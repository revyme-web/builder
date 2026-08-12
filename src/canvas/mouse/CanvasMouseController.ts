// src/canvas/mouse/CanvasMouseController.ts
//
// Owns ALL mouse event handling extracted from Canvas.tsx:
//   - handleMouseMove  (hover hit-test with redirect chain)
//   - handleMouseUp    (pan cleanup + empty-canvas deselect)
//   - handleNodeMouseDown  (selection routing, dblclick, shape-edit, drag start)
//   - handleCanvasMouseDown (empty-canvas / pan-tool / creator-tool routing)
//   - revyme:select-viewport window listener
//   - revyme:ghost-select document listener
//   - capture-phase ghost DOM listener
//
// Constructor receives opts; all heavy logic is verbatim-ported from Canvas.tsx
// with mechanical ref substitutions (nodesRef.current → store.get(nodesAtom), etc.).

import type { useStore } from 'jotai';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import type React from 'react';
import { commitFocusedPanelInput } from '@/shared/dom-utils';
import { trace } from '@/shared/debug-trace';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import {
  nodesAtom,
  selectedIdsAtom,
  mapItemIndexAtom,
  getNodeFromCache,
  variableModalRequestAtom,
  componentToolRevealAtom,
} from '@/code/stores/store';
import {
  isComponentFilePath,
  isMasterFilePath,
} from '@/code/project/active-file-store';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import {
  interactingViewportIdAtom,
  viewportsConfigAtom,
  DEFAULT_VIEWPORTS,
} from '@/code/stores/viewport-store';
import {
  toolModeAtom,
} from '@/code/stores/tool-store';
import {
  shapeEditingIdAtom,
} from '@/code/stores/shape-edit-store';
import {
  groupEditingIdAtom,
  activeContainerIdAtom,
} from '@/code/stores/shape-edit-store';
import {
  activeGradientAtom,
  selectedGradientStopAtom,
  gradientUpdateCallbackAtom,
  gradientStopUpdateCallbackAtom,
  gradientStopSelectCallbackAtom,
  gradientCommitCallbackAtom,
  isMaskGradientAtom,
} from '@/code/stores/gradient-store';
import {
  activeClipPathAtom,
  clipPathUpdateCallbackAtom,
  clipPathCommitCallbackAtom,
} from '@/code/stores/clippath-store';
import { closeActiveToolPopup } from '@/editor/ui/ToolPopup';
import { colorPickerOpenAtom } from '@/code/stores/editor-store';
import {
  overlayEditingIdAtom,
} from '@/code/stores/overlay-store';
import {
  directSelectionEnabledAtom,
} from '@/code/stores/user-preferences-store';
import {
  suppressSelectionOverlayAtom,
} from '@/code/stores/editor-store';
import {
  componentEditorFileAtom,
} from '@/code/stores/component-editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { isDefaultLocaleAtom } from '@/code/stores/locale-store';
import {
  getViewportPrefix,
  redirectToComponentInstance,
  redirectToCollectionTemplate,
  redirectToFitTextWrapper,
  redirectLayoutNodeToViewport,
  getIsolatedChildOfGroup,
  getNodeHitsAtPoint,
  vpIdFromPrefix,
  getActiveFilePath,
  isPrimaryViewport,
} from '../node-ops';
import { getScreenCornersById } from '../resize/geometry-utils';
import { queueReplicaCreationUnhide } from '../creators/creator-utils';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { redirectToTopLevelChild } from '../commands';
import {
  getGhostIndex,
  stripGhostSuffix,
} from '@/shared/ghost-id';
import {
  handleHandToolDown,
  handleHandToolMove,
  handleHandToolUp,
  handleSpacePanDown,
  handleSpacePanMove,
  handleSpacePanUp,
  isPanning,
  isSpacePanning,
  isSpaceBarDown,
} from '../transform';
import {
  startFrameCreation,
} from '../creators/FrameCreator';
import {
  startTextCreation,
  getDefaultTextNodeStyles,
} from '../creators/TextCreator';
import {
  startShapeCreation,
  type ShapeMode,
} from '../creators/ShapeCreator';
import {
  startSketchCreation,
} from '../creators/SketchCreator';
import {
  startLayoutCreation,
  type LayoutMode,
} from '../creators/LayoutCreator';
import {
  isShapeMode,
  isLayoutMode,
} from '@/code/stores/tool-store';
import { suppressSelectionBox } from '../selection/SelectionBox';
import { enterComponentFile } from '../component-navigation';
import { getPageTemplate, listTemplates } from '@/code/project/template-ops';
import { generateNodeId } from '@/shared/id-utils';
import { createNode, getContentRoot, findNodeRect, clearBridgeReadCaches } from '../node-ops';
import { zoomToFit, zoomToFitSelection, zoomToFitCanvasBounds, transformManager, cameraStash } from '@/canvas/transform';
import { parseCanvasConfig } from '@/code/project/canvas-config';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { isFrameTag } from '@/shared/constants';
import { DOUBLE_CLICK_THRESHOLD, ZERO_WIDTH_SPACE } from '@/shared/constants';

// Max mouse movement (screen px) between two clicks for them to count as
// a double-click. OS-level dbl-click typically allows ~4 px of jitter; we
// use 5 to be slightly more forgiving for trackpad users.
const DOUBLE_CLICK_MAX_DIST = 5;

type JotaiStore = ReturnType<typeof useStore>;

export interface CanvasMouseControllerOpts {
  jotaiStore: JotaiStore;
  bridge: PostMessageBridge;
  containerRef: React.RefObject<HTMLDivElement | null>;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  dragCoordinatorRef: React.MutableRefObject<import('../drag/DragCoordinator').DragCoordinator | null>;
  textEditControllerRef: React.MutableRefObject<import('../text-edit/CanvasTextEditController').CanvasTextEditController | null>;
  editingNodeIdRef: React.MutableRefObject<string | null>;
  hoverSuppressUntilRef: React.MutableRefObject<number>;
  canvasInteractingValRef: React.MutableRefObject<boolean>;
  frameCreatorCallbacksRef: React.MutableRefObject<(() => any) | null>;
  // React setters threaded from Canvas.tsx
  setBreadcrumb: (fn: (prev: string[]) => string[]) => void;
  setActiveFilePath: (path: string) => void;
  setUpdatingFromCanvas: (b: boolean) => void;
  setPanCursor: (v: boolean) => void;
  setInteractingViewport: (vpId: string) => void;
  setSelectedIds: (ids: string[]) => void;
  setHoveredId: (id: string | null) => void;
  setHoveredNodeId: (id: string | null) => void;
  setHoveredViewport: (vpId: string | null) => void;
  setMapItemIndex: (idx: number | null) => void;
  setShapeEditingId: (fn: ((prev: string | null) => string | null) | string | null) => void;
  setSelectedPoint: (p: any) => void;
  setGroupEditingId: (id: string | null) => void;
  setOverlayEditingId: (id: string | null) => void;
  startTextEdit: (nodeId: string, el: HTMLElement | null, textContent: string, vpId?: string) => void;
  commitTextEdit: () => Promise<void>;
  // CMS setters
  /** Open the CMS editor overlay (collection + optional item/field). Wired to
   *  `openCmsEditorAtom`, which also selects the CMS left panel — App closes
   *  the overlay whenever that panel isn't active. */
  openCmsEditor: (opts: { collection: string; itemId?: string | null; fieldId?: string | null }) => void;
  setLeftPanel: (p: string) => void;
  setToolMode: (m: string) => void;
  // cmsData for bound text double-click
  getCmsData: () => Map<string, any[]>;
}

export class CanvasMouseController {
  private opts: CanvasMouseControllerOpts;
  private store: JotaiStore;

  // Internal state that was previously refs in Canvas.tsx
  lastClick: { nodeId: string; vpId: string | null; time: number; x: number; y: number } | null = null;
  emptyCanvasClick = false;
  /** Child of a multi-selected node pressed this gesture. The drag was redirected
   *  to the ancestor (group drag); if the pointer never moves, mouseup selects
   *  this child instead. Null when the press wasn't that case. */
  private pendingMultiSelectChild: string | null = null;
  ghostClickHandled = false;

  // Cleanup functions for event listeners
  private _removeReplicaListener: (() => void) | null = null;
  private _removeGhostDomListener: (() => void) | null = null;
  private _removeGhostBridgeListener: (() => void) | null = null;
  private _removeSetInteractingVpListener: (() => void) | null = null;
  private _removeModifierHoverListener: (() => void) | null = null;
  // Last canvas hover position — lets a Ctrl/Cmd keydown/keyup re-run the hover
  // redirect at the same spot (direct-select UP preview without moving).
  private lastHoverClientX = 0;
  private lastHoverClientY = 0;

  constructor(opts: CanvasMouseControllerOpts) {
    this.opts = opts;
    this.store = opts.jotaiStore;
    trace.action('canvas:mouse-controller-created', {});

    // ─── Replica Selection (revyme:select-viewport event) ───────────────
    // Dispatched by keyboard shortcuts (Shift+B) to select a node in a
    // specific replica viewport.
    const replicaHandler = (e: Event) => {
      const { nodeId, vpId } = (e as CustomEvent).detail;
      opts.setInteractingViewport(vpId);
      opts.setSelectedIds([nodeId]);
      trace.action('canvas:select-viewport', { nodeId, vpId });
    };
    window.addEventListener('revyme:select-viewport', replicaHandler);
    this._removeReplicaListener = () => window.removeEventListener('revyme:select-viewport', replicaHandler);

    // ─── Set Interacting Viewport event ─────────────────────────────────
    // Dispatched by drag strategies that hand the dragged element off to
    // a different viewport mid-drag.
    const setVpHandler = (e: Event) => {
      const { vpId } = (e as CustomEvent).detail;
      opts.setInteractingViewport(vpId);
      trace.action('canvas:set-interacting-viewport', { vpId, source: 'drag-entry' });
    };
    window.addEventListener('revyme:set-interacting-viewport', setVpHandler);
    this._removeSetInteractingVpListener = () => window.removeEventListener('revyme:set-interacting-viewport', setVpHandler);

    // ─── Ghost Selection — capture-phase DOM listener ────────────────────
    // Direct DOM check on every mousedown: walk up from target to find
    // data-collection-ghost. Capture phase fires BEFORE handleNodeMouseDown.
    // NOTE: only fires in DirectBridge mode (no iframe).
    const ghostDomHandler = (e: MouseEvent) => {
      this.ghostClickHandled = false; // reset each click
      let target = e.target as HTMLElement | null;
      while (target) {
        if (target.hasAttribute('data-collection-ghost')) {
          const nodeId = target.getAttribute('data-node-id') || '';
          const match = nodeId.match(/__(\d+)$/);
          if (match) {
            const ghostIndex = parseInt(match[1], 10);
            opts.setMapItemIndex(ghostIndex);
            this.ghostClickHandled = true;
            trace.action('canvas:ghost-selected', { ghostIndex, nodeId });
          }
          return;
        }
        target = target.parentElement;
      }
    };
    document.addEventListener('mousedown', ghostDomHandler, true);
    this._removeGhostDomListener = () => document.removeEventListener('mousedown', ghostDomHandler, true);

    // ─── Ghost Selection (iframe-aware path) ─────────────────────────────
    // In iframe mode the parent-frame mousedown listener above can't see
    // clicks on ghost elements (e.target is the <iframe> itself).
    // Renderer.ts dispatches 'revyme:ghost-select' inside the iframe;
    // bridge-sandbox forwards it to bridge-host which re-dispatches the
    // same CustomEvent on the parent's document.
    const ghostBridgeHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.ghostIndex === 'number') {
        opts.setMapItemIndex(detail.ghostIndex);
        this.ghostClickHandled = true;
        trace.action('canvas:ghost-selected-via-bridge', {
          ghostIndex: detail.ghostIndex,
          templateId: detail.templateId,
        });
      }
    };
    document.addEventListener('revyme:ghost-select', ghostBridgeHandler);
    this._removeGhostBridgeListener = () => document.removeEventListener('revyme:ghost-select', ghostBridgeHandler);

    // ─── Direct-select UP preview on Ctrl/Cmd press (no mouse move) ───────
    // The hover redirect normally only re-evaluates on mousemove. So pressing
    // Cmd while STATIONARY over a child wouldn't preview the parent until the
    // user moved. Re-run the hover at the last position whenever Ctrl/Cmd is
    // pressed or released. Gated to Meta/Control keys, skipped while typing in
    // an input/textarea/contentEditable (so Cmd-shortcuts there don't hijack
    // the canvas hover) — `updateHover` itself bails during drag/pan.
    const modifierHoverHandler = (ke: KeyboardEvent) => {
      if (ke.key !== 'Meta' && ke.key !== 'Control') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      this.updateHover(this.lastHoverClientX, this.lastHoverClientY, ke.metaKey || ke.ctrlKey);
    };
    window.addEventListener('keydown', modifierHoverHandler);
    window.addEventListener('keyup', modifierHoverHandler);
    this._removeModifierHoverListener = () => {
      window.removeEventListener('keydown', modifierHoverHandler);
      window.removeEventListener('keyup', modifierHoverHandler);
    };
  }

  /** Wire the node-mousedown ref so the Renderer can install per-node handlers */
  bindNodeMouseDown(target: React.MutableRefObject<(nodeId: string, e: MouseEvent) => void>): void {
    target.current = (nodeId: string, e: MouseEvent) => this.handleNodeMouseDown(nodeId, e);
    trace.fn('canvas:mouse-controller-bind-node-mousedown', {});
  }

  /**
   * Overlay edit mode: from a hit stack, return the first ALLOWED node — the
   * edited overlay (or a descendant), its source/trigger (any click on it
   * redirects to the trigger itself), or a top-level canvas node. Everything
   * else in the viewport is non-selectable / non-hoverable while editing an
   * overlay. Returns null when nothing allowed was hit. Shared by hover + click.
   */
  private resolveOverlayAllowedHit(
    hits: Array<{ id: string; vpPrefix: string }>,
    overlayId: string,
  ): { id: string; vpPrefix: string } | null {
    const nodes = this.store.get(nodesAtom);
    let triggerId = '';
    try { triggerId = JSON.parse(nodes.get(overlayId)?.attrs?.['data-overlay'] || '{}').triggerId || ''; } catch { /* skip */ }
    const isDescendantOf = (id: string, ancestorId: string): boolean => {
      let cur = nodes.get(id)?.parentId ?? null;
      for (let i = 0; i < 50 && cur; i++) { if (cur === ancestorId) return true; cur = nodes.get(cur)?.parentId ?? null; }
      return false;
    };
    for (const h of hits) {
      const n = nodes.get(h.id);
      if (h.id === overlayId || isDescendantOf(h.id, overlayId)) return h;
      if (triggerId && (h.id === triggerId || isDescendantOf(h.id, triggerId))) return { id: triggerId, vpPrefix: h.vpPrefix };
      if (n?.isCanvasNode) return h;
    }
    return null;
  }

  /**
   * Direct-selection UP-redirect. With direct selection ON (the default), the
   * canvas targets the DEEPEST hit. Holding Ctrl/Cmd promotes that hit to its
   * IMMEDIATE PARENT (one level up) for hover, selection AND drag — so the user
   * can grab the containing frame without leaving direct mode (hover a card's
   * label + Cmd → target the card). Stops at the viewport root: a top-level
   * section's parent is the root, and selecting the whole viewport from a single
   * Cmd-hover isn't the intent, so the section is kept. A `layout::` parent
   * redirects to the viewport (same as `redirectLayoutNodeToViewport`).
   */
  private promoteToParent(nodeId: string): string {
    const nodes = this.store.get(nodesAtom);
    const parentId = nodes.get(nodeId)?.parentId;
    if (!parentId) return nodeId; // already top-level / the root itself
    const parent = nodes.get(parentId);
    // Immediate parent IS the viewport root → keep the node (don't jump to the
    // whole viewport from one Cmd-press).
    if (parent && !parent.parentId && !parent.isCanvasNode) return nodeId;
    return redirectLayoutNodeToViewport(parentId) ?? parentId;
  }

  /** Hover hit-test + redirect chain, parameterized so it can be re-run on a
   *  Ctrl/Cmd key change at the LAST mouse position (not just on mousemove) —
   *  so pressing Cmd while stationary over a child immediately previews the
   *  parent. Mirrors the logic inlined in `handleMouseMove`. */
  private updateHover(clientX: number, clientY: number, ctrlOrMeta: boolean): void {
    if (
      this.opts.dragCoordinatorRef.current?.isDragging ||
      this.opts.canvasInteractingValRef.current ||
      performance.now() < this.opts.hoverSuppressUntilRef.current ||
      isPanning() || isSpacePanning() || isSpaceBarDown()
    ) return;

    const hits = getNodeHitsAtPoint(clientX, clientY);
    const overlayHoverId = this.store.get(overlayEditingIdAtom);
    if (overlayHoverId) {
      const allowed = hits.length > 0 ? this.resolveOverlayAllowedHit(hits, overlayHoverId) : null;
      if (allowed) {
        // Apply the SAME redirects as the normal hover path (below): a component
        // instance is ATOMIC, so hovering its children must resolve to the
        // instance. This was skipped in overlay-editing mode → every child of a
        // component instance inside a fixed overlay highlighted individually
        // (the select path already redirects via handleNodeMouseDown). FIT text
        // still resolves to its SVG wrapper.
        const grpEdit = this.store.get(groupEditingIdAtom);
        let hid = redirectToComponentInstance(allowed.id, this.store.get(nodesAtom), grpEdit);
        const fitHid = redirectToFitTextWrapper(hid, this.store.get(nodesAtom));
        if (fitHid) hid = fitHid;
        this.opts.setHoveredViewport(vpIdFromPrefix(allowed.vpPrefix));
        this.opts.setHoveredId(hid);
        this.opts.setHoveredNodeId(hid);
      } else {
        this.opts.setHoveredId(null);
        this.opts.setHoveredNodeId(null);
      }
      return;
    }
    if (hits.length === 0) {
      this.opts.setHoveredId(null);
      this.opts.setHoveredNodeId(null);
      return;
    }
    const { id: realId, vpPrefix } = hits[0];
    this.opts.setHoveredViewport(vpIdFromPrefix(vpPrefix));
    const canonicalId = stripGhostSuffix(realId);
    const hoverGroupEditId = this.store.get(groupEditingIdAtom);
    let redirected = redirectToComponentInstance(canonicalId, this.store.get(nodesAtom), hoverGroupEditId);
    const fitHover = redirectToFitTextWrapper(redirected, this.store.get(nodesAtom));
    if (fitHover) redirected = fitHover;
    const layoutRedirect = redirectLayoutNodeToViewport(redirected);
    if (layoutRedirect) redirected = layoutRedirect;
    // Figma-style nested-selection redirect (down) vs direct-select UP-redirect.
    const directSel = this.store.get(directSelectionEnabledAtom);
    if (!directSel && !ctrlOrMeta) {
      const activeContainer = this.store.get(activeContainerIdAtom);
      redirected = redirectToTopLevelChild(redirected, activeContainer, this.store.get(nodesAtom));
    } else if (directSel && ctrlOrMeta) {
      // Ctrl/Cmd promotes the hover to the parent frame (direct-select up).
      redirected = this.promoteToParent(redirected);
    }
    // SAFETY NET — a component instance rendered INSIDE the template (header,
    // footer, nav…) resolves to an id that isn't in the page's merged node
    // map: template chrome is merged under `layout::…`, but the instance's own
    // id is not. So none of the redirects above land it on a real node and the
    // hover would silently VANISH (the bug: hovering a template element keeps
    // the full-viewport highlight, but hovering a component instance inside it
    // cleared the hover entirely). Treat any unresolvable target as template
    // chrome → highlight the viewport root, exactly like a plain template node.
    if (redirected !== 'root' && !this.store.get(nodesAtom).has(redirected)) {
      redirected = 'root';
    }
    this.opts.setHoveredId(redirected);
    const ghostSuffixed = redirected === canonicalId && realId !== canonicalId ? realId : redirected;
    this.opts.setHoveredNodeId(ghostSuffixed);
  }

  /** Called from the canvas container's onMouseMove React handler */
  handleMouseMove(e: MouseEvent): void {
    // A modal is open → freeze canvas hover/drag tracking too (no hover highlight behind the modal).
    if (document.querySelector('[data-modal-root]')) return;
    // Space+drag pan
    if (handleSpacePanMove(e)) return;
    // Hand tool pan (middle mouse handled natively via attachMiddleMousePan)
    if (handleHandToolMove(e)) return;

    // Drag coordinator handles drag movement.
    // Skip if window listeners are active (they handle it already — prevents double processing)
    if (!this.opts.dragCoordinatorRef.current?.hasWindowListeners) {
      this.opts.dragCoordinatorRef.current?.handleMouseMove(e);
    }

    // Hover tracking — hit test from cached rects (viewport-aware). Stash the
    // position so a Ctrl/Cmd key change can re-run the hover at the same spot
    // (direct-select UP preview when the user presses Cmd without moving).
    this.lastHoverClientX = e.clientX;
    this.lastHoverClientY = e.clientY;
    this.updateHover(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
  }

  /** Called from the canvas container's onMouseUp and onMouseLeave React handlers */
  handleMouseUp(e: MouseEvent): void {
    // Don't run the empty-canvas deselect on a mouseup that belongs to a modal/popup interaction.
    if (document.querySelector('[data-modal-root]')) { this.emptyCanvasClick = false; return; }
    trace.action('canvas:mouseup', { button: e.button, wasPanning: isPanning() });
    handleHandToolUp();
    handleSpacePanUp();
    this.opts.setPanCursor(false);
    const wasDragging = this.opts.dragCoordinatorRef.current?.isDragging || this.opts.dragCoordinatorRef.current?.isPending;
    // `isDragging` ALONE (not `|| isPending`): a plain click on a child of a
    // multi-selection leaves the coordinator PENDING — armed at mousedown but
    // never moved past the threshold — so `wasDragging` is true for a click that
    // never dragged and cannot gate the deferred selection below.
    const didActuallyDrag = this.opts.dragCoordinatorRef.current?.isDragging ?? false;
    // Skip if window listeners handle mouseup (prevents double processing)
    if (!this.opts.dragCoordinatorRef.current?.hasWindowListeners) {
      this.opts.dragCoordinatorRef.current?.handleMouseUp();
    }

    // Clear selection if mousedown was on empty canvas AND no drag/selection-box happened
    if (this.emptyCanvasClick && !wasDragging) {
      this.store.set(selectedIdsAtom, []);
      // Reset the Figma-style nested-selection container — clicking
      // on empty canvas is the user's "back to top-level" gesture.
      this.store.set(activeContainerIdAtom, null);
    }
    // Deferred multi-select child pick: mousedown sent the DRAG to the
    // multi-selected ancestor; with no drag, the press meant "select this child".
    if (this.pendingMultiSelectChild && !didActuallyDrag) {
      const childId = this.pendingMultiSelectChild;
      trace.action('canvas:multi-select-child-picked', { childId });
      this.store.set(selectedIdsAtom, [childId]);
    }
    this.pendingMultiSelectChild = null;

    this.emptyCanvasClick = false;
  }

  /**
   * Cancel a pending empty-canvas deselect.
   * Called by handleSelectionBoxChange (rubber-band) in Canvas.tsx since the
   * ref is owned here but the selection box lives in Canvas.tsx JSX.
   */
  cancelEmptyCanvasClick(): void {
    this.emptyCanvasClick = false;
  }

  /** Shared node mousedown handler — used by ALL elements (Renderer-created and imperative-created). */
  handleNodeMouseDown(nodeId: string, e: MouseEvent, vpIdOverride?: string): void {
    // Commit a half-typed panel input before this changes the selection — the
    // in-iframe node mousedown arrives through the bridge, so it does NOT pass
    // through `handleMouseDown`'s call. Same reason; see
    // `commitFocusedPanelInput`.
    commitFocusedPanelInput();
    // Any locked template node click → select the whole viewport (same as
    // clicking the viewport header). The template is merged onto the page root,
    // so the viewport IS `root` — redirectLayoutNodeToViewport returns 'root'
    // for navbar/footer/etc. (`layout::…`).
    const layoutRedirect = redirectLayoutNodeToViewport(nodeId);
    if (layoutRedirect) {
      // Double-click on a layout node: jump into the Template's
      // LayoutClient.tsx and select the corresponding node there.
      const isLeftButtonL = e.button === 0;
      const noModL = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      const nowL = Date.now();
      const lastL = this.lastClick;
      const dtL = lastL ? nowL - lastL.time : Infinity;
      const distL = lastL ? Math.hypot(e.clientX - lastL.x, e.clientY - lastL.y) : Infinity;
      const layoutVpId = vpIdOverride || this.store.get(interactingViewportIdAtom);
      const isLayoutDouble = isLeftButtonL && noModL && lastL && lastL.nodeId === nodeId && lastL.vpId === layoutVpId && dtL > 50 && dtL < DOUBLE_CLICK_THRESHOLD && distL <= DOUBLE_CLICK_MAX_DIST;
      if (isLayoutDouble) {
        const activeFile = getActiveFilePath();
        const tplName = getPageTemplate(activeFile);
        const tpl = tplName ? listTemplates().find(t => t.name === tplName) : null;
        if (tpl) {
          // Entering the Template selects the TEMPLATE AS A WHOLE — its root
          // ('root' in the LayoutClient), NOT whichever node sat under the
          // cursor. The interacting viewport (below) carries WHICH replica
          // (desktop / tablet / mobile) the user double-clicked, so the
          // matching viewport's template root is the one shown selected.
          this.lastClick = null;
          flushNow();
          // ── Smooth, no-jump enter (same PRE-ZOOM technique as
          // enterComponentFile): snap the camera to the clicked viewport's
          // template root bounds — in the TEMPLATE's OWN canvas space — BEFORE
          // switching the active file, so the template's first paint already
          // lands at the right zoom and the post-render Fit Selection is a
          // near no-op (no visible scale jump). Save the camera for "back". ──
          cameraStash.save(activeFile, transformManager.getTransform());
          const tplCfg = parseCanvasConfig(projectFS.readFile(tpl.clientPath) ?? '');
          // WHICH template viewport actually renders on the clicked page tile?
          // Chrome resolves its band by WIDTH (max-width semantics), not by
          // viewport NAME — a "mobile" page tile resized to 609 paints the
          // template's TABLET band (609 ≤ 768), so entering must land on the
          // template's tablet artboard, not its 375 mobile ("it zooms on
          // mobile although the tablet template body is what's used",
          // 2026-08-06). Bucket the page tile's width against the template's
          // own viewport set: smallest template width ≥ the page width; wider
          // than all → the template's primary. Same-name fallback when the
          // page width is unknown.
          const pageVpWidth = this.store.get(viewportsConfigAtom).find(v => v.id === layoutVpId)?.width ?? 0;
          const tplViewportSet = tplCfg?.viewports?.length ? tplCfg.viewports : DEFAULT_VIEWPORTS;
          let tplVpId = layoutVpId;
          if (pageVpWidth > 0 && tplViewportSet.length > 0) {
            let bucket: { id: string; width: number } | null = null;
            for (const v of tplViewportSet) {
              if (v.width >= pageVpWidth && (bucket === null || v.width < bucket.width)) bucket = v;
            }
            const tplPrimary = tplViewportSet.find(v => v.isPrimary)
              ?? tplViewportSet.reduce((a, b) => (b.width > a.width ? b : a));
            tplVpId = (bucket ?? tplPrimary).id;
            if (tplVpId !== layoutVpId) {
              trace.action('canvas:enter-template-band-redirect', { pageVpId: layoutVpId, pageVpWidth, tplVpId });
            }
          }
          const tplVp = tplCfg?.viewports.find(v => v.id === tplVpId);
          if (tplCfg && tplVp && (tplVp.width || 0) > 0) {
            const tplPos = tplCfg.positions[tplVpId] ?? { x: 0, y: 0 };
            // Height: use the LIVE rendered height of this viewport's template
            // root (the page's merged `root`; screen px → canvas via /scale) so
            // the pre-zoom box matches the post-render fit; fall back to a
            // square when no rect is cached yet.
            const liveRect = findNodeRect('root', layoutVpId);
            const curScale = transformManager.getTransform().scale;
            const tplH = (liveRect && liveRect.height > 0 && curScale > 0)
              ? liveRect.height / curScale
              : tplVp.width;
            zoomToFitCanvasBounds({ left: tplPos.x, top: tplPos.y, width: tplVp.width, height: tplH }, true);
          }
          // ── Opacity dip — hide the iframe through the file switch + camera
          // snap so any RESIDUAL fit adjustment is INVISIBLE (templates are
          // auto-height, so the pre-zoom above can't be pixel-exact). The
          // iframe's `style` prop is static, so this imperative write survives
          // React reconciliation. Same mechanism as enterComponentFile. ──
          const iframeEl = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
          if (iframeEl) iframeEl.style.opacity = '0';
          this.store.set(suppressSelectionOverlayAtom, true);

          // Breadcrumb so a future "back" wires up; mirrors enterComponentFile.
          this.opts.setBreadcrumb(prev => [...prev, activeFile]);
          this.opts.setActiveFilePath(tpl.clientPath);
          // The RAW atom setter above bypasses switchActiveFile — so ITS
          // cache wipe never ran here, and the parent's rect/computed/corners
          // caches kept the PAGE's entries under the template's colliding ids
          // ('root'/'tablet-root'/'mobile-root'). Tablet/desktop healed by
          // fresh onscreen measures overwriting theirs; an OFFSCREEN replica
          // never re-measured, so the page's ~14,000px 'mobile-root' rect kept
          // driving the fit + selection overlay no matter how many
          // sandbox-side caches were cleared (user reports 2026-07-27, thrice
          // — the parent cache was the last holder of the stale rect).
          clearBridgeReadCaches();
          this.store.set(selectedIdsAtom, ['root']);
          // Surface the template's node tree: switch the left panel to Layers
          // (it was on Pages) so the user is focused on editing the template,
          // with the template root already selected in the tree.
          this.store.set(leftPanelAtom, 'layers');
          this.opts.setUpdatingFromCanvas(false);
          // Enter on the TEMPLATE viewport whose band the clicked tile paints
          // (width-bucketed above) — not the same-NAMED viewport.
          this.opts.setInteractingViewport(tplVpId);

          // Reveal the iframe + overlay only ONCE, after the camera lands.
          const prevOnRenderComplete = this.opts.bridge.onRenderComplete;
          let revealed = false;
          const reveal = () => {
            if (revealed) return;
            revealed = true;
            if (iframeEl) iframeEl.style.opacity = '1';
            this.store.set(suppressSelectionOverlayAtom, false);
          };
          // Safety net — never leave the iframe invisible if the render signal
          // doesn't arrive.
          const safety = setTimeout(() => {
            this.opts.bridge.onRenderComplete = prevOnRenderComplete;
            reveal();
          }, 1000);
          // One-shot onRenderComplete (fires after the template's viewports
          // paint): ZOOM TO FIT just the clicked viewport's template root (Fit
          // Selection, NOT fit-all), then reveal ONE frame later so the iframe
          // reappears already at the final transform — the user never sees the
          // zoom adjust (double-rAF, same as enterComponentFile).
          this.opts.bridge.onRenderComplete = () => {
            this.opts.bridge.onRenderComplete = prevOnRenderComplete;
            clearTimeout(safety);
            prevOnRenderComplete?.();
            requestAnimationFrame(async () => {
              const content = getContentRoot();
              if (content) {
                // `getNodeBounds` scopes a BARE 'root' to the interacting
                // viewport (set to `layoutVpId` above), so this fits only the
                // clicked viewport's template root.
                //
                // LIVE DOM read, not the rect cache: the file switch clears
                // every parent/sandbox cache (node ids collide across files —
                // the cache once held the merged PAGE's ~14,000px mobile root
                // here), and a replica can be OFFSCREEN at the pre-zoom
                // camera, so the post-render measure may not have covered it
                // yet. The old cache check then fell back to fit-ALL and left
                // the selection overlay with no rect at all (a degenerate
                // screen-tall band; user report 2026-07-27). getRectAsync asks
                // the iframe directly; the seed makes the overlay + fit see
                // the fresh rect immediately.
                const prefix = getViewportPrefix(tplVpId);
                let liveRoot: DOMRect | null = null;
                try {
                  liveRoot = (await this.opts.bridge.getRectAsync?.('root', prefix)) ?? null;
                } catch { /* bridge torn down mid-switch — fall through */ }
                trace.action('canvas:template-entry-fit', {
                  vpId: tplVpId, prefix,
                  liveRoot: liveRoot ? { w: Math.round(liveRoot.width), h: Math.round(liveRoot.height) } : null,
                  branch: liveRoot && liveRoot.width > 0 && liveRoot.height > 0 ? 'fit-selection' : 'fit-all',
                });
                if (liveRoot && liveRoot.width > 0 && liveRoot.height > 0) {
                  this.opts.bridge.seedRectFromScreen?.('root', prefix, liveRoot);
                  zoomToFitSelection(content, ['root'], true);
                } else {
                  zoomToFit(content, true);
                }
              }
              requestAnimationFrame(reveal);
            });
          };
          trace.action('canvas:dblclick-enter-template', {
            from: activeFile, template: tplName, vpId: tplVpId, pageVpId: layoutVpId,
          });
          return;
        }
      }
      // Single click → select viewport. Remember this click so the
      // NEXT click within the threshold can fire the dblclick branch above.
      if (isLeftButtonL && noModL) this.lastClick = { nodeId, vpId: layoutVpId, time: nowL, x: e.clientX, y: e.clientY };
      this.store.set(selectedIdsAtom, ['root']);
      if (layoutVpId) this.opts.setInteractingViewport(layoutVpId);
      return;
    }
    if (nodeId === 'children-slot') return;
    // Viewport roots (parentId: null) are not draggable on pages — their position
    // is managed by viewport system. On component files, variant roots ARE selectable/draggable.
    // Canvas nodes (isCanvasNode: true) are always selectable/draggable.
    const mdNode = this.store.get(nodesAtom).get(nodeId);
    if (mdNode && !mdNode.parentId && !mdNode.isCanvasNode && !isComponentFilePath(getActiveFilePath())) return;

    // In shape edit mode, block all canvas interaction (no drag, no selection change)
    // EXCEPT: clicking on a node OUTSIDE the edited shape's hierarchy should
    // exit shape edit + proceed with the new selection.
    const editingShapeId = this.store.get(shapeEditingIdAtom);
    if (editingShapeId) {
      let walker: string | null | undefined = nodeId;
      let isInside = false;
      const nodesMap = this.store.get(nodesAtom);
      while (walker) {
        if (walker === editingShapeId) { isInside = true; break; }
        walker = nodesMap.get(walker)?.parentId;
      }
      if (isInside) return; // click within the edited shape — keep editing
      // Click is OUTSIDE the edited shape — exit shape edit, then proceed
      // so the new node gets selected as if shape edit hadn't been active.
      this.opts.setShapeEditingId(null);
      this.opts.setSelectedPoint(null);
      // fall through to the normal selection path below
    }

    // The RAW deep hit (the actual clicked element) BEFORE the group-edit
    // isolation reduces it to the immediate child of the current group. The
    // recursive double-click drill-down needs this to know WHICH descendant
    // was clicked when descending into a deeper nested group — otherwise
    // `nodeId` is already the group and the selection falls back to ALL its
    // children ("selects both" instead of the one shape).
    const rawDeepHit = nodeId;

    // Group-edit (Figma-style isolation) — when set, redirect-to-parent-svg
    // is suppressed for clicks INSIDE the group so the user can pick
    // individual children. Clicks OUTSIDE the group exit isolation and
    // proceed normally.
    const groupEditId = this.store.get(groupEditingIdAtom);
    if (groupEditId) {
      const isolated = getIsolatedChildOfGroup(nodeId, groupEditId, this.store.get(nodesAtom));
      if (isolated && isolated !== groupEditId) {
        // Click landed on a CHILD inside the isolated group → pick that child,
        // stay in isolation.
        nodeId = isolated;
        trace.action('canvas:group-edit-isolated', { groupEditId, isolated });
      } else {
        // Click on the group ITSELF (isolated === groupEditId) or OUTSIDE it
        // (isolated === null) → EXIT isolation. Re-selecting the group as a
        // unit pops back out of child-edit, so its children require a fresh
        // double-click to become directly selectable again. (Previously the
        // group-itself case stayed isolated, so children kept being
        // single-click selectable after re-selecting the group.)
        this.opts.setGroupEditingId(null);
        if (isolated === groupEditId) nodeId = groupEditId;
        trace.action('canvas:group-edit-exit', { groupEditId, clickedId: nodeId, hitGroupItself: isolated === groupEditId });
      }
    }

    // Space held → pan canvas, never drag/select elements
    if (isSpaceBarDown()) {
      handleSpacePanDown(e);
      this.opts.setPanCursor(true);
      return;
    }

    const currentToolMode = this.store.get(toolModeAtom);
    if (currentToolMode === 'frame') {
      startFrameCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
      return;
    }
    if (currentToolMode === 'text') {
      startTextCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
      return;
    }
    if (isShapeMode(currentToolMode)) {
      startShapeCreation(e as PointerEvent, currentToolMode as ShapeMode, this.opts.frameCreatorCallbacksRef.current!());
      return;
    }
    if (currentToolMode === 'sketch') {
      startSketchCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
      return;
    }
    if (isLayoutMode(currentToolMode)) {
      startLayoutCreation(e as PointerEvent, currentToolMode as LayoutMode, this.opts.frameCreatorCallbacksRef.current!());
      return;
    }
    // Hand tool — pan instead of selecting/dragging nodes
    if (currentToolMode === 'hand') {
      handleHandToolDown(e);
      this.opts.setPanCursor(true);
      return;
    }

    // Prefer caller-supplied viewport (from the hit test) — `setInteractingViewport`
    // is React state and the ref doesn't update synchronously, so reading from
    // `interactingVpIdRef.current` here would return the previous interaction's
    // viewport (typically 'desktop').
    // On a component master, selecting a node makes the CLICKED variant tile
    // the interacting viewport. Every variant shares the same root data-id,
    // so Fit Selection (getNodeBounds) scopes by the interacting viewport to
    // pick that one tile instead of unioning the whole variant grid. Without
    // this, clicking variant-2/3 left interacting on the primary and Shift+2
    // zoomed to fit everything. Scoped to component files so page-replica
    // click semantics (style writes default to primary) are unchanged.
    //
    // The mousedown dispatch (Renderer → iframe bridge) carries only the bare
    // node id — which variant tile was clicked is lost — so when no override
    // is supplied we re-derive it from a hit test at the cursor, exactly like
    // the hover path. Mirrors the layout-node branch above (line ~415).
    let resolvedVpId = vpIdOverride;
    if (!resolvedVpId) {
      const mdHits = getNodeHitsAtPoint(e.clientX, e.clientY);
      if (mdHits.length > 0) resolvedVpId = vpIdFromPrefix(mdHits[0].vpPrefix);
    }
    const vpId = resolvedVpId ?? this.store.get(interactingViewportIdAtom);

    // Clicking a node makes the CLICKED tile the interacting viewport — for BOTH
    // component variants AND page replicas (design-tool parity: you edit on the tile
    // you click). Previously page-replica clicks left this on primary, so a
    // responsive style override OR a scoped animation added "on the tablet
    // replica" silently applied to ALL viewports. With this, the replica's tile
    // is the editing context, so per-breakpoint scoping resolves correctly.
    if (resolvedVpId && resolvedVpId !== this.store.get(interactingViewportIdAtom)) {
      this.opts.setInteractingViewport(resolvedVpId);
    }

    // Ghost click → redirect to collection template (strip __N suffix).
    // Also capture the ghost index into mapItemIndex so the selection box
    // and properties panel target the clicked ghost, not item 0.
    const ghostIndexFromHit = getGhostIndex(nodeId);
    const ghostSuffix = ghostIndexFromHit !== null ? `__${ghostIndexFromHit}` : '';
    const ghostRedirect = redirectToCollectionTemplate(nodeId);
    if (ghostRedirect) nodeId = ghostRedirect;
    if (ghostIndexFromHit !== null) {
      this.opts.setMapItemIndex(ghostIndexFromHit);
      this.ghostClickHandled = true;
      trace.action('canvas:ghost-selected-from-hit', { ghostIndex: ghostIndexFromHit, nodeId });
    }

    // SVG without data-id: auto-inject data-id on first click so it becomes a real node
    const clickTarget = e.target as HTMLElement;
    const clickedSvg = clickTarget.closest('svg') || (clickTarget.tagName.toLowerCase() === 'svg' ? clickTarget : null);
    const svgDataId = clickedSvg?.getAttribute('data-id') || '';
    const isAutoId = svgDataId.startsWith('auto_');
    // Only inject if the SVG's node doesn't exist in the parsed node map (auto-generated)
    const svgNodeExists = svgDataId && this.store.get(nodesAtom).has(svgDataId) && !svgDataId.startsWith('auto_');
    if (clickedSvg && isAutoId && !svgNodeExists) {
      const parentWithRealId = clickedSvg.parentElement?.closest('[data-id]:not([data-id^="auto_"])');
      const parentDataId = parentWithRealId?.getAttribute('data-id');
      if (parentDataId && parentWithRealId) {
        const allSvgs = Array.from(parentWithRealId.querySelectorAll('svg[data-id^="auto_"], svg:not([data-id])'));
        const svgIndex = allSvgs.indexOf(clickedSvg as Element);
        const newId = `shape-${Math.random().toString(36).slice(2, 10)}`;
        trace.action('canvas:svg-inject-data-id', { parentId: parentDataId, svgIndex, newId });
        queueMutation({ type: 'injectSvgDataId', parentId: parentDataId, svgIndex: Math.max(0, svgIndex), newId, newName: 'Shape' });
        setTimeout(() => this.store.set(selectedIdsAtom, [newId]), 100);
        this.lastClick = null;
        return;
      }
    }

    // Double-click detection (>50ms gap to avoid same-frame false triggers).
    // ONLY tracks plain left-button presses (e.button === 0 AND no modifier keys).
    const now = Date.now();
    const last = this.lastClick;
    const timeDiff = last ? now - last.time : Infinity;
    const distFromLast = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : Infinity;
    const isLeftButton = e.button === 0;
    const noMod = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    // Same-viewport check: every viewport renders a replica of every node
    // with the same nodeId, so a click on desktop-Hero followed by a click
    // on tablet-Hero would otherwise satisfy `last.nodeId === nodeId` and
    // mistakenly trigger enter-master / shape-edit / text-edit.
    if (isLeftButton && noMod && last && last.nodeId === nodeId && last.vpId === vpId && timeDiff > 50 && timeDiff < DOUBLE_CLICK_THRESHOLD && distFromLast <= DOUBLE_CLICK_MAX_DIST) {
      // Figma-style drill-in PRECEDENCE: when directSelectionEnabled is OFF
      // and the user hasn't drilled down to this exact deep hit yet, the
      // double-click means "go one level deeper" — NOT specialized handlers.
      const directSelDbl = this.store.get(directSelectionEnabledAtom);
      if (!directSelDbl) {
        const currentSelectedIds = this.store.get(selectedIdsAtom);
        const currentSelectedId = currentSelectedIds[0];
        const currentSelNode = currentSelectedId ? this.store.get(nodesAtom).get(currentSelectedId) : null;
        if (
          currentSelectedId &&
          currentSelectedId !== nodeId &&
          currentSelNode &&
          (currentSelNode.children?.length ?? 0) > 0
        ) {
          this.store.set(activeContainerIdAtom, currentSelectedId);
          const innerHit = redirectToTopLevelChild(nodeId, currentSelectedId, this.store.get(nodesAtom));
          this.store.set(selectedIdsAtom, [innerHit]);
          trace.action('canvas:direct-selection-drill-in', {
            container: currentSelectedId, selected: innerHit, deepHit: nodeId,
          });
          this.lastClick = null;
          return;
        }
      }

      // SVG shape edit / group edit: double-click an SVG either enters
      // shape edit (single-shape SVGs) or group-edit isolation (composite SVGs).
      const dblGroupEditId = this.store.get(groupEditingIdAtom);
      const redirectedId = redirectToComponentInstance(nodeId, this.store.get(nodesAtom), dblGroupEditId);
      const redirectedNode2 = this.store.get(nodesAtom).get(redirectedId);
      // Sketch wrappers (data-sketch="true") are ONE-SHOT — there is no edit
      // mode anymore. Double-click does nothing special; return early so it does
      // NOT fall through to SVG group-edit isolation below. The sketch stays a
      // plain selected node (brush is tweakable via the right-panel SketchTool).
      const isSketchWrapper = redirectedNode2
        && redirectedNode2.type === 'svg'
        && (redirectedNode2.attrs?.['data-sketch'] === 'true' || redirectedNode2.name === 'Sketch');
      if (isSketchWrapper) {
        trace.action('canvas:sketch-dblclick-noop', { nodeId: redirectedId });
        this.lastClick = null;
        return;
      }
      if (redirectedNode2 && redirectedNode2.type === 'svg') {
        // Group SVG (has SVG children) → enter group-edit isolation. RECURSIVE:
        // drill in whenever the resolved target is a group that ISN'T already
        // the isolated one — so double-clicking a nested group while already
        // inside its parent goes one level DEEPER (infinitely), instead of
        // falling through to shape-edit on a group (which deselects/“disappears”).
        // `redirectToComponentInstance` resolves a deep hit to the immediate
        // child group of the current isolation, so each double-click descends
        // exactly one level.
        const hasSvgChildren = redirectedId !== dblGroupEditId
          && (redirectedNode2.children ?? []).some((cid: string) => {
            const c = this.store.get(nodesAtom).get(cid);
            return c?.type === 'svg';
          });
        if (hasSvgChildren) {
          const groupChildren = redirectedNode2.children ?? [];
          // Pick the EXACT child of the group we're drilling into from the RAW
          // deep hit — `nodeId` was reduced to the isolated child (often this
          // group) by the group-edit climb, so using it would select ALL
          // children. The raw hit resolves to the specific descendant clicked.
          let selectionAfter: string[];
          const deepChild = getIsolatedChildOfGroup(rawDeepHit, redirectedId, this.store.get(nodesAtom));
          if (deepChild && deepChild !== redirectedId) {
            selectionAfter = [deepChild];
          } else if (rawDeepHit !== redirectedId && groupChildren.includes(rawDeepHit)) {
            selectionAfter = [rawDeepHit];
          } else if (nodeId !== redirectedId && groupChildren.includes(nodeId)) {
            selectionAfter = [nodeId];
          } else {
            selectionAfter = groupChildren;
          }
          trace.action('canvas:group-edit-enter', {
            nodeId: redirectedId, hitId: nodeId, selectionAfter,
          });
          this.opts.setGroupEditingId(redirectedId);
          this.store.set(selectedIdsAtom, selectionAfter);
          this.lastClick = null;
          return;
        }
        trace.action('canvas:shape-edit-enter', { nodeId: redirectedId, source: 'imperative-dblclick' });
        this.opts.setShapeEditingId(redirectedId);
        this.opts.setSelectedPoint(null);
        this.lastClick = null;
        return;
      }

      // CDN-linked component: double-click guides the user to the Component
      // tool in the properties panel (scroll + flash) — the SAME affordance a
      // local code-component instance gets via `revealComponentTool` further
      // down. Configuring the instance is what double-click is for.
      //
      // It deliberately does NOT open the Linked Component modal any more.
      // That modal is the UNLINK surface, it already has an explicit entry
      // point (the tool's "Edit Code" button → `handleEditComponent`), and on
      // a CLOSED-SOURCE component the only thing it can say is "this can't be
      // unlinked" — so double-click was firing a dead-end dialog on exactly
      // the components whose props panel the user was trying to reach.
      if (redirectedNode2?.componentFile && redirectedNode2.componentFile.startsWith('http')) {
        this.lastClick = null;
        trace.action('canvas:dblclick-cdn-component', {
          nodeId, cdnUrl: redirectedNode2.componentFile, action: 'reveal-component-tool',
        });
        this.store.set(componentToolRevealAtom, (n) => n + 1);
        return;
      }

      // Component instance: double-click enters the master file.
      if (redirectedNode2?.componentFile && isMasterFilePath(redirectedNode2.componentFile)) {
        // Resolve `initialVariant` against the CURRENT parent variant
        // when the instance carries a per-parent-variant ternary (e.g.
        // `<RoHuVu initialVariant={variant === 'variant-1' ? 'variant-1'
        // : ''} />`). The parser stores ternaries on `attrConditional`
        // and uses the DEFAULT branch as the fallback `attrs.initialVariant`
        // (empty string for the user's case), which would zoom into the
        // wrong variant (or none at all). Using the interacting viewport
        // / variant matches what the user sees on the parent canvas
        // tile — dbl-clicking the nested instance on the parent's
        // variant-1 tile lands inside the master at its variant-1.
        // Which viewport TILE did the user actually double-click? The
        // mousedown that preceded this dbl-click does NOT update
        // interactingViewportId on pages (that's scoped to component files),
        // so reading the atom would give a stale 'desktop' and always land on
        // the primary. Derive the clicked viewport fresh from a hit test.
        const dblHits = getNodeHitsAtPoint(e.clientX, e.clientY);
        const clickedVpId = dblHits.length > 0
          ? vpIdFromPrefix(dblHits[0].vpPrefix)
          : this.store.get(interactingViewportIdAtom);

        // PAGE instance: the variant shown in a viewport comes from the
        // instance's responsiveVariantMap, keyed by viewport WIDTH (e.g.
        // 768 → 'variant-1'). This lands the user on the SAME variant the
        // clicked replica was displaying instead of the primary.
        const clickedWidth = clickedVpId ? getViewportWidths()[clickedVpId] : undefined;
        // The variant a viewport displays comes from responsiveVariantMap
        // (width → variant). The redirect target is the INSTANCE WRAPPER node,
        // which carries the raw `data-responsive` attr but NOT a populated
        // responsiveVariantMap (that map is only stamped on the EXPANDED child
        // nodes, never on the wrapper — see project-parser expandComponent).
        // So parse the attr directly when the map is absent. Shape:
        // {"768":{"initialVariant":"variant-1"},"375":{...},"_bp":[...]}.
        let respMap: Record<number, string> | null = redirectedNode2.responsiveVariantMap ?? null;
        if (!respMap) {
          const respAttr = redirectedNode2.attrs?.['data-responsive'] as string | undefined;
          if (respAttr) {
            try {
              const parsed = JSON.parse(respAttr) as Record<string, any>;
              respMap = {};
              for (const [k, v] of Object.entries(parsed)) {
                if (k === '_bp') continue;
                const w = parseInt(k, 10);
                if (!isNaN(w) && v && typeof v === 'object' && v.initialVariant) respMap[w] = v.initialVariant;
              }
            } catch { /* malformed attr — leave respMap null, falls through */ }
          }
        }
        const fromResponsive = (clickedVpId && clickedVpId !== 'desktop' && clickedWidth != null)
          ? respMap?.[clickedWidth]
          : undefined;

        // NESTED instance inside a master: variant comes from a
        // per-parent-variant ternary on attrConditional, keyed by the parent
        // master variant (the clicked tile's id, e.g. 'variant-1'). Page
        // viewport widths aren't in the variant keyspace, so fromResponsive is
        // undefined there and we fall through to this.
        const parentVariantKey = clickedVpId === 'desktop' || !clickedVpId ? 'default' : clickedVpId;
        const conditionalMap = (redirectedNode2 as any).attrConditional?.initialVariant as Record<string, string> | undefined;
        const resolvedFromConditional = conditionalMap
          ? (conditionalMap[parentVariantKey] ?? conditionalMap.default)
          : undefined;
        const rawInstanceVariant = fromResponsive
          ?? resolvedFromConditional
          ?? (redirectedNode2.attrs?.initialVariant as string | undefined)
          ?? '';
        // Normalise: empty string / unrecognised → default. Without
        // this, dbl-click would pass `initialVariant: ''` which
        // `enterComponentFile` couldn't resolve to a viewport.
        const instanceVariant = rawInstanceVariant || 'default';
        trace.action('canvas:dblclick-resolve-variant', {
          clickedVpId, clickedWidth, respMap, fromResponsive,
          resolvedFromConditional, instanceVariant,
        });
        const cf = redirectedNode2.componentFile;
        const isContainerSet = cf.startsWith('icons/');
        const focusNodeId = isContainerSet
          ? (redirectedNode2.attrs?.name as string | undefined)
          : undefined;
        const focusVariantName = !isContainerSet ? instanceVariant : undefined;
        this.lastClick = null;
        // Use getActiveFilePath() (imperative) not closure-captured activeFilePath —
        // the useCallback deps list doesn't include activeFilePath so it can go stale.
        const currentActiveFilePath = getActiveFilePath();
        enterComponentFile(
          {
            fromFilePath: currentActiveFilePath,
            componentFilePath: redirectedNode2.componentFile,
            initialVariant: instanceVariant,
            focusNodeId,
            focusVariantName,
          },
          {
            setActiveFile: this.opts.setActiveFilePath,
            setBreadcrumb: this.opts.setBreadcrumb,
            setSelectedIds: (ids: string[]) => this.store.set(selectedIdsAtom, ids),
            setUpdatingFromCanvas: this.opts.setUpdatingFromCanvas,
            setInteractingViewport: this.opts.setInteractingViewport,
            getNodes: () => this.store.get(nodesAtom),
            openCodeEditor: (file: string) => this.store.set(componentEditorFileAtom, file),
            // Double-click on a code-component instance: guide the user to the
            // Component tool in the properties panel (scroll + flash) instead
            // of dropping them into the full code overlay.
            revealComponentTool: () => this.store.set(componentToolRevealAtom, (n) => n + 1),
            setSuppressSelectionOverlay: (v: boolean) => this.store.set(suppressSelectionOverlayAtom, v),
          },
        );
        return;
      }

      // CMS-bound text → open CMS overlay focused on that field.
      const cmsNode = this.store.get(nodesAtom).get(nodeId);
      const cmsBoundField = cmsNode?.binding?.property === 'text' ? cmsNode.binding.field : null;
      if (cmsBoundField) {
        let cursor: typeof cmsNode | undefined = cmsNode;
        let cmsSlug: string | null = null;
        while (cursor) {
          if (cursor.collectionList && !cursor.collectionList.source.startsWith('__inline:')) {
            cmsSlug = cursor.collectionList.source;
            break;
          }
          cursor = cursor.parentId ? this.store.get(nodesAtom).get(cursor.parentId) : undefined;
        }
        if (cmsSlug) {
          const rowIdx = this.store.get(mapItemIndexAtom) ?? 0;
          const items = this.opts.getCmsData().get(cmsSlug) ?? [];
          const targetItem = items[rowIdx];
          if (targetItem) {
            trace.action('canvas:dblclick-cms-bound', {
              nodeId, slug: cmsSlug, itemId: targetItem._id, field: cmsBoundField,
            });
            this.opts.openCmsEditor({
              collection: cmsSlug, itemId: targetItem._id, fieldId: cmsBoundField,
            });
            this.lastClick = null;
            return;
          }
        }
      }

      // Component-variable-bound text → open the Variable modal on that variable
      // instead of entering text-edit (design-tool parity). A text node whose content is
      // driven by a component variable (`node.textVariable`, set from a live `{prop}`
      // binding OR a `data-var-orphan` stash on a canvas node) isn't directly
      // editable — its text IS the variable's default. Double-click jumps to the
      // variable so you edit the source, exactly like the purple Content pill.
      const varNode = this.store.get(nodesAtom).get(nodeId);
      if (varNode?.textVariable) {
        trace.action('canvas:dblclick-text-variable', { nodeId, variableRef: varNode.textVariable });
        this.store.set(variableModalRequestAtom, {
          property: 'textContent',
          propertyLabel: 'Content',
          currentValue: varNode.textContent ?? '',
          variableRef: varNode.textVariable,
          nameEditable: true,
        });
        this.lastClick = null;
        return;
      }

      // Empty-frame quick text: double-click an empty frame that isn't
      // already a flex/grid container → apply centered column layout, drop
      // a text node inside, immediately enter TipTap edit mode.
      //
      // NOT IN TRANSLATION MODE. On a non-default locale the editor is a
      // translation surface: every text commit routes to `messages/{locale}`
      // and the JSX is meant to stay untouched. This gesture does the
      // opposite — it writes a layout onto the frame, creates a NODE, and
      // opens TipTap on it, all structural edits that belong to the source
      // language. Doing that while translating produced a node whose default
      // text only exists in the locale you happened to be in (user report
      // 2026-08-09). Double-click falls through to plain selection instead.
      const emptyFrameNode = this.store.get(isDefaultLocaleAtom)
        ? this.store.get(nodesAtom).get(nodeId)
        : null;
      if (
        emptyFrameNode &&
        isFrameTag(emptyFrameNode.type) &&
        emptyFrameNode.children.length === 0 &&
        !emptyFrameNode.textContent &&
        !emptyFrameNode.hasMixedContent
      ) {
        const display = emptyFrameNode.styles.display || '';
        const hasLayout = display === 'flex' || display === 'inline-flex'
          || display === 'grid' || display === 'inline-grid';
        if (!hasLayout) {
          trace.action('canvas:empty-frame-dblclick', { nodeId, vpId });
          // Apply centered column flex layout to the frame. Routing:
          //
          //   PRIMARY (page or component default variant): write to
          //   INLINE — that's the master/base styling.
          //
          //   SOLO REPLICA (any file kind): `data-replica-solo`
          //   present → redirect non-display edits to INLINE BASE,
          //   same contract as the rest of the solo-replica system. On
          //   a component master we ALSO write `display` for the
          //   current variant so the variant's existing `'unset'` (set
          //   at solo entry) doesn't shadow the new inline `'flex'`
          //   and collapse the layout to `block`. On a page replica
          //   the @container display:'unset' already exists for the
          //   solo vp and inherits inline correctly — no extra write.
          //
          //   NON-PRIMARY VARIANT of a component master (NOT solo):
          //   write to the variant override only. Touching inline
          //   here would leak `display: 'flex'` into every other
          //   variant that doesn't define `display` (bug: "double-
          //   click a child in variant-2 unhides the parent on primary
          //   and variant-3"). Inline `display: 'none'` baseline must
          //   stay so the element remains hidden on every variant
          //   that hasn't been explicitly authored.
          const layoutStyles = {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          };
          const isOnComponentMaster = isComponentFilePath(getActiveFilePath());
          const onNonPrimary = !isPrimaryViewport(vpId);
          const frameNode = getNodeFromCache(nodeId) ?? this.store.get(nodesAtom).get(nodeId);
          const soloVpId = frameNode?.attrs?.['data-replica-solo'];
          const isSolo = !!soloVpId && onNonPrimary;
          if (isSolo) {
            // Solo-replica redirect on a component master — write the
            // FULL layout (display + flex props) to inline so the
            // master ALWAYS renders with the layout once unhidden on
            // any variant. Mirror to variants.default for completeness.
            //
            // Why writing inline `display: 'flex'` is safe here even
            // though it looked like a leak before: framer-motion's
            // missing-property fallback goes to the `initial` variant
            // (= `default` here), NOT to inline. So a variant with no
            // entry (e.g. `variant-2`) reads `display` from
            // `variants.default` which carries the solo-hide
            // `display: 'none'`. Inline `display: 'flex'` only ever
            // shows when a variant ALSO removes its display override.
            // That's exactly the "unhide on primary / variant-N" flow
            // the user wants: clear the override → inline `flex`
            // kicks in → layout renders with the props the user just
            // authored.
            //
            // The previous "inline keeps display: 'none'" rule meant
            // that unhiding on primary cleared `variants.default
            // .display` but inline `'none'` still won — element
            // stayed hidden, layout never appeared. This is the bug
            // the user reported.
            //
            //   INLINE: full layout (display: 'flex' + flex props)
            //     — master/default-state appearance.
            //   variants.default: full layout — kept hidden via the
            //     EXISTING `display: 'none'` (we don't overwrite it
            //     here; the solo-entry already set it). Future
            //     unhide just removes `default.display` and the
            //     inline `flex` carries the rendering.
            //   variants[activeVariant]: `display: 'flex'` so this
            //     variant's solo `'unset'` is replaced with the real
            //     layout display.
            //
            // For page replicas there's no variants object — the
            // solo-replica @container already inherits inline, so
            // writing the full layout to inline is fine. Fall through
            // to the plain inline-only write.
            if (isOnComponentMaster) {
              const { display: _displayLayout, ...nonDisplayLayout } = layoutStyles;
              // SOLO CONTRACT (user-confirmed: "Keep hidden, layout
              // props ready"). Layout exists everywhere in CODE but
              // visibility stays per-solo:
              //
              //   INLINE: flex props only, NO `display`. Inline
              //     keeps its `display: 'none'` baseline so other
              //     variants don't visibly leak. The flex props are
              //     ready to apply the moment any variant has its
              //     `display` set to `'flex'`.
              //   variants.default: same flex props, NO `display`
              //     change (keeps the `'none'` from solo entry → still
              //     hidden on primary, layout ready for future unhide).
              //   variants[activeVariant]: `display: 'flex'` so this
              //     variant renders with the layout immediately.
              //   variants[other variants in variantConfig]: explicit
              //     `display: 'none'` to lock visibility (framer-motion
              //     "latest known value" rule would otherwise carry
              //     `flex` over from a visit to the active variant).
              queueMutation({ type: 'updateStyles', nodeId, styles: nonDisplayLayout });
              queueMutation({
                type: 'updateVariantStyle',
                nodeId,
                variantName: 'default',
                styles: nonDisplayLayout,
              });
              queueMutation({
                type: 'updateVariantStyle',
                nodeId,
                variantName: vpId,
                styles: { display: 'flex' },
              });
              // Solo visibility via the AnimatePresence + conditional
              // render pattern — replaces the old "write display:'none'
              // to every other variant" pattern. The single mutation
              // wraps the JSX in `<AnimatePresence mode="popLayout">`
              // around `{variant === 'X' && <Child/>}`, so siblings can
              // smoothly FLIP into the gap when the variant transition
              // unmounts this element.
              try {
                const code = projectFS.readFile(getActiveFilePath()) ?? '';
                const variantNames = parseVariantConfig(code).map(v => v.name);
                const hiddenVariants = variantNames.filter(v => v !== vpId);
                queueMutation({
                  type: 'setVariantVisibility',
                  nodeId,
                  hiddenVariants,
                  allVariants: variantNames,
                });
              } catch (e) {
                trace.error('canvas:empty-frame-dblclick-variant-enum-failed', { error: String(e) });
              }
            } else {
              queueMutation({ type: 'updateStyles', nodeId, styles: layoutStyles });
            }
          } else if (isOnComponentMaster && onNonPrimary) {
            queueMutation({
              type: 'updateVariantStyle',
              nodeId,
              variantName: vpId,
              styles: layoutStyles,
            });
          } else {
            queueMutation({ type: 'updateStyles', nodeId, styles: layoutStyles });
          }
          // Step 2: create a text child.
          const textId = generateNodeId('text');
          this.opts.textEditControllerRef.current?.setEmptyFrameScaffold({ frameId: nodeId, textId });
          const textStyles = getDefaultTextNodeStyles('frame-fill');
          const contentEl = this.opts.contentRef.current;
          if (contentEl) {
            // On a non-primary REPLICA: the new text must be born "solo
            // on this vp" — hidden on every other vp + marked
            // `data-replica-solo="<vpId>"` so style edits redirect to
            // base. The replica-creation helper handles both the
            // `display: 'unset'` for the active vp's @container AND the
            // solo-marker. To pair correctly, the inline `display: 'none'`
            // baseline must be added to the styles BEFORE createNode so
            // every OTHER vp's render of this text is hidden by default.
            const isReplicaVp = !isPrimaryViewport(vpId);
            const textStylesForVp = isReplicaVp
              ? { ...textStyles, display: 'none' }
              : textStyles;
            const textEl = createNode({
              id: textId,
              type: 'p',
              name: 'Text',
              styles: textStylesForVp,
              textContent: ZERO_WIDTH_SPACE,
              parentEl: contentEl,
              parentId: nodeId,
              onMouseDown: (nid: string, evt: MouseEvent) => this.handleNodeMouseDown(nid, evt),
            });
            if (isReplicaVp) {
              const vpWidth = getViewportWidths()[vpId] ?? 0;
              queueReplicaCreationUnhide(textId, vpId, vpWidth);
            }
            // Step 3: flush so the layout + new node land in JSX, then enter TipTap.
            flushNow();
            this.store.set(selectedIdsAtom, [textId]);
            setTimeout(() => {
              this.opts.startTextEdit(textId, textEl, ZERO_WIDTH_SPACE, vpId);
            }, 50);
          }
          this.lastClick = null;
          return;
        }
      }

      // Text edit: allow for nodes with text, mixed content, or text-type elements.
      //
      // LEAF NODES ONLY (`children.length === 0`): a frame with real element
      // children (data-id'd nodes / component instances) must NEVER enter
      // text edit — TipTap mounts over the frame's RENDERED DOM, captures a
      // component instance's internals as plain text, and the exit commit
      // (updateNodeChildrenFromHTML) rewrites the children with it: the
      // instance is destroyed and its variant labels come back as text rows
      // ("double-clicked the white frame and the button disappeared",
      // 2026-08-07 — the gate passed on the frame's WHITESPACE-only JSX text,
      // hence also the trim). Rich-text runs carry no data-id, so genuine
      // text nodes always have zero children and keep working.
      const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'label', 'button']);
      const node = this.store.get(nodesAtom).get(nodeId);
      if (node && node.children.length === 0
          && (node.textContent?.trim() || node.hasMixedContent || TEXT_TYPES.has(node.type))) {
        // For .map() ghosts, mount TipTap on the GHOST'S data-node-id (with __N suffix).
        const editTargetId = nodeId + ghostSuffix;
        trace.action('canvas:text-edit-from-dblclick-iframe', { nodeId: editTargetId, vpId });
        this.opts.startTextEdit(editTargetId, null, '', vpId);
        this.lastClick = null;
        return;
      }

      this.lastClick = null;
    } else if (isLeftButton && noMod) {
      // Only remember PLAIN LEFT clicks for the next-click double-click test.
      this.lastClick = { nodeId, vpId, time: now, x: e.clientX, y: e.clientY };
    }

    // Redirect to component instance root (children → instance boundary).
    const selGroupEditId = this.store.get(groupEditingIdAtom);
    let redirected = redirectToComponentInstance(nodeId, this.store.get(nodesAtom), selGroupEditId);
    // Redirect FIT text children to SVG wrapper (so width controls scaling)
    const fitRedirect = redirectToFitTextWrapper(redirected, this.store.get(nodesAtom));
    if (fitRedirect) redirected = fitRedirect;

    if (e.shiftKey) {
      // Shift+Click: toggle in multi-select.
      const currentIds = this.store.get(selectedIdsAtom);
      if (currentIds.includes(redirected)) {
        const newIds = currentIds.filter(id => id !== redirected);
        trace.action('canvas:shift-click-remove', { nodeId: redirected, newCount: newIds.length });
        this.store.set(selectedIdsAtom, newIds);
      } else {
        const newIds = [redirected, ...currentIds];
        trace.action('canvas:shift-click-add', { nodeId: redirected, newCount: newIds.length });
        this.store.set(selectedIdsAtom, newIds);
      }
      // Also start the drag-pending state so the user can do "shift,
      // then click + drag → drag with axis-lock". Previously the
      // shift+click path early-returned without `startPending`, so
      // holding shift BEFORE the click blocked the drag entirely —
      // the lock only worked when shift was pressed AFTER drag had
      // started. With `startPending` here, the drag fires the moment
      // the user moves the mouse past the threshold, and the
      // `shift`-active modifier flows into each strategy's axis-lock
      // logic. The selection toggle above remains the no-movement
      // path (mouseup without crossing the threshold just toggles).
      this.opts.dragCoordinatorRef.current?.startPending(redirected, e, getViewportPrefix(vpId));
    } else {
      // Multi-select redirect: if the clicked node ISN'T in the current
      // multi-select but one of its ancestors IS, redirect the click to
      // that ancestor. Otherwise clicking a child of a multi-selected
      // node would collapse the selection to that single child, breaking
      // the user's "I'm dragging the group" intent. Mirrors the old
      // builder's behavior. Skipped when ctrl/cmd-bypass is used so the
      // user can still explicitly direct-select a descendant.
      const ctrlBypassMulti = e.ctrlKey || e.metaKey;
      this.pendingMultiSelectChild = null;
      if (!ctrlBypassMulti) {
        const currentSel = this.store.get(selectedIdsAtom);
        if (currentSel.length > 1 && !currentSel.includes(redirected)) {
          const nodesMap = this.store.get(nodesAtom);
          const selSet = new Set(currentSel);
          let walker: string | null | undefined = nodesMap.get(redirected)?.parentId;
          while (walker) {
            if (selSet.has(walker)) {
              trace.action('canvas:multi-select-redirect-to-ancestor', {
                from: redirected, to: walker, selCount: currentSel.length,
              });
              // The DRAG target becomes the ancestor so grabbing a child still
              // moves the whole group. The SELECTION does NOT follow it here —
              // remember the child and commit it on mouseup IF no drag happened.
              // Redirecting both made every descendant of a multi-selection
              // unclickable: pressing one just re-selected the group, so a child
              // could never be picked without dropping the selection first (user
              // report 2026-07-25). Deferring to the no-movement path gives both —
              // click selects the child, click-and-drag moves the group.
              this.pendingMultiSelectChild = redirected;
              redirected = walker;
              break;
            }
            walker = nodesMap.get(walker)?.parentId;
          }
        }
      }

      // Figma-style nested selection: when directSelectionEnabled is OFF,
      // walk UP from the deep hit to the immediate child of the user's "active container".
      const directSelection = this.store.get(directSelectionEnabledAtom);
      const ctrlBypass = e.ctrlKey || e.metaKey;
      if (!directSelection && !ctrlBypass) {
        const activeContainer = this.store.get(activeContainerIdAtom);
        const promoted = redirectToTopLevelChild(redirected, activeContainer, this.store.get(nodesAtom));
        if (activeContainer) {
          const promotedNode = this.store.get(nodesAtom).get(promoted);
          // Click outside the active container's subtree → reset.
          if (promotedNode && promotedNode.parentId === null) {
            this.store.set(activeContainerIdAtom, null);
            trace.action('canvas:direct-selection-pop-container', {
              from: activeContainer, clickedTopLevel: promoted,
            });
          }
        }
        if (promoted !== redirected) {
          trace.action('canvas:direct-selection-redirect', {
            from: redirected, to: promoted, activeContainer,
          });
          redirected = promoted;
        }
      } else if (directSelection && ctrlBypass) {
        // Direct-select UP: Ctrl/Cmd promotes the deepest hit to its PARENT for
        // BOTH selection and drag (the `redirected` id below drives startPending
        // + the selection write), so mousing down on child B with Cmd held grabs
        // + drags the containing frame A.
        const promoted = this.promoteToParent(redirected);
        if (promoted !== redirected) {
          trace.action('canvas:direct-selection-promote-parent', { from: redirected, to: promoted });
          redirected = promoted;
        }
      }

      // Start drag pending BEFORE triggering selection re-renders.
      this.opts.dragCoordinatorRef.current?.startPending(redirected, e, getViewportPrefix(vpId));

      if (!this.store.get(selectedIdsAtom).includes(redirected)) {
        this.store.set(selectedIdsAtom, [redirected]);
      }
      // Always route map item index
      const clickedNode = this.store.get(nodesAtom).get(redirected);
      if (this.ghostClickHandled) {
        // Capture phase already set the correct ghost index — don't override
      } else if (clickedNode?.isCollectionTemplate) {
        this.opts.setMapItemIndex(0);
      } else if (!clickedNode?.isCollectionTemplate) {
        this.opts.setMapItemIndex(null);
      }
    }
  }

  /** Called from the canvas container's onMouseDown React handler */
  /** Exit every Fill "overlay mode" in one shot: clear the gradient + clip-path
   *  atoms (so their canvas overlays vanish THIS frame) and close the floating Fill
   *  ToolPopup (which unmounts the color/gradient/clip-path editors, dropping
   *  `colorPickerOpen` so the suppressed selection chrome is restored). Called when a
   *  real canvas click lands while a Fill picker/overlay is open. Idempotent — atom
   *  nulls are no-ops when already clear (jotai skips same-value sets). */
  private exitFillOverlayModes(): void {
    const hadGradient = this.store.get(activeGradientAtom) != null;
    const hadClipPath = this.store.get(activeClipPathAtom) != null;
    this.store.set(activeGradientAtom, null);
    this.store.set(selectedGradientStopAtom, null);
    this.store.set(gradientUpdateCallbackAtom, null);
    this.store.set(gradientStopUpdateCallbackAtom, null);
    this.store.set(gradientStopSelectCallbackAtom, null);
    this.store.set(gradientCommitCallbackAtom, null);
    this.store.set(isMaskGradientAtom, false);
    this.store.set(activeClipPathAtom, null);
    this.store.set(clipPathUpdateCallbackAtom, null);
    this.store.set(clipPathCommitCallbackAtom, null);
    closeActiveToolPopup();
    trace.action('canvas:exit-fill-overlay-modes', { hadGradient, hadClipPath });
  }

  handleMouseDown(e: MouseEvent): void {
    // A modal/popup is open (its portal carries `[data-modal-root]`) — its clicks must NOT drive
    // canvas interaction (empty-canvas deselect, hit-test, drag). Same gate KeyboardManager uses for
    // shortcuts. Covers any path that reaches this handler while a modal is up.
    if (document.querySelector('[data-modal-root]')) return;
    // Commit a half-typed PANEL input BEFORE the selection changes below. Panel
    // inputs commit on blur, and their handler closes over whatever node is
    // selected at that moment — so clicking from a half-typed Font Size onto
    // another element applied the value to the node just clicked (the selection
    // changed first, then blur fired). Blurring here runs the commit while the
    // ORIGINAL selection is still active. See `commitFocusedPanelInput`.
    commitFocusedPanelInput();
    // Read toolMode from store (not a closed-over ref) so we always get current value.
    const toolMode = this.store.get(toolModeAtom);
    trace.action('canvas:mousedown', { button: e.button, toolMode, target: (e.target as HTMLElement).tagName });
    // Currently editing text? When clicks land inside the iframe, the
    // iframe's own outside-click listener decides whether to commit.
    // The parent only commits when the click was on parent chrome OUTSIDE the iframe.
    if (this.opts.editingNodeIdRef.current) {
      const target = e.target as HTMLElement;
      const clickedIframe = target.tagName === 'IFRAME' || target === this.opts.iframeRef.current;
      if (!clickedIframe) {
        this.opts.commitTextEdit();
      }
      return;
    }

    // Middle mouse pan is handled natively (attachMiddleMousePan) — not here
    if (e.button === 1) return;
    // Space+drag → pan
    if (handleSpacePanDown(e)) { trace.action('canvas:pan-start', { source: 'space' }); this.opts.setPanCursor(true); return; }
    // Hand tool → left-click pan
    if (toolMode === 'hand') {
      if (handleHandToolDown(e)) { this.opts.setPanCursor(true); return; }
    }

    // View-only: viewers CAN select a node (click → selection border +
    // read-only properties panel) but cannot CREATE. The creator-tool
    // block below is skipped; the hit-test + selection below still runs.
    // Drag is blocked downstream in DragCoordinator.startPending, so a
    // viewer click selects without ever starting a drag.
    if (!isViewerMode()) {
      // Creator tools
      if (toolMode === 'frame') {
        startFrameCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
        return;
      }
      if (toolMode === 'text') {
        startTextCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
        return;
      }
      if (isShapeMode(toolMode)) {
        startShapeCreation(e as PointerEvent, toolMode as ShapeMode, this.opts.frameCreatorCallbacksRef.current!());
        return;
      }
      if (toolMode === 'sketch') {
        startSketchCreation(e as PointerEvent, this.opts.frameCreatorCallbacksRef.current!());
        return;
      }
      if (isLayoutMode(toolMode)) {
        startLayoutCreation(e as PointerEvent, toolMode as LayoutMode, this.opts.frameCreatorCallbacksRef.current!());
        return;
      }
    }

    // FILL OVERLAY EXIT — a Fill picker / gradient / clip-path overlay is open, so a
    // click ANYWHERE on the canvas (another node OR empty) must FIRST exit that mode:
    // close the floating Fill ToolPopup + clear the gradient/clip-path atoms, so the
    // selection chrome comes back and the popup doesn't just re-target the node we're
    // about to click. (Gradient/clip-path HANDLE clicks never reach here — the
    // overlay's pointer-events:auto handles consume them.) The hit-test + selection
    // below STILL run, so this same click also selects / deselects what was clicked.
    if (e.button === 0
        && (this.store.get(colorPickerOpenAtom)
          || this.store.get(activeGradientAtom) != null
          || this.store.get(activeClipPathAtom) != null)) {
      this.exitFillOverlayModes();
    }

    // Hit-test through bridge (viewport-aware)
    const hits = getNodeHitsAtPoint(e.clientX, e.clientY);

    // Overlay edit mode — restrict selection to: the edited overlay (+ its
    // children, so you can build its content), its SOURCE/trigger node, and
    // top-level CANVAS nodes. Clicking anything else in the viewport does
    // nothing (stays in overlay mode). A click on truly empty canvas (no hits)
    // falls through to the normal handler, which exits overlay mode.
    const overlayEditId = this.store.get(overlayEditingIdAtom);
    if (overlayEditId && hits.length > 0) {
      const chosen = this.resolveOverlayAllowedHit(hits, overlayEditId);
      if (chosen) {
        suppressSelectionBox();
        const hitVpId = vpIdFromPrefix(chosen.vpPrefix);
        this.opts.setInteractingViewport(hitVpId);
        trace.action('canvas:overlay-mode-select', { nodeId: chosen.id, vpPrefix: chosen.vpPrefix });
        this.handleNodeMouseDown(chosen.id, e, hitVpId);
      } else {
        trace.action('canvas:overlay-mode-select-blocked', { topHit: hits[0]?.id });
      }
      return;
    }

    if (hits.length > 0) {
      // Found a node — suppress SelectionBox (its pointerdown already fired)
      suppressSelectionBox();
      const { id: nodeId, vpPrefix } = hits[0];
      const hitVpId = vpIdFromPrefix(vpPrefix);
      this.opts.setInteractingViewport(hitVpId);
      trace.action('canvas:iframe-hit-test', { nodeId, vpPrefix, hitCount: hits.length });
      this.handleNodeMouseDown(nodeId, e, hitVpId);
    } else {
      // Empty-geometry hit. An SVG only paints its shape, so the empty
      // interior of a SELECTED svg (a group, or a single shape's bbox)
      // misses every hit-test — yet the user sees a selection box there and
      // expects a press to drag it. If a single svg is selected and the
      // press is inside its box, redirect the mousedown to it.
      const selIds = this.store.get(selectedIdsAtom);
      if (selIds.length === 1 && !this.store.get(groupEditingIdAtom)) {
        const selNode = this.store.get(nodesAtom).get(selIds[0]);
        if (selNode?.type === 'svg') {
          const selVpId = this.store.get(interactingViewportIdAtom);
          // Test against the PAINTED-bbox corners (cornersCache) — the same
          // box the selection overlay draws — not the wrapper's CSS rect.
          // For a group the painted bbox is the live union of its children;
          // the CSS rect can lag behind a refit, so the empty interior would
          // stop hitting after a child is moved.
          const c = getScreenCornersById(selIds[0], selVpId);
          if (c) {
            const minX = Math.min(c.TL.x, c.TR.x, c.BR.x, c.BL.x);
            const maxX = Math.max(c.TL.x, c.TR.x, c.BR.x, c.BL.x);
            const minY = Math.min(c.TL.y, c.TR.y, c.BR.y, c.BL.y);
            const maxY = Math.max(c.TL.y, c.TR.y, c.BR.y, c.BL.y);
            if (e.clientX >= minX && e.clientX <= maxX && e.clientY >= minY && e.clientY <= maxY) {
              trace.action('canvas:svg-empty-interior-drag', { nodeId: selIds[0] });
              this.handleNodeMouseDown(selIds[0], e, selVpId);
              return;
            }
          }
        }
      }

      // Clicked empty canvas — deselect, exit any edit mode (shape / group)
      this.emptyCanvasClick = true;
      const editId = this.store.get(shapeEditingIdAtom);
      this.opts.setShapeEditingId(null);
      this.opts.setSelectedPoint(null);
      this.opts.setOverlayEditingId(null);
      this.opts.setGroupEditingId(null);
    }
  }

  dispose(): void {
    this._removeReplicaListener?.();
    this._removeSetInteractingVpListener?.();
    this._removeGhostDomListener?.();
    this._removeGhostBridgeListener?.();
    this._removeModifierHoverListener?.();
    trace.action('canvas:mouse-controller-disposed', {});
  }
}
