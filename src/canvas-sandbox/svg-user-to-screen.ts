// svg-user-to-screen.ts — THE single source of truth for mapping an SVG
// element's local geometry coordinates → iframe screen coordinates.
//
// Why this exists: selection corners, hit-testing, drag-delta inversion, the
// shape-edit anchor overlay, and rotation each used to reconstruct this
// transform their OWN way, leaning on browser APIs that are unreliable for our
// nested-viewBox + CSS-rotated SVGs (`getBoxQuads()` returns EMPTY here;
// `getScreenCTM()` mis-handles CSS transforms; inline-style reconstruction is
// empty for nested children). Fixing one surface left the others diverging.
// This module composes the FULL chain DETERMINISTICALLY from the actual
// attrs/styles + the canvas zoom — no getBoxQuads/getScreenCTM.
//
// Two layers, on purpose:
//   • Pure affine-tuple math (no DOM, no DOMMatrix — jsdom has neither). Fully
//     unit-testable. An `Affine` is `[a,b,c,d,e,f]`, the SAME convention as the
//     `DOMMatrix` constructor and `solveViewBoxAffine`: x' = a·x + c·y + e,
//     y' = b·x + d·y + f.
//   • A DOM-reading composer that builds each chain link from an element and
//     composes them. Reads only getBoundingClientRect / getAttribute / style.
//
// SVG structure: a GROUP is a top-level <svg> (CSS
// left/top/width/height + viewBox + optional `transform: rotate()` with
// transform-origin) whose children are nested <svg> wrappers positioned by
// x/y/width/height ATTRS; each holds a <polygon>/<path> whose rotation is an
// SVG `transform="rotate(a cx cy)"` ATTRIBUTE (not CSS). The chain is therefore
//   screen ← M_topSvg · M_nestedChild* · M_innerShape ← shape-local geometry.

// ─── Pure affine math ───────────────────────────────────────────────────────

export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** m · n (n applied first, then m). */
export function multiply(m: Affine, n: Affine): Affine {
  const [ma, mb, mc, md, me, mf] = m;
  const [na, nb, nc, nd, ne, nf] = n;
  return [
    ma * na + mc * nb,
    mb * na + md * nb,
    ma * nc + mc * nd,
    mb * nc + md * nd,
    ma * ne + mc * nf + me,
    mb * ne + md * nf + mf,
  ];
}

/** Compose left-to-right: composeAll(A, B, C) = A·B·C (A applied LAST). */
export function composeAll(...ms: Affine[]): Affine {
  return ms.reduce((acc, m) => multiply(acc, m), IDENTITY);
}

export function applyAffine(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Inverse of an invertible affine; null when (near-)degenerate. */
export function invertAffine(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

export function translate(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

/** CSS-positive rotation (clockwise in screen space, y-down). */
export function rotateDeg(deg: number): Affine {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [cos, sin, -sin, cos, 0, 0];
}

/** Decompose an affine into scale/rotation/translation (assumes no skew —
 *  true for our compositions of rotate·scale·translate). Used by the
 *  shape-edit overlay RAF which positions an axis-aligned box and CSS-rotates
 *  it. */
export function decompose(m: Affine): { scaleX: number; scaleY: number; rotationDeg: number; tx: number; ty: number } {
  const [a, b, c, d, e, f] = m;
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  const rotationDeg = (Math.atan2(b, a) * 180) / Math.PI;
  return { scaleX, scaleY, rotationDeg, tx: e, ty: f };
}

// ─── Chain links (pure, from plain inputs) ──────────────────────────────────

export interface TopSvgParams {
  /** getBoundingClientRect centre of the top-level <svg> (the rotation pivot's
   *  screen position; for a normalised group the box/content/rotation centre
   *  coincide so this equals the box-centre screen position). */
  Cx: number; Cy: number;
  /** Parsed CSS `rotate(θdeg)` on the wrapper; 0 for a standalone shape (whose
   *  rotation lives on the inner shape attribute instead). */
  thetaDeg: number;
  /** Canvas zoom (currentSandboxTransform.scale). */
  zoom: number;
  /** Rotation pivot in CSS px (from `transform-origin`); for a non-rotated svg
   *  it MUST be the box centre so `Cx,Cy` (= BCR centre) corresponds to it. */
  pivotX: number; pivotY: number;
  /** viewBox origin (handles authored `viewBox="0 -74 …"`). */
  vbX: number; vbY: number;
  /** viewBox → CSS scale (group: cssW/vbW == 1). */
  cssW: number; vbW: number; cssH: number; vbH: number;
}

/** Top-level/standalone <svg> viewBox-user coords → screen.
 *  translate(C) · rotate(θ) · scale(zoom) · translate(-pivot) ·
 *  scale(cssW/vbW, cssH/vbH) · translate(-vbX,-vbY).
 *  Algebraic restatement of bridge-sandbox `buildSvgUserToScreen` (which is
 *  the test oracle), generalised to viewBox origin/scale. */
export function topSvgUserToScreenAffine(p: TopSvgParams): Affine {
  const sx = p.vbW !== 0 ? p.cssW / p.vbW : 1;
  const sy = p.vbH !== 0 ? p.cssH / p.vbH : 1;
  return composeAll(
    translate(p.Cx, p.Cy),
    rotateDeg(p.thetaDeg),
    scale(p.zoom, p.zoom),
    translate(-p.pivotX, -p.pivotY),
    scale(sx, sy),
    translate(-p.vbX, -p.vbY),
  );
}

export interface NestedChildParams {
  /** Child <svg>'s x/y/width/height ATTRIBUTES (in the parent group's user space). */
  x: number; y: number; width: number; height: number;
  /** Child's own viewBox. */
  childVbX: number; childVbY: number; childVbW: number; childVbH: number;
  /** Child's OWN rotation (deg) — a nested GROUP rotates via the SVG
   *  `transform="rotate(θ cx cy)"` ATTRIBUTE on its own `<svg>` (CSS
   *  `transform-box: border-box` is unreliable on a nested `<svg>` — it orbits;
   *  the SVG attribute with an explicit parent-space pivot spins in place,
   *  verified empirically). 0 for an un-rotated child / shape. Omitted ⇒ 0. */
  thetaDeg?: number;
  /** The rotate ATTRIBUTE's pivot `(cx,cy)` in the PARENT group's user space
   *  (= the establishing coordinate system the nested `<svg>` is placed in).
   *  Defaults to the child's box centre `(x+w/2, y+h/2)` when rotated. */
  pivotX?: number; pivotY?: number;
}

/** Nested child <svg>'s viewBox-user coords → parent-group user coords.
 *  rotateAboutParent(θ, cx, cy) · translate(x,y) ·
 *    scale(width/childVbW, height/childVbH) · translate(-childVbX,-childVbY).
 *  The rotation is applied OUTSIDE the child→parent placement, about the
 *  attribute pivot `(cx,cy)` in PARENT space — matching how the browser renders
 *  `transform="rotate(θ cx cy)"` on the nested `<svg>`. Collapses to the plain
 *  translate·scale map when θ = 0 (shapes, un-rotated groups). */
export function nestedChildAffine(p: NestedChildParams): Affine {
  const sx = p.childVbW !== 0 ? p.width / p.childVbW : 1;
  const sy = p.childVbH !== 0 ? p.height / p.childVbH : 1;
  const base = composeAll(
    translate(p.x, p.y),
    scale(sx, sy),
    translate(-p.childVbX, -p.childVbY),
  );
  const theta = p.thetaDeg ?? 0;
  if (theta === 0) return base;
  const cx = p.pivotX ?? (p.x + p.width / 2);
  const cy = p.pivotY ?? (p.y + p.height / 2);
  return composeAll(
    translate(cx, cy),
    rotateDeg(theta),
    translate(-cx, -cy),
    base,
  );
}

// ─── DOM-reading composer ────────────────────────────────────────────────────

export interface SvgCtmContext {
  /** The canvas content root — the walk stops here. */
  contentRoot: Element | null;
  /** Canvas zoom (currentSandboxTransform.scale). */
  zoom: number;
  /** Adapter returning the inner shape's `transform` attribute as an Affine
   *  (bridge passes a wrapper around `getInnerShapeTransformMatrix`). */
  innerShapeAffine?: (svg: SVGSVGElement) => Affine | null;
}

/** Parse the angle from a CSS `transform: rotate(Ndeg)` (0 when absent/other). */
function parseCssRotateDeg(transform: string | null | undefined): number {
  if (!transform || transform === 'none') return 0;
  const m = transform.match(/rotate\(\s*(-?[\d.]+)deg/);
  if (m) { const n = parseFloat(m[1]); return Number.isFinite(n) ? n : 0; }
  // matrix(a,b,...) form → angle from (a,b)
  const mm = transform.match(/matrix\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
  if (mm) {
    const a = parseFloat(mm[1]), b = parseFloat(mm[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return (Math.atan2(b, a) * 180) / Math.PI;
  }
  return 0;
}

function parseViewBox(svg: Element): { x: number; y: number; w: number; h: number } | null {
  const vb = svg.getAttribute('viewBox');
  if (!vb) return null;
  const p = vb.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null;
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

function num(v: string | null | undefined, fallback = 0): number {
  const n = parseFloat(v || '');
  return Number.isFinite(n) ? n : fallback;
}

/** Build `TopSvgParams` by reading a top-level/standalone <svg>'s box, rotation,
 *  transform-origin and viewBox. Deterministic — getBoundingClientRect (for the
 *  pivot's screen anchor) + attrs/styles only. */
function readTopSvgParams(svg: SVGSVGElement, zoom: number): TopSvgParams | null {
  const r = (svg as unknown as HTMLElement).getBoundingClientRect();
  if (!(r.width >= 0) || !(r.height >= 0)) return null;
  const vb = parseViewBox(svg);
  const cssW = num((svg as unknown as HTMLElement).style.width, vb?.w ?? 0);
  const cssH = num((svg as unknown as HTMLElement).style.height, vb?.h ?? 0);
  const vbW = vb?.w || cssW;
  const vbH = vb?.h || cssH;
  if (!(cssW > 0) || !(cssH > 0) || !(vbW > 0) || !(vbH > 0)) return null;
  const thetaDeg = parseCssRotateDeg((svg as unknown as HTMLElement).style.transform);
  // Pivot in CSS px: transform-origin if set (groups), else the box centre
  // (standalone shapes — required so the BCR centre `C` corresponds to the
  // pivot when θ=0). NOT getBBox centre.
  let pivotX = cssW / 2, pivotY = cssH / 2;
  const to = (svg as unknown as HTMLElement).style.transformOrigin || '';
  const tm = to.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
  if (tm) { pivotX = parseFloat(tm[1]); pivotY = parseFloat(tm[2]); }
  // Pivot SCREEN position `C` — backed out from the BCR (see `pivotScreenPosition`).
  const { Cx, Cy } = pivotScreenPosition(r.left, r.top, thetaDeg, zoom, pivotX, pivotY, cssW, cssH);
  return {
    Cx, Cy,
    thetaDeg,
    zoom,
    pivotX, pivotY,
    vbX: vb?.x ?? 0,
    vbY: vb?.y ?? 0,
    cssW, vbW, cssH, vbH,
  };
}

/** The rotation pivot's SCREEN position, backed out from the element's
 *  bounding-client-rect top-left + angle + zoom + pivot offset + box dims.
 *
 *  A rotation maps the pivot to a FIXED point, so it must be a corner-relative
 *  invariant of the BCR (the rotated AABB). We rotate the box's 4 corners
 *  (expressed relative to the pivot, in screen px) and take their min — the BCR
 *  top-left equals `pivot + min(rotatedCorner)`, so `pivot = BCR.topLeft − min`.
 *
 *  Correct even for a NON-normalised group whose `transform-origin` (= painted
 *  content centre) is off the box centre — there the BCR centre is NOT the
 *  pivot. For a normalised group / θ=0 it reduces to the BCR centre / box-anchor,
 *  so nothing regresses. Pure (no DOM). */
export function pivotScreenPosition(
  bcrLeft: number, bcrTop: number, thetaDeg: number, zoom: number,
  pivotX: number, pivotY: number, cssW: number, cssH: number,
): { Cx: number; Cy: number } {
  const rad = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rel: Array<[number, number]> = [
    [-pivotX * zoom, -pivotY * zoom],
    [(cssW - pivotX) * zoom, -pivotY * zoom],
    [(cssW - pivotX) * zoom, (cssH - pivotY) * zoom],
    [-pivotX * zoom, (cssH - pivotY) * zoom],
  ];
  let minX = Infinity, minY = Infinity;
  for (const [dx, dy] of rel) {
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    if (rx < minX) minX = rx;
    if (ry < minY) minY = ry;
  }
  return { Cx: bcrLeft - minX, Cy: bcrTop - minY };
}

/** Build `NestedChildParams` from a nested child <svg>'s ATTRS + own viewBox. */
export function readNestedChildParams(svg: SVGSVGElement): NestedChildParams | null {
  let width = num(svg.getAttribute('width'));
  let height = num(svg.getAttribute('height'));
  if (!(width > 0) || !(height > 0)) return null;
  const vb = parseViewBox(svg);
  let x = num(svg.getAttribute('x'));
  let y = num(svg.getAttribute('y'));
  // Live drag moves a group child via a compositor-only CSS
  // `transform: translate(dx,dy)` on the wrapper (no x/y attr write until
  // mouseup). It shifts the child in the parent's viewBox user space — the SAME
  // units as x/y — so fold it in, else the selection corners FREEZE at the old
  // x/y while the shape visibly moves during the drag.
  const t = (svg as unknown as HTMLElement).style?.transform;
  let styleM: DOMMatrix | null = null;
  if (t && t !== 'none' && typeof DOMMatrix !== 'undefined') {
    try { styleM = new DOMMatrix(t); } catch { /* ignore */ }
  }
  if (styleM) {
    if (Number.isFinite(styleM.e)) x += styleM.e;
    if (Number.isFinite(styleM.f)) y += styleM.f;
  }
  // PER-VARIANT SCALE (the size channel — replica-context groupChildBoxToMotion):
  // the canvas folds variants[v].scaleX/scaleY into the style transform with the
  // fill-box 50% origin, so the PAINTED box is the attr box scaled about its
  // centre. the reference's transform order is translate·scale·rotate → linear part
  // a = sx·cosθ, b = sy·sinθ, c = −sx·sinθ, d = sy·cosθ: sx = hypot(a, c),
  // sy = hypot(b, d). Feed the consumer the SCALED box; the rotation pivot
  // below (box centre) is scale-invariant. (Rotation + NON-uniform scale paints
  // a parallelogram the box+θ model can only approximate — acceptable, rare.)
  if (styleM) {
    const sx = Math.hypot(styleM.a, styleM.c);
    const sy = Math.hypot(styleM.b, styleM.d);
    if (Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0
      && (Math.abs(sx - 1) > 0.0001 || Math.abs(sy - 1) > 0.0001)) {
      x += width * (1 - sx) / 2;
      y += height * (1 - sy) / 2;
      width *= sx;
      height *= sy;
    }
  }
  // A nested GROUP rotates via the SVG `transform="rotate(θ cx cy)"` ATTRIBUTE
  // on its own `<svg>` (cx,cy in PARENT user space). Fold it into the affine so
  // the group's selection corners / painted bounds rotate WITH it. (CSS
  // transform-box on a nested <svg> is unreliable — it orbits — so we no longer
  // read style rotation here for groups; the live-drag `translate()` fold above
  // still applies.)
  let thetaDeg = 0;
  let pivotX: number | undefined, pivotY: number | undefined;
  const attrT = svg.getAttribute('transform');
  const rm = attrT?.match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
  if (rm) {
    thetaDeg = parseFloat(rm[1]);
    pivotX = parseFloat(rm[2]);
    pivotY = parseFloat(rm[3]);
  } else if (styleM) {
    // PER-VARIANT child rotation: the canvas folds `variants[v].rotate` into a
    // CSS `rotate(θdeg)` on the wrapper, paired with inline
    // transform-box: fill-box + transform-origin: 50% 50% (RotateManager's
    // variant branch) — pinned to the box centre, so unlike the bare-CSS
    // orbit case above this one IS deterministic. Extract θ from the style
    // matrix; the pivot is the translated box centre in parent user space
    // (T·R about c ≡ R about (c+t) then T — x/y already include the translate
    // fold above). Without this the selection corners stayed axis-aligned on
    // a variant-rotated child (live find 2026-06-12).
    // θ = atan2(−c, a): with the scale channel in the same matrix
    // (linear = S·R), atan2(b, a) mixes sy into the angle — atan2(−c, a)
    // isolates θ for any sx/sy (and reduces to the old formula when
    // unscaled).
    const theta = Math.atan2(-styleM.c, styleM.a) * (180 / Math.PI);
    if (Number.isFinite(theta) && Math.abs(theta) > 0.01) {
      thetaDeg = theta;
      pivotX = x + width / 2;
      pivotY = y + height / 2;
    }
  }
  return {
    x,
    y,
    width, height,
    childVbX: vb?.x ?? 0,
    childVbY: vb?.y ?? 0,
    childVbW: vb?.w || width,
    childVbH: vb?.h || height,
    thetaDeg,
    pivotX, pivotY,
  };
}

/** The chain of <svg> ancestors from the topmost group/standalone down to
 *  (and including) `svgEl`. `[topSvg, …, svgEl]`. */
function svgAncestorChain(svgEl: SVGSVGElement, contentRoot: Element | null): SVGSVGElement[] {
  const chain: SVGSVGElement[] = [];
  let cur: Element | null = svgEl;
  while (cur && cur !== contentRoot && cur.tagName.toLowerCase() === 'svg') {
    chain.unshift(cur as SVGSVGElement);
    cur = cur.parentElement;
  }
  return chain;
}

/** Affine mapping `svgEl`'s OWN viewBox-user coords → iframe screen coords,
 *  composing the full <svg> ancestor chain (M_topSvg · M_nestedChild*).
 *  Deterministic; does NOT include the inner shape's transform (use
 *  `getSvgFullAffine` for that). Returns null on degenerate geometry. */
export function getSvgWrapperViewBoxAffine(svgEl: SVGSVGElement, ctx: SvgCtmContext): Affine | null {
  const chain = svgAncestorChain(svgEl, ctx.contentRoot);
  if (chain.length === 0) return null;
  const top = readTopSvgParams(chain[0], ctx.zoom);
  if (!top) return null;
  let m = topSvgUserToScreenAffine(top);
  for (let i = 1; i < chain.length; i++) {
    const child = readNestedChildParams(chain[i]);
    if (!child) return null;
    m = multiply(m, nestedChildAffine(child));
  }
  return m;
}

/** Full CTM: `svgEl`'s inner shape geometry coords → screen. Wrapper viewBox
 *  affine composed with the inner shape's `transform` attribute. */
export function getSvgFullAffine(svgEl: SVGSVGElement, ctx: SvgCtmContext): Affine | null {
  const wrapper = getSvgWrapperViewBoxAffine(svgEl, ctx);
  if (!wrapper) return null;
  const inner = ctx.innerShapeAffine?.(svgEl) ?? null;
  return inner ? multiply(wrapper, inner) : wrapper;
}

/** Map the 4 corners of an axis-aligned box (in the element's local space)
 *  through an affine → screen corners (TL/TR/BR/BL). */
export function affineBoxCorners(
  m: Affine, x: number, y: number, w: number, h: number,
): { TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } } {
  return {
    TL: applyAffine(m, x, y),
    TR: applyAffine(m, x + w, y),
    BR: applyAffine(m, x + w, y + h),
    BL: applyAffine(m, x, y + h),
  };
}

/** Convert an Affine tuple to a DOMMatrix (sandbox only — DOMMatrix exists
 *  there; never call this from jsdom-unit-tested code). */
export function affineToDOMMatrix(m: Affine): DOMMatrix {
  return new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
}
