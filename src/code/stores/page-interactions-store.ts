// page-interactions-store.ts — Derived atom for "Set Variable" interactions
// on the active page. Reads JSX event handlers and surfaces a flat list the
// InteractionsTool consumes.

import { atom } from 'jotai';
import { codeAtom, selectedNodeAtom } from './store';
import { parsePageInteractionsForNode, type PageInteraction } from '@/code/features/page-interactions';
import {
  parseCloseOverlayForNode,
  enclosingOverlayForNode,
  type CloseOverlayInteraction,
} from '@/code/generation/close-overlay-gen';
import { trace } from '@/shared/debug-trace';

/**
 * Interactions on the currently selected node only — that's all the panel
 * shows at any one time, so we avoid scanning every node in the tree on each
 * code change.
 */
export const pageInteractionsForSelectedAtom = atom<PageInteraction[]>((get) => {
  const code = get(codeAtom);
  const selectedId = get(selectedNodeAtom);
  if (!selectedId || !code) return [];
  const list = parsePageInteractionsForNode(code, selectedId);
  trace.fn('page-interactions-store:forSelected', { nodeId: selectedId, count: list.length });
  return list;
});

/** "Close Overlay" interactions on the selected node (handles delayed closes). */
export const closeOverlayInteractionsForSelectedAtom = atom<CloseOverlayInteraction[]>((get) => {
  const code = get(codeAtom);
  const selectedId = get(selectedNodeAtom);
  if (!selectedId || !code) return [];
  return parseCloseOverlayForNode(code, selectedId);
});

/**
 * The id of the overlay enclosing the selected node, or null. Drives whether
 * the "Close Overlay" item appears in the add-interaction menu.
 */
export const enclosingOverlayForSelectedAtom = atom<string | null>((get) => {
  const code = get(codeAtom);
  const selectedId = get(selectedNodeAtom);
  if (!selectedId || !code) return null;
  return enclosingOverlayForNode(code, selectedId);
});
