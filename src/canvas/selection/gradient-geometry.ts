// gradient-geometry.ts — the gradient overlay's math, in the ELEMENT'S OWN box.
//
// A CSS gradient is laid out in the element's local, untransformed box: the
// angle, the gradient-line length and every radius are local. The overlay used
// to do this math in SCREEN space (screen width/height, screen atan2), so on a
// rotated / skewed / flipped frame the line pointed the wrong way and dragging
// fought the gradient. Everything here goes local ⇄ screen through the
// element's transformed quad (the box-quad corners the selection overlay
// already has — ancestors' transforms and the canvas zoom included), which is
// exact for any affine transform.

import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { Point } from '@/shared/types';
import { pctToScreen, screenToPct } from '@/canvas/canvas-math';

/** The element's quad plus its local (CSS px) size. */
export interface ElementFrame {
  corners: ScreenCorners;
  w: number;
  h: number;
}

/** Local size from the computed CSS width/height when known; otherwise the
 *  quad's edge lengths (right for rotation + uniform scale, which is almost
 *  everything — a non-uniform scale or skew needs the CSS size). */
export function elementFrame(corners: ScreenCorners, size?: { w: number; h: number } | null): ElementFrame {
  const edgeW = Math.hypot(corners.TR.x - corners.TL.x, corners.TR.y - corners.TL.y);
  const edgeH = Math.hypot(corners.BL.x - corners.TL.x, corners.BL.y - corners.TL.y);
  const w = size && size.w > 0 ? size.w : edgeW;
  const h = size && size.h > 0 ? size.h : edgeH;
  return { corners, w, h };
}

export function localToScreen(f: ElementFrame, x: number, y: number): Point {
  return pctToScreen(f.corners, f.w > 0 ? (x / f.w) * 100 : 50, f.h > 0 ? (y / f.h) * 100 : 50);
}

export function screenToLocal(f: ElementFrame, sx: number, sy: number): Point {
  const [px, py] = screenToPct(f.corners, sx, sy);
  return { x: (px / 100) * f.w, y: (py / 100) * f.h };
}

/** CSS gradient angle of a local vector: 0deg = up, clockwise (y points down). */
export function cssAngleOf(dx: number, dy: number): number {
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/** Local unit vector for a CSS angle. */
export function cssAngleVector(deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** The linear gradient line (0% → 100%) on screen — CSS Images 3: through the
 *  box centre at the gradient angle, length |W·sin θ| + |H·cos θ|. */
export function linearGradientLine(f: ElementFrame, directionDeg: number): { start: Point; end: Point } {
  const v = cssAngleVector(directionDeg);
  const half = (Math.abs(f.w * v.x) + Math.abs(f.h * v.y)) / 2;
  const cx = f.w / 2, cy = f.h / 2;
  return {
    start: localToScreen(f, cx - v.x * half, cy - v.y * half),
    end: localToScreen(f, cx + v.x * half, cy + v.y * half),
  };
}

/** Screen point at `pct` (0–100) along a segment. */
export function alongLine(start: Point, end: Point, pct: number): Point {
  const t = pct / 100;
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

/**
 * Rotate-zone centres just BEYOND the outermost stops, along the gradient
 * axis — the gradient's version of the frame's corner rotate zones. `gap` is
 * the screen distance from the end stop's centre. `outwardDeg` is the screen
 * direction pointing away from the stops (atan2, degrees, y down) — the same
 * convention the rotate cursor's base angle uses.
 */
export function linearRotateZones(
  start: Point, end: Point, firstPct: number, lastPct: number, gap: number,
): { before: Point & { outwardDeg: number }; after: Point & { outwardDeg: number } } | null {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len, uy = dy / len;
  const first = alongLine(start, end, firstPct);
  const last = alongLine(start, end, lastPct);
  const fwd = (Math.atan2(uy, ux) * 180) / Math.PI;
  return {
    before: { x: first.x - ux * gap, y: first.y - uy * gap, outwardDeg: fwd + 180 },
    after: { x: last.x + ux * gap, y: last.y + uy * gap, outwardDeg: fwd },
  };
}

/**
 * The gradient angle while dragging a rotate zone: the start angle plus how far
 * the pointer has turned around the box centre — measured in the element's
 * own space, so it is the same delta math as rotating the frame itself and
 * never jumps on grab. Shift snaps to 15°.
 */
export function rotatedGradientAngle(
  f: ElementFrame, startDeg: number, grab: Point, pointer: Point, snap: boolean,
): number {
  const cx = f.w / 2, cy = f.h / 2;
  const a = screenToLocal(f, grab.x, grab.y);
  const b = screenToLocal(f, pointer.x, pointer.y);
  const delta = cssAngleOf(b.x - cx, b.y - cy) - cssAngleOf(a.x - cx, a.y - cy);
  let deg = startDeg + delta;
  if (snap) deg = Math.round(deg / 15) * 15;
  return normalizeDeg(Math.round(deg));
}

/** Points of a local ellipse mapped to screen (an ellipse stays an ellipse
 *  under any affine transform; a polyline keeps the path builder simple). */
export function localEllipsePath(f: ElementFrame, cx: number, cy: number, rx: number, ry: number, segments = 72): string {
  let d = '';
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const p = localToScreen(f, cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
  }
  return `${d}Z`;
}
