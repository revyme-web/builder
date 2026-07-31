// resize-live-store.ts — Live dimension broadcast from ResizeManager → SizeTool.
//
// During a canvas handle-resize, the Dimensions panel needs to show the value
// being committed IN REAL TIME and IN THE RIGHT UNIT. It can't poll the canvas
// DOM for this: the canvas renders inside the iframe (the parent-frame
// `document.querySelector` misses it) and the bridge only exposes COMPUTED
// styles, which resolve `vh`/`%` → px — so a `100vh` resize would read back as
// `891px` and flip the unit chevron.
//
// Instead ResizeManager publishes the EXACT formatted string it is about to
// commit (`'108vh'`, `'52%'`, `'880px'`) here every frame, and SizeTool reads
// it. Because it's the same string the commit writes, the live preview and the
// committed value can never disagree (no mouse-up jump).
//
// This is a plain module store (not a jotai atom) read synchronously inside
// SizeTool's existing RAF poll — no per-frame atom write, no extra subscription.

import { trace } from '@/shared/debug-trace';

export interface LiveResizeDims {
  /** The node currently being resized. SizeTool gates on this so a stale value
   *  can't leak onto a different selection. */
  nodeId: string;
  /** Formatted width string (e.g. `'880px'`, `'52%'`, `'100vw'`). */
  width?: string;
  /** Formatted height string (e.g. `'108vh'`). */
  height?: string;
}

let current: LiveResizeDims | null = null;

// ─── Activity subscription ──────────────────────────────────────────────────
// `current !== null` doubles as "a handle-resize is in flight": ResizeManager
// publishes on every `pointermove` and clears on `pointerup`. Overlays that
// must step aside for the gesture (ParentHighlight) subscribe here.
//
// Listeners fire ONLY on activity TRANSITIONS — start, end, or a switch to a
// different node — never on the per-frame value updates. A notification per
// frame would re-render every subscriber at 60fps for values they don't read,
// and `isResizing`'s boolean snapshot wouldn't have changed anyway.
const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

export const resizeLiveOps = {
  /** Publish the current live dimensions (called per frame by ResizeManager). */
  set(dims: LiveResizeDims): void {
    const wasActive = current !== null;
    const nodeChanged = current?.nodeId !== dims.nodeId;
    current = dims;
    if (!wasActive || nodeChanged) notify();
  },
  /** Read the latest published dimensions, or null when no resize is active. */
  get(): LiveResizeDims | null {
    return current;
  },
  /** Clear on resize end. No-op (silent) when already clear. */
  clear(): void {
    if (current === null) return;
    trace.action('resize-live:clear', { nodeId: current.nodeId });
    current = null;
    notify();
  },
  /** True while a handle-resize gesture is in flight. Stable boolean snapshot
   *  for `useSyncExternalStore` (the `get()` object identity changes every
   *  frame, so it must NOT be used as a snapshot). */
  isResizing(): boolean {
    return current !== null;
  },
  /** Subscribe pattern compatible with `useSyncExternalStore`. Fires on
   *  activity transitions only — see the `listeners` note above. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
