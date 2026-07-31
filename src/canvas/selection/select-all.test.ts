import { describe, test, expect } from 'vitest';
import { selectAllPageNodeIds } from './select-all';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (partial: Partial<CanvasNode> & { id: string }): CanvasNode => ({
  type: 'div', parentId: null, children: [], order: 0, styles: {},
  ...partial,
} as CanvasNode);

function toMap(nodes: CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('selectAllPageNodeIds', () => {
  test('selects top-level sections + top-level canvas nodes, never descendants or root', () => {
    const ids = selectAllPageNodeIds(toMap([
      node({ id: 'root', children: ['hero', 'about'] }),
      node({ id: 'hero', parentId: 'root', children: ['hero-title'] }),
      node({ id: 'about', parentId: 'root' }),
      node({ id: 'hero-title', parentId: 'hero' }),          // descendant — parent covers it
      node({ id: 'float-1', isCanvasNode: true }),            // floating canvas frame
      node({ id: 'float-1-child', parentId: 'float-1' }),     // inside a canvas node
    ]));
    expect(ids.sort()).toEqual(['about', 'float-1', 'hero']);
  });

  test('excludes template chrome, ghosts, and overlay portals', () => {
    const ids = selectAllPageNodeIds(toMap([
      node({ id: 'root', children: [] }),
      node({ id: 'hero', parentId: 'root' }),
      node({ id: 'layout::header', parentId: 'root' }),        // template chrome
      node({ id: 'layout::footer', parentId: 'root' }),
      node({ id: 'children-slot', parentId: 'root' }),         // template placeholder
      node({ id: 'card__1', parentId: 'root' }),               // CMS ghost copy
      node({ id: 'overlay-frame-1', parentId: 'root', attrs: { 'data-overlay': 'true' } }),
    ]));
    expect(ids).toEqual(['hero']);
  });

  test('empty page returns empty array', () => {
    expect(selectAllPageNodeIds(toMap([node({ id: 'root' })]))).toEqual([]);
  });
});
