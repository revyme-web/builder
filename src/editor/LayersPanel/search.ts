// LayersPanel/search.ts — the layer-tree search filter, lifted verbatim from the
// `displayLayers` useMemo in LayersPanel.tsx (Phase 7 god-file split, item 7.7).
// See the call site for the filter semantics (matches ∪ ancestors ∪ headers).

import type { CanvasNode } from '@/code/parsing/parser';
import type { FlatLayer } from './rows';

export function filterLayersForSearch(
  layers: FlatLayer[],
  layerSearchActive: boolean,
  layerSearchQuery: string,
  nodes: Map<string, CanvasNode>,
): FlatLayer[] {
    if (!layerSearchActive) return layers;
    const q = layerSearchQuery.trim().toLowerCase();
    const ancestorIds = new Set<string>();
    for (const l of layers) {
      if (!l.nodeId) continue;
      const haystack = `${l.node.name || ''} ${l.node.type || ''}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      ancestorIds.add(l.nodeId);
      // Walk up via parentId in the node map. Stops at the root (no
      // parentId) or the first missing-node entry.
      let pid: string | null | undefined = l.node.parentId;
      while (pid) {
        ancestorIds.add(pid);
        pid = nodes.get(pid)?.parentId ?? null;
      }
    }
    return layers.filter(l => {
      // Keep every viewport / variant header — they're navigation
      // landmarks; hiding them would orphan deep matches in the list.
      if (!l.nodeId) return true;
      return ancestorIds.has(l.nodeId);
    });
}
