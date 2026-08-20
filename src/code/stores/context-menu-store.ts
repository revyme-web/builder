// context-menu-store.ts — Context menu + rename state.

import { atom } from 'jotai';

export interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  nodeId: string | null;
  /** True when the right-click landed on a VIEWPORT HEADER — the menu's
   *  node operations (Make Component, Cut, Delete, …) don't apply to a
   *  viewport, so they all disable. Without this flag the menu would
   *  resurrect the current selection via its `menu.nodeId || selectedId`
   *  fallback and happily offer to cut it. */
  viewportHeader?: boolean;
}

export const contextMenuAtom = atom<ContextMenuState>({
  show: false,
  x: 0,
  y: 0,
  nodeId: null,
});

/** Set to a nodeId to activate inline rename in the layers panel */
export const renamingNodeIdAtom = atom<string | null>(null);
