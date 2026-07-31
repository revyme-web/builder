// font-loader.ts -- Google Font loader with caching.
// Maintains a global set of loaded fonts, creates <link> tags for Google Fonts CDN.
// Uses document.fonts.ready with 100ms fallback.

import { trace } from './debug-trace';
// Lazy-imported via dynamic import to avoid a circular dependency on
// boot — `canvas-bridge` pulls in iframe machinery that isn't ready
// until after the editor mounts. Callers of `loadGoogleFont` may run
// during early bootstrap (default fonts on page load), so we skip the
// iframe injection if the bridge hasn't initialized yet.
let _getCanvasBridge: (() => { loadFontInIframe?: (url: string) => void }) | null = null;
import('@/canvas/canvas-bridge')
  .then((mod) => { _getCanvasBridge = mod.getCanvasBridge; })
  .catch(() => { /* not available in this context (e.g. tests, ssr) — fine */ });

const loadedFonts = new Set<string>();
const pendingFonts = new Map<string, Promise<void>>();
const fontLoadCallbacks = new Set<() => void>();

/** System fonts that don't need loading from Google Fonts CDN */
const SYSTEM_FONTS = [
  'arial', 'helvetica', 'times new roman', 'georgia', 'verdana',
  'courier new', 'tahoma', 'trebuchet ms', 'comic sans ms', 'impact',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
];

/**
 * Register a callback to be called when any font finishes loading.
 * Returns an unsubscribe function.
 */
function onFontLoad(callback: () => void): () => void {
  fontLoadCallbacks.add(callback);
  trace.fn('font-loader:onFontLoad', { callbackCount: fontLoadCallbacks.size });
  return () => fontLoadCallbacks.delete(callback);
}

/** Notify all registered callbacks that a font has loaded */
function notifyFontLoaded(fontFamily: string) {
  trace.action('font-loader:notify', { fontFamily, callbackCount: fontLoadCallbacks.size });
  fontLoadCallbacks.forEach(cb => {
    try { cb(); } catch (err) { trace.error('font-loader:callback-error', { error: String(err) }); }
  });
}

/**
 * Load a Google Font by creating a <link> in the document head.
 * Skips system fonts. Deduplicates by font name.
 */
export function loadGoogleFont(fontFamily: string): Promise<void> {
  if (!fontFamily) return Promise.resolve();

  // Skip system fonts
  const lower = fontFamily.toLowerCase();
  if (SYSTEM_FONTS.some(sf => lower.includes(sf))) {
    return Promise.resolve();
  }

  // Already loaded
  if (loadedFonts.has(fontFamily)) return Promise.resolve();

  // Already loading — return existing promise
  if (pendingFonts.has(fontFamily)) return pendingFonts.get(fontFamily)!;

  trace.action('font-loader:load-start', { fontFamily });

  const fontUrl = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/ /g, '+')}:wght@100;200;300;400;500;600;700;800;900&display=swap`;

  // Also load into the canvas iframe's document head — its document is
  // SEPARATE from the parent's, so a `<link>` in `document.head` doesn't
  // cascade into the iframe and any text inside the canvas falls back to
  // the parent stack until commit time. Idempotent: skip if a `<link>` for
  // this URL is already attached. Safe to call before the iframe is
  // available (no-op then; commit later still loads via globals.css).
  injectFontIntoCanvasIframe(fontUrl);

  const promise = new Promise<void>((resolve) => {
    const link = document.createElement('link');
    link.href = fontUrl;
    link.rel = 'stylesheet';

    link.onload = () => {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          loadedFonts.add(fontFamily);
          pendingFonts.delete(fontFamily);
          trace.action('font-loader:loaded', { fontFamily, method: 'document.fonts.ready' });
          notifyFontLoaded(fontFamily);
          resolve();
        });
      } else {
        // Fallback for browsers without document.fonts
        setTimeout(() => {
          loadedFonts.add(fontFamily);
          pendingFonts.delete(fontFamily);
          trace.action('font-loader:loaded', { fontFamily, method: 'timeout-fallback' });
          notifyFontLoaded(fontFamily);
          resolve();
        }, 100);
      }
    };

    link.onerror = () => {
      // Still mark as loaded on error so we don't block or retry
      loadedFonts.add(fontFamily);
      pendingFonts.delete(fontFamily);
      trace.error('font-loader:load-error', { fontFamily });
      resolve();
    };

    document.head.appendChild(link);
  });

  pendingFonts.set(fontFamily, promise);
  return promise;
}

/** Inject the given Google Fonts URL into the canvas iframe's document
 *  head so text rendered by the sandbox renderer can resolve the face.
 *
 *  Cross-origin path: parent at 3333 can't reach into the iframe at
 *  5174 directly (`iframe.contentDocument` returns `null` for
 *  cross-origin frames despite the `allow-same-origin` sandbox token —
 *  that token preserves the iframe's OWN origin, it doesn't merge it
 *  with the parent's). The bridge ships a Comlink-backed
 *  `loadFontInIframe` that lets the iframe append the `<link>` to its
 *  own `document.head`. Idempotency lives on the iframe side too. */
function injectFontIntoCanvasIframe(fontUrl: string): void {
  if (!_getCanvasBridge) return;
  const bridge = _getCanvasBridge();
  bridge.loadFontInIframe?.(fontUrl);
  trace.action('font-loader:iframe-link-requested', { fontUrl });
}

/**
 * Extract font name from a CSS font-family value and load it.
 * e.g. "'Syne', sans-serif" -> loads "Syne"
 */
export function loadFontFromCSSValue(value: string): Promise<void> {
  if (!value) return Promise.resolve();

  const fontName = value.split(',')[0].trim().replace(/['"]/g, '');
  trace.fn('font-loader:loadFromCSS', { rawValue: value, extracted: fontName });
  return loadGoogleFont(fontName);
}

/** `@font-face` format() hint inferred from a font file url/extension. */
function formatHintFromUrl(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  return ext === 'woff2' ? 'woff2'
    : ext === 'woff' ? 'woff'
    : ext === 'otf' ? 'opentype'
    : 'truetype';
}

/**
 * Load a custom (workspace) font via the FontFace API so it renders in the
 * EDITOR document — the font picker previews each workspace font in its own
 * typeface. Deduped by family+weight+style; idempotent. Notifies onFontLoad
 * listeners on success so open pickers repaint.
 *
 * NOTE: this registers the face in the PARENT document only (where the picker
 * and editor chrome live). Rendering a workspace font INSIDE the canvas iframe
 * and persisting it to a published site is the separate "apply to project"
 * flow (copy the file into the project FS + write @font-face into globals.css).
 */
export function loadCustomFont(args: {
  family: string; url: string; weight?: number; style?: 'normal' | 'italic';
}): Promise<void> {
  const { family, url, weight = 400, style = 'normal' } = args;
  const key = `custom:${family}__${weight}__${style}`;
  if (loadedFonts.has(key)) return Promise.resolve();
  const inFlight = pendingFonts.get(key);
  if (inFlight) return inFlight;

  if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
    return Promise.resolve();
  }

  const p = (async () => {
    try {
      const face = new FontFace(family, `url("${url}") format("${formatHintFromUrl(url)}")`, {
        weight: String(weight),
        style,
        display: 'swap',
      });
      const loaded = await face.load();
      document.fonts.add(loaded);
      loadedFonts.add(key);
      trace.action('font-loader:custom-loaded', { family, weight, style });
      notifyFontLoaded(family);
    } catch (err) {
      trace.error('font-loader:custom-failed', { family, url, error: String(err) });
    } finally {
      pendingFonts.delete(key);
    }
  })();
  pendingFonts.set(key, p);
  return p;
}
