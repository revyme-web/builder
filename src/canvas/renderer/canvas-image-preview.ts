// canvas-image-preview.ts — CANVAS-ONLY downscaled image previews.
//
// A page full of camera-resolution photos makes the canvas slow twice over:
// every structural re-render re-decodes multi-megapixel bitmaps (the renderer
// rebuilds subtrees with replaceChildren), and the compositor drags the full
// bitmaps under the pan/zoom transform every frame. The LIVE site is fine —
// browsers there lazy-load and rarely rebuild — but a design surface rebuilds
// constantly.
//
// This module swaps the PAINTED image for a downscaled preview while leaving
// the SOURCE untouched: node attrs, generated code and the published site keep
// the original URL; only the sandbox DOM shows the preview. Same philosophy as
// the canvas video freeze (Renderer.ts): a container-level MutationObserver,
// so it catches every image however it enters — node render, code component,
// CMS binding, slot child — not just what the Renderer's own attr path writes.
//
// What gets a preview: http(s)/relative raster images whose long edge exceeds
// MAX_PREVIEW_EDGE and that the iframe is allowed to read (same-origin or
// CORS-clean). Everything else — SVG (scales free), GIF (animation would
// flatten), data:/blob: URLs, CORS-opaque hosts, small images — keeps the
// original: quality only ever drops where it buys real memory back.
//
// The swap must not fight the Renderer's diff loops (they compare the DOM
// value against the node value and would restore the original every patch,
// re-decoding the full bitmap each cycle — the exact cost this avoids). Two
// guards make the swap invisible to diffing:
//   • <img src>: `isPreviewAppliedSrc` in the patch attr loop.
//   • backgroundImage: `setElStyle` skips a write when the element already
//     paints this exact original's preview (dataset pair below).
// Element bookkeeping lives in data- attrs:
//   data-cip-src    — original src an <img>'s preview replaces
//   data-cip-srcset — the applied preview src (blob: or /cdn-cgi/image/ URL)
//   data-cip-bg     — original backgroundImage value the preview replaces
//   data-cip-bgset  — the swapped value as CSSOM re-serialized it (read back
//                     after the write, since the browser normalizes quoting)

import { trace } from '@/shared/debug-trace';

/** Long edge of a preview bitmap. 1600px keeps a 2× grid tile / half-screen
 *  image pixel-exact; a full-bleed hero inspected at 100% on retina reads
 *  slightly soft — the accepted trade for grids of photos staying 60fps. */
export const MAX_PREVIEW_EDGE = 1600;
/** Preview quality — one knob for BOTH the edge resize (as a 0–100 percent)
 *  and the client-side WebP encode (as a 0–1 fraction). */
const PREVIEW_QUALITY = 0.25;
/** Parallel downscale jobs — a 50-image gallery must not stampede the
 *  network/decoder; the rest queue. */
const MAX_CONCURRENT = 4;

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────

/** Is this URL a candidate for previewing? data:/blob: are already local;
 *  SVG is resolution-free; GIF previews would freeze the animation; a
 *  /cdn-cgi/image/ URL is already a transformed preview. The extension check
 *  is a pre-filter — the fetch result's MIME is re-checked. */
export function shouldPreviewUrl(url: string): boolean {
  const u = url.trim();
  if (!u || u.startsWith('data:') || u.startsWith('blob:')) return false;
  if (u.includes('/cdn-cgi/image/')) return false;
  if (!/^(https?:)?\/\//.test(u) && !u.startsWith('/') && !u.startsWith('.')) return false;
  if (/\.(svg|gif)(\?|#|$)/i.test(u)) return false;
  return true;
}

// ─── Edge resize (Cloudflare Image Transformations) ─────────────────────
// For images hosted on the revyme.app zone, the canvas never needs the full
// original: Cloudflare's `/cdn-cgi/image/` endpoint (Transformations enabled
// on the zone, "this zone only" sources) serves an edge-resized WebP/AVIF, so
// the first load downloads ~100KB instead of the multi-MB camera file. Other
// hosts keep the client-side downscale pipeline below.

/** Hosts whose images can be rewritten through the zone's edge resizer. */
const EDGE_RESIZE_HOST = /(^|\.)revyme\.app$/i;

/** Rewrite an image URL to its edge-resized preview form, or null when the
 *  host isn't behind the zone resizer. fit=scale-down + both dimensions =
 *  contain-style downscale, never upscaled, never cropped. `edgePx` sizes the
 *  bounding box — the canvas uses the default; the layers panel asks for a
 *  tiny thumbnail variant. */
export function edgeResizeUrl(url: string, edgePx: number = MAX_PREVIEW_EDGE): string | null {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/');
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!EDGE_RESIZE_HOST.test(u.hostname)) return null;
    if (u.pathname.startsWith('/cdn-cgi/')) return null;
    const opts = `width=${edgePx},height=${edgePx},fit=scale-down,quality=${Math.round(PREVIEW_QUALITY * 100)},format=auto`;
    return `${u.origin}/cdn-cgi/image/${opts}/${u.toString()}`;
  } catch {
    return null;
  }
}

/** Edge health latch: after this many consecutive probe failures (feature
 *  toggled off, quota exhausted) stop trying the edge for the session and
 *  let every image fall through to the client-side pipeline. */
const EDGE_MAX_FAILURES = 3;
let edgeFailureStreak = 0;

/** Load-probe an edge URL as an actual image. Doubles as cache warmup — the
 *  swap that follows hits the browser's HTTP cache, not the network. Image()
 *  load/error events work cross-origin, no CORS needed. */
function probeImage(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = new Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

/** Extract every url(...) token from a CSS background-image value —
 *  quote-aware, multi-layer aware (`linear-gradient(...), url("a.jpg")`). */
export function extractCssUrls(value: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (u) out.push(u);
  }
  return out;
}

/** Rewrite url(...) tokens through `resolve` (original → preview URL, or null
 *  to keep). Returns the swapped value, or null when nothing changed. */
export function swapCssUrls(value: string, resolve: (url: string) => string | null): string | null {
  let changed = false;
  const swapped = value.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g,
    (whole, dq, sq, bare) => {
      const orig = ((dq ?? sq ?? bare) || '').trim();
      const next = orig ? resolve(orig) : null;
      if (!next || next === orig) return whole;
      changed = true;
      return `url("${next}")`;
    },
  );
  return changed ? swapped : null;
}

// ─── Preview cache ────────────────────────────────────────────────────────

/** original URL → preview blob URL, or null = keep the original (small /
 *  vector / animated / unreadable). Session-lifetime; blob URLs are never
 *  revoked while the canvas lives — every re-render reuses them, which is
 *  the whole point. */
const previewCache = new Map<string, string | null>();
const pendingJobs = new Map<string, Promise<string | null>>();
let runningJobs = 0;
const jobQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (runningJobs < MAX_CONCURRENT) { runningJobs++; return Promise.resolve(); }
  return new Promise(res => jobQueue.push(() => { runningJobs++; res(); }));
}
function releaseSlot(): void {
  runningJobs--;
  jobQueue.shift()?.();
}

async function buildPreview(url: string): Promise<string | null> {
  await acquireSlot();
  try {
    // credentials omitted: previews must never leak cookies to image hosts,
    // and the sandbox origin isn't the app origin anyway.
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!/^image\//.test(blob.type)) return null;
    if (blob.type === 'image/svg+xml' || blob.type === 'image/gif') return null;
    const bmp = await createImageBitmap(blob);
    try {
      const long = Math.max(bmp.width, bmp.height);
      if (long <= MAX_PREVIEW_EDGE) return null;
      const scale = MAX_PREVIEW_EDGE / long;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const cnv = new OffscreenCanvas(w, h);
      const ctx = cnv.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, w, h);
      const out = await cnv.convertToBlob({ type: 'image/webp', quality: PREVIEW_QUALITY });
      trace.action('canvas-image-preview:built', {
        url: url.slice(0, 120), from: `${bmp.width}x${bmp.height}`, to: `${w}x${h}`,
        origBytes: blob.size, previewBytes: out.size,
      });
      return URL.createObjectURL(out);
    } finally {
      bmp.close();
    }
  } catch {
    // CORS-opaque host, decode failure, unsupported type — keep the original.
    return null;
  } finally {
    releaseSlot();
  }
}

/** Resolve (and memoize) the preview for a URL. Null = use the original.
 *  Degradation chain: edge resize (zone-hosted, no full download at all) →
 *  client-side downscale (full download once, small bitmap thereafter) →
 *  original. */
function ensurePreview(url: string): Promise<string | null> {
  if (previewCache.has(url)) return Promise.resolve(previewCache.get(url) ?? null);
  const pending = pendingJobs.get(url);
  if (pending) return pending;
  const job = (async () => {
    const edge = edgeFailureStreak < EDGE_MAX_FAILURES ? edgeResizeUrl(url) : null;
    if (edge) {
      if (await probeImage(edge)) {
        edgeFailureStreak = 0;
        previewCache.set(url, edge);
        pendingJobs.delete(url);
        trace.action('canvas-image-preview:edge', { url: url.slice(0, 120) });
        return edge;
      }
      // Resizer refused (feature off / quota / non-image) — fall through to
      // the client pipeline; latch off after repeated failures.
      edgeFailureStreak++;
      trace.action('canvas-image-preview:edge-failed', { url: url.slice(0, 120), streak: edgeFailureStreak });
    }
    const result = await buildPreview(url);
    previewCache.set(url, result);
    pendingJobs.delete(url);
    return result;
  })();
  pendingJobs.set(url, job);
  return job;
}

/** Synchronous cache lookup (undefined = not built yet). */
function cachedPreview(url: string): string | null | undefined {
  return previewCache.get(url);
}

// ─── Renderer diff guards ─────────────────────────────────────────────────

/** True when `el` already paints the PREVIEW of `desiredSrc` — the Renderer's
 *  attr diff treats that as "src applied" instead of restoring the original
 *  (which would re-decode the full bitmap on every patch). The preview may be
 *  a blob URL (client downscale) or a /cdn-cgi/image/ URL (edge resize). */
export function isPreviewAppliedSrc(el: Element, desiredSrc: string): boolean {
  const d = (el as HTMLElement).dataset;
  return d?.cipSrc === desiredSrc && !!d.cipSrcset
    && el.getAttribute('src') === d.cipSrcset;
}

/** backgroundImage twin of isPreviewAppliedSrc, used by setElStyle. */
export function isPreviewAppliedBg(el: HTMLElement, desiredValue: string): boolean {
  return el.dataset.cipBg === desiredValue
    && !!el.dataset.cipBgset
    && el.style.backgroundImage === el.dataset.cipBgset;
}

// ─── DOM wiring ───────────────────────────────────────────────────────────

function visitImg(img: HTMLImageElement): void {
  // With a srcset the browser paints a srcset candidate, not src — a src
  // swap would be inert. Leave responsive images (code components) alone.
  if (img.hasAttribute('srcset')) return;
  const src = img.getAttribute('src') || '';
  if (!shouldPreviewUrl(src)) return;
  if (isPreviewAppliedSrc(img, src)) return;
  // An image the builder didn't size renders at its NATURAL dimensions —
  // swapping in a smaller intrinsic bitmap would reflow it. Builder-authored
  // image nodes always carry explicit sizing; naturals (some code components)
  // keep the original.
  if (!img.style.width && !img.style.height && !img.getAttribute('width') && !img.getAttribute('height')) return;
  void ensurePreview(src).then(preview => {
    if (!preview) return;
    // Re-check — the node may have been re-pointed while we downscaled.
    if (img.getAttribute('src') !== src) return;
    img.dataset.cipSrc = src;
    img.dataset.cipSrcset = preview;
    img.src = preview;
  });
}

function visitBg(el: HTMLElement): void {
  const bg = el.style.backgroundImage;
  if (!bg || !bg.includes('url(')) {
    // Fill removed — drop stale bookkeeping so a future identical value
    // isn't mis-judged as already applied.
    if (el.dataset.cipBg) { delete el.dataset.cipBg; delete el.dataset.cipBgset; }
    return;
  }
  if (bg === el.dataset.cipBgset) return; // our own swap echoing back
  const urls = extractCssUrls(bg).filter(shouldPreviewUrl);
  if (urls.length === 0) return;
  void Promise.all(urls.map(ensurePreview)).then(() => {
    if (el.style.backgroundImage !== bg) return; // value moved on mid-flight
    const swapped = swapCssUrls(bg, u => cachedPreview(u) ?? null);
    if (!swapped) return;
    el.dataset.cipBg = bg;
    el.style.backgroundImage = swapped;
    // Read back — CSSOM normalizes url() quoting, and the guard compares
    // against what the browser actually stores.
    el.dataset.cipBgset = el.style.backgroundImage;
  });
}

function scan(root: Element): void {
  if (root instanceof HTMLImageElement) visitImg(root);
  else if (root instanceof HTMLElement && root.style.backgroundImage.includes('url(')) visitBg(root);
  root.querySelectorAll('img').forEach(img => visitImg(img as HTMLImageElement));
  root.querySelectorAll('[style*="url("]').forEach(el => {
    if (el instanceof HTMLElement) visitBg(el);
  });
}

/**
 * Install the canvas-wide preview observer on the sandbox content container.
 * Idempotent per container (same pattern as the video freeze). Catches every
 * image however it's added, and re-applies instantly from cache when culling
 * or a structural re-render recreates elements.
 */
export function initCanvasImagePreview(container: HTMLElement): void {
  if ((container as any).__imgPreview) return;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
  scan(container);
  const obs = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach(n => { if (n instanceof Element) scan(n); });
      } else if (r.target instanceof HTMLImageElement && r.attributeName === 'src') {
        visitImg(r.target);
      } else if (r.target instanceof HTMLElement && r.attributeName === 'style') {
        visitBg(r.target);
      }
    }
  });
  obs.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
  (container as any).__imgPreview = obs;
  trace.action('canvas-image-preview:init');
}
