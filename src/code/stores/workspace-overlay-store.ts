// workspace-overlay-store.ts — "is a full-workspace overlay covering the
// canvas right now?"
//
// The chrome's cut-corner notches (LeftPanel bottom-right, RightHeader
// top-left) are windows onto the CANVAS — they only make sense while the
// canvas is what's behind them. When a takeover overlay is open (CMS
// collection/editor, localization, code-component or plugin master editor)
// the notch shows a triangle of stale canvas peeking through the overlay's
// chrome instead, so the panels square their corners while any of these is
// up. One derived atom so every consumer agrees on what counts as a
// takeover; add future overlays HERE, not in the consumers.

import { atom } from 'jotai';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { pluginEditorFileAtom } from '@/editor/plugin-editor/plugin-editor-store';
import { cmsEditorOpenAtom } from '@/code/stores/cms-editor-store';
import { cmsOverlayOpenAtom } from '@/editor/left-toolbar/panels/cms/CmsOverlay';
import { translationsOverlayOpenAtom } from '@/code/stores/left-panel-store';

export const workspaceOverlayOpenAtom = atom((get) =>
  get(componentEditorFileAtom) !== null ||
  get(pluginEditorFileAtom) !== null ||
  get(cmsEditorOpenAtom) ||
  get(cmsOverlayOpenAtom) ||
  get(translationsOverlayOpenAtom)
);
