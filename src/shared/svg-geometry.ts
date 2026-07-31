// scale-geometry.ts — Scale an SVG shape's geometry by (sx, sy).
//
// Used by ResizeManager to resize a ROTATED SVG shape "standard": the
// wrapper viewBox is kept 1:1 with width/height (so the viewBox→box mapping
// stays uniform — never skews), and the size change is baked into the
// geometry itself. Because the geometry scale is applied BEFORE the inner
// shape's `rotate()` transform, a non-uniform scale produces a cleanly
// stretched + rotated shape, NOT a skewed parallelogram.
//
// Background: SVG rotation is stored on the INNER shape's `transform`
// attribute (`rotate(angle cx cy)`, not CSS on the wrapper), which conflicts
// with resizing by changing the wrapper's width/height unless the geometry
// itself is scaled to match — hence this module.

import { parseSvgPath } from '@/shared/svg-path/svg-path-parser';

/** Per-command-letter axis tagging for path `d` params: which params are an
 *  X coordinate, which are Y, which are neither (arc rotation / flags).
 *  Keyed by the UPPERCASE letter — relative (lowercase) commands scale
 *  identically because we scale around the origin (0,0). */
const CMD_AXES: Record<string, Array<'x' | 'y' | '-'>> = {
  M: ['x', 'y'],
  L: ['x', 'y'],
  T: ['x', 'y'],
  H: ['x'],
  V: ['y'],
  Z: [],
  C: ['x', 'y', 'x', 'y', 'x', 'y'],
  S: ['x', 'y', 'x', 'y'],
  Q: ['x', 'y', 'x', 'y'],
  // rx, ry, x-axis-rotation, large-arc-flag, sweep-flag, x, y
  A: ['x', 'y', '-', '-', '-', 'x', 'y'],
};

/** Round to 6 decimals and stringify — keeps paths compact without visibly
 *  drifting geometry across repeated resizes. */
function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** A geometry attr written as a PERCENTAGE (e.g. `rx="50%"`). Such values are
 *  relative to the element's viewBox/dimension, so they can't be treated as
 *  absolute numbers — parseFloat("50%") = 50 silently drops the unit and the
 *  shape collapses (it becomes 50 user-units, then any scale/bbox is wrong).
 *  Geometry maths (scale/translate/bbox) must special-case these: a percentage
 *  shape auto-resolves against its (scaling) viewBox, so it's left untouched. */
function isPctAttr(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().endsWith('%');
}

export interface BBox { x: number; y: number; width: number; height: number }

// Cubic-bézier approximation of an ellipse as a `<path>` `d` — the SAME shape
// the reference emits (4 segments, magic constant κ = 0.5522847498). Shapes are baked
// to a path with ABSOLUTE coordinates instead of `<ellipse rx="50%">` so EVERY
// geometry op here (bbox, vertices, scale, rotate-transform bake) reads real
// coordinates — exactly like a polygon's points. A %-based `<ellipse>` carries
// no absolute coords, which is why it collapsed on resize and produced loose
// rotated bounds while the polygon triangle worked. Winding: top→right→bottom→
// left→close. Lives here (pure geometry) so creators + tests share one source.
const ELLIPSE_KAPPA = 0.5522847498307936;
export function ellipsePathD(width: number, height: number): string {
  const rx = width / 2, ry = height / 2, cx = rx, cy = ry;
  const kx = rx * ELLIPSE_KAPPA, ky = ry * ELLIPSE_KAPPA;
  return [
    `M${fmt(cx)},${fmt(cy - ry)}`,
    `C${fmt(cx + kx)},${fmt(cy - ry)} ${fmt(cx + rx)},${fmt(cy - ky)} ${fmt(cx + rx)},${fmt(cy)}`,
    `C${fmt(cx + rx)},${fmt(cy + ky)} ${fmt(cx + kx)},${fmt(cy + ry)} ${fmt(cx)},${fmt(cy + ry)}`,
    `C${fmt(cx - kx)},${fmt(cy + ry)} ${fmt(cx - rx)},${fmt(cy + ky)} ${fmt(cx - rx)},${fmt(cy)}`,
    `C${fmt(cx - rx)},${fmt(cy - ky)} ${fmt(cx - kx)},${fmt(cy - ry)} ${fmt(cx)},${fmt(cy - ry)}`,
    'Z',
  ].join(' ');
}

/** Bounding box of a path `d` in its own (user/viewBox) coordinates. Tracks
 *  the current point so RELATIVE commands resolve to absolute positions, and
 *  includes every endpoint + control point. For cubic/quadratic curves the
 *  control-point hull is a slight OVER-estimate of the true curve bounds — an
 *  acceptable, safe (content-containing) approximation; the reshape tool emits
 *  straight `L` segments, for which it is exact. Returns null on empty input. */
// Memo cache for pathPoints — the rect/corners measurement pass calls it for
// EVERY svg path element on EVERY measure cycle (a 743-node imported page hit
// 6,382 parses in a 9s drag session: ~130 unique `d` strings × ~24 renders,
// each parse also emitting 2 trace entries). `d` is the full cache key; the
// returned array is READ-ONLY by convention — every caller only iterates it.
// Bounded: cleared wholesale past 1000 entries (shape edits mint new `d`s).
const _pathPointsCache = new Map<string, Array<[number, number]>>();

/** All absolute (x,y) points a path passes through — endpoints + control
 *  points (the control hull over-estimates curve extent, exact for `L`).
 *  Memoised by `d` — treat the result as read-only. */
export function pathPoints(d: string): Array<[number, number]> {
  const cached = _pathPointsCache.get(d);
  if (cached) return cached;
  const pts = computePathPoints(d);
  if (_pathPointsCache.size >= 1000) _pathPointsCache.clear();
  _pathPointsCache.set(d, pts);
  return pts;
}

function computePathPoints(d: string): Array<[number, number]> {
  const cmds = parseSvgPath(d);
  let cx = 0, cy = 0, startX = 0, startY = 0;
  const pts: Array<[number, number]> = [];
  const add = (x: number, y: number) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]); };
  for (const cmd of cmds) {
    const letter = cmd[0];
    const upper = letter.toUpperCase();
    const rel = letter !== upper;
    const n = cmd.slice(1).map(Number);
    const bx = cx, by = cy;
    if (upper === 'Z') { cx = startX; cy = startY; continue; }
    if (upper === 'H') { for (const v of n) { cx = rel ? cx + v : v; add(cx, cy); } continue; }
    if (upper === 'V') { for (const v of n) { cy = rel ? cy + v : v; add(cx, cy); } continue; }
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      for (let i = 0; i + 1 < n.length; i += 2) {
        cx = rel ? cx + n[i] : n[i];
        cy = rel ? cy + n[i + 1] : n[i + 1];
        add(cx, cy);
        if (upper === 'M' && i === 0) { startX = cx; startY = cy; }
      }
      continue;
    }
    if (upper === 'C' || upper === 'S' || upper === 'Q') {
      // SAMPLE points ON the curve, not the raw control points. Control points
      // sit OUTSIDE the curve, so their hull's AABB — when the shape is ROTATED —
      // over-reaches the true rotated-curve extent and the group/selection bound
      // shows whitespace (the reference hugs the curve). On-curve samples keep the
      // rotated AABB tight. Pure JS (no getPointAtLength), 16/segment is sub-px.
      const stride = upper === 'C' ? 6 : 4;
      const SAMPLES = 16;
      for (let i = 0; i + stride <= n.length; i += stride) {
        const sx = cx, sy = cy;
        let x1: number, y1: number, x2: number, y2: number, ex: number, ey: number;
        if (upper === 'C') {
          x1 = rel ? sx + n[i] : n[i];         y1 = rel ? sy + n[i + 1] : n[i + 1];
          x2 = rel ? sx + n[i + 2] : n[i + 2]; y2 = rel ? sy + n[i + 3] : n[i + 3];
          ex = rel ? sx + n[i + 4] : n[i + 4]; ey = rel ? sy + n[i + 5] : n[i + 5];
        } else if (upper === 'Q') {
          // quadratic control → promote to the equivalent cubic control points
          const qx = rel ? sx + n[i] : n[i], qy = rel ? sy + n[i + 1] : n[i + 1];
          ex = rel ? sx + n[i + 2] : n[i + 2]; ey = rel ? sy + n[i + 3] : n[i + 3];
          x1 = sx + (2 / 3) * (qx - sx); y1 = sy + (2 / 3) * (qy - sy);
          x2 = ex + (2 / 3) * (qx - ex); y2 = ey + (2 / 3) * (qy - ey);
        } else { // 'S' smooth cubic — approximate first control point as the current point
          x1 = sx; y1 = sy;
          x2 = rel ? sx + n[i] : n[i];         y2 = rel ? sy + n[i + 1] : n[i + 1];
          ex = rel ? sx + n[i + 2] : n[i + 2]; ey = rel ? sy + n[i + 3] : n[i + 3];
        }
        for (let s = 1; s <= SAMPLES; s++) {
          const t = s / SAMPLES, u = 1 - t;
          add(
            u * u * u * sx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
            u * u * u * sy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey,
          );
        }
        cx = ex; cy = ey;
      }
      continue;
    }
    if (upper === 'A') {
      for (let i = 0; i + 7 <= n.length; i += 7) {
        cx = rel ? cx + n[i + 5] : n[i + 5];
        cy = rel ? cy + n[i + 6] : n[i + 6];
        add(cx, cy);
      }
      continue;
    }
  }
  return pts;
}

function bboxOfPoints(pts: Array<[number, number]>): BBox | null {
  if (pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** All (x,y) vertices/handles of a shape's geometry, in its own coords. */
export function geometryVertices(tag: string, attrs: Record<string, string | undefined>): Array<[number, number]> {
  const b = geometryBBox(tag, attrs);
  const t = tag.toLowerCase();
  if (t === 'path') return attrs.d ? pathPoints(attrs.d) : [];
  if (t === 'polygon' || t === 'polyline') {
    if (!attrs.points) return [];
    const nums = attrs.points.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    return out;
  }
  // rect/ellipse/circle/line: the 4 bbox corners are exact for an AABB-aligned
  // shape and a safe (containing) approximation under rotation.
  if (!b) return [];
  return [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]];
}

/** Bounding box of geometry AFTER applying a `rotate(angleDeg, cx, cy)`. Rotates
 *  the geometry's vertices around the pivot, then bboxes — tight for line/polygon
 *  shapes (which the reshape tool emits), a safe over-estimate for curves. */
export function rotatedGeometryBBox(
  tag: string, attrs: Record<string, string | undefined>,
  angleDeg: number, pivotX: number, pivotY: number,
): BBox | null {
  const verts = geometryVertices(tag, attrs);
  if (verts.length === 0) return null;
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rotated = verts.map(([x, y]): [number, number] => {
    const dx = x - pivotX, dy = y - pivotY;
    return [pivotX + dx * cos - dy * sin, pivotY + dx * sin + dy * cos];
  });
  return bboxOfPoints(rotated);
}

// ─── Affine (matrix) geometry transform ──────────────────────────────────────
// Needed to scale a ROTATED child during a group resize the way the reference does:
// the group's scale must be applied in the GROUP frame, which on the child's
// (un-rotated) geometry is `M = R(-θ)·S(sx,sy)·R(θ)` — a scale+shear matrix, not
// a plain axis scale. SVG matrix convention `[a b c d e f]`:
//   x' = a·x + c·y + e,  y' = b·x + d·y + f.

export type Affine6 = [number, number, number, number, number, number];

/** Build `M = R(-θ)·S(sx,sy)·R(θ)` (the linear part) plus the translation so the
 *  rotation pivot scales to `(sx·px, sy·py)`. Returns the SVG affine `[a..f]`. */
export function rotatedScaleAffine(angleDeg: number, sx: number, sy: number, pivotX: number, pivotY: number): Affine6 {
  const r = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const cc = cos * cos, ss = sin * sin, sc = sin * cos;
  // M = R(-θ)·diag(sx,sy)·R(θ)  (symmetric)
  const m00 = sx * cc + sy * ss;
  const m01 = (sy - sx) * sc;
  const m11 = sx * ss + sy * cc;
  // geom' = M·(p - pivot) + S·pivot = M·p + (S·pivot - M·pivot)
  const e = sx * pivotX - (m00 * pivotX + m01 * pivotY);
  const f = sy * pivotY - (m01 * pivotX + m11 * pivotY);
  return [m00, m01, m01, m11, e, f]; // a=m00 b=m10(=m01) c=m01 d=m11 — note b/c both m01 (symmetric)
}

/** A 2×2 linear map stored like the linear part of an SVG matrix:
 *  `[a, b, c, d]` means `x' = a·x + c·y`, `y' = b·x + d·y`. */
export type Linear2 = [number, number, number, number];

/** `A · B` for two 2×2 linear maps in `[a,b,c,d]` form. */
export function mulLinear2(A: Linear2, B: Linear2): Linear2 {
  // A = [[a,c],[b,d]], B = [[Ba,Bc],[Bb,Bd]]
  return [
    A[0] * B[0] + A[2] * B[1], // a' = a·Ba + c·Bb
    A[1] * B[0] + A[3] * B[1], // b' = b·Ba + d·Bb
    A[0] * B[2] + A[2] * B[3], // c' = a·Bc + c·Bd
    A[1] * B[2] + A[3] * B[3], // d' = b·Bc + d·Bd
  ];
}

/** Rotation matrix `R(θ)` as a `Linear2` (`x' = cosθ·x − sinθ·y`). */
export function rotLinear2(angleDeg: number): Linear2 {
  const r = (angleDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c];
}

/** `M = R(−θ)·L·R(θ)` — a general linear map `L` expressed in a frame rotated by
 *  θ (the "the reference trick" generalised from a pure scale to ANY linear map, so a
 *  rotated child/group SHEARS to exactly track a non-uniform parent stretch).
 *  Plus the translation so the rotation pivot maps `P → L·P`. Returns SVG `[a..f]`. */
export function rotatedLinearAffine(angleDeg: number, L: Linear2, pivotX: number, pivotY: number): Affine6 {
  const M = mulLinear2(rotLinear2(-angleDeg), mulLinear2(L, rotLinear2(angleDeg)));
  const LPx = L[0] * pivotX + L[2] * pivotY, LPy = L[1] * pivotX + L[3] * pivotY;
  const MPx = M[0] * pivotX + M[2] * pivotY, MPy = M[1] * pivotX + M[3] * pivotY;
  return [M[0], M[1], M[2], M[3], LPx - MPx, LPy - MPy];
}

function applyAffinePt(x: number, y: number, m: Affine6): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Transform a `points` list by an affine. */
function transformPoints(points: string, m: Affine6): string {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [x, y] = applyAffinePt(nums[i], nums[i + 1], m);
    out.push(`${fmt(x)},${fmt(y)}`);
  }
  return out.join(' ');
}

/** Transform an ABSOLUTE path `d` by an affine. Coordinate PAIRS (M/L/T/C/S/Q
 *  endpoints + control points) are transformed; H/V are promoted to L (a shear
 *  makes them diagonal); an arc's endpoint is transformed (rx/ry left as-is — a
 *  pragmatic approximation, the reshape tool emits straight segments). The
 *  editor emits absolute commands, so relative handling isn't needed here. */
function transformPathD(d: string, m: Affine6): string {
  const cmds = parseSvgPath(d);
  let cx = 0, cy = 0;
  const out: string[] = [];
  const pair = (x: number, y: number) => { const p = applyAffinePt(x, y, m); return `${fmt(p[0])} ${fmt(p[1])}`; };
  for (const cmd of cmds) {
    const letter = cmd[0];
    const upper = letter.toUpperCase();
    const n = cmd.slice(1).map(Number);
    if (upper === 'Z') { out.push('Z'); continue; }
    if (upper === 'H') { cx = n[n.length - 1]; out.push(`L ${pair(cx, cy)}`); continue; }
    if (upper === 'V') { cy = n[n.length - 1]; out.push(`L ${pair(cx, cy)}`); continue; }
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      const parts: string[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) { cx = n[i]; cy = n[i + 1]; parts.push(pair(cx, cy)); }
      out.push(`${upper} ${parts.join(' ')}`);
      continue;
    }
    if (upper === 'C' || upper === 'S' || upper === 'Q') {
      const stride = upper === 'C' ? 6 : 4;
      const parts: string[] = [];
      for (let i = 0; i + stride <= n.length; i += stride) {
        for (let j = 0; j < stride; j += 2) parts.push(pair(n[i + j], n[i + j + 1]));
        cx = n[i + stride - 2]; cy = n[i + stride - 1];
      }
      out.push(`${upper} ${parts.join(' ')}`);
      continue;
    }
    if (upper === 'A') {
      const parts: string[] = [];
      for (let i = 0; i + 7 <= n.length; i += 7) {
        cx = n[i + 5]; cy = n[i + 6];
        parts.push(`${fmt(n[i])} ${fmt(n[i + 1])} ${n[i + 2]} ${n[i + 3]} ${n[i + 4]} ${pair(cx, cy)}`);
      }
      out.push(`A ${parts.join(' ')}`);
      continue;
    }
  }
  return out.join(' ');
}

/** Transform a shape's geometry by an affine. Path/polygon/polyline supported
 *  (the shapes the group system produces). */
export function transformShapeGeometry(tag: string, attrs: Record<string, string | undefined>, m: Affine6): Record<string, string> {
  const t = tag.toLowerCase();
  const out: Record<string, string> = {};
  if (t === 'path') { if (attrs.d) out.d = transformPathD(attrs.d, m); }
  else if (t === 'polygon' || t === 'polyline') { if (attrs.points) out.points = transformPoints(attrs.points, m); }
  return out;
}

function pathBBox(d: string): BBox | null {
  const cmds = parseSvgPath(d);
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    any = true;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const cmd of cmds) {
    const letter = cmd[0];
    const upper = letter.toUpperCase();
    const rel = letter !== upper;
    const n = cmd.slice(1).map(Number);
    // base point that relative coords are measured from (the command start).
    const bx = cx, by = cy;
    if (upper === 'Z') { cx = startX; cy = startY; continue; }
    if (upper === 'H') {
      for (const v of n) { cx = rel ? cx + v : v; add(cx, cy); }
      continue;
    }
    if (upper === 'V') {
      for (const v of n) { cy = rel ? cy + v : v; add(cx, cy); }
      continue;
    }
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      for (let i = 0; i + 1 < n.length; i += 2) {
        cx = rel ? cx + n[i] : n[i];
        cy = rel ? cy + n[i + 1] : n[i + 1];
        add(cx, cy);
        if (upper === 'M' && i === 0) { startX = cx; startY = cy; }
      }
      continue;
    }
    if (upper === 'C' || upper === 'S' || upper === 'Q') {
      const stride = upper === 'C' ? 6 : 4;
      for (let i = 0; i + stride <= n.length; i += stride) {
        // All coords in the group are relative to the command-start point.
        for (let j = 0; j < stride; j += 2) {
          add(rel ? bx + n[i + j] : n[i + j], rel ? by + n[i + j + 1] : n[i + j + 1]);
        }
        cx = rel ? bx + n[i + stride - 2] : n[i + stride - 2];
        cy = rel ? by + n[i + stride - 1] : n[i + stride - 1];
      }
      continue;
    }
    if (upper === 'A') {
      for (let i = 0; i + 7 <= n.length; i += 7) {
        // rx ry rot large-arc sweep x y — only the endpoint is a real point.
        cx = rel ? cx + n[i + 5] : n[i + 5];
        cy = rel ? cy + n[i + 6] : n[i + 6];
        add(cx, cy);
      }
      continue;
    }
  }
  if (!any) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of a `points` list ("x,y x,y …" or "x y x y …"). */
function pointsBBox(points: string): BBox | null {
  const nums = points.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < minX) minX = nums[i]; if (nums[i] > maxX) maxX = nums[i];
    if (nums[i + 1] < minY) minY = nums[i + 1]; if (nums[i + 1] > maxY) maxY = nums[i + 1];
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of a shape's geometry in its own coordinate space, by tag. */
export function geometryBBox(tag: string, attrs: Record<string, string | undefined>): BBox | null {
  const t = tag.toLowerCase();
  const num = (v: string | undefined) => parseFloat(v ?? '');
  if (t === 'path') return attrs.d ? pathBBox(attrs.d) : null;
  if (t === 'polygon' || t === 'polyline') return attrs.points ? pointsBBox(attrs.points) : null;
  // Percentage geometry has no absolute bbox without the viewBox (and a
  // `rx="50%"` ellipse FILLS its box, so a shrink-wrap refit must leave it
  // alone). Return null → callers (refit) skip the shape / keep its current box,
  // instead of collapsing it to 2×parseFloat("50%")=100. See isPctAttr.
  if (t === 'rect') {
    if (isPctAttr(attrs.x) || isPctAttr(attrs.y) || isPctAttr(attrs.width) || isPctAttr(attrs.height)) return null;
    const x = num(attrs.x) || 0, y = num(attrs.y) || 0, w = num(attrs.width), h = num(attrs.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { x, y, width: w, height: h };
  }
  if (t === 'ellipse') {
    if (isPctAttr(attrs.cx) || isPctAttr(attrs.cy) || isPctAttr(attrs.rx) || isPctAttr(attrs.ry)) return null;
    const cx = num(attrs.cx) || 0, cy = num(attrs.cy) || 0, rx = num(attrs.rx), ry = num(attrs.ry);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
    return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
  }
  if (t === 'circle') {
    if (isPctAttr(attrs.cx) || isPctAttr(attrs.cy) || isPctAttr(attrs.r)) return null;
    const cx = num(attrs.cx) || 0, cy = num(attrs.cy) || 0, r = num(attrs.r);
    if (!Number.isFinite(r)) return null;
    return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
  }
  if (t === 'line') {
    const x1 = num(attrs.x1) || 0, y1 = num(attrs.y1) || 0, x2 = num(attrs.x2) || 0, y2 = num(attrs.y2) || 0;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }
  return null;
}

/**
 * Scale every coordinate in a path `d` string by (sx, sy) around the origin.
 * X-coords (and arc `rx`) scale by sx; Y-coords (and arc `ry`) by sy. Arc
 * `x-axis-rotation` and the two flags pass through unchanged — a non-uniform
 * scale technically alters an arc's rotation, but generated shapes use cubic
 * béziers (ShapeCreator + the svg-editor library), not arcs, so this is a
 * pragmatic approximation for the rare arc case.
 */
export function scalePathD(d: string, sx: number, sy: number): string {
  const cmds = parseSvgPath(d);
  const out: string[] = [];
  for (const cmd of cmds) {
    const letter = cmd[0];
    const axes = CMD_AXES[letter.toUpperCase()] ?? [];
    const params: string[] = [];
    for (let i = 1; i < cmd.length; i++) {
      const axis = axes[i - 1];
      if (axis === 'x' || axis === 'y') {
        const n = parseFloat(cmd[i]);
        params.push(Number.isFinite(n) ? fmt(n * (axis === 'x' ? sx : sy)) : cmd[i]);
      } else {
        params.push(cmd[i]);
      }
    }
    out.push(params.length ? `${letter} ${params.join(' ')}` : letter);
  }
  return out.join(' ');
}

/** Translate a path `d` by (dx, dy). Only ABSOLUTE (uppercase) command coords
 *  shift — relative deltas are unchanged by a translation. (Our editor emits
 *  absolute paths.) Mirrors `scalePathD`'s CMD_AXES handling for H/V/A/etc.
 *
 *  One spec nuance matters for FOREIGN paths: a path's FIRST moveto is
 *  absolute even when written lowercase (`m`). Fully-relative exports (svgl
 *  wordmarks) start `m x y …` — skipping it made the whole translation a
 *  silent no-op, so a dropped shape's "local" path stayed in absolute space
 *  and the group refit exploded the union (live find 2026-07-28). */
export function translatePathD(d: string, dx: number, dy: number): string {
  const cmds = parseSvgPath(d);
  const out: string[] = [];
  for (let c = 0; c < cmds.length; c++) {
    const cmd = cmds[c];
    const letter = cmd[0];
    const isAbs = letter === letter.toUpperCase() || (c === 0 && letter === 'm');
    const axes = CMD_AXES[letter.toUpperCase()] ?? [];
    const params: string[] = [];
    for (let i = 1; i < cmd.length; i++) {
      const axis = axes[i - 1];
      if (isAbs && (axis === 'x' || axis === 'y')) {
        const n = parseFloat(cmd[i]);
        params.push(Number.isFinite(n) ? fmt(n + (axis === 'x' ? dx : dy)) : cmd[i]);
      } else {
        params.push(cmd[i]);
      }
    }
    out.push(params.length ? `${letter} ${params.join(' ')}` : letter);
  }
  return out.join(' ');
}

/** Translate a `points` list by (dx, dy). */
export function translatePoints(points: string, dx: number, dy: number): string {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push(`${fmt(nums[i] + dx)},${fmt(nums[i + 1] + dy)}`);
  }
  return out.join(' ');
}

/** Translate any supported geometry shape by (dx, dy) in its local space. */
export function translateShapeGeometry(
  tag: string,
  attrs: Record<string, string | undefined>,
  dx: number,
  dy: number,
): Record<string, string> {
  const t = tag.toLowerCase();
  const out: Record<string, string> = {};
  if (t === 'path') {
    if (attrs.d) out.d = translatePathD(attrs.d, dx, dy);
  } else if (t === 'polygon' || t === 'polyline') {
    if (attrs.points) out.points = translatePoints(attrs.points, dx, dy);
  } else if (t === 'rect') {
    // Percentage coords are viewBox-relative — leave them (translating `50%` by
    // an absolute dx is meaningless and parseFloat would bake/collapse them).
    if (attrs.x != null && !isPctAttr(attrs.x)) out.x = fmt((parseFloat(attrs.x) || 0) + dx);
    if (attrs.y != null && !isPctAttr(attrs.y)) out.y = fmt((parseFloat(attrs.y) || 0) + dy);
  } else if (t === 'ellipse' || t === 'circle') {
    if (attrs.cx != null && !isPctAttr(attrs.cx)) out.cx = fmt((parseFloat(attrs.cx) || 0) + dx);
    if (attrs.cy != null && !isPctAttr(attrs.cy)) out.cy = fmt((parseFloat(attrs.cy) || 0) + dy);
  } else if (t === 'line') {
    if (attrs.x1 != null) out.x1 = fmt((parseFloat(attrs.x1) || 0) + dx);
    if (attrs.y1 != null) out.y1 = fmt((parseFloat(attrs.y1) || 0) + dy);
    if (attrs.x2 != null) out.x2 = fmt((parseFloat(attrs.x2) || 0) + dx);
    if (attrs.y2 != null) out.y2 = fmt((parseFloat(attrs.y2) || 0) + dy);
  }
  return out;
}

/** Scale a `points` list ("x,y x,y …" or "x y x y …") by (sx, sy). */
export function scalePoints(points: string, sx: number, sy: number): string {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push(`${fmt(nums[i] * sx)},${fmt(nums[i + 1] * sy)}`);
  }
  return out.join(' ');
}

/** Scale a single numeric attribute into `out`, skipping missing/non-numeric values. */
function scaleAttr(
  out: Record<string, string>,
  attrs: Record<string, string | undefined>,
  key: string,
  factor: number,
): void {
  const v = attrs[key];
  if (v == null || v === '') return;
  // A PERCENTAGE attr (e.g. `rx="50%"`) is relative to the element's
  // viewBox/dimension, which ALREADY scales with the child <svg>'s
  // width/height/viewBox during a group resize. Baking it would both drop the
  // `%` (parseFloat("50%") → 50) AND collapse the shape — `50%` becomes the
  // literal `50` user-units, then ×factor, so the painted circle shrinks far
  // below 50% of its box. Leave percentage geometry untouched; the viewBox
  // scaling resolves it to the correct absolute size.
  if (isPctAttr(v)) return;
  const n = parseFloat(v);
  if (Number.isFinite(n)) out[key] = fmt(n * factor);
}

/**
 * Scale an SVG shape's geometry attributes by (sx, sy). Returns ONLY the
 * geometry attributes that changed — the caller writes them back onto the
 * shape element / source. The shape tag is preserved (no path normalization).
 *
 * Supported: path (`d`), polygon/polyline (`points`), rect, ellipse, line.
 * `circle` can't stay a circle under a non-uniform scale — its `r` is scaled
 * by the average factor as a best-effort fallback (ShapeCreator emits
 * `<ellipse>`, not `<circle>`, so this is a corner case).
 */
export function scaleShapeGeometry(
  tag: string,
  attrs: Record<string, string | undefined>,
  sx: number,
  sy: number,
): Record<string, string> {
  const t = tag.toLowerCase();
  const out: Record<string, string> = {};
  if (t === 'path') {
    if (attrs.d) out.d = scalePathD(attrs.d, sx, sy);
  } else if (t === 'polygon' || t === 'polyline') {
    if (attrs.points) out.points = scalePoints(attrs.points, sx, sy);
  } else if (t === 'rect') {
    scaleAttr(out, attrs, 'x', sx);
    scaleAttr(out, attrs, 'y', sy);
    scaleAttr(out, attrs, 'width', sx);
    scaleAttr(out, attrs, 'height', sy);
    scaleAttr(out, attrs, 'rx', sx);
    scaleAttr(out, attrs, 'ry', sy);
  } else if (t === 'ellipse') {
    scaleAttr(out, attrs, 'cx', sx);
    scaleAttr(out, attrs, 'cy', sy);
    scaleAttr(out, attrs, 'rx', sx);
    scaleAttr(out, attrs, 'ry', sy);
  } else if (t === 'circle') {
    scaleAttr(out, attrs, 'cx', sx);
    scaleAttr(out, attrs, 'cy', sy);
    scaleAttr(out, attrs, 'r', (sx + sy) / 2);
  } else if (t === 'line') {
    scaleAttr(out, attrs, 'x1', sx);
    scaleAttr(out, attrs, 'y1', sy);
    scaleAttr(out, attrs, 'x2', sx);
    scaleAttr(out, attrs, 'y2', sy);
  }
  return out;
}

/** The geometry attribute names this module knows how to scale, per tag —
 *  callers use this to snapshot a shape's original geometry before a resize. */
export const GEOMETRY_ATTRS_BY_TAG: Record<string, string[]> = {
  path: ['d'],
  polygon: ['points'],
  polyline: ['points'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  line: ['x1', 'y1', 'x2', 'y2'],
};
