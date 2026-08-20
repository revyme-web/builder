// transform/CameraCommands.ts — High-level camera operations.
// zoomIn, zoomOut, zoomTo100, zoomToFit, zoomToSelection, panToNode, etc.
// These are pure functions ready to be wired to keyboard shortcuts, toolbar buttons, etc.
// None of them wire any keyboard events — that's for a future KeyboardManager.

import { transformManager } from './TransformManager';
import { animateCanvasTo, moveCanvasTo } from './CameraAnimator';
import {
  ZOOM_STEP, FIT_MIN_SCALE, FIT_MAX_SCALE, FIT_PADDING,
  ANIM_ZOOM_STEP, ANIM_ZOOM_TO_100, ANIM_ZOOM_TO_FIT, ANIM_PAN_TO_NODE,
  MIN_SCALE, MAX_SCALE,
} from './constants';
import { clamp } from '@/canvas/canvas-math';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getViewportPrefix, parseRectCacheKey } from '@/canvas/node-ops';
import { screenRectToCanvas, getIframeOffset } from '@/canvas/drag/helpers/coords';
import { trace } from '@/shared/debug-trace';
import { getDefaultStore } from 'jotai';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { getNodesSnapshot } from '@/code/stores/store';

// Track mouse position globally so zoom commands can anchor to cursor
let lastMouseX = typeof window !== 'undefined' ? window.innerWidth / 2 : 0;
let lastMouseY = typeof window !== 'undefined' ? window.innerHeight / 2 : 0;

if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
}

/** Get the available canvas area (accounting for sidebars/header). Override via setCanvasInsets. */
let canvasInsets = { left: 308, top: 52, right: 260, bottom: 0 };

export function setCanvasInsets(insets: { left: number; top: number; right: number; bottom: number }): void {
  canvasInsets = insets;
}

function getAvailableArea() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
  // FULL-BLEED canvas (glass chrome, 2026-08-20): the container's ORIGIN is
  // (0, 0) — it spans the whole window and BOTH side slabs float OVER it, so
  // container-relative and screen coordinates are the same thing now.
  //   centerX: screen center of the visible strip between the slabs
  //            → left + width / 2. (Before full-bleed the container started
  //            AT the left panel's edge, the inset cancelled out, and this
  //            was width / 2 — that stale cancellation shifted every fit
  //            ~284px left once the origin moved: the "enter master lands
  //            half behind the left panel" report.)
  //   centerY: screen center of the strip BELOW the header
  //            → top + height / 2. The old `height / 2` ignored the header,
  //            biasing every fit ~half-a-header too HIGH (part of the
  //            "new site's viewport sits top-right" report, 2026-07-29).
  const width = w - canvasInsets.left - canvasInsets.right;
  const height = h - canvasInsets.top - canvasInsets.bottom;
  const centerX = canvasInsets.left + width / 2;
  const centerY = canvasInsets.top + height / 2;
  return { width, height, centerX, centerY };
}

// ─── Zoom Commands ──────────────────────────────────────────────────────────

/** Zoom in by ZOOM_STEP (10%) towards mouse cursor. Animated. */
export function zoomIn(): void {
  const t = transformManager.getTransform();
  const newScale = Math.min(t.scale + ZOOM_STEP, MAX_SCALE);
  const target = computeZoomTransform(t, newScale, lastMouseX, lastMouseY);
  trace.fn('camera.zoomIn', { from: t.scale, to: newScale });
  animateCanvasTo(target.x, target.y, target.scale, ANIM_ZOOM_STEP);
}

/** Zoom out by ZOOM_STEP (10%) towards mouse cursor. Animated. */
export function zoomOut(): void {
  const t = transformManager.getTransform();
  const newScale = Math.max(t.scale - ZOOM_STEP, MIN_SCALE);
  const target = computeZoomTransform(t, newScale, lastMouseX, lastMouseY);
  trace.fn('camera.zoomOut', { from: t.scale, to: newScale });
  animateCanvasTo(target.x, target.y, target.scale, ANIM_ZOOM_STEP);
}

/** Zoom to 100%, keeping viewport center fixed. Animated. */
export function zoomTo100(): void {
  const t = transformManager.getTransform();
  const { centerX, centerY } = getAvailableArea();
  const target = computeZoomTransform(t, 1, centerX, centerY);
  trace.fn('camera.zoomTo100');
  animateCanvasTo(target.x, target.y, target.scale, ANIM_ZOOM_TO_100);
}

/** Zoom to a specific scale, anchored at viewport center. Animated. */
export function zoomToScale(scale: number): void {
  const t = transformManager.getTransform();
  const clamped = clamp(scale, MIN_SCALE, MAX_SCALE);
  const { centerX, centerY } = getAvailableArea();
  const target = computeZoomTransform(t, clamped, centerX, centerY);
  trace.fn('camera.zoomToScale', { scale: clamped });
  animateCanvasTo(target.x, target.y, target.scale, ANIM_ZOOM_TO_100);
}

// ─── Fit Commands ───────────────────────────────────────────────────────────

/**
 * Zoom to fit ALL visible content on canvas. Animated.
 * Finds bounding box of all data-node-id elements and fits them in view.
 */
export function zoomToFit(contentEl: HTMLElement, instant?: boolean): void {
  trace.fn('camera.zoomToFit', { instant });
  const bounds = getContentBounds(contentEl);
  if (!bounds) return;
  fitBoundsInView(bounds, FIT_PADDING, instant ? 0 : ANIM_ZOOM_TO_FIT);
}

/** Fit ALL content NOW using whatever the bridge rect-cache currently holds.
 *  Returns false when the cache has no usable rects yet (caller can retry on
 *  the next render). Instant — no camera tween. `getContentBounds` ignores
 *  its element arg (it reads the bridge cache), so no DOM ref needed.
 *  Exported (as `fitAllIfCacheReady`) for the camera-persist first-load path,
 *  which runs INSIDE a render-complete handler — the cache is already fresh
 *  there, so waiting for ANOTHER render (fitAllOnNextRender) could stall on
 *  an idle project. */
export function fitAllIfCacheReady(): boolean {
  return fitAllNow();
}
function fitAllNow(): boolean {
  const bounds = getContentBounds(document.documentElement);
  if (!bounds) return false;
  fitBoundsInView(bounds, FIT_PADDING, 0);
  return true;
}

/** Imperatively hide / show the canvas iframe (the GLITCH FIX). Set on the
 *  iframe ELEMENT, not the wrapper div — React reconciles the wrapper's
 *  `style` on every Canvas render and would wipe an imperative opacity, but
 *  the iframe's style prop is static, so the write survives. Same trick
 *  component-navigation uses for master entry. */
function hideCanvasIframe(): HTMLElement | null {
  const iframe = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
  if (iframe) iframe.style.opacity = '0';
  return iframe;
}
function revealCanvasIframe(iframe: HTMLElement | null): void {
  // Extra rAF before un-hiding: lets the bridge push fresh rects and the
  // browser paint the NEW camera first, so reveal shows the page already at
  // the right pan/zoom (mirrors component-nav's `restoreOnNextPaint`).
  requestAnimationFrame(() => { if (iframe) iframe.style.opacity = '1'; });
}

/**
 * Apply a camera change once the NEXT canvas render completes, keeping the
 * canvas HIDDEN until then so the user never sees the new page at the wrong
 * pan/zoom (the page-switch "scale glitch"). `apply` returns false to retry
 * on a later render — used by the fit path when the rect-cache isn't
 * populated yet. Always reveals, even on the safety timeout.
 *
 * Until it does, the bridge rect-cache still holds the OLD page's rects, and
 * applying synchronously would frame the wrong content. We wait for
 * `revyme:render-complete` (fired when the iframe rebuilt + cache refreshed),
 * give it one rAF to settle, apply, then reveal.
 */
function applyCameraOnNextRender(apply: () => boolean, opts?: { retries?: number; timeoutMs?: number }): void {
  const iframe = hideCanvasIframe();
  let armed = opts?.retries ?? 4;
  const timeoutMs = opts?.timeoutMs ?? 3000;
  let done = false;
  const finish = () => {
    window.removeEventListener('revyme:render-complete', onRender);
    clearTimeout(timer);
    revealCanvasIframe(iframe);
  };
  const onRender = () => {
    if (done) return;
    requestAnimationFrame(() => {
      if (done) return;
      if (apply()) { done = true; finish(); }
      else if (--armed <= 0) { done = true; finish(); }
      // else: cache not ready — wait for the next render-complete
    });
  };
  const timer = setTimeout(() => { if (!done) { done = true; apply(); finish(); } }, timeoutMs);
  window.addEventListener('revyme:render-complete', onRender);
}

/** Fit all content once the next render completes — canvas stays hidden
 *  until the fit lands, so a created/switched page never flashes at the old
 *  camera. Used after page create + first-visit page switches. (A page with a
 *  SAVED camera doesn't use this — `applyPageCameraForSwitch` applies the
 *  saved transform synchronously before the render, so no hide is needed.) */
export function fitAllOnNextRender(): void {
  trace.fn('camera.fitAllOnNextRender', {});
  applyCameraOnNextRender(() => fitAllNow());
}

/**
 * Zoom to fit specific nodes. Animated.
 *
 * `scaleMultiplier` (default 1) scales the COMPUTED target down/up after
 * the fit math. Use < 1 to zoom less aggressively — e.g. component-enter
 * flows pass 0.5 so a small card lands at half the otherwise-too-tight zoom.
 */
export function zoomToFitNodes(
  contentEl: HTMLElement,
  nodeIds: string[],
  instant?: boolean,
  padding?: number,
  scaleMultiplier?: number,
): void {
  trace.fn('camera.zoomToFitNodes', { nodeIds, instant, scaleMultiplier });
  const bounds = getNodeBounds(contentEl, nodeIds);
  if (!bounds) return;
  fitBoundsInView(bounds, padding ?? FIT_PADDING, instant ? 0 : ANIM_ZOOM_TO_FIT, scaleMultiplier ?? 1);
}

/**
 * Zoom to fit selected nodes. Falls back to zoomToFit if nothing selected.
 *
 * `instant` skips the camera tween — the transform jumps to the final
 * value on the next frame instead of animating over `ANIM_ZOOM_TO_FIT`.
 * Used by master-entry flows that want the new file to appear ALREADY
 * at the right zoom (no glance of pre-zoom content). Default false
 * preserves the existing animated behaviour for the BottomToolbar
 * "Fit Selection" command.
 */
export function zoomToFitSelection(
  contentEl: HTMLElement,
  selectedIds: string[],
  instant?: boolean,
): void {
  trace.fn('camera.zoomToFitSelection', { selectedIds, instant });
  if (selectedIds.length === 0) {
    zoomToFit(contentEl, instant);
    return;
  }
  const bounds = getNodeBounds(contentEl, selectedIds);
  if (!bounds) return;
  fitBoundsInView(bounds, FIT_PADDING, instant ? 0 : ANIM_ZOOM_TO_FIT);
}

// ─── Pan Commands ───────────────────────────────────────────────────────────

/**
 * Pan to center on a specific node. Keeps current zoom. Animated.
 */
export function panToNode(_contentEl: HTMLElement, nodeId: string): void {
  trace.fn('camera.panToNode', { nodeId });
  // `nodeId` is the data-node-id (already viewport-prefixed). Resolve via
  // bridge.getRect() — that path runs toParentSpace + adjustForTransformDelta
  // on the cached iframe-local rect. Iterating bridge.rectCache directly
  // would return RAW iframe-local rects, which after the canvas-space
  // conversion below would put the camera in the wrong place.
  const bridge = getCanvasBridge();
  // Split data-node-id into (vpPrefix, dataId). Format: "<vpPrefix><dataId>"
  // where vpPrefix is "" for desktop or "<vpId>-" for replicas/variants.
  // Try matches against every known entry in the cache to find the right split.
  const cache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
  if (!cache) return;
  let resolvedNodeId: string | null = null;
  let resolvedPrefix: string | null = null;
  for (const key of cache.keys()) {
    const parsed = parseRectCacheKey(key);
    if (!parsed) continue;
    const { vpPrefix, nodeId: dataId } = parsed;
    if (`${vpPrefix}${dataId}` === nodeId) {
      resolvedNodeId = dataId;
      resolvedPrefix = vpPrefix;
      break;
    }
  }
  if (resolvedNodeId === null) return;
  const screenRect = bridge.getRect(resolvedNodeId, resolvedPrefix!);
  if (!screenRect) return;

  const t = transformManager.getTransform();
  const c = screenRectToCanvas(screenRect, t);
  const canvasCenterX = c.left + c.width / 2;
  const canvasCenterY = c.top + c.height / 2;

  const { centerX, centerY } = getAvailableArea();
  const x = centerX - canvasCenterX * t.scale;
  const y = centerY - canvasCenterY * t.scale;

  animateCanvasTo(x, y, t.scale, ANIM_PAN_TO_NODE);
}

/**
 * Pan to a specific canvas coordinate. Keeps current zoom. Animated.
 */
export function panToCanvasPoint(canvasX: number, canvasY: number, duration?: number): void {
  trace.fn('camera.panToCanvasPoint', { canvasX, canvasY });
  const t = transformManager.getTransform();
  const { centerX, centerY } = getAvailableArea();
  const x = centerX - canvasX * t.scale;
  const y = centerY - canvasY * t.scale;
  animateCanvasTo(x, y, t.scale, duration ?? ANIM_PAN_TO_NODE);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Compute new transform for zooming at an anchor point */
function computeZoomTransform(
  current: { x: number; y: number; scale: number },
  newScale: number,
  anchorX: number,
  anchorY: number,
): { x: number; y: number; scale: number } {
  const canvasX = (anchorX - current.x) / current.scale;
  const canvasY = (anchorY - current.y) / current.scale;
  return {
    x: anchorX - canvasX * newScale,
    y: anchorY - canvasY * newScale,
    scale: newScale,
  };
}

/** Get bounding box of ALL visible content in canvas-space — bridge-aware.
 *
 *  STALE-CACHE GUARD (exported for tests): entries whose data-id isn't in the
 *  CURRENT page's node map are ignored, and a cache with no live entry at all
 *  returns null.
 *
 *  The rect cache is only replaced wholesale by an `allRects` sweep, which the
 *  sandbox emits AFTER `revyme:render-complete`. So the first render-complete
 *  following a page create/switch still sees the PREVIOUS page's rects — and
 *  `fitAllNow` happily fit those and reported success, framing empty space. On a
 *  long Home page that landed the camera at 10% zoom with the new (short) page
 *  nowhere in view, so every new page had to be panned to by hand (user report
 *  2026-07-26; New Page / 404 / CMS Index / CMS Detail all call
 *  `fitAllOnNextRender`, so all four were affected).
 *
 *  Returning null is what makes the retry in `applyCameraOnNextRender` work as
 *  intended — "cache not ready — wait for the next render-complete" — instead of
 *  it accepting stale bounds on the first try. */
export function getContentBounds(_contentEl: HTMLElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
  // Walk the cache to discover (vpPrefix, dataId) pairs, then fetch each rect
  // via bridge.getRect() so it goes through toParentSpace + transformDelta.
  // Iterating cache.values() directly returns raw iframe-local rects — wrong
  // frame for the canvas-space conversion below.
  const bridge = getCanvasBridge();
  const cache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
  if (!cache || cache.size === 0) return null;
  const t = transformManager.getTransform();
  const offset = getIframeOffset();
  // The current page's nodes — the yardstick for "is this cache entry stale?".
  // Empty means the parse hasn't landed yet, so nothing can be validated and
  // the caller should retry rather than fit whatever the cache still holds.
  const nodes = getNodesSnapshot();
  if (nodes.size === 0) {
    trace.fn('camera.getContentBounds:no-nodes', { cacheSize: cache.size });
    return null;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  let stale = 0;

  for (const key of cache.keys()) {
    const parsed = parseRectCacheKey(key);
    if (!parsed) continue;
    const { vpPrefix, nodeId: dataId } = parsed;
    // Leftover from the page we just navigated AWAY from — see the guard note
    // on this function. Ghost rows (`id__1`) miss too, harmlessly: their
    // collection-list ancestor is a node and already covers that area.
    if (!nodes.has(dataId)) { stale++; continue; }
    const r = bridge.getRect(dataId, vpPrefix);
    if (!r || r.width === 0 || r.height === 0) continue;
    const c = screenRectToCanvas(r, t, offset);
    minX = Math.min(minX, c.left);
    minY = Math.min(minY, c.top);
    maxX = Math.max(maxX, c.left + c.width);
    maxY = Math.max(maxY, c.top + c.height);
    count++;
  }
  if (count === 0) {
    trace.fn('camera.getContentBounds:all-stale', { cacheSize: cache.size, stale });
    return null;
  }
  return { minX, minY, maxX, maxY };
}

/** Get bounding box of specific nodes in canvas-space — bridge-aware.
 *  Exported for unit tests (variant-tile scoping is subtle — see
 *  CameraCommands.test.ts). */
export function getNodeBounds(_contentEl: HTMLElement, nodeIds: string[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  // `nodeIds` are full data-node-ids (already prefixed). Discover the
  // (vpPrefix, dataId) split via cache key match, then defer to
  // bridge.getRect() for the parent-space rect.
  const bridge = getCanvasBridge();
  const cache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
  if (!cache) return null;
  const t = transformManager.getTransform();
  const offset = getIframeOffset();
  const wanted = new Set(nodeIds);

  // When a selected id is a BARE dataId (no viewport prefix) it matches the
  // SAME element in EVERY viewport — page replicas AND component-master
  // variant tiles all share one data-id. Unioning them spans the whole
  // side-by-side grid, so "Fit Selection" on a single variant zooms way
  // out (thousands of px wide) instead of fitting that one tile. Prefer
  // the tile in the viewport the user is interacting with; only fall back
  // to the union if that viewport has no matching rect (e.g. the node is
  // responsive-only and absent from the interacting viewport).
  const interactingVpId = getDefaultStore().get(interactingViewportIdAtom);
  const preferredPrefix = getViewportPrefix(interactingVpId);

  // Accumulate two boxes in one pass: `scoped` (matches in the interacting
  // viewport + any explicitly-prefixed selection) and `all` (every match).
  // Pick scoped when it has anything, else fall back to all.
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity, sCount = 0;
  let aMinX = Infinity, aMinY = Infinity, aMaxX = -Infinity, aMaxY = -Infinity, aCount = 0;

  for (const key of cache.keys()) {
    const parsed = parseRectCacheKey(key);
    if (!parsed) continue;
    const { vpPrefix, nodeId: dataId } = parsed;
    const fullKey = `${vpPrefix}${dataId}`;
    // An EXPLICITLY-prefixed selection (e.g. 'variant-2-frame…') is honored
    // verbatim. CRITICAL: desktop's prefix is '' so its fullKey collapses to
    // the bare dataId — we must NOT treat that as an explicit prefix match,
    // or a bare selection (the usual case — variants share one root id) would
    // always pull the desktop tile into scope and union it with the
    // interacting variant. The `vpPrefix !== ''` guard prevents that.
    const explicitlyPrefixed = vpPrefix !== '' && wanted.has(fullKey);
    const bareMatch = wanted.has(dataId);
    if (!explicitlyPrefixed && !bareMatch) continue;
    const r = bridge.getRect(dataId, vpPrefix);
    if (!r || r.width === 0 || r.height === 0) continue;
    const c = screenRectToCanvas(r, t, offset);
    const l = c.left, tp = c.top, rt = c.left + c.width, bt = c.top + c.height;
    aMinX = Math.min(aMinX, l); aMinY = Math.min(aMinY, tp); aMaxX = Math.max(aMaxX, rt); aMaxY = Math.max(aMaxY, bt); aCount++;
    // An explicitly-prefixed selection is already viewport-specific — always
    // honor it. A bare-dataId match is "scoped" only in the interacting
    // viewport (preferredPrefix), so a single variant tile is fit alone.
    if (explicitlyPrefixed || vpPrefix === preferredPrefix) {
      sMinX = Math.min(sMinX, l); sMinY = Math.min(sMinY, tp); sMaxX = Math.max(sMaxX, rt); sMaxY = Math.max(sMaxY, bt); sCount++;
    }
  }

  if (sCount > 0) return { minX: sMinX, minY: sMinY, maxX: sMaxX, maxY: sMaxY };
  if (aCount > 0) return { minX: aMinX, minY: aMinY, maxX: aMaxX, maxY: aMaxY };
  return null;
}

/**
 * Public form of `fitBoundsInView` for callers that already know their
 * bounds in canvas-space (e.g. icon-set master entry can
 * read the variant card's `(x, y, width, height)` from the config
 * synchronously, BEFORE the iframe has rendered, and pre-snap the
 * camera so the new master file lands rendered at the correct zoom on
 * its very first paint — no opacity dance needed). Skips the rectCache
 * lookup that the node-id-driven helpers go through.
 *
 * `padding` and `scaleMultiplier` mirror `zoomToFitNodes` so a
 * pre-zoom can match the parameters of the post-render zoom that
 * follows it. If the two passes use different params, the camera
 * jumps from pre-zoom to post-render bounds — visible as a "zoom
 * in then out" twitch when entering a master.
 */
export function zoomToFitCanvasBounds(
  bounds: { left: number; top: number; width: number; height: number },
  instant?: boolean,
  padding?: number,
  scaleMultiplier?: number,
): void {
  trace.fn('camera.zoomToFitCanvasBounds', { bounds, instant, padding, scaleMultiplier });
  fitBoundsInView(
    { minX: bounds.left, minY: bounds.top, maxX: bounds.left + bounds.width, maxY: bounds.top + bounds.height },
    padding ?? FIT_PADDING,
    instant ? 0 : ANIM_ZOOM_TO_FIT,
    scaleMultiplier ?? 1,
  );
}

/** Fit a bounding box into the available view area */
function fitBoundsInView(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding: number,
  duration: number,
  scaleMultiplier: number = 1,
): void {
  const { width: availW, height: availH, centerX, centerY } = getAvailableArea();

  const contentW = bounds.maxX - bounds.minX;
  const contentH = bounds.maxY - bounds.minY;
  const contentCenterX = bounds.minX + contentW / 2;
  const contentCenterY = bounds.minY + contentH / 2;

  const scaleForW = (availW - padding * 2) / contentW;
  const scaleForH = (availH - padding * 2) / contentH;
  let targetScale = Math.min(scaleForW, scaleForH) * scaleMultiplier;
  targetScale = clamp(targetScale, FIT_MIN_SCALE, FIT_MAX_SCALE);

  const x = centerX - contentCenterX * targetScale;
  const y = centerY - contentCenterY * targetScale;

  if (duration <= 0) {
    moveCanvasTo(x, y, targetScale);
  } else {
    animateCanvasTo(x, y, targetScale, duration);
  }
}
