// exit-size.ts — the size a node keeps when it leaves a parent for the canvas.
//
// Every exit path measures the box the node occupied and commits it as
// `width`/`height` in px. For a node that was sizing itself to its CONTENT
// that is wrong: the measurement describes what it happened to be at the
// moment of the drag, not how it was configured. An auto-width text came out
// as a frozen `123px` box — the Dimensions panel flipped from "auto" to a
// number, and editing the text no longer resized it (user report
// 2026-10-05).
//
// Only `auto` carries over. A percentage, a stretch or a flex basis was
// resolved AGAINST THE PARENT, which the node no longer has; on the canvas
// root `100%` would mean something entirely different, so for those the
// measured px really is the honest preservation of what the user saw.

/** Style keys this applies to. */
export type SizeProp = 'width' | 'height';

/**
 * The value to commit for one axis on exit.
 *
 * @param authored  the node's OWN styles (model, not computed) — computed
 *                  always resolves to px and would defeat the whole point
 * @param prop      which axis
 * @param measured  the px fallback the strategy measured
 */
export function exitSize(
  authored: Record<string, string | undefined> | undefined | null,
  prop: SizeProp,
  measured: string,
): string {
  return (authored?.[prop] ?? '').trim() === 'auto' ? 'auto' : measured;
}

/** Both axes at once, for the common `{ width, height }` spread. */
export function exitSizes(
  authored: Record<string, string | undefined> | undefined | null,
  measuredWidth: string,
  measuredHeight: string,
): { width: string; height: string } {
  return {
    width: exitSize(authored, 'width', measuredWidth),
    height: exitSize(authored, 'height', measuredHeight),
  };
}
