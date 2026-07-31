// image-dims.ts — Natural-size reading + insert-box fitting for images
// entering the canvas from OUTSIDE the project (OS file drop, browser
// image-URL drop, clipboard paste).
//
// Every one of those paths has the same two problems: the source image's
// aspect ratio is unknown until it decodes, and the inserted node needs a
// sane on-canvas size that doesn't crop the image. Both helpers live here
// so all entry points produce an identically-sized node — CanvasFileDrop
// and image-paste previously each had their own answer, and the paste one
// (a fixed 200x150 box) cropped anything that wasn't 4:3.

import { trace } from '@/shared/debug-trace';

/** Longest-side cap for an inserted image (canvas px), plus the fallback
 *  box used when the image's natural size can't be read. */
export const MAX_DROP_SIZE = 400;
export const DEFAULT_DROP_W = 320;
export const DEFAULT_DROP_H = 200;

/** How long to wait for a URL to decode before giving up and falling back
 *  to the default box. Keeps a slow/blocked remote URL from hanging an
 *  insert indefinitely. */
const DIMS_TIMEOUT_MS = 4000;

/** Load an image's natural dimensions. Reading naturalWidth/Height is NOT
 *  a tainting pixel read, so it works cross-origin. Resolves null on error
 *  or after a timeout so a slow/blocked URL can't hang the insert. */
export function getImageDimensions(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (v: { w: number; h: number } | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), DIMS_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); finish(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null); };
    img.onerror = () => { clearTimeout(timer); finish(null); };
    img.src = url;
  });
}

/** Read natural dimensions straight from an in-memory Blob/File via an
 *  object URL. Used by the clipboard-paste path, which holds the bytes
 *  before it has any hosted URL — avoids a round-trip back to R2 just to
 *  learn the aspect ratio. Always revokes the object URL. */
export async function getBlobImageDimensions(blob: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof URL === 'undefined' || !URL.createObjectURL) return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const dims = await getImageDimensions(objectUrl);
    trace.action('image-dims:blob-read', { size: blob.size, type: blob.type, w: dims?.w ?? null, h: dims?.h ?? null });
    return dims;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Insert box that preserves the image's aspect ratio within
 *  MAX_DROP_SIZE. Images smaller than the cap keep their natural size
 *  (scale is clamped to 1 — we never upscale). */
export function fitFrameBox(dims: { w: number; h: number } | null): { width: number; height: number } {
  if (!dims || dims.w <= 0 || dims.h <= 0) return { width: DEFAULT_DROP_W, height: DEFAULT_DROP_H };
  const scale = Math.min(1, MAX_DROP_SIZE / Math.max(dims.w, dims.h));
  return { width: Math.max(1, Math.round(dims.w * scale)), height: Math.max(1, Math.round(dims.h * scale)) };
}
