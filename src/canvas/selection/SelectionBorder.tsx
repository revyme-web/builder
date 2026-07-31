// SelectionBorder.tsx — 4 separate edge lines around the selected element.
// Each edge is a thin line. Positioned at screen-space corners.

import { SELECTION_COLOR } from '@/shared/constants';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';

interface Props {
  corners: ScreenCorners;
  rotation: number;
  color?: string;
}

const BORDER_WIDTH = 1.5;

export default function SelectionBorder({ corners, rotation, color = SELECTION_COLOR }: Props) {
  const edges: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [
    { from: corners.TL, to: corners.TR },
    { from: corners.TR, to: corners.BR },
    { from: corners.BR, to: corners.BL },
    { from: corners.BL, to: corners.TL },
  ];

  return (
    <svg
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 1,
      }}
    >
      {edges.map((edge, i) => (
        <line
          key={i}
          x1={edge.from.x} y1={edge.from.y}
          x2={edge.to.x} y2={edge.to.y}
          stroke={color}
          strokeWidth={BORDER_WIDTH}
        />
      ))}
    </svg>
  );
}
