// drag/types.ts — Drag system type definitions and strategy interface.
// All drag strategies implement DragStrategy. The DragCoordinator picks the
// right strategy and routes mouse events to it.

import type { Transform, NodeMap, DraggedNode, PendingUpdate, SnapResult, DropTarget, Point } from '@/shared/types';
import { findNodeComputedStyle, findNodeComputedStyles, findChildRects } from '@/canvas/node-ops';
import { getNodeFromCache } from '@/code/stores/store';

// ─── Drag Context ──────────────────────────────────────────────────────────
// Immutable context created at drag start, passed to strategy methods.

export interface DragContext {
  /** Nodes being dragged (1 for single, N for multi-select) */
  draggedNodes: DraggedNode[];

  /** Mouse position at drag start (screen-space) */
  startMouse: Point;

  /** Canvas transform at drag start */
  transform: Transform;

  /** Canvas container DOM rect (for coordinate conversion) */
  containerRect: DOMRect;

  /** Content container element (holds rendered nodes) */
  contentEl: HTMLElement;

  /** Current code string (for reading node data) */
  code: string;

  /** Current parsed nodes */
  nodes: NodeMap;

  /** IDs of all selected nodes */
  selectedIds: string[];

  /** Modifier keys at drag start */
  modifiers: {
    alt: boolean;   // duplicate
    shift: boolean; // axis lock
    ctrl: boolean;  // drag through
  };

  /** Viewport prefix for DOM queries (e.g. 'tablet-' for replica viewports, '' for desktop) */
  viewportPrefix: string;

  /** For grip handle drags — constrain reorder to this axis */
  gripAxis?: 'x' | 'y';
}

// ─── Drag Strategy Interface ───────────────────────────────────────────────
// Each drag mode (canvas, in-frame, layout, toolbar) implements this.

export interface DragStrategy {
  /** Unique name for debugging */
  readonly name: string;

  /**
   * Check if this strategy can handle the given drag context.
   * Called by the coordinator to pick the right strategy.
   */
  canHandle(context: DragContext): boolean;

  /**
   * Called once when drag starts (after threshold met).
   * Set up any DOM state (placeholders, ghost elements, etc.)
   */
  onStart(context: DragContext): void;

  /**
   * Called on every mouse move during drag.
   * Returns the visual position (for DOM updates) and snap result.
   * Should NOT update code — only update DOM for 60fps visual feedback.
   */
  onMove(
    context: DragContext,
    mouseScreen: Point,
    mouseDelta: Point,
  ): DragMoveResult;

  /**
   * Called on mouse up. Returns pending updates to commit to code.
   * Clean up any DOM state.
   */
  onEnd(context: DragContext): PendingUpdate[];

  /**
   * Called when drag is cancelled (Escape key, etc.)
   * Must restore DOM to pre-drag state.
   */
  onCancel(context: DragContext): void;

  /**
   * Determine which viewport the dragged element ended up in.
   * Used by the coordinator to generate replica visibility updates at drop time.
   * Walks up from the element's DOM position to find the viewport ancestor.
   */
  getDropViewportId?(context: DragContext): string | undefined;
}

// ─── Drag Move Result ──────────────────────────────────────────────────────
// Returned by onMove — tells coordinator what to render.

export interface DragMoveResult {
  /** Snap result (guides to render, snapped positions) */
  snap: SnapResult | null;

  /** Drop target (for layout/toolbar strategies) */
  dropTarget: DropTarget | null;

  /** Parent to highlight (for auto-parenting) */
  highlightParentId: string | null;

  /** Viewport ID for the highlight (when the target is in a different viewport than drag start) */
  highlightVpId?: string;

  /** Whether axis is locked (shift+drag) */
  axisLock: 'x' | 'y' | null;

  /** Signal to coordinator to switch to a different strategy mid-drag */
  switchRequest?: {
    toStrategy: 'canvas' | 'absolute-in-frame' | 'layout-lifted';
    reason: string;
    /** When set, the requesting strategy has already updated the dragged-
     *  node state authoritatively. Coordinator should NOT call rebuildContext
     *  (which would re-derive startLeft/startTop from the imperative cache,
     *  potentially picking up stale values during a drag where the atom
     *  hasn't re-derived yet). Used by CanvasDragStrategy.live-reparent
     *  and AbsoluteInFrameStrategy.exit so the new strategy starts from
     *  the exact canvas-space coords just committed to code. */
    skipRebuild?: boolean;
    /** Authoritative startLeft / startTop / startParentId to plant on the
     *  dragged nodes when skipRebuild is true. Coordinator overwrites
     *  context.draggedNodes[*] with these values + sets startMouse =
     *  current mouse so dx/dy = 0 right after switch. */
    nodeStateOverrides?: Map<string, {
      startLeft: number;
      startTop: number;
      startParentId: string | null;
      /** Optional screen-pixel dimensions. Set by exit handlers that
       *  KNOW the dragged node's post-commit size (e.g. exit from a
       *  rotated parent: the new canvas-frame AABB won't match the
       *  lift-time AABB and bridge rectCache lags by a frame, so the
       *  receiving strategy reading findNodeRect returns stale
       *  inflated dims and snap math fires offset). Coordinator
       *  applies these to draggedNode.width/height. */
      width?: number;
      height?: number;
      /** Optional transform override — set by exit handlers that
       *  stripped translates from the source `transform` so the
       *  receiving strategy doesn't re-compose the stale value in
       *  its per-frame writes. Coordinator stamps it onto
       *  `draggedNode.transformOverride` for the receiving
       *  strategy's onStart to pick up. */
      transform?: string;
      /** The gesture CONTINUES ON A DIFFERENT NODE. Set by the replica
       *  drag-out split (2026-08-26): a mid-drag exit from a replica the
       *  other breakpoints still render must not move the shared source —
       *  it commits a fresh-id canvas CLONE + a hide-on-origin, and the
       *  rest of the drag (canvas travel, frame entry, drop) operates on
       *  the clone. Coordinator renames the dragged node and swaps the
       *  id in `context.selectedIds` so end-of-drag bookkeeping follows. */
      newId?: string;
      /** The parent the gesture lifted the node out of — planted on
       *  `draggedNode.exitSourceParentId` so the receiving strategy knows
       *  which frame counts as "back to parent" (see shared/types). */
      sourceParentId?: string | null;
    }>;
    /** When the dragged element's data-node-id prefix changes during the
     *  switch (e.g. variant exit hoists to canvas root with no prefix),
     *  the coordinator must update `context.viewportPrefix` so the new
     *  strategy's bridge.patchStyles calls find the right element. */
    newViewportPrefix?: string;
  };
}

// ─── Layout Detection ──────────────────────────────────────────────────────

export type ParentLayoutMode = 'absolute' | 'flex' | 'grid' | 'block' | 'none';

// ─── Bridge-Compatible Layout Detection ────────────────────────────────────
// These work via nodeId+vpId (bridge helpers) instead of requiring an HTMLElement.
// Use these when you have a nodeId but not necessarily an element reference.

/**
 * Determine the layout mode of a parent by nodeId+vpId (bridge-compatible).
 * Returns 'absolute' if the bridge returns empty.
 */
export function detectParentLayoutById(parentId: string, vpId: string): ParentLayoutMode {
  // SVG container fast-path: nested SVG children are positioned via
  // `x/y` ATTRIBUTES, not CSS. Their computed CSS `position` is `static`
  // (default for SVG elements), which the flow-detection below would
  // misread as "this is a flex/grid/block flow container with flow
  // children" and route the drag through layout reorder. The actual
  // layout model is "absolute via SVG positioning" — the same logical
  // mode as `position: absolute` HTML children. Drags should write
  // `x/y` attrs (handled in updateNodeStyles), NOT reorder.
  if (getNodeFromCache(parentId)?.type === 'svg') return 'absolute';

  // Fall back to the node's INLINE display when the computed cache misses.
  // `findNodeComputedStyle` can momentarily return '' during the re-renders a
  // mid-drag reparent triggers; a flex/grid container's display is always
  // authored inline by the generator, so this keeps layout-mode detection
  // stable. Without it, a flex parent read as '' fell through to the
  // block/absolute branch, and a canvas-node drop into it wrongly reparented as
  // absolute + switched to absolute-in-frame (jumpy, no drop-line) instead of
  // showing the layout insertion line.
  const display = findNodeComputedStyle(parentId, vpId, 'display')
    || getNodeFromCache(parentId)?.styles?.display
    || '';
  if (display) {
    if (display === 'flex' || display === 'inline-flex') return 'flex';
    if (display === 'grid' || display === 'inline-grid') return 'grid';

    // Check children for flow detection — use findChildRects to get child IDs,
    // then check each child's computed position via bridge
    const childRects = findChildRects(parentId, vpId);
    let hasFlowChild = false;
    for (const child of childRects) {
      const pos = findNodeComputedStyle(child.id, vpId, 'position');
      if (pos && pos !== 'absolute' && pos !== 'fixed') {
        hasFlowChild = true;
        break;
      }
    }
    return hasFlowChild ? 'block' : 'absolute';
  }

  return 'absolute';
}

/**
 * Get the layout direction of a parent by nodeId+vpId (bridge-compatible).
 * Returns 'column' if the bridge returns empty.
 */
export function getFlexDirectionById(parentId: string, vpId: string): 'row' | 'column' {
  const styles = findNodeComputedStyles(parentId, vpId, ['display', 'flexDirection', 'gridAutoFlow']);
  const display = styles['display'] || '';

  if (display) {
    if (display === 'flex' || display === 'inline-flex') {
      const dir = styles['flexDirection'] || styles['flex-direction'] || '';
      return dir === 'column' || dir === 'column-reverse' ? 'column' : 'row';
    }
    if (display === 'grid' || display === 'inline-grid') {
      const flow = styles['gridAutoFlow'] || styles['grid-auto-flow'] || '';
      return flow?.includes('column') ? 'column' : 'row';
    }
    return 'column'; // block flow
  }

  return 'column';
}
