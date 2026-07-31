// OverlayDragStrategy.ts — Handles dragging overlay nodes.
// Overlays store OFFSET from trigger, not absolute position.
// During drag: moves element via bridge (patchNodeStyles).
// On end: calculates offset from trigger, commits to data-overlay config.

import type { DragStrategy, DragContext, DragMoveResult } from '../types';
import { patchNodeStyles, findNodeComputedStyles, isPrimaryViewport, getActiveFilePath, vpIdFromPrefix } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { findNodeRect } from '@/canvas/node-ops';
import { computeOverlayPosition } from '@/canvas/renderer/overlay-portals';
import { getViewportWidths, visibleViewportsAtom } from '@/code/stores/viewport-store';
import { resolveOverlayConfig } from '@/code/parsing/overlay-parser';
import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import type { NodeMap } from '@/shared/types';
import { transformManager } from '@/canvas/transform';
import { calculateSnap, getMouseVelocity, resetSnapHysteresis } from '../handlers/snap-handler';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { OverlayConfig, Rect } from '@/shared/types';
import { SNAP_THRESHOLD } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

/** One viewport's live drag baseline — the overlay's start left/top in that
 *  viewport's portal. Each viewport positions the overlay from its OWN trigger,
 *  so they have different absolute coords but share the drag DELTA. */
interface OverlayVpBaseline {
  vpPrefix: string;
  vpId: string;
  left: number;
  top: number;
  /** Whether this viewport's overlay should move LIVE with the current drag.
   *  Primary drag → primary + replicas WITHOUT their own offset override.
   *  Replica drag → only the dragged replica. (Same rule the @media system
   *  uses: a primary edit propagates to non-overridden replicas; a replica
   *  edit is isolated.) */
  move: boolean;
  /** Per-viewport data to recompute position via `computeOverlayPosition` —
   *  used for the NON-interacting (replica) tiles so their live position is
   *  derived from THEIR OWN trigger (which sits at a different %-resolved spot)
   *  + the live offset, exactly like the commit re-render. Null when the
   *  trigger/root rect isn't cached. */
  cfg: import('@/shared/types').OverlayConfig;
  triggerRect: { left: number; top: number; width: number; height: number } | null;
  rootRect: { left: number; top: number; width: number; height: number } | null;
  ovW: number;
  ovH: number;
}

interface OverlayDragState {
  overlayId: string;
  triggerId: string;
  config: OverlayConfig;
  initialMouseX: number;
  initialMouseY: number;
  initialLeft: number;
  initialTop: number;
  scale: number;
  /** Viewport prefix for bridge calls */
  vpPrefix: string;
  /** Resolved viewport id (for bridge rect reads) */
  vpId: string;
  /** Overlay's canvas-space top-left + size at drag start — the un-snapped
   *  position is derived from this so snapping never reads its own lagging
   *  rect mid-drag. */
  initialCanvasLeft: number;
  initialCanvasTop: number;
  overlayWidth: number;
  overlayHeight: number;
  /** Source trigger's canvas-space rect — the ONLY thing the overlay snaps
   *  against. Captured once at start (the trigger doesn't move during the drag). */
  triggerCanvasRect: Rect | null;
  /** Previous mouse pos for snap-breakout velocity. */
  prevMouseX: number;
  prevMouseY: number;
  /** Per-viewport baselines — the overlay is mirrored to EVERY viewport live
   *  during the drag (not just on mouse-up). Each viewport moves by the same
   *  delta from its own start position. */
  vpBaselines: OverlayVpBaseline[];
  /** Whether the overlay being dragged is a CANVAS node (its trigger was
   *  dragged out). Then there's no viewport portal: the drag just free-follows
   *  the cursor and commits the new offset; `Renderer.positionCanvasNodeOverlays`
   *  keeps it relative to its canvas-node trigger. */
  isCanvasOverlay: boolean;
  /** Whether the drag started on the primary viewport. */
  isPrimaryDrag: boolean;
  /** The interacting viewport's breakpoint width (for a replica-drag commit). */
  interactingVpWidth: number;
  /** Non-null when dragging on a NON-primary design-component VARIANT — its name
   *  keys the per-variant override (commit routes here instead of vpWidth). */
  variantKey: string | null;
  /** Effective offset for the interacting viewport at drag start (base or its
   *  own override) — the commit is `effective + delta`. */
  effOffsetX: number;
  effOffsetY: number;
  /** Last applied CSS delta for final offset calculation (INCLUDES snap). */
  lastCssDeltaX: number;
  lastCssDeltaY: number;
}

let dragState: OverlayDragState | null = null;

/** Top-level (parentless) ancestor — the overlay's positioning origin (a page's
 *  `root`, a component's variant-root element id). */
function topLevelAncestor(nodeId: string, nodes: NodeMap): string {
  let cur = nodes.get(nodeId);
  const seen = new Set<string>();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = nodes.get(cur.parentId);
    if (!next) break;
    cur = next;
  }
  return cur?.id ?? nodeId;
}

export const OverlayDragStrategy: DragStrategy = {
  name: 'overlay',

  canHandle(context: DragContext): boolean {
    // Check if any dragged node is a RELATIVE overlay (fixed overlays are not draggable)
    // Uses NodeMap instead of DOM — works across iframe boundary
    for (const node of context.draggedNodes) {
      const nodeData = context.nodes.get(node.id);
      if (!nodeData) continue;
      // Check overlay flag from NodeMap attrs instead of DOM attribute
      const overlayAttr = nodeData.attrs?.['data-overlay'] || '';
      if (!overlayAttr) continue;
      try {
        const config = JSON.parse(overlayAttr);
        if (config.type === 'fixed') continue;
      } catch { /* skip */ }
      return true;
    }
    return false;
  },

  onStart(context: DragContext): void {
    const node = context.draggedNodes[0];
    if (!node) return;

    const nodeData = context.nodes.get(node.id);
    if (!nodeData) return;

    // Read overlay config from NodeMap instead of DOM
    const overlayAttr = nodeData.attrs?.['data-overlay'] || '';
    let config: OverlayConfig;
    try { config = JSON.parse(overlayAttr); } catch { return; }

    // Read initial position via bridge computed styles
    const vpPrefix = context.viewportPrefix;
    const vpId = vpIdFromPrefix(vpPrefix);
    const computed = findNodeComputedStyles(node.id, vpId, ['left', 'top']);
    const initialLeft = parseFloat(computed['left']) || 0;
    const initialTop = parseFloat(computed['top']) || 0;

    // Canvas-space rects for snapping. The overlay snaps ONLY against its
    // source trigger node (see onMove) — capture the trigger's canvas rect
    // once here; it doesn't move during the drag.
    const overlayCanvasRect = getAbsoluteCanvasRectById(node.id, vpId, context.transform);
    const triggerCanvasRect = config.triggerId
      ? getAbsoluteCanvasRectById(config.triggerId, vpId, context.transform)
      : null;

    // Replica-aware live mirror. Each viewport's overlay sits at its own
    // trigger + (its own or the base) offset, so they have different absolute
    // coords but move by the same drag delta. WHICH viewports move depends on
    // where the drag started — same propagation rule as @media:
    //   • Primary drag → primary + every replica that has NO offset override.
    //   • Replica drag → only the dragged replica.
    // ACTIVE viewports — page viewports OR component VARIANTS (the variant=replica
    // analog) so replica overlays move live too. Variants report width 0.
    const vps = getDefaultStore().get(visibleViewportsAtom);
    const widthOf: Record<string, number> = Object.fromEntries(vps.map(vp => [vp.id, vp.width ?? 0]));
    // Positioning origin: the trigger's top-level ancestor (component variant
    // root), NOT hardcoded `root` — else a component overlay had no rootRect and
    // onMove skipped (stale until mouse-up).
    const rootId = topLevelAncestor(config.triggerId, getDefaultStore().get(nodesAtom));
    const isPrimaryDrag = isPrimaryViewport(vpId);
    const interactingVpWidth = widthOf[vpId] ?? 0;
    const responsive = config.responsive || {};
    const responsiveVariant = config.responsiveVariant || {};
    // Component variants read their override from `responsiveVariant[name]`, pages
    // from `responsive[width]`. Without this a variant with its OWN offset read as
    // "no override" → it WRONGLY synced during a primary drag and snapped back on
    // mouse-up (the user's bug). Detect once.
    const isComponent = isComponentFilePath(getActiveFilePath());
    const scale = context.transform.scale;
    const vpBaselines: OverlayVpBaseline[] = [];
    for (const vp of vps) {
      const v = vp.id;
      const prefix = isPrimaryViewport(v) ? '' : `${v}-`;
      const c = findNodeComputedStyles(node.id, v, ['left', 'top']);
      const ov = isComponent ? responsiveVariant[v] : responsive[String(widthOf[v])];
      const hasOffsetOverride = !!ov && (ov.offsetX !== undefined || ov.offsetY !== undefined);
      const move = isPrimaryDrag
        ? (isPrimaryViewport(v) || !hasOffsetOverride)  // skip replicas that own their offset
        : prefix === vpPrefix;                          // replica drag → only this one
      const trig = config.triggerId ? findNodeRect(config.triggerId, v) : null;
      const rootR = findNodeRect(rootId, v) ?? findNodeRect('layout::root', v) ?? findNodeRect('root', v);
      const ovRect = findNodeRect(node.id, v);
      vpBaselines.push({
        vpPrefix: prefix,
        vpId: v,
        left: parseFloat(c['left']) || 0,
        top: parseFloat(c['top']) || 0,
        move,
        cfg: resolveOverlayConfig(config, v, widthOf[v] ?? 0),
        triggerRect: trig ? { left: trig.left, top: trig.top, width: trig.width, height: trig.height } : null,
        rootRect: rootR ? { left: rootR.left, top: rootR.top, width: rootR.width, height: rootR.height } : null,
        ovW: ovRect ? ovRect.width / scale : 0,
        ovH: ovRect ? ovRect.height / scale : 0,
      });
    }

    // Effective offset for the interacting viewport at drag start (base, or its
    // own override) — the committed offset is `effective + delta`.
    const eff = isPrimaryDrag
      ? { offsetX: config.offsetX ?? 0, offsetY: config.offsetY ?? 0 }
      : resolveOverlayConfig(config, vpId, interactingVpWidth);

    // Fresh drag — clear any sticky snap state from a previous gesture.
    resetSnapHysteresis();

    dragState = {
      overlayId: node.id,
      triggerId: config.triggerId,
      config,
      initialMouseX: context.startMouse.x,
      initialMouseY: context.startMouse.y,
      initialLeft,
      initialTop,
      scale: context.transform.scale,
      vpPrefix,
      vpId,
      initialCanvasLeft: overlayCanvasRect?.left ?? 0,
      initialCanvasTop: overlayCanvasRect?.top ?? 0,
      overlayWidth: overlayCanvasRect?.width ?? 0,
      overlayHeight: overlayCanvasRect?.height ?? 0,
      triggerCanvasRect,
      prevMouseX: context.startMouse.x,
      prevMouseY: context.startMouse.y,
      vpBaselines,
      isCanvasOverlay: !!nodeData.isCanvasNode,
      isPrimaryDrag,
      interactingVpWidth,
      variantKey: (!isPrimaryDrag && isComponentFilePath(getActiveFilePath())) ? vpId : null,
      effOffsetX: eff.offsetX ?? 0,
      effOffsetY: eff.offsetY ?? 0,
      lastCssDeltaX: 0,
      lastCssDeltaY: 0,
    };

    trace.action('overlay-drag:start', {
      overlayId: node.id, triggerId: config.triggerId,
      initialLeft, initialTop, vpPrefix,
      hasTriggerRect: !!triggerCanvasRect,
    });
  },

  onMove(context: DragContext, mouseScreen: { x: number; y: number }): DragMoveResult {
    if (!dragState) return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };

    // Calculate mouse delta in screen pixels, convert to CSS pixels
    const screenDeltaX = mouseScreen.x - dragState.initialMouseX;
    const screenDeltaY = mouseScreen.y - dragState.initialMouseY;
    const cssDeltaX = screenDeltaX / dragState.scale;
    const cssDeltaY = screenDeltaY / dragState.scale;

    // ─── Canvas overlay: free cursor-follow, no viewports, no snap ───
    if (dragState.isCanvasOverlay) {
      patchNodeStyles(context.contentEl, dragState.overlayId, dragState.vpPrefix, {
        left: `${Math.round(dragState.initialLeft + cssDeltaX)}px`,
        top: `${Math.round(dragState.initialTop + cssDeltaY)}px`,
      });
      dragState.lastCssDeltaX = cssDeltaX;
      dragState.lastCssDeltaY = cssDeltaY;
      return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    // ─── Snap ONLY against the source trigger node ───
    // Snap guides are active during overlay drag, but the overlay aligns to
    // exactly ONE reference: its trigger. We work in canvas space (the units
    // SnapGuide.position renders in) using the analytic un-snapped position
    // (initial canvas rect + delta) so the math never depends on the overlay's
    // own rect, which lags a frame behind the bridge patch.
    let snapResult: import('@/shared/types').SnapResult | null = null;
    let snapOffsetX = 0;
    let snapOffsetY = 0;
    if (dragState.triggerCanvasRect && dragState.overlayWidth > 0) {
      const draggedRect: Rect = {
        left: dragState.initialCanvasLeft + cssDeltaX,
        top: dragState.initialCanvasTop + cssDeltaY,
        width: dragState.overlayWidth,
        height: dragState.overlayHeight,
      };
      const velocity = getMouseVelocity(
        { x: dragState.prevMouseX, y: dragState.prevMouseY },
        mouseScreen,
      );
      const snap = calculateSnap(
        draggedRect,
        [{ id: dragState.triggerId, rect: dragState.triggerCanvasRect }],
        velocity,
        SNAP_THRESHOLD / dragState.scale,
      );
      if (snap.snappedX) snapOffsetX = snap.x - draggedRect.left;
      if (snap.snappedY) snapOffsetY = snap.y - draggedRect.top;
      snapResult = snap;
    }
    dragState.prevMouseX = mouseScreen.x;
    dragState.prevMouseY = mouseScreen.y;

    const totalDeltaX = cssDeltaX + snapOffsetX;
    const totalDeltaY = cssDeltaY + snapOffsetY;
    // The committed offset for THIS drag (interacting vp's start offset + delta,
    // snap folded in). EVERY moving tile is positioned with the SAME
    // `computeOverlayPosition` the commit re-render uses — from its OWN trigger
    // (different %-resolved spot per viewport) + this offset. Using it for the
    // INTERACTING tile too (not a baseline + delta) means live == committed even
    // on the very FIRST drag: the old baseline came from `computedCache`, which
    // is stale on the first gesture (fresh only after a render), so the first
    // detach drag jumped on mouse-up and only later drags were stable.
    const newOffsetX = dragState.effOffsetX + totalDeltaX;
    const newOffsetY = dragState.effOffsetY + totalDeltaY;
    const scale = transformManager.getTransform().scale;
    // Component master: don't clamp the overlay to the variant tile while dragging
    // (it overflows freely over the canvas, mirroring the live page) — else the
    // overlay "stalls" at the artboard edge. Pages still clamp to the viewport.
    const noClamp = isComponentFilePath(getActiveFilePath());

    for (const vp of dragState.vpBaselines) {
      if (!vp.move || !vp.triggerRect || !vp.rootRect) continue;
      const pos = computeOverlayPosition(
        { ...vp.cfg, offsetX: newOffsetX, offsetY: newOffsetY },
        vp.ovW, vp.ovH,
        { left: vp.triggerRect.left, top: vp.triggerRect.top, width: vp.triggerRect.width, height: vp.triggerRect.height,
          right: vp.triggerRect.left + vp.triggerRect.width, bottom: vp.triggerRect.top + vp.triggerRect.height },
        vp.rootRect,
        scale,
        !noClamp,
      );
      patchNodeStyles(context.contentEl, dragState.overlayId, vp.vpPrefix, {
        left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px`,
      });
    }

    // Track last delta (INCLUDING snap) so the committed offset lands snapped.
    dragState.lastCssDeltaX = totalDeltaX;
    dragState.lastCssDeltaY = totalDeltaY;

    return {
      snap: snapResult,
      dropTarget: null,
      highlightParentId: null,
      axisLock: null,
    };
  },

  onEnd(_context: DragContext): import('@/shared/types').PendingUpdate[] {
    if (!dragState) return [];

    // New offset = the interacting viewport's EFFECTIVE start offset + drag
    // delta (delta already includes any trigger snap).
    const newOffsetX = dragState.effOffsetX + Math.round(dragState.lastCssDeltaX);
    const newOffsetY = dragState.effOffsetY + Math.round(dragState.lastCssDeltaY);

    // Route the write: primary drag → base config; replica drag → that
    // viewport's responsive override (so each replica owns its own offset).
    // Pass the full breakpoint list so the baked `responsiveBp` keeps
    // owning-viewport resolution correct (a no-override viewport → base).
    queueMutation({
      type: 'updateOverlayConfig',
      overlayId: dragState.overlayId,
      patch: { offsetX: newOffsetX, offsetY: newOffsetY },
      // Component VARIANT drag → per-variant override (keyed by name); page
      // replica drag → per-width override; primary → base.
      vpWidth: dragState.variantKey ? null : (dragState.isPrimaryDrag ? null : dragState.interactingVpWidth),
      variant: dragState.variantKey,
      breakpoints: Object.values(getViewportWidths()),
    });

    trace.action('overlay-drag:end', {
      overlayId: dragState.overlayId,
      isPrimaryDrag: dragState.isPrimaryDrag,
      vpWidth: dragState.interactingVpWidth,
      newOffset: { x: newOffsetX, y: newOffsetY },
    });

    dragState = null;
    resetSnapHysteresis();
    return []; // No style updates — we use mutations instead
  },

  onCancel(): void {
    dragState = null;
    resetSnapHysteresis();
  },
};
