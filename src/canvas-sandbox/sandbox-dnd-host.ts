// sandbox-dnd-host.ts — No-op stubs.
//
// Originally this booted `@revyme/canvas-dnd` inside the iframe to handle
// pointer events / hit-testing / overlays. We've since moved all of that
// to Revyme's own selection/drag systems in the parent frame, and
// the canvas-dnd library was removed from the dev workflow. Keeping this
// file as no-op stubs so existing callers (bridge-sandbox.ts and
// canvas-sandbox/main.tsx) compile without touching the import package.
//
// When canvas-dnd is fully expunged from package.json + the imports in
// bridge-sandbox.ts, this file can be deleted entirely.

/** No-op. canvas-dnd is no longer initialized inside the iframe. */
export function initSandboxDnd(_contentEl: HTMLElement, _overlayEl: HTMLElement): void {
  /* canvas-dnd removed — see file header */
}

/** No-op. Parent-frame transform manager + bridge.render handle camera now. */
export function setSandboxDndTransform(_x: number, _y: number, _scale: number): void {
  /* no-op */
}

/** No-op. Hover state lives in `hoveredNodeIdAtom` parent-side. */
export function setSandboxDndHovered(_nodeId: string | null, _viewport?: string): void {
  /* no-op */
}

/** Continuous-interaction flag (element drag / resize / slider in the parent
 *  frame). rect-emit's per-patch SUBTREE refresh — 500+ getBoundingClientRect
 *  + corner computations per style patch on big imports — is gated on this:
 *  during interaction only the PATCHED element re-emits (its overlay must
 *  track), and the gesture-end full render reconciles every cache. Was a
 *  no-op stub: the parent forwarded the signal but the sandbox dropped it,
 *  so big-node drags backlogged the message queue and the visual position
 *  trailed the cursor by seconds (live find 2026-07-15). */
let _sandboxInteracting = false;
let _dragEndTs = 0;

export function setSandboxDndInteracting(interacting: boolean): void {
  // Record when a drag ENDS so post-drag storms (code-component re-mount →
  // ResizeObserver) can be suppressed for a short settle window.
  if (_sandboxInteracting && !interacting && typeof performance !== 'undefined') {
    _dragEndTs = performance.now();
  }
  _sandboxInteracting = interacting;
}

export function isSandboxDndInteracting(): boolean {
  return _sandboxInteracting;
}

/** True during a drag AND for ~1.3s after it ends. The drop's own render +
 *  allRects-measure already captured the settled layout, so the ResizeObserver
 *  storm from code components re-mounting in that window would only re-emit an
 *  identical full measure (~120ms each, twice) — pure waste. The window has to
 *  outlast CDN code-component re-load latency (traced re-mount → resize storms
 *  landing 670-930ms after mouseup on a 3-CDN-component page). */
export function isSandboxDragSettling(): boolean {
  if (_sandboxInteracting) return true;
  return typeof performance !== 'undefined' && (performance.now() - _dragEndTs) < 1300;
}
