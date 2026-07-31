// AddEntryUI.tsx — Shared skeleton for the floating "add entry" affordances
// next to a selected source on a master file (9.4b). AddVariantUI ("+ Variant"
// / "+ Hover/Pressed" on component masters) and AddVectorUI ("+ Vector" on
// icon-set masters) share this placement/poll/render skeleton; the per-kind
// differences (labels, what clicking creates, where sibling rects come from)
// stay in the wrapper files as props/callbacks.

import React, { useEffect, useState } from 'react';
import { nextFrames } from '@/shared/dom-utils';
import { findNodeRect } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { PlusBadgeIcon } from '@/shared/icons';

export interface ScreenRect { left: number; top: number; width: number; height: number; }

/** Show the text label only when the card is big enough on screen. */
export const showText = (rect: ScreenRect) => rect.width >= 80 && rect.height >= 50;
/** Show the + icon only when the card is big enough on screen. */
export const showIcon = (rect: ScreenRect) => rect.width >= 30 && rect.height >= 30;

/**
 * Scan past overlapping rects along one axis so the candidate card never sits
 * ON TOP of another entry. Starts one `padding` past the source's far edge and
 * pushes past every overlapping obstacle (max 20 iterations). The candidate is
 * always source-sized; the cross-axis position is pinned to the source's edge.
 */
export function scanPastRects(
  axis: 'right' | 'below',
  sourceRect: DOMRect,
  padding: number,
  obstacles: DOMRect[],
): ScreenRect {
  const candidateWidth = sourceRect.width;
  const candidateHeight = sourceRect.height;
  if (axis === 'right') {
    let candidateLeft = sourceRect.right + padding;
    const candidateTop = sourceRect.top;
    let iterations = 20;
    while (iterations-- > 0) {
      const candidateRight = candidateLeft + candidateWidth;
      let overlap = false;
      let pushTo = candidateLeft;
      for (const rect of obstacles) {
        if (
          candidateRight > rect.left && candidateLeft < rect.right &&
          (candidateTop + candidateHeight) > rect.top && candidateTop < rect.bottom
        ) {
          overlap = true;
          pushTo = Math.max(pushTo, rect.right + padding);
        }
      }
      if (!overlap) break;
      candidateLeft = pushTo;
    }
    return { left: candidateLeft, top: candidateTop, width: candidateWidth, height: candidateHeight };
  }
  // axis === 'below'
  let candidateTop = sourceRect.bottom + padding;
  const candidateLeft = sourceRect.left;
  let iterations = 20;
  while (iterations-- > 0) {
    const candidateBottom = candidateTop + candidateHeight;
    let overlap = false;
    let pushTo = candidateTop;
    for (const rect of obstacles) {
      if (
        (candidateLeft + candidateWidth) > rect.left && candidateLeft < rect.right &&
        candidateBottom > rect.top && candidateTop < rect.bottom
      ) {
        overlap = true;
        pushTo = Math.max(pushTo, rect.bottom + padding);
      }
    }
    if (!overlap) break;
    candidateTop = pushTo;
  }
  return { left: candidateLeft, top: candidateTop, width: candidateWidth, height: candidateHeight };
}

/**
 * Position polling — RAF loop that reads the source's rect from the bridge
 * and scans past sibling entries on each axis so the card(s) never overlap
 * another entry. The gap scales with the SOURCE size so a small source keeps
 * the button close: a fixed 200-canvas-px gap (`200 * scale`) put the button
 * far off-screen when zoomed into a small source — you couldn't see/click it.
 * Half the source dimension (per axis), floored at 24*scale so it never
 * collapses onto the source, capped at the original 200*scale for big
 * sources. Rects are in screen px, so the clamp bounds are too.
 */
export function useAddEntryPlacement(opts: {
  enabled: boolean;
  sourceId: string | null;
  vpId: string;
  /** Obstacle rects re-read EVERY frame — memoize with the same deps the
   *  original placement effect listed so restarts match. */
  getObstacleRects: () => DOMRect[];
  /** Also compute the below-the-source slot (AddVariantUI's HP strip). */
  scanBelow?: boolean;
}): { right: ScreenRect | null; below: ScreenRect | null } {
  const { enabled, sourceId, vpId, getObstacleRects, scanBelow } = opts;
  const [right, setRight] = useState<ScreenRect | null>(null);
  const [below, setBelow] = useState<ScreenRect | null>(null);

  useEffect(() => {
    if (!enabled || !sourceId) {
      setRight(null);
      setBelow(null);
      return;
    }

    let rafId: number;
    const poll = () => {
      const sourceRect = findNodeRect(sourceId, vpId);
      if (!sourceRect) { rafId = requestAnimationFrame(poll); return; }
      const scale = transformManager.getTransform().scale;
      const minGap = 24 * scale;
      const maxGap = 200 * scale;
      const rightPadding = Math.min(maxGap, Math.max(minGap, sourceRect.width * 0.5));

      const obstacles = getObstacleRects();

      setRight(scanPastRects('right', sourceRect, rightPadding, obstacles));
      if (scanBelow) {
        const belowPadding = Math.min(maxGap, Math.max(minGap, sourceRect.height * 0.5));
        setBelow(scanPastRects('below', sourceRect, belowPadding, obstacles));
      }

      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [enabled, sourceId, vpId, scanBelow, getObstacleRects]);

  return { right, below };
}

/**
 * Wait for a (newly created) node's DOM to land — retries `findNodeRect` for
 * up to 30 animation frames, starting two frames after the code write so the
 * renderer has a chance to paint. Runs `onReady` once the rect exists.
 */
export function whenNodeRectReady(nodeId: string, vpId: string, onReady: () => void): void {
  let attempts = 30;
  const tryFind = () => {
    const rect = findNodeRect(nodeId, vpId);
    if (rect) {
      onReady();
      return;
    }
    if (attempts-- > 0) requestAnimationFrame(tryFind);
  };
  nextFrames(2, tryFind);
}

/**
 * The floating source-sized "+ <label>" card. Fixed-position (screen space),
 * hidden/click-through while the canvas is interacting, hover highlight.
 * `forceHover` keeps the hover background while an attached menu is open
 * (AddVariantUI's Hover/Pressed dropdown).
 */
export function AddEntryCard({ rect, label, title, isInteracting, forceHover, onClick }: {
  rect: ScreenRect;
  label: string;
  title: string;
  isInteracting: boolean;
  forceHover?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onMouseDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: showText(rect) ? 12 : 0,
        border: '2px solid var(--border-light)',
        backgroundColor: (isHovered || forceHover) ? 'var(--variant-card-bg-hover)' : 'var(--variant-card-bg)',
        cursor: 'pointer',
        pointerEvents: isInteracting ? 'none' : 'auto',
        zIndex: 2001,
        opacity: isInteracting ? 0 : 1,
        transition: isInteracting ? 'none' : 'background-color 0.15s, opacity 0.15s',
      }}
      title={title}
    >
      {showIcon(rect) && <PlusBadgeIcon />}
      {showText(rect) && (
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      )}
    </div>
  );
}
