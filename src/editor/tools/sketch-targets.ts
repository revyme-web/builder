// sketch-targets.ts — which sketch nodes one Brush edit should hit.
//
// Mirrors svg-shape-targets.ts (the SvgShapeTool multi-select fan-out fix,
// 2026-07-24): SketchTool renders for multi-select but its brush writers
// (`applyBrushToSketch*`, variant styleUpdate) targeted the single primary
// `nodeId` — selecting several sketches and changing the Brush Fill recolored
// only one of them (user report 2026-07-29). Own file so SketchTool keeps a
// single default export (Fast Refresh).

import type { CanvasNode } from '@/code/parsing/parser';

/** True when a node is a Sketch wrapper — same detection PropertiesPanel uses
 *  to choose the Brush panel (grouping strips the data-sketch attr but keeps
 *  the name). */
export function isSketchNode(node: CanvasNode | undefined): boolean {
  if (!node) return false;
  return node.attrs?.['data-sketch'] === 'true' || node.name === 'Sketch';
}

/** The sketch ids one brush edit targets. Sketch-EDIT mode (drawing inside
 *  one sketch) pins to that sketch; otherwise every selected sketch node,
 *  falling back to the primary so single-select never regresses. Pure —
 *  unit tested. */
export function resolveSketchTargets(
  editingId: string | null,
  selectedIds: readonly string[],
  primaryId: string | null,
  nodes: ReadonlyMap<string, CanvasNode>,
): string[] {
  if (editingId) return [editingId];
  const out: string[] = [];
  for (const id of selectedIds) {
    if (isSketchNode(nodes.get(id))) out.push(id);
  }
  if (out.length === 0 && primaryId) return [primaryId];
  return out;
}
