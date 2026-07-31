// transform-reparent.ts — Transform-aware coordinate conversion for drag
// reparent / unparent. Direct port of the canvas-dnd `convertScreenToParentLocal`
// + `exitToCanvasRoot` formulas, adapted to Revyme's iframe bridge.
//
// Why this exists:
//   The naïve "screen TL minus parent screen TL, divided by canvas scale"
//   only works when neither the dragged element NOR the parent is transformed.
//   For a `transform: scale(2)` element, `findNodeRect` returns the post-
//   transform AABB — using that AABB's TL as the new CSS `left` puts the
//   layout box at the wrong place AND keeps the element's own transform on
//   top, producing a visible "doubling" / shift on entry/exit.
//
//   The canvas-dnd approach anchors the AABB CENTER (which equals the CSS
//   layout-box center for any transform whose origin is centered, including
//   scale and rotation) to a target screen point, then derives the CSS TL
//   by subtracting half the COMPUTED CSS width/height. The result is the
//   correct layout-box position; the element's transform stays applied on
//   top, with no visual jump.

import type { Transform } from '@/shared/types';
import { findNodeRect, findNodeComputedStyles } from '@/canvas/node-ops';
import { getScreenCornersById, quadDiagonalIntersection } from '@/canvas/resize/geometry-utils';
import { trace } from '@/shared/debug-trace';

interface Point { x: number; y: number; }

/**
 * Map a screen-space point INTO the parent's CSS-local coordinate system,
 * accounting for the parent's transform (rotation, skew, scale, perspective)
 * and canvas zoom.
 *
 * Output is in CSS pixels relative to the parent's PADDING-BOX origin —
 * i.e. the same coordinate space `position: absolute; left/top` use.
 *
 * Returns null only if the parent's rect can't be resolved.
 */
export function convertScreenToParentLocal(
  screenX: number,
  screenY: number,
  parentId: string,
  vpId: string,
  scale: number,
): Point | null {
  const parentRect = findNodeRect(parentId, vpId);
  if (!parentRect) return null;

  const styles = findNodeComputedStyles(parentId, vpId, [
    'width', 'height',
    'paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom',
    'transform',
  ]);
  const cssW = parseFloat(styles.width) || 0;
  const cssH = parseFloat(styles.height) || 0;
  const padL = parseFloat(styles.paddingLeft) || 0;
  const padT = parseFloat(styles.paddingTop) || 0;
  const padR = parseFloat(styles.paddingRight) || 0;
  const padB = parseFloat(styles.paddingBottom) || 0;
  const transformStr = styles.transform || '';

  // Parent's BCR center in the parent-frame screen space (same space as
  // findNodeRect — already includes any cumulative ancestor transform).
  const bcrCx = parentRect.left + parentRect.width / 2;
  const bcrCy = parentRect.top + parentRect.height / 2;

  // CSS box dimensions including padding (the box absolute children resolve
  // their `left`/`top` against). content-box + padding == padding-box.
  const boxW = cssW + padL + padR;
  const boxH = cssH + padT + padB;

  // Element's own transform matrix (rotate, skew, scale, perspective…).
  // Empty / 'none' → identity matrix.
  const matrix = (transformStr && transformStr !== 'none')
    ? new DOMMatrix(transformStr)
    : new DOMMatrix();

  // LINEAR part only — zero the matrix translation. The anchor below is the
  // parent's BCR centre, which ALREADY sits wherever the transform's
  // translation moved the box (the visual centre is the image of the CSS-box
  // centre for a centred origin: visual(p) = visualCentre + M_linear·(p −
  // boxCentre)). Composing the FULL matrix applied the translation a second
  // time — a parent positioned `left/top: 50%` + `translate(-50%, -50%)`
  // (the centered-image pattern) computed entry coords off by exactly half
  // its own size, so a canvas node dropped into it jumped ~(W/2, H/2) at the
  // entry commit (user report 2026-07-30). Rotation/scale/skew matrices have
  // no translation component, so they are unchanged.
  const linear = new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, 0, 0]);

  // Forward matrix: CSS-local (0,0 = top-left of padding-box) → screen-space.
  //   translate(bcrCenter) · scale(canvasZoom) · linear(elementTransform) · translate(-boxCenter)
  // Inverse maps screen → CSS-local.
  const forward = new DOMMatrix()
    .translateSelf(bcrCx, bcrCy)
    .scaleSelf(scale, scale)
    .multiplySelf(linear)
    .translateSelf(-boxW / 2, -boxH / 2);

  const inverse = forward.inverse();
  const local = inverse.transformPoint(new DOMPoint(screenX, screenY));
  trace.fn('transform-reparent:screen-to-local', {
    parentId, screenX, screenY,
    parentRect: { left: parentRect.left, top: parentRect.top, width: parentRect.width, height: parentRect.height },
    boxW, boxH, transformStr, scale, localX: local.x, localY: local.y,
  });

  // Subtract padding so the result is in the same coord space as inline
  // `left`/`top` (relative to padding-box edge, not content-box).
  return { x: local.x - padL, y: local.y - padT };
}

/**
 * Compute the new canvas-space (root-relative) CSS position when an element
 * is being moved out of any parent onto the canvas root, preserving its
 * visual center.
 *
 * Mirrors canvas-dnd's `exitToCanvasRoot`. Caller is responsible for
 * actually queueing the reparent + style writes; this helper only does
 * the math.
 *
 * The anchor is the screen-space image of the element's CSS-box CENTRE —
 * the fixed point of its own transform (transform-origin centred). For an
 * affine transform that's the AABB centre; for a PROJECTIVE transform
 * (perspective) it's the painted quad's diagonal crossing — see
 * `computeEntryParentLocalPosition` for the full reasoning. Anchoring on
 * the AABB centre made a perspective-distorted element jump (typically
 * downward, since a top-pinched trapezoid's AABB centre sits below the
 * true centre) the instant it unparented. Falls back to the AABB centre
 * when corners are unavailable.
 *
 * @param childId      - dragged element's id (for the painted-corner read)
 * @param vpId         - dragged element's viewport id
 * @param elScreenRect - element's parent-frame screen rect (post-transform AABB)
 * @param transform    - canvas pan + zoom
 * @param iframeOffset - bridge's iframe offset (parent-frame coords)
 * @param liftWidth    - element's CSS width (NOT AABB) in CSS pixels
 * @param liftHeight   - element's CSS height in CSS pixels
 */
export function computeExitCanvasPosition(
  childId: string,
  vpId: string,
  elScreenRect: { left: number; top: number; width: number; height: number },
  transform: Transform,
  iframeOffset: { x: number; y: number },
  liftWidth: number,
  liftHeight: number,
): { canvasLeft: number; canvasTop: number } {
  // Anchor = screen-space image of the element's CSS-box centre.
  let anchorX = elScreenRect.left + elScreenRect.width / 2;
  let anchorY = elScreenRect.top + elScreenRect.height / 2;
  const corners = getScreenCornersById(childId, vpId);
  if (corners) {
    const diag = quadDiagonalIntersection(corners);
    if (diag) { anchorX = diag.x; anchorY = diag.y; }
  }

  // Screen anchor → canvas space, then shift by half the CSS box so the
  // CSS-box centre lands exactly on the anchor. The element's own
  // transform keeps that centre fixed, so the visible shape doesn't move.
  const canvasLeft = (anchorX - iframeOffset.x - transform.x) / transform.scale - liftWidth / 2;
  const canvasTop = (anchorY - iframeOffset.y - transform.y) / transform.scale - liftHeight / 2;
  return { canvasLeft, canvasTop };
}

/**
 * Compute the parent-relative CSS top-left when an element is being moved
 * INTO a parent, preserving its visual center.
 *
 * Mirrors canvas-dnd's entry math (AbsoluteDragStrategy lines ~415-446):
 * the AABB center is anchored to the parent's local frame via
 * `convertScreenToParentLocal`, then the CSS TL is derived by subtracting
 * half the element's COMPUTED width/height. The element's own transform
 * stays applied on top, no visual jump.
 *
 * Returns null if the parent's rect or computed styles can't be resolved.
 *
 * @param childId      - dragged element's id
 * @param parentId     - target parent's id
 * @param elScreenRect - element's screen rect (post-transform AABB)
 * @param vpId         - parent's viewport id (used to read parent transform / rect)
 * @param scale        - canvas zoom
 * @param childVpId    - child's viewport id for the computed-dimensions read.
 *                       Defaults to `vpId`, but for canvas-rooted nodes
 *                       (vpPrefix='') being dropped into a non-primary
 *                       replica/variant, the child lives outside the entered
 *                       viewport — pass the dragged element's actual vpId so
 *                       findNodeComputedStyles hits the right cache key.
 */
export function computeEntryParentLocalPosition(
  childId: string,
  parentId: string,
  elScreenRect: { left: number; top: number; width: number; height: number },
  vpId: string,
  scale: number,
  childVpId?: string,
  /** Caller supplied a MOUSE-SYNCHRONOUS rect (derived from the drag's own
   *  written position) for an untransformed child — use ITS centre as the
   *  anchor and skip the painted-corners override. The corners cache lags
   *  the sandbox RAF exactly like the rect cache, so overriding a fresh
   *  rect with stale corners froze a one-step tracking error into the
   *  entry commit (the fast-drag residual, 2026-07-30). */
  trustRectAnchor?: boolean,
): { parentRelLeft: number; parentRelTop: number; cssWidth: number; cssHeight: number } | null {
  const dimVpId = childVpId ?? vpId;

  // Anchor = the screen-space image of the element's CSS-box CENTRE — the
  // fixed point of its own transform (transform-origin is centred). For
  // affine transforms (scale / rotation / skew) that's the AABB centre.
  // For a PROJECTIVE transform (perspective) it is NOT: the painted quad
  // is a trapezoid whose AABB centre is offset from the true centre
  // image. Projective transforms map lines to lines, so the rectangle
  // centre (where its diagonals cross) maps to where the painted quad's
  // diagonals cross. Anchoring on the AABB centre instead made a
  // perspective-distorted node visibly jump on entry. Fall back to the
  // AABB centre when corners are unavailable.
  let anchorX = elScreenRect.left + elScreenRect.width / 2;
  let anchorY = elScreenRect.top + elScreenRect.height / 2;
  if (!trustRectAnchor) {
    const childCorners = getScreenCornersById(childId, dimVpId);
    if (childCorners) {
      const diag = quadDiagonalIntersection(childCorners);
      if (diag) { anchorX = diag.x; anchorY = diag.y; }
    }
  }

  const localPos = convertScreenToParentLocal(anchorX, anchorY, parentId, vpId, scale);

  // Read the CHILD's CSS dimensions (not the post-transform AABB). For a
  // scale(2) element this is the un-doubled layout box — committing this
  // as `width`/`height` wouldn't change the visible size because the
  // scale transform stays applied on top.
  const childStyles = findNodeComputedStyles(childId, dimVpId, ['width', 'height']);
  const cssW = parseFloat(childStyles.width);
  const cssH = parseFloat(childStyles.height);
  const fallbackW = elScreenRect.width / scale;
  const fallbackH = elScreenRect.height / scale;
  const cssWidth = Number.isFinite(cssW) && cssW > 0 ? cssW : fallbackW;
  const cssHeight = Number.isFinite(cssH) && cssH > 0 ? cssH : fallbackH;

  if (!localPos) {
    // Fallback: simple AABB-relative math. Loses transform fidelity but
    // gracefully degrades when the parent's computed styles are missing.
    const parentRect = findNodeRect(parentId, vpId);
    if (!parentRect) return null;
    return {
      parentRelLeft: Math.round((elScreenRect.left - parentRect.left) / scale),
      parentRelTop: Math.round((elScreenRect.top - parentRect.top) / scale),
      cssWidth,
      cssHeight,
    };
  }

  return {
    parentRelLeft: Math.round(localPos.x - cssWidth / 2),
    parentRelTop: Math.round(localPos.y - cssHeight / 2),
    cssWidth,
    cssHeight,
  };
}

// ─── Diagnostic ─────────────────────────────────────────────────────────────

/** Trace helper for entry/exit decisions — verbose, only called once per event. */
export function traceTransformReparent(
  kind: 'entry' | 'exit',
  data: Record<string, unknown>,
): void {
  trace.action(`transform-reparent:${kind}`, data);
}
