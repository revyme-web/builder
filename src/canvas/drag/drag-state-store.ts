// drag-state-store.ts — Module-level "is an element drag in progress?"
// signal, exposed via the standard subscribe-based pattern so React
// components can read it via `useSyncExternalStore`.
//
// Why not a Jotai atom: writing from DragCoordinator (which lives
// outside the React tree) into a Jotai atom requires a store
// reference, but `getDefaultStore()` returns a DIFFERENT store than
// main.tsx's `<Provider>`-scoped store — writes there are invisible
// to subscribers in the rendered tree. Other live-state signals on
// the canvas (parent-highlight, drop-line, etc.) use this same
// vanilla pattern for the same reason.
//
// What this signal is FOR vs `canvasInteractingAtom`:
//   - `canvasInteractingAtom` flips true on ANY canvas-level
//     interaction, including pure camera pan/zoom (the
//     `transformManager.subscribe` callback in Canvas.tsx fires it).
//     Useful for visual helpers that should fade on any motion.
//   - This atom flips true ONLY when an actual ELEMENT drag is in
//     progress (DragCoordinator's `isDragStarted`). Useful for
//     consumers that need to react to element movement specifically
//     — e.g. PositionTool's live-poll, which should NOT show
//     "live" position values during a camera pan (the cache lags
//     the parent transform by one frame, so the math gives garbage
//     numbers that move randomly with the pan).

let _isDragging = false;
const listeners = new Set<() => void>();

export const dragStateOps = {
  /** Update the in-progress flag. Notifies subscribers synchronously. */
  set(v: boolean): void {
    if (_isDragging === v) return;
    _isDragging = v;
    for (const fn of listeners) fn();
  },
  /** Snapshot read used by `useSyncExternalStore`. */
  get(): boolean {
    return _isDragging;
  },
  /** Subscribe pattern compatible with `useSyncExternalStore`. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
