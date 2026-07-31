// size-helpers.ts — Pure helpers for SizeTool's width/height unit conversion.
//
// Extracted so we can unit-test the math independently of the React tool.
// SizeTool keeps the React handlers; this file owns the px → unit math
// and the simulated-viewport-height heuristic.

import { isFillMode } from '@/shared/flex-helpers';

export type DimUnit = 'px' | '%' | 'auto' | 'vw' | 'vh' | 'fill';

/** Exiting main-axis FILL to `auto`/Fit must neutralise the grow flex in the
 *  SAME write. Fill mode is DERIVED state (grow flex + no/fit-size dimension —
 *  SizeTool's isWidthFillMain/isHeightFillMain), so writing `min-content`
 *  while `flex: '1 0 0px'` survives leaves the node still DETECTED as fill:
 *  the unit dropdown snaps back to Fill and the element keeps growing
 *  (flex-basis 0px beats the width/height property for the main size).
 *  Returns the flex patch to merge into the dimension write, or null when no
 *  grow flex is in play (cross axis, or the node isn't growing). `'0 0 auto'`
 *  = hug content, matching how every authored fit-sized node carries its
 *  flex. Live find 2026-07-13: Works title stuck on Fill after Width → Fit. */
export function exitFillFlexPatch(
  axisIsMain: boolean,
  flexVal: string | undefined,
): { flex: string } | null {
  return axisIsMain && isFillMode(flexVal || '') ? { flex: '0 0 auto' } : null;
}

/** Estimated viewport height for vh-based dimension conversions. The
 *  canvas has no real "viewport height" so we mirror the heuristic in
 *  `shared/responsive-units.ts` and `Renderer.ts`: width × per-device-class
 *  ratio (16:10 desktop, 3:4 tablet, 9:19.5 phone). */
export function estimatedVpHeight(vpWidth: number): number {
  const heightRatio = vpWidth >= 1024 ? 0.625 : vpWidth >= 500 ? 1.33 : 2.16;
  return vpWidth * heightRatio;
}

/** Convert a rendered px value to a target dimension unit. `parentSize`,
 *  `vpWidth`, `vpHeight` are the denominators for `%`, `vw`, `vh`
 *  respectively — passed explicitly so width and height handlers can
 *  use the right axis (parentWidth+vpWidth vs parentHeight+vpHeight).
 *
 *  Output formatting:
 *   - `px` / `%` / `vw` / `vh` → integer (no decimals — per user
 *     preference, the JSX source stays clean and small visual drift
 *     after a unit swap is acceptable since the user typically tweaks
 *     the number afterwards anyway).
 *   - `auto` / `fill` → sentinel return values (`'auto'` / `''`)
 *
 *  Zero-denominator guard: returns `0<unit>` rather than NaN when the
 *  parent or viewport size is missing (e.g. element is detached or
 *  the cache hasn't populated yet). */
export function convertPxToDimUnit(
  px: number,
  toUnit: DimUnit,
  parentSize: number,
  vpWidth: number,
  vpHeight: number,
): string {
  if (toUnit === 'auto') return 'auto';
  if (toUnit === 'fill') return ''; // fill is handled via flex property
  if (toUnit === 'px') return `${Math.round(px)}px`;
  if (toUnit === '%') {
    if (!(parentSize > 0)) return '0%';
    return `${Math.round((px / parentSize) * 100)}%`;
  }
  if (toUnit === 'vw') {
    if (!(vpWidth > 0)) return '0vw';
    return `${Math.round((px / vpWidth) * 100)}vw`;
  }
  if (toUnit === 'vh') {
    if (!(vpHeight > 0)) return '0vh';
    return `${Math.round((px / vpHeight) * 100)}vh`;
  }
  return `${Math.round(px)}px`;
}

/** Does an authored dimension carry a RELATIVE unit (%, vw, vh)?
 *
 *  SizeTool uses this to decide whether the Dimensions field may show the
 *  element's LIVE inline px (`liveSize`, polled during a canvas handle-resize).
 *  It must NOT for relative units: the Renderer resolves vh/vw → px for the
 *  canvas (no real viewport there), so a `99vh` element's inline `style.height`
 *  reads as e.g. `891px`. The field shows the authored number + a unit chevron,
 *  so substituting px flips the chevron to `px` AND — because every scrub step
 *  also nulls `liveSize` — makes the field oscillate px↔unit. px / auto / empty
 *  keep `liveSize` (the legit live-resize feedback path, incl. component
 *  instances with no explicit width/height in JSX). */
export function isRelativeUnit(v: string | undefined | null): boolean {
  return !!v && /(?:%|vw|vh)$/.test(v.trim());
}

/** Extract the unit suffix of a dimension string. A bare number or unrecognised
 *  value reports `px` (the CSS default for lengths). `'108vh'→'vh'`, `'52%'→'%'`,
 *  `'880px'→'px'`, `'100'→'px'`. */
export function dimUnitOf(v: string | undefined | null): string {
  const m = v?.trim().match(/(%|[a-z]+)\s*$/i);
  return m ? m[1].toLowerCase() : 'px';
}

/** Pick the value the Dimensions field should display during a canvas resize.
 *
 *  `live` is the value broadcast by ResizeManager each frame (the exact string
 *  it's committing — `'108vh'`, `'52%'`, `'880px'`), with the canvas DOM poll as
 *  a fallback. `authored` is the source `styles.width/height`.
 *
 *   - Non-relative authored (px / auto / Fit): show `live` as-is — the legit
 *     live-resize feedback path (incl. component instances with no explicit
 *     width/height in JSX).
 *   - Relative authored (%/vw/vh): show `live` ONLY when it carries the SAME
 *     unit. An in-unit resize (ResizeManager now broadcasts %/vh/… live) updates
 *     the field in real time; a stray px-resolved value (the bridge resolves
 *     vh/% → px on the canvas) is rejected so the chevron can't flip px↔unit.
 *
 *  Returns `undefined` to fall back to the authored value. */
export function pickLiveDim(authored: string | undefined, live: string | undefined | null): string | undefined {
  if (!live) return undefined;
  if (!isRelativeUnit(authored)) return live;
  return dimUnitOf(authored) === dimUnitOf(live) ? live : undefined;
}

/** FIT-text panel redirect: when `nodeId` is the INNER text of a fit pair
 *  (its `<id>-svg` sibling wrapper exists and is an svg), the Size tool must
 *  read/write the WRAPPER — the inner's width/height ('auto' + the Fit% scale)
 *  are the fit contract's internals, not user-facing size. Returns the wrapper
 *  id, or null when no redirect applies. Mirrors the canvas click redirect
 *  (redirectToFitTextWrapper). */
export function fitSizeRedirectTarget(
  nodes: Map<string, { type?: string }>,
  nodeId: string,
): string | null {
  const wrapper = nodes.get(`${nodeId}-svg`);
  return wrapper?.type === 'svg' ? `${nodeId}-svg` : null;
}
