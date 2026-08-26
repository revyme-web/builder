// dragged-node-rect.ts — WHICH viewport's copy of the dragged node to measure.
//
// Reported 2026-08-26: dragging a node out of a layout parent on the MOBILE
// tile, onto the canvas, and then into a no-layout canvas frame never
// reparented — on mouseup it stayed a canvas node. The identical gesture
// starting from the primary worked. The trace showed CanvasDragStrategy
// emitting no entry action of ANY kind for the whole canvas phase: not
// `entry-best-candidate`, not `entry-cleared`. Entry detection was blind, not
// wrong.
//
// Cause: mid-drag, LayoutLiftedStrategy commits the exit-to-canvas and hands
// off. The node MODEL is canvas-rooted from that instant (`viewportPrefix`
// becomes `''` → vpId `desktop`), but that exit deliberately skips the
// imperative re-home, so the live DOM element is still parked in the ORIGIN
// tile — every per-frame write during the canvas phase goes to `vpId: mobile`.
// Measuring the dragged element under the model's prefix therefore reads the
// DESKTOP copy, and drag start had already hidden that copy
// (`layout-lifted:hide-synced-replicas` puts `display: none` on the node in
// every viewport but the one being dragged). A hidden copy has no measurable
// rect, so `detectSingleNodeContainment` bailed on its very first line, every
// frame, for the entire drag.
//
// From the primary that same lookup hits the copy the user is actually
// dragging — visible by definition — which is exactly why only replicas broke.
//
// The rule this encodes: measure a node where it is PAINTED, not where the
// model says it lives. Those two agree everywhere except inside a mid-drag
// handoff, which is precisely when entry detection matters.

/** The subset of DOMRect this module needs — keeps the resolver testable
 *  without a DOM. */
export interface RectLike {
  width: number;
  height: number;
}

/**
 * A rect that can actually be measured against.
 *
 * `display: none` is the case that matters: depending on how far the render
 * got, a hidden copy is either absent from the rect cache or present as a
 * collapsed 0-area entry. Both mean "not on screen here", and a containment
 * test against a zero rect silently answers "outside" rather than failing —
 * which is how this stayed invisible. Same reasoning as
 * `reorderable-children.ts`, where a per-replica hide also shows up as 0×0.
 */
export function isMeasurableRect(rect: RectLike | null | undefined): boolean {
  return !!rect && rect.width > 0 && rect.height > 0;
}

/**
 * Pick the viewport to measure the dragged node in.
 *
 * Prefers the caller's viewport — during an ordinary drag that is where the
 * element lives and no scan happens. Falls back to any other viewport whose
 * tile paints it, in `fallbackVpIds` order, so a handed-off replica drag finds
 * the tile still holding the element.
 *
 * Returns the vpId alongside the rect: callers need it for the FOLLOW-UP
 * lookups on the same element (computed transform, painted corners), which
 * must come from the same copy or the geometry silently mixes two viewports.
 */
export function resolveDraggedRect<T extends RectLike>(
  preferredVpId: string,
  fallbackVpIds: readonly string[],
  lookup: (vpId: string) => T | null,
): { vpId: string; rect: T } | null {
  const preferred = lookup(preferredVpId);
  if (isMeasurableRect(preferred)) return { vpId: preferredVpId, rect: preferred as T };

  for (const vpId of fallbackVpIds) {
    if (vpId === preferredVpId) continue;
    const rect = lookup(vpId);
    if (isMeasurableRect(rect)) return { vpId, rect: rect as T };
  }
  return null;
}
