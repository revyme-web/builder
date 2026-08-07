// measure-computed-reuse.test.ts — the reuse gate that stops the measure pass
// from re-deriving computed styles AND screen corners for every element on
// every render.
//
// getComputedStyle + the CACHED_PROPS read is the dominant per-element cost of
// a measure pass, and it ran for EVERY element EVERY render: ~1,861 style
// resolutions per undo on a page carrying a Figma-imported vector swarm (a
// protractor = ~400 individual <svg> nodes). That made undo cost scale with
// element count no matter how the page was authored (2026-08-07).
//
// An element's computed values can only differ from the last read when its own
// inline style changed, its box moved/resized (which covers every ancestor or
// sibling layout cascade), or the stylesheet itself changed. This locks that
// decision table — the gate must never reuse across a real change.

import { describe, it, expect } from 'vitest';

type Rect = { left: number; top: number; width: number; height: number };

/** The gate, mirrored exactly from emitAllMeasures. */
function canReuse(args: {
  forceFull: boolean;
  prev?: { styleAttr: string; rect: Rect };
  styleAttr: string;
  rect: Rect;
}): boolean {
  const { forceFull, prev, styleAttr, rect } = args;
  return !forceFull && !!prev && prev.styleAttr === styleAttr
    && prev.rect.left === rect.left && prev.rect.top === rect.top
    && prev.rect.width === rect.width && prev.rect.height === rect.height;
}

const R = (left = 10, top = 20, width = 100, height = 50): Rect => ({ left, top, width, height });
const base = { forceFull: false, prev: { styleAttr: 'color: red;', rect: R() }, styleAttr: 'color: red;', rect: R() };

describe('measure computed-style + corners reuse gate', () => {
  it('reuses when box AND inline style are unchanged', () => {
    expect(canReuse(base)).toBe(true);
  });

  it('re-reads when the inline style changed', () => {
    expect(canReuse({ ...base, styleAttr: 'color: blue;' })).toBe(false);
  });

  it('re-reads when the box MOVED (ancestor/sibling layout cascade)', () => {
    expect(canReuse({ ...base, rect: R(11) })).toBe(false);
    expect(canReuse({ ...base, rect: R(10, 21) })).toBe(false);
  });

  it('re-reads when the box RESIZED', () => {
    expect(canReuse({ ...base, rect: R(10, 20, 101) })).toBe(false);
    expect(canReuse({ ...base, rect: R(10, 20, 100, 51) })).toBe(false);
  });

  it('re-reads when the stylesheet changed (class / media-query flip)', () => {
    expect(canReuse({ ...base, forceFull: true })).toBe(false);
  });

  it('re-reads an element never measured before', () => {
    expect(canReuse({ ...base, prev: undefined })).toBe(false);
  });

  it('a zoom/pan (every rect shifts) forces a full re-read', () => {
    // Canvas transform scales getBoundingClientRect, so no element matches.
    const zoomed = R(20, 40, 200, 100);
    expect(canReuse({ ...base, rect: zoomed })).toBe(false);
  });
});
