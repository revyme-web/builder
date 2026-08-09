// left-panel-store.test.ts — Tests for left panel state management.

import { describe, test, expect, vi } from 'vitest';
import { createStore } from 'jotai';
import { leftPanelAtom, togglePanelAtom, DEFAULT_LEFT_PANEL } from '@/code/stores/left-panel-store';

// Mock trace
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

describe('leftPanelAtom', () => {
  test('the builder opens on Layers', () => {
    // Layers is the home panel — it is what you reach for on almost every
    // edit, while Pages is a navigation action taken once per session.
    const store = createStore();
    expect(store.get(leftPanelAtom)).toBe('layers');
    expect(DEFAULT_LEFT_PANEL).toBe('layers');
  });
});

describe('togglePanelAtom', () => {
  test('switches to a different panel', () => {
    const store = createStore();
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe('insert');
  });

  test('clicking the active panel falls back home (never null)', () => {
    const store = createStore();
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe('insert');

    // Click insert again → back to the home panel
    store.set(togglePanelAtom, 'insert');
    expect(store.get(leftPanelAtom)).toBe(DEFAULT_LEFT_PANEL);
  });

  test('clicking the home panel while on it stays there', () => {
    const store = createStore();
    expect(store.get(leftPanelAtom)).toBe(DEFAULT_LEFT_PANEL);
    store.set(togglePanelAtom, DEFAULT_LEFT_PANEL);
    expect(store.get(leftPanelAtom)).toBe(DEFAULT_LEFT_PANEL);
  });

  test('Pages is still reachable and still toggles home', () => {
    // Pages is no longer the fallback, so it must behave like any other panel.
    const store = createStore();
    store.set(togglePanelAtom, 'pages-layers');
    expect(store.get(leftPanelAtom)).toBe('pages-layers');
    store.set(togglePanelAtom, 'pages-layers');
    expect(store.get(leftPanelAtom)).toBe(DEFAULT_LEFT_PANEL);
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
    const panels = ['insert', 'pages-layers', 'layers', 'library', 'media', 'locale', 'cms'] as const;

    for (const panel of panels) {
      store.set(togglePanelAtom, panel);
      expect(store.get(leftPanelAtom)).toBe(panel);
    }
  });
});
