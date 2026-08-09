// measure-geometry.ts — the geometry behind the ALT measuring overlay.
//
// Pure: no React, no DOM, no bridge, no jotai. `DistanceIndicators` owns the
// polling and the painting; everything that can be reasoned about on paper
// lives here so it can be unit-tested without a canvas. Same split as
// `pin-constraint-utils.ts` next door, and the same Fast-Refresh reason: a
// component file that also exports non-components breaks HMR.
//
// TWO PICTURES, ONE MODULE:
//   • INSET  — the four gaps between a box and a box that CONTAINS it. This is
//              the original ALT feature (selected element inside its parent).
//   • GAP    — the distance between two boxes SEPARATED on at least one axis,
//              with a dashed elbow when a straight line out of the selection
//              can't land inside the target. A diagonal arrangement is
//              separated on BOTH axes and therefore yields TWO measurements.
//
// Hovering an ancestor lands in INSET naturally, so "hover the parent" needs no
// special case — it is the original picture aimed at a different box.
//
// COORDINATE SPACE. Every coordinate in and out is HOST-WINDOW SCREEN space
// (what `findNodeRect` returns — pan and zoom already baked in), so the caller
// can draw the numbers straight into a `position: fixed` SVG with no transform.
// The `value` fields are the only things divided by `scale`, because those are
// the CSS px the user actually authored.

/** Structural subset of DOMRect. Tests pass object literals; `findNodeRect`
 *  returns a real DOMRect, which satisfies this. */
export interface MRect { left: number; top: number; right: number; bottom: number }

export interface MeasureSegment {
  /** Stable React key. Per-axis for gaps, the side name for insets. The two gap
   *  keys are distinct because a diagonal pair emits both at once. */
  key: 'gap-h' | 'gap-v' | 'top' | 'right' | 'bottom' | 'left';
  /** Solid segment, screen px. */
  x1: number; y1: number; x2: number; y2: number;
  /** Horizontal run — decides which way the 8px end caps point. */
  isH: boolean;
  /** The measurement, in CSS px (screen px ÷ scale), rounded. */
  value: number;
  /** Label anchor — the solid segment's midpoint. */
  lx: number; ly: number;
  /** Whether each end of the solid run gets an 8px perpendicular end cap.
   *  The end where a dashed elbow TURNS gets none: a cap is centred on the
   *  line, so half of it would stick out opposite the way the elbow goes and
   *  the corner would read as a little overshoot instead of a right angle. */
  capStart: boolean; capEnd: boolean;
  /** Dashed elbow from the solid's far end to the target's near edge. Present
   *  only when a straight line could not reach the target on its own. */
  dash?: { x1: number; y1: number; x2: number; y2: number };
}

export interface MeasureResult {
  kind: 'gap' | 'inset';
  segments: MeasureSegment[];
}

/** Sub-pixel slack when deciding "separated" vs "overlapping". Bridge rects
 *  jitter by fractions of a pixel between frames; without this the overlay
 *  would flip between the one-line and four-line pictures while the pointer
 *  sits still. */
export const MEASURE_EPS = 0.5;

/**
 * Signed gap between two 1-D ranges.
 *   > 0  separated by that much
 *   = 0  flush
 *   < 0  overlapping — magnitude is the SHORTEST translation that would
 *        separate them, so a fully contained box reads as the distance to the
 *        nearer edge, not its own width.
 *
 * One expression covers both orderings (b after a, and a after b) because at
 * most one of the two differences can be positive.
 */
export function axisGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(bMin - aMax, aMin - bMax);
}

/** The shared span of two 1-D ranges, or null when they don't overlap. */
export function overlapBand(
  aMin: number, aMax: number, bMin: number, bMax: number,
): { min: number; max: number } | null {
  const min = Math.max(aMin, bMin);
  const max = Math.min(aMax, bMax);
  return max > min ? { min, max } : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Guards a rect coming off the bridge. A failed read mid-interaction yields
 *  NaN fields, and a culled node yields a zero box — both would render as
 *  garbage lines rather than nothing. */
export function isUsableRect(r: MRect | null | undefined): r is MRect {
  if (!r) return false;
  if (![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) return false;
  return r.right - r.left !== 0 || r.bottom - r.top !== 0;
}

/** One axis of `computeGapMeasure`. `horizontal` selects which axis is measured. */
function axisSegment(a: MRect, b: MRect, scale: number, horizontal: boolean): MeasureSegment {
  const s = scale || 1;
  // Along-axis extents of each box, and across-axis extents for the band.
  const aAlong = horizontal ? [a.left, a.right] : [a.top, a.bottom];
  const bAlong = horizontal ? [b.left, b.right] : [b.top, b.bottom];
  const aAcross = horizontal ? [a.top, a.bottom] : [a.left, a.right];
  const bAcross = horizontal ? [b.top, b.bottom] : [b.left, b.right];

  const gap = axisGap(aAlong[0], aAlong[1], bAlong[0], bAlong[1]);
  // Facing edges — never centres, never far edges. `after` = b sits on the
  // greater side of a.
  const after = bAlong[0] >= aAlong[1];
  const from = after ? aAlong[1] : bAlong[1];
  const to = after ? bAlong[0] : aAlong[0];
  // Which END of the solid segment touches the TARGET. `to` only when the
  // target sits after the selection; when it sits before, the segment runs
  // target→selection and `from` is the target's edge. Anchoring the elbow to
  // the wrong end sent it off along the selection's edge instead of the
  // target's, so it reached nothing.
  const targetEnd = after ? to : from;

  // WHERE THE SOLID SITS on the across axis: the centre of the overlap band,
  // not the selection's own centre. With a tall selection and a short target
  // inside its range, the selection's centre would put the line past the
  // target's edge; the band centre runs it through the target. When the target
  // spans the selection the band IS the selection's range, so the two agree —
  // which is the arrangement the Framer screenshots show.
  const band = overlapBand(aAcross[0], aAcross[1], bAcross[0], bAcross[1]);
  const p = band ? (band.min + band.max) / 2 : (aAcross[0] + aAcross[1]) / 2;
  // …and how far it must travel perpendicular to actually touch the target.
  // Clamping into the target's across-range is a no-op whenever the bands
  // overlap, so one formula produces both the straight case and the elbow.
  const q = clamp(p, bAcross[0], bAcross[1]);
  const needsDash = Math.abs(q - p) > 1e-6;

  // `from` is the segment's start and `to` its end, so the elbow turns at the
  // start when the target sits BEFORE the selection and at the end otherwise.
  const capStart = !(needsDash && !after);
  const capEnd = !(needsDash && after);

  return horizontal
    ? {
        key: 'gap-h', isH: true,
        x1: from, y1: p, x2: to, y2: p,
        value: Math.round(Math.max(0, gap) / s),
        lx: (from + to) / 2, ly: p,
        capStart, capEnd,
        ...(needsDash ? { dash: { x1: targetEnd, y1: p, x2: targetEnd, y2: q } } : {}),
      }
    : {
        key: 'gap-v', isH: false,
        x1: p, y1: from, x2: p, y2: to,
        value: Math.round(Math.max(0, gap) / s),
        lx: p, ly: (from + to) / 2,
        capStart, capEnd,
        ...(needsDash ? { dash: { x1: p, y1: targetEnd, x2: q, y2: targetEnd } } : {}),
      };
}

/**
 * Every distance between two boxes separated on at least one axis. Empty when
 * they overlap on both — that's `computeInsetMeasure`'s picture.
 *
 * ONE MEASUREMENT PER SEPARATED AXIS, which means a DIAGONAL arrangement gets
 * TWO (user call 2026-08-09, matching Framer): the horizontal gap with a
 * vertical elbow down to the target, and the vertical gap with a horizontal
 * elbow across to it. The two elbows meet at the target's near corner and the
 * pair reads as a bracket around the offset.
 *
 * This replaced a rule that picked the single axis with the shorter elbow. That
 * always drew *a* true number, but it silently chose which question the user was
 * asking; when the boxes are offset both ways, both numbers are the answer.
 *
 * The single-axis case falls out with no special casing: if the boxes overlap
 * vertically, only the horizontal axis is separated, so only one segment is
 * produced — and its elbow length is zero, so it draws straight.
 */
export function computeGapMeasure(
  a: MRect, b: MRect, scale: number, eps: number = MEASURE_EPS,
): MeasureSegment[] {
  const out: MeasureSegment[] = [];
  if (axisGap(a.left, a.right, b.left, b.right) >= -eps) out.push(axisSegment(a, b, scale, true));
  if (axisGap(a.top, a.bottom, b.top, b.bottom) >= -eps) out.push(axisSegment(a, b, scale, false));
  return out;
}

/**
 * The four gaps between an inner box and the box containing it — the original
 * ALT picture. Sides whose rounded value is <= 0 are dropped, so a flush or
 * overflowing edge simply has no line, matching the long-standing behaviour.
 *
 * Lines run from the INNER box's centre axis, which is where they have always
 * run; a contained box's centre and its overlap band's centre coincide, so this
 * agrees with `computeGapMeasure`'s placement.
 */
export function computeInsetMeasure(inner: MRect, outer: MRect, scale: number): MeasureSegment[] {
  const s = scale || 1;
  const cx = (inner.left + inner.right) / 2;
  const cy = (inner.top + inner.bottom) / 2;
  const raw: MeasureSegment[] = [
    { key: 'top', isH: false, x1: cx, y1: outer.top, x2: cx, y2: inner.top, capStart: true, capEnd: true,
      value: Math.round((inner.top - outer.top) / s), lx: cx, ly: (outer.top + inner.top) / 2 },
    { key: 'right', isH: true, x1: inner.right, y1: cy, x2: outer.right, y2: cy, capStart: true, capEnd: true,
      value: Math.round((outer.right - inner.right) / s), lx: (inner.right + outer.right) / 2, ly: cy },
    { key: 'bottom', isH: false, x1: cx, y1: inner.bottom, x2: cx, y2: outer.bottom, capStart: true, capEnd: true,
      value: Math.round((outer.bottom - inner.bottom) / s), lx: cx, ly: (inner.bottom + outer.bottom) / 2 },
    { key: 'left', isH: true, x1: outer.left, y1: cy, x2: inner.left, y2: cy, capStart: true, capEnd: true,
      value: Math.round((inner.left - outer.left) / s), lx: (outer.left + inner.left) / 2, ly: cy },
  ];
  return raw.filter((seg) => seg.value > 0);
}

/**
 * Measure between two arbitrary boxes: the gap when they are separated,
 * otherwise the insets of whichever is inside the other.
 *
 * Containment is decided by AREA. That is exact when one box really does
 * contain the other (hovering an ancestor, or a descendant of the selection)
 * and a reasonable answer when they merely overlap — the sides that make sense
 * survive the `> 0` filter and the rest drop out.
 *
 * An empty `segments` array is a legitimate result (identical boxes, or an
 * overlap with no positive side). The caller treats it as "nothing to show
 * here" and falls back to the parent picture.
 */
export function computePairMeasure(
  a: MRect, b: MRect, scale: number, eps: number = MEASURE_EPS,
): MeasureResult {
  const gaps = computeGapMeasure(a, b, scale, eps);
  if (gaps.length > 0) return { kind: 'gap', segments: gaps };
  const areaOf = (r: MRect) => Math.abs(r.right - r.left) * Math.abs(r.bottom - r.top);
  const [inner, outer] = areaOf(a) <= areaOf(b) ? [a, b] : [b, a];
  return { kind: 'inset', segments: computeInsetMeasure(inner, outer, scale) };
}

// ─── Target resolution ──────────────────────────────────────────────────────

export type MeasureTarget =
  | { mode: 'parent'; id: string; vpId: string }
  | { mode: 'hover'; id: string; vpId: string };

/**
 * Which box the selection is measured against this frame.
 *
 * `id` is the BRIDGE-CACHE id — ghost-suffixed (`card__2`) when the pointer is
 * over a specific `.map()` copy, because each ghost has its own rect. Passing
 * the canonical id there would measure to ghost #0 while the user hovers #3.
 */
export function resolveMeasureTarget(args: {
  selectedId: string;
  selectedVpId: string;
  parentId: string | null | undefined;
  hoveredId: string | null;
  hoveredNodeId: string | null;
  hoveredVpId: string | null;
  /** `stripGhostSuffix` — injected so this module stays dependency-free. */
  stripGhost: (id: string) => string;
}): MeasureTarget | null {
  const { selectedId, selectedVpId, parentId, hoveredId, hoveredNodeId, hoveredVpId, stripGhost } = args;
  const parent: MeasureTarget | null = parentId
    ? { mode: 'parent', id: parentId, vpId: selectedVpId }
    : null;

  if (!hoveredId) return parent;
  // `hoveredViewportIdAtom` is typed `string` but is set to null when hover is
  // cleared, so this cannot be trusted to be a string.
  const vpId = hoveredVpId ?? selectedVpId;

  // Hovering yourself measures nothing.
  if (stripGhost(hoveredId) === selectedId && vpId === selectedVpId) return parent;
  // Hovering your own parent produces the identical picture through a longer
  // route — take the parent path so the overlay doesn't churn as the pointer
  // crosses the parent's padding. A DIFFERENT viewport's copy of the parent is
  // a different box, so that still goes through hover.
  if (hoveredId === parentId && vpId === selectedVpId) return parent;

  const rectId = hoveredNodeId && stripGhost(hoveredNodeId) === hoveredId ? hoveredNodeId : hoveredId;
  return { mode: 'hover', id: rectId, vpId };
}

// ─── React bail-out guard ───────────────────────────────────────────────────

function segEqual(a: MeasureSegment, b: MeasureSegment): boolean {
  return a.key === b.key && a.isH === b.isH
    && a.capStart === b.capStart && a.capEnd === b.capEnd
    && Object.is(a.x1, b.x1) && Object.is(a.y1, b.y1)
    && Object.is(a.x2, b.x2) && Object.is(a.y2, b.y2)
    && Object.is(a.value, b.value)
    && Object.is(a.lx, b.lx) && Object.is(a.ly, b.ly)
    && Object.is(a.dash?.x1, b.dash?.x1) && Object.is(a.dash?.y1, b.dash?.y1)
    && Object.is(a.dash?.x2, b.dash?.x2) && Object.is(a.dash?.y2, b.dash?.y2);
}

/**
 * Field-wise equality so the poll can return the PREVIOUS object and let React
 * bail out of the re-render. Not a nicety — the poll's deps include the hovered
 * id, which churns at pointer rate, and an unconditional `setState` in that
 * skeleton is what blew React's update-depth limit and took the whole app down
 * (see `pin-constraint-utils.ts`).
 *
 * `Object.is`, NOT `===`: a bridge read can hand back NaN mid-interaction, and
 * `NaN !== NaN` would make this permanently false — which is the exact shape of
 * that crash.
 */
export function measureEqual(a: MeasureResult | null, b: MeasureResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.segments.length !== b.segments.length) return false;
  return a.segments.every((seg, i) => segEqual(seg, b.segments[i]));
}
