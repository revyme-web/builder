// Max-latency mirror (2026-07-23): the old cancel-and-reschedule debounce let
// a burst of sequential writes postpone the stable mirror indefinitely — the
// Pages tree showed a created page ~2s late. A pending timer must keep its
// ORIGINAL deadline and mirror the LATEST values when it fires.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { StableAtomSyncHost, expediteStableAtomSync } from './useStableAtomSync';
import { codeAtom, canvasInteractingAtom } from '@/code/stores/store';
import { projectVersionAtom, stableProjectVersionAtom } from '@/code/project/project-fs';

describe('useStableAtomSync max-latency', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mount = (store: ReturnType<typeof createStore>) =>
    render(<Provider store={store}><StableAtomSyncHost /></Provider>);

  it('a write burst does NOT postpone the deadline — mirror lands once at ~450ms with the LATEST value', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { store.set(projectVersionAtom, 1); store.set(codeAtom, 'v1'); });
    // Burst: new writes every 200ms — under the old debounce this reset the
    // clock forever; under max-latency the original 450ms deadline holds.
    act(() => { vi.advanceTimersByTime(200); store.set(projectVersionAtom, 2); });
    act(() => { vi.advanceTimersByTime(200); store.set(projectVersionAtom, 3); });
    act(() => { vi.advanceTimersByTime(100); }); // t=500ms > 450ms deadline
    expect(store.get(stableProjectVersionAtom)).toBe(3); // latest, not first
  });

  it('drag pause survives: timer firing mid-interaction skips; drag end reschedules', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { store.set(projectVersionAtom, 5); });
    act(() => { store.set(canvasInteractingAtom, true); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(store.get(stableProjectVersionAtom)).toBe(0); // paused
    act(() => { store.set(canvasInteractingAtom, false); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(store.get(stableProjectVersionAtom)).toBe(5); // drag-end resync
  });

  // A panel-originated edit has no canvas paint to protect, so it must not wait
  // out the 450ms budget. Measured 2026-08-23: adding a text effect reparsed in
  // 11ms but the Animation row appeared 572ms later, because the row derives
  // from the MIRRORED code atom and nothing had expedited it.
  it('expedite collapses the delay to 0 for a panel-originated write', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { vi.advanceTimersByTime(500); }); // drain the mount-scheduled mirror
    act(() => { expediteStableAtomSync(); store.set(projectVersionAtom, 7); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(store.get(stableProjectVersionAtom)).toBe(7);
  });

  it('without expedite the same write still waits out the budget', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { store.set(projectVersionAtom, 8); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(store.get(stableProjectVersionAtom)).toBe(0); // still waiting
    act(() => { vi.advanceTimersByTime(500); });
    expect(store.get(stableProjectVersionAtom)).toBe(8);
  });

  // The flag is consumed by the next effect run that has work to mirror — it
  // is a promise about an IMMINENT write, not a global mode.
  it('expedite is ONE-SHOT — it does not speed up the next write too', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { expediteStableAtomSync(); store.set(projectVersionAtom, 1); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(store.get(stableProjectVersionAtom)).toBe(1);
    act(() => { store.set(projectVersionAtom, 2); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(store.get(stableProjectVersionAtom)).toBe(1); // second write waits
    act(() => { vi.advanceTimersByTime(500); });
    expect(store.get(stableProjectVersionAtom)).toBe(2);
  });

  // Regression: an expedite arriving while a mirror is ALREADY pending used to
  // be swallowed by the max-latency early-return — the panel still waited out
  // the old deadline, and the unconsumed flag then expedited the NEXT write.
  it('expedite pulls an already-pending mirror EARLIER instead of being swallowed', () => {
    const store = createStore();
    store.set(canvasInteractingAtom, false);
    mount(store);
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { store.set(projectVersionAtom, 1); });   // schedules a 450ms mirror
    act(() => { vi.advanceTimersByTime(100); });        // 350ms still to run
    act(() => { expediteStableAtomSync(); store.set(projectVersionAtom, 2); });
    act(() => { vi.advanceTimersByTime(0); });
    expect(store.get(stableProjectVersionAtom)).toBe(2); // landed immediately
  });

});
