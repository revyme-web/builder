// select-all.ts — Cmd/Ctrl+A on the canvas: select everything selectable
// on the page.
//
// Scope = every TOP-LEVEL page thing the user can act on:
//   - the primary viewport's sections (parentId === 'root')
//   - top-level canvas nodes (floating frames outside viewports)
//
// Excluded, matching the marquee/delete rules:
//   - template chrome (`layout::` ids + the `children-slot` placeholder) —
//     locked, owned by the template file
//   - CMS/.map() ghost copies (`__N` id suffix)
//   - hidden overlay portals (`data-overlay` nodes live outside the flow;
//     selecting them from a page-level select-all is never what's wanted)
//   - `root` itself (the viewport)
//
// Descendants are NOT included — selecting a parent already covers its
// subtree for every bulk operation (copy, delete, move), and flooding the
// selection with thousands of leaves would make the overlay useless.

import type { CanvasNode } from '@/code/parsing/parser';
import { isGhostNodeId } from '@/shared/ghost-id';

export function selectAllPageNodeIds(nodes: Map<string, CanvasNode>): string[] {
  const ids: string[] = [];
  for (const [id, node] of nodes) {
    if (id === 'root' || id === 'children-slot') continue;
    if (id.startsWith('layout::')) continue;
    if (isGhostNodeId(id)) continue;
    if (node.attrs?.['data-overlay']) continue;

    const isTopLevelSection = node.parentId === 'root';
    const isTopLevelCanvasNode = node.isCanvasNode === true;
    if (isTopLevelSection || isTopLevelCanvasNode) ids.push(id);
  }
  return ids;
}
