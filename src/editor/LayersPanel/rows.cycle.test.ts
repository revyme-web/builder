// rows.cycle.test.ts — computeSelectionSets must survive a cyclic node map.
//
// A collection-list drag-out corrupted the node cache with a parentId/children
// cycle (2026-07-29); the recursive descendant walk in computeSelectionSets
// blew the stack and crashed the whole LayersPanel. The walk must visit each
// node at most once and still return the acyclic descendants.

import { describe, test, expect, vi } from 'vitest';
import { computeSelectionSets, type FlatLayer } from './rows';
import type { CanvasNode } from '@/code/parsing/parser';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));
// rows.tsx pulls editor chrome (icons, viewer-mode store) that a pure-helper
// test doesn't need — stub the heavy leaf imports.
vi.mock('@/editor/left-toolbar/panels/LibraryPanel/items/IconSetRow', () => ({
  IconSetIcon: () => null,
}));

const bare = (id: string, parentId: string | null, children: string[]): CanvasNode => ({
  id, type: 'div', name: '', parentId, children, styles: {}, textContent: '',
  attrs: {}, hasMixedContent: false, order: 0, isCanvasNode: parentId === null,
  componentFile: null, componentInstanceId: null, isComponentRoot: false,
  motionVariants: null, motionVariantsRef: null, motionProps: null,
  responsiveVariantMap: null, conditionalStyles: null,
} as unknown as CanvasNode);

const layerFor = (node: CanvasNode, depth: number): FlatLayer => ({
  id: `desktop:${node.id}`, nodeId: node.id, node, depth,
  hasChildren: node.children.length > 0, isExpanded: true, viewportId: 'desktop',
});

describe('computeSelectionSets — cycle guard', () => {
  test('cyclic children graph terminates and marks the acyclic descendants', () => {
    // sel → mid → sel (cycle) plus a normal leaf under mid.
    const sel = bare('cyc-sel', null, ['cyc-mid']);
    const mid = bare('cyc-mid', 'cyc-sel', ['cyc-sel', 'cyc-leaf']);
    const leaf = bare('cyc-leaf', 'cyc-mid', []);
    const nodes = new Map<string, CanvasNode>([[sel.id, sel], [mid.id, mid], [leaf.id, leaf]]);
    const layers = [layerFor(sel, 0), layerFor(mid, 1), layerFor(leaf, 2)];

    // Without the seen-set this recursed forever (RangeError: Maximum call stack).
    const { childOfSelectedSet } = computeSelectionSets('desktop:cyc-sel', layers, nodes);

    expect(childOfSelectedSet.has('desktop:cyc-mid')).toBe(true);
    expect(childOfSelectedSet.has('desktop:cyc-leaf')).toBe(true);
    // The cycled-back selected node is never re-added as its own descendant.
    expect(childOfSelectedSet.has('desktop:cyc-sel')).toBe(false);
  });

  test('self-referencing node terminates', () => {
    const selfy = bare('cyc-self', null, ['cyc-self']);
    const nodes = new Map<string, CanvasNode>([[selfy.id, selfy]]);
    const layers = [layerFor(selfy, 0)];

    const { childOfSelectedSet } = computeSelectionSets('desktop:cyc-self', layers, nodes);

    expect(childOfSelectedSet.size).toBe(0);
  });
});
