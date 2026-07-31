// svg-shape-targets.ts — pure helper for SvgShapeTool's Fill/Stroke fan-out.
//
// Lives in its own file so SvgShapeTool.tsx keeps a single default (component)
// export — React Fast Refresh disables HMR for a file that co-exports a
// component and a plain value.

import type { CanvasNode } from '@/code/parsing/parser';

export interface ShapeAttrTarget {
  nodeId: string;
  shapeNode: CanvasNode | null;
  childIndex: number;
}

/**
 * Enumerate every SVG shape a Fill/Stroke write should hit.
 *
 *   - Single-select → just the primary (with its selectedPoint childIndex).
 *   - Multi-select → EVERY selected `<svg>` node, each targeting its OWN inner
 *     shape child at index 0.
 *
 * Fixes "multi-select Fill only updated the last shape" (live find 2026-07-24) —
 * the inner-shape attr writer used to target one nodeId, ignoring the selection.
 *
 * `resolveShapeChild` injects `findSvgShapeChild` so this stays pure/testable.
 */
export function resolveShapeAttrTargets(
  selectedIds: string[],
  primary: { nodeId: string | null; shapeNode: CanvasNode | null; childIndex: number },
  nodes: Map<string, CanvasNode>,
  resolveShapeChild: (svg: CanvasNode, nodes: Map<string, CanvasNode>, idx: number) => CanvasNode | null,
): ShapeAttrTarget[] {
  if (selectedIds.length <= 1) {
    return primary.nodeId
      ? [{ nodeId: primary.nodeId, shapeNode: primary.shapeNode, childIndex: primary.childIndex }]
      : [];
  }
  return selectedIds
    .map((id) => nodes.get(id))
    .filter((n): n is CanvasNode => !!n && n.type === 'svg')
    .map((n) => ({ nodeId: n.id, shapeNode: resolveShapeChild(n, nodes, 0), childIndex: 0 }));
}
