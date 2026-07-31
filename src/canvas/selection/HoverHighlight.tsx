// HoverHighlight.tsx — Transform-aware outline around hovered element.
// Uses bridge helpers (findNodeRect + cornersFromRect) for iframe-compatible rect reads.
// Renders as 4 SVG lines connecting the transformed corners.

import { usePolledValue } from '@/canvas/hooks/usePolledValue';
import { useAtomValue } from 'jotai';
import { SELECTION_COLOR, COMPONENT_COLOR, MAP_TEMPLATE_COLOR } from '@/shared/constants';
import { hoveredViewportIdAtom, hoveredNodeIdAtom, isComponentFileAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { getScreenCornersById, cornersEqual, type ScreenCorners } from '@/canvas/resize/geometry-utils';
import { stripGhostSuffix } from '@/shared/ghost-id';

interface Props {
  nodeId: string;
  color?: string;
}

export default function HoverHighlight({ nodeId, color: colorOverride }: Props) {
  const vpId = useAtomValue(hoveredViewportIdAtom);
  const hoveredNodeId = useAtomValue(hoveredNodeIdAtom);
  const isInsideComponent = useAtomValue(isComponentFileAtom);
  // For .map() ghosts the hovered ID carries a `__N` suffix (so the cache
  // lookup hits the right per-ghost rect), but the node identity in the
  // NodeMap is the template's canonical id. Strip the suffix for nodes.get
  // so isMapNode/isComponentInstance get the real template node, otherwise
  // the color falls back to the default selection color on ghost hover.
  const canonicalId = stripGhostSuffix(nodeId);
  // Per-computation subscription (NOT the whole map): the ancestor walk
  // re-runs per commit but only notifies when these two flags flip — so a
  // drag commit elsewhere on the page no longer re-renders the hover outline.
  const { isComponentInstance, isMapNode } = useNodesComputed((nodes) => {
    const hoveredNode = nodes.get(canonicalId);
    // Detect if hovered node is inside an inline .map() template
    let isMap = false;
    if (hoveredNode) {
      let current = hoveredNode;
      while (current) {
        if (current.isCollectionTemplate) {
          const parent = current.parentId ? nodes.get(current.parentId) : null;
          if (parent?.collectionList?.source?.startsWith('__inline:')) { isMap = true; break; }
        }
        const p = current.parentId ? nodes.get(current.parentId) : undefined;
        if (!p) break;
        current = p;
      }
    }
    return { isComponentInstance: hoveredNode?.componentFile != null, isMapNode: isMap };
  }, [canonicalId]);
  const color = colorOverride ?? (isMapNode ? MAP_TEMPLATE_COLOR : (isInsideComponent || isComponentInstance) ? COMPONENT_COLOR : SELECTION_COLOR);

  const corners = usePolledValue<ScreenCorners>(
    true,
    (prev) => {
      // Use bridge corners cache — accurate for rotated/transformed elements.
      // For .map() ghosts the visual target is the specific ghost copy under
      // the cursor (rect cache key has a `__N` suffix). hoveredNodeId carries
      // that suffix when the cursor is over a ghost; fall back to the
      // canonical nodeId prop otherwise.
      const isGhostOfThisNode = !!hoveredNodeId
        && hoveredNodeId !== nodeId
        && stripGhostSuffix(hoveredNodeId) === canonicalId;
      const lookupId = isGhostOfThisNode ? hoveredNodeId : nodeId;
      const newCorners = getScreenCornersById(lookupId, vpId);
      if (newCorners) {
        return cornersEqual(prev, newCorners) ? prev : newCorners;
      }
      return null;
    },
    [nodeId, vpId, hoveredNodeId, canonicalId],
  );

  if (!corners) return null;

  const { TL, TR, BR, BL } = corners;

  return (
    <svg
      style={{
        position: 'fixed',
        left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 1,
      }}
    >
      <path
        d={`M ${TL.x} ${TL.y} L ${TR.x} ${TR.y} L ${BR.x} ${BR.y} L ${BL.x} ${BL.y} Z`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
