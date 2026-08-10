// camera-move-store.ts — "is the CAMERA moving?" (pan / zoom), as opposed to
// the user manipulating a node.
//
// `canvasInteractingAtom` cannot answer this. It flips true for BOTH — a node
// drag/resize and a pure camera pan/zoom all set it (the
// `transformManager.subscribe` callback in useCanvasTransform), which is
// deliberate for helpers that should fade on any motion. But some overlays are
// about the NODE, not the canvas, and should disappear while the camera moves:
// `SelectionOverlay` hides its handles during any interaction and draws a thin
// `<InteractionOutline/>` instead, so a two-finger scroll left a blue outline
// floating over the design with nothing to explain it (user report 2026-08-10).
// The space-bar / hand-tool pan already hid everything via `panHighlightAtom`;
// wheel and trackpad had no equivalent.
//
// Set ONLY by the transform subscriber, and cleared on the same debounce, so
// it tracks the camera exactly. It is NOT a substitute for
// `canvasInteractingAtom` (a slider scrub moves no camera) nor for
// `dragStateOps` (an auto-panning drag moves both) — read it together with
// those to tell "camera only" from "camera because of a gesture".
//
// Vanilla subscribe/getSnapshot, not a Jotai atom, for the same reason
// `drag-state-store` is: the writer lives outside the React tree, where
// `getDefaultStore()` is a different store than main.tsx's `<Provider>`.

let _isMoving = false;
const listeners = new Set<() => void>();

export const cameraMoveOps = {
  /** Update the flag. Notifies subscribers synchronously; no-ops when unchanged. */
  set(v: boolean): void {
    if (_isMoving === v) return;
    _isMoving = v;
    for (const fn of listeners) fn();
  },
  /** Snapshot read for `useSyncExternalStore` and imperative callers. */
  get(): boolean {
    return _isMoving;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
