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

export const toolModeAtom = atom<ToolMode>('select');

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
