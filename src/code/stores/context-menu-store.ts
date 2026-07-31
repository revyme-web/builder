// context-menu-store.ts — Context menu + rename state.

import { atom } from 'jotai';

export interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  nodeId: string | null;
}

export const contextMenuAtom = atom<ContextMenuState>({
  show: false,
  x: 0,
  y: 0,
  nodeId: null,
});

/** Set to a nodeId to activate inline rename in the layers panel */
export const renamingNodeIdAtom = atom<string | null>(null);
