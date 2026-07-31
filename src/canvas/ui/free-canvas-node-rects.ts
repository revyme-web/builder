// free-canvas-node-rects.ts — Collect screen rects of every FREE canvas
// node on the current canvas plane.
//
// "Free canvas node" = a node that lives outside any viewport, painted
// at canvas-plane level. Two shapes qualify:
//
//   1. Children of the `const canvasNodes = (<>…</>)` fragment.
//   2. Hoisted slot consts (`const cn_<id> = <jsx data-canvas-node="true"/>`)
//      that aren't currently wired into a slot (those with `parentId: null`).
//
// EXCLUDED: nodes carried in by a component instance's expansion
// (`componentInstanceId` set). The Renderer already filters those out of
// the page's canvas plane — see Renderer.ts:500 — so they don't actually
// paint on this canvas, and including them here would shift the placement
// scans by the master's authoring coords (visible symptom: the "+ Variant"
// button drifting far off-screen on a page that hosts a slot-bearing
// component instance).
//
// Shared by AddVariantUI / AddVectorUI so each
// scan-past-siblings polling loop also avoids landing the "+" placeholder
// card on top of a canvas node sitting next to the source variant.

import type { CanvasNode } from '@/code/parsing/parser';
import { findNodeRect } from '@/canvas/node-ops';

export function getFreeCanvasNodeRects(
  nodes: Map<string, CanvasNode>,
  /** vpId of the currently-interacting variant viewport — canvas nodes
   *  are vp-agnostic and live under the primary prefix, but accept this
   *  for symmetry with `findNodeRect` callers that already track vpId.
   *  Unused for now; canvas-nodes always resolve under 'desktop'. */
  _vpId: string,
): DOMRect[] {
  const out: DOMRect[] = [];
  for (const node of nodes.values()) {
    if (!node.isCanvasNode) continue;
    if (node.parentId) continue;
    // Skip canvas-nodes pulled in from a component instance's expansion —
    // they don't paint on this canvas plane (filtered in Renderer).
    if (node.componentInstanceId) continue;
    const rect = findNodeRect(node.id, 'desktop');
    if (rect) out.push(rect);
  }
  return out;
}
