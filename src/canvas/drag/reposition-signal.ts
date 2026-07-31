// reposition-signal.ts — "a drag just COMMITTED a layout reposition" pulse,
// exposed via the standard subscribe-based pattern (same as `drag-state-store`)
// so React components can read it with `useSyncExternalStore`.
//
// Why this exists (vs `dragStateOps` / `canvasInteractingAtom`):
//   - `canvasInteractingAtom` flips on ANY canvas motion incl. pure camera
//     pan/zoom.
//   - `dragStateOps` flips on any ELEMENT drag — but ALSO on resize (the
//     ResizeManager sets it). A resize-end has NO stale-paint problem (the box
//     tracked the handle live), so hiding the selection overlay there would
//     cause an unwanted blink.
//   - THIS pulse fires ONLY when a drag strategy actually REPOSITIONS a node in
//     its layout (drop-inside-parent reorder / grid swap). The node's new-slot
//     rect is remeasured a frame or two later (async bridge round-trip), so for
//     that gap the selection overlay would otherwise paint at the STALE drag
//     (cursor) position before snapping to the new slot. `SelectionFade`
//     subscribes, hides on the pulse, and reveals (fades in) once the corners
//     settle.
//
// CRITICAL nuance — the selection overlay is UNMOUNTED while dragging and
// MOUNTS on drop, i.e. AFTER `signal()` has already fired. A live subscription
// alone would miss that edge (the consumer doesn't exist yet when the pulse
// fires). So besides notifying live subscribers (for the rare case the overlay
// IS mounted), we latch a one-shot `_pending` flag the freshly-mounted consumer
// can `consume()` — claiming "a reposition committed just before I mounted".
//
// `_counter` is a monotonically-increasing edge (for any `useSyncExternalStore`
// consumer); `_pending` is the latched one-shot claimed via `consume()`.

let _counter = 0;
let _pending = false;
// Held HIGH from `signal()` until `clearCommitPending()` (Canvas's
// onRenderComplete) — i.e. the whole drag-commit gap. Consumers that must stay
// hidden across that gap read it via `isCommitPending()`: e.g.
// CanvasNodeNameDisplay, where a just-reparented node still reads `isCanvasNode`
// from the stale cache, so its floating name label would flash back on mouseup
// before the commit lands. Distinct from `_pending`, the one-shot SelectionFade
// consume latch.
let _commitPending = false;
const listeners = new Set<() => void>();

export const repositionSignalOps = {
  /** Pulse: a layout reposition just committed. Latches `_pending` + notifies. */
  signal(): void {
    _counter++;
    _pending = true;
    _commitPending = true;
    for (const fn of listeners) fn();
  },
  /**
   * Claim the latched "a reposition just committed" flag. Returns true at most
   * once per `signal()` (then resets), so whichever of the live subscription or
   * the consumer's mount-check runs first handles the hide; the other is a no-op.
   */
  consume(): boolean {
    if (!_pending) return false;
    _pending = false;
    return true;
  },
  /** True from `signal()` until `clearCommitPending()` — the drag-commit gap. */
  isCommitPending(): boolean {
    return _commitPending;
  },
  /** Clear the commit-gap flag (call from onRenderComplete) + notify subscribers. */
  clearCommitPending(): void {
    if (!_commitPending) return;
    _commitPending = false;
    for (const fn of listeners) fn();
  },
  /** Monotonic edge counter (for `useSyncExternalStore` consumers). */
  get(): number {
    return _counter;
  },
  /** Subscribe pattern compatible with `useSyncExternalStore`. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
