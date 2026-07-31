// src/canvas/hooks/useLocaleOverrides.ts
//
// Loads locale overrides from two sources, merged into localeOverridesAtom:
//   1. `:lang(xx)` CSS rules in page code → style overrides per node.
//   2. `messages/{locale}.json` (next-intl) → deterministic text/prop entries
//      per parsed translation node (buildTranslationTextOverrides).
// (The legacy `i18n/{locale}.json` layer is retired — text is migrated into
// messages at project load; localization overhaul Phase 5.)
//
// Also wires the imperative `setLocaleStyleCallback` so node-ops can write
// locale-scoped style updates back into the atom.
//
// Both effects share atom-setter state, so they live together here.

import { useEffect, useRef, type RefObject } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { codeAtom, nodesAtom, triggerAsyncParse } from '@/code/stores/store';
import {
  activeLocaleAtom,
  isDefaultLocaleAtom,
  localeOverridesAtom,
  i18nConfigAtom,
} from '@/code/stores/locale-store';
import { buildTranslationTextOverrides } from './locale-override-map';
import { activeFilePathAtom, filePathToSlug } from '@/code/project/active-file-store';
import { parseLocaleRules } from '@/code/generation/locale-gen';
import { setParseActiveLocale } from '@/code/parsing/parser';
import { extractStyleCSS } from '@/code/parsing/parser';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { setLocaleStyleCallback } from '../node-ops';
import { getCanvasRenderer } from '../CanvasRenderer';
import { toKebab } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';
import type { NodeOverride } from '@/shared/types';

/** Content equality for override maps — same keys, same per-node override
 *  payloads. Used to keep the atom's IDENTITY stable when a reload produced
 *  the same result: the atom is a render-effect dependency, so a fresh-but-
 *  equal Map after every code change (e.g. each undo) forwarded a SECOND
 *  full canvas render per edit (live find 2026-07-17). */
function overrideMapsEqual(a: Map<string, NodeOverride>, b: Map<string, NodeOverride>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o) return false;
    if (JSON.stringify(v) !== JSON.stringify(o)) return false;
  }
  return true;
}

export function useLocaleOverrides(contentRef: RefObject<HTMLDivElement | null>): void {
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const code = useAtomValue(codeAtom);
  const nodes = useAtomValue(nodesAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const i18nConfig = useAtomValue(i18nConfigAtom);
  const [localeOverrides, setLocaleOverrides] = useAtom(localeOverridesAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setNodesRef = useRef(setNodes);
  setNodesRef.current = setNodes;

  // Mirror the latest setter so the imperative callback (registered once)
  // always writes to the current store. Jotai setters are stable across
  // renders, but mirroring via a ref is the safest pattern for imperative
  // callbacks that outlive a single render.
  const setLocaleOverridesRef = useRef(setLocaleOverrides);
  setLocaleOverridesRef.current = setLocaleOverrides;

  // ── Wire the imperative callback once (mount only) ──────────────────────
  // node-ops calls this when locale style changes come in imperatively
  // (e.g. via updateNodeStyles in locale mode). We merge-empty-string-removes:
  // an empty value means "delete this property".
  useEffect(() => {
    trace.action('useLocaleOverrides:wire-callback', {});
    setLocaleStyleCallback((nodeId, styles) => {
      trace.action('useLocaleOverrides:locale-style-update', { nodeId, styleCount: Object.keys(styles).length });
      setLocaleOverridesRef.current(prev => {
        const next = new Map(prev);
        const existing = next.get(nodeId) || {};
        const mergedStyles = { ...(existing.styles || {}), ...styles };
        // Remove empty string values (property removal — empty = delete)
        for (const key of Object.keys(mergedStyles)) {
          if (mergedStyles[key] === '') delete mergedStyles[key];
        }
        if (Object.keys(mergedStyles).length === 0 && !existing.text && existing.visible === undefined) {
          next.delete(nodeId);
        } else {
          next.set(nodeId, { ...existing, styles: mergedStyles });
        }
        return next;
      });
    });

    return () => {
      // Clear the callback on unmount so node-ops doesn't write to a dead component.
      setLocaleStyleCallback(null);
      trace.action('useLocaleOverrides:callback-cleared', {});
    };
  }, []);

  // ── Locale-scoped INSTANCE PROPS: reparse on locale switch ──────────────
  // Locale prop values (`prop={__activeLocale === 'fr' ? … : base}`) resolve
  // at PARSE time against setParseActiveLocale — a locale switch must reparse
  // so every instance re-resolves its per-locale prop values.
  const bumpProjectVersion = useSetAtom(projectVersionAtom);
  useEffect(() => {
    setParseActiveLocale(activeLocale === (i18nConfig?.defaultLocale ?? 'en') ? '' : activeLocale);
    if (code.includes('__activeLocale')) {
      // Bump the parse-cache key so nodesAtom re-derives ON THE MAIN THREAD
      // (where setParseActiveLocale lives). The worker parse
      // (triggerAsyncParse) has its OWN module instance of the parser — its
      // locale flag is never set, so worker reparses always resolved the
      // DEFAULT locale (the "canvas ignores my French prop value" find).
      bumpProjectVersion((v: number) => v + 1);
      trace.action('useLocaleOverrides:locale-reparse', { activeLocale });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocale]);

  // ── Recompute overrides on every locale / file / code change ────────────
  // Sources: messages/ (default + non-default) and :lang() CSS styles
  // (non-default only). Ordered so later sources merge per nodeId.
  useEffect(() => {
    trace.fn('useLocaleOverrides:load', { activeLocale, activeFilePath, isDefaultLocale });
    const renderer = getCanvasRenderer();
    const overrideMap = new Map<string, NodeOverride>();

    // Source 3: next-intl messages — applies to BOTH default and non-default
    // locales. Deterministic per PARSED translation node (node.translationKey
    // from the parser): active-locale value, default-locale fallback, ''.
    // Keying off the parsed nodes replaces the old `code.includes("t('key')")`
    // string gate — orphaned messages can't apply (no node carries the key),
    // and a t() node ALWAYS has an entry, so switching locales can never
    // leave another locale's stale text painted (the "Peintre stays in
    // English" report, 2026-07-21).
    const namespace = filePathToSlug(activeFilePath);
    const defaultLocale = i18nConfig?.defaultLocale ?? 'en';
    const activeMessagesRaw = projectFS.readFile(`messages/${activeLocale}.json`);
    const defaultMessagesRaw = activeLocale === defaultLocale
      ? activeMessagesRaw
      : projectFS.readFile(`messages/${defaultLocale}.json`);
    const translationEntries = buildTranslationTextOverrides({
      nodes, namespace, activeMessagesRaw, defaultMessagesRaw,
    });
    for (const [nodeId, entry] of translationEntries) overrideMap.set(nodeId, entry);
    const messagesCount = translationEntries.size;

    if (isDefaultLocale) {
      // Default locale: messages-only path (no :lang() CSS, no JSON
      // overrides). Clear any prior inline locale styles so switching back
      // to EN doesn't keep stale FR opacity / color rules around.
      const content = contentRef.current;
      if (content) {
        const prevOverrides = localeOverrides;
        for (const [nodeId, override] of prevOverrides) {
          if (!override.styles) continue;
          const els = content.querySelectorAll(`[data-id="${nodeId}"]`);
          els.forEach(el => {
            for (const key of Object.keys(override.styles!)) {
              try { (el as HTMLElement).style.removeProperty(toKebab(key)); } catch { /* skip */ }
            }
          });
        }
        trace.action('useLocaleOverrides:inline-styles-cleared', { nodeCount: prevOverrides.size });
      }

      // Only force the render (clear the canvas-update skip flag) when the
      // overrides ACTUALLY changed — this effect fires on EVERY code change,
      // and unconditionally clearing clobbered a canvas-drag's markCanvasUpdate
      // (the drop's render-skip), forcing a full re-render + measure on every
      // drag commit on a big page. No locale change → nothing to render.
      if (!overrideMapsEqual(localeOverrides, overrideMap)) {
        setLocaleOverrides(overrideMap);
        renderer.clearCanvasUpdate();
      }
      trace.action('useLocaleOverrides:overrides-loaded', {
        locale: activeLocale, isDefault: true, messagesCount,
      });
      return;
    }

    // Source 1: :lang() CSS rules in the JSX (style overrides per node).
    const cssRules = parseLocaleRules(extractStyleCSS(code));
    const localeRules = cssRules.get(activeLocale);
    if (localeRules) {
      for (const [nodeId, props] of localeRules) {
        const styles: Record<string, string> = {};
        for (const [prop, val] of props) {
          const camel = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          styles[camel] = val;
        }
        const existing = overrideMap.get(nodeId) || {};
        overrideMap.set(nodeId, { ...existing, styles: { ...(existing.styles || {}), ...styles } });
      }
    }

    // (Legacy i18n/{locale}.json overrides are RETIRED — text migrated into
    // messages/*.json at project load; localization overhaul Phase 5.)

    // Only force the render when overrides actually changed (see the default-
    // locale branch above) — unconditional clear clobbered canvas-drag's
    // render-skip flag on every commit.
    if (!overrideMapsEqual(localeOverrides, overrideMap)) {
      setLocaleOverrides(overrideMap);
      renderer.clearCanvasUpdate();
    }
    trace.action('useLocaleOverrides:overrides-loaded', {
      locale: activeLocale,
      filePath: activeFilePath,
      nodeCount: overrideMap.size,
      fromCSS: localeRules?.size ?? 0,

      fromMessages: messagesCount,
    });
  }, [activeLocale, activeFilePath, isDefaultLocale, setLocaleOverrides, code, nodes, i18nConfig]);
}
