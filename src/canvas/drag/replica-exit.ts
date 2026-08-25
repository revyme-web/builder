// replica-exit.ts — dragging a layout child OUT of a non-primary viewport.
//
// A page replica (tablet/mobile) and a component-master variant tile render the
// SAME JSX element. So "move it to the canvas" is only ever right when this
// viewport is the last one showing it; otherwise the move deletes it from the
// primary and every sibling replica too.
//
// `LayoutLiftedStrategy` has answered this correctly for a long time, in two
// paths (move the source when solo, else clone to canvas + hide the source
// here). `GridDragStrategy` — a separate strategy for grid parents — never
// learned any of it and moved the source unconditionally: dragging a grid child
// out of one variant removed it from ALL of them, primary included (reported
// 2026-08-24, and the reason this predicate now lives in one place rather than
// inline in a 3,900-line strategy).

/** Everything the decision needs, injected so the rule itself stays pure. */
export interface ReplicaOnlyQuery {
  /** Viewport the drag STARTED on (`desktop` for a master's default variant). */
  dropVpId: string;
  /** Every viewport id on canvas for the active file, this one included. */
  otherVpIds: string[];
  /** Component master (variant tiles) vs page (breakpoint replicas). */
  isComponentMaster: boolean;
  /** Variants the node is hidden on — a master's visibility channel. */
  hiddenOnVariants?: Set<string> | null;
  /** The node's own inline `display` — a page replica's visibility channel. */
  inlineDisplay?: string;
  /** Computed `display` for the node on another viewport (page replicas only). */
  readDisplay: (vpId: string) => string;
}

/** `desktop` is the id the primary variant renders under; `default` is its name. */
const variantNameOf = (vpId: string) => (vpId === 'desktop' ? 'default' : vpId);

/**
 * Is `dropVpId` the ONLY viewport currently rendering this node?
 *
 * True → the source can be moved to the canvas outright; nothing else shows it.
 * False → the source must stay put (hidden on this viewport only) and a CLONE
 * goes to the canvas, or the other replicas lose the element.
 *
 * The two file kinds keep visibility in different places, and reading the wrong
 * one silently returns `true` for everything — which is exactly how a "solo"
 * answer once let a variant drag-out move a shared element:
 *
 * • **Component master** — the AnimatePresence + conditional-render pattern
 *   puts visibility in `hiddenOnVariants`, NOT inline `display`. Solo iff every
 *   OTHER variant is in that set. An empty set means "visible everywhere", so
 *   it is never solo.
 * • **Page replica** — the legacy inline `display: 'none'` baseline plus
 *   `@media display: unset` on the one viewport that shows it. Solo iff this
 *   node is hidden by default and computes to `none` on every other viewport.
 */
export function isReplicaOnlyOnViewport(q: ReplicaOnlyQuery): boolean {
  if (q.isComponentMaster) {
    const hidden = q.hiddenOnVariants;
    if (!hidden || hidden.size === 0) return false;
    const current = variantNameOf(q.dropVpId);
    for (const otherVpId of q.otherVpIds) {
      const name = variantNameOf(otherVpId);
      if (name === current) continue;
      if (!hidden.has(name)) return false;
    }
    return true;
  }

  if (q.inlineDisplay !== 'none') return false;
  for (const otherVpId of q.otherVpIds) {
    if (otherVpId === q.dropVpId) continue;
    const otherDisplay = q.readDisplay(otherVpId);
    if (otherDisplay && otherDisplay !== 'none') return false;
  }
  return true;
}
