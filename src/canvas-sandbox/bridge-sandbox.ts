// bridge-sandbox.ts — Sandbox-side runtime.
// Exposes the SandboxApi to the parent via Comlink RPC and emits high-frequency
// events back via raw postMessage.
//
// Phase 7 split: the handler bodies live in ./sandbox/{rect-emit,
// style-handlers,read-handlers,group-resize,placeholders,text-shape-hosts}.ts
// and the `api` literal below is a dispatch table assembling the imported
// handlers. Shared mutable state (contentRoot / currentSandboxTransform /
// emit) lives in ./sandbox/sandbox-state.ts so the handler modules never
// import this file — moving `emitRectAndCornersForElement` into
// ./sandbox/rect-emit.ts is what broke the old bridge-sandbox ↔
// sandbox-code-host circular import.

import { CullingController } from './culling-controller';
import * as Comlink from 'comlink';
import type { SandboxApi, RenderInput } from './sandbox-api';
import { deserializeNodeMap } from './protocol';
import { trace } from '@/shared/debug-trace';
import { setSandboxGlobalsCSS } from './stubs/project-fs';
import { setPushedLayoutCss } from '@/canvas/renderer/responsive';
import { replayOverlayPlacements } from '@/canvas/renderer/overlay-portals';
import { setSandboxCmsCollections } from './stubs/cms-ops';
import { renderNodes, setRendererDragLockedNodeIds } from '@/canvas/Renderer';
import { viewportBandPinOps } from '@/canvas/resize/viewport-band-pin-store';
import { clearMeasureReplayCache } from './sandbox/measure';
import {
  mountCodeComponent as mountCodeComponentImpl,
  mountCodeComponentsBatch as mountCodeComponentsBatchImpl,
  unmountCodeComponent as unmountCodeComponentImpl,
  updateCodeComponentProps as updateCodeComponentPropsImpl,
} from './sandbox-code-host';
import { setSandboxDndTransform, setSandboxDndHovered, setSandboxDndInteracting, isSandboxDndInteracting } from './sandbox-dnd-host';
import {
  initTextEditHost,
  isTextEditing,
  getActiveTextEditNodeId,
} from './text-edit-host';
import { initShapeEditHost } from './shape-edit-host';
import {
  contentRoot,
  setContentRoot,
  currentSandboxTransform,
  setCurrentSandboxTransform,
  emit, setCurrentRenderSeq } from './sandbox/sandbox-state';
import {
  forceRemeasureAllRects,
  startSettleObserver,
  emitSubtreeRefresh,
  scheduleRemeasureAllRects,
} from './sandbox/rect-emit';
import { emitAllMeasures } from './sandbox/measure';
import {
  setCollectionGhostsHidden, patchStyles, patchMultipleStyles, injectCSS, removeCSS,
  setCanvasTokenVar, loadFontInIframe, setCanvasTokensCSS, setInnerHTML, setAttribute,
  setChildShapeAttribute, patchAttrsAndStyles, previewPatchStyles, previewRestoreStyles,
} from './sandbox/style-handlers';
import {
  getRect, getChildRects, getComputedValues, getContainerRect, getElementIdsAtPoint,
  getTransformedCorners, getBBox, captureElement,
} from './sandbox/read-handlers';
import { bakeGroupResize, clearGroupResizeBake, liveRefitGroup } from './sandbox/group-resize';
import {
  removeElement, reparentLive, createPlaceholder, movePlaceholder, patchPlaceholderStyles,
  swapTwoElements, removePlaceholders, getPlaceholderRect, liftNode, restoreNode, commitMergedOrder,
} from './sandbox/placeholders';
import {
  startTextEdit, commitTextEdit, cancelTextEdit, editorCommand,
  startShapeEdit, commitShapeEdit, cancelShapeEdit, setShapeEditHandleMode, setShapeEditAnchorPosition,
} from './sandbox/text-shape-hosts';

// `@revyme/canvas-dnd` is no longer in active use — see sandbox-dnd-host
// for the full story. Local no-op stub keeps the call sites compiling.
const syncElements = (): void => { /* canvas-dnd removed */ };

/** Initialize the sandbox runtime. Called once on sandbox HTML mount. */
export function initSandbox(_containerEl: HTMLElement, contentRootEl: HTMLElement): void {
  setContentRoot(contentRootEl);
  // DOM-settle observer: any subtree mutation (layout-animation frames, code
  // component updates, undo patches) re-arms the debounced remeasure so
  // overlays recalc without a camera move. Idempotent.
  startSettleObserver();
  // Initialize the text-edit host with a handle to the content root so it
  // can find elements by data-node-id when the parent calls startTextEdit.
  initTextEditHost(contentRootEl);
  // Same for the SVG path editor — lives inside the iframe so anchor drag
  // events stay local (no Comlink round-trips per pointermove).
  initShapeEditHost(contentRootEl);
  // (.map() ghost-select forwarding lives inside the renderNodes onMouseDown
  // callback, where it can deterministically emit ghostSelect before
  // nodeMouseDown — see the api.render method below.)

  // Forward RAF-throttled mouse position to the parent. Parent uses this to
  // run a ghost-aware hit-test (canvas-dnd's onDndHover only sends canonical
  // data-id, so without this the hover outline always lands on the template
  // even when the cursor is over ghost #N).
  let lastMouseX = -1;
  let lastMouseY = -1;
  let mouseMoveScheduled = false;
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (mouseMoveScheduled) return;
    mouseMoveScheduled = true;
    requestAnimationFrame(() => {
      mouseMoveScheduled = false;
      emit({ type: 'sandboxMouseMove', clientX: lastMouseX, clientY: lastMouseY });
    });
  });
  // Expose the API to the parent. Comlink wraps postMessage under the hood;
  // every method becomes an awaited RPC call on the parent side.
  Comlink.expose(api, Comlink.windowEndpoint(self.parent));
  // One-time signal — Comlink doesn't have a native ready event since
  // wrap() returns a proxy immediately. Parent waits on this before sending.
  emit({ type: 'sandboxReady' });
  trace.action('canvas-sandbox:ready');
}

// ─── API implementation ───────────────────────────────────────────────────

// Camera-gesture compositor hint. Without it, every zoom frame RE-RASTERS
// the whole content layer at the new scale — on a 700-node page that's the
// "pan/zoom is laggy" cost (paint, not script). `will-change: transform`
// during the gesture makes Chromium scale the CACHED texture (transiently
// blurry, like Figma) and re-rasterise sharp once at idle. It must NOT stay
// on permanently: a promoted layer holds the full content texture at the
// current scale — GPU memory we only want to pay during gestures.
let _gestureHintTimer: ReturnType<typeof setTimeout> | null = null;

function hintCameraGesture(): void {
  if (!contentRoot) return;
  if (contentRoot.style.willChange !== 'transform') contentRoot.style.willChange = 'transform';
  if (_gestureHintTimer) clearTimeout(_gestureHintTimer);
  _gestureHintTimer = setTimeout(() => {
    _gestureHintTimer = null;
    if (contentRoot) contentRoot.style.willChange = '';
  }, 250);
}

// Viewport culling — created lazily on first render (needs contentRoot).
// Deferred while a drag is live: edge-autopan transforms mid-drag must not
// swap DOM under the active drag strategy.
// A/B verdict (2026-07-19): culling was temporarily disabled at the user's
// request to test its impact — zoom-out WITHOUT it was "terrible and
// extremely laggy" (every offscreen tile painted + rastered at every
// intermediate scale). Re-enabled permanently; culling stays.
let cullingController: CullingController | null = null;
function getCulling(): CullingController | null {
  if (!contentRoot) return null;
  if (!cullingController) {
    cullingController = new CullingController(
      contentRoot,
      () => isSandboxDndInteracting(),
      (_culled, restored) => {
        // Re-materialised subtrees need fresh parent-cache rects NOW — the
        // next render may be far away and hover/selection would read the
        // last pre-cull values (usually still right, but a code edit that
        // landed while culled can have moved things).
        if (restored > 0) scheduleRemeasureAllRects();
      },
    );
  }
  return cullingController;
}

// The post-render measure pass (rects + corners + computed for every node,
// with culled-subtree AND offscreen-section replay) lives in
// sandbox/measure.ts — see `emitAllMeasures`.

const api: SandboxApi = {
  render(input: RenderInput): void {
    if (!contentRoot) return;
    try {
      const nodes = deserializeNodeMap(input.nodes);
      // Make globals CSS available to Renderer via stubbed projectFS
      if (input.globalsCss) setSandboxGlobalsCSS(input.globalsCss);
      // Template responsive CSS (selector-prefixed parent-side). The fs-based
      // merge inside renderNodes reads NOTHING here (projectFS stub), so the
      // pushed value is the only way template @media overrides reach
      // templated-page tiles (footer-nav flex-wrap live find 2026-07-13).
      if (input.layoutCss !== undefined) setPushedLayoutCss(input.layoutCss);
      // Mirror CMS schemas + item data into the sandbox stubs so collection
      // lists render real ghost copies instead of the empty-state placeholder.
      if (input.cmsCollections) setSandboxCmsCollections(input.cmsCollections);
      // Apply transform BEFORE render so getBoundingClientRect includes pan/zoom
      if (input.transform) {
        setCurrentSandboxTransform({ ...input.transform });
        contentRoot.style.transform = `translate3d(${input.transform.x}px, ${input.transform.y}px, 0) scale(${input.transform.scale})`;
        contentRoot.style.transformOrigin = '0 0';
        getCulling()?.onTransform(input.transform.x, input.transform.y, input.transform.scale);
      }
      trace.action('canvas-sandbox:render', { nodeCount: nodes.size, vpCount: input.viewports.length, codeLen: input.code ? input.code.length : 0 });
      // Culled roots STAY culled through renders: patching display:none DOM is
      // nearly free, and the allRects pass replays lastEmittedMeasure for
      // [data-culled] subtrees. Restoring everything here forced a full
      // multi-tile relayout on every edit — the reason culling never helped
      // drag/undo/reparent on big pages. Only STALE entries are pruned —
      // elements that left the DOM OR were reparented out of root level (a
      // culled canvas node dragged into a frame; else it stays invisible +
      // unhittable forever, restorable only by a page switch).
      // FILE-SWITCH render: EVERYTHING keyed by node id belongs to the
      // PREVIOUS file — ids collide across files (`root`/`mobile-root` exist
      // in every page and every LayoutClient).
      //   • the measure replay cache would serve the old file's geometry
      //     (the ~14,000px selection overlay on template entry), and
      //   • CULLED state carries over: the old file's offscreen tile keeps its
      //     display:none + placeholder + stored box, so the NEW file's same-id
      //     root measures 0×0 and — with the camera now elsewhere — never
      //     re-materialises ("mobile viewport height 0 until I pan", user
      //     report 2026-07-27; the getRect-culled trace proved it).
      // Restore every cull (real DOM for the switch render + its measures) and
      // drop the replay cache; the post-render evaluate re-culls whatever is
      // genuinely offscreen in the NEW file.
      if (input.distrustPatchKeys && !input.preserveCulling) {
        getCulling()?.restoreAll();
        clearMeasureReplayCache();
      }
      // Remember the render epoch — echoed on allRects so the host can drop
      // measures that belong to an OLDER render (see protocol.ts).
      setCurrentRenderSeq(input.renderSeq);
      // Viewport-drag band pin: the Renderer's width-keyed resolvers run in
      // THIS bundle with their own pin-store instance — adopt the parent's
      // state before rendering (null clears when the gesture is over).
      viewportBandPinOps.adopt(input.bandPin);
      getCulling()?.pruneStale();
      // ENFORCE the pinned tile's container-query silence directly on the
      // live DOM (before AND independent of the render's own root stamp):
      // band CSS re-evaluating against the live drag width is exactly the
      // "flips to primary during resize" class, and the stamp inside the
      // root loop proved missable. Traced so a miss is visible in dumps.
      if (input.bandPin) {
        const pinnedRoot = contentRoot.querySelector(`[data-viewport="${input.bandPin.vpId}"]`) as HTMLElement | null;
        if (pinnedRoot) {
          pinnedRoot.style.containerType = 'normal';
          trace.action('sandbox:band-pin-container-off', { vpId: input.bandPin.vpId, found: true });
        } else {
          trace.action('sandbox:band-pin-container-off', { vpId: input.bandPin.vpId, found: false });
        }
      }
      renderNodes(
        contentRoot,
        nodes,
        null,
        (nodeId, mouseEvent) => {
          // Suppress iframe→parent mousedown forwarding while text editing.
          // ProseMirror needs the raw event for cursor/selection placement;
          // forwarding it to the parent triggers handleNodeMouseDown which
          // treats it as a fresh selection click and tears down the edit
          // session. Only suppress when the click is inside the editing
          // element — clicks on OTHER nodes still need to fire so the
          // outside-click commit path runs.
          if (isTextEditing()) {
            const editingId = getActiveTextEditNodeId();
            if (editingId && nodeId === editingId) return;
          }
          // .map() ghost detection — if the click target sits inside a
          // [data-collection-ghost] subtree, emit `ghostSelect` BEFORE
          // `nodeMouseDown`. Ordering matters: parent's handleNodeMouseDown
          // checks ghostClickHandledRef which is set to true by the
          // ghostSelect handler. Emitting in the same callback guarantees
          // the postMessage queue receives them in the correct order
          // (DOM event ordering on the per-element vs document-level
          // listeners is not reliable across browsers / canvas-dnd).
          let ghostTarget = mouseEvent.target as HTMLElement | null;
          while (ghostTarget) {
            if (ghostTarget.hasAttribute && ghostTarget.hasAttribute('data-collection-ghost')) {
              const fullId = ghostTarget.getAttribute('data-node-id') || '';
              const dataId = ghostTarget.getAttribute('data-id') || '';
              const match = fullId.match(/__(\d+)$/);
              if (match && dataId) {
                emit({
                  type: 'ghostSelect',
                  ghostIndex: parseInt(match[1], 10),
                  templateId: dataId,
                });
              }
              break;
            }
            ghostTarget = ghostTarget.parentElement;
          }
          emit({
            type: 'nodeMouseDown',
            nodeId,
            event: {
              clientX: mouseEvent.clientX,
              clientY: mouseEvent.clientY,
              button: mouseEvent.button,
              shiftKey: mouseEvent.shiftKey,
              altKey: mouseEvent.altKey,
              ctrlKey: mouseEvent.ctrlKey,
              metaKey: mouseEvent.metaKey,
            },
          });
        },
        input.viewports,
        input.code,
        input.activeLocale,
        input.defaultLocale,
        // Re-Map the plain Record sent over postMessage — renderNodes +
        // patchElement expect a real Map<string, NodeOverride>. Without
        // this rehydration the iframe never applies i18n overrides and
        // every locale renders the default-locale JSX text.
        input.localeOverrides ? new Map(Object.entries(input.localeOverrides)) : undefined,
        input.distrustPatchKeys,
      );
      trace.action('canvas-sandbox:render-done', { children: contentRoot.children.length });
      // Re-cull SYNCHRONOUSLY before measuring: at high zoom this drops the
      // measure pass from every-element to visible-elements-only (culled
      // subtrees replay their cached payloads below). evaluate() reads root
      // boxes (forces one layout), then display:none removes the culled
      // subtrees from the relayout the measurement forces next.
      //
      // NOT on a FILE-SWITCH render. The camera is TRANSITIONAL here (the
      // entry's pre-zoom; the real fit runs after this render's measures
      // land) — the sync re-cull judged the fresh file's tiles against that
      // in-between camera, hid all three template viewports, the measure
      // pass emitted 3 rects for a 70-node file, and the entry's fit +
      // every later read saw only culled zeros ("measured: 3" trace, user
      // report 2026-07-27). A new file needs ONE full measure before any
      // culling; the idle evaluate re-culls at the SETTLED camera.
      if (!input.distrustPatchKeys || input.preserveCulling) getCulling()?.evaluate();
      // AFTER the sync re-cull: culled roots whose content was PATCHED this
      // render (marked data-culled-dirty by patchElement) re-materialise so
      // the measure below emits their REAL new geometry — otherwise the grey
      // placeholder + the replayed rect caches (name labels, selection
      // overlays) stay at the pre-edit position and "bleed" into view. The
      // idle evaluate scheduled by restoreDirty re-culls them with the fresh
      // box once the caches are updated.
      getCulling()?.restoreDirty();
      // Measure pass (rects + corners + computed, with culled + offscreen-
      // section replay) — sandbox/measure.ts.
      emitAllMeasures({ scheduleCullEvaluate: () => getCulling()?.scheduleEvaluate() });
    } catch (err) {
      trace.error('canvas-sandbox:render-failed', err);
      emit({ type: 'error', message: String(err), stack: (err as Error)?.stack });
    }
    // Tell canvas-dnd the DOM changed so it re-collects element rects.
    // Without this, canvas-dnd's hit-test cache is empty and clicks miss.
    try { syncElements(); } catch { /* canvas-dnd may not be initialized yet */ }
    emit({ type: 'renderComplete' });
  },

  setDragLockedNodeIds(ids: string[]): void {
    setRendererDragLockedNodeIds(new Set(ids));
    // Central drag-locks double as the sandbox's "element drag live" signal.
    // The legacy canvas-dnd flag was never set for coordinator drags, so
    // everything gated on isSandboxDndInteracting (culling defer, the
    // ResizeObserver-fed remeasure sweep) silently ran mid-drag — traced as
    // a full sweep every ~150ms for the whole gesture on code-component
    // pages. Locks are non-empty exactly while a drag holds elements.
    setSandboxDndInteracting(ids.length > 0);
  },

  /** Re-measure every node's rect/corners AFTER the caller's latest DOM
   *  mutations (cancels any premature pending remeasure). Used after a reorder
   *  so selection/hover overlays snap to the new layout instantly. */
  forceRemeasureAllRects,

  // ─── Style / attr / CSS patching — sandbox/style-handlers.ts ───────────
  setCollectionGhostsHidden,
  patchStyles,
  patchMultipleStyles,
  previewPatchStyles,
  previewRestoreStyles,
  injectCSS,
  removeCSS,
  setCanvasTokenVar,
  loadFontInIframe,
  setCanvasTokensCSS,
  setInnerHTML,
  setAttribute,
  setChildShapeAttribute,
  patchAttrsAndStyles,

  // ─── DOM reads — sandbox/read-handlers.ts ──────────────────────────────
  getRect,
  getChildRects,
  getComputedValues,
  getContainerRect,
  getElementIdsAtPoint,
  getTransformedCorners,
  getBBox,

  setViewportTransform(x: number, y: number, scale: number): void {
    if (!contentRoot) return;
    setCurrentSandboxTransform({ x, y, scale });
    hintCameraGesture();
    contentRoot.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    contentRoot.style.transformOrigin = '0 0';
    // Forward to canvas-dnd so drag/snap math uses the right scale + offset
    setSandboxDndTransform(x, y, scale);
    // Viewport culling: evaluate when the camera settles (idle debounce) —
    // culled roots materialise at gesture END, never mid-pan.
    getCulling()?.onTransform(x, y, scale);
  },

  setDndHovered(nodeId: string | null, viewport?: string): void {
    setSandboxDndHovered(nodeId, viewport);
  },

  setDndInteracting(interacting: boolean): void {
    const was = isSandboxDndInteracting();
    setSandboxDndInteracting(interacting);
    trace.action('sandbox:dnd-interacting', { interacting, was, willReconcile: was && !interacting && !!contentRoot });
    // Gesture end: per-patch subtree refreshes were suppressed during the
    // interaction (rect-emit gate), so descendant rect/corner caches are
    // stale. Reconcile through the BATCHED allRects pipeline — NOT the
    // per-element emitSubtreeRefresh storm. Measured live (2026-07-19): the
    // storm posted ~2900 individual rect/corners messages of which the
    // parent's window listener received effectively NONE — descendants of a
    // moved canvas frame kept pre-drag cached rects, so their children were
    // un-hoverable/un-selectable until a camera move ran the allRects
    // sweep. emitAllMeasures ships the same data as a few batched envelopes
    // over the proven allRects channel (the exact path the camera-idle heal
    // uses), bumps the host's cacheGeneration, and is cheaper.
    if (was && !interacting && contentRoot) {
      trace.action('sandbox:dnd-gesture-end-reconcile', { nodes: contentRoot.querySelectorAll('[data-node-id]').length });
      // forceRemeasureAllRects also RE-PLACES portaled overlays (see the replay
      // inside runRemeasureOnNextFrame): a layout drop commits imperatively and
      // skips the re-render, so the Renderer's portal pass never runs here and a
      // relative overlay would keep its pre-gesture position. The settle observer
      // lands a second pass once framer-motion's layout FLIP finishes, which is
      // when the trigger's rect is actually final.
      forceRemeasureAllRects();
    }
  },

  /** Re-place portaled relative overlays from their triggers' CURRENT rects,
   *  NOW plus once on the next frame. Called at drop so an overlay lands in the
   *  same frame as its reordered trigger — the measure funnel's replay is
   *  settle-DEBOUNCED (150ms after the DOM goes quiet), which the user sees as
   *  the overlay visibly catching up a beat late. The next-frame pass covers a
   *  reorder whose final `order` values land one frame after the drop commit.
   *  Idempotent: replaying an already-correct placement is a no-op write. */
  repositionOverlays(): void {
    if (!contentRoot) return;
    const now = replayOverlayPlacements(contentRoot);
    trace.action('sandbox:repositionOverlays', { replaced: now });
    requestAnimationFrame(() => {
      if (contentRoot) replayOverlayPlacements(contentRoot);
    });
  },

  // ─── Live SVG group resize / refit — sandbox/group-resize.ts ───────────
  bakeGroupResize,
  clearGroupResizeBake,
  liveRefitGroup,

  // ─── Drag placeholders + imperative lift/restore/reparent — sandbox/placeholders.ts ─
  removeElement,
  reparentLive,
  createPlaceholder,
  movePlaceholder,
  patchPlaceholderStyles,
  swapTwoElements,
  removePlaceholders,
  getPlaceholderRect,
  liftNode,
  restoreNode,
  commitMergedOrder,

  mountCodeComponent(nodeId: string, code: string, props: Record<string, any>, vpWidth: number): void {
    if (!contentRoot) return;
    mountCodeComponentImpl(contentRoot, nodeId, code, props, vpWidth);
  },

  mountCodeComponentsBatch(
    mounts: Array<{ nodeId: string; code: string; props: Record<string, any>; vpWidth: number }>,
  ): void {
    if (!contentRoot) return;
    mountCodeComponentsBatchImpl(contentRoot, mounts);
  },

  unmountCodeComponent(nodeId: string): void {
    unmountCodeComponentImpl(nodeId);
  },

  updateCodeComponentProps(nodeId: string, props: Record<string, any>, vpWidth: number): void {
    updateCodeComponentPropsImpl(nodeId, props, vpWidth);
  },

  // ─── Text editing — sandbox/text-shape-hosts.ts ────────────────────────
  startTextEdit,
  commitTextEdit,
  cancelTextEdit,
  editorCommand,

  // ─── Shape editing — sandbox/text-shape-hosts.ts ───────────────────────
  startShapeEdit,
  commitShapeEdit,
  cancelShapeEdit,
  setShapeEditHandleMode,
  setShapeEditAnchorPosition,

  // ─── Element capture — sandbox/read-handlers.ts ────────────────────────
  captureElement,
};
