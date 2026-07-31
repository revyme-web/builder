// cms-editor-store.test.ts — opening the CMS editor is never just "set open".
//
// App.tsx enforces an invariant: the CMS collection overlay may only exist
// while the CMS panel is the active left panel, via an effect that closes it
// whenever `leftPanelAtom !== 'cms'`. Every opener therefore has to switch the
// panel in the same commit. The `?cms=`/`?item=` URL restore in ProjectLoader
// didn't — it opened the overlay, App's effect closed it right back, and since
// the URL sync only runs WHILE the overlay is open, the deep link stayed in the
// address bar pointing at an overlay that wasn't there (user report
// 2026-07-25). `openCmsEditorAtom` makes that impossible to forget.

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { leftPanelAtom } from './left-panel-store';
import {
  openCmsEditorAtom,
  cmsEditorOpenAtom,
  cmsEditorCollectionAtom,
  cmsEditorExpandedItemAtom,
  cmsEditorFocusedFieldAtom,
} from './cms-editor-store';

let store: ReturnType<typeof createStore>;
beforeEach(() => { store = createStore(); });

describe('openCmsEditorAtom', () => {
  it('selects the CMS left panel (App would close the overlay otherwise)', () => {
    expect(store.get(leftPanelAtom)).toBe('pages-layers'); // fresh-load default
    store.set(openCmsEditorAtom, { collection: 'blog' });
    expect(store.get(leftPanelAtom)).toBe('cms');
  });

  it('opens on the requested collection', () => {
    store.set(openCmsEditorAtom, { collection: 'blog' });
    expect(store.get(cmsEditorOpenAtom)).toBe(true);
    expect(store.get(cmsEditorCollectionAtom)).toBe('blog');
  });

  it('carries an item + field deep link', () => {
    store.set(openCmsEditorAtom, { collection: 'blog', itemId: 'item_1', fieldId: 'title' });
    expect(store.get(cmsEditorExpandedItemAtom)).toBe('item_1');
    expect(store.get(cmsEditorFocusedFieldAtom)).toBe('title');
  });

  it('clears a PREVIOUS item/field when opened without one', () => {
    store.set(openCmsEditorAtom, { collection: 'blog', itemId: 'item_1', fieldId: 'title' });
    store.set(openCmsEditorAtom, { collection: 'team' });
    expect(store.get(cmsEditorExpandedItemAtom)).toBeNull();
    expect(store.get(cmsEditorFocusedFieldAtom)).toBeNull();
  });

  it('treats a null itemId from the URL as "no deep link"', () => {
    store.set(openCmsEditorAtom, { collection: 'blog', itemId: null, fieldId: null });
    expect(store.get(cmsEditorOpenAtom)).toBe(true);
    expect(store.get(cmsEditorExpandedItemAtom)).toBeNull();
  });
});
