// left-panel-store.test.ts — Tests for left panel state management.

import { describe, test, expect, vi } from 'vitest';
import { createStore } from 'jotai';
import { leftPanelAtom, togglePanelAtom } from '@/code/stores/left-panel-store';

// Mock trace
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

describe('leftPanelAtom', () => {
  test('defaults to pages-layers', () => {
    const store = createStore();
    expect(store.get(leftPanelAtom)).toBe('pages-layers');
  });
});

describe('togglePanelAtom', () => {
  test('switches to a different panel', () => {
    const store = createStore();
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe('insert');
  });

  test('clicking active panel falls back to pages-layers (never null)', () => {
    const store = createStore();
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe('insert');

    // Click insert again → back to pages-layers
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe('pages-layers');
  });

  test('clicking pages-layers when already on pages-layers stays on pages-layers', () => {
    const store = createStore();
    expect(store.get(leftPanelAtom)).toBe('pages-layers');
    store.set(togglePanelAtom, 'pages-layers');
    expect(store.get(leftPanelAtom)).toBe('pages-layers');
  });

  test('switches between different panels', () => {
    const store = createStore();
    store.set(togglePanelAtom, 'media');
    expect(store.get(leftPanelAtom)).toBe('media');

    store.set(togglePanelAtom, 'library');
    expect(store.get(leftPanelAtom)).toBe('library');

    store.set(togglePanelAtom, 'cms');
    expect(store.get(leftPanelAtom)).toBe('cms');
  });

  test('all panel IDs are valid', () => {
    const store = createStore();
    const panels = ['insert', 'pages-layers', 'library', 'media', 'locale', 'cms'] as const;

    for (const panel of panels) {
      store.set(togglePanelAtom, panel);
      expect(store.get(leftPanelAtom)).toBe(panel);
    }
  });
});
