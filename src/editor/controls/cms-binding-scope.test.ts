import { describe, it, expect } from 'vitest';
import { findCmsListScope } from './cms-binding-scope';
import type { CanvasNode } from '@/code/parsing/parser';

/** Minimal node — only the fields the scope walk reads. */
function n(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type: 'div', name: id, children: [], styles: {}, ...extra } as CanvasNode;
}

/**
 * The shape from the report:
 *
 *   <div "Case studies" collectionList={collection-1}>   ← container
 *     {collection1.map((item) => <Link "row"> … </Link>)} ← row template
 *     <QiXiWe />                                          ← SIBLING of the map
 *   </div>
 */
function tree() {
  const container = n('container', {
    collectionList: { source: 'collection-1', itemVar: 'item', templateIds: {} } as CanvasNode['collectionList'],
  });
  const row = n('row', { parentId: 'container', isCollectionTemplate: true });
  const rowChild = n('rowChild', { parentId: 'row', isCollectionTemplate: true });
  const rowDeep = n('rowDeep', { parentId: 'rowChild', isCollectionTemplate: true });
  // The component instance: inside the CONTAINER, outside the map callback.
  const sibling = n('sibling', { parentId: 'container' });
  const nodes = new Map<string, CanvasNode>(
    [container, row, rowChild, rowDeep, sibling].map((x) => [x.id, x]),
  );
  return { nodes, container, row, rowChild, rowDeep, sibling };
}

describe('findCmsListScope', () => {
  it('the row-template ROOT is in scope', () => {
    const { nodes, row } = tree();
    expect(findCmsListScope(row, nodes)).toEqual({ slug: 'collection-1', itemVar: 'item' });
  });

  it('descendants of the row are in scope at ANY depth', () => {
    const { nodes, rowChild, rowDeep } = tree();
    expect(findCmsListScope(rowChild, nodes)).toEqual({ slug: 'collection-1', itemVar: 'item' });
    expect(findCmsListScope(rowDeep, nodes)).toEqual({ slug: 'collection-1', itemVar: 'item' });
  });

  it('REGRESSION: a sibling of the .map() is NOT in scope', () => {
    // It is a direct child of the collection-list container, so the old
    // ancestor-only walk matched on the first hop and offered binding. Writing
    // `item.field` there is a ReferenceError — `item` only exists inside the
    // callback.
    const { nodes, sibling } = tree();
    expect(findCmsListScope(sibling, nodes)).toBeNull();
  });

  it('the collection-list CONTAINER itself is not in scope', () => {
    const { nodes, container } = tree();
    expect(findCmsListScope(container, nodes)).toBeNull();
  });

  it('an inline (non-CMS) source never binds — no schema to bind against', () => {
    const container = n('c', {
      collectionList: { source: '__inline:rows', itemVar: 'item', templateIds: {} } as CanvasNode['collectionList'],
    });
    const row = n('r', { parentId: 'c', isCollectionTemplate: true });
    const nodes = new Map([[container.id, container], [row.id, row]]);
    expect(findCmsListScope(row, nodes)).toBeNull();
  });

  it('carries the collection\'s own item variable name, not a hardcoded "item"', () => {
    const container = n('c', {
      collectionList: { source: 'posts', itemVar: 'post', templateIds: {} } as CanvasNode['collectionList'],
    });
    const row = n('r', { parentId: 'c', isCollectionTemplate: true });
    const nodes = new Map([[container.id, container], [row.id, row]]);
    expect(findCmsListScope(row, nodes)).toEqual({ slug: 'posts', itemVar: 'post' });
  });

  it('a template-flagged node with no collection ancestor yields null', () => {
    const orphan = n('o', { isCollectionTemplate: true });
    expect(findCmsListScope(orphan, new Map([[orphan.id, orphan]]))).toBeNull();
  });

  it('null / undefined nodes are safe', () => {
    expect(findCmsListScope(null, new Map())).toBeNull();
    expect(findCmsListScope(undefined, new Map())).toBeNull();
  });

  it('NESTED lists resolve to the INNERMOST collection', () => {
    // Outer list of categories, inner list of posts — a node inside the inner
    // row must bind against `post`, not the outer `cat`.
    const outer = n('outer', {
      collectionList: { source: 'cats', itemVar: 'cat', templateIds: {} } as CanvasNode['collectionList'],
    });
    const outerRow = n('outerRow', { parentId: 'outer', isCollectionTemplate: true });
    const inner = n('inner', {
      parentId: 'outerRow',
      isCollectionTemplate: true,
      collectionList: { source: 'posts', itemVar: 'post', templateIds: {} } as CanvasNode['collectionList'],
    });
    const innerRow = n('innerRow', { parentId: 'inner', isCollectionTemplate: true });
    const nodes = new Map([outer, outerRow, inner, innerRow].map((x) => [x.id, x]));
    expect(findCmsListScope(innerRow, nodes)).toEqual({ slug: 'posts', itemVar: 'post' });
    expect(findCmsListScope(outerRow, nodes)).toEqual({ slug: 'cats', itemVar: 'cat' });
  });
});
