import { describe, it, expect, afterEach } from 'vitest';
import { viewportBandPinOps, pinnedResolveWidth } from './viewport-band-pin-store';

afterEach(() => viewportBandPinOps.clear());

describe('viewport-band-pin-store', () => {
  it('page nodes on the dragged tile resolve at the START width; chrome resolves live', () => {
    viewportBandPinOps.set('mobile', 429);
    viewportBandPinOps.updateLiveWidth(771);
    // Page node rendering at the live width → pinned to the gesture start.
    expect(pinnedResolveWidth('frame-msfu6slb-1j', 771)).toBe(429);
    // Template chrome adapts live — never pinned.
    expect(pinnedResolveWidth('layout::CePaNu-mshigtbi-1:frame-msftb4p7-8', 771)).toBe(771);
    // Other tiles (rendering at their own widths) are untouched.
    expect(pinnedResolveWidth('frame-msfu6slb-1j', 1440)).toBe(1440);
    expect(pinnedResolveWidth('frame-msfu6slb-1j', 564)).toBe(564);
  });

  it('no-ops entirely outside a gesture', () => {
    expect(pinnedResolveWidth('frame-a', 771)).toBe(771);
    viewportBandPinOps.set('mobile', 429);
    viewportBandPinOps.clear();
    expect(pinnedResolveWidth('frame-a', 429)).toBe(429);
  });

  it('liveWidth updates follow the crossings', () => {
    viewportBandPinOps.set('mobile', 429);
    // Before any crossing, the tile renders at the start width itself.
    expect(pinnedResolveWidth('frame-a', 429)).toBe(429);
    viewportBandPinOps.updateLiveWidth(587);
    expect(pinnedResolveWidth('frame-a', 587)).toBe(429);
    viewportBandPinOps.updateLiveWidth(1053);
    expect(pinnedResolveWidth('frame-a', 1053)).toBe(429);
    expect(pinnedResolveWidth('frame-a', 587)).toBe(587); // stale width no longer matches
  });
});
