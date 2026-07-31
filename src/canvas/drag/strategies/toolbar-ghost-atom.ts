// toolbar-ghost-atom.ts — Module-level state for the toolbar drag ghost overlay.
// Uses the same pub/sub pattern as dropLineOps/parentHighlightOps to avoid
// Jotai store mismatch (Provider store vs getDefaultStore).

import type { ToolbarItem } from '../toolbar-item-config';
import type { Point } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

export interface ToolbarGhostState {
  item: ToolbarItem;
  screenPos: Point;
  /** Viewport ID when ghost is over a viewport, null otherwise */
  vpId: string | null;
  /** Canvas-space position when over canvas/viewport, null when in screen-space */
  canvasPos: Point | null;
}

let _ghost: ToolbarGhostState | null = null;
let _listener: (() => void) | null = null;

export const toolbarGhostOps = {
  show(state: ToolbarGhostState) {
    _ghost = state;
    _listener?.();
  },

  hide() {
    if (_ghost === null) return;
    _ghost = null;
    trace.action('toolbar-ghost:hide');
    _listener?.();
  },

  get(): ToolbarGhostState | null {
    return _ghost;
  },

  subscribe(fn: () => void) {
    _listener = fn;
    return () => { _listener = null; };
  },
};
