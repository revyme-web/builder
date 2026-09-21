// vector-set-fit.ts — what "Fit" (auto) means for a VECTOR SET instance.
//
// An icon set renders its variant at a fixed natural size and merges the user's
// style over it:
//
//   mergedStyle = { width: `${config.width}px`, height: `${config.height}px`, ...userStyle }
//
// so a bare `height: auto` falls back toward the variant's INTRINSIC height,
// with no relation to the width the user set: a 26px-wide icon came out 217px
// tall (user report 2026-09-21, "its auto but the height is so big"). A vector
// has a locked aspect — that is why `resetVectorSetSize` already clears both
// dimensions together — so Fit here means "the size that keeps this variant's
// aspect", not "the intrinsic size".

export interface VariantNaturalSize { width: number; height: number }

/**
 * One dimension of a vector set, derived from the other through the variant's
 * aspect — always a DEFINITE px value.
 *
 * Deliberately not `auto` + `aspect-ratio`: that was tried and failed on a live
 * icon-set instance in two separate ways. The sandbox wrapper counts `'auto'`
 * as a user dimension and feeds its previous measured size back into the
 * component, so an auto width sat at a stale 227px; and the instance style
 * writer drops `height: 'auto'` entirely, leaving the wrapper at its 40px
 * placeholder. Definite px is what that pipeline is built around.
 *
 * Derived from the OTHER dimension so the variant's aspect is preserved. When
 * the other dimension has no definite px either (both Fit, or an unset width),
 * fall back to this variant's natural size — the vector at 1:1.
 */
export function vectorSetFitSize(
  variant: VariantNaturalSize | null | undefined,
  dim: 'width' | 'height',
  otherPx: number | null | undefined,
): string | null {
  if (!variant) return null;
  const { width: vw, height: vh } = variant;
  if (!(vw > 0) || !(vh > 0)) return null;
  const natural = dim === 'width' ? vw : vh;
  if (otherPx == null || !Number.isFinite(otherPx) || otherPx <= 0) {
    return `${Math.round(natural * 100) / 100}px`;
  }
  const ratio = dim === 'width' ? vw / vh : vh / vw;
  return `${Math.round(otherPx * ratio * 100) / 100}px`;
}

/**
 * A px size on ONE row → the write for BOTH, linked through the variant's
 * aspect. The single source for the live chevron scrub AND the commit: the
 * scrub used to patch only its own key while the commit wrote both, so the
 * vector stretched on one axis for the whole gesture and snapped to its aspect
 * on mouse-up (user report 2026-09-21). `null` = not a px value, not ours.
 *
 * Clamped to ≥ 1px: a vector has no mirrored / zero-size form, and a 0 driver
 * would send vectorSetFitSize to its natural-size fallback — one row at 0 and
 * the other jumping to full size.
 */
export function vectorSetLinkedWrite(
  variant: VariantNaturalSize | null | undefined,
  dim: 'width' | 'height',
  value: string | null | undefined,
): Record<string, string> | null {
  const m = /^(-?[\d.]+)px$/.exec((value ?? '').trim());
  if (!m) return null;
  const num = Math.max(1, parseFloat(m[1]));
  if (!Number.isFinite(num)) return null;
  const other = dim === 'width' ? 'height' : 'width';
  const derived = vectorSetFitSize(variant, other, num);
  if (!derived) return null;
  return { [dim]: `${num}px`, [other]: derived };
}

// ─── Fit as a MODE ──────────────────────────────────────────────────────────
//
// The sizes are always definite px (see vectorSetFitSize), so "this dimension
// is on Fit" can't live in the style. It lives in a marker attribute instead:
// `data-fit-dim="width|height|both"`. The panel shows a Fit row's unit as `auto`
// with the resolved number greyed, exactly like the reference ("Width 80 · Fit /
// Height 80 · Fixed") — a display mode over storage the renderer can't get
// wrong. Choosing `auto` used to change nothing visible and snap back to `px`
// (user report 2026-09-21, "it still needs to just lock it in and stay in
// auto").
//
//   one row on Fit   that row follows the OTHER through the variant's aspect
//   both rows on Fit the instance is the variant's natural size, 1:1

export type FitDim = 'width' | 'height';
export type FitMode = FitDim | 'both';
export const FIT_DIM_ATTR = 'data-fit-dim';

export function readFitDim(attrs: Record<string, unknown> | null | undefined): FitMode | null {
  const v = attrs?.[FIT_DIM_ATTR];
  return v === 'width' || v === 'height' || v === 'both' ? v : null;
}

/** Is this Dimensions row showing `auto`? */
export function isFitRow(mode: FitMode | null | undefined, dim: FitDim): boolean {
  return mode === dim || mode === 'both';
}

const otherDim = (d: FitDim): FitDim => (d === 'width' ? 'height' : 'width');
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** Units that make no sense on a vector: its size is one ratio-linked number,
 *  and a viewport unit or a flex fill sizes ONE axis from outside, breaking the
 *  ratio (choosing `vw` produced a 504 × 32 sliver). */
export const VECTOR_SET_DISABLED_UNITS: ReadonlySet<string> = new Set(['vw', 'vh', 'fill']);

export interface VectorSetUnitAction {
  /** Styles to write (may be empty). */
  styles: Record<string, string>;
  /** New marker value: a mode, `''` to remove it, or undefined to leave it. */
  fitDim?: FitMode | '';
  /** Let the generic unit-change logic continue after this (e.g. px → %). */
  passThrough?: boolean;
}

/** The marker after `dim` stops being a Fit row. */
function modeWithout(mode: FitMode | null, dim: FitDim): FitMode | '' | undefined {
  if (mode === 'both') return otherDim(dim);   // the other row STAYS on Fit
  if (mode === dim) return '';
  return undefined;
}

/**
 * What a unit change on one Dimensions row means for a vector set.
 *
 *  • → auto        that row becomes a Fit row. If the OTHER row already is one,
 *                  both are: the instance takes the variant's natural width AND
 *                  height (user report 2026-09-21 — the second `auto` used to
 *                  flip the first back to px, so "both auto" was unreachable).
 *  • auto → px     TYPING a number into a Fit row makes it the fixed one and
 *                  leaves Fit on the other row (reference parity: "enter 80 on
 *                  height and width becomes the computed one"). Picking `px`
 *                  from the dropdown just drops the mode on that row.
 *  • → vw/vh/fill  refused.
 *  • anything else passes through, dropping the mode on this row.
 */
export function vectorSetUnitAction(a: {
  dim: FitDim;
  toUnit: string;
  typedNum?: number;
  variant: VariantNaturalSize;
  computedWidth: number;
  computedHeight: number;
  fitDim: FitMode | null;
}): VectorSetUnitAction | 'blocked' {
  const { dim, toUnit, typedNum, variant, fitDim } = a;
  const other = otherDim(dim);
  const computedOther = dim === 'width' ? a.computedHeight : a.computedWidth;
  if (VECTOR_SET_DISABLED_UNITS.has(toUnit)) return 'blocked';
  if (toUnit === 'auto') {
    if (isFitRow(fitDim, other)) {
      const ok = variant.width > 0 && variant.height > 0;
      return {
        styles: ok ? { width: px(variant.width), height: px(variant.height), aspectRatio: '' } : {},
        fitDim: 'both',
      };
    }
    const fit = vectorSetFitSize(variant, dim, computedOther);
    return { styles: fit ? { [dim]: fit, aspectRatio: '' } : {}, fitDim: dim };
  }
  if (toUnit === 'px' && typedNum != null && Number.isFinite(typedNum)) {
    const otherPx = vectorSetFitSize(variant, other, typedNum);
    return {
      styles: otherPx ? { [dim]: `${typedNum}px`, [other]: otherPx, aspectRatio: '' } : { [dim]: `${typedNum}px` },
      fitDim: other,
    };
  }
  if (toUnit === 'px') return { styles: {}, fitDim: modeWithout(fitDim, dim) };
  return { styles: {}, fitDim: modeWithout(fitDim, dim), passThrough: true };
}

/**
 * The sizes a Fit instance takes when its VARIANT changes (the icon picker).
 * The storage is frozen px, so without this `auto` would keep the OLD variant's
 * numbers — a label, not a behaviour. `null` = not on Fit, leave the size alone.
 */
export function vectorSetResnap(
  mode: FitMode | null | undefined,
  variant: VariantNaturalSize | null | undefined,
  current: { width: number; height: number },
): Record<string, string> | null {
  if (!mode || !variant || !(variant.width > 0) || !(variant.height > 0)) return null;
  if (mode === 'both') return { width: px(variant.width), height: px(variant.height) };
  // The fixed row drives. Without a definite px there (a `%` height, say) there
  // is nothing to derive from — and vectorSetFitSize would fall back to the
  // natural size, silently turning "follow the height" into "ignore it".
  const driver = mode === 'width' ? current.height : current.width;
  if (!Number.isFinite(driver) || driver <= 0) return null;
  const fit = vectorSetFitSize(variant, mode, driver);
  return fit ? { [mode]: fit } : null;
}

/** A hand resize leaves the natural size, so "both on Fit" stops being true.
 *  A single Fit row survives it — the handles keep the aspect, which is all
 *  that row promises. */
export function fitModeAfterHandResize(mode: FitMode | null | undefined): '' | undefined {
  return mode === 'both' ? '' : undefined;
}
