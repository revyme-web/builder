/**
 * SegmentMath — Math for path segments (lines and cubic beziers).
 *
 * Used for:
 * - Hit testing: is the mouse near a segment?
 * - Closest point: where on the segment is closest to the mouse?
 * - Splitting: De Casteljau subdivision to insert a point on a curve.
 */

import type { Point } from './types';

// ── Point-to-line distance ─────────────────────────────────────────────────

/** Closest point on a line segment (p0→p1) to point p. Returns t in [0,1]. */
export function closestTOnLine(p: Point, p0: Point, p1: Point): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  const t = ((p.x - p0.x) * dx + (p.y - p0.y) * dy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

/** Point on a line at parameter t. */
export function pointOnLine(p0: Point, p1: Point, t: number): Point {
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

/** Distance from point to line segment. */
export function distToLine(p: Point, p0: Point, p1: Point): number {
  const t = closestTOnLine(p, p0, p1);
  const closest = pointOnLine(p0, p1, t);
  return dist(p, closest);
}

// ── Point-to-cubic-bezier distance ─────────────────────────────────────────

/** Evaluate cubic bezier at parameter t. */
export function pointOnCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

/** Find the closest t on a cubic bezier to point p. Samples then refines. */
export function closestTOnCubic(p: Point, p0: Point, p1: Point, p2: Point, p3: Point): number {
  // Coarse sample
  let bestT = 0;
  let bestDist = Infinity;
  const steps = 50;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = pointOnCubic(p0, p1, p2, p3, t);
    const d = dist(p, pt);
    if (d < bestDist) { bestDist = d; bestT = t; }
  }

  // Refine with binary search
  let lo = Math.max(0, bestT - 1 / steps);
  let hi = Math.min(1, bestT + 1 / steps);
  for (let iter = 0; iter < 10; iter++) {
    const mid1 = lo + (hi - lo) / 3;
    const mid2 = hi - (hi - lo) / 3;
    const d1 = dist(p, pointOnCubic(p0, p1, p2, p3, mid1));
    const d2 = dist(p, pointOnCubic(p0, p1, p2, p3, mid2));
    if (d1 < d2) hi = mid2; else lo = mid1;
  }

  return (lo + hi) / 2;
}

/** Distance from point to cubic bezier. */
export function distToCubic(p: Point, p0: Point, p1: Point, p2: Point, p3: Point): number {
  const t = closestTOnCubic(p, p0, p1, p2, p3);
  return dist(p, pointOnCubic(p0, p1, p2, p3, t));
}

// ── De Casteljau split ─────────────────────────────────────────────────────

/** Split a cubic bezier at t into two cubics. Returns [left, right] control points. */
export function splitCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, t: number,
): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point] } {
  const lerp = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  // Level 1
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  // Level 2
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  // Level 3 (the split point)
  const p0123 = lerp(p012, p123, t);

  return {
    left: [p0, p01, p012, p0123],
    right: [p0123, p123, p23, p3],
  };
}

/** Split a line segment at t, producing two line endpoints. */
export function splitLine(p0: Point, p1: Point, t: number): Point {
  return pointOnLine(p0, p1, t);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
