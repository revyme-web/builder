// ObjectPositionHandle.tsx — Draggable dot at the selection's bottom-right
// that adjusts how an image / video / background-image fills its box.
//
// Two CSS targets, picked by element type:
//   - <img> / <video> / <picture> ... with `object-fit: cover` → writes
//     `objectPosition`.
//   - frame (`<div>`, `<section>`, …) with a `background-image` AND
//     `background-size: cover` → writes `backgroundPosition`.
//
// Cover-mode-only: position adjustment is only meaningful when content
// overflows the box. For `contain` / `auto` / `100% 100%` the position
// is the box origin and dragging has no visible effect — hide the handle
// in those cases.
//
// Drag math: the delta (in canvas-space px) is mapped to a 0–100% shift
// of the position. Going right increases X (which pushes the image
// leftward in CSS), going down increases Y. `* 0.5` damping matches the
// old builder's feel — full-handle traversal needs a generous gesture.
// Shift-snap to 10% increments.

import { useCallback, useRef } from 'react';
import { SELECTION_COLOR } from '@/shared/constants';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import { findNodeComputedStyle, updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { trace } from '@/shared/debug-trace';
import { MEDIA_TAGS } from '@/shared/constants';
import { getNodeFromCache } from '@/code/stores/store';

const BASE_SIZE = 8; // px at scale=1
const MIN_SCALE = 0.2;
const SENSITIVITY = 0.5; // 1 canvas-px drag → 0.5% position change

interface Props {
  corners: ScreenCorners;
  nodeId: string;
  vpId: string;
  /** The node's tag — `img`/`video`/`picture`/etc. for object-position,
   *  anything else routes to background-position (when there's a bg). */
  nodeType: string;
  color?: string;
  onInteracting: (v: boolean) => void;
}

interface Eligibility {
  property: 'objectPosition' | 'backgroundPosition';
  initial: { x: number; y: number };
}

/** Decide which CSS property this element should drive, and read the
 *  current position into 0–100% pair. Returns null when the element
 *  isn't a valid target.
 *
 *  Read from the parsed source styles (`node.styles`) — the bridge's
 *  computed cache only populates props that some patch has touched, so
 *  for a freshly-rendered background-image frame `findNodeComputedStyle`
 *  would return `''` and we'd misclassify the element as ineligible.
 *  Source styles are populated unconditionally by the parser, so they
 *  ARE the right truth source for "is this property set in JSX". The
 *  computed-style fallback below picks up @media / @container overrides
 *  for the current viewport. */
function getEligibility(nodeId: string, vpId: string, nodeType: string): Eligibility | null {
  const tag = nodeType.toLowerCase().replace(/^motion\./, 'motion.');
  const isMedia = MEDIA_TAGS.has(tag) && tag !== 'svg' && tag !== 'audio' && tag !== 'iframe';
  const node = getNodeFromCache(nodeId);
  const sourceStyles = node?.styles ?? {};
  /** Resolve a style by precedence: source (JSX) → computed (bridge cache).
   *  Bridge cache wins for @media / responsive override values when present. */
  const read = (...keys: string[]): string => {
    for (const k of keys) {
      if (sourceStyles[k]) return sourceStyles[k];
    }
    for (const k of keys) {
      const v = findNodeComputedStyle(nodeId, vpId, k);
      if (v) return v;
    }
    return '';
  };
  if (isMedia) {
    const fit = (read('objectFit', 'object-fit') || 'fill').toLowerCase();
    // Position only matters when the painted content can overflow the
    // box — that's `cover`. For `contain` / `fill` / `none` / `scale-down`
    // the image already fits, so a position drag does nothing user-
    // visible. Skip the handle in those cases.
    if (fit !== 'cover') return null;
    return { property: 'objectPosition', initial: parsePosition(read('objectPosition', 'object-position') || '50% 50%') };
  }
  // Non-media element → only show the handle if there's a background
  // image AND it's in cover mode.
  const bgImage = read('backgroundImage', 'background-image') || 'none';
  if (!bgImage || bgImage === 'none') return null;
  const bgSize = (read('backgroundSize', 'background-size') || 'auto').toLowerCase();
  if (bgSize !== 'cover') return null;
  return { property: 'backgroundPosition', initial: parsePosition(read('backgroundPosition', 'background-position') || '50% 50%') };
}

/** Parse a CSS `<x> <y>` position into 0-100 % pair. Accepts %, px, and
 *  the named keywords (`top` / `right` / etc.). Anything we can't parse
 *  falls back to center. Pixel values are converted by computed-style
 *  resolution at write time; we display percent for stable feel. */
function parsePosition(raw: string): { x: number; y: number } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'center' || trimmed === '') return { x: 50, y: 50 };
  // Two-value form
  const parts = trimmed.split(/\s+/);
  const parse = (s: string | undefined, axis: 'x' | 'y'): number => {
    if (!s) return 50;
    if (s === 'center') return 50;
    if (axis === 'x') {
      if (s === 'left') return 0;
      if (s === 'right') return 100;
    } else {
      if (s === 'top') return 0;
      if (s === 'bottom') return 100;
    }
    const pct = s.match(/^(-?[\d.]+)%$/);
    if (pct) return Math.max(0, Math.min(100, parseFloat(pct[1])));
    const px = s.match(/^(-?[\d.]+)px$/);
    // Treat px as 0% for now — the user will drag away from it and the
    // first commit will rewrite to %; we just want a sensible seed.
    if (px) return parseFloat(px[1]) >= 0 ? 0 : 100;
    return 50;
  };
  return { x: parse(parts[0], 'x'), y: parse(parts[1] ?? parts[0], 'y') };
}

export default function ObjectPositionHandle({ corners, nodeId, vpId, nodeType, color = SELECTION_COLOR, onInteracting }: Props) {
  const scale = transformManager.getTransform().scale;
  const currentPos = useRef<{ x: number; y: number }>({ x: 50, y: 50 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const contentEl = getContentRoot();
    if (!contentEl) return;

    const eligibility = getEligibility(nodeId, vpId, nodeType);
    if (!eligibility) return;

    currentPos.current = eligibility.initial;
    const property = eligibility.property;
    const startX = e.clientX;
    const startY = e.clientY;
    const currentScale = transformManager.getTransform().scale;

    trace.action('object-position-handle:start', { nodeId, property, initial: eligibility.initial });
    onInteracting(true);

    let lastValue = `${Math.round(currentPos.current.x)}% ${Math.round(currentPos.current.y)}%`;

    const onMove = (me: PointerEvent) => {
      const deltaX = (me.clientX - startX) / currentScale;
      const deltaY = (me.clientY - startY) / currentScale;

      let newX = Math.max(0, Math.min(100, currentPos.current.x + deltaX * SENSITIVITY));
      let newY = Math.max(0, Math.min(100, currentPos.current.y + deltaY * SENSITIVITY));

      // Shift snaps to 10% increments.
      if (me.shiftKey) {
        newX = Math.round(newX / 10) * 10;
        newY = Math.round(newY / 10) * 10;
      }

      lastValue = `${Math.round(newX)}% ${Math.round(newY)}%`;
      updateNodeStyles({
        id: nodeId,
        styles: { [property]: lastValue },
        contentEl,
        domOnly: true,
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Commit the last value to source.
      updateNodeStyles({
        id: nodeId,
        styles: { [property]: lastValue },
        contentEl,
      });
      onInteracting(false);
      trace.action('object-position-handle:end', { nodeId, property, value: lastValue });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [nodeId, vpId, nodeType, onInteracting]);

  if (scale < MIN_SCALE) return null;

  // Eligibility is checked again at mousedown time (computed styles
  // could have changed between render passes), but we also gate the
  // render here so the dot doesn't appear on elements that aren't
  // valid targets.
  const eligibility = getEligibility(nodeId, vpId, nodeType);
  trace.fn('ObjectPositionHandle:render', { nodeId, nodeType, eligibleProp: eligibility?.property ?? null });
  if (!eligibility) return null;

  const handleSize = BASE_SIZE;
  const r = handleSize / 2;
  // Inset from the BR corner — matches BorderRadiusHandle's offset
  // pattern at TL. 6px in screen space, scale-invariant.
  const offset = 6;
  const cx = corners.BR.x - offset - handleSize;
  const cy = corners.BR.y - offset - handleSize;

  return (
    <svg
      data-object-position-handle=""
      onPointerDown={handlePointerDown}
      style={{
        position: 'fixed',
        left: cx,
        top: cy,
        width: handleSize,
        height: handleSize,
        pointerEvents: 'all',
        cursor: 'move',
        zIndex: 4,
        overflow: 'visible',
      }}
    >
      <circle cx={r} cy={r} r={r} fill="#fff" />
      <circle cx={r} cy={r} r={r * 0.75} fill={color} />
      <circle cx={r} cy={r} r={r * 0.2} fill="#fff" />
    </svg>
  );
}
