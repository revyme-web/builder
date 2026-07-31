// GripHandle.tsx — Drag grip for flex children. Small accent circle with arrow icon.
// Shows on left (column) or bottom (row) outside the element.
// Ported from old builder: scale-aware, accent color, proper icons.

import { useNodesComputed } from '@/code/stores/node-family';
import { SELECTION_COLOR } from '@/shared/constants';
import { findNodeComputedStyle } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { trace } from '@/shared/debug-trace';

// ─── Arrow icons (old builder's GripHorizontal/VerticalIcon) ────────────────

const GripHorizontalIcon = ({ size }: { size: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 512 512">
    <path fill="#fff" d="M504.3 273.6c4.9-4.5 7.7-10.9 7.7-17.6s-2.8-13-7.7-17.6l-112-104c-7-6.5-17.2-8.2-25.9-4.4S352 142.5 352 152v56H160v-56c0-9.5-5.7-18.2-14.4-22s-18.9-2.1-25.9 4.4l-112 104C2.8 243 0 249.3 0 256s2.8 13 7.7 17.6l112 104c7 6.5 17.2 8.2 25.9 4.4s14.4-12.5 14.4-22v-56h192v56c0 9.5 5.7 18.2 14.4 22s18.9 2.1 25.9-4.4z" />
  </svg>
);

const GripVerticalIcon = ({ size }: { size: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 512 512" style={{ transform: 'rotate(90deg)' }}>
    <path fill="#fff" d="M504.3 273.6c4.9-4.5 7.7-10.9 7.7-17.6s-2.8-13-7.7-17.6l-112-104c-7-6.5-17.2-8.2-25.9-4.4S352 142.5 352 152v56H160v-56c0-9.5-5.7-18.2-14.4-22s-18.9-2.1-25.9 4.4l-112 104C2.8 243 0 249.3 0 256s2.8 13 7.7 17.6l112 104c7 6.5 17.2 8.2 25.9 4.4s14.4-12.5 14.4-22v-56h192v56c0 9.5 5.7 18.2 14.4 22s18.9 2.1 25.9-4.4z" />
  </svg>
);

interface Props {
  corners: { TL: { x: number; y: number }; TR: { x: number; y: number }; BL: { x: number; y: number }; BR: { x: number; y: number } };
  nodeId: string;
  vpId: string;
  color?: string;
  onGripDragStart?: (nodeId: string, event: React.PointerEvent, gripAxis: 'x' | 'y') => void;
}

export default function GripHandle({ corners, nodeId, vpId, color = SELECTION_COLOR, onGripDragStart }: Props) {
  // Check context: must be a flex child with siblings. Per-computation
  // subscription — re-renders only when the {isColumn}/null RESULT changes,
  // not on every commit somewhere else on the page.
  const context = useNodesComputed((nodes) => {
    const node = nodes.get(nodeId);
    if (!node) return null;
    // Top-level canvas-fragment entries have no flex parent — they live in
    // the `canvasNodes` JSX block and float on the canvas. No grip there.
    if (node.isCanvasNode) return null;
    const parentId = node.parentId;
    if (!parentId) return null;

    // Viewport-aware position check — a node may be relative on desktop but
    // absolute on tablet, and the grip must hide in viewports where it's
    // out of flow. Falls back to source styles if the bridge has no value.
    const computedPos = findNodeComputedStyle(nodeId, vpId, 'position');
    const pos = computedPos || node.styles?.position;
    if (pos === 'absolute' || pos === 'fixed') return null;

    // Parent must also be a real in-flow node — if the parent itself is a
    // canvas node, the grip's "reorder among siblings" semantics still apply
    // ONLY if the parent is flex (checked below). No special case needed
    // beyond the flex-display check.
    const parentDisplay = findNodeComputedStyle(parentId, vpId, 'display');

    // Must be in a flex container (not grid)
    if (!parentDisplay.includes('flex')) return null;
    if (parentDisplay.includes('grid')) return null;

    // Wrapped flex: once items flow onto multiple lines the grip's single-axis
    // reorder drag is ambiguous (a child's "next" neighbor may be on another
    // row), so suppress the grip handle when the parent wraps.
    const parentWrap = findNodeComputedStyle(parentId, vpId, 'flexWrap') || findNodeComputedStyle(parentId, vpId, 'flex-wrap');
    if (parentWrap === 'wrap' || parentWrap === 'wrap-reverse') return null;

    // Must have at least one sibling that's also in flow
    const parentNode = nodes.get(parentId);
    if (!parentNode) return null;
    const siblings = parentNode.children.filter(childId => {
      if (childId === nodeId) return false;
      const childNode = nodes.get(childId);
      if (!childNode) return false;
      const childPos = childNode.styles?.position;
      return childPos !== 'absolute' && childPos !== 'fixed';
    });
    if (siblings.length === 0) return null;

    const dir = findNodeComputedStyle(parentId, vpId, 'flexDirection') || findNodeComputedStyle(parentId, vpId, 'flex-direction');
    return { isColumn: dir === 'column' || dir === 'column-reverse' };
  }, [nodeId, vpId]);

  const scale = transformManager.getTransform().scale;
  if (!context || scale < 0.2) return null;

  const { isColumn } = context;

  // Fixed screen-space sizes (same visual size at any zoom)
  const handleSize = 24;
  const iconSize = 14;
  const offset = 32;

  // Position outside the element
  let cx: number, cy: number;
  if (isColumn) {
    // Left of element, vertically centered
    cx = (corners.TL.x + corners.BL.x) / 2 - offset;
    cy = (corners.TL.y + corners.BL.y) / 2;
  } else {
    // Below element, horizontally centered
    cx = (corners.BL.x + corners.BR.x) / 2;
    cy = (corners.BL.y + corners.BR.y) / 2 + offset;
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const gripAxis = isColumn ? 'y' : 'x';
    trace.action('grip-handle:pointerdown', { nodeId, isColumn, gripAxis });
    onGripDragStart?.(nodeId, e, gripAxis);
  };

  // Browsers fire BOTH pointerdown AND mousedown for the same click.
  // pointerdown is stopped above but mousedown still bubbles to the canvas
  // container's onMouseDown, which would hit-test through the grip and start
  // dragging the element behind it. Stop mousedown too. Same for click —
  // belt-and-suspenders so no synthetic event wakes up the canvas handlers.
  const stopAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onMouseDown={stopAll}
      onClick={stopAll}
      style={{
        position: 'fixed',
        left: cx - handleSize / 2,
        top: cy - handleSize / 2,
        width: handleSize,
        height: handleSize,
        borderRadius: '50%',
        backgroundColor: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'all',
        cursor: 'grab',
        zIndex: 5,
      }}
    >
      {isColumn ? <GripVerticalIcon size={iconSize} /> : <GripHorizontalIcon size={iconSize} />}
    </div>
  );
}
