import { describe, it, expect } from 'vitest';
import { computeEdgeAutoScrollDelta, vpIdFromLayerId } from './drag';

// The layers list auto-scrolls when a row drag hovers near its top/bottom edge.
// computeEdgeAutoScrollDelta is the pure core: cursor + container rect → px/frame.
describe('computeEdgeAutoScrollDelta — layers drag edge auto-scroll', () => {
  const rect = { left: 100, right: 400, top: 200, bottom: 800 }; // a tall list column
  const ZONE = 52;
  const MAX = 16;
  const d = (x: number, y: number) => computeEdgeAutoScrollDelta(x, y, rect, ZONE, MAX);

  it('is 0 in the vertical middle', () => {
    expect(d(250, 500)).toBe(0);
  });

  it('scrolls UP (negative) near the top edge, faster the closer to the edge', () => {
    const nearInner = d(250, rect.top + ZONE - 1); // just inside the top band
    const atEdge = d(250, rect.top);               // exactly at the top edge
    expect(nearInner).toBeLessThan(0);
    expect(atEdge).toBe(-MAX);                      // full speed at the edge
    expect(Math.abs(atEdge)).toBeGreaterThan(Math.abs(nearInner)); // ramps up
  });

  it('stays at full up-speed when the cursor is ABOVE the top edge', () => {
    expect(d(250, rect.top - 40)).toBe(-MAX);
  });

  it('scrolls DOWN (positive) near/below the bottom edge', () => {
    expect(d(250, rect.bottom - 1)).toBeGreaterThan(0);
    expect(d(250, rect.bottom)).toBe(MAX);
    expect(d(250, rect.bottom + 40)).toBe(MAX);
  });

  it('does not scroll when the cursor is off the column horizontally', () => {
    // Near the top edge vertically, but far to the right of the panel → 0.
    expect(d(rect.right + 200, rect.top)).toBe(0);
    expect(d(rect.left - 200, rect.top)).toBe(0);
  });

  it('is 0 at/beyond the band boundary and clamps to a ~0.2× minimum just inside it', () => {
    expect(d(250, rect.top + ZONE)).toBe(0);                        // boundary exclusive → no scroll
    expect(d(250, rect.top + ZONE - 1)).toBeCloseTo(-MAX * 0.2, 5); // just inside → minimum speed
  });
});

// Row ids are viewport-prefixed; the drop-target canvas highlight (and select)
// need the prefix to target the right tile (rect cache key = `vpPrefix:nodeId`).
describe('vpIdFromLayerId — viewport prefix of a layer-row id', () => {
  it('splits a normal viewport-prefixed row id', () => {
    expect(vpIdFromLayerId('mobile:hero')).toBe('mobile');
    expect(vpIdFromLayerId('desktop:frame-abc-1')).toBe('desktop');
  });

  it('unwraps a viewport HEADER row id', () => {
    expect(vpIdFromLayerId('__vp_mobile')).toBe('mobile');
    expect(vpIdFromLayerId('__vp_desktop')).toBe('desktop');
  });

  it('handles component-master VARIANT prefixes', () => {
    expect(vpIdFromLayerId('default:root')).toBe('default');
    expect(vpIdFromLayerId('variant-1:card-title')).toBe('variant-1');
  });

  it('takes only the FIRST segment (nodeIds have no colon)', () => {
    expect(vpIdFromLayerId('desktop:a-b-c')).toBe('desktop');
  });
});
