// The sequence a layers-panel drop renumbers MUST be the sequence the tree
// shows, or "drop before this row" means two different things on the two sides.
// `sortChildrenByVisualOrder` is the single source of that sequence — the tree
// renders from it and (since the hidden-sibling fix) the drop commit orders
// from it too. These tests pin the properties the drop path depends on.

import { describe, test, expect } from 'vitest';
import { sortChildrenByVisualOrder } from './rows';
import type { CanvasNode } from '@/code/parsing/parser';

const VPS = [
  { id: 'desktop', width: 1280, isPrimary: true },
  { id: 'tablet', width: 768, isPrimary: false },
];

function node(id: string, styles: Record<string, string> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, styles, children: [], ...extra } as unknown as CanvasNode;
}

function flexParent(childIds: string[]): CanvasNode {
  return node('parent', { display: 'flex' }, { children: childIds });
}

const sort = (
  parent: CanvasNode,
  nodes: Map<string, CanvasNode>,
  vpId: string | null = 'desktop',
  isComp = false,
) => sortChildrenByVisualOrder(parent, parent.children, vpId, nodes, VPS, new Map(), isComp);

describe('sortChildrenByVisualOrder', () => {
  test('orders flex children by their explicit order, not JSX order', () => {
    const parent = flexParent(['a', 'b', 'c']);
    const nodes = new Map([
      ['a', node('a', { order: '2' })],
      ['b', node('b', { order: '0' })],
      ['c', node('c', { order: '1' })],
    ]);
    expect(sort(parent, nodes)).toEqual(['b', 'c', 'a']);
  });

  test('leaves a non-flex parent alone', () => {
    const parent = node('parent', { display: 'block' }, { children: ['a', 'b'] });
    const nodes = new Map([['a', node('a', { order: '5' })], ['b', node('b', { order: '1' })]]);
    expect(sort(parent, nodes)).toEqual(['a', 'b']);
  });

  test('keeps JSX order when no child declares one', () => {
    const parent = flexParent(['a', 'b', 'c']);
    const nodes = new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]]);
    expect(sort(parent, nodes)).toEqual(['a', 'b', 'c']);
  });

  test('ties break on JSX index, so the sequence is stable', () => {
    const parent = flexParent(['a', 'b']);
    const nodes = new Map([['a', node('a', { order: '1' })], ['b', node('b', { order: '1' })]]);
    expect(sort(parent, nodes)).toEqual(['a', 'b']);
  });

  // THE REPORTED BUG. A child hidden for this variant still occupies a slot in
  // the authored order. The drop path used to derive the sequence from RECTS,
  // where a hidden child is a 0x0 box at the parent's origin and therefore
  // sorts FIRST — stealing slot 0 and shifting every visible sibling down one.
  // Ordering by effective `order` puts it back where it was authored.
  test('a hidden child keeps its authored slot instead of sorting first', () => {
    const parent = flexParent(['visibleA', 'hidden', 'visibleB']);
    const nodes = new Map([
      ['visibleA', node('visibleA', { order: '0' })],
      ['hidden', node('hidden', { order: '1', display: 'none' })],
      ['visibleB', node('visibleB', { order: '2' })],
    ]);
    expect(sort(parent, nodes)).toEqual(['visibleA', 'hidden', 'visibleB']);
  });

  // On a component master the order frequently lives in the `default` variant
  // object, which framer-motion applies over the base style prop. The tree has
  // always read it; the drop commit now writes it.
  test('a default-variant order beats the base style prop', () => {
    const parent = flexParent(['logo', 'chat']);
    const nodes = new Map([
      // Base says chat is first; the default variant says the opposite, and the
      // variant is what actually renders.
      ['logo', node('logo', { order: '2' }, { motionVariants: { default: { order: '1' } } })],
      ['chat', node('chat', { order: '0' }, { motionVariants: { default: { order: '2' } } })],
    ]);
    expect(sort(parent, nodes, 'desktop', true)).toEqual(['logo', 'chat']);
  });

  test('a non-default variant tile reads that variant’s own order', () => {
    const parent = flexParent(['a', 'b']);
    const nodes = new Map([
      ['a', node('a', { order: '0' }, { motionVariants: { tablet: { order: '5' } } })],
      ['b', node('b', { order: '1' })],
    ]);
    expect(sort(parent, nodes, 'tablet', true)).toEqual(['b', 'a']);
  });

  test('a single child is returned untouched', () => {
    const parent = flexParent(['only']);
    expect(sort(parent, new Map([['only', node('only', { order: '9' })]]))).toEqual(['only']);
  });

  test('a missing child node does not throw or drop the id', () => {
    const parent = flexParent(['a', 'ghost']);
    const nodes = new Map([['a', node('a', { order: '1' })]]);
    expect(sort(parent, nodes).sort()).toEqual(['a', 'ghost']);
  });
});

// B18 — a frame that is flex only on a BAND. The sort read the parent's BASE
// `display`, so on the tile where the frame IS flex it bailed to JSX order,
// while the drag path's `isOrderedLayout` resolved display properly and ran the
// commit regardless. The two disagreeing flattened a hand-built arrangement
// into source order in a single drag.
describe('sortChildrenByVisualOrder — display resolved per band', () => {
  const VPS = [
    { id: 'desktop', width: 1440, isPrimary: true },
    { id: 'mobile', width: 450, isPrimary: false },
  ];
  const mk = (id: string, styles: Record<string, string>, children: string[] = []) =>
    ({ id, type: 'div', name: 'Frame', parentId: null, children, styles, attrs: {}, textContent: '' } as unknown as CanvasNode);

  /** Parent: display:none at base, flex via the mobile @container override. */
  const build = () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('a', mk('a', { order: '1' }));
    nodes.set('b', mk('b', { order: '0' }));
    const parent = mk('p', { display: 'none' }, ['a', 'b']);
    nodes.set('p', parent);
    const overrides = new Map([['p', new Map([[450, new Map([['display', 'flex']])]])]]);
    return { parent, nodes, overrides };
  };

  test('sorts by order on the viewport where the parent IS flex', () => {
    const { parent, nodes, overrides } = build();
    expect(sortChildrenByVisualOrder(parent, ['a', 'b'], 'mobile', nodes, VPS, overrides, false))
      .toEqual(['b', 'a']);   // order 0 before order 1
  });

  test('still bails to JSX order where the parent really is not a layout', () => {
    const { parent, nodes } = build();
    const none = new Map<string, Map<number, Map<string, string>>>();
    expect(sortChildrenByVisualOrder(parent, ['a', 'b'], 'desktop', nodes, VPS, none, false))
      .toEqual(['a', 'b']);
  });
});
