// canvas-math.ts — Centralized coordinate space conversions.
// Every system that needs to convert between coordinate spaces uses this.
// Snap guides, resize handles, distance indicators, auto-parenting, drop indicators — all go through here.
//
// Coordinate spaces:
//   - Screen space: mouse position, getBoundingClientRect
//   - Canvas space: absolute position on the infinite canvas (what you see when zoom=1, pan=0)
//   - Parent-relative: element's style.left/top relative to its positioned parent
//
// The key rule: snap guides, selection overlays, and visual helpers render in CANVAS space.
// Elements store positions in PARENT-RELATIVE space (style.left/top).
// This module converts between them.

import type { Transform, Rect, Point } from '@/shared/types';
import { getCanvasBridge } from './canvas-bridge';
import { findNodeRect } from './node-ops';
import { trace } from '@/shared/debug-trace';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';

export { clamp } from '@/shared/math-utils';

// ─── Element Rects ──────────────────────────────────────────────────────────

// ─── Screen ↔ Canvas ────────────────────────────────────────────────────────

/**
 * Convert screen (mouse) coordinates to canvas-space coordinates.
 */
export function screenToCanvas(
  screenX: number, screenY: number,
  transform: Transform, containerRect: DOMRect,
): Point {
  return {
    x: (screenX - containerRect.left - transform.x) / transform.scale,
    y: (screenY - containerRect.top - transform.y) / transform.scale,
  };
}

/**
 * Convert canvas-space coordinates to screen coordinates.
 */
export function canvasToScreen(
  canvasX: number, canvasY: number,
  transform: Transform, containerRect: DOMRect,
): Point {
  return {
    x: canvasX * transform.scale + transform.x + containerRect.left,
    y: canvasY * transform.scale + transform.y + containerRect.top,
  };
}

/**
 * Calculate mouse delta in canvas-space (accounting for zoom).
 */
export function getCanvasDelta(screenDx: number, screenDy: number, scale: number): Point {
  return { x: screenDx / scale, y: screenDy / scale };
}

// ─── Rect Math ──────────────────────────────────────────────────────────────

/** Check if a point is inside a rect. */
export function isInsideRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.left && point.x <= rect.left + rect.width &&
         point.y >= rect.top && point.y <= rect.top + rect.height;
}

/** Check if two rects overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left &&
         a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Get the combined bounding box of multiple rects. */
export function getBoundingRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}


// ─── Bridge-Powered Rect Reads ─────────────────────────────────────────────
// These resolve element by nodeId via the bridge, avoiding direct DOM access.
// In Phase 2, these become postMessage queries to the sandbox iframe.

/**
 * Get a canvas element's absolute rect using the bridge (by nodeId, not element reference).
 * Bridge version of getAbsoluteCanvasRect — doesn't require an HTMLElement reference.
 */
export function getCanvasRectById(nodeId: string, vpPrefix: string, transform: Transform): Rect | null {
  const bridge = getCanvasBridge();
  const elRect = bridge.getRect(nodeId, vpPrefix);
  const containerRect = bridge.getContainerRect();
  if (!elRect || !containerRect) return null;
  return {
    left: (elRect.left - containerRect.left) / transform.scale,
    top: (elRect.top - containerRect.top) / transform.scale,
    width: elRect.width / transform.scale,
    height: elRect.height / transform.scale,
  };
}

// ─── Transform Matrix Utilities ─────────────────────────────────────────────

/**
 * Transform a point through an element's CSS matrix using center pivot.
 * Used by resize to calculate opposite corner positions through rotation.
 */
/**
 * Apply a CSS transform matrix to a point in the same coordinate space
 * as `elementRect`. Returns the post-transform position of that point —
 * used by the resize anchor logic to keep the opposite corner stable
 * regardless of the element's own transform.
 *
 * Handles ALL transform combinations via `DOMMatrix.transformPoint`:
 *   - 2D affine (rotate / scale / skew / translate / `matrix(…)`)
 *   - 3D affine without perspective (`rotateX` / `rotateY` / `rotate3d`
 *     / `matrix3d(…)` with m43 = 0) — projection is parallel, so the
 *     2D screen coords come out of `transformPoint` directly.
 *   - 3D with perspective — `transformPoint` returns a homogeneous
 *     point with `w ≠ 1`; we divide x/y by w to get the projected
 *     screen position the browser actually renders.
 *
 * The previous regex-based version only matched the 2D `matrix(a,b,c,
 * d,e,f)` form and returned the untransformed point for everything
 * else — that's why opposite-corner anchoring worked for plain
 * rotation but broke on skew, rotateX/Y, and any 3D combination.
 *
 * CSS rotates around `transform-origin` (default `50% 50%` = element
 * centre). We translate to origin → transform → translate back to
 * match that.
 */
export function getTransformedPoint(
  x: number, y: number,
  elementRect: { x: number; y: number; width: number; height: number },
  matrixStr: string,
  // Optional explicit rotation pivot in the SAME space as `elementRect`.
  // The CSS `transform-origin` is NOT always the box centre — e.g. an SVG
  // GROUP rotates around its painted-content centre. When the resize
  // compensation pins the opposite corner it must use the ACTUAL pivot the
  // browser rotates around, or it pins a virtual point that doesn't match
  // the screen (the rotated group "swings"). Defaults to the box centre,
  // which is what a `transform-origin: 50% 50%` element uses.
  pivot?: { x: number; y: number },
): Point {
  if (!matrixStr || matrixStr === 'none') return { x, y };

  let m: DOMMatrix;
  try {
    m = new DOMMatrix(matrixStr);
  } catch {
    return { x, y };
  }

  const cx = pivot ? pivot.x : elementRect.x + elementRect.width / 2;
  const cy = pivot ? pivot.y : elementRect.y + elementRect.height / 2;
  const p = new DOMPoint(x - cx, y - cy, 0, 1).matrixTransform(m);
  // For non-perspective 2D/3D, w stays 1 and this is a no-op.
  // For perspective-applied 3D, divide x/y by w to get the projected
  // screen position the browser actually paints.
  const w = p.w || 1;
  return { x: p.x / w + cx, y: p.y / w + cy };
}

// ─── Overlay coordinate helpers (shared by GradientOverlay, ClipPathOverlay, ShapeEditOverlay) ──

/** Linear interpolation between two points. */
export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Convert element-relative percentage (0-100) to screen coordinates via bilinear interpolation across a ScreenCorners quad. */
export function pctToScreen(corners: { TL: Point; TR: Point; BL: Point; BR: Point }, xPct: number, yPct: number): Point {
  const top = lerpPoint(corners.TL, corners.TR, xPct / 100);
  const bottom = lerpPoint(corners.BL, corners.BR, xPct / 100);
  return lerpPoint(top, bottom, yPct / 100);
}

/** Convert screen coordinates back to element-relative percentage (0-100) via inverse bilinear interpolation. */
export function screenToPct(corners: { TL: Point; TR: Point; BL: Point; BR: Point }, sx: number, sy: number): [number, number] {
  const dx = corners.TR.x - corners.TL.x;
  const dy = corners.TR.y - corners.TL.y;
  const ex = corners.BL.x - corners.TL.x;
  const ey = corners.BL.y - corners.TL.y;
  const px = sx - corners.TL.x;
  const py = sy - corners.TL.y;
  const det = dx * ey - dy * ex;
  if (Math.abs(det) < 0.001) return [50, 50];
  const xPct = ((px * ey - py * ex) / det) * 100;
  const yPct = ((dx * py - dy * px) / det) * 100;
  return [xPct, yPct];
}

// ─── Bridge-Aware Coordinate Functions (by nodeId) ─────────────────────────

/**
 * Get an element's rect in ABSOLUTE CANVAS space by nodeId.
 * Bridge-aware version of getAbsoluteCanvasRect — uses findNodeRect instead of direct DOM.
 * Accounts for iframe offset when running in iframe mode.
 */
export function getAbsoluteCanvasRectById(nodeId: string, vpId: string, transform: Transform): Rect | null {
  const elRect = findNodeRect(nodeId, vpId);
  if (!elRect) {
    trace.fn('canvas-math:getAbsoluteCanvasRectById:null', { nodeId, vpId });
    return null;
  }
  const bridge = getCanvasBridge();
  const iframeOffset = 'getIframeOffset' in bridge
    ? (bridge as PostMessageBridge).getIframeOffset()
    : { x: 0, y: 0 };
  const contentOriginX = iframeOffset.x + transform.x;
  const contentOriginY = iframeOffset.y + transform.y;
  const result = {
    left: (elRect.left - contentOriginX) / transform.scale,
    top: (elRect.top - contentOriginY) / transform.scale,
    width: elRect.width / transform.scale,
    height: elRect.height / transform.scale,
  };
  trace.fn('canvas-math:getAbsoluteCanvasRectById', { nodeId, vpId, left: result.left, top: result.top, width: result.width, height: result.height });
  return result;
}

/**
 * Get the parent chain offset by nodeId.
 * Bridge-aware version of getParentCanvasOffset.
 * Returns { x: parentRect.left, y: parentRect.top } or { x: 0, y: 0 } if not found.
 */
export function getParentCanvasOffsetById(parentId: string, vpId: string, transform: Transform): { x: number; y: number } {
  const parentRect = getAbsoluteCanvasRectById(parentId, vpId, transform);
  if (!parentRect) {
    trace.fn('canvas-math:getParentCanvasOffsetById:null', { parentId, vpId });
    return { x: 0, y: 0 };
  }
  trace.fn('canvas-math:getParentCanvasOffsetById', { parentId, vpId, x: parentRect.left, y: parentRect.top });
  return { x: parentRect.left, y: parentRect.top };
}

/**
 * Convert screen coordinates to parent-relative coordinates by parentId.
 * Bridge-aware version of screenToParent — uses findNodeRect instead of direct DOM.
 */
function screenToParentById(screenX: number, screenY: number, parentId: string, vpId: string): { x: number; y: number } {
  const parentRect = findNodeRect(parentId, vpId);
  if (!parentRect) {
    trace.fn('canvas-math:screenToParentById:null', { parentId, vpId, screenX, screenY });
    return { x: screenX, y: screenY };
  }
  const result = { x: screenX - parentRect.left, y: screenY - parentRect.top };
  trace.fn('canvas-math:screenToParentById', { parentId, vpId, x: result.x, y: result.y });
  return result;
}

/**
 * Convert absolute canvas position to parent-relative position by parentId.
 * Bridge-aware version of absoluteToRelative — uses getParentCanvasOffsetById instead of direct DOM.
 */
export function absoluteToRelativeById(
  absX: number, absY: number,
  parentId: string, vpId: string, transform: Transform,
): Point {
  const offset = getParentCanvasOffsetById(parentId, vpId, transform);
  trace.fn('canvas-math:absoluteToRelativeById', { parentId, vpId, absX, absY, offsetX: offset.x, offsetY: offset.y });
  return { x: absX - offset.x, y: absY - offset.y };
}
