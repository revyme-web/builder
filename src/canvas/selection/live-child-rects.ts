// live-child-rects.ts — child geometry for handles drawn BETWEEN a container's
// children (GapHandles), read LIVE from the iframe instead of the sync cache.
//
// Why the cache can't be used at the moment these handles need it:
//
//   1. `SelectionOverlay` unmounts every handle for the duration of an
//      interaction (its `if (isInteracting)` early return — the gesture itself
//      runs on window listeners). Handles MOUNT FRESH on pointer-up, so no
//      amount of tracking-during-the-drag can carry a position forward.
//   2. For that whole gesture the sandbox downgraded each patch's subtree
//      refresh to the patched ELEMENT only (`setDndInteracting` → rect-emit
//      gate; a deliberate perf call — the per-element storm measured ~2900
//      messages the parent mostly dropped). The gesture-end
//      `forceRemeasureAllRects` reconciles it afterwards.
//
// Together: at mount every CHILD rect in the cache is pre-drag, and stays that
// way until the gesture-end sweep lands. GapHandles therefore painted the old
// positions and snapped ~0.3s later (user report 2026-07-26; the trace shows
// `sandbox:subtree-refresh` firing exactly ZERO times across the drag).
//
// PaddingHandles survives the identical remount because it reads only the
// container's OWN rect + computed padding — both kept fresh by the per-patch
// emit. This module is that same principle for child geometry: read live, and
// don't paint a frame you know is stale.

/** Is a live child-rect read available on this bridge? The DirectBridge
 *  fallback (tests, non-iframe canvas) has no async read — callers must paint
 *  from the sync cache there rather than suppressing the handles forever. */
export function liveChildRectsSupported(bridge: { getChildRectsAsync?: unknown } | null | undefined): boolean {
  return typeof bridge?.getChildRectsAsync === 'function';
}

export interface IdRect { id: string; rect: DOMRect }

/**
 * The rect each child should be drawn with: the live one when we have it, else
 * the cached one.
 *
 * Ids and their ORDER come from the caller's (model-filtered) list — this only
 * swaps geometry. Taking ids from the live read instead would drop the hidden-
 * child and out-of-flow filters applied upstream and sprout handles next to
 * elements that aren't in the flex flow at all.
 */
export function withLiveRects(
  cached: readonly IdRect[],
  live: ReadonlyMap<string, DOMRect> | null,
): IdRect[] {
  if (!live || live.size === 0) return cached as IdRect[];
  return cached.map(c => ({ id: c.id, rect: live.get(c.id) ?? c.rect }));
}
