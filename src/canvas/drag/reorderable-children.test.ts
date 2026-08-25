// Reported 2026-08-24: dragging a canvas node into a replica whose children are
// all hidden THERE showed before/after drop lines instead of a single "inside"
// affordance. `findChildRects` reports what the DOM has, and a `display: none`
// child is still a child — it just measures 0x0.

import { describe, it, expect } from 'vitest';
import { reorderableChildren, hasReorderableChildren } from './reorderable-children';

const child = (id: string, width = 100, height = 40) => ({ id, rect: { width, height } });
const none = new Set<string>();

describe('reorderableChildren', () => {
  it('THE BUG: children hidden on this replica are not reorder anchors', () => {
    // Both children exist in the DOM but are display:none on this viewport.
    const kids = [child('a', 0, 0), child('b', 0, 0)];
    expect(hasReorderableChildren(kids, none)).toBe(false);
  });

  it('the same parent on a viewport that RENDERS them still gets lines', () => {
    expect(hasReorderableChildren([child('a'), child('b')], none)).toBe(true);
  });

  it('one visible child among hidden ones is enough', () => {
    expect(hasReorderableChildren([child('a', 0, 0), child('b')], none)).toBe(true);
  });

  it('a collapsed axis counts as hidden — no before/after against a zero-area box', () => {
    expect(hasReorderableChildren([child('a', 100, 0)], none)).toBe(false);
    expect(hasReorderableChildren([child('a', 0, 40)], none)).toBe(false);
  });

  it('the dragged node is never its own anchor', () => {
    expect(hasReorderableChildren([child('a')], new Set(['a']))).toBe(false);
  });

  it('template chrome stays excluded — that gate predates this one', () => {
    // A templated viewport whose only children are the locked header/footer
    // must read as EMPTY so it offers the {children} slot.
    expect(hasReorderableChildren([child('layout::header'), child('children-slot')], none)).toBe(false);
  });

  it('returns the surviving children, in order', () => {
    const kids = [child('a', 0, 0), child('b'), child('layout::x'), child('c')];
    expect(reorderableChildren(kids, none).map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('an empty parent has nothing to anchor to', () => {
    expect(hasReorderableChildren([], none)).toBe(false);
  });
});
