/**
 * HitTester — Point-in-radius tests for anchors, handles, and segments.
 *
 * Supports multi-shape: iterates all shapes in the document.
 * Priority: anchors > handles > segments (with anchor exclusion zone).
 */

import type { Point, HitResult } from './types';
import type { ShapeEntry } from './SvgDocument';
import { distToLine, distToCubic, closestTOnLine, closestTOnCubic } from './SegmentMath';

/** Convert screen point to SVG viewBox coordinates. */
export function screenToSvg(
  screenX: number,
  screenY: number,
  svgRect: { left: number; top: number; width: number; height: number },
  viewBox: { x: number; y: number; width: number; height: number },
): Point {
  const relX = (screenX - svgRect.left) / svgRect.width;
  const relY = (screenY - svgRect.top) / svgRect.height;
  return {
    x: viewBox.x + relX * viewBox.width,
    y: viewBox.y + relY * viewBox.height,
  };
}
function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Screen-space distance between a click point and a user-space anchor.
 *  Required because preserveAspectRatio="none" stretches the viewBox
 *  asymmetrically, so user-space distances don't translate to a uniform
 *  hit-radius in screen pixels. The previous averaged-scale path made
 *  one axis effectively zero-radius on aspect-mismatched shapes —
 *  clicking on a vertex registered as a segment hit, which the user
 *  reported as "clicking an existing anchor adds a new breakpoint
 *  instead of dragging it". */
function userPointToScreenDist(
  userPoint: Point,
  screenX: number,
  screenY: number,
  svgRect: { left: number; top: number; width: number; height: number },
  viewBox: { x: number; y: number; width: number; height: number },
  ctm?: DOMMatrix | null,
): number {
  let ax: number, ay: number;
  if (ctm) {
    // Matrix-based — works for any transform (rotate, skew, etc.). Required
    // when the host SVG has CSS rotate: the rect-based fallback computes the
    // anchor's screen position via AABB linear mapping, which is wrong for
    // rotated shapes and makes clicks on the visible (rotated) dots miss.
    try {
      const p = new DOMPoint(userPoint.x, userPoint.y).matrixTransform(ctm);
      ax = p.x; ay = p.y;
    } catch {
      if (viewBox.width <= 0 || viewBox.height <= 0) return Infinity;
      ax = svgRect.left + ((userPoint.x - viewBox.x) / viewBox.width) * svgRect.width;
      ay = svgRect.top + ((userPoint.y - viewBox.y) / viewBox.height) * svgRect.height;
    }
  } else {
    if (viewBox.width <= 0 || viewBox.height <= 0) return Infinity;
    ax = svgRect.left + ((userPoint.x - viewBox.x) / viewBox.width) * svgRect.width;
    ay = svgRect.top + ((userPoint.y - viewBox.y) / viewBox.height) * svgRect.height;
  }
  const dx = ax - screenX;
  const dy = ay - screenY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Hit test across all shapes in a document.
 * Returns the closest hit with shapeIndex.
 */
export function hitTestMultiShape(
  screenX: number,
  screenY: number,
  shapes: readonly ShapeEntry[],
  svgRect: { left: number; top: number; width: number; height: number },
  viewBox: { x: number; y: number; width: number; height: number },
  // Defaults tuned for clickable hit targets, NOT for the anchor's visual
  // size. Visual circles are 8px wide (4px radius); a 6px hit radius made
  // the actual click target only marginally larger than the visible dot,
  // which felt unforgiving — users reliably aiming at an anchor would
  // miss by a pixel or two and land on a segment, triggering a split-add
  // (Bug: "click on top vertex of triangle adds new anchor instead of
  // dragging the existing one"). 14px gives the anchor a generous halo
  // so the click intention "I want THIS vertex" wins over edge-near-vertex
  // clicks. The exclusion zone (`anchorExclusionPx` below) extends this
  // further so segment-split is suppressed in the entire "anchor approach"
  // ring — a click landing in that ring no-ops rather than splitting,
  // letting the user retry without accidentally mutating the path.
  anchorRadiusPx: number = 14,
  handleRadiusPx: number = 10,
  /** Optional user-space → screen matrix. When provided, anchor/handle
   *  screen distances are computed via matrix multiplication instead of
   *  rect+viewBox linear mapping — required for hit-test to land on the
   *  correct dot when the host SVG has a CSS rotate. The segment hover
   *  check also uses the inverse of this matrix to convert the click
   *  point into user-space — otherwise rotated shapes report a hover
   *  position offset from where the cursor visually is. */
  ctm?: DOMMatrix | null,
): HitResult {
  let svgPoint: Point;
  if (ctm) {
    try {
      const p = ctm.inverse().transformPoint(new DOMPoint(screenX, screenY));
      svgPoint = { x: p.x, y: p.y };
    } catch {
      svgPoint = screenToSvg(screenX, screenY, svgRect, viewBox);
    }
  } else {
    svgPoint = screenToSvg(screenX, screenY, svgRect, viewBox);
  }

  // 1. Check anchors across all shapes (highest priority). Distance in
  //    SCREEN space — `preserveAspectRatio="none"` makes user-space
  //    distance unreliable across aspects.
  let closestAnchor: HitResult = null;
  let closestAnchorDist = anchorRadiusPx;

  for (let s = 0; s < shapes.length; s++) {
    if (!shapes[s].visible) continue;
    const anchors = shapes[s].path.anchors;
    for (let a = 0; a < anchors.length; a++) {
      const d = userPointToScreenDist(anchors[a].point, screenX, screenY, svgRect, viewBox, ctm);
      if (d < closestAnchorDist) {
        closestAnchorDist = d;
        closestAnchor = { type: 'anchor', shapeIndex: s, anchorIndex: a };
      }
    }
  }
  if (closestAnchor) return closestAnchor;

  // 2. Check handles across all shapes (also screen-space distance).
  let closestHandle: HitResult = null;
  let closestHandleDist = handleRadiusPx;

  for (let s = 0; s < shapes.length; s++) {
    if (!shapes[s].visible) continue;
    const anchors = shapes[s].path.anchors;
    for (let a = 0; a < anchors.length; a++) {
      const anchor = anchors[a];
      if (anchor.handleIn) {
        const hp: Point = { x: anchor.point.x + anchor.handleIn.x, y: anchor.point.y + anchor.handleIn.y };
        const d = userPointToScreenDist(hp, screenX, screenY, svgRect, viewBox, ctm);
        if (d < closestHandleDist) {
          closestHandleDist = d;
          closestHandle = { type: 'handleIn', shapeIndex: s, anchorIndex: a };
        }
      }
      if (anchor.handleOut) {
        const hp: Point = { x: anchor.point.x + anchor.handleOut.x, y: anchor.point.y + anchor.handleOut.y };
        const d = userPointToScreenDist(hp, screenX, screenY, svgRect, viewBox, ctm);
        if (d < closestHandleDist) {
          closestHandleDist = d;
          closestHandle = { type: 'handleOut', shapeIndex: s, anchorIndex: a };
        }
      }
    }
  }
  if (closestHandle) return closestHandle;

  // 3. Check segments. Anchor-priority (above) is screen-space; segment
  //    distance is user-space because computing screen-space distance to
  //    a cubic Bezier is non-trivial. Use the averaged x/y scale to
  //    approximate the threshold in user-space — accurate enough for
  //    segment hit at the 36 px range, and segments are long so a small
  //    asymmetry doesn't change outcomes.
  //
  // When a CTM is provided, derive the screen-per-user ratios from its
  // linear part: `√(a² + b²)` is the magnitude of the user-X axis in
  // screen px, `√(c² + d²)` is the user-Y axis. Rotation cancels out of
  // the magnitudes — what survives is the actual scale factor in each
  // axis. This is correct under any rotation; the rect-based fallback
  // is only correct for axis-aligned hosts.
  let avgScreenToUser: number;
  if (ctm) {
    const sx = Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b);
    const sy = Math.sqrt(ctm.c * ctm.c + ctm.d * ctm.d);
    avgScreenToUser = (sx > 0 && sy > 0) ? ((1 / sx) + (1 / sy)) / 2 : 1;
  } else {
    avgScreenToUser = (svgRect.width > 0 && svgRect.height > 0)
      ? ((viewBox.width / svgRect.width) + (viewBox.height / svgRect.height)) / 2
      : 1;
  }
  const segmentRadius = 36 * avgScreenToUser;
  // Anchor exclusion zone — clicks within this radius of any anchor are
  // suppressed at the segment-hit stage. Set higher than `anchorRadiusPx`
  // so the area "around but not on" an anchor doesn't trigger an unwanted
  // segment split: the user is clearly aiming at the anchor (or somewhere
  // very close), so no path mutation is the safer outcome — they can
  // re-aim and click the anchor itself.
  const anchorExclusionPx = 48;

  // Anchor exclusion stays in screen-space (cheap, exact).
  for (let s = 0; s < shapes.length; s++) {
    if (!shapes[s].visible) continue;
    for (const anchor of shapes[s].path.anchors) {
      if (userPointToScreenDist(anchor.point, screenX, screenY, svgRect, viewBox, ctm) < anchorExclusionPx) return null;
    }
  }

  for (let s = 0; s < shapes.length; s++) {
    if (!shapes[s].visible) continue;
    const anchors = shapes[s].path.anchors;

    for (let i = 1; i < anchors.length; i++) {
      const prevA = anchors[i - 1];
      const currA = anchors[i];
      let segDist: number;
      let t: number;

      if (currA.handleIn || prevA.handleOut) {
        const cp1: Point = prevA.handleOut
          ? { x: prevA.point.x + prevA.handleOut.x, y: prevA.point.y + prevA.handleOut.y }
          : prevA.point;
        const cp2: Point = currA.handleIn
          ? { x: currA.point.x + currA.handleIn.x, y: currA.point.y + currA.handleIn.y }
          : currA.point;
        segDist = distToCubic(svgPoint, prevA.point, cp1, cp2, currA.point);
        t = closestTOnCubic(svgPoint, prevA.point, cp1, cp2, currA.point);
      } else {
        segDist = distToLine(svgPoint, prevA.point, currA.point);
        t = closestTOnLine(svgPoint, prevA.point, currA.point);
      }

      if (segDist < segmentRadius) {
        return { type: 'segment', shapeIndex: s, anchorIndex: i, t };
      }
    }
  }

  return null;
}
