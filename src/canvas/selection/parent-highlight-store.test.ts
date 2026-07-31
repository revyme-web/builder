// parent-highlight-store.test.ts — Tests for parent highlight state.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { parentHighlightOps } from './parent-highlight-store';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

describe('parentHighlightOps', () => {
  beforeEach(() => {
    parentHighlightOps.hide();
  });

  test('starts with null', () => {
    expect(parentHighlightOps.get()).toBeNull();
  });

  test('show() sets the highlight info', () => {
    parentHighlightOps.show({ parentId: 'frame-1', vpId: 'desktop' });
    expect(parentHighlightOps.get()).toEqual({ parentId: 'frame-1', vpId: 'desktop' });
  });

  test('hide() clears the highlight info', () => {
    parentHighlightOps.show({ parentId: 'frame-1', vpId: 'desktop' });
    parentHighlightOps.hide();
    expect(parentHighlightOps.get()).toBeNull();
  });

  test('hide() is idempotent', () => {
    parentHighlightOps.hide();
    parentHighlightOps.hide();
    expect(parentHighlightOps.get()).toBeNull();
  });

  test('show() deduplicates same values', () => {
    const listener = vi.fn();
    const unsub = parentHighlightOps.subscribe(listener);

    parentHighlightOps.show({ parentId: 'frame-1', vpId: 'desktop' });
    parentHighlightOps.show({ parentId: 'frame-1', vpId: 'desktop' }); // same values
    // First call notifies, second should be deduped
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
  });

  test('subscribe() notifies on changes', () => {
    const listener = vi.fn();
    const unsub = parentHighlightOps.subscribe(listener);

    parentHighlightOps.show({ parentId: 'a', vpId: 'desktop' });
    expect(listener).toHaveBeenCalledTimes(1);

    parentHighlightOps.show({ parentId: 'b', vpId: 'tablet' }); // different values
    expect(listener).toHaveBeenCalledTimes(2);

    parentHighlightOps.hide();
    expect(listener).toHaveBeenCalledTimes(3);

    unsub();
  });
});
