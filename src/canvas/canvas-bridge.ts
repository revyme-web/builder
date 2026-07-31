// canvas-bridge.ts — Abstraction layer for canvas DOM access.
//
// Canvas content always renders inside the sandbox iframe. The bridge is the
// only way for parent-frame code (editor, drag/resize, selection) to read or
// mutate canvas elements. The concrete implementation is `PostMessageBridge`
// (see canvas-sandbox/bridge-host.ts), wired by Canvas.tsx after the iframe
// loads.

import { trace } from '@/shared/debug-trace';

// ─── Bridge Interface ──────────────────────────────────────────────────────
// Methods that read or write canvas DOM. Sync read methods are served from
// caches (rectCache / computedCache / cornersCache) populated by sandbox events.
// Writes are fire-and-forget postMessage commands.

export interface CanvasBridge {
  /** Get bounding rect of a canvas element in screen space. */
  getRect(nodeId: string, vpPrefix: string): DOMRect | null;

  /** Get rects of all children of a parent element. */
  getChildRects(parentId: string, vpPrefix: string): Array<{ id: string; rect: DOMRect }>;

  /** Async variant that reads the LIVE iframe DOM (not the data-id-keyed
   *  rectCache) — so it surfaces CMS collection-list ghost rows, which share
   *  the template's data-id and are therefore excluded from the sync cache.
   *  Returns rects in DOM order, in the same (parent/screen) space as getRect.
   *  Optional: only PostMessageBridge implements it. */
  getChildRectsAsync?(parentId: string, vpPrefix: string): Promise<Array<{ id: string; rect: DOMRect }>>;

  /** Async single-rect variant that reads the LIVE iframe DOM, bypassing the
   *  sync rectCache. Used to VERIFY cache freshness after camera idle (the
   *  stale-reveal gates): after an extreme zoom the cache can hold
   *  pre-interaction / culled-placeholder rects until the culling restore
   *  re-measures, and geometry computed from it is silently wrong. Same
   *  (parent/screen) space as getRect. Optional: PostMessageBridge only. */
  getRectAsync?(nodeId: string, vpPrefix: string): Promise<DOMRect | null>;
  /** Live rect + culled flag — culled endpoints' projected cache entries are authoritative. */
  getRectLiveMetaAsync?(nodeId: string, vpPrefix: string): Promise<{ rect: DOMRect | null; culled: boolean }>;

  /** Seed the rect cache for a node not yet in the iframe (freshly-created),
   *  from the host-space preview rect, so the selection overlay resolves it
   *  instantly. PostMessageBridge only (DirectBridge reads the DOM live). */
  seedRectFromScreen?(nodeId: string, vpPrefix: string, screenRect: { left: number; top: number; width: number; height: number }): void;

  /** Seed computed styles for a freshly-created node so selection-overlay handles
   *  that read computed values resolve instantly. PostMessageBridge only. */
  seedComputed?(nodeId: string, vpPrefix: string, computed: Record<string, string>): void;

  /** Get a computed style property value. */
  getComputedValue(nodeId: string, vpPrefix: string, prop: string): string;

  /** Get multiple computed style properties at once. */
  getComputedValues(nodeId: string, vpPrefix: string, props: string[]): Record<string, string>;

  /** Get container rect (the content root transform container). */
  getContainerRect(): DOMRect | null;

  /** Get node IDs of elements at a screen point (hit testing). */
  getElementIdsAtPoint(x: number, y: number): string[];

  // ─── Write methods (fire-and-forget) ─────────────────────────────────

  /** Patch inline styles on a canvas element. 60fps safe. */
  patchStyles(nodeId: string, vpPrefix: string, styles: Record<string, string>, important?: boolean): void;

  /** Atomic attrs + styles patch — exists so SVG wrapper normalization
   *  can land `viewBox` and `width/height/left/top` in the SAME iframe
   *  message. Splitting them across two Comlink calls leaves a one-frame
   *  paint window where the path's scale doesn't match either the old or
   *  new wrapper, and the painted shape visibly jumps. */
  patchAttrsAndStyles(nodeId: string, vpPrefix: string, attrs: Record<string, string>, styles: Record<string, string>, important?: boolean): void;

  /** Live group-resize baking — bakes a group's children synchronously inside
   *  the iframe each frame so a rotated child stays stable (no mouseup snap).
   *  See sandbox-api.ts. Optional: only PostMessageBridge implements it. */
  bakeGroupResize?(groupId: string, vpPrefix: string, scaleX: number, scaleY: number): void;
  clearGroupResizeBake?(groupId: string): void;
  /** Live group auto-fit (re-fit to painted bounds synchronously each frame). */
  liveRefitGroup?(groupId: string, vpPrefix: string): void;
  /** Re-place portaled relative overlays from their triggers' CURRENT rects,
   *  right now. Fired at drop so an overlay lands in the SAME frame as its
   *  reordered trigger instead of waiting for the settle-debounced measure. */
  repositionOverlays?(): void;

  /** Replace innerHTML of a canvas element. Used by the SVG path editor for
   *  imperative-first live morphing during handle drag — DOM updates instantly
   *  and the code commit is deferred to drag end. Browsers parse SVG children
   *  in the correct namespace when assigned to an SVG element's innerHTML. */
  setInnerHTML(nodeId: string, vpPrefix: string, html: string): void;

  /** Set or remove a single attribute on a canvas element. Used for SVG
   *  presentation attrs (viewBox, preserveAspectRatio, fill, stroke, …)
   *  that aren't reachable via inline-style writes. Pass `null` to remove. */
  setAttribute(nodeId: string, vpPrefix: string, attr: string, value: string | null): void;

  /** Remove an element from the canvas iframe DOM IMMEDIATELY (imperative-first
   *  delete). The `removeNode` code mutation is async — auto-flushed → re-parse →
   *  iframe re-render, ~0.3s — so without this the node lingers on screen after the
   *  user hits Delete. This drops every viewport copy (matches `data-id`, same as
   *  removeNode) on the keystroke; the code commit then makes it permanent.
   *  PostMessageBridge only — NullBridge/DirectBridge no-op. */
  removeElement?(nodeId: string): void;

  /** Imperative-first REPARENT on drag-mouseup: move an element into a new parent
   *  (or to the canvas root when `newParentId` is null) in the iframe DOM
   *  IMMEDIATELY, so a canvas→layout drag-in (or layout→canvas drag-out) snaps in
   *  and the siblings re-flow at once — instead of waiting ~0.3s for the `move`
   *  code mutation to re-parse the page. The async mutation then makes it
   *  permanent; the `patchStyles` stale-element guard reconciles any brief
   *  duplicate. Best-effort: no-ops if the element/target can't be resolved (the
   *  commit still guarantees correctness). PostMessageBridge only. */
  reparentLive?(nodeId: string, vpPrefix: string, newParentId: string | null, index: number, styles: Record<string, string>): void;

  /** Inject or update a CSS rule in the canvas style element. */
  injectCSS(selector: string, cssBody: string): void;

  /** Remove a CSS rule from the canvas style element by selector. */
  removeCSS(selector: string): void;

  /** Iframe's `contentDocument` for direct head-injection. NOTE: the
   *  canvas iframe is CROSS-ORIGIN with the parent (parent 3333, sandbox
   *  5174) so this returns `null` in practice — `iframe.contentDocument`
   *  on a cross-origin frame raises a SecurityError or returns null.
   *  Use `loadFontInIframe` instead for runtime font injection. */
  getIframeDocument(): Document | null;

  /** Append a Google Fonts `<link>` to the iframe's document head via
   *  Comlink. The cross-origin path that actually works for hover-
   *  preview / runtime font loads. NullBridge is a no-op. */
  loadFontInIframe(fontUrl: string): void;

  /** Shift the CACHED rects of the given node ids by a screen-space delta
   *  and drop their stale corners entries — the parent-side heal for a
   *  rigid subtree move whose descendants' cache entries would otherwise
   *  stay at the pre-drag position (reposition drops skip the render, so
   *  no allRects re-measure runs). Optional: PostMessageBridge only. */
  shiftCachedSubtree?(nodeIds: string[], dxScreen: number, dyScreen: number): void;

  /** Wipe all bridge read caches (rect, computed, container rect, corners).
   *  Called on file switch so the next selection/hover poll doesn't read
   *  stale entries keyed under the same data-id across two different files
   *  (e.g. a Marquee with the same data-id in the page and in the component
   *  master both writing to `':Marquee-…'`). The caches refill on the next
   *  `allRects` event from the new file's render. */
  clearReadCaches?(): void;
}

// ─── Null Bridge ───────────────────────────────────────────────────────────
// Placeholder used before the iframe loads. Reads return empty values, writes
// are dropped. Replaced by PostMessageBridge via setActiveBridge() once the
// sandbox iframe is ready.

class NullBridge implements CanvasBridge {
  getRect(): DOMRect | null { return null; }
  getChildRects(): Array<{ id: string; rect: DOMRect }> { return []; }
  getComputedValue(): string { return ''; }
  getComputedValues(): Record<string, string> { return {}; }
  getContainerRect(): DOMRect | null { return null; }
  getElementIdsAtPoint(): string[] { return []; }
  patchStyles(): void {}
  patchAttrsAndStyles(): void {}
  setInnerHTML(): void {}
  setAttribute(): void {}
  injectCSS(): void {}
  removeCSS(): void {}
  getIframeDocument(): Document | null { return null; }
  loadFontInIframe(): void {}
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _activeBridge: CanvasBridge = new NullBridge();

/** Get the active canvas bridge. */
export function getCanvasBridge(): CanvasBridge {
  return _activeBridge;
}

/** Drop the bridge's sync read caches (rects / computed / corners) so the
 *  next RAF poll can't serve stale entries from a previous file. Used by
 *  `switchActiveFile()` — the same data-id can exist in two files, and the
 *  cache key is just `vpPrefix:nodeId`. Named wrapper so non-canvas code
 *  never touches `getCanvasBridge()` directly. */
export function clearBridgeReadCaches(): void {
  _activeBridge.clearReadCaches?.();
}

/** Swap the active bridge (called from Canvas.tsx after iframe loads). */
export function setActiveBridge(bridge: CanvasBridge): void {
  _activeBridge = bridge;
  // Debug/e2e introspection — lets DevTools and the playwright harnesses
  // inspect the live rect/corners caches (`window.__canvasBridge.rectCache`)
  // when diagnosing stale-geometry bugs. Read-only usage only.
  (window as unknown as { __canvasBridge?: CanvasBridge }).__canvasBridge = bridge;
  trace.action('canvas-bridge:setActiveBridge', { type: bridge.constructor.name });
}

/** Reset to the no-op NullBridge (called on iframe teardown / bridge dispose). */
export function resetActiveBridge(): void {
  _activeBridge = new NullBridge();
  trace.action('canvas-bridge:resetActiveBridge', {});
}
