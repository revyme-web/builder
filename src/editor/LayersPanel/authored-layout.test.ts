// Dropping into a HIDDEN frame that has a layout stamped the child
// `position: absolute` with pins, and it stayed absolute once the frame was
// unhidden (user report 2026-09-21, B14 second half). `detectParentLayoutById`
// reads the COMPUTED display, and a hidden frame has nothing laid out to
// measure — it reports `none`/`absolute`.
//
// Hiding only swaps `display`; the layout properties stay on the node (that is
// what lets unhide restore the frame intact), so they record what the frame is.

import { describe, it, expect } from 'vitest';
import { authoredLayoutOfParent } from './drag';
import type { CanvasNode } from '@/code/parsing/parser';

const n = (styles: Record<string, string>) =>
  ({ id: 'p', type: 'div', name: 'Frame', parentId: null, children: [], styles, attrs: {}, textContent: '' } as unknown as CanvasNode);

describe('authoredLayoutOfParent', () => {
  it('reads a live display directly', () => {
    expect(authoredLayoutOfParent(n({ display: 'flex' }))).toBe('flex');
    expect(authoredLayoutOfParent(n({ display: 'inline-flex' }))).toBe('flex');
    expect(authoredLayoutOfParent(n({ display: 'grid' }))).toBe('grid');
    expect(authoredLayoutOfParent(n({ display: 'inline-grid' }))).toBe('grid');
  });

  // The reported frame: hidden, but still carrying its column layout.
  it('recovers flex from a HIDDEN frame', () => {
    expect(authoredLayoutOfParent(n({
      position: 'relative', display: 'none',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    }))).toBe('flex');
  });

  it('recovers grid from a hidden frame', () => {
    expect(authoredLayoutOfParent(n({ display: 'none', gridTemplateColumns: '1fr 1fr' }))).toBe('grid');
    expect(authoredLayoutOfParent(n({ display: 'none', gridAutoFlow: 'row' }))).toBe('grid');
  });

  // A real block frame must stay a no-layout destination, where the drop keeps
  // the child absolute and its pins anchor to the frame.
  it('never promotes a visible block frame', () => {
    expect(authoredLayoutOfParent(n({ display: 'block', flexDirection: 'column' }))).toBeNull();
    expect(authoredLayoutOfParent(n({ display: 'block' }))).toBeNull();
  });

  // `gap` / `alignItems` alone are not layout-defining — a block frame can
  // carry them as leftovers.
  it('requires a layout-DEFINING property, not just a layout-ish one', () => {
    expect(authoredLayoutOfParent(n({ display: 'none', gap: '12px' }))).toBeNull();
    expect(authoredLayoutOfParent(n({ display: 'none', alignItems: 'center' }))).toBeNull();
  });

  it('handles an absent display and an empty node', () => {
    expect(authoredLayoutOfParent(n({ flexDirection: 'row' }))).toBe('flex');
    expect(authoredLayoutOfParent(n({}))).toBeNull();
    expect(authoredLayoutOfParent(null)).toBeNull();
    expect(authoredLayoutOfParent(undefined)).toBeNull();
  });
});
