// multi-align.ts — Pure math for aligning a MULTI-SELECTION to its shared
// bounding box (standard). No DOM, no React — fully testable.
//
// Single-node alignment (pin-utils `calculateAlignment`) aligns ONE element
// inside its parent. Multi-select alignment is different: the reference frame
// is the bounding box of the whole selection, and every node moves so its
// chosen edge / centre lines up with that box. "Align left" snaps every node's
// left edge to the leftmost edge in the selection; "centre horizontally" centres
// each node on the selection's mid-X; etc.
//
// Returns a per-node DELTA (dx OR dy, in the same coordinate space as the input
// rects). The caller adds the delta to each node's current position. Working in
// deltas keeps the function agnostic to coordinate space (screen px, layout px,
// zoom) — the caller divides by the canvas scale once.

import type { AlignDirection } from '@/shared/pin-utils';

export interface AlignRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AlignDelta {
  /** Horizontal shift (left/center-h/right). Undefined for vertical directions. */
  dx?: number;
  /** Vertical shift (top/center-v/bottom). Undefined for horizontal directions. */
  dy?: number;
}

const isHorizontalDir = (dir: AlignDirection) =>
  dir === 'left' || dir === 'center-h' || dir === 'right';

/**
 * Compute per-node deltas to align `rects` to their shared bounding box.
 *
 * Needs ≥2 rects to have a meaningful group; with fewer it returns an empty map
 * (a single node has nothing to align against).
 */
export function calculateMultiAlign(
  dir: AlignDirection,
  rects: AlignRect[],
): Map<string, AlignDelta> {
  const out = new Map<string, AlignDelta>();
  if (rects.length < 2) return out;

  // Group bounding box.
  const minLeft = Math.min(...rects.map(r => r.left));
  const maxRight = Math.max(...rects.map(r => r.left + r.width));
  const minTop = Math.min(...rects.map(r => r.top));
  const maxBottom = Math.max(...rects.map(r => r.top + r.height));
  const centerX = (minLeft + maxRight) / 2;
  const centerY = (minTop + maxBottom) / 2;

  for (const r of rects) {
    if (isHorizontalDir(dir)) {
      let targetLeft: number;
      if (dir === 'left') targetLeft = minLeft;
      else if (dir === 'right') targetLeft = maxRight - r.width;
      else targetLeft = centerX - r.width / 2; // center-h
      out.set(r.id, { dx: targetLeft - r.left });
    } else {
      let targetTop: number;
      if (dir === 'top') targetTop = minTop;
      else if (dir === 'bottom') targetTop = maxBottom - r.height;
      else targetTop = centerY - r.height / 2; // center-v
      out.set(r.id, { dy: targetTop - r.top });
    }
  }

  return out;
}
