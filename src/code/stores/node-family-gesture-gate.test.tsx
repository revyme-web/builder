import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// `updateNodeInCache` bumps `nodeStylesVersionAtom` on every committed style
// write — every frame during a drag or resize. `useLiveNode` feeds
// ControlProvider, whose context value is a fresh object per render, so ONE
// bump rebuilds the whole tool stack. On the user's 2026-08-04 recording that
// was 84 panel renders inside a 61ms window, and because the canvas iframe is
// same-origin the drag's own `reparentLive` message queued behind all of it:
// the entered element froze for four frames, then lurched. The gate below keeps
// the panel off the per-frame path while a gesture is live and resyncs it once
// the gesture ends.
describe('useLiveNode — gesture gate', () => {
  const PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="a" data-name="A" style={{ position: 'absolute', left: '10px' }}></div>
    </div>
  );
}`;

  async function setup() {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom, nodesAtom, updateNodeInCache } = await import('./store');
    const { useLiveNode } = await import('./node-family');
    const { dragStateOps } = await import('@/canvas/drag/drag-state-store');
    const store = getDefaultStore();
    store.set(codeAtom, PAGE);
    store.get(nodesAtom); // populate the imperative cache

    let renders = 0;
    let lastLeft: string | undefined;
    function Probe() {
      renders++;
      lastLeft = useLiveNode('a')?.styles.left;
      return null;
    }
    render(<Probe />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return {
      dragStateOps,
      updateNodeInCache,
      /** One commit per act() — the real drag writes one per frame in its own
       *  task, so batching them into a single act would hide the flood. */
      async frames(n: number, from = 20) {
        for (let i = 0; i < n; i++) {
          await act(async () => { updateNodeInCache('a', { left: `${from + i}px` }); });
        }
      },
      renders: () => renders,
      left: () => lastLeft,
    };
  }

  beforeEach(async () => {
    const { dragStateOps } = await import('@/canvas/drag/drag-state-store');
    dragStateOps.set(false);
  });

  it('re-renders on every style commit when NO gesture is in flight', async () => {
    const h = await setup();
    const before = h.renders();

    await act(async () => { h.updateNodeInCache('a', { left: '11px' }); });
    await act(async () => { h.updateNodeInCache('a', { left: '12px' }); });
    await act(async () => { h.updateNodeInCache('a', { left: '13px' }); });

    expect(h.renders()).toBeGreaterThan(before);
    expect(h.left()).toBe('13px');
  });

  it('does NOT re-render per frame while a gesture is live', async () => {
    const h = await setup();

    await act(async () => { h.dragStateOps.set(true); });
    const atGestureStart = h.renders();

    // 20 frames of drag writes — the shape that produced the 84-render window.
    await h.frames(20);

    expect(h.renders()).toBe(atGestureStart);
  });

  it('resyncs on gesture end at a cost that does NOT scale with frame count', async () => {
    // The property that matters: a 200-frame drag must cost the panel the same
    // as a 20-frame one. (The end-of-gesture wake is a few renders — the
    // useSyncExternalStore fire plus jotai re-subscribing as the styles signal
    // swaps back — but it is O(1), which is the whole point.)
    async function gestureOf(frames: number) {
      const h = await setup();
      await act(async () => { h.dragStateOps.set(true); });
      await h.frames(frames);
      const duringGesture = h.renders();
      await act(async () => { h.dragStateOps.set(false); });
      return { wake: h.renders() - duringGesture, left: h.left() };
    }

    const short = await gestureOf(20);
    const long = await gestureOf(200);

    expect(long.wake).toBe(short.wake);
    // …and the wake carries the value the drag committed — the "panel is
    // correct the frame the drop lands" contract this hook exists for.
    expect(short.left).toBe('39px');
    expect(long.left).toBe('219px');
  });

  it('goes back to live updates after the gesture', async () => {
    const h = await setup();
    await act(async () => { h.dragStateOps.set(true); });
    await act(async () => { h.updateNodeInCache('a', { left: '99px' }); });
    await act(async () => { h.dragStateOps.set(false); });
    const afterGesture = h.renders();

    await act(async () => { h.updateNodeInCache('a', { left: '123px' }); });

    expect(h.renders()).toBeGreaterThan(afterGesture);
    expect(h.left()).toBe('123px');
  });
});
