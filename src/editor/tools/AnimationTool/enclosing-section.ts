// enclosing-section.ts — nearest ANCHORED ancestor of a node: the default
// scroll target when the user picks "Section in View" without choosing a
// section. "Section in View" should mean MY section out of the box; writing
// an empty sectionId generates a self-targeted scrub instead (and, before
// the JSX-aware ref-attach fix in generator-motion-scroll, an unattached
// ref the oracle blocked — "can't switch to Section in View", 2026-08-07).

import { getNodesSnapshot } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

/** Anchor id (html `id` attribute) of the node's nearest ancestor carrying
 *  one, or '' when no ancestor is anchored. Starts at the PARENT — the
 *  node's own anchor would make the section target itself. */
export function findEnclosingAnchorId(nodeId: string): string {
  const nodes = getNodesSnapshot();
  let cur = nodes.get(nodeId)?.parentId ?? null;
  let hops = 0;
  while (cur && hops++ < 100) {
    const n = nodes.get(cur);
    if (!n) break;
    const anchor = (n as any).attrs?.id;
    if (anchor) {
      trace.fn('scroll:enclosing-anchor', { nodeId, ancestor: cur, anchor });
      return String(anchor);
    }
    cur = n.parentId;
  }
  return '';
}
