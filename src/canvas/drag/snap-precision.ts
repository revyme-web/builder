// snap-precision.ts — the correction that puts a snapped drag EXACTLY on its
// target, for every dragged node.
//
// Reported 2026-08-24: at high zoom a snapped element jiggled ±1px with every
// mouse move, and the dynamic-pin badge flipped L/R/L/R while the element was
// visibly locked to a guide. One cause for both.
//
// The strategies used to round the pre-snap position to whole CSS px and then
// measure the snap correction against the ROUNDED value:
//
//     raw        = startLocal + delta
//     correction = target - round(raw)
//     committed  = raw + correction  =  target + (raw - round(raw))
//
// so the rounding residue — anywhere in [-0.5, 0.5) — rode straight through
// into a position that is supposed to BE the target, and `Math.round` at the
// CSS write turned it into a 1px sawtooth. The same residue swung the
// dynamic-pin right-edge test across its 1px threshold, which is why the pin
// flickered in lockstep with the jiggle.
//
// It is invisible at 100% zoom, where one mouse pixel is one CSS pixel and the
// residue never changes. Only when a mouse pixel is a FRACTION of a CSS pixel
// does it sweep — hence "a zoom bug".
//
// The fix is to keep the pre-snap position unrounded and let each node's own
// CSS write do the rounding. Measure the correction against the raw value and
// the residue cancels by construction.

/**
 * How far every dragged node must shift, in parent-local px, for the PRIMARY
 * node to land on its snap target.
 *
 * `rawLocal` must be the UNROUNDED `startLocal + delta`. Rounding it before
 * this call reintroduces the defect above — the correction can only cancel a
 * residue it can see.
 *
 * Returns 0 on an un-snapped axis, so the drag follows the cursor untouched.
 */
export function snapCorrection(
  rawLocal: number,
  snappedAbs: number,
  parentOffset: number,
  snapped: boolean,
): number {
  if (!snapped) return 0;
  return (snappedAbs - parentOffset) - rawLocal;
}
