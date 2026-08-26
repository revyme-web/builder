// drag/helpers/coords.ts — Shared coordinate-space conversions for drag /
// resize / camera code. Replaces the dozens of inline copies of
//   (rect.left - iframeOffset.x - transform.x) / transform.scale
// scattered across the strategies and CameraCommands.
//
// Why a helper:
//   - The conversion math has to be exact across every drag site, otherwise
//     elements drift between strategies (e.g., element jumps when canvas-drag
//     hands off to absolute-in-frame).
//   - The bridge's `getIframeOffset()` is optional on some bridge
//     implementations (DirectBridge in tests). The helper handles the fallback.
//   - `transform.x/y/scale` semantics: transform translates the canvas content
//     in screen space, then scales it. To convert a screen rect to canvas
//     space: subtract iframe offset (parent screen → iframe screen), subtract
//     transform translation (iframe screen → canvas screen), divide by scale
//     (canvas screen → canvas pixels).

import type { Point } from '@/shared/types';
import { getCanvasBridge } from '@/canvas/canvas-bridge';

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Read the iframe's screen offset from the bridge. Returns {0,0} if the
 *  bridge implementation doesn't expose getIframeOffset (e.g. DirectBridge). */
export function getIframeOffset(): Point {
  const b = getCanvasBridge() as any;
  if (typeof b.getIframeOffset === 'function') {
    const o = b.getIframeOffset();
    return { x: o.x ?? 0, y: o.y ?? 0 };
  }
  return { x: 0, y: 0 };
}

/** Convert a parent-screen-space DOMRect (from the bridge rectCache) to
 *  canvas-space coordinates and dimensions. */
export function screenRectToCanvas(rect: DOMRect, t: CanvasTransform, offset?: Point): CanvasRect {
  const o = offset ?? getIframeOffset();
  return {
    left: (rect.left - o.x - t.x) / t.scale,
    top: (rect.top - o.y - t.y) / t.scale,
    width: rect.width / t.scale,
    height: rect.height / t.scale,
  };
}

/** Convert a parent-screen-space point (e.g. mouse position) to canvas-space. */
export function screenPointToCanvas(p: Point, t: CanvasTransform, offset?: Point): Point {
  const o = offset ?? getIframeOffset();
  return {
    x: (p.x - o.x - t.x) / t.scale,
    y: (p.y - o.y - t.y) / t.scale,
  };
}

/** Inverse of `screenRectToCanvas`: canvas-space rect → parent-screen space.
 *
 *  CAUTION for drag code: mid-handoff the dragged element is still PARKED in
 *  its origin tile (the exit's code flush is deferred), so projecting its
 *  MODEL canvas coords through this gives where the element WILL paint after
 *  the flush — a constant offset from where it paints NOW. Anchoring on
 *  `startMouse − grabOffset + writtenDelta` is the divergence-free form for
 *  the dragged element itself (see CanvasDragStrategy's entry detection,
 *  2026-08-26); this helper is for rects whose model and DOM agree. */
export function canvasRectToScreen(rect: CanvasRect, t: CanvasTransform, offset?: Point): CanvasRect {
  const o = offset ?? getIframeOffset();
  return {
    left: rect.left * t.scale + t.x + o.x,
    top: rect.top * t.scale + t.y + o.y,
    width: rect.width * t.scale,
    height: rect.height * t.scale,
  };
}
