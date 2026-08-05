// bridge-host.ts — Parent-side handle for the sandbox iframe.
//
// Parent → iframe RPC goes through Comlink (postMessage under the hood, proxied
// to feel like async method calls). 1.1KB of comlink replaces ~100 lines of
// manual UUID-correlation / pending-map machinery.
//
// Iframe → parent events (allRects, rectUpdate, computedUpdate, cornersUpdate,
// renderComplete, nodeMouseDown, error) stay as raw postMessage. They fire
// frequently and don't need request/response semantics — they just push fresh
// data into the parent caches.
//
// CanvasBridge (sync interface served from caches) is implemented on top of
// the Comlink remote. Sync getters return cached values; the caches are
// populated via the iframe's own emit-events.

import * as Comlink from 'comlink';
import type { CanvasBridge } from '@/canvas/canvas-bridge';
import type { SandboxApi, RenderInput, PatchUpdate, TextEditCommand } from './sandbox-api';
import type { TextEditFitResult, SandboxEvent, TextEditSnapshot } from './protocol';
import { isSandboxEvent, serializeNodeMap } from './protocol';
import type { ViewportConfig } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

export class PostMessageBridge implements CanvasBridge {
  private iframe: HTMLIFrameElement | null = null;
  private remote: Comlink.Remote<SandboxApi> | null = null;
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

  // Rect cache — populated after each render and by rectUpdate events.
  // Key: "vpPrefix:nodeId", Value: DOMRect (in iframe-space, toParentSpace translates on read)
  rectCache = new Map<string, DOMRect>();
  private containerRectCache: DOMRect | null = null;

  /** Render epoch — stamped onto every render(); allRects echoes the epoch it
   *  measured against, and older-epoch emissions are DROPPED (a pre-switch
   *  remeasure otherwise lands after the switch's cache wipe and wholesale
   *  repopulates the caches with the previous file's geometry). */
  private renderSeq = 0;

  // Generation counter — bumped on every allRects (full cache rebuild).
  // In-flight prefetch promises capture the generation at start time and
  // skip writing if the cache has been rebuilt since. Without this, a
  // prefetch fired during a drag could resolve AFTER the post-drop render
  // already refreshed the cache, overwriting fresh rects with stale ones
  // captured mid-drag — visible bug: hover hit-test lands on the wrong
  // element after a reorder commit.
  private cacheGeneration = 0;

  // Computed style cache — prefetched before continuous interactions, kept fresh via computedUpdate events.
  // Key: "vpPrefix:nodeId", Value: map of CSS property → computed value
  private computedCache = new Map<string, Record<string, string>>();

  // Corners cache — populated via cornersUpdate events from patchStyles, used for rotated/skewed elements.
  // Key: "vpPrefix:nodeId", Value: corners in iframe-space (offset applied on read)
  private cornersCache = new Map<string, { TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } }>();

  // Transform tracking for rect delta adjustment during pan/zoom.
  private cacheTransform: { x: number; y: number; scale: number } = { x: 0, y: 0, scale: 1 };
  private currentTransform: { x: number; y: number; scale: number } = { x: 0, y: 0, scale: 1 };

  // Event callbacks
  onRenderComplete: (() => void) | null = null;
  onNodeMouseDown: ((nodeId: string, event: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void) | null = null;
  onSandboxMouseMove: ((clientX: number, clientY: number) => void) | null = null;
  onReady: (() => void) | null = null;
  // canvas-dnd event callbacks (raw postMessage from sandbox)
  onDndCommit: ((updates: Array<{ type: string; nodeId: string; newParentId?: string | null; newIndex?: number; styles?: Record<string, string> }>) => void) | null = null;
  onDndSelect: ((selectedIds: string[]) => void) | null = null;
  onDndHover: ((hoveredId: string | null) => void) | null = null;
  onDndViewportHit: ((viewport: string) => void) | null = null;
  onDndDragState: ((state: { isDragging: boolean; source: string }) => void) | null = null;
  // Text-edit event callbacks (sandbox-hosted TipTap → parent toolbar/state)
  onTextEditSelectionChanged: ((snapshot: TextEditSnapshot) => void) | null = null;
  onTextEditContentChanged: ((html: string) => void) | null = null;
  onTextEditCommitted: ((html: string, fit?: TextEditFitResult) => void) | null = null;
  onTextEditCancelled: (() => void) | null = null;
  // Shape-edit cancel callback (Escape inside iframe etc.). Commit is
  // an awaitable Comlink RPC — see commitShapeEdit() — not an event.
  onShapeEditCancelled: (() => void) | null = null;
  // Pen-creation: user clicked away → FINISH (commit + exit), vs cancel=discard.
  onShapeEditDone: (() => void) | null = null;
  // Library reports the selected-anchor's position + handle-mode whenever
  // selection changes (or the user toggles curve mode). Parent registers
  // a handler to drive the shape-edit Path tool (Position + Curve).
  onAnchorInfo: ((info: null | { shapeIndex: number; anchorIndex: number; x: number; y: number; handleMode: 'straight' | 'mirrored' | 'disconnected' }) => void) | null = null;

  constructor() {
    this.readyPromise = new Promise(resolve => { this.readyResolve = resolve; });
    window.addEventListener('message', this.handleMessage);
  }

  /** Set the iframe element. Called after iframe loads. */
  setIframe(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
    if (iframe.contentWindow) {
      // Wrap the iframe's contentWindow with Comlink. windowEndpoint adapts the
      // Window's postMessage signature to Comlink's Worker-style API.
      this.remote = Comlink.wrap<SandboxApi>(Comlink.windowEndpoint(iframe.contentWindow));
    }
    trace.action('postmessage-bridge:setIframe', { src: iframe.src, hasRemote: !!this.remote });
  }

  /** Wait for sandbox to be ready. */
  waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return this.readyPromise;
  }

  /** Iframe's `contentDocument` so callers can inject into the sandbox's
   *  document head (e.g. Google Fonts `<link>` for hover-preview). The
   *  iframe is same-origin (parent dev server hosts both ports), so
   *  cross-document access works. Returns null when the iframe hasn't
   *  loaded yet — caller should retry on next ready tick. */
  getIframeDocument(): Document | null {
    return this.iframe?.contentDocument ?? null;
  }

  /** Check if sandbox is ready. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Clean up. */
  destroy(): void {
    window.removeEventListener('message', this.handleMessage);
    this.remote?.[Comlink.releaseProxy]?.();
    this.remote = null;
    this.iframe = null;
  }

  // ─── Commands (fire-and-forget; comlink awaits but we don't have to) ──

  /** Send a full render command to sandbox. */
  render(
    nodes: Map<string, CanvasNode>,
    viewports: ViewportConfig[],
    code: string,
    css: string,
    globalsCss: string,
    activeLocale?: string,
    defaultLocale?: string,
    transform?: { x: number; y: number; scale: number },
    cmsCollections?: { data: Record<string, any[]>; schemas: Record<string, any> },
    localeOverrides?: Map<string, import('@/shared/types').NodeOverride>,
    layoutCss?: string,
    /** File-switch renders: disable the per-element subtree-skip (see RenderInput). */
    distrustPatchKeys?: boolean,
  ): void {
    if (transform) this.currentTransform = { ...transform };
    // Maps don't survive structured cloning the way objects do — Comlink
    // serializes them but our consumer (sandbox renderNodes) expects a Map,
    // so we hand the iframe a plain Record and re-Map it on the other side.
    const localeOverridesObj = localeOverrides && localeOverrides.size > 0
      ? Object.fromEntries(localeOverrides)
      : undefined;
    const input: RenderInput = {
      nodes: serializeNodeMap(nodes),
      viewports,
      code,
      css,
      globalsCss,
      layoutCss,
      activeLocale,
      defaultLocale,
      transform,
      cmsCollections,
      localeOverrides: localeOverridesObj,
      distrustPatchKeys,
      // Epoch for stale-emission rejection (see the allRects handler).
      renderSeq: ++this.renderSeq,
    };
    trace.action('postmessage-bridge:send-render', { nodeCount: nodes.size, vpCount: viewports.length, overrideCount: localeOverrides?.size ?? 0 });
    this.remote?.render(input);
  }

  /** Fire-and-forget style patch. 60fps safe. */
  patchStyles(nodeId: string, vpPrefix: string, styles: Record<string, string>, important = false): void {
    this.remote?.patchStyles(nodeId, vpPrefix, styles, important);
  }

  previewPatchStyles(nodeId: string, vpPrefix: string, styles: Record<string, string>): void {
    this.remote?.previewPatchStyles(nodeId, vpPrefix, styles);
  }

  previewRestoreStyles(nodeId: string, vpPrefix: string, resting: Record<string, string>): void {
    this.remote?.previewRestoreStyles(nodeId, vpPrefix, resting);
  }

  /** Imperative-first delete: drop every copy of the node from the iframe DOM now,
   *  so the canvas reflects the delete on the keystroke instead of after the async
   *  re-parse + re-render (~0.3s). The removeNode code mutation makes it permanent. */
  removeElement(nodeId: string): void {
    this.remote?.removeElement(nodeId);
  }

  private applyComputedUpdate(entry: { nodeId: string; vpPrefix: string; styles: Record<string, string> }): void {
    const compKey = `${entry.vpPrefix}:${entry.nodeId}`;
    const existing = this.computedCache.get(compKey) || {};
    this.computedCache.set(compKey, { ...existing, ...entry.styles });
  }

  private applyCornersUpdate(entry: {
    nodeId: string;
    vpPrefix: string;
    corners: { TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } };
    decoupled?: boolean;
  }, fromTransform?: { x: number; y: number; scale: number }): void {
    // Convert from the CAPTURE camera → cache space. Batches carry their
    // capture transform (exact); single-entry events fall back to the live
    // camera (same as rectUpdate).
    const cct = this.cacheTransform;
    const cnt = fromTransform ?? this.currentTransform;
    let corners = entry.corners;
    if (cct.scale !== 0 && (cct.x !== cnt.x || cct.y !== cnt.y || cct.scale !== cnt.scale)) {
      const r = cct.scale / cnt.scale;
      const adj = (p: { x: number; y: number }) => ({
        x: (p.x - cnt.x) * r + cct.x,
        y: (p.y - cnt.y) * r + cct.y,
      });
      corners = { TL: adj(entry.corners.TL), TR: adj(entry.corners.TR), BR: adj(entry.corners.BR), BL: adj(entry.corners.BL) };
    }
    const cornerKey = `${entry.vpPrefix}:${entry.nodeId}`;
    // STALE-EVENT REJECTION:
    // `cornersUpdate` events are postMessage-async — a render emitted
    // for FILE A can arrive at the bridge AFTER FILE B's `allRects`
    // has already cleared+repopulated the caches. Without this check
    // the stale event overwrites cornersCache with the previous file's
    // corners, every polled overlay (selection box, slot handle, slot
    // connectors) paints stale on entry, and only an action triggers
    // a fresh `cornersUpdate` that finally lands the right value.
    //
    // The rectCache for the CURRENT file is the source of truth — it
    // was JUST populated by the latest allRects. If a cornersUpdate's
    // centre is far from the cached rect's centre for the same key,
    // the corners belong to a different layout (i.e. a previous file)
    // and must be discarded. 8px tolerance covers sub-pixel +
    // mid-tween drift without admitting genuinely stale events.
    // `decoupled` corners (SVG wrappers' painted bbox) intentionally
    // drift from the CSS-box rect — e.g. a group whose child is dragged
    // past its box. The rect-centre stale check would reject every such
    // frame once the drift exceeds 8px, freezing the live group resize.
    // Skip the check for them; cross-file staleness on SVG corners is
    // self-correcting on the next allRects.
    const cachedRect = this.rectCache.get(cornerKey);
    if (cachedRect && !entry.decoupled) {
      const rectCx = cachedRect.left + cachedRect.width / 2;
      const rectCy = cachedRect.top + cachedRect.height / 2;
      const cornersCx = (corners.TL.x + corners.BR.x) / 2;
      const cornersCy = (corners.TL.y + corners.BR.y) / 2;
      if (Math.abs(rectCx - cornersCx) > 8 || Math.abs(rectCy - cornersCy) > 8) {
        trace.fn('postmessage-bridge:cornersUpdate-rejected-stale', {
          cornerKey,
          dx: Math.round(Math.abs(rectCx - cornersCx)),
          dy: Math.round(Math.abs(rectCy - cornersCy)),
        });
        return;
      }
    }
    this.cornersCache.set(cornerKey, corners);
  }

  reparentLive(nodeId: string, vpPrefix: string, newParentId: string | null, index: number, styles: Record<string, string>): void {
    this.remote?.reparentLive(nodeId, vpPrefix, newParentId, index, styles);
  }

  /** Fire-and-forget batch style patch. */
  patchMultipleStyles(updates: Array<{ nodeId: string; vpPrefix: string; styles: Record<string, string>; important: boolean }>): void {
    this.remote?.patchMultipleStyles(updates as PatchUpdate[]);
  }

  /** Fire-and-forget transform update. */
  setViewportTransform(x: number, y: number, scale: number): void {
    this.currentTransform = { x, y, scale };
    this.remote?.setViewportTransform(x, y, scale);
  }

  /** Fire-and-forget CSS injection. Cross-origin iframe — sync access to
   * `contentDocument` is blocked, so this goes through Comlink/postMessage
   * (1-2ms typical). The handoff is fast enough to land before
   * framer-motion's animation fires after the upcoming React re-render. */
  injectCSS(selector: string, cssBody: string): void {
    this.remote?.injectCSS(selector, cssBody);
  }

  /** Fire-and-forget CSS removal. */
  removeCSS(selector: string): void {
    this.remote?.removeCSS(selector);
  }

  /** Replace the design-tokens block in the iframe's canvas style element.
   *  Used by preset edits (color, typography) to push live updates without
   *  forcing a full iframe re-render. 60fps safe. */
  setCanvasTokensCSS(tokensCSS: string): void {
    this.remote?.setCanvasTokensCSS(tokensCSS);
  }

  /** Live single-variable update — fastest possible path for color/font
   *  preset drags. Sets the CSS custom property inline on contentRoot. */
  setCanvasTokenVar(name: string, value: string): void {
    this.remote?.setCanvasTokenVar(name, value);
  }

  /** Append a Google Fonts `<link>` to the iframe's document head.
   *  Cross-origin (parent 3333 ↔ iframe 5174) so this can't be done by
   *  poking `iframe.contentDocument` from the parent — must round-trip
   *  through Comlink. */
  loadFontInIframe(fontUrl: string): void {
    this.remote?.loadFontInIframe(fontUrl);
  }

  /** Fire-and-forget innerHTML update (text edit commit). */
  setInnerHTML(nodeId: string, vpPrefix: string, html: string): void {
    this.remote?.setInnerHTML(nodeId, vpPrefix, html);
  }

  /** Fire-and-forget attribute set/remove. */
  setAttribute(nodeId: string, vpPrefix: string, attr: string, value: string | null): void {
    this.remote?.setAttribute(nodeId, vpPrefix, attr, value);
  }

  /** Fire-and-forget attribute set/remove on the Nth shape-tag child of
   *  an SVG wrapper. Used by the SvgShapeTool to update fill / stroke /
   *  cap / join etc. while the user is in shape-edit mode (where the
   *  path editor library has rewritten the SVG's children to bare
   *  elements without `data-node-id`). */
  setChildShapeAttribute(
    parentNodeId: string,
    vpPrefix: string,
    childIndex: number,
    attr: string,
    value: string | null,
  ): void {
    this.remote?.setChildShapeAttribute(parentNodeId, vpPrefix, childIndex, attr, value);
  }

  /** Async getBBox for SVG elements — returns the painted bbox in
   *  user-space (viewBox) coordinates, or null if the element isn't
   *  an SVGGraphicsElement / not found. */
  async getBBoxAsync(
    nodeId: string,
    vpPrefix: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!this.remote) return null;
    return await this.remote.getBBox(nodeId, vpPrefix);
  }

  /** Fire-and-forget atomic attrs + styles patch — exists so SVG wrapper
   *  normalization can land `viewBox` and `width/height/left/top` in the
   *  SAME iframe message. Splitting them across two Comlink calls leaves
   *  a one-frame paint window where the path's scale doesn't match
   *  either the old or new wrapper, and the painted shape visibly jumps. */
  patchAttrsAndStyles(
    nodeId: string,
    vpPrefix: string,
    attrs: Record<string, string>,
    styles: Record<string, string>,
    important: boolean = false,
  ): void {
    this.remote?.patchAttrsAndStyles(nodeId, vpPrefix, attrs, styles, important);
  }

  bakeGroupResize(groupId: string, vpPrefix: string, scaleX: number, scaleY: number): void {
    this.remote?.bakeGroupResize(groupId, vpPrefix, scaleX, scaleY);
  }

  clearGroupResizeBake(groupId: string): void {
    this.remote?.clearGroupResizeBake(groupId);
  }

  liveRefitGroup(groupId: string, vpPrefix: string): void {
    this.remote?.liveRefitGroup(groupId, vpPrefix);
  }

  repositionOverlays(): void {
    this.remote?.repositionOverlays();
  }

  // ─── Layout Drag Placeholders ─────────────────────────────────────────

  createPlaceholder(placeholderId: string, parentNodeId: string, vpPrefix: string, beforeNodeId: string | null, styles: Record<string, string>): void {
    this.remote?.createPlaceholder(placeholderId, parentNodeId, vpPrefix, beforeNodeId, styles);
  }

  movePlaceholder(placeholderId: string, parentNodeId: string, vpPrefix: string, beforeNodeId: string | null): void {
    this.remote?.movePlaceholder(placeholderId, parentNodeId, vpPrefix, beforeNodeId);
  }

  /** Fire-and-forget style patch on a placeholder element (looked up by
   *  data-placeholder-id, not data-node-id). LayoutLiftedStrategy uses this
   *  to update placeholder.order during drag-time reorder. */
  patchPlaceholderStyles(placeholderId: string, vpPrefix: string, styles: Record<string, string>): void {
    this.remote?.patchPlaceholderStyles(placeholderId, vpPrefix, styles);
  }

  removePlaceholders(placeholderIds: string[]): void {
    this.remote?.removePlaceholders(placeholderIds);
  }

  /** Lock specific node IDs from patchElement style writes inside the
   *  sandbox. Used by LayoutLiftedStrategy to protect lifted nodes from
   *  mid-drag force-renders (alt-duplicate `addNode` triggers a full
   *  re-render — without this lock the lifted overlay loses its
   *  imperative `position: absolute` + `zIndex: 9999` and snaps back
   *  into the flex flow under sibling stacking). */
  setDragLockedNodeIds(ids: string[]): void {
    this.remote?.setDragLockedNodeIds(ids);
  }

  /** Re-measure all node rects/corners after a reorder (see sandbox impl) so
   *  selection/hover overlays snap to the new layout without waiting for the
   *  async source re-render. */
  forceRemeasureAllRects(): void {
    this.remote?.forceRemeasureAllRects();
  }

  /** Hide/show a CMS collection list's ghost copies during a layout drag of one
   *  of its items (see sandbox impl). */
  setCollectionGhostsHidden(containerId: string, vpPrefix: string, hidden: boolean): void {
    this.remote?.setCollectionGhostsHidden(containerId, vpPrefix, hidden);
  }

  /** Swap two children of a parent in DOM order. Either id may be a
   *  regular node `data-id` or a placeholder's `data-placeholder-id`. */
  swapTwoElements(idA: string, idB: string, parentNodeId: string, vpPrefix: string): void {
    this.remote?.swapTwoElements(idA, idB, parentNodeId, vpPrefix);
  }

  /** Get the placeholder's current bounding rect in parent screen space.
   *  Used by GridDragStrategy to size the lifted element to match the
   *  placeholder's actual cell coverage (handles spans, mixed tracks). */
  async getPlaceholderRect(placeholderId: string): Promise<DOMRect | null> {
    if (!this.remote) return null;
    const data = await this.remote.getPlaceholderRect(placeholderId);
    if (!data) return null;
    return this.toParentSpace(new DOMRect(data.left, data.top, data.width, data.height));
  }

  liftNode(nodeId: string, vpPrefix: string, styles: Record<string, string>): void {
    this.remote?.liftNode(nodeId, vpPrefix, styles);
  }

  /** Reverse of liftNode — moves the element back into a parent at index N
   *  with the given restore styles applied first. Eliminates the (0,0) flash
   *  on layout drop where the element would otherwise sit at contentRoot until
   *  React re-renders from code. */
  restoreNode(
    nodeId: string,
    parentNodeId: string,
    vpPrefix: string,
    index: number,
    styles: Record<string, string>,
  ): void {
    this.remote?.restoreNode(nodeId, parentNodeId, vpPrefix, index, styles);
  }

  commitMergedOrder(
    parentNodeId: string,
    vpPrefix: string,
    participantIds: string[],
    restores: Array<{ nodeId: string; styles: Record<string, string> }>,
    placeholderIds: string[],
    chromeOrderRestores: Array<{ nodeId: string; order: string }> = [],
  ): void {
    this.remote?.commitMergedOrder(parentNodeId, vpPrefix, participantIds, restores, placeholderIds, chromeOrderRestores);
  }

  // ─── Code Components ──────────────────────────────────────────────────

  mountCodeComponent(nodeId: string, code: string, props: Record<string, any>, vpWidth: number): void {
    this.remote?.mountCodeComponent(nodeId, code, props, vpWidth);
  }

  /** Forward every code-component instance in ONE message — the sandbox mounts
   *  them in a single synchronous pass so N instances of the same component
   *  appear together instead of cascading one reflow at a time. */
  mountCodeComponentsBatch(
    mounts: Array<{ nodeId: string; code: string; props: Record<string, any>; vpWidth: number }>,
  ): void {
    this.remote?.mountCodeComponentsBatch(mounts);
  }

  unmountCodeComponent(nodeId: string): void {
    this.remote?.unmountCodeComponent(nodeId);
  }

  updateCodeComponentProps(nodeId: string, props: Record<string, any>, vpWidth: number): void {
    this.remote?.updateCodeComponentProps(nodeId, props, vpWidth);
  }

  // ─── canvas-dnd overlay control ────────────────────────────────────────

  setDndHovered(nodeId: string | null, viewport?: string): void {
    this.remote?.setDndHovered(nodeId, viewport);
  }

  setDndInteracting(interacting: boolean): void {
    this.remote?.setDndInteracting(interacting);
  }

  // setBridgeInteracting REMOVED (2026-07-30): the sandbox never implemented
  // it — and `this.remote` is a comlink PROXY, so the old
  // `if (r?.setBridgeInteracting)` guard was ALWAYS truthy (property access
  // on a comlink proxy returns a callable sub-proxy, never undefined). Every
  // interaction toggle fired an RPC for a method that didn't exist →
  // `undefined.apply` uncaught-promise TypeErrors in the sandbox, twice per
  // gesture (the long-standing "intermittent comlink burst").
  // `setDndInteracting` already carries the same signal and drives the
  // rect-emit gate + gesture-end reconcile. LESSON: never truthiness-probe a
  // method on a comlink remote — expose it for real or don't call it.

  // ─── Text editing — TipTap mounts inside the iframe ──────────────────
  // Parent kicks off / commits / cancels editing via these RPCs. Selection
  // state and content updates flow back as SandboxEvent.textEdit* events.

  /**
   * @param isResponsive  Set when the node uses `useResponsiveText`. The
   *                      sandbox uses this to skip cross-viewport sync
   *                      during typing — each viewport's React subtree
   *                      resolves the hook independently, so DOM-mirroring
   *                      keystrokes across replicas just fights React.
   */
  startTextEdit(nodeId: string, vpPrefix: string, initialHtml?: string, isResponsive?: boolean, syncExcludeVpIds?: string[]): void {
    this.remote?.startTextEdit(nodeId, vpPrefix, initialHtml, isResponsive, syncExcludeVpIds);
  }

  /** Returns the final HTML (+ FIT re-fit values when the edited text sits in
   *  a FIT wrapper) so the caller can persist them through its existing
   *  mutation pipeline. Awaitable across Comlink. */
  async commitTextEdit(): Promise<{ html: string; fit?: TextEditFitResult }> {
    if (!this.remote) return { html: '' };
    const r = await this.remote.commitTextEdit();
    return r ?? { html: '' };
  }

  cancelTextEdit(): void {
    this.remote?.cancelTextEdit();
  }

  editorCommand(command: TextEditCommand): void {
    this.remote?.editorCommand(command);
  }

  // ─── Shape editing (SvgPathEditor lives in iframe) ────────────────────

  startShapeEdit(nodeId: string, vpPrefix: string, pen?: boolean): void {
    this.remote?.startShapeEdit(nodeId, vpPrefix, pen);
  }

  /** Awaitable Comlink RPC — resolves with the final shape state so the
   *  caller can queue source mutations before its handler registrations
   *  are torn down. Returns null when there's no active editor (e.g. the
   *  user double-exited via Escape then click-outside). */
  async commitShapeEdit(): Promise<{
    nodeId: string;
    vpPrefix: string;
    innerJSX: string;
    shapes: { dataId: string; d: string }[];
    wrapper: { viewBox: string; widthPx: string; heightPx: string; leftPx: string; topPx: string };
  } | null> {
    if (!this.remote) return null;
    const result = await this.remote.commitShapeEdit();
    return result ?? null;
  }

  cancelShapeEdit(): void {
    this.remote?.cancelShapeEdit();
  }

  /** Path tool → iframe library: change the selected anchor's curve type. */
  setShapeEditHandleMode(mode: 'straight' | 'mirrored' | 'disconnected'): void {
    this.remote?.setShapeEditHandleMode(mode);
  }

  /** Path tool → iframe library: move the selected anchor to (x, y). */
  setShapeEditAnchorPosition(x: number, y: number): void {
    this.remote?.setShapeEditAnchorPosition(x, y);
  }

  /** Capture a canvas element as an image data-URL. Awaitable Comlink RPC —
   *  `html-to-image` runs inside the iframe where the element actually
   *  lives (a parent-frame capture finds nothing post-iframe-migration). */
  async captureElement(
    nodeId: string,
    vpPrefix: string,
    opts: { format: 'png' | 'jpeg' | 'svg'; pixelRatio: number; backgroundColor?: string },
  ): Promise<string | null> {
    if (!this.remote) return null;
    return (await this.remote.captureElement(nodeId, vpPrefix, opts)) ?? null;
  }

  // ─── CanvasBridge Interface (sync, served from caches) ────────────────

  /** Get the iframe's screen offset for translating between coordinate spaces. */
  getIframeOffset(): { x: number; y: number } {
    if (!this.iframe) return { x: 0, y: 0 };
    const r = this.iframe.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  /** Translate an iframe-space rect to parent screen-space. */
  private toParentSpace(rect: DOMRect): DOMRect {
    const offset = this.getIframeOffset();
    return new DOMRect(rect.x + offset.x, rect.y + offset.y, rect.width, rect.height);
  }

  /**
   * Adjust a cached rect from cache-time transform space to current transform space.
   * When the user pans/zooms after the last render, cached rects become stale.
   * This converts them by undoing the old transform and applying the current one.
   */
  private adjustForTransformDelta(rect: DOMRect): DOMRect {
    const ct = this.cacheTransform;
    const nt = this.currentTransform;
    if (ct.x === nt.x && ct.y === nt.y && ct.scale === nt.scale) return rect;
    if (ct.scale === 0) return rect;
    const ratio = nt.scale / ct.scale;
    return new DOMRect(
      (rect.x - ct.x) * ratio + nt.x,
      (rect.y - ct.y) * ratio + nt.y,
      rect.width * ratio,
      rect.height * ratio,
    );
  }

  /**
   * INVERSE of adjustForTransformDelta. A prefetch (`prefetchRect`/
   * `prefetchChildRects`) reads rects measured at the iframe's CURRENT render
   * scale (== `currentTransform`), but the rectCache baseline is
   * `cacheTransform` (set by the last `allRects`). When the camera moved since
   * that emit (e.g. page-load render at one zoom, then zoom-to-fit, with no new
   * allRects yet), `getRect`'s forward `adjustForTransformDelta` would rescale
   * the fresh rect by `currentTransform/cacheTransform` a SECOND time — the
   * cause of "layout drag does nothing on the first drag, works on the second"
   * (siblings cached ×(nt/ct) too large, mouse maps above them → reorder index
   * never changes). Map the fresh rect back into the cacheTransform baseline so
   * the forward adjustment recovers the correct current-space rect.
   */
  private toCacheBaseline(rect: DOMRect): DOMRect {
    const ct = this.cacheTransform;
    const nt = this.currentTransform;
    if (ct.x === nt.x && ct.y === nt.y && ct.scale === nt.scale) return rect;
    if (ct.scale === 0 || nt.scale === 0) return rect;
    const ratio = nt.scale / ct.scale;
    return new DOMRect(
      (rect.x - nt.x) / ratio + ct.x,
      (rect.y - nt.y) / ratio + ct.y,
      rect.width / ratio,
      rect.height / ratio,
    );
  }

  getRect(nodeId: string, vpPrefix: string): DOMRect | null {
    const cached = this.rectCache.get(`${vpPrefix}:${nodeId}`);
    if (!cached) return null;
    return this.toParentSpace(this.adjustForTransformDelta(cached));
  }

  /** Async version — returns parent-space rect via Comlink. */
  async getRectAsync(nodeId: string, vpPrefix: string): Promise<DOMRect | null> {
    if (!this.remote) return null;
    const data = await this.remote.getRect(nodeId, vpPrefix);
    if (!data) return null;
    return this.toParentSpace(new DOMRect(data.left, data.top, data.width, data.height));
  }

  /** Live rect + CULLED flag. A culled element measures 0×0 behind its
   *  placeholder, so live-vs-cached verifiers (stale reveal gate) must know
   *  "this endpoint is culled — the PROJECTED cache entry is the truth"
   *  instead of waiting for a live measurement that can never agree. */
  async getRectLiveMetaAsync(nodeId: string, vpPrefix: string): Promise<{ rect: DOMRect | null; culled: boolean }> {
    if (!this.remote) return { rect: null, culled: false };
    const data = await this.remote.getRect(nodeId, vpPrefix);
    if (!data) return { rect: null, culled: false };
    if ((data as { culled?: boolean }).culled) return { rect: null, culled: true };
    return { rect: this.toParentSpace(new DOMRect(data.left, data.top, data.width, data.height)), culled: false };
  }

  getChildRects(_parentId: string, _vpPrefix: string): Array<{ id: string; rect: DOMRect }> {
    return []; // sync — use getChildRectsAsync or prefetchChildRects
  }

  async getChildRectsAsync(parentId: string, vpPrefix: string): Promise<Array<{ id: string; rect: DOMRect }>> {
    if (!this.remote) return [];
    const data = await this.remote.getChildRects(parentId, vpPrefix);
    if (!Array.isArray(data)) return [];
    return data.map((d: any) => ({
      id: d.id,
      rect: this.toParentSpace(new DOMRect(d.rect.left, d.rect.top, d.rect.width, d.rect.height)),
    }));
  }

  getComputedValue(nodeId: string, vpPrefix: string, prop: string): string {
    const cached = this.computedCache.get(`${vpPrefix}:${nodeId}`);
    return cached?.[prop] ?? '';
  }

  getComputedValues(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    const cached = this.computedCache.get(`${vpPrefix}:${nodeId}`);
    if (!cached) return {};
    const result: Record<string, string> = {};
    for (const p of props) result[p] = cached[p] ?? '';
    return result;
  }

  async getComputedValuesAsync(nodeId: string, vpPrefix: string, props: string[]): Promise<Record<string, string>> {
    if (!this.remote) return {};
    return await this.remote.getComputedValues(nodeId, vpPrefix, props);
  }

  getContainerRect(): DOMRect | null {
    if (!this.containerRectCache) return null;
    // Apply the same transform-delta adjustment that getRect() does. The
    // cache holds the rect at cache-time transform; if the user has panned
    // or zoomed since, we need to convert to current transform so the
    // subtraction (rect.left - containerRect.left) elsewhere uses
    // consistent transform spaces. Without this, ViewportHeaderManager
    // computes wildly offset header positions on the first pan/zoom after
    // a render.
    return this.toParentSpace(this.adjustForTransformDelta(this.containerRectCache));
  }

  async getContainerRectAsync(): Promise<DOMRect | null> {
    if (!this.remote) return null;
    const data = await this.remote.getContainerRect();
    if (!data) return null;
    return new DOMRect(data.left, data.top, data.width, data.height);
  }

  getElementIdsAtPoint(_x: number, _y: number): string[] {
    return []; // sync stub
  }

  async getElementIdsAtPointAsync(x: number, y: number): Promise<string[]> {
    if (!this.remote) return [];
    return await this.remote.getElementIdsAtPoint(x, y);
  }

  getElement(_nodeId: string, _vpPrefix: string): HTMLElement | null {
    // Elements live in the iframe — can't access from parent
    return null;
  }

  /** Async: get transformed corners from sandbox, translated to parent screen-space. */
  async getTransformedCornersAsync(nodeId: string, vpPrefix: string): Promise<{ TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } } | null> {
    if (!this.remote) return null;
    const data = await this.remote.getTransformedCorners(nodeId, vpPrefix);
    if (!data) return null;
    const offset = this.getIframeOffset();
    return {
      TL: { x: data.TL.x + offset.x, y: data.TL.y + offset.y },
      TR: { x: data.TR.x + offset.x, y: data.TR.y + offset.y },
      BR: { x: data.BR.x + offset.x, y: data.BR.y + offset.y },
      BL: { x: data.BL.x + offset.x, y: data.BL.y + offset.y },
    };
  }

  /** Sync: read cached corners, translated to parent screen-space + transform-delta adjusted. */
  getCachedCorners(nodeId: string, vpPrefix: string): { TL: { x: number; y: number }; TR: { x: number; y: number }; BR: { x: number; y: number }; BL: { x: number; y: number } } | null {
    const cached = this.cornersCache.get(`${vpPrefix}:${nodeId}`);
    if (!cached) return null;
    const offset = this.getIframeOffset();
    const ct = this.cacheTransform;
    const nt = this.currentTransform;
    const needsDelta = ct.x !== nt.x || ct.y !== nt.y || ct.scale !== nt.scale;
    const adjust = (p: { x: number; y: number }) => {
      let { x, y } = p;
      if (needsDelta && ct.scale !== 0) {
        const ratio = nt.scale / ct.scale;
        x = (x - ct.x) * ratio + nt.x;
        y = (y - ct.y) * ratio + nt.y;
      }
      return { x: x + offset.x, y: y + offset.y };
    };
    return { TL: adjust(cached.TL), TR: adjust(cached.TR), BR: adjust(cached.BR), BL: adjust(cached.BL) };
  }

  /** Prefetch and cache a rect for sync access. Call before drag starts.
   *
   *  CRITICAL: the rectCache holds IFRAME-space rects (the `allRects` event
   *  writes them raw, and `getRect()` applies toParentSpace + transform-delta
   *  on read). Using `getRectAsync` here would write a PARENT-space rect to
   *  the cache, then every subsequent `getRect()` would translate it into
   *  parent-space AGAIN — double-offset every read until the next allRects
   *  emit clears the cache. Read raw iframe-space coords from the remote
   *  directly so we land in the same space the cache expects.
   */
  async prefetchRect(nodeId: string, vpPrefix: string): Promise<DOMRect | null> {
    if (!this.remote) return null;
    // Capture generation BEFORE the await — we'll discard the cache write
    // if a full allRects rebuild lands while we were waiting (the prefetched
    // rect would be stale relative to the new cache state).
    const gen = this.cacheGeneration;
    const data = await this.remote.getRect(nodeId, vpPrefix);
    if (!data) return null;
    const rect = new DOMRect(data.left, data.top, data.width, data.height);
    if (gen === this.cacheGeneration) {
      // Baseline-correct so a stale cacheTransform doesn't double-scale this on
      // sync getRect reads (see toCacheBaseline).
      this.rectCache.set(`${vpPrefix}:${nodeId}`, this.toCacheBaseline(rect));
    }
    return this.toParentSpace(rect);
  }

  /** Seed the rect cache for a node that does NOT exist in the iframe yet — e.g.
   *  a freshly-CREATED node, before its first render lands. `screenRect` is the
   *  host-space bounding rect of the creation PREVIEW (which already sits at the
   *  drawn position). Seeding lets a sync `getRect` / the selection overlay
   *  resolve the node INSTANTLY at that spot instead of waiting ~0.3s for the
   *  render + allRects. Inverse of the `getRect` read path: store
   *  `toCacheBaseline(screenRect - iframeOffset)` so getRect(=
   *  toParentSpace(adjustForTransformDelta(cached))) returns the screenRect back.
   *  The next allRects (when the real node renders) clears + replaces it. */
  seedRectFromScreen(nodeId: string, vpPrefix: string, screenRect: { left: number; top: number; width: number; height: number }): void {
    const offset = this.getIframeOffset();
    const iframeRect = new DOMRect(screenRect.left - offset.x, screenRect.top - offset.y, screenRect.width, screenRect.height);
    this.rectCache.set(`${vpPrefix}:${nodeId}`, this.toCacheBaseline(iframeRect));
    trace.action('postmessage-bridge:seedRectFromScreen', { nodeId, vpPrefix, screenRect: { l: screenRect.left, t: screenRect.top, w: screenRect.width, h: screenRect.height } });
  }

  /** Seed computed styles for a node not yet in the iframe (freshly-created), so
   *  selection-overlay handles that read computed values (radius/padding/gap/flex,
   *  rotation gates via `transform`, etc.) resolve INSTANTLY instead of waiting
   *  ~0.3s for the render. Merges into any existing entry; replaced by the real
   *  computed values on the next allRects (which clears computedCache). */
  seedComputed(nodeId: string, vpPrefix: string, computed: Record<string, string>): void {
    const key = `${vpPrefix}:${nodeId}`;
    this.computedCache.set(key, { ...this.computedCache.get(key), ...computed });
    trace.action('postmessage-bridge:seedComputed', { nodeId, vpPrefix, count: Object.keys(computed).length });
  }

  /** Prefetch all child rects of a parent for snap alignment / layout drag.
   *
   *  Same iframe-space contract as prefetchRect — must NOT go through
   *  getChildRectsAsync (which applies toParentSpace and would double-offset
   *  every cached entry, causing visible off-by-one in reorder math during
   *  layout drag because every sibling's read-back coords would be shifted
   *  by the iframe offset).
   */
  async prefetchChildRects(parentId: string, vpPrefix: string): Promise<void> {
    if (!this.remote) return;
    // Capture generation BEFORE the await. If allRects fired during the
    // RPC round-trip, the rectCache has been freshly rebuilt — writing
    // mid-drag rects on top of fresh post-render rects produces ghost
    // hover hits at the dragged element's pre-commit positions.
    const gen = this.cacheGeneration;
    const data = await this.remote.getChildRects(parentId, vpPrefix);
    if (!Array.isArray(data)) return;
    if (gen !== this.cacheGeneration) return;
    for (const d of data) {
      const rect = new DOMRect(d.rect.left, d.rect.top, d.rect.width, d.rect.height);
      // Store in the cacheTransform baseline (see toCacheBaseline) so a stale
      // cacheTransform doesn't double-scale these on sync getRect reads.
      this.rectCache.set(`${vpPrefix}:${d.id}`, this.toCacheBaseline(rect));
    }
  }

  /** Prefetch the container rect for canvas math calculations. */
  async prefetchContainerRect(): Promise<void> {
    this.containerRectCache = await this.getContainerRectAsync();
  }

  /** Prefetch computed styles for a node and cache for sync access. */
  async prefetchComputedStyles(nodeId: string, vpPrefix: string, props: string[]): Promise<void> {
    const values = await this.getComputedValuesAsync(nodeId, vpPrefix, props);
    const key = `${vpPrefix}:${nodeId}`;
    this.computedCache.set(key, { ...this.computedCache.get(key), ...values });
  }

  /** Read a single cached computed style value (sync, returns '' if not cached). */
  getCachedComputedStyle(nodeId: string, vpPrefix: string, prop: string): string {
    return this.computedCache.get(`${vpPrefix}:${nodeId}`)?.[prop] ?? '';
  }

  /** Read multiple cached computed style values (sync, returns '' for uncached props). */
  getCachedComputedStyles(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    const cached = this.computedCache.get(`${vpPrefix}:${nodeId}`);
    if (!cached) return {};
    const result: Record<string, string> = {};
    for (const p of props) result[p] = cached[p] ?? '';
    return result;
  }

  /** Clear the computed style cache. */
  clearComputedCache(): void {
    this.computedCache.clear();
  }

  /** Clear all caches (call on render). */
  clearRectCache(): void {
    this.rectCache.clear();
    this.containerRectCache = null;
    this.computedCache.clear();
    this.cornersCache.clear();
  }

  /** CanvasBridge interface alias for clearRectCache — called by
   *  `switchActiveFile` so stale entries from the previous file don't
   *  leak into the next file's selection/hover polls (e.g. a Marquee
   *  with the same data-id in two files would otherwise reuse the old
   *  rect until the new file's first `allRects` event arrives). */
  clearReadCaches(): void {
    this.clearRectCache();
  }

  /** PARENT-SIDE cache nudge for a rigid subtree move. When a canvas node
   *  (or absolute child) is dragged, its ROOT's cached rect stays fresh via
   *  the per-frame drag emits — but its DESCENDANTS' entries do not: the
   *  per-patch subtree walk is suppressed during interaction, the reposition
   *  drop SKIPS the render (no allRects), and the sandbox's gesture-end
   *  reconcile proved unreliable in live tracing (2026-07-19: children of a
   *  moved frame kept pre-drag rects — un-hoverable/un-selectable until a
   *  camera move). This shifts the descendants' cached rects by the root's
   *  own screen delta — deterministic, zero messaging. Stale corners entries
   *  are DELETED (consumers fall back to `cornersFromRect(rect)`); the next
   *  real measure replaces everything. Screen delta is converted into the
   *  cache-baseline space the entries are stored in. */
  shiftCachedSubtree(nodeIds: string[], dxScreen: number, dyScreen: number): void {
    if (nodeIds.length === 0 || (dxScreen === 0 && dyScreen === 0)) return;
    const ct = this.cacheTransform;
    const nt = this.currentTransform;
    const ratio = nt.scale !== 0 && ct.scale !== 0 ? ct.scale / nt.scale : 1;
    const dx = dxScreen * ratio;
    const dy = dyScreen * ratio;
    const idSet = new Set(nodeIds);
    let shifted = 0;
    for (const [key, rect] of Array.from(this.rectCache)) {
      const sep = key.indexOf(':');
      const nodeId = sep >= 0 ? key.slice(sep + 1) : key;
      if (!idSet.has(nodeId)) continue;
      this.rectCache.set(key, new DOMRect(rect.x + dx, rect.y + dy, rect.width, rect.height));
      this.cornersCache.delete(key);
      shifted++;
    }
    trace.action('bridge-host:shift-cached-subtree', { ids: nodeIds.length, shifted, dxScreen: Math.round(dxScreen), dyScreen: Math.round(dyScreen) });
  }

  // ─── Iframe → parent event handler (raw postMessage) ──────────────────

  private handleMessage = (e: MessageEvent): void => {
    // canvas-dnd events come over raw postMessage with a top-level `type`
    // (no __sandbox wrapper). Route them first.
    const raw = e.data;
    if (raw && typeof raw === 'object' && typeof raw.type === 'string' && !raw.__sandbox) {
      switch (raw.type) {
        case 'dndCommit':      this.onDndCommit?.(raw.updates ?? []); return;
        case 'dndSelect':      this.onDndSelect?.(raw.selectedIds ?? []); return;
        case 'dndHover':       this.onDndHover?.(raw.hoveredId ?? null); return;
        case 'dndViewportHit': this.onDndViewportHit?.(raw.viewport); return;
        case 'dndDragState':   this.onDndDragState?.(raw); return;
      }
    }

    if (!isSandboxEvent(e.data)) return;
    const event = e.data.payload as SandboxEvent;

    switch (event.type) {
      case 'sandboxReady':
        if (!this.ready) {
          this.ready = true;
          this.readyResolve();
        }
        this.onReady?.();
        // Backup: prefetch container rect now in case the first allRects event
        // races with the parent's first ViewportHeaderManager render.
        this.prefetchContainerRect().catch(() => { /* ignore */ });
        trace.action('postmessage-bridge:ready', {});
        break;

      case 'renderComplete':
        // Backup: keep container rect fresh after each render in case allRects'
        // bundled containerRect somehow isn't available.
        if (!this.containerRectCache) {
          this.prefetchContainerRect().catch(() => { /* ignore */ });
        }
        this.onRenderComplete?.();
        break;

      case 'allRects': {
        // STALE-EPOCH REJECTION: this payload was measured against an older
        // render than the latest one we sent — its rects belong to a previous
        // file/state. Applying it would wholesale-resurrect the stale caches
        // the file switch just wiped (the ~14,000px 'mobile-root' rect that
        // kept driving the template-entry fit, user report 2026-07-27).
        if (event.renderSeq !== undefined && event.renderSeq < this.renderSeq) {
          trace.action('postmessage-bridge:drop-stale-allRects', {
            eventSeq: event.renderSeq, currentSeq: this.renderSeq, rectCount: event.rects.length,
          });
          break;
        }
        this.rectCache.clear();
        this.computedCache.clear();
        this.cornersCache.clear();
        this.cacheGeneration++;
        for (const { nodeId, vpPrefix, rect } of event.rects) {
          this.rectCache.set(`${vpPrefix}:${nodeId}`, new DOMRect(rect.left, rect.top, rect.width, rect.height));
        }
        // Cache the contentRoot rect (iframe-space). Sync getContainerRect()
        // applies toParentSpace on read. Without this, ViewportHeaderManager
        // can't compute header positions and renders nothing.
        if (event.containerRect) {
          this.containerRectCache = new DOMRect(
            event.containerRect.left,
            event.containerRect.top,
            event.containerRect.width,
            event.containerRect.height,
          );
        }
        this.cacheTransform = event.transform
          ? { ...event.transform }
          : { ...this.currentTransform };
        break;
      }

      case 'rectUpdate': {
        // Single rect update from patchStyles. Convert from current→cache space
        // so adjustForTransformDelta produces the correct result on read.
        const ct = this.cacheTransform;
        const nt = this.currentTransform;
        let rx = event.rect.left, ry = event.rect.top, rw = event.rect.width, rh = event.rect.height;
        if (ct.scale !== 0 && (ct.x !== nt.x || ct.y !== nt.y || ct.scale !== nt.scale)) {
          const ratio = ct.scale / nt.scale;
          rx = (rx - nt.x) * ratio + ct.x;
          ry = (ry - nt.y) * ratio + ct.y;
          rw = rw * ratio;
          rh = rh * ratio;
        }
        const key = `${event.vpPrefix}:${event.nodeId}`;
        this.rectCache.set(key, new DOMRect(rx, ry, rw, rh));
        break;
      }

      case 'computedUpdate': {
        this.applyComputedUpdate(event);
        break;
      }

      case 'computedUpdateBatch': {
        for (const entry of event.entries) this.applyComputedUpdate(entry);
        break;
      }

      case 'cornersUpdate': {
        this.applyCornersUpdate(event);
        break;
      }

      case 'cornersUpdateBatch': {
        for (const entry of event.entries) this.applyCornersUpdate(entry, event.transform);
        break;
      }

      case 'nodeMouseDown':
        this.onNodeMouseDown?.(event.nodeId, event.event);
        break;

      case 'ghostSelect':
        // Re-dispatch on parent's document so existing Canvas.tsx listener fires.
        // The CustomEvent shape mirrors what Renderer.ts dispatches in-iframe.
        document.dispatchEvent(new CustomEvent('revyme:ghost-select', {
          detail: { ghostIndex: event.ghostIndex, templateId: event.templateId },
          bubbles: true,
        }));
        trace.action('postmessage-bridge:ghost-select', { ghostIndex: event.ghostIndex, templateId: event.templateId });
        break;

      case 'sandboxMouseMove':
        this.onSandboxMouseMove?.(event.clientX, event.clientY);
        break;

      case 'error':
        trace.error('postmessage-bridge:sandbox-error', { message: event.message, stack: event.stack });
        break;

      case 'traceEvent': {
        // Replay iframe-side trace into parent's buffer with a sandbox: prefix
        // so the source is visible in the unified timeline.
        const cat = `sandbox:${event.category}`;
        switch (event.traceType) {
          case 'action': trace.action(cat, event.data); break;
          case 'fn':     trace.fn(cat, event.data); break;
          case 'dom':    trace.dom(cat, event.data); break;
          case 'state':  trace.state(cat, event.data); break;
          case 'error':  trace.error(cat, event.data); break;
        }
        break;
      }

      case 'textEditSelectionChanged':
        this.onTextEditSelectionChanged?.(event.snapshot);
        break;
      case 'textEditContentChanged':
        this.onTextEditContentChanged?.(event.html);
        break;
      case 'textEditCommitted':
        this.onTextEditCommitted?.(event.html, event.fit);
        break;
      case 'textEditCancelled':
        this.onTextEditCancelled?.();
        break;
      case 'shapeEditCancelled':
        this.onShapeEditCancelled?.();
        break;
      case 'shapeEditDone':
        this.onShapeEditDone?.();
        break;
      case 'anchorInfo':
        this.onAnchorInfo?.(event.info);
        break;
    }
  };
}
