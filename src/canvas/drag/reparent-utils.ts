// reparent-utils.ts — Shared utility for live DOM reparenting during drag.
// Moves an element from one parent to another while preserving its exact
// screen position. Used by CanvasDragStrategy and AbsoluteInFrameStrategy.
//
// The "set 0,0 → measure origin → calculate offset" pattern:
// 1. Capture element's screen position BEFORE moving
// 2. Move DOM element into new parent
// 3. Set left=0, top=0 (temporary)
// 4. Measure where that puts it on screen (the new parent's CSS origin)
// 5. Calculate: cssLeft = (screenBefore - originAt0) / canvasScale
// 6. Apply the calculated CSS left/top
//
// This works because both measurements are in screen space (same transform context),
// and dividing by scale converts screen-pixel deltas to CSS-pixel values.

import { findVisibleChildRects, findNodeRect } from '@/canvas/node-ops';
import { getNodeFromCache } from '@/code/stores/store';
import { detectParentLayoutById, getFlexDirectionById } from './types';
import { trace } from '@/shared/debug-trace';
import { calculateGridDrop } from './grid-drop';
import { findNodeComputedStyle } from '@/canvas/node-ops';





/**
 * Sort visible child rects into FLOW order — the order CSS actually lays
 * them out: ascending `order` style (default 0), ties broken by DOM
 * sequence (the input order of `findVisibleChildRects`, which walks the
 * real DOM). Geometric axis sorting (`rect.top`) was used before, but a
 * sibling with a NEGATIVE MARGIN overlaps its neighbour and can start
 * ABOVE it — the geometric order then inverts against the real flow
 * order, midpoints go non-monotonic, and both the insert index and the
 * committed `order` renumber come out wrong. Flow order is immune to
 * geometry entirely.
 */
function sortChildRectsByFlow(
  children: { id: string; rect: DOMRect }[],
  getNodeOrder?: (nodeId: string) => string | undefined,
): { id: string; rect: DOMRect }[] {
  const orderOf = (id: string): number => {
    const raw = getNodeOrder ? getNodeOrder(id) : getNodeFromCache(id)?.styles?.order;
    const n = parseFloat(String(raw ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  // Array.prototype.sort is stable — equal orders keep DOM sequence.
  return [...children].sort((a, b) => orderOf(a.id) - orderOf(b.id));
}

/**
 * A flow child of a FLEX container with NO explicit `flex` defaults to
 * `flex: 0 1 auto` (shrink 1) and collapses to ~0 in a constrained flex
 * column/row — the "node disappears when dropped into a flex layout" bug. When
 * a node ENTERS a flex parent and doesn't already declare its own flex sizing
 * (Fill `1 0 0px` / Fixed `0 0 auto`, or any flexGrow/Shrink/Basis), it must be
 * pinned to `0 0 auto`. Returns the flex string to inject, or null when none is
 * needed (parent isn't flex, or the node already sizes itself — don't clobber a
 * user's Fill). design-tool parity: flex children never shrink. Shared by the canvas
 * drag reparent (CanvasDragStrategy) and the layers-panel drop (LayersPanel/drag).
 */
export function flexForFlowChildEnteringFlex(
  nodeStyles: Record<string, string> | undefined,
  parentLayout: string | null | undefined,
): string | null {
  if (parentLayout !== 'flex') return null;
  const s = nodeStyles || {};
  const declaresFlex = s.flex != null || s.flexGrow != null || s.flexShrink != null || s.flexBasis != null;
  return declaresFlex ? null : '0 0 auto';
}

/**
 * Compute new flex `order` assignments for a desired child order.
 * Returns { nodeId, order }[] for the children that CAN take an order write.
 *
 * The `{children}` slot (`children-slot`) is special: it's a JSX expression, not
 * an element, so writing an inline `order` to it is a no-op in source — the
 * write silently vanishes on the next re-parse and the slot snaps back to its
 * default (0) flex position. A naive sequential `0,1,2…` therefore breaks any
 * reorder that crosses the slot (e.g. dragging a section ABOVE `{children}`):
 * the section is told `order:0`, the slot `order:1` (dropped), so the slot stays
 * at 0 and the section snaps back BELOW it on mouseup.
 *
 * Fix: treat `children-slot` as an UNWRITABLE ANCHOR pinned at order 0, and
 * assign every real sibling an order RELATIVE to it — negative for siblings
 * before the slot, positive for those after — and EXCLUDE the slot from the
 * returned writes. So `[CTA, slot, Footer]` → `CTA:-1, Footer:1` (slot untouched
 * at 0) → visual `[CTA, slot, Footer]`, which round-trips through source.
 */
export function computeReorderAssignments(
  desiredOrder: string[],
): { nodeId: string; order: number }[] {
  const anchorIdx = desiredOrder.indexOf('children-slot');
  if (anchorIdx < 0) {
    return desiredOrder.map((id, i) => ({ nodeId: id, order: i }));
  }
  const out: { nodeId: string; order: number }[] = [];
  for (let i = 0; i < desiredOrder.length; i++) {
    if (desiredOrder[i] === 'children-slot') continue; // unwritable — pinned at 0
    out.push({ nodeId: desiredOrder[i], order: i - anchorIdx });
  }
  return out;
}

/**
 * When a node is being inserted into a flex/grid parent at a visual position,
 * AND the parent's children have explicit `order` styles (from prior reorder
 * operations), inserting in JSX order alone leaves the dragged element with
 * the CSS default `order: 0` — placing it visually at the start of the
 * order:0 group instead of where the user dropped it.
 *
 * This helper detects the situation and returns a list of style updates that
 * RENUMBER all children (existing + the inserted dragged ones) to sequential
 * 0..N orders matching the desired visual layout. Returns [] when no child
 * has an explicit order — the JSX insertion alone is enough.
 *
 * @param parentId       - The flex/grid parent receiving the insert.
 * @param vpId           - Active viewport (for rect lookup).
 * @param insertIndex    - Where the dragged should land in visual order.
 * @param draggedIds     - The dragged element ids (may be 1+ for multi-select).
 * @param direction      - 'column' or 'row' for sort axis.
 * @param getNodeStyles  - Reads a node's inline `order` style (caller-provided
 *                         to keep the helper free of NodeMap imports).
 */
export function computeLayoutInsertOrderUpdates(
  parentId: string,
  vpId: string,
  insertIndex: number,
  draggedIds: string[],
  direction: 'column' | 'row',
  getNodeOrder: (nodeId: string) => string | undefined,
): { nodeId: string; order: number }[] {
  // Must read the same child set `calculateLayoutInsertIndexById` does —
  // the `insertIndex` we receive was computed against
  // `findVisibleChildRects` (filters hidden / 0×0). If we read the full
  // unfiltered list here, hidden siblings shift our slot count and the
  // dragged node lands in a different position than where the drop-line
  // showed. Concrete repro: a `display:none` sibling sits at position
  // 0 in the unfiltered list. The visible-list `insertIndex=2` becomes
  // unfiltered-list position 3, so the renumber lands the new node one
  // slot earlier than intended.
  const childRects = findVisibleChildRects(parentId, vpId);
  const draggedSet = new Set(draggedIds);
  // Flow order, not geometric order — see sortChildRectsByFlow. Must match
  // the basis calculateLayoutInsertIndexById computed `insertIndex` against.
  const existing = sortChildRectsByFlow(
    childRects.filter(c => !draggedSet.has(c.id)),
    getNodeOrder,
  );

  // NO early-out when the siblings carry no explicit `order`.
  //
  // It used to return [] there, which left the inserted child (and its
  // siblings) with no `order` at all — the CSS default 0. That reads fine until
  // someone drags to reorder: the engine manipulates `order`, and a child
  // without one snaps to the front of the order:0 group. It also bounces the
  // oracle's FLEX_CHILD_MISSING_ORDER, which a component built entirely in the
  // editor tripped four times (user report 2026-07-26) — the builder failing
  // its own gate.
  //
  // Stamping sequential orders in the CURRENT flow sequence is visually a
  // no-op: with no explicit order, flow order IS DOM order, so 0,1,2… over that
  // same sequence renders identically. It happens once per parent; afterwards
  // the explicit-order path above takes over.

  const desiredVisualOrder: string[] = [];
  for (let i = 0; i <= existing.length; i++) {
    if (i === insertIndex) {
      for (const id of draggedIds) desiredVisualOrder.push(id);
    }
    if (i < existing.length) desiredVisualOrder.push(existing[i].id);
  }

  trace.action('reparent-utils:computeLayoutInsertOrderUpdates', {
    parentId, vpId, insertIndex, draggedIds, direction,
    desiredVisualOrder,
  });

  // Anchor-aware, NOT plain sequential: when editing a template the visible
  // children include the `{children}` slot (findVisibleChildRects), which is
  // a JSX expression — an order write to it silently vanishes on re-parse.
  // computeReorderAssignments pins the slot at 0 and numbers real siblings
  // relative to it (negative before / positive after), excluding the slot
  // from the writes. On pages (no slot in the list) it degrades to the same
  // sequential 0..N this returned before.
  return computeReorderAssignments(desiredVisualOrder);
}


/**
 * Bridge-compatible version of calculateLayoutInsertIndex.
 * Uses findChildRects() instead of DOM iteration.
 * Returns the insertion index for a dragged element in a layout parent.
 *
 * Hidden-child filter: a child whose computed `display === 'none'` for THIS
 * vpId is excluded from the gap-midpoint calculation. Otherwise its rect is
 * 0×0 at its inline `left`/`top`, the midpoint check fires at that x/y, and
 * a phantom drop-line shows up where there's no visible element. Common
 * case: a node visible only in tablet (display:none on desktop via inline +
 * @container override) — dragging over the same parent in desktop must NOT
 * surface a line indicator for that node. Equivalent for component variants
 * (display:none in `default` variant). Reads through the bridge's
 * computed-style cache, so it's O(1) per child during drag.
 */
export function calculateLayoutInsertIndexById(
  mouseScreen: { x: number; y: number },
  parentId: string,
  vpId: string,
  direction: 'row' | 'column',
  excludeIds: Set<string> = new Set(),
): number {
  // Grid parents get 2D-aware computation: the cursor's row + column
  // zone together pick the inter-cell gap, and the insert index lands
  // at the cell that gap is between. The 1D `direction` param has no
  // meaningful answer for grid — its row-major flow handles "horizontal
  // insert" the same way "vertical insert" would for column-flow. Same
  // `calculateGridDrop` powers the DropLineIndicator's grid line so the
  // index and the line geometry agree.
  const display = findNodeComputedStyle(parentId, vpId, 'display');
  if (display === 'grid' || display === 'inline-grid') {
    const r = calculateGridDrop(mouseScreen, parentId, vpId, excludeIds);
    trace.action('reparent-utils:calculateGridDrop', {
      parentId, vpId, mousePos: mouseScreen,
      insertIdx: r.insertIndex, hasLine: !!r.line,
    });
    return r.insertIndex;
  }

  // `findVisibleChildRects` already drops hidden / zero-area children; we
  // only need to subtract the dragged set on top.
  const visibleRects = findVisibleChildRects(parentId, vpId);
  if (visibleRects.length === 0) return 0;

  const unsorted = visibleRects.filter(c => !excludeIds.has(c.id));
  if (unsorted.length === 0) return 0;

  // Sort into FLOW order (CSS `order` + DOM sequence) — that's the order
  // the layout actually flows, and unlike geometric axis sorting it can't
  // invert when a negative-margin sibling overlaps its neighbour.
  const filtered = sortChildRectsByFlow(unsorted);

  const mousePos = direction === 'row' ? mouseScreen.x : mouseScreen.y;

  // For each child, check if mouse is before or after its midpoint.
  // Midpoints are clamped MONOTONIC along the walk: an overlapping
  // (negative-margin) sibling's raw midpoint can sit BEFORE the previous
  // sibling's, which would make the first-midpoint-past-the-pointer scan
  // unstable. Clamping keeps every insert slot reachable and the answer
  // deterministic; disjoint layouts are unaffected (already monotonic).
  let lastMid = -Infinity;
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i].rect;
    const rawMid = direction === 'row'
      ? r.left + r.width / 2
      : r.top + r.height / 2;
    const mid = Math.max(rawMid, lastMid + 1);
    lastMid = mid;

    if (mousePos < mid) {
      trace.action('reparent-utils:calculateLayoutInsertIndexById', {
        parentId, vpId, direction,
        childCount: filtered.length,
        insertIdx: i,
        mousePos,
        mids: filtered.map((f, idx) => ({
          idx, id: f.id,
          mid: direction === 'row' ? f.rect.left + f.rect.width / 2 : f.rect.top + f.rect.height / 2,
          rectStart: direction === 'row' ? f.rect.left : f.rect.top,
          rectEnd: direction === 'row' ? f.rect.right : f.rect.bottom,
        })),
      });
      return i;
    }
  }

  trace.action('reparent-utils:calculateLayoutInsertIndexById', {
    parentId, vpId, direction,
    childCount: filtered.length,
    insertIdx: filtered.length,
    mousePos,
    mids: filtered.map((f, idx) => ({
      idx, id: f.id,
      mid: direction === 'row' ? f.rect.left + f.rect.width / 2 : f.rect.top + f.rect.height / 2,
      rectStart: direction === 'row' ? f.rect.left : f.rect.top,
      rectEnd: direction === 'row' ? f.rect.right : f.rect.bottom,
    })),
  });

  return filtered.length;
}


/**
 * Edge-magnet promotion. Given a current "best containing frame" and the
 * cursor position, returns the frame's parent when the cursor sits within
 * `edgePx` of the frame's edge ALONG the parent's layout axis — so the
 * caller's `calculateLayoutInsertIndexById` runs on the parent and shows
 * a drop-line between the current frame and its visual neighbour.
 *
 * Why: when two layout siblings (e.g. viewport sections) touch with no
 * gap, dropping "between" them is otherwise unreachable. The cursor is
 * always inside one of the two siblings — the parent never wins the
 * containment race. Without magnetism the only way to insert between
 * them is to land on the exact 1-pixel boundary.
 *
 * Returns the original `best` when:
 *   - the frame has no parent or parent === root
 *   - parent is not a flex/grid layout container
 *   - cursor is outside the frame on the layout axis (distStart/distEnd < 0)
 *   - cursor is further than `edgePx` from both layout-axis edges
 *
 * The cross-axis is intentionally ignored: a cursor near the right edge
 * of a column-flex child should not promote, because there's no sibling
 * on that axis to insert between.
 */
export function applyLayoutEdgeMagnet(
  best: { id: string; rect: DOMRect } | null,
  mouseScreen: { x: number; y: number },
  nodes: Map<string, any>,
  vpId: string,
  edgePx: number = 12,
): { id: string; rect: DOMRect } | null {
  if (!best) return best;

  const node = nodes.get(best.id);
  const parentId = node?.parentId;
  if (!parentId) return best;

  // Note: parent === 'root' is allowed. The viewport itself is `root`,
  // and the entire point of the magnet is to promote a section back UP
  // to the viewport when the cursor is near a section boundary so the
  // drop-line shows between sections in the viewport. The layout check
  // below filters out the case where root isn't actually a layout
  // container.
  const parentLayout = detectParentLayoutById(parentId, vpId);
  if (parentLayout !== 'flex' && parentLayout !== 'grid') return best;

  // GRID PARENTS: skip the magnet. The magnet's purpose was to let
  // flex-section drops fall back to the parent when the cursor sits in
  // the section's gutter — there's no inter-cell "drop between"
  // ambiguity to solve for flex. For grids the gap math is handled
  // upstream by `calculateGridDrop` (in grid-drop.ts) and the user
  // explicitly wants cursor-over-grid-child to enter that CHILD as a
  // frame, not promote back to the outer grid. Without this skip,
  // hovering anywhere within 12px of a cell edge — which is most of
  // the cell's footprint once you account for grid gaps — kept
  // bouncing the entry candidate from the cell back to the grid and
  // the user could never actually enter the cell.
  if (parentLayout === 'grid') return best;

  const direction = getFlexDirectionById(parentId, vpId);
  const isVertical = direction === 'column';

  const r = best.rect;
  const distStart = isVertical ? mouseScreen.y - r.top : mouseScreen.x - r.left;
  const distEnd   = isVertical ? r.bottom - mouseScreen.y : r.right - mouseScreen.x;

  // Cursor outside the frame on the layout axis — let the regular
  // hit-test pick the right target.
  if (distStart < 0 || distEnd < 0) return best;
  // Not in either edge zone — keep best as-is.
  if (distStart > edgePx && distEnd > edgePx) return best;

  const parentRect = findNodeRect(parentId, vpId);
  if (!parentRect) return best;

  trace.action('reparent-utils:applyLayoutEdgeMagnet', {
    fromId: best.id,
    toParentId: parentId,
    edge: distStart < distEnd ? 'start' : 'end',
    distStart, distEnd, edgePx,
  });

  return { id: parentId, rect: parentRect };
}
