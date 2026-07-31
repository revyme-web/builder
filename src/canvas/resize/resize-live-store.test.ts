// resize-live-store.test.ts — Coverage for the live resize-dimension broadcast.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { resizeLiveOps } from './resize-live-store';

afterEach(() => resizeLiveOps.clear());

describe('resizeLiveOps', () => {
  test('starts empty', () => {
    expect(resizeLiveOps.get()).toBeNull();
  });

  test('set publishes the latest dims; get reads them back', () => {
    resizeLiveOps.set({ nodeId: 'a', width: '100%', height: '108vh' });
    expect(resizeLiveOps.get()).toEqual({ nodeId: 'a', width: '100%', height: '108vh' });
    // A later set overwrites (per-frame publish).
    resizeLiveOps.set({ nodeId: 'a', width: '100%', height: '109vh' });
    expect(resizeLiveOps.get()?.height).toBe('109vh');
  });

  test('clear resets to null', () => {
    resizeLiveOps.set({ nodeId: 'a', height: '108vh' });
    resizeLiveOps.clear();
    expect(resizeLiveOps.get()).toBeNull();
  });

  test('clear is a safe no-op when already empty', () => {
    expect(() => resizeLiveOps.clear()).not.toThrow();
    expect(resizeLiveOps.get()).toBeNull();
  });

  // ─── Activity subscription (drives ParentHighlight's resize gate) ─────────
  //
  // `current !== null` doubles as "a handle-resize is in flight". Listeners must
  // fire on TRANSITIONS only — a notification per published frame would
  // re-render every subscriber at 60fps for a boolean that didn't change.

  test('isResizing tracks the gesture', () => {
    expect(resizeLiveOps.isResizing()).toBe(false);
    resizeLiveOps.set({ nodeId: 'a', height: '100px' });
    expect(resizeLiveOps.isResizing()).toBe(true);
    resizeLiveOps.clear();
    expect(resizeLiveOps.isResizing()).toBe(false);
  });

  test('notifies on start and on end, NOT on every frame', () => {
    const fn = vi.fn();
    const unsub = resizeLiveOps.subscribe(fn);
    resizeLiveOps.set({ nodeId: 'a', height: '100px' });   // start → notify
    expect(fn).toHaveBeenCalledTimes(1);
    resizeLiveOps.set({ nodeId: 'a', height: '101px' });   // same gesture → silent
    resizeLiveOps.set({ nodeId: 'a', height: '102px' });
    expect(fn).toHaveBeenCalledTimes(1);
    resizeLiveOps.clear();                                  // end → notify
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
  });

  test('notifies when the resize switches to a DIFFERENT node', () => {
    const fn = vi.fn();
    const unsub = resizeLiveOps.subscribe(fn);
    resizeLiveOps.set({ nodeId: 'a', height: '100px' });
    resizeLiveOps.set({ nodeId: 'b', height: '100px' });
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
  });

  test('a redundant clear does not notify', () => {
    const fn = vi.fn();
    const unsub = resizeLiveOps.subscribe(fn);
    resizeLiveOps.clear();
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  test('unsubscribe stops notifications', () => {
    const fn = vi.fn();
    resizeLiveOps.subscribe(fn)();
    resizeLiveOps.set({ nodeId: 'a', height: '100px' });
    expect(fn).not.toHaveBeenCalled();
  });
});
