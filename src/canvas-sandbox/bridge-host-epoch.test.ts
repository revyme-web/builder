// bridge-host-epoch.test.ts — stale-epoch rejection for allRects.
//
// A camera change right before a file switch triggers the OLD file's
// remeasure; its allRects lands AFTER the switch's cache wipe and — because
// the handler clears + wholesale-repopulates — resurrects the previous file's
// geometry under the new file's colliding node ids. Live symptom: the merged
// page's ~14,000px 'mobile-root' rect kept driving the template-entry fit and
// selection overlay no matter which sandbox cache was cleared (user report
// 2026-07-27, three rounds — the in-flight emission was the resurrector).
//
// The host stamps every render with ++renderSeq; the sandbox echoes the epoch
// it measured against; older-epoch allRects are DROPPED.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { PostMessageBridge } from './bridge-host';

const allRectsMsg = (renderSeq: number | undefined, height: number) => ({
  data: {
    __sandbox: true,
    payload: {
      type: 'allRects',
      rects: [{ nodeId: 'root', vpPrefix: 'mobile-', rect: { left: 0, top: 0, width: 375, height } }],
      transform: { x: 0, y: 0, scale: 1 },
      ...(renderSeq !== undefined ? { renderSeq } : {}),
    },
  },
} as MessageEvent);

describe('PostMessageBridge — allRects stale-epoch rejection', () => {
  let bridge: PostMessageBridge;
  beforeEach(() => { bridge = new PostMessageBridge(); });
  afterEach(() => { bridge.destroy(); });

  const handle = (msg: MessageEvent) => (bridge as any).handleMessage(msg);
  const cachedHeight = () =>
    ((bridge as any).rectCache as Map<string, DOMRect>).get('mobile-:root')?.height;

  it('drops an allRects measured against an OLDER render epoch', () => {
    (bridge as any).renderSeq = 5;              // the host has sent render #5
    handle(allRectsMsg(4, 14134));              // old file's in-flight measure
    expect(cachedHeight()).toBeUndefined();     // dropped — cache untouched
    handle(allRectsMsg(5, 810));                // the new render's measure
    expect(cachedHeight()).toBe(810);
  });

  it('a fresh emission REPLACES the cache wholesale (normal path unchanged)', () => {
    (bridge as any).renderSeq = 2;
    handle(allRectsMsg(2, 810));
    expect(cachedHeight()).toBe(810);
    handle(allRectsMsg(2, 812));                // same-epoch remeasure (camera)
    expect(cachedHeight()).toBe(812);
  });

  it('an emission WITHOUT a seq (older sandbox bundle) is accepted', () => {
    (bridge as any).renderSeq = 9;
    handle(allRectsMsg(undefined, 810));
    expect(cachedHeight()).toBe(810);
  });
});
