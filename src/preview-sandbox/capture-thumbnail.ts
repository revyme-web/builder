// capture-thumbnail.ts — On a `preview:capture-thumbnail` request from the
// parent editor, snapshot the rendered preview page to a small JPEG and post
// the data URL back as `preview:thumbnail`. Runs entirely inside the :5175
// iframe so the editor's main thread is never touched. The capture is
// deferred (fonts.ready + requestIdleCallback) so it never competes with the
// preview's own paint — that's the "must not slow down preview" constraint.
//
// Replaces the puppeteer screenshot-service: the preview iframe already holds
// a real React render of the user's site, so we snapshot that directly.
//
// Uses console (not the editor's `trace`) to match the rest of preview-sandbox,
// which is its own iframe world and doesn't participate in the canvas debug bus.

let capturing = false;

// How long to wait for entrance animations to finish before snapshotting.
// Appear/scroll-reveal animations (framer-motion initial→whileInView, slow hero
// fades/scales) start at mount and the capture request arrives right after the
// preview mounts — so an immediate snapshot catches the hero at opacity:0 and
// the thumbnail comes out black/blank. This covers the common case incl. a
// ~2.3s hero fade. Bump it if your slowest entrance animation is longer.
const SETTLE_MS = 2200;

/** Resolve the body's effective background — JPEG has no alpha, so a
 *  transparent body would otherwise come out black. */
function opaqueBackground(): string {
  const bg = getComputedStyle(document.body).backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  if (htmlBg && htmlBg !== 'transparent' && htmlBg !== 'rgba(0, 0, 0, 0)') return htmlBg;
  return '#ffffff';
}

/** Wait for the browser to be idle (or a short fallback) so the capture
 *  never competes with the preview's render/paint. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 300);
  });
}

/** Output width the thumbnail raster targets. Dashboard cards render a few
 *  hundred px wide — 900 covers retina cards with room to spare. */
const THUMB_WIDTH = 900;

/** pixelRatio for the capture: scales the raster down to ~THUMB_WIDTH wide.
 *  Never upscales (capped at 1). Pure — unit tested. */
export function captureScale(scrollWidth: number): number {
  if (!scrollWidth || scrollWidth <= 0) return 1;
  return Math.min(1, THUMB_WIDTH / scrollWidth);
}

/** Snapshot `document.body` (the user's rendered site — globals.css background
 *  plus the #root tree) to a downscaled JPEG data URL and post it to the
 *  parent. Best-effort: a failure just means the thumbnail isn't refreshed.
 *  Re-entrant guard — overlapping requests are ignored. */
export async function captureThumbnail(): Promise<void> {
  if (capturing) return;
  capturing = true;
  try {
    // Let web fonts settle so text isn't snapshotted mid-swap.
    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
    // Then let entrance animations finish (else a fading-in hero captures black).
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
    await whenIdle();

    const { toJpeg } = await import('html-to-image');
    const body = document.body;
    // Full-page capture, DOWNSCALED — the dashboard wants a tall, full-length
    // thumbnail, but it renders in a card a few hundred px wide, so native
    // resolution was pure waste. The old native-res + cacheBust capture froze
    // the PREVIEW's main thread for seconds (deep DOM clone + per-node style
    // inlining + re-downloading EVERY image with a ?<timestamp> buster +
    // rasterizing a ~1440×8000 canvas) — it landed ~4-5s after the preview
    // opened, right when the user starts interacting, and read as "the page
    // freezes when I hover" (live find 2026-07-07). pixelRatio shrinks the
    // raster to ~THUMB_WIDTH wide (≈6-10× fewer pixels); dropping cacheBust
    // reuses the browser's image cache instead of re-fetching every asset
    // (a host whose cached response lacks CORS headers just skip-embeds that
    // one image — thumbnails are best-effort).
    const dataUrl = await toJpeg(body, {
      quality: 0.85,
      pixelRatio: captureScale(body.scrollWidth),
      width: body.scrollWidth,
      height: body.scrollHeight || window.innerHeight,
      backgroundColor: opaqueBackground(),
    });
    parent.postMessage({ type: 'preview:thumbnail', dataUrl }, '*');
  } catch (err) {
    console.warn('[preview] thumbnail capture failed', err);
  } finally {
    capturing = false;
  }
}
