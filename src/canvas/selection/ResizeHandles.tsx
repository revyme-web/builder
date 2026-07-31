// ResizeHandles.tsx — 4 visible handles (circles) + 4 invisible edge hit areas.
// Handles adapt based on which axes are resizable:
//   - Both axes: 4 corner circles (TL, TR, BR, BL)
//   - Only vertical (h disabled): 2 circles at top/bottom edge centers
//   - Only horizontal (v disabled): 2 circles at left/right edge centers
//   - Neither: no circles shown

import { RESIZE_HANDLE_SIZE, SELECTION_COLOR } from '@/shared/constants';
import type { ScreenCorners, Direction } from '@/canvas/resize/geometry-utils';
import { midpoint } from '@/canvas/resize/geometry-utils';
import { getResizeCursor } from '@/canvas/resize/cursor-utils';

interface Props {
  corners: ScreenCorners;
  rotation: number;
  onResizeStart: (direction: Direction, e: React.PointerEvent) => void;
  color?: string;
  /** Disable horizontal (left/right) resize — width is auto/fill/100% */
  disableHorizontal?: boolean;
  /** Disable vertical (top/bottom) resize — height is auto */
  disableVertical?: boolean;
}

export default function ResizeHandles({
  corners, rotation, onResizeStart,
  color = SELECTION_COLOR,
  disableHorizontal = false,
  disableVertical = false,
}: Props) {
  const handleR = RESIZE_HANDLE_SIZE / 2;
  const innerR = handleR * 0.75;

  // Determine which circle handles to show and where
  const circleHandles: { pos: { x: number; y: number }; dir: Direction }[] = [];

  if (!disableHorizontal && !disableVertical) {
    // Both axes resizable → 4 corner circles
    circleHandles.push(
      { pos: corners.TL, dir: 'topLeft' },
      { pos: corners.TR, dir: 'topRight' },
      { pos: corners.BR, dir: 'bottomRight' },
      { pos: corners.BL, dir: 'bottomLeft' },
    );
  } else if (disableHorizontal && !disableVertical) {
    // Only vertical resize → circles at top and bottom edge centers
    circleHandles.push(
      { pos: midpoint(corners.TL, corners.TR), dir: 'top' },
      { pos: midpoint(corners.BL, corners.BR), dir: 'bottom' },
    );
  } else if (!disableHorizontal && disableVertical) {
    // Only horizontal resize → circles at left and right edge centers
    circleHandles.push(
      { pos: midpoint(corners.TL, corners.BL), dir: 'left' },
      { pos: midpoint(corners.TR, corners.BR), dir: 'right' },
    );
  }
  // Both disabled → no circles

  // Edge hit areas — only for enabled axes
  const edgeHandles: { from: { x: number; y: number }; to: { x: number; y: number }; dir: Direction }[] = [];
  if (!disableVertical) {
    edgeHandles.push({ from: corners.TL, to: corners.TR, dir: 'top' });
    edgeHandles.push({ from: corners.BR, to: corners.BL, dir: 'bottom' });
  }
  if (!disableHorizontal) {
    edgeHandles.push({ from: corners.TR, to: corners.BR, dir: 'right' });
    edgeHandles.push({ from: corners.BL, to: corners.TL, dir: 'left' });
  }

  return (
    <>
      {/* Circle handles */}
      {circleHandles.map((h) => (
        <svg
          key={h.dir}
          data-resize-dir={h.dir}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onResizeStart(h.dir, e); }}
          style={{
            position: 'fixed',
            left: h.pos.x - handleR,
            top: h.pos.y - handleR,
            width: RESIZE_HANDLE_SIZE,
            height: RESIZE_HANDLE_SIZE,
            pointerEvents: 'all',
            cursor: getResizeCursor(h.dir, rotation),
            zIndex: 3,
            overflow: 'visible',
          }}
        >
          <circle cx={handleR} cy={handleR} r={handleR} fill={color} />
          <circle cx={handleR} cy={handleR} r={innerR} fill="#fff" />
        </svg>
      ))}

      {/* Edge hit areas — invisible, wider than border for easy grabbing */}
      {edgeHandles.map((edge) => {
        const dx = edge.to.x - edge.from.x;
        const dy = edge.to.y - edge.from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        const mid = midpoint(edge.from, edge.to);
        const hitHeight = 8;

        return (
          <div
            key={`edge-${edge.dir}`}
            data-resize-edge={edge.dir}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onResizeStart(edge.dir, e); }}
            style={{
              position: 'fixed',
              left: mid.x - length / 2,
              top: mid.y - hitHeight / 2,
              width: length,
              height: hitHeight,
              transform: `rotate(${angle}deg)`,
              transformOrigin: 'center center',
              pointerEvents: 'all',
              cursor: getResizeCursor(edge.dir, rotation),
              zIndex: 2,
            }}
          />
        );
      })}
    </>
  );
}
