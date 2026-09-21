// pin-field-units.ts — the Position pin fields (T/L/R/B) are px fields, but
// the SOURCE value for a side may be a percentage: a node created in percent-
// centre mode, or any side `toPercentageCenter` / the unpin-one-axis branch
// converted (see PinControl.handlePinToggle).
//
// Before this module the field did `Math.round(parsePx(value))` and the change
// handler appended `px`. `parsePx` is a bare `parseFloat`, so `36.7802%` showed
// as `37` and the first chevron committed `36px` — on an 807px-wide parent the
// element jumped from 296px to 36px, and the L pin silently flipped from
// unpinned to pinned (`isFixedPx` is the pin test). Every later edit was stable
// because the value was px by then. User report 2026-09-20.
//
// Rule: the field always SHOWS resolved CSS px, and always writes back in the
// unit the source already uses. Percent semantics match `livePinValues` — a
// fraction of the parent's padding box, translate excluded — so the two agree.

/** Total is the parent dimension on this side's axis; 0/unknown = no resolve. */
export function pinFieldDisplayPx(value: string | undefined, total: number): number {
  if (!value) return 0;
  const num = parseFloat(value);
  if (isNaN(num)) return 0;
  if (value.trim().endsWith('%')) return total > 0 ? (num / 100) * total : 0;
  return num;
}

/**
 * The painted distance from each parent edge, for a side the source does NOT
 * declare. Without this the field shows `0` for an undeclared side, so the
 * first chevron commits `-1px` and slams the element against that edge
 * (user report 2026-09-20: B read 0 on a node sitting 174px off the bottom).
 *
 * Same math as `livePinValues`: the LAYOUT box, translate removed, so the
 * number agrees with what the other fields show.
 */
export function paintedPinPx(
  rect: { left: number; top: number; width: number; height: number; parentWidth: number; parentHeight: number },
  translateX: number,
  translateY: number,
): Record<'left' | 'top' | 'right' | 'bottom', number> {
  const cssLeft = rect.left - translateX;
  const cssTop = rect.top - translateY;
  return {
    left: cssLeft,
    top: cssTop,
    right: rect.parentWidth - cssLeft - rect.width,
    bottom: rect.parentHeight - cssTop - rect.height,
  };
}

/** Typed/chevroned px back into the source's unit. `''` clears, as everywhere. */
export function pinFieldCommitValue(typed: string, sourceValue: string | undefined, total: number): string {
  const raw = typed.trim();
  if (raw === '') return '';
  if (raw.endsWith('%') || raw.endsWith('px')) return raw;
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  if (sourceValue && sourceValue.trim().endsWith('%')) {
    if (total <= 0) return `${num}px`;
    return `${Math.round((num / total) * 100 * 10000) / 10000}%`;
  }
  return `${num}px`;
}
