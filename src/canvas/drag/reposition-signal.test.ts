// reposition-signal.test.ts — Tests for the layout-reposition pulse store.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { repositionSignalOps } from './reposition-signal';

describe('repositionSignalOps', () => {
  beforeEach(() => {
    // Drain any latched flag from a previous test (module-level state).
    repositionSignalOps.consume();
    repositionSignalOps.clearCommitPending();
  });

  test('get() returns a number (monotonic counter)', () => {
    expect(typeof repositionSignalOps.get()).toBe('number');
  });

  test('signal() increments the counter on every call (each is a distinct edge)', () => {
    const before = repositionSignalOps.get();
    repositionSignalOps.signal();
    expect(repositionSignalOps.get()).toBe(before + 1);
    repositionSignalOps.signal();
    expect(repositionSignalOps.get()).toBe(before + 2);
  });

  test('consume() returns true once per signal, then false', () => {
    repositionSignalOps.signal();
    expect(repositionSignalOps.consume()).toBe(true);  // claimed
    expect(repositionSignalOps.consume()).toBe(false); // already claimed
  });

  test('consume() is false with no pending signal', () => {
    expect(repositionSignalOps.consume()).toBe(false);
  });

  test('a later signal re-latches a consumed flag (consecutive reorders)', () => {
    repositionSignalOps.signal();
    expect(repositionSignalOps.consume()).toBe(true);
    repositionSignalOps.signal(); // next reorder
    expect(repositionSignalOps.consume()).toBe(true);
  });

  test('subscribe() notifies on every signal — consecutive reorders each observed', () => {
    const listener = vi.fn();
    const unsub = repositionSignalOps.subscribe(listener);

    repositionSignalOps.signal();
    expect(listener).toHaveBeenCalledTimes(1);
    repositionSignalOps.signal(); // no intervening "false" — still observed
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  test('unsubscribe() stops notifications', () => {
    const listener = vi.fn();
    const unsub = repositionSignalOps.subscribe(listener);
    repositionSignalOps.signal();
    unsub();
    repositionSignalOps.signal();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('multiple subscribers all notified', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = repositionSignalOps.subscribe(a);
    const ub = repositionSignalOps.subscribe(b);
    repositionSignalOps.signal();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    ua(); ub();
  });

  test('isCommitPending() is high from signal() until clearCommitPending()', () => {
    expect(repositionSignalOps.isCommitPending()).toBe(false);
    repositionSignalOps.signal();
    expect(repositionSignalOps.isCommitPending()).toBe(true);
    repositionSignalOps.clearCommitPending();
    expect(repositionSignalOps.isCommitPending()).toBe(false);
  });

  test('commit-pending survives consume() (independent of the SelectionFade latch)', () => {
    repositionSignalOps.signal();
    repositionSignalOps.consume();                            // SelectionFade claims the one-shot
    expect(repositionSignalOps.isCommitPending()).toBe(true); // label gate still held
  });

  test('clearCommitPending() notifies subscribers (so the label re-renders)', () => {
    repositionSignalOps.signal();
    const listener = vi.fn();
    const unsub = repositionSignalOps.subscribe(listener);
    repositionSignalOps.clearCommitPending();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  test('clearCommitPending() is a no-op (no notify) when nothing is pending', () => {
    const listener = vi.fn();
    const unsub = repositionSignalOps.subscribe(listener);
    repositionSignalOps.clearCommitPending();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});
