// shape-edit-history.ts — Session-local undo/redo stack for shape-edit mode.
//
// While the SVG path editor is active, vertex edits are LIVE DOM mutations in
// the iframe — no source mutations, no global-history entries. The whole
// session commits as ONE source change on exit. That left Cmd+Z dead inside
// the session (nothing to undo yet, and focus is in the iframe so the
// parent's shortcut never fires). This class is the in-session history the
// host keeps instead: snapshots of the edited SVG's state, one entry per USER
// GESTURE, popped/reapplied by Cmd+Z / Cmd+Shift+Z without leaving edit mode.
//
// Pure (no DOM, no clocks) so the gesture-coalescing rules are unit-testable;
// snapshot capture/restore stays in shape-edit-host. Snapshot type is opaque.
//
// Gesture coalescing — `recordChange` is called with the PRE-change state on
// every model change (the host's `setSvgContent` fires per pointermove tick
// during a drag, and per scrub tick from the Path tool's Position chevrons):
//   • 'drag'     — one entry per drag gesture: the first change after
//                  `beginDrag()` pushes, the rest of the drag coalesces.
//   • 'panel'    — Path-tool scrubs (x/y chevron drag): ticks within
//                  PANEL_COALESCE_MS of the previous panel push merge, so a
//                  scrub is one entry, not one per pixel.
//   • 'discrete' — everything else (delete vertex, pen point placement,
//                  handle-mode change, typed position commit): one entry each.
// Every recorded change — pushed or coalesced — clears the redo stack.

export type ShapeEditChangeKind = 'drag' | 'panel' | 'discrete';

export class ShapeEditHistory<S> {
  /** Scrub ticks within this window of the previous panel push coalesce. */
  static readonly PANEL_COALESCE_MS = 500;
  /** Oldest entries drop past this depth (snapshots hold full inner markup). */
  static readonly MAX_ENTRIES = 100;

  private undoStack: S[] = [];
  private redoStack: S[] = [];
  private dragPushed = false;
  private lastPanelPushAt = -Infinity;

  /** Call at pointerdown on the editor overlay: the next 'drag' change starts
   *  a NEW gesture (pushes one entry; later ticks of the same drag coalesce). */
  beginDrag(): void {
    this.dragPushed = false;
  }

  /**
   * Record a model change. `before` is the state IMMEDIATELY BEFORE the
   * change applies; `now` is a millisecond clock (host passes Date.now()).
   * Returns true when an entry was pushed, false when coalesced into the
   * current gesture. Always clears redo — any new change invalidates it.
   */
  recordChange(before: S, kind: ShapeEditChangeKind, now: number): boolean {
    this.redoStack.length = 0;
    if (kind === 'drag') {
      if (this.dragPushed) return false;
      this.dragPushed = true;
    } else if (kind === 'panel') {
      const coalesce = now - this.lastPanelPushAt < ShapeEditHistory.PANEL_COALESCE_MS;
      this.lastPanelPushAt = now;
      if (coalesce) return false;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > ShapeEditHistory.MAX_ENTRIES) this.undoStack.shift();
    return true;
  }

  /** Pop the previous state; `current` becomes the redo target. Null when the
   *  session has nothing left to undo (caller does nothing — in-session undo
   *  NEVER falls through to the global history while editing). Breaks gesture
   *  coalescing so the next scrub/drag after an undo starts a fresh entry. */
  undo(current: S): S | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    this.endGesture();
    return prev;
  }

  /** Inverse of `undo`. Null when there is nothing to redo. */
  redo(current: S): S | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    this.endGesture();
    return next;
  }

  /** Break panel/drag coalescing so the next change starts a fresh entry. */
  private endGesture(): void {
    this.dragPushed = false;
    this.lastPanelPushAt = -Infinity;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get depth(): number { return this.undoStack.length; }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.endGesture();
  }
}

/**
 * Map a keydown to an in-session history command. Shared by the iframe-side
 * capture listener (focus lives in the iframe after any anchor click) and
 * unit tests. Cmd/Ctrl+Z → undo, +Shift → redo, Cmd/Ctrl+Y → redo — the same
 * bindings the parent's global shortcuts use.
 */
export function shapeEditKeyCommand(e: {
  key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey?: boolean;
}): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y') return 'redo';
  return null;
}
