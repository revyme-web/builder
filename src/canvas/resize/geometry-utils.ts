// geometry-utils.ts — Transform-aware geometry math for visual helpers and resize.
// All functions are pure (no side effects except DOM reads in getScreenCorners).
// Ported from builder/src/builder/context/resizable/geometry-utils.ts

import type { Point, Rect, ScreenCorners } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { findNodeRect, findNodeComputedStyle, getViewportPrefix } from '@/canvas/node-ops';
import { getNodeFromCache } from '@/code/stores/store';
import { getCanvasBridge } from '@/canvas/canvas-bridge';

// ─── Types ─────────────────────────────────────────────────────────────────

// ScreenCorners lives in shared/types.ts (leaf) so node-ops can type against
// it without importing this module (cycle); re-exported here for callers.
export type { ScreenCorners };

// ─── Transform-aware containment (point-in-quad / quad-in-quad) ─────────────
//
// Direct port of canvas-dnd's containment helpers. Used by drag entry
// detection when either the dragged element or the candidate parent has a
// CSS transform — the bridge's bounding rect is the post-transform AABB,
// which incorrectly reports "inside" for a corner that lies in the AABB
// but outside the parent's rotated visual quad.

/**
 * True iff a point lies inside the (possibly rotated) quadrilateral defined
 * by `corners`. Cross-product sign test on each edge — works for any convex
 * quad including pure axis-aligned rectangles.
 */
export function pointInQuad(px: number, py: number, corners: ScreenCorners): boolean {
  const { TL, TR, BR, BL } = corners;
  const cross = (ax: number, ay: number, bx: number, by: number, qx: number, qy: number) =>
    (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  const d1 = cross(TL.x, TL.y, TR.x, TR.y, px, py);
  const d2 = cross(TR.x, TR.y, BR.x, BR.y, px, py);
  const d3 = cross(BR.x, BR.y, BL.x, BL.y, px, py);
  const d4 = cross(BL.x, BL.y, TL.x, TL.y, px, py);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0 || d4 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0 || d4 > 0;
  return !(hasNeg && hasPos);
}

/**
 * True iff every corner of `elCorners` lies inside `containerCorners`.
 * Use for entry detection when one or both are transformed.
 */
export function isFullyInsideQuad(
  elCorners: ScreenCorners,
  containerCorners: ScreenCorners,
): boolean {
  return (
    pointInQuad(elCorners.TL.x, elCorners.TL.y, containerCorners) &&
    pointInQuad(elCorners.TR.x, elCorners.TR.y, containerCorners) &&
    pointInQuad(elCorners.BR.x, elCorners.BR.y, containerCorners) &&
    pointInQuad(elCorners.BL.x, elCorners.BL.y, containerCorners)
  );
}

/**
 * True iff `elCorners` and `containerCorners` have no overlap. Element is
 * "fully outside" the container quad when no element corner is inside the
 * container AND no container corner is inside the element. Use for the
 * conservative exit predicate (e.g. "wait until completely outside before
 * reparenting up the hierarchy").
 *
 * This isn't a full SAT (separating axis theorem) test — it can miss the
 * pathological case where two convex quads cross without any corner being
 * inside the other. For drag interactions on roughly-rectangular shapes
 * that's good enough; if it ever bites, swap to SAT.
 */
export function isFullyOutsideQuad(
  elCorners: ScreenCorners,
  containerCorners: ScreenCorners,
): boolean {
  const elInContainer =
    pointInQuad(elCorners.TL.x, elCorners.TL.y, containerCorners) ||
    pointInQuad(elCorners.TR.x, elCorners.TR.y, containerCorners) ||
    pointInQuad(elCorners.BR.x, elCorners.BR.y, containerCorners) ||
    pointInQuad(elCorners.BL.x, elCorners.BL.y, containerCorners);
  if (elInContainer) return false;
  const containerInEl =
    pointInQuad(containerCorners.TL.x, containerCorners.TL.y, elCorners) ||
    pointInQuad(containerCorners.TR.x, containerCorners.TR.y, elCorners) ||
    pointInQuad(containerCorners.BR.x, containerCorners.BR.y, elCorners) ||
    pointInQuad(containerCorners.BL.x, containerCorners.BL.y, elCorners);
  return !containerInEl;
}

/** Create ScreenCorners from a DOMRect (axis-aligned, no rotation). */
export function cornersFromRect(rect: DOMRect): ScreenCorners {
  return {
    TL: { x: rect.left, y: rect.top },
    TR: { x: rect.right, y: rect.top },
    BR: { x: rect.right, y: rect.bottom },
    BL: { x: rect.left, y: rect.bottom },
  };
}

export type Direction =
  | 'top' | 'bottom' | 'left' | 'right'
  | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface ZeroCrossingResult {
  width: number;
  height: number;
  left: number;
  top: number;
  xHandle: 'left' | 'right';
  yHandle: 'top' | 'bottom';
  crossed: boolean;
}

// ─── Corner Detection ──────────────────────────────────────────────────────

/**
 * Get the 4 visual corners of an element in screen-space (viewport coordinates).
 * Uses getBoxQuads() for accurate corners of rotated/transformed elements (Chrome).
 * Falls back to getBoundingClientRect() for untransformed elements or other browsers.
 */
/**
 * @deprecated Use `getScreenCornersById(nodeId, vpId)` instead (bridge-aware, reads from cornersCache).
 * Get the 4 visual corners of an element in screen-space.
 * Ported from old builder's getCorners — handles rotation, skew, scale, perspective.
 *
 * Priority:
 * 1. getBoxQuads (Chrome 69+) — most accurate
 * 2. Marker-based measurement — for perspective transforms
 * 3. Manual DOMMatrix walk — fallback for other browsers
 */
/**
 * Check if element or any ancestor has rotation or skew (not just scale/translate).
 * Direct-DOM helper for `getScreenCorners(el)` — legitimate SANDBOX-side use
 * (inside the iframe the elements are local). Parent-frame code must use
 * `nodeOrAncestorHasRotationOrSkewById` instead.
 * getBoundingClientRect handles scale+translate correctly — we only need
 * marker-based measurement when there's actual rotation/skew that makes
 * the bounding rect not match the visual corners.
 */

/** True when a 2D matrix rotates, skews, OR FLIPS (mirror / 180°). The old
 *  per-site test checked only the shear terms (|b|, |c|) — but
 *  `rotate(180deg)` is `matrix(-1, 0, 0, -1)`: b = c = 0 with a NEGATIVE
 *  diagonal, so every consumer classified a 180°-rotated element as
 *  UN-rotated. Its corners then came back axis-aligned with TL at the
 *  visual top-left — while the painted local TL sits at the visual
 *  bottom-right — so resize handles carried the wrong direction labels and
 *  a 180° canvas node resized in the mirrored direction (user report
 *  2026-07-30). Negative a/d (flips) need the rotated corner path for the
 *  same reason. Accepts any {a,b,c,d} shape so tests don't need DOMMatrix. */
export function matrixHasRotationSkewOrFlip(m: { a: number; b: number; c: number; d: number }): boolean {
  return Math.abs(m.b) > 0.001 || Math.abs(m.c) > 0.001 || m.a < -0.001 || m.d < -0.001;
}

export function elementOrAncestorHasRotationOrSkew(el: HTMLElement, memo?: Map<Element, boolean>): boolean {
  // `memo` (optional): PER-PASS cache for bulk callers — the sandbox measure
  // pass asks this for EVERY element, and ancestors are shared, so an
  // uncached sweep costs O(N × depth) getComputedStyle reads; memoised it's
  // O(N). Each entry answers "this element or ANY ancestor is rotated".
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  let result = false;
  while (node && node !== document.body) {
    const hit = memo?.get(node);
    if (hit !== undefined) { result = hit; break; }
    chain.push(node);
    const t = window.getComputedStyle(node).transform;
    // jsdom (unit tests) has no DOMMatrix — and no layout, so there is no
    // rotation to detect anyway. Without this guard, a debounced remeasure
    // sweep firing AFTER a test threw an unhandled ReferenceError that
    // failed CI (exit 1) while looking like a harmless flake locally.
    if (t && t !== 'none' && typeof DOMMatrix !== 'undefined') {
      // Rotation, skew, OR flip/180° (see matrixHasRotationSkewOrFlip).
      const m = new DOMMatrix(t);
      if (matrixHasRotationSkewOrFlip(m)) { result = true; break; }
    }
    node = node.parentElement;
  }
  if (memo) for (const c of chain) memo.set(c, result);
  return result;
}

export function getScreenCorners(el: Element, rotMemo?: Map<Element, boolean>): ScreenCorners {
  const htmlEl = el as HTMLElement;

  // SVG elements: use getScreenCTM for accurate rotated corners.
  // Skip for SVG elements with CSS-based sizing (width:100%, height:auto) like FIT text wrappers
  // — their parsed CSS values don't reflect actual rendered dimensions. Use BCR fallback instead.
  const isSvgElement = el.tagName.toLowerCase() === 'svg';
  const hasCssSizing = isSvgElement && (htmlEl.style.width?.includes('%') || htmlEl.style.height === 'auto');
  if (!hasCssSizing && (isSvgElement || (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0 && el.tagName !== 'BODY'))) {
    const svgEl = el as unknown as SVGSVGElement;
    const cssW = parseFloat(htmlEl.style.width) || 0;
    const cssH = parseFloat(htmlEl.style.height) || 0;

    // Try getScreenCTM — the SVG-native way to get the full transform chain to screen space
    if (typeof svgEl.getScreenCTM === 'function' && cssW > 0) {
      const ctm = svgEl.getScreenCTM();
      if (ctm) {
        // Transform the 4 CSS-dimension corners through the CTM
        const pts = [
          new DOMPoint(0, 0).matrixTransform(ctm),      // TL
          new DOMPoint(cssW, 0).matrixTransform(ctm),    // TR
          new DOMPoint(cssW, cssH).matrixTransform(ctm), // BR
          new DOMPoint(0, cssH).matrixTransform(ctm),    // BL
        ];
        return {
          TL: { x: pts[0].x, y: pts[0].y },
          TR: { x: pts[1].x, y: pts[1].y },
          BR: { x: pts[2].x, y: pts[2].y },
          BL: { x: pts[3].x, y: pts[3].y },
        };
      }
    }

    // Fallback: axis-aligned BCR
    const bcr = el.getBoundingClientRect();
    if (bcr.width > 0 || bcr.height > 0) {
      return {
        TL: { x: bcr.left, y: bcr.top },
        TR: { x: bcr.right, y: bcr.top },
        BR: { x: bcr.right, y: bcr.bottom },
        BL: { x: bcr.left, y: bcr.bottom },
      };
    }
  }

  // 1. Try getBoxQuads (most accurate for all transforms)
  if ('getBoxQuads' in el && typeof (el as any).getBoxQuads === 'function') {
    try {
      const quads = (el as any).getBoxQuads({ box: 'border' });
      if (quads && quads.length > 0) {
        const q = quads[0];
        return {
          TL: { x: q.p1.x, y: q.p1.y },
          TR: { x: q.p2.x, y: q.p2.y },
          BR: { x: q.p3.x, y: q.p3.y },
          BL: { x: q.p4.x, y: q.p4.y },
        };
      }
    } catch (err) { trace.fn('geometry:quads-fallback', { error: String(err) }); }
  }

  // 2. Check if element or ANY ancestor has rotation/skew (not just scale/translate)
  const hasTransformInHierarchy = elementOrAncestorHasRotationOrSkew(htmlEl, rotMemo);

  if (hasTransformInHierarchy) {
    // 3. Marker-based measurement — works for ALL transform cases
    // (own transforms, parent transforms, perspective, 3D, nested transforms)
    // Markers inherit the full transform chain from the browser automatically.
    // NOTE: Skip markers for SVG elements — can't append <div> to <svg>
    if (htmlEl.offsetWidth > 0) {
      try {
        return measureCornersWithMarkers(htmlEl);
      } catch (err) { trace.fn('geometry:markers-fallback', { error: String(err) }); }
    }

    // 4. Manual matrix walk as secondary fallback
    const corners = getTransformedCornersViaMatrix(htmlEl);
    if (corners) return corners;
  }

  // 5. No transforms — simple bounding rect
  const r = el.getBoundingClientRect();
  return {
    TL: { x: r.left, y: r.top },
    TR: { x: r.right, y: r.top },
    BR: { x: r.right, y: r.bottom },
    BL: { x: r.left, y: r.bottom },
  };
}


/**
 * Measure corners using temporary marker elements.
 * Works correctly for perspective/3D transforms where matrix math gives extreme values.
 * The markers inherit the element's transform and we measure their actual screen positions.
 * Ported from old builder's measureCornersWithMarkers.
 */
function measureCornersWithMarkers(el: HTMLElement): ScreenCorners {
  // SVG elements return 0 for offsetWidth/Height — use parsed CSS style fallback
  const w = el.offsetWidth || parseFloat(el.style.width) || 0;
  const h = el.offsetHeight || parseFloat(el.style.height) || 0;

  // The markers below are `position:absolute`, so they anchor to the
  // nearest POSITIONED ancestor. If `el` itself is `position: static`
  // the markers escape past it to some ancestor and the measured
  // corners come out offset (the visible symptom: selection overlay
  // sitting off the element, common for flex/grid children that lack an
  // explicit `position: relative`). Temporarily promote `el` to
  // `relative` so it becomes the markers' containing block. `relative`
  // with no inset offsets is LAYOUT-NEUTRAL — it doesn't move or resize
  // the element — and the whole measure happens synchronously, so
  // there's no paint/flicker before we restore the original value.
  const computedPosition = window.getComputedStyle(el).position;
  const needsPositionPromotion = computedPosition === 'static';
  const prevInlinePosition = needsPositionPromotion ? el.style.position : '';
  if (needsPositionPromotion) el.style.position = 'relative';

  const positions = [
    { name: 'TL', left: 0, top: 0 },
    { name: 'TR', left: w, top: 0 },
    { name: 'BR', left: w, top: h },
    { name: 'BL', left: 0, top: h },
  ];

  const markers: HTMLElement[] = [];
  for (const pos of positions) {
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute;left:${pos.left}px;top:${pos.top}px;width:0;height:0;pointer-events:none;visibility:hidden;`;
    markers.push(marker);
    el.appendChild(marker);
  }

  // Force layout
  void el.offsetHeight;

  const corners: ScreenCorners = { TL: { x: 0, y: 0 }, TR: { x: 0, y: 0 }, BR: { x: 0, y: 0 }, BL: { x: 0, y: 0 } };
  for (let i = 0; i < markers.length; i++) {
    const rect = markers[i].getBoundingClientRect();
    const name = positions[i].name as keyof ScreenCorners;
    corners[name] = { x: rect.left, y: rect.top };
  }

  // Cleanup — restore the original inline `position` before removing
  // the markers so `el` is left exactly as we found it.
  if (needsPositionPromotion) el.style.position = prevInlinePosition;
  for (const marker of markers) el.removeChild(marker);

  return corners;
}

/** Parse transform origin handling %, px, and keywords */
function parseOrigin(token: string, size: number): number {
  if (!token) return 0;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * size;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'center') return 0.5 * size;
  if (token === 'right' || token === 'bottom') return size;
  return parseFloat(token) || 0;
}

/**
 * Build accumulated matrix from element to viewport.
 * Ported from old builder's getMatrixToViewport.
 */
function getMatrixToViewport(el: HTMLElement): DOMMatrix {
  let m = new DOMMatrix();

  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    const dx = node.offsetLeft - (node.scrollLeft || 0);
    const dy = node.offsetTop - (node.scrollTop || 0);
    m = new DOMMatrix().translate(dx, dy).multiply(m);

    const nodeStyle = window.getComputedStyle(node);
    if (nodeStyle.transform && nodeStyle.transform !== 'none') {
      const t = new DOMMatrixReadOnly(nodeStyle.transform);
      const origins = nodeStyle.transformOrigin.split(' ');
      const ox = parseOrigin(origins[0], node.offsetWidth);
      const oy = parseOrigin(origins[1] || 'center', node.offsetHeight);

      m = new DOMMatrix()
        .translate(ox, oy)
        .multiply(t)
        .translate(-ox, -oy)
        .multiply(m);
    }
  }
  return m;
}

/**
 * Calculate corners using manual matrix walk.
 * Ported from old builder's getTransformedCornersFallback.
 */
function getTransformedCornersViaMatrix(el: HTMLElement): ScreenCorners | null {
  // SVG elements have offsetWidth=0, offsetParent=null — matrix walk fails. Skip.
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return null;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const M = getMatrixToViewport(el);

  const TL = new DOMPoint(0, 0).matrixTransform(M);
  const TR = new DOMPoint(w, 0).matrixTransform(M);
  const BR = new DOMPoint(w, h).matrixTransform(M);
  const BL = new DOMPoint(0, h).matrixTransform(M);

  return { TL, TR, BR, BL };
}

/**
 * Compare two ScreenCorners for approximate equality.
 * Used by selection overlays and hover highlights to avoid unnecessary re-renders.
 * Tolerance of 0.5px (sub-pixel — imperceptible but avoids floating point noise).
 */
export function cornersEqual(a: ScreenCorners | null, b: ScreenCorners | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const tol = 0.5;
  return (
    Math.abs(a.TL.x - b.TL.x) < tol && Math.abs(a.TL.y - b.TL.y) < tol &&
    Math.abs(a.TR.x - b.TR.x) < tol && Math.abs(a.TR.y - b.TR.y) < tol &&
    Math.abs(a.BR.x - b.BR.x) < tol && Math.abs(a.BR.y - b.BR.y) < tol &&
    Math.abs(a.BL.x - b.BL.x) < tol && Math.abs(a.BL.y - b.BL.y) < tol
  );
}

/**
 * Get the center point of the 4 corners.
 */
export function getElementCenter(corners: ScreenCorners): Point {
  return {
    x: (corners.TL.x + corners.TR.x + corners.BR.x + corners.BL.x) / 4,
    y: (corners.TL.y + corners.TR.y + corners.BR.y + corners.BL.y) / 4,
  };
}

/**
 * Midpoint of two points.
 */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Intersection of a quad's two diagonals (TL–BR and TR–BL).
 *
 * For a rectangle or any AFFINE image of one (parallelogram — scale,
 * rotation, skew) this equals `getElementCenter` (the centroid). For a
 * PROJECTIVE image (a perspective trapezoid) it does NOT: a projective
 * transform maps lines to lines, so the source rectangle's centre — the
 * point where its diagonals cross — maps to where the IMAGE quad's
 * diagonals cross, which is offset from the centroid / AABB centre.
 *
 * This is the screen-space image of the element's transform-origin
 * (default `center`), hence the visually-stable anchor for reparent
 * math. Returns null only for a degenerate quad (parallel diagonals).
 */
export function quadDiagonalIntersection(corners: ScreenCorners): Point | null {
  const { TL, TR, BR, BL } = corners;
  const r = { x: BR.x - TL.x, y: BR.y - TL.y };  // TL→BR
  const s = { x: BL.x - TR.x, y: BL.y - TR.y };  // TR→BL
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((TR.x - TL.x) * s.y - (TR.y - TL.y) * s.x) / denom;
  return { x: TL.x + t * r.x, y: TL.y + t * r.y };
}

/**
 * True iff the quad is an axis-aligned rectangle (top/bottom edges
 * horizontal, left/right edges vertical) within `epsilon` screen px.
 *
 * A `false` result means the element is visually transformed — rotated,
 * skewed, OR perspective-distorted — even if it has no CSS transform of
 * its own (it may inherit one from an ancestor, or BE the transform).
 * Lets callers choose between AABB math (fast, exact for axis-aligned)
 * and quad math (needed for any transformed shape, whose AABB is larger
 * than the visible quad).
 */
export function cornersAreAxisAligned(corners: ScreenCorners, epsilon = 0.5): boolean {
  const { TL, TR, BR, BL } = corners;
  return (
    Math.abs(TL.y - TR.y) <= epsilon &&
    Math.abs(BL.y - BR.y) <= epsilon &&
    Math.abs(TL.x - BL.x) <= epsilon &&
    Math.abs(TR.x - BR.x) <= epsilon
  );
}

// ─── Rotation Detection ────────────────────────────────────────────────────


/**
 * Check if a CSS transform matrix is non-identity.
 */
export function hasTransforms(matrixString: string): boolean {
  if (!matrixString || matrixString === 'none') return false;

  const match = matrixString.match(/matrix\(([^)]+)\)/);
  if (!match) return false;

  const v = match[1].split(',').map(Number);
  const tolerance = 0.001;

  // Identity matrix: 1,0,0,1,0,0
  return !(
    Math.abs(v[0] - 1) < tolerance &&
    Math.abs(v[1]) < tolerance &&
    Math.abs(v[2]) < tolerance &&
    Math.abs(v[3] - 1) < tolerance &&
    Math.abs(v[4]) < tolerance &&
    Math.abs(v[5]) < tolerance
  );
}

// ─── Edge/Handle Math ──────────────────────────────────────────────────────

/**
 * Get the 4 edge midpoints from corners.
 */
export function getEdgeMidpoints(corners: ScreenCorners) {
  return {
    top: midpoint(corners.TL, corners.TR),
    right: midpoint(corners.TR, corners.BR),
    bottom: midpoint(corners.BL, corners.BR),
    left: midpoint(corners.TL, corners.BL),
  };
}

/**
 * Get the screen-space angle of each edge (for cursor rotation).
 * Returns degrees from horizontal.
 */
export function getEdgeAngle(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI);
}

/**
 * Map a Direction to which sides are being resized.
 */
export function getHandlesFromDirection(direction: Direction): {
  xHandle: 'left' | 'right' | null;
  yHandle: 'top' | 'bottom' | null;
} {
  switch (direction) {
    case 'topLeft':     return { xHandle: 'left',  yHandle: 'top' };
    case 'topRight':    return { xHandle: 'right', yHandle: 'top' };
    case 'bottomLeft':  return { xHandle: 'left',  yHandle: 'bottom' };
    case 'bottomRight': return { xHandle: 'right', yHandle: 'bottom' };
    case 'top':         return { xHandle: null,     yHandle: 'top' };
    case 'bottom':      return { xHandle: null,     yHandle: 'bottom' };
    case 'left':        return { xHandle: 'left',  yHandle: null };
    case 'right':       return { xHandle: 'right', yHandle: null };
  }
}

/**
 * Get the opposite corner for a given direction (the corner that stays fixed during resize).
 */
export function getOppositeCorner(
  direction: Direction,
  rect: Rect,
): Point {
  switch (direction) {
    case 'topLeft':     return { x: rect.left + rect.width, y: rect.top + rect.height };
    case 'topRight':    return { x: rect.left, y: rect.top + rect.height };
    case 'bottomLeft':  return { x: rect.left + rect.width, y: rect.top };
    case 'bottomRight': return { x: rect.left, y: rect.top };
    case 'top':         return { x: rect.left + rect.width / 2, y: rect.top + rect.height };
    case 'bottom':      return { x: rect.left + rect.width / 2, y: rect.top };
    case 'left':        return { x: rect.left + rect.width, y: rect.top + rect.height / 2 };
    case 'right':       return { x: rect.left, y: rect.top + rect.height / 2 };
  }
}

// ─── Transform Compensation for Resize ─────────────────────────────────────

/**
 * Apply hierarchical inverse transform to convert screen-space mouse delta
 * to element-local resize delta. This "undoes" rotation/scale from parent transforms
 * so that resize calculations work correctly.
 *
 * Walks the DOM from element to body, accumulates transform matrices (ignoring translation),
 * inverts the combined matrix, and transforms the delta through it.
 */
function getHierarchicalInverseTransformedResizeDelta(
  rawDx: number,
  rawDy: number,
  element: HTMLElement,
): { deltaX: number; deltaY: number } {
  // Accumulate transform matrices from element to root
  const matrices: DOMMatrix[] = [];
  let current: HTMLElement | null = element;

  while (current && current !== document.body) {
    const transform = getComputedStyle(current).transform;
    if (transform && transform !== 'none') {
      const m = new DOMMatrix(transform);
      // Zero out translation — we only want rotation/scale/skew
      m.e = 0;
      m.f = 0;
      matrices.push(m);
    }
    current = current.offsetParent as HTMLElement | null;
  }

  if (matrices.length === 0) {
    return { deltaX: rawDx, deltaY: rawDy };
  }

  // Compose matrices (element → root order)
  let combined = matrices[0];
  for (let i = 1; i < matrices.length; i++) {
    combined = matrices[i].multiply(combined);
  }

  // Invert
  const inverse = combined.inverse();

  // Transform the delta
  const point = new DOMPoint(rawDx, rawDy).matrixTransform(inverse);
  return { deltaX: point.x, deltaY: point.y };
}

// ─── Zero Crossing ─────────────────────────────────────────────────────────

/**
 * Handle the case where width or height goes negative during resize.
 * When a dimension crosses zero, flip the resize handle to the opposite side
 * and adjust position to maintain visual continuity.
 * Ported from old builder's processZeroCrossing.
 */
export function processZeroCrossing(
  width: number,
  height: number,
  left: number,
  top: number,
  xHandle: 'left' | 'right',
  yHandle: 'top' | 'bottom',
): ZeroCrossingResult {
  let finalWidth = width;
  let finalHeight = height;
  let finalLeft = left;
  let finalTop = top;
  let finalXHandle = xHandle;
  let finalYHandle = yHandle;
  let crossed = false;

  // Width crossing (negative width)
  if (width < 0) {
    finalWidth = Math.abs(width);
    finalXHandle = xHandle === 'left' ? 'right' : 'left';
    // left + width (negative) = moves left edge to where right edge was
    finalLeft = left + width;
    crossed = true;
  }

  // Height crossing (negative height)
  if (height < 0) {
    finalHeight = Math.abs(height);
    finalYHandle = yHandle === 'top' ? 'bottom' : 'top';
    // top + height (negative) = moves top edge to where bottom edge was
    finalTop = top + height;
    crossed = true;
  }

  return { width: finalWidth, height: finalHeight, left: finalLeft, top: finalTop, xHandle: finalXHandle, yHandle: finalYHandle, crossed };
}

/**
 * Update the resize direction after a zero crossing.
 * Maps the new x/y handles back to a Direction.
 */
export function updateDirectionAfterCrossing(
  newXHandle: 'left' | 'right',
  newYHandle: 'top' | 'bottom',
  originalDirection: Direction,
): Direction {
  // Corner directions: use the new handle combination
  if (['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].includes(originalDirection)) {
    if (newXHandle === 'left' && newYHandle === 'top') return 'topLeft';
    if (newXHandle === 'right' && newYHandle === 'top') return 'topRight';
    if (newXHandle === 'left' && newYHandle === 'bottom') return 'bottomLeft';
    if (newXHandle === 'right' && newYHandle === 'bottom') return 'bottomRight';
  }

  // Edge directions: maintain edge type, use new handle
  if (originalDirection === 'left' || originalDirection === 'right') {
    return newXHandle === 'left' ? 'left' : 'right';
  }
  if (originalDirection === 'top' || originalDirection === 'bottom') {
    return newYHandle === 'top' ? 'top' : 'bottom';
  }

  return originalDirection;
}

// ─── Bridge-Aware Geometry (by nodeId) ─────────────────────────────────────

/**
 * Get the 4 visual corners of an element by nodeId, using the bridge.
 * Tries cached transformed corners first (accurate for rotated elements in iframe mode),
 * then falls back to axis-aligned rect from findNodeRect.
 */
export function getScreenCornersById(nodeId: string, vpId: string): ScreenCorners | null {
  const bridge = getCanvasBridge();
  const vpPrefix = getViewportPrefix(vpId);
  // Try cached transformed corners (accurate for rotated elements)
  if ('getCachedCorners' in bridge) {
    const corners = (bridge as any).getCachedCorners(nodeId, vpPrefix);
    if (corners) {
      trace.fn('geometry:getScreenCornersById:cached', { nodeId, vpId });
      return corners;
    }
  }
  // Fallback: axis-aligned rect
  const rect = findNodeRect(nodeId, vpId);
  if (!rect) {
    trace.fn('geometry:getScreenCornersById:null', { nodeId, vpId });
    return null;
  }
  trace.fn('geometry:getScreenCornersById:rect', { nodeId, vpId, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  return cornersFromRect(rect);
}

/**
 * Bridge-aware version of `elementOrAncestorHasRotationOrSkew`. Walks the
 * parent chain via NodeMap (not DOM) and reads each ancestor's computed
 * `transform` through the bridge. Returns true iff the node itself OR any
 * ancestor has a non-identity rotation/skew (matrix b/c components > 0.001).
 *
 * Pure scale/translate (b=c=0) returns false — so the canvas pan/zoom
 * transform on the viewport root doesn't false-positive here.
 */
export function nodeOrAncestorHasRotationOrSkewById(nodeId: string, vpId: string): boolean {
  let currentId: string | null = nodeId;
  while (currentId) {
    const transform = findNodeComputedStyle(currentId, vpId, 'transform');
    if (transform && transform !== 'none') {
      try {
        const m = new DOMMatrix(transform);
        if (matrixHasRotationSkewOrFlip(m)) {
          trace.fn('geometry:nodeOrAncestorHasRotationOrSkewById:hit', { nodeId, vpId, atId: currentId });
          return true;
        }
      } catch { /* skip invalid matrix */ }
    }
    const node = getNodeFromCache(currentId);
    currentId = node?.parentId ?? null;
  }
  return false;
}

/**
 * Extract the rotation angle (degrees) of an element by nodeId.
 *
 * Primary source: the element's own computed CSS `transform` (bridge-aware,
 * via findNodeComputedStyle).
 *
 * SVG fallback: SVG shape rotation is NOT a CSS transform on the `<svg>`
 * wrapper — it lives as a `transform` ATTRIBUTE on the inner shape
 * (path/polygon/…). So for an SVG node with no CSS transform, derive the
 * screen-space angle from the cached rotated corners (the sandbox's
 * `getSvgShapeScreenCorners` already composes the inner-shape transform
 * into those). Without this the selection overlay's handle cursors stay
 * axis-aligned on a visibly-rotated shape.
 */
export function getElementRotationById(nodeId: string, vpId: string): number {
  // Painted-corners path: derive the rotation angle from the actual
  // top edge of the painted quad. The angle from TL → TR gives the
  // PAINTED top-edge slope, which includes the full cumulative ancestor
  // transform chain (rotation, skew, scale at any depth). This is what
  // the rotation handles + cursor orientations should match — the user
  // sees the painted shape, not the element's own CSS `transform`.
  //
  // The CSS-`transform` matrix-extraction path that this replaces only
  // read the element's OWN computed `transform`; CSS transforms don't
  // inherit, so a non-rotated child of a rotated parent reported 0°
  // even though it visibly painted at the parent's angle. Rotate
  // handle cursors stayed axis-aligned over a visibly-rotated shape →
  // wrong rotation cursor / wrong outward-bisector hit zones.
  //
  // Canvas pan/zoom is translate + uniform scale (no rotation
  // component), so the angle is pan/zoom-invariant. SVG groups
  // (transform attribute on inner shape) are also covered because
  // their cached corners already reflect the attr-transform.
  const corners = getScreenCornersById(nodeId, vpId);
  if (corners) {
    const angle = Math.atan2(corners.TR.y - corners.TL.y, corners.TR.x - corners.TL.x) * (180 / Math.PI);
    trace.fn('geometry:getElementRotationById', { nodeId, vpId, rotation: angle, source: 'painted-corners' });
    return angle;
  }

  // Fallback: corners cache miss → matrix-extraction from the element's
  // OWN computed transform. Misses inherited transforms but better
  // than 0° when nothing's cached yet (rare — corners are usually
  // populated by the time selection runs).
  const transform = findNodeComputedStyle(nodeId, vpId, 'transform');
  if (transform && transform !== 'none') {
    const match = transform.match(/matrix\(([^)]+)\)/);
    if (match) {
      const values = match[1].split(',').map(Number);
      if (values.length >= 6) {
        const rotation = Math.atan2(values[1], values[0]) * (180 / Math.PI);
        if (Math.abs(rotation) > 0.001) {
          trace.fn('geometry:getElementRotationById', { nodeId, vpId, rotation, source: 'css-fallback' });
          return rotation;
        }
      }
    }
  }

  trace.fn('geometry:getElementRotationById', { nodeId, vpId, rotation: 0 });
  return 0;
}

/**
 * Bridge-aware version of getHierarchicalInverseTransformedResizeDelta.
 * Walks the parent chain via NodeMap instead of DOM offsetParent, reading
 * computed transforms via bridge helpers.
 */
export function getHierarchicalInverseTransformedResizeDeltaById(
  rawDx: number,
  rawDy: number,
  nodeId: string,
  vpId: string,
): { deltaX: number; deltaY: number } {
  // Accumulate transform matrices from element to root via internal cache parent chain
  const matrices: DOMMatrix[] = [];
  let currentId: string | null = nodeId;

  while (currentId) {
    const transform = findNodeComputedStyle(currentId, vpId, 'transform');
    if (transform && transform !== 'none') {
      try {
        const m = new DOMMatrix(transform);
        // Zero out translation — we only want rotation/scale/skew
        m.e = 0;
        m.f = 0;
        matrices.push(m);
      } catch { /* skip invalid matrix */ }
    }
    const node = getNodeFromCache(currentId);
    currentId = node?.parentId ?? null;
  }

  if (matrices.length === 0) {
    return { deltaX: rawDx, deltaY: rawDy };
  }

  // Compose matrices (element → root order)
  let combined = matrices[0];
  for (let i = 1; i < matrices.length; i++) {
    combined = matrices[i].multiply(combined);
  }

  // Invert
  const inverse = combined.inverse();

  // Transform the delta
  const point = new DOMPoint(rawDx, rawDy).matrixTransform(inverse);
  trace.fn('geometry:getHierarchicalInverseTransformedResizeDeltaById', {
    nodeId, vpId, rawDx, rawDy, deltaX: point.x, deltaY: point.y, matrixCount: matrices.length,
  });
  return { deltaX: point.x, deltaY: point.y };
}
