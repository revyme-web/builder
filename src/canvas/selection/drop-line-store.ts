// drop-line-store.ts — Module-level state for the drop line indicator.
// Shows a blue line between siblings during layout reorder drag.
// Callers: LayoutLiftedStrategy (show/hide), DropLineIndicator (read).

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';

export interface DropLineInfo {
  parentId: string;
  insertIndex: number;
  vpId: string;
}

let _dropLine: DropLineInfo | null = null;
// Companion flag: "drag is currently over a flex/grid drop target". The
// drop-line itself is suppressed when the target has no children (no
// siblings to draw a line BETWEEN), but pin-lines + snap-guides should
// still be hidden for the empty case — same UX rule, just no visible
// line. Strategies set this in addition to (or instead of) dropLineOps
// .show/.hide whenever layout-drop entry is detected.
let _layoutDropActive = false;
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

export const dropLineOps = {
  show(info: DropLineInfo) {
    // Skip the listener notify if nothing changed — drag strategies call this
    // every move tick with a fresh object, which would otherwise rerender every
    // frame even when the underlying parent/index/viewport haven't changed.
    // Object identity differs but the actual data is stable; comparing fields
    // avoids the cascade of useSyncExternalStore re-renders that Reactt
    // sometimes flags as "Maximum update depth exceeded" under concurrent mode.
    const prev = _dropLine;
    const sameInfo = !!prev
      && prev.parentId === info.parentId
      && prev.insertIndex === info.insertIndex
      && prev.vpId === info.vpId;
    // A visible line implies a layout drop preview is active. Auto-set
    // the companion flag so callers don't have to remember to set it
    // alongside every show().
    const flagChanged = !_layoutDropActive;
    _layoutDropActive = true;
    if (sameInfo && !flagChanged) return;
    _dropLine = info;
    trace.action('drop-line:show', info);
    notify();
  },

  hide() {
    if (_dropLine === null && !_layoutDropActive) return;
    _dropLine = null;
    // Auto-clear the layout flag too — `hide()` is the "no longer over
    // any layout target" signal in the strategies. The empty-layout
    // case calls `markEmptyLayoutDrop()` instead, which keeps the flag
    // on without rendering a line.
    _layoutDropActive = false;
    trace.action('drop-line:hide');
    notify();
  },

  get(): DropLineInfo | null {
    return _dropLine;
  },

  /** Mark the drag as being over an EMPTY layout drop target. No line
   *  is drawn (there are no siblings to put one between), but the
   *  layout-drop flag flips on so PinConstraintLines + snap-guides
   *  hide for the same UX reason as the with-children case. Replaces
   *  `hide()` in strategies' empty-layout branches. */
  markEmptyLayoutDrop() {
    if (_dropLine === null && _layoutDropActive) return;
    _dropLine = null;
    _layoutDropActive = true;
    trace.action('drop-line:empty-layout-drop');
    notify();
  },

  /** True iff a drop-line is showing OR the drag is over an empty
   *  layout drop target. Hook + suppress callers read this. */
  isLayoutDropActive(): boolean {
    return _layoutDropActive;
  },

  /** Subscribe to changes — multi-listener (DropLineIndicator + Canvas
   *  snap-guide gate + anywhere else that wants to suppress visuals while
   *  a layout drop preview is active). */
  subscribe(fn: () => void) {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  },
};

/** React hook: re-render whenever a layout drop preview becomes active
 *  or inactive. Returns true while a drop-line is showing OR the drag
 *  is over an EMPTY layout drop target — used by PinConstraintLines
 *  and snap-guide rendering to suppress visuals that would compete
 *  with the drop indicator (or with the implicit "you're dropping into
 *  this empty frame" affordance). */
export function useDropLineActive(): boolean {
  return useSyncExternalStore(
    dropLineOps.subscribe,
    () => dropLineOps.isLayoutDropActive(),
    () => false,
  );
}
