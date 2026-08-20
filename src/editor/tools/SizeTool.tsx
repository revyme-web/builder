// SizeTool.tsx — Width/Height controls matching old builder design.
// Each dimension: label (W/H) + value input + unit selector (px/%/auto/fill).
// Inset mode awareness: when L+R pinned, W updates right inset.
// Fill mode: maps to CSS `flex: N 0 0px` when parent is flex along that axis.

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useLivePreview } from '../hooks/useLivePreview';
import { useAtomValue, useSetAtom, getDefaultStore } from 'jotai';
import { canvasInteractingAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import { injectFlexLayoutOnFrame, shouldInjectLayoutOnAuto, freezeParentRelativeChildrenForAuto } from './layout-injection';
import { viewportsConfigAtom, viewportWidthsAtom, syncViewportWidths, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { applyViewportWidthChange } from '@/code/generation/viewport-width-rewrite';
import { activeFilePathAtom, isVectorSetComponentFile } from '@/code/project/active-file-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { setForceRender, queueMutation } from '@/code/mutation/mutation-queue';
import { FIT_SIZE, isFitSize } from '@/shared/constants';
import { ToolSection, ToolInput, ToolSelect } from '../controls';
import { isPrimaryViewport } from '@/canvas/node-ops';
import { useControl } from '../controls/ControlProvider';
import ControlLabel from '../controls/ControlLabel';
import { getInsetState, computeDimensionInsetStyles, parsePx } from '@/shared/pin-utils';
import { findNodeSize, findNodeParentInnerSize, findNodeComputedStyles, forceCanvasRender, getInteractingViewport } from '@/canvas/node-ops';
import { beginViewportWidthScrub, type ViewportWidthScrub } from '@/canvas/resize/viewport-width-scrub';
import { canUseFill, isMainAxis, isFillMode, getFillMultiplier, makeFillFlex, parseFlex, formatFlex, crossAxisFillPatch } from '@/shared/flex-helpers';
import { convertPxToDimUnit, estimatedVpHeight, pickLiveDim, fitSizeRedirectTarget, exitFillFlexPatch, isAutoDim } from './size-helpers';
import { resizeLiveOps } from '@/canvas/resize/resize-live-store';
import { trace } from '@/shared/debug-trace';

// ─── Unit parsing ───────────────────────────────────────────────────────────

type DimUnit = 'px' | '%' | 'auto' | 'vw' | 'vh' | 'fill';

function parseValue(raw: string): { num: number; unit: DimUnit } {
  // The "auto" unit (shown as Fit) maps from the CSS Fit values — `min-content`
  // (current), legacy `auto`, and `fit-content`/`max-content`.
  if (!raw || isFitSize(raw)) return { num: 0, unit: 'auto' };
  const match = raw.match(/^(-?[\d.]+)\s*(px|%|vw|vh)?$/);
  if (match) return { num: parseFloat(match[1]), unit: (match[2] || 'px') as DimUnit };
  return { num: 0, unit: 'auto' };
}

function formatValue(num: number, unit: DimUnit): string {
  if (unit === 'auto') return FIT_SIZE; // "Fit" → min-content (NOT auto — see constants)
  if (unit === 'fill') return ''; // fill is handled via flex property, not width/height
  return `${num}${unit}`;
}

/** Round a `<number>px` dimension string to a whole pixel for DISPLAY only
 *  (the stored value keeps its precision). A baked SVG-group resize produces
 *  3-decimal px (e.g. `1318.731px`); the Dimensions panel should read like a
 *  normal frame's integer px. Non-px values (`%`, `auto`, `fill`, `vw`…) pass
 *  through untouched. */
function roundPxDisplay(v: string | undefined | null): string | undefined {
  if (v == null) return v ?? undefined;
  const m = /^(-?\d*\.?\d+)px$/.exec(v.trim());
  return m ? `${Math.round(parseFloat(m[1]))}px` : v;
}

// ─── Unit options ───────────────────────────────────────────────────────────

const UNIT_OPTIONS: { value: string; label: string }[] = [
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'auto', label: 'auto' },
  { value: 'vw', label: 'vw' },
  { value: 'vh', label: 'vh' },
];

// ─── Dimension Row ──────────────────────────────────────────────────────────

function DimensionRow({ label, property, value, onChange, onChangeLive, onUnitChange, computedSize, parentSize, unitOptions, currentUnit, chevronLabel, disabled, overridden, onResetOverride, hideResetStyle }: {
  label: string;
  /** CSS property name. When provided, the row uses ControlLabel — gets accent color
   *  on responsive override and a click-to-reset menu. Pass `undefined` for non-style
   *  rows (e.g. the FIT pseudo-row). */
  property?: string;
  value: string;
  onChange: (v: string) => void;
  /** Live scrub callback — imperative DOM patch per drag frame (60fps); commit via onChange on release.
   *  Without it, the ToolInput scrubber falls back to onChange every frame (modifyProjectFile → reparse →
   *  re-render) which tanks FPS on Min/Max/Width/Height drags (the user-reported lag vs the gap handle). */
  onChangeLive?: (v: string) => void;
  onUnitChange: (fromUnit: DimUnit, toUnit: DimUnit, currentNum: number) => void;
  computedSize: number;
  parentSize: number;
  unitOptions: { value: string; label: string; disabled?: boolean }[];
  /** Override detected unit (e.g. 'fill' when fill mode is active) */
  currentUnit?: DimUnit;
  /** Override label shown on the unit selector chevron (e.g. 'fr') */
  chevronLabel?: string;
  /** Disable input (e.g. FIT height) */
  disabled?: boolean;
  /** Force the responsive-override accent on the label even when the
   *  ControlProvider's `hasOverride` would say no. Used by the
   *  viewport-frame Height row, whose override state lives in the
   *  `@canvas` viewport config (vp.height per replica vs primary), not
   *  in the @media style map ControlLabel normally consults. */
  overridden?: boolean;
  /** Custom reset handler — replaces the default `updateStyle('', '')`
   *  action ControlLabel applies. Same hook ContentControl uses for
   *  text-content overrides. For viewport height it pulls the replica's
   *  vp.height back to the primary's value. */
  onResetOverride?: () => void;
  /** Suppress the default "Remove" menu entry. Use when the row's
   *  displayed value does NOT come from `styles[property]` — e.g. the
   *  viewport-frame Height row reads `currentViewportConfig.height` so
   *  clearing `styles.height` would wipe the root div's CSS height,
   *  not the value the user sees. */
  hideResetStyle?: boolean;
}) {
  const parsed = parseValue(value);
  const activeUnit = currentUnit ?? parsed.unit;
  const isAuto = activeUnit === 'auto';
  const isFill = activeUnit === 'fill';

  // Display value: computed size when auto/disabled, multiplier when fill, otherwise actual value
  const displayValue = disabled
    ? String(Math.round(computedSize) || 0)
    : isFill
      ? value
      : isAuto ? String(Math.round(computedSize) || 0) : String(parsed.num);

  const handleNumChange = (v: string) => {
    if (isFill) {
      // In fill mode, pass through the raw multiplier value
      onChange(v);
      return;
    }
    const num = parseFloat(v) || 0;
    // When auto: typing a value switches to px mode
    if (isAuto) {
      onUnitChange('auto', 'px', num);
      return;
    }
    onChange(formatValue(num, activeUnit));
  };

  // Live scrub: same formatting as handleNumChange but routes to the imperative patch (no code write). The
  // auto→px switch is a unit change (commit) so it's never live; fill passes the raw multiplier through.
  const handleNumChangeLive = (v: string) => {
    if (!onChangeLive || disabled) return;
    if (isFill) { onChangeLive(v); return; }
    if (isAuto) return;
    onChangeLive(formatValue(parseFloat(v) || 0, activeUnit));
  };

  const handleUnitChange = (newUnit: string) => {
    const u = newUnit as DimUnit;
    if (u === activeUnit) return;

    // Delegate unit switching to parent via onUnitChange
    onUnitChange(activeUnit, u, parsed.num);
  };

  return (
    <div className="flex items-center justify-between w-full">
      {property
        // `hideCreateVariable` — width / height (and the min/max
        // variants this row also serves) carry unit-suffixed length
        // values (`100px`, `50%`, `auto`, `fit-content`, …) that don't
        // round-trip cleanly through the variable system's `number`
        // type. The user-visible affordance to "Create Variable" from
        // these rows is misleading: even when it succeeds, binding
        // the variable back via `style={{ width: cardW }}` strips the
        // unit and produces an unrendered `width: 100` (no `px`).
        // Hide the entry entirely until we add a dedicated `length`
        // variable type. Same rationale `pageVariableTypeForProperty`
        // in `page-variables.ts` already documents — this just makes
        // the UI match the data layer.
        ? <ControlLabel label={label} property={property} overridden={overridden} onResetOverride={onResetOverride} hideResetStyle={hideResetStyle} hideCreateVariable />
        // `pl-[18px] -ml-[18px]` mirrors ControlLabel's chevron-gutter geometry
        // so rows that fall into the plain-label branch claim the SAME flex
        // width as rows that use ControlLabel. Without it the negative margin
        // present only on ControlLabel makes its flex item 18 px narrower in
        // the main-axis layout, and the value column on those rows ends up
        // 18 px wider than on plain-label rows — visible misalignment
        // between, e.g., the viewport-frame Width row (plain) and the
        // Height row (ControlLabel) sitting right above each other.
        : <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px] mr-[2px]">{label}</span>
      }
      <div className="flex items-center gap-1 w-full">
        <div className="flex-1">
          <ToolInput
            value={displayValue}
            onChange={disabled ? () => {} : handleNumChange}
            onChangeLive={disabled || !onChangeLive ? undefined : handleNumChangeLive}
            // With a live (DOM-only) scrub the chevron drag commits on mouseup via `onCommit`, NOT `onChange`
            // (which only fired per-frame in the non-live path). Without this the drag would live-patch then
            // REVERT to the start value on release (no code write). Routes through handleNumChange to format.
            onCommit={disabled ? undefined : handleNumChange}
            step={isFill ? 1 : 1}
            className={isAuto || disabled ? 'opacity-50' : ''}
            chevronLabel={isFill ? 'fr' : chevronLabel}
            disabled={disabled}
          />
        </div>
        <div className="flex-1">
          <ToolSelect
            value={activeUnit}
            onChange={handleUnitChange}
            options={unitOptions}
          />
        </div>
      </div>
    </div>
  );
}

import { SELF_ALIGN_OPTIONS } from '../controls/css-property-options';

// ─── Flex child sub-controls ─────────────────────────────────────────────────

// FlexChildSection removed — flex props now inline in SizeTool render

// ─── SizeTool ───────────────────────────────────────────────────────────────

interface Props {
  styles: Record<string, string>;
  nodeId: string;
  vpId: string;
  onUpdate: (key: string, value: string) => void;
  onUpdateMultiple: (styles: Record<string, string>) => void;
  /** Overlays MUST stay fixed px (auto/%/vw/vh break the portal's
   *  offsetWidth/offsetHeight-based align + collision math) — restrict the
   *  width/height unit picker to px only. */
  pxOnly?: boolean;
}

/** Is this axis in FILL mode? Main-axis fill = a fill flex with no explicit
 *  size — EXCEPT when the fill flex comes from a viewport OVERRIDE
 *  (`fillFromOverride`): a replica's Fill writes `flex: 1 0 0px` into the
 *  @media map but the PRIMARY's inline height/width stays in the base styles
 *  (the base belongs to the primary — the override writer must not touch it).
 *  CSS ignores the size anyway (flex-basis 0 governs the main axis), but the
 *  size guard used to veto the fill display, so the replica's Height row kept
 *  showing the primary's px with no override accent (user report 2026-07-28).
 *  Exported for tests. */
export function axisFillActive(
  flexVal: string,
  sizeVal: string | undefined,
  canFill: boolean,
  isMain: boolean,
  fillFromOverride: boolean,
): boolean {
  return canFill && isMain && isFillMode(flexVal) && (!sizeVal || isFitSize(sizeVal) || fillFromOverride);
}

export default function SizeTool({ styles: stylesProp, nodeId: nodeIdProp, vpId, onUpdate: onUpdateProp, onUpdateMultiple: onUpdateMultipleProp, pxOnly }: Props) {
  const { parentLayout, parentFlexDirection, node, updateStyleLive, hasOverride } = useControl();
  // FIT-TEXT REDIRECT — selecting the INNER <p> of a fit pair (layers panel,
  // exiting text edit) must size the SVG WRAPPER. The inner's width/height
  // ('auto' + the Fit% scale transform) are the fit contract's internals, not
  // user-facing size — showing them here surfaced an uneditable "auto" Width.
  // Canvas clicks already redirect (redirectToFitTextWrapper); this mirrors
  // that for the panel: read the wrapper's styles, write to the wrapper's id.
  const fitRedirectId = useNodesComputed(
    (nodes) => fitSizeRedirectTarget(nodes, nodeIdProp),
    [nodeIdProp],
  );
  const isFitInnerRedirect = fitRedirectId != null;
  const nodeId = fitRedirectId ?? nodeIdProp;
  const fitWrapperNode = useNode(fitRedirectId);
  const styles = isFitInnerRedirect
    ? ((fitWrapperNode?.styles ?? {}) as Record<string, string>)
    : stylesProp;
  const onUpdate = useCallback((prop: string, value: string) => {
    if (isFitInnerRedirect) {
      trace.action('size:fit-inner-redirect-write', { inner: nodeIdProp, wrapper: `${nodeIdProp}-svg`, prop, value });
      queueMutation({ type: 'updateStyles', nodeId: `${nodeIdProp}-svg`, styles: { [prop]: value } });
      return;
    }
    onUpdateProp(prop, value);
  }, [isFitInnerRedirect, nodeIdProp, onUpdateProp]);
  const onUpdateMultiple = useCallback((updates: Record<string, string>) => {
    if (isFitInnerRedirect) {
      trace.action('size:fit-inner-redirect-write-multi', { inner: nodeIdProp, wrapper: `${nodeIdProp}-svg`, props: Object.keys(updates) });
      queueMutation({ type: 'updateStyles', nodeId: `${nodeIdProp}-svg`, styles: updates });
      return;
    }
    onUpdateMultipleProp(updates);
  }, [isFitInnerRedirect, nodeIdProp, onUpdateMultipleProp]);
  const isTopLevel = !!(node?.isCanvasNode) || !node?.parentId;
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const inset = useMemo(() => getInsetState(styles), [styles]);
  const isFitSvgWrapper = nodeId.endsWith('-svg') && styles.height === 'auto' && styles.width;

  // Viewport frame: when the page root (`root` on a bare page or
  // `layout::root` on a templated one) is selected, the Width row is no
  // longer a CSS dimension but the viewport's BREAKPOINT WIDTH from the
  // `/** @canvas { viewports } */` block. Showing the JSX `width: '100%'`
  // here was misleading — the user expects to see / change the canvas
  // breakpoint number (e.g. 1440 for desktop). Height stays computed-auto
  // because viewports always stretch to content.
  const isViewportFrame = nodeId === 'root' || nodeId === 'layout::root';
  const viewportsConfig = useAtomValue(viewportsConfigAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);

  // ── Design-instance hug state (instance-auto-size) ───────────────────────
  // A hug branch ('auto' in the instance's dim style ternary) is BAKED to the
  // master's concrete value at parse time (instance hug bake,
  // project-parser.ts), so the resolved styles carry a definite px and every
  // legacy write/accent/reset path just works. `hugDims` — stamped by the
  // bake — is how the panel knows the SOURCE says auto for the active
  // variant, so the unit dropdown shows Auto instead of the baked px.
  const dimHug = useCallback((dim: 'width' | 'height'): boolean => {
    if (!node || node.componentFile == null) return false;
    const hugged = node.hugDims?.[dim];
    if (!hugged) return false;
    const active = activeComponentVariant && activeComponentVariant !== 'default' ? activeComponentVariant : 'default';
    return hugged.includes(active);
  }, [node, activeComponentVariant]);
  const widthHug = dimHug('width');
  const heightHug = dimHug('height');
  const setViewportsConfig = useSetAtom(viewportsConfigAtom);
  const setViewportWidths = useSetAtom(viewportWidthsAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const currentViewportConfig = isViewportFrame
    ? viewportsConfig.find(v => v.id === vpId)
    : undefined;
  // Primary viewport / variant gate for the Width + Height row menus.
  // On the primary there's no responsive override to "reset to" —
  // clicking Remove would just wipe the base inline width / height
  // and collapse the element to its content-determined size, which is
  // never what the user means by a width/height row's menu action.
  // Component-master variants reuse the viewport mechanism (each
  // variant is a viewport id), so this single check covers both the
  // "primary viewport" and "primary variant" cases the user pointed
  // out. On replicas the reset-override flow goes through the
  // dedicated `onResetOverride` handler — that one stays available.
  const isPrimary = isPrimaryViewport(vpId);

  // Vector sets are aspect-locked, so a width override always implies the
  // matching height override (and vice versa). Resetting just one would leave
  // the replica at a non-matching aspect — reset BOTH so it snaps back to the
  // primary's locked ratio. Only fires when a "Reset Override" is actually
  // shown (i.e. the dimension is overridden on this replica/variant).
  const isVectorSet = !!node && isVectorSetComponentFile(node.componentFile);
  const resetVectorSetSize = useCallback(
    () => onUpdateMultiple({ width: '', height: '' }),
    [onUpdateMultiple],
  );

  // Width-change flow mirrors the viewport-handle drag-resize path
  // (`SelectionOverlay.tsx:268-285`):
  //   1. Update `viewportWidthsAtom` + `syncViewportWidths` — Canvas.tsx:408
  //      uses `vpWidths[v.id] ?? v.width` when computing `activeViewports`,
  //      so this seeds the runtime width before the iframe re-render below.
  //   2. Update `viewportsConfigAtom` — persists to the @canvas block so the
  //      breakpoint survives across sessions.
  //   3. Rewrite `@container` media-query breakpoints in the active code via
  //      `rewriteContainerBreakpoints` so responsive overrides re-bucket
  //      against the new width range. `setForceRender()` first so the queue
  //      flush inside `modifyProjectFile` doesn't trip the canvas-update
  //      skip guard.
  //   4. `forceCanvasRender()` to actually push the new viewport width to
  //      the iframe NOW. Without this, the React render effect would either
  //      (a) be skipped because the user is mid-chevron-drag and
  //      `interacting === true`, or (b) not refire after release because
  //      none of its deps changed since the last skipped invocation. The
  //      forced render reads viewport state imperatively from `jotaiStore`
  //      (see Canvas.tsx:435-485), so it picks up the writes from steps
  //      1-2 even before React has committed.
  // LIVE scrub for the breakpoint chevron: mirror the tile-drag gesture.
  // Dirty ONLY the widths atom + registry (the tile tracks the scrub per
  // frame); the CONFIG — the band-keying truth — stays untouched until the
  // single commit on release. Before this row had a live handler, ToolInput's
  // chevron fell back to firing the FULL commit per hold-repeat tick (50ms),
  // each with the render-closure's stale prevWidth — the second tick rewrote
  // from a width the bands no longer carried and every @media override
  // stranded at an intermediate key ("chevron loses all overrides while the
  // tile drag keeps them", 2026-08-17).
  //
  // The live half is the SHARED viewport-width scrub session (the same
  // band-pin + imperative-patch + band-crossing-render machinery the tile
  // drag runs in ResizeManager): on the first tick it pins the tile's
  // resolution width so page content stays visually intact for the whole
  // gesture, each tick patches only the tile box through the bridge, and a
  // full render fires only at responsive-boundary crossings. The pin is
  // released at commit, whose render ships the final truth.
  const scrubRef = useRef<ViewportWidthScrub | null>(null);
  // Unmount mid-scrub (selection change while holding the chevron): release
  // the pin and repaint, or the tile stays frozen on the pinned inline state.
  useEffect(() => () => {
    if (scrubRef.current) {
      scrubRef.current.end();
      scrubRef.current = null;
      forceCanvasRender();
    }
  }, []);
  const handleViewportBreakpointLive = useCallback((raw: string) => {
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) return;
    const rounded = Math.round(num);
    if (!scrubRef.current) {
      const startWidth = getDefaultStore().get(viewportsConfigAtom).find(v => v.id === vpId)?.width ?? rounded;
      scrubRef.current = beginViewportWidthScrub({ vpId, nodeId, startWidth, activeFilePath });
    }
    scrubRef.current.tick(rounded);
  }, [vpId, nodeId, activeFilePath]);

  const handleViewportBreakpointChange = useCallback((raw: string) => {
    // Release the live scrub's band pin FIRST — before any early return —
    // so a scrub that lands back on the start width still unpins. The
    // commit render below ships bandPin:null and re-stamps containerType
    // (the drag's commit path skips the manual DOM restore the same way).
    // Early-return paths get an explicit render for the same reason: the
    // pinned render left containerType: normal + pinned inline styles on
    // the tile, and only a post-unpin render clears them.
    const hadScrub = !!scrubRef.current;
    scrubRef.current?.end();
    scrubRef.current = null;
    const bail = () => { if (hadScrub) forceCanvasRender(); };
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) return bail();
    const rounded = Math.round(num);
    // Read the pre-change width from the CONFIG at call time — never from the
    // render closure. Rapid consecutive commits (Enter+blur, chevron click
    // then type) run before React re-renders this component, and a stale
    // closure width makes the band rewrite move from a key that no longer
    // exists. The config is only written by commits, so it is always the
    // width the bands are currently keyed by (same rule the tile-drag path
    // documents in SelectionOverlay's onViewportResize).
    const prevWidth = getDefaultStore().get(viewportsConfigAtom).find(v => v.id === vpId)?.width ?? rounded;
    if (prevWidth === rounded) return bail();

    setViewportWidths(prev => {
      const updated = { ...prev, [vpId]: rounded };
      syncViewportWidths(updated);
      return updated;
    });
    if (activeFilePath) {
      setForceRender();
      // Re-stamp every width-keyed artifact (@media bands, animation gates,
      // data-responsive, responsive text) in the active file AND its
      // route-group companions — a templated page's LayoutClient carries its
      // own bands/gates and must move with the page or the template chrome
      // loses its overrides at the new width. Shared with the tile-drag path.
      //
      // ORDER IS LOAD-BEARING: this runs BEFORE setViewportsConfig writes the
      // new width into the file's @canvas block. The band rewrite's
      // normalize pass converges stray bands onto the FILE's config keys —
      // with the new config already committed, the still-old-keyed band
      // reads as a stray, and when the new width lands inside a WIDER band's
      // interval the viewport flattens from THAT band (mobile got a copy of
      // the tablet rules) while its real band is dropped ("width input
      // removes all the overrides", trace 2026-08-17: normalize-band-keys
      // dropped:[298]). The tile-drag path always had this order.
      applyViewportWidthChange(activeFilePath, vpId, prevWidth, rounded);
    }
    setViewportsConfig(prev => prev.map(v => v.id === vpId ? { ...v, width: rounded } : v));
    forceCanvasRender();
    trace.action('size:viewport-breakpoint-change', { vpId, prevWidth, newWidth: rounded });
  }, [vpId, activeFilePath, setViewportsConfig, setViewportWidths]);

  // Viewport HEIGHT change: writes the `height` field on the viewport
  // config (persisted to @canvas) AND mirrors the change onto the root
  // div's inline `style.height` in the JSX so the source file matches
  // what the canvas renders. Both writes happen for the PRIMARY
  // viewport — the JSX root div is the primary's source of truth. For
  // REPLICAS, only the @canvas config is touched (the JSX is shared
  // across viewports and replica heights are runtime-applied by the
  // Renderer).
  //
  // `'auto'` is stored EXPLICITLY (string) rather than removed, so the
  // user's intent round-trips through the @canvas block and the next
  // open of the file shows the same Height dropdown state. The matching
  // `height: 'auto'` lands on the root div's JSX style at the same
  // time, otherwise the file would still say `height: '900px'` and the
  // Renderer's runtime override would diverge from the source code.
  const handleViewportHeightChange = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const isAuto = trimmed === '' || trimmed === 'auto';
    const num = isAuto ? 0 : parseFloat(trimmed);
    const rounded = Number.isFinite(num) && num > 0 ? Math.round(num) : 0;

    setViewportsConfig(prev => prev.map(v => {
      if (v.id !== vpId) {
        // PRIMARY HEIGHT BROADCAST — same rule as SelectionOverlay's
        // onViewportResize commit: every replica persists its OWN vp.height
        // copy (seeded at creation), so a primary-only write leaves the
        // replicas' stale copies to re-apply on the commit re-render —
        // after the live scrub mirrored them, mouseup snapped them back
        // ("replicas revert on mouseup", 2026-08-07). A px height set on
        // the PRIMARY writes onto every replica too; editing a replica
        // touches only that replica, and auto never broadcasts (overlay
        // parity).
        if (currentViewportConfig?.isPrimary && !isAuto && rounded > 0) {
          return { ...v, height: rounded };
        }
        return v;
      }
      if (isAuto) return { ...v, height: 'auto' as const };
      if (rounded === 0) {
        // Defensive — invalid input (NaN, 0). Drop the field rather
        // than persist a meaningless value.
        const { height: _drop, ...rest } = v;
        return rest as typeof v;
      }
      return { ...v, height: rounded };
    }));

    // Mirror to the JSX root div's inline style on the PRIMARY viewport.
    // The replica path skips this write — replica heights are runtime
    // overrides applied by the Renderer per viewport, and the JSX root
    // div is the primary's source code.
    if (currentViewportConfig?.isPrimary) {
      if (isAuto) {
        onUpdate('height', 'auto');
      } else if (rounded > 0) {
        onUpdate('height', `${rounded}px`);
      }
    }

    forceCanvasRender();
    trace.action('size:viewport-height-change', {
      vpId, height: isAuto ? 'auto' : (rounded || 'unset'),
      mirroredToRoot: !!currentViewportConfig?.isPrimary,
    });
  }, [vpId, setViewportsConfig, currentViewportConfig?.isPrimary, onUpdate]);

  const getComputedSize = useCallback(() => {
    // IMPORTANT: read width/height from `getComputedStyle` (logical CSS px)
    // rather than `findNodeSize` (which derives from `getBoundingClientRect`
    // inside the iframe — and the iframe's contentRoot carries the canvas
    // zoom transform, so the rect width/height are in TRANSFORMED screen
    // pixels). At any zoom != 100%, using the rect value as the px seed
    // when converting auto→px (or fill→px, or any unit→px) collapsed/grew
    // the node by exactly the zoom ratio.
    //
    // Two failure modes we need to handle:
    //  1. Cache miss / first render — fall back to the synthetic
    //     `__offsetWidth`/`__offsetHeight` keys (also logical px, also
    //     transform-immune) before the rect-based fallback kicks in.
    //  2. CSS height resolves to `auto` (e.g. the viewport root with
    //     `style.height = ''`). `parseFloat('auto') = NaN → 0`, which
    //     used to fall through to the rect fallback and collapse the
    //     viewport to transformed pixels at low zoom. `__offsetHeight`
    //     returns the actual rendered content height regardless.
    const cs = findNodeComputedStyles(nodeId, vpId, ['width', 'height', '__offsetWidth', '__offsetHeight']);
    const cssWidth = parseFloat(cs.width) || 0;
    const cssHeight = parseFloat(cs.height) || 0;
    const offsetWidth = parseFloat(cs.__offsetWidth) || 0;
    const offsetHeight = parseFloat(cs.__offsetHeight) || 0;
    const rectSize = (cssWidth > 0 && cssHeight > 0) || (offsetWidth > 0 && offsetHeight > 0)
      ? null
      : findNodeSize(nodeId, vpId);
    const parentSize = findNodeParentInnerSize(nodeId, vpId);
    return {
      width: cssWidth || offsetWidth || rectSize?.width || 0,
      height: cssHeight || offsetHeight || rectSize?.height || 0,
      parentWidth: parentSize.width,
      parentHeight: parentSize.height,
    };
  }, [nodeId, vpId]);

  const handleViewportHeightUnitChange = useCallback((_from: DimUnit, to: DimUnit) => {
    if (to === 'auto') {
      handleViewportHeightChange('');
    } else if (to === 'px') {
      // Switching auto → px: seed with the viewport root's actual rendered
      // content height so the viewport stays the same size after the swap.
      // Measure live (rather than reading a closure-captured `computed`)
      // so the seed is always the current rendered size, not a value from
      // the previous render. `getComputedSize` falls back to the iframe's
      // `__offsetHeight` synthetic key when CSS resolves to `auto`, so this
      // returns logical CSS px regardless of canvas zoom. Without that
      // fallback the seed came from the canvas-transformed rect height
      // and the viewport collapsed by the zoom factor on every auto→px swap.
      const live = getComputedSize();
      const seed = Math.round(live.height || 0) || 100;
      handleViewportHeightChange(String(seed));
    }
  }, [handleViewportHeightChange, getComputedSize]);

  // Live dimensions: poll DOM during resize for real-time feedback.
  // Kept until the next styles-change render (so we don't flicker back to
  // the stale source value between mouseup and the mutation flush).
  //
  // Anchor the poll to the inline `width`/`height` the element had AT
  // INTERACTION START — only push to `liveSize` when the DOM has CHANGED
  // from that anchor. A resize handler patches inline width on every
  // frame, so the anchor diverges and `liveSize` reflects the live value.
  // A pure drag (no size change) leaves the anchor matching every frame,
  // so `liveSize` stays null and the dropdown keeps reading
  // `styles.width` — which is the right behaviour for a component
  // instance with no explicit width/height in JSX. Without the anchor
  // gate the poll grabbed the master root's inline defaults
  // (`width: '868px'`) on frame 0 and that stale string survived the
  // drag end, flipping the unit chevron from `auto` to `px` even though
  // the source code never gained a width property.
  // Cleared when styles update (mutation flushed — styles are fresh).
  const [liveSize, setLiveSize] = useLivePreview<{ w: string; h: string }>([styles.width, styles.height]);
  useEffect(() => {
    if (!isInteracting) return;
    let rafId: number;
    let anchorW: string | null = null;
    let anchorH: string | null = null;
    const poll = () => {
      // Prefer the ResizeManager broadcast: the EXACT formatted string it's
      // committing, in the authored unit (vh/%/px). The canvas DOM can't give
      // this — it lives in the sandbox iframe (a parent-frame element read
      // returns null) and the bridge only exposes COMPUTED styles, which
      // resolve vh/% → px.
      const live = resizeLiveOps.get();
      let w = live && live.nodeId === nodeId ? (live.width || '') : '';
      let h = live && live.nodeId === nodeId ? (live.height || '') : '';
      // A baked SVG-group resize updates the iframe element + the bridge computed
      // cache without a ResizeManager broadcast — fall back to the cache so the
      // group's width/height sync LIVE (parity with a normal frame, whose
      // broadcast the branch above picks up).
      if (!w || !h) {
        const cs = findNodeComputedStyles(nodeId, vpId, ['width', 'height']);
        // The computed backfill exists for the baked SVG-group resize, which
        // updates the iframe element without a ResizeManager broadcast. It must
        // NOT fill an axis the user authored as AUTO: computed height is always
        // a px number, so a width-only drag (`direction: 'right'`) made the
        // Height row read `px` for the length of the gesture and snap back to
        // `auto` on mouseup — the axis was never being resized at all (user
        // report 2026-08-08, a component instance with width px + height auto).
        // A genuine height resize still shows live px: that value arrives on
        // the BROADCAST path above, which this guard doesn't touch.
        if (!w && cs.width && !isAutoDim(styles.width)) w = cs.width;
        if (!h && cs.height && !isAutoDim(styles.height)) h = cs.height;
      }
      if (anchorW === null) {
        anchorW = w;
        anchorH = h;
      } else if (w !== anchorW || h !== anchorH) {
        setLiveSize(prev => (prev?.w === w && prev?.h === h) ? prev : { w, h });
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [isInteracting, nodeId, vpId]);

  const computed = getComputedSize();

  // ─── Fill mode detection ───────────────────────────────────────────────
  const flexVal = styles.flex || '';
  const widthCanFill = canUseFill(parentLayout, parentFlexDirection, 'width');
  const heightCanFill = canUseFill(parentLayout, parentFlexDirection, 'height');
  const widthIsMainAxis = isMainAxis(parentFlexDirection, 'width');
  const heightIsMainAxis = isMainAxis(parentFlexDirection, 'height');

  // Main-axis fill: flex grow with no width/height → shows multiplier (Nfr)
  // Cross-axis fill: NOT auto-detected (100% is ambiguous). User selects fill via dropdown.
  // `flexFillOverridden`: the fill flex comes from THIS viewport's override map
  // (replica @media / variant object) — the primary's inline size stays in the
  // base styles, so the size guard inside axisFillActive must be waived AND the
  // row must show the override accent + Reset Override (see axisFillActive).
  const flexFillOverridden = !isPrimary && hasOverride('flex') && isFillMode(flexVal);
  const isWidthFillMain = axisFillActive(flexVal, styles.width, widthCanFill, widthIsMainAxis, flexFillOverridden);
  const isWidthFillCross = false; // cross-axis fill not auto-detected
  const isWidthFill = isWidthFillMain;

  const isHeightFillMain = axisFillActive(flexVal, styles.height, heightCanFill, heightIsMainAxis, flexFillOverridden);
  const isHeightFillCross = false; // cross-axis fill not auto-detected
  const isHeightFill = isHeightFillMain;

  const fillMultiplier = getFillMultiplier(flexVal);

  // Reset Override for an override-sourced fill: clear the `flex` override so
  // the axis falls back to the primary's base size. Only the flex layer is
  // cleared — an earlier size override (if any) resurfaces, matching the
  // one-layer-at-a-time semantics of every other Reset Override.
  const resetFlexFillOverride = useCallback(() => {
    onUpdate('flex', '');
    trace.action('size:reset-fill-override', { nodeId, vpId });
  }, [onUpdate, nodeId, vpId]);

  trace.fn('SizeTool:render', { nodeId, parentLayout, parentFlexDirection, flexVal, isWidthFill, isHeightFill, fillMultiplier, flexFillOverridden });

  // ─── Unit options (add 'fill' when parent is flex along that axis) ────
  //
  // CODE COMPONENT instances are FIXED-size: the bundle's internals are a
  // black box, so an `auto` wrapper collapses whenever the root draws via
  // absolute/100% children (the tiny-overlay bug). `auto` is greyed out for
  // them — same UX as the reference's disabled "Fit Content" on code components.
  // Concrete units (px/%/vw/vh/fill) all resolve to a definite size and
  // stay available.
  const selfNodeSub = useNode(nodeId);
  const isCodeComponentInstance = selfNodeSub?.isCodeComponent === true;
  const disableAutoForCode = useCallback(
    (opts: { value: string; label: string; disabled?: boolean }[]) =>
      isCodeComponentInstance
        ? opts.map(o => o.value === 'auto' ? { ...o, disabled: true } : o)
        : opts,
    [isCodeComponentInstance],
  );

  const widthUnitOptions = useMemo(() => {
    if (pxOnly) return UNIT_OPTIONS.map(o => o.value === 'px' ? o : { ...o, disabled: true });
    if (isTopLevel) {
      return disableAutoForCode(UNIT_OPTIONS.map(o => o.value === 'px' || o.value === 'auto' ? o : { ...o, disabled: true }));
    }
    if (!widthCanFill) return disableAutoForCode(UNIT_OPTIONS);
    return disableAutoForCode([...UNIT_OPTIONS, { value: 'fill', label: 'fill' }]);
  }, [widthCanFill, isTopLevel, pxOnly, disableAutoForCode]);

  const heightUnitOptions = useMemo(() => {
    if (pxOnly) return UNIT_OPTIONS.map(o => o.value === 'px' ? o : { ...o, disabled: true });
    if (isTopLevel) {
      return disableAutoForCode(UNIT_OPTIONS.map(o => o.value === 'px' || o.value === 'auto' ? o : { ...o, disabled: true }));
    }
    if (!heightCanFill) return disableAutoForCode(UNIT_OPTIONS);
    return disableAutoForCode([...UNIT_OPTIONS, { value: 'fill', label: 'fill' }]);
  }, [heightCanFill, isTopLevel, pxOnly, disableAutoForCode]);

  // Min/max width/height accept ONLY Fixed (px) or % — auto/vw/vh don't apply as a
  // constraint (clearing a min/max = REMOVE the row via its ×, not an "auto" unit).
  // On a top-level node (a design-component variant root or a canvas node) a '%'
  // has no sizing parent to resolve against, so it's disabled there → px only.
  const minMaxUnitOptions = useMemo(() => {
    const base = UNIT_OPTIONS.filter(o => o.value === 'px' || o.value === '%');
    if (isTopLevel) return base.map(o => o.value === 'px' ? o : { ...o, disabled: true });
    return base;
  }, [isTopLevel]);

  // px↔% switch for a min/max row. Reuses the resize converter (% relative to the
  // parent's inner size); vp dims are irrelevant here since vw/vh aren't offered.
  const minMaxUnitChange = useCallback((prop: 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', to: DimUnit) => {
    const isW = prop === 'minWidth' || prop === 'maxWidth';
    const px = Math.round((isW ? computed.width : computed.height) || 0);
    const parent = isW ? computed.parentWidth : computed.parentHeight;
    const next = convertPxToDimUnit(px, to, parent, 0, 0);
    trace.action('size:minmax-unit', { prop, to, px, parent, next });
    onUpdate(prop, next);
  }, [computed.width, computed.height, computed.parentWidth, computed.parentHeight, onUpdate]);

  // ─── Aspect Ratio Lock ─────────────────────────────────────────────────
  //
  // Stored as the CSS `aspect-ratio` property (`"1.5 / 1"` standard
  // format). When locked, CSS maintains the ratio for us: we set
  // `aspect-ratio` AND flip ONE of width/height to `auto` so the browser
  // computes the other from the ratio. Lock toggle reads the current
  // computed CSS pixel dimensions through the bridge (`computed.width/height`
  // already go through `findNodeComputedStyles`, which returns logical CSS
  // px regardless of canvas zoom) — that's the source-of-truth for the
  // ratio. Unlocking writes back the visible pixel value so the auto
  // dimension doesn't collapse the moment the lock comes off.
  const aspectRatioValue = styles.aspectRatio || '';
  const isAspectRatioLocked = !!aspectRatioValue
    && aspectRatioValue !== 'auto'
    && aspectRatioValue !== 'unset';

  // Parse a CSS `aspect-ratio` value into a numeric width/height ratio.
  // Accepts `"1.5 / 1"`, `"16 / 9"`, or a bare `"1.5"`. Null when missing
  // or malformed — callers fall back to the normal (unlocked) write path.
  const aspectRatioNum = useMemo(() => {
    if (!isAspectRatioLocked) return null;
    const s = String(aspectRatioValue).trim();
    const slash = s.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    if (slash) {
      const a = parseFloat(slash[1]);
      const b = parseFloat(slash[2]);
      if (a > 0 && b > 0) return a / b;
    }
    const num = parseFloat(s);
    return Number.isFinite(num) && num > 0 ? num : null;
  }, [isAspectRatioLocked, aspectRatioValue]);

  // Show the lock affordance when either (a) it's already locked — so the
  // user can unlock — or (b) both width AND height are set to non-auto
  // values, making a lock actually meaningful. Hide on viewport frames
  // (those rows write to `@canvas` config, not CSS), fill mode (flex
  // sizing drives the geometry), FIT SVG wrappers (the wrapper's height
  // is intentionally `auto` and locked elsewhere), and when insets are
  // active on either axis (width = `calc(100% - L - R)` would conflict
  // with the ratio — user should clear the pin first).
  const shouldShowAspectLock =
    !isViewportFrame
    && !isFitSvgWrapper
    && !isWidthFill
    && !isHeightFill
    && !inset.horizontalInset
    && !inset.verticalInset
    && (
      isAspectRatioLocked
      || (
        !!styles.width && !isFitSize(styles.width)
        && !!styles.height && !isFitSize(styles.height)
      )
    );

  const handleAspectRatioToggle = useCallback(() => {
    if (isAspectRatioLocked) {
      // Unlock — drop `aspect-ratio` and restore any `auto` dimension to
      // its current computed CSS-pixel value so the element doesn't
      // visually jump on toggle.
      const next: Record<string, string> = { aspectRatio: '' };
      if (styles.width === 'auto') next.width = `${Math.round(computed.width)}px`;
      if (styles.height === 'auto') next.height = `${Math.round(computed.height)}px`;
      onUpdateMultiple(next);
      trace.action('size:aspect-lock-off', { nodeId, ...next });
      return;
    }
    // Lock — read live computed dimensions through the bridge, compute
    // width/height ratio, and write `aspect-ratio` + flip ONE dimension to
    // `auto`. Priority matches the old builder so the lock-on transition
    // doesn't fight a user's existing % unit:
    //   • width is %   → height becomes auto
    //   • height is %  → width becomes auto
    //   • both px (or other) → width keeps its value, height becomes auto
    const w = computed.width;
    const h = computed.height;
    if (!(w > 0 && h > 0)) return;
    const ratio = w / h;
    const arValue = `${ratio.toFixed(5)} / 1`;
    const widthIsPct = String(styles.width || '').endsWith('%');
    const heightIsPct = String(styles.height || '').endsWith('%');
    const next: Record<string, string> = { aspectRatio: arValue };
    if (widthIsPct) next.height = 'auto';
    else if (heightIsPct) next.width = 'auto';
    else next.height = 'auto';
    onUpdateMultiple(next);
    trace.action('size:aspect-lock-on', { nodeId, ratio: arValue, ...next });
  }, [isAspectRatioLocked, computed.width, computed.height, styles.width, styles.height, nodeId, onUpdateMultiple]);

  // ─── Width change handler ─────────────────────────────────────────────
  const handleWidthChange = useCallback((v: string) => {
    // Currently in fill mode — changing the multiplier (preserve shrink + basis)
    if (isWidthFill) {
      const mult = Math.max(1, parseFloat(v) || 1);
      trace.action('size:width-fill-change', { nodeId, multiplier: mult });
      onUpdate('flex', formatFlex({ ...flex, grow: mult }));
      return;
    }
    // Aspect ratio locked — keep ratio honest while the user types.
    // Strategy: width is allowed to be the controlling dimension; if the
    // user changes width while height was the controller (height
    // non-auto), flip height to `auto` so the browser recomputes via
    // `aspect-ratio`. % values get normalised to the visible width so
    // unit swaps don't jump the element. Insets disable the lock path
    // up at `shouldShowAspectLock`, but guard here too in case a user
    // re-enabled an inset somehow.
    if (aspectRatioNum && !inset.horizontalInset) {
      const trimmed = (v || '').trim().toLowerCase();
      if (trimmed === '' || trimmed === 'auto' || trimmed === 'fill') {
        // Auto/fill paths flow through the unit handler instead — fall
        // through to the normal write here to avoid double-handling.
        onUpdate('width', v);
        return;
      }
      const newUnit = (v.replace(/[\d.-]/g, '').trim() || 'px') as DimUnit;
      const heightIsAuto = styles.height === 'auto';
      if (heightIsAuto) {
        // Width is already the controlling dimension — straight update.
        // CSS keeps height aligned to the ratio for free.
        onUpdate('width', v);
      } else {
        // Switching control over to width. Convert the value to the
        // matching percentage of parent if the user picked `%`, then
        // flip height to auto.
        let finalWidth = v;
        if (newUnit === '%' && computed.parentWidth > 0) {
          const pct = (computed.width / computed.parentWidth) * 100;
          finalWidth = `${pct.toFixed(5)}%`;
        }
        onUpdateMultiple({ width: finalWidth, height: 'auto' });
      }
      trace.action('size:width-change-locked', { nodeId, value: v, finalUnit: newUnit });
      return;
    }
    // Normal (non-fill, non-locked) handling
    trace.action('size:width-change', { nodeId, value: v, insetMode: inset.horizontalInset });
    if (inset.horizontalInset) {
      const newWidth = parsePx(v);
      const newStyles = computeDimensionInsetStyles(inset, styles, 'width', newWidth, computed.parentWidth);
      onUpdateMultiple(newStyles);
    } else {
      onUpdate('width', v);
    }
  }, [isWidthFill, inset, styles, nodeId, computed.parentWidth, computed.width, aspectRatioNum, onUpdate, onUpdateMultiple]);

  // Shared trigger for the "switch to auto on a no-layout frame" case.
  // Called from both width AND height unit-change handlers BEFORE writing
  // `auto`. If the selected node is a no-layout frame with children,
  // inject a flex layout + reflow children to flow first — otherwise
  // setting width/height to `auto` would collapse the frame to 0 because
  // its absolute children don't contribute to its intrinsic size. Same
  // helper LayoutTool's `+` button uses, so the resulting layout is
  // identical regardless of which entry point the user took.
  const maybeInjectLayoutForAuto = useCallback(() => {
    const nodes = getNodesSnapshot();
    const selfNode = nodes.get(nodeId);
    if (!shouldInjectLayoutOnAuto(selfNode, styles.display ?? '')) return;
    injectFlexLayoutOnFrame(nodeId, nodes, vpId);
  }, [nodeId, styles.display, vpId]);

  // Auto on an ALREADY-laid-out frame: injection never runs, so children
  // sized in % (or FILL grow on this frame's own main axis) make the axis
  // circular — 90% of an auto parent is 0 and the frame collapses (user
  // report 2026-07-29). Freeze those children to their rendered px first;
  // the auto write follows in the same flush.
  const freezeChildrenForAuto = useCallback((axis: 'width' | 'height') => {
    freezeParentRelativeChildrenForAuto(nodeId, axis, getNodesSnapshot(), vpId);
  }, [nodeId, vpId]);

  const handleWidthUnitChange = useCallback((fromUnit: DimUnit, toUnit: DimUnit) => {
    // Switching TO fill
    if (toUnit === 'fill') {
      trace.action('size:width-fill', { nodeId, isMainAxis: widthIsMainAxis });
      if (widthIsMainAxis) {
        // Main axis: use flex grow
        onUpdateMultiple({ width: '', flex: makeFillFlex(1) });
      } else {
        // Cross axis: 100% — on a replica with a flipped parent, pair the
        // flex re-base so the base row-fill doesn't collapse the height.
        onUpdateMultiple(crossAxisFillPatch('width', !isPrimary, flexVal));
      }
      return;
    }
    // Source-of-truth for the conversion: the actual rendered CSS px from
    // the bridge's computed-style cache. Works for ANY fromUnit (auto, %,
    // px, vw, vh, fill) — they all resolve to a real pixel size in the
    // browser and that's exactly what we want to preserve visually when
    // swapping units. Previously the non-fill branch did
    // `parseFloat(styles.width)` which strips units (so '50vw' → 50,
    // treated as 50px) and the % branch recomputed via parent×ratio,
    // both of which diverge from the real rendered px when the source
    // unit is anything other than what the math expects.
    const currentPx = computed.width;
    const { vpWidth: simVpWidth } = getInteractingViewport();
    const simVpHeight = estimatedVpHeight(simVpWidth);
    if (toUnit === 'auto') {
      const selfNode = getNodesSnapshot().get(nodeId);
      // CODE COMPONENT instance: auto is not a legal state (the option is
      // greyed out in the dropdown; this guards keyboard/legacy paths).
      // Removing the override would leave the wrapper sizeless → collapse.
      if (selfNode?.isCodeComponent) {
        trace.action('size:unit-change-blocked', { label: 'W', reason: 'code-component-fixed-only' });
        return;
      }
      // Exiting main-axis FILL: neutralise the grow flex in the SAME write —
      // a fit-size width with `flex: '1 0 0px'` left behind still DETECTS as
      // fill (isWidthFillMain), so the dropdown snaps back and the node keeps
      // growing (basis 0px beats width for the main size).
      const unfill = exitFillFlexPatch(widthIsMainAxis, flexVal);
      // Component instance: "Fit" means hug to the MASTER's natural size, NOT
      // force `min-content` onto the instance root. Writing min-content makes
      // the master re-measure its children from scratch and collapse any
      // wrappable text to its longest word (e.g. a button label stacks one
      // word per line). Instead remove the override (write '') so the master's
      // own width resolves through the `...style` spread — design-tool parity. Also
      // skip layout injection (the master owns its internal layout).
      if (selfNode?.componentFile != null) {
        // Hug the master via a dedicated mutation — the generic '' write gets
        // variant-scoped on a replica into an empty-string OVERRIDE
        // (`cond ? '' : …`), which still clobbers the master's size (the
        // Adore grid collapse, 2026-08-15). The mutation writes an 'auto'
        // branch into the ordinary style ternary (whole-entry removal when
        // nothing else is pinned); expandComponent bakes it per tile to the
        // master's tracked value.
        const activeVar = activeComponentVariant && activeComponentVariant !== 'default' ? activeComponentVariant : null;
        // PAGE viewport replica: the hug is PER-VIEWPORT, not per-variant —
        // write the band override 'auto' through the normal responsive
        // routing (onUpdate) and guarantee the runtime-wrapper marker; the
        // canvas adopts the master's dim on band-auto tiles (Renderer
        // instance-wrapper sync, 2026-08-15).
        const interactVp = viewportsConfig.find(v => v.id === getInteractingViewport().vpId);
        if (!activeVar && interactVp && !interactVp.isPrimary) {
          if (unfill) onUpdateMultiple({ width: 'auto', ...unfill });
          else onUpdate('width', 'auto');
          queueMutation({ type: 'ensureInstanceHugMarker', nodeId, dim: 'width' });
          trace.action('size:unit-change', { label: 'W', from: fromUnit, to: toUnit, value: 0, instanceHugMaster: true, viewportBand: interactVp.id, unfill: !!unfill });
          return;
        }
        if (unfill) queueMutation({ type: 'updateStyles', nodeId, styles: { ...unfill } });
        queueMutation({ type: 'autoSizeInstanceDim', nodeId, dim: 'width', activeVariant: activeVar });
        trace.action('size:unit-change', { label: 'W', from: fromUnit, to: toUnit, value: 0, instanceHugMaster: true, activeVar: activeComponentVariant, unfill: !!unfill });
        return;
      }
      maybeInjectLayoutForAuto();
      freezeChildrenForAuto('width');
      // "Fit" → min-content (sizes to content on flex/layout)
      if (unfill) onUpdateMultiple({ width: FIT_SIZE, ...unfill });
      else onUpdate('width', FIT_SIZE);
      trace.action('size:unit-change', { label: 'W', from: fromUnit, to: toUnit, value: 0, unfill: !!unfill });
      return;
    }
    const newVal = convertPxToDimUnit(currentPx, toUnit, computed.parentWidth, simVpWidth, simVpHeight);
    // Switching FROM fill: also clear the flex shorthand so the new value
    // sticks. Same write semantics as the rest of the unit conversion.
    if (fromUnit === 'fill') {
      trace.action('size:width-unfill', { nodeId, newUnit: toUnit, currentPx, newVal });
      if (isWidthFillMain) onUpdateMultiple({ width: newVal, flex: '' });
      else onUpdate('width', newVal);
      return;
    }
    onUpdate('width', newVal);
    trace.action('size:unit-change', { label: 'W', from: fromUnit, to: toUnit, currentPx, newVal });
  }, [widthIsMainAxis, isWidthFillMain, flexVal, nodeId, computed, onUpdate, onUpdateMultiple, maybeInjectLayoutForAuto, freezeChildrenForAuto, activeComponentVariant]);

  // ─── Height change handler ────────────────────────────────────────────
  const handleHeightChange = useCallback((v: string) => {
    // Currently in fill mode — changing the multiplier (preserve shrink + basis)
    if (isHeightFill) {
      const mult = Math.max(1, parseFloat(v) || 1);
      trace.action('size:height-fill-change', { nodeId, multiplier: mult });
      onUpdate('flex', formatFlex({ ...flex, grow: mult }));
      return;
    }
    // Aspect ratio locked — mirror image of the width handler. Two cases
    // diverge slightly so the user can change a pixel HEIGHT while width
    // is the controlling dimension and still get a stable result:
    //   • height in %/vh: same as width — flip control, recompute % from
    //     visible height vs parent height.
    //   • height in px: compute the delta and apply `delta * ratio` to
    //     width so the result lands EXACTLY where the user expects
    //     (typing 200 → 250 grows width by `50 * ratio`, not "set width
    //     to a brand new 250 * ratio"). This matches the reference's "drag
    //     height by 50 → width grows by 50 * ratio" behaviour and the
    //     old builder's delta-based math.
    if (aspectRatioNum && !inset.verticalInset) {
      const trimmed = (v || '').trim().toLowerCase();
      if (trimmed === '' || trimmed === 'auto' || trimmed === 'fill') {
        onUpdate('height', v);
        return;
      }
      const newUnit = (v.replace(/[\d.-]/g, '').trim() || 'px') as DimUnit;
      const widthIsAuto = styles.width === 'auto';
      if (widthIsAuto) {
        // Height is already the controlling dimension — straight update.
        onUpdate('height', v);
      } else if (newUnit === '%' || newUnit === 'vh' || newUnit === 'vw') {
        // Switch control to height. Normalise % from the visible height.
        let finalHeight = v;
        if (newUnit === '%' && computed.parentHeight > 0) {
          const pct = (computed.height / computed.parentHeight) * 100;
          finalHeight = `${pct.toFixed(5)}%`;
        }
        onUpdateMultiple({ width: 'auto', height: finalHeight });
      } else {
        // Pixel height with non-auto width — keep WIDTH as the canonical
        // controller and compute the new width that satisfies the ratio
        // delta. Preserve width's existing unit (px or %) by converting
        // back through parent if needed. Then set height to `auto` so CSS
        // re-derives it from the ratio (no risk of drift between the
        // value we computed and what the browser actually paints).
        const newHeightPx = parseFloat(v) || 0;
        const heightDelta = newHeightPx - computed.height;
        const widthDelta = heightDelta * aspectRatioNum;
        const newWidthPx = computed.width + widthDelta;
        const widthUnit = (String(styles.width || '').replace(/[\d.-]/g, '').trim() || 'px') as DimUnit;
        let finalWidth: string;
        if (widthUnit === '%' && computed.parentWidth > 0) {
          const pct = (newWidthPx / computed.parentWidth) * 100;
          finalWidth = `${pct.toFixed(5)}%`;
        } else {
          finalWidth = `${Math.round(newWidthPx)}${widthUnit}`;
        }
        onUpdateMultiple({ width: finalWidth, height: 'auto' });
      }
      trace.action('size:height-change-locked', { nodeId, value: v, finalUnit: newUnit });
      return;
    }
    // Normal (non-fill, non-locked) handling
    trace.action('size:height-change', { nodeId, value: v, insetMode: inset.verticalInset });
    if (inset.verticalInset) {
      const newHeight = parsePx(v);
      const newStyles = computeDimensionInsetStyles(inset, styles, 'height', newHeight, computed.parentHeight);
      onUpdateMultiple(newStyles);
    } else {
      onUpdate('height', v);
    }
  }, [isHeightFill, inset, styles, nodeId, computed.parentHeight, computed.height, computed.width, computed.parentWidth, aspectRatioNum, onUpdate, onUpdateMultiple]);

  const handleHeightUnitChange = useCallback((fromUnit: DimUnit, toUnit: DimUnit) => {
    // Switching TO fill
    if (toUnit === 'fill') {
      trace.action('size:height-fill', { nodeId, isMainAxis: heightIsMainAxis });
      if (heightIsMainAxis) {
        onUpdateMultiple({ height: '', flex: makeFillFlex(1) });
      } else {
        // Cross axis: 100% — replica-flipped parent pairs the flex re-base
        // (see handleWidthUnitChange).
        onUpdateMultiple(crossAxisFillPatch('height', !isPrimary, flexVal));
      }
      return;
    }
    // Source-of-truth: the actual rendered CSS px from the bridge — see
    // handleWidthUnitChange for rationale. Same fix mirrored here.
    const currentPx = computed.height;
    const { vpWidth: simVpWidth } = getInteractingViewport();
    const simVpHeight = estimatedVpHeight(simVpWidth);
    if (toUnit === 'auto') {
      const selfNode = getNodesSnapshot().get(nodeId);
      // CODE COMPONENT instance: fixed-only — see handleWidthUnitChange.
      if (selfNode?.isCodeComponent) {
        trace.action('size:unit-change-blocked', { label: 'H', reason: 'code-component-fixed-only' });
        return;
      }
      // Exiting main-axis FILL: clear the grow flex in the same write — see
      // handleWidthUnitChange. Same fix mirrored here.
      const unfill = exitFillFlexPatch(heightIsMainAxis, flexVal);
      // Component instance: hug the master's natural height — remove the
      // override (write '') instead of forcing min-content, and skip layout
      // injection. See handleWidthUnitChange for the full rationale.
      if (selfNode?.componentFile != null) {
        // Hug the master — same contract as the width branch above.
        const activeVar = activeComponentVariant && activeComponentVariant !== 'default' ? activeComponentVariant : null;
        const interactVp = viewportsConfig.find(v => v.id === getInteractingViewport().vpId);
        if (!activeVar && interactVp && !interactVp.isPrimary) {
          if (unfill) onUpdateMultiple({ height: 'auto', ...unfill });
          else onUpdate('height', 'auto');
          queueMutation({ type: 'ensureInstanceHugMarker', nodeId, dim: 'height' });
          trace.action('size:unit-change', { label: 'H', from: fromUnit, to: toUnit, value: 0, instanceHugMaster: true, viewportBand: interactVp.id, unfill: !!unfill });
          return;
        }
        if (unfill) queueMutation({ type: 'updateStyles', nodeId, styles: { ...unfill } });
        queueMutation({ type: 'autoSizeInstanceDim', nodeId, dim: 'height', activeVariant: activeVar });
        trace.action('size:unit-change', { label: 'H', from: fromUnit, to: toUnit, value: 0, instanceHugMaster: true, activeVar: activeComponentVariant, unfill: !!unfill });
        return;
      }
      maybeInjectLayoutForAuto();
      freezeChildrenForAuto('height');
      // "Fit" → min-content
      if (unfill) onUpdateMultiple({ height: FIT_SIZE, ...unfill });
      else onUpdate('height', FIT_SIZE);
      trace.action('size:unit-change', { label: 'H', from: fromUnit, to: toUnit, value: 0, unfill: !!unfill });
      return;
    }
    const newVal = convertPxToDimUnit(currentPx, toUnit, computed.parentHeight, simVpWidth, simVpHeight);
    if (fromUnit === 'fill') {
      trace.action('size:height-unfill', { nodeId, newUnit: toUnit, currentPx, newVal });
      if (isHeightFillMain) onUpdateMultiple({ height: newVal, flex: '' });
      else onUpdate('height', newVal);
      return;
    }
    onUpdate('height', newVal);
    trace.action('size:unit-change', { label: 'H', from: fromUnit, to: toUnit, currentPx, newVal });
  }, [heightIsMainAxis, isHeightFillMain, flexVal, nodeId, computed, onUpdate, onUpdateMultiple, maybeInjectLayoutForAuto, freezeChildrenForAuto, activeComponentVariant]);

  // ─── Flex shorthand parsing ──────────────────────────────────────────
  const flex = parseFlex(styles.flex || '');

  // ─── Advanced properties tracking ────────────────────────────────────
  // Track which advanced props are visible (added via + dropdown or auto-detected from AI)
  // Min/max width/height are STYLE-DRIVEN — a row exists iff the style is set
  // (see visibleProps). So "Remove" from the row's ControlLabel clears the
  // value AND drops the row, which is the only clear path needed (no × button).
  // (No `flex-basis` row — the reference has no separate Basis control; the Width
  //  Fill/Fixed/Hug mode already drives the flex shorthand's basis.)
  const [addedProps, setAddedProps] = useState<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // A min/max/basis row is visible when the user explicitly added it OR
  // the node already carries that style. `addedProps` alone goes stale —
  // it's `useState`-initialised once and never re-syncs on node switch —
  // so a `maxWidth` set in code (or by AI) wouldn't surface. Deriving the
  // style-backed props every render fixes that.
  const visibleProps = useMemo(() => {
    const s = new Set(addedProps);
    if (styles.minWidth) s.add('minWidth');
    if (styles.maxWidth) s.add('maxWidth');
    if (styles.minHeight) s.add('minHeight');
    if (styles.maxHeight) s.add('maxHeight');
    return s;
  }, [addedProps, styles.minWidth, styles.maxWidth, styles.minHeight, styles.maxHeight]);

  // Selecting a different node clears the user-added (still-empty) rows —
  // they're per-node; `visibleProps` re-derives the style-backed ones.
  useEffect(() => { setAddedProps(new Set()); }, [nodeId]);

  const addProp = useCallback((prop: string) => {
    trace.action('size:add-prop', { prop });
    // Min/max are CREATED at the node's current computed px (Fixed) — a concrete,
    // immediately-editable constraint, not a faded `auto` placeholder (mirrors the
    // resize/lock auto→px resolve). They're style-driven, so writing the style IS
    // what makes the row appear; "Remove" later clears the value and the row.
    if (prop === 'minWidth' || prop === 'maxWidth') { onUpdate(prop, `${Math.round(computed.width || 0)}px`); setDropdownOpen(false); return; }
    if (prop === 'minHeight' || prop === 'maxHeight') { onUpdate(prop, `${Math.round(computed.height || 0)}px`); setDropdownOpen(false); return; }
    setAddedProps(prev => new Set(prev).add(prop));
    setDropdownOpen(false);
  }, [onUpdate, computed.width, computed.height]);

  // Available props to add (not yet shown)
  const advancedOptions = [
    { key: 'minWidth', label: 'Min Width' },
    { key: 'maxWidth', label: 'Max Width' },
    { key: 'minHeight', label: 'Min Height' },
    { key: 'maxHeight', label: 'Max Height' },
  ].filter(o => !visibleProps.has(o.key));

  // ─── Render ───────────────────────────────────────────────────────────
  // Viewport frame has no min/max CSS knobs — the breakpoint width is the
  // only configurable dimension. Suppress the add-property menu.
  const addAction = !isViewportFrame && advancedOptions.length > 0 ? (
    <div className="relative">
      <button
        onClick={() => setDropdownOpen(v => !v)}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title="Add size property"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-[998]" onClick={() => setDropdownOpen(false)} />
          <div className="absolute right-[10px] top-full mt-1 z-[999] w-max bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] py-1">
            {advancedOptions.map(opt => (
              <div
                key={opt.key}
                onClick={() => addProp(opt.key)}
                className="px-3 py-1.5 text-xs text-[var(--text-primary)] cursor-pointer hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] cut-corners mx-1 whitespace-nowrap"
              >
                {opt.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <ToolSection title="Dimensions" action={addAction}>
      {isViewportFrame && currentViewportConfig ? (
        // Viewport breakpoint row: writes the canvas viewport `width` config
        // (persisted to the @canvas block), NOT a CSS dimension. Height is
        // always content-driven for viewports, so keep it auto/computed.
        // `property={undefined}` hides the chevron menu — there's no CSS
        // property bound to this row, so variable / preset bindings don't
        // apply. Unit is locked to px.
        <DimensionRow
          label="Width"
          value={`${currentViewportConfig.width}px`}
          onChange={handleViewportBreakpointChange}
          // Chevron scrub live-tracks the tile via the widths atom only; the
          // commit (onChange via ToolInput's onCommit) runs the band rewrite
          // ONCE on release — same live/commit split as the tile drag.
          onChangeLive={handleViewportBreakpointLive}
          onUnitChange={() => {}}
          computedSize={currentViewportConfig.width}
          parentSize={currentViewportConfig.width}
          unitOptions={[{ value: 'px', label: 'px' }]}
          hideResetStyle
        />
      ) : (
        <DimensionRow
          label="Width"
          property="width"
          value={widthHug ? 'auto' : isWidthFillMain ? String(fillMultiplier) : isWidthFillCross ? String(Math.round(computed.width)) : (inset.horizontalInset ? `${Math.round(computed.width)}px` : (roundPxDisplay(pickLiveDim(styles.width, liveSize?.w) || styles.width) || 'auto'))}
          onChange={handleWidthChange}
          // LIVE scrub — without this the chevron drag fell back to the FULL
          // commit pipeline per tick (the DimensionRow comment documents the
          // failure mode; the min/max rows were wired, the main rows never
          // were — "panel resize is choppy while the overlay circles are
          // smooth", live find 2026-07-19). DOM-only patch per tick; the
          // release commits once via onCommit → handleWidthChange. Fill
          // multipliers and inset-derived widths keep the legacy path.
          onChangeLive={isWidthFill || inset.horizontalInset ? undefined : (v) => updateStyleLive('width', v)}
          onUnitChange={handleWidthUnitChange}
          computedSize={computed.width}
          parentSize={computed.parentWidth}
          unitOptions={widthUnitOptions}
          currentUnit={widthHug ? 'auto' : isWidthFill ? 'fill' : undefined}
          hideResetStyle={isPrimary}
          overridden={isWidthFill && flexFillOverridden ? true : undefined}
          onResetOverride={isVectorSet ? resetVectorSetSize : (isWidthFill && flexFillOverridden ? resetFlexFillOverride : undefined)}
        />
      )}

      {/* ─── Aspect Ratio Lock between Width / Height ───────────────────
          Visually sits in the gutter between the two rows, anchored
          horizontally just before the input column starts (left: 35%).
          Two SVG arcs hint at the connection between width and height
          inputs — they tint accent when locked, secondary text colour
          when not. Wrapper is 0 px tall + has negative top/bottom margins
          so the lock floats between the rows without changing the gap. */}
      {shouldShowAspectLock && (
        <div
          className="relative"
          // Wrapper occupies 0 vertical space; the lock icon inside is
          // absolutely positioned to overlay the gap between rows. The
          // negative top/bottom margins (-0.25rem each = 4 px) cancel
          // exactly half of ToolSection's gap-2 (8 px) above and below
          // this 0-height row, restoring the SAME 8 px gap between Width
          // and Height the panel had before the lock affordance existed.
          // Without these margins, inserting the wrapper as a flex
          // sibling doubles the spacing (16 px) and squishes nothing —
          // but with the previous −0.375 rem values, the wrapper ate too
          // much of the gap and the two rows visibly collapsed onto
          // each other. -0.25 rem hits the original cadence exactly.
          style={{ height: 0, marginTop: '-0.25rem', marginBottom: '-0.25rem' }}
        >
          <div
            className="absolute flex items-center justify-center pointer-events-none"
            style={{ left: '35%', top: -10, transform: 'translateX(-50%)' }}
          >
            {/* Top connector — curves from the width input down toward
                the lock button. Path starts bottom-left and bends to the
                right side of a 10×40 box, matching the old builder. */}
            <svg
              className="absolute pointer-events-none"
              style={{ left: 1, top: -38, width: 10, height: 40, overflow: 'visible' }}
            >
              <path
                d="M 0,37 Q 0,31 6,29 L 11,29"
                fill="none"
                stroke={isAspectRatioLocked ? 'var(--accent)' : 'var(--text-secondary)'}
                strokeWidth="1"
              />
            </svg>

            <button
              type="button"
              onClick={handleAspectRatioToggle}
              className={`p-0.5 hover:bg-[var(--bg-hover)] cut-corners transition-colors absolute z-10 pointer-events-auto cursor-pointer ${
                isAspectRatioLocked ? 'text-[var(--accent-text)]' : 'text-[var(--text-secondary)]'
              }`}
              style={{ left: -7, top: 2 }}
              title={isAspectRatioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            >
              {isAspectRatioLocked ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                </svg>
              )}
            </button>

            {/* Bottom connector — mirror of the top, leading into the
                height input. */}
            <svg
              className="absolute pointer-events-none"
              style={{ left: 1, top: 19, width: 10, height: 40, overflow: 'visible' }}
            >
              <path
                d="M 0,3 Q 0,8 6,11 L 11,11"
                fill="none"
                stroke={isAspectRatioLocked ? 'var(--accent)' : 'var(--text-secondary)'}
                strokeWidth="1"
              />
            </svg>
          </div>
        </div>
      )}

      {isViewportFrame && currentViewportConfig ? (
        // Viewport height: px (fixed pixel height stored in viewport config)
        // OR auto (omitted from config, content-driven). Unit chevron lets
        // the user toggle between the two. When px, the value comes from
        // the persisted config; when auto, the value displays the current
        // content-driven measurement (read-only).
        //
        // Override accent: a REPLICA whose vp.height differs from the
        // primary's vp.height is "detached" — the user dragged its own
        // height handle past the primary-broadcast value, so it's no
        // longer synced. Mirror the same blue/accent ControlLabel +
        // "Reset Override" menu every other replica-aware property gets.
        // Reset copies the primary's current vp.height back onto this
        // replica.
        (() => {
          const vpHeight = currentViewportConfig.height;
          const isPxMode = typeof vpHeight === 'number' && vpHeight > 0;
          const primaryVp = viewportsConfig.find(v => v.isPrimary) ?? viewportsConfig[0];
          const isReplicaDetached = !currentViewportConfig.isPrimary
            && !!primaryVp
            && typeof primaryVp.height === 'number' && primaryVp.height > 0
            && typeof vpHeight === 'number' && vpHeight > 0
            && vpHeight !== primaryVp.height;
          const handleResetReplicaHeight = () => {
            if (!primaryVp || typeof primaryVp.height !== 'number' || primaryVp.height <= 0) return;
            handleViewportHeightChange(String(primaryVp.height));
            trace.action('size:viewport-height-reset', { vpId, to: primaryVp.height });
          };
          return (
            <DimensionRow
              label="Height"
              property="height"
              value={isPxMode ? `${vpHeight}px` : `${Math.round(computed.height) || 0}px`}
              onChange={handleViewportHeightChange}
              // Live (per-frame) scrub = DOM-only patch of this viewport's root —
              // the SAME imperative path the resize overlay uses. Without it every
              // chevron-drag tick ran the FULL commit (viewport-config write +
              // JSX mirror + forceCanvasRender → project write + re-parse of the
              // whole file per tick; 16 writes/38 parses in one drag on a big
              // canvasNodes page — "extremely slow and replicas glitching",
              // 2026-08-07). The release commits ONCE via onCommit → onChange.
              onChangeLive={!isPxMode ? undefined : (v) => updateStyleLive('height', v)}
              onUnitChange={handleViewportHeightUnitChange}
              computedSize={computed.height}
              parentSize={computed.parentHeight}
              unitOptions={[
                { value: 'px', label: 'px' },
                { value: 'auto', label: 'auto' },
              ]}
              currentUnit={isPxMode ? 'px' : 'auto'}
              disabled={!isPxMode}
              overridden={isReplicaDetached}
              onResetOverride={isReplicaDetached ? handleResetReplicaHeight : undefined}
              // Suppress the "Remove" menu entry on every viewport.
              // ControlLabel reads `value = styles['height']` (the root div's
              // CSS height) which is unrelated to the value this row
              // displays (the viewport-config height from `@canvas`).
              // Clicking "Remove" would silently wipe the root's
              // inline height and collapse the page to 0px. Reset Override
              // (replicas only) stays — that one routes through the
              // `onResetOverride` handler and syncs vp.height back to the
              // primary's value, which is what the user actually wants.
              hideResetStyle
            />
          );
        })()
      ) : (
        <DimensionRow
          label="Height"
          property="height"
          value={heightHug ? 'auto' : isFitSvgWrapper ? `${Math.round(computed.height) || 0}px` : isHeightFillMain ? String(fillMultiplier) : isHeightFillCross ? String(Math.round(computed.height)) : (inset.verticalInset ? `${Math.round(computed.height)}px` : (roundPxDisplay(pickLiveDim(styles.height, liveSize?.h) || styles.height) || 'auto'))}
          onChange={isFitSvgWrapper ? () => {} : handleHeightChange}
          // LIVE scrub — same as the Width row above.
          onChangeLive={isFitSvgWrapper || isHeightFill || inset.verticalInset ? undefined : (v) => updateStyleLive('height', v)}
          onUnitChange={isFitSvgWrapper ? () => {} : handleHeightUnitChange}
          computedSize={computed.height}
          parentSize={computed.parentHeight}
          unitOptions={isFitSvgWrapper ? [{ value: 'fit', label: 'Fit' }, ...heightUnitOptions.map(o => ({ ...o, disabled: true }))] : heightUnitOptions}
          currentUnit={heightHug ? 'auto' : isFitSvgWrapper ? 'fit' as DimUnit : isHeightFill ? 'fill' : undefined}
          disabled={!!isFitSvgWrapper}
          hideResetStyle={isPrimary}
          overridden={isHeightFill && flexFillOverridden ? true : undefined}
          onResetOverride={isVectorSet ? resetVectorSetSize : (isHeightFill && flexFillOverridden ? resetFlexFillOverride : undefined)}
        />
      )}

      {/* Flex/Grid child controls — only for relative children in flex/grid parents, never for top-level */}
      {(() => {
        if (isTopLevel) return null;
        const pos = styles.position || 'relative';
        const isRelative = pos === 'relative' || pos === 'static' || pos === '';
        const isFlexChild = parentLayout === 'flex' && isRelative;
        const isGridChild = parentLayout === 'grid' && isRelative;
        if (!isFlexChild && !isGridChild) return null;
        return (
          <>
            {/* `pl-[18px] -ml-[18px]` mimics ControlLabel's gutter so the
                value column gets the same 18 px of width as Width/Height
                rows above. The control's own w-full + flex-shrink picks
                up the recovered space. Plain span (no chevron / menu)
                because Shrink and Align Self are flex-context concepts
                — the variable / preset system can't bind them
                meaningfully today. */}
            {/* Shrink (flex-shrink) control REMOVED 2026-06-13 — match the reference:
                flex children are always shrink: 0 (Fixed/Hug). flex-shrink: 1
                is a footgun on the fixed-size canvas (collapses a child to ~0
                computed height in a height-constrained flex column — the
                CSS-default leak when no flex is set). All drop/create paths now
                bake `flex: '0 0 auto'`; the "shrink-to-fit" need is served by
                Fill (grow + min:0). No user-facing toggle. */}
            <div className="flex items-center justify-between w-full">
              <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Align Self</span>
              <ToolSelect value={styles.alignSelf || 'auto'} onChange={v => onUpdate('alignSelf', v === 'auto' ? '' : v)} options={SELF_ALIGN_OPTIONS} />
            </div>
          </>
        );
      })()}

      {/* Dynamically added min/max properties — same layout as Width/Height.
          Suppressed for viewport frames since min/max are CSS-only knobs and
          the only configurable viewport dimension is the breakpoint width. */}
      {!isViewportFrame && visibleProps.has('minWidth') && (
        <DimensionRow label="Min Width" property="minWidth" value={styles.minWidth || 'auto'}
          onChange={v => onUpdate('minWidth', v)} onChangeLive={v => updateStyleLive('minWidth', v)} onUnitChange={(_, to) => minMaxUnitChange('minWidth', to)}
          computedSize={computed.width} parentSize={computed.parentWidth} unitOptions={minMaxUnitOptions} />
      )}
      {!isViewportFrame && visibleProps.has('maxWidth') && (
        <DimensionRow label="Max Width" property="maxWidth" value={styles.maxWidth || 'auto'}
          onChange={v => onUpdate('maxWidth', v)} onChangeLive={v => updateStyleLive('maxWidth', v)} onUnitChange={(_, to) => minMaxUnitChange('maxWidth', to)}
          computedSize={computed.width} parentSize={computed.parentWidth} unitOptions={minMaxUnitOptions} />
      )}
      {!isViewportFrame && visibleProps.has('minHeight') && (
        <DimensionRow label="Min Height" property="minHeight" value={styles.minHeight || 'auto'}
          onChange={v => onUpdate('minHeight', v)} onChangeLive={v => updateStyleLive('minHeight', v)} onUnitChange={(_, to) => minMaxUnitChange('minHeight', to)}
          computedSize={computed.height} parentSize={computed.parentHeight} unitOptions={minMaxUnitOptions} />
      )}
      {!isViewportFrame && visibleProps.has('maxHeight') && (
        <DimensionRow label="Max Height" property="maxHeight" value={styles.maxHeight || 'auto'}
          onChange={v => onUpdate('maxHeight', v)} onChangeLive={v => updateStyleLive('maxHeight', v)} onUnitChange={(_, to) => minMaxUnitChange('maxHeight', to)}
          computedSize={computed.height} parentSize={computed.parentHeight} unitOptions={minMaxUnitOptions} />
      )}
    </ToolSection>
  );
}
