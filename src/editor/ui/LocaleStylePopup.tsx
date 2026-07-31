// LocaleStylePopup.tsx — the "Localize" convert flow on a style control
// (localization overhaul Phase 4):
//
//   Variable   [🌐 Locale ×]      ← blue pill; × removes the whole localization
//              [Convert      ▾]
//   ─────────────────────────
//   When       [French       ▾]   ← per-condition locale select
//   Set        <the property's REAL control (color picker slide-in, radius
//               corner cluster, numeric input, select…)>
//   ─────────────────────────
//   Fallback   <same control editing the BASE (default-locale) value>
//              [Add Condition]
//
// Conditions persist as `:lang(xx)` CSS rules (updateLocaleStyle mutations) —
// they ship verbatim to the live site and preview on canvas per active locale.

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import ToolPopup from './ToolPopup';
import ToolRow from '@/editor/controls/ToolRow';
import ToolSelect from '@/editor/controls/ToolSelect';
import ToolInput from '@/editor/controls/ToolInput';
import ToolSlider from '@/editor/controls/ToolSlider';
import ColorInput from '@/editor/controls/ColorInput';
import SpacingControl from '@/editor/controls/SpacingControl';
import { RemoveButton } from '@/editor/controls/RemoveButton';
import { resolveControl } from '@/editor/controls/control-registry';
import { getAlignOptions, getJustifyOptions } from '@/editor/controls/css-property-options';
import { resolveVariableEditor } from '@/editor/controls/variable-editor-registry';
import { UnifiedControlProvider } from '@/editor/controls/unified';
import { codeAtom, nodesAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeComputedStyle } from '@/canvas/node-ops';
import { i18nConfigAtom } from '@/code/stores/locale-store';
import { useSetAtom } from 'jotai';
import { translationsOverlayOpenAtom } from '@/editor/left-toolbar/panels/LocalePanel';
import { parseLocaleRulesScoped, localeOffMarker } from '@/code/generation/locale-gen';
import { useLocaleStyleState, localeScopeOf } from '@/editor/controls/LocaleBoundPill';
import { extractStyleCSS } from '@/code/parsing/parser';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { toKebab } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';

// ─── Value-type helpers (mirrors StyleField's detection) ───────────────────

const COLOR_PROPS = new Set([
  'backgroundColor', 'background', 'color', 'borderColor', 'fill', 'stroke',
  'outlineColor', 'textDecorationColor', 'caretColor', 'accentColor',
]);

function isColorValue(v: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/.test(v) || /^hsla?\(/.test(v);
}

/** Parse a radius shorthand into 4 corners (TL TR BR BL). */
function radiusCorners(v: string): [string, string, string, string] {
  const parts = (v || '0px').trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}
function serializeCorners(c: [string, string, string, string]): string {
  return c.every(x => x === c[0]) ? c[0] : c.join(' ');
}

/** The property's REAL value control with an explicit value/onChange —
 *  same resolution the VariableModal default-value editor uses. ColorInput
 *  slides its picker inside the surrounding ToolPopup automatically. */
export function LocaleValueEditor({ property, value, onChange, onChangeLive, flexDirection }: {
  property: string;
  value: string;
  onChange: (v: string) => void;
  /** The node's flex direction — align/justify use the Layout tool's
   *  direction-aware labels (Top/Bottom/Left/Right…), not raw CSS values. */
  flexDirection?: string;
  /** Per-frame drag updates (color picker scrub) — local/DOM-only; the code
   *  write happens ONCE via onChange on release. Without this, every picker
   *  frame ran queueMutation+flushNow (full write+reparse) — the "super slow
   *  color drag" report. */
  onChangeLive?: (v: string) => void;
}) {
  const registryDef = useMemo(() => resolveControl(property), [property]);

  // Align/Justify: the EXACT same direction-aware option labels the Layout
  // tool shows (Top/Center/Bottom/Between/… in a column) — never the raw
  // flex-start/flex-end wording.
  if (property === 'alignItems' || property === 'justifyContent') {
    const opts = property === 'alignItems' ? getAlignOptions(flexDirection) : getJustifyOptions(flexDirection);
    return (
      <ToolSelect
        value={value}
        onChange={onChange}
        options={opts.map(o => ({ value: o.value, label: o.label ?? o.value }))}
      />
    );
  }

  // THE REAL CONTROL FIRST — the same mechanism the Variable modal uses:
  // resolveVariableEditor maps a property to its actual panel atom (Padding's
  // 4-side cluster, Gap slider, Direction arrows, …) mounted in
  // variableDefault mode over an explicit value/onChange buffer. Only
  // properties without a dedicated atom fall through to the generic editors.
  const EditorAtom = useMemo(() => resolveVariableEditor(property), [property]);
  if (EditorAtom) {
    return (
      <UnifiedControlProvider
        property={property}
        mode="variableDefault"
        externalValue={value}
        externalOnChange={onChange}
        externalOnChangeLive={onChangeLive ?? onChange}
        hideLabel
      >
        <EditorAtom mode="variableDefault" externalValue={value} externalOnChange={onChange} externalOnChangeLive={onChangeLive ?? onChange} hideLabel />
      </UnifiedControlProvider>
    );
  }

  if (property === 'borderRadius') {
    const corners = radiusCorners(value);
    return (
      <SpacingControl
        values={corners}
        labels={['TL', 'TR', 'BR', 'BL']}
        onChange={(i, v) => {
          const next = [...corners] as [string, string, string, string];
          next[i] = v;
          onChange(serializeCorners(next));
        }}
        onChangeAll={(v) => onChange(v)}
      />
    );
  }
  if (COLOR_PROPS.has(property) || isColorValue(value)) {
    return <ColorInput value={value || '#000000'} onChange={onChange} onChangeLive={onChangeLive ?? (() => {})} showAlpha />;
  }
  const numericDef = registryDef?.type === 'numeric' ? registryDef : null;
  if (registryDef?.type === 'select' && registryDef.options) {
    return (
      <ToolSelect
        value={value}
        onChange={onChange}
        options={registryDef.options.map(o => ({ value: o.value, label: o.label ?? o.value }))}
      />
    );
  }
  if (numericDef || /^-?[\d.]+(?:px|%|em|rem|vh|vw|deg|fr|s|ms)?$/.test(value)) {
    // Registry numerics with bounds render the SAME slider+input pair the
    // real control uses (opacity etc.); unbounded numerics keep the input.
    if (numericDef && numericDef.min !== undefined && numericDef.max !== undefined) {
      const num = parseFloat(value) || 0;
      return (
        <div className="flex items-center gap-2 w-full">
          <ToolSlider
            value={num} min={numericDef.min} max={numericDef.max} step={numericDef.step ?? 0.01}
            onChange={(v) => (onChangeLive ?? onChange)(String(v))}
            onCommit={(v) => onChange(String(v))}
          />
          <ToolInput value={value} onChange={onChange} step={numericDef.step ?? 1} min={numericDef.min} max={numericDef.max} />
        </div>
      );
    }
    return <ToolInput value={value} onChange={onChange} step={numericDef?.step ?? 1} min={numericDef?.min} max={numericDef?.max} />;
  }
  return <ToolInput value={value} onChange={onChange} text />;
}

// ─── The popup ─────────────────────────────────────────────────────────────

export default function LocaleStylePopup({ property, propertyLabel, nodeId, baseValue, isOpen, onClose, anchorRef, onChangeBase, onChangeBaseLive }: {
  property: string;
  /** Display title (e.g. "Fill", "Radius") — falls back to the property. */
  propertyLabel?: string;
  nodeId: string;
  baseValue: string;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Writes the BASE (default-locale) value — the Fallback row's editor.
   *  ControlLabel passes its updateStyle. Omitted → fallback is read-only. */
  onChangeBase?: (v: string) => void;
  /** Live (per-frame) twin for the Fallback editor's scrubs. */
  onChangeBaseLive?: (v: string) => void;
}) {
  const config = useAtomValue(i18nConfigAtom);
  const code = useAtomValue(codeAtom);
  const setTranslationsOverlayOpen = useSetAtom(translationsOverlayOpenAtom);
  const defaultLocale = config?.defaultLocale ?? 'en';
  const locales = useMemo(
    () => (config?.locales ?? []).filter(l => l.code !== defaultLocale),
    [config, defaultLocale],
  );

  // Per-ARTBOARD effective :lang() values: the interacting replica's band
  // overlays the base rules; writes scope to the same band so every replica
  // carries its own localization (or none) independently.
  const artboard = useLocaleStyleState(property, nodeId);
  // The base value may arrive empty (some labels don't thread their control's
  // value) — resolve it: prop → parsed node style → computed. Without a real
  // base, convert-on-open can't seed and Fallback shows nothing.
  const nodes = useAtomValue(nodesAtom);
  const vpIdForComputed = useAtomValue(interactingViewportIdAtom);
  const effectiveBase = useMemo(() => {
    if (baseValue) return baseValue;
    const st = nodes.get(nodeId)?.styles ?? {};
    const aliases: Record<string, string[]> = {
      backgroundColor: ['background'], background: ['backgroundColor'],
      borderRadius: ['borderTopLeftRadius'], color: [],
    };
    const styleVal = st[property] ?? (aliases[property] ?? []).map(a => st[a]).find(Boolean);
    if (styleVal) return styleVal;
    try {
      const computed = findNodeComputedStyle(nodeId, vpIdForComputed, property);
      // Reject the browser's non-values ('normal' for unset gap/lineHeight,
      // 'auto', 'none') — seeding \`gap: normal !important\` is junk; fall
      // through to the CSS-initial map instead. Same filter the variable-
      // creation seed uses.
      if (computed && computed !== 'normal' && computed !== 'auto' && computed !== 'none') return computed;
    } catch { /* fall through */ }
    // Well-known CSS initial values — properties rarely present inline
    // (opacity, overflow…) still need a base for convert-on-open + Fallback.
    const CSS_INITIAL: Record<string, string> = {
      opacity: '1', overflow: 'visible', display: 'flex', visibility: 'visible',
      padding: '0px', margin: '0px', gap: '0px', borderRadius: '0px',
    };
    return CSS_INITIAL[property] ?? '';
  }, [baseValue, nodes, nodeId, property, vpIdForComputed]);
  const persisted = useMemo(() => {
    const out: Record<string, string> = {};
    const kebab = toKebab(property);
    const { global, banded, variants } = parseLocaleRulesScoped(extractStyleCSS(code));
    for (const l of locales) {
      const base = global.get(l.code)?.get(nodeId)?.get(kebab);
      if (base !== undefined) out[l.code] = base;
    }
    if (artboard.isReplica && (artboard.vpWidth || artboard.variantName)) {
      for (const l of locales) {
        const props = artboard.variantName
          ? variants.get(artboard.variantName)?.get(l.code)?.get(nodeId)
          : banded.get(artboard.vpWidth!)?.get(l.code)?.get(nodeId);
        if (!props) continue;
        if (props.get(localeOffMarker(kebab)) !== undefined) { delete out[l.code]; continue; }
        const v = props.get(kebab);
        if (v !== undefined) out[l.code] = v;
      }
    }
    return out;
  }, [code, nodeId, property, locales, artboard.isReplica, artboard.vpWidth, artboard.variantName]);

  // Condition list — seeded from persisted rules; empty → one blank condition
  // on the first non-default locale (the "convert" starting state).
  const [conds, setConds] = useState<{ locale: string; value: string }[]>(() => {
    const seeded = locales.filter(l => persisted[l.code] !== undefined)
      .map(l => ({ locale: l.code, value: persisted[l.code] }));
    return seeded.length > 0 ? seeded : (locales[0] ? [{ locale: locales[0].code, value: '' }] : []);
  });

  // RESEED ON ARTBOARD CHANGE — Shift+B (or any replica switch) while the
  // popup is open must re-derive the condition values for the NEW artboard;
  // `conds` is mount-seeded state, so without this the Set fields kept the
  // previous artboard's values while Fallback (live-derived) moved (user
  // rule 2026-07-22: every localization popup always reflects the selected
  // artboard).
  const artboardKey = `${nodeId}:${property}:${artboard.isReplica ? (artboard.variantName ?? artboard.vpWidth) : 'primary'}`;
  const prevArtboardKeyRef = useRef(artboardKey);
  useEffect(() => {
    if (prevArtboardKeyRef.current === artboardKey) return;
    prevArtboardKeyRef.current = artboardKey;
    const seeded = locales.filter(l => persisted[l.code] !== undefined)
      .map(l => ({ locale: l.code, value: persisted[l.code] }));
    setConds(seeded.length > 0 ? seeded : (locales[0] ? [{ locale: locales[0].code, value: '' }] : []));
    trace.action('locale-style-popup:artboard-reseed', { nodeId, property, artboardKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artboardKey]);

  // AUTO-CLOSE when the localization vanishes on this artboard (the pill's ×
  // in the properties panel, a replica removal, or an undo) — the popup is a
  // view over those rules and must not linger over a de-localized control.
  // Gated on having SEEN rules so convert-on-open's brief empty first frame
  // doesn't self-close.
  const hadRulesRef = useRef(false);
  useEffect(() => {
    const hasEffective = artboard.locales.length > 0
      || Object.keys(persisted).length > 0
      || (!artboard.removed && artboard.baseLocales.length > 0);
    if (hasEffective) { hadRulesRef.current = true; return; }
    if (hadRulesRef.current) {
      trace.action('locale-style-popup:auto-close-delocalized', { nodeId, property });
      onClose();
    }
  }, [artboard.locales.length, artboard.removed, artboard.baseLocales.length, persisted, nodeId, property, onClose]);

  const write = (locale: string, value: string) => {
    trace.action('locale-style-popup:write', { nodeId, property, locale, value, vpWidth: artboard.isReplica ? artboard.vpWidth : null });
    // REPLICA: scope the rule to this artboard's @media band (and clear any
    // removal marker — setting a value re-enables the localization here).
    // PRIMARY: top-level base rule.
    if (artboard.isReplica && (artboard.vpWidth || artboard.variantName)) {
      queueMutation({
        type: 'updateLocaleStyle', nodeId, locale, ...localeScopeOf(artboard),
        styles: { [property]: value, [localeOffMarker(toKebab(property))]: '' },
      });
    } else {
      queueMutation({ type: 'updateLocaleStyle', nodeId, locale, styles: { [property]: value } });
    }
    flushNow();
  };

  // CONVERT ON OPEN: clicking "Localize" must apply immediately — the first
  // condition is written with the CURRENT base value right away, so the
  // control turns into the blue Locale pill without an extra tweak. (Runs
  // once, only when nothing is persisted yet and a base value exists.)
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (Object.keys(persisted).length === 0 && effectiveBase && conds[0]) {
      trace.action('locale-style-popup:auto-convert', { nodeId, property, locale: conds[0].locale, value: effectiveBase });
      write(conds[0].locale, effectiveBase);
      setConds(prev => prev.map((c, i) => (i === 0 ? { ...c, value: effectiveBase } : c)));
    } else {
      trace.action('locale-style-popup:auto-convert-skip', {
        nodeId, property, persistedCount: Object.keys(persisted).length,
        effectiveBase, hasCond: !!conds[0],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCondValue = (idx: number, value: string) => {
    setConds(prev => prev.map((c, i) => (i === idx ? { ...c, value } : c)));
    write(conds[idx].locale, value);
  };

  const setCondLocale = (idx: number, locale: string) => {
    const prev = conds[idx];
    if (prev.locale === locale) return;
    // Move the rule: clear the old locale's value, write it on the new one.
    if (prev.value) {
      write(prev.locale, '');
      write(locale, prev.value);
    }
    setConds(list => list.map((c, i) => (i === idx ? { ...c, locale } : c)));
  };

  const removeCond = (idx: number) => {
    const c = conds[idx];
    if (c.value) write(c.locale, '');
    setConds(list => list.filter((_, i) => i !== idx));
  };

  const clearAll = () => {
    // Same responsive semantics as the pill's × in the properties panel:
    // on a REPLICA, removing the localization opts THIS artboard out only
    // (banded base-bake + --locale-off marker — the base rules stay for the
    // other viewports); on the PRIMARY it clears the localization globally.
    if (artboard.isReplica && (artboard.vpWidth || artboard.variantName)) {
      trace.action('locale-style-popup:remove-replica', { nodeId, property, vpWidth: artboard.vpWidth, variantName: artboard.variantName });
      const kebab = toKebab(property);
      const affected = new Set([...artboard.baseLocales, ...artboard.locales]);
      for (const locale of affected) {
        queueMutation({
          type: 'updateLocaleStyle', nodeId, locale, ...localeScopeOf(artboard),
          styles: { [property]: effectiveBase || 'unset', [localeOffMarker(kebab)]: '1' },
        });
      }
      flushNow();
      onClose();
      return;
    }
    trace.action('locale-style-popup:clear-all', { nodeId, property });
    for (const c of conds) if (c.value) write(c.locale, '');
    for (const l of locales) if (persisted[l.code] !== undefined) write(l.code, '');
    onClose();
  };

  const usedLocales = new Set(conds.map(c => c.locale));
  const nextFree = locales.find(l => !usedLocales.has(l.code));

  if (!isOpen) return null;
  return (
    <ToolPopup isOpen onClose={onClose} title={propertyLabel ?? property} anchorRef={anchorRef} width={260}>
      <div className="flex flex-col gap-2.5 p-0.5" data-locale-style-popup>
        {/* Variable row — blue Locale pill: BODY opens the Localization
            view, only the × removes the localization. */}
        <ToolRow label="Variable">
          <button
            onClick={() => { setTranslationsOverlayOpen(true); onClose(); }}
            data-locale-variable-pill
            className="w-full h-8 flex items-center gap-2 pl-1 pr-2 rounded-[var(--radius-lg)] border border-transparent text-xs font-medium text-white cursor-pointer"
            style={{ backgroundColor: 'var(--accent)' }}
            title="Open Localization"
          >
            <span className="w-4 h-4 rounded bg-white/20 flex items-center justify-center shrink-0">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
              </svg>
            </span>
            <span className="truncate flex-1 text-left">Locale</span>
            <span role="button" onClick={(e) => { e.stopPropagation(); clearAll(); }} className="text-white/70 hover:text-white text-sm leading-none" title="Remove localization">×</span>
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

        {/* Conditions — When <locale> / Set <real control> */}
        {conds.map((c, idx) => (
          <React.Fragment key={`${c.locale}-${idx}`}>
            <div className="border-t border-[var(--border-light)] mt-0.5 pt-2.5 flex flex-col gap-2.5" data-locale-condition={c.locale}>
              <ToolRow label="When">
                <div className="flex items-center gap-1 w-full">
                  <ToolSelect
                    value={c.locale}
                    onChange={(v) => setCondLocale(idx, v)}
                    options={locales.map(l => ({
                      value: l.code,
                      label: l.label,
                      disabled: l.code !== c.locale && usedLocales.has(l.code),
                    }))}
                  />
                  {conds.length > 1 && <RemoveButton onClick={() => removeCond(idx)} />}
                </div>
              </ToolRow>
              <ToolRow label="Set">
                <LocaleValueEditor
                  property={property}
                  value={c.value || effectiveBase}
                  onChange={(v) => setCondValue(idx, v)}
                  onChangeLive={(v) => setConds(prev => prev.map((cc, i) => (i === idx ? { ...cc, value: v } : cc)))}
                  flexDirection={nodes.get(nodeId)?.styles?.flexDirection}
                />
              </ToolRow>
            </div>
          </React.Fragment>
        ))}

        {/* Fallback — the default-locale (base) value, real control */}
        <div className="border-t border-[var(--border-light)] mt-0.5 pt-2.5 flex flex-col gap-2.5">
          <ToolRow label="Fallback">
            {onChangeBase ? (
              <LocaleValueEditor property={property} value={effectiveBase} onChange={onChangeBase} onChangeLive={onChangeBaseLive} flexDirection={nodes.get(nodeId)?.styles?.flexDirection} />
            ) : (
              <span className="text-xs text-[var(--text-disabled)] truncate" title={effectiveBase}>{effectiveBase || '—'}</span>
            )}
          </ToolRow>
          {nextFree && (
            <button
              onClick={() => {
                // Same convert-immediately rule: a new condition applies the
                // base value right away instead of sitting empty.
                if (effectiveBase) write(nextFree.code, effectiveBase);
                setConds(prev => [...prev, { locale: nextFree.code, value: effectiveBase || '' }]);
              }}
              data-locale-add-condition
              className="w-full h-8 rounded-[var(--radius-lg)] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-xs text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              Add Condition
            </button>
          )}
        </div>
      </div>
    </ToolPopup>
  );
}
