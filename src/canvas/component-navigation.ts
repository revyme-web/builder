// component-navigation.ts — Centralized "enter component master" flow.
//
// Three call sites used to do this independently:
//   1. Make Component (canvas/ui/ContextMenu.tsx) — after the new file is
//      created.
//   2. Edit Component button (editor/tools/ComponentPropsTool.tsx).
//   3. Double-click on an instance (canvas/Canvas.tsx).
//
// They had drifted slightly: different push-breadcrumb logic, different
// zoom timing (setTimeout vs onRenderComplete), different padding. This
// module is the single source. Each caller passes its setters + the target
// component file + variant, the helper handles the rest.

import { hasComponentControls } from '@/code/components/controls-parser';
import { isComponentFilePath, isComponentLikeFilePath, isIconSetFilePath, switchActiveFile, getHomePageFilePath } from '@/code/project/active-file-store';
import { syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { zoomToFit, zoomToFitNodes, zoomToFitSelection, zoomToFitCanvasBounds, cameraStash, transformManager } from '@/canvas/transform';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getContentRoot, getViewportPrefix, parseRectCacheKey } from '@/canvas/node-ops';
import { parseIconSetConfig } from '@/code/icons/icon-set-config';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { parseCanvasConfig } from '@/code/project/canvas-config';
import { trace } from '@/shared/debug-trace';
import { getDefaultStore } from 'jotai';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import type { CanvasNode } from '@/code/parsing/parser';

interface CanvasBounds {
  left: number; top: number; width: number; height: number;
  /** True when the height (or the whole box) was GUESSED from source — the
   *  root renders `height: 'auto'` so its real size only exists post-render.
   *  Callers keep the opacity dip for estimated bounds and tighten with the
   *  rendered rect once the iframe lands. */
  estimated?: boolean;
}

/**
 * Library-mode breadcrumb collapse — shared by `enterComponentFile`
 * (icon-set entries) and `LibraryPanel.switchToComponent`
 * (regular components). Library navigation is a flat jump, not a
 * navigation step, so the gray page pill always stays the original
 * page (`prev[0]`) regardless of how deep the user nested before
 * clicking. When `prev` is empty (deep-link directly into a master
 * with no history) we seed with `fromFilePath` — that's the only
 * "page" we have to remember.
 *
 * Pure: takes the previous breadcrumb + the file the user is leaving,
 * returns the new breadcrumb. Caller wires `setBreadcrumb` itself so
 * jotai updater identity stays stable.
 */
export function collapseLibraryBreadcrumb(prev: string[], fromFilePath: string): string[] {
  return prev.length > 0 ? [prev[0]] : [fromFilePath];
}

/**
 * Resolve the primary variant id for an icon-set file.
 * Returns the entry flagged `isPrimary: true` (or the first entry as
 * a fallback for legacy files written before isPrimary existed).
 *
 * Used as `focusNodeId` by every navigation surface that enters a
 * container-set master from outside (Library panel click, dbl-click on
 * an instance, "Make Icon Set" right-click flow). Pinning the camera
 * + selection on the primary card on entry mirrors the UX double-click
 * already gives — without it, library-panel clicks would land at
 * whatever zoom the user previously had + select nothing, then the
 * user has to manually fit + click.
 *
 * Returns undefined when the file isn't a container-set, has no
 * parseable config, or is empty — callers (`enterComponentFile`) treat
 * undefined as "fall back to all-content fit", which is correct for
 * page files / component masters / unparseable files.
 */
export function getPrimaryVariantId(filePath: string): string | undefined {
  const code = projectFS.readFile(filePath);
  if (!code) return undefined;
  const cfgs = isIconSetFilePath(filePath)
    ? parseIconSetConfig(code)
    : null;
  if (!cfgs || cfgs.length === 0) return undefined;
  return (cfgs.find(c => c.isPrimary) ?? cfgs[0]).name;
}

/**
 * Compute the canvas-space bounding rectangle for a file's content
 * SYNCHRONOUSLY, without waiting for the iframe to render. Used by
 * any flow that wants to pre-snap the camera to its destination
 * BEFORE the iframe re-renders, eliminating the "wrong-zoom flash"
 * during file switches.
 *
 * The bounds source depends on the file kind:
 *   - Page (`app/...`): viewports + positions from the `@canvas`
 *     block. Each viewport's box is `(positions[id], width, height)`.
 *   - Icon-set master: union of every variant card's
 *     rect from iconConfig. When `focusNodeId` is
 *     given, returns just that one card's rect.
 *   - Component master: union of every variant rect, where each
 *     variant is positioned at `(variant.x, variant.y)` and the
 *     component's intrinsic size comes from
 *     `extractComponentRootSize`.
 *
 * Returns null when the file's source can't be read or doesn't
 * contain enough metadata to compute bounds (the calling site falls
 * back to the post-render zoom path in that case).
 *
 * Exported for unit tests.
 */
export function computeFileEntryBounds(
  filePath: string,
  focusNodeId?: string,
  focusVariantName?: string,
): CanvasBounds | null {
  const code = projectFS.readFile(filePath);
  if (!code) return null;

  // Container-set masters (icon sets). Config entries share the shape
  // `{ name, x, y, width, height }`.
  if (isIconSetFilePath(filePath)) {
    const cfgs = parseIconSetConfig(code);
    if (cfgs.length === 0) return null;
    if (focusNodeId) {
      const single = cfgs.find(c => c.name === focusNodeId);
      if (single) return { left: single.x, top: single.y, width: single.width, height: single.height };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cfgs) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x + c.width > maxX) maxX = c.x + c.width;
      if (c.y + c.height > maxY) maxY = c.y + c.height;
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  // Component master: variants are framer-motion states laid out at
  // variantConfig positions. Each variant renders the component's
  // root element at its intrinsic size. When `focusVariantName` is
  // given (e.g. an instance dbl-click passing its `initialVariant`),
  // zoom to that ONE variant viewport instead of the entire grid —
  // mirrors what the container-set path does for `focusNodeId`.
  if (isComponentFilePath(filePath)) {
    const variants = parseVariantConfig(code);
    if (variants.length === 0) return null;
    // Entering a component ALWAYS centers on a SINGLE variant viewport —
    // the focused one if it resolves, otherwise the primary (first)
    // variant. We deliberately DON'T fit the union of every variant:
    // laid out side-by-side they span thousands of px, so the union fit
    // zooms the camera way out — the "zoom is soo far from what's
    // selected" bug. Both the make-component flow (no focusVariantName)
    // and a double-click whose instance variant doesn't match a config
    // name (e.g. stale / viewport-keyed) previously fell into that union
    // branch; now they land on the primary variant, matching the
    // icon-set single-card focus and the user's expectation.
    const focusVariant =
      (focusVariantName ? variants.find(vc => vc.name === focusVariantName) : undefined)
      ?? variants.find(vc => vc.isPrimary)
      ?? variants[0];
    if (!focusVariant) return null;
    // Size the box to the FOCUSED variant's own width/height (a 768px tablet
    // variant, not the 1440px default), else the camera centers a too-wide box
    // and the tile sits offset-left.
    const { width: rw, height: rh, estimated } = extractComponentRootSize(code, focusVariant.name);
    return { left: focusVariant.x, top: focusVariant.y, width: rw, height: rh, ...(estimated ? { estimated } : {}) };
  }

  // Page file: viewports + positions from the `@canvas` block.
  const config = parseCanvasConfig(code);
  if (config && config.viewports.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const vp of config.viewports) {
      const pos = config.positions[vp.id] ?? { x: 0, y: 0 };
      const w = vp.width || 0;
      // Page viewports may render with `height: auto` (no fixed
      // height in the @canvas config). When that happens fall back
      // to the viewport's width as a square — the post-render zoom
      // pass will tighten the fit once the iframe lands.
      const h = (typeof vp.height === 'number' && vp.height > 0) ? vp.height : w;
      if (w === 0) continue;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + w > maxX) maxX = pos.x + w;
      if (pos.y + h > maxY) maxY = pos.y + h;
    }
    if (!Number.isFinite(minX)) return null;
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }
  return null;
}

/**
 * Extract the component root element's width/height from the JSX
 * source via regex. Tries three strategies in order — the first that
 * yields BOTH dimensions wins:
 *
 *   1. The root's variants object — pattern `const XxxVariants = {
 *      default: { width: '1007px', height: '628px', ... } }`. Design
 *      components made via "Make Component" emit one of these per
 *      element-with-variants, and the root's `default` entry is the
 *      source of truth for its intrinsic size.
 *
 *   2. The first JSX element carrying both a `data-id="..."` AND a
 *      `style={{ ... }}` block with `width: 'XXXpx'` / `height: 'YYYpx'`.
 *      Components without variants land here. (The earlier version
 *      hard-coded `data-id="root"`, which only fits page roots —
 *      design component roots use mangled ids like
 *      `frame-mox0ml2n-2`, so the literal lookup always missed and
 *      this function fell to the 800×600 fallback. That made the
 *      pre-zoom land tighter than the post-render zoom and produced a
 *      visible "zoom in then back out" jump.)
 *
 *   3. Hard fallback to 800×600. Pre-zoom only needs to be in the
 *      right ballpark for the post-render pass to land smoothly on
 *      top of it — off-by-a-bit is fine, off-by-a-screen still flashes.
 *
 * Exported for unit tests.
 */
export function extractComponentRootSize(code: string, variantName: string = 'default'): { width: number; height: number; estimated?: boolean } {
  const FALLBACK = { width: 800, height: 600, estimated: true as const };

  // 1. Variants object — `const XxxVariants = { default: {...}, 'variant-1': {...} }`.
  // Read the REQUESTED variant's width/height so a caller zooming to a
  // specific variant gets THAT tile's real size (e.g. a 768px tablet variant,
  // not the 1440px default — otherwise the fit box is too wide and the tile
  // sits offset-left of centre). Falls back to `default` when the variant
  // carries no explicit size. Brace-match the FIRST variants object so we read
  // the root element's sizes, not a child element's.
  const decl = code.match(/const\s+\w+Variants\s*=\s*\{/);
  if (decl && decl.index !== undefined) {
    const open = decl.index + decl[0].length - 1; // index of the object's `{`
    let depth = 0, close = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close > open) {
      const body = code.slice(open + 1, close);
      const readVariant = (name: string): { width: number; height: number } | null => {
        // Key is either bare (`default:`) or quoted (`'variant-1':`). Inner
        // object has no nested braces, so `[^{}]*` captures it safely.
        const re = new RegExp(`(?:'${name}'|"${name}"|\\b${name})\\s*:\\s*\\{([^{}]*)\\}`);
        const mv = body.match(re);
        if (!mv) return null;
        const w = mv[1].match(/width\s*:\s*['"](\d+(?:\.\d+)?)px['"]/);
        const h = mv[1].match(/height\s*:\s*['"](\d+(?:\.\d+)?)px['"]/);
        return (w && h) ? { width: parseFloat(w[1]), height: parseFloat(h[1]) } : null;
      };
      const found = readVariant(variantName) ?? (variantName !== 'default' ? readVariant('default') : null);
      if (found) return found;
    }
  }

  // 2. The ROOT element's own dimensions. The first `data-id` element is the
  // component root (LayoutGroup/MotionConfig wrappers carry no data-id).
  // CRITICAL: when the root's height is 'auto' (content-driven masters like
  // the order-carousel Testimonial), ESTIMATE from its width instead of
  // falling through to descendants — the old any-element-with-both-px scan
  // landed on a deep 70×70 avatar, so entering the master fitted a 70px box
  // and the camera slammed to max zoom with the variant cut off (the
  // "super zoomed in on double-click" find). The post-render pass uses this
  // same function, so both passes converge on the same (slightly loose) fit.
  const dataIdRe = /data-id="[^"]+"/g;
  // Scan from the COMPONENT FUNCTION on: module-scope slot consts
  // (`const cn_… = <div data-id="…" data-canvas-node …/>`) can precede the
  // function in carried-over files, and their marquee cards have explicit px
  // sizes — the "first data-id = root" assumption then fit a ~350px CARD box
  // and entry slammed to ~200% zoom at the tile's top-left (make-component on
  // the CTA section, 2026-07-28). New builds emit cn_ consts below the export,
  // but files already created keep the old shape — skip past them here.
  const fnIdx = code.search(/function\s+\w+\s*\(\s*\{\s*style/);
  if (fnIdx > 0) dataIdRe.lastIndex = fnIdx;
  let firstDataId = true;
  let m: RegExpExecArray | null;
  while ((m = dataIdRe.exec(code)) !== null) {
    let tagStart = m.index;
    while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
    // Brace-aware tag end so a JSX expression `style={{...}}` doesn't
    // confuse us — count `{` / `}` and only accept a `>` at depth 0.
    let depth = 0;
    let tagEnd = -1;
    for (let i = tagStart; i < code.length; i++) {
      const c = code[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { tagEnd = i; break; }
    }
    if (tagEnd === -1) continue;
    const tagText = code.slice(tagStart, tagEnd + 1);
    const w = resolveDimForVariant(tagText, 'width', variantName);
    const h = resolveDimForVariant(tagText, 'height', variantName);
    if (w != null && h != null) return { width: w, height: h };
    if (firstDataId) {
      firstDataId = false;
      // Root with a px width but content-driven height: estimate. A 16:10
      // guess keeps the fit sane; the exact height only tightens the fit.
      if (w != null) return { width: w, height: Math.round(w * 0.625), estimated: true };
      // Root with no px width at all: descendants can't speak for the tile
      // either — use the fallback rather than a random child's box.
      return FALLBACK;
    }
  }

  return FALLBACK;
}

/**
 * Resolve a `width`/`height` px value from an element's inline-`style` text for
 * a specific variant. Handles BOTH a plain value (`width: '375px'`) AND a
 * per-variant ternary (`width: initialVariant === 'variant-1' ? '768px' :
 * '375px'`) — variant size now lives in an inline ternary (so it rides the
 * `layout` FLIP), not the `variants` object. Without resolving the ternary, a
 * plain `width: '…px'` regex grabbed the FIRST branch's px regardless of the
 * requested variant — so entering a component zoomed to the wrong tile size and
 * the variant sat offset-left of centre. Returns null when there's no px value
 * (e.g. `auto`/`%`), so the caller keeps scanning for the root element.
 */
function resolveDimForVariant(styleText: string, prop: 'width' | 'height', variant: string): number | null {
  const m = styleText.match(new RegExp(`\\b${prop}\\s*:\\s*([^,}]+)`));
  if (!m) return null;
  const expr = m[1].trim();

  // Plain quoted px → that's the value (no per-variant branches).
  const plain = expr.match(/^['"](\d+(?:\.\d+)?)px['"]$/);
  if (plain) return parseFloat(plain[1]);

  // Ternary: collect `(variant|initialVariant) === 'X' ? 'Npx'` branches. The
  // `default` fallback is the FINAL else branch — and only when it's actually
  // a px value. The old "last quoted px anywhere" heuristic broke on
  // `A ? '537px' : B ? '553px' : 'min-content'` (a make-component root whose
  // primary height is content-driven): it read 553 — the MOBILE tile's height
  // — as the default, so entry fit a wrong box. A non-px else returns null and
  // the caller estimates from width instead.
  const branchRe = /(?:variant|initialVariant)\s*===\s*'([^']+)'\s*\?\s*['"](\d+(?:\.\d+)?)px['"]/g;
  const map: Record<string, number> = {};
  let bm: RegExpExecArray | null;
  while ((bm = branchRe.exec(expr)) !== null) map[bm[1]] = parseFloat(bm[2]);
  const tail = expr.match(/:\s*['"]([^'"]+)['"]\s*$/);
  const tailPx = tail?.[1].match(/^(\d+(?:\.\d+)?)px$/);
  if (tailPx) map.default = parseFloat(tailPx[1]);

  const resolved = map[variant] ?? map.default;
  return resolved ?? null;
}

/** Time given to the iframe-onRenderComplete safety net before falling back. */
const RENDER_TIMEOUT_MS = 1000;

export interface EnterComponentSetters {
  setActiveFile: (path: string) => void;
  setBreadcrumb: (updater: (prev: string[]) => string[]) => void;
  setSelectedIds: (ids: string[]) => void;
  setUpdatingFromCanvas: (v: boolean) => void;
  setInteractingViewport: (id: string) => void;
  /**
   * Reads the parsed nodes for the currently active file. Must be wired by
   * the caller so we read from the SAME jotai store the setters write to —
   * `getDefaultStore()` returns a different store than main.tsx's
   * `<Provider>` and would silently miss the new file's nodes.
   */
  getNodes: () => Map<string, CanvasNode>;
  /**
   * Invoked when the target component is a CODE component (has @controls
   * annotation). The caller decides whether to open its code-editor overlay
   * — different surfaces have different overlays (Code component editor vs canvas).
   */
  openCodeEditor?: (componentFilePath: string) => void;
  /**
   * Suppress the SelectionBorder / corner / parent-highlight overlays
   * for one render cycle while the iframe transitions to the new
   * file. Without this gate, the overlay reads stale rect-cache
   * entries from the previous file BEFORE the bridge has pushed back
   * fresh rects — visible as a giant box that snaps to the right size
   * a frame later. Caller wires this to `suppressSelectionOverlayAtom`.
   */
  setSuppressSelectionOverlay?: (suppress: boolean) => void;
}

export interface EnterComponentOptions {
  /** File the user is currently on — pushed onto the breadcrumb. */
  fromFilePath: string;
  /** Component master file to switch to. */
  componentFilePath: string;
  /**
   * Variant viewport id to focus on. `'default'` is normalized to
   * `'desktop'` (the primary). Match the format Canvas.tsx uses.
   */
  initialVariant?: string;
  /**
   * Specific node id within the master to select + zoom-to-fit on,
   * INSTEAD of selecting the master root and zoom-fitting all content.
   * Used by icon-set masters: each variant lives as a
   * positioned child of the master root (e.g. `icon-1`),
   * and double-clicking an instance should land the user centered on
   * that one variant rather than on the whole grid. When omitted, the
   * legacy "select root + fit all content" behaviour applies.
   */
  focusNodeId?: string;
  /**
   * Specific design-component VARIANT NAME to zoom-to-fit on, INSTEAD
   * of fitting the union of all variants. Used by component instance
   * dbl-click: an instance with `initialVariant="hover"` lands the
   * master centered on that one variant viewport, not on the entire
   * grid of variants laid out side-by-side. Selection still goes to
   * the variant root (component variants share the same root data-id;
   * the variant is identified by viewport prefix), unlike
   * `focusNodeId` which selects the focused element directly.
   */
  focusVariantName?: string;
  /**
   * Where the entry came from — affects breadcrumb behavior:
   *
   *   • `'instance'` (default): chains intermediate masters as the
   *     user double-clicks deeper into nested instances. Used by the
   *     canvas double-click path (component-A → component-B-instance
   *     → component-C-instance produces `home → A → B → C`).
   *
   *   • `'library'`: collapses the chain to ONLY the original page.
   *     The user picked another master from a flat list (Library
   *     panel), not via navigation depth — the master they happened
   *     to be on when they clicked is NOT a navigation parent. Always
   *     yields `originalPage → newMaster` regardless of how deep the
   *     user was before clicking.
   */
  entryMode?: 'library' | 'instance';
}

/**
 * Switch active file to the component master, push breadcrumb, set the
 * interacting viewport, and zoom-to-fit on the variant's content with a
 * relaxed scale so the user lands centered without being zoomed-in too far.
 *
 * For code components (Code component templates) the helper short-circuits and asks
 * the caller to open its code-editor overlay instead — there's no master
 * file to navigate to in the same sense.
 */
export function enterComponentFile(
  options: EnterComponentOptions,
  setters: EnterComponentSetters,
): void {
  const { fromFilePath, componentFilePath, initialVariant = 'default', focusNodeId, focusVariantName, entryMode = 'instance' } = options;

  // Code components: open the code editor instead of the master canvas.
  const compCode = projectFS.readFile(componentFilePath);
  if (compCode && hasComponentControls(compCode) && setters.openCodeEditor) {
    trace.action('enter-component:open-code-editor', { componentFilePath });
    setters.openCodeEditor(componentFilePath);
    return;
  }

  // Same-file no-op: double-clicking inside a component master view
  // can re-enter the SAME file (e.g. clicking the master root, which
  // legitimately has its own componentFile attribute). switchActiveFile
  // already early-returns on `from === to`, but the surrounding bookkeeping
  // (breadcrumb push + opacity fade + setTimeout-restore) used to fire
  // anyway — leaving the canvas at `opacity: 0` until the 1-second
  // safety timeout because no new render fires to call `restore()`.
  // The user sees "blank master for ~2 seconds, then comes back" with
  // no apparent cause. Bail before any side effect when from === to.
  if (fromFilePath === componentFilePath) {
    trace.action('enter-component:noop-same-file', { componentFilePath });
    return;
  }

  // Entering a master's CANVAS → switch the left panel to the Layers tab so the
  // user immediately sees the master's node hierarchy. Any prior tab (Pages,
  // Library, Insert, Media, …) auto-switches. Placed AFTER the code-editor
  // short-circuit and same-file bail so Code component masters (open a code editor, not
  // the canvas) and re-entries keep the current panel. main.tsx binds <Provider>
  // to the default store, so this getDefaultStore() write reaches the UI.
  getDefaultStore().set(leftPanelAtom, 'layers');

  // Component-master tiles are keyed by VARIANT name — 'default' IS the
  // primary id there (isPrimaryViewport('default') === true, prefix '').
  // Mapping it to the page concept 'desktop' made every consumer keyed by
  // vp identity miss: the LayersPanel computed `__vp_desktop` while the
  // master's header row is `__vp_default`, so entering a component never
  // highlighted the top-level variant row (user report 2026-07-31).
  const targetVpId = initialVariant;

  // Snapshot the camera transform for the FROM file BEFORE switching.
  // The breadcrumb's "back to page" handler reads this stash and
  // restores the exact pan/zoom the user was at when they entered the
  // master — without it, exit-to-page just zoom-fits the page (Right
  // result but loses context). We save unconditionally because the
  // stash entry is overwritten on re-entry, and stale entries cost
  // nothing at idle.
  cameraStash.save(fromFilePath, transformManager.getTransform());

  // Pre-zoom: snap the camera transform to the destination viewport
  // BEFORE switching activeFile, so the iframe's first paint of the
  // new master lands rendered at the correct zoom — no opacity flash,
  // no double-rAF restore dance. `computeFileEntryBounds` reads the
  // file's source synchronously (no DOM, no iframe round-trip) and
  // returns the union rect for whichever kind it is.
  //
  // PARAMS MUST MATCH the post-render zoom pass below. If the two
  // zoom calls use different `padding` / `scaleMultiplier` the camera
  // jumps between them and the user sees a visible "zoom in then
  // back out" twitch — defeats the whole point of pre-zoom. The
  // post-render path on a design component goes through
  // `zoomToFitNodes(..., padding=200, scaleMultiplier=0.5)`, so we
  // mirror those numbers here. Container-set / page paths use the
  // default fit (FIT_PADDING, multiplier=1) — same as their
  // post-render `zoomToFitSelection` / `zoomToFit` callers.
  let didPreZoom = false;
  // LIBRARY entry: restore this file's SAVED camera (pan/zoom) if we have one,
  // instead of fitting — so clicking a component in the Library panel lands
  // exactly where the user left it last (persisted per file via camera-persist).
  // Instance double-click (entryMode==='instance', carries focusNodeId/variant)
  // keeps its deliberate fit-to-the-clicked-variant behaviour.
  const savedCamera = entryMode === 'library' ? cameraStash.get(componentFilePath) : null;
  const preBounds = savedCamera ? null : computeFileEntryBounds(componentFilePath, focusNodeId, focusVariantName);
  if (savedCamera) {
    transformManager.setTransform({ ...savedCamera });
    didPreZoom = true;
    trace.action('enter-component:pre-zoom-saved', { componentFilePath, savedCamera });
  } else if (preBounds) {
    const isComp = isComponentFilePath(componentFilePath);
    // Fit the SINGLE focused variant exactly like "Fit Selection" (default
    // FIT_PADDING, no scale multiplier). A prior 0.5 multiplier was meant to
    // stop tiny cards from hitting the 200% cap, but for a wide 1440px
    // component it halved the zoom so the variant filled only ~40% of the
    // viewport — the "zooms out completely" symptom. Matching fit-selection
    // params lands entry tight on the variant, same as manual Shift+2.
    zoomToFitCanvasBounds(preBounds, true);
    // ESTIMATED bounds (auto-height master root): the camera is only
    // approximately right, so keep the opacity dip — the post-render pass
    // tightens to the REAL rendered rect while the iframe is still hidden,
    // and the user's first visible frame is the exact fit. Marking
    // didPreZoom=true here would skip the dip and show a visible reframe.
    didPreZoom = !preBounds.estimated;
    trace.action('enter-component:pre-zoom', {
      focusNodeId, kind: isComp ? 'component' : 'container-set-or-page', estimated: !!preBounds.estimated, ...preBounds,
    });
  }

  // Brief opacity dip prevents a frame of the old/new page at the wrong
  // zoom from leaking through — used as a fallback for the cases the
  // pre-zoom above didn't cover (component masters, missing focus
  // node, or container-set files where the variant id isn't in
  // config). Targets the canvas iframe directly: React reconciles the
  // wrapper div's `style={{ ..., cursor: ... }}` on every Canvas
  // render, which would wipe an imperative `opacity = '0'` set on it.
  // The iframe element's style prop is static, so an imperative
  // write here survives reconciliation.
  const iframe = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
  const targets: HTMLElement[] = [];
  if (iframe && !didPreZoom) targets.push(iframe);
  for (const t of targets) t.style.opacity = '0';

  // Suppress the selection / parent-highlight overlay while the iframe
  // transitions. The overlay's RAF poll otherwise reads stale rects
  // from the OLD file's content — when the user dbl-clicks an
  // instance whose data-id happens to also exist in the new master
  // (e.g. shared root id `frame-...`), the overlay positions itself
  // using the cached rect from the previous file. Visible flash:
  // selection overlay shows huge for ~1 frame, then snaps to the
  // correct master-side rect once the bridge pushes a fresh batch.
  // The suppression clears at the same time as the iframe-opacity
  // restore (`restoreOnNextPaint`), by which point the cache holds
  // the new file's geometry.
  setters.setSuppressSelectionOverlay?.(true);

  trace.action('enter-component:switch', { from: fromFilePath, to: componentFilePath, targetVpId });

  // Push breadcrumb FIRST (so DynamicToolbar's back chevron returns
  // where we came from). Library entries collapse the chain to the
  // original page (the master the user happened to be on isn't a
  // navigation parent — they picked from a flat list). Instance
  // entries chain so deep instance dbl-clicks build a path.
  if (entryMode === 'library') {
    setters.setBreadcrumb(prev => collapseLibraryBreadcrumb(prev, fromFilePath));
  } else if (!isComponentLikeFilePath(fromFilePath)) {
    // Entering from a real PAGE starts a fresh chain rooted at that page.
    setters.setBreadcrumb(() => [fromFilePath]);
  } else {
    // Entering from a COMPONENT *or a TEMPLATE* (both component-like) ACCUMULATES,
    // so drilling page → template → component-instance builds a real breadcrumb
    // (Home › Body › Header) instead of the template replacing the chain with
    // just itself ([template] → "/LayoutClient.tsx › Header"). When the chain has
    // no page root yet (a template/component opened DIRECTLY, so prev is empty),
    // seed the home page as the root so the breadcrumb still reads page → master,
    // matching the "Home › <master>" the breadcrumb shows before the drill.
    setters.setBreadcrumb(prev => prev.length ? [...prev, fromFilePath] : [getHomePageFilePath(), fromFilePath]);
  }

  switchActiveFile(fromFilePath, componentFilePath, {
    setActiveFile: setters.setActiveFile,
    setSelectedIds: setters.setSelectedIds,
    setUpdatingFromCanvas: setters.setUpdatingFromCanvas,
  }, { syncQueueCode, flushNow });
  setters.setInteractingViewport(targetVpId);

  // Immediately resolve a SELECTION TARGET for the new file. The
  // selection sticks across the iframe render — SelectionOverlay
  // reads the rect from cache once the iframe finishes rendering.
  // Without this early call, the post-render setSelectedIds inside
  // onRenderComplete sometimes fires for a stale render cycle and
  // the selection silently drops.
  //
  // When `focusNodeId` is set (icon-set instance, or
  // any caller wanting to land on a specific child), select THAT
  // directly instead of the master root. Two reasons:
  //   1. The post-render pass will end up selecting `focusNodeId`
  //      anyway, so picking root here would cause a brief
  //      "root → variant" selection flicker — visible as the
  //      Properties panel briefly showing the master's root, then
  //      snapping to the variant ~1 frame later.
  //   2. Setting the final selection up front lets the Properties
  //      panel skip the wrong-node render entirely, so the user
  //      lands on the expected tool group from the first paint.
  const findRootId = (): string | null => {
    for (const node of setters.getNodes().values()) {
      if (!node.parentId && !node.isCanvasNode) return node.id;
    }
    return null;
  };
  const initialSelectId = focusNodeId ?? findRootId();
  trace.action('enter-component:initial-select', { selectedId: initialSelectId });
  if (initialSelectId) setters.setSelectedIds([initialSelectId]);

  // Wait for the iframe to render the master file before computing zoom
  // bounds. Same timing strategy as Canvas.tsx's double-click flow:
  // hook onRenderComplete (fires AFTER the iframe pushes back its allRects
  // payload, so the cache reflects the new file). 1s safety timeout in case
  // the signal never arrives.
  const bridge = getCanvasBridge() as any;
  const previousHandler = bridge.onRenderComplete as (() => void) | undefined;
  const wantPrefix = getViewportPrefix(targetVpId);
  let consumed = false;

  // Restore in two parts: handler swap is safe to do anytime (synchronous
  // bookkeeping), but the OPACITY restore needs to wait one extra frame
  // after the camera transform snaps. The same-frame approach (opacity
  // and transform set in one rAF) didn't work because the iframe paints
  // on its own commit cycle — by the time the browser composites the
  // parent's opacity-1 frame, the sandbox may STILL be applying the
  // post-message transform update. Double-rAF gives the iframe a paint
  // cycle to land at the new transform before we let it become visible.
  const restoreHandler = () => { bridge.onRenderComplete = previousHandler ?? null; };
  const restoreOpacity = () => {
    for (const t of targets) t.style.opacity = '1';
  };
  const restoreSelectionOverlay = () => {
    setters.setSuppressSelectionOverlay?.(false);
  };
  const restoreOnNextPaint = () => {
    restoreHandler();
    // Wait one extra rAF before letting overlay + opacity reappear —
    // gives the bridge time to push fresh rect-cache entries from the
    // newly-rendered iframe content. Without this, the overlay polls
    // stale rects on its first post-restore tick and flashes huge.
    requestAnimationFrame(() => {
      restoreOpacity();
      restoreSelectionOverlay();
    });
  };
  /** Used only by the no-content / safety-timeout fallbacks where there's
   *  no iframe paint to wait for — restoring immediately is fine and
   *  avoids a one-frame extra blank. */
  const restoreNow = () => { restoreHandler(); restoreOpacity(); restoreSelectionOverlay(); };

  bridge.onRenderComplete = () => {
    if (consumed) { previousHandler?.(); return; }
    consumed = true;
    previousHandler?.();
    requestAnimationFrame(() => {
      // Order matters here. The PREVIOUS code path was:
      //   1. restore() → opacity 1
      //   2. zoom (animated, 200ms tween from current → target)
      // Inside one rAF that's fine for opacity, but the camera tween
      // STARTS at the current (pre-entry) transform and ANIMATES to
      // the target — so the user briefly sees the master at the wrong
      // zoom before the tween catches up. That's the "small flash
      // before zoom" symptom.
      //
      // New order:
      //   1. Apply target transform INSTANTLY (no tween) so the next
      //      paint already has the master at its final scale/offset.
      //   2. restore() → opacity 1 in the SAME rAF so the browser
      //      coalesces both writes into a single paint.
      // The user now goes straight from blank to "master at correct
      // zoom" with no intermediate frame.
      const content = getContentRoot();
      if (!content) {
        restoreNow();
        return;
      }

      // Find the actual viewport root node id from the freshly-parsed file.
      // The root is the node with no parentId that isn't a canvas-node.
      // (Hardcoding 'default' was wrong — master files use the JSX element's
      // own data-id like 'frame-1', so selection silently no-op'd.)
      const rootNodeId = findRootId();
      trace.action('enter-component:resolved-root', { rootNodeId, targetVpId, wantPrefix });

      // LIBRARY entry with a saved camera: re-assert it (the render may have
      // moved the transform) and SKIP every fit branch below — the user wants
      // their remembered pan/zoom, not a fresh fit.
      if (savedCamera) {
        transformManager.setTransform({ ...savedCamera });
        if (rootNodeId) setters.setSelectedIds([rootNodeId]);
        restoreOnNextPaint();
        trace.action('enter-component:post-saved-camera', { componentFilePath });
        return;
      }

      const cache = bridge.rectCache as Map<string, DOMRect> | undefined;

      // Variant-focus mode (icon-set / any caller passing
      // `focusNodeId`): select the variant child and zoom-to-fit on it
      // ALONE — NOT on every cache entry. The master is a grid of
      // variant cards; fitting the whole grid would zoom out to where
      // the variant the user double-clicked is one tiny tile, defeating
      // the purpose of the navigation.
      //
      // Use `zoomToFitSelection` here, NOT the component-enter
      // `zoomToFitNodes(..., scaleMultiplier=0.5)` path. The 0.5
      // multiplier is correct for design components (a 320×200 card
      // would otherwise hit FIT_MAX_SCALE and feel zoomed-in), but
      // wrong for variant cards: a 240×240 card already lands at a
      // comfortable scale, and halving it makes it look tiny on screen.
      // `zoomToFitSelection` matches the BottomToolbar's "Fit Selection"
      // (Shift+2) command exactly, which is the UX the user expects.
      if (focusNodeId && cache && cache.size > 0) {
        // Two key formats in play here:
        //   - `rectCache` is keyed `${vpPrefix}:${dataId}` (colon
        //     separator — see bridge-host.ts).
        //   - `getNodeBounds` (called by zoomToFitSelection) accepts
        //     either the bare `dataId` or the COLON-LESS concatenated
        //     `${vpPrefix}${dataId}` — see camera-commands.ts.
        // We use the colon form ONLY for the cache `has` probe; the
        // zoomToFit call gets the bare dataId. Mixing them silently
        // misses the cache and falls into the all-content fit branch,
        // which is exactly the "not zoomed to fit" symptom that
        // triggered this fix.
        const cacheKey = `${wantPrefix}:${focusNodeId}`;
        if (cache.has(cacheKey)) {
          zoomToFitSelection(content, [focusNodeId], true);
          setters.setSelectedIds([focusNodeId]);
          restoreOnNextPaint();
          trace.action('enter-component:focus-variant', { focusNodeId, cacheKey });
          return;
        }
        // Variant id not in cache yet — fall through to the all-content
        // fit so we don't leave the user staring at an unzoomed master
        // while the cache catches up. Still select the variant id; the
        // selection overlay will reposition once its rect lands.
        trace.action('enter-component:focus-variant-miss', { focusNodeId, cacheKey });
      }

      // For component masters: post-render zoom must AGREE with the
      // pre-zoom bounds so the camera doesn't jump. The pre-zoom uses
      // `computeFileEntryBounds`, which returns the union of every
      // variant frame at its declared root size. The previous
      // post-render path here fitted only the cache's CHILD entries
      // (skipping rootNodeId), so for a 1007×628 component containing
      // a 240×240 child, post-render scale was ~3× tighter than
      // pre-zoom — the user saw "snap then zoom in".
      //
      // Using the same `computeFileEntryBounds` for both passes
      // guarantees they converge on the SAME camera transform, so the
      // post-render call is a no-op visually (the camera is already
      // there from pre-zoom). Cache-based fit kept as a fallback for
      // file kinds the bounds helper doesn't cover.
      const isCompFile = isComponentFilePath(componentFilePath);
      if (isCompFile) {
        const postBounds = computeFileEntryBounds(componentFilePath, focusNodeId, focusVariantName);
        if (postBounds) {
          // ESTIMATED bounds (auto-height master root, e.g. an order-carousel
          // whose root is width 1280px / height 'auto'): the source can't know
          // the rendered height, but the iframe just painted — fit the REAL
          // root rect from the cache instead of the guess. The bare rootNodeId
          // is scoped to the focused variant tile by getNodeBounds via
          // interactingViewportIdAtom (set to targetVpId above), and the
          // opacity dip is still active for estimated pre-bounds, so this
          // tighten is invisible: the first visible frame is the exact fit.
          const realRootRect = postBounds.estimated && rootNodeId
            && cache?.has(`${wantPrefix}:${rootNodeId}`);
          if (realRootRect && rootNodeId) {
            zoomToFitSelection(content, [rootNodeId], true);
            trace.action('enter-component:post-zoom-real-rect', { rootNodeId, wantPrefix });
          } else {
          // Same fit-selection params as the pre-zoom above so the two
          // passes converge on the SAME transform (no zoom-in-then-out
          // twitch). See the pre-zoom comment for why the 0.5 went away.
          zoomToFitCanvasBounds(postBounds, true);
          }
          // Selection: focusNodeId targets a literal node (container-
          // set variant card); for components the "focus" is the
          // variant viewport, and component variants share the same
          // root data-id (interactingViewportId carries the variant
          // identity), so select root.
          if (rootNodeId) setters.setSelectedIds(focusNodeId ? [focusNodeId] : [rootNodeId]);
          restoreOnNextPaint();
          return;
        }
      }

      if (cache && cache.size > 0 && rootNodeId) {
        const contentNodeIds: string[] = [];
        for (const key of cache.keys()) {
          const parsed = parseRectCacheKey(key);
          if (!parsed) continue;
          const { vpPrefix, nodeId: dataId } = parsed;
          if (vpPrefix !== wantPrefix) continue;
          if (dataId === rootNodeId) continue; // skip the viewport root itself
          contentNodeIds.push(`${vpPrefix}${dataId}`);
        }
        if (contentNodeIds.length > 0) {
          zoomToFitNodes(content, contentNodeIds, true);
          setters.setSelectedIds(focusNodeId ? [focusNodeId] : [rootNodeId]);
          restoreOnNextPaint();
          return;
        }
      }
      // Fallback: fit the whole content area if cache doesn't have variant
      // entries yet (timing edge case on first-ever component create).
      // Still select the root if we found one.
      zoomToFit(content, true);
      if (focusNodeId) setters.setSelectedIds([focusNodeId]);
      else if (rootNodeId) setters.setSelectedIds([rootNodeId]);
      restoreOnNextPaint();
    });
  };

  setTimeout(() => {
    if (!consumed) {
      consumed = true;
      restoreNow();
    }
  }, RENDER_TIMEOUT_MS);
}
