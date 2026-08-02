// LocaleBoundPill.tsx — the blue "Locale" pill shown in a control's VALUE
// area when the property carries `:lang()` locale overrides (localization
// overhaul Phase 4). Mirrors VariableBoundPill's exact look: accent pill,
// icon chip, label, × to remove. Body click opens the Localize popup;
// × clears every locale's rule for the property.

import React, { useMemo, useRef, useState } from 'react';
import { useControlContext } from '@/editor/controls/unified';
import { useAtomValue } from 'jotai';
import { codeAtom } from '@/code/stores/store';
import { i18nConfigAtom } from '@/code/stores/locale-store';
import { parseLocaleRulesScoped, localeOffMarker } from '@/code/generation/locale-gen';
import { interactingViewportIdAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { isPrimaryViewport } from '@/shared/constants';
import { extractStyleCSS } from '@/code/parsing/parser';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { toKebab } from '@/shared/css-utils';
import LocaleStylePopup from '@/editor/ui/LocaleStylePopup';
import { trace } from '@/shared/debug-trace';

export interface LocaleStyleState {
  /** Locales whose localization is EFFECTIVE on the interacting artboard. */
  locales: string[];
  /** True when this replica opted out (banded `--locale-off-<prop>` marker). */
  removed: boolean;
  /** True when the interacting artboard is a non-primary replica (page
   *  viewport OR design-component variant tile). */
  isReplica: boolean;
  /** The replica's band width (page replicas only). */
  vpWidth?: number;
  /** The variant name (design-component variant tiles only). */
  variantName?: string;
  /** Locales localized at the BASE (primary) level, ignoring replica state. */
  baseLocales: string[];
  /** True when THIS replica's band carries any :lang rule for the property
   *  (a per-replica value or the removal marker) — drives Reset Locale
   *  Override in the label menu. */
  hasBandRules: boolean;
  /** Locales carrying ANY banded rule (value OR removal marker) for the
   *  property on THIS artboard — the exact set a band reset must clear.
   *  baseLocales∪locales is WRONG for that: a removal marker forces
   *  `locales: []`, and with no global rules the union is empty → Reset
   *  Override queued ZERO mutations (the stuck-blue Opacity find). */
  bandLocales: string[];
}

/** Per-ARTBOARD locale style state for (nodeId, property): banded `:lang()`
 *  rules at the interacting replica's width overlay the top-level base rules
 *  (the replica-effective resolution rule every control follows); a banded
 *  `--locale-off-<prop>: 1` marker means this replica removed the
 *  localization — the pill hides there and Reset Override re-inherits. */
export function useLocaleStyleState(property: string, nodeId: string | null): LocaleStyleState {
  const code = useAtomValue(codeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  return useMemo(() => getLocaleStyleState(code, nodeId, property, vpId, vpWidths, activeFilePath),
    [code, nodeId, property, vpId, vpWidths, activeFilePath]);
}

/** PURE per-artboard state builder — the hook above wraps it with the live
 *  atoms (same pattern as LocalePropPill's getLocalePropState). */
export function getLocaleStyleState(
  code: string, nodeId: string | null, property: string,
  vpId: string, vpWidths: Record<string, number>, activeFilePath: string,
): LocaleStyleState {
    const empty: LocaleStyleState = { locales: [], removed: false, isReplica: false, baseLocales: [], hasBandRules: false, bandLocales: [] };
    if (!nodeId || !code.includes(':lang(')) return empty;
    const kebab = toKebab(property);
    const marker = localeOffMarker(kebab);
    const { global, banded, variants } = parseLocaleRulesScoped(extractStyleCSS(code));
    const baseLocales: string[] = [];
    for (const [locale, nodeMap] of global) {
      if (nodeMap.get(nodeId)?.get(kebab) !== undefined) baseLocales.push(locale);
    }

    // Shared replica-overlay resolution: `scopeProps(locale)` returns the
    // scope's prop map for this node (banded @media rules on a PAGE replica,
    // data-variant rules on a COMPONENT variant tile).
    const overlay = (lookup: (locale: string) => Map<string, string> | undefined, scope: Partial<LocaleStyleState>): LocaleStyleState => {
      let removed = false;
      let hasBandRules = false;
      const bandLocales: string[] = [];
      const effective = new Set<string>(baseLocales);
      const allLocales = new Set<string>([...baseLocales]);
      // We must iterate the SCOPE's locales too (a variant/band can localize
      // a locale the base doesn't have).
      for (const [locale] of global) allLocales.add(locale);
      for (const locale of scope.variantName
        ? (variants.get(scope.variantName)?.keys() ?? [])
        : (banded.get(scope.vpWidth ?? -1)?.keys() ?? [])) allLocales.add(locale);
      for (const locale of allLocales) {
        const props = lookup(locale);
        if (!props) continue;
        const hasMarker = props.get(marker) !== undefined;
        const hasValue = props.get(kebab) !== undefined;
        if (hasMarker || hasValue) bandLocales.push(locale);
        if (hasMarker) { removed = true; hasBandRules = true; continue; }
        if (hasValue) { effective.add(locale); hasBandRules = true; }
      }
      return {
        locales: removed ? [] : [...effective],
        removed,
        isReplica: true,
        baseLocales,
        hasBandRules,
        bandLocales,
        ...scope,
      };
    };

    // DESIGN COMPONENT master: artboards are VARIANT tiles; a non-default
    // variant scopes locale styles via the root's data-variant attribute —
    // same override/removal model as page replica bands.
    if (isComponentFilePath(activeFilePath)) {
      const variantId = isPrimaryViewport(vpId) ? 'default' : vpId;
      if (variantId === 'default') {
        return { locales: baseLocales, removed: false, isReplica: false, baseLocales, hasBandRules: false, bandLocales: [] };
      }
      return overlay(
        (locale) => variants.get(variantId)?.get(locale)?.get(nodeId),
        { variantName: variantId },
      );
    }

    const vpWidth = vpWidths[vpId];
    const primaryWidth = Math.max(...Object.values(vpWidths).map(Number).filter(n => Number.isFinite(n)), 0);
    const isReplica = Number.isFinite(vpWidth) && vpWidth > 0 && vpWidth !== primaryWidth;
    if (!isReplica) {
      return { locales: baseLocales, removed: false, isReplica: false, baseLocales, hasBandRules: false, bandLocales: [] };
    }
    return overlay(
      (locale) => banded.get(vpWidth)?.get(locale)?.get(nodeId),
      { vpWidth },
    );
}

/** The mutation-scope fields for the interacting artboard: page replicas
 *  band by width, component variant tiles scope by variant name. Spread into
 *  every `updateLocaleStyle` mutation that targets the current artboard. */
export function localeScopeOf(state: Pick<LocaleStyleState, 'isReplica' | 'vpWidth' | 'variantName'>): { maxWidth?: number; variantName?: string } {
  if (!state.isReplica) return {};
  if (state.variantName) return { variantName: state.variantName };
  if (state.vpWidth) return { maxWidth: state.vpWidth };
  return {};
}

/** Back-compat effective-locales view (empty when removed on this replica —
 *  integrated controls then naturally fall back to their normal rendering). */
export function useLocaleStyleOverrides(property: string, nodeId: string | null): string[] {
  return useLocaleStyleState(property, nodeId).locales;
}

export default function LocaleBoundPill({ property, propertyLabel, nodeId, baseValue, onChangeBase }: {
  property: string;
  propertyLabel: string;
  nodeId: string;
  baseValue: string;
  onChangeBase?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const config = useAtomValue(i18nConfigAtom);
  const state = useLocaleStyleState(property, nodeId);
  const overrides = state.locales;

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state.isReplica && (state.vpWidth || state.variantName)) {
      // REPLICA ×: opt this artboard out only — bake the base value + the
      // removal marker into this scope (page @media band / component
      // data-variant rule); the primary keeps its localization and Reset
      // Locale Override (label menu) re-inherits it.
      trace.action('locale-pill:remove-replica', { nodeId, property, vpWidth: state.vpWidth, variantName: state.variantName, locales: overrides });
      const kebab = toKebab(property);
      for (const locale of overrides) {
        queueMutation({
          type: 'updateLocaleStyle', nodeId, locale, ...localeScopeOf(state),
          styles: { [property]: baseValue || 'unset', [localeOffMarker(kebab)]: '1' },
        });
      }
      flushNow();
      return;
    }
    trace.action('locale-pill:clear', { nodeId, property, locales: overrides });
    for (const locale of overrides) {
      queueMutation({ type: 'updateLocaleStyle', nodeId, locale, styles: { [property]: '' } });
    }
    flushNow();
  };

  const summary = overrides.length === 1
    ? (config?.locales.find(l => l.code === overrides[0])?.label ?? overrides[0])
    : `${overrides.length} Locales`;

  return (
    <>
      <button
        ref={pillRef}
        onClick={() => { setOpen(true); trace.action('locale-pill:open', { nodeId, property }); }}
        data-locale-pill={property}
        className="w-full h-8 flex items-center gap-2 pl-1 pr-2 rounded-[var(--radius-lg)] border border-transparent text-xs font-medium text-[var(--accent-fg)] cursor-pointer"
        style={{ backgroundColor: 'var(--accent)' }}
        title={`Localized · ${summary}`}
      >
        <span className="w-4 h-4 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: 'color-mix(in srgb, var(--accent-fg) 16%, transparent)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
          </svg>
        </span>
        <span className="truncate flex-1 text-left">Locale</span>
        <span role="button" onClick={clear} className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none" title="Remove localization">×</span>
      </button>
      {open && (
        <LocaleStylePopup
          property={property}
          propertyLabel={propertyLabel}
          nodeId={nodeId}
          baseValue={baseValue}
          isOpen
          onClose={() => setOpen(false)}
          anchorRef={pillRef}
          onChangeBase={onChangeBase}
        />
      )}
    </>
  );
}

/** Wrap a unified atom's VALUE side: renders the blue Locale pill when the
 *  property carries :lang overrides on the interacting artboard, else the
 *  atom's normal control. One-line adoption per atom:
 *    <LocalePillOr property="opacity" label="Opacity">…control…</LocalePillOr>
 */
export function LocalePillOr({ property, label, children }: {
  property: string;
  label: string;
  children: React.ReactNode;
}) {
  const { node, value, onChange } = useControlContext();
  const overrides = useLocaleStyleOverrides(property, node?.id ?? null);
  if (overrides.length > 0 && node?.id) {
    return (
      <LocaleBoundPill
        property={property}
        propertyLabel={label}
        nodeId={node.id}
        baseValue={value || ''}
        onChangeBase={(v) => onChange(v)}
      />
    );
  }
  return <>{children}</>;
}

/** Explicit-props twin of LocalePillOr for LEGACY-provider rows (LayoutTool's
 *  hand-rolled Direction/Wrap) — same swap, caller supplies everything. */
export function LocalePillOrLegacy({ property, label, nodeId, baseValue, onChangeBase, children }: {
  property: string;
  label: string;
  nodeId: string | null;
  baseValue: string;
  onChangeBase?: (v: string) => void;
  children: React.ReactNode;
}) {
  const overrides = useLocaleStyleOverrides(property, nodeId);
  if (overrides.length > 0 && nodeId) {
    return (
      <LocaleBoundPill
        property={property}
        propertyLabel={label}
        nodeId={nodeId}
        baseValue={baseValue}
        onChangeBase={onChangeBase}
      />
    );
  }
  return <>{children}</>;
}
