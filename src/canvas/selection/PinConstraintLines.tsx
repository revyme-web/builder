// PinConstraintLines.tsx — Dashed lines from each pinned edge of an absolute
// element to the corresponding edge of its parent. Always visible while an
// absolute-positioned element with `top`/`right`/`bottom`/`left` pins is
// selected — including during drag (the RAF poll keeps them tracking).
//
// Transform handling: when the selected node OR any ancestor has a CSS
// `transform` applied, the pin lines are HIDDEN entirely. The math to draw
// constraint lines that correctly follow a rotated/skewed parent's local
// frame is doable but visually noisy — every angle the user sees on screen
// has to be reasoned about against the parent's local space, and the
// information is more confusing than helpful in those cases. Hiding is a
// cleaner UX. The selection's own corner-aware overlay (SelectionBorder,
// resize handles) still shows the user where their element is.
//
// Hidden-state handling: we ask the BRIDGE for the rendered element's
// computed `display` and check the rect collapse — instead of mirroring the
// parser's per-source resolution chain (motionVariants, conditionalStyles,
// containerOverrides, instance-tag redirect, ancestor display:none, etc.).
// Each storage format has its own routing quirks across page-vs-master,
// primary-vs-replica, and component-instance redirects; the browser already
// resolved them all by the time it computed `display` on the element, so
// the bridge answer is the single source of truth.

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom, selectedIdsAtom, canvasInteractingAtom, getNodeFromCache } from '@/code/stores/store';
import { useLiveNode } from '@/code/stores/node-family';
import { interactingViewportIdAtom, viewportsConfigAtom } from '@/code/stores/viewport-store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { activeFilePathAtom, isComponentFilePath, isIconSetFilePath } from '@/code/project/active-file-store';
import { shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import { findNodeRect, findNodeComputedStyle } from '@/canvas/node-ops';
import { nodeOrAncestorHasRotationOrSkewById } from '@/canvas/resize/geometry-utils';
import { useDropLineActive } from '@/canvas/selection/drop-line-store';
import { isStylePinned, getEffectiveStyles, pinDataEqual } from './pin-constraint-utils';
import { trace } from '@/shared/debug-trace';

const COLOR_PAGE = '#3b82f6';
const COLOR_COMP = '#a78bfa';

export interface PinData {
  lp: boolean; rp: boolean; tp: boolean; bp: boolean;
  er: DOMRect; pr: DOMRect;
}


function CLine({ dir, d, color }: { dir: string; d: PinData; color: string }) {
  const { er, pr } = d;
  let x1: number, y1: number, x2: number, y2: number;
  if (dir === 'top') { x1 = x2 = er.left + er.width / 2; y1 = pr.top; y2 = er.top; }
  else if (dir === 'bottom') { x1 = x2 = er.left + er.width / 2; y1 = er.bottom; y2 = pr.bottom; }
  else if (dir === 'left') { y1 = y2 = er.top + er.height / 2; x1 = pr.left; x2 = er.left; }
  else { y1 = y2 = er.top + er.height / 2; x1 = er.right; x2 = pr.right; }
  return <line x1={x1!} y1={y1!} x2={x2!} y2={y2!} stroke={color} strokeWidth={1} strokeDasharray="4 4" />;
}

export default function PinConstraintLines() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  // Per-node subscription: the effect re-arms when THIS node changes (its
  // position/pin gating lives in the setup below); commits elsewhere no
  // longer restart the loop. The ancestor transform walk reads a fresh
  // imperative snapshot; rendered transforms are caught per-frame anyway
  // (the findNodeComputedStyle poll inside update()).
  const node = useLiveNode(selectedId);
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const viewportsConfig = useAtomValue(viewportsConfigAtom);
  // Active viewport's @media max-width (used to pick the right
  // replica override bucket). 0 for the primary viewport (no @media
  // override applies) — getEffectiveStyles short-circuits in that case.
  const currentVpMaxWidth = (() => {
    const vpCfg = viewportsConfig.find(v => v.id === vpId);
    if (!vpCfg || vpCfg.isPrimary) return 0;
    return vpCfg.width ?? 0;
  })();
  // Suppress pin-lines entirely while a layout drop preview is active —
  // the drop-line indicator and the dragged element are the focus, and
  // the dashed pin lines on the (now-stale) selected node would clutter
  // the same screen region. Hook re-runs the component when the drop-
  // line shows/hides so the lines pop back as soon as the preview ends.
  const dropLineActive = useDropLineActive();
  const isComp = isComponentFilePath(activeFile);
  // Icon-set masters lay out their cards with absolute positioning
  // purely as a presentation grid. The pin lines aren't a real
  // authoring surface there, and the dashed connectors from each card
  // to the master root just clutter the canvas with no useful
  // affordance.
  const isIconSet = isIconSetFilePath(activeFile);
  // While editing a shape's vertices, the selection IS the <svg> wrapper but
  // the user is reshaping the path — static wrapper→parent dashes are noise.
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const color = isComp ? COLOR_COMP : COLOR_PAGE;
  const [pin, setPin] = useState<PinData | null>(null);
  // Imperative escape hatch for the RAF live-reparent check below: React
  // batches a setState issued from a RAF tick as a normal task, which on a
  // big page queues BEHIND the drop's deferred fan-out parse (~120ms long
  // task) — the stale lines would outlive the drop by ~200ms. Hiding the
  // mounted svg directly commits within the same frame; setPin then
  // reconciles React state whenever the scheduler gets to it.
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    // Imperative hide + state clear. The gating exits below run in the
    // effect AFTER a reparent commit, but the setPin(null) REMOVAL render
    // they schedule can land a full fan-out long task later (~120ms on a
    // big page). Hiding the mounted svg directly makes the lines vanish in
    // this same frame; the state catch-up then unmounts it for real.
    // `reason` is traced so a "why aren't my pin lines showing?" report
    // pinpoints the exact gate that fired (live find 2026-07-24: a hero whose
    // ancestor carried a benign translate/scale was hiding them — the trace
    // now names the culprit gate directly).
    const suppress = (reason: string) => {
      if (svgRef.current) svgRef.current.style.display = 'none';
      setPin(null);
      trace.action('pin-constraint-lines:suppress', { selectedId, reason });
    };
    trace.action('pin-constraint-lines:gate', {
      selectedId, hasNode: !!node, isCanvasNode: node?.isCanvasNode,
      pos: node?.styles?.position, parentId: node?.parentId,
      left: node?.styles?.left, top: node?.styles?.top,
    });
    // Icon-set masters: suppress entirely. See `isIconSet`
    // comment above.
    if (isIconSet) { suppress('icon-set'); return; }
    if (!selectedId) { suppress('no-selection'); return; }
    if (!node) { suppress('no-node'); return; }

    // Canvas nodes float freely — including ones connected into a code
    // component slot (which have a parentId but still float). Their inline
    // left/top are workspace coords, not parent-relative pins, so the pin
    // constraint lines are meaningless and visually wrong.
    if (node.isCanvasNode) { suppress('canvas-node'); return; }

    // SVG shapes get pin constraint lines exactly like any other absolute
    // element — an absolute <svg> with left/top/right/bottom pins has the same
    // constraint story as an absolute frame (user request 2026-07-24). The
    // `dynamicPinNodes` exclusion in AbsoluteInFrameStrategy is about DRAG
    // auto-pin conversion only, NOT about the visualization — a `data-pinned`
    // frame is excluded from `dynamicPinNodes` too yet still shows these lines.
    // Two SVG cases stay suppressed:
    //   • SVG-GROUP CHILDREN (a nested <svg> inside an <svg> group) are placed
    //     by x/y ATTRIBUTES in SVG coord space, so their CSS `position` is
    //     static → the `pos !== 'absolute'` gate below filters them naturally
    //     (no explicit type check needed).
    //   • SHAPE-EDIT mode — reshaping vertices; wrapper dashes are clutter.
    if (node.type === 'svg' && shapeEditingId === selectedId) { suppress('svg-shape-edit'); return; }

    // Pin lines apply only to absolutely-positioned elements (the
    // top/right/bottom/left values are meaningful relative to the
    // parent). Read EFFECTIVE styles (base + active vp's @media)
    // so a replica that pinned an element only via @media still
    // shows constraint lines on that viewport.
    const effectiveStyles = getEffectiveStyles(selectedId, node.styles ?? {}, currentVpMaxWidth, containerOverrides);
    const pos = effectiveStyles.position;
    if (pos !== 'absolute' && pos !== 'fixed') { suppress('not-absolute'); return; }

    const parentId = node.parentId;
    if (!parentId) { suppress('no-parent'); return; }

    // Suppress ONLY for genuine ROTATION or SKEW anywhere up the chain — those
    // rotate the parent's pinned edge off the screen axes, so an axis-aligned
    // dashed line would point to the wrong place. A benign translate / scale /
    // translateZ(0) leaves every edge axis-aligned (findNodeRect already returns
    // the post-transform SCREEN rect for both element and parent), so the lines
    // stay correct. The old "ANY transform hides them" rule wrongly killed pin
    // lines on hero sections whose ancestor carried a plain translate/scale
    // (glow wrapper / parallax / GPU-layer hint) — live find 2026-07-24. This
    // bridge helper reads LIVE computed matrices, walks ancestors, and checks
    // the matrix b/c terms only (rotation/skew), so it ignores the canvas
    // pan/zoom on root and catches animation-injected rotations too.
    if (nodeOrAncestorHasRotationOrSkewById(selectedId, vpId)) { suppress('rotation-or-skew'); return; }

    const hasPin = isStylePinned(effectiveStyles.left) || isStylePinned(effectiveStyles.right) || isStylePinned(effectiveStyles.top) || isStylePinned(effectiveStyles.bottom);
    if (!hasPin) { suppress('no-pin'); return; }

    let rafId: number;
    const update = () => {
      // LIVE reparent check straight off the imperative cache — the drag
      // strategies' exit/enter reparent mutates the cache synchronously, but
      // the React path to hide the lines (version bump → re-render → THIS
      // effect re-runs → setPin) needs an extra effect hop that lands AFTER
      // the next paint — and on a big page the drop's deferred fan-out parse
      // (a ~120ms long task at mouseup+32ms) starves that second render, so
      // stale pin lines lingered ~160ms after dragging OUT of the frame.
      // Reading the cache here and calling setPin(null) from the RAF tick
      // commits the removal in the SAME frame, ahead of the fan-out timer.
      // Only the reparent signals are checked (isCanvasNode / parentId) —
      // position/pin edits re-run the effect via the version-bump
      // subscription in useLiveNode, which has no long task racing it.
      const live = getNodeFromCache(selectedId);
      if (live && (live.isCanvasNode || live.parentId !== parentId)) {
        trace.action('pin-constraint-lines:live-reparent-suppress', { selectedId, isCanvasNode: live.isCanvasNode, parentId: live.parentId, expectedParent: parentId });
        if (svgRef.current) svgRef.current.style.display = 'none';
        setPin(null); rafId = requestAnimationFrame(update); return;
      }
      if (svgRef.current && svgRef.current.style.display === 'none') svgRef.current.style.display = '';
      // Hidden-state check via the bridge's computed style, NOT by mirroring
      // the parser's per-source resolution chain (motionVariants /
      // conditionalStyles / containerOverrides / instance redirect / etc.).
      // Each source has its own quirks — variant viewports on a component
      // master, @media on a page replica, instance-tag redirect on a deep
      // component child, ancestor display:none — and reproducing the cascade
      // in TS drifts out of sync the moment any of those storage formats
      // changes. The actual rendered element's `display` already reflects
      // every source the browser applied, so ask it directly.
      //
      // We also bail out on a collapsed (zero-size) rect — display:none on an
      // ANCESTOR doesn't show up on this element's own computed display, but
      // it does collapse its bounding rect, so the AND of the two catches
      // every "not actually visible" case.
      const display = findNodeComputedStyle(selectedId, vpId, 'display');
      if (display === 'none') { setPin(null); rafId = requestAnimationFrame(update); return; }

      // Live ROTATION/SKEW check (rotation/skew only — NOT any transform).
      // Catches rotations rendered AFTER arm time: animation editors (Motion /
      // GSAP hover, tap, loop) inject `transform: rotate(...)` onto the live
      // element as a preview, which never touches the parsed source tree the
      // startup check walked. Ancestor-aware, so a rotated PARENT also trips it.
      // A plain translate/scale (b=c=0 in the matrix) leaves the pinned edges
      // axis-aligned, so the lines stay valid — the reason the hero's benign
      // ancestor transform no longer hides them (live find 2026-07-24).
      if (nodeOrAncestorHasRotationOrSkewById(selectedId, vpId)) { setPin(null); rafId = requestAnimationFrame(update); return; }

      const er = findNodeRect(selectedId, vpId);
      const pr = findNodeRect(parentId, vpId);
      if (er && pr && (er.width > 0 || er.height > 0)) {
        // Read styles from the live cache (not the captured `nodes` map).
        // During dynamic-pin drag, the strategy mutates `_cachedNodes`
        // via `updateNodeInCache` per frame; the captured `nodes`
        // reference here is stale until commit. Reading via
        // `getNodeFromCache` makes the pin-side detection track the
        // user's drag in real time — left/right/top/bottom badges flip
        // as the auto-pin shifts.
        //
        // Merge active-viewport @media overrides on top of the live
        // cache so a replica-only pin (e.g. tablet-only full inset)
        // is detected on this viewport. Without the merge the pin
        // constraint lines would only appear when the desktop primary
        // had the pin, even though the tablet view clearly shows the
        // pinned axis.
        const currentNode = getNodeFromCache(selectedId) ?? node;
        const cs = getEffectiveStyles(selectedId, currentNode?.styles ?? {}, currentVpMaxWidth, containerOverrides);
        const next: PinData = {
          lp: isStylePinned(cs.left), rp: isStylePinned(cs.right),
          tp: isStylePinned(cs.top), bp: isStylePinned(cs.bottom),
          er, pr,
        };
        // Keep the PREVIOUS object when nothing changed so React bails out of
        // the render — see `pinDataEqual`. Without this the per-frame object
        // churn fed a synchronous set→render→effect→set chain and blew the
        // update-depth limit mid-drag.
        setPin(prev => (pinDataEqual(prev, next) ? prev : next));
      } else {
        setPin(null);
      }
      rafId = requestAnimationFrame(update);
    };
    // FIRST tick via RAF too — never synchronously in the effect body. A
    // synchronous update() means: setPin → render → (a dep like `node`
    // changed identity) → effect re-runs → setPin … all within one commit,
    // which is exactly the chain React's update-depth limit kills. Deferring
    // one frame costs nothing visually and structurally caps the loop even
    // if a future equality-guard hole (the NaN one, say) reopens.
    rafId = requestAnimationFrame(update);

    return () => { cancelAnimationFrame(rafId); };
  }, [selectedId, vpId, node, isComp, isIconSet, shapeEditingId, containerOverrides, currentVpMaxWidth]);

  // Keep pin lines visible during drag too — the RAF loop above re-reads
  // findNodeRect every frame, so the lines track the moving element. Users
  // want to see the pin constraints WHILE adjusting position to understand
  // what they're pinned to.
  // RENDER-PHASE gate on the live node — don't wait for the effect to clear
  // `pin`. After a reparent commit (drag OUT of a frame), the version bump
  // schedules this render immediately, but the passive-effect pass that
  // would setPin(null) queues BEHIND the drop's deferred fan-out parse
  // (~120ms long task on a big page) — the stale lines outlived the drop by
  // ~150ms. Deriving the suppress conditions here unmounts the svg on the
  // FIRST post-commit render; the effect then reconciles state at leisure.
  const liveGateOk = (() => {
    if (!node || node.isCanvasNode || !node.parentId) return false;
    // Absolute SVGs show pin lines; only shape-edit mode suppresses (see effect).
    if (node.type === 'svg' && shapeEditingId === selectedId) return false;
    const pos = getEffectiveStyles(selectedId!, node.styles ?? {}, currentVpMaxWidth, containerOverrides).position;
    return pos === 'absolute' || pos === 'fixed';
  })();

  if (!pin) return null;
  if (!liveGateOk) return null;
  if (dropLineActive) return null;
  // Multi-select: constraint lines target a single node and lose meaning
  // across heterogeneous nodes. Hide entirely — the multi-select bounding
  // box + per-node borders already convey the group. Gate goes AFTER all
  // hooks above (Rules of Hooks) so the early return doesn't change hook
  // count between renders.
  if (selectedIds.length > 1) return null;
  void isInteracting; // suppression intentionally not applied
  const any = pin.lp || pin.rp || pin.tp || pin.bp;
  if (!any) return null;

  return (
    <svg ref={svgRef} data-pin-constraint-lines style={{ position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 4997, overflow: 'visible' }}>
      {pin.lp && <CLine dir="left" d={pin} color={color} />}
      {pin.rp && <CLine dir="right" d={pin} color={color} />}
      {pin.tp && <CLine dir="top" d={pin} color={color} />}
      {pin.bp && <CLine dir="bottom" d={pin} color={color} />}
    </svg>
  );
}
