// LayerDropHighlight.tsx — solid outline (+ subtle fill) on the canvas node that
// a LAYERS-PANEL drag is about to drop INSIDE. Driven by `layerDropTargetAtom`
// (set by LayersPanel while the tree drop indicator shows position:'inside'), so
// the user sees on the canvas WHICH container will receive the dropped layer —
// synced to whichever row the cursor is over in the tree.
//
// Rect-based (findNodeRect → cornersFromRect) rather than the cornersCache: the
// rect cache is refreshed every Renderer cycle for every node, so the target
// resolves even though it isn't the canvas-hovered element. Renders as a sibling
// of SelectionOverlay (stable JSX slot) so it's independent of that component's
// many conditional early returns.

import { useAtomValue } from 'jotai';
import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { layerDropTargetAtom } from '@/code/stores/store';
import { SELECTION_COLOR } from '@/shared/constants';
import { findNodeRect } from '@/canvas/node-ops';
import { cornersFromRect, cornersEqual, type ScreenCorners } from '@/canvas/resize/geometry-utils';

export default function LayerDropHighlight() {
  const target = useAtomValue(layerDropTargetAtom);
  const nodeId = target?.nodeId ?? null;
  const vpId = target?.vpId ?? '';

  const corners = usePolledValue<ScreenCorners>(
    !!nodeId,
    (prev) => {
      if (!nodeId) return null;
      const rect = findNodeRect(nodeId, vpId);
      if (!rect) return prev; // keep last good box on a transient cache miss
      const next = cornersFromRect(rect);
      return cornersEqual(prev, next) ? prev : next;
    },
    [nodeId, vpId],
    { immediate: true },
  );

  if (!nodeId || !corners) return null;
  const { TL, TR, BR, BL } = corners;

  return (
    <svg
      style={{
        position: 'fixed',
        left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 2,
      }}
    >
      <path
        d={`M ${TL.x} ${TL.y} L ${TR.x} ${TR.y} L ${BR.x} ${BR.y} L ${BL.x} ${BL.y} Z`}
        fill={SELECTION_COLOR}
        fillOpacity={0.1}
        stroke={SELECTION_COLOR}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
