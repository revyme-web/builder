// tool-store.ts — Active tool mode state.
// Only ONE tool mode can be active at a time.
// Toggling a mode deactivates all others.

import { atom } from 'jotai';
import { trace } from '@/shared/debug-trace';

export type ToolMode = 'select' | 'frame' | 'text' | 'hand'
  | 'shape-rect' | 'shape-ellipse' | 'shape-triangle' | 'shape-path'
  | 'layout-rows' | 'layout-columns' | 'layout-grids'
  | 'sketch';

export function isShapeMode(mode: ToolMode): boolean {
  trace.fn('tool:is-shape-mode', { mode });
  return mode.startsWith('shape-');
}

export function isLayoutMode(mode: ToolMode): boolean {
  trace.fn('tool:is-layout-mode', { mode });
  return mode.startsWith('layout-');
}

/** Tool modes that CREATE nodes (frame / text / layout / shape / sketch). */
export const CREATOR_TOOL_MODES: ReadonlySet<string> = new Set([
  'frame', 'text', 'layout-rows', 'layout-columns', 'layout-grids',
  'shape-rect', 'shape-ellipse', 'shape-triangle', 'shape-path', 'sketch',
]);
export function isCreatorToolMode(mode: string): boolean { return CREATOR_TOOL_MODES.has(mode); }

/** TRANSLATION MODE lock: while a non-default locale is active the page is
 *  being translated, not designed — creator tools are greyed in the toolbar
 *  and their shortcuts are inert (reference parity, 2026-09-07). Canvas mirrors
 *  `isDefaultLocaleAtom` into this so the store has no locale import. */
export const creatorToolsLockedAtom = atom(false);

const toolModeBaseAtom = atom<ToolMode>('select');
/** The active tool. Writes of a CREATOR mode are ignored while
 *  `creatorToolsLockedAtom` is set — one gate for the toolbar, the shortcuts
 *  and every programmatic caller. */
export const toolModeAtom = atom(
  (get) => get(toolModeBaseAtom),
  (get, set, mode: ToolMode) => {
    if (get(creatorToolsLockedAtom) && isCreatorToolMode(mode)) {
      trace.action('tool-store:creator-locked', { mode });
      return;
    }
    set(toolModeBaseAtom, mode);
  },
);

/**
 * Reactive "pan highlight" — true when temporarily panning via middle mouse or space bar.
 * Drives the hand icon highlight in the bottom toolbar.
 * Separate from toolModeAtom because these are transient holds, not explicit mode switches.
 */
export const panHighlightAtom = atom(false);

/** Set tool mode. Only one mode active at a time. */
export function setToolMode(mode: ToolMode, set: (mode: ToolMode) => void): void {
  trace.action('tool:set-mode', { mode });
  set(mode);
}
