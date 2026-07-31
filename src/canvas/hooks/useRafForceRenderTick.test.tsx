// useRafForceRenderTick.test.tsx — the shared handle-tracking RAF pump.
//
// It now has TWO independent drivers per component: the handle's OWN drag
// (start on pointerdown / stop on pointerup) and a `canvasInteracting` effect
// that keeps the handle tracking while a DIFFERENT handle drags — added because
// GapHandles froze at its pre-drag position during a PADDING drag and snapped to
// the new geometry on commit (user report 2026-07-26). Overlapping starts must
// therefore be safe: `rafRef` only remembers the LAST scheduled frame, so a
// second loop would be un-cancellable by `stop()`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRafForceRenderTick } from './useRafForceRenderTick';

/** Manual RAF clock: `frame()` runs exactly the callbacks queued so far. */
let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter(f => f.id !== id);
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

function frame() {
  const due = queue;
  queue = [];
  act(() => { for (const f of due) f.cb(performance.now()); });
}

/** How many loops are alive right now (one queued frame each). */
const pending = () => queue.length;

describe('useRafForceRenderTick', () => {
  it('bumps the tick once per frame while started', () => {
    const { result } = renderHook(() => useRafForceRenderTick());
    expect(result.current.tick).toBe(0);

    act(() => { result.current.start(); });
    frame();
    expect(result.current.tick).toBe(1);
    frame();
    expect(result.current.tick).toBe(2);
  });

  it('stops bumping after stop()', () => {
    const { result } = renderHook(() => useRafForceRenderTick());
    act(() => { result.current.start(); });
    frame();
    const at = result.current.tick;

    act(() => { result.current.stop(); });
    frame();
    frame();
    expect(result.current.tick).toBe(at);
    expect(pending()).toBe(0);
  });

  it('a SECOND start() does not spawn a parallel loop', () => {
    // The regression this guards: two loops, one tick each, and `stop()` can
    // only cancel the frame id it last stored — the orphan keeps re-rendering.
    const { result } = renderHook(() => useRafForceRenderTick());
    act(() => { result.current.start(); });
    act(() => { result.current.start(); });
    expect(pending()).toBe(1);

    frame();
    expect(result.current.tick).toBe(1);   // one bump, not two
    expect(pending()).toBe(1);
  });

  it('ONE stop() ends the pump even after overlapping starts', () => {
    const { result } = renderHook(() => useRafForceRenderTick());
    act(() => { result.current.start(); });   // own drag
    act(() => { result.current.start(); });   // canvasInteracting effect
    frame();
    const at = result.current.tick;

    act(() => { result.current.stop(); });
    frame();
    frame();
    expect(result.current.tick).toBe(at);
    expect(pending()).toBe(0);
  });

  it('restarts cleanly after a stop (next drag)', () => {
    const { result } = renderHook(() => useRafForceRenderTick());
    act(() => { result.current.start(); });
    frame();
    act(() => { result.current.stop(); });

    act(() => { result.current.start(); });
    frame();
    expect(result.current.tick).toBe(2);
    expect(pending()).toBe(1);
  });

  it('cancels the loop on unmount (selection changed mid-drag)', () => {
    const { result, unmount } = renderHook(() => useRafForceRenderTick());
    act(() => { result.current.start(); });
    expect(pending()).toBe(1);
    unmount();
    expect(pending()).toBe(0);
  });
});
