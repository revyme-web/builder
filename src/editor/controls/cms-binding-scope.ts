// cms-binding-scope.ts — which nodes may bind to a CMS field via the .map()
// item variable.
//
// This is a SCOPE question, not an ancestry one. `item` is the callback
// parameter of `collection.map((item, idx) => …)`, so only nodes emitted
// INSIDE that callback can reference it. Binding anywhere else writes
// `item.field` into a position where `item` does not exist — a ReferenceError
// at render, not a cosmetic mistake.

import type { CanvasNode } from '@/code/parsing/parser';

export interface CmsListScope {
  /** Collection slug — the `.map()` source. */
  slug: string;
  /** The callback parameter name (`item`, `post`, …). */
  itemVar: string;
}

/**
 * The collection whose `item` is in scope for `node`, or null.
 *
 * Two conditions, both required:
 *
 *  1. `node.isCollectionTemplate` — the parser sets this on every node visited
 *     while inside a `.map()` callback, pushing the context BEFORE walking the
 *     callback body. So it covers the row-template root and its whole subtree
 *     at any depth, which is exactly the set of positions where `item` resolves.
 *
 *  2. An ancestor actually carries the `collectionList`, giving us the slug and
 *     the parameter name.
 *
 * Condition 1 is the one that was missing. A component instance dropped into
 * the collection-list CONTAINER — a sibling of the `.map()` expression, not a
 * descendant of the row — satisfied the ancestor walk on its first hop and was
 * offered the full binding surface (reported 2026-08-24).
 *
 * `__inline:` sources are skipped: those are literal arrays, not CMS
 * collections, and have no schema to bind against.
 */
export function findCmsListScope(
  node: CanvasNode | null | undefined,
  nodes: Map<string, CanvasNode>,
): CmsListScope | null {
  if (!node?.isCollectionTemplate) return null;
  let cursor: CanvasNode | undefined = node;
  while (cursor) {
    if (cursor.collectionList && !cursor.collectionList.source.startsWith('__inline:')) {
      return { slug: cursor.collectionList.source, itemVar: cursor.collectionList.itemVar };
    }
    cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
  }
  return null;
}
