// handle-gates.ts — which canvas handles apply to a given node.
//
// Pure predicates over computed style, kept out of the overlay components so
// the rules can be read and tested without a bridge or a React tree.

/**
 * Does this `display` establish a LAYOUT — a container that arranges its own
 * children — as opposed to one whose children place themselves?
 *
 * Padding is the gap between a container's frame and the content box its
 * layout fills, so it is meaningful exactly here. A frame with no layout
 * positions its children off their own `left`/`top`, and offering padding
 * handles there invites an edit the user never asked for — they appeared on a
 * chart bar with no layout at all (reported 2026-08-24). The panel already
 * draws the line in the same place: `PaddingControl` renders inside the Layout
 * section and only when the node has one.
 *
 * `includes` rather than equality so `inline-flex` and `inline-grid` count.
 */
export function displayEstablishesLayout(display: string): boolean {
  const d = (display || '').trim();
  return d.includes('flex') || d.includes('grid');
}
