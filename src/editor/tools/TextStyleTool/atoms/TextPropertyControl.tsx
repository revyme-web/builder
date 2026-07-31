import { useState, useEffect } from 'react';
import { ToolInput, ToolSlider, ToolSelect, ControlLabel } from '../../../controls';
import { resolveControl } from '../../../controls/control-registry';
import { LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { useControlOptional } from '../../../controls/ControlProvider';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { calculateFitViewBox } from '@/code/generation/fit-text-gen';
import { refitFitTextForStyles } from '../fit-refit';
import { useDebouncedCallback } from '../../../hooks/useDebouncedCallback';
import { useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { selectedNodeAtom, selectedIdsAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import { isReplicaViewportAtom, interactingViewportWidthAtom } from '@/code/stores/viewport-store';
import { containerOverridesAtom, getOverrideValue, hasOverrideAtWidth } from '@/code/stores/container-query-store';
import { findNodeComputedStyle, getInteractingViewport, forceCanvasRender, updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

/** Convert a font-size value to its visually-equivalent value in another
 *  unit. Without this, swapping the unit dropdown from `px` to `vw` keeps
 *  the same number (`56` → `56vw`) and the text balloons to ~56% of the
 *  viewport. We need to compute the current size in px and re-express it
 *  in the target unit so the rendered text stays the same size.
 *
 *  Why route through px: it's the lone unit every other unit can convert
 *  to/from. Going `vw → rem` directly needs the same intermediate.
 *
 *  Inputs:
 *   - currentPx: the rendered px size right now (from the bridge's
 *     computed-style cache, so `vw`/`em`/`rem`/`%` are already resolved
 *     against the simulated viewport / parent / root).
 *   - vpWidth: simulated viewport width in CSS px (NOT window.innerWidth) —
 *     `vw` rewrites need this to land at the correct fraction of the
 *     designed viewport, not the browser window the canvas sits in.
 *   - rootFontSizePx: html element's font-size for `rem` (defaults to 16
 *     if the user hasn't customized — accurate enough for unit swaps,
 *     and reading from the iframe document would be a bridge round-trip
 *     for marginal gain).
 *   - parentFontSizePx: only used for `em`. We pass the same `currentPx`
 *     when the parent value is unknown — in practice the user's element
 *     inherits its parent's font-size, so currentPx of the parent ≈ the
 *     resolved value the bridge gave us divided by the user's existing
 *     `em` multiplier — too lossy. Fallback to currentPx is safer (em=1
 *     after a swap = same size, rather than a blown-up ratio). */
function convertFontSizeUnit(
  currentPx: number,
  toUnit: string,
  vpWidth: number,
  rootFontSizePx = 16,
  parentFontSizePx?: number,
): number {
  switch (toUnit) {
    case 'px':
      return currentPx;
    case 'rem':
      return currentPx / rootFontSizePx;
    case 'em':
      // Without a reliable parent fontSize, treat current as parent —
      // a swap to em yields `1em` (same visual size). The user can
      // type a new number afterwards.
      return currentPx / (parentFontSizePx ?? currentPx);
    case 'vw':
      return (currentPx / vpWidth) * 100;
    case 'vh': {
      // vh in the canvas isn't tied to a real viewport height; use the
      // same heuristic Renderer.ts uses for vh→px: width × ratio per
      // device class. Inverse of that.
      const heightRatio = vpWidth >= 1024 ? 0.625 : vpWidth >= 500 ? 1.33 : 2.16;
      return (currentPx / (vpWidth * heightRatio)) * 100;
    }
    case 'pt':
      // 1pt = 4/3 px (CSS spec).
      return currentPx * 0.75;
    case '%':
      // % font-size is relative to parent font-size — same fallback as em.
      return (currentPx / (parentFontSizePx ?? currentPx)) * 100;
    default:
      return currentPx;
  }
}

/** Resolve the element's current font-size in px using the bridge's
 *  computed-style cache. Falls back to parsing the inline value if the
 *  cache miss (mid-render) gives nothing, and to a default of 16px so
 *  unit swaps never produce NaN. */
function resolveCurrentFontSizePx(
  nodeId: string | null,
  vpId: string,
  inlineValue: string,
  vpWidth: number,
): number {
  if (nodeId) {
    const computed = findNodeComputedStyle(nodeId, vpId, 'font-size');
    const px = parseFloat(computed);
    if (Number.isFinite(px) && px > 0) return px;
  }
  // Fallback: parse the inline value ourselves.
  const num = parseFloat(inlineValue) || 16;
  if (inlineValue.endsWith('px')) return num;
  if (inlineValue.endsWith('rem')) return num * 16;
  if (inlineValue.endsWith('em')) return num * 16;
  if (inlineValue.endsWith('vw')) return (num / 100) * vpWidth;
  if (inlineValue.endsWith('pt')) return num * (4 / 3);
  return num;
}

/** Round a converted number to a whole integer for display. Per user
 *  preference: unit swaps never produce decimal values — `56px → vw`
 *  rounds to `4vw` (not `3.9vw`), `56px → rem` rounds to `4rem` (not
 *  `3.5rem`). Acceptable visual drift since the user typically tweaks
 *  the number after the swap anyway, and integer values are cleaner
 *  in the JSX source. */
function formatConvertedValue(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n));
}

const FONT_SIZE_UNITS = [
  { value: 'px', label: 'px' },
  { value: 'rem', label: 'rem' },
  { value: 'em', label: 'em' },
  { value: 'vw', label: 'vw' },
  { value: 'clamp', label: 'clamp' },
  { value: 'fit', label: 'fit' },
];

const CLAMP_UNITS = [
  { value: 'px', label: 'px' },
  { value: 'rem', label: 'rem' },
  { value: 'em', label: 'em' },
  { value: 'vw', label: 'vw' },
];

interface ClampValues { minVal: string; minUnit: string; prefVal: string; prefUnit: string; maxVal: string; maxUnit: string }

function parseClamp(raw: string): ClampValues | null {
  const m = raw.match(/^clamp\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/);
  if (!m) return null;
  const parse = (s: string) => {
    const t = s.trim();
    const num = parseFloat(t) || 0;
    const unit = t.replace(/^-?[\d.]+/, '') || 'px';
    return { val: String(num), unit };
  };
  const min = parse(m[1]);
  const pref = parse(m[2]);
  const max = parse(m[3]);
  return { minVal: min.val, minUnit: min.unit, prefVal: pref.val, prefUnit: pref.unit, maxVal: max.val, maxUnit: max.unit };
}

function formatClamp(c: ClampValues): string {
  return `clamp(${c.minVal}${c.minUnit}, ${c.prefVal}${c.prefUnit}, ${c.maxVal}${c.maxUnit})`;
}

interface TextPropertyControlProps {
  property: string;
  label: string;
  /** External value (for preset editing mode) */
  value?: string;
  /** External onChange (for preset editing mode) */
  onChange?: (value: string) => void;
}

export function TextPropertyControl({ property, label, value: externalValue, onChange: externalOnChange }: TextPropertyControlProps) {
  const isExternal = externalValue !== undefined && externalOnChange !== undefined;
  // Only call useTextStyles when NOT in external mode (it requires ControlProvider)
  const text = isExternal ? null : useTextStyles(); // eslint-disable-line react-hooks/rules-of-hooks
  const { value: textValue, isMixed } = isExternal ? { value: externalValue!, isMixed: false } : text!.get(property);
  const value = isExternal ? externalValue! : textValue;
  const registryDef = resolveControl(property);

  const selectedId = useAtomValue(selectedNodeAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const selectedNode = useNode(selectedId) ?? null;
  const parentNode = useNode(selectedNode?.parentId) ?? null;
  const grandparentNode = useNode(parentNode?.parentId) ?? null;
  // FIT detection — resolve the wrapping `-svg` SVG from EITHER end of the chain:
  //   • the FIT SVG WRAPPER itself is selected — this is what the Fit toggle
  //     selects (`setSelectedIds([svgId])`) and what a click redirects to
  //     (redirectToFitTextWrapper), so it's the COMMON case that was missed →
  //     the control fell through to raw `px` (156) instead of Fit.
  //   • the inner text is selected: p → svg(-svg), or p → foreignObject → svg(-svg).
  const fitWrapperNode =
    (selectedNode?.type === 'svg' && selectedNode?.id?.endsWith('-svg')) ? selectedNode
    : (parentNode?.type === 'svg' && parentNode?.id?.endsWith('-svg')) ? parentNode
    : (parentNode?.type === 'foreignObject' && grandparentNode?.type === 'svg' && grandparentNode?.id?.endsWith('-svg')) ? grandparentNode
    : null;
  const isFitMode = property === 'fontSize' && !!fitWrapperNode;
  // FIT "Font Size" is DECOUPLED from the container width (design-tool parity). The
  // Size tool owns the SVG wrapper's `width` % (the div's width in its parent);
  // Font Size is the text's SCALE WITHIN that container — the reference applies
  // `transform: scale(x)` on the <foreignObject>. We apply it to the inner text
  // <p> (it carries a data-id → targetable; HTML default transform-origin is
  // center, matching the reference's `center center`). 100% = full fit, lower = smaller.
  const fitTextNode = useNodesComputed((nodes) => {
    if (!fitWrapperNode) return null;
    for (const childId of fitWrapperNode.children ?? []) {
      const child = nodes.get(childId);
      if (child?.type === 'foreignObject') {
        for (const innerId of child.children ?? []) {
          const inner = nodes.get(innerId);
          if (inner) return inner;
        }
      } else if (child) {
        return child; // parser may collapse the foreignObject → direct inner child
      }
    }
    return null;
  }, [fitWrapperNode]);
  // PER-VIEWPORT Fit% (design-tool parity): on a replica the scale reads/writes a
  // per-breakpoint @media override on the INNER text node — desktop keeps its
  // own value. Blue label + Reset Override mirror every other replica control.
  const isReplicaVp = useAtomValue(isReplicaViewportAtom);
  const interactingW = useAtomValue(interactingViewportWidthAtom);
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const fitScaleOverridden = !!(isReplicaVp && fitTextNode
    && hasOverrideAtWidth(containerOverrides, fitTextNode.id, 'transform', interactingW));
  const fitScalePct = (() => {
    const ovTransform = (isReplicaVp && fitTextNode)
      ? getOverrideValue(containerOverrides, fitTextNode.id, 'transform', interactingW)
      : null;
    const m = (ovTransform ?? fitTextNode?.styles?.transform ?? '').match(/scale\(\s*([\d.]+)/);
    return m ? Math.round(parseFloat(m[1]) * 100) : 100;
  })();

  // FIT re-fit on metric commits: Weight / Spacing change the text's measured
  // width, so the frozen viewBox no longer matches and `textAlign: center`
  // overflows the box asymmetrically (off-center look — same failure as a
  // font-family change, see fit-refit.ts). Debounced: the slider fires
  // setValue per drag tick; one re-fit lands after the drag settles.
  const pendingRefit = useRef<Record<string, string>>({});
  const refitDebounced = useDebouncedCallback(() => {
    const overrides = pendingRefit.current;
    pendingRefit.current = {};
    if (fitWrapperNode && Object.keys(overrides).length > 0) {
      void refitFitTextForStyles(fitWrapperNode.id, overrides);
    }
  }, 350);
  const setValue = isExternal ? externalOnChange! : (v: string) => {
    text!.set(property, v);
    // lineHeight included: the box HEIGHT derives from it (fit-measure) — a
    // 0.7 line-height with a stale box left a whitespace band under the ink.
    if (fitWrapperNode && (property === 'fontWeight' || property === 'letterSpacing' || property === 'lineHeight')) {
      pendingRefit.current[property] = v;
      refitDebounced.call();
    }
  };

  // Variable-bound shortcut: when this property is bound to a page-variable
  // / component-prop, swap the slider/input/select for the standard
  // VariableBoundPill — same UX as the StylesTool atoms (Opacity, Fill,
  // etc.). Skipped in `isExternal` mode (preset editor) where the
  // ControlProvider isn't mounted and the value is a buffer, not a node
  // style.
  const ctl = isExternal ? null : useControlOptional(); // eslint-disable-line react-hooks/rules-of-hooks
  const valueSource = ctl ? ctl.getValueSource(property) : null;
  const isVariableBound = valueSource?.source === 'prop' && !!valueSource.ref;

  // fontSize clamp state — declared UNCONDITIONALLY (before any early return).
  // It was previously inside the `property === 'fontSize'` branch BELOW the
  // variable-bound early return; once fontSize became variable-able, binding it
  // took that early return and skipped these hooks → "Rendered fewer hooks than
  // expected" crash. Hooks must run in the same order every render.
  const isClamp = value.startsWith('clamp(');
  const [clampState, setClampState] = useState<ClampValues>(
    (isClamp ? parseClamp(value) : null) || { minVal: '16', minUnit: 'px', prefVal: '4', prefUnit: 'vw', maxVal: '48', maxUnit: 'px' }
  );
  useEffect(() => {
    if (isClamp) {
      const p = parseClamp(value);
      if (p) setClampState(p);
    }
  }, [value, isClamp]);

  trace.fn('TextPropertyControl:render', { property, label, value, isMixed, isExternal, controlType: registryDef?.type, isFitMode, isVariableBound });

  if (isVariableBound && ctl && valueSource?.ref) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} plain={isExternal} />
        <div className="flex items-center gap-2 w-full">
          <LegacyVariableBoundPill
            property={property}
            propertyLabel={label}
            variableRef={valueSource.ref}
            currentValue={value || ''}
            removeVariable={ctl.removeVariable}
          />
        </div>
      </div>
    );
  }

  // Select-type properties (textTransform, whiteSpace, etc.)
  if (registryDef?.type === 'select') {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} plain={isExternal} />
        <ToolSelect value={isMixed ? '' : value} onChange={setValue} options={registryDef.options} />
      </div>
    );
  }

  // Special fontSize control with unit dropdown + clamp support
  if (property === 'fontSize' && registryDef?.type === 'numeric') {
    // `isClamp` / `clampState` / its sync effect are hoisted to the top of the
    // component (above the early returns) so hooks always run.
    const numValue = isClamp ? 0 : (parseFloat(value) || 0);
    const currentUnit = isFitMode ? 'fit' : isClamp ? 'clamp' : (value.replace(/^-?[\d.]+/, '') || 'px');

    const updateClamp = (patch: Partial<ClampValues>) => {
      const next = { ...clampState, ...patch };
      setClampState(next);
      setValue(formatClamp(next));
      trace.action('font-size:clamp-update', { clamp: formatClamp(next) });
    };

    const handleUnitChange = (newUnit: string) => {
      if (newUnit === currentUnit) return;

      if (newUnit === 'clamp') {
        // Switch to clamp — use current value as the max, derive min and preferred
        const fallbackMax = numValue || 48;
        const defaults: ClampValues = {
          minVal: String(Math.round(fallbackMax * 0.4)),
          minUnit: 'px',
          prefVal: String(Math.round(fallbackMax * 0.1)),
          prefUnit: 'vw',
          maxVal: String(fallbackMax),
          maxUnit: 'px',
        };
        setClampState(defaults);
        setValue(formatClamp(defaults));
        trace.action('font-size:switch-to-clamp', { defaults: formatClamp(defaults) });
        return;
      }

      if (currentUnit === 'clamp') {
        // Switch from clamp — use the max value as the new static value
        const maxNum = parseFloat(clampState.maxVal) || 16;
        setValue(`${maxNum}${newUnit}`);
        trace.action('font-size:switch-from-clamp', { newUnit, maxNum });
        return;
      }

      if (newUnit === 'fit' && selectedId) {
        const node = getNodesSnapshot().get(selectedId);
        const textContent = node?.textContent || '';
        const styles = node?.styles || {};
        const viewBox = calculateFitViewBox(textContent, styles);
        flushNow();
        queueMutation({ type: 'wrapFitText', nodeId: selectedId, viewBox });
        const svgId = `${selectedId}-svg`;
        setTimeout(() => setSelectedIds([svgId]), 150);
        trace.action('font-size:switch-to-fit', { nodeId: selectedId, viewBox });
        return;
      }

      if (currentUnit === 'fit' && selectedId) {
        // In FIT mode the SELECTION is the SVG WRAPPER — unwrap keys on the
        // INNER text id (unwrapFitText derives `<id>-svg` itself; passing the
        // wrapper id made it look for `…-svg-svg` = silent no-op, the
        // "stuck in fit" bug). Also: the fit fontSize is in viewBox UNITS —
        // convert to the VISUAL px (units × wrapperWidth/vbWidth × Fit%) so
        // the text keeps its on-screen size through the switch.
        const textId = fitTextNode?.id;
        if (!textId) return;
        const { vpId, vpWidth } = getInteractingViewport();
        const unitPx = parseFloat(fitTextNode?.styles?.fontSize ?? '') || 16;
        const vbW = parseFloat(String((fitWrapperNode?.attrs as any)?.viewBox ?? '').split(/\s+/)[2] ?? '') || 0;
        const wrapperW = parseFloat(findNodeComputedStyle(selectedId, vpId, 'width')) || 0;
        const visualPx = (vbW > 0 && wrapperW > 0)
          ? unitPx * (wrapperW / vbW) * (fitScalePct / 100)
          : unitPx;
        const newValue = newUnit === 'px'
          ? `${Math.round(visualPx)}px`
          : `${formatConvertedValue(convertFontSizeUnit(visualPx, newUnit, vpWidth))}${newUnit}`;
        flushNow();
        queueMutation({ type: 'unwrapFitText', nodeId: textId });
        queueMutation({ type: 'updateStyles', nodeId: textId, styles: { fontSize: newValue } });
        flushNow();
        forceCanvasRender();
        // The wrapper node no longer exists — move selection to the text node.
        setTimeout(() => setSelectedIds([textId]), 100);
        trace.action('font-size:switch-from-fit', { textId, newUnit, unitPx, vbW, wrapperW, visualPx, newValue });
        return;
      }

      // Visually-equivalent unit conversion. Read the bridge's resolved
      // font-size in px (already accounts for whatever the current unit
      // is — vw against simulated viewport, em against parent, etc.),
      // then express that px in the new unit. Without this the user
      // swap from `56px` → `vw` would write `56vw` and balloon the text;
      // with it, `56px` becomes `~3.89vw` at vp=1440, looking identical.
      const { vpId, vpWidth } = getInteractingViewport();
      const currentPx = resolveCurrentFontSizePx(selectedId ?? null, vpId, value, vpWidth);
      const converted = convertFontSizeUnit(currentPx, newUnit, vpWidth);
      const newValue = `${formatConvertedValue(converted)}${newUnit}`;
      trace.action('font-size:unit-swap', {
        from: `${numValue}${currentUnit}`,
        to: newValue,
        currentPx,
        vpWidth,
      });
      setValue(newValue);
    };

    // FIT "Font Size" scales the inner <p> via `transform: scale()` (center
    // origin) = the reference's foreignObject scale. 100% = full fit; can exceed 100%
    // to overflow (SVG overflow:visible). LIVE (chevron drag / scrub) patches
    // the DOM only via `updateNodeStyles({ domOnly: true })` — no per-tick code
    // write/reparse (which tanked FPS). COMMIT (release / typed) writes once.
    // Same live/commit split as the color + slider + Transition controls.
    const fitScaleStyles = (v: string) => {
      const pct = Math.max(1, Math.min(1000, Math.round(parseFloat(v) || 100)));
      return { pct, styles: { transform: `scale(${(pct / 100).toFixed(4)})`, transformOrigin: 'center' } };
    };
    const liveFitScale = (v: string) => {
      if (!fitTextNode) return;
      const { pct, styles } = fitScaleStyles(v);
      const contentEl = getContentRoot();
      if (contentEl) updateNodeStyles({ id: fitTextNode.id, styles, contentEl, domOnly: true });
      trace.action('font-size:fit-scale-live', { textId: fitTextNode.id, pct });
    };
    const commitFitScale = (v: string) => {
      if (!fitTextNode) return;
      const { pct, styles } = fitScaleStyles(v);
      if (isReplicaVp) {
        // Per-breakpoint override — desktop/base keeps its own Fit%.
        queueMutation({ type: 'updateContainerStyle', nodeId: fitTextNode.id, maxWidth: interactingW, styles });
      } else {
        queueMutation({ type: 'updateStyles', nodeId: fitTextNode.id, styles });
      }
      // Panel-driven change on a non-selected node doesn't patch the canvas on
      // its own → flush code + force a re-render so it's committed live.
      flushNow();
      forceCanvasRender();
      trace.action('font-size:fit-scale', { textId: fitTextNode.id, pct, perViewport: isReplicaVp, vpWidth: isReplicaVp ? interactingW : undefined });
    };
    // Reset Override (replica chevron): drop THIS breakpoint's transform pair —
    // the tile falls back to the base Fit%.
    const resetFitScaleOverride = () => {
      if (!fitTextNode) return;
      queueMutation({ type: 'updateContainerStyle', nodeId: fitTextNode.id, maxWidth: interactingW, styles: { transform: '', transformOrigin: '' } });
      flushNow();
      forceCanvasRender();
      trace.action('font-size:fit-scale-reset-override', { textId: fitTextNode.id, vpWidth: interactingW });
    };

    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex items-center justify-between w-full">
          <ControlLabel
            label={label}
            property={property}
            plain={isExternal && !fitScaleOverridden}
            overridden={isFitMode && fitScaleOverridden}
            onResetOverride={isFitMode && fitScaleOverridden ? resetFitScaleOverride : undefined}
          />
          <div className="flex items-center gap-1 w-full">
            <div className="flex-1 min-w-0">
              <ToolInput
                value={isMixed ? '' : isFitMode ? String(fitScalePct) : isClamp ? '' : String(numValue)}
                onChange={(v) => {
                  if (isFitMode && fitTextNode) commitFitScale(v);
                  else if (currentUnit !== 'clamp') setValue(`${parseFloat(v) || 0}${currentUnit}`);
                }}
                onChangeLive={isFitMode && fitTextNode ? liveFitScale : undefined}
                onCommit={isFitMode && fitTextNode ? commitFitScale : undefined}
                step={registryDef.step ?? 1}
                disabled={currentUnit === 'clamp'}
              />
            </div>
            <div className="flex-1 min-w-0">
              <ToolSelect
                value={currentUnit}
                onChange={handleUnitChange}
                options={FONT_SIZE_UNITS}
              />
            </div>
          </div>
        </div>
        {currentUnit === 'clamp' && (
          <div className="flex flex-col gap-1.5 pl-[25%]">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)] w-8 shrink-0">Min</span>
              <ToolInput value={clampState.minVal} onChange={(v) => updateClamp({ minVal: v })} step={1} />
              <ToolSelect value={clampState.minUnit} onChange={(v) => updateClamp({ minUnit: v })} options={CLAMP_UNITS} />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)] w-8 shrink-0">Pref</span>
              <ToolInput value={clampState.prefVal} onChange={(v) => updateClamp({ prefVal: v })} step={0.5} />
              <ToolSelect value={clampState.prefUnit} onChange={(v) => updateClamp({ prefUnit: v })} options={CLAMP_UNITS} />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)] w-8 shrink-0">Max</span>
              <ToolInput value={clampState.maxVal} onChange={(v) => updateClamp({ maxVal: v })} step={1} />
              <ToolSelect value={clampState.maxUnit} onChange={(v) => updateClamp({ maxUnit: v })} options={CLAMP_UNITS} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Default numeric with slider (lineHeight, letterSpacing, fontWeight, etc.)
  if (registryDef?.type === 'numeric') {
    const numValue = parseFloat(value) || 0;
    const unit = value.replace(/^-?[\d.]+/, '') || (property === 'lineHeight' ? '' : 'px');
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} plain={isExternal} />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider
            value={isMixed ? 0 : numValue}
            min={registryDef.min ?? 0}
            max={registryDef.max ?? 100}
            step={registryDef.step ?? 1}
            onChange={(v) => setValue(`${v}${unit}`)}
          />
          <ToolInput
            value={isMixed ? '' : (property === 'lineHeight' ? value : String(numValue))}
            onChange={(v) => {
              if (property === 'lineHeight') setValue(v);
              else setValue(`${parseFloat(v) || 0}${unit}`);
            }}
            step={registryDef.step ?? 1}
          />
        </div>
      </div>
    );
  }

  // Fallback: plain text input
  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property={property} plain={isExternal} />
      <ToolInput value={isMixed ? '' : value} onChange={setValue} text />
    </div>
  );
}
