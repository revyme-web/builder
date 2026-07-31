// parent-highlight-store.ts — Module-level state for the parent highlight overlay.
// Shows a semi-transparent accent border + fill on the parent element during drag.
// Callers: DragCoordinator via Canvas.tsx (show/hide), ParentHighlight (read).

import { trace } from '@/shared/debug-trace';

export interface ParentHighlightInfo {
  parentId: string;
  vpId: string;
}

let _highlight: ParentHighlightInfo | null = null;
let _listener: (() => void) | null = null;

export const parentHighlightOps = {
  show(info: ParentHighlightInfo) {
    // Avoid redundant updates
    if (_highlight && _highlight.parentId === info.parentId && _highlight.vpId === info.vpId) return;
    _highlight = info;
    trace.action('parent-highlight:show', info);
    _listener?.();
  },

  hide() {
    if (_highlight === null) return;
    _highlight = null;
    trace.action('parent-highlight:hide');
    _listener?.();
  },

  get(): ParentHighlightInfo | null {
    return _highlight;
  },

  /** Subscribe to changes (single listener — only ParentHighlight uses this) */
  subscribe(fn: () => void) {
    _listener = fn;
    return () => { _listener = null; };
  },
};
