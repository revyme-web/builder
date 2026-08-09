// locale-override-map.ts — deterministic canvas text resolution for
// next-intl translation nodes.
//
// For EVERY parsed node carrying `translationKey` (its JSX text is
// `{t('key')}`), produce a text override entry for the ACTIVE locale:
//
//     text = messages[active][ns][key]
//         ?? messages[default][ns][key]
//         ?? ''
//
// plus per-viewport buckets from `key__<vpWidth>` suffixed message keys
// (replica translations) → NodeOverride.textOverrides.
//
// Always producing an entry — including the default locale and including the
// explicit-empty case — is the point: the old resolution gated entries on a
// `code.includes("t('key')")` string match and dropped them silently, so a
// t() node whose entry vanished kept whatever locale's text was last painted
// (the "Peintre stays in English, empty after page switch" report). With a
// guaranteed entry, applyLocaleOverrides always rewrites the text on patch.
//
// Pure (raw JSON strings in, Map out) so it's unit-testable; the hook owns
// the store reads.

import type { CanvasNode } from '@/code/parsing/parser';
import type { NodeOverride } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

type MessageNs = Record<string, string>;

/** Parse a messages/{locale}.json payload and return the given namespace's
 *  flat key→string map ({} on missing/invalid). */
export function parseMessagesNamespace(raw: string | null | undefined, namespace: string): MessageNs {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const ns = parsed?.[namespace];
    if (!ns || typeof ns !== 'object') return {};
    const out: MessageNs = {};
    for (const [k, v] of Object.entries(ns)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (err) {
    trace.error('locale-override-map:messages-parse-failed', {
      namespace, error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

const RUN_CALL_RE = /\{\s*\w+\('([^']+)'\)\s*\}/g;

/** Does a mixed node's raw inner JSX carry `{t('key')}` run calls? */
export function richTextHasRunCalls(innerJsx: string): boolean {
  RUN_CALL_RE.lastIndex = 0;
  return RUN_CALL_RE.test(innerJsx);
}

/** Substitute every `{t('key')}` run call in a rich-text inner JSX with the
 *  resolved message text (entity-escaped so pasted `<`/`{` can't inject
 *  markup — the renderer paints the result via innerHTML). */
export function substituteRichTextRuns(innerJsx: string, resolve: (key: string) => string): string {
  return innerJsx.replace(RUN_CALL_RE, (_, k: string) =>
    resolve(k)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;'));
}

export function buildTranslationTextOverrides(opts: {
  nodes: Map<string, CanvasNode> | null | undefined;
  namespace: string;
  /** messages/{activeLocale}.json content */
  activeMessagesRaw: string | null | undefined;
  /** messages/{defaultLocale}.json content (pass the same string when the
   *  active locale IS the default — the fallback then collapses). */
  defaultMessagesRaw: string | null | undefined;
}): Map<string, NodeOverride> {
  const out = new Map<string, NodeOverride>();
  const { nodes, namespace } = opts;
  if (!nodes || nodes.size === 0) return out;

  const active = parseMessagesNamespace(opts.activeMessagesRaw, namespace);
  const fallback = parseMessagesNamespace(opts.defaultMessagesRaw, namespace);

  for (const [nodeId, node] of nodes) {
    // A DORMANT canvas node has no `{t()}` call to read a key from — dragging
    // it out of the page baked the default-locale literal and stashed the key
    // in `data-i18n-orphan`, because `t` doesn't exist at module scope. The
    // stash is still a translation key, so the canvas must resolve it like any
    // other; without this the node sat on the canvas in English no matter which
    // locale was selected (user report 2026-08-09).
    const stashKey = node.translationOrphanKey;
    const key = node.translationKey ?? stashKey;
    const isDormant = !node.translationKey && !!stashKey;
    // Attr translation calls (placeholder={t('id__attr_placeholder')}) —
    // resolve each to a prop override with the same active→default→'' chain.
    let props: Record<string, string> | undefined;
    if (node.attrTranslationKeys) {
      for (const [attr, attrKey] of Object.entries(node.attrTranslationKeys)) {
        props = props ?? {};
        props[attr] = active[attrKey] ?? fallback[attrKey] ?? '';
      }
    }
    if (!key) {
      // RICH-TEXT runs: a mixed-content node's textContent is raw inner JSX
      // that may carry `{t('key')}` run calls. Resolve each against the same
      // active→default→'' chain and hand the renderer a fully-substituted
      // innerJsx (the innerHTML path renders it; spans keep their styling in
      // every locale). Entity-escape the message so pasted `<`/`{` can't
      // inject markup.
      if (node.hasMixedContent && node.textContent && richTextHasRunCalls(node.textContent)) {
        const innerJsx = substituteRichTextRuns(node.textContent, (k) => active[k] ?? fallback[k] ?? '');
        const entry: NodeOverride = { innerJsx };
        if (props) entry.props = props;
        out.set(nodeId, entry);
        continue;
      }
      if (props) out.set(nodeId, { props });
      continue;
    }
    // A live t() node resolves to '' when no message exists — its JSX carries
    // no text either way. A DORMANT node does: its baked literal is the only
    // copy left, so blanking it would delete words off the canvas.
    const text = active[key] ?? fallback[key] ?? (isDormant ? (node.textContent ?? '') : '');

    // Replica buckets: `key__<vpWidth>` suffixed entries. Active locale wins
    // per width; default-locale buckets fill widths the active locale hasn't
    // translated yet (mirrors the flat-text fallback).
    let textOverrides: Record<string, string> | undefined;
    const collect = (src: MessageNs) => {
      const prefix = `${key}__`;
      for (const [mk, mv] of Object.entries(src)) {
        if (!mk.startsWith(prefix)) continue;
        const width = mk.slice(prefix.length);
        if (!/^\d+$/.test(width)) continue;
        textOverrides = textOverrides ?? {};
        if (textOverrides[width] === undefined) textOverrides[width] = mv;
      }
    };
    collect(active);
    collect(fallback);

    const entry: NodeOverride = textOverrides ? { text, textOverrides } : { text };
    if (props) entry.props = props;
    out.set(nodeId, entry);
  }
  if (out.size > 0) {
    trace.fn('buildTranslationTextOverrides', { namespace, entryCount: out.size });
  }
  return out;
}
