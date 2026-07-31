// icon-viewbox.ts — make a fetched icon's geometry 1:1 with the box it drops at.
//
// Shapes in this builder are created 1:1 — one viewBox unit == one CSS pixel —
// because every gesture (resize, shape edit, per-variant geometry) does its math
// in pixels against the wrapper's box. The Insert panel broke that for icons:
// `buildIconDragItem` drops at 48×48 while passing the source viewBox straight
// through (iconify's is almost always `0 0 24 24`), so every inserted icon
// arrived at 2× and bounced SHAPE_WRAPPER_NOT_1TO1 — 30 on one live page, 20 of
// them the identical 32-vs-24 pair (user report 2026-07-26).
//
// Scaling the GEOMETRY (rather than shrinking the wrapper to the viewBox) keeps
// the icon dropping at a usable size while making the wrapper honest.
//
// BAILS OUT rather than guessing: markup carrying its own transforms, gradients,
// masks, filters or <use> references has coordinate spaces this simple scale
// would silently distort. Returning null there leaves the icon exactly as it is
// today — one lingering violation is a far better outcome than a mangled icon.

import { scalePathD } from './svg-geometry';

/** Constructs that make a naive geometry scale unsafe. */
const UNSAFE = /<(defs|mask|clipPath|filter|use|pattern|linearGradient|radialGradient)\b|\stransform=/i;

/** Attributes to scale on the primitive shape tags, by axis. */
const X_ATTRS = ['x', 'cx', 'x1', 'x2', 'rx'];
const Y_ATTRS = ['y', 'cy', 'y1', 'y2', 'ry'];
const W_ATTRS = ['width'];
const H_ATTRS = ['height'];

export interface IconGeometry { viewBox: string; inner: string }

/** Scale a `points="x,y x,y"` list (polygon / polyline). */
function scalePoints(points: string, sx: number, sy: number): string {
  return points.trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return pair;
    return `${+(x * sx).toFixed(3)},${+(y * sy).toFixed(3)}`;
  }).join(' ');
}

function scaleAttr(inner: string, attr: string, factor: number): string {
  return inner.replace(new RegExp(`\\s${attr}="([^"]*)"`, 'g'), (whole, v: string) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n) || /%$/.test(v.trim())) return whole;   // % is already relative
    return ` ${attr}="${+(n * factor).toFixed(3)}"`;
  });
}

/**
 * Rewrite `inner` so the geometry fills a `w`×`h` viewBox — the rectangular
 * general case (a brand WORDMARK drops at e.g. 155×64; its source space is
 * `0 0 116 48`). Same 1:1 contract, same bail-outs.
 *
 * Returns null when the source viewBox is unusable, when the markup is already
 * 1:1, or when it contains constructs this scale can't safely handle — the
 * caller then keeps its current behaviour.
 */
export function normalizeSvgGeometryToBox(
  viewBox: string | undefined,
  inner: string,
  w: number,
  h: number,
): IconGeometry | null {
  if (!viewBox || !inner || !(w > 0) || !(h > 0)) return null;
  const [x0, y0, vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number);
  if (![x0, y0, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) return null;
  if (x0 !== 0 || y0 !== 0) return null;              // offset origins need a translate first
  if (Math.abs(vw - w) < 0.01 && Math.abs(vh - h) < 0.01) return null;  // already 1:1
  if (UNSAFE.test(inner)) return null;

  const sx = w / vw, sy = h / vh;
  let out = inner.replace(/\sd="([^"]*)"/g, (whole, d: string) => {
    const scaled = scalePathD(d, sx, sy);
    return scaled ? ` d="${scaled}"` : whole;
  });
  out = out.replace(/\spoints="([^"]*)"/g, (_w, p: string) => ` points="${scalePoints(p, sx, sy)}"`);
  for (const a of X_ATTRS) out = scaleAttr(out, a, sx);
  for (const a of Y_ATTRS) out = scaleAttr(out, a, sy);
  for (const a of W_ATTRS) out = scaleAttr(out, a, sx);
  for (const a of H_ATTRS) out = scaleAttr(out, a, sy);
  // `r` is a single radius — only meaningful under a uniform scale.
  if (Math.abs(sx - sy) < 0.001) out = scaleAttr(out, 'r', sx);
  else if (/\sr="/.test(out)) return null;
  // Stroke widths live in the same user space, so they scale with it.
  out = scaleAttr(out, 'strokeWidth', (sx + sy) / 2);
  out = scaleAttr(out, 'stroke-width', (sx + sy) / 2);

  return { viewBox: `0 0 ${w} ${h}`, inner: out };
}

/**
 * Rewrite `inner` so the geometry fills a `size`×`size` viewBox.
 * Square convenience over {@link normalizeSvgGeometryToBox}.
 */
export function normalizeIconGeometry(
  viewBox: string | undefined,
  inner: string,
  size: number,
): IconGeometry | null {
  return normalizeSvgGeometryToBox(viewBox, inner, size, size);
}
