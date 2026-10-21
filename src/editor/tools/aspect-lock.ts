// aspect-lock.ts — the Dimensions panel's aspect-ratio lock as pure patches.
//
// A locked box is CSS `aspect-ratio` plus exactly ONE definite side (the one
// the user set last); the other side is Fit and the browser derives it from
// the ratio. Every write here keeps that invariant:
//
//   • the free side is written as FIT_SIZE (`min-content`), never a literal
//     `auto`. A flex parent STRETCHES an `auto` cross size and `aspect-ratio`
//     does not stop it — a locked vector in a navbar row grew to the row's
//     height. `min-content` holds the ratio in block, row and column parents
//     alike, and it is the spelling the unit dropdown's Fit already writes, so
//     every check asks `isFitSize` instead of `=== 'auto'` (the old checks
//     missed the dropdown's value and flipped units the user had chosen),
//   • a definite value committed on the free side (typed into the measured
//     field, or picked from the dropdown) makes THAT side the driver and the
//     other side Fit — leaving both definite made the browser drop the ratio,
//   • unlocking freezes the Fit side to the px it renders at, so nothing jumps.
//
// VECTORS are different (Framer parity): a shape's size is W×H in px, period —
// no unit choice, so no Fit / % / Fill. Its lock stores the ratio in the same
// `aspect-ratio` property (inert in CSS once both sides are definite) and every
// write sets BOTH sides in px through it — see the vector* helpers below.
//
// Bug #17, 2026-10-12: "choosing fit height or fit width while keeping the
// other side in px is not possible without locking/unlocking in weird ways".

import { FIT_SIZE, isFitSize } from '@/shared/constants';

export type Axis = 'width' | 'height';

export const otherAxis = (axis: Axis): Axis => (axis === 'width' ? 'height' : 'width');

type Dims = Record<string, string | undefined>;
type Size = { width: number; height: number };

/** An authored size the ratio can derive FROM: set, and not a Fit value. */
const isDefinite = (v: string | undefined): boolean => !!v && !isFitSize(v);

/** A CSS `aspect-ratio` value as width/height. Accepts `"1.5 / 1"`,
 *  `"16 / 9"` or a bare `"1.5"`; null when missing, `auto` or malformed. */
export function parseAspectRatio(value: string | undefined): number | null {
  const s = String(value ?? '').trim();
  if (!s || s === 'auto' || s === 'unset') return null;
  const slash = s.match(/([\d.]+)\s*\/\s*([\d.]+)/);
  if (slash) {
    const a = parseFloat(slash[1]);
    const b = parseFloat(slash[2]);
    return a > 0 && b > 0 ? a / b : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether the lock means something: each side is either definite or Fit,
 *  and at least one is definite (it is what the ratio derives from). An
 *  UNSET side stays unlockable — writing Fit onto it would change how it
 *  sizes before the user asked for anything. */
export function canLockAspect(styles: Dims): boolean {
  const ok = (v: string | undefined) => isDefinite(v) || isFitSize(v);
  return ok(styles.width) && ok(styles.height) && (isDefinite(styles.width) || isDefinite(styles.height));
}

/** The side a fresh lock leaves free. A side already on Fit stays the free
 *  one; with both definite a `%` keeps control (it is a responsive choice),
 *  else width drives and height follows. */
function freeAxisForLock(styles: Dims): Axis {
  if (isFitSize(styles.width) && isDefinite(styles.height)) return 'width';
  if (isDefinite(styles.width) && isFitSize(styles.height)) return 'height';
  if (String(styles.width ?? '').endsWith('%')) return 'height';
  if (String(styles.height ?? '').endsWith('%')) return 'width';
  return 'height';
}

/** Lock ON: store the rendered ratio and put the free side on Fit. Null when
 *  the box has no measurable size yet. */
export function aspectLockOnPatch(styles: Dims, size: Size): Record<string, string> | null {
  if (!(size.width > 0 && size.height > 0)) return null;
  return {
    aspectRatio: `${(size.width / size.height).toFixed(5)} / 1`,
    [freeAxisForLock(styles)]: FIT_SIZE,
  };
}

/** Lock OFF: drop the ratio and freeze the Fit side to the px it renders at
 *  — without the ratio a frame's Fit would hug its content and jump. */
export function aspectUnlockPatch(styles: Dims, size: Size): Record<string, string> {
  const patch: Record<string, string> = { aspectRatio: '' };
  for (const axis of ['width', 'height'] as const) {
    if (isFitSize(styles[axis])) patch[axis] = `${Math.round(size[axis])}px`;
  }
  return patch;
}

/** Locked: a definite `value` committed on `axis` — that side drives, the
 *  other derives. The other side is only written when it is not already the
 *  Fit spelling, so a replica doesn't gain a redundant override. */
export function lockedDimensionWrite(axis: Axis, value: string, styles: Dims): Record<string, string> {
  const other = otherAxis(axis);
  const patch: Record<string, string> = { [axis]: value };
  if (styles[other] !== FIT_SIZE) patch[other] = FIT_SIZE;
  return patch;
}

/** Locked: the user puts `axis` on Fit. When the other side is Fit too it
 *  takes over as the driver at its rendered px — two Fit sides under a ratio
 *  leave it nothing to derive from (a frame collapses to its content). */
export function lockedFitWrite(axis: Axis, styles: Dims, size: Size): Record<string, string> {
  const other = otherAxis(axis);
  const patch: Record<string, string> = { [axis]: FIT_SIZE };
  if (!isDefinite(styles[other]) && size[other] > 0) patch[other] = `${Math.round(size[other])}px`;
  return patch;
}

// ─── Vectors: W×H px + the lock ──────────────────────────────────────────────

const isPx = (v: string | undefined): boolean => /^-?[\d.]+px$/.test(String(v ?? '').trim());
const px2 = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** A vector's size row value for `axis`: its authored px, else (a legacy
 *  Fit / % / unset side) the px it renders at — the row only speaks px. */
export function vectorDisplayValue(axis: Axis, styles: Dims, size: Size): string {
  return isPx(styles[axis]) ? String(styles[axis]) : `${Math.round(size[axis])}px`;
}

/** A vector's size write. Locked (`ratio` set) → the other side follows
 *  through the ratio; unlocked → it keeps its size, frozen to px when it
 *  wasn't px yet (a legacy Fit / % side). Null for a non-number. */
export function vectorSizePatch(
  axis: Axis, value: string, styles: Dims, size: Size, ratio: number | null,
): Record<string, string> | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.max(0, n);
  const other = otherAxis(axis);
  const patch: Record<string, string> = { [axis]: px2(v) };
  if (ratio) patch[other] = px2(axis === 'width' ? v / ratio : v * ratio);
  else if (!isPx(styles[other])) patch[other] = px2(size[other]);
  return patch;
}

/** A vector's lock toggle. ON stores the rendered ratio and pins both sides
 *  to px (a legacy Fit / % side included); OFF only drops the ratio — both
 *  sides are px already. Null when there's no measured size to lock. */
export function vectorLockPatch(styles: Dims, size: Size, locked: boolean): Record<string, string> | null {
  if (locked) return { aspectRatio: '' };
  if (!(size.width > 0 && size.height > 0)) return null;
  const patch: Record<string, string> = { aspectRatio: `${(size.width / size.height).toFixed(5)} / 1` };
  for (const axis of ['width', 'height'] as const) {
    if (!isPx(styles[axis])) patch[axis] = px2(size[axis]);
  }
  return patch;
}
