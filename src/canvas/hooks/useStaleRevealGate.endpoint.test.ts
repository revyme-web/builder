// endpointIsFresh — the stale reveal gate's per-endpoint verdict.
// The culled case: an offscreen slot-connected canvas node stays culled
// forever; its projected cache entry is authoritative and must count as
// fresh (arrows were hidden until the 6s cap, re-armed by every pan).
import { describe, it, expect } from 'vitest';
import { endpointIsFresh } from './useStaleRevealGate';

const r = (x: number, y: number, w = 100, h = 50) => new DOMRect(x, y, w, h);

describe('endpointIsFresh', () => {
  it('both missing → fresh (nothing to draw)', () => {
    expect(endpointIsFresh(null, null, false)).toBe(true);
  });
  it('CULLED with cached rect → fresh (projected cache is the truth)', () => {
    expect(endpointIsFresh(r(10, 10), null, true)).toBe(true);
  });
  it('live missing, NOT culled → stale (element not measured yet)', () => {
    expect(endpointIsFresh(r(10, 10), null, false)).toBe(false);
  });
  it('cached missing but live exists → stale (cache not caught up)', () => {
    expect(endpointIsFresh(null, r(10, 10), false)).toBe(false);
  });
  it('agreeing rects → fresh; drifted rects → stale', () => {
    expect(endpointIsFresh(r(10, 10), r(11, 11), false)).toBe(true);
    expect(endpointIsFresh(r(10, 10), r(40, 10), false)).toBe(false);
  });
});
