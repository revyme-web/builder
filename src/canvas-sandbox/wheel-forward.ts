// wheel-forward.ts — hand every wheel / trackpad pinch inside the canvas iframe
// to the parent's camera.
//
// The iframe is `pointer-events: none`, so a wheel normally lands on the
// parent's canvas container and pans / zooms the camera. Text edit and vector
// edit flip the iframe to `pointer-events: auto` (clicks must reach the content),
// and from then on every wheel lands HERE instead. Nothing handled it: a pinch —
// which the browser synthesises as a ctrl-wheel — fell through to the browser's
// default and zoomed the whole editor page instead of the canvas.
//
// So: swallow it and post it to the parent, where useCanvasTransform's
// `onIframeWheel` feeds it to the same `handleWheel` a wheel over the canvas
// gets. The gesture behaves identically whether or not the iframe is taking
// clicks. Coordinates stay iframe-local; the parent adds the iframe's offset
// (the iframe is never scaled — the camera transform lives inside it).

/** The message the parent's `onIframeWheel` listener reads. */
export interface ForwardedWheel {
  type: 'wheel';
  deltaX: number;
  deltaY: number;
  /** 0 = pixels (trackpad), 1 = lines (Firefox mouse wheel) — tunes pinch vs wheel zoom speed. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
}

/** Install the forwarder on `win`. Returns a disposer. */
export function installWheelForwarding(
  win: Window,
  post: (msg: ForwardedWheel) => void,
): () => void {
  const onWheel = (e: WheelEvent) => {
    // Never let the browser act on it — that is the page zoom (pinch) or a
    // scroll of the iframe document. The parent owns the camera.
    e.preventDefault();
    post({
      type: 'wheel',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };
  // `passive: false` — a passive listener can't preventDefault, and the pinch
  // would still zoom the page.
  win.addEventListener('wheel', onWheel, { passive: false });
  return () => win.removeEventListener('wheel', onWheel);
}
