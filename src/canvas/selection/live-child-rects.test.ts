// live-child-rects.test.ts — geometry arbitration for GapHandles during a
// gesture it doesn't own.
//
// Reported: drag the PADDING handle, release, and the gap handles appear at
// their old spot and correct ~0.3s later. Two compounding facts —
// `SelectionOverlay` UNMOUNTS the handles for the whole interaction (they mount
// fresh on pointer-up), and the sandbox suppressed subtree rect refreshes for
// that same window (`sandbox:subtree-refresh`: ZERO across the drag), so the
// cached CHILD rects at mount are pre-drag. PaddingHandles survives the identical
// remount because it reads only the container's own rect + computed padding
// (user report 2026-07-26).

import { describe, it, expect } from 'vitest';
import { withLiveRects, liveChildRectsSupported, type IdRect } from './live-child-rects';

const r = (left: number, top: number, w = 100, h = 40) => new DOMRect(left, top, w, h);

describe('withLiveRects', () => {
  const cached: IdRect[] = [{ id: 'a', rect: r(0, 100) }, { id: 'b', rect: r(0, 200) }];

  it('swaps in live geometry while held', () => {
    const live = new Map([['a', r(0, 138)], ['b', r(0, 238)]]);
    expect(withLiveRects(cached, live)).toEqual([
      { id: 'a', rect: r(0, 138) },
      { id: 'b', rect: r(0, 238) },
    ]);
  });

  it('falls back to the cache when not holding live rects', () => {
    expect(withLiveRects(cached, null)).toEqual(cached);
    expect(withLiveRects(cached, new Map())).toEqual(cached);
  });

  it('keeps the caller ORDER and id list — filters upstream still decide', () => {
    // The live map is DOM-ordered and holds extra entries; neither may leak into
    // the handle list, or hidden / out-of-flow children would sprout handles.
    const live = new Map([
      ['b', r(0, 238)], ['a', r(0, 138)],
      ['hidden', r(0, 0, 0, 0)], ['abs', r(500, 500)],
    ]);
    expect(withLiveRects(cached, live).map(c => c.id)).toEqual(['a', 'b']);
  });

  it('keeps the cached rect for a child the live read is missing', () => {
    const live = new Map([['a', r(0, 138)]]);
    expect(withLiveRects(cached, live)).toEqual([
      { id: 'a', rect: r(0, 138) },
      { id: 'b', rect: r(0, 200) },
    ]);
  });

  it('does not mutate the caller list', () => {
    const input: IdRect[] = [{ id: 'a', rect: r(0, 100) }];
    withLiveRects(input, new Map([['a', r(0, 999)]]));
    expect(input[0].rect.top).toBe(100);
  });
});

describe('liveChildRectsSupported', () => {
  it('is true for a bridge with the async read (iframe)', () => {
    expect(liveChildRectsSupported({ getChildRectsAsync: () => Promise.resolve([]) })).toBe(true);
  });

  it('is false for the DirectBridge fallback — callers must not suppress forever', () => {
    // Without a live read there is nothing to wait for, so the handles have to
    // paint from the sync cache rather than never appearing at all.
    expect(liveChildRectsSupported({})).toBe(false);
    expect(liveChildRectsSupported(null)).toBe(false);
    expect(liveChildRectsSupported(undefined)).toBe(false);
    expect(liveChildRectsSupported({ getChildRectsAsync: 'nope' as unknown })).toBe(false);
  });
});
