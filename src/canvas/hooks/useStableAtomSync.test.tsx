// Max-latency mirror (2026-07-23): the old cancel-and-reschedule debounce let
// a burst of sequential writes postpone the stable mirror indefinitely — the
// Pages tree showed a created page ~2s late. A pending timer must keep its
// ORIGINAL deadline and mirror the LATEST values when it fires.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { StableAtomSyncHost } from './useStableAtomSync';
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
});
