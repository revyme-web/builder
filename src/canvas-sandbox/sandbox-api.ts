// sandbox-api.ts — Single source of truth for the parent ↔ sandbox RPC surface.
// Both sides import this interface; Comlink wraps the postMessage transport.
//
// Parent → iframe: Comlink.wrap proxy returns this interface (every call is async).
// Iframe → parent events: still raw postMessage (high-frequency emit; see SandboxEvent).

import type { ViewportConfig, NodeOverride } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';
import type { TextEditFitResult, SerializedNodeMap } from './protocol';

/** Convenience alias used in RenderInput. NodeOverride lives in shared/types. */
type NodeLocaleOverride = NodeOverride;

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  x?: number;
  y?: number;
  right?: number;
  bottom?: number;
}

export interface CornersLike {
  TL: { x: number; y: number };
  TR: { x: number; y: number };
  BR: { x: number; y: number };
  BL: { x: number; y: number };
}

export interface ChildRect {
  id: string;
  rect: RectLike;
}

export interface RenderInput {
  nodes: SerializedNodeMap;
  viewports: ViewportConfig[];
  code: string;
  css: string;
  globalsCss: string;
  /**
   * FILE-SWITCH renders set this: patchElement must NOT trust per-element
   * `__revymePatchKey` subtree skips. The keys were stamped by the PREVIOUS
   * file's render, and node ids collide across files BY DESIGN (every page and
   * every LayoutClient roots at `data-id="root"`) — a stale key that happens
   * to match let the whole old subtree survive the switch (the home page
   * rendered inside a freshly-created template's viewports, user report
   * 2026-07-27). One full patch walk per file switch is the correct price;
   * keys are re-stamped during it, so the NEXT same-file render skips again.
   */
  distrustPatchKeys?: boolean;
  /** Host-stamped render epoch — echoed back on allRects for stale-emission
   *  rejection across file switches (see protocol.ts allRects.renderSeq). */
  renderSeq?: number;
  /**
   * The active page's TEMPLATE responsive CSS (LayoutClient <style> content,
   * selectors already rewritten `[data-id="X"]` → `[data-id="layout::X"]`),
   * computed PARENT-side. The sandbox's projectFS stub reads nothing, so
   * renderNodes' own fs-based layout-css merge is dead in the iframe — the
   * template's @media overrides (e.g. footer-nav flex-wrap on mobile) never
   * reached templated-page tiles without this (live find 2026-07-13).
   * Mirrors how globalsCss travels. Empty string when the page has no
   * template (or the active file IS the template).
   */
  layoutCss?: string;
  activeLocale?: string;
  defaultLocale?: string;
  /**
   * Per-node overrides for the active non-default locale, merged from
   * `:lang()` CSS rules (parsed parent-side) and `i18n/{locale}.json`.
   * Without this the iframe never sees the i18n text/prop/style overrides
   * — its sandbox stub for projectFS doesn't include i18n files, and
   * `renderNodes` only applies overrides when this map is supplied. So
   * `<p>title</p>` would always render the JSX default text on canvas
   * even though fr.json holds the translation. Serialized as a plain
   * Record because postMessage can't transfer Map instances.
   */
  localeOverrides?: Record<string, NodeLocaleOverride>;
  /** Apply transform before render so getBoundingClientRect includes pan/zoom. */
  transform?: { x: number; y: number; scale: number };
  /**
   * CMS collection content the iframe needs to render `.map()`-bound
   * templates. Without this the sandbox sees zero items and renders the
   * "No items in {collection}" empty-state on every collection list,
   * even when the parent's panel shows rows. Mirrored on every render.
   * Both schemas and data are passed because the renderer needs both —
   * data drives ghost copies, schema names show in the BindButton.
   */
  cmsCollections?: {
    data: Record<string, any[]>;
    schemas: Record<string, any>;
  };
}

export interface PatchUpdate {
  nodeId: string;
  vpPrefix: string;
  styles: Record<string, string>;
  important: boolean;
}

/**
 * The full API the sandbox exposes to the parent. Every method is async over
 * Comlink — return types may be `T` or `Promise<T>`; the parent always sees
 * `Promise<T>`. Fire-and-forget commands return void; queries return data.
 */
export interface SandboxApi {
  // ─── Render ────────────────────────────────────────────────────────────
  render(input: RenderInput): void | Promise<void>;

  /**
   * Update the renderer's drag-locked node ID set inside the sandbox.
   * Nodes in this set are skipped by `patchElement` style application,
   * so imperative bridge-patched lift styles (`position: absolute`,
   * `left/top/zIndex` from LayoutLiftedStrategy) survive mid-drag force-
   * renders triggered by source mutations (alt-duplicate addNode, etc.).
   * Set/cleared by strategy on lift / cleanup.
   */
  setDragLockedNodeIds(ids: string[]): void | Promise<void>;

  /**
   * Hide/show the DOM-only ghost copies of a CMS collection list during a
   * layout drag of one of its items. Set on lift / cleared on cleanup.
   */
  setCollectionGhostsHidden(containerId: string, vpPrefix: string, hidden: boolean): void | Promise<void>;

  /** Re-measure every node's rect/corners after a reorder's DOM mutations
   *  (cancels any premature pending remeasure) so overlays snap instantly. */
  forceRemeasureAllRects(): void | Promise<void>;

  // ─── Style patches (fire-and-forget; 60fps) ────────────────────────────
  patchStyles(
    nodeId: string,
    vpPrefix: string,
    styles: Record<string, string>,
    important: boolean,
  ): void | Promise<void>;
  patchMultipleStyles(updates: PatchUpdate[]): void | Promise<void>;
  /** Motion-preview !important patch that SNAPSHOTS each key's prior inline
   *  value on first write, so previewRestoreStyles can put back exactly what
   *  the DOM had (a runtime animation's `opacity: 1` lives inline, not in
   *  node.styles — model-based restore left appear-nodes invisible). */
  previewPatchStyles(nodeId: string, vpPrefix: string, styles: Record<string, string>): void | Promise<void>;
  /** Restore previewed keys: snapshotted prior inline value → caller's resting
   *  fallback → remove. Unions the snapshot's keys into `resting`'s key set. */
  previewRestoreStyles(nodeId: string, vpPrefix: string, resting: Record<string, string>): void | Promise<void>;

  // ─── Queries ───────────────────────────────────────────────────────────
  getRect(nodeId: string, vpPrefix: string): RectLike | null | Promise<RectLike | null>;
  getChildRects(parentId: string, vpPrefix: string): ChildRect[] | Promise<ChildRect[]>;
  getComputedValues(
    nodeId: string,
    vpPrefix: string,
    props: string[],
  ): Record<string, string> | Promise<Record<string, string>>;
  getContainerRect(): RectLike | null | Promise<RectLike | null>;
  getElementIdsAtPoint(x: number, y: number): string[] | Promise<string[]>;
  getTransformedCorners(
    nodeId: string,
    vpPrefix: string,
  ): CornersLike | null | Promise<CornersLike | null>;

  // ─── Transform ─────────────────────────────────────────────────────────
  setViewportTransform(x: number, y: number, scale: number): void | Promise<void>;

  // ─── Stylesheet ────────────────────────────────────────────────────────
  injectCSS(selector: string, cssBody: string): void | Promise<void>;
  removeCSS(selector: string): void | Promise<void>;
  /** Replace the design-tokens block (between the canvas-tokens-start/end
   *  markers) in the iframe's canvas style element. Lets preset edits push
   *  `var(--xxx)` updates without a full iframe re-render — calling
   *  forceCanvasRender at 60fps during a color-picker drag noticeably
   *  tanks the framerate. The parent passes the full tokens CSS string
   *  already scoped to `[data-content-root]`. */
  setCanvasTokensCSS(tokensCSS: string): void | Promise<void>;
  /** Live single-variable update — sets a CSS custom property directly on
   *  the iframe's contentRoot element via element.style.setProperty. The
   *  fastest possible path for preset color/typography drags: every
   *  `var(--name)` reference repaints on the next frame, no CSS string
   *  parsing, no <style> textContent splice, no Renderer pipeline. */
  setCanvasTokenVar(name: string, value: string): void | Promise<void>;
  /** Append a Google Fonts `<link>` to the iframe's document head so the
   *  sandbox can resolve a font face during hover preview. The parent's
   *  `<link>` doesn't reach the iframe (cross-origin: parent at 3333,
   *  iframe at 5174), so we go through Comlink instead. Idempotent —
   *  duplicate `<link>` tags for the same URL are skipped. */
  loadFontInIframe(fontUrl: string): void | Promise<void>;

  // ─── DOM mutations ─────────────────────────────────────────────────────
  /** Imperative-first delete — remove every copy of the node from the iframe DOM
   *  immediately (matches `data-id`, all viewports), so a delete is visible on the
   *  keystroke. The async removeNode code mutation makes it permanent. */
  removeElement(nodeId: string): void | Promise<void>;
  reparentLive(nodeId: string, vpPrefix: string, newParentId: string | null, index: number, styles: Record<string, string>): void | Promise<void>;
  setInnerHTML(nodeId: string, vpPrefix: string, html: string): void | Promise<void>;
  setAttribute(
    nodeId: string,
    vpPrefix: string,
    attr: string,
    value: string | null,
  ): void | Promise<void>;
  /** Set / remove an attribute on the Nth shape-tag child of an SVG
   *  wrapper. Needed for shape-edit mode: the path editor library writes
   *  bare children via innerHTML, so they don't carry `data-node-id`
   *  and `setAttribute` (which queries by id) can't reach them. Lets
   *  the Properties Panel's fill/stroke/cap/join controls update the
   *  inner shape while the user is still editing anchors. Pass `null`
   *  to remove. */
  setChildShapeAttribute(
    parentNodeId: string,
    vpPrefix: string,
    childIndex: number,
    attr: string,
    value: string | null,
  ): void | Promise<void>;

  /** Get the painted bounding box of an SVG element in user-space (viewBox)
   *  coordinates via `SVGGraphicsElement.getBBox()`. Different from
   *  `getBoundingClientRect`: returns the actual painted geometry (which
   *  can extend outside the SVG element's declared width/height when
   *  children draw beyond the wrapper bounds), and is in viewBox units
   *  rather than transformed screen pixels. Used by the shape-edit overlay
   *  on exit to normalize the wrapper to fit the painted content. */
  getBBox(
    nodeId: string,
    vpPrefix: string,
  ): { x: number; y: number; width: number; height: number } | null
    | Promise<{ x: number; y: number; width: number; height: number } | null>;

  /** Atomically write both an attribute change AND a style patch to the
   *  same element in a single Comlink message — so the browser doesn't
   *  paint the intermediate state where one is updated and the other is
   *  not. Specifically built for SVG wrapper normalization, where a new
   *  `viewBox` plus a new `width`/`height`/`left`/`top` must land in the
   *  same frame: any gap between them re-projects the path through a
   *  scale that doesn't match either the old or the new wrapper, and the
   *  painted geometry visibly jumps for one frame on mouseup. */
  patchAttrsAndStyles(
    nodeId: string,
    vpPrefix: string,
    attrs: Record<string, string>,
    styles: Record<string, string>,
    important: boolean,
  ): void | Promise<void>;

  /** Live group-resize baking. Resizing a group non-uniformly would CSS-scale
   *  (shear) a rotated child during the drag, then the commit bakes it clean —
   *  a mouseup snap. This bakes the children SYNCHRONOUSLY inside the iframe each
   *  frame (group kept 1:1) so the live preview matches the commit exactly. The
   *  first call snapshots the group's ORIGINAL children; later calls re-bake from
   *  that snapshot at the new scale. `clearGroupResizeBake` drops it on mouseup. */
  bakeGroupResize(groupId: string, vpPrefix: string, scaleX: number, scaleY: number): void | Promise<void>;
  clearGroupResizeBake(groupId: string): void | Promise<void>;

  /** Live group auto-fit. Re-fits a group to its children's PAINTED bounds
   *  SYNCHRONOUSLY in the iframe (resize + re-base children + 1:1 viewBox; for an
   *  ABSOLUTE group also compensate left/top so the content stays put; for a flex
   *  child the parent layout re-flows it). Called each frame during a child
   *  drag/resize/reshape so the user sees the final auto-fit state LIVE. */
  liveRefitGroup(groupId: string, vpPrefix: string): void | Promise<void>;
  repositionOverlays(): void | Promise<void>;

  // ─── Layout drag placeholders ──────────────────────────────────────────
  createPlaceholder(
    placeholderId: string,
    parentNodeId: string,
    vpPrefix: string,
    beforeNodeId: string | null,
    styles: Record<string, string>,
  ): void | Promise<void>;
  movePlaceholder(
    placeholderId: string,
    parentNodeId: string,
    vpPrefix: string,
    beforeNodeId: string | null,
  ): void | Promise<void>;
  /** Patch arbitrary inline styles on a placeholder by its data-placeholder-id.
   *  Used by LayoutLiftedStrategy to update the placeholder's CSS `order` value
   *  during drag — see the order-based positioning notes there. */
  patchPlaceholderStyles(
    placeholderId: string,
    vpPrefix: string,
    styles: Record<string, string>,
  ): void | Promise<void>;
  removePlaceholders(placeholderIds: string[]): void | Promise<void>;
  /** Read a placeholder's iframe-local bounding rect. Returns null if
   *  the placeholder isn't currently in the DOM. */
  getPlaceholderRect(
    placeholderId: string,
  ): { left: number; top: number; width: number; height: number } | null
    | Promise<{ left: number; top: number; width: number; height: number } | null>;
  /** Swap two children of a shared parent in DOM order. Either id may be
   *  a regular `data-id` or a `data-placeholder-id`. Used by
   *  GridDragStrategy for auto-flow grids to swap the lifted node's
   *  placeholder with a hovered sibling — the browser re-flows them into
   *  each other's cells. */
  swapTwoElements(
    idA: string,
    idB: string,
    parentNodeId: string,
    vpPrefix: string,
  ): void | Promise<void>;
  liftNode(
    nodeId: string,
    vpPrefix: string,
    styles: Record<string, string>,
  ): void | Promise<void>;
  /** Restore a previously-lifted node back into a parent at a specific index.
   *  Companion to liftNode — used by LayoutLiftedStrategy on drop so the
   *  element doesn't sit at contentRoot's (0,0) waiting for React to re-render. */
  restoreNode(
    nodeId: string,
    parentNodeId: string,
    vpPrefix: string,
    index: number,
    styles: Record<string, string>,
  ): void | Promise<void>;
  /** ATOMIC templated-root drop endgame: remove placeholders + restore the
   *  dragged node(s) + physically arrange the parent's children to
   *  `orderedIds` + clear every inline CSS order — ONE message, one sandbox
   *  task, so no intermediate state can paint (the multi-message flow flashed
   *  the restored section above its still-rank-stamped siblings for a frame). */
  commitMergedOrder(
    parentNodeId: string,
    vpPrefix: string,
    participantIds: string[],
    restores: Array<{ nodeId: string; styles: Record<string, string> }>,
    placeholderIds: string[],
    chromeOrderRestores?: Array<{ nodeId: string; order: string }>,
  ): void | Promise<void>;

  // ─── Code components ──────────────────────────────────────────
  mountCodeComponent(
    nodeId: string,
    code: string,
    props: Record<string, any>,
    vpWidth: number,
  ): void | Promise<void>;
  /** Mount many instances in ONE message so the sandbox creates all their
   *  React roots in a single macrotask → React batches the first commits into
   *  one paint (no per-instance reflow "dominos"). See sandbox-code-host. */
  mountCodeComponentsBatch(
    mounts: Array<{ nodeId: string; code: string; props: Record<string, any>; vpWidth: number }>,
  ): void | Promise<void>;
  unmountCodeComponent(nodeId: string): void | Promise<void>;
  updateCodeComponentProps(
    nodeId: string,
    props: Record<string, any>,
    vpWidth: number,
  ): void | Promise<void>;

  // ─── canvas-dnd overlay control ────────────────────────────────────────
  // The sandbox-side canvas-dnd library renders its own hover / selection
  // overlays into `#dnd-overlay`. The parent calls these to clear or hide
  // them when its own state changes (e.g. text-edit start should clear any
  // pre-existing hover, and pan/zoom should hide overlays so they don't
  // freeze in screen-space mid-transform).
  setDndHovered(nodeId: string | null, viewport?: string): void | Promise<void>;
  setDndInteracting(interacting: boolean): void | Promise<void>;

  // ─── Text editing (TipTap, lives in sandbox) ──────────────────────────
  // The editor mounts directly on the canvas element being edited, so wrap
  // behavior, position, and font sizing are pixel-identical to non-edit mode.
  // Selection state is streamed back via SandboxEvent.textEditSelectionChanged;
  // toolbar commands come back as RPC calls below.
  startTextEdit(
    nodeId: string,
    vpPrefix: string,
    /** Initial HTML; if omitted the iframe element's current innerHTML is used. */
    initialHtml?: string,
    /** Set when the node uses `useResponsiveText`. Tells the sandbox to skip
     *  cross-viewport DOM sync during typing — each viewport renders its own
     *  variant via its own React tree, so mirroring the editor's HTML to
     *  other viewports would briefly overwrite their hook-resolved values. */
    isResponsive?: boolean,
    /** Tile vpIds (variant names on a component master) whose variant has its
     *  OWN text override (`conditionalText` / per-variant text variable) —
     *  the live keystroke mirror skips these so typing on the primary never
     *  overwrites their committed content. */
    syncExcludeVpIds?: string[],
  ): void | Promise<void>;
  /** Capture the final HTML and tear down the editor. Returns the HTML so
   *  the parent can persist it through its existing mutation pipeline. */
  commitTextEdit(): { html: string; fit?: TextEditFitResult } | Promise<{ html: string; fit?: TextEditFitResult }>;
  /** Tear down the editor without persisting. */
  cancelTextEdit(): void | Promise<void>;
  /**
   * Apply a high-level text-style command. Mirrors what `useTextStyles.set`
   * does in the parent today.
   *
   * Variants:
   *   - { kind: 'mark',      property, value }   → setMark / unsetMark on textStyle
   *   - { kind: 'paragraph', property, value }   → updateAttributes('paragraph', { [property]: value })
   *   - { kind: 'highlight', value }             → setHighlight({ color }) / unsetHighlight
   *   - { kind: 'gradient',  value }             → setMark backgroundGradient + color: transparent
   */
  editorCommand(command: TextEditCommand): void | Promise<void>;

  // ─── Shape editing (SvgPathEditor lives inside sandbox) ──────────────
  // Mirrors the text-edit API. All anchor drag events stay in the iframe;
  // the parent only learns about the final state on commit. See
  // `shape-edit-host.ts` for rationale.
  //
  // commitShapeEdit returns the final state SYNCHRONOUSLY via Comlink
  // (rather than emitting an event) so the unmount cleanup that calls
  // it can `await` the response and queue source mutations BEFORE its
  // own handler registrations are torn down. Event-based commit was
  // racy because React unmount cleanup is synchronous.
  startShapeEdit(nodeId: string, vpPrefix: string, pen?: boolean): void | Promise<void>;
  commitShapeEdit(): {
    nodeId: string;
    vpPrefix: string;
    innerJSX: string;
    shapes: { dataId: string; d: string }[];
    wrapper: { viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string };
  } | null | Promise<{
    nodeId: string;
    vpPrefix: string;
    innerJSX: string;
    shapes: { dataId: string; d: string }[];
    wrapper: { viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string };
  } | null>;
  cancelShapeEdit(): void | Promise<void>;
  /** Set the handle mode (curve type) of the currently-selected anchor in
   *  shape-edit mode. Drives the editor's Path-tool Curve segmented control. */
  setShapeEditHandleMode(mode: 'straight' | 'mirrored' | 'disconnected'): void | Promise<void>;
  /** Move the currently-selected anchor to absolute (x, y) in SVG user-space.
   *  Drives the editor's Path-tool Position x/y inputs. */
  setShapeEditAnchorPosition(x: number, y: number): void | Promise<void>;


  // ─── Export ────────────────────────────────────────────────────────────
  /** Capture a canvas element as an image data-URL. `html-to-image` MUST
   *  run INSIDE the sandbox iframe — the element lives in the iframe's DOM,
   *  so a parent-frame `document.querySelector` + capture finds nothing
   *  (returns null). Returns null when the element isn't found or the
   *  capture throws (e.g. a tainted cross-origin image). */
  captureElement(
    nodeId: string,
    vpPrefix: string,
    opts: { format: 'png' | 'jpeg' | 'svg'; pixelRatio: number; backgroundColor?: string },
  ): Promise<string | null>;
}

export type TextEditCommand =
  | { kind: 'mark'; property: string; value: string | null }
  | { kind: 'paragraph'; property: string; value: string | null }
  | { kind: 'highlight'; value: string | null }
  | { kind: 'gradient'; value: string | null };

// Convenience for ad-hoc helpers that take a partially-typed serialized form.
export type { CanvasNode, ViewportConfig, SerializedNodeMap };
