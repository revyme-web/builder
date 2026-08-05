// CanvasDragStrategy.ts — Drag absolute-positioned elements freely on the canvas.
// This is the default strategy when an element has position:absolute or is on the canvas root.
// Handles: multi-select with maintained offsets, snap guides, shift+axis lock.
//
// Per-node containment detection:
// During multi-select drag, EACH node independently detects if it's inside a non-layout frame.
// When confirmed (after grace period), that node is live-reparented into the frame.
// If it later leaves the frame, it's reparented back to canvas root.
// Single-select preserves existing behavior (strategy switch on entry).

import type { Point, PendingUpdate, Rect } from '@/shared/types';
import type { DragContext, DragStrategy, DragMoveResult } from '../types';
import { detectParentLayoutById, getFlexDirectionById } from '../types';
import { getCanvasDelta, getAbsoluteCanvasRectById, getParentCanvasOffsetById } from '@/canvas/canvas-math';
import { calculateSnap, getMouseVelocity } from '../handlers/snap-handler';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import { SNAP_THRESHOLD, nodeAcceptsChildren } from '@/shared/constants';
import { updateNodeStyles, isPrimaryViewport, vpIdFromPrefix, getActiveFilePath, patchNodeStyles, findNodeRect, findNodeComputedStyle, findNodeComputedStyles, findChildRects, getNodeHitsAtPoint, findRootHitAtPoint, forceCanvasRender, getViewportPrefix, parseRectCacheKey, forceCanvasRenderDeferredDuringDrag } from '@/canvas/node-ops';
import { isFullyInsideQuad, cornersFromRect, pointInQuad , matrixHasRotationSkewOrFlip } from '@/canvas/resize/geometry-utils';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { trace } from '@/shared/debug-trace';
import { calculateLayoutInsertIndexById, computeLayoutInsertOrderUpdates, computeLayoutInsertAnchorId, computeReplicaOrderMirrorUpdates, buildDesiredVisualOrder, applyLayoutEdgeMagnet, flexForFlowChildEnteringFlex } from '../reparent-utils';
import { computeEntryParentLocalPosition, computeExitCanvasPosition, traceTransformReparent } from '../transform-reparent';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getIframeOffset, screenPointToCanvas, screenRectToCanvas } from '../helpers/coords';
import { getScreenCornersById } from '@/canvas/resize/geometry-utils';
import { isOverlayNode } from '@/code/parsing/overlay-parser';
import { EntryDetector } from '../entry-detector';
import { isComponentFilePath, isIconSetFilePath } from '@/code/project/active-file-store';
import { getReplicaContext } from '../replica-context';
import { getConsolidationClone, clearConsolidationClone } from '../consolidation-clone-store';
import { getPendingReplicaExtraction, clearPendingReplicaExtraction } from '../pending-replica-extraction-store';
import { commitExitToCanvas, flushExitToCanvas } from '../exit-commit';
import { buildCanvasCloneDescriptor } from '../clone-descriptor';
import { queueBorderOverlayDuplicates, queueReplicaCreationUnhide } from '@/canvas/creators/creator-utils';
import { commitOrderAssignments } from './order-commit';
import { queueMutation, flushNow, flushNowDeferredDuringDrag, getCurrentCode } from '@/code/mutation/mutation-queue';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { moveNodeInCache, updateNodeInCache, getNodeFromCache, seedNodesForCode } from '@/code/stores/store';
import { containerOverridesAtom, getOverridesAtWidth } from '@/code/stores/container-query-store';
import { getDefaultStore } from 'jotai';



/** Inward margin (px) for entry detection — element center must be this far inside the frame */
const ENTRY_MARGIN = 10;

/**
 * True iff the computed CSS `transform` value represents a non-identity
 * transform. Empty / unset / 'none' / 'matrix(1, 0, 0, 1, 0, 0)' all count
 * as identity (no quad-vs-AABB difference to worry about).
 */
function hasNonIdentityTransform(transform: string | null | undefined): boolean {
  if (!transform) return false;
  const t = transform.trim();
  if (!t || t === 'none') return false;
  // Exact identity matrix: no rotation, scale=1, no translate.
  if (t === 'matrix(1, 0, 0, 1, 0, 0)' || t === 'matrix(1,0,0,1,0,0)') return false;
  return true;
}

/**
 * Project a canvas-space drag delta into the parent's LOCAL frame by
 * passing it through the inverse of the parent's CSS transform. This is
 * the same projection AbsoluteInFrameStrategy does each onMove tick — used
 * here when commit-to-parent fires per-node so the post-reparent
 * `startLeft` matches the next frame's parent-local delta.
 *
 * Returns the input unchanged when the parent has no (or identity)
 * transform — same fast-path the runtime cache uses.
 */
function projectDeltaToParentLocal(
  dx: number, dy: number, parentId: string, vpId: string,
): { dx: number; dy: number } {
  const transform = findNodeComputedStyle(parentId, vpId, 'transform');
  if (!hasNonIdentityTransform(transform)) return { dx, dy };
  const m = new DOMMatrix(transform);
  const inv = m.inverse();
  const local = new DOMPoint(dx, dy).matrixTransform(inv);
  return { dx: local.x, dy: local.y };
}

/** Number of consecutive frames inside a new parent before entry is confirmed (grace period) */
const ENTRY_GRACE_FRAMES = 3;

/** True when a drag hit lands on (or inside) a component INSTANCE — the
 *  instance node itself, OR one of its expanded internals (id `instanceId:…`,
 *  single colon; the `layout::` double-colon chrome is filtered upstream).
 *  An instance can NEVER accept a page-level drop: its content is owned by the
 *  master file, so inserting a canvas node into the expanded subtree would
 *  corrupt the page. Covers design components (`componentFile` /
 *  `isComponentInstance`), code/Code components (`isCodeComponent`), and
 *  icon-set instances (`componentFile`). */
function hitIsOverComponentInstance(hitId: string, nodes: DragContext['nodes']): boolean {
  const isInst = (n: any): boolean =>
    !!n && (!!n.componentFile || n.isComponentInstance === true || n.isCodeComponent === true);
  // An ABSOLUTE / FIXED instance is an out-of-flow OVERLAY (e.g. a GradientAura
  // covering its parent). It must NOT block the drop — the drop should see
  // THROUGH it to the in-flow container behind. (The caller then skips the
  // instance via canAcceptChildren and falls to the next hit.) Only IN-FLOW
  // instances block, where "drop into the master's content" would be ambiguous.
  const isOutOfFlow = (n: any): boolean => {
    const p = n?.styles?.position;
    return p === 'absolute' || p === 'fixed';
  };
  const direct = nodes.get(hitId);
  if (isInst(direct)) return !isOutOfFlow(direct);
  const colon = hitId.indexOf(':');
  if (colon > 0) {
    const outer = nodes.get(hitId.slice(0, colon));
    if (isInst(outer)) return !isOutOfFlow(outer);
  }
  return false;
}

/** The OUTERMOST instance WRAPPER node id for a hit that is (or is inside) a
 *  component instance. The wrapper is the node with `componentFile` and NO
 *  `componentInstanceId` (LayersPanel's isComponentInstance definition) — an
 *  EXPANDED root (`inst:rootId`) also carries componentFile, so naively
 *  treating the first instance-ish node as the wrapper resolved its parent to
 *  the wrapper ITSELF and put the drop-line INSIDE the instance (between the
 *  master's internal children — user report 2026-08-05 round 2). Climb the
 *  parent chain until the true wrapper; null when the hit isn't
 *  instance-related. */
function instanceWrapperIdForHit(hitId: string, nodes: DragContext['nodes']): string | null {
  // Seed: the hit itself, or the colon form's outer id (`inst:internal`).
  const colon = hitId.indexOf(':');
  let curId: string | null | undefined = nodes.has(hitId)
    ? hitId
    : (colon > 0 && nodes.get(hitId.slice(0, colon)) ? hitId.slice(0, colon) : null);
  const seen = new Set<string>();
  while (curId && !seen.has(curId)) {
    const n: any = nodes.get(curId);
    if (!n) return null;
    if (n.componentFile && !n.componentInstanceId) return curId; // the real wrapper
    if (!n.componentInstanceId && !n.componentFile && n.isCodeComponent !== true) return null; // left instance territory without finding one
    seen.add(curId);
    curId = n.parentId;
  }
  return null;
}

/** Per-node reparent tracking — whether a node has been live-reparented into its confirmed parent */
interface NodeReparentState {
  reparented: boolean;
  confirmedParentId: string | null;
  confirmedParentEl: HTMLElement | null;
}

export class CanvasDragStrategy implements DragStrategy {
  readonly name = 'canvas';

  /** Previous mouse position (for velocity calculation) */
  private prevMouse: Point = { x: 0, y: 0 };

  /** Axis lock direction (detected from first significant movement) */
  private lockedAxis: 'x' | 'y' | null = null;

  /** Whether axis lock has been determined */
  private axisLockDetermined = false;

  /** Last computed positions per node (for onEnd — don't rely on DOM which may be rebuilt) */
  private lastPositions: Map<string, { left: number; top: number }> = new Map();

  /**
   * The dragged element's CURRENT screen rect derived from the position this
   * strategy WROTE this frame (`lastPositions`, canvas-space css — includes
   * snap), instead of the bridge rect cache, which lags the sandbox's RAF by
   * a frame. Entry anchoring on the stale cache while the strategy switch
   * re-baselines startMouse to NOW froze that lag in permanently — the node
   * landed a step behind the cursor on fast drags (the residual after the
   * translated-parent fix, 2026-07-30). Only for children WITHOUT an own
   * authored transform: for those, layout TL == AABB TL; a rotated child's
   * AABB differs and keeps the cached-rect path. Size comes from the cache
   * (it doesn't change mid-drag).
   */
  private mouseSyncedRect(
    nodeId: string,
    cached: ReturnType<typeof findNodeRect>,
    context: DragContext,
  ): ReturnType<typeof findNodeRect> {
    if (!cached) return cached;
    if ((this.originalTransforms.get(nodeId) ?? '') !== '') return cached;
    const lp = this.lastPositions.get(nodeId);
    if (!lp) return cached;
    // `lastPositions` is in the node's CURRENT parent's coordinate space:
    // canvas-root css for top-level nodes, PARENT-LOCAL after a per-node
    // live reparent (the entry rebases startLeft/startTop). Converting a
    // parent-local value with the root-space math below projected the rect
    // one whole parent-offset away — the exit detector then saw the
    // just-entered node "outside" its parent and the multi-drag flapped
    // enter→exit→enter at ~14Hz, queueing a move + mid-drag render per
    // cycle (the oscillation report, 2026-08-05). Parent-local values get
    // the parent's screen origin added; a transformed parent falls back to
    // the cached bridge rect (fresh to ~1 frame — every per-frame patch
    // emits a rectUpdate).
    const rState = this.nodeReparentStates.get(nodeId);
    if (rState?.reparented && rState.confirmedParentId) {
      const vpId = vpIdFromPrefix(context.viewportPrefix);
      if (hasNonIdentityTransform(findNodeComputedStyle(rState.confirmedParentId, vpId, 'transform'))) {
        return cached;
      }
      const parentRect = findNodeRect(rState.confirmedParentId, vpId);
      if (!parentRect) return cached;
      const left = parentRect.left + lp.left * context.transform.scale;
      const top = parentRect.top + lp.top * context.transform.scale;
      return {
        left, top,
        x: left, y: top,
        width: cached.width,
        height: cached.height,
        right: left + cached.width,
        bottom: top + cached.height,
      } as ReturnType<typeof findNodeRect>;
    }
    const off = getIframeOffset();
    const left = lp.left * context.transform.scale + context.transform.x + off.x;
    const top = lp.top * context.transform.scale + context.transform.y + off.y;
    // Explicit fields — NEVER `{...cached}`: DOMRect properties live on the
    // PROTOTYPE, so spreading one yields an empty object (width/height
    // undefined → NaN anchors → the entry commit wrote `left: NaN`).
    return {
      left, top,
      x: left, y: top,
      width: cached.width,
      height: cached.height,
      right: left + cached.width,
      bottom: top + cached.height,
    } as ReturnType<typeof findNodeRect>;
  }

  /** Trace flag — emit a detailed payload on the first onMove tick after a
   *  fresh start or strategy switch, so we can see the math state going in. */
  private firstMoveTraced = false;
  private firstWriteTraced = false;

  // ─── Single-select entry state (preserved for backward compat) ──────────
  // Used only when draggedNodes.length === 1.

  /** ID of the frame the element has entered (null = still on canvas root) */
  private enteredParentId: string | null = null;
  private enteredParentEl: HTMLElement | null = null;
  private enteredVpId: string = 'desktop';
  private framesInCandidateParent = 0;
  private candidateParentId: string | null = null;
  private entryConfirmed = false;
  private liveReparented = false;
  private enteredInsertIndex = -1;
  /** Viewport the mouse is currently hovering over (for parent highlight targeting) */
  private lastHoverVpId: string | undefined;
  /** True when drop line is showing — suppresses parent highlight (mutually exclusive) */
  private dropLineActive = false;
  /**
   * Variant tiles this gesture hid IMPERATIVELY, `${nodeId}|${vpPrefix}` → the
   * `display` to restore. See `mirrorVariantSoloHideLive` for why the code write
   * alone isn't enough mid-drag.
   */
  private liveVariantHides = new Map<string, string>();

  // ─── Multi-select per-node entry state ──────────────────────────────────

  /** Unified entry detection for multi-select (grace period + confirmation) */
  private multiEntryDetector: EntryDetector | null = null;
  /** Per-node reparent tracking (whether element has been live-reparented) */
  private nodeReparentStates: Map<string, NodeReparentState> = new Map();

  /** Lift-time canvas-space corners — snapshot in onStart, shifted by total
   *  drag delta in onMove. Required for transform-aware snap on rotated
   *  elements: the bridge's cornersCache updates after each patchStyles, so
   *  using it directly + cumulative delta would double-count the prior frames. */
  private liftCorners: Map<string, import('../handlers/snap-handler').ScreenCorners> = new Map();

  /** Lift-time CSS `transform` value per node (the `style.transform`
   *  attribute, NOT the computed matrix — preserves the user's original
   *  function form like `rotate(45deg) scale(2)`). Per-frame writes prepend
   *  `translate(dx, dy) ` to this string so the visual offset uses the
   *  compositor (no layout per frame). On reparent / mouseup we re-commit
   *  this string verbatim alongside the new left/top so the element keeps
   *  its rotation / scale / etc. Empty string for nodes with no original
   *  transform. */
  private originalTransforms: Map<string, string> = new Map();

  /** Per-node "committed" inline left/top — the position the element's
   *  CSS `left` / `top` actually has in the DOM/JSX. Set at lift to the
   *  lift position, updated on reparent to the new parent-local position.
   *  Per-frame translate is computed as `nodeLeft - committedLeft`, NOT
   *  `nodeLeft - node.startLeft`, because `node.startLeft` is mutated on
   *  reparent for the next-frame math to work, while the element's actual
   *  CSS left only changes at commit moments. Without this, after reparent
   *  in multi-drag the translate kept building cumulatively from lift and
   *  the element jumped by the lift→reparent travel distance every frame. */
  private committedPos: Map<string, { left: number; top: number }> = new Map();

  canHandle(context: DragContext): boolean {
    const firstNode = context.draggedNodes[0];
    if (!firstNode) return false;

    // Canvas nodes are always free-floating absolute elements
    const nodeData = context.nodes.get(firstNode.id);
    if (nodeData?.isCanvasNode) return true;

    const position = nodeData?.styles?.position || 'absolute';
    return position === 'absolute' || position === 'fixed' || !firstNode.startParentId;
  }

  onStart(context: DragContext): void {
    this.prevMouse = context.startMouse;
    this.lockedAxis = null;
    this.axisLockDetermined = false;
    this.lastPositions.clear();
    this.firstMoveTraced = false;
    this.firstWriteTraced = false;
    const p = context.draggedNodes[0];
    trace.action('canvas-drag:onStart', {
      startMouse: context.startMouse,
      transform: { x: context.transform.x, y: context.transform.y, scale: context.transform.scale },
      primary: p ? {
        id: p.id, startLeft: p.startLeft, startTop: p.startTop,
        startParentId: p.startParentId, mouseOffsetX: p.mouseOffsetX, mouseOffsetY: p.mouseOffsetY,
        width: p.width, height: p.height,
      } : null,
    });

    // Single-select state
    this.enteredParentId = null;
    this.enteredParentEl = null;
    this.framesInCandidateParent = 0;
    this.candidateParentId = null;
    this.entryConfirmed = false;
    this.liveReparented = false;
    this.enteredInsertIndex = -1;

    // Multi-select state
    this.multiEntryDetector = new EntryDetector(
      context.draggedNodes.map(n => n.id),
      ENTRY_GRACE_FRAMES,
    );
    this.nodeReparentStates.clear();
    this.originalTransforms.clear();
    this.committedPos.clear();
    for (const node of context.draggedNodes) {
      this.nodeReparentStates.set(node.id, { reparented: false, confirmedParentId: null, confirmedParentEl: null });
      // Snapshot the user's pre-drag inline transform so per-frame writes
      // can prepend `translate(dx, dy) ` without losing rotation / scale.
      //
      // When the receiving end of a strategy switch (e.g. exit from
      // AbsoluteInFrame to canvas), prefer `node.transformOverride`:
      // the exiting strategy stripped translates from the source
      // transform but `context.nodes` may not have re-parsed the
      // committed mutation yet. Without the override, the snapshot
      // would still carry the stale source translate and per-frame
      // writes would re-compose it on top of the just-stripped css —
      // shifting the element by W/2 on the next move.
      const nodeData = context.nodes.get(node.id);
      const t = typeof node.transformOverride === 'string'
        ? node.transformOverride
        : (nodeData?.styles?.transform || '').trim();
      this.originalTransforms.set(node.id, t === 'none' ? '' : t);
      // Commit baseline: at lift, the inline left/top equals startLeft/Top.
      this.committedPos.set(node.id, { left: node.startLeft, top: node.startTop });
      // PAINT-PERF: promote each dragged node to its own compositor layer for the duration of the drag.
      // The per-frame work in onMove is tiny (the trace shows only cached corner reads), yet a canvas-node
      // drag on a TEMPLATE runs at single-digit FPS while a normal page stays smooth — because WITHOUT a
      // layer the browser REPAINTS the region under the moving node every frame, and a template's content
      // (3 viewports × background-image + gradient + `backgroundBlendMode` + the Header) is paint-heavy.
      // `will-change: transform` isolates the node so its per-frame transform updates COMPOSITE, not repaint.
      // Element count is irrelevant — paint complexity is — which is exactly the reported symptom. Cleared in
      // onEnd/onCancel. DOM-only (never written to code).
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { willChange: 'transform' });
    }

    // Snapshot lift-time corners in canvas-space — used to project current
    // dragCorners on each onMove frame (lift-time corners + cumulative delta).
    const startVpId = vpIdFromPrefix(context.viewportPrefix);
    const lcOffset = getIframeOffset();
    const lcToCanvas = (p: { x: number; y: number }) => screenPointToCanvas(p, context.transform, lcOffset);
    this.liftCorners.clear();
    for (const node of context.draggedNodes) {
      const c = getScreenCornersById(node.id, startVpId);
      if (c) {
        this.liftCorners.set(node.id, {
          TL: lcToCanvas(c.TL), TR: lcToCanvas(c.TR),
          BR: lcToCanvas(c.BR), BL: lcToCanvas(c.BL),
        });
      }
    }
  }

  onMove(context: DragContext, mouseScreen: Point): DragMoveResult {
    const { draggedNodes, startMouse, transform, contentEl } = context;
    const isMultiSelect = draggedNodes.length > 1;

    // Canvas-space delta from drag start
    const screenDx = mouseScreen.x - startMouse.x;
    const screenDy = mouseScreen.y - startMouse.y;
    const delta = getCanvasDelta(screenDx, screenDy, transform.scale);

    if (!this.firstMoveTraced) {
      this.firstMoveTraced = true;
      const p = draggedNodes[0];
      trace.action('canvas-drag:first-onMove-after-switch', {
        mouseScreen,
        startMouse,
        screenDelta: { x: screenDx, y: screenDy },
        canvasDelta: delta,
        transformX: transform.x, transformY: transform.y, scale: transform.scale,
        primary: p ? {
          id: p.id, startLeft: p.startLeft, startTop: p.startTop,
          startParentId: p.startParentId, mouseOffsetX: p.mouseOffsetX, mouseOffsetY: p.mouseOffsetY,
          width: p.width, height: p.height,
        } : null,
      });

      // Synthesize AABB lift corners — ONLY when the cached corners
      // are STALE from a strategy switch (user dragged out of a
      // rotated parent into canvas). Detection: the element's own
      // computed `transform` is empty/identity, but the cached
      // corners look rotated. That's the post-exit case — the
      // element is axis-aligned in canvas space but cornersCache
      // still holds the pre-exit rotated quad.
      //
      // CRITICAL: do NOT synthesize unconditionally. For canvas
      // nodes with their OWN `transform: rotate(...)` etc., the
      // cached corners are correct (the freshly-grabbed sample IS
      // the real rotated quad). Synthesizing AABB in that case
      // wipes the rotation info and the snap engine starts
      // computing snaps against a fictional axis-aligned dragged
      // element while the rendered element is still rotated — the
      // visible breakage the user just reported.
      const startVpId = vpIdFromPrefix(context.viewportPrefix);
      for (const node of draggedNodes) {
        // Element's OWN transform on canvas. Empty / 'none' /
        // identity means the element is axis-aligned by itself.
        const ownTransform = findNodeComputedStyle(node.id, startVpId, 'transform') || '';
        let hasOwnRotationOrSkew = false;
        if (ownTransform && ownTransform !== 'none') {
          try {
            const m = new DOMMatrix(ownTransform);
            hasOwnRotationOrSkew = matrixHasRotationSkewOrFlip(m);
          } catch { /* identity */ }
        }

        // Inspect the cached corners we'd use otherwise.
        const cached = this.liftCorners.get(node.id);
        const cornersLookRotated = !!cached && (
          Math.abs(cached.TL.y - cached.TR.y) > 0.5 ||
          Math.abs(cached.BL.y - cached.BR.y) > 0.5 ||
          Math.abs(cached.TL.x - cached.BL.x) > 0.5 ||
          Math.abs(cached.TR.x - cached.BR.x) > 0.5
        );

        // The post-exit stale-cache case: cache says rotated, but
        // the element itself has no rotation. Synthesize axis-
        // aligned AABB from the now-correct width/height (already
        // pushed in via the switchRequest's nodeStateOverrides).
        if (cornersLookRotated && !hasOwnRotationOrSkew) {
          const cssW = node.width / transform.scale;
          const cssH = node.height / transform.scale;
          this.liftCorners.set(node.id, {
            TL: { x: node.startLeft,        y: node.startTop        },
            TR: { x: node.startLeft + cssW, y: node.startTop        },
            BR: { x: node.startLeft + cssW, y: node.startTop + cssH },
            BL: { x: node.startLeft,        y: node.startTop + cssH },
          });
          trace.action('canvas-drag:lift-corners-synthesized', {
            nodeId: node.id,
            reason: 'post-exit-stale-cache',
          });
        }
        // else: element has its own rotation OR cached corners are
        // already axis-aligned. In both cases the cached corners
        // captured in onStart are correct — keep them as-is.
      }
    }

    // Shift+drag: lock to axis
    let dx = delta.x;
    let dy = delta.y;

    if (context.modifiers.shift) {
      if (!this.axisLockDetermined && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        this.lockedAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        this.axisLockDetermined = true;
      }
      if (this.lockedAxis === 'x') dy = 0;
      if (this.lockedAxis === 'y') dx = 0;
    } else {
      this.lockedAxis = null;
      this.axisLockDetermined = false;
    }

    // Primary dragged node
    const primary = draggedNodes[0];

    // Parent's absolute canvas offset (converts parent-relative <-> absolute canvas)
    const vpId = vpIdFromPrefix(context.viewportPrefix);
    const parentOffset = primary.startParentId
      ? getParentCanvasOffsetById(primary.startParentId, vpId, transform)
      : { x: 0, y: 0 };
    const parentOffsetX = parentOffset.x;
    const parentOffsetY = parentOffset.y;

    // Snap: collect sibling rects via bridge for snap guide calculation.
    const draggedIds = new Set(draggedNodes.map(n => n.id));
    const siblingRects: { id: string; rect: Rect }[] = [];
    // Map sibling.id → its actual (dataId, vpPrefix) so the corners
    // lookup later can fetch the correct cached painting. Only populated
    // by the top-level branch where multiple paintings of the same dataId
    // can coexist; the parent-children branch uses one viewport at a time
    // and doesn't need this disambiguation.
    const siblingPrefixById = new Map<string, { dataId: string; vpPrefix: string }>();
    const snapParentId = primary.startParentId;
    if (snapParentId) {
      const childRects = findChildRects(snapParentId, vpId);
      for (const child of childRects) {
        if (draggedIds.has(child.id)) continue;
        const absRect = getAbsoluteCanvasRectById(child.id, vpId, transform);
        if (absRect) siblingRects.push({ id: child.id, rect: absRect });
      }
    } else {
      // Top-level drag (canvas-node OR variant root). Treat every
      // parentless cache entry as a potential snap target — agnostic to
      // whether it's a "canvas node", a "variant root", or another
      // viewport's painting of the same master node. The only thing we
      // exclude is the dragged element's OWN cache entry (same prefix +
      // same dataId).
      //
      // We also remember each sibling's source viewport prefix so the
      // corners-cache lookup below can fetch the RIGHT painting's corners.
      // Without that mapping, the corners loop reused the dragged's vpId
      // for every sibling — causing same-dataId siblings (a default
      // viewport's painting of the master while dragging the variant-1
      // painting) to load the DRAGGED element's corners as the sibling's,
      // producing a permanent self-snap.
      const bridge = getCanvasBridge() as any;
      const cache = bridge.rectCache as Map<string, DOMRect> | undefined;
      const t = transform;
      const offset = getIframeOffset();
      const toCanvas = (r: DOMRect): Rect => screenRectToCanvas(r, t, offset);
      const draggedPrefix = context.viewportPrefix;
      // Container-set masters (icon-set): variant
      // containers are children of `root` (parentId === 'root') but
      // visually sit at the SAME top level as canvas nodes — the user
      // expects to snap a free shape against a variant card and vice
      // versa. Loosen the "no parent" filter on these masters: also
      // accept direct children of root.
      const apForSnap = getActiveFilePath();
      const isContainerMasterForSnap = isIconSetFilePath(apForSnap);
      if (cache) {
        for (const key of cache.keys()) {
          const parsed = parseRectCacheKey(key);
          if (!parsed) continue;
          const { vpPrefix: prefix, nodeId: dataId } = parsed;
          if (prefix === draggedPrefix && draggedIds.has(dataId)) continue;
          const otherNode = context.nodes.get(dataId);
          if (!otherNode) continue;
          // Top-level on the master canvas means EITHER no parent
          // (regular canvas-node) OR a direct child of master root
          // (a variant container). Anything deeper (e.g. shapes
          // inside a vector) is excluded — those are inner content,
          // not peers.
          const isTopLevel = !otherNode.parentId
            || (isContainerMasterForSnap && otherNode.parentId === 'root');
          if (!isTopLevel) continue;
          const screenRect = bridge.getRect(dataId, prefix);
          if (!screenRect) continue;
          const id = `${prefix}${dataId}`;
          siblingRects.push({ id, rect: toCanvas(screenRect) });
          siblingPrefixById.set(id, { dataId, vpPrefix: prefix });
        }
      }
      trace.fn('canvas-drag:top-level-snap-siblings', {
        draggedPrefix,
        draggedIds: [...draggedIds],
        siblingCount: siblingRects.length,
        siblings: siblingRects.map(s => ({ id: s.id, l: Math.round(s.rect.left), t: Math.round(s.rect.top), w: Math.round(s.rect.width), h: Math.round(s.rect.height) })),
      });
    }

    // Overlays are portal-rendered siblings — never a valid snap target.
    for (let i = siblingRects.length - 1; i >= 0; i--) {
      if (isOverlayNode(context.nodes.get(siblingRects[i].id))) siblingRects.splice(i, 1);
    }

    // Calculate new position (parent-relative)
    const newLeft = Math.round(primary.startLeft + dx);
    const newTop = Math.round(primary.startTop + dy);

    // Snap in ABSOLUTE canvas space (matches sibling rects and guide rendering).
    // primary.width/height come from findNodeRect → SCREEN pixels (post-zoom).
    // Sibling rects come from getAbsoluteCanvasRectById → CSS pixels.
    // Without this divide, dragRight = left + screenWidth lands in the wrong
    // coordinate space and right/bottom edge snaps never match.
    const dragCssWidth = primary.width / transform.scale;
    const dragCssHeight = primary.height / transform.scale;
    const draggedRect: Rect = {
      left: parentOffsetX + newLeft,
      top: parentOffsetY + newTop,
      width: dragCssWidth,
      height: dragCssHeight,
    };

    const velocity = getMouseVelocity(this.prevMouse, mouseScreen);

    // Transform-aware: collect screen corners for the dragged element + siblings
    // so rotated/skewed elements snap by their visual corners (not just AABB).
    // Convert screen corners → canvas-space (matching draggedRect/siblingRects).
    const bridge = getCanvasBridge();
    const iframeOffset = getIframeOffset();
    const toCanvas = (p: { x: number; y: number }) => screenPointToCanvas(p, context.transform, iframeOffset);
    let dragCorners: import('../handlers/snap-handler').ScreenCorners | null = null;
    const liftedC = this.liftCorners.get(primary.id);
    if (liftedC) {
      // Lift-time corners (canvas-space, captured once in onStart) shifted by
      // the cumulative drag delta. Translation is rotation-agnostic, so this
      // gives accurate projected corner positions for rotated/skewed elements.
      const dxCss = newLeft - primary.startLeft;
      const dyCss = newTop - primary.startTop;
      dragCorners = {
        TL: { x: liftedC.TL.x + dxCss, y: liftedC.TL.y + dyCss },
        TR: { x: liftedC.TR.x + dxCss, y: liftedC.TR.y + dyCss },
        BR: { x: liftedC.BR.x + dxCss, y: liftedC.BR.y + dyCss },
        BL: { x: liftedC.BL.x + dxCss, y: liftedC.BL.y + dyCss },
      };
    }
    const siblingCorners = new Map<string, import('../handlers/snap-handler').ScreenCorners>();
    for (const sib of siblingRects) {
      // For top-level siblings the "id" includes the viewport prefix
      // (e.g. `variant-1-frame-foo`), and `siblingPrefixById` maps it back
      // to the real (dataId, vpPrefix) pair. Use those when reading
      // cached corners — the bridge's corner cache is keyed by
      // `${vpPrefix}:${dataId}`, so passing the dragged's vpId would
      // produce the WRONG painting's corners (the dragged element's own,
      // creating a permanent self-snap on every drag tick).
      const meta = siblingPrefixById.get(sib.id);
      let c: { TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } } | null = null;
      if (meta && 'getCachedCorners' in bridge) {
        const cached = (bridge as any).getCachedCorners(meta.dataId, meta.vpPrefix);
        if (cached) c = cached;
      }
      if (!c) {
        // Fallback: the parent-children branch (no prefix tracking) or a
        // sibling without cached corners — derive AABB corners from its
        // canvas-space rect we already have.
        const r = sib.rect;
        const screenLeft = r.left * context.transform.scale + context.transform.x + iframeOffset.x;
        const screenTop = r.top * context.transform.scale + context.transform.y + iframeOffset.y;
        const screenWidth = r.width * context.transform.scale;
        const screenHeight = r.height * context.transform.scale;
        c = {
          TL: { x: screenLeft, y: screenTop },
          TR: { x: screenLeft + screenWidth, y: screenTop },
          BR: { x: screenLeft + screenWidth, y: screenTop + screenHeight },
          BL: { x: screenLeft, y: screenTop + screenHeight },
        };
      }
      siblingCorners.set(sib.id, {
        TL: toCanvas(c.TL), TR: toCanvas(c.TR), BR: toCanvas(c.BR), BL: toCanvas(c.BL),
      });
    }

    const snap = calculateSnap(
      draggedRect,
      siblingRects,
      velocity,
      SNAP_THRESHOLD / context.transform.scale,
      dragCorners,
      siblingCorners,
      getActiveRulerGuideSnapLines(),
    );
    this.prevMouse = mouseScreen;

    // Convert snapped absolute positions back to parent-relative for style.left/top
    const finalAbsLeft = snap.snappedX ? snap.x : draggedRect.left;
    const finalAbsTop = snap.snappedY ? snap.y : draggedRect.top;
    const finalRelLeft = finalAbsLeft - parentOffsetX;
    const finalRelTop = finalAbsTop - parentOffsetY;
    const snapOffsetX = finalRelLeft - newLeft;
    const snapOffsetY = finalRelTop - newTop;

    // Per-frame cache of parent-transform inverses. Multi-drag with each
    // node potentially in a different parent + same parent appearing on
    // many nodes ⇒ do this once per parent per frame, not per node.
    // `false` = parent has no meaningful transform (cache the negative
    // result so we don't re-bridge-call). `null` = not yet computed.
    const parentDeltaCache = new Map<string, DOMMatrix | false>();
    const writeVpId = vpIdFromPrefix(context.viewportPrefix);
    const projectDelta = (parentId: string | null): { dx: number; dy: number } => {
      // Outside any parent → canvas-space delta (no rotation to undo).
      if (!parentId) return { dx, dy };
      let cached = parentDeltaCache.get(parentId);
      if (cached === undefined) {
        const t = findNodeComputedStyle(parentId, writeVpId, 'transform');
        if (!t || t === 'none') {
          parentDeltaCache.set(parentId, false);
          cached = false;
        } else {
          const m = new DOMMatrix(t);
          const isId = Math.abs(m.b) < 1e-3 && Math.abs(m.c) < 1e-3 &&
                       Math.abs(m.a - 1) < 1e-3 && Math.abs(m.d - 1) < 1e-3;
          if (isId) { parentDeltaCache.set(parentId, false); cached = false; }
          else { parentDeltaCache.set(parentId, m.inverse()); cached = m.inverse(); }
        }
      }
      if (cached === false) return { dx, dy };
      const p = new DOMPoint(dx, dy).matrixTransform(cached);
      return { dx: p.x, dy: p.y };
    };

    for (const node of draggedNodes) {
      // Project the canvas-space delta into the node's PARENT's local
      // frame, so dragging the mouse "right" moves the element along the
      // parent's local +x axis — even when the parent is rotated. Without
      // this, dragging in a rotated multi-select scenario produced the
      // "drag up goes right" disorientation. Single-drag had the same
      // logic in AbsoluteInFrameStrategy.onMove (lines 173-180); this is
      // the per-node port for multi-drag where strategy stays as Canvas.
      const rState = this.nodeReparentStates.get(node.id);
      const parentForNode = rState?.reparented ? rState.confirmedParentId : node.startParentId;
      const local = projectDelta(parentForNode);

      const nodeLeft = Math.round(node.startLeft + local.dx + snapOffsetX);
      const nodeTop = Math.round(node.startTop + local.dy + snapOffsetY);

      // Per-frame translate write — compositor-only, no layout pass.
      // The element's `left`/`top` stay at the most recent COMMITTED value
      // (lift baseline OR new parent-local left after a reparent commit);
      // the visual offset comes from this CSS `transform`. The translate
      // amount is `nodeLeft - committedLeft` so on the frame after a
      // reparent commit it starts at 0 and grows incrementally, instead of
      // re-applying the entire lift→reparent cumulative travel.
      // The translate is PREPENDED so it's applied AFTER the element's
      // own existing transform, giving us a screen-space translation
      // regardless of any rotation/scale on the element itself.
      const committed = this.committedPos.get(node.id) || { left: node.startLeft, top: node.startTop };
      const tx = nodeLeft - committed.left;
      const ty = nodeTop - committed.top;
      const orig = this.originalTransforms.get(node.id) ?? '';
      const transform = `translate(${tx}px, ${ty}px)${orig ? ' ' + orig : ''}`;

      if (!this.firstWriteTraced) {
        this.firstWriteTraced = true;
        trace.action('canvas-drag:first-write-after-switch', {
          nodeId: node.id,
          startLeft: node.startLeft, startTop: node.startTop,
          dx, dy, localDx: local.dx, localDy: local.dy,
          snapOffsetX, snapOffsetY,
          newLeft: nodeLeft, newTop: nodeTop,
          parentId: parentForNode,
          mode: 'translate', orig,
        });
      }

      // Patch via bridge (sends postMessage to sandbox iframe)
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform });

      // Mirror live transform to all viewports (DOM-only — no cache/mutation queue).
      //
      // Skip for top-level roots on a component master file: each variant
      // viewport renders the SAME source root at its OWN canvas position
      // (`variantConfig[*].x/y` → `rootEl.style.left/top` in the Renderer).
      // Mirroring the dragged primary's transform onto every variant root
      // drags them all in lockstep across the canvas — exactly the bug the
      // user reported ("dragging the primary moves all the others"). The
      // bridge patch above already applied the transform to the dragged
      // viewport's specific element; the other variants must stay put.
      //
      // The check has to allow the mirror in two normal cases:
      //   - page files (replica viewports DO share canvas position; mirror
      //     gives instant visual feedback on tablet/mobile during a primary
      //     drag).
      //   - non-root nodes on component masters (children of the variant
      //     root that share position across variant viewports — those still
      //     mirror because each variant viewport paints them at the same
      //     parent-local coords).
      const isCompMasterRoot = isComponentFilePath(getActiveFilePath()) && node.startParentId === null;
      if (!isCompMasterRoot) {
        updateNodeStyles({ id: node.id, styles: { transform }, contentEl: context.contentEl, domOnly: true });
      }

      this.lastPositions.set(node.id, { left: nodeLeft, top: nodeTop });
    }

    if (snap.snappedX || snap.snappedY || snap.spacingGuides.length > 0) {
      trace.action('snap:result', {
        snappedX: snap.snappedX, snappedY: snap.snappedY,
        guides: snap.guides.length, spacingGuides: snap.spacingGuides.length,
      });
    }

    // ─── Parent entry detection ───
    if (isMultiSelect) {
      this.detectPerNodeContainment(context, draggedIds, dx, dy, snapOffsetX, snapOffsetY, mouseScreen);
    } else {
      const result = this.detectSingleNodeContainment(context, draggedIds, mouseScreen, snap);
      if (result) return result;
    }

    // Parent highlight and drop line are mutually exclusive:
    // - Drop line visible (has children) → no parent highlight
    // - No drop line (empty container or non-layout) → show parent highlight
    //
    // Caveat: during the ENTRY_GRACE_FRAMES window after a candidate
    // change, `dropLineActive` is still false (entry not yet confirmed)
    // but `candidateParentId` is already pointing at the new target.
    // Without the suppression below, every magnet promotion → root
    // would briefly flash the viewport's highlight outline for 5
    // frames before the drop-line replaces it. Suppress the highlight
    // when the candidate is a layout container that has children — it
    // WILL switch to a drop-line on confirmation, so showing a
    // highlight in the meantime is just a visual stutter.
    const candidateForHighlight = this.enteredParentId ?? this.candidateParentId ?? null;
    let highlightId: string | null = this.dropLineActive ? null : candidateForHighlight;
    if (!this.dropLineActive && this.candidateParentId && !this.entryConfirmed) {
      const candidateVpId = this.lastHoverVpId || vpIdFromPrefix(context.viewportPrefix);
      const candidateLayout = detectParentLayoutById(this.candidateParentId, candidateVpId);
      if (candidateLayout === 'flex' || candidateLayout === 'grid') {
        const hasChildren = findChildRects(this.candidateParentId, candidateVpId)
          .some(c => !draggedIds.has(c.id));
        if (hasChildren) highlightId = null;
      }
    }

    return {
      // Suppress snap guides when drop line is active (layout insertion mode)
      snap: this.dropLineActive ? null : snap,
      dropTarget: null,
      highlightParentId: highlightId,
      highlightVpId: this.lastHoverVpId,
      axisLock: this.lockedAxis,
    };
  }

  // ─── Multi-select: per-node containment detection ─────────────────────────
  //
  // Bridge-aware port of canvas-dnd's UniversalDragStrategy multi-drag flow.
  // Each dragged node has its OWN entry/exit ecosystem — separate hit-test
  // at the node's center, separate grace period, separate reparent commit
  // when confirmed. Two nodes dragged together can land in two different
  // parents (or one in a parent and one on canvas) depending on each one's
  // independent geometry against the candidates under it.
  //
  // The previous implementation read parent-frame DOM (querySelectorAll +
  // getBoundingClientRect + appendChild). That doesn't work in iframe mode
  // since the canvas elements live INSIDE the iframe — `contentEl` is empty
  // and `getNodeEl` returns null, so multi-select drag silently no-op'd.

  private detectPerNodeContainment(
    context: DragContext,
    draggedIds: Set<string>,
    dx: number, dy: number,
    snapOffsetX: number, snapOffsetY: number,
    mouseScreen: Point,
  ): void {
    const { draggedNodes, nodes } = context;
    const startVpId = vpIdFromPrefix(context.viewportPrefix);

    // Skip ids: dragged elements + their descendants.
    const skipIds = new Set(draggedIds);
    const collectDescendants = (id: string) => {
      const n = nodes.get(id);
      if (!n) return;
      for (const childId of n.children) { skipIds.add(childId); collectDescendants(childId); }
    };
    for (const id of draggedIds) collectDescendants(id);

    // Track the viewport the cursor is over (used for hit-test resolution
    // and matched against the bridge cache prefix). Bridge-aware port of
    // detectSingleNodeContainment's hover resolution — the old
    // `getViewportAtMouse` read parent-frame DOM (empty in iframe mode)
    // and always returned null, so multi-select drags never detected
    // hovering a different viewport. `hits` is sorted smallest-area-first,
    // so the deepest NON-DRAGGED element under the cursor determines the
    // hovered viewport; `findRootHitAtPoint` covers empty replicas (where
    // the only hit under the cursor is the dragged element itself). Fall
    // back to the drag-start viewport when the cursor is over empty canvas.
    const cursorHits = getNodeHitsAtPoint(mouseScreen.x, mouseScreen.y);
    const firstNonDraggedHit = cursorHits.find(h => !skipIds.has(h.id) && h.id !== 'root');
    let hoverVpPrefix = firstNonDraggedHit
      ? firstNonDraggedHit.vpPrefix
      : (cursorHits.length > 0 ? cursorHits[0].vpPrefix : context.viewportPrefix);
    if (!firstNonDraggedHit) {
      const rootHit = findRootHitAtPoint(mouseScreen.x, mouseScreen.y);
      if (rootHit) hoverVpPrefix = rootHit.vpPrefix;
    }
    this.lastHoverVpId = vpIdFromPrefix(hoverVpPrefix);

    // ── Group layout target (cursor-based) ──────────────────────────────────
    // Multi-drag over a flex/grid container behaves like a single-node drag:
    // ONE drop-line at the cursor's slot, no per-node live reparent, and
    // onEnd commits every dragged node into that slot as consecutive
    // siblings (the reference behavior — user report 2026-08-05; before this,
    // layout targets were a dead end: the per-node path skipped them and the
    // multi onEnd branch never committed the confirmed parent). Reuses the
    // single-select entry fields + hysteresis — one gesture is either single
    // or multi, never both.
    const groupTargetId = this.detectGroupLayoutTargetId(
      cursorHits, hoverVpPrefix, this.lastHoverVpId, skipIds, nodes, mouseScreen,
    );
    if (groupTargetId !== this.candidateParentId) {
      this.candidateParentId = groupTargetId;
      this.framesInCandidateParent = groupTargetId ? 1 : 0;
      this.entryConfirmed = false;
      if (this.enteredParentId) {
        this.enteredParentId = null;
        this.enteredParentEl = null;
        this.enteredInsertIndex = -1;
        dropLineOps.hide();
        parentHighlightOps.hide();
      }
    } else if (groupTargetId) {
      this.framesInCandidateParent++;
      if (!this.entryConfirmed && this.framesInCandidateParent >= ENTRY_GRACE_FRAMES) {
        this.entryConfirmed = true;
        this.enteredParentId = groupTargetId;
        this.enteredParentEl = null;
        this.enteredVpId = this.lastHoverVpId;
        trace.action('canvas-drag:multi-layout-entry-confirmed', {
          parentId: groupTargetId, vpId: this.lastHoverVpId, nodeCount: draggedNodes.length,
        });
      }
    }

    // Mutations queued per-frame are flushed in one batch at the end so the
    // renderer reparents N elements in a single render cycle.
    let pendingFlush = false;

    for (const node of draggedNodes) {
      const rState = this.nodeReparentStates.get(node.id)!;

      // Per-node screen rect from the bridge — the live AABB.
      const elScreenRect = this.mouseSyncedRect(node.id, findNodeRect(node.id, startVpId), context);
      if (!elScreenRect) continue;

      // ─── Per-node exit detection (asymmetric: center-outside) ───
      if (rState.reparented && rState.confirmedParentId) {
        const parentRect = findNodeRect(rState.confirmedParentId, startVpId);
        const parentTransformValue = findNodeComputedStyle(rState.confirmedParentId, startVpId, 'transform');
        const parentHasTrans = hasNonIdentityTransform(parentTransformValue);
        const parentCorners = parentHasTrans ? getScreenCornersById(rState.confirmedParentId, startVpId) : null;

        const elCx = elScreenRect.left + elScreenRect.width / 2;
        const elCy = elScreenRect.top + elScreenRect.height / 2;

        const exited = parentCorners
          ? !pointInQuad(elCx, elCy, parentCorners)
          : parentRect
            ? (elCx < parentRect.left || elCx > parentRect.left + parentRect.width ||
               elCy < parentRect.top || elCy > parentRect.top + parentRect.height)
            : false;

        if (exited) {
          // Element left its previously confirmed parent. Send it back to
          // canvas root via a queued move + stylesync. The element keeps
          // its current screen position (computeExitCanvasPosition does
          // the AABB-center-stable conversion).
          const offset = getIframeOffset();
          const computed = findNodeComputedStyles(node.id, startVpId, ['width', 'height']);
          const cssW = parseFloat(computed.width) || elScreenRect.width / context.transform.scale;
          const cssH = parseFloat(computed.height) || elScreenRect.height / context.transform.scale;
          const { canvasLeft, canvasTop } = computeExitCanvasPosition(node.id, startVpId, elScreenRect, context.transform, offset, cssW, cssH);
          const cssLeft = Math.round(canvasLeft);
          const cssTop = Math.round(canvasTop);
          traceTransformReparent('exit', { nodeId: node.id, source: 'per-node', cssLeft, cssTop, cssW, cssH });

          const orig = this.originalTransforms.get(node.id) ?? '';
          const exitStyles: Record<string, string> = {
            position: 'absolute',
            left: `${cssLeft}px`, top: `${cssTop}px`,
            width: `${Math.round(cssW)}px`, height: `${Math.round(cssH)}px`,
            // Clear the per-frame drag translate atomically with the
            // reparent commit. Without this, the element's inline transform
            // would still hold the cumulative drag offset for one frame
            // after JSX flushes, producing a visible double-apply jump.
            transform: orig,
          };
          // On component master files startVpId IS the source variant
          // name (e.g., 'desktop' for default, 'variant-1'). The strip
          // walker in moveNodeInCode resolves variant-conditional text
          // (`{variant === 'X' ? 'A' : 'B'}`) into a plain JSXText for
          // the canvas-rooted node — without it the ternary collapses
          // to the default branch (often a `​` placeholder) and the
          // element disappears at canvas root.
          const exitSourceVariant = isComponentFilePath(getActiveFilePath()) ? startVpId : undefined;
          commitExitToCanvas({
            nodeId: node.id,
            styles: exitStyles,
            sourceVariant: exitSourceVariant,
            patch: { contentEl: context.contentEl, vpPrefix: context.viewportPrefix, styles: { transform: orig }, when: 'before-cache' },
          });
          // After exit the node lives on the canvas root — no parent
          // transform, so the next frame's projected delta == canvas delta.
          // We can subtract canvas-space dx/dy directly here.
          node.startLeft = cssLeft - dx - snapOffsetX;
          node.startTop = cssTop - dy - snapOffsetY;
          node.startParentId = null;
          // The element's CSS left/top is now cssLeft/cssTop. Anchor the
          // translate-baseline here so the next frame's translate starts
          // at 0 and grows incrementally instead of re-applying the entire
          // lift → exit cumulative.
          this.committedPos.set(node.id, { left: cssLeft, top: cssTop });
          rState.reparented = false;
          rState.confirmedParentId = null;
          rState.confirmedParentEl = null;
          this.multiEntryDetector!.clearNode(node.id);
          pendingFlush = true;
          continue;
        }
      }
      if (rState.reparented) continue;

      // Group layout mode owns the gesture — no per-node absolute entries
      // while the cursor hovers (or has confirmed) a layout container.
      // Mixed per-node reparents + a group drop-line would commit the
      // selection into two different parents on mouseup.
      if (groupTargetId || this.enteredParentId) {
        this.multiEntryDetector!.clearNode(node.id);
        continue;
      }

      // ─── Per-node entry detection — hit-test at the node's CENTER ───
      // (Not the cursor — multi-select, each node moves on its own offset.)
      const nodeCx = elScreenRect.left + elScreenRect.width / 2;
      const nodeCy = elScreenRect.top + elScreenRect.height / 2;
      const hits = getNodeHitsAtPoint(nodeCx, nodeCy);

      let bestCandidate: { id: string; el: HTMLElement | null } | null = null;
      for (const hit of hits) {
        // Used to skip 'root' here — paired with AbsoluteInFrameStrategy's
        // page-root reject. Both have been lifted so a canvas node can be
        // dragged INTO the page root on an empty starter page (where root
        // is the only frame). Without this, fully-inside hits never picked
        // root and the canvas node stayed parent=null.
        if (skipIds.has(hit.id)) continue;
        const candidateNode = nodes.get(hit.id);
        if (!candidateNode) continue;
        // Component INSTANCE (or its expanded internals) — never a drop target
        // (content owned by the master). Cursor over one BLOCKS the drop: bail
        // with no candidate rather than falling through to an ancestor behind.
        if (hitIsOverComponentInstance(hit.id, nodes)) { bestCandidate = null; break; }
        const tag = (candidateNode as any).tag || candidateNode.type || 'div';
        if (!nodeAcceptsChildren(candidateNode)) continue;
        const hitVpId = hit.vpPrefix ? vpIdFromPrefix(hit.vpPrefix) : startVpId;
        const rect = findNodeRect(hit.id, hitVpId);
        if (!rect) continue;

        // Layout-child override (mirror of single-select path). When
        // the hit's PARENT is flex/grid, accept the cursor-over rule —
        // each slot/cell is a visually distinct drop zone and the
        // user's intent is "drop INTO this card", not "drop into the
        // outer layout container". Same rule, both axes.
        const hitLayout = detectParentLayoutById(hit.id, hitVpId);
        const hitIsLayout = hitLayout === 'flex' || hitLayout === 'grid';
        if (!hitIsLayout) {
          const hitParentId = (candidateNode as any).parentId;
          if (hitParentId) {
            const parentDisplay = findNodeComputedStyle(hitParentId, hitVpId, 'display');
            if (
              parentDisplay === 'grid' || parentDisplay === 'inline-grid'
              || parentDisplay === 'flex' || parentDisplay === 'inline-flex'
            ) {
              // Only drop INTO the card when the dragged element FULLY FITS. A
              // no-layout frame can't lay out an oversized child, so parenting a
              // BIGGER element just makes it overflow the card (the bug: any
              // cursor-inside hit parented it regardless of size). Bigger-than-
              // target → skip this cursor-over shortcut and fall through to the
              // fully-inside check below (which also fails → the outer layout
              // container / canvas). Same "must fully fit" rule a plain frame uses.
              const fits = elScreenRect.left >= rect.left && elScreenRect.top >= rect.top
                && elScreenRect.right <= rect.right && elScreenRect.bottom <= rect.bottom;
              if (fits) {
                bestCandidate = { id: hit.id, el: null };
                break;
              }
            }
          }
        }

        // Same 4-case transform-aware fully-inside check the single-select
        // path uses — see detectSingleNodeContainment for the rationale.
        const containerHasTransform = hasNonIdentityTransform(findNodeComputedStyle(hit.id, startVpId, 'transform'));
        const elHasTransform = hasNonIdentityTransform(findNodeComputedStyle(node.id, startVpId, 'transform'));
        const containerCorners = containerHasTransform ? getScreenCornersById(hit.id, startVpId) : null;
        const elCorners = elHasTransform ? getScreenCornersById(node.id, startVpId) : null;

        let fullyInside: boolean;
        if (containerCorners && elCorners) {
          fullyInside = isFullyInsideQuad(elCorners, containerCorners);
        } else if (containerCorners) {
          fullyInside = isFullyInsideQuad(cornersFromRect(elScreenRect), containerCorners);
        } else if (elCorners) {
          const inAabb = (p: { x: number; y: number }) =>
            p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
          fullyInside = inAabb(elCorners.TL) && inAabb(elCorners.TR) && inAabb(elCorners.BR) && inAabb(elCorners.BL);
        } else {
          fullyInside =
            elScreenRect.left >= rect.left &&
            elScreenRect.right <= rect.right &&
            elScreenRect.top >= rect.top &&
            elScreenRect.bottom <= rect.bottom;
        }
        if (fullyInside) { bestCandidate = { id: hit.id, el: null }; break; }
      }

      // Root fallback. `getNodeHitsAtPoint` deliberately omits the page
      // root from regular hit-testing; without this, a canvas node
      // dragged into an empty starter page (where `root` is the only
      // frame) never gets a candidate and entry never fires.
      if (!bestCandidate) {
        const rootHit = findRootHitAtPoint(nodeCx, nodeCy);
        if (rootHit && !skipIds.has(rootHit.id)) {
          const rootRect = findNodeRect(rootHit.id, rootHit.vpPrefix ? vpIdFromPrefix(rootHit.vpPrefix) : startVpId);
          if (rootRect) {
            const inAabb = (p: { x: number; y: number }) =>
              p.x >= rootRect.left && p.x <= rootRect.right && p.y >= rootRect.top && p.y <= rootRect.bottom;
            const elHasTransform = hasNonIdentityTransform(findNodeComputedStyle(node.id, startVpId, 'transform'));
            const elCorners = elHasTransform ? getScreenCornersById(node.id, startVpId) : null;
            const fullyInside = elCorners
              ? inAabb(elCorners.TL) && inAabb(elCorners.TR) && inAabb(elCorners.BR) && inAabb(elCorners.BL)
              : elScreenRect.left >= rootRect.left
                && elScreenRect.right <= rootRect.right
                && elScreenRect.top >= rootRect.top
                && elScreenRect.bottom <= rootRect.bottom;
            if (fullyInside) bestCandidate = { id: rootHit.id, el: null };
          }
        }
      }

      // Update the per-node grace counter.
      this.multiEntryDetector!.update(node.id, bestCandidate ? { id: bestCandidate.id, el: bestCandidate.el as any } : null);
      const entryState = this.multiEntryDetector!.getState(node.id);
      if (!entryState?.confirmed || !entryState.confirmedId) continue;

      // Skip live-reparent for layout parents (drop-line preview only,
      // commit happens on mouseup in onEnd).
      const targetVpId = startVpId;
      const layout = detectParentLayoutById(entryState.confirmedId, targetVpId);
      if (layout === 'flex' || layout === 'grid') continue;

      // ─── Per-node live reparent (transform-aware) ───
      const pos = computeEntryParentLocalPosition(
        node.id, entryState.confirmedId, elScreenRect, targetVpId, context.transform.scale,
        undefined, (this.originalTransforms.get(node.id) ?? '') === '',
      );
      const cssLeft = pos?.parentRelLeft ?? 0;
      const cssTop = pos?.parentRelTop ?? 0;
      traceTransformReparent('entry', {
        nodeId: node.id, parentId: entryState.confirmedId, source: 'per-node',
        cssLeft, cssTop, cssWidth: pos?.cssWidth, cssHeight: pos?.cssHeight,
      });

      const orig = this.originalTransforms.get(node.id) ?? '';
      const entryStyles: Record<string, string> = {
        position: 'absolute',
        left: `${cssLeft}px`, top: `${cssTop}px`,
        // Clear the per-frame drag translate atomically with the reparent
        // commit so the inline transform doesn't carry the cumulative
        // lift→entry translate forward into the new parent.
        transform: orig,
      };
      // `canvasNode: false` — this is a canvas-node ENTERING a viewport
      // tree, not a canvas exit. Without the explicit false, the move
      // generator treats `newParentId === fileRootId` ("root") as a
      // canvas-exit and runs `stripVariantFamilyFromElement` which
      // resets inline `display: 'none'` to `''` — wiping the replica-
      // visibility marker we set in `entryStyles` and leaving the
      // element visible on every viewport (incl. the primary the
      // user expected hidden).
      queueMutation({ type: 'move', nodeId: node.id, newParentId: entryState.confirmedId, styles: entryStyles, canvasNode: false });
      // IMPERATIVE-FIRST RE-HOME (mid-drag entry). Central drag locks make
      // the Renderer skip this node, so the flush-render below can no longer
      // move its DOM parent — the element would stay parked at the content
      // root and the parent-relative per-frame writes that follow (dynamic-pin
      // `left: N%`, translate-from-committed baselines) would resolve against
      // the content root's huge box → the element flies off at the exact
      // reparent moment. `-1` = append without touching sibling CSS `order`
      // (absolute entry has no layout slot). Also fans replica copies into the
      // entered parent's other viewports, like the commit's render used to.
      getCanvasBridge().reparentLive?.(node.id, context.viewportPrefix, entryState.confirmedId, -1, entryStyles);
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform: orig });
      moveNodeInCache(node.id, entryState.confirmedId);
      updateNodeInCache(node.id, entryStyles);
      // OVERLAY RE-HOMING: handled ENTIRELY by `rehydrateOverlayFromCanvasInCode`
      // (the trigger's `move` above runs `canvasNode:false` + newParentId, which
      // fires the rehydrate chain in the move handler). Rehydrate lifts the
      // overlay out of `canvasNodes` into the component return as
      // `{<id>Open && <overlay/>}` with restored runtime, and the portal then
      // repositions it from the trigger every render — so the overlay's JSX
      // PARENT is irrelevant to where it paints.
      //
      // We used to ALSO queue an explicit `move` of the overlay element into the
      // entered parent here ("re-homing for design-tool parity"). That was redundant
      // with rehydrate AND corrupting: `moveNodeInCode` pulled the bare
      // `motion.div` OUT of its `{Open && (...)}` conditional wrapper, leaving a
      // malformed conditional. On the subsequent drag-OUT,
      // `extractOverlayToCanvasInCode` couldn't cleanly remove the mangled
      // overlay → a DUPLICATE "ghost" overlay was left on the canvas (the
      // canvas→variant→canvas round-trip bug; overlays authored INSIDE a variant
      // never have a canvas form so they never hit it). Rehydrate alone is both
      // correct and sufficient — no second move.

      // Subtract the current frame's drag delta so the next frame's
      // `newLeft = startLeft + projectedLocalDx` evaluates back to cssLeft.
      // The next frame projects (dx, dy) through the parent's transform
      // inverse to reach the parent's local frame — so the value we
      // subtract here MUST also be the parent-local projected delta.
      const localDelta = projectDeltaToParentLocal(dx, dy, entryState.confirmedId, targetVpId);
      node.startLeft = cssLeft - localDelta.dx - snapOffsetX;
      node.startTop = cssTop - localDelta.dy - snapOffsetY;
      node.startParentId = entryState.confirmedId;
      rState.reparented = true;
      rState.confirmedParentId = entryState.confirmedId;
      rState.confirmedParentEl = null; // not used in bridge mode
      // The element's CSS left/top is now cssLeft/cssTop. Anchor the
      // translate baseline here so subsequent frames compute incremental
      // translate from this position instead of cumulative-from-lift.
      this.committedPos.set(node.id, { left: cssLeft, top: cssTop });
      pendingFlush = true;
    }

    if (pendingFlush) {
      flushNowDeferredDuringDrag();
      forceCanvasRenderDeferredDuringDrag();
    }

    // Drop-line / empty-layout preview for the group layout target — same
    // affordance the single-select path shows.
    this.updateLayoutDropPreview(context, draggedIds, mouseScreen);
  }

  /** Cursor-based LAYOUT-ONLY drop-target resolution for multi-select drags.
   *  Trimmed mirror of the single-select bestFrame walk: layout containers
   *  accept on cursor-over; component instances resolve to their layout
   *  parent (drop-line BETWEEN instances, never inside); a non-layout frame
   *  under the cursor BLOCKS the walk (the per-node absolute entry owns that
   *  case). Returns null when no layout target applies. */
  private detectGroupLayoutTargetId(
    cursorHits: ReturnType<typeof getNodeHitsAtPoint>,
    hoverVpPrefix: string,
    hoverVpId: string,
    skipIds: Set<string>,
    nodes: DragContext['nodes'],
    mouseScreen: Point,
  ): string | null {
    let bestFrame: { id: string; rect: any } | null = null;
    let blocked = false;
    for (const hit of cursorHits) {
      if (hit.vpPrefix !== hoverVpPrefix) continue;
      if (skipIds.has(hit.id)) continue;
      if (hit.id === 'root') continue; // root fallback below
      if (hit.id.startsWith('layout::') || hit.id === 'children-slot') continue;
      if (hitIsOverComponentInstance(hit.id, nodes)) {
        const wrapperId = instanceWrapperIdForHit(hit.id, nodes);
        const parentId = wrapperId ? nodes.get(wrapperId)?.parentId : null;
        const parentNode: any = parentId ? nodes.get(parentId) : null;
        const parentIsInstanceOwned = !!parentNode
          && (!!parentNode.componentFile || !!parentNode.componentInstanceId || parentNode.isCodeComponent === true);
        if (parentId && parentNode && !parentIsInstanceOwned && !skipIds.has(parentId)
            && !parentId.startsWith('layout::') && parentId !== 'children-slot') {
          const parentLayout = detectParentLayoutById(parentId, hoverVpId);
          if (parentLayout === 'flex' || parentLayout === 'grid') {
            const parentRect = findNodeRect(parentId, hoverVpId);
            if (parentRect) { bestFrame = { id: parentId, rect: parentRect }; break; }
          }
        }
        blocked = true; break;
      }
      const candidateNode = nodes.get(hit.id);
      if (!candidateNode) continue;
      if (!nodeAcceptsChildren(candidateNode)) continue;
      const layout = detectParentLayoutById(hit.id, hoverVpId);
      if (layout === 'flex' || layout === 'grid') {
        const rect = findNodeRect(hit.id, hoverVpId);
        if (rect) bestFrame = { id: hit.id, rect };
        else blocked = true;
      } else {
        blocked = true; // non-layout frame: per-node absolute entry owns it
      }
      break;
    }
    bestFrame = applyLayoutEdgeMagnet(bestFrame as any, mouseScreen, nodes, hoverVpId) as any;
    if (!bestFrame && !blocked) {
      // Root fallback (mirror of the single path): a flex/grid page root
      // accepts a group drop when the cursor sits inside it.
      const rootRect = findNodeRect('root', hoverVpId);
      const inside = rootRect &&
        mouseScreen.x >= rootRect.left && mouseScreen.x <= rootRect.right &&
        mouseScreen.y >= rootRect.top && mouseScreen.y <= rootRect.bottom;
      if (inside && !skipIds.has('root')) {
        const layout = detectParentLayoutById('root', hoverVpId);
        if (layout === 'flex' || layout === 'grid') {
          bestFrame = { id: 'root', rect: rootRect };
        }
      }
    }
    return bestFrame?.id ?? null;
  }

  // ─── Live mirror of the variant solo-hide ────────────────────────────────

  /**
   * Apply the variant hide `hideInAllOthers` just QUEUED to the DOM, now.
   *
   * A canvas node entering a design-component variant becomes solo on that
   * variant: the code write sets `hidden = [every other variant]`, and on the
   * next render `Renderer.ts` turns that into `display: 'none'` on the copy in
   * each hidden variant's tile (the `hiddenOnVariants` branch of style
   * resolution). Mid-drag that render never lands on those copies — the node is
   * DRAG-LOCKED, and `patch-children-skip-locked` skips the whole child, styles
   * included. Meanwhile `reparentLive` HAS already inserted the element into
   * every tile of the entered parent (one node, many viewports), so the primary
   * tile shows a second live copy for the rest of the gesture and only loses it
   * on mouseup, when the locks clear and a full render finally reaches it.
   *
   * Page replicas don't have this problem: their hide is an `@container` rule,
   * and a stylesheet applies to a locked element just fine. Only the component
   * path needs the per-element mirror — which is why this is design-components
   * only (user report 2026-08-04).
   *
   * Restores the ENTERED variant on the way through, so moving between variants
   * inside one gesture doesn't leave the previous one dark.
   */
  private mirrorVariantSoloHideLive(
    contentEl: HTMLElement,
    nodeId: string,
    hiddenVariants: string[],
    enteredVpId: string,
    originalDisplay: string,
  ): void {
    for (const variant of hiddenVariants) {
      const prefix = getViewportPrefix(variant);
      const key = `${nodeId}|${prefix}`;
      if (this.liveVariantHides.has(key)) continue;
      this.liveVariantHides.set(key, originalDisplay);
      patchNodeStyles(contentEl, nodeId, prefix, { display: 'none' });
    }
    this.restoreLiveVariantHide(contentEl, nodeId, getViewportPrefix(enteredVpId));
    trace.action('canvas-drag:variant-solo-hide-live', {
      nodeId, enteredVpId, hiddenVariants, originalDisplay,
    });
  }

  /** Undo one mirrored hide. `originalDisplay` is '' for a node with no display
   *  of its own — and '' DELETES the inline property, which is exactly right. */
  private restoreLiveVariantHide(contentEl: HTMLElement, nodeId: string, prefix: string): void {
    const key = `${nodeId}|${prefix}`;
    if (!this.liveVariantHides.has(key)) return;
    patchNodeStyles(contentEl, nodeId, prefix, { display: this.liveVariantHides.get(key)! });
    this.liveVariantHides.delete(key);
    trace.action('canvas-drag:variant-solo-hide-restore', { nodeId, prefix });
  }

  /** Drop every mirrored hide — entry into the PRIMARY variant (the node goes
   *  back to being shared, so no tile stays dark) and gesture teardown, where a
   *  cancelled drag would otherwise strand an invisible copy. */
  private restoreAllLiveVariantHides(contentEl: HTMLElement): void {
    if (this.liveVariantHides.size === 0) return;
    for (const key of Array.from(this.liveVariantHides.keys())) {
      const sep = key.lastIndexOf('|');
      this.restoreLiveVariantHide(contentEl, key.slice(0, sep), key.slice(sep + 1));
    }
  }

  // ─── Single-select: existing containment detection (backward compat) ──────

  private detectSingleNodeContainment(
    context: DragContext,
    draggedIds: Set<string>,
    mouseScreen: Point,
    snap: any,
  ): DragMoveResult | null {
    const { draggedNodes, contentEl, nodes } = context;
    const primary = draggedNodes[0];
    const startVpId = vpIdFromPrefix(context.viewportPrefix);

    // Live element rect via the bridge — works in iframe mode where parent's
    // contentEl has no children. Bail only if rect can't be resolved.
    const elScreenRect = findNodeRect(primary.id, startVpId);
    if (!elScreenRect) return null;

    // Skip IDs: dragged elements + their descendants (so we don't try to
    // re-parent into a child of ourselves). Walk NodeMap children since the
    // parent-side DOM has no canvas elements.
    const skipIds = new Set(draggedIds);
    const collectDescendants = (id: string) => {
      const n = nodes.get(id);
      if (!n) return;
      for (const childId of n.children) {
        skipIds.add(childId);
        collectDescendants(childId);
      }
    };
    for (const id of draggedIds) collectDescendants(id);

    // Hit-test the mouse position via bridge to find which viewport the
    // pointer is over. hits is sorted smallest-area-first so the deepest
    // NON-DRAGGED element under the cursor determines the hovered viewport.
    // Skip dragged ids + their descendants — otherwise dragging a canvas
    // node (vpPrefix='') over a tablet replica frame would pick the canvas
    // node's own '' prefix as hoverVpPrefix and filter out every tablet-
    // prefixed candidate in the loop below, blocking entry detection.
    // Fall back to the drag-start viewport when the cursor is over empty canvas.
    const hits = getNodeHitsAtPoint(mouseScreen.x, mouseScreen.y);
    const firstNonDraggedHit = hits.find(h => !skipIds.has(h.id) && h.id !== 'root');
    let hoverVpPrefix = firstNonDraggedHit
      ? firstNonDraggedHit.vpPrefix
      : (hits.length > 0 ? hits[0].vpPrefix : context.viewportPrefix);
    // Empty replica fallback: when the cursor is over a viewport whose
    // root has no eligible children, the only non-skipped element in the
    // hits list is often the dragged element itself (its rect tracks the
    // cursor). `firstNonDraggedHit` is null and the existing fallback
    // would land on the dragged element's source vp prefix — which is
    // wrong when the cursor is actually over a replica's root.
    // `findRootHitAtPoint` scans the rect cache for the root containing
    // the cursor and returns its vp prefix.
    if (!firstNonDraggedHit) {
      const rootHit = findRootHitAtPoint(mouseScreen.x, mouseScreen.y);
      if (rootHit) hoverVpPrefix = rootHit.vpPrefix;
    }
    const hoverVpId = vpIdFromPrefix(hoverVpPrefix);
    this.lastHoverVpId = hoverVpId;

    // Hybrid entry detection. The cursor's DEEPEST frame-acceptable hit is the
    // only candidate considered — we never fall through to ancestors. Rules:
    //   layout (flex/grid): cursor-over is enough. Drop-line shows insertion.
    //   non-layout: dragged element must be FULLY INSIDE the frame; otherwise
    //     entry is SUPPRESSED (no drop-line on ancestors either). This matches
    //     the user's mental model: hovering a no-layout card should never
    //     light up the outer flex section behind it.
    let bestFrame: { id: string; rect: DOMRect } | null = null;
    let suppressEntry = false;
    for (const hit of hits) {
      if (hit.vpPrefix !== hoverVpPrefix) continue;
      if (skipIds.has(hit.id)) continue;
      if (hit.id === 'root') continue; // handled by viewport-root fallback below
      // TEMPLATE nodes (`layout::…` header/footer/nav merged from the page's
      // Template + the `children-slot`) belong to the template's own file —
      // never a drop parent on a page (same guard the other strategies apply).
      if (hit.id.startsWith('layout::') || hit.id === 'children-slot') continue;
      // Component INSTANCE (or its expanded internals) — never a drop target
      // ITSELF: its content is owned by the master, so inserting page content
      // would corrupt the instance. BUT an in-flow instance sitting in a
      // flex/grid parent occupies a layout SLOT — hovering it while dragging
      // means "insert into the parent at this position", exactly like
      // hovering a plain flex child. Blocking entry outright meant a
      // container filled with instances could NEVER show the between-slots
      // drop-line (the cursor is always over one — user report 2026-08-05).
      // Resolve the instance's LAYOUT PARENT as the candidate; suppress only
      // when the parent isn't a layout container.
      if (hitIsOverComponentInstance(hit.id, nodes)) {
        const wrapperId = instanceWrapperIdForHit(hit.id, nodes);
        const parentId = wrapperId ? nodes.get(wrapperId)?.parentId : null;
        const parentNode: any = parentId ? nodes.get(parentId) : null;
        // The candidate parent must live OUTSIDE any instance (not a wrapper,
        // not expanded internals) — the drop-line goes BETWEEN instances,
        // never inside one.
        const parentIsInstanceOwned = !!parentNode
          && (!!parentNode.componentFile || !!parentNode.componentInstanceId || parentNode.isCodeComponent === true);
        if (parentId && parentNode && !parentIsInstanceOwned && !skipIds.has(parentId)
            && !parentId.startsWith('layout::') && parentId !== 'children-slot') {
          const parentLayout = detectParentLayoutById(parentId, hoverVpId);
          if (parentLayout === 'flex' || parentLayout === 'grid') {
            const parentRect = findNodeRect(parentId, hoverVpId);
            if (parentRect) { bestFrame = { id: parentId, rect: parentRect }; break; }
          }
        }
        suppressEntry = true; break;
      }
      const node = nodes.get(hit.id);
      if (!node) continue;
      const tag = (node as any).tag || node.type || 'div';
      if (!nodeAcceptsChildren(node)) continue;
      const rect = findNodeRect(hit.id, hoverVpId);
      if (!rect) continue;

      const layout = detectParentLayoutById(hit.id, hoverVpId);
      const isLayout = layout === 'flex' || layout === 'grid';

      // Layout-child override: non-layout frames whose PARENT is a
      // layout container (grid OR flex) are visually distinct drop
      // zones — each occupies a cell / flex slot and the user clearly
      // means "drop INTO this card" when their cursor lands on it,
      // even if the dragged element overhangs the slot boundary. Use
      // the same cursor-over rule layout containers themselves use;
      // without this override the fully-inside check below would
      // suppress entry and the strategy would fall through to showing
      // the LAYOUT PARENT's own drop-line indicator across the whole
      // container — exactly the wrong target. Applies to flex and
      // grid uniformly per user feedback ("should be centralized").
      if (!isLayout) {
        const hitParentId = nodes.get(hit.id)?.parentId;
        if (hitParentId) {
          const parentDisplay = findNodeComputedStyle(hitParentId, hoverVpId, 'display');
          if (
            parentDisplay === 'grid' || parentDisplay === 'inline-grid'
            || parentDisplay === 'flex' || parentDisplay === 'inline-flex'
          ) {
            // Only target the card when the dragged element FULLY FITS — a
            // no-layout frame can't lay out an oversized child. Bigger-than-
            // target → skip the card and consider the layout container behind it
            // (the loop falls to the outer flex/grid below, showing its drop-
            // line). Mirrors the entry-detection gate so preview + commit agree.
            const fits = elScreenRect.left >= rect.left && elScreenRect.top >= rect.top
              && elScreenRect.right <= rect.right && elScreenRect.bottom <= rect.bottom;
            if (fits) {
              bestFrame = { id: hit.id, rect };
              break;
            }
            continue;
          }
        }
      }

      if (!isLayout) {
        // Transform-aware "fully inside" — direct port of the canvas-dnd
        // 4-case decision in AbsoluteDragStrategy. The bridge's `rect` is
        // the candidate's post-transform AABB; for a rotated parent that
        // AABB is much larger than the visual quad, so plain AABB
        // containment fired entry while the dragged element was still
        // visually outside the rotated parent.
        const containerHasTransform = hasNonIdentityTransform(
          findNodeComputedStyle(hit.id, hoverVpId, 'transform'),
        );
        const elHasTransform = hasNonIdentityTransform(
          findNodeComputedStyle(primary.id, hoverVpId, 'transform'),
        );
        const containerCorners = containerHasTransform
          ? getScreenCornersById(hit.id, hoverVpId)
          : null;
        const elCorners = elHasTransform
          ? getScreenCornersById(primary.id, hoverVpId)
          : null;

        let fullyInside: boolean;
        if (containerCorners && elCorners) {
          // Both transformed: dragged element corners inside container quad.
          fullyInside = isFullyInsideQuad(elCorners, containerCorners);
        } else if (containerCorners) {
          // Container transformed, element not: AABB corners of element
          // inside container quad.
          fullyInside = isFullyInsideQuad(cornersFromRect(elScreenRect), containerCorners);
        } else if (elCorners) {
          // Element transformed, container not: dragged corners inside
          // container AABB.
          const inAabb = (p: { x: number; y: number }) =>
            p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
          fullyInside = inAabb(elCorners.TL) && inAabb(elCorners.TR) && inAabb(elCorners.BR) && inAabb(elCorners.BL);
        } else {
          // Neither transformed: standard AABB containment (original fast path).
          fullyInside =
            elScreenRect.left >= rect.left &&
            elScreenRect.right <= rect.right &&
            elScreenRect.top >= rect.top &&
            elScreenRect.bottom <= rect.bottom;
        }

        if (fullyInside) {
          bestFrame = { id: hit.id, rect };
        } else {
          // Cursor IS over a non-layout frame, just not fully contained.
          // Block the walk — don't show drop-line on ancestors behind it.
          suppressEntry = true;
        }
        break;
      }

      bestFrame = { id: hit.id, rect };
      break;
    }
    void elScreenRect;

    // Edge-magnet promotion. When the deepest layout frame and ITS parent
    // are both layout containers running along the same axis, and the
    // cursor sits within ~12px of the layout-axis edge of the deeper
    // frame, treat the parent as the drop target. Without this, two
    // touching siblings (e.g. viewport sections with gap=0) can never be
    // dropped "between" — the cursor is always inside one of them and
    // the parent loses the containment race.
    bestFrame = applyLayoutEdgeMagnet(bestFrame, mouseScreen, nodes, hoverVpId);

    // Fallback: if no candidate yet AND cursor isn't sitting on a non-layout
    // frame, but the mouse is inside the viewport root and the root is
    // flex/grid, drop INTO the viewport itself. The suppressEntry guard keeps
    // the viewport from lighting up when the user is hovering a no-layout
    // card that doesn't contain the dragged element.
    if (!bestFrame && !suppressEntry) {
      const rootRect = findNodeRect('root', hoverVpId);
      const inside = rootRect &&
        mouseScreen.x >= rootRect.left && mouseScreen.x <= rootRect.right &&
        mouseScreen.y >= rootRect.top && mouseScreen.y <= rootRect.bottom;
      if (inside && !skipIds.has('root')) {
        const layout = detectParentLayoutById('root', hoverVpId);
        const isCompFile = isComponentFilePath(getActiveFilePath());
        if (layout === 'flex' || layout === 'grid' || isCompFile) {
          bestFrame = { id: 'root', rect: rootRect } as any;
        } else {
          // Non-layout root (empty starter page — root is a static frame
          // with `position: relative`). Require the dragged element to be
          // FULLY INSIDE root, same predicate a regular non-layout frame
          // uses upstream. Without this, a canvas node would enter root
          // the moment the cursor crossed its edge — too eager when root
          // covers most of the visible canvas.
          const elFullyInside =
            elScreenRect.left >= rootRect.left &&
            elScreenRect.right <= rootRect.right &&
            elScreenRect.top >= rootRect.top &&
            elScreenRect.bottom <= rootRect.bottom;
          if (elFullyInside) bestFrame = { id: 'root', rect: rootRect } as any;
        }
      }
    }

    const bestFrameId = bestFrame?.id ?? null;
    const bestFrameEl = (bestFrame as any)?.el ?? null; // null in iframe mode — we use IDs

    if (bestFrameId) {
      trace.action('canvas-drag:entry-best-candidate', { bestFrameId });
    }

    // Entry hysteresis
    if (bestFrameId !== this.candidateParentId) {
      this.candidateParentId = bestFrameId;
      this.framesInCandidateParent = bestFrameId ? 1 : 0;
      this.entryConfirmed = false;
      this.liveReparented = false;

      // Whenever the candidate changes, clear the previously-confirmed entry.
      // Otherwise the drop-line code below uses a stale enteredParentId during
      // the grace window — e.g. cursor moves from outer-flex into a nested
      // non-layout card, candidate flips to the card but enteredParentId is
      // still the outer flex, so the drop-line renders on the outer flex.
      if (this.enteredParentId) {
        this.enteredParentId = null;
        this.enteredParentEl = null;
        this.enteredInsertIndex = -1;
        dropLineOps.hide();
        parentHighlightOps.hide();
        trace.action('canvas-drag:entry-cleared', {
          nodeId: primary.id,
          newCandidate: bestFrameId,
        });
      }
    } else if (bestFrameId) {
      this.framesInCandidateParent++;

      if (!this.entryConfirmed && this.framesInCandidateParent >= ENTRY_GRACE_FRAMES) {
        this.entryConfirmed = true;
        this.enteredParentId = bestFrameId;
        this.enteredParentEl = bestFrameEl;
        this.enteredVpId = hoverVpId || vpIdFromPrefix(context.viewportPrefix);
        trace.action('canvas-drag:entry-confirmed', {
          nodeId: primary.id,
          enteredParentId: bestFrameId,
          enteredVpId: this.enteredVpId,
          framesInside: this.framesInCandidateParent,
        });
      }
    }

    // If entry just confirmed, perform live reparent for non-layout parents.
    // Bridge-aware: uses node IDs + findNodeRect math instead of DOM querying,
    // so it works with the iframe-rendered canvas (parent contentEl is empty).
    if (this.enteredParentId && !this.liveReparented) {
      const enteredParentId = this.enteredParentId;
      const dropVpId = this.enteredVpId || vpIdFromPrefix(context.viewportPrefix);
      const layout = detectParentLayoutById(enteredParentId, dropVpId);

      if (layout !== 'flex' && layout !== 'grid') {
        const scale = context.transform.scale || 1;
        // When entering a non-primary replica/variant frame, the moved element
        // must be hidden in primary + other replicas and re-shown ONLY in the
        // entered viewport. Mirrors the create-on-replica pattern in creators
        // (FrameCreator etc.): inline base gets `display: 'none'` (covers
        // primary/desktop) and the entered viewport gets a
        // `display: 'unset'` override via queueReplicaCreationUnhide, plus
        // explicit `display: 'none'` on every OTHER replica/variant via
        // hideInAllOthers (so the entered's container/variant override doesn't
        // bleed into smaller replicas via min-width-bounded @media rules).
        const enteringNonPrimaryVp = !isPrimaryViewport(dropVpId);
        // Set by the two write sites below that produce the pair described in
        // the comment above (base inline `display:'none'` + the entered vp's
        // `display:'unset'` @container override). Those halves land through
        // DIFFERENT channels: the inline one is in the move mutation's styles
        // and reaches the DOM instantly, the override needs the code regenerate
        // + <style> re-render. Deferring the second half is what made a node
        // entering a REPLICA vanish for the whole drag and pop back on mouseup
        // (user report 2026-08-04). Read at the flush below.
        //
        // Tracked at the WRITE SITES rather than re-derived from
        // `enteringNonPrimaryVp` so the gate can't drift: the pair is skipped
        // for component instances and component files, and a predicate that
        // didn't know that would send those down the expensive path for nothing.
        let writesVpVisibility = false;
        // The dragged node lives in the START viewport (canvas root for
        // canvas nodes, vpPrefix=''). Reading its rect / computed dims via
        // dropVpId would query a non-existent prefixed element and fall back
        // to (0,0), causing a huge jump on entry. Use startVpId for the
        // CHILD lookups; dropVpId still drives the PARENT's transform.
        const childVpId = startVpId;

        // Detect layout-child target (entered parent is a child of a
        // flex/grid container). For these targets:
        //   • Compute entry coords directly from CURSOR position rather
        //     than the cached corners (which may be stale due to dynamic
        //     pin or recent transform writes).
        //   • Promote the target to `position: relative` if it lacks one
        //     — without a positioned ancestor the element's left/top
        //     resolves against the wrong containing block (typically the
        //     outer layout container) and the element offsets visibly.
        // Same logic AbsoluteInFrameStrategy uses for its layout-child
        // sibling-entry path. Kept in sync — the same physical drop
        // pattern shouldn't diverge by which strategy is currently
        // active.
        const enteredParentNodeForLayout = nodes.get(enteredParentId);
        const enteredParentGrandparentId = (enteredParentNodeForLayout as any)?.parentId;
        const enteredParentGrandparentDisplay = enteredParentGrandparentId
          ? findNodeComputedStyle(enteredParentGrandparentId, dropVpId, 'display')
          : '';
        const enteredIsLayoutChild =
          enteredParentGrandparentDisplay === 'grid' || enteredParentGrandparentDisplay === 'inline-grid'
          || enteredParentGrandparentDisplay === 'flex' || enteredParentGrandparentDisplay === 'inline-flex';

        // Cache the per-node entry coords so the entryOverrides built
        // for the strategy switch reuses the SAME values committed to
        // source. Without this, the override loop further down would
        // re-run `computeEntryParentLocalPosition` (the OLD non-
        // transform-aware helper) and produce DIFFERENT startLeft/
        // startTop — AbsoluteInFrameStrategy then uses that mismatched
        // baseline for its dynamic-pin math, jumping the element by
        // (myEntryCoords − oldHelperCoords) on the very next tick.
        const entryPosByNode = new Map<string, { cssLeft: number; cssTop: number }>();

        for (const node of draggedNodes) {
          const elRect = this.mouseSyncedRect(node.id, findNodeRect(node.id, childVpId), context);
          let cssLeft = 0;
          let cssTop = 0;
          let pos: ReturnType<typeof computeEntryParentLocalPosition> | null = null;
          if (enteredIsLayoutChild) {
            // Cursor-anchored entry — bypass `computeEntryParentLocalPosition`
            // which reads stale cached corners. Map cursor to the
            // target's local CSS coords via its PAINTED QUAD corners
            // (not the AABB). The AABB-based math `(cursor - aabbLeft)
            // / scale` only works when the target's local axes are
            // aligned with screen axes — for cells inside a transformed
            // ancestor (rotated grid, etc.), the painted quad is rotated
            // in screen space but the AABB is axis-aligned, so the AABB
            // origin doesn't correspond to the cell's local (0,0).
            // Using the corners gives the correct affine inverse that
            // works for ANY cumulative ancestor transform (rotate, skew,
            // scale at any nesting depth). Falls back to AABB math when
            // corners aren't cached.
            const corners = getScreenCornersById(enteredParentId, dropVpId);
            const sibCssDims = findNodeComputedStyles(enteredParentId, dropVpId, ['width', 'height']);
            const sibCssW = parseFloat(sibCssDims.width);
            const sibCssH = parseFloat(sibCssDims.height);
            const elemComputed = findNodeComputedStyles(node.id, childVpId, ['width', 'height']);
            const cssW = parseFloat(elemComputed.width) || (elRect ? elRect.width / scale : 0);
            const cssH = parseFloat(elemComputed.height) || (elRect ? elRect.height / scale : 0);
            if (corners && Number.isFinite(sibCssW) && sibCssW > 0 && Number.isFinite(sibCssH) && sibCssH > 0) {
              // Solve the 2D affine system to map cursor screen → cell-
              // local. The cell's painted quad defines a basis:
              //   xAxis = TR - TL (cell-local +X direction in screen)
              //   yAxis = BL - TL (cell-local +Y direction in screen)
              // For any screen point S inside the quad, S = TL + α*xAxis
              // + β*yAxis where (α, β) ∈ [0,1] are the local coords
              // normalized to cell size. Solve the 2×2 linear system:
              //   [xAxisX yAxisX] [α]   [dx]
              //   [xAxisY yAxisY] [β] = [dy]
              // via Cramer's rule. Works for ANY 2D affine transform
              // (rotation, skew, scale, or any composition) — pure
              // rotation has orthogonal axes so the simpler dot-product
              // projection would also work for it, but skew makes the
              // axes non-orthogonal and projection breaks. The affine
              // solver is correct for both.
              const xAxisX = corners.TR.x - corners.TL.x;
              const xAxisY = corners.TR.y - corners.TL.y;
              const yAxisX = corners.BL.x - corners.TL.x;
              const yAxisY = corners.BL.y - corners.TL.y;
              const dx = mouseScreen.x - corners.TL.x;
              const dy = mouseScreen.y - corners.TL.y;
              const det = xAxisX * yAxisY - yAxisX * xAxisY;
              const relX = det !== 0 ? (dx * yAxisY - dy * yAxisX) / det : 0;
              const relY = det !== 0 ? (dy * xAxisX - dx * xAxisY) / det : 0;
              const cursorLocalX = relX * sibCssW;
              const cursorLocalY = relY * sibCssH;
              cssLeft = Math.round(cursorLocalX - cssW / 2);
              cssTop = Math.round(cursorLocalY - cssH / 2);
            } else {
              // Fallback: AABB-relative math for non-transformed parents.
              const sibScreenRect = findNodeRect(enteredParentId, dropVpId);
              if (sibScreenRect) {
                const cursorLocalX = (mouseScreen.x - sibScreenRect.left) / scale;
                const cursorLocalY = (mouseScreen.y - sibScreenRect.top) / scale;
                cssLeft = Math.round(cursorLocalX - cssW / 2);
                cssTop = Math.round(cursorLocalY - cssH / 2);
              }
            }
          } else {
            // Transform-aware: anchor the AABB CENTER (== layout-box center for
            // any centered transform: scale, rotation) into parent-local CSS,
            // then derive the layout-box TL by subtracting half the COMPUTED
            // CSS width/height. Without this, a `transform: scale(2)` element
            // entering a parent had its CSS TL set to the AABB TL — which kept
            // the scale on top, doubling the visible size at the new position.
            // Mirrors canvas-dnd's AbsoluteDragStrategy entry math.
            pos = elRect
              ? computeEntryParentLocalPosition(node.id, enteredParentId, elRect, dropVpId, scale, childVpId,
                  (this.originalTransforms.get(node.id) ?? '') === '')
              : null;
            cssLeft = pos?.parentRelLeft ?? 0;
            cssTop = pos?.parentRelTop ?? 0;
          }
          traceTransformReparent('entry', {
            nodeId: node.id, parentId: enteredParentId,
            elScreenRect: elRect, cssLeft, cssTop,
            cssWidth: pos?.cssWidth, cssHeight: pos?.cssHeight,
            mouseScreen, lastPos: this.lastPositions.get(node.id) ?? null,
            enteredIsLayoutChild,
          });

          // Commit move to code immediately so the Renderer reparents in place.
          // Include `transform: <originalTransform>` so the inline drag
          // translate is cleared atomically with the new left/top — keeps
          // single-drag entry stable when the element had a pre-drag rotate
          // or scale and we'd been writing per-frame translates on top.
          const orig = this.originalTransforms.get(node.id) ?? '';
          const moveStyles: Record<string, string> = {
            position: 'absolute',
            left: `${cssLeft}px`,
            top: `${cssTop}px`,
            transform: orig,
          };
          // Non-primary entry: write display:none to the inline base so the
          // primary/desktop viewport (which has no @container override) hides
          // the element by default. The entered viewport's container/variant
          // override below flips it back to visible.
          //
          // Component-instance exception (mirrors ToolbarDragStrategy): when
          // the dragged node is a component instance, inline `style` is
          // merged onto the component's INNER root via `expandComponent`. The
          // `@media display: unset` rule targets the wrapper's data-id —
          // not the inner root — so the inner root stays `display: none`
          // and the embed renders blank. Skip the inline; per-viewport
          // @media hide rules below already cover the primary range with
          // bounded `(max-width:X) and (min-width:Y+1)` selectors.
          const draggedNode = context.nodes.get(node.id);
          // Code-component / code component instances skipped by `expandComponent`
          // never get `isComponentInstance`; check both flags so they ride
          // the same no-inline-display path as design-component instances.
          const isInstance =
            draggedNode?.isComponentInstance === true ||
            draggedNode?.isCodeComponent === true;
          // Component master files: variant visibility is owned by
          // `setVariantVisibility` (AnimatePresence wrapper). Skip the
          // legacy inline `display: 'none'` write — it freezes into
          // `variants.default` via `ensureDefaultHasBaseValues` and
          // produces the dual-pattern (wrapper AND variant display)
          // that causes the asymmetric jump on variant transitions.
          const isComponentFile = isComponentFilePath(getActiveFilePath());
          if (enteringNonPrimaryVp && !isInstance && !isComponentFile) {
            moveStyles.display = 'none';
            // Half one of the visibility pair — see `writesVpVisibility`.
            writesVpVisibility = true;
          }
          // `canvasNode: false` — canvas-node ENTERING a viewport tree.
          // Without the explicit false, the move generator's
          // "moving-to-root" branch fires (since `enteredParentId` for
          // a viewport entry equals the page's `fileRootId === "root"`)
          // and `stripVariantFamilyFromElement` resets inline
          // `display: 'none'` back to `''` — the replica-visibility
          // marker we just set in `moveStyles.display` gets wiped and
          // the element shows on every viewport.
          queueMutation({
            type: 'move',
            nodeId: node.id,
            newParentId: enteredParentId,
            styles: moveStyles,
            canvasNode: false,
          });
          // IMPERATIVE-FIRST RE-HOME — same contract as the multi-node entry
          // block above: the drag-locked render can't move the DOM parent, so
          // do it here or AbsoluteInFrameStrategy's first dynamic-pin ticks
          // (`left: N%`) resolve against the content root and the element
          // flies off at the reparent moment. `-1` = append, no order slots.
          //
          // Traced because the hazard above is a TIMING one and was otherwise
          // invisible: this is a Comlink post, and the sandbox's matching
          // `sandbox:reparentLive` is the only other end of it. Pairing the two
          // timestamps measures how long the entered element spends carrying
          // parent-local coords while still in its old DOM parent (53ms in the
          // 2026-08-04 recording, with the properties panel re-rendering on
          // every drag frame in between — same-origin iframe, same event loop).
          trace.action('canvas-drag:entry-reparent-posted', {
            nodeId: node.id, parentId: enteredParentId, cssLeft, cssTop,
          });
          getCanvasBridge().reparentLive?.(node.id, context.viewportPrefix, enteredParentId, -1, moveStyles);
          patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform: orig });
          // Anchor the translate baseline at the new committed position.
          this.committedPos.set(node.id, { left: cssLeft, top: cssTop });
          // Sync the imperative NodeMap cache to the new parent + new styles.
          // The DragCoordinator's rebuildContext (fires right after this
          // returns) reads nodeData.parentId and nodeData.styles via
          // getNodeFromCache. That cache is normally refreshed by the
          // nodesAtom getter when React reads the atom, but during a drag
          // canvasInteracting=true blocks bridge.render() so the atom may
          // not be re-derived in time. Without this sync, the rebuild
          // sees parentId=null (the pre-move state) and falls into the
          // no-parent branch with stale canvas-space styles — and the
          // AbsoluteInFrameStrategy then treats the element's startLeft
          // as the OLD canvas X (e.g. 540px) inside the new parent's
          // 320px-wide frame, visibly placing it at the parent's
          // top-left corner instead of where the cursor is.
          moveNodeInCache(node.id, enteredParentId);
          updateNodeInCache(node.id, {
            position: 'absolute',
            left: `${cssLeft}px`,
            top: `${cssTop}px`,
          });
          // Stash for the entryOverrides loop below so the strategy
          // switch passes the SAME baseline AbsoluteInFrameStrategy
          // should use for its first dynamic-pin tick.
          entryPosByNode.set(node.id, { cssLeft, cssTop });
        }

        // Promote the layout-child target to `position: relative` if it
        // lacks one — without a positioned ancestor the entered child's
        // absolute coords resolve against the wrong containing block
        // (typically the outer flex/grid container, which is much bigger)
        // and the element renders far from where the math placed it.
        // Mirror of the same fix in AbsoluteInFrameStrategy's sibling-
        // entry path. Only fires for layout-child targets (`grid` / `flex`
        // parents) and only when the target is `static` / unset —
        // `relative`/`absolute`/`sticky`/`fixed` all create containing
        // blocks and the user's choice is preserved.
        if (enteredIsLayoutChild) {
          const targetStyles = nodes.get(enteredParentId)?.styles ?? {};
          const existingPos = targetStyles.position || '';
          if (!existingPos || existingPos === 'static') {
            queueMutation({
              type: 'updateStyles',
              nodeId: enteredParentId,
              styles: { position: 'relative' },
            });
            updateNodeInCache(enteredParentId, { position: 'relative' });
            patchNodeStyles(context.contentEl, enteredParentId, context.viewportPrefix, { position: 'relative' });
            trace.action('canvas-drag:promote-target-to-relative', {
              targetId: enteredParentId,
              reason: 'layout-child-needs-containing-block',
            });
          }
        }

        // Always clear any `@media display:'none'` the dragged carried
        // for the entered viewport. Without this, a vp-only-extracted
        // canvas clone (which has display:'none' on every non-source
        // viewport) enters the entered viewport, the @media rule kicks
        // in the moment it joins that iframe's tree, the element
        // collapses to 0×0, and the entry-math reads a zero rect →
        // huge offset jump. Writing `display: ''` removes that property
        // from the entered vp's @container rule (no-op if it wasn't
        // there, which is the common case for plain canvas nodes).
        const enteredVpId = this.enteredVpId || 'desktop';
        // True when that unhide actually REMOVES a live rule (rather than being
        // the usual no-op) — the entered viewport currently hides this node.
        // Drives the synchronous pipeline at the flush below; see there.
        let unhidesLiveRule = false;
        {
          const vpWidths = getViewportWidths();
          const enteredVpWidth = vpWidths[enteredVpId] ?? 0;
          const overrides = getDefaultStore().get(containerOverridesAtom);
          for (const node of draggedNodes) {
            if (getOverridesAtWidth(overrides, node.id, enteredVpWidth).get('display')) {
              unhidesLiveRule = true;
            }
            queueMutation({
              type: 'updateContainerStyle',
              nodeId: node.id,
              maxWidth: enteredVpWidth,
              styles: { display: '' },
            });
          }
          trace.action('canvas-drag:entered-vp-display-unhide', {
            enteredVpId, enteredVpWidth, unhidesLiveRule, nodeIds: draggedNodes.map(n => n.id),
          });
        }
        if (!isPrimaryViewport(enteredVpId)) {
          const vpWidths = getViewportWidths();
          const rctx = getReplicaContext(enteredVpId, getActiveFilePath(), vpWidths);
          for (const node of draggedNodes) {
            // Component instances skipped the inline `display:'none'`
            // (see comment on the move-mutation block above), so the
            // primary's @container hide MUST be kept — it's the only
            // thing keeping the instance hidden on the primary range.
            // Regular tags keep the original "skip primary @container"
            // optimization (inline already covers primary, redundant
            // @container would fight the entered's display:'unset').
            const draggedNode = context.nodes.get(node.id);
            // Both design-component instances (`isComponentInstance`) and
            // code-component / code component instances (`isCodeComponent`) need the
            // same wrapper-vs-inner-root treatment. Code components are
            // skipped by `expandComponent` (project-parser.ts:91) so they
            // never get the `isComponentInstance` flag — checking only
            // that field misses them and the legacy "inline display:none +
            // unset !important" path runs, which collapses the wrapper to
            // `display: inline` (zero-area) for the entered viewport.
            const isInstance =
              draggedNode?.isComponentInstance === true ||
              draggedNode?.isCodeComponent === true;
            const hideUpdates = rctx.hideInAllOthers(node.id);
            for (const hideUpdate of hideUpdates) {
              if (!isInstance && hideUpdate.type === 'updateContainerStyle') {
                const targetVpId = Object.keys(vpWidths).find(
                  k => vpWidths[k] === hideUpdate.maxWidth,
                );
                if (targetVpId && isPrimaryViewport(targetVpId)) continue;
              }
              queueMutation(hideUpdate as any);
            }
            // Mirror the hide we just queued into the DOM — the mid-drag render
            // can't reach the locked copies. See `mirrorVariantSoloHideLive`.
            for (const u of hideUpdates) {
              if (u.type !== 'setVariantVisibility') continue;
              this.mirrorVariantSoloHideLive(
                context.contentEl,
                node.id,
                (u as any).hiddenVariants as string[],
                enteredVpId,
                getNodeFromCache(node.id)?.styles?.display ?? '',
              );
            }
            // Component instances skip the unhide. `display: 'unset' !important`
            // would force the wrapper to `display: inline` (initial value
            // beats UA stylesheet under !important author rule), and inline
            // boxes ignore width/height — the embed renders at 0×0. Other
            // replicas' @media hides leave the entered viewport with no
            // override, so the wrapper renders with its natural
            // `display: block` (Renderer creates `<div>` for instances per
            // the VALID_TAGS fallback).
            if (!isInstance) {
              // Read the element's existing `display` from the live
              // cache. For a canvas-node that had `display: 'flex'` /
              // `'grid'` / etc. (e.g. a layout-frame the user drew on
              // canvas and is now dragging into a replica), the
              // entered vp's `@container` override needs to RESTORE
              // that display, not fall back to `unset` which kills
              // any flex/grid layout. The inline `display: 'none'`
              // (hide-baseline) we write next overrides it everywhere
              // EXCEPT the entered vp via the `@container display:
              // <original>` write.
              const cachedNode = getNodeFromCache(node.id);
              const originalDisplay = cachedNode?.styles?.display ?? '';
              queueReplicaCreationUnhide(node.id, enteredVpId, vpWidths[enteredVpId] ?? 0, originalDisplay);
              // Half two of the visibility pair — the STYLESHEET half, the one
              // no imperative patch can express. See `writesVpVisibility`.
              writesVpVisibility = true;
            }
            // SOLO-REPLICA marker. A canvas-node entering ONLY this
            // replica (hidden on every other vp) starts its life in
            // "solo" mode: subsequent style edits the user makes
            // while on this vp get redirected to the BASE inline
            // styles instead of the @container rule (so the visible
            // rendering on this vp serves as the authoring surface
            // for the master/base values). The moment the user
            // unhides the element on any other vp, the redirect
            // ends and routing reverts to normal per-vp @container.
            //
            // Tracked via `data-replica-solo="<vpId>"`. Component
            // instances are skipped — their style routing already
            // goes to the master variants object, not the inline
            // styles, so the redirect would be a no-op.
            if (!isInstance) {
              queueMutation({
                type: 'updateHtmlAttrs',
                nodeId: node.id,
                attrs: { 'data-replica-solo': enteredVpId },
              });
              trace.action('canvas-drag:set-replica-solo', { nodeId: node.id, soloVpId: enteredVpId });
            }
          }
        } else {
          // Entering the PRIMARY variant — the node is shared again, so drop any
          // tile this gesture darkened on an earlier entry into a variant.
          // Without this, variant-1 → primary in one gesture leaves the primary
          // copy stuck at `display:none` (the mirror's own version of the bug it
          // exists to fix).
          this.restoreAllLiveVariantHides(context.contentEl);
        }

        // Commit: mutations queue now; the drop's flushNow drains them in one
        // chain (mid-drag string work was the drag-start stall on big pages).
        //
        // EXCEPT when this entry changes the node's PER-VIEWPORT VISIBILITY.
        // That state lives (at least half of it) in a `@media { [data-id=x] {
        // display: … !important } }` rule in the page's <style> block, and a
        // stylesheet `!important` cannot be beaten by the imperative
        // per-element patches the drag runs at 60fps — the only way to change
        // it is to regenerate the code and re-render the block. Two entries
        // need that, and BOTH were deferring it to the drop:
        //
        //   · `unhidesLiveRule` — entering a viewport that currently HIDES the
        //     node (a vp-only-extracted clone re-entering its primary). The
        //     rule must go, or the node is invisible in the viewport the user
        //     just dragged it into ("it should not hide when I enter primary").
        //
        //   · `writesVpVisibility` — entering a REPLICA, which CREATES the
        //     hide: base inline `display:'none'` + the entered vp's
        //     `display:'unset'` override. The inline half reaches the DOM
        //     instantly and the stylesheet half doesn't, so deferring left the
        //     node hidden EVERYWHERE for the whole drag ("the moment it enters
        //     the replica it's completely hidden and only appears on mouse
        //     up"). Clearing a rule and writing one are the same problem.
        //
        // Both take the full synchronous pipeline — the same trio the vp-only
        // clone EXIT uses for the mirror-image problem (materialising DOM
        // mid-drag), for the same reason: no imperative primitive expresses it.
        //
        // The gate stays NARROW. An ordinary canvas node entering the PRIMARY
        // with no overrides — the common case — writes no visibility at all and
        // keeps the deferred path, paying nothing. Seeding the node cache from
        // the freshly committed code is what makes the forced render survive
        // Canvas.tsx's integrity guard mid-gesture — see the identical trio in
        // AbsoluteInFrameStrategy's clone exit.
        if (unhidesLiveRule || writesVpVisibility) {
          trace.action('canvas-drag:entry-sync-unhide-pipeline', {
            enteredVpId, unhidesLiveRule, writesVpVisibility,
            nodeIds: draggedNodes.map(n => n.id),
          });
          flushNow();
          seedNodesForCode(getCurrentCode());
          forceCanvasRender();
        } else {
          flushNowDeferredDuringDrag();
          // Force iframe re-render so the element's DOM parent actually changes
          // before the next patchStyles tick writes inline left/top. Without
          // this, position:absolute coords get interpreted relative to the OLD
          // parent and the element appears offset.
          forceCanvasRenderDeferredDuringDrag();
        }
        // The dragged node now lives in the entered viewport. Update
        // `interactingViewportIdAtom` (via Canvas's event listener) so
        // selection-overlay / pin-constraint-lines / style-write routing
        // all read from the entered viewport's DOM. Without this, those
        // overlays keep querying findNodeRect(node, 'desktop') where the
        // node has display:'none' and zero rect → overlays draw at (0,0).
        if (enteringNonPrimaryVp) {
          window.dispatchEvent(new CustomEvent('revyme:set-interacting-viewport', {
            detail: { vpId: enteredVpId },
          }));
        }
        trace.action('canvas-drag:code-first-entry', {
          parentId: enteredParentId, vpId: enteredVpId,
          nodeIds: draggedNodes.map(n => n.id),
        });

        this.liveReparented = true;
        // Provide authoritative node state to the new strategy so it doesn't
        // rebuild from the (potentially stale during a drag) imperative cache.
        // cssLeft/cssTop are the parent-local coords just committed to code —
        // re-derived via the same transform-aware path so they match the
        // values written to JSX in the loop above.
        const entryOverrides = new Map<string, { startLeft: number; startTop: number; startParentId: string | null }>();
        for (const node of draggedNodes) {
          // Reuse the SAME cssLeft/cssTop we just committed to source.
          // Re-running `computeEntryParentLocalPosition` here would
          // produce DIFFERENT values for transformed targets (it uses
          // cached corners as anchor, ignoring the cursor-anchored
          // corner-projection math the entry loop just did). That
          // mismatch was the visible "huge jump" on entry into a
          // rotated-grid cell — the strategy switch handed
          // AbsoluteInFrameStrategy a baseline that didn't match the
          // committed source, and dynamic-pin's `startLeft + dx` math
          // landed at the wrong position on its first tick.
          const cached = entryPosByNode.get(node.id);
          // Defensive fallback: if cache miss (shouldn't happen since
          // the same loop populates it for every dragged node), fall
          // back to the legacy helper to avoid emitting `{0, 0}`
          // overrides — better stale than zero.
          let cssLeft: number;
          let cssTop: number;
          if (cached) {
            cssLeft = cached.cssLeft;
            cssTop = cached.cssTop;
          } else {
            const elRect = this.mouseSyncedRect(node.id, findNodeRect(node.id, startVpId), context);
            const pos = elRect
              ? computeEntryParentLocalPosition(node.id, enteredParentId, elRect, dropVpId, scale, startVpId,
                  (this.originalTransforms.get(node.id) ?? '') === '')
              : null;
            cssLeft = pos?.parentRelLeft ?? 0;
            cssTop = pos?.parentRelTop ?? 0;
          }
          entryOverrides.set(node.id, { startLeft: cssLeft, startTop: cssTop, startParentId: enteredParentId });
        }
        // When entering a non-primary viewport's frame, propagate the new
        // viewport prefix to the coordinator so the next strategy
        // (AbsoluteInFrameStrategy) reads the element's rect / computed
        // styles from the entered viewport's DOM instead of the original
        // (canvas-root, vpPrefix='') one. Without this, abs-in-frame's
        // `findNodeRect(child, 'desktop')` returns null (element has
        // display:none on desktop) → strategy thinks element is outside
        // its parent → fires grandparent-reparent → element jumps to the
        // entered parent's grandparent (e.g. flex container 'hero')
        // instead of staying inside the blue frame.
        // Same contract as variant-exit-clone-and-vp-prefix.md.
        const newPrefix = enteringNonPrimaryVp ? getViewportPrefix(dropVpId) : undefined;
        return {
          snap: null,
          dropTarget: null,
          highlightParentId: null,
          axisLock: this.lockedAxis,
          switchRequest: {
            toStrategy: 'absolute-in-frame',
            reason: 'parent-entry-absolute',
            skipRebuild: true,
            nodeStateOverrides: entryOverrides,
            ...(newPrefix !== undefined ? { newViewportPrefix: newPrefix } : {}),
          },
        };
      }
    }

    // If reparented but element left the parent, unparent back to canvas.
    // Bridge-aware: compute canvas-space CSS coords via findNodeRect.
    if (this.liveReparented && !this.enteredParentId) {
      const scale = context.transform.scale || 1;
      const exitVpId = this.lastHoverVpId || vpIdFromPrefix(context.viewportPrefix);
      const liveIframeOffset = getIframeOffset();
      for (const node of draggedNodes) {
        const elRect = findNodeRect(node.id, exitVpId);
        if (!elRect) continue;
        // Width/height come from the COMPUTED CSS box (offsetWidth-equivalent),
        // NOT the screen AABB. The AABB bakes in the element's transform —
        // committing it as `width`/`height` for a `transform: scale(2)` element
        // would set the layout box to 2x its real size, doubling the visible
        // result once the scale stays applied on top.
        const computed = findNodeComputedStyles(node.id, exitVpId, ['width', 'height']);
        const computedW = parseFloat(computed.width);
        const computedH = parseFloat(computed.height);
        const liftWidth = Number.isFinite(computedW) && computedW > 0 ? computedW : elRect.width / scale;
        const liftHeight = Number.isFinite(computedH) && computedH > 0 ? computedH : elRect.height / scale;
        // Position via the canvas-dnd `exitToCanvasRoot` formula: AABB top-
        // left + (aabbW - cssW) / 2 keeps the element's visual CENTER stable
        // when the layout box is smaller than the AABB (rotated / scaled).
        const { canvasLeft, canvasTop } = computeExitCanvasPosition(
          node.id, exitVpId, elRect, context.transform, liveIframeOffset, liftWidth, liftHeight,
        );
        const cssLeft = Math.round(canvasLeft);
        const cssTop = Math.round(canvasTop);
        traceTransformReparent('exit', {
          nodeId: node.id, vpId: exitVpId,
          elScreenRect: { ...elRect },
          cssLeft, cssTop, liftWidth, liftHeight,
        });

        const orig = this.originalTransforms.get(node.id) ?? '';
        const exitStyles: Record<string, string> = {
          position: 'absolute',
          left: `${cssLeft}px`,
          top: `${cssTop}px`,
          width: `${Math.round(liftWidth)}px`,
          height: `${Math.round(liftHeight)}px`,
          // Clear the per-frame drag translate atomically with the exit
          // commit (matches the per-node and entry paths above).
          transform: orig,
        };
        // Shared choreography: wipe stale @media rules (so the canvas
        // clone doesn't inherit display:none) + move to canvas root +
        // imperative cache sync (see entry-path comment for rationale).
        commitExitToCanvas({
          nodeId: node.id,
          styles: exitStyles,
          patch: { contentEl: context.contentEl, vpPrefix: context.viewportPrefix, styles: { transform: orig }, when: 'before-cache' },
        });
        // Update the in-memory dragged-node so subsequent onMove ticks treat
        // this as a top-level canvas node at canvas-space (cssLeft, cssTop).
        // No strategy switch fires here — we stay in CanvasDragStrategy — so
        // there's no rebuild to refresh these values via the override path.
        node.startLeft = cssLeft;
        node.startTop = cssTop;
        node.startParentId = null;
        // Anchor the translate baseline at the new canvas-space position.
        this.committedPos.set(node.id, { left: cssLeft, top: cssTop });
      }
      // Sync flush + force iframe re-render so the DOM parent actually
      // changes (see entry comment).
      flushExitToCanvas();
      // After updating start{Left,Top}, the next onMove must compute dx/dy
      // from the CURRENT mouse position so the element stays under cursor.
      // Otherwise dx grows from the original startMouse and the element
      // teleports by the cumulative pre-exit drag delta.
      context.startMouse = { x: this.prevMouse.x, y: this.prevMouse.y };
      this.liveReparented = false;
      parentHighlightOps.hide();
      trace.action('canvas-drag:code-first-exit', { nodeIds: draggedNodes.map(n => n.id) });
    }


    this.updateLayoutDropPreview(context, draggedIds, mouseScreen);

    return null; // no strategy switch
  }

  /** Drop-line / empty-layout preview for a confirmed layout parent entry.
   *  Drop line OR parent highlight (mutually exclusive): has children →
   *  drop line (shows insertion position); empty container → the
   *  empty-layout-drop affordance. Shared by the single-select containment
   *  tail and the multi-select group-layout path (which drives the same
   *  enteredParentId fields). */
  private updateLayoutDropPreview(context: DragContext, draggedIds: Set<string>, mouseScreen: Point): void {
    this.dropLineActive = false;
    if (this.enteredParentId && !this.liveReparented) {
      const vpId = this.lastHoverVpId || vpIdFromPrefix(context.viewportPrefix);
      // Bridge-aware layout detection (was reading el.style; el is null in iframe mode).
      const layout = detectParentLayoutById(this.enteredParentId, vpId);
      if (layout === 'flex' || layout === 'grid') {
        const direction = getFlexDirectionById(this.enteredParentId, vpId);
        const insertIndex = calculateLayoutInsertIndexById(
          mouseScreen,
          this.enteredParentId,
          vpId,
          direction === 'column' ? 'column' : 'row',
          draggedIds,
        );
        this.enteredInsertIndex = insertIndex;
        // Has REORDERABLE children? Exclude locked template chrome
        // (`layout::…` / `children-slot`) so a templated viewport whose only
        // children are the template's header/footer counts as EMPTY — it then
        // shows a single empty-layout drop affordance (the `{children}` slot)
        // instead of phantom drop-lines between the locked template nodes.
        const childRects = findChildRects(this.enteredParentId, vpId);
        const hasChildren = childRects.some(
          (c) => !draggedIds.has(c.id) && !c.id.startsWith('layout::') && c.id !== 'children-slot',
        );
        if (hasChildren) {
          dropLineOps.show({ parentId: this.enteredParentId, insertIndex, vpId });
          this.dropLineActive = true;
        } else {
          // Empty layout target — no siblings to draw a line between,
          // but the layout-drop preview IS active. Pin lines + snap
          // guides hide for the same UX reason as the with-children
          // case (`useDropLineActive` reads the layout-drop flag, not
          // just whether a line is showing).
          dropLineOps.markEmptyLayoutDrop();
        }
      }
    }
  }

  onEnd(context: DragContext): PendingUpdate[] {
    const updates: PendingUpdate[] = [];
    const isMultiSelect = context.draggedNodes.length > 1;

    // Drop the drag-only compositor-layer promotion from onStart (every drop path runs through here, before
    // its early returns). Keeping `will-change` after the drag would pin a layer per node and waste GPU memory.
    for (const node of context.draggedNodes) {
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { willChange: '' });
    }

    // ── Pending replica-extraction handoff (vp-only canvas-drop) ────────
    // A multi-vp replica drag-out registered a snapshot of the source's
    // pre-exit state. There are three ways it gets consumed:
    //
    //   1. Drop in a new parent (this strategy) ⇒ synced unparent —
    //      source already moved globally during drag, the new parent is
    //      its committed home, every vp renders it there. The snapshot
    //      is moot; clear it and let the regular reparent commit below
    //      run.
    //
    //   2. Drop on free canvas (this strategy) ⇒ VP-ONLY EXTRACTION.
    //      The user's intent shifted: they want this element REMOVED
    //      from the source viewport only. We:
    //        a. Revert the SOURCE to its original parent + index +
    //           styles + container overrides (every non-source vp
    //           snaps back to the pre-drag rendering).
    //        b. Add a FRESH canvas-node clone at the drop position,
    //           with `@container display:none` on every NON-source vp
    //           so the clone only shows on the source vp.
    //        c. Write `@container display:none` on the source for the
    //           source vp so the user's "this vp doesn't render it
    //           anymore" rule is honored.
    //
    //   3. Strategy switched to AbsoluteInFrameStrategy and dropped
    //      there ⇒ handled in AbsoluteInFrameStrategy.onEnd (clears the
    //      snapshot at the top).
    if (!isMultiSelect) {
      for (const node of context.draggedNodes) {
        const snap = getPendingReplicaExtraction(node.id);
        if (!snap) continue;
        const droppedInParent = !!this.enteredParentId;
        if (droppedInParent) {
          // Case 1: synced unparent — clear and fall through to the
          // normal reparent commit path below.
          clearPendingReplicaExtraction(node.id);
          trace.action('canvas-drag:clear-extraction-snapshot-on-parent-drop', { nodeId: node.id });
          continue;
        }
        // Case 2: vp-only canvas-drop extraction.
        const pos = this.lastPositions.get(node.id);
        const idMap = new Map<string, string>();
        const cloneRoot = buildCanvasCloneDescriptor(node.id, context.nodes, idMap);
        if (!cloneRoot) {
          // Defensive — should never happen for a node we just tracked.
          clearPendingReplicaExtraction(node.id);
          trace.error('canvas-drag:extraction-clone-build-failed', { nodeId: node.id });
          continue;
        }
        // Place the clone at the source's final canvas position.
        cloneRoot.styles = {
          ...cloneRoot.styles,
          position: 'absolute',
          left: `${pos?.left ?? 0}px`,
          top: `${pos?.top ?? 0}px`,
        };
        // Hide the clone on every NON-source viewport — the clone is
        // the per-vp extracted version, so only the source vp should
        // render it. Without these hides the clone would appear in
        // every viewport (default visibility for a fresh canvas node).
        //
        // The `addCanvasNode` is queued via queueMutation (not pushed
        // to `updates`) because PendingUpdate has no `addCanvasNode`
        // type — the only `add` variant is the toolbar-style one that
        // uses a different descriptor shape. Direct queueMutation
        // runs first in the mutation queue, exactly the order we want
        // (clone exists before subsequent style writes target it).
        queueMutation({ type: 'addCanvasNode', node: cloneRoot });
        // Extraction clone = fresh ids; copy the subtree's ::after
        // border-overlay rules onto them or the border is lost.
        queueBorderOverlayDuplicates(idMap);
        for (const otherVpId of Object.keys(getViewportWidths())) {
          if (otherVpId === snap.sourceVpId) continue;
          const otherWidth = getViewportWidths()[otherVpId] ?? 0;
          updates.push({
            nodeId: cloneRoot.id,
            type: 'updateContainerStyle',
            maxWidth: otherWidth,
            styles: { display: 'none' },
          });
        }
        // Revert source back to its original parent + index +
        // pre-drag styles. The exit had moved it to canvas-root with
        // canvas-space coords; this move snaps it back to where it
        // started for every non-source vp's rendering.
        updates.push({
          nodeId: node.id,
          type: 'move',
          newParentId: snap.originalParentId ?? undefined,
          newIndex: snap.originalIndex,
          styles: snap.originalStyles,
          canvasNode: false,
        });
        // Restore the source's @container overrides that the exit's
        // `clearContainerStyles` wiped. Each entry becomes a fresh
        // `updateContainerStyle` keyed by the original max-width.
        for (const [maxWidth, props] of snap.originalContainerOverrides) {
          const stylesObj: Record<string, string> = {};
          for (const [k, v] of props) stylesObj[k] = v;
          updates.push({
            nodeId: node.id,
            type: 'updateContainerStyle',
            maxWidth,
            styles: stylesObj,
          });
        }
        // Hide the source on the source vp so the per-vp extraction
        // shows ONLY the clone (otherwise the restored source would
        // re-render in the source vp at its original position next
        // to the clone — double image on that viewport).
        const sourceVpWidth = getViewportWidths()[snap.sourceVpId] ?? 0;
        updates.push({
          nodeId: node.id,
          type: 'updateContainerStyle',
          maxWidth: sourceVpWidth,
          styles: { display: 'none' },
        });
        clearPendingReplicaExtraction(node.id);
        trace.action('canvas-drag:vp-only-canvas-extraction', {
          sourceId: node.id, sourceVpId: snap.sourceVpId,
          cloneId: cloneRoot.id,
          revertParentId: snap.originalParentId,
          revertIndex: snap.originalIndex,
          dropLeft: pos?.left, dropTop: pos?.top,
          restoredOverrideVps: Array.from(snap.originalContainerOverrides.keys()),
        });
        // Skip the rest of onEnd for this drag — we've fully driven
        // the commit via the extraction mutations.
        dropLineOps.hide();
        parentHighlightOps.hide();
        this.resetState();
        return updates;
      }
    }

    // ── Consolidation-clone handoff ─────────────────────────────────────
    // When AbsoluteInFrameStrategy detected a multi-vp visible drag-out
    // from a replica, it created a CLONE at canvas root and registered
    // {sourceId, sourceVpId, sourceParentId} in the consolidation store.
    // The user's drag has been visually following the clone; on mouseup
    // we consolidate:
    //   - Drop in a flex/grid parent: move SOURCE there with insert
    //     index. Per-vp overrides on source survive; all viewport
    //     replicas re-derive at the new spot.
    //   - Drop in a no-layout parent: move SOURCE there with absolute
    //     parent-relative coords (clone's screen rect → parent local).
    //   - Drop on canvas free space: do nothing destructive — source
    //     stays where it was. Clone is removed.
    // Always remove the clone and clear the registry entry.
    const consolidations: Array<{ cloneId: string; info: ReturnType<typeof getConsolidationClone> }> = [];
    if (!isMultiSelect) {
      for (const node of context.draggedNodes) {
        const info = getConsolidationClone(node.id);
        if (info) consolidations.push({ cloneId: node.id, info });
      }
    }
    if (consolidations.length > 0) {
      const { cloneId, info } = consolidations[0];
      if (!info) {
        // Type narrowing — we already filtered nulls above, but TS
        // doesn't know. Treat as no-consolidation.
      } else {
        const droppedInParent = !!this.enteredParentId;
        if (droppedInParent) {
          // SYNCED-UNPARENT model: a replica drag that ends in a new
          // parent is a regular reparent — the source JSX element
          // moves once and every viewport renders it at the new
          // location. The user's words: "when I unparent on a
          // replica it actually needs to unparent from all the
          // replicas, the replica is completely synced in the
          // unparenting".
          //
          // The vp-only-extraction model ONLY applies when the same
          // drag ends on free canvas — handled in the else branch
          // below.
          //
          // We move the SOURCE (not the clone), revert the source-vp
          // hide we wrote at drag-exit, and remove the clone (it was
          // a visual aid for the canvas-drop case that never
          // happened).
          //
          // We ALSO clear `display: none` on the source for EVERY
          // viewport — a synced unparent is a fresh placement and any
          // drag-time hide that may have lingered (or a pre-existing
          // per-vp hide that the user's "no hidden in other
          // viewport" rule says shouldn't survive the unparent) gets
          // wiped so the element shows in every vp at the new spot.
          const dropVpId = this.enteredVpId || vpIdFromPrefix(context.viewportPrefix);
          const parentLayout = detectParentLayoutById(this.enteredParentId!, dropVpId);
          if (parentLayout === 'flex' || parentLayout === 'grid') {
            // Pin to `0 0 auto` when entering a flex parent (unless it already
            // sizes itself) — else the flow child shrinks to ~0 and collapses.
            const enterFlex = flexForFlowChildEnteringFlex(context.nodes.get(info.sourceId)?.styles, parentLayout);
            updates.push({
              nodeId: info.sourceId,
              type: 'move',
              newParentId: this.enteredParentId!,
              newIndex: this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : undefined,
              // Anchor by SIBLING ID too — the visual index splices wrong in
              // JSX space once CSS `order` diverges from source order (see
              // computeLayoutInsertAnchorId).
              insertBeforeId: this.enteredInsertIndex >= 0
                ? computeLayoutInsertAnchorId(this.enteredParentId!, dropVpId, this.enteredInsertIndex, [info.sourceId], (id) => context.nodes.get(id)?.styles?.order)
                : undefined,
              styles: { position: 'relative', left: '', top: '', right: '', bottom: '', ...(enterFlex ? { flex: enterFlex } : {}) },
            });
            // Renumber siblings if the parent has explicit `order` styles —
            // see "Renumber sibling `order` styles" comment in the regular
            // layout-entry path below for the rationale.
            const direction = getFlexDirectionById(this.enteredParentId!, dropVpId);
            const orderUpdates = computeLayoutInsertOrderUpdates(
              this.enteredParentId!,
              dropVpId,
              this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : 0,
              [info.sourceId],
              direction === 'column' ? 'column' : 'row',
              (id) => context.nodes.get(id)?.styles?.order,
            );
            // Routed via `commitOrderAssignments` for the same reason the
            // regular layout-entry path below does it — a raw `type: 'style'`
            // order lands in `variants[X].order` on a component master's
            // variant tile (user report 2026-07-27).
            updates.push(...commitOrderAssignments(orderUpdates, context.contentEl, dropVpId));
            // Viewports with an INDEPENDENT @media order map need their own
            // band write for the inserted node — see
            // computeReplicaOrderMirrorUpdates ("tablet jumped way above").
            updates.push(...computeReplicaOrderMirrorUpdates({
              draggedIds: [info.sourceId],
              desiredVisualOrder: buildDesiredVisualOrder(this.enteredParentId!, dropVpId, this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : 0, [info.sourceId], (id) => context.nodes.get(id)?.styles?.order),
              getNodeStyles: (id) => context.nodes.get(id)?.styles,
              overrides: getDefaultStore().get(containerOverridesAtom),
              vpWidths: getViewportWidths(),
              dropVpId,
            }));
          } else {
            // No-layout parent: convert clone's canvas position back to
            // parent-relative coords. Use the clone's live screen rect
            // (it's still mounted at canvas root at this point) and the
            // entered parent's screen rect.
            const cloneRect = findNodeRect(cloneId, vpIdFromPrefix(context.viewportPrefix));
            const parentRect = findNodeRect(this.enteredParentId!, dropVpId);
            const scale = context.transform.scale || 1;
            const relX = cloneRect && parentRect
              ? Math.round((cloneRect.left - parentRect.left) / scale)
              : 0;
            const relY = cloneRect && parentRect
              ? Math.round((cloneRect.top - parentRect.top) / scale)
              : 0;
            updates.push({
              nodeId: info.sourceId,
              type: 'move',
              newParentId: this.enteredParentId!,
              styles: { position: 'absolute', left: `${relX}px`, top: `${relY}px` },
            });
          }
          // Wipe every per-vp `display: none` on the source so a
          // synced unparent ends with the element showing in every
          // viewport. Covers the drag-exit-time write on source vp
          // AND any pre-existing hide on a non-source vp. Empty
          // value = remove the property from the @container rule
          // (codebase-wide convention).
          for (const vpId of Object.keys(getViewportWidths())) {
            const vpWidth = getViewportWidths()[vpId] ?? 0;
            updates.push({
              nodeId: info.sourceId,
              type: 'updateContainerStyle',
              maxWidth: vpWidth,
              styles: { display: '' },
            });
          }
          // Drop in parent: clone was just a visual aid, remove it.
          updates.push({ nodeId: cloneId, type: 'remove' });
          trace.action('canvas-drag:consolidate-synced-unparent', {
            cloneId, sourceId: info.sourceId, sourceVpId: info.sourceVpId,
            parentId: this.enteredParentId, parentLayout,
          });
        } else {
          // Drop on canvas free space — the user wants to extract just
          // this replica's instance into a brand-new canvas node. KEEP
          // the clone (it now lives at canvas root with its own fresh
          // data-id, survives as an independent element). Commit its
          // final position via a `style` update so left/top in JSX
          // matches the mouseup spot. KEEP the source-vp
          // `@container display:'none'` we wrote on exit so the
          // original source no longer renders in the dragged-out
          // replica (primary + other replicas keep rendering it).
          const pos = this.lastPositions.get(cloneId);
          if (pos) {
            updates.push({
              nodeId: cloneId,
              type: 'style',
              styles: { left: `${pos.left}px`, top: `${pos.top}px` },
            });
          }
          trace.action('canvas-drag:consolidate-canvas-drop-keep-clone', {
            cloneId, sourceId: info.sourceId, sourceVpId: info.sourceVpId,
            sourceVpStaysHidden: !!info.sourceVpHidden,
            cloneFinalLeft: pos?.left, cloneFinalTop: pos?.top,
          });
        }
        clearConsolidationClone(cloneId);

        // Skip the rest of the normal onEnd path.
        dropLineOps.hide();
        parentHighlightOps.hide();
        this.resetState();
        return updates;
      }
    }

    // ATOMIC final-state inline patch: write { left, top, transform: orig }
    // for each node in ONE patchNodeStyles call. If we cleared transform
    // FIRST and committed left/top via the mutation queue afterward, there
    // would be a 1+ frame gap where inline transform is empty but JSX
    // (and so inline left/top) still held the lift position — visible as
    // an ugly snap-back to lift then snap-forward to final. Doing both in
    // one patch keeps the visual state continuous from the last drag
    // frame to the rendered final position.
    for (const node of context.draggedNodes) {
      const orig = this.originalTransforms.get(node.id) ?? '';
      const pos = this.lastPositions.get(node.id);
      const finalStyles: Record<string, string> = { transform: orig };
      if (pos) {
        finalStyles.left = `${pos.left}px`;
        finalStyles.top = `${pos.top}px`;
      }
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, finalStyles);
    }
    // NO originalTransforms.clear() here — the commit loops BELOW still read
    // it (`transform: orig` in the canvas-drop + reparent updates). Clearing
    // early made every later read '' → the code commit wrote `transform: ''`
    // and a rotated node dropped on canvas lost its rotation on mouse-up
    // (exit-from-frame trace 2026-07-29: exit committed rotate() correctly,
    // the drop commit then erased it). Cleared in resetState() after all
    // update-building is done.

    // Multi-select GROUP-LAYOUT drop: a confirmed cursor layout target routes
    // the WHOLE selection through the layout-parent commit branch below — it
    // already loops draggedNodes, anchors by sibling id, renumbers `order`,
    // and mirrors replica bands. Only per-node absolute reparents (and plain
    // canvas moves) take the per-node branch. `liveReparented` is never set
    // by the multi path, so the code-first sub-branch stays single-only.
    const multiLayoutDrop = isMultiSelect && !!this.enteredParentId && !this.liveReparented;
    if (isMultiSelect && !multiLayoutDrop) {
      // ─── Multi-select: per-node updates based on individual parent state ───
      for (const node of context.draggedNodes) {
        const rState = this.nodeReparentStates.get(node.id);
        const pos = this.lastPositions.get(node.id);

        if (rState?.reparented && rState.confirmedParentId) {
          // Node was reparented into a frame — commit as move
          const relX = pos?.left ?? 0;
          const relY = pos?.top ?? 0;

          trace.action('canvas-drag:per-node-commit-move', {
            nodeId: node.id, parentId: rState.confirmedParentId,
            relX, relY,
          });

          updates.push({
            nodeId: node.id,
            type: 'move',
            newParentId: rState.confirmedParentId,
            styles: {
              position: 'absolute',
              left: `${relX}px`,
              top: `${relY}px`,
            },
            // canvas-node entering a viewport tree — see the same
            // explanation above the live-entry move site.
            canvasNode: false,
          });
        } else {
          // Node still on canvas — normal style commit
          const pos = this.lastPositions.get(node.id);
          if (pos) {
            updates.push({
              nodeId: node.id,
              type: 'style',
              styles: { left: `${pos.left}px`, top: `${pos.top}px` },
            });
          }
        }
      }
    } else if (this.enteredParentId) {
      // ─── Single-select: existing reparent logic ───
      // (enteredParentEl may be null in iframe mode — we use IDs throughout.)

      if (this.liveReparented) {
        // Code-first entry: move + replica hides already committed via flushNow() during onMove.
        // Only need to commit final position (left/top from continued dragging after entry).
        for (const node of context.draggedNodes) {
          const pos = this.lastPositions.get(node.id);
          if (!pos) continue;
          updates.push({
            nodeId: node.id,
            type: 'style',
            styles: { left: `${pos.left}px`, top: `${pos.top}px` },
          });
        }
        trace.action('canvas-drag:code-first-entry-onEnd', {
          nodeIds: context.draggedNodes.map(n => n.id),
          parentId: this.enteredParentId,
        });
      } else {
        // Layout parent entry (flex/grid) — move not yet committed, produce deferred updates
        const dropVpId = this.enteredVpId || vpIdFromPrefix(context.viewportPrefix);
        const parentLayout = detectParentLayoutById(this.enteredParentId, dropVpId);
        // When entering a non-primary replica's flex/grid parent, the move
        // mutation must include inline `display:'none'` (so primary is hidden
        // via inline, not via a desktop @container catch-all that bleeds
        // across all widths). The `@container display:'unset'` write below
        // overrides this for the entered viewport.
        const enteringNonPrimaryFlexVp = !isPrimaryViewport(dropVpId);
        // Component master file: variant visibility is handled by the
        // `setVariantVisibility` mutation (AnimatePresence wrapper +
        // conditional render). Skip the legacy inline `display: 'none'` +
        // variant `display: 'unset'` writes — those produce a sloppy
        // dual-pattern (wrapper AND variants[X].display = 'none') and the
        // baked-in inline display freezes into `variants.default` via
        // `ensureDefaultHasBaseValues`. Page replicas keep the legacy
        // routing (no AnimatePresence on pages — `@container` rules drive
        // per-viewport visibility).
        const isComponentFile = isComponentFilePath(getActiveFilePath());

        trace.action('canvas-drag:reparent-into-frame', {
          nodeIds: context.draggedNodes.map(n => n.id),
          parentId: this.enteredParentId,
          parentLayout,
          enteringNonPrimaryFlexVp,
        });

        // Commit order = VISUAL order along the container's main axis, not
        // selection order. Every node shares one insertBeforeId anchor, so
        // queue order becomes sibling order — a multi-drop then lands the
        // nodes in the order the user sees them on screen. Screen rects
        // (live AABBs) are the one space all dragged nodes share.
        const commitNodes = [...context.draggedNodes];
        if (isMultiSelect && (parentLayout === 'flex' || parentLayout === 'grid')) {
          const sortDirection = getFlexDirectionById(this.enteredParentId, dropVpId);
          const sortVpId = vpIdFromPrefix(context.viewportPrefix);
          const axisOf = (n: { id: string }) => {
            const r = findNodeRect(n.id, sortVpId);
            return sortDirection === 'column' ? (r?.top ?? 0) : (r?.left ?? 0);
          };
          commitNodes.sort((a, b) => axisOf(a) - axisOf(b));
        }

        for (const node of commitNodes) {
          if (parentLayout === 'flex' || parentLayout === 'grid') {
            const moveStyles: Record<string, string> = {
              position: 'relative',
              left: '', top: '', right: '', bottom: '',
              // Clear the per-frame drag `transform: translate(dx,dy)` (or restore
              // the node's AUTHORED transform). Without this, reparentLive moves
              // the node into the flex slot but it stays visually TRANSLATED to the
              // drop-cursor spot until the commit render clears the inline transform
              // — which on a big page lands ~250ms later (parse + code-derived-atom
              // cascade), i.e. the "~1s to insert on mouseup" delay. The absolute-in-
              // frame entry already resets `transform: orig`; flex/grid must too so
              // the node SNAPS into its slot instantly on the reparentLive move.
              transform: this.originalTransforms.get(node.id) ?? '',
            };
            // Component instances skip the inline `display:'none'` —
            // inline gets merged onto the inner root via `expandComponent`,
            // so the wrapper's `@media display:'unset'` would never reach
            // the inner root and the embed renders blank. Page-replica
            // bounded `@media` hides cover the primary range on their own.
            // (Same exception as ToolbarDragStrategy + the no-layout
            // entry path above.)
            const draggedNode = context.nodes.get(node.id);
            // Pin to `0 0 auto` when entering a flex parent (unless it already
            // sizes itself) — else the flow child shrinks to ~0 and collapses
            // (the "disappears on drop into a flex layout" bug).
            const enterFlex = flexForFlowChildEnteringFlex(draggedNode?.styles, parentLayout);
            if (enterFlex) moveStyles.flex = enterFlex;
            // Both design-component instances (`isComponentInstance`) and
            // code-component / code component instances (`isCodeComponent`) need the
            // same wrapper-vs-inner-root treatment. Code components are
            // skipped by `expandComponent` (project-parser.ts:91) so they
            // never get the `isComponentInstance` flag — checking only
            // that field misses them and the legacy "inline display:none +
            // unset !important" path runs, which collapses the wrapper to
            // `display: inline` (zero-area) for the entered viewport.
            const isInstance =
              draggedNode?.isComponentInstance === true ||
              draggedNode?.isCodeComponent === true;
            // Component master files use AnimatePresence (setVariantVisibility)
            // for variant visibility — skip the legacy inline display:'none'.
            if (enteringNonPrimaryFlexVp && !isInstance && !isComponentFile) moveStyles.display = 'none';
            updates.push({
              nodeId: node.id,
              type: 'move',
              newParentId: this.enteredParentId,
              newIndex: this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : undefined,
              // Anchor by SIBLING ID too — see computeLayoutInsertAnchorId.
              insertBeforeId: this.enteredInsertIndex >= 0
                ? computeLayoutInsertAnchorId(this.enteredParentId, dropVpId, this.enteredInsertIndex, context.draggedNodes.map(n => n.id), (id) => context.nodes.get(id)?.styles?.order)
                : undefined,
              styles: moveStyles,
            });
          } else {
            // Fallback handled below — see "Fallback: non-layout entry"
          }
        }

        // Renumber sibling `order` styles when the parent's children carry
        // explicit `order` (set by prior reorder operations). Without this,
        // the JSX-inserted dragged element defaults to `order: 0` and
        // visually lands at the top of the order:0 group instead of where
        // the drop-line indicator showed. Empty result = no explicit
        // orders; JSX position alone determines visual layout.
        if (parentLayout === 'flex' || parentLayout === 'grid') {
          const direction = getFlexDirectionById(this.enteredParentId, dropVpId);
          const orderUpdates = computeLayoutInsertOrderUpdates(
            this.enteredParentId,
            dropVpId,
            this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : 0,
            context.draggedNodes.map(n => n.id),
            direction === 'column' ? 'column' : 'row',
            (id) => context.nodes.get(id)?.styles?.order,
          );
          if (orderUpdates.length > 0) {
            // Route through `commitOrderAssignments` so component master
            // replicas emit `setConditionalOrder` (variant ternary in
            // inline style) instead of raw `type: 'style'`. Without this,
            // the writes go through `updateNodeStyles` and get routed to
            // `variants[X].order = N` — framer-motion then tweens `order`
            // as a float, CSS truncates → no flex reflow during the
            // transition → visible JUMP. The ternary in inline style is
            // evaluated at React render → instant integer change → CSS
            // reflows → layout={true} FLIP animates the position smoothly.
            updates.push(...commitOrderAssignments(orderUpdates, context.contentEl, dropVpId));
          }
          // Viewports with an INDEPENDENT @media order map need their own
          // band write for the inserted node(s) — see
          // computeReplicaOrderMirrorUpdates ("tablet jumped way above").
          updates.push(...computeReplicaOrderMirrorUpdates({
            draggedIds: context.draggedNodes.map(n => n.id),
            desiredVisualOrder: buildDesiredVisualOrder(this.enteredParentId, dropVpId, this.enteredInsertIndex >= 0 ? this.enteredInsertIndex : 0, context.draggedNodes.map(n => n.id), (id) => context.nodes.get(id)?.styles?.order),
            getNodeStyles: (id) => context.nodes.get(id)?.styles,
            overrides: getDefaultStore().get(containerOverridesAtom),
            vpWidths: getViewportWidths(),
            dropVpId,
          }));
        }

        for (const node of context.draggedNodes) {
          if (parentLayout === 'flex' || parentLayout === 'grid') {
            // Already pushed above; skip.
          } else {
            // Fallback: non-layout entry that wasn't live-reparented.
            // Compute parent-local coords from the node's screen rect (bridge)
            // minus the parent's screen origin (bridge).
            const elRect = findNodeRect(node.id, dropVpId);
            const parentRect = findNodeRect(this.enteredParentId, dropVpId);
            const scale = context.transform.scale || 1;
            const relX = elRect && parentRect
              ? Math.round((elRect.left - parentRect.left) / scale)
              : 0;
            const relY = elRect && parentRect
              ? Math.round((elRect.top - parentRect.top) / scale)
              : 0;
            updates.push({
              nodeId: node.id,
              type: 'move',
              newParentId: this.enteredParentId,
              styles: {
                position: 'absolute',
                left: `${relX}px`,
                top: `${relY}px`,
              },
            });
          }
        }

        // Replica hides for layout entry (non-code-first path) — still deferred.
        // When dropping into a non-primary viewport, hide in all OTHER viewports
        // so the element appears ONLY in the target replica. Source of truth:
        // viewport store (parent contentEl is empty in iframe mode).
        // For PAGE replicas, `hideInAllOthers` writes `@container display:none`
        // for every other viewport — including the primary's `@container
        // (max-width: <desktopWidth>)` rule, which is the catch-all that
        // matches at ALL widths. Without an explicit `@container display:'unset'`
        // for the ENTERED viewport, the desktop catch-all hides the element
        // everywhere — visible symptom: drop succeeds, source moves into the
        // hero in JSX, but no viewport shows it. Selection then resolves
        // against a hidden element with offsetWidth=0 and the overlay
        // floats at stale coords.
        const enteredVp = this.enteredVpId || vpIdFromPrefix(context.viewportPrefix);
        if (!isPrimaryViewport(enteredVp)) {
          const vpWidths = getViewportWidths();
          const rctx = getReplicaContext(enteredVp, getActiveFilePath(), vpWidths);
          for (const node of context.draggedNodes) {
            if (rctx.isComponent) {
              // Component variant entry: `setVariantVisibility` (emitted by
              // `hideInAllOthers`) wraps the element in `<AnimatePresence>`
              // + conditional render. The wrapper handles hide on every
              // OTHER variant; no inline `display: 'none'` or variant
              // `display: 'unset'` write needed. Emitting them creates the
              // dual-pattern bug where variants[X].display tweens the
              // float — observable as a JUMP on variant transition.
              updates.push(...rctx.hideInAllOthers(node.id));
            } else {
              // Page replica: write `@container display:'unset'` for the
              // entered vp's max-width so the entered viewport overrides
              // any inherited display rule. The PRIMARY's hide is the
              // INLINE `display:'none'` that the move mutation above
              // already set — DON'T also write a primary `@container`
              // rule. The desktop @media has no `min-width` (it's the
              // largest breakpoint) so its display:none would match at
              // every width and override the entered viewport's
              // display:unset depending on serializer order. The user
              // also needs the inline write to be visible/editable in the
              // JSX panel — burying the hide in a @container rule means
              // they can't unhide by toggling an inline style.
              //
              // Component instances skip the unhide entirely — they
              // also skipped the inline display above, so there's
              // nothing to override on the entered viewport. Writing
              // `display: 'unset' !important` would force the wrapper
              // to `display: inline` (CSS `unset` resolves to initial
              // = `inline` when an !important author rule beats the UA
              // stylesheet) and inline boxes ignore width/height.
              const draggedNode = context.nodes.get(node.id);
              const isInstance =
                draggedNode?.isComponentInstance === true ||
                draggedNode?.isCodeComponent === true;
              if (!isInstance) {
                updates.push({
                  nodeId: node.id,
                  type: 'updateContainerStyle',
                  maxWidth: vpWidths[enteredVp] ?? 0,
                  styles: { display: 'unset' },
                });
              }
              // For component instances we skipped the inline `display:'none'`
              // above, so the primary's @container hide must be kept — it's
              // the only thing keeping the instance hidden on the primary
              // range. Regular tags keep the original "skip primary
              // @container" optimization.
              for (const hideUpdate of rctx.hideInAllOthers(node.id)) {
                if (hideUpdate.type !== 'updateContainerStyle') {
                  updates.push(hideUpdate);
                  continue;
                }
                if (!isInstance) {
                  const targetVpId = Object.keys(vpWidths).find(
                    k => vpWidths[k] === hideUpdate.maxWidth,
                  );
                  if (targetVpId && isPrimaryViewport(targetVpId)) continue;
                }
                updates.push(hideUpdate);
              }
            }
          }
          // Selection / pin-line / write-routing all key off
          // interactingViewportIdAtom. The drop just made the element
          // visible ONLY in `enteredVp`; querying its rect from
          // 'desktop' (where it's now display:'none') resolves to a
          // zero-size rect and the SelectionOverlay floats at stale
          // coords. Same fix as the canvas-node-into-replica entry path.
          window.dispatchEvent(new CustomEvent('revyme:set-interacting-viewport', {
            detail: { vpId: enteredVp },
          }));
          trace.action('canvas-drag:hide-in-other-variants', {
            enteredVp,
            allVps: Object.keys(vpWidths),
            nodeIds: context.draggedNodes.map(n => n.id),
          });
        }
      }
    } else {
      // ─── Normal canvas style commit ───
      for (const node of context.draggedNodes) {
        const pos = this.lastPositions.get(node.id);
        if (!pos) continue;

        // Apply the FINAL position IMPERATIVELY via the bridge (left/top +
        // clear the per-frame drag `transform`). In iframe mode the canvas
        // DOM lives in the sandbox, so the code commit's position only
        // reaches the DOM through a full re-render — but the render (+ its
        // full measure) is the ~130ms drop settle on a big page. Patching
        // here makes the DOM fully correct NOW: the `transform` write is a
        // subtree-refresh prop so it also re-emits the node's rect (keeps
        // the selection overlay exact), and clearing it keeps the NEXT drag
        // of this node from composing on a stale translate. The orchestrator
        // then marks the drop canvas-safe so the redundant render skips —
        // the parse still runs for panels/undo. `type:'style'` with only
        // left/top/transform is the signal commitUpdates keys off.
        const orig = this.originalTransforms.get(node.id) ?? '';
        patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, {
          left: `${pos.left}px`, top: `${pos.top}px`, transform: orig,
        });
        updates.push({
          nodeId: node.id,
          type: 'style',
          styles: { left: `${pos.left}px`, top: `${pos.top}px`, transform: orig },
        });
      }
    }

    // Replica visibility is handled during drag via flushNow() in entry/reparent paths.

    // Clear visual stores
    dropLineOps.hide();
    parentHighlightOps.hide();

    this.resetState();
    return updates;
  }

  getDropViewportId(context: DragContext): string {
    return this.enteredVpId || vpIdFromPrefix(context.viewportPrefix);
  }

  onCancel(context: DragContext): void {
    // The variant hide this gesture painted was never committed — undo it, or
    // the copy stays invisible in tiles the reverted code says are visible.
    // `onEnd` deliberately does NOT do this: there the drop DID commit the
    // hide, so what we painted already matches the code and clearing it would
    // un-hide the primary copy right where the user reported seeing it.
    this.restoreAllLiveVariantHides(context.contentEl);
    // Restore each node to its lift state — original transform + lift
    // left/top — so the element snaps back exactly where it started.
    for (const node of context.draggedNodes) {
      const orig = this.originalTransforms.get(node.id) ?? '';
      // `willChange: ''` clears the onStart drag-only compositor-layer promotion.
      const styles = { left: `${node.startLeft}px`, top: `${node.startTop}px`, transform: orig, willChange: '' };
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, styles);
      // If a consolidation clone was registered for this drag, the user
      // cancelled before mouseup. Remove the clone JSX and clear the
      // registry so a future drag doesn't see stale state.
      const cInfo = getConsolidationClone(node.id);
      if (cInfo) {
        queueMutation({ type: 'removeNode', nodeId: node.id });
        // Revert the source-vp hide we wrote on exit so the source
        // re-appears in its original viewport — the user cancelled.
        if (cInfo.sourceVpHidden) {
          const sourceVpWidth = getViewportWidths()[cInfo.sourceVpId] ?? 0;
          queueMutation({
            type: 'updateContainerStyle',
            nodeId: cInfo.sourceId,
            maxWidth: sourceVpWidth,
            styles: { display: '' },
          });
        }
        clearConsolidationClone(node.id);
      }
      // Pending replica-extraction snapshot from a multi-vp replica
      // drag: the user cancelled mid-drag. Revert the source: move
      // back to original parent + restore original styles + restore
      // original container overrides. The exit had moved it to canvas-
      // root with canvas-space coords; this undoes that so cancel
      // leaves the user where they started visually.
      const pSnap = getPendingReplicaExtraction(node.id);
      if (pSnap) {
        queueMutation({
          type: 'move',
          nodeId: node.id,
          newParentId: pSnap.originalParentId,
          index: pSnap.originalIndex,
          styles: pSnap.originalStyles,
          canvasNode: false,
        });
        for (const [maxWidth, props] of pSnap.originalContainerOverrides) {
          const stylesObj: Record<string, string> = {};
          for (const [k, v] of props) stylesObj[k] = v;
          queueMutation({
            type: 'updateContainerStyle',
            nodeId: node.id,
            maxWidth,
            styles: stylesObj,
          });
        }
        clearPendingReplicaExtraction(node.id);
      }
      // queueMutation directly is fine for cancel since we're not
      // returning PendingUpdates; the cancel path doesn't go through
      // commitDragUpdates.
    }
    dropLineOps.hide();
    parentHighlightOps.hide();
    this.resetState();
  }

  private resetState(): void {
    // Per-gesture transform/pos snapshots — cleared HERE, after every commit
    // loop that reads them (never mid-onEnd; see the premature-clear bug note
    // in the atomic final-patch section).
    this.originalTransforms.clear();
    this.committedPos.clear();
    // Bookkeeping only — the DOM restore, when one is owed, already ran in
    // `onCancel`. See `mirrorVariantSoloHideLive`.
    this.liveVariantHides.clear();
    this.enteredParentId = null;
    this.enteredParentEl = null;
    this.enteredVpId = 'desktop';
    this.lastHoverVpId = undefined;
    this.dropLineActive = false;
    this.framesInCandidateParent = 0;
    this.candidateParentId = null;
    this.entryConfirmed = false;
    this.liveReparented = false;
    this.enteredInsertIndex = -1;
    this.multiEntryDetector = null;
    this.nodeReparentStates.clear();
  }
}
