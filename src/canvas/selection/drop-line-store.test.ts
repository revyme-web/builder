// drop-line-store.test.ts — Tests for drop line indicator state.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { dropLineOps } from './drop-line-store';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

describe('dropLineOps', () => {
  beforeEach(() => {
    dropLineOps.hide();
  });

  test('starts with null', () => {
    expect(dropLineOps.get()).toBeNull();
  });

  test('show() sets the drop line info', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 2, vpId: 'desktop' });
    expect(dropLineOps.get()).toEqual({ parentId: 'p1', insertIndex: 2, vpId: 'desktop' });
  });

  test('hide() clears the drop line info', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    dropLineOps.hide();
    expect(dropLineOps.get()).toBeNull();
  });

  test('hide() is idempotent (no error on double hide)', () => {
    dropLineOps.hide();
    dropLineOps.hide();
    expect(dropLineOps.get()).toBeNull();
  });

  test('show() overwrites previous state', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    dropLineOps.show({ parentId: 'p2', insertIndex: 3, vpId: 'tablet' });
    expect(dropLineOps.get()).toEqual({ parentId: 'p2', insertIndex: 3, vpId: 'tablet' });
  });

  test('subscribe() notifies on show/hide', () => {
    const listener = vi.fn();
    const unsub = dropLineOps.subscribe(listener);

    dropLineOps.show({ parentId: 'p1', insertIndex: 1, vpId: 'desktop' });
    expect(listener).toHaveBeenCalledTimes(1);

    dropLineOps.hide();
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    dropLineOps.show({ parentId: 'p2', insertIndex: 0, vpId: 'desktop' });
    expect(listener).toHaveBeenCalledTimes(2); // no more calls after unsub
  });

  // ─── Multi-listener subscribe ──────────────────────────────────────────────

  test('subscribe() supports multiple concurrent listeners', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = dropLineOps.subscribe(a);
    const unsubB = dropLineOps.subscribe(b);

    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // Unsubscribing one keeps the other alive
    unsubA();
    dropLineOps.hide();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    unsubB();
  });

  // ─── isLayoutDropActive + markEmptyLayoutDrop ──────────────────────────────

  test('isLayoutDropActive() is false by default', () => {
    expect(dropLineOps.isLayoutDropActive()).toBe(false);
  });

  test('show() auto-flips the layout-drop flag on', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
  });

  test('hide() auto-flips the layout-drop flag off', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    dropLineOps.hide();
    expect(dropLineOps.isLayoutDropActive()).toBe(false);
  });

  test('markEmptyLayoutDrop() sets layout-drop flag without rendering a line', () => {
    dropLineOps.markEmptyLayoutDrop();
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
    expect(dropLineOps.get()).toBeNull(); // no line to draw
  });

  test('markEmptyLayoutDrop() clears any existing drop line', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 1, vpId: 'desktop' });
    expect(dropLineOps.get()).not.toBeNull();
    dropLineOps.markEmptyLayoutDrop();
    expect(dropLineOps.get()).toBeNull();
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
  });

  test('hide() after markEmptyLayoutDrop() clears the flag', () => {
    dropLineOps.markEmptyLayoutDrop();
    dropLineOps.hide();
    expect(dropLineOps.isLayoutDropActive()).toBe(false);
  });

  test('subscribers fire when the layout-drop flag transitions', () => {
    const listener = vi.fn();
    const unsub = dropLineOps.subscribe(listener);
    listener.mockClear();

    dropLineOps.markEmptyLayoutDrop();
    expect(listener).toHaveBeenCalledTimes(1);

    // Same state → no notify (idempotency)
    dropLineOps.markEmptyLayoutDrop();
    expect(listener).toHaveBeenCalledTimes(1);

    dropLineOps.hide();
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  test('show() then markEmptyLayoutDrop() then show() leaves flag still on (no flicker)', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
    dropLineOps.markEmptyLayoutDrop();
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
    dropLineOps.show({ parentId: 'p2', insertIndex: 1, vpId: 'desktop' });
    expect(dropLineOps.isLayoutDropActive()).toBe(true);
    expect(dropLineOps.get()).toEqual({ parentId: 'p2', insertIndex: 1, vpId: 'desktop' });
  });

  // ─── getLayoutDropTarget (feeds ParentHighlight's drop-target outline) ─────

  test('getLayoutDropTarget() is null with no active preview', () => {
    expect(dropLineOps.getLayoutDropTarget()).toBeNull();
  });

  test('show() exposes the line parent as the layout-drop target', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 2, vpId: 'desktop' });
    expect(dropLineOps.getLayoutDropTarget()).toEqual({ parentId: 'p1', vpId: 'desktop' });
  });

  test('target reference is STABLE while only insertIndex changes (per-gap moves must not re-render the outline)', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    const first = dropLineOps.getLayoutDropTarget();
    dropLineOps.show({ parentId: 'p1', insertIndex: 3, vpId: 'desktop' });
    expect(dropLineOps.getLayoutDropTarget()).toBe(first);
  });

  test('target reference stays stable across show() → markEmptyLayoutDrop() on the same container', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 1, vpId: 'desktop' });
    const first = dropLineOps.getLayoutDropTarget();
    dropLineOps.markEmptyLayoutDrop({ parentId: 'p1', vpId: 'desktop' });
    expect(dropLineOps.getLayoutDropTarget()).toBe(first);
  });

  test('markEmptyLayoutDrop(target) exposes the empty container as the target', () => {
    dropLineOps.markEmptyLayoutDrop({ parentId: 'empty-1', vpId: 'tablet' });
    expect(dropLineOps.get()).toBeNull();
    expect(dropLineOps.getLayoutDropTarget()).toEqual({ parentId: 'empty-1', vpId: 'tablet' });
  });

  test('markEmptyLayoutDrop(target) dedupes repeats but notifies on target change', () => {
    const listener = vi.fn();
    const unsub = dropLineOps.subscribe(listener);
    listener.mockClear();

    dropLineOps.markEmptyLayoutDrop({ parentId: 'a', vpId: 'desktop' });
    dropLineOps.markEmptyLayoutDrop({ parentId: 'a', vpId: 'desktop' });
    expect(listener).toHaveBeenCalledTimes(1);

    dropLineOps.markEmptyLayoutDrop({ parentId: 'b', vpId: 'desktop' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(dropLineOps.getLayoutDropTarget()).toEqual({ parentId: 'b', vpId: 'desktop' });

    unsub();
  });

  test('hide() clears the layout-drop target', () => {
    dropLineOps.show({ parentId: 'p1', insertIndex: 0, vpId: 'desktop' });
    dropLineOps.hide();
    expect(dropLineOps.getLayoutDropTarget()).toBeNull();
  });
});
