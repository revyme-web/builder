// out-of-flow-order.ts — keep absolutely / fixed positioned flex children
// painting ABOVE the flow siblings they follow when those siblings get
// renumbered.
//
// Measured in Chrome 148 (e2e bisect on a user page, 2026-09-09): an
// absolutely-positioned child of a flex container is painted as if its
// `order` were 0 — whatever `order` it carries itself. Every builder reorder
// writes sequential `order: 0..N` on the flow siblings, so the moment any
// sibling gets `order: 1` every out-of-flow overlay in that parent drops
// BEHIND it: a hero pinned at the top of a page vanished under the next
// section's opaque background the instant a header was dropped above it.
// Clearing all orders or giving the overlay `z-index: 1` brings it back.
//
// Rule (DOM paint order, expressed with z-index): an out-of-flow child whose
// nearest preceding flow sibling now has a POSITIVE order gets `z-index: 1`
// when it has none — it stays above the flow siblings before it, as the DOM
// order says. One placed before every flow sibling (a background layer)
// keeps painting below them and is left alone.

export interface OrderAssignment { nodeId: string; order: number }
export interface LayerAssignment { nodeId: string; zIndex: number }

export function outOfFlowLayeringForOrders(
  assignments: readonly OrderAssignment[],
  /** ALL of the parent's children in DOM (JSX) order. */
  childrenInDomOrder: readonly string[],
  isOutOfFlow: (id: string) => boolean,
  /** Current z-index of a child (undefined / 'auto' when none). */
  currentZIndex: (id: string) => string | undefined,
): LayerAssignment[] {
  if (assignments.length === 0) return [];
  const assigned = new Map(assignments.map(a => [a.nodeId, a.order]));
  const out: LayerAssignment[] = [];
  let lastFlow: number | undefined;
  for (const id of childrenInDomOrder) {
    if (assigned.has(id)) { lastFlow = assigned.get(id); continue; }
    if (!isOutOfFlow(id)) continue;
    if (lastFlow === undefined || lastFlow <= 0) continue;
    const z = (currentZIndex(id) ?? '').trim();
    if (z !== '' && z !== 'auto') continue;
    out.push({ nodeId: id, zIndex: 1 });
  }
  return out;
}
