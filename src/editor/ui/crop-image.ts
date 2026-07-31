// crop-image.ts — browser-only rasterisation for the image-crop modal. Loads
// the source image WITHOUT tainting the canvas, and cuts a region to a Blob.
// Pure geometry (handle math, coordinate conversion) lives in shared/crop-utils.
//
// Why a byte-fetch instead of `<img crossOrigin>`: a cross-origin CDN image
// loaded straight into an <img> taints the canvas (toBlob then throws), and the
// crossOrigin request often reuses the browser's already-cached NON-cors copy
// (the canvas is on the same page). Fetching the BYTES through the backend media
// proxy (`fetchMediaBytes`) sidesteps CORS entirely (server-to-server in cloud;
// direct fetch in local mode), and loading them from a same-origin `blob:` URL
// is never tainted — so remote images crop in place. A direct crossOrigin load
// is kept as a last-ditch fallback.

import { backend } from '@/backend';
import type { CropRect } from '@/shared/crop-utils';
import { trace } from '@/shared/debug-trace';

export interface LoadedCropImage {
  img: HTMLImageElement;
  /** Same-origin blob URL to render + crop from. null when the fallback direct
   *  load was used (then the original src is the render source). */
  objectUrl: string | null;
}

/** Load one URL into an <img>. `cors` requests CORS mode (needed only for the
 *  direct-load fallback; blob/data URLs ignore it). */
function loadFromUrl(url: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    if (cors) img.crossOrigin = 'anonymous';
    img.src = url;
  });
}

/**
 * Load an image for cropping without canvas taint. Primary path: fetch the
 * bytes via the backend media proxy → load from a same-origin blob URL.
 * Fallback: a direct crossOrigin `<img>` load (may still succeed for a
 * CORS-enabled image endpoint). Caller must `URL.revokeObjectURL(objectUrl)`
 * when done (if non-null).
 */
export async function loadCropImage(src: string): Promise<LoadedCropImage> {
  try {
    const blob = await backend.fetchMediaBytes(src);
    const objectUrl = URL.createObjectURL(blob);
    const img = await loadFromUrl(objectUrl, false);
    trace.action('crop-image:loaded-via-proxy', { bytes: blob.size });
    return { img, objectUrl };
  } catch (err) {
    trace.action('crop-image:proxy-failed-fallback-direct', {
      error: err instanceof Error ? err.message : String(err),
    });
    const img = await loadFromUrl(src, true);
    return { img, objectUrl: null };
  }
}

/** Natural (intrinsic) pixel size of a loaded image. */
export function naturalSize(img: HTMLImageElement): { width: number; height: number } {
  return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}

/** Output MIME: PNG when the source looks like PNG / has no hint (lossless,
 *  keeps alpha); JPEG for jpg sources (far smaller for photos). */
export function cropOutputMime(src: string): 'image/png' | 'image/jpeg' {
  const lower = src.split('?')[0].toLowerCase();
  if (lower.endsWith('.png') || lower.startsWith('data:image/png')) return 'image/png';
  if (/\.jpe?g$/.test(lower) || lower.startsWith('data:image/jpeg') || lower.startsWith('data:image/jpg')) return 'image/jpeg';
  return 'image/png';
}

export interface CroppedResult {
  blob: Blob;
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
}

/**
 * Cut `natCrop` (NATURAL/source pixels) out of an ALREADY-LOADED image and
 * return it as a Blob. The image MUST be untainted (loaded via a blob/data URL
 * or a CORS-clean source) — `toBlob` throws otherwise, which we surface.
 */
export async function cropLoadedImageToBlob(
  img: HTMLImageElement,
  natCrop: CropRect,
  mime: 'image/png' | 'image/jpeg',
): Promise<CroppedResult> {
  const w = Math.max(1, Math.round(natCrop.width));
  const h = Math.max(1, Math.round(natCrop.height));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  ctx.drawImage(img, Math.round(natCrop.x), Math.round(natCrop.y), w, h, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, mime, mime === 'image/jpeg' ? 0.92 : undefined);
    } catch (err) {
      trace.error('crop-image:toBlob-tainted', { error: err instanceof Error ? err.message : String(err) });
      resolve(null);
    }
  });
  if (!blob) throw new Error('crop failed — the image is cross-origin without CORS headers');

  trace.action('crop-image:cropped', { w, h, mime, bytes: blob.size });
  return { blob, width: w, height: h, mime };
}

/**
 * One-shot convenience: load `src` (proxy-safe) and cut `natCrop` out of it.
 * Revokes its own blob URL. Used where the caller doesn't keep the image around.
 */
export async function cropImageToBlob(src: string, natCrop: CropRect): Promise<CroppedResult> {
  const { img, objectUrl } = await loadCropImage(src);
  try {
    return await cropLoadedImageToBlob(img, natCrop, cropOutputMime(src));
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
