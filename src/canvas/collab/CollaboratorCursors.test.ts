// CollaboratorCursors.test.ts — the rAF rect poll must be identity-stable:
// setState with a fresh-but-equal DOMRect each frame re-rendered the collab
// overlay 60×/s forever (profiled ~16ms/frame parent-side whenever any canvas
// animation kept frames busy, even with zero remote cursors).

import { describe, it, expect } from 'vitest';
import { sameRect } from './CollaboratorCursors';

describe('sameRect', () => {
  it('equal rects compare true (state identity preserved)', () => {
    expect(sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 4 })).toBe(true);
  });
  it('any differing field compares false', () => {
    const base = { left: 1, top: 2, width: 3, height: 4 };
    expect(sameRect(base, { ...base, left: 9 })).toBe(false);
    expect(sameRect(base, { ...base, top: 9 })).toBe(false);
    expect(sameRect(base, { ...base, width: 9 })).toBe(false);
    expect(sameRect(base, { ...base, height: 9 })).toBe(false);
  });
});
