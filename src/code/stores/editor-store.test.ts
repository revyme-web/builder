// editor-store.test.ts — AI chat docking transitions.

import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { leftPanelAtom, DEFAULT_LEFT_PANEL } from '@/code/stores/left-panel-store';
import {
  aiChatSheetOpenAtom, aiChatDetachedAtom, detachAiChatAtom, dockAiChatAtom,
} from './editor-store';

describe('AI chat docking', () => {
  it('defaults to docked + popup closed', () => {
    const store = createStore();
    expect(store.get(aiChatDetachedAtom)).toBe(false);
    expect(store.get(aiChatSheetOpenAtom)).toBe(false);
  });

  it('detach opens the floating popup and frees the VIBE left panel', () => {
    const store = createStore();
    store.set(leftPanelAtom, 'vibe');
    store.set(detachAiChatAtom);
    expect(store.get(aiChatDetachedAtom)).toBe(true);
    expect(store.get(aiChatSheetOpenAtom)).toBe(true);
    // Left panel falls back to the default so the docked panel is gone.
    expect(store.get(leftPanelAtom)).toBe(DEFAULT_LEFT_PANEL);
  });

  it('dock closes the popup and keeps the panel the user is on', () => {
    const store = createStore();
    store.set(detachAiChatAtom);
    // While detached the user navigates to the Layers panel.
    store.set(leftPanelAtom, 'layers');
    store.set(dockAiChatAtom);
    expect(store.get(aiChatDetachedAtom)).toBe(false);
    expect(store.get(aiChatSheetOpenAtom)).toBe(false);
    // The left panel is untouched — NOT forced to 'vibe'.
    expect(store.get(leftPanelAtom)).toBe('layers');
  });
});
