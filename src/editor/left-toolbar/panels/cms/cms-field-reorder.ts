// cms-field-reorder.ts — the Fields tab's drop-target rule, pure.
//
// The collection's TITLE is "the first text-type field" (it names items in the
// sidebar and seeds the auto slug), so a reorder must never put another TEXT
// field above it. The rule is applied to the drag PREVIEW (dnd-kit collision
// targets) so what the user sees while dragging is what commits — not only at
// drop, where a clamp silently snapped the row back (review find 2026-09-09).

/** Ids a dragged field may land on. Text field → only rows AFTER the title.
 *  Anything else (or no title) → every row. */
export function fieldDropTargets(ids: readonly string[], titleFieldId: string | null, movedIsText: boolean): Set<string> {
  if (!movedIsText || !titleFieldId) return new Set(ids);
  const titleIdx = ids.indexOf(titleFieldId);
  if (titleIdx === -1) return new Set(ids);
  return new Set(ids.slice(titleIdx + 1));
}
