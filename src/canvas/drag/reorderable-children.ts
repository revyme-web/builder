// reorderable-children.ts — which of a parent's children can a drop line be
// drawn between, ON THIS VIEWPORT.
//
// Reported 2026-08-24: dragging a canvas node into a replica whose children are
// all hidden there showed before/after line indicators instead of a single
// "inside" affordance. `findChildRects` reports what the DOM has, and a
// `display: none` child is still a child — it just measures 0×0. So a replica
// that renders nothing looked exactly like one with two stacked siblings, and
// the drop line was drawn between boxes the user cannot see.

/** The shape `findChildRects` returns — id plus its measured rect. */
export interface ChildRect {
  id: string;
  rect: { width: number; height: number };
}

/** Template chrome is locked: never a reorder anchor. A templated viewport
 *  whose only children are the header/footer counts as EMPTY, so it offers the
 *  `{children}` slot rather than phantom lines between nodes you cannot move. */
const isTemplateChrome = (id: string) => id.startsWith('layout::') || id === 'children-slot';

/**
 * Children a drop line may anchor to on this viewport.
 *
 * Excludes the dragged nodes themselves, template chrome, and anything with no
 * painted area — which is how a per-replica hide shows up in a rect list. A
 * genuinely zero-sized visible box is indistinguishable here, and treating it
 * as "not an anchor" is the right call anyway: there is no meaningful before/
 * after against something occupying no space.
 */
export function reorderableChildren(children: ChildRect[], draggedIds: Set<string>): ChildRect[] {
  return children.filter((c) =>
    !draggedIds.has(c.id)
    && !isTemplateChrome(c.id)
    && c.rect.width > 0
    && c.rect.height > 0);
}

/** True when a drop line makes sense — i.e. something is actually visible to
 *  sit before or after. Otherwise the caller should offer "inside". */
export function hasReorderableChildren(children: ChildRect[], draggedIds: Set<string>): boolean {
  return reorderableChildren(children, draggedIds).length > 0;
}
