// BorderRadiusHandle.tsx — Draggable handle at top-left corner to adjust border-radius.
// Drag vertically to increase/decrease all 4 corners equally.
// Shift-key snaps to 32px increments. Scale-aware sizing.

import { useCallback, useRef } from 'react';
import { SELECTION_COLOR } from '@/shared/constants';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import { findNodeComputedStyle, updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { styleHelperOps } from './style-helper-store';
import { trace } from '@/shared/debug-trace';
import { getNodesSnapshot } from '@/code/stores/store';

const BASE_SIZE = 8; // px at scale=1
const MIN_SCALE = 0.2;

interface Props {
  corners: ScreenCorners;
  nodeId: string;
  vpId: string;
  color?: string;
  onInteracting: (v: boolean) => void;
}

export default function BorderRadiusHandle({ corners, nodeId, vpId, color = SELECTION_COLOR, onInteracting }: Props) {
  const scale = transformManager.getTransform().scale;

  // DIAGNOSTIC (temporary): when does THIS handle actually render vs. get nulled
  // by the scale gate? Logs on node change or scale-gate flip only.
  const dbgRef = useRef('');
  const dbgTl = corners ? `${Math.round(corners.TL.x)},${Math.round(corners.TL.y)}` : 'none';
  // Include position + hidden in the signature so this logs not just the first
  // render but any LATER move (seed → real rect on render-complete) or scale-gate
  // flip — that's what would make the radius handle appear to "land late".
  const dbgSig = `${nodeId}|${scale < MIN_SCALE ? 'HID' : 'viz'}|${dbgTl}`;
  if (dbgSig !== dbgRef.current) {
    dbgRef.current = dbgSig;
    trace.action('border-radius-handle:state', {
      nodeId, hidden: scale < MIN_SCALE, scale, tl: dbgTl,
    });
  }

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const contentEl = getContentRoot();
    if (!contentEl) return;

    // Read initial radius from the computed cache. KEY DETAIL: the sandbox
    // measure sweep caches CAMEL keys of CACHED_PROPS — `border-radius` →
    // `borderRadius`. The old read asked for `borderTopLeftRadius` /
    // `border-top-left-radius`, neither of which is ever cached, and the
    // cache short-circuits uncached props to '' — so EVERY re-drag started
    // from 0 instead of the committed radius (user report 2026-07-29).
    // parseFloat on a per-corner list ('12px 8px …') yields the top-left
    // corner, which is exactly what this uniform handle wants. Authored
    // styles are the fallback for a cold cache.
    const computedRadius = findNodeComputedStyle(nodeId, vpId, 'borderRadius')
      || findNodeComputedStyle(nodeId, vpId, 'borderTopLeftRadius')
      || findNodeComputedStyle(nodeId, vpId, 'border-top-left-radius');
    const authoredRadius = getNodesSnapshot().get(nodeId)?.styles?.borderRadius ?? '';
    const initialRadius = parseFloat(computedRadius) || parseFloat(authoredRadius) || 0;
    const startY = e.clientY;
    const currentScale = transformManager.getTransform().scale;

    trace.action('border-radius-handle:start', { nodeId, initialRadius });
    onInteracting(true);

    // Track last radius for commit
    let lastRadius = initialRadius;

    const onMove = (me: PointerEvent) => {
      const deltaY = (me.clientY - startY) / currentScale;
      let newRadius = Math.max(0, Math.round(initialRadius + deltaY));

      // Shift-key: snap to 32px increments
      if (me.shiftKey) {
        newRadius = Math.round(newRadius / 32) * 32;
      }

      // Apply via bridge (imperative-first)
      lastRadius = newRadius;
      updateNodeStyles({ id: nodeId, styles: { borderRadius: `${newRadius}px` }, contentEl, domOnly: true });

      // Show tooltip
      styleHelperOps.show({
        type: 'radius',
        position: { x: me.clientX + 16, y: me.clientY + 16 },
        value: newRadius,
        unit: 'px',
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Commit tracked value to code
      const styles: Record<string, string> = lastRadius === 0
        ? { borderRadius: '' }
        : { borderRadius: `${lastRadius}px` };

      updateNodeStyles({ id: nodeId, styles, contentEl });
      styleHelperOps.hide();
      onInteracting(false);
      trace.action('border-radius-handle:end', { nodeId, radius: lastRadius });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [nodeId, vpId, onInteracting]);

  if (scale < MIN_SCALE) return null;

  // Fixed screen-space size (same as resize handles)
  const handleSize = BASE_SIZE;
  const r = handleSize / 2;

  // Fixed inward offset
  const offset = 6;

  return (
    <svg
      onPointerDown={handlePointerDown}
      style={{
        position: 'fixed',
        left: corners.TL.x + offset,
        top: corners.TL.y + offset,
        width: handleSize,
        height: handleSize,
        pointerEvents: 'all',
        cursor: 'nwse-resize',
        zIndex: 4,
        overflow: 'visible',
      }}
    >
      <circle cx={r} cy={r} r={r} fill="#fff" />
      <circle cx={r} cy={r} r={r * 0.75} fill={color} />
    </svg>
  );
}
