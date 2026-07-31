// Shared helpers for StylesTool atoms.

export function parsePx(v: string | undefined): number {
  if (!v) return 0;
  return parseFloat(v) || 0;
}

export function formatPx(n: number): string {
  return String(n);
}

// ─── Backdrop filter (blur) ──────────────────────────────────────────────────
//
// The Styles "Backdrop Filter" control is a single blur radius, stored as a
// CSS function string (`blur(14px)`) on both `backdropFilter` and the Safari-
// prefixed `WebkitBackdropFilter`. These two helpers convert between that
// string and the numeric px radius the slider/input speak. We keep them here
// (shared) rather than inline in the atom so they're unit-testable and reused
// if another surface ever needs to read a backdrop blur.

/**
 * Parse the blur radius (in px) out of a `backdrop-filter` value like
 * `blur(14px)`. Returns 0 when the value is absent, `none`, or has no blur().
 */
export function parseBackdropBlur(raw: string | undefined): number {
  if (!raw || raw === 'none') return 0;
  const m = raw.match(/blur\(\s*(-?[\d.]+)px\s*\)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Format a numeric px radius back into a `backdrop-filter` value (`blur(Npx)`). */
export function formatBackdropBlur(n: number): string {
  return `blur(${n}px)`;
}
