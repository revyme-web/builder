// A frame hidden at base and laid out only on a band: reordering its children
// from the Desktop tile queued a bare JSX reorder, because the layout is read on
// the DROP viewport where the parent computes to `display: none`. The children
// kept their `order: 0` / `order: 1`, so the source and the layers panel moved
// while the mobile tile — where the parent IS flex — did not (user report
// 2026-09-21).

import { describe, it, expect } from 'vitest';
import { siblingsCarryExplicitOrder } from './drag';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (id: string, styles: Record<string, string>, children: string[] = []): CanvasNode =>
  ({ id, type: 'div', name: 'Frame', parentId: null, children, styles, attrs: {}, textContent: '' } as unknown as CanvasNode);

/** The reported shape: parent display:none at base, children carrying order. */
const tree = (childStyles: Record<string, string>[]) => {
  const ids = childStyles.map((_, i) => `child-${i}`);
  const m = new Map<string, CanvasNode>();
  m.set('parent', node('parent', { display: 'none', order: '3' }, ids));
  childStyles.forEach((st, i) => m.set(ids[i], node(ids[i], st)));
  return m;
};

describe('siblingsCarryExplicitOrder', () => {
  it('is true when a child declares order — a JSX move alone would be invisible', () => {
    expect(siblingsCarryExplicitOrder(tree([{ order: '0' }, { order: '1' }]), 'parent')).toBe(true);
  });

  it('is true when only ONE child declares it', () => {
    expect(siblingsCarryExplicitOrder(tree([{}, { order: '2' }]), 'parent')).toBe(true);
  });

  // Here a plain reorder really is enough, so the drop must NOT start
  // renumbering — that would author `order` on a tree that has none.
  it('is false when no child declares order', () => {
    expect(siblingsCarryExplicitOrder(tree([{}, { backgroundColor: 'red' }]), 'parent')).toBe(false);
  });

  it('treats an empty order as absent', () => {
    expect(siblingsCarryExplicitOrder(tree([{ order: '' }, { order: '   ' }]), 'parent')).toBe(false);
  });

  it('accepts order: 0, which is falsy as a string but a real declaration', () => {
    expect(siblingsCarryExplicitOrder(tree([{ order: '0' }]), 'parent')).toBe(true);
  });

  it('is false for a missing or childless parent', () => {
    expect(siblingsCarryExplicitOrder(tree([]), 'parent')).toBe(false);
    expect(siblingsCarryExplicitOrder(tree([{ order: '1' }]), 'nope')).toBe(false);
    expect(siblingsCarryExplicitOrder(tree([{ order: '1' }]), null)).toBe(false);
  });
});
