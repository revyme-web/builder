// transform-utils.ts — shared CSS transform helpers for drag strategies.

/** Remove `translate(...)`, `translateX(...)`, `translateY(...)` and
 *  `translate3d(...)` from a CSS transform string, preserving every
 *  other function (rotate, scale, skew, matrix, perspective, etc.).
 *  Returns trimmed leftover or empty string if nothing remains. */
export function stripTranslateFunctions(transform: string): string {
  if (!transform || transform === 'none') return '';
  return transform
    .replace(/translate3d\s*\([^)]*\)\s*/gi, '')
    .replace(/translate[XY]?\s*\([^)]*\)\s*/gi, '')
    .trim();
}

/** Sum every `translate(...)` / `translateX(...)` / `translateY(...)`
 *  / `translate3d(...)` value in a CSS transform string into a single
 *  (x, y) pixel offset. Percent values resolve against the provided
 *  element size (CSS spec: `translateX(N%)` = N% of element's width).
 *
 *  Used by drag strategies + snap so the dragged element's VISIBLE
 *  position (cssLeft + translateOffset) drives snap candidates and
 *  guide alignment — without it, percent-translated elements (e.g.
 *  `translate(-50%, -50%)` for centering) snap against their css
 *  position which is half the element off from where the user sees
 *  the visible edges.
 *
 *  Other transform functions (rotate, scale, skew, matrix,
 *  perspective) don't contribute a direct (x, y) translate and are
 *  ignored — snap doesn't try to handle rotated AABBs here.
 */
export function parseTranslateOffset(
  transform: string,
  elementWidth: number,
  elementHeight: number,
): { x: number; y: number } {
  if (!transform || transform === 'none') return { x: 0, y: 0 };
  let x = 0;
  let y = 0;

  const resolveValue = (raw: string, basis: number): number => {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    if (trimmed.endsWith('%')) return (parseFloat(trimmed) / 100) * basis;
    // px / unitless: parseFloat ignores the suffix.
    return parseFloat(trimmed) || 0;
  };

  // `translate(X[, Y])` — Y defaults to 0 when omitted.
  const translateRe = /translate\s*\(\s*([^,)]+?)(?:\s*,\s*([^)]+?))?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = translateRe.exec(transform)) !== null) {
    x += resolveValue(m[1], elementWidth);
    if (m[2] !== undefined) y += resolveValue(m[2], elementHeight);
  }

  // `translateX(X)` and `translateY(Y)` — single-axis.
  const txRe = /translateX\s*\(\s*([^)]+?)\s*\)/gi;
  while ((m = txRe.exec(transform)) !== null) {
    x += resolveValue(m[1], elementWidth);
  }
  const tyRe = /translateY\s*\(\s*([^)]+?)\s*\)/gi;
  while ((m = tyRe.exec(transform)) !== null) {
    y += resolveValue(m[1], elementHeight);
  }

  // `translate3d(X, Y, Z)` — only X and Y matter for 2D layout.
  const t3dRe = /translate3d\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*[^)]+?\s*\)/gi;
  while ((m = t3dRe.exec(transform)) !== null) {
    x += resolveValue(m[1], elementWidth);
    y += resolveValue(m[2], elementHeight);
  }

  return { x, y };
}
