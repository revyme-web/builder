// The eye icon wrote only the clicked row, so hiding four selected frames hid
// one of them (user report 2026-09-21).

import { describe, it, expect } from 'vitest';
import { visibilityToggleTargets } from './rows';

const all = () => true;

describe('visibilityToggleTargets', () => {
  it('applies to the whole selection when the clicked row is part of it', () => {
    expect(visibilityToggleTargets(['a', 'b', 'c', 'd'], 'a', all)).toEqual(['a', 'b', 'c', 'd']);
    expect(visibilityToggleTargets(['a', 'b', 'c', 'd'], 'd', all)).toEqual(['a', 'b', 'c', 'd']);
  });

  // Clicking the eye on an unrelated row must not hide your selection.
  it('acts on one node when the clicked row is OUTSIDE the selection', () => {
    expect(visibilityToggleTargets(['a', 'b'], 'z', all)).toEqual(['z']);
  });

  it('acts on one node for a single selection', () => {
    expect(visibilityToggleTargets(['a'], 'a', all)).toEqual(['a']);
    expect(visibilityToggleTargets([], 'a', all)).toEqual(['a']);
  });

  it('drops ids that are no longer in the tree', () => {
    expect(visibilityToggleTargets(['a', 'gone', 'c'], 'a', (id) => id !== 'gone')).toEqual(['a', 'c']);
  });

  it('falls back to the clicked row if the whole selection is stale', () => {
    expect(visibilityToggleTargets(['x', 'y'], 'x', () => false)).toEqual(['x']);
  });
});
