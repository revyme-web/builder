// node-ops.ts — Centralized node operations API.
//
// TWO layers:
//   1. DOM Queries — find elements, get IDs, viewport detection (pure reads)
//   2. Node Mutations — create, move, delete, restyle, reorder (imperative-first pattern)
//
// All mutations follow the imperative-first pattern:
//   → Update DOM directly (instant visual feedback)
//   → Queue code mutation (async, code catches up)
//   → Render effect skips (updatingFromCanvas ref)
//
// Every system (FrameCreator, DragCoordinator, PropertiesPanel, future TextCreator, etc.)
// uses these instead of touching DOM or mutation queue directly.

import { isComponentFilePath } from '@/code/project/file-path-kind';
import { isPrimaryViewport } from '@/shared/constants';
import { toKebab, healSpacingShorthand, normalizeTransparent, healInertOffsets, SHORTHAND_LONGHANDS } from '@/shared/css-utils';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { ensureInstanceSizeOverride, hasInstanceSizeOverride } from '@/code/variants/instance-size-override';
import { modifyProjectFile } from '@/code/project/modify-file';
import { el } from '@/shared/dom-utils';
import { queueMutation, setForceRender, flushNow } from '@/code/mutation/mutation-queue';
// From the LEAF module, NOT the queue barrel: a dozen test files mock
// `mutation-queue`, and reading this at module scope through the barrel made
// every one of those mocks responsible for re-exporting the constant.
import { RENDER_RESOLVED_MUTATIONS } from '@/code/mutation/render-resolved-mutations';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { injectNodeIntoCache, updateNodeInCache, removeNodeFromCache, moveNodeInCache, isComponentInstanceInCache, getVariantOverriddenKeys, getNodeFromCache } from '@/code/stores/store';
import { DEFAULT_VIEWPORT_WIDTH, SVG_SHAPE_TAGS } from '@/shared/constants';
import { getReplicaContext, svgChildCarrierOrigin, groupChildBoxToMotion, groupChildrenCarryVariantGeometry, compensateGroupChildVariantsForBaseBox } from '@/canvas/drag/replica-context';
import { motionPropsToCSSTransform } from '@/shared/motion-transform';
import { trace } from '@/shared/debug-trace';
import { getCanvasBridge } from './canvas-bridge';
import { transformManager } from './transform/TransformManager';
import { moveChildAndRefitGroup, normalizeGroupOnResize, refitGroupChain } from '@/code/svg/refit-group';
import { getViewportWidths } from '@/code/stores/viewport-store';
import type { ScreenCorners } from '@/shared/types';
import { isGhostNodeId, stripGhostSuffix } from '@/shared/ghost-id';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
// The LEAF path-predicate module — active-file-store would cycle from here.
import { isLayoutFile } from '@/code/project/file-path-kind';

// ─── Global Context for Style Routing ───────────────────────────────────────
// Set by ControlProvider / Canvas when the interacting viewport/variant changes.
// This allows imperative code (ResizeManager, DragCoordinator) to route correctly
// without passing context through every call.

let _activeFilePath: string = 'app/page.tsx';
export function getActiveFilePath(): string { return _activeFilePath; }
let _interactingVpId: string = 'desktop';
let _vpWidth: number = DEFAULT_VIEWPORT_WIDTH;
let _activeLocale: string = 'en';
let _isDefaultLocale: boolean = true;
let _onLocaleStyleUpdate: ((nodeId: string, styles: Record<string, string>) => void) | null = null;
let _markUpdatingFromCanvas: (() => void) | null = null;

/** Register a callback to sync locale style changes to the atom. Called from Canvas.tsx. */
export function setLocaleStyleCallback(fn: ((nodeId: string, styles: Record<string, string>) => void) | null): void {
  _onLocaleStyleUpdate = fn;
}

/** Register a function that flags the render effect to skip its next iframe-render
 *  pass. updateNodeStyles calls this BEFORE mutating the cache so the cache-driven
 *  React re-render does not trigger a full bridge.render() — the bridge has
 *  already been patched via patchStyles/patchMultipleStyles, no full render needed.
 *  Without this, color-picker drags fire a full iframe DOM rebuild every frame
 *  (visible as flashes / lag, especially with replicas). */
export function setUpdatingFromCanvasFlagger(fn: (() => void) | null): void {
  _markUpdatingFromCanvas = fn;
}

/** Position keys that must NEVER be mirrored from the primary onto sibling VARIANT tiles during a
 *  component-master live update: each variant owns its own canvas position (variantConfig x/y), so
 *  fanning the primary's left/top across tiles yanks them together for a frame (resize-commit glitch).
 *  Size/paint props still mirror — synced variants should follow the primary's resize. */
const VARIANT_NON_MIRRORED_POSITION = new Set(['left', 'top', 'right', 'bottom']);

/** longhand → the shorthand that covers it (`paddingTop` → `padding`). */
const LONGHAND_TO_SHORTHAND: Record<string, string> = Object.fromEntries(
  Object.entries(SHORTHAND_LONGHANDS).flatMap(([short, longs]) =>
    (longs as readonly string[]).map((lh) => [lh, short]),
  ),
);

/**
 * Narrow a PRIMARY write down to what may safely be mirrored onto a replica /
 * variant tile that owns overrides of its own.
 *
 * SHORTHAND vs LONGHAND is the subtle part. `overridden` holds the keys the
 * variant actually AUTHORED, so a variant owning `paddingTop/Right/Bottom/Left`
 * does NOT contain `padding` — and the Padding control writes the SHORTHAND.
 * A plain `overridden.has(k)` check therefore let `padding` through, and it is
 * mirrored with `!important`, flattening all four overridden sides for the
 * length of the drag. It snapped back on mouseup only because the commit
 * re-renders from source (user report 2026-08-13).
 *
 * Mirror only the sides the variant does NOT own; when it owns every side the
 * shorthand is dropped entirely.
 *
 * The expansions are merged LAST on purpose: the same write also carries
 * `paddingRight: ''` etc. (the control deletes the longhands so the shorthand
 * governs), and those deletes come later in key order — applied in sequence
 * they would wipe the very sides just expanded.
 *
 * Used by BOTH fan-out paths (parent-frame DOM and the iframe bridge). They
 * had independent copies of the filter, which is exactly how one of them got
 * fixed and the other kept corrupting the tiles.
 */
function filterMirroredStyles(
  styles: Record<string, string>,
  overridden: Set<string> | null | undefined,
  skipPosition: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const expanded: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (overridden?.has(k)) continue;
    if (VARIANT_NON_MIRRORED_POSITION.has(k) && skipPosition) continue;
    // The INVERSE pairing: the write is a LONGHAND and the variant owns the
    // covering SHORTHAND (`padding: '16px'`). `overridden` holds only
    // `padding`, so `paddingTop` isn't matched and would mirror straight over
    // the side the variant is deliberately setting. Which of the two forms a
    // variant ends up storing depends on how the override was authored, so
    // both directions have to be guarded or the same bug returns wearing the
    // other hat.
    if (overridden && LONGHAND_TO_SHORTHAND[k] && overridden.has(LONGHAND_TO_SHORTHAND[k]!)) continue;
    const longhands = SHORTHAND_LONGHANDS[k];
    if (longhands && overridden && longhands.some((lh) => overridden.has(lh))) {
      // A multi-value shorthand ('10px 20px') can't be split per side without
      // parsing it, so it is dropped — the commit re-render restores the
      // correct value either way.
      if (!/\s/.test(String(v).trim())) {
        for (const lh of longhands) {
          if (!overridden.has(lh)) expanded[lh] = v;
        }
      }
      continue;
    }
    out[k] = v;
  }
  return Object.assign(out, expanded);
}

/** Register a function that forces an iframe re-render bypassing the
 *  canvasInteracting / canvasUpdating skip guards. Called by drag strategies
 *  after a STRUCTURAL change (live re-parent: canvas → frame, frame → canvas)
 *  so the iframe DOM moves the element to its new parent before the next
 *  patchStyles writes inline left/top — otherwise the inline coords are
 *  interpreted in the wrong parent's coordinate space. */
let _forceCanvasRender: ((mode?: 'force' | 'patch', overrideNodes?: Map<string, import('@/code/parsing/parser').CanvasNode>, overrideCode?: string) => void) | null = null;
export function setForceCanvasRender(fn: ((mode?: 'force' | 'patch', overrideNodes?: Map<string, import('@/code/parsing/parser').CanvasNode>, overrideCode?: string) => void) | null): void {
  _forceCanvasRender = fn;
}
export function forceCanvasRender(): void {
  _forceCanvasRender?.('force');
}
/**
 * Commit pending mutations NOW, then force a FULL Renderer rebuild on the next
 * frame. For STRUCTURAL visibility writes on a component/CMS master —
 * `setVariantVisibility` (the `<AnimatePresence>` rewrap) or a per-variant
 * `display` ternary on a CMS `.map()` row — that the in-place DOM patch can't
 * apply (display is stripped / strategy-owned); they only land on a full cycle,
 * which a panel/control write doesn't otherwise trigger. The `flushNow → force`
 * split across a frame is deliberate (the PROVEN Layers-eye timing): `flushNow`
 * commits the code synchronously in THIS tick, then the rAF defers the imperative
 * `forceCanvasRender` a frame so the `setCode` fan-out (codeAtom → re-parse → the
 * cascade of code-derived atoms) settles before the rebuild reads it. Collapsing
 * them into one tick left the DOM stale (the "Hide YES does nothing until you
 * switch pages" regression). try/catch so a render throw can never surface as an
 * unhandled rejection (e.g. a rAF firing during test teardown).
 *
 * Call this AFTER the write helper has returned (so ALL its mutations are queued
 * and commit in ONE atomic flush = one undo step) — never mid-write.
 */
export function flushAndForceStructuralRender(): void {
  trace.fn('nodeOps.flushAndForceStructuralRender', {});
  try {
    flushNow();
    requestAnimationFrame(() => {
      try { forceCanvasRender(); }
      catch (e) { trace.error('flushAndForceStructuralRender:force-failed', { error: String(e) }); }
    });
  } catch (e) {
    trace.error('flushAndForceStructuralRender:flush-failed', { error: String(e) });
  }
}
/** PATCH-mode imperative render: same fresh-input build as forceCanvasRender
 *  but ships through CanvasRenderer.render (diff/patch + duplicate-forward
 *  dedup) instead of forceRender's FULL rebuild (which remounts every code
 *  component — ~0.5s on a big page). Used by undo/redo: the restored code is
 *  already in the store (jotai reflects a set synchronously for imperative
 *  readers), so this posts the iframe's patch render mid-handler — ahead of
 *  the React pass — and the effect-driven render later dedups. */
export function patchCanvasRender(
  overrideNodes?: Map<string, import('@/code/parsing/parser').CanvasNode>,
  overrideCode?: string,
): void {
  _forceCanvasRender?.('patch', overrideNodes, overrideCode);
}

/**
 * Transition-site variant: while a drag is LIVE, the render (+ its measure
 * pass) is fully redundant — the strategies re-home the element imperatively
 * (`reparentLive`), the drag-locks make the renderer skip the dragged node
 * anyway, and replica fan-out / @container hides are imperative too. On a
 * big page the mid-drag render+measure was the whole per-transition hitch
 * (~90ms at each enter/exit reparent). Defer to the drop: mark the pending
 * forceRender so the drag-end flush (deferred-drag-flush apply → setCode →
 * render) reconciles everything in ONE post-drop render. Outside a drag this
 * is exactly forceCanvasRender().
 */
export function forceCanvasRenderDeferredDuringDrag(): void {
  if (dragStateOps.get()) {
    setForceRender();
    trace.action('node-ops:force-render-deferred-mid-drag', {});
    return;
  }
  _forceCanvasRender?.();
}

/**
 * Getter for per-replica @container overrides. Wired from Canvas.tsx using
 * `containerOverridesAtom`. Returns the merged property→value map for a node
 * at a given viewport width (smallest matching breakpoint wins).
 *
 * Used by updateNodeStyles to suppress primary→replica fan-out for properties
 * the replica has its own override for. Without this, resizing the primary
 * stomps a replica's @media `width`/`height` because the primary path patches
 * every viewport's element with `important: true` (see updateNodeStyles
 * page-file primary branch).
 */
let _getReplicaOverrides: ((nodeId: string, vpWidth: number) => Record<string, string>) | null = null;
export function setReplicaOverridesGetter(
  fn: ((nodeId: string, vpWidth: number) => Record<string, string>) | null,
): void {
  _getReplicaOverrides = fn;
}

/** Check if a viewport/variant ID is the primary one (gets '' prefix) */
export { isPrimaryViewport };

/** Get the current interacting viewport context (set via setStyleContext) */
export function getInteractingViewport(): { vpId: string; vpWidth: number } {
  return { vpId: _interactingVpId, vpWidth: _vpWidth };
}

/** Call from Canvas/ControlProvider when context changes */
export function setStyleContext(
  filePath: string,
  vpId: string,
  vpWidth: number,
  locale?: string,
  isDefaultLocale?: boolean,
): void {
  _activeFilePath = filePath;
  _interactingVpId = vpId;
  _vpWidth = vpWidth;
  if (locale !== undefined) _activeLocale = locale;
  if (isDefaultLocale !== undefined) _isDefaultLocale = isDefaultLocale;
}

// ─── Viewport Helpers ───────────────────────────────────────────────────────

/**
 * Get the DOM query prefix for a viewport/variant.
 * The PRIMARY viewport/variant always gets '' (no prefix) — its nodes have unprefixed data-node-id.
 * Non-primary viewports get 'id-' prefix (e.g. 'tablet-', 'mobile-', 'responsive-').
 * 'desktop' is always treated as primary for backward compat.
 */
export function getViewportPrefix(viewportId: string): string {
  // 'desktop' is always primary (pages). For component variants, the Renderer
  // gives '' prefix to whichever variant has isPrimary:true — and its viewport ID
  // is set as the interactingViewportId. We also treat 'default' as primary
  // since that's the default variant ID from variant-config.
  //
  // '' (empty vpId) is ALSO primary space: CANVAS NODES render once at the
  // canvas root and their bridge cache entries are keyed with the '' prefix.
  // The old `'' + '-'` fallthrough produced the bogus prefix '-' — every
  // rect/layout lookup for a caller passing vpId '' silently missed, which
  // dead-ended the Insert-panel drag's whole canvas-node drop branch (no
  // hover highlight, no drop line, drop landed free — user report
  // 2026-07-29; ToolbarDragStrategy's CANVAS_VP = '').
  if (!viewportId || viewportId === 'desktop' || viewportId === 'default') return '';
  return viewportId + '-';
}

/** Reverse of getViewportPrefix: derive viewport ID from prefix. '' → 'desktop', 'tablet-' → 'tablet'. */
export function vpIdFromPrefix(prefix: string): string {
  if (!prefix) return 'desktop';
  return prefix.endsWith('-') ? prefix.slice(0, -1) : prefix;
}

/**
 * Split a bridge rect-cache key (`${vpPrefix}:${nodeId}` — see
 * bridge-sandbox's allRects emit) into its parts. Returns null when the key
 * has no colon separator (callers that iterate the cache skip those; callers
 * that tolerate them fall back to `{ vpPrefix: '', nodeId: key }`).
 */
export function parseRectCacheKey(key: string): { vpPrefix: string; nodeId: string } | null {
  const colonIdx = key.indexOf(':');
  if (colonIdx < 0) return null;
  return { vpPrefix: key.slice(0, colonIdx), nodeId: key.slice(colonIdx + 1) };
}

// clearBridgeReadCaches lives in canvas-bridge.ts (leaf side of the funnel —
// active-file-store imports it there without a node-ops cycle); re-exported.
export { clearBridgeReadCaches } from './canvas-bridge';

/**
 * Read the active canvas camera transform (pan x/y + zoom scale). Funnel
 * wrapper around `transformManager` so non-canvas code (paste-engine copy)
 * doesn't import the transform system directly.
 */
export function getActiveTransform(): { x: number; y: number; scale: number } {
  return transformManager.getTransform();
}

/** Detect which viewport an event target is inside. Walks up the DOM tree. */
export function getViewportFromEvent(e: MouseEvent | Event, root: HTMLElement): string {
  let target = e.target as HTMLElement | null;
  while (target && target !== root) {
    // Check for viewport container (content nodes)
    const vp = target.getAttribute('data-viewport');
    if (vp) return vp;
    // Check for viewport header (overlay elements)
    const vpHeader = target.getAttribute('data-viewport-header');
    if (vpHeader) return vpHeader;
    target = target.parentElement;
  }
  return 'desktop';
}

// ─── DOM Element Lookups ────────────────────────────────────────────────────

export interface NodeContext {
  contentEl: HTMLElement;
  viewportPrefix: string;
}

/** Find a viewport element by viewport ID. Root IS the viewport — no wrapper. */
export function getViewportContainer(contentEl: HTMLElement, vpId: string): HTMLElement | null {
  return contentEl.querySelector(`[data-viewport="${vpId}"]`);
}


// ─── Global DOM Lookups ─────────────────────────────────────────────────────
// For React components that don't receive contentEl as a prop.
// Imperative systems (DragCoordinator, strategies) should use the scoped versions above.

/** Get the content root element (hidden parent-frame anchor — actual canvas
 *  content lives in the sandbox iframe). DOM patches against this root are
 *  no-ops; cache updates + mutation queue still run. */
export function getContentRoot(): HTMLElement | null {
  const el = document.querySelector('[data-content-root]');
  return (el as HTMLElement) ?? null;
}

/**
 * Get the canvas <style data-canvas-styles> element, creating it if it doesn't exist.
 * Used for imperative CSS injection (::after border overlays, future features).
 */
export function getOrCreateCanvasStyleEl(): HTMLStyleElement | null {
  const root = getContentRoot();
  if (!root) return null;
  let el = root.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-canvas-styles', 'true');
    root.prepend(el);
    trace.action('node-ops:created-canvas-style-el', {});
  }
  return el;
}

/**
 * Clear all injected CSS and remove stale viewport elements.
 * Call this when the entire page is replaced (e.g., AI writeFile on active page).
 * Forces the renderer to rebuild from scratch instead of patching stale DOM.
 */
export function clearCanvasStyles(): void {
  const styleEl = getOrCreateCanvasStyleEl();
  if (!styleEl) return;
  styleEl.textContent = '';

  // Remove all viewport root elements so renderer creates fresh ones
  // (prevents stale inline styles from the old page persisting)
  const root = getContentRoot();
  if (root) {
    const viewports = root.querySelectorAll('[data-viewport]');
    trace.action('node-ops:clear-canvas-styles', { removedViewports: viewports.length });
    viewports.forEach(el => el.remove());
  }

  // Re-inject tokens immediately so var(--xxx) still works
  refreshCanvasTokens();
}

/**
 * Re-inject the full tokens.css into the canvas style element.
 * Handles design tokens (:root vars), dark theme, and global @keyframes.
 * Uses /* canvas-tokens-start/end markers to reliably replace the section on updates.
 * Call this after any change to app/globals.css (tokens, keyframes, etc.).
 *
 * Coalesces calls within the same animation frame so a continuous color
 * picker drag (which can call this 60+ times/sec) only does the work once
 * per frame.
 */
let _pendingRefreshFrame: number | null = null;
export function refreshCanvasTokens(): void {
  if (_pendingRefreshFrame !== null) return;
  _pendingRefreshFrame = requestAnimationFrame(() => {
    _pendingRefreshFrame = null;
    refreshCanvasTokensImmediate();
  });
}

function refreshCanvasTokensImmediate(): void {
  const styleEl = getOrCreateCanvasStyleEl();
  if (!styleEl) return;
  const rawCSS = projectFS.readFile('app/globals.css');
  if (!rawCSS) return;

  // Extract ONLY :root, [data-theme], and @keyframes blocks from globals.css.
  // Global resets (*, body, a, img) must NOT leak into the editor UI.
  const safeBlocks: string[] = [];
  const blockRegex = /(:root\s*\{[^}]*\}|\[data-theme[^\]]*\]\s*\{[^}]*\}|@keyframes\s+[\w-]+\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\})/gs;
  let match;
  while ((match = blockRegex.exec(rawCSS)) !== null) {
    safeBlocks.push(match[0]);
  }
  // Scope :root to [data-content-root] so CSS variables don't leak into the builder UI.
  // :root always matches <html> regardless of where the <style> element lives.
  const tokensCSS = safeBlocks.join('\n').replace(/:root\s*\{/g, '[data-content-root] {');

  const current = styleEl.textContent || '';
  const startMarker = '/* canvas-tokens-start */';
  const endMarker = '/* canvas-tokens-end */';
  const startIdx = current.indexOf(startMarker);
  const endIdx = current.indexOf(endMarker);

  if (startIdx >= 0 && endIdx > startIdx) {
    // Replace content between markers (preserves any page-injected CSS after endMarker)
    styleEl.textContent =
      current.slice(0, startIdx) +
      startMarker + '\n' + tokensCSS + '\n' + endMarker +
      current.slice(endIdx + endMarker.length);
  } else {
    // First injection: prepend with markers before existing page CSS
    styleEl.textContent = startMarker + '\n' + tokensCSS + '\n' + endMarker + '\n' + current;
  }

  // Also push to the sandbox iframe. Use the lightweight token-only RPC
  // (replaces just the canvas-tokens-start/end block in the iframe's style
  // element) rather than forceCanvasRender — preset color pickers fire at
  // 60fps and a full iframe re-render per tick stutters the UI badly.
  const bridge = getCanvasBridge() as any;
  if (typeof bridge?.setCanvasTokensCSS === 'function') {
    bridge.setCanvasTokensCSS(tokensCSS);
  }
  trace.action('node-ops:refresh-canvas-tokens', { tokensCSSLength: tokensCSS.length });
}

/**
 * Inject or update a CSS rule in the canvas style element.
 * If a rule with the same selector already exists, it's replaced.
 */
export function injectCanvasCSS(selector: string, cssBody: string): void {
  // Always patch the local DOM style element (hidden parent in iframe mode)
  const styleEl = getOrCreateCanvasStyleEl();
  if (!styleEl) return;
  const selectorEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  const newRule = `\n${selector} {\n${cssBody}\n}`;
  if (ruleRegex.test(styleEl.textContent || '')) {
    styleEl.textContent = (styleEl.textContent || '').replace(ruleRegex, newRule);
  } else {
    styleEl.textContent = (styleEl.textContent || '') + newRule;
  }
  trace.action('node-ops:inject-canvas-css', { selector });

  // Forward to sandbox iframe
  getCanvasBridge().injectCSS(selector, cssBody);
}

/**
 * Remove a CSS rule from the canvas style element by selector.
 */
export function removeCanvasCSS(selector: string): void {
  // Always patch the local DOM style element (hidden parent in iframe mode)
  const root = getContentRoot();
  if (!root) return;
  const styleEl = root.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
  if (!styleEl) return;
  const selectorEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  styleEl.textContent = (styleEl.textContent || '').replace(ruleRegex, '');
  trace.action('node-ops:remove-canvas-css', { selector });

  // Forward to sandbox iframe
  getCanvasBridge().removeCSS(selector);
}

/**
 * Query the PARENT frame's document for a `[data-node-id="..."]` element.
 * Canvas DOM lives in the sandbox iframe, so this ALWAYS returns null for
 * canvas nodes — it only resolves parent-frame DOM (overlays, viewport
 * headers etc.) that carries a `data-node-id` attribute.
 *
 * For canvas nodes use the bridge helpers instead: `node.styles` from the
 * cached NodeMap for inline styles, `findNodeRect` for bounds,
 * `findNodeComputedStyle` for computed styles, `patchNodeStyles` /
 * `getCanvasBridge().setAttribute` for writes.
 */
export function findParentFrameElement(nodeId: string, vpId: string): HTMLElement | null {
  const prefix = getViewportPrefix(vpId);
  return document.querySelector(`[data-node-id="${prefix}${nodeId}"]`) as HTMLElement | null;
}

/**
 * Get the bounding client rect for a node in PARENT screen space.
 * The bridge translates from iframe-space to parent-space.
 */
export function findNodeRect(nodeId: string, vpId: string): DOMRect | null {
  const prefix = getViewportPrefix(vpId);
  return getCanvasBridge().getRect(nodeId, prefix);
}

/** LIVE async rect via the bridge (Comlink) — bypasses the sync rectCache.
 *  Used to VERIFY cache freshness after camera idle (stale-reveal gates):
 *  after an extreme zoom the sync cache can hold pre-interaction or
 *  culled-placeholder rects until the culling restore re-measures, so
 *  "compute ran" is NOT the same as "geometry is right". Falls back to the
 *  sync cache when the bridge has no async path (NullBridge). */
export async function findNodeRectLiveAsync(nodeId: string, vpId: string): Promise<DOMRect | null> {
  const prefix = getViewportPrefix(vpId);
  const bridge = getCanvasBridge();
  if (bridge.getRectAsync) return bridge.getRectAsync(nodeId, prefix);
  return bridge.getRect(nodeId, prefix);
}

/** Live rect + CULLED flag for freshness verifiers. A culled endpoint's live
 *  rect is unmeasurable (0×0 placeholder swap) but its PROJECTED cache entry
 *  stays authoritative — callers treat { culled: true } as converged-on-cache
 *  instead of polling until a cap (offscreen slot-connected canvas nodes stay
 *  culled forever; live find 2026-07-21: connector arrows hidden ~6s). */
export async function findNodeRectLiveMetaAsync(nodeId: string, vpId: string): Promise<{ rect: DOMRect | null; culled: boolean }> {
  const prefix = getViewportPrefix(vpId);
  const bridge = getCanvasBridge();
  if (bridge.getRectLiveMetaAsync) return bridge.getRectLiveMetaAsync(nodeId, prefix);
  return { rect: await findNodeRectLiveAsync(nodeId, vpId), culled: false };
}

/** Get element dimensions via bridge. */
export function findNodeSize(nodeId: string, vpId: string): { width: number; height: number } {
  const rect = findNodeRect(nodeId, vpId);
  return rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 };
}

/** Get the parent's inner (content box) dimensions via bridge. */
export function findNodeParentInnerSize(nodeId: string, vpId: string): { width: number; height: number } {
  const prefix = getViewportPrefix(vpId);
  const vals = getCanvasBridge().getComputedValues(nodeId, prefix, ['__parentClientWidth', '__parentClientHeight']);
  return {
    width: parseFloat(vals['__parentClientWidth']) || 0,
    height: parseFloat(vals['__parentClientHeight']) || 0,
  };
}

/** Get a single computed style value via bridge. Prefers cached value. */
export function findNodeComputedStyle(nodeId: string, vpId: string, prop: string): string {
  const bridge = getCanvasBridge();
  const prefix = getViewportPrefix(vpId);
  if ('getCachedComputedStyle' in bridge) {
    const cached = (bridge as any).getCachedComputedStyle(nodeId, prefix, prop);
    if (cached) return cached;
  }
  return bridge.getComputedValue(nodeId, prefix, prop);
}

/** Resolve a single computed style value, awaiting an iframe RPC when the value isn't already cached.
 *  Use this when correctness matters more than 60fps (e.g. seeding a variable's default from the real
 *  rendered px) — the sync `findNodeComputedStyle` returns '' on a cold cache. Falls back to '' if the
 *  bridge can't resolve it. */
export async function findNodeComputedStyleAsync(nodeId: string, vpId: string, prop: string): Promise<string> {
  const sync = findNodeComputedStyle(nodeId, vpId, prop);
  if (sync) return sync;
  const bridge = getCanvasBridge();
  const prefix = getViewportPrefix(vpId);
  if ('getComputedValuesAsync' in bridge) {
    try {
      const values = await (bridge as any).getComputedValuesAsync(nodeId, prefix, [prop]);
      return values?.[prop] ?? '';
    } catch { /* fall through */ }
  }
  return '';
}

/** Get multiple computed style values via bridge. Prefers cached values. */
export function findNodeComputedStyles(nodeId: string, vpId: string, props: string[]): Record<string, string> {
  const bridge = getCanvasBridge();
  const prefix = getViewportPrefix(vpId);
  if ('getCachedComputedStyles' in bridge) {
    const cached = (bridge as any).getCachedComputedStyles(nodeId, prefix, props);
    if (cached && Object.keys(cached).length > 0) return cached;
  }
  return bridge.getComputedValues(nodeId, prefix, props);
}

/**
 * Find the rects + corners for every .map() ghost copy of a template node, in
 * PARENT screen space. Ghosts are stored in the bridge caches under composite
 * keys like `${vpPrefix}:${templateId}__N`. We scan the rectCache for entries
 * matching that prefix and resolve each via the bridge so the parent-space +
 * transform-delta adjustments happen consistently.
 *
 * Returns ghosts sorted by ghostIndex ascending. Empty when no ghosts exist or
 * the bridge does not expose a rectCache (DirectBridge in non-iframe mode).
 */
export function findGhostsForTemplate(
  templateId: string,
  vpId: string,
): Array<{ ghostIndex: number; rect: DOMRect; corners: ScreenCorners | null }> {
  const bridge = getCanvasBridge() as any;
  const rectCache: Map<string, DOMRect> | undefined = bridge.rectCache;
  if (!rectCache || rectCache.size === 0) return [];

  const prefix = getViewportPrefix(vpId);
  const cacheKeyPrefix = `${prefix}:${templateId}__`;
  const result: Array<{ ghostIndex: number; rect: DOMRect; corners: ScreenCorners | null }> = [];
  for (const key of rectCache.keys()) {
    if (!key.startsWith(cacheKeyPrefix)) continue;
    const suffix = key.slice(cacheKeyPrefix.length);
    const ghostIndex = parseInt(suffix, 10);
    if (!Number.isFinite(ghostIndex) || String(ghostIndex) !== suffix) continue;
    const ghostNodeId = `${templateId}__${ghostIndex}`;
    const rect = bridge.getRect(ghostNodeId, prefix);
    if (!rect) continue;
    const corners = typeof bridge.getCachedCorners === 'function'
      ? bridge.getCachedCorners(ghostNodeId, prefix)
      : null;
    result.push({ ghostIndex, rect, corners });
  }
  result.sort((a, b) => a.ghostIndex - b.ghostIndex);
  // TRACE ON CHANGE ONLY. SelectionOverlay polls this at 60fps while a
  // collection row is selected; a trace per call snapshots + buffers sixty
  // times a second to say the same number (one 465ms window held 56 identical
  // `count: 0` lines — 2026-08-08). Same lesson as the per-node svg attr traces
  // in the parser: aggregate, don't spam.
  const sigKey = `${cacheKeyPrefix}`;
  if (_lastGhostCount.get(sigKey) !== result.length) {
    _lastGhostCount.set(sigKey, result.length);
    trace.fn('findGhostsForTemplate', { templateId, vpId, count: result.length });
  }
  return result;
}

/** Last ghost count reported per template+viewport — see the trace gate above. */
const _lastGhostCount = new Map<string, number>();

/** Build child rects from NodeMap children + bridge rectCache. */
export function findChildRects(parentId: string, vpId: string): Array<{ id: string; rect: DOMRect }> {
  const parentNode = getNodeFromCache(parentId);
  if (!parentNode?.children) return [];
  const prefix = getViewportPrefix(vpId);
  const bridge = getCanvasBridge();
  const results: Array<{ id: string; rect: DOMRect }> = [];
  for (const childId of parentNode.children) {
    const rect = bridge.getRect(childId, prefix);
    if (rect) results.push({ id: childId, rect });
  }
  return results;
}

/** Same as `findChildRects` but skips children whose computed
 *  `display === 'none'` for this vpId AND children with zero-area rects.
 *  Use when picking a layout gap (drop-line midpoint, insert-index calc) —
 *  hidden children sit at their inline `left`/`top` with a 0×0 rect, which
 *  would otherwise pollute midpoint/gap math with phantom "stops" where
 *  there's nothing visible to drop next to.
 *
 *  Common cases this filters out:
 *    - Page-replica nodes hidden on primary via inline `display:'none'` +
 *      `@container display:'unset'` for the entered viewport.
 *    - Component-master nodes hidden on the `default` variant via
 *      `motionVariants.default = { display: 'none' }`.
 *    - Mid-drag transient 0×0 rects between mutation flush + layout settle. */
export function findVisibleChildRects(parentId: string, vpId: string): Array<{ id: string; rect: DOMRect }> {
  const all = findChildRects(parentId, vpId);
  return all.filter(c => {
    if (c.rect.width === 0 && c.rect.height === 0) return false;
    if (findNodeComputedStyle(c.id, vpId, 'display') === 'none') return false;
    // OUT-OF-FLOW children (position: absolute / fixed) — e.g. an absolute
    // GradientAura overlay covering its parent, or pinned float cards. They're
    // NOT flex/grid line members, so every layout-child consumer must ignore
    // them (drop-line index + DropLineIndicator + gap handles + reorder),
    // exactly like the template-chrome exclusion below. Without this, an
    // absolute child (often 100%×100% and non-droppable, e.g. a code component)
    // masks the real in-flow siblings: the drop lines vanish / land on the
    // overlay instead of between the flex children behind it.
    const pos = findNodeComputedStyle(c.id, vpId, 'position');
    if (pos === 'absolute' || pos === 'fixed') return false;
    // LOCKED TEMPLATE CHROME — on a templated page the merged viewport `root`
    // mixes the template's `layout::…` nodes (header/footer/nav) with the
    // page's own sections. Template nodes belong to the template file and are
    // NEVER valid reorder/drop siblings for page content — excluding them here
    // keeps every layout-child consumer (drop-line index + DropLineIndicator +
    // gap handles + reorder) in agreement: drop positions appear ONLY in the
    // `{children}` slot region, not between the locked header/footer. A
    // template-only page (no sections) → zero eligible children → the strategy
    // shows a single empty-layout drop affordance instead of N phantom lines.
    if (c.id.startsWith('layout::')) return false;
    // The `{children}` placeholder: excluded on PAGE views (it isn't a drop
    // sibling for page content — and no such node exists in the merged map
    // anyway), but when EDITING THE TEMPLATE it is a REAL flow sibling the
    // user drops chrome before/after. Blanket-excluding it made the drop-line
    // math blind to the slot: dragging over the placeholder landed the line
    // at its CENTER (the header↔footer boundary), and a slot-only template
    // showed no line at all (user report 2026-07-27). Mirrors the add-back
    // LayoutLiftedStrategy.getLayoutSiblingRects has always done for reorder.
    if (c.id === 'children-slot' && !isLayoutFile(getActiveFilePath())) return false;
    return true;
  });
}

/** Find a viewport container element (global document query).
 *  Skips overlay portals which also have data-viewport. */
export function findViewportElement(vpId: string): HTMLElement | null {
  return document.querySelector(`[data-viewport="${vpId}"]:not([data-overlay-portal])`) as HTMLElement | null;
}

/**
 * Get the content root's bounding rect via bridge.
 */
export function getContentRootRect(): DOMRect | null {
  return getCanvasBridge().getContainerRect();
}

/**
 * Hit test with viewport awareness — returns nodeId + vpPrefix pairs sorted
 * smallest-area-first. Reads from the bridge's rect cache.
 *
 * For each candidate, the AABB is used as a cheap pre-filter. If the AABB
 * matches, we then refine via point-in-quad against the cached rotated
 * corners so a rotated diamond doesn't register hover inside its
 * circumscribed AABB but outside the visual quad.
 */
export function getNodeHitsAtPoint(x: number, y: number): Array<{ id: string; vpPrefix: string }> {
  const bridge = getCanvasBridge();
  if (!('rectCache' in bridge)) return [];
  const cache = (bridge as any).rectCache as Map<string, DOMRect>;
  // Cross-product point-in-quad — same predicate as geometry-utils
  // `pointInQuad`. Inlined to avoid import cycle (node-ops is imported very
  // early; geometry-utils pulls in canvas-bridge which pulls in node-ops).
  const inQuad = (
    px: number, py: number,
    TL: { x: number; y: number }, TR: { x: number; y: number },
    BR: { x: number; y: number }, BL: { x: number; y: number },
  ) => {
    const cross = (
      ax: number, ay: number, bx: number, by: number, qx: number, qy: number,
    ) => (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    const d1 = cross(TL.x, TL.y, TR.x, TR.y, px, py);
    const d2 = cross(TR.x, TR.y, BR.x, BR.y, px, py);
    const d3 = cross(BR.x, BR.y, BL.x, BL.y, px, py);
    const d4 = cross(BL.x, BL.y, TL.x, TL.y, px, py);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0 || d4 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0 || d4 > 0;
    return !(hasNeg && hasPos);
  };
  const hits: Array<{ id: string; vpPrefix: string; area: number }> = [];
  // Tree depth (ancestor count) — used to break the hit sort so a DESCENDANT
  // always beats its ANCESTOR, regardless of painted area. The old area-only
  // sort ("smallest = most specific") picked the parent over a child that
  // OVERFLOWS it (the child's bbox is bigger), so an oversized child was never
  // hoverable/selectable where it overlapped its parent. A child paints on top
  // of its parent, so the deeper node is the correct hit.
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = getNodeFromCache(id)?.parentId ?? null;
    for (let i = 0; i < 50 && cur; i++) { d++; cur = getNodeFromCache(cur)?.parentId ?? null; }
    return d;
  };
  // Respect ancestor `overflow` clipping: a node that OVERFLOWS an ancestor whose
  // overflow is hidden/scroll/auto/clip is NOT painted in the clipped region, so
  // it must not be hit-testable there (hovering empty space past a clipped node's
  // visible box would otherwise wrongly highlight it). Walk the hit's ancestors;
  // if any clips and the point is OUTSIDE that ancestor's box, the hit is culled.
  // Uses the ancestor's cached corners (rotation-correct quad) when available,
  // else its AABB rect. overflow comes from the node cache (inline styles — the
  // editor's convention; computed isn't reliably prefetched here).
  const CLIP_OVERFLOWS = new Set(['hidden', 'scroll', 'auto', 'clip']);
  const isClippedOut = (nodeId: string, vpPrefix: string, px: number, py: number): boolean => {
    // An OVERLAY node is portaled OUT of its ancestor subtree at render time, so an
    // ancestor's `overflow:hidden` does NOT clip it — it overflows freely (e.g. on a
    // component master, the overlay overhangs the variant tile onto the canvas). If
    // the hit IS the overlay, nothing clips it.
    if (getNodeFromCache(nodeId)?.attrs?.['data-overlay']) return false;
    let cur = getNodeFromCache(nodeId)?.parentId ?? null;
    for (let i = 0; i < 50 && cur; i++) {
      const node = getNodeFromCache(cur);
      if (!node) break;
      const s = node.styles || {};
      const clips = CLIP_OVERFLOWS.has((s.overflow || '').trim())
        || CLIP_OVERFLOWS.has((s.overflowX || '').trim())
        || CLIP_OVERFLOWS.has((s.overflowY || '').trim());
      if (clips) {
        const aCorners = 'getCachedCorners' in bridge ? (bridge as any).getCachedCorners(cur, vpPrefix) : null;
        if (aCorners) {
          if (!inQuad(px, py, aCorners.TL, aCorners.TR, aCorners.BR, aCorners.BL)) return true;
        } else {
          const aRect = bridge.getRect(cur, vpPrefix);
          if (aRect && (px < aRect.left || px > aRect.right || py < aRect.top || py > aRect.bottom)) return true;
        }
      }
      // The overlay itself IS a clip boundary (its own overflow, checked above, still
      // clips its children) — but it's portaled, so STOP before walking into the
      // ancestors it was lifted out of.
      if (node.attrs?.['data-overlay']) break;
      cur = node.parentId ?? null;
    }
    return false;
  };
  for (const [key] of cache) {
    const { vpPrefix, nodeId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
    if (!nodeId || nodeId === 'root') continue;
    // Prefer the cached CORNERS (the painted/visible shape) as the hit
    // region. For SVG wrappers — especially GROUPS — the painted bbox can
    // extend well past the wrapper's CSS-box `rect` (a child moved/resized
    // past the box before any refit). Using the rect's AABB as a pre-filter
    // would then reject points that ARE inside the visible group box,
    // before the corners check could accept them — so the empty interior
    // stops registering hits after a child moves. Deriving the AABB from
    // the corners keeps the clickable/hover area in sync with what the user
    // sees. Falls back to the rect when corners aren't cached yet.
    const corners = 'getCachedCorners' in bridge
      ? (bridge as any).getCachedCorners(nodeId, vpPrefix)
      : null;
    if (corners) {
      const minX = Math.min(corners.TL.x, corners.TR.x, corners.BR.x, corners.BL.x);
      const maxX = Math.max(corners.TL.x, corners.TR.x, corners.BR.x, corners.BL.x);
      const minY = Math.min(corners.TL.y, corners.TR.y, corners.BR.y, corners.BL.y);
      const maxY = Math.max(corners.TL.y, corners.TR.y, corners.BR.y, corners.BL.y);
      // Garbage-corner guard. A valid element's corner-AABB is ~its bounding
      // rect (equal for a rotated element; for a decoupled/spilled SVG the
      // corners can be a few× larger, but still bounded to real content). The
      // corner math for a nested `<svg>` under a CSS-rotated parent group
      // could blow up to canvas-spanning values (empty inline styles → a
      // degenerate viewBox→screen affine), so a single rotated group made
      // EVERY click land on one of its children. When the corners' area
      // dwarfs the (always-bounded) rect by >100×, distrust them and fall
      // back to the rect — the hit region can then never swallow the whole
      // canvas. Parent-side backstop, independent of the sandbox bundle.
      const cornersArea = (maxX - minX) * (maxY - minY);
      const gRect = bridge.getRect(nodeId, vpPrefix);
      if (gRect && gRect.width > 0 && gRect.height > 0 && cornersArea > gRect.width * gRect.height * 100) {
        if (x < gRect.left || x > gRect.right || y < gRect.top || y > gRect.bottom) continue;
        if (isClippedOut(nodeId, vpPrefix, x, y)) continue;
        hits.push({ id: nodeId, vpPrefix, area: gRect.width * gRect.height });
        continue;
      }
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (!inQuad(x, y, corners.TL, corners.TR, corners.BR, corners.BL)) continue;
      if (isClippedOut(nodeId, vpPrefix, x, y)) continue;
      hits.push({ id: nodeId, vpPrefix, area: (maxX - minX) * (maxY - minY) });
    } else {
      const rect = bridge.getRect(nodeId, vpPrefix);
      if (!rect) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (isClippedOut(nodeId, vpPrefix, x, y)) continue;
      hits.push({ id: nodeId, vpPrefix, area: rect.width * rect.height });
    }
  }
  // PAINT ORDER first — the browser's truth for "what is on top" (the thing
  // the user believes they are hovering). Two overlapping hits are reduced to
  // their SIBLING ancestors under the closest common parent, then compared by
  // CSS stacking within that parent: higher z-index paints above; equal
  // z-index → the LATER sibling in DOM order paints above. An ancestor/
  // descendant pair keeps descendant-above (children paint over parents).
  // Without this, a full-bleed decorative backdrop (e.g. a deep 100%×100%
  // "Background Noise" texture) beat a SHALLOWER sibling section that
  // visually covers it — hover, click, and drag drop-detection all landed on
  // the backdrop even with z-index raised on the section (the "can't drop
  // into Trusted Logos" find). Depth + smallest-area remain as tiebreakers
  // for indeterminate pairs (different viewports, cache misses).
  const chainOf = (id: string): string[] => {
    const chain: string[] = [id];
    let cur = getNodeFromCache(id)?.parentId ?? null;
    for (let i = 0; i < 50 && cur; i++) {
      chain.push(cur);
      cur = getNodeFromCache(cur)?.parentId ?? null;
    }
    return chain;
  };
  const zOf = (id: string): number => {
    const raw = getNodeFromCache(id)?.styles?.zIndex;
    const n = parseFloat(String(raw ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  const paintCompare = (aId: string, bId: string): number => {
    if (aId === bId) return 0;
    const aChain = chainOf(aId);
    const bChain = chainOf(bId);
    const aSet = new Map(aChain.map((id, i) => [id, i]));
    for (let bi = 0; bi < bChain.length; bi++) {
      const common = bChain[bi];
      const ai = aSet.get(common);
      if (ai === undefined) continue;
      if (ai === 0) return 1;  // a IS b's ancestor → b paints above → b first
      if (bi === 0) return -1; // b IS a's ancestor → a paints above → a first
      const sibA = aChain[ai - 1];
      const sibB = bChain[bi - 1];
      const dz = zOf(sibB) - zOf(sibA);
      if (dz) return dz; // higher z paints above → first
      const kids = getNodeFromCache(common)?.children ?? [];
      const ia = kids.indexOf(sibA);
      const ib = kids.indexOf(sibB);
      if (ia !== -1 && ib !== -1 && ia !== ib) return ib - ia; // later sibling paints above → first
      return 0;
    }
    return 0; // no common ancestor (different viewports) — fall through
  };
  hits.sort((a, b) => paintCompare(a.id, b.id) || (depthOf(b.id) - depthOf(a.id)) || (a.area - b.area));
  return hits.map(h => ({ id: h.id, vpPrefix: h.vpPrefix }));
}

/** Hit test returning just node IDs (drops viewport info). */
export function getNodeIdsAtPoint(x: number, y: number): string[] {
  return getNodeHitsAtPoint(x, y).map(h => h.id);
}

/**
 * Find the page-root hit at a screen point — returns `{ id: 'root', vpPrefix }`
 * when the point is inside any viewport's root rect (the page's own root, not
 * the layout's). Used as the drop-target fallback when no smaller eligible
 * frame is under the cursor (e.g. dropping into an empty page where only root
 * exists, or onto whitespace between text children that can't accept kids).
 *
 * `getNodeHitsAtPoint` deliberately omits root from regular hit-testing
 * (selection skips it), so this helper exposes the rect-cache lookup
 * separately for drop-target use.
 */
export function findRootHitAtPoint(x: number, y: number): { id: string; vpPrefix: string } | null {
  const bridge = getCanvasBridge();
  if (!('rectCache' in bridge)) return null;
  const cache = (bridge as any).rectCache as Map<string, DOMRect>;
  let best: { id: string; vpPrefix: string; area: number } | null = null;
  for (const [key] of cache) {
    const { vpPrefix, nodeId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
    if (nodeId !== 'root') continue;
    const rect = bridge.getRect('root', vpPrefix);
    if (!rect) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const area = rect.width * rect.height;
    if (!best || area < best.area) best = { id: 'root', vpPrefix, area };
  }
  return best ? { id: best.id, vpPrefix: best.vpPrefix } : null;
}

// ─── Element Relationships ──────────────────────────────────────────────────

/**
 * Get the positioning parent of an element.
 * offsetParent respects CSS positioning (returns the nearest positioned ancestor).
 * Falls back to parentElement for edge cases (display:none elements have null offsetParent).
 */
export function getPositioningParent(el: HTMLElement): HTMLElement | null {
  return (el.offsetParent as HTMLElement) || el.parentElement;
}

// ─── Element Geometry ───────────────────────────────────────────────────────

/** Get element dimensions from the layout box. */
export function getElementSize(el: HTMLElement): { width: number; height: number } {
  // SVG elements return 0 for offsetWidth/Height — use getBoundingClientRect as fallback
  if (el.offsetWidth === 0 && el.offsetHeight === 0) {
    const bcr = el.getBoundingClientRect();
    return { width: bcr.width, height: bcr.height };
  }
  return { width: el.offsetWidth, height: el.offsetHeight };
}

/** Get the positioning parent's inner (content box) dimensions. */
export function getParentInnerSize(el: HTMLElement): { width: number; height: number } {
  const parent = getPositioningParent(el);
  return { width: parent?.clientWidth || 0, height: parent?.clientHeight || 0 };
}

// ─── Component Interaction Redirect ──────────────────────────────────────────

/**
 * Redirect a node ID to its top-level component instance root.
 * When hovering/clicking a child inside a component instance,
 * this returns the instance root ID instead — so the whole component
 * is selected/highlighted as a unit.
 *
 * Handles two cases:
 * 1. Direct lookup: nodeId exists in map and has componentInstanceId
 * 2. Unprefixed lookup: nodeId is a component-internal ID (e.g. "card2-title")
 *    but the map has "auto_0:card2-title" — scan for matching suffix
 *
 * Returns the original ID if the node is not inside a component instance.
 */
/**
 * Walk `componentInstanceId` references until we hit a node that's not
 * inside another component (the OUTERMOST instance). Required for nested
 * instances: clicking a child of `<Outer><Inner/></Outer>` redirects to
 * Inner first (Inner.componentInstanceId === Outer-id), then we need to
 * keep climbing to Outer so the user selects the top-level instance —
 * matching the "instances are opaque to the user" UX for every nested
 * level. Without this, hovering inside a nested instance highlighted
 * the nested wrapper instead of the outer one. Bounded iteration count
 * to defend against any future cycle (shouldn't happen, but cheap
 * insurance).
 */
function walkToOuterInstance(
  startId: string,
  nodesMap: Map<string, import('@/code/parsing/parser').CanvasNode>,
): string {
  let currentId = startId;
  for (let i = 0; i < 16; i++) {
    const n = nodesMap.get(currentId);
    if (!n || !n.componentInstanceId || n.componentInstanceId === currentId) return currentId;
    currentId = n.componentInstanceId;
  }
  return currentId;
}

export function redirectToComponentInstance(
  nodeId: string,
  nodesMap: Map<string, import('@/code/parsing/parser').CanvasNode>,
  isolatedGroupId?: string | null,
): string {
  // Case 1: Direct match
  const node = nodesMap.get(nodeId);
  if (node) {
    // Group-edit isolation: when the clicked node is the immediate child
    // of the isolated group SVG, suppress the SVG-parent climb so the
    // child stays selected as itself instead of folding back into the
    // group as a whole. Required for Figma-style "double-click to enter,
    // then pick a shape" UX.
    if (isolatedGroupId && node.parentId === isolatedGroupId) {
      return walkToOuterInstance(node.componentInstanceId ?? nodeId, nodesMap);
    }
    // SVG climbing — Figma-style "click selects the outermost group;
    // double-click enters". Climbs UP through ALL svg ancestors to find
    // the OUTERMOST <svg> in the chain (so clicking a child of a group
    // SVG resolves to the group as a whole). Two stop conditions:
    //   1. If `isolatedGroupId` is set and an ancestor is the immediate
    //      child of the isolated group → return that ancestor (lets the
    //      user pick individual shapes inside an entered group).
    //   2. Hit a non-SVG ancestor → return the last svg seen (the
    //      outermost svg in the unbroken chain).
    //
    // Also handles the `<g>` wrappers Illustrator/Sketch/Inkscape emit:
    // those are treated as transparent climb steps so a click on a path
    // inside `<g>` doesn't stop at the `<g>`.
    const SVG_INNER_TAGS = new Set(['path', 'polygon', 'polyline', 'line', 'rect', 'circle', 'ellipse', 'g']);
    const isInsideSvg = SVG_INNER_TAGS.has(node.type) || node.type === 'svg';
    if (isInsideSvg && node.parentId) {
      // If this node is itself an SVG, it's a candidate for "outermost"
      // already; otherwise we'll start tracking once we hit an SVG ancestor.
      let topSvg: string | null = node.type === 'svg' ? nodeId : null;
      let cursor: string | null | undefined = node.parentId;
      while (cursor) {
        const ancestor = nodesMap.get(cursor);
        if (!ancestor) break;
        if (ancestor.type === 'svg') {
          // In group-edit isolation: if this svg's parent IS the isolated
          // group, we've found the immediate child of the group — return it
          // so the user selects an individual shape inside the entered group.
          if (isolatedGroupId && ancestor.parentId === isolatedGroupId) {
            return walkToOuterInstance(ancestor.componentInstanceId ?? cursor, nodesMap);
          }
          topSvg = cursor;
        }
        // Stop at the isolated group itself — never select past it.
        if (isolatedGroupId && cursor === isolatedGroupId) break;
        cursor = ancestor.parentId;
      }
      if (topSvg) {
        const top = nodesMap.get(topSvg);
        return walkToOuterInstance(top?.componentInstanceId ?? topSvg, nodesMap);
      }
    }
    return walkToOuterInstance(node.componentInstanceId ?? nodeId, nodesMap);
  }

  // Case 2: nodeId is unprefixed — find the prefixed version in the map
  // (component children have IDs like "auto_0:card2-title" but DOM has data-id="card2-title")
  for (const [fullId, n] of nodesMap) {
    if (fullId.endsWith(':' + nodeId) && n.componentInstanceId) {
      return walkToOuterInstance(n.componentInstanceId, nodesMap);
    }
  }

  return nodeId;
}

/**
 * Group-edit isolation: scope a click to children of an isolated group.
 *
 * When `groupEditingIdAtom` is set (the user double-clicked into a group
 * SVG), all selection clicks inside the canvas need to be reinterpreted:
 *
 *   • Click on a descendant of the group → return the IMMEDIATE CHILD of
 *     the group on that path. This lets the user pick a single shape inside
 *     the group rather than selecting the whole group as `redirectToComponentInstance`
 *     would do (it climbs to the SVG-typed parent, which would always be
 *     the group itself for nested shapes).
 *   • Click on the group itself → return the group id (caller stays in
 *     isolation, just re-selects the group as a unit).
 *   • Click on anything OUTSIDE the group → return null. Caller exits
 *     isolation and proceeds with normal selection of whatever was clicked.
 */
export function getIsolatedChildOfGroup(
  clickedId: string,
  groupId: string,
  nodesMap: Map<string, import('@/code/parsing/parser').CanvasNode>,
): string | null {
  let cursor: string | null | undefined = clickedId;
  while (cursor) {
    if (cursor === groupId) return groupId;
    const n = nodesMap.get(cursor);
    if (!n) return null;
    if (n.parentId === groupId) return cursor;
    cursor = n.parentId;
  }
  return null;
}

/**
 * Find the inner shape child (path/polygon/rect/…) of an SVG shape wrapper.
 * A "Vector" is an `<svg>` wrapper whose shape-tag children carry the actual
 * geometry. Returns the Nth shape child (default: first) with its id, or null
 * when the node isn't an SVG wrapper or has no shape child.
 *
 * Shared by RotateManager, RotateControl and SvgShapeTool so the "which
 * element holds the geometry" lookup lives in exactly one place.
 */
export function findSvgShapeChild(
  node: import('@/code/parsing/parser').CanvasNode | null | undefined,
  nodes: Map<string, import('@/code/parsing/parser').CanvasNode>,
  childIndex = 0,
): { id: string; node: import('@/code/parsing/parser').CanvasNode } | null {
  if (!node || node.type !== 'svg' || !Array.isArray(node.children)) return null;
  let i = 0;
  for (const childId of node.children) {
    const child = nodes.get(childId);
    // motion-ized shapes (`motion.path` — e.g. an inner with per-variant `d`
    // geometry) are still shapes: without the strip, the WHOLE shape
    // machinery (rotate branch, geometry bake) silently skipped them and
    // rotations fell to the generic path with no legacy-attr handling
    // (live find 2026-06-12).
    if (child && SVG_SHAPE_TAGS.has((child.type || '').replace('motion.', ''))) {
      if (i === childIndex) return { id: childId, node: child };
      i++;
    }
  }
  return null;
}

/**
 * The bottom-up list of `<svg>`-GROUP ancestors affected when `nodeId` (a
 * shape, a sub-group, or any nested `<svg>`) changes — for feeding
 * `refitGroupChain`. Walks `parentId` while the node is an `<svg>`, collecting
 * each level that is itself a GROUP (an `<svg>` with at least one `<svg>`
 * child). Includes the starting node when it is itself a group. Stops at the
 * first non-`<svg>` ancestor (a frame/div), so a TOP-LEVEL group and all its
 * nested-group ancestors are covered, recursively, to any depth.
 *
 * Example: a shape inside `inner` inside `outer` → `[inner, outer]`; resizing
 * `inner` (a group) → `[inner, outer]`.
 */
export function getSvgGroupAncestorChain(
  nodeId: string,
  nodes?: Map<string, import('@/code/parsing/parser').CanvasNode>,
): string[] {
  const get = (id: string) => (nodes ? nodes.get(id) : getNodeFromCache(id));
  const out: string[] = [];
  let cur = get(nodeId);
  while (cur && cur.type === 'svg') {
    const isGroup = (cur.children ?? []).some(cid => get(cid)?.type === 'svg');
    if (isGroup) out.push(cur.id);
    cur = cur.parentId ? get(cur.parentId) : undefined;
  }
  return out;
}

/**
 * Redirect ghost (collection repeat) clicks to the template element.
 * Ghost elements have IDs with `__N` suffix (e.g. "member-card__2").
 * Stripping the suffix gives the template ID. Returns null when the id has
 * no ghost suffix.
 */
export function redirectToCollectionTemplate(clickedId: string): string | null {
  if (!isGhostNodeId(clickedId)) return null;
  const templateId = stripGhostSuffix(clickedId);
  trace.action('node-ops:ghost-redirect', { clickedId, templateId });
  return templateId;
}

/**
 * Redirect clicks/hovers on layout elements to the viewport root
 * (`layout::root`). Layout elements (navbar, footer, etc.) inherit from
 * the layout file, not the page — they shouldn't be individually
 * selectable from the page editor. Selecting any of them selects the whole
 * viewport, same as clicking the viewport header.
 *
 * Returns the redirected id, or null if no redirect applies (node is from
 * the page, or is the layout root itself).
 */
export function redirectLayoutNodeToViewport(nodeId: string): string | null {
  // Clicking a locked template node (header / footer / nav — `layout::…`)
  // selects the VIEWPORT. The template is merged ONTO the page root, so the
  // viewport IS `root` now (no separate `layout::root` layer).
  if (!nodeId.startsWith('layout::')) return null;
  return 'root';
}

/**
 * Redirect clicks on FIT text children to their SVG wrapper parent.
 * When a text element is inside an SVG foreignObject FIT wrapper (data-id ends with -svg),
 * the user should interact with the SVG wrapper (to control width/scaling).
 */
export function redirectToFitTextWrapper(nodeId: string, nodes: Map<string, any>): string | null {
  const node = nodes.get(nodeId);
  if (!node?.parentId) return null;
  const parent = nodes.get(node.parentId);
  // Direct parent is SVG wrapper
  if (parent?.type === 'svg' && parent.id?.endsWith('-svg')) {
    trace.action('node-ops:fit-text-redirect', { from: nodeId, to: parent.id });
    return parent.id;
  }
  // Parent is foreignObject, grandparent is SVG wrapper
  if (parent?.type === 'foreignObject' && parent.parentId) {
    const grandparent = nodes.get(parent.parentId);
    if (grandparent?.type === 'svg' && grandparent.id?.endsWith('-svg')) {
      trace.action('node-ops:fit-text-redirect', { from: nodeId, to: grandparent.id });
      return grandparent.id;
    }
  }
  return null;
}

// ─── Direct DOM Style Patches (Bridge Abstraction) ─────────────────────────
// These functions are the ONLY way drag/resize/transform code should mutate
// element styles. In Phase 2 (iframe split) they become postMessage calls.
// Fire-and-forget — no return value, no async. 60fps safe.

/**
 * Patch inline styles on a canvas element. Fire-and-forget, 60fps safe.
 * All drag/resize code should use this instead of direct `el.style.xxx = ...`.
 *
 * In Phase 2 (iframe split) this becomes a postMessage to the sandbox iframe.
 *
 * @param el - The target DOM element (already resolved via getNodeEl/querySelector)
 * @param styles - Record of camelCase CSS properties → values. Empty string removes the property.
 * @param important - If true, uses setProperty with !important (for replicas/variants)
 */
export function patchElementStyles(
  el: HTMLElement,
  styles: Record<string, string>,
  important = false,
): void {
  // Apply to any parent-frame mirror element (no-op when there isn't one)
  for (const [key, value] of Object.entries(styles)) {
    try {
      if (key.startsWith('--')) {
        // Custom property (e.g. overlay-border variable `--X` consumed by an
        // `::after`). Bracket assignment is a silent no-op for these — use
        // setProperty/removeProperty so the live drag updates the overlay.
        if (value === '') el.style.removeProperty(key);
        else el.style.setProperty(key, value, important ? 'important' : '');
      } else if (value === '') {
        (el.style as any)[key] = '';
      } else if (important) {
        const kebab = toKebab(key);
        el.style.setProperty(kebab, value, 'important');
      } else {
        (el.style as any)[key] = value;
      }
    } catch { /* skip invalid property */ }
  }

  // Forward to the sandbox iframe (the visible canvas DOM)
  const nodeId = el.getAttribute('data-id') || '';
  const fullId = el.getAttribute('data-node-id') || '';
  // vpPrefix is the part of data-node-id before the nodeId (e.g. "tablet-" for "tablet-abc123")
  const vpPrefix = fullId && nodeId && fullId.endsWith(nodeId)
    ? fullId.slice(0, fullId.length - nodeId.length)
    : '';
  if (nodeId) {
    getCanvasBridge().patchStyles(nodeId, vpPrefix, styles, important);
  }
}

/**
 * Patch inline styles on a canvas element by node ID. Resolves the element internally.
 * Convenience wrapper over patchElementStyles for code that has nodeId but not the element.
 *
 * @param contentEl - The content root element
 * @param nodeId - The node's data-id
 * @param vpPrefix - The viewport prefix ('' for primary, 'tablet-' etc for replicas)
 * @param styles - Record of camelCase CSS properties → values
 * @param important - If true, uses setProperty with !important
 */
/** Live/instant preview of a VARIANT svg group child's BOX (left/top/width/
 *  height in group units) — patch the WRAPPER's folded transform, the same
 *  channel the commit paints. Patching x/y/width/height ATTRS here is wrong
 *  twice on a variant painting: the attrs move the box in the BASE frame
 *  while the existing folded variant transform (deltas/scale/rotate) stays
 *  applied ON TOP (double-composition), and the px carrier origin stays at
 *  the base attrs. Live find 2026-06-12: width-resize of a rotated+scaled
 *  variant child offset on mouseup. Returns false when this isn't a variant
 *  svg-child box write (caller falls back to its existing path).
 *
 *  COALESCED per task: ResizeManager patches the box in FRAGMENTS — separate
 *  patchNodeStyles calls for height, left, top within one tick. Converting
 *  each fragment alone (against the stale entry) produced three CONTRADICTORY
 *  transforms per frame — the painting flickered "in random places" (trace
 *  2026-06-12: {height:175}→scaleY 0.8794 then {top:52}→scaleY 0.9548, same
 *  millisecond). Fragments merge into a pending box and ONE microtask applies
 *  the atomic conversion; the pending entry clears after each apply, so
 *  nothing leaks across gestures. */
const _pendingSvgChildBoxPreview = new Map<string, { nodeId: string; vpPrefix: string; vpId: string; box: Record<string, string> }>();
/** Per-microtask coalescing of PRIMARY svg-child attr ticks (see
 *  patchNodeStyles redirect) — keyed `${vpPrefix}|${nodeId}`, holds merged
 *  x/y/width/height attr updates for one tick's fragmented calls. */
const _pendingSvgChildAttrTick = new Map<string, Record<string, string>>();

/** Commit-time supersede for the svg-child attr-tick coalescer. A group-child
 *  COMMIT runs in the same task as its last live left/top patch: the live
 *  patch sits in `_pendingSvgChildAttrTick` waiting for its microtask while
 *  the commit synchronously refits the group and bridge-patches the POST-refit
 *  finals — then the microtask fires and posts the PRE-refit live values
 *  AFTER them (comlink is FIFO on send order). The sandbox child ended one
 *  refit behind the wrapper: painted ~refit-delta off after mouseup, and the
 *  next drag started offset (user report 2026-07-28, caught by
 *  svg-group-drag-stability.spec's MutationObserver: y 0 → -198, 3ms apart).
 *  Merging the committed finals INTO the pending tick makes the trailing
 *  microtask post the same finals — a harmless double-write that also keeps
 *  the tick's carrier-origin refresh computing from post-refit attrs. */
export function supersedePendingSvgChildAttrTick(nodeId: string, vpPrefix: string, finalAttrs: Record<string, string>): void {
  const tickKey = `${vpPrefix}|${nodeId}`;
  const pending = _pendingSvgChildAttrTick.get(tickKey);
  if (!pending) return;
  Object.assign(pending, finalAttrs);
  trace.action('node-ops:svg-child-tick-superseded', { nodeId, vpPrefix, keys: Object.keys(finalAttrs) });
}

function applySvgChildBoxPreview(key: string): void {
  const pending = _pendingSvgChildBoxPreview.get(key);
  if (!pending) return;
  _pendingSvgChildBoxPreview.delete(key);
  const { nodeId, vpPrefix, vpId, box } = pending;
  const node = getNodeFromCache(nodeId);
  const parent = node?.parentId ? getNodeFromCache(node.parentId) : null;
  if (node?.type !== 'svg' || parent?.type !== 'svg') return;
  const conv = groupChildBoxToMotion(box, node as any, vpId);
  const prev = (node.motionVariants?.[vpId] ?? {}) as Record<string, string | number>;
  const merged: Record<string, string | number> = { ...prev };
  for (const [k, v] of Object.entries(conv.styles)) {
    if (v !== '') merged[k] = v;
    else delete merged[k];
  }
  const folded = motionPropsToCSSTransform(merged);
  const carrier = svgChildCarrierOrigin(node.attrs, parent.attrs?.viewBox);
  getCanvasBridge().patchStyles(nodeId, vpPrefix, {
    transform: folded,
    transformBox: carrier.transformBox,
    transformOrigin: carrier.transformOrigin,
  }, true);
  // GEOMETRY channel (rotated children): the size paints as scaled inner `d`s
  // — patch each per-tile (index-aligned with the node's children order) so
  // the live tick equals the commit. The fold above carries translate+rotate
  // only (the conversion cleared the CSS scale).
  if (conv.sizeChannel === 'geometry') {
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    if (bridge.setChildShapeAttribute) {
      conv.innerGeometry.forEach((ig, idx) => {
        bridge.setChildShapeAttribute!(nodeId, vpPrefix, idx, 'd', ig.d);
      });
    }
  }
  trace.action('patchVariantSvgChildBoxPreview', {
    nodeId, vpPrefix, box, folded, channel: conv.sizeChannel, innerCount: conv.innerGeometry.length,
  });
}

function patchVariantSvgChildBoxPreview(
  nodeId: string,
  vpPrefix: string,
  styles: Record<string, string>,
): boolean {
  const vpId = vpIdFromPrefix(vpPrefix || 'desktop');
  if (!vpPrefix || isPrimaryViewport(vpId) || !isComponentFilePath(_activeFilePath)) return false;
  const node = getNodeFromCache(nodeId);
  const parent = node?.parentId ? getNodeFromCache(node.parentId) : null;
  if (node?.type !== 'svg' || parent?.type !== 'svg') return false;
  const box: Record<string, string> = {};
  for (const k of ['left', 'top', 'width', 'height'] as const) {
    if (styles[k] != null && styles[k] !== '') box[k] = styles[k];
  }
  if (Object.keys(box).length === 0) return false;
  const key = `${vpPrefix}${nodeId}`;
  const pending = _pendingSvgChildBoxPreview.get(key);
  if (pending) {
    Object.assign(pending.box, box);
  } else {
    _pendingSvgChildBoxPreview.set(key, { nodeId, vpPrefix, vpId, box });
    queueMicrotask(() => applySvgChildBoxPreview(key));
  }
  return true;
}

export function patchNodeStyles(
  contentEl: HTMLElement,
  nodeId: string,
  vpPrefix: string,
  styles: Record<string, string>,
  important = false,
): void {
  // SVG-group child redirect: nested `<svg>` inside a group SVG positions
  // via x/y attrs, not CSS. ResizeManager calls patchNodeStyles with
  // `{ left, top, width, height }` during live resize — for normal
  // elements those land as CSS and the visual moves; for nested SVGs
  // CSS `left/top` don't apply, so resize-with-position-change (e.g.
  // dragging the top-left handle, OR a bottom-right handle that crosses
  // the zero-crossing flip and now needs to move the wrapper) fails to
  // update visually. Bridge-patch the corresponding SVG attrs instead.
  const node = getNodeFromCache(nodeId);
  const parentNode = node?.parentId ? getNodeFromCache(node.parentId) : null;
  if (node?.type === 'svg' && parentNode?.type === 'svg') {
    // VARIANT painting: preview via the folded wrapper transform (the commit's
    // own channel) — attr patches double-compose with the existing fold.
    if (!patchVariantSvgChildBoxPreview(nodeId, vpPrefix, styles)) {
      const attrUpdates: Record<string, string> = {};
      if (styles.left != null) attrUpdates.x = `${parseFloat(styles.left) || 0}`;
      if (styles.top != null) attrUpdates.y = `${parseFloat(styles.top) || 0}`;
      if (styles.width != null) attrUpdates.width = `${parseFloat(styles.width) || 0}`;
      if (styles.height != null) attrUpdates.height = `${parseFloat(styles.height) || 0}`;
      if (Object.keys(attrUpdates).length > 0) {
        // ResizeManager sends one tick as SEPARATE calls ({width}, {height},
        // {left, top}). Coalesce them per microtask and emit ONE patch — a
        // per-fragment emit computed the carrier origin below from the stale
        // cache for whichever box keys that fragment lacked (live repro
        // 2026-06-12: origin = old-x + new-w/2 → the painted box rode a wrong
        // pivot the whole gesture and "snapped" on mouseup).
        const tickKey = `${vpPrefix}|${nodeId}`;
        const pendingTick = _pendingSvgChildAttrTick.get(tickKey);
        if (pendingTick) {
          Object.assign(pendingTick, attrUpdates);
        } else {
          _pendingSvgChildAttrTick.set(tickKey, { ...attrUpdates });
          queueMicrotask(() => {
            const merged = _pendingSvgChildAttrTick.get(tickKey);
            _pendingSvgChildAttrTick.delete(tickKey);
            if (!merged) return;
            const nodeNow = getNodeFromCache(nodeId);
            const parentNow = nodeNow?.parentId ? getNodeFromCache(nodeNow.parentId) : null;
            // PRIMARY-rotated (motion channel): the wrapper's CSS rotation
            // pivots at the view-box PX carrier — a fixed point. Moving the
            // attrs under it makes the painted box ORBIT the stale pivot for
            // the whole gesture (live find 2026-06-12: primary rotated resize
            // "offsets and shrinks weirdly during"). Refresh the origin to
            // the live box centre in the SAME patch so the rotation stays
            // pinned to the box.
            const carrierTick: Record<string, string> = {};
            const defRot = parseFloat(String(nodeNow?.motionVariants?.default?.rotate ?? '0')) || 0;
            if (Math.abs(defRot) > 0.001 || nodeNow?.styles?.transformBox === 'view-box') {
              const liveBox = {
                x: merged.x != null ? parseFloat(merged.x) : (parseFloat(nodeNow?.attrs?.x ?? '0') || 0),
                y: merged.y != null ? parseFloat(merged.y) : (parseFloat(nodeNow?.attrs?.y ?? '0') || 0),
                w: merged.width != null ? parseFloat(merged.width) : (parseFloat(nodeNow?.attrs?.width ?? '0') || 0),
                h: merged.height != null ? parseFloat(merged.height) : (parseFloat(nodeNow?.attrs?.height ?? '0') || 0),
              };
              const c = svgChildCarrierOrigin(
                { x: `${liveBox.x}`, y: `${liveBox.y}`, width: `${liveBox.w}`, height: `${liveBox.h}` },
                parentNow?.attrs?.viewBox,
              );
              carrierTick.transformOrigin = c.transformOrigin;
            }
            getCanvasBridge().patchAttrsAndStyles(nodeId, vpPrefix, merged, carrierTick);
          });
        }
      }
    }
  }

  const el = contentEl.querySelector(`[data-node-id="${vpPrefix}${nodeId}"]`) as HTMLElement | null;
  if (el) {
    patchElementStyles(el, styles, important);
  } else {
    // Element lives in the sandbox iframe — patch via bridge directly
    getCanvasBridge().patchStyles(nodeId, vpPrefix, styles, important);
  }
}

// ─── Node Mutations (Imperative-First) ──────────────────────────────────────
// Every mutation: 1) update DOM instantly  2) queue code mutation async
// The render effect skips via updatingFromCanvas ref (see lesson 08).

/** Callback for mousedown on imperatively-created elements */
export type NodeMouseDownHandler = (nodeId: string, e: MouseEvent) => void;

/**
 * Create a new node and insert it into the DOM + code.
 * Instant visual. Code catches up async.
 */
/**
 * When a new CONTENT node is added to a frame that already holds a positioned
 * BACKGROUND layer — an absolute/fixed child such as a GradientAura code
 * component or an absolute image aura — the new node would paint BEHIND it. A
 * positioned element later in the DOM out-paints a static / z-index:auto/0
 * sibling regardless of source order (CSS stacking: painting step 6 vs 3), so
 * the backdrop covers the fresh element and the user has to hand-set z-index
 * just to see it. standard, new content should sit ON TOP of the backdrop.
 *
 * Returns the z-index to give the new node so it clears the backdrop (and sits
 * at the existing content layer), or undefined when the parent has NO positioned
 * background — then we leave z-index unset.
 */
export function zIndexAboveBackgroundLayer(parentId: string): string | undefined {
  const parent = getNodeFromCache(parentId);
  if (!parent || !Array.isArray(parent.children) || parent.children.length === 0) return undefined;
  const zOf = (z: string | undefined): number => {
    if (z == null || z === '' || z === 'auto') return 0;
    const n = parseInt(z, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  let maxBgZ = -Infinity;   // highest z among positioned BACKDROP children (z ≤ 0 / auto)
  let maxContentZ = 0;      // highest explicit z among in-flow content children
  for (const childId of parent.children) {
    const child = getNodeFromCache(childId);
    if (!child) continue;
    const pos = child.styles?.position;
    if (pos === 'absolute' || pos === 'fixed') {
      // Only a LOW/zero-z positioned element is a "backdrop" to clear. A
      // positioned element at z ≥ 1 is an intentional FOREGROUND layer — don't
      // leap a new content node above it.
      const z = zOf(child.styles?.zIndex);
      if (z <= 0) maxBgZ = Math.max(maxBgZ, z);
    } else {
      const z = child.styles?.zIndex;
      if (z != null && z !== '' && z !== 'auto') maxContentZ = Math.max(maxContentZ, zOf(z));
    }
  }
  if (maxBgZ === -Infinity) return undefined;  // no positioned backdrop to clear
  return String(Math.max(maxBgZ + 1, maxContentZ));
}

export function createNode(options: {
  id: string;
  type?: string;
  name?: string;
  styles: Record<string, string>;
  parentEl: HTMLElement;
  parentId: string;
  index?: number;
  isCanvasNode?: boolean;
  contentEl?: HTMLElement;  // required for canvas nodes (append to content root)
  onMouseDown?: NodeMouseDownHandler;
  textContent?: string;
}): HTMLElement {
  const { id, type = 'div', name, styles, parentEl, parentId, index, isCanvasNode, contentEl, onMouseDown, textContent } = options;

  // Auto-clear a positioned background layer (e.g. a GradientAura) so the new
  // node isn't hidden behind it (CSS stacking). Only when the caller didn't set
  // z-index itself, and only for in-viewport nodes (canvas nodes float freely).
  if (!isCanvasNode && styles.zIndex == null) {
    const bgZ = zIndexAboveBackgroundLayer(parentId);
    if (bgZ) {
      styles.zIndex = bgZ;
      trace.action('nodeOps.createNode:z-above-background', { id, parentId, zIndex: bgZ });
    }
  }

  trace.fn('nodeOps.createNode', { id, parentId, isCanvasNode, index });

  // 1. Create DOM element
  const nodeEl = el(type as any, {
    attrs: { 'data-node-id': id, 'data-id': id, ...(name ? { 'data-name': name } : {}) },
    styles: styles as any,
  });

  // Set text content if provided
  if (textContent) {
    nodeEl.textContent = textContent;
  }

  if (onMouseDown) {
    nodeEl.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      onMouseDown(id, e);
    });
  }

  // 2. Insert into DOM
  if (isCanvasNode && contentEl) {
    contentEl.appendChild(nodeEl);
  } else if (index !== undefined && index < parentEl.children.length) {
    parentEl.insertBefore(nodeEl, parentEl.children[index]);
  } else {
    parentEl.appendChild(nodeEl);
  }

  // 3. Inject into cached nodes Map so PropertiesPanel shows immediately
  injectNodeIntoCache({
    id, type, name: name || type,
    parentId: isCanvasNode ? null : parentId,
    children: [], styles, attrs: {}, textContent: textContent || '', hasMixedContent: false, order: 0,
    isCanvasNode: !!isCanvasNode,
    componentFile: null, componentInstanceId: null, isComponentRoot: false,
    motionVariants: null, motionVariantsRef: null, motionProps: null,
    responsiveVariantMap: null, conditionalStyles: null,
  });

  // 4. Queue code mutation (async — code catches up)
  if (isCanvasNode) {
    queueMutation({ type: 'addCanvasNode', node: { id, type, styles, name, textContent } });
  } else {
    queueMutation({ type: 'addNode', parentId, node: { id, type, styles, name, textContent }, index });
  }

  return nodeEl;
}

/**
 * Remove a node from the DOM + code.
 * Instant visual. Code catches up async.
 */
export function removeNode(options: {
  id: string;
  contentEl: HTMLElement;
  viewportPrefix?: string;
}): void {
  const { id, contentEl, viewportPrefix = '' } = options;

  trace.fn('nodeOps.removeNode', { id });

  // 1. Remove from DOM (all viewports). Canvas content lives in the cross-origin
  //    iframe, so the parent-frame querySelector below is a no-op for real nodes —
  //    tell the IFRAME to drop the element NOW via the bridge. This is what makes a
  //    delete vanish on the keystroke instead of waiting ~0.3s for the async
  //    removeNode mutation → re-parse → iframe re-render. The element is already
  //    gone by then, so that pass just confirms it. (DirectBridge has no iframe →
  //    the optional method is undefined → the parent-frame line below handles it.)
  getCanvasBridge().removeElement?.(id);
  contentEl.querySelectorAll(`[data-id="${id}"]`).forEach(el => el.remove());

  // 2. Update cache (PropertiesPanel reflects immediately)
  removeNodeFromCache(id);

  // 3. Queue code mutation
  queueMutation({ type: 'removeNode', nodeId: id });
}

/**
 * Update styles on a node. Instant DOM patch + async code mutation.
 *
 * CENTRALIZED ROUTING — auto-detects the correct mutation target from global context:
 * - Component file + non-primary variant → writes to framer-motion variants object
 * - Page file + non-primary viewport (replica) → writes to @container CSS
 * - Primary / default → writes to inline style
 *
 * ALL callers (resize, drag, properties panel, controls) use this one function.
 * No one needs to pass variant/replica context — it's read from setStyleContext().
 */
/**
 * Lazily wire a component master so its instances' width/height override the
 * variant size (see `instance-size-override`). Idempotent + cheap-guarded:
 * resolves the master file from the instance node's `componentFile`, skips when
 * already wired or unresolvable. Called on a committed instance size write.
 */
function ensureMasterInstanceSizeOverride(instanceId: string): void {
  const node = getNodeFromCache(instanceId) as { componentFile?: string | null } | undefined;
  const masterPath = node?.componentFile;
  if (!masterPath) return;
  const existing = projectFS.readFile(masterPath);
  if (!existing || hasInstanceSizeOverride(existing)) return;
  // Defer: let the current updateNodeStyles finish queuing the instance's own
  // style write first, so modifyProjectFile's flush commits both together and
  // we avoid a re-entrant flush mid-interaction.
  queueMicrotask(() => {
    const fresh = projectFS.readFile(masterPath);
    if (!fresh || hasInstanceSizeOverride(fresh)) return;
    modifyProjectFile(masterPath, ensureInstanceSizeOverride);
    trace.action('nodeOps:ensureMasterInstanceSizeOverride', { instanceId, masterPath });
  });
}

export function updateNodeStyles(options: {
  id: string;
  styles: Record<string, string>;
  contentEl: HTMLElement;
  viewportPrefix?: string;
  /** DOM-only mode: skip cache update and mutation queue. Used during live drag/resize
   *  onMove so replicas reflect changes instantly without flooding the mutation queue. */
  domOnly?: boolean;
  /** The caller already queued the group-child VARIANT COMPENSATION itself
   *  (the bake commit, which has the fresh geometry in hand) — the redirect's
   *  generic compensation must not run a second time. */
  skipVariantCompensation?: boolean;
}): void {
  // View-only gate. Every style write in the editor (drag, resize,
  // controls, etc.) lands here — early-return for viewers so writes
  // bottom-out safely. The drag/resize gesture entry-points + canvas
  // pointer-events overlay block the gesture from starting, this is
  // the safety net for anything that slips through.
  if (isViewerMode()) {
    trace.fn('updateNodeStyles:blocked-viewer', { id: options.id });
    return;
  }
  const { id, contentEl, domOnly = false } = options;
  let styles = options.styles;

  // TRANSPARENT_COLOR (oracle, tier 2) — the builder must satisfy its own gate.
  // Every style write in the editor funnels through here, so normalising once
  // at the entry covers controls, drag, resize, paste and plugins alike; a page
  // that had only ever been touched in the builder was still shipping 14 of
  // these (user report 2026-07-26).
  styles = normalizeTransparent(styles);

  // UNHIDE auto-restore: when an incoming write clears `display` (sets
  // it to `''`) on a node that has flex/grid layout properties
  // authored elsewhere in its style map, substitute the matching real
  // display value (`'flex'` / `'grid'`) so unhiding doesn't leave the
  // element rendering as `block` and silently drop the layout. Covers
  // every unhide path centrally (StylesTool Hide button, LayersPanel
  // eye icon, command palette toggle, future tools) — each just
  // writes `display: ''` and gets the right display back.
  //
  // Skipped when:
  //   - `display` isn't in the write (nothing to substitute).
  //   - The write's `display` is non-empty (the caller's value wins).
  //   - The node has no flex/grid props (nothing to preserve).
  //
  // The substitution is done on a COPY of styles so we don't mutate
  // the caller's object.
  // PAGE FILES ONLY. On a COMPONENT, an unhide (`display: ''`) is owned by the
  // variant-visibility systems further down: `setVariantVisibility` (unwraps the
  // `<AnimatePresence>{cond && …}` for a normal node) or the inline `display`
  // ternary (CMS `.map()` rows). Both restore visibility WITHOUT needing an inline
  // `display:flex`. If we auto-restore '' → 'flex' here for a flex/grid component
  // node, `displayWriteVal` is no longer '' by the time the setVariantVisibility
  // interception runs → it's skipped → the `{false && …}` wrapper is NEVER unwrapped
  // and the eye stays shut forever after the first hide (the reported bug). So skip
  // the substitution on component files and let the unhide flow to the unwrap path.
  if (!domOnly && !isComponentFilePath(_activeFilePath) && Object.prototype.hasOwnProperty.call(styles, 'display') && styles.display === '') {
    const node = getNodeFromCache(id);
    const nodeStyles = node?.styles ?? {};
    // Check both incoming write AND existing source for flex/grid
    // indicators — the user might be writing flex props AND clearing
    // display in the same call (less common but possible).
    const combined = { ...nodeStyles, ...styles };
    const hasGrid = !!combined.gridTemplateColumns
      || !!combined.gridTemplateRows
      || !!combined.gridAutoFlow
      || !!combined.gridAutoColumns
      || !!combined.gridAutoRows;
    const hasFlex = !!combined.flexDirection
      || !!combined.alignItems
      || !!combined.justifyContent
      || !!combined.flexWrap
      || (combined.gap !== undefined && combined.gap !== '');
    if (hasGrid || hasFlex) {
      const restoredDisplay = hasGrid ? 'grid' : 'flex';
      trace.action('updateNodeStyles:unhide-auto-restore-display', {
        id, restoredDisplay, hasGrid, hasFlex,
      });
      styles = { ...styles, display: restoredDisplay };
    }
  }

  // SHORTHAND/LONGHAND HEAL — padding & margin. Legacy imports leave BOTH
  // the shorthand and longhands in one style object (`paddingTop: '66px',
  // …, padding: '34px'`). React/deploy resolve that in key order (trailing
  // shorthand wins), while longhand-preferring readers see the longhands —
  // so code/panel and the rendered DOM permanently disagree, and undoing
  // back to the mixed object reads as "the DOM ignored the code" (the CTA
  // padding-undo report). Whenever a primary write touches a longhand on
  // such a node, fold the source shorthand into the sides this write
  // doesn't set and delete it ('' = remove) — one edit permanently heals
  // the file. Primary page writes only: replica writes land in @media
  // !important overrides (which out-rank the base shorthand anyway), and
  // component writes route into variant objects where injected extra keys
  // don't belong.
  //
  // The primary gate is `isPrimaryViewport(_interactingVpId)`, NOT the absence
  // of `options.viewportPrefix`: that flag says "this caller patched a specific
  // tile's DOM", which replica CALLERS don't necessarily set. PaddingHandles
  // commits its source write without one, so heal ran on a mobile-replica drag
  // and did real damage (user report 2026-07-26) — it folded the node's BASE
  // padding (`58px`) into the two sides the drag didn't touch and emitted the
  // `padding: ''` delete, both of which routed into the mobile @media band:
  //   before  { padding: 12px !important; gap: 46px !important }
  //   after   { gap: 46px !important; padding-right: 58px !important;
  //             padding-left: 58px !important; padding-top: 78px !important; … }
  // So the band lost its own 12px shorthand and PINNED the primary's 58px onto
  // left/right as a replica override. Nothing needed healing there: the band's
  // `!important` already out-ranks the base shorthand, and a shorthand followed
  // by longhands inside ONE rule resolves correctly on its own.
  if (!domOnly && !options.viewportPrefix && !isComponentFilePath(_activeFilePath)
    && isPrimaryViewport(_interactingVpId)) {
    const nodeStyles = getNodeFromCache(id)?.styles;
    if (nodeStyles) {
      for (const base of ['padding', 'margin'] as const) {
        const extra = healSpacingShorthand(styles, nodeStyles, base);
        if (extra) {
          trace.action('updateNodeStyles:shorthand-heal', { id, base, extra, vpId: _interactingVpId });
          styles = { ...extra, ...styles };
        }
      }
      // POSITION_OFFSET_REQUIRES_ABSOLUTE — drop zero left/top/right/bottom on a
      // relative/static node. They place nothing, but the Position tool's pin
      // detector matches '0px', so they read as phantom PINS in the panel.
      const inert = healInertOffsets(nodeStyles);
      if (inert) {
        trace.action('updateNodeStyles:inert-offset-heal', { id, inert, vpId: _interactingVpId });
        styles = { ...inert, ...styles };
      }
    }
  } else if (!domOnly && !isComponentFilePath(_activeFilePath) && !isPrimaryViewport(_interactingVpId)) {
    trace.fn('updateNodeStyles:shorthand-heal-skipped-replica', {
      id, vpId: _interactingVpId, styleKeys: Object.keys(styles),
    });
  }

  // PER-VARIANT box writes (computed here, used by BOTH svg blocks below): on
  // a component master's non-default variant tile, an svg wrapper's box is
  // per-variant — the shared-geometry paths (group normalize, group-child attr
  // redirect) must be skipped so the write falls through to the standard
  // replica-context routing (variant entry).
  const isVariantTileBoxWrite = !domOnly
    && isComponentFilePath(_activeFilePath)
    && !isPrimaryViewport(_interactingVpId);

  // SVG group resize: when the GROUP itself (an `<svg>` whose direct
  // children include other `<svg>`s) gets its width/height updated,
  // normalize its viewBox to match the new pixel dimensions and scale
  // children proportionally. Without this, viewBox stays at the OLD
  // dimensions while CSS width/height change → 1 viewBox unit no longer
  // equals 1 pixel → drag deltas (in pixels) get written as viewBox
  // units, producing the "moves very slowly + reverts to pre-resize
  // size on commit" symptom that arises after every group resize.
  // Runs only on real source writes (not domOnly live ticks), and only on the
  // PRIMARY: a variant-tile resize must not normalize the SHARED viewBox/
  // children — its box is per-variant (see isVariantTileBoxWrite below).
  if (!domOnly && !isVariantTileBoxWrite && (styles.width != null || styles.height != null)) {
    const groupNode = getNodeFromCache(id);
    if (groupNode?.type === 'svg') {
      const hasSvgChildren = (groupNode.children ?? []).some(cid => {
        const c = getNodeFromCache(cid);
        return c?.type === 'svg';
      });
      if (hasSvgChildren) {
        // On a single-axis resize (e.g. bottom edge) `styles` carries only the
        // changed dimension; the unchanged one falls back to the group's CURRENT
        // size. A NESTED group keeps its box in `x/y/width/height` ATTRIBUTES, so
        // its current width/height live in `attrs`, NOT `styles` — without the
        // attrs fallback `newW` collapses to 0 on a height-only resize, the
        // `newW>0 && newH>0` guard skips normalizeGroupOnResize, and the group's
        // viewBox never re-matches its box (1 unit ≠ 1px → children stretch/
        // squish, "jumps and changes height completely").
        const curW = groupNode.styles?.width ?? groupNode.attrs?.width;
        const curH = groupNode.styles?.height ?? groupNode.attrs?.height;
        const newW = parseFloat(styles.width ?? curW ?? '0') || 0;
        const newH = parseFloat(styles.height ?? curH ?? '0') || 0;
        if (newW > 0 && newH > 0) {
          // normalizeGroupOnResize writes children scaling + viewBox +
          // style.width/height AND any left/top move in ONE source
          // transaction. Strip width/height/left/top from the styles map so
          // the standard write below doesn't double-write them — a second
          // write would bump the version again and could land between
          // normalize's bump and the next render, briefly painting the group
          // at its old size/position for a frame (the flash/JUMP the user
          // reported, specifically on TOP/LEFT-edge resizes where left/top
          // move together with the size).
          const newLeftPx = styles.left != null ? parseFloat(styles.left) : undefined;
          const newTopPx = styles.top != null ? parseFloat(styles.top) : undefined;
          normalizeGroupOnResize(_activeFilePath, id, newW, newH, newLeftPx, newTopPx);
          // Resizing a NESTED group changes its attribute box, so every group
          // ABOVE it must shrink-wrap to the new bounds (recursive). Skip the
          // group itself (index 0) — normalizeGroupOnResize already set its box.
          const ancestors = getSvgGroupAncestorChain(id).filter(gid => gid !== id);
          if (ancestors.length > 0) refitGroupChain(ancestors, _activeFilePath);
          const { width: _w, height: _h, left: _l, top: _t, ...rest } = styles;
          styles = rest;
        }
      }
    }
  }

  // SVG group child redirect: nested `<svg>` elements inside a group SVG
  // are positioned via `x/y` SVG ATTRS and sized via `width/height` SVG
  // attrs — NOT CSS. Writing CSS styles to source has no visual effect
  // and the wrapper width/height stay stale. Detect via parent type and
  // route position/size writes through `moveChildAndRefitGroup` (same
  // path the drag commit uses). domOnly mode (live resize/drag tick)
  // still needs to mirror to DOM so the user sees the resize, but
  // through SVG attrs — so we skip the `moveChildAndRefitGroup` source
  // write and just patch attrs in DOM.
  const nodeForRouting = getNodeFromCache(id);
  const parentForRouting = nodeForRouting?.parentId ? getNodeFromCache(nodeForRouting.parentId) : null;
  // PER-VARIANT box exception: on a component master's non-default variant
  // tile this redirect must NOT run for the SOURCE write — x/y/width/height
  // ATTRS are SHARED by every variant painting (and moveChildAndRefitGroup
  // re-bases the shared group box), so the "redirect" silently resized every
  // variant or got dropped, and the variant tile reverted on the next rebuild
  // ("commits on mouse-up but reverts when I drag again", no entry in code).
  // Fall through to the standard replica-context routing below instead:
  // width/height land in the VARIANT ENTRY (CSS geometry properties override
  // the shared attrs on this tile only — same channel as top-level svg
  // wrappers' isSvgSize exception) and left/top become x/y translate DELTAS
  // (leftTopToXY). The flush rebuild repaints the tile from the variant entry,
  // replacing the live attr preview from the domOnly ticks, which keep the
  // per-tile bridge attr patch below.
  if (nodeForRouting?.type === 'svg' && parentForRouting?.type === 'svg' && isVariantTileBoxWrite) {
    trace.action('updateNodeStyles:svg-child-variant-box-route', {
      id, vpId: _interactingVpId, keys: Object.keys(styles),
    });
  }
  if (nodeForRouting?.type === 'svg' && parentForRouting?.type === 'svg' && !isVariantTileBoxWrite) {
    // VARIANT-TILE domOnly TICK: the box preview must be the FOLDED wrapper
    // transform, NOT an attr patch — the attrs are the SHARED base the variant
    // fold multiplies on top of. Patching width=W per tick while the folded
    // scaleX(W/base) also applies painted the box at W·(W/base): the live
    // repro measured the right edge running 125px past the cursor,
    // accelerating, then snapping correct on mouse-up when the rebuild
    // restored the attrs (live find 2026-06-12, the "going completely crazy"
    // resize). Same preview the commit path and patchNodeStyles use.
    const isVariantTileTick = domOnly
      && isComponentFilePath(_activeFilePath)
      && !isPrimaryViewport(_interactingVpId);
    if (isVariantTileTick) {
      const vpPrefixTick = options.viewportPrefix ?? getViewportPrefix(_interactingVpId);
      if (patchVariantSvgChildBoxPreview(id, vpPrefixTick, styles)) {
        const remainingTick = { ...styles };
        delete remainingTick.left; delete remainingTick.top;
        delete remainingTick.width; delete remainingTick.height;
        if (Object.keys(remainingTick).length === 0) return;
        styles = remainingTick;
      }
    }
    const attrUpdates: Record<string, string> = {};
    if (styles.left != null) attrUpdates.x = `${parseFloat(styles.left) || 0}`;
    if (styles.top != null) attrUpdates.y = `${parseFloat(styles.top) || 0}`;
    if (styles.width != null) attrUpdates.width = `${parseFloat(styles.width) || 0}`;
    if (styles.height != null) attrUpdates.height = `${parseFloat(styles.height) || 0}`;
    if (Object.keys(attrUpdates).length > 0) {
      const vpPrefixSvg = options.viewportPrefix ?? getViewportPrefix(_interactingVpId);
      // Always mirror to iframe DOM so the live resize tick / drag-end
      // visual stays at the new position+size. A motion-rotated child's
      // carrier origin rides along (same rationale as patchNodeStyles).
      const carrierMirror: Record<string, string> = {};
      const defRotMirror = parseFloat(String(nodeForRouting.motionVariants?.default?.rotate ?? '0')) || 0;
      if (Math.abs(defRotMirror) > 0.001 || nodeForRouting.styles?.transformBox === 'view-box') {
        const liveBox = {
          x: attrUpdates.x != null ? parseFloat(attrUpdates.x) : (parseFloat(nodeForRouting.attrs?.x ?? '0') || 0),
          y: attrUpdates.y != null ? parseFloat(attrUpdates.y) : (parseFloat(nodeForRouting.attrs?.y ?? '0') || 0),
          w: attrUpdates.width != null ? parseFloat(attrUpdates.width) : (parseFloat(nodeForRouting.attrs?.width ?? '0') || 0),
          h: attrUpdates.height != null ? parseFloat(attrUpdates.height) : (parseFloat(nodeForRouting.attrs?.height ?? '0') || 0),
        };
        carrierMirror.transformOrigin = svgChildCarrierOrigin(
          { x: `${liveBox.x}`, y: `${liveBox.y}`, width: `${liveBox.w}`, height: `${liveBox.h}` },
          parentForRouting.attrs?.viewBox,
        ).transformOrigin;
      }
      getCanvasBridge().patchAttrsAndStyles(id, vpPrefixSvg, attrUpdates, carrierMirror);
      if (!domOnly) {
        // REFIT GATE + VARIANT COMPENSATION (primary resize/move of a group
        // child whose group carries per-variant values): the refit re-bases
        // the group box + EVERY child's attrs (trace 2026-06-12:
        // refit-group:committed dx −67 dy −365 after a primary height resize)
        // — and the variant entries (x/y deltas, scales, geometry d, px
        // metadata, carrier origin) are all RELATIVE to those attrs, so every
        // variant painting jumped. Same law as the drag commit's refit gate +
        // detach compensation, extended for size: keep the group box FIXED,
        // write the child's attrs plainly, and rewrite this child's variant
        // entries against the new base so each variant's PAINTING is
        // untouched. (The bake path flushes its shared geometry before this
        // runs, so the cache already holds the new base d for re-derivation.)
        if (groupChildrenCarryVariantGeometry(nodeForRouting.parentId!)) {
          const skipComp = (options as { skipVariantCompensation?: boolean }).skipVariantCompensation === true;
          const oldBox = {
            x: parseFloat(nodeForRouting.attrs?.x ?? '0') || 0,
            y: parseFloat(nodeForRouting.attrs?.y ?? '0') || 0,
            w: parseFloat(nodeForRouting.attrs?.width ?? '0') || 0,
            h: parseFloat(nodeForRouting.attrs?.height ?? '0') || 0,
          };
          const newBox = {
            x: attrUpdates.x != null ? parseFloat(attrUpdates.x) : oldBox.x,
            y: attrUpdates.y != null ? parseFloat(attrUpdates.y) : oldBox.y,
            w: attrUpdates.width != null ? parseFloat(attrUpdates.width) : oldBox.w,
            h: attrUpdates.height != null ? parseFloat(attrUpdates.height) : oldBox.h,
          };
          queueMutation({ type: 'updateHtmlAttrs', nodeId: id, attrs: attrUpdates });
          // The bake commit compensates itself with the FRESH geometry in
          // hand (the cache lags the queued d by a parse cycle) — skip here.
          // newBaseDs stays EMPTY: this branch writes box attrs only — the
          // base d and viewBox are untouched, so the compensation must read
          // the cache d and scale about the VIEWBOX centre. Passing cache
          // d's as newBaseDs marked them "fresh" (bake semantics: 1:1 space,
          // centre = newBox/2) and the replica's geometry re-derived about
          // the wrong centre — the replica jumped −40px on a PRIMARY resize
          // it should not react to (live repro 2026-06-12, BiNuWe file).
          if (!skipComp) {
            for (const u of compensateGroupChildVariantsForBaseBox(id, oldBox, newBox, {})) {
              queueMutation(u as any);
            }
          }
          trace.action('updateNodeStyles:svg-child-refit-gated-variant-compensate', { id, oldBox, newBox });
          const remainingGated = { ...styles };
          delete remainingGated.left; delete remainingGated.top;
          delete remainingGated.width; delete remainingGated.height;
          if (Object.keys(remainingGated).length === 0) return;
          styles = remainingGated;
          // fall through to the standard path with only non-box keys
          // (skip the refit + sibling/group DOM patches entirely)
        } else {
        // Source write + group bbox refit in one transaction. Returns
        // post-refit final values so we can also patch the group + any
        // shifted siblings to keep iframe DOM in lockstep with source.
        const finalState = moveChildAndRefitGroup(_activeFilePath, nodeForRouting.parentId!, id, attrUpdates);
        if (finalState) {
          const bridge = getCanvasBridge();
          const childFinal = { ...attrUpdates, ...finalState.childAttrs };
          supersedePendingSvgChildAttrTick(id, vpPrefixSvg, childFinal);
          bridge.patchAttrsAndStyles(id, vpPrefixSvg, childFinal, {});
          for (const [siblingId, siblingAttrs] of finalState.siblingAttrs) {
            bridge.patchAttrsAndStyles(siblingId, vpPrefixSvg, siblingAttrs, {});
          }
          if (Object.keys(finalState.groupStyles).length > 0) {
            const groupAttrs: Record<string, string> = finalState.groupViewBox ? { viewBox: finalState.groupViewBox } : {};
            bridge.patchAttrsAndStyles(nodeForRouting.parentId!, vpPrefixSvg, groupAttrs, finalState.groupStyles);
          }
        }
        // moveChildAndRefitGroup refit only the IMMEDIATE parent group. If that
        // parent is itself nested, every group above it must also shrink-wrap
        // (recursive) — otherwise an outer group's box/selection goes stale the
        // moment a deeply-nested shape moves. Refit the parent's ancestors.
        const parentAncestors = getSvgGroupAncestorChain(nodeForRouting.parentId!)
          .filter(gid => gid !== nodeForRouting.parentId);
        if (parentAncestors.length > 0) refitGroupChain(parentAncestors, _activeFilePath);
        // Carrier-origin maintenance: a per-variant rotate/scale carrier's PX
        // origin (view-box) is derived from the attrs this primary commit just
        // rewrote — refresh it in the same flush so variant transforms keep
        // pivoting at the box centre. Use the POST-REFIT attrs (the refit may
        // have re-based x/y); the pre-refit values left the origin off-centre
        // and the rotation orbited on the next paint.
        if (nodeForRouting.styles?.transformBox === 'view-box') {
          const refreshedCarrier = svgChildCarrierOrigin(
            { ...nodeForRouting.attrs, ...attrUpdates, ...(finalState?.childAttrs ?? {}) },
            parentForRouting.attrs?.viewBox,
          );
          queueMutation({ type: 'updateStyles', nodeId: id, styles: refreshedCarrier as unknown as Record<string, string> });
          trace.action('updateNodeStyles:svg-child-carrier-origin-refresh', { id, ...refreshedCarrier });
        }
        }
      }
      // Strip routed keys; if anything else (opacity, fill via inline
      // style, etc.) remains in `styles`, fall through to the standard
      // path below for those.
      const remaining = { ...styles };
      delete remaining.left; delete remaining.top; delete remaining.width; delete remaining.height;
      if (Object.keys(remaining).length === 0) return;
      styles = remaining;
    }
  }

  // Auto-detect routing from global context
  const isComponentFile = isComponentFilePath(_activeFilePath);
  const isPrimary = isPrimaryViewport(_interactingVpId);
  const variantName = (isComponentFile && !isPrimary) ? _interactingVpId : null;
  const isReplica = (!isComponentFile && !isPrimary);
  const vpWidth = _vpWidth;
  const vpPrefix = options.viewportPrefix ?? getViewportPrefix(_interactingVpId);

  // VARIANT VISIBILITY ROUTING — component master variant + display
  // write ADDITIONALLY queues `setVariantVisibility` (AnimatePresence +
  // conditional render) for SMOOTH live-preview animations (siblings
  // FLIP into the gap when the element unmounts via popLayout).
  //
  // We keep the OLD `updateVariantStyle({display:'none'})` path running
  // in parallel: the canvas Renderer reads `motionVariants[X].display`
  // to know how to render each variant tile, and the legacy parser
  // migration loop populates `hiddenOnVariants` from it too. Dropping
  // the old path entirely would mean an empty `hiddenOnVariants` until
  // the next parser pass — visible as "click Hide YES, nothing
  // happens for a frame". Keeping both writes makes the canvas
  // respond instantly AND live preview gets the smooth animation.
  // Visibility routing. `hiddenOnVariants` (AnimatePresence) is the SINGLE
  // source of truth for per-variant show/hide — for EVERY element (motion +
  // instance) and EVERY variant (primary included). We only intercept the
  // visibility values `display: 'none'` (hide) and `display: ''` (unhide) —
  // a real layout `display` change (flex/grid/block) falls through to the
  // normal style routing untouched. Scoping by isPrimary/instance before led to
  // mixed state (a motion element hidden on the primary wrote a baked
  // `display:none` that conflicted with `hiddenOnVariants` and couldn't be
  // unhidden).
  const displayWriteVal = styles.display;
  // A CMS `.map()` ROW (collection template) CANNOT use the hiddenOnVariants /
  // <AnimatePresence> visibility mechanism — you can't wrap a node that lives inside
  // a `.map()` callback (the generator fails "setVariantVisibility:not-found-in-parent"
  // → silent no-op, the long-standing "Hide does nothing on a CMS row" bug). Let its
  // `display: none`/'' FALL THROUGH to the normal style routing below, where
  // replica-context writes an inline `display` ternary (per-variant) / inline display
  // (primary) that the Renderer resolves for the template AND every ghost copy.
  const dispNode = getNodeFromCache(id);
  const dispParent = dispNode?.parentId ? getNodeFromCache(dispNode.parentId) : null;
  const isCmsRowForDisplay = !!dispParent?.collectionList
    && Object.values(dispParent.collectionList.templateIds ?? {}).includes(id);
  if (isComponentFile
      && !isCmsRowForDisplay
      && Object.prototype.hasOwnProperty.call(styles, 'display')
      && (displayWriteVal === 'none' || displayWriteVal === '')
      && !domOnly) {
    const displayValue = styles.display;
    const hide = displayValue === 'none';
    const visVariant = isPrimary ? 'default' : _interactingVpId;
    const nodeForVis = getNodeFromCache(id);
    if (nodeForVis) {
      let allVariants: string[] = ['default', visVariant];
      try {
        const code = projectFS.readFile(_activeFilePath) ?? '';
        const cfg = parseVariantConfig(code);
        if (cfg.length > 0) allVariants = cfg.map(v => v.name);
      } catch (e) {
        trace.error('updateNodeStyles:variant-cfg-parse-failed', { error: String(e) });
      }
      const currentHidden = new Set(nodeForVis.hiddenOnVariants ?? []);
      if (hide) {
        // The PRIMARY is the BASE — hiding it hides on EVERY variant (the user
        // can then unhide on a specific variant). A non-primary hide affects
        // only that variant.
        if (isPrimary) for (const v of allVariants) currentHidden.add(v);
        else currentHidden.add(visVariant);
      } else {
        // Unhide on the primary = show everywhere; on a variant = show there.
        if (isPrimary) currentHidden.clear();
        else currentHidden.delete(visVariant);
      }
      const hiddenArr = Array.from(currentHidden);
      trace.action('updateNodeStyles:setVariantVisibility', {
        nodeId: id, variant: visVariant, hide, isPrimary, hiddenArr, allVariants,
      });
      queueMutation({
        type: 'setVariantVisibility',
        nodeId: id,
        hiddenVariants: hiddenArr,
        allVariants,
      });
      // `setVariantVisibility` STRUCTURALLY re-wraps the node (`<AnimatePresence>` +
      // conditional render) — the canvas Renderer can only apply that on a FULL
      // rebuild, which a panel/control write doesn't trigger. The CALLER forces that
      // rebuild via `flushAndForceStructuralRender()` AFTER this returns (Layers eye +
      // the Styles Hide control both do) — NOT here: flushing mid-write would split
      // the unhide's `display:''` clear (queued below) into a second flush = a second
      // undo step. Keeping the force at the caller keeps the whole write atomic.
      // `hiddenOnVariants` (AnimatePresence) is the source of truth. Strip the
      // HIDE write (`display:'none'`) so the source doesn't ALSO bake a
      // base/variant `display:none` — that leaks across variants (a base
      // `display:none` is inherited by every variant without an explicit
      // override → "hid one variant, it vanished on another"). KEEP the UNHIDE
      // write (`display:''`) so it CLEARS any stale/baked `display:none` on the
      // unhidden variant (and is a harmless no-op on clean components). The
      // canvas reads `hiddenOnVariants` (resolveVariantStyles) to hide per
      // variant.
      if (hide) {
        const { display: _hideDisp, ...withoutDisplay } = styles;
        styles = withoutDisplay;
        if (Object.keys(styles).length === 0) return;
      }
    }
  }

  // Component instance root: redirect style writes to the instance tag on the page.
  // Expanded IDs look like 'instanceId:componentNodeId'. The instance tag's data-id
  // is the part before the colon. When on a page (not component file), write to the
  // instance tag so styles go on <Card style={{width: '400px'}} />.
  if (!isComponentFile && id.includes(':')) {
    const instanceId = id.split(':')[0]; // e.g. 'card2' from 'card2:card2-root'
    // Verify it's actually a component instance by checking the DOM element
    const el = contentEl.querySelector(`[data-node-id="${vpPrefix}${id}"]`) as HTMLElement;
    const isInstanceRoot = el?.closest(`[data-node-id="${vpPrefix}${instanceId}"]`) !== el
      || el?.getAttribute('data-id') !== instanceId; // Different data-id = expanded node

    // Only redirect if this looks like an expanded component node
    // Simple heuristic: the instanceId part exists as a data-id in the page code
    if (instanceId && instanceId !== id) {
      // For component instances, legacy literal 'auto' on width/height means
      // "remove my override, use the master's default value" — convert to '' (remove).
      // The editor's canonical Fit value is 'min-content' (FIT_SIZE), which is NOT
      // 'auto': it writes THROUGH to the instance tag so the instance resolves to its
      // own content size (design-tool parity), and setsSize below forwards it over variants.
      const instanceStyles = { ...styles };
      for (const dim of ['width', 'height'] as const) {
        if (instanceStyles[dim] === 'auto') {
          instanceStyles[dim] = '';
        }
      }
      trace.fn('nodeOps.updateNodeStyles:instanceRedirect', { from: id, to: instanceId, styles: instanceStyles });
      // DOM patch on the expanded root (visual feedback). Removed dims are
      // SKIPPED: the inline style is the flattened master+instance merge, so
      // clearing them collapses the element until a re-render — the forced
      // render below applies the properly re-expanded value instead.
      const dimRemoved = (key: string, value: string) =>
        value === '' && (key === 'width' || key === 'height');
      if (el) {
        for (const [key, value] of Object.entries(styles)) {
          if (dimRemoved(key, value)) continue;
          if (value === '') { try { (el.style as any)[key] = ''; } catch {} }
          else { try { (el.style as any)[key] = value; } catch {} }
        }
      }
      if (!domOnly) {
        updateNodeInCache(id, styles);
        queueMutation({ type: 'updateStyles', nodeId: instanceId, styles: instanceStyles });
        if (instanceStyles.width === '' || instanceStyles.height === '') {
          setForceRender();
          trace.action('nodeOps:instance-dim-remove-force-render', { id: instanceId, expanded: id });
        }
        // If this write sets a width/height, the master's variant `animate`
        // would otherwise clobber the instance value (a motion value beats the
        // `style` prop). Lazily wire the master to forward instance size over
        // its variants so each instance can size independently (design-tool parity).
        const setsSize = (instanceStyles.width !== undefined && instanceStyles.width !== '')
          || (instanceStyles.height !== undefined && instanceStyles.height !== '');
        if (setsSize) ensureMasterInstanceSizeOverride(instanceId);
      }
      return;
    }
  }

  // For component instances (direct write, no colon), 'auto' on width/height means
  // "remove my override, use the master's default" — convert to '' (remove property).
  // PRIMARY VIEWPORT ONLY: on a page @media replica the explicit `auto` band
  // override IS the per-viewport hug (canvas adopts the master's dim on that
  // tile; `data-size-hug` wraps it live) — converting it to '' silently
  // REMOVED the band override instead, so "width auto on the tablet replica"
  // just re-inherited the primary's value (user report 2026-08-15).
  if (!isComponentFile && !id.includes(':') && isComponentInstanceInCache(id)
      && isPrimaryViewport(_interactingVpId)) {
    for (const dim of ['width', 'height'] as const) {
      if (styles[dim] === 'auto') {
        styles = { ...styles, [dim]: '' };
      }
    }
    // Dim REMOVAL on an instance can't be applied imperatively: the DOM
    // element's inline style is the FLATTENED expandComponent merge, so
    // clearing `width` drops the instance override AND the master base in
    // one go — the expanded root collapsed to text size until a page
    // switch re-expanded it (user report 2026-07-31, W/H → auto). Queue
    // the removal, FORCE the flush render (a style-only flush is otherwise
    // fully-imperative and skips the rebuild), and keep the removed dims
    // OUT of the imperative patch below so the element holds its current
    // box until the re-expand lands the resolved value. Primary viewport
    // only — replica dim writes route @container overrides, a different
    // system with different removal semantics.
    if (!domOnly && isPrimaryViewport(_interactingVpId)) {
      const removedDims: Record<string, string> = {};
      if (styles.width === '') removedDims.width = '';
      if (styles.height === '') removedDims.height = '';
      if (Object.keys(removedDims).length > 0) {
        updateNodeInCache(id, removedDims);
        queueMutation({ type: 'updateStyles', nodeId: id, styles: removedDims });
        setForceRender();
        trace.action('nodeOps:instance-dim-remove-force-render', { id, dims: Object.keys(removedDims) });
        const rest: Record<string, string> = { ...styles };
        for (const dim of Object.keys(removedDims)) delete rest[dim];
        if (Object.keys(rest).length === 0) return;
        styles = rest;
      }
    }
  }

  trace.fn('nodeOps.updateNodeStyles', { id, styles, variantName, isReplica, vpId: _interactingVpId });

  // Apply styles to an element: clears (empty string) first, then sets.
  // This prevents shorthand expansion conflicts (e.g. border='1px solid red' + borderTopWidth='' race).
  // Replica elements use setProperty('important') to override @container !important CSS during drag.
  const useImportant = isReplica || !!variantName;
  const applyStylesToEl = (el: HTMLElement) => {
    const entries = Object.entries(styles);
    // Pass 1: clear empty values
    for (const [key, value] of entries) {
      if (value === '') { try { (el.style as any)[key] = ''; } catch { /* skip */ } }
    }
    // Pass 2: set non-empty values
    for (const [key, value] of entries) {
      if (value !== '') {
        // Convert position:fixed → absolute for canvas compatibility
        const v = (key === 'position' && value === 'fixed') ? 'absolute' : value;
        try {
          if (useImportant) {
            // kebab-case for setProperty: camelCase → kebab
            const kebab = toKebab(key);
            el.style.setProperty(kebab, v, 'important');
          } else {
            (el.style as any)[key] = v;
          }
        } catch { /* skip */ }
      }
    }
  };

  // 1. Patch DOM + forward to iframe bridge
  if (variantName || isReplica) {
    const el = contentEl.querySelector(`[data-node-id="${vpPrefix}${id}"]`) as HTMLElement;
    if (el) applyStylesToEl(el);
    // svg GROUP CHILD box: CSS left/top/width/height are NOT painted on a
    // nested <svg> (Chromium probe 2026-06-12 — only attrs and transforms
    // paint), so a plain patchStyles gives zero visual feedback on a panel
    // write (and the post-commit flush skips the Renderer). Patch the box
    // per-tile as ATTRS instead — the next full render repaints the SAME box
    // via the folded translate+scale from the variant entry, so there's no
    // jump when the attrs get rebuilt away.
    const patchNode = getNodeFromCache(id);
    const patchParent = patchNode?.parentId ? getNodeFromCache(patchNode.parentId) : null;
    const isSvgChildPatch = patchNode?.type === 'svg' && patchParent?.type === 'svg';
    const hasBoxKey = styles.left != null || styles.top != null || styles.width != null || styles.height != null;
    if (isSvgChildPatch && hasBoxKey) {
      // Folded-transform preview (the commit's own paint channel) — attr
      // patches relocate the box in the BASE frame under the existing fold.
      patchVariantSvgChildBoxPreview(id, vpPrefix, styles);
      const nonBox: Record<string, string> = {};
      for (const [k, v] of Object.entries(styles)) {
        if (k === 'left' || k === 'top' || k === 'width' || k === 'height') continue;
        nonBox[k] = v;
      }
      if (Object.keys(nonBox).length > 0) getCanvasBridge().patchStyles(id, vpPrefix, nonBox, useImportant);
    } else {
      getCanvasBridge().patchStyles(id, vpPrefix, styles, useImportant);
    }
  } else if (isComponentFile) {
    // Component primary: patch primary, then mirror to every variant
    // viewport's painting of the SAME data-id so the user sees live
    // updates on all variants while dragging the primary.
    //
    // Two delivery paths matter here, depending on whether the canvas
    // content is rendered inline in the parent frame or in the sandbox
    // iframe:
    //
    //   - Parent-frame DOM (legacy): contentEl.querySelector finds the
    //     element directly. We patch its `el.style` and walk siblings
    //     by `data-id` to mirror to other viewports.
    //   - Iframe sandbox: parent-frame contentEl.querySelector returns
    //     null because the elements live in the sandbox document. We
    //     forward each variant prefix's update via `patchMultipleStyles`
    //     so the bridge applies them inside the iframe.
    //
    // Without the bridge fan-out, mid-drag updates on a component
    // master only ever reached the primary viewport — the variants
    // appeared frozen until commit (the user-reported bug).
    const primaryEl = contentEl.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
    if (primaryEl) {
      applyStylesToEl(primaryEl);
      contentEl.querySelectorAll(`[data-id="${id}"]`).forEach(domEl => {
        if (domEl === primaryEl) return;
        const varEl = domEl as HTMLElement;
        let variantName: string | null = null;
        let ancestor: HTMLElement | null = varEl.parentElement;
        while (ancestor && ancestor !== contentEl) {
          const vp = ancestor.getAttribute('data-viewport');
          if (vp) { variantName = vp; break; }
          ancestor = ancestor.parentElement;
        }
        const overridden = variantName ? getVariantOverriddenKeys(id, variantName) : null;
        // POSITION mirroring is COMMIT-only-skipped. On commit (!domOnly) each tile's left/top is
        // its OWN (variantConfig x/y) — mirroring the primary's left/top there yanked sibling
        // tiles to the primary's spot for one frame, then the re-render snapped them back: the
        // user-reported resize-commit glitch. So skip position at commit.
        // DURING the live drag tick (domOnly) we DO mirror position: a synced replica (no
        // per-variant override — overridden keys already dropped) must follow the primary
        // in real time, exactly like a page-viewport replica. mouseup commit reconciles.
        for (const [key, value] of Object.entries(filterMirroredStyles(styles, overridden, !domOnly))) {
          try {
            if (value === '') { (varEl.style as any)[key] = ''; }
            else { (varEl.style as any)[key] = value; }
          } catch { /* skip */ }
        }
      });
    }
    // Forward primary styles to iframe + fan out to every variant
    // viewport's painting in a single batch. We discover the variant
    // prefixes by walking the rectCache for keys that match this
    // dataId — those are the only viewport prefixes that actually
    // rendered the node, so we don't waste round-trips on viewports
    // it doesn't appear in.
    const bridge = getCanvasBridge();
    const updates: Array<{ nodeId: string; vpPrefix: string; styles: Record<string, string>; important: boolean }> = [
      { nodeId: id, vpPrefix: '', styles, important: false },
    ];
    if ('rectCache' in bridge) {
      const cache = (bridge as any).rectCache as Map<string, DOMRect>;
      const seenPrefixes = new Set<string>(['']);
      for (const key of cache.keys()) {
        const parsed = parseRectCacheKey(key);
        if (!parsed) continue;
        const { vpPrefix: prefix, nodeId: dataId } = parsed;
        if (dataId !== id) continue;
        if (seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        // Strip variant-overridden keys so a per-variant left/top in
        // the variants object isn't temporarily clobbered by the
        // primary's value during drag. The variantName is the segment
        // before the trailing dash on the prefix (e.g. 'variant-1-' →
        // 'variant-1').
        const variantName = prefix.endsWith('-') ? prefix.slice(0, -1) : prefix;
        const overridden = getVariantOverriddenKeys(id, variantName);
        // Drop variant-overridden keys. Position is dropped only on COMMIT (!domOnly): without the
        // commit-time drop, the primary's left/top fanned onto every sibling tile for one frame on
        // resize-commit, then snapped back (the glitch). During the live drag tick (domOnly) we DO
        // mirror position so a synced replica follows the primary in real time (see DOM path above).
        const mirrorStyles = filterMirroredStyles(styles, overridden, !domOnly);
        if (Object.keys(mirrorStyles).length === 0) continue;
        // Variant overrides need !important to win against framer-motion's
        // animate-driven inline styles on the variant element.
        updates.push({ nodeId: id, vpPrefix: prefix, styles: mirrorStyles, important: true });
      }
    }
    if (typeof (bridge as any).patchMultipleStyles === 'function' && updates.length > 1) {
      (bridge as any).patchMultipleStyles(updates);
    } else {
      for (const u of updates) bridge.patchStyles(u.nodeId, u.vpPrefix, u.styles, u.important);
    }
  } else {
    // Page file primary: patch all matching elements across viewports
    contentEl.querySelectorAll(`[data-id="${id}"]`).forEach(domEl => {
      applyStylesToEl(domEl as HTMLElement);
    });
    // Forward to iframe — batch primary + replicas in ONE Comlink call.
    // The previous code iterated the entire rectCache (O(N) where N = total
    // cached rects, often 100s) and emitted a separate postMessage per
    // matching replica. On a 60fps slider drag with 3 viewports that's 180
    // round-trips/sec. Now we iterate viewports (3–5 known) and send a single
    // batch via patchMultipleStyles — same correctness, dramatically less
    // overhead.
    const bridge = getCanvasBridge();
    const updates: Array<{ nodeId: string; vpPrefix: string; styles: Record<string, string>; important: boolean }> = [
      { nodeId: id, vpPrefix, styles, important: useImportant },
    ];
    if ('rectCache' in bridge) {
      const cache = (bridge as any).rectCache as Map<string, DOMRect>;
      const allWidths = getViewportWidths();
      const viewportIds = Object.keys(allWidths);
      for (const vpId of viewportIds) {
        const otherPrefix = isPrimaryViewport(vpId) ? '' : `${vpId}-`;
        if (otherPrefix === vpPrefix) continue;
        // Only push if a replica actually exists for this node in this viewport.
        if (!cache.has(`${otherPrefix}:${id}`)) continue;
        // Strip properties the replica has its own @media/@container override for —
        // primary's value should NOT stomp a replica-specific responsive value.
        // Without this, resizing the primary's width/height drags the replica
        // along even when the replica has its own width/height in @container CSS.
        // Always-clobber for non-replicas (primary is the only loop entry pushing
        // here, so all targets are replicas).
        let replicaStyles = styles;
        if (_getReplicaOverrides) {
          const replicaOverrides = _getReplicaOverrides(id, allWidths[vpId] ?? 0);
          const overriddenKeys = Object.keys(replicaOverrides);
          if (overriddenKeys.length > 0) {
            const filtered: Record<string, string> = {};
            for (const k of Object.keys(styles)) {
              if (!(k in replicaOverrides)) filtered[k] = styles[k];
            }
            if (Object.keys(filtered).length === 0) {
              trace.action('nodeOps.updateNodeStyles:replicaShielded', {
                id, vpId, vpWidth: allWidths[vpId], skippedKeys: Object.keys(styles),
              });
              continue; // every prop overridden, skip
            }
            if (Object.keys(filtered).length !== Object.keys(styles).length) {
              trace.action('nodeOps.updateNodeStyles:replicaPartialShielded', {
                id, vpId, vpWidth: allWidths[vpId],
                kept: Object.keys(filtered), shielded: overriddenKeys.filter(k => k in styles),
              });
            }
            replicaStyles = filtered;
          }
        }
        updates.push({ nodeId: id, vpPrefix: otherPrefix, styles: replicaStyles, important: true });
      }
    }
    if (typeof (bridge as any).patchMultipleStyles === 'function' && updates.length > 1) {
      (bridge as any).patchMultipleStyles(updates);
    } else {
      for (const u of updates) bridge.patchStyles(u.nodeId, u.vpPrefix, u.styles, u.important);
    }
  }

  // DOM-only: live drag/resize feedback — skip cache + mutation queue
  if (domOnly) return;

  // Component instance selected directly (no colon — the instance tag IS the
  // selected node): a width/height write goes to the instance's inline style,
  // but the master's variant `animate` would clobber it (a motion value beats
  // the `style` prop). Lazily wire the master so each instance sizes
  // independently (design-tool parity). The colon path (expanded child) is handled
  // separately above; the idempotent guard makes a double-call a no-op.
  if (!isComponentFile && !id.includes(':') && isComponentInstanceInCache(id)) {
    const setsSize = (styles.width !== undefined && styles.width !== '')
      || (styles.height !== undefined && styles.height !== '');
    if (setsSize) ensureMasterInstanceSizeOverride(id);
  }

  // 2. Update cache (PropertiesPanel reflects immediately)
  // Skip cache update for variant edits — the value goes to the variant object, not inline styles.
  // Updating inline cache would cause the Renderer to apply the value from node.styles
  // (skipping resolveVariantStyles), creating oscillation during continuous edits.
  if (!variantName) {
    // Set the canvas-initiated flag BEFORE the cache update. The cache update
    // mutates the nodes atom synchronously; the Canvas render effect listens
    // to nodes and would fire a full bridge.render() on the next React commit.
    // The bridge has already been patched (instant + replicas batched), so a
    // full DOM rebuild is wasteful and visually flashes during continuous drags.
    _markUpdatingFromCanvas?.();
    updateNodeInCache(id, styles);
  }

  // 3. Queue code mutation — routed automatically
  //
  // Priority: responsive+locale combo > locale > standard (ReplicaContext handles variant/responsive)
  // When on a non-primary viewport AND non-default locale simultaneously,
  // the rule goes INSIDE the @container block with a :lang() prefix.
  if (!_isDefaultLocale) {
    // TRANSLATION MODE: persisted style writes are BLOCKED while a
    // non-default locale is active (localization overhaul Phase 2 —
    // locale mode edits translations only). Per-locale
    // styles are authored from the DEFAULT mode via the explicit
    // "Localize" convert flow (LocaleStylePopup → updateLocaleStyle
    // mutations queued directly), never through this implicit route —
    // the old behavior (any style edit under FR silently became a
    // `:lang(fr)` override) created accidental locale forks.
    trace.action('nodeOps.updateNodeStyles:blocked-translation-mode', {
      id, locale: _activeLocale, styleKeys: Object.keys(styles),
    });
    return;
  }
  {
    // SOLO-REPLICA redirect. A canvas-node that was dropped into a single
    // replica viewport (via CanvasDragStrategy's solo-entry path) gets a
    // `data-replica-solo="<soloVpId>"` attribute. While that attribute is
    // present, ALL non-display style writes route to the BASE inline
    // styles instead of the active vp's @container rule — so the user's
    // edits on the solo replica build the master values, and a future
    // unhide on the primary or another replica inherits those values
    // for free.
    //
    // `display` writes are NOT redirected — those go through normal
    // per-vp routing so the user can hide/unhide the element on
    // individual viewports. An unhide on a non-solo vp also clears the
    // solo attribute below.
    const soloNode = getNodeFromCache(id);
    const soloVpId = soloNode?.attrs?.['data-replica-solo'];
    const hasDisplayWrite = Object.prototype.hasOwnProperty.call(styles, 'display');
    if (soloVpId && !isPrimary) {
      // Split: display writes (if any) route normally; non-display
      // writes redirect to inline (base) so they author the master.
      const { display: _displayVal, ...nonDisplayStyles } = styles;
      if (Object.keys(nonDisplayStyles).length > 0) {
        trace.action('nodeOps.updateNodeStyles:solo-replica-redirect-to-base', {
          nodeId: id, soloVpId, activeVpId: _interactingVpId,
          styleKeys: Object.keys(nonDisplayStyles),
        });
        queueMutation({ type: 'updateStyles', nodeId: id, styles: nonDisplayStyles });
        // ALSO clear the SAME keys from the active variant override:
        //   - PAGE replica: the solo vp's @container rule
        //   - COMPONENT variant: the variants[variantName] entry
        // Otherwise the existing variant/container value would keep
        // winning over the inline base we just wrote (framer-motion
        // variants beat inline, @container !important beats inline
        // without important) — visible as the user's edit "snapping
        // back" on mouseup.
        const clearStyles: Record<string, string> = {};
        for (const k of Object.keys(nonDisplayStyles)) clearStyles[k] = '';
        if (isComponentFile) {
          queueMutation({
            type: 'updateVariantStyle',
            nodeId: id,
            variantName: _interactingVpId,
            styles: clearStyles,
          });
          // ALSO mirror the new value into `variants.default` — same
          // fan-out the standard primary-component path does (see
          // replica-context.ts styleUpdate isPrimary branch). Without
          // this, the `variants.default` entry keeps whatever value
          // `ensureDefaultHasBaseValues` baked in from a PREVIOUS
          // edit, and framer-motion applies that stale value on the
          // default variant instead of the inline we just wrote —
          // visible as "I changed the color on variant-1, the
          // preview / canvas on primary shows the OLD color" once the
          // node is unhidden on primary. Writing the new value
          // explicitly keeps default + inline + active variant
          // consistent: inline = NEW, default = NEW (matches), active
          // variant = NO ENTRY (falls through to inline).
          queueMutation({
            type: 'updateVariantStyle',
            nodeId: id,
            variantName: 'default',
            styles: nonDisplayStyles,
          });
        } else {
          queueMutation({
            type: 'updateContainerStyle',
            nodeId: id,
            maxWidth: vpWidth,
            styles: clearStyles,
          });
        }
      }
      if (hasDisplayWrite) {
        // Display still routes via ReplicaContext (per-vp @container).
        const rctx = getReplicaContext(_interactingVpId, _activeFilePath, { [_interactingVpId]: vpWidth });
        const muts = rctx.styleUpdate(id, { display: styles.display });
        for (const m of muts) {
          if (m.type === 'style') queueMutation({ type: 'updateStyles', nodeId: m.nodeId, styles: m.styles! });
          else queueMutation(m as any);
        }
      }
    } else {
      // Standard routing via ReplicaContext (handles page/component × primary/replica)
      const rctx = getReplicaContext(_interactingVpId, _activeFilePath, { [_interactingVpId]: vpWidth });
      const mutations = rctx.styleUpdate(id, styles);
      const overrideRemovedKeys: string[] = [];
      for (const m of mutations) {
        // PendingUpdate type 'style' → mutation queue type 'updateStyles'
        if (m.type === 'style') {
          queueMutation({ type: 'updateStyles', nodeId: m.nodeId, styles: m.styles! });
        } else {
          queueMutation(m as any);
          if (CSS_RULE_STORAGE_MUTATIONS.has(m.type) && m.styles) {
            for (const [k, v] of Object.entries(m.styles)) {
              if (v === '') overrideRemovedKeys.push(k);
            }
          }
        }
      }
      forceRenderForOverrideRemoval(id, overrideRemovedKeys);
      // Instance dim BAND writes need a real renderer pass: the band flush is
      // otherwise fully imperative, but a per-viewport `auto` (hug) resolves
      // to the master root's dim inside patchElement's instance-wrapper sync
      // — imperatively the wrapper just got `width: auto !important` and sat
      // stale at its old box until a page switch rebuilt the tile (user
      // report 2026-08-15). Any dim change forces the pass so the adopt (or
      // a new definite value's root-fill decision) paints immediately.
      if (isComponentInstanceInCache(id) && (styles.width !== undefined || styles.height !== undefined)) {
        forceRenderAfterExternalEdit('instance-dim-band-write', { nodeId: id, keys: Object.keys(styles) });
      }
    }
    // Solo-clear on unhide. If a display write makes the element
    // visible on a vp OTHER than the solo vp, the element is no
    // longer "solo on that one replica" — clear the attribute so
    // future style edits route normally.
    //
    // Just clear — no snapshot. Earlier code copied inline layout
    // keys into the solo vp's @container to "lock in" the solo
    // appearance. The user explicitly does NOT want that: it
    // pollutes the @container with values that mirror the inline
    // base, creating noise that's hard to reason about. After
    // unhide, the solo vp simply inherits whatever's in inline base
    // — same as any other vp without an explicit override. If the
    // user wants a per-vp override they can author it directly on
    // that vp post-unhide via the normal @container routing.
    if (soloVpId && hasDisplayWrite && styles.display !== 'none' && _interactingVpId !== soloVpId) {
      queueMutation({
        type: 'updateHtmlAttrs',
        nodeId: id,
        attrs: { 'data-replica-solo': '' },
      });
      // Force a full iframe re-render NOW. Three calls needed, each
      // covering a different skip path:
      //
      //   1. setForceRender() — tells `onBeforeFlush` not to ADD to
      //      `canvasUpdating` for THIS flush. Doesn't clear an
      //      already-set flag.
      //   2. flushNow() — process the queued updateHtmlAttrs +
      //      preceding updateStyles synchronously so the source has
      //      the post-unhide values before we trigger the render.
      //   3. forceCanvasRender() — bypasses every skip gate including
      //      `canvasUpdating` (which was already set to true earlier
      //      in this same updateNodeStyles call via
      //      `_markUpdatingFromCanvas`, BEFORE my code runs). Without
      //      this, the React-effect render that fires from the nodes-
      //      atom change would just consume the canvasUpdating flag
      //      and skip; the iframe never re-renders, the source-vp
      //      iframe element keeps its solo-era stale inline styles
      //      (which were only ever patched on the active vp during
      //      solo, never on the OTHER vps being unhidden now), and
      //      the user has to page-switch to clear them.
      //
      // Pairs with the `applyStyles` stale-clear fix in
      // the sandbox-side Renderer. Both required: render only matters if
      // applyStyles correctly clears removed keys, and stale-clear
      // only matters if the render actually fires.
      setForceRender();
      flushNow();
      forceCanvasRender();
      trace.action('nodeOps.updateNodeStyles:solo-replica-clear', {
        nodeId: id, soloVpId, unhiddenOnVpId: _interactingVpId,
      });
    }
  }
}

/** THE canonical "a Reset Override just happened — make the canvas match the
 *  code" primitive. Every reset affordance in the editor funnels through this,
 *  whether it routed through `updateNodeStyles` (the generic
 *  `updateStyle(prop, '')` path) or through a tool's own `onResetOverride`
 *  handler that queues bespoke mutations (SvgShapeTool, OverlayTool,
 *  ComponentPropsTool, CollectionListTool, SketchTool, AnimationTool, …).
 *
 *  Use for any edit the CANVAS did not make imperatively — a control's Reset
 *  Override, a Layers-panel drag-and-drop reorder, the JSON editor. Those queue
 *  mutations but never patch the DOM, so the render-skip the canvas drag path
 *  relies on (it patches imperatively, so skipping is correct) leaves them
 *  invisible until a page switch or reload forces a rebuild.
 *
 *  WHY a forced render is mandatory, not an optimisation: the value a reset
 *  reveals is NOT in the element's inline style. It lives either in a
 *  render-baked stylesheet rule (`@media`/`@container`, `:lang()`, `::after`,
 *  `:hover`) or in the `{...base, ...default, ...variant}` merge
 *  `resolveVariantStyles` computes at render. The imperative patch can only
 *  CLEAR the inline value — which re-exposes the stale baked rule (page
 *  replica) or drops the property entirely instead of falling back to the base
 *  (component variant). Only `renderNodes` regenerates the CSS + re-resolves
 *  the merge, and it ALSO sweeps the `data-live-important` residue that live
 *  `!important` patches leave behind.
 *
 *  The trio, each call covering a different skip path:
 *    1. `setForceRender()`    — `onBeforeFlush` must not (re-)arm the skip for
 *                               THIS flush. Does NOT clear an already-set flag.
 *    2. `flushNow()`          — get the removal into the source synchronously,
 *                               so the render below reads the post-reset code.
 *    3. `forceCanvasRender()` — bypasses every skip gate INCLUDING the
 *                               `canvasUpdating` mark `updateNodeStyles` itself
 *                               set earlier in the same call stack.
 *
 *  The extra rAF pass covers reset handlers that DEFER their write (a
 *  `requestAnimationFrame`, a `modifyProjectFile` chain, an await). Those land
 *  after the synchronous trio, so without the follow-up their removal would sit
 *  in code with a skipped render — exactly the intermittent "worked one time out
 *  of two" the user reported. A reset is a one-shot menu click, so a second
 *  render one frame later is cheap; `renderNodes` diff-patches (it does not
 *  rebuild), so code-component roots are not remounted.
 *
 *  Idempotent + safe to over-call: `flushNow()` on an empty queue is a no-op and
 *  `forceRender` re-forwards the same input. */
export function forceRenderAfterExternalEdit(reason: string, detail?: Record<string, unknown>): void {
  trace.action('nodeOps.forceRenderAfterExternalEdit', { reason, ...detail });
  setForceRender();
  flushNow();
  forceCanvasRender();
  // Second pass for deferred/async reset handlers (see doc above).
  requestAnimationFrame(() => {
    trace.action('nodeOps.forceRenderAfterExternalEdit:raf', { reason });
    setForceRender();
    flushNow();
    forceCanvasRender();
  });
}

/** Mutation types whose visual result is RENDER-RESOLVED — stylesheet-backed
 *  (`@media`/`:lang()`/`::after`/`:hover`) or computed by the variant merge.
 *  Single source of truth, shared with `onBeforeFlush`'s render-skip decision
 *  in `useMutationQueueLifecycle`. Previously this was `updateContainerStyle`
 *  ONLY, on the assumption that "variant styles resolve into each tile's inline
 *  styles at render, so the instant patch already shows a removal" — that's
 *  wrong for a REMOVAL: clearing the inline drops the property instead of
 *  falling back to the base/default merge, so the tile rendered without the
 *  property until an unrelated render happened to fire. */
const CSS_RULE_STORAGE_MUTATIONS = RENDER_RESOLVED_MUTATIONS;

/** A property REMOVAL ('' value) routed into render-resolved override storage
 *  is invisible to the instant DOM patch. Without this the user must
 *  page-switch to see e.g. the Transform ✕ take effect on a replica (live
 *  find 2026-07-20). Thin wrapper over the shared primitive so the call site
 *  keeps its "only when something was actually removed" gate. */
function forceRenderForOverrideRemoval(nodeId: string, removedKeys: string[]): void {
  if (removedKeys.length === 0) return;
  forceRenderAfterExternalEdit('style-override-removal', { nodeId, removedKeys });
}

/** Position properties that must always be inline (never @container) during drag commits. */
const POSITION_KEYS = new Set(['left', 'top', 'right', 'bottom', 'width', 'height', 'position']);

/**
 * Commit drag position changes with correct routing:
 * - Position props (left/top/right/bottom/width/height/position) → always INLINE styles.
 *   @container with !important would override them, freezing subsequent drags.
 * - Other props → normal updateNodeStyles routing (may go to @container for replicas).
 */
export function commitDragPosition(id: string, styles: Record<string, string>, contentEl: HTMLElement): void {
  const posStyles: Record<string, string> = {};
  const otherStyles: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (POSITION_KEYS.has(k)) posStyles[k] = v;
    else otherStyles[k] = v;
  }
  // Position props: always inline (skip responsive routing)
  if (Object.keys(posStyles).length > 0) {
    // Apply to DOM immediately
    const vpPrefix = getViewportPrefix(_interactingVpId);
    const el = contentEl.querySelector(`[data-node-id="${vpPrefix}${id}"]`) as HTMLElement;
    if (el) for (const [k, v] of Object.entries(posStyles)) { try { (el.style as any)[k] = v; } catch (err) { trace.error('node-ops:style-set-failed', { key: k, value: v, error: String(err) }); } }
    // Update node cache synchronously so next drag reads correct startLeft/startTop
    updateNodeInCache(id, posStyles);
    queueMutation({ type: 'updateStyles', nodeId: id, styles: posStyles });
    // SOLO replica drag commit: ALSO clear the same position keys
    // from the solo vp's @container rule. Same rationale as the
    // matching block in `updateNodeStyles` — without this, any
    // pre-existing `@container` !important position values (from a
    // prior buggy PinControl write, or from a manual override that
    // shouldn't survive the solo-redirect contract) keep winning
    // over the inline value we just wrote, and the element snaps
    // back on mouseup despite the live patches showing the new
    // position during drag.
    const soloNode = getNodeFromCache(id);
    const soloVpId = soloNode?.attrs?.['data-replica-solo'];
    if (soloVpId && !isPrimaryViewport(_interactingVpId)) {
      const clearStyles: Record<string, string> = {};
      for (const k of Object.keys(posStyles)) clearStyles[k] = '';
      // PAGE replica: clear @container override for the solo vp.
      // COMPONENT variant: clear the matching variants[variantName]
      // entries — otherwise framer-motion picks the variant value over
      // the inline base we just wrote and the element visibly snaps
      // back on mouseup. Same logic, different storage mechanism.
      if (isComponentFilePath(_activeFilePath)) {
        queueMutation({
          type: 'updateVariantStyle',
          nodeId: id,
          variantName: _interactingVpId,
          styles: clearStyles,
        });
        // Mirror the new position into `variants.default` (same
        // reason as updateNodeStyles's solo-redirect block — keeps
        // default + inline consistent, so a future unhide on primary
        // doesn't render a stale baseline frozen in default).
        queueMutation({
          type: 'updateVariantStyle',
          nodeId: id,
          variantName: 'default',
          styles: posStyles,
        });
      } else {
        queueMutation({
          type: 'updateContainerStyle',
          nodeId: id,
          maxWidth: _vpWidth,
          styles: clearStyles,
        });
      }
      trace.action('commitDragPosition:solo-replica-clear-active-vp-container', {
        nodeId: id, soloVpId, vpId: _interactingVpId,
        target: isComponentFilePath(_activeFilePath) ? 'variant' : 'container',
        clearedKeys: Object.keys(posStyles),
      });
    }
  }
  // Other props: normal routing (may go to @container for replicas)
  if (Object.keys(otherStyles).length > 0) {
    updateNodeStyles({ id, styles: otherStyles, contentEl });
  }
}

/**
 * Move/reorder a node within its parent or to a new parent.
 * Instant DOM move + async code mutation.
 */
export function moveNode(options: {
  id: string;
  newParentEl: HTMLElement;
  newParentId: string;
  index?: number;
  styles?: Record<string, string>;
  contentEl: HTMLElement;
  viewportPrefix?: string;
}): void {
  const { id, newParentEl, newParentId, index, styles, contentEl, viewportPrefix = '' } = options;

  trace.fn('nodeOps.moveNode', { id, newParentId, index });

  // 1. Find and move DOM element
  const nodeEl = contentEl.querySelector(`[data-node-id="${viewportPrefix}${id}"]`) as HTMLElement;
  if (nodeEl) {
    if (index !== undefined && index < newParentEl.children.length) {
      newParentEl.insertBefore(nodeEl, newParentEl.children[index]);
    } else {
      newParentEl.appendChild(nodeEl);
    }

    // Apply style changes if provided
    if (styles) {
      for (const [key, value] of Object.entries(styles)) {
        try { (nodeEl.style as any)[key] = value; } catch { /* skip */ }
      }
    }
  }

  // 2. Update cache
  moveNodeInCache(id, newParentId);
  if (styles) updateNodeInCache(id, styles);

  // 3. Queue code mutation
  queueMutation({ type: 'move', nodeId: id, newParentId, styles });
}

/**
 * Reorder a node within its current parent.
 * Instant DOM reorder + async code mutation.
 */
export function reorderNode(options: {
  id: string;
  parentEl: HTMLElement;
  parentId: string;
  index: number;
  contentEl: HTMLElement;
  viewportPrefix?: string;
}): void {
  const { id, parentEl, parentId, index, contentEl, viewportPrefix = '' } = options;

  trace.fn('nodeOps.reorderNode', { id, parentId, index });

  // 1. Move DOM element to new position
  const nodeEl = contentEl.querySelector(`[data-node-id="${viewportPrefix}${id}"]`) as HTMLElement;
  if (nodeEl) {
    const children = Array.from(parentEl.children).filter(c => c !== nodeEl);
    if (index >= children.length) {
      parentEl.appendChild(nodeEl);
    } else {
      parentEl.insertBefore(nodeEl, children[index]);
    }
  }

  // 2. Queue code mutation
  queueMutation({ type: 'reorder', nodeId: id, parentId, index });
}
