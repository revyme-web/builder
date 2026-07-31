// order-positioning.ts — Helpers for spaced-rank CSS `order` math used by
// LayoutLiftedStrategy during drag.
//
// At drag start each layout sibling gets `order = visualRank * ORDER_GAP`
// (e.g. 0, 10, 20). The placeholder takes the dragged element's spaced order
// so it visually replaces the lifted element. During drag the placeholder's
// order is rewritten to slot it between siblings — pickPlaceholderOrder
// returns an integer strictly between two neighbors so flex re-sorts the
// placeholder to the requested visual position WITHOUT touching DOM order
// or rewriting siblings' orders every move.
//
// Why a gap of 10:
//   - Leaves room for many in-between slots before the strategy ever has to
//     renumber siblings (haven't hit that yet — typical drag commits a final
//     sequential 0/1/2/... assignment, so the spaced state is short-lived).
//   - Round((prev + next) / 2) is always strictly between prev and next when
//     |next - prev| >= 2, which is true with any gap >= 2.

/** Gap between adjacent rank-based order values. Must be >= 2 so the midpoint
 *  computation in pickPlaceholderOrder always produces an integer strictly
 *  between two adjacent ranks. */
export const ORDER_GAP = 10;

/** Convert a 0-based visual rank to a spaced CSS `order` value. */
export function rankToOrder(rank: number): number {
  return rank * ORDER_GAP;
}

/**
 * Pick a CSS `order` value for the placeholder so it lands at the requested
 * insert index in the visual rank sequence.
 *
 * @param siblingOrders The current `order` values of the non-dragged siblings,
 *                      in visual order (typically each is some rank * ORDER_GAP).
 * @param insertIndex   Target visual slot for the placeholder. 0 = before the
 *                      first sibling. siblings.length = after the last.
 *                      Anything in between = between siblings[i-1] and siblings[i].
 *
 * Returns an integer strictly between the two neighboring siblings (or beyond
 * the ends with a half-gap padding). Returns 0 when there are no siblings.
 */
export function pickPlaceholderOrder(siblingOrders: number[], insertIndex: number): number {
  if (siblingOrders.length === 0) return 0;
  const halfGap = Math.floor(ORDER_GAP / 2);
  if (insertIndex <= 0) {
    return siblingOrders[0] - halfGap;
  }
  if (insertIndex >= siblingOrders.length) {
    return siblingOrders[siblingOrders.length - 1] + halfGap;
  }
  const prev = siblingOrders[insertIndex - 1];
  const next = siblingOrders[insertIndex];
  return Math.round((prev + next) / 2);
}

/** A 1D sibling extent along the flow axis (top/bottom for column,
 *  left/right for row), in any consistent coordinate space. */
export interface FlowSpan { start: number; end: number }

/**
 * Clip sibling spans so each starts at or after the previous one's end.
 *
 * Raw AABBs are NOT disjoint when a sibling is pulled over its neighbour by
 * a negative margin (e.g. a section title frame with `marginTop: -614px`
 * overlapping the section above it). In the overlap zone the cursor is
 * "inside" TWO siblings at once, so a containment walk answers differently
 * as the layout reflows around the moving placeholder — the reorder index
 * oscillates, the placeholder jumps at drag start, and the drop commits
 * whatever the flap last said (the "lands somewhere I don't even know" bug).
 *
 * Clipping to monotonic spans assigns the overlap deterministically to the
 * EARLIER sibling in flow order. Non-overlapping layouts pass through
 * unchanged, so ordinary reorders behave exactly as before.
 */
export function normalizeFlowSpans(spans: FlowSpan[]): FlowSpan[] {
  let cursor = -Infinity;
  return spans.map((s) => {
    const start = Math.max(s.start, cursor);
    const end = Math.max(s.end, start);
    cursor = end;
    return { start, end };
  });
}
