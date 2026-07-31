// MotionPropsEditor.tsx — Shared ToolAtom-based editor for motion animation properties.
// Used by: HoverTapPopup, AppearPopup, LoopPopup, StopEditor (scroll transform).
// Features: unified ToolAtom controls, Add Property via pushPanel, live DOM preview.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue, getDefaultStore } from 'jotai';
import { nodesAtom, canvasInteractingAtom } from '@/code/stores/store';
import { ToolInput, ToolSelect, ControlLabel } from '../../../controls';
import ColorInput from '../../../controls/ColorInput';
import { getPropertyIcon } from '@/design-system/PropertyIcons';
import { useToolPopupOptional } from '../../../ui/ToolPopup';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { trace } from '@/shared/debug-trace';
import {
  OpacityControl, RotateControl, OffsetControl, Rotate3DControl,
  SkewControl, ScaleXYControl, PerspectiveControl, Preserve3DControl,
  RadiusControl, ClipPathControl, BackgroundColorControl,
  FilterControl, ShadowControl, BorderControl, MaskControl,
  PaddingControl, MarginControl, OverflowControl,
} from '../../StylesTool/atoms';
import type { ComponentType } from 'react';
import type { AtomProps } from '../../../controls/unified/types';
import type { ControlMode } from '../../../controls/unified/types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** All style properties available via Add Property — maps CSS key to ToolAtom + label */
export const ADDABLE_STYLE_ATOMS: { key: string; label: string; Atom: ComponentType<AtomProps> }[] = [
  { key: 'borderRadius', label: 'Border Radius', Atom: RadiusControl },
  { key: 'clipPath', label: 'Clip Path', Atom: ClipPathControl },
  { key: 'backgroundColor', label: 'Background', Atom: BackgroundColorControl },
  { key: 'filter', label: 'Filter', Atom: FilterControl },
  { key: 'boxShadow', label: 'Shadow', Atom: ShadowControl },
  { key: 'border', label: 'Border', Atom: BorderControl },
  { key: 'maskImage', label: 'Mask', Atom: MaskControl },
  { key: 'padding', label: 'Padding', Atom: PaddingControl },
  { key: 'margin', label: 'Margin', Atom: MarginControl },
  { key: 'overflow', label: 'Overflow', Atom: OverflowControl },
];

/** Motion props that map to CSS transform — not directly settable via el.style */
const MOTION_TRANSFORM_KEYS = new Set([
  'x', 'y', 'z', 'xPercent', 'yPercent', 'scale', 'scaleX', 'scaleY', 'scaleZ',
  'rotate', 'rotateX', 'rotateY', 'skew', 'skewX', 'skewY', 'perspective',
  'autoAlpha', // keyframe-sheet control: opacity + visibility
]);

/** Default values when adding a property via Add Property (empty string = remove, so we need real defaults) */
const ADD_PROPERTY_DEFAULTS: Record<string, string> = {
  borderRadius: '0',
  clipPath: 'none',
  backgroundColor: 'transparent',
  filter: 'none',
  boxShadow: 'none',
  border: 'none',
  maskImage: 'none',
  padding: '0',
  margin: '0',
  overflow: 'visible',
};

/** All transform-category keys (always-visible ToolAtoms, not in "Add Property" list) */
const TRANSFORM_KEYS = new Set([
  'opacity', 'autoAlpha', 'scale', 'rotate', 'x', 'y', 'z', 'xPercent', 'yPercent',
  'rotateX', 'rotateY', 'skew', 'skewX', 'skewY', 'scaleX', 'scaleY', 'scaleZ',
  'perspective', 'transformStyle',
]);

/** Map sub-properties to their parent ToolAtom key */
export const SUB_PROPERTY_MAP: Record<string, string> = {
  borderWidth: 'border', borderStyle: 'border', borderColor: 'border',
  borderTopWidth: 'border', borderTopStyle: 'border', borderTopColor: 'border',
  borderRightWidth: 'border', borderRightStyle: 'border', borderRightColor: 'border',
  borderBottomWidth: 'border', borderBottomStyle: 'border', borderBottomColor: 'border',
  borderLeftWidth: 'border', borderLeftStyle: 'border', borderLeftColor: 'border',
  borderImageSource: 'border', borderImageSlice: 'border',
  WebkitMaskImage: 'maskImage', mask: 'maskImage', WebkitMask: 'maskImage',
};

// ─── Preview helpers ─────────────────────────────────────────────────────────

/** Build a CSS transform string from motion props (x, y, scale, rotate, etc.) */
export function buildTransformPreview(props: Record<string, string>): string {
  const parts: string[] = [];
  // perspective MUST come first for 3D transforms to work
  if (props.perspective && props.perspective !== '0') parts.push(`perspective(${props.perspective}px)`);
  if (props.xPercent && props.xPercent !== '0') parts.push(`translateX(${props.xPercent}%)`);
  else if (props.x && props.x !== '0') parts.push(`translateX(${props.x.includes('%') ? props.x : props.x + 'px'})`);
  if (props.yPercent && props.yPercent !== '0') parts.push(`translateY(${props.yPercent}%)`);
  else if (props.y && props.y !== '0') parts.push(`translateY(${props.y.includes('%') ? props.y : props.y + 'px'})`);
  if (props.z && props.z !== '0') parts.push(`translateZ(${props.z}px)`);
  if (props.scale && props.scale !== '1') parts.push(`scale(${props.scale})`);
  if (props.scaleX && props.scaleY && (props.scaleX !== '1' || props.scaleY !== '1')) {
    parts.push(`scaleX(${props.scaleX})`, `scaleY(${props.scaleY})`);
  }
  if (props.scaleZ && props.scaleZ !== '1') parts.push(`scaleZ(${props.scaleZ})`);
  if (props.rotate && props.rotate !== '0') parts.push(`rotate(${props.rotate}deg)`);
  if (props.rotateX && props.rotateX !== '0') parts.push(`rotateX(${props.rotateX}deg)`);
  if (props.rotateY && props.rotateY !== '0') parts.push(`rotateY(${props.rotateY}deg)`);
  if (props.skew && props.skew !== '0') { parts.push(`skewX(${props.skew}deg)`, `skewY(${props.skew}deg)`); }
  else {
    if (props.skewX && props.skewX !== '0') parts.push(`skewX(${props.skewX}deg)`);
    if (props.skewY && props.skewY !== '0') parts.push(`skewY(${props.skewY}deg)`);
  }
  return parts.join(' ');
}

/** Apply !important preview styles to a DOM element.
 *  Also forwards to bridge in iframe mode so the visible iframe shows the preview.
 *  Pass nodeId + vpId for bridge forwarding (optional — omit for local-only preview). */
export function applyPreview(el: HTMLElement | null, props: Record<string, string>, nodeId?: string, vpId?: string): void {
  const transformCSS = buildTransformPreview(props);
  // Direct DOM patch — only when the element lives in the PARENT frame
  // (primary tile / non-iframe). Replicas live in the sandbox iframe, where
  // querySelector returns null; the bridge below covers those.
  if (el) {
    for (const [key, value] of Object.entries(props)) {
      if (!value || MOTION_TRANSFORM_KEYS.has(key)) continue;
      const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      el.style.setProperty(kebab, value, 'important');
    }
    if (props.autoAlpha !== undefined) {
      el.style.setProperty('opacity', props.autoAlpha, 'important');
      el.style.setProperty('visibility', parseFloat(props.autoAlpha) === 0 ? 'hidden' : 'inherit', 'important');
    }
    if (transformCSS) el.style.setProperty('transform', transformCSS, 'important');
  }
  // Forward to sandbox iframe / the actual replica tile — ALWAYS (this is what
  // makes the preview land on the selected viewport regardless of iframe mode).
  if (nodeId) {
    const prefix = getViewportPrefix(vpId || 'desktop');
    const bridgeStyles: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!value || MOTION_TRANSFORM_KEYS.has(key)) continue;
      bridgeStyles[key] = value;
    }
    if (props.autoAlpha !== undefined) {
      bridgeStyles.opacity = props.autoAlpha;
      bridgeStyles.visibility = parseFloat(props.autoAlpha) === 0 ? 'hidden' : 'inherit';
    }
    if (transformCSS) bridgeStyles.transform = transformCSS;
    getCanvasBridge().patchStyles(nodeId, prefix, bridgeStyles, true);
  }
}

/** Clear preview styles from a DOM element.
 *  Also clears via bridge in iframe mode.
 *  Pass nodeId + vpId for bridge forwarding (optional). */
export function clearPreview(el: HTMLElement | null, props: Record<string, string>, nodeId?: string, vpId?: string): void {
  if (el) {
    for (const key of Object.keys(props)) {
      if (MOTION_TRANSFORM_KEYS.has(key)) continue;
      const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      el.style.removeProperty(kebab);
    }
    el.style.removeProperty('transform');
  }
  // Forward to sandbox iframe
  if (nodeId) {
    const prefix = getViewportPrefix(vpId || 'desktop');
    const clearStyles: Record<string, string> = {};
    for (const key of Object.keys(props)) {
      if (MOTION_TRANSFORM_KEYS.has(key)) continue;
      clearStyles[key] = '';
    }
    clearStyles.transform = '';
    getCanvasBridge().patchStyles(nodeId, prefix, clearStyles);
  }
}

/** RESTORE preview keys to the element's RESTING (authored) values instead of
 *  removing them. The preview overwrites the element's OWN inline value — e.g. a
 *  bar's `height: 52px` becomes `height: 0 !important`. Plain removal then wipes
 *  the 52px and the element collapses (the Renderer's diff-patch won't re-add an
 *  unchanged value). So we re-set each key from `restingStyles` (the node's source
 *  style); keys with no authored value (opacity/transform) are removed → default.
 *  Non-`!important` writes replace the preview's `!important` declaration. */
export function restorePreview(el: HTMLElement | null, keys: string[], restingStyles: Record<string, string> | undefined, nodeId?: string, vpId?: string): void {
  const restOf = (k: string): string | null => {
    const v = restingStyles?.[k];
    return v != null && v !== '' ? v : null;
  };
  if (el) {
    for (const key of keys) {
      if (MOTION_TRANSFORM_KEYS.has(key)) continue;
      const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      const v = restOf(key);
      if (v != null) el.style.setProperty(kebab, v); else el.style.removeProperty(kebab);
    }
    el.style.removeProperty('transform');
  }
  if (nodeId) {
    const prefix = getViewportPrefix(vpId || 'desktop');
    const bridgeStyles: Record<string, string> = {};
    for (const key of keys) {
      if (MOTION_TRANSFORM_KEYS.has(key)) continue;
      bridgeStyles[key] = restOf(key) ?? '';
    }
    bridgeStyles.transform = '';
    getCanvasBridge().patchStyles(nodeId, prefix, bridgeStyles);
  }
}

// Debounce window for the DEFERRED code commit (deferCommit) — long enough to
// skip mid-drag frames, short enough that the commit lands promptly after release.
const COMMIT_DEBOUNCE_MS = 150;

// ─── MotionPropsEditor ───────────────────────────────────────────────────────

interface MotionPropsEditorProps {
  nodeId: string;
  props: Record<string, string>;
  onChange: (newProps: Record<string, string>) => void;
  /** Apply !important preview styles to DOM element while editing. Default: false. */
  preview?: boolean;
  /** Defer the code commit (onChange) until the drag settles — the live !important
   *  preview already shows the result instantly, so committing per frame (reparse
   *  + full canvas re-render) is wasted work and tanks slider FPS. Debounced + a
   *  flush on release/unmount. Default: false (commit on every change). */
  deferCommit?: boolean;
  /** Control mode for ToolAtoms. Default: 'motionVariant'. */
  mode?: ControlMode;
  /** Extra keys from sibling stops (scroll) — show controls for keys added to ANY stop */
  extraKeys?: Set<string>;
  /** Optional transition row rendered after Preserve 3D */
  transitionRow?: React.ReactNode;
  /** Render the Add Property list externally (e.g. KeyframeSheet sliding panel) */
  renderAddPropertyList?: (list: React.ReactNode) => void;
}

export default function MotionPropsEditor({ nodeId, props, onChange, preview, deferCommit, mode = 'motionVariant', extraKeys, transitionRow, renderAddPropertyList }: MotionPropsEditorProps) {
  // Drop parser-internal markers (`_scope`, `_variantName`) so they never render
  // as a property row or get written back into the animation object.
  const stripMarkers = (p: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) out[k] = v;
    return out;
  };
  const [localProps, setLocalProps] = useState(() => stripMarkers(props));
  // Latest incoming props (the resolved per-viewport branch) — read in the
  // re-seed effect without making it depend on every props change.
  const propsRef = useRef(props);
  propsRef.current = props;
  const popupCtx = useToolPopupOptional();
  const pushPanel = popupCtx?.pushPanel;
  const popPanel = popupCtx?.popPanel;
  const [showAddList, setShowAddList] = useState(false);
  const localPropsRef = useRef(localProps);
  localPropsRef.current = localProps;

  // Preview the hover/effect state on the tile the user is editing (the selected
  // replica / variant), not always the primary. Was hardcoded to 'desktop', so
  // editing a tablet-scoped hover flashed the preview on the desktop tile.
  const previewVpId = useAtomValue(interactingViewportIdAtom);

  // ── Deferred commit (FPS) ───────────────────────────────────────────────────
  // `setLocalProps` drives the IMPERATIVE !important DOM preview (60fps, and it
  // survives canvas re-renders — see the line-~289 note). The `onChange` COMMIT
  // is FAR heavier than a normal style write: for scroll it's
  // updateScrollAnimInCode → re-parse the scroll hooks (~14×) + parseProjectFile
  // + full canvas re-render. Running it per slider tick tanks FPS. With
  // `deferCommit` on, only the live preview runs during the drag and the code
  // commits ONCE when the drag ENDS. The reliable "a slider is dragging" signal
  // is `canvasInteractingAtom` — ToolSlider (Radix) flips it true for the whole
  // drag and false on release. (A debounce fired between slow drag steps; window
  // pointer events don't fire because Radix captures the pointer — both left ~20
  // commits per drag in the trace.) Keyboard / ToolInput edits don't set the
  // atom, so they fall back to a short debounce.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingCommitRef = useRef<Record<string, string> | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushCommit = useCallback(() => {
    if (commitTimerRef.current != null) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    if (pendingCommitRef.current != null) {
      trace.action('motion-props:flush-commit', {});
      onChangeRef.current(pendingCommitRef.current);
      pendingCommitRef.current = null;
    }
  }, []);
  const sliderDragging = useAtomValue(canvasInteractingAtom);
  const handleChange = useCallback((newProps: Record<string, string>) => {
    setLocalProps(newProps);                 // LIVE: imperative preview re-applies (fast)
    if (!deferCommit) { onChange(newProps); return; }
    pendingCommitRef.current = newProps;      // DEFERRED — committed when the drag ends
    const dragging = getDefaultStore().get(canvasInteractingAtom);
    // DIAGNOSTIC: if this line appears in the trace, the deferred path is LIVE.
    // Its absence (alongside many updateScrollAnimInCode) means a stale module.
    trace.action('motion-props:deferred-change', { dragging });
    if (dragging) return;                    // mid-slider-drag: wait for release
    if (commitTimerRef.current != null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(flushCommit, COMMIT_DEBOUNCE_MS);  // keyboard fallback
  }, [onChange, deferCommit, flushCommit]);
  // Commit when a slider drag ENDS (canvasInteracting true → false) + on unmount.
  useEffect(() => {
    if (deferCommit && !sliderDragging) flushCommit();
  }, [sliderDragging, deferCommit, flushCommit]);
  useEffect(() => () => flushCommit(), [flushCommit]);

  // Re-seed local edits when the preview TARGET changes — the user selected a
  // different replica / variant tile (previewVpId) or a different node. The
  // incoming `props` is the resolved branch for THAT tile, so the editor + DOM
  // preview must adopt it; otherwise we'd keep injecting the settings from
  // whichever tile the popup first opened on. Keyed on previewVpId/nodeId only
  // (NOT props) so in-progress edits on the same tile aren't clobbered.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; } // useState already seeded mount
    flushCommit();   // commit the OLD tile's pending edit before re-seeding to the new target
    const seeded = stripMarkers(propsRef.current);
    localPropsRef.current = seeded;   // sync so the preview effect (same commit) reads fresh, no flash
    setLocalProps(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewVpId, nodeId]);

  // EXTERNAL-CHANGE SYNC — the popup is open and the underlying animation
  // changes from OUTSIDE this editor (Paste Style on the row, undo): re-seed so
  // the open popup shows the new values instead of the stale pre-paste ones
  // (live find 2026-07-13: pasted hover only appeared after close + reopen).
  // Guards (the value-sync-own-commit lesson — never clobber in-flight edits):
  //   • skip while a slider drag / deferred commit / debounce timer is pending
  //   • skip when the incoming props deep-equal the local value (our own commit
  //     round-tripping through the parser — the common case after every edit)
  const propsSig = JSON.stringify(stripMarkers(props));
  useEffect(() => {
    if (!didMountRef.current) return;   // mount seed already handled
    if (sliderDragging || pendingCommitRef.current != null || commitTimerRef.current != null) return;
    const incoming = stripMarkers(propsRef.current);
    if (JSON.stringify(incoming) === JSON.stringify(localPropsRef.current)) return;
    trace.action('motion-props:external-reseed', { nodeId, keys: Object.keys(incoming) });
    localPropsRef.current = incoming;
    setLocalProps(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsSig]);

  // True for the KeyframeSheet's stop-authoring mode. It's the only mode
  // where Auto Alpha / Depth (Z) / px↔% Offset toggle / Perspective /
  // Preserve 3D should appear — the rest (motionVariant, scrollStop,
  // motionPathWaypoint) target framer-motion which doesn't use those
  // props.
  const isKeyframeMode = mode === 'cssKeyframe';

  // Mode props for all ToolAtoms
  const mp = { mode: mode as 'scrollStop', stopProps: localProps, onStopChange: handleChange };

  // ── Preview system ──────────────────────────────────────────────────────────
  // Accumulate EVERY key ever injected as a preview so teardown clears the FULL
  // set — not just whatever's in localProps at close. Without this, a key the
  // user added then changed/removed mid-edit (e.g. add Width → 0, which injects
  // `width: 0 !important`) was left STALE in the DOM: the Renderer re-paints the
  // base styles non-important, so the !important preview survived and the element
  // stayed collapsed at 0. applyTrackedPreview also clears keys dropped between
  // applies, and the teardown clears the whole union so nothing leaks. (`transform`
  // is always cleared by clearPreview itself, so transform keys aren't tracked.)
  const appliedKeysRef = useRef<Set<string>>(new Set());
  // The node's RESTING (authored) styles — what the preview must restore TO on
  // teardown (read imperatively so we don't re-subscribe/re-render per node change).
  const getRestingStyles = useCallback(() => getDefaultStore().get(nodesAtom).get(nodeId)?.styles, [nodeId]);
  const applyTrackedPreview = useCallback((p: Record<string, string>) => {
    // el = null: the canvas DOM lives in the sandbox iframe — the preview
    // helpers reach it through their bridge path (nodeId + vpId).
    const next = new Set(Object.keys(p).filter((k) => p[k] && !MOTION_TRANSFORM_KEYS.has(k)));
    if (p.autoAlpha !== undefined) { next.add('opacity'); next.add('visibility'); }
    // Restore keys previewed before but gone now (removed row / emptied value) to
    // their resting value — NOT remove (removal wipes the element's own inline).
    const stale = [...appliedKeysRef.current].filter((k) => !next.has(k));
    if (stale.length) restorePreview(null, stale, getRestingStyles(), nodeId, previewVpId);
    applyPreview(null, p, nodeId, previewVpId);
    appliedKeysRef.current = next;
  }, [nodeId, previewVpId, getRestingStyles]);

  useEffect(() => {
    if (!preview) return;
    applyTrackedPreview(localPropsRef.current);
    trace.action('motion-props:preview-apply', { nodeId, vpId: previewVpId, propCount: Object.keys(localPropsRef.current).length });
    return () => {
      // RESTORE the FULL accumulated set to the node's resting styles so the popup
      // close never leaves the DOM stale (e.g. a bar stuck at height 0 because the
      // preview overwrote its 52px and removal would have deleted it entirely).
      // el = null: the bridge path (nodeId + vpId) reaches the iframe element.
      restorePreview(null, [...appliedKeysRef.current], getRestingStyles(), nodeId, previewVpId);
      appliedKeysRef.current.clear();
      trace.action('motion-props:preview-remove', { nodeId });
    };
  }, [nodeId, preview, previewVpId, applyTrackedPreview, getRestingStyles]);

  // Update preview when props change
  useEffect(() => {
    if (!preview) return;
    applyTrackedPreview(localProps);
  }, [localProps, preview, applyTrackedPreview]);

  // ── Track added style properties ────────────────────────────────────────────
  const allKeys = new Set(Object.keys(localProps));
  // Include keys from sibling stops (scroll: if one stop has borderRadius, all show it)
  if (extraKeys) {
    for (const key of extraKeys) allKeys.add(key);
  }
  // Expand sub-properties to parent atom keys
  for (const key of [...allKeys]) {
    if (SUB_PROPERTY_MAP[key]) allKeys.add(SUB_PROPERTY_MAP[key]);
  }

  const addedStyleKeys = [...allKeys].filter(k =>
    !TRANSFORM_KEYS.has(k) && ADDABLE_STYLE_ATOMS.some(a => a.key === k)
  );

  // Raw value properties — shown as simple controls when present
  const RAW_VALUE_PROPS = ['color', 'width', 'height'];
  const activeRawProps = RAW_VALUE_PROPS.filter(k => allKeys.has(k));

  const availableToAdd = ADDABLE_STYLE_ATOMS.filter(a => !allKeys.has(a.key));
  // Add raw value props to the "Add Property" list if not already present
  const availableRawProps = RAW_VALUE_PROPS.filter(k => !allKeys.has(k));

  return (
    <div className="flex flex-col gap-2">
      {/* Keyframe-only controls (Auto Alpha, Depth Z, Perspective,
          Preserve 3D, px/% Offset toggle) are gated on `isKeyframeMode`.
          Motion-native modes (motionVariant, variant, scrollStop) get
          standard set: Opacity, Rotate, Rotate 3D, Offset
          (px-only), Skew, Scale — and nothing else. Showing keyframe-only
          props in scroll stops produced garbage that never reached the
          generated code (scroll-mode just uses motion props). */}
      {/* Transform ToolAtoms — always shown */}
      <OpacityControl {...mp} />
      <RotateControl {...mp} />
      <Rotate3DControl {...mp} />
      {/* Motion keeps the plain px-only OffsetControl. Keyframe mode gets a
          combined Offset row below with a px/% unit toggle (both `x`/`y` and
          `xPercent`/`yPercent` are authorable and 99% of users want one or the
          other, not both). */}
      {!isKeyframeMode && <OffsetControl {...mp} />}
      {/* Keyframe-only controls */}
      {isKeyframeMode && (
        <>
          {/* Combined Offset (px or %) — toggling the unit moves the values
              to the other property pair and clears the inactive one, so the
              code stays in one of the two modes at a time. */}
          {(() => {
            const usingPercent = !!(localProps.xPercent || localProps.yPercent);
            const xKey = usingPercent ? 'xPercent' : 'x';
            const yKey = usingPercent ? 'yPercent' : 'y';
            const xVal = localProps[xKey] || '0';
            const yVal = localProps[yKey] || '0';
            const toggleUnit = () => {
              const next: Record<string, string> = { ...localProps };
              if (usingPercent) {
                next.x = localProps.xPercent || '0';
                next.y = localProps.yPercent || '0';
                next.xPercent = '';
                next.yPercent = '';
              } else {
                next.xPercent = localProps.x || '0';
                next.yPercent = localProps.y || '0';
                next.x = '';
                next.y = '';
              }
              handleChange(next);
            };
            return (
              <div className="flex items-center justify-between w-full">
                <ControlLabel label="Offset" property="" plain />
                <div className="flex items-center w-full gap-1">
                  <ToolInput value={xVal} onChange={(v) => handleChange({ ...localProps, [xKey]: v })} step={1} chevronLabel="X" />
                  <ToolInput value={yVal} onChange={(v) => handleChange({ ...localProps, [yKey]: v })} step={1} chevronLabel="Y" />
                  <button type="button" onClick={toggleUnit}
                    className="flex items-center justify-center h-7 px-1.5 text-[10px] font-medium transition-colors cursor-pointer bg-[var(--button-secondary-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-md shrink-0"
                    title={`Switch to ${usingPercent ? 'pixels' : 'percent'}`}>
                    {usingPercent ? '%' : 'px'}
                  </button>
                </div>
              </div>
            );
          })()}
          {/* Auto Alpha — opacity + visibility:hidden at 0 */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Auto Alpha" property="" plain />
            <div className="w-full">
              <ToolInput value={localProps.autoAlpha || '1'} onChange={(v) => handleChange({ ...localProps, autoAlpha: v })} step={0.1} />
            </div>
          </div>
          {/* Depth (Z) — translateZ in px */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Depth (Z)" property="" plain />
            <div className="w-full">
              <ToolInput value={localProps.z || '0'} onChange={(v) => handleChange({ ...localProps, z: v })} step={1} chevronLabel="px" />
            </div>
          </div>
        </>
      )}
      <SkewControl {...mp} />
      <ScaleXYControl {...mp} />
      {/* Perspective + Preserve 3D are keyframe-mode only — the CSS
          properties that set up the 3D rendering context, not
          something framer-motion users author per-stop. */}
      {isKeyframeMode && <PerspectiveControl {...mp} />}
      {isKeyframeMode && <Preserve3DControl {...mp} />}

      {/* Transition row — rendered between Preserve 3D and Add Property */}
      {transitionRow}

      {/* Added style properties — same ToolAtoms as StylesTool */}
      {addedStyleKeys.map(key => {
        const entry = ADDABLE_STYLE_ATOMS.find(a => a.key === key);
        if (!entry) return null;
        return <entry.Atom key={key} {...mp} />;
      })}

      {/* Raw value properties — color as text, width/height as numeric + unit */}
      {activeRawProps.map(key => {
        if (key === 'color') {
          return (
            <div key={key} className="flex items-center justify-between w-full">
              <ControlLabel label="Color" property="" plain />
              <div className="w-full">
                <ColorInput value={localProps.color || '#000000'} onChange={(v) => handleChange({ ...localProps, color: v })} />
              </div>
            </div>
          );
        }
        const raw = localProps[key] || '0';
        const match = raw.match(/^(-?[\d.]+)\s*(px|%)?$/);
        const num = match ? match[1] : raw.replace(/[^-\d.]/g, '') || '0';
        const unit = match?.[2] || 'px';
        return (
          <div key={key} className="flex items-center justify-between w-full">
            <ControlLabel label={key === 'width' ? 'Width' : 'Height'} property="" plain />
            <div className="flex items-center gap-1 w-full">
              <div className="flex-1">
                <ToolInput value={num} onChange={(v) => handleChange({ ...localProps, [key]: `${v}${unit}` })} step={1} />
              </div>
              <div className="flex-1">
                <ToolSelect value={unit} onChange={(u) => handleChange({ ...localProps, [key]: `${num}${u}` })}
                  options={[{ value: 'px', label: 'px' }, { value: '%', label: '%' }]} />
              </div>
            </div>
          </div>
        );
      })}

      {/* Add Property — right-aligned like other controls.
          The empty `<ControlLabel/>` matches the same `w-3/4 + pl/-ml [18px]`
          gutter recovery as the real labels in this panel, and the
          `<div className="w-full">` wrapper makes the button claim the
          full right column (without it, the button shrinks to content). */}
      {(availableToAdd.length > 0 || availableRawProps.length > 0) && (
        <>
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="" property="" plain />
            <div className="w-full">
            <button onClick={() => {
              const closeAll = () => { popPanel?.(); setShowAddList(false); renderAddPropertyList?.(null); };
              const addList = (
                <div className="flex flex-col gap-1">
                  {availableRawProps.map(key => (
                    <button key={key}
                      onClick={() => { handleChange({ ...localProps, [key]: '0' }); closeAll(); }}
                      className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                      {(() => { const I = getPropertyIcon(key); return <I width={20} height={20} className="shrink-0" />; })()}
                      {key === 'color' ? 'Color' : key === 'width' ? 'Width' : 'Height'}
                    </button>
                  ))}
                  {availableToAdd.map(({ key, label }) => (
                    <button key={key}
                      onClick={() => { handleChange({ ...localProps, [key]: ADD_PROPERTY_DEFAULTS[key] || '0' }); closeAll(); }}
                      className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                      {(() => { const I = getPropertyIcon(key); return <I width={20} height={20} className="shrink-0" />; })()}
                      {label}
                    </button>
                  ))}
                </div>
              );
              if (pushPanel) pushPanel('Add Property', addList);
              else if (renderAddPropertyList) renderAddPropertyList(addList);
              else setShowAddList(!showAddList);
            }}
              className="w-full h-8 flex items-center justify-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors">
              + Add Property
            </button>
            </div>
          </div>
          {/* Inline add list when no popup context (KeyframeSheet) */}
          {showAddList && !pushPanel && (
            <div className="flex flex-col gap-1">
              {availableRawProps.map(key => (
                <button key={key}
                  onClick={() => { handleChange({ ...localProps, [key]: '0' }); setShowAddList(false); }}
                  className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                  {key === 'color' ? 'Color' : key === 'width' ? 'Width' : 'Height'}
                </button>
              ))}
              {availableToAdd.map(({ key, label }) => (
                <button key={key}
                  onClick={() => { handleChange({ ...localProps, [key]: ADD_PROPERTY_DEFAULTS[key] || '0' }); setShowAddList(false); }}
                  className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]">
                  {label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
