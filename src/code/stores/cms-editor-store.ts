// cms-editor-store.ts — Atoms for the full-screen CMS collection editor
// overlay (editor/left-toolbar/panels/cms/CmsEditorOverlay.tsx). Lifted here
// (code/stores) because canvas surfaces (Canvas, CanvasMouseController, the
// breadcrumbs) and the CMS AI agent open / deep-link the overlay too.

import { atom } from 'jotai';
import { leftPanelAtom } from './left-panel-store';

export const cmsEditorOpenAtom = atom(false);
export const cmsEditorCollectionAtom = atom<string | null>(null);
// The item open in the editor pane. Lifted to an atom so a canvas
// double-click can deep-link straight to one item (with a field highlighted).
export const cmsEditorExpandedItemAtom = atom<string | null>(null);
export const cmsEditorFocusedFieldAtom = atom<string | null>(null);

/**
 * Open the CMS editor overlay on a collection (optionally an item + field).
 *
 * Write-only atom, because opening is never JUST `cmsEditorOpenAtom = true`:
 * App.tsx enforces "the overlay may only exist while the CMS panel is the
 * active left panel" with an effect that closes it whenever `leftPanelAtom`
 * isn't 'cms'. Every canvas-side opener had to remember to switch the panel
 * too, and the one that forgot — the `?cms=` URL restore in ProjectLoader —
 * opened the overlay and had it closed again in the same commit, so reloading
 * an item deep-link showed the plain canvas (user report 2026-07-25).
 * Routing every opener through here makes that impossible to forget.
 */
export const openCmsEditorAtom = atom(
  null,
  (_get, set, opts: { collection: string; itemId?: string | null; fieldId?: string | null }) => {
    set(leftPanelAtom, 'cms');
    set(cmsEditorCollectionAtom, opts.collection);
    set(cmsEditorExpandedItemAtom, opts.itemId ?? null);
    set(cmsEditorFocusedFieldAtom, opts.fieldId ?? null);
    set(cmsEditorOpenAtom, true);
  },
);
