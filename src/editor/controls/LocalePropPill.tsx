// LocalePropPill.tsx — per-LOCALE values on component-INSTANCE props (design
// component variables, hoisted variables, code-component controls): the
// "Localize" control for the props panel. Rides the scoped-expr locale
// rail (setLocaleInstancePropInCode / updateLocaleInstanceProp mutation):
//   prop={(__activeLocale === 'fr' ? "ergerg" : "base")}
// with per-instance-REPLICA values via `&& __mqN` band gates. Same UX family
// as LocaleBoundPill/LocaleStylePopup for styles: blue pill on the row, popup
// with When/Set per configured locale + Fallback (base), artboard-scoped Set
// on replicas, × removes.

import React, { useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { codeAtom } from '@/code/stores/store';
import { i18nConfigAtom } from '@/code/stores/locale-store';
import { interactingViewportIdAtom, viewportWidthsAtom, getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { parseScopedScalarExpr } from '@/code/generation/scoped-expr';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { ToolRow, ToolInput, ToolSelect } from '@/editor/controls';
import ToolPopup from '@/editor/ui/ToolPopup';
import { RemoveButton } from '@/editor/controls/RemoveButton';
import ColorInput from '@/editor/controls/ColorInput';
import NumberVariableEditor from '@/editor/controls/NumberVariableEditor';
import { translationsOverlayOpenAtom } from '@/code/stores/left-panel-store';
import { trace } from '@/shared/debug-trace';

// Match `prop="x"` / `prop='x'` / `prop={…}` on the instance tag (same shape
// the writer uses).
function readPropExpr(code: string, nodeId: string, prop: string): string | null {
  const tagMatch = new RegExp(`<[\\w.]+[^>]*\\sdata-id="${nodeId}"[^>]*>`).exec(code);
  if (!tagMatch) return null;
  const m = tagMatch[0].match(new RegExp(`(?<![\\w-])${prop}=(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`));
  if (!m) return null;
  if (m[1] !== undefined || m[2] !== undefined) return JSON.stringify(m[1] ?? m[2]);
  return (m[3] ?? '').trim() || null;
}

const unq = (v: string): string => {
  try { const p = JSON.parse(v); return typeof p === 'string' ? p : v; } catch { return v; }
};

/** The replica-removal bake value: the base literal when it's a plain value,
 *  else the writer's `undefined` sentinel (component default). */
export function localePropBakeValue(state: LocalePropState): string {
  if (state.baseValue && state.baseValue !== 'undefined' && !looksLikeExpr(state.baseValue)) return state.baseValue;
  return '__locale_default__';
}

const looksLikeExpr = (v: string): boolean =>
  v.includes('__activeLocale') || v.includes('__mq') || /^\(.*\)$/.test(v.trim());

export interface LocalePropState {
  /** Locales carrying a value effective on the CURRENT artboard. */
  locales: string[];
  /** All per-locale values: locale → { base?: string; byWidth: Record<maxW, string> } */
  entries: Record<string, { base?: string; byWidth: Record<number, string> }>;
  baseValue: string;
  isReplica: boolean;
  vpWidth?: number;
  bandQuery?: string;
}

/** The interacting artboard's band query — same ranged head the writers use. */
function bandQueryFor(vpWidth: number): string {
  const widths = getSortedBreakpointWidths();
  const smaller = widths.filter((w) => w < vpWidth);
  const minW = smaller.length > 0 ? Math.max(...smaller) : undefined;
  return minW !== undefined
    ? `(max-width: ${vpWidth}px) and (min-width: ${minW + 0.02}px)`
    : `(max-width: ${vpWidth}px)`;
}

/** Convert-on-click: seed the FIRST non-default locale with the current
 *  value (artboard-scoped on a replica) — the row then shows the pill, and
 *  the popup opens from it. Mirrors the styles popup's convert-on-open. */
let _pendingOpenKey: string | null = null;

export function localizeInstanceProp(opts: {
  nodeId: string; componentName: string; prop: string; currentValue: string;
  firstLocale: string; isReplica: boolean; vpWidth?: number;
}): void {
  queueMutation({
    type: 'updateLocaleInstanceProp',
    nodeId: opts.nodeId, componentName: opts.componentName, prop: opts.prop,
    locale: opts.firstLocale, value: opts.currentValue,
    bandQuery: opts.isReplica && opts.vpWidth ? bandQueryFor(opts.vpWidth) : undefined,
  });
  flushNow();
  _pendingOpenKey = `${opts.nodeId}:${opts.prop}`;
  trace.action('locale-prop:convert', { nodeId: opts.nodeId, prop: opts.prop, locale: opts.firstLocale, replica: opts.isReplica });
}

/** Effective DISPLAY value of a locale-scoped instance-prop attr. The parsed
 *  attr is the RAW expression — a select fed that string matches no option
 *  and silently renders the FIRST one (the "reverts to Start after 2s" find,
 *  once the optimistic hold expired). Resolution: active-locale entry
 *  (banded on this artboard) → base branch → component default. */
export function resolveScopedPropDisplayValue(
  code: string, nodeId: string | null, prop: string,
  vpId: string, vpWidths: Record<string, number>,
  activeLocale: string, defaultLocale: string,
  raw: string, defaultValue?: string | null,
): string {
  if (!raw || !raw.includes('__activeLocale')) return raw;
  const lp = getLocalePropState(code, nodeId, prop, vpId, vpWidths);
  const e = lp.entries[activeLocale];
  const banded = e && lp.vpWidth !== undefined ? e.byWidth[lp.vpWidth] : undefined;
  const localeVal = activeLocale !== defaultLocale ? (banded ?? e?.base) : undefined;
  const pick = localeVal ?? lp.baseValue;
  return (!pick || pick === 'undefined') ? (defaultValue ?? '') : pick;
}

/** PURE per-artboard locale-prop state — usable inside row loops (no hooks).
 *  The hook below wraps it with the live atoms. */
export function getLocalePropState(
  code: string, nodeId: string | null, prop: string,
  vpId: string, vpWidths: Record<string, number>,
  fallback?: string,
): LocalePropState {
  const empty: LocalePropState = { locales: [], entries: {}, baseValue: '', isReplica: false };
  if (!nodeId) return empty;
  const expr = readPropExpr(code, nodeId, prop);
  if (expr == null) return empty;
  const { base, responsive } = parseScopedScalarExpr(code, expr);
  const entries: LocalePropState['entries'] = {};
  for (const r of responsive) {
    if (!('locale' in r.scope)) continue;
    const e = (entries[r.scope.locale] ??= { byWidth: {} });
    const mw = r.scope.query?.match(/max-width:\s*(\d+)px/);
    if (mw) e.byWidth[parseInt(mw[1], 10)] = unq(r.value);
    else e.base = unq(r.value);
  }
  const vpWidth = vpWidths[vpId];
  const primaryWidth = Math.max(...Object.values(vpWidths).map(Number).filter((n) => Number.isFinite(n)), 0);
  const isReplica = Number.isFinite(vpWidth) && vpWidth > 0 && vpWidth !== primaryWidth;
  // REPLICA REMOVAL BAKE: a banded value EQUAL to the effective default is the
  // prop twin of the styles' base-bake + --locale-off marker — "this replica
  // opted out". It doesn't count as an effective localization here (pill
  // hides; the band entry still drives the blue label + Reset Override).
  const baseV = unq(base);
  // Removal detection is EXACT: the bake writes the base literal (or the
  // `undefined` sentinel when the base is the component default) — banded
  // value === base means "removed on this replica", never a real override.
  const locales = Object.keys(entries).filter((l) => {
    const banded = isReplica ? entries[l].byWidth[vpWidth] : undefined;
    if (banded !== undefined) return banded !== baseV && banded !== 'undefined';
    return entries[l].base !== undefined;
  });
  return {
    locales,
    entries,
    baseValue: baseV,
    isReplica,
    vpWidth: isReplica ? vpWidth : undefined,
    bandQuery: isReplica ? bandQueryFor(vpWidth) : undefined,
  };
}

/** True when THIS replica carries its own banded locale value for the prop —
 *  drives the blue override label + Reset Override (re-inherit primary). */
export function localePropBandedHere(state: LocalePropState): boolean {
  return state.isReplica && state.vpWidth !== undefined
    && Object.values(state.entries).some((e) => e.byWidth[state.vpWidth!] !== undefined);
}

/** Clear every banded locale value on the CURRENT replica for the prop —
 *  the Reset Override action (primary scopes untouched → re-inherits). */
export function resetLocalePropBand(nodeId: string, componentName: string, prop: string, state: LocalePropState): void {
  if (!state.isReplica || state.vpWidth === undefined) return;
  for (const [locale, e] of Object.entries(state.entries)) {
    if (e.byWidth[state.vpWidth] !== undefined) {
      queueMutation({ type: 'updateLocaleInstanceProp', nodeId, componentName, prop, locale, value: null, bandQuery: state.bandQuery });
    }
  }
  flushNow();
  trace.action('locale-prop:reset-band', { nodeId, prop, vpWidth: state.vpWidth });
}

export function useLocalePropState(nodeId: string | null, prop: string, fallback?: string): LocalePropState {
  const code = useAtomValue(codeAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  return useMemo(() => getLocalePropState(code, nodeId, prop, vpId, vpWidths, fallback), [code, nodeId, prop, vpId, vpWidths, fallback]);
}

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
    </svg>
  );
}

/** Resolve the popup's Fallback row from the expression base + the row's
 *  effective value. A usable fallback is a real literal — the stringified
 *  `undefined`/`null` base branch means "defer to the master default", never
 *  a display value (the "Fallback: undefined" find). Options-backed props
 *  display the option LABEL (Top/Bottom…), Set-row parity. */
export function resolveEffectiveFallback(
  baseValue: string | undefined,
  fallback: string | undefined,
  options?: { value: string; label: string }[],
): { value: string; label: string } {
  const usable = (v?: string) => !!v && v !== 'undefined' && v !== 'null' && !looksLikeExpr(v);
  const value = usable(baseValue) ? baseValue! : (usable(fallback) ? fallback! : '');
  return { value, label: options?.find((o) => o.value === value)?.label ?? value };
}

export function LocalePropPopup({ nodeId, componentName, prop, propLabel, options, state, anchorRef, onClose, fallback, editorKind, numberMeta }: {
  nodeId: string;
  componentName: string;
  prop: string;
  propLabel: string;
  /** Enum options when the prop is a select control (e.g. Justify). */
  options?: { value: string; label: string }[];
  state: LocalePropState;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** The row's EFFECTIVE value (explicit attr or the component's default) —
   *  shown as Fallback when the expression base is the literal `undefined`
   *  (prop had no explicit attr before localizing: runtime falls through to
   *  the component default). */
  fallback?: string;
  /** Renders the REAL control in Set/Fallback rows — ColorInput for colors,
   *  NumberVariableEditor (slider/stepper) for numbers — instead of a raw
   *  text input (the rgba-in-a-text-input / number-without-slider finds). */
  editorKind?: 'color' | 'number';
  /** Number editor knobs (only with editorKind 'number'). */
  numberMeta?: { control: 'slider' | 'stepper'; min?: number; max?: number; step?: number };
}) {
  const config = useAtomValue(i18nConfigAtom);
  const setTranslationsOverlayOpen = useSetAtom(translationsOverlayOpenAtom);
  const locales = (config?.locales ?? []).filter((l) => l.code !== config?.defaultLocale);

  const write = (locale: string, value: string | null) => {
    queueMutation({
      type: 'updateLocaleInstanceProp', nodeId, componentName, prop, locale, value,
      bandQuery: state.isReplica ? state.bandQuery : undefined,
    });
    flushNow();
    trace.action('locale-prop:write', { nodeId, prop, locale, banded: state.isReplica, removed: value === null });
  };

  const valueFor = (locale: string): string => {
    const e = state.entries[locale];
    if (!e) return '';
    if (state.isReplica && state.vpWidth !== undefined && e.byWidth[state.vpWidth] !== undefined) return e.byWidth[state.vpWidth];
    return e.base ?? '';
  };

  // Conditions — seeded from persisted per-locale values on the CURRENT
  // artboard; reseeds on artboard switch (same rule as the style popup).
  const seed = () => {
    const seeded = locales.filter((l) => valueFor(l.code) !== '')
      .map((l) => ({ locale: l.code, value: valueFor(l.code) }));
    return seeded.length > 0 ? seeded : (locales[0] ? [{ locale: locales[0].code, value: '' }] : []);
  };
  const [conds, setConds] = useState<{ locale: string; value: string }[]>(seed);
  const artboardKey = `${nodeId}:${prop}:${state.isReplica ? state.vpWidth : 'primary'}`;
  const prevKeyRef = useRef(artboardKey);
  if (prevKeyRef.current !== artboardKey) {
    prevKeyRef.current = artboardKey;
    setConds(seed());
  }
  const usedLocales = new Set(conds.map((c) => c.locale));
  const nextFree = locales.find((l) => !usedLocales.has(l.code));

  const resolved = resolveEffectiveFallback(state.baseValue, fallback, options);
  // Editable Fallback: commits rewrite the expression's BASE
  // branch; the draft keeps the control stable until the parse round-trips.
  const [baseDraft, setBaseDraft] = useState<string | null>(null);
  const effectiveFallback = baseDraft ?? resolved.value;
  const writeBase = (v: string) => {
    queueMutation({ type: 'updateInstancePropBase', nodeId, componentName, prop, value: v });
    flushNow();
    setBaseDraft(v);
  };

  const clearAll = () => {
    for (const l of Object.keys(state.entries)) {
      const e = state.entries[l];
      if (state.isReplica && state.vpWidth !== undefined) {
        // Replica removal = bake the base/default sentinel into this band
        // (styles parity) — even when only inheriting the base scope.
        write(l, localePropBakeValue(state));
      } else {
        if (e.base !== undefined) write(l, null);
        for (const w of Object.keys(e.byWidth)) {
          queueMutation({ type: 'updateLocaleInstanceProp', nodeId, componentName, prop, locale: l, value: null, bandQuery: bandQueryFor(Number(w)) });
        }
        flushNow();
      }
    }
    onClose();
  };

  const Editor = ({ value, onCommit }: { value: string; onCommit: (v: string) => void }) =>
    editorKind === 'color'
      ? <ColorInput value={value} onChange={onCommit} />
      : editorKind === 'number'
        ? <NumberVariableEditor value={value} onChange={onCommit}
            meta={{ control: numberMeta?.control ?? 'stepper', min: numberMeta?.min, max: numberMeta?.max, step: numberMeta?.step ?? 1 }} />
        : options && options.length > 0
          ? <ToolSelect value={value} onChange={onCommit} options={options} />
          : <ToolInput text value={value} onChange={onCommit} />;

  return (
    <ToolPopup isOpen onClose={onClose} title={propLabel} anchorRef={anchorRef} width={260}>
      <div className="flex flex-col gap-2.5 p-0.5" data-locale-prop-popup>
        {/* Variable row — blue Locale pill: BODY opens the Localization view,
            only the × removes (exact parity with the style popup). */}
        <ToolRow label="Variable">
          <button
            onClick={() => { setTranslationsOverlayOpen(true); onClose(); }}
            data-locale-variable-pill
            className="w-full h-8 flex items-center gap-2 pl-1 pr-2 cut-corners border border-transparent text-xs font-medium text-[var(--accent-fg)] cursor-pointer"
            style={{ backgroundColor: 'var(--accent)' }}
            title="Open Localization"
          >
            <span className="w-4 h-4 rounded bg-[var(--accent-fg)]/20 flex items-center justify-center shrink-0"><GlobeIcon /></span>
            <span className="truncate flex-1 text-left">Locale</span>
            <span role="button" onClick={(e) => { e.stopPropagation(); clearAll(); }} className="text-[var(--accent-fg)]/70 hover:text-[var(--accent-fg)] text-sm leading-none" title="Remove localization">×</span>
          </button>
        </ToolRow>
        <ToolRow label="">
          <ToolSelect value="convert" onChange={() => {}} options={[{ value: 'convert', label: 'Convert' }]} />
        </ToolRow>

        {locales.length === 0 && (
          <div className="text-xs text-[var(--text-disabled)] px-1 py-1">
            Add a language in the Localization panel first.
          </div>
        )}

        {conds.map((c, idx) => (
          <div key={`${c.locale}-${idx}`} className="border-t border-[var(--border-light)] mt-0.5 pt-2.5 flex flex-col gap-2.5" data-locale-prop-condition={c.locale}>
            <ToolRow label="When">
              <div className="flex items-center gap-1 w-full">
                <ToolSelect
                  value={c.locale}
                  onChange={(v) => {
                    // Move the value to the new locale scope.
                    const val = c.value || valueFor(c.locale);
                    if (valueFor(c.locale) !== '') write(c.locale, null);
                    if (val) write(v, val);
                    setConds((prev) => prev.map((cc, i) => (i === idx ? { locale: v, value: val } : cc)));
                  }}
                  options={locales.map((l) => ({ value: l.code, label: l.label, disabled: l.code !== c.locale && usedLocales.has(l.code) }))}
                />
                {conds.length > 1 && (
                  <RemoveButton onClick={() => {
                    if (valueFor(c.locale) !== '') write(c.locale, null);
                    setConds((prev) => prev.filter((_, i) => i !== idx));
                  }} />
                )}
              </div>
            </ToolRow>
            <ToolRow label="Set">
              <Editor
                value={c.value || effectiveFallback}
                onCommit={(v) => { write(c.locale, v); setConds((prev) => prev.map((cc, i) => (i === idx ? { ...cc, value: v } : cc))); }}
              />
            </ToolRow>
          </div>
        ))}

        {/* Fallback — the default-locale (base) prop value */}
        <div className="border-t border-[var(--border-light)] mt-0.5 pt-2.5 flex flex-col gap-2.5">
          <ToolRow label="Fallback">
            <Editor value={effectiveFallback} onCommit={writeBase} />
          </ToolRow>
          {nextFree && (
            <button
              onClick={() => {
                if (effectiveFallback) write(nextFree.code, effectiveFallback);
                setConds((prev) => [...prev, { locale: nextFree.code, value: effectiveFallback }]);
              }}
              className="w-full h-7 cut-corners text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              Add Condition
            </button>
          )}
        </div>
      </div>
    </ToolPopup>
  );
}

/** Row wrapper: blue Locale pill when the prop carries locale values on the
 *  current artboard, else the normal control. Consumes the convert flow's
 *  pending-open signal so Localize (menu) opens the popup immediately. */
export function LocalePropPillOr({ nodeId, componentName, prop, propLabel, options, fallback, editorKind, numberMeta, children }: {
  nodeId: string | null;
  componentName: string;
  prop: string;
  propLabel: string;
  options?: { value: string; label: string }[];
  /** The row's effective value — Fallback display for default-backed props. */
  fallback?: string;
  /** Renders the REAL control in Set/Fallback rows — ColorInput for colors,
   *  NumberVariableEditor (slider/stepper) for numbers — instead of a raw
   *  text input (the rgba-in-a-text-input / number-without-slider finds). */
  editorKind?: 'color' | 'number';
  /** Number editor knobs (only with editorKind 'number'). */
  numberMeta?: { control: 'slider' | 'stepper'; min?: number; max?: number; step?: number };
  children: React.ReactNode;
}) {
  const state = useLocalePropState(nodeId, prop, fallback);
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const localized = state.locales.length > 0;

  // Consume-once open signal from localizeInstanceProp (the menu item).
  if (nodeId && localized && _pendingOpenKey === `${nodeId}:${prop}` && !open) {
    _pendingOpenKey = null;
    setOpen(true);
  }

  if (!nodeId || !localized) return <>{children}</>;

  return (
    <>
      <button
        ref={pillRef}
        onClick={() => setOpen(true)}
        data-locale-prop-pill={prop}
        className="w-full h-8 flex items-center gap-2 pl-1 pr-2 cut-corners border border-transparent text-xs font-medium text-[var(--accent-fg)] cursor-pointer"
        style={{ backgroundColor: 'var(--accent)' }}
        title={`Localized · ${state.locales.join(', ')}`}
      >
        <span className="w-4 h-4 rounded bg-[var(--accent-fg)]/20 flex items-center justify-center shrink-0"><GlobeIcon /></span>
        <span className="truncate flex-1 text-left">Locale</span>
        <span
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            const bake = localePropBakeValue(state);
            for (const l of Object.keys(state.entries)) {
              if (state.isReplica) {
                // REPLICA ×: opt this replica out only — bake the effective
                // default into this band (the styles base-bake twin). The
                // primary keeps its localization; Reset Override re-inherits.
                queueMutation({
                  type: 'updateLocaleInstanceProp', nodeId, componentName, prop, locale: l,
                  value: bake, bandQuery: state.bandQuery,
                });
              } else {
                queueMutation({ type: 'updateLocaleInstanceProp', nodeId, componentName, prop, locale: l, value: null });
              }
            }
            flushNow();
            trace.action('locale-prop:pill-clear', { nodeId, prop, replica: state.isReplica });
          }}
          className="text-[var(--accent-fg)]/70 hover:text-[var(--accent-fg)] text-sm leading-none"
          title="Remove localization"
        >×</span>
      </button>
      {open && (
        <LocalePropPopup
          nodeId={nodeId}
          componentName={componentName}
          prop={prop}
          propLabel={propLabel}
          options={options}
          state={state}
          anchorRef={pillRef}
          onClose={() => setOpen(false)}
          fallback={fallback}
          editorKind={editorKind}
          numberMeta={numberMeta}
        />
      )}
    </>
  );
}
