// RotateHandle.tsx — Invisible rotation hit areas outside the 4 corners.
// Like Figma/the reference: hover just outside a corner → cursor changes to rotate.
// Hit zones follow the element's rotation (placed along outward edge bisectors).

import type { ScreenCorners } from '@/canvas/resize/geometry-utils';
import type { Point } from '@/shared/types';
import { getRotateCursor } from '@/canvas/resize/cursor-utils';

interface Props {
  corners: ScreenCorners;
  rotation: number;
  onRotateStart: (e: React.PointerEvent, corner: string) => void;
}

// Kept deliberately tight so the rotate zone hugs the corner and doesn't
// reach far enough to steal clicks meant for an adjacent node. The zone
// spans OFFSET..(OFFSET + HIT_SIZE) px outward from the corner point —
// here 5..17 px. OFFSET clears the 8 px (±4 px) resize handle.
const HIT_SIZE = 12; // px — invisible hit area outside each corner
const OFFSET = 5;    // px — gap between corner handle and rotate zone

/** Get the outward direction at a corner (bisector of the two edges meeting at that corner) */
function getOutwardOffset(corner: Point, adj1: Point, adj2: Point): { dx: number; dy: number } {
  // Vector from corner to each adjacent corner (inward along edges)
  const v1x = adj1.x - corner.x;
  const v1y = adj1.y - corner.y;
  const v2x = adj2.x - corner.x;
  const v2y = adj2.y - corner.y;

  // Normalize
  const len1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
  const len2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
  const n1x = v1x / len1, n1y = v1y / len1;
  const n2x = v2x / len2, n2y = v2y / len2;

  // Bisector of the two inward edges (points inward)
  let bx = n1x + n2x;
  let by = n1y + n2y;
  const blen = Math.sqrt(bx * bx + by * by) || 1;
  bx /= blen;
  by /= blen;

  // Outward = opposite of inward bisector
  return { dx: -bx, dy: -by };
}

export default function RotateHandle({ corners, rotation, onRotateStart }: Props) {
  const { TL, TR, BR, BL } = corners;

  // Calculate outward offset for each corner
  const zones = [
    { corner: 'TL', point: TL, ...getOutwardOffset(TL, TR, BL) },
    { corner: 'TR', point: TR, ...getOutwardOffset(TR, TL, BR) },
    { corner: 'BR', point: BR, ...getOutwardOffset(BR, BL, TR) },
    { corner: 'BL', point: BL, ...getOutwardOffset(BL, TL, BR) },
  ];

  return (
    <>
      {zones.map((zone) => {
        // Position the hit zone outside the corner along the outward direction
        const dist = OFFSET + HIT_SIZE / 2;
        const cx = zone.point.x + zone.dx * dist;
        const cy = zone.point.y + zone.dy * dist;

        return (
          <div
            key={zone.corner}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onRotateStart(e, zone.corner);
            }}
            style={{
              position: 'fixed',
              left: cx - HIT_SIZE / 2,
              top: cy - HIT_SIZE / 2,
              width: HIT_SIZE,
              height: HIT_SIZE,
              pointerEvents: 'all',
              cursor: getRotateCursor(zone.corner, rotation),
              zIndex: 2,
              // backgroundColor: 'rgba(255,0,0,0.15)', // uncomment to debug hit areas
            }}
          />
        );
      })}
    </>
  );
}
