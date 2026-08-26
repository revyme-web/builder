// GridDragStrategy.ts — Drag-to-swap inside CSS Grid containers.
//
// Model: SWAP-ON-CELL-ENTRY. Each time the cursor crosses into a new
// grid cell, the dragged element's placeholder swaps positions with
// whatever sibling is in that cell. One swap per cell-entry, never per
// frame — that's what kills oscillation.
//
// Two swap mechanisms depending on grid type:
//   - AUTO-FLOW grid (no inline gridColumn/Row on any child): swap by
//     reordering DOM children. Browser auto-flow re-paints them in
//     each other's cells.
//   - EXPLICIT grid (at least one child has authored gridColumn/Row):
//     swap by exchanging the inline `gridColumn`/`gridRow` values
//     between placeholder and target. DOM order is irrelevant.
//
// State machine per drag:
//   1. onStart — lift dragged into canvas-space, create placeholder in
//      original cell, async-prefetch the grid template + per-child
//      computed placement (gridTemplateColumns etc. aren't in the
//      bridge's default CACHED_PROPS, so a sync read returns empty).
//   2. onMove — track the cursor, compute current cell from mouse +
//      parent rect + grid template. If cell key changed since last
//      frame AND a different sibling occupies it, perform a single
//      swap and remember the cell key.
//   3. onEnd — commit changes: a single `reorder` mutation for auto-
//      flow, per-child `style` mutations for explicit. Restore lifted
//      element styles so the next render cycle places it cleanly.
//   4. onCancel — restore everything; emit nothing.

import type { Point, PendingUpdate } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';
import type { DragContext, DragStrategy, DragMoveResult } from '../types';
import { commitOrderAssignments } from './order-commit';
import { repositionSignalOps } from '../reposition-signal';
import { computeReorderAssignments } from '../reparent-utils';
import {
  findNodeRect, findNodeComputedStyles, findChildRects, patchNodeStyles,
  getViewportPrefix, vpIdFromPrefix, getNodeHitsAtPoint, forceCanvasRender, parseRectCacheKey, forceCanvasRenderDeferredDuringDrag, isPrimaryViewport, getActiveFilePath } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getIframeOffset } from '../helpers/coords';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { trace } from '@/shared/debug-trace';
import { parseGridInfo, type GridInfo } from './grid-cell-resolver';
import { isReplicaOnlyOnViewport } from '../replica-exit';
import { getReplicaContext } from '../replica-context';
import { buildCanvasCloneForLayoutDrop } from './LayoutLiftedStrategy';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { queueMutation, flushNow, flushNowDeferredDuringDrag } from '@/code/mutation/mutation-queue';
import { moveNodeInCache, updateNodeInCache, getNodeFromCache } from '@/code/stores/store';
import { nodeAcceptsChildren } from '@/shared/constants';
import { calculateSnap, getMouseVelocity } from '../handlers/snap-handler';
import { SNAP_THRESHOLD } from '@/shared/constants';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import type { Rect } from '@/shared/types';

const PLACEHOLDER_BG = 'rgba(59, 130, 246, 0.15)';
const PLACEHOLDER_RADIUS = '4px';

interface InlinePlacement {
  gridColumn: string;
  gridRow: string;
  gridArea: string;
}

export class GridDragStrategy implements DragStrategy {
  readonly name = 'grid';

  // ── Identity ─────────────────────────────────────────────────────────────
  private parentId = '';
  private liftedNodeId = '';
  private placeholderId = '';
  private vpId = '';
  private vpPrefix = '';
  private contentEl: HTMLElement | null = null;

  // ── Sibling tracking ─────────────────────────────────────────────────────
  /** Children of the parent at drag start, in DOM order, with the lifted
   *  node EXCLUDED. */
  private remainingSiblings: string[] = [];
  /** ALL children at drag start in DOM order — including the lifted node.
   *  Source-order baseline for computing the onEnd commit diff. */
  private originalChildOrder: string[] = [];
  /** Desired final DOM order. Starts as `originalChildOrder`; each swap
   *  exchanges the lifted node's slot with the target's. At onEnd we
   *  diff this against `originalChildOrder` and emit reorder mutations
   *  for every child whose index differs. */
  private finalOrder: string[] = [];
  /** Lifted node's index in the FULL child list at drag start — used to
   *  decide whether a reorder is even needed at onEnd. */
  private startIndex = -1;

  // ── Lift geometry (canvas-space CSS px) ──────────────────────────────────
  // `bridge.liftNode` reparents the element to `contentRoot` so it
  // ESCAPES the parent's `transform` (rotate / scale). Without this,
  // in-place lifting inherits the parent's transform and the mouse
  // delta moves the element in a rotated axis — drag goes the wrong
  // way for rotated grids. Same model `LayoutLiftedStrategy` uses for
  // flex children, and `restoreNode` puts the element back on drop.
  private liftLeft = 0;
  private liftTop = 0;
  private liftWidth = 0;
  private liftHeight = 0;
  private startMouseX = 0;
  private startMouseY = 0;
  /** Latest mouseScreen + canvas transform snapshot from onMove. The
   *  resize-overlay path that consumed these was removed (per user
   *  feedback the mid-drag size change was too subtle); they're kept
   *  in case future logic needs cursor-in-canvas math without
   *  threading context through every call site. */
  private currentMouseX = 0;
  private currentMouseY = 0;
  private currentScale = 1;
  private canvasTransformX = 0;
  private canvasTransformY = 0;
  /** Snapshot of the lifted node's inline styles for the props we touch
   *  during lift (position, left, top, width, height, zIndex, etc.).
   *  React sets these via `style={{...}}` in JSX, so we can't just CLEAR
   *  them on unlift — that'd leave the element with UA-default `width:
   *  auto; height: auto` and it'd collapse to 0×0 (empty div, no
   *  content). We have to restore each prop to its source value. */
  private liftedOriginalInline: Record<string, string> = {};

  // ── Grid state ───────────────────────────────────────────────────────────
  private gridInfo: GridInfo | null = null;
  /** Each child's inline `gridColumn`/`gridRow`/`gridArea` at drag start.
   *  Used for explicit-grid swap restore + onEnd diff. */
  private originalPlacements = new Map<string, InlinePlacement>();
  /** ORDER-STYLE mode. The builder stamps every flex/grid child with an
   *  inline `order` (oracle: FLEX_CHILD_MISSING_ORDER), and CSS `order`
   *  BEATS DOM position in grid auto-flow. The strategy's DOM-swap +
   *  JSX-reorder model predates that: with ordered children the mid-drag
   *  DOM swaps were visually INVISIBLE and the committed JSX reorder
   *  changed nothing on screen (user report 2026-07-27 — "doesn't reorder
   *  during drag or on mouseup"). When any child carries an inline order,
   *  swaps exchange ORDER VALUES instead, and the commit re-stamps
   *  sequential orders through the shared replica-aware router. */
  private hasOrderStyles = false;
  /** Inline `order` per child at drag start (dragged's keyed by its id). */
  private originalOrders = new Map<string, string>();
  /** Mutates as order-swaps happen; the dragged slot's order is tracked
   *  under `liftedNodeId` (the placeholder carries it visually). */
  private liveOrders = new Map<string, string>();
  /** The dragged child's AUTHORED width/height (source styles, not computed). */
  private liftedAuthoredW = '';
  private liftedAuthoredH = '';
  /** Parent's column/row gap in CANVAS px — bridges the hit-test dead
   *  zones between cells (cursor in a gap resolved to NO target and the
   *  hover felt dead). */
  private gapX = 0;
  private gapY = 0;

  /** Mutates as swaps happen mid-drag. Drives the onEnd diff. */
  private livePlacements = new Map<string, InlinePlacement>();
  /** Picked once in onStart based on parseGridInfo's hasExplicitPlacement
   *  flag — explicit path swaps via inline styles, auto-flow via DOM. */
  private isExplicitGrid = false;

  // ── Mouse cell tracking (oscillation guard) ──────────────────────────────
  /** Sibling id the cursor was last hovering. Swap fires ONLY when this
   *  changes — same oscillation guard the cell-key check used, but
   *  works for any layout (spans, mixed grids) because it's based on
   *  actual hit testing rather than computed cell coordinates. */
  private lastTargetId = '';

  // ── Exit-to-canvas ───────────────────────────────────────────────────────
  /** True after `commitExitToCanvas` has committed the element to canvas
   *  AND triggered a strategy switch. Once set, onMove / onEnd no-op so
   *  the new strategy (CanvasDragStrategy) owns the element. */
  private handedOffToCanvas = false;

  /** Replica drag-out work (hide source on this viewport + add the canvas
   *  clone) queued at exit time and returned from `onEnd`. The orchestrator
   *  drains `add` / `setConditionalStyle` PendingUpdates; `queueMutation`
   *  has no channel for either. */
  private replicaExitUpdates: PendingUpdate[] = [];

  /** Alt-duplicate node IDs added mid-drag. Tracked so
   *  `refreshDragLockSet` includes them in the renderer drag-lock set
   *  (preserves the replica-aware inline `display: 'none'` baseline
   *  set by DragCoordinator at alt-down across any subsequent force-
   *  render). Cleared on alt-release via `unregisterAltDuplicateRank`. */
  private altDuplicateIds: Set<string> = new Set();

  /** Top-of-tree ancestor (`parentId === null`) walked from the grid
   *  parent at lift time — usually `root` for pages or `layout::root`
   *  for layouts. Drives the in-viewport check below: while the cursor
   *  is anywhere inside this rect, the placeholder stays visible and
   *  the element remains "logically still in the grid". Only when the
   *  cursor exits the viewport entirely (out onto the canvas) does the
   *  placeholder disappear. Same model LayoutLiftedStrategy uses. */
  private viewportNodeId = '';

  /** Cursor-in-viewport tracker. Toggles placeholder + parent-highlight
   *  visibility — when `false` the grid placeholder is removed and the
   *  lifted element floats. Doesn't trigger a strategy switch on its
   *  own; exit-to-canvas only fires when the cursor enters a DIFFERENT
   *  acceptable frame OR the user mouseups outside the grid. */
  private isOverViewport = true;

  /** Previous-frame mouse position — feeds `getMouseVelocity` for the
   *  off-viewport canvas-snap path (snap-handler uses velocity for
   *  break-out hysteresis). */
  private prevMouse: Point = { x: 0, y: 0 };

  canHandle(context: DragContext): boolean {
    const first = context.draggedNodes[0];
    if (!first || !first.startParentId) return false;
    const nodeData: CanvasNode | undefined = context.nodes.get(first.id);
    if (nodeData?.isCanvasNode) return false;
    if (first.startParentId.startsWith('layout::')) return false;
    const ownPos = nodeData?.styles?.position;
    if (ownPos === 'absolute' || ownPos === 'fixed') return false;
    const parentNode = context.nodes.get(first.startParentId);
    if (!parentNode) return false;
    const parentDisplay = parentNode.styles?.display;
    if (parentDisplay !== 'grid' && parentDisplay !== 'inline-grid') return false;
    return true;
  }

  onStart(context: DragContext): void {
    const primary = context.draggedNodes[0];
    const { transform, startMouse } = context;
    this.parentId = primary.startParentId!;
    this.liftedNodeId = primary.id;
    this.contentEl = context.contentEl;
    this.vpId = vpIdFromPrefix(context.viewportPrefix);
    this.vpPrefix = getViewportPrefix(this.vpId);
    this.handedOffToCanvas = false;
    this.replicaExitUpdates = [];
    this.lastTargetId = '';
    this.isOverViewport = true;
    this.prevMouse = { x: startMouse.x, y: startMouse.y };
    this.viewportNodeId = this.findViewportAncestor(this.parentId, context.nodes);

    const childRects = findChildRects(this.parentId, this.vpId);
    let allChildren = childRects.map(r => r.id);

    // ORDER-STYLE mode detection + VISUAL ordering. `findChildRects`
    // returns JSX/DOM order; with inline `order` styles the VISUAL grid
    // order can differ, and every downstream model (slot indices,
    // finalOrder, the commit diff) must speak visual order.
    this.originalOrders.clear();
    this.liveOrders.clear();
    this.hasOrderStyles = false;
    const orderNum = new Map<string, number>();
    allChildren.forEach((id, domIdx) => {
      const o = (context.nodes.get(id)?.styles?.order ?? '').trim();
      if (o !== '') this.hasOrderStyles = true;
      this.originalOrders.set(id, o);
      this.liveOrders.set(id, o);
      const n = parseFloat(o);
      orderNum.set(id, (Number.isFinite(n) ? n : 0) * 100000 + domIdx);
    });
    if (this.hasOrderStyles) {
      allChildren = [...allChildren].sort((a, b) => orderNum.get(a)! - orderNum.get(b)!);
    }

    this.startIndex = allChildren.indexOf(primary.id);
    this.remainingSiblings = allChildren.filter(id => id !== primary.id);
    this.originalChildOrder = [...allChildren];
    this.finalOrder = [...allChildren];

    // Gap sizes (canvas px) for the hover hit-test's gap bridging.
    const gapComputed = findNodeComputedStyles(this.parentId, this.vpId, ['columnGap', 'rowGap']);
    this.gapX = parseFloat(gapComputed.columnGap) || 0;
    this.gapY = parseFloat(gapComputed.rowGap) || 0;

    // Lift geometry in canvas-space — same conversion LayoutLiftedStrategy
    // uses for its absolute lift positions.
    const rect = findNodeRect(primary.id, this.vpId);
    if (!rect) {
      trace.error('grid-drag:onStart:no-rect', { nodeId: primary.id });
      return;
    }
    this.startMouseX = startMouse.x;
    this.startMouseY = startMouse.y;
    // Layout box dimensions (computed CSS width/height) — NOT the
    // screen AABB. For a rotated/scaled element, AABB > CSS box; using
    // AABB would inflate the lifted element AND keep its own transform
    // on top, doubling the visible size on lift. Same rule as
    // LayoutLiftedStrategy uses for its lift measurements.
    const computed = findNodeComputedStyles(primary.id, this.vpId, ['width', 'height']);
    const cssW = parseFloat(computed.width);
    const cssH = parseFloat(computed.height);
    this.liftWidth = Number.isFinite(cssW) && cssW > 0 ? cssW : rect.width / transform.scale;
    this.liftHeight = Number.isFinite(cssH) && cssH > 0 ? cssH : rect.height / transform.scale;

    // Canvas-space lift position. `bridge.liftNode` reparents the
    // element to `contentRoot` so its containing block becomes the
    // canvas root (no inherited transforms from the grid parent).
    // Convert child screen rect → canvas CSS px: subtract iframe offset
    // and canvas pan, then un-scale.
    //
    // For ROTATED / SCALED elements, the screen rect is the AABB —
    // bigger than the CSS box. If we put liftLeft = aabbLeft and keep
    // the element's transform (so it stays rotated during drag, like
    // LayoutLiftedStrategy), the rotated quad would visibly shift on
    // lift because its centre would land at (aabbLeft + cssW/2,
    // aabbTop + cssH/2) instead of (aabbLeft + aabbW/2, aabbTop +
    // aabbH/2). Shift the lift position inward by half the
    // (aabb - css) delta so the LAYOUT box's centre coincides with
    // the AABB centre — element stays visually stable on lift.
    const iframeOffset = getIframeOffset();
    const aabbLeft = (rect.left - iframeOffset.x - transform.x) / transform.scale;
    const aabbTop = (rect.top - iframeOffset.y - transform.y) / transform.scale;
    const aabbW = rect.width / transform.scale;
    const aabbH = rect.height / transform.scale;
    this.liftLeft = aabbLeft + (aabbW - this.liftWidth) / 2;
    this.liftTop = aabbTop + (aabbH - this.liftHeight) / 2;
    this.currentMouseX = startMouse.x;
    this.currentMouseY = startMouse.y;
    this.currentScale = transform.scale;
    this.canvasTransformX = transform.x;
    this.canvasTransformY = transform.y;

    // Snapshot every child's inline placement — drives explicit-mode
    // swap restore + final-commit diff.
    this.originalPlacements.clear();
    this.livePlacements.clear();
    for (const childId of allChildren) {
      const inline = context.nodes.get(childId)?.styles ?? {};
      const snapshot: InlinePlacement = {
        gridColumn: inline.gridColumn || '',
        gridRow: inline.gridRow || '',
        gridArea: inline.gridArea || '',
      };
      this.originalPlacements.set(childId, { ...snapshot });
      this.livePlacements.set(childId, { ...snapshot });
    }

    // Authored (source) size of the dragged child — the placeholder must
    // mirror the sizing MODE, not the computed px (see createPlaceholder).
    const authored = context.nodes.get(primary.id)?.styles ?? {};
    this.liftedAuthoredW = (authored.width ?? '').trim();
    this.liftedAuthoredH = (authored.height ?? '').trim();

    // Create the placeholder before the dragged element so it takes
    // the dragged element's cell once the lifted node escapes to
    // contentRoot.
    this.placeholderId = `ph-grid-${primary.id}`;
    this.createPlaceholder(primary.id);

    // Snapshot every inline style we're about to mutate, so onEnd can
    // restore them precisely (clearing to '' would wipe React's
    // source-provided width/height/position and the element collapses
    // to a 0×0 empty div).
    const sourceStyles = context.nodes.get(primary.id)?.styles ?? {};
    const PROPS_TOUCHED_BY_LIFT = [
      'position', 'left', 'top', 'width', 'height',
      'zIndex', 'pointerEvents', 'transform',
      'gridColumn', 'gridRow', 'gridArea', 'order',
    ];
    this.liftedOriginalInline = {};
    for (const prop of PROPS_TOUCHED_BY_LIFT) {
      this.liftedOriginalInline[prop] = (sourceStyles as Record<string, string>)[prop] ?? '';
    }

    // Reparent the element to `contentRoot` via `bridge.liftNode` — the
    // "portal" technique flex uses. The lifted element escapes the
    // parent's transform / clip stack, so for rotated grids the drag
    // tracks the cursor correctly (in-place position:absolute would
    // inherit the parent rotate and drag the wrong direction).
    //
    // The element's OWN `transform` (e.g. `rotate(-30deg)`) is
    // PRESERVED on lift — same behavior as LayoutLiftedStrategy.
    // The drag preview shows the rotated quad, matching what the user
    // sees on the canvas. Combined with the (aabb − css) recenter
    // above, the visible position is stable at the moment of lift.
    // Clearing transform here would flatten a rotated element back to
    // axis-aligned the instant the drag starts — visually jarring and
    // misrepresents what's actually being dragged.
    const bridge = getCanvasBridge();
    const liftStyles: Record<string, string> = {
      position: 'absolute',
      left: `${Math.round(this.liftLeft)}px`,
      top: `${Math.round(this.liftTop)}px`,
      width: `${Math.round(this.liftWidth)}px`,
      height: `${Math.round(this.liftHeight)}px`,
      zIndex: '9999',
      pointerEvents: 'none',
      gridColumn: '',
      gridRow: '',
      gridArea: '',
    };
    if ('liftNode' in bridge) {
      (bridge as PostMessageBridge).liftNode(primary.id, this.vpPrefix, liftStyles);
    } else if (this.contentEl) {
      patchNodeStyles(this.contentEl, primary.id, this.vpPrefix, liftStyles);
    }

    // Lock the lifted node AND every visible sibling from `patchElement`
    // style application. Mirrors the LayoutLiftedStrategy fix:
    //
    //  • Lifted node — keeps its `position: absolute` + `zIndex: 9999`
    //    + lifted left/top across mid-drag force-renders (alt-duplicate
    //    `addNode` triggers one). Without this the drag overlay snaps
    //    back into the grid and stops following the cursor.
    //  • Siblings — keeps their inline grid-placement styles
    //    (`gridColumn`/`gridRow`) intact across mid-drag force-renders;
    //    CSSOM `el.style.gridColumn = ''` would clear any imperative
    //    swap state set by `swapWithSibling`.
    //  • Also covers `patchChildElements` + `patchCanvasNodes` lookups
    //    in the renderer — drag-locked nodes are skipped in all three
    //    paths so the lifted element stays under `contentRoot`
    //    (where `liftNode` put it) instead of being re-parented or
    //    swept away.
    //
    // Cleared in `resetState()`. The strategy's `registerAltDuplicate`
    // -style hook isn't wired here yet; if grid alt-duplicate ever
    // gains a separate code path, refresh the lock set on each
    // add/remove (see LayoutLifted.refreshDragLockSet).
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds([
        primary.id,
        ...allChildren.filter(id => id !== primary.id),
      ]);
    }

    // Parse grid info only to detect explicit-vs-auto mode. We don't
    // use cellOccupancy anymore — hit-testing replaced cell-based
    // detection — but we still need `hasExplicitPlacement` to pick
    // between inline-style swap (explicit) vs DOM-order swap (auto).
    this.gridInfo = parseGridInfo(this.parentId, this.vpId, allChildren, context.nodes);
    this.isExplicitGrid = this.gridInfo.hasExplicitPlacement;
    this.lastTargetId = '';

    parentHighlightOps.show({ parentId: this.parentId, vpId: this.vpId });
    dropLineOps.hide();
    trace.action('grid-drag:start', { parentId: this.parentId, nodeId: primary.id });
  }

  onMove(context: DragContext, mouseScreen: Point): DragMoveResult {
    if (this.handedOffToCanvas) {
      return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    const { transform } = context;
    this.currentMouseX = mouseScreen.x;
    this.currentMouseY = mouseScreen.y;
    this.currentScale = transform.scale;
    this.canvasTransformX = transform.x;
    this.canvasTransformY = transform.y;

    // 1. Update lifted element position. liftLeft/Top are CANVAS-SPACE
    //    CSS px (element was reparented to contentRoot via liftNode).
    //    Mouse delta in screen px / scale → canvas-space delta.
    const cssDx = (mouseScreen.x - this.startMouseX) / transform.scale;
    const cssDy = (mouseScreen.y - this.startMouseY) / transform.scale;
    let newLeft = this.liftLeft + cssDx;
    let newTop = this.liftTop + cssDy;

    // Off-viewport canvas snap — same logic LayoutLiftedStrategy uses
    // when its lifted node is dragged out onto the canvas. Build a
    // sibling list from rectCache (canvas-level nodes only — those with
    // `parentId === null`, plus the viewport root itself), feed
    // `calculateSnap` with the cursor-driven dragged rect, and fold the
    // snap result into the position write so the visual lock + the
    // snap guide line up. CRITICAL: dragged rect derived from
    // `lift + delta` (not `findNodeRect`) — reading the DOM would
    // create a feedback loop where last tick's snap-locked position
    // re-snaps to itself and oscillates with the cursor write.
    //
    // Skipped while INSIDE the viewport (cursor over the grid or
    // anywhere in the page hierarchy) — reorder owns positioning
    // there, no snap needed.
    let canvasSnap: ReturnType<typeof calculateSnap> | null = null;
    const viewportRectEarly = this.viewportNodeId
      ? findNodeRect(this.viewportNodeId, this.vpId)
      : null;
    const cursorOffViewport = !!viewportRectEarly
      && (mouseScreen.x < viewportRectEarly.left || mouseScreen.x > viewportRectEarly.right
        || mouseScreen.y < viewportRectEarly.top || mouseScreen.y > viewportRectEarly.bottom);
    if (cursorOffViewport) {
      const draggedRect: Rect = {
        left: newLeft, top: newTop,
        width: this.liftWidth, height: this.liftHeight,
      };
      const bridge = getCanvasBridge();
      const iframeOffset = getIframeOffset();
      const siblingRects: Array<{ id: string; rect: Rect }> = [];
      const cache = 'rectCache' in bridge ? (bridge as unknown as { rectCache: Map<string, DOMRect> }).rectCache : null;
      if (cache) {
        for (const [key] of cache) {
          const { vpPrefix: prefix, nodeId: dataId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
          if (!dataId || dataId === this.liftedNodeId) continue;
          const otherNode = context.nodes.get(dataId);
          if (!otherNode) continue;
          // Canvas-level snap targets: nodes with no parent (root
          // viewport, free-floating canvas nodes), plus the root itself
          // as a snap-to-viewport-edge anchor.
          if (otherNode.parentId && dataId !== 'root') continue;
          const screenRect = bridge.getRect(dataId, prefix);
          if (!screenRect) continue;
          siblingRects.push({
            id: prefix ? `${prefix}${dataId}` : dataId,
            rect: {
              left: (screenRect.left - iframeOffset.x - transform.x) / transform.scale,
              top: (screenRect.top - iframeOffset.y - transform.y) / transform.scale,
              width: screenRect.width / transform.scale,
              height: screenRect.height / transform.scale,
            },
          });
        }
      }
      const velocity = getMouseVelocity(this.prevMouse, mouseScreen);
      canvasSnap = calculateSnap(
        draggedRect,
        siblingRects,
        velocity,
        SNAP_THRESHOLD / transform.scale,
        undefined,
        undefined,
        getActiveRulerGuideSnapLines(),
      );
      if (canvasSnap.snappedX) newLeft = canvasSnap.x;
      if (canvasSnap.snappedY) newTop = canvasSnap.y;
    }

    if (this.contentEl) {
      patchNodeStyles(this.contentEl, this.liftedNodeId, this.vpPrefix, {
        left: `${Math.round(newLeft)}px`,
        top: `${Math.round(newTop)}px`,
      });
    }

    this.prevMouse = { x: mouseScreen.x, y: mouseScreen.y };

    // 2. Cursor-zone classification:
    //      INSIDE  viewport hierarchy → placeholder + parent highlight
    //        VISIBLE; reorder is gated separately on cursor being
    //        inside the grid parent rect (sub-region of viewport)
    //      OUTSIDE viewport hierarchy → placeholder HIDDEN, element
    //        floats freely on the canvas; re-entering the viewport
    //        restores the placeholder at its last grid slot
    //      OVER a DIFFERENT acceptable frame → commit-to-canvas + hand
    //        off to CanvasDragStrategy
    //
    // This mirrors LayoutLiftedStrategy's round-trip drag-out exactly —
    // the placeholder is tied to VIEWPORT presence, not grid-parent
    // presence, so the user can move the cursor anywhere within the
    // page (e.g. over a sibling section, the page background, a header)
    // without losing their grid placeholder.
    const viewportRect = this.viewportNodeId
      ? findNodeRect(this.viewportNodeId, this.vpId)
      : null;
    const cursorInsideViewport = !!viewportRect
      && mouseScreen.x >= viewportRect.left && mouseScreen.x <= viewportRect.right
      && mouseScreen.y >= viewportRect.top && mouseScreen.y <= viewportRect.bottom;

    if (this.isOverViewport && !cursorInsideViewport) {
      // Cursor left the viewport entirely → hide placeholder + parent
      // highlight. Element stays lifted; we don't commit / switch.
      this.removePlaceholder();
      parentHighlightOps.hide();
      this.isOverViewport = false;
      this.lastTargetId = '';
      trace.action('grid-drag:exit-viewport');
    } else if (!this.isOverViewport && cursorInsideViewport) {
      // Cursor came back into the viewport → recreate placeholder in
      // the lifted node's logical slot. `removePlaceholder` cleared
      // `this.placeholderId` on exit, so RE-ASSIGN it before the
      // bridge create call — otherwise the placeholder is created
      // with an empty data-placeholder-id and subsequent lookups
      // (remove on drop, rect query) all fail silently. The next
      // reorder check inside the grid adjusts the placeholder position
      // if the user is hovering a different cell.
      this.placeholderId = `ph-grid-${this.liftedNodeId}`;
      this.createPlaceholder(this.liftedNodeId);
      parentHighlightOps.show({ parentId: this.parentId, vpId: this.vpId });
      this.isOverViewport = true;
      trace.action('grid-drag:reenter-viewport');
    }

    // When the cursor is OUTSIDE the viewport AND over a DIFFERENT
    // acceptable frame on the canvas, commit-to-canvas + switch to
    // CanvasDragStrategy. CanvasDragStrategy's own entry detection
    // then routes the element into that frame on the next tick
    // (AbsoluteInFrameStrategy for no-layout, LayoutLiftedStrategy
    // for flex/grid).
    //
    // GATED on `!isOverViewport` — LayoutLiftedStrategy's exact rule.
    // While the cursor stays anywhere inside the viewport hierarchy
    // (over the page background, sibling sections, headers, etc.) the
    // element remains "logically still in the grid" with its
    // placeholder visible, so the user can freely move around without
    // committing prematurely. Only after the cursor leaves the
    // viewport AND lands over another frame does the commit fire —
    // that's the explicit cross-page "I'm picking a new parent" gesture.
    if (!this.isOverViewport) {
      const hits = getNodeHitsAtPoint(mouseScreen.x, mouseScreen.y);
      const originalAncestors = new Set<string>();
      {
        let walker: string | null = this.parentId;
        while (walker) {
          originalAncestors.add(walker);
          const wn = context.nodes.get(walker);
          walker = wn?.parentId ?? null;
        }
      }
      let foundNewParent: string | null = null;
      for (const hit of hits) {
        if (hit.id === this.liftedNodeId) continue;
        if (hit.id === 'root' || hit.id.startsWith('layout::') || hit.id === 'children-slot') continue;
        if (originalAncestors.has(hit.id)) continue;
        const node = context.nodes.get(hit.id);
        if (!node) continue;
        const tag = (node as any).tag || node.type || 'div';
        if (!nodeAcceptsChildren(node)) continue;
        foundNewParent = hit.id;
        break;
      }
      if (foundNewParent) {
        return this.commitExitToCanvas('grid-cursor-over-new-parent', context);
      }
    }

    // 3. Reorder only fires when cursor is inside the grid parent rect.
    // Outside the grid parent but still in viewport: element floats,
    // placeholder remains at its current grid slot (no swap updates).
    const parentRect = findNodeRect(this.parentId, this.vpId);
    const cursorInsideParent = !!parentRect
      && mouseScreen.x >= parentRect.left && mouseScreen.x <= parentRect.right
      && mouseScreen.y >= parentRect.top && mouseScreen.y <= parentRect.bottom;
    if (!cursorInsideParent) {
      // Return canvasSnap so guides render while floating outside the
      // viewport. While inside viewport but outside grid parent there
      // is no snap target collected above (gated on cursorOffViewport),
      // so canvasSnap is null — guide list stays empty, fine.
      return { snap: canvasSnap, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    // 4. Inside original parent → sibling-rect hit detection. Iterates
    //    EVERY known sibling of this grid (from `originalChildOrder`),
    //    reads each one's current bridge rect, and picks the first
    //    whose rect contains the cursor. Works for any layout (uniform
    //    1×1, spans, mixed, dense) because it doesn't depend on cell
    //    math — just per-sibling AABB tests.
    //
    //    Why not `getNodeHitsAtPoint`? That walks the entire rectCache
    //    which can include ghost copies, the parent itself, components'
    //    internal elements, etc. — more filtering complexity for less
    //    determinism than just iterating our actual siblings.
    // Inflate each sibling rect by HALF THE GRID GAP (screen px): strict
    // AABB containment left dead zones between cells — the trace showed
    // hover-target:null for 69 of 74 moves while sweeping across the grid,
    // because the cursor rode the gap band (2026-07-27). Half-gap
    // inflation tiles the parent contiguously with zero overlap, so every
    // point inside the grid resolves to exactly one sibling.
    const inflX = (this.gapX / 2) * transform.scale;
    const inflY = (this.gapY / 2) * transform.scale;
    let targetId: string | null = null;
    for (const sibId of this.originalChildOrder) {
      if (sibId === this.liftedNodeId) continue;
      const sibRect = findNodeRect(sibId, this.vpId);
      if (!sibRect) continue;
      if (mouseScreen.x < sibRect.left - inflX || mouseScreen.x > sibRect.right + inflX) continue;
      if (mouseScreen.y < sibRect.top - inflY || mouseScreen.y > sibRect.bottom + inflY) continue;
      targetId = sibId;
      break;
    }
    if (targetId !== this.lastTargetId) {
      trace.action('grid-drag:hover-target', {
        targetId, prevTarget: this.lastTargetId,
        mouse: { x: mouseScreen.x, y: mouseScreen.y },
        siblingCount: this.originalChildOrder.length - 1,
      });
      this.lastTargetId = targetId ?? '';
      if (targetId) this.swapWithSibling(targetId);
    }

    return {
      snap: null,
      dropTarget: null,
      highlightParentId: this.parentId,
      highlightVpId: this.vpId,
      axisLock: null,
    };
  }

  onEnd(context: DragContext): PendingUpdate[] {
    // Even after the mid-drag handoff to CanvasDragStrategy this runs (that is
    // what the guard is for) — and it is the ONLY channel for the replica exit's
    // work: `hideInThis` can return any of three PendingUpdate shapes and the
    // clone is an `add`, none of which `queueMutation` accepts directly.
    if (this.handedOffToCanvas) {
      const pending = this.replicaExitUpdates;
      this.replicaExitUpdates = [];
      return pending;
    }

    const primary = context.draggedNodes[0];
    const updates: PendingUpdate[] = [];

    // Mouseup OUTSIDE the viewport entirely (cursor was floating on
    // the canvas backdrop). Commit the element to canvas root with
    // proper px dimensions, same as the mid-drag exit path. Without
    // this, the mouseup would trigger the grid-reorder branch below
    // which re-inserts the element into the original grid at
    // startIndex — exactly the opposite of what the user just did.
    if (!this.isOverViewport) {
      this.commitExitToCanvas('grid-drop-outside-viewport', context);
      // commitExitToCanvas queued the move/clearContainerStyles + flushed —
      // nothing left for the coordinator to emit EXCEPT a replica exit's
      // hide+clone, which has no queueMutation channel. Never a grid reorder,
      // so the coordinator can't double-commit on top.
      const pending = this.replicaExitUpdates;
      this.replicaExitUpdates = [];
      this.resetState();
      return pending;
    }

    // Same fade as a layout-drag commit: the selection overlay mounts on
    // drop at the STALE drag (cursor) position before the new-slot rect
    // remeasures (`restoreNode` is an async bridge round-trip). Pulse the
    // reposition signal so SelectionFade hides the whole overlay group and
    // fades it back in once the corners settle at the new slot — the user
    // never sees the recalculation (user request 2026-07-27). Drop-INSIDE
    // only, mirroring LayoutLiftedStrategy: the exit-to-canvas path above
    // returns before this and has no snap-back jump.
    repositionSignalOps.signal();
    trace.action('grid-drag:reposition-signal', { nodeId: primary.id });

    // Restore the lifted element back into the grid at its FINAL desired
    // position (where `finalOrder` says it should land). For no-swap
    // drops this equals startIndex — element snaps back to its origin.
    // For commits this lines up the visual instantly so there's no
    // gap between drop and the next render rebuild from source.
    const finalIdx = this.finalOrder.indexOf(primary.id);
    this.removePlaceholder();
    this.unliftAndRestore(finalIdx >= 0 ? finalIdx : this.startIndex);
    parentHighlightOps.hide();

    // NON-PRIMARY tile (page replica / component-master variant): the
    // structural JSX reorder below is WRONG here — JSX is shared by every
    // tile, so a reorder performed on one variant moved the cards on ALL
    // of them ("reorders everything on all the variants", 2026-08-11; the
    // flex reorder was already correct because LayoutLiftedStrategy never
    // JSX-reorders — it only writes CSS `order`). Mirror the flex commit:
    // route CSS order through the shared router — @container band on a page
    // replica, order TERNARY on a master variant — and leave the JSX alone
    // so every other tile keeps painting its own sequence. Runs regardless
    // of `hasOrderStyles`: children with no `order` at all get the initial
    // sequential stamp exactly like the flex path's no-early-out rule.
    if (!isPrimaryViewport(this.vpId) && this.contentEl) {
      // Master variant: the ternary's `default` branch must pin the PRIMARY
      // tile's CURRENT visual sequence (row-major) — same authoritative
      // source the Layers-panel reorder passes. Without it, children that
      // carry no `order` anywhere collapse to model-default 0 and the
      // primary's sequence rests on DOM-order tie-breaks alone. Page
      // replicas don't consume it (their branch writes @container).
      let defaultOrders: Map<string, number> | undefined;
      if (getActiveFilePath().startsWith('components/')) {
        const primaryVisual = findChildRects(this.parentId, 'default')
          .slice()
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
          .map((c) => c.id);
        if (primaryVisual.length > 0) {
          defaultOrders = new Map(primaryVisual.map((id, i) => [id, i] as const));
        }
      }
      updates.push(...commitOrderAssignments(
        computeReorderAssignments(this.finalOrder), this.contentEl, this.vpId, defaultOrders,
      ));
    } else {
      // PRIMARY tile: commit via DOM reorder (works for all grid types:
      // auto-flow, span-based explicit, true explicit). Walk the desired
      // `finalOrder` left-to-right; for each position that's wrong,
      // emit a reorder to move the right child into place. The local
      // `current` array tracks source state as each prior mutation
      // lands, so each `newIndex` is correct for `reorderNodeInCode`
      // (which removes then re-inserts at the given index in the
      // post-removal list).
      //
      // Per-child reorders (not a single "set order" mutation) so the
      // commit reproduces the SWAP semantics the user saw mid-drag —
      // a one-shot reorder of the lifted node alone would "insert and
      // shift", displacing the wrong siblings.
      const current = [...this.originalChildOrder];
      for (let i = 0; i < this.finalOrder.length; i++) {
        const desired = this.finalOrder[i];
        if (current[i] === desired) continue;
        const idx = current.indexOf(desired);
        if (idx < 0) continue;
        current.splice(idx, 1);
        current.splice(i, 0, desired);
        updates.push({
          nodeId: desired,
          type: 'reorder',
          newParentId: this.parentId,
          newIndex: i,
        });
      }

      // ORDER-STYLE grids: the JSX reorder above fixes SOURCE order, but the
      // children's inline `order` styles are what actually paint the grid —
      // left untouched, they snap the visual straight back to the pre-drag
      // sequence the moment the re-render lands (the "mouseup doesn't
      // reorder" report, 2026-07-27). Re-stamp sequential orders over the
      // final VISUAL order through the shared router — identical semantics
      // to the flex reorder commit.
      if (this.hasOrderStyles && this.contentEl) {
        updates.push(...commitOrderAssignments(
          computeReorderAssignments(this.finalOrder), this.contentEl, this.vpId,
        ));
      }
    }

    trace.action('grid-drag:end', {
      updateCount: updates.length, isExplicitGrid: this.isExplicitGrid, hasOrderStyles: this.hasOrderStyles,
    });
    this.resetState();
    return updates;
  }

  onCancel(_context: DragContext): void {
    // Cancel = revert everything. Restore the lifted node to its
    // ORIGINAL position (not the swap-driven `finalOrder` position) so
    // the grid looks exactly like it did before the user grabbed.
    this.removePlaceholder();
    this.unliftAndRestore(this.startIndex);
    this.restoreSiblings();
    parentHighlightOps.hide();
    dropLineOps.hide();
    trace.action('grid-drag:cancel', { nodeId: this.liftedNodeId });
    this.resetState();
  }

  // ── Swap implementation ────────────────────────────────────────────────────

  /** Single swap step. Always DOM-swap (placeholder ↔ target). Works
   *  for every grid type:
   *    - Auto-flow uniform grids → swap by DOM order, browser re-flows.
   *    - Spans (`grid-column: span N`) → DOM order still drives where
   *      each item lands; each retains its own span size.
   *    - Explicit positions (`grid-column: 1 / 3`) → DOM swap is a
   *      visual no-op (items pinned to explicit cells) but harmless. */
  private swapWithSibling(targetId: string): void {
    if (this.hasOrderStyles) {
      // CSS `order` drives the visual grid here — a DOM swap paints
      // NOTHING. Exchange order values between the placeholder (which
      // carries the dragged slot's order) and the target instead.
      this.swapOrderValues(targetId);
    } else {
      this.swapAutoFlowDom(targetId);
    }

    // Mirror the swap in `finalOrder` — this is what gets committed to
    // source at onEnd. Lifted and target exchange indices, all other
    // siblings unchanged.
    const li = this.finalOrder.indexOf(this.liftedNodeId);
    const ti = this.finalOrder.indexOf(targetId);
    if (li >= 0 && ti >= 0) {
      [this.finalOrder[li], this.finalOrder[ti]] = [this.finalOrder[ti], this.finalOrder[li]];
    }

    // (Drag overlay stays at its initial lift size — the placeholder
    // alone resizes to match each target cell so siblings reflow
    // correctly. Per user feedback: resizing the overlay mid-drag was
    // too subtle / distracting; what's being dragged should visually
    // remain what was picked up. The committed cell still gets the
    // user's existing width/height (or the cell's `auto`/`fr` track
    // size) — the overlay size is purely visual.)

    // CRITICAL: refresh sibling rects in the bridge cache. The DOM
    // swap moved siblings to new positions, but `swapTwoElements`
    // doesn't emit per-element rect updates (the cache only auto-
    // refreshes on full render cycles). Without this, the very next
    // hover lookup uses pre-swap cached rects, so the moved sibling
    // is invisible to hit detection — that's why dragging back to
    // a just-swapped sibling appeared to do nothing.
    const bridge = getCanvasBridge();
    if ('prefetchChildRects' in bridge) {
      (bridge as PostMessageBridge).prefetchChildRects(this.parentId, this.vpPrefix);
    }

    trace.action('grid-drag:swap', { liftedId: this.liftedNodeId, targetId });
  }

  /** Explicit grids: exchange `gridColumn`/`gridRow`/`gridArea` inline
   *  between the placeholder and the hovered sibling. DOM order is
   *  untouched. */
  private swapExplicitPlacement(targetId: string): void {
    if (!this.contentEl) return;
    // The "dragged" item's CURRENT placement lives in livePlacements
    // under its own id (not the placeholder's). The placeholder mirrors
    // it via inline style, but tracking is done by liftedNodeId.
    const draggedLive = this.livePlacements.get(this.liftedNodeId);
    const targetLive = this.livePlacements.get(targetId);
    if (!draggedLive || !targetLive) return;

    // Target takes dragged's current placement; placeholder visually
    // takes target's — so the user sees the target shift into the cell
    // the placeholder vacated.
    patchNodeStyles(this.contentEl, targetId, this.vpPrefix, {
      gridColumn: draggedLive.gridColumn,
      gridRow: draggedLive.gridRow,
      gridArea: draggedLive.gridArea,
    });
    const bridge = getCanvasBridge();
    if ('patchPlaceholderStyles' in bridge) {
      (bridge as PostMessageBridge).patchPlaceholderStyles(this.placeholderId, this.vpPrefix, {
        gridColumn: targetLive.gridColumn,
        gridRow: targetLive.gridRow,
        gridArea: targetLive.gridArea,
      });
    }
    this.livePlacements.set(this.liftedNodeId, { ...targetLive });
    this.livePlacements.set(targetId, { ...draggedLive });
  }

  /** ORDER-STYLE grids: exchange inline `order` between the placeholder
   *  (tracked under `liftedNodeId`) and the target sibling. The browser
   *  re-flows both into each other's cells; DOM order is untouched (the
   *  JSX reorder + sequential re-stamp at onEnd own the source truth). */
  private swapOrderValues(targetId: string): void {
    if (!this.contentEl) return;
    const phOrder = this.liveOrders.get(this.liftedNodeId) ?? '';
    const tOrder = this.liveOrders.get(targetId) ?? '';
    patchNodeStyles(this.contentEl, targetId, this.vpPrefix, { order: phOrder });
    const bridge = getCanvasBridge();
    if ('patchPlaceholderStyles' in bridge) {
      (bridge as PostMessageBridge).patchPlaceholderStyles(this.placeholderId, this.vpPrefix, { order: tOrder });
    }
    this.liveOrders.set(this.liftedNodeId, tOrder);
    this.liveOrders.set(targetId, phOrder);
  }

  /** Auto-flow grids: swap placeholder and target in DOM order. Browser
   *  grid auto-flow re-paints them in each other's cells. Single
   *  `bridge.swapTwoElements` call handles all the DOM bookkeeping. */
  private swapAutoFlowDom(targetId: string): void {
    const bridge = getCanvasBridge();
    if ('swapTwoElements' in bridge) {
      (bridge as PostMessageBridge).swapTwoElements(
        this.placeholderId, targetId, this.parentId, this.vpPrefix,
      );
    }
  }

  // ── Placeholder + unlift helpers ───────────────────────────────────────────

  /** Create the in-grid placeholder. For explicit grids it inherits the
   *  dragged item's resolved placement; for auto-flow it stays
   *  unplaced so the browser auto-flows it alongside siblings.
   *
   *  Sizing matches the LAYOUT BOX of the dragged element exactly
   *  (`liftWidth × liftHeight`, captured at onStart from computed CSS
   *  via `findNodeComputedStyles` — un-rotated, pre-transform). This
   *  is what the user sees as "the thing I picked up" and what'll
   *  commit on drop, so the placeholder visibly stands in for the
   *  same shape.
   *
   *  `alignSelf` / `justifySelf` left as `start` so the placeholder
   *  sits at the cell's top-left at its fixed size — without the
   *  stretch, larger cells (1fr tracks with a small element) show the
   *  exact element footprint inside their cell instead of inflating
   *  the placeholder to the full track. */
  private createPlaceholder(draggedId: string): void {
    const bridge = getCanvasBridge();
    if (!('createPlaceholder' in bridge)) return;

    // SIZING MODE must mirror the dragged child, not its computed px. A
    // `height: 100%` grid child contributes ~nothing to an AUTO row's track
    // sizing (the rows stretch evenly); standing in with the computed px
    // (e.g. 205px) injects a FIXED contribution into that row — auto sizing
    // + stretch redistribution then grow the dragged row and shrink the
    // other ("top row gets taller during grid drag, readjusts on mouseup",
    // user report 2026-07-27). Percentage / unset sizes → keep the % (or
    // stretch); fixed px sizes → the exact footprint as before.
    const wIsFluid = this.liftedAuthoredW === '' || this.liftedAuthoredW.includes('%');
    const hIsFluid = this.liftedAuthoredH === '' || this.liftedAuthoredH.includes('%');
    const phStyles: Record<string, string> = {
      width: wIsFluid ? (this.liftedAuthoredW || 'auto') : `${Math.round(this.liftWidth)}px`,
      height: hIsFluid ? (this.liftedAuthoredH || 'auto') : `${Math.round(this.liftHeight)}px`,
      alignSelf: hIsFluid ? 'stretch' : 'start',
      justifySelf: wIsFluid ? 'stretch' : 'start',
      backgroundColor: PLACEHOLDER_BG,
      borderRadius: PLACEHOLDER_RADIUS,
      pointerEvents: 'none',
      boxSizing: 'border-box',
    };

    // ORDER-STYLE grids: the placeholder must inherit the dragged item's
    // inline `order`, or it auto-flows at order 0 — the FRONT of the
    // order-sorted grid — displacing every sibling by one cell and
    // resizing the rows the instant the drag starts (the "top row gets
    // taller / placeholder in the wrong slot" report, 2026-07-27).
    if (this.hasOrderStyles) {
      const dOrder = this.liveOrders.get(draggedId) ?? '';
      if (dOrder !== '') phStyles.order = dOrder;
    }

    // For an explicit grid, pin the placeholder to the dragged item's
    // resolved cells so the layout doesn't reflow on lift. The sync
    // parse may have empty resolved placement (cache miss); fall back
    // to the inline `gridColumn`/`gridRow` strings if available.
    const original = this.originalPlacements.get(draggedId);
    const resolved = this.gridInfo?.itemPlacements.get(draggedId);
    if (resolved && (resolved.colStart >= 1 && resolved.rowStart >= 1)) {
      const inlineCol = original?.gridColumn;
      const inlineRow = original?.gridRow;
      const inlineArea = original?.gridArea;
      if (inlineCol || inlineRow || inlineArea) {
        if (inlineCol) phStyles.gridColumn = inlineCol;
        if (inlineRow) phStyles.gridRow = inlineRow;
        if (inlineArea && inlineArea !== 'auto') phStyles.gridArea = inlineArea;
      }
    } else if (original?.gridColumn || original?.gridRow) {
      if (original.gridColumn) phStyles.gridColumn = original.gridColumn;
      if (original.gridRow) phStyles.gridRow = original.gridRow;
      if (original.gridArea && original.gridArea !== 'auto') phStyles.gridArea = original.gridArea;
    }

    (bridge as PostMessageBridge).createPlaceholder(
      this.placeholderId, this.parentId, this.vpPrefix, draggedId, phStyles,
    );
  }

  private removePlaceholder(): void {
    if (!this.placeholderId) return;
    const bridge = getCanvasBridge();
    if ('removePlaceholders' in bridge) {
      (bridge as PostMessageBridge).removePlaceholders([this.placeholderId]);
    }
    this.placeholderId = '';
  }

  /** Reverse the lift on the dragged element. Restores every inline
   *  style we mutated to its drag-start value (NOT blank — see
   *  `liftedOriginalInline` for why), with explicit-swap `livePlacements`
   *  overriding the original grid placement if the user did swaps. */
  private unliftAndRestore(restoreIndex?: number): void {
    const live = this.livePlacements.get(this.liftedNodeId);
    const restore: Record<string, string> = { ...this.liftedOriginalInline };
    // Live placement (mutated by swaps) wins over the original snapshot
    // for the grid-positioning props.
    if (live) {
      restore.gridColumn = live.gridColumn;
      restore.gridRow = live.gridRow;
      restore.gridArea = live.gridArea;
    }
    // ORDER-STYLE grids: the element re-enters at the ORDER of the slot
    // it was dropped on (the placeholder carried it through the swaps).
    // Cancel passes restoreToOriginalOrder — the snapshot value wins there.
    if (this.hasOrderStyles) {
      const liveOrder = this.liveOrders.get(this.liftedNodeId);
      if (liveOrder !== undefined && liveOrder !== '') restore.order = liveOrder;
    }
    // `bridge.restoreNode` does TWO things: applies these styles AND
    // physically reparents the element back into the grid at `idx`.
    // Without restoreNode the element would stay orphaned in
    // contentRoot (`liftNode` put it there). The bridge counts only
    // real children (not placeholders) when computing the insertion
    // point, so passing `finalOrder`'s index for the lifted node lands
    // it at the right slot.
    const bridge = getCanvasBridge();
    if ('restoreNode' in bridge && this.parentId) {
      const idx = restoreIndex ?? Math.max(0, this.startIndex);
      (bridge as PostMessageBridge).restoreNode(
        this.liftedNodeId, this.parentId, this.vpPrefix, idx, restore,
      );
    } else if (this.contentEl) {
      // DirectBridge fallback (no liftNode happened either, just clear).
      patchNodeStyles(this.contentEl, this.liftedNodeId, this.vpPrefix, restore);
    }
  }

  /** Restore every sibling to its drag-start placement. Used on cancel
   *  for explicit grids. (Auto-flow grids never patch sibling styles, so
   *  there's nothing to restore there — DOM is restored by the cancel
   *  preventing the reorder commit.) */
  private restoreSiblings(): void {
    if (!this.contentEl) return;
    // ORDER-STYLE grids: put every sibling's inline `order` back to its
    // drag-start value (order-swaps mutated them imperatively).
    if (this.hasOrderStyles) {
      for (const [nodeId, o] of this.originalOrders) {
        if (nodeId === this.liftedNodeId) continue;
        if (o !== (this.liveOrders.get(nodeId) ?? '')) {
          patchNodeStyles(this.contentEl, nodeId, this.vpPrefix, { order: o });
        }
      }
    }
    if (!this.isExplicitGrid) return;
    for (const [nodeId, original] of this.originalPlacements) {
      if (nodeId === this.liftedNodeId) continue;
      patchNodeStyles(this.contentEl, nodeId, this.vpPrefix, {
        gridColumn: original.gridColumn,
        gridRow: original.gridRow,
        gridArea: original.gridArea,
      });
    }
  }


  /** Commit the lifted node to canvas root with a proper position +
   *  resolved px width/height, then hand off to CanvasDragStrategy.
   *
   *  Why we don't just leave the element with its grid-cell-derived
   *  `width: 100%` and let the source rebuild handle it: the grid's
   *  `width: 100%` resolves against the GRID CELL while parented; once
   *  the element is reparented to canvas (parent=null), `100%`
   *  resolves against the page width and the element balloons across
   *  the viewport (the original bug — element jumped to 1600+ px). The
   *  px width/height we computed at lift time (un-rotated CSS box, NOT
   *  the rotated AABB) is exactly the visual size the user picked up,
   *  so committing it locks the element at the same size.
   *
   *  `clearContainerStyles` strips per-viewport `@media` overrides on
   *  this node so the responsive cascade doesn't fight the new px size.
   *
   *  The (aabb − css) / 2 recenter math is the same one
   *  LayoutLiftedStrategy uses for its exit — keeps rotated / scaled
   *  elements visually stable across the commit. */
  private commitExitToCanvas(reason: string, context: DragContext): DragMoveResult {
    this.handedOffToCanvas = true;
    this.removePlaceholder();
    parentHighlightOps.hide();
    dropLineOps.hide();

    const transform = context.transform;
    const iframeOffset = getIframeOffset();

    // Live position of the lifted element in canvas-space. The element
    // is already in contentRoot (post-`liftNode`) and its rect reflects
    // the per-frame `left`/`top` patches plus its own preserved
    // transform — so the AABB centre matches what the user sees.
    const liveRect = findNodeRect(this.liftedNodeId, this.vpId);
    let canvasLeft = this.liftLeft;
    let canvasTop = this.liftTop;
    if (liveRect) {
      const aabbLeft = (liveRect.left - iframeOffset.x - transform.x) / transform.scale;
      const aabbTop = (liveRect.top - iframeOffset.y - transform.y) / transform.scale;
      const aabbW = liveRect.width / transform.scale;
      const aabbH = liveRect.height / transform.scale;
      canvasLeft = aabbLeft + (aabbW - this.liftWidth) / 2;
      canvasTop = aabbTop + (aabbH - this.liftHeight) / 2;
    }

    const exitStyles: Record<string, string> = {
      position: 'absolute',
      left: `${Math.round(canvasLeft)}px`,
      top: `${Math.round(canvasTop)}px`,
      width: `${Math.round(this.liftWidth)}px`,
      height: `${Math.round(this.liftHeight)}px`,
      // Strip grid-cell placement so source doesn't re-pin the element
      // into the old cell on the next render.
      gridColumn: '',
      gridRow: '',
      gridArea: '',
      // Lift bookkeeping that should not leak into committed source.
      zIndex: '',
      pointerEvents: '',
    };
    // Clear lift visual flags on the LIVE element so the visual handoff
    // to CanvasDragStrategy is clean (zIndex / pointerEvents stripped).
    if (this.contentEl) {
      patchNodeStyles(this.contentEl, this.liftedNodeId, this.vpPrefix, {
        zIndex: '', pointerEvents: '',
      });
    }

    // REPLICA / VARIANT EXIT. Every tile renders the SAME JSX element, so a
    // `move` deletes it from the primary and every sibling too — dragging a
    // grid child out of one variant emptied all of them (reported 2026-08-24).
    // `LayoutLiftedStrategy` has always split this in two; the grid strategy
    // never did. Same decision, same two paths, shared predicate.
    const activeFile = getActiveFilePath();
    const rctx = getReplicaContext(this.vpId, activeFile, getViewportWidths());
    const isOnComponentMaster = isComponentFilePath(activeFile);
    const otherVpIds = isOnComponentMaster
      ? parseVariantConfig(projectFS.readFile(activeFile) ?? '')
          .map((v: { name: string }) => (v.name === 'default' ? 'desktop' : v.name))
      : Object.keys(getViewportWidths());
    const soloHere = rctx.isPrimary || isReplicaOnlyOnViewport({
      dropVpId: this.vpId,
      otherVpIds,
      isComponentMaster: isOnComponentMaster,
      hiddenOnVariants: context.nodes.get(this.liftedNodeId)?.hiddenOnVariants,
      inlineDisplay: context.nodes.get(this.liftedNodeId)?.styles?.display,
      readDisplay: (vpId) => findNodeComputedStyles(this.liftedNodeId, vpId, ['display']).display ?? '',
    });

    queueMutation({ type: 'clearContainerStyles', nodeId: this.liftedNodeId });

    if (!soloHere) {
      // Other tiles still show it: CLONE to canvas with fresh ids and hide the
      // SOURCE on this viewport only. Fresh ids matter — reusing the source's
      // would let its @media/variant rules follow the clone out.
      const idMap = new Map<string, string>();
      const desc = buildCanvasCloneForLayoutDrop(
        this.liftedNodeId, context.nodes, exitStyles,
        isOnComponentMaster ? this.vpId : undefined,
        isOnComponentMaster ? undefined : (getViewportWidths()[this.vpId] ?? undefined),
        idMap,
      );
      if (desc) {
        // A source carrying the replica-only `display:'none'` baseline would
        // hand the clone an invisible canvas node — there is no @media context
        // at canvas root to flip it back on.
        if (desc.styles?.display === 'none') desc.styles.display = '';
        this.replicaExitUpdates = [
          rctx.hideInThis(this.liftedNodeId),
          { nodeId: desc.id!, type: 'add', descriptor: desc },
        ];
        trace.action('grid-drag:exit-to-canvas-replica-clone', {
          srcId: this.liftedNodeId, cloneId: desc.id, vpId: this.vpId,
        });
      } else {
        trace.error('grid-drag:clone-descriptor-failed', { nodeId: this.liftedNodeId });
      }
    } else {
      queueMutation({
        type: 'move',
        nodeId: this.liftedNodeId,
        newParentId: null,
        canvasNode: true,
        styles: exitStyles,
      });
      moveNodeInCache(this.liftedNodeId, null);
      updateNodeInCache(this.liftedNodeId, exitStyles);
    }

    flushNowDeferredDuringDrag();
    forceCanvasRenderDeferredDuringDrag();

    trace.action('grid-drag:exit-to-canvas', {
      nodeId: this.liftedNodeId,
      canvasLeft, canvasTop,
      width: this.liftWidth, height: this.liftHeight,
      reason,
    });

    // Hand control over. CanvasDragStrategy reads the committed position
    // from the cache as its baseline — `skipRebuild` keeps the iframe
    // alive without a full re-render across the switch.
    // CLONE PATH — do NOT hand off. The handoff points CanvasDragStrategy at
    // `liftedNodeId`, which on this path is the SOURCE: it stays in the tree,
    // now hidden on this viewport. Dragging and committing THAT is what left
    // the canvas node "selected but fake" — the overlay tracked the hidden
    // original at a stale rect, Layers showed nothing selected (a hidden node
    // cannot be), and style edits wrote to something invisible (reported
    // 2026-08-24).
    //
    // The clone does not exist yet — it is created when `onEnd` returns the
    // `add` update and the orchestrator flushes. That branch already does the
    // right thing afterwards: `flushNow()` so the parser produces the canonical
    // node, then `setSelectedIds([newId])` (CanvasDragOrchestrator ~1091). So
    // keep ownership of the drag and let mouseup do the work.
    if (this.replicaExitUpdates.length > 0) {
      trace.action('grid-drag:exit-clone-no-handoff', { srcId: this.liftedNodeId });
      return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    const exitOverrides = new Map<string, { startLeft: number; startTop: number; startParentId: string | null; sourceParentId?: string | null }>();
    exitOverrides.set(this.liftedNodeId, {
      startLeft: Math.round(canvasLeft),
      startTop: Math.round(canvasTop),
      startParentId: null,
      // Original grid parent — lets the canvas strategy's back-to-parent
      // placeholder fire only on a return to THIS parent (see shared/types).
      sourceParentId: this.parentId,
    });

    return {
      snap: null, dropTarget: null, highlightParentId: null, axisLock: null,
      switchRequest: {
        toStrategy: 'canvas',
        reason,
        skipRebuild: true,
        nodeStateOverrides: exitOverrides,
      },
    };
  }

  // ── Misc helpers ───────────────────────────────────────────────────────────

  /** Walk up the node-cache parent chain to the topmost ancestor
   *  (`parentId === null`). For pages that's `root`; for layouts the
   *  layout root. Drives the in-viewport exit predicate so the user
   *  can drag the element anywhere within the page hierarchy without
   *  the placeholder disappearing. 50-step safety cap is the same one
   *  LayoutLiftedStrategy uses. */
  private findViewportAncestor(
    startId: string,
    nodes: Map<string, CanvasNode>,
  ): string {
    let current = startId;
    for (let depth = 0; depth < 50; depth++) {
      const node = nodes.get(current);
      if (!node || !node.parentId) break;
      current = node.parentId;
    }
    return current;
  }


  /**
   * Register an alt-duplicate so the renderer drag-lock includes it
   * (preserves inline styles like `display: 'none'` baseline used by
   * the replica-aware path in `DragCoordinator.applyAltDuplicateState`
   * — without locking, a subsequent force-render's `patchElement`
   * would no-op against unchanged source styles but a more involved
   * code path could regress this).
   *
   * Grid doesn't use the spaced-rank `order` mechanism that flex does
   * (it uses `gridColumn`/`gridRow` placement), so the `rank` param
   * is just for interface parity with LayoutLifted — unused here.
   */
  registerAltDuplicateRank(duplicateId: string, _rank: number): void {
    this.altDuplicateIds.add(duplicateId);
    this.refreshDragLockSet();
  }

  /** Reverse of `registerAltDuplicateRank` — called on alt-release. */
  unregisterAltDuplicateRank(duplicateId: string): void {
    this.altDuplicateIds.delete(duplicateId);
    this.refreshDragLockSet();
  }

  /** Push the current set of locked node IDs (lifted + visible siblings
   *  + alt-duplicates) to the renderer. Called on lift and on each
   *  alt-add/alt-remove. */
  private refreshDragLockSet(): void {
    if (!this.parentId) return;
    const parentNode = getNodeFromCache(this.parentId);
    if (!parentNode) return;
    const locked: string[] = [];
    for (const childId of parentNode.children) {
      if (childId.startsWith('layout::')) continue;
      const cn = getNodeFromCache(childId);
      if (!cn) continue;
      if (cn.isCanvasNode) continue;
      const pos = cn.styles?.position || '';
      if (pos === 'absolute' || pos === 'fixed') continue;
      locked.push(childId);
    }
    const bridge = getCanvasBridge();
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds(locked);
    }
    trace.action('grid-drag:drag-lock-refresh', { count: locked.length });
  }

  /**
   * Re-stamp the FULL lift styles (position/left/top/width/height/
   * zIndex/pointerEvents) on the lifted node with `left/top` computed
   * from the LIVE cursor position. Called by `DragCoordinator.resync
   * DraggedAfterGhostChange` after a mid-drag force-render — even
   * with the renderer drag-lock skipping `patchElement` for the
   * lifted node, this is defence-in-depth: any code path that
   * imperatively touches the element's inline styles between the
   * lift and now (overlay portals, locale overrides, etc.) gets
   * undone here in a single atomic patch, so the dragged overlay
   * stays glued to the cursor across structural changes.
   *
   * Mirrors `LayoutLiftedStrategy.rehydrateLiftAfterForceRender`.
   */
  rehydrateLiftAfterForceRender(context: DragContext, mouseDelta: Point): void {
    if (!this.liftedNodeId || !this.contentEl) return;
    const scale = context.transform?.scale || 1;
    const dx = mouseDelta.x / scale;
    const dy = mouseDelta.y / scale;
    patchNodeStyles(this.contentEl, this.liftedNodeId, this.vpPrefix, {
      position: 'absolute',
      left: `${Math.round(this.liftLeft + dx)}px`,
      top: `${Math.round(this.liftTop + dy)}px`,
      width: `${Math.round(this.liftWidth)}px`,
      height: `${Math.round(this.liftHeight)}px`,
      zIndex: '9999',
      pointerEvents: 'none',
      gridColumn: '',
      gridRow: '',
      gridArea: '',
    });
    trace.action('grid-drag:rehydrate-lift', { nodeId: this.liftedNodeId, dx, dy });
  }

  private resetState(): void {
    this.hasOrderStyles = false;
    this.liftedAuthoredW = '';
    this.liftedAuthoredH = '';
    this.originalOrders.clear();
    this.liveOrders.clear();
    this.gapX = 0;
    this.gapY = 0;
    // Release the renderer drag-lock so post-drag source renders apply
    // normally to the formerly-lifted node and its siblings — without
    // this they'd be permanently skipped by `patchElement` until page
    // reload.
    const bridge = getCanvasBridge();
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds([]);
    }
    this.parentId = '';
    this.liftedNodeId = '';
    this.placeholderId = '';
    this.contentEl = null;
    this.remainingSiblings = [];
    this.originalChildOrder = [];
    this.finalOrder = [];
    this.startIndex = -1;
    this.gridInfo = null;
    this.isExplicitGrid = false;
    this.originalPlacements.clear();
    this.livePlacements.clear();
    this.lastTargetId = '';
    this.liftedOriginalInline = {};
    this.currentMouseX = 0;
    this.currentMouseY = 0;
    this.currentScale = 1;
    this.canvasTransformX = 0;
    this.canvasTransformY = 0;
    this.handedOffToCanvas = false;
    this.isOverViewport = true;
    this.viewportNodeId = '';
    this.altDuplicateIds.clear();
  }
}
