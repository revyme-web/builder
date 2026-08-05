// src/canvas/drag/CanvasDragOrchestrator.ts
//
// Wraps DragCoordinator. Owns the 4-branch commit ladder (variant-root,
// icon-set vector, SVG-group child, regular page node)
// and the auto-pan lifecycle. Canvas.tsx calls startPending/handleMouseMove/
// handleMouseUp/startGripDrag via refs wired here.
//
// DESIGN:
//  - Constructed once per Canvas mount (when containerRef / contentRef are ready).
//  - Receives all React state setters and refs via opts (no atom subscriptions
//    inside the class — this is NOT a hook).
//  - auto-pan: creates the AutoPanController, wires drag-compensation tick and
//    idle-interacting-clear tick, and exposes the controller for marquee/creator
//    tenants via `setActiveAutoPan`.
//  - commitUpdates: verbatim port of Canvas.tsx commitDragUpdates. All
//    `nodesRef.current` → `opts.getNodes()`, `activeFilePath` closures →
//    `opts.getActiveFilePath()`, `jotaiStore.xxx` → `opts.jotaiStore.xxx`.

import type { useStore } from 'jotai';
import { DragCoordinator } from './DragCoordinator';
import {
  attachAutoPan,
  setActiveAutoPan,
  transformManager,
} from '../transform';
import { trace } from '@/shared/debug-trace';
import { pluralize, singularize } from '@/shared/pluralize';
import type { PendingUpdate, SnapGuide, SpacingGuide, NodeMap } from '@/shared/types';
import type { CanvasRenderer } from '../CanvasRenderer';
import { isIconSetFilePath } from '@/code/project/active-file-store';
import { generateNodeId } from '@/shared/id-utils';
import { updateVariantPosition } from '@/code/variants/variant-ops';
import { updateIconPosition, updateIconSize } from '@/code/icons/icon-set-ops';
import { parseIconSetConfig, iconConfigPx } from '@/code/icons/icon-set-config';
import { projectFS } from '@/code/project/project-fs';
import { queueMutation, syncQueueCode, flushNow, setDeferNextFanOut } from '@/code/mutation/mutation-queue';
import { moveNodeInCache, updateNodeInCache, injectNodeIntoCache, getNodeFromCache } from '@/code/stores/store';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { shapeEditCommitPendingAtom } from '@/code/stores/shape-edit-store';
import { collectionSchemasAtom } from '@/code/stores/cms-store';
import { getViewportWidths, viewportsConfigAtom } from '@/code/stores/viewport-store';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import {
  updateNodeStyles,
  commitDragPosition,
  getActiveFilePath,
  forceCanvasRender,
  getSvgGroupAncestorChain,
  getViewportPrefix,
  supersedePendingSvgChildAttrTick,
} from '../node-ops';
import { moveChildAndRefitGroup, refitGroupChain } from '@/code/svg/refit-group';
import { svgChildCarrierOrigin, groupChildrenCarryVariantGeometry } from './replica-context';
import { repositionSignalOps } from './reposition-signal';
import { parentHighlightOps } from '../selection/parent-highlight-store';
import { setViewportHeadersVisible } from '../ViewportHeaderManager';

type JotaiStore = ReturnType<typeof useStore>;

/**
 * Recursively map a toolbar/plugin `NewNodeDescriptor` child tree to the
 * generator's `AddNodeDef` shape for the `add` commit path.
 *
 * Two things happen here:
 *  1. `tag` → `type` — the descriptor uses `tag`, the generator's `buildNodeJSX`
 *     reads `type`; without the rename every child falls back to `<div>`.
 *  2. Mint a fresh unique `id` for any node that lacks one. `id` is MANDATORY:
 *     `buildNodeJSX` writes it verbatim as `data-id`. The Insert panel's toolbar
 *     items pre-generate an id on every descendant, but a PLUGIN-authored layout
 *     tree (`canvas.startLayoutDrag`) typically omits child ids — leaving them
 *     undefined emits `data-id="undefined"` on every node, so the parser /
 *     renderer / bridge key dozens of distinct elements to the same id and the
 *     whole canvas crashes. Prefix the minted id with the tag for readable layers.
 *
 * Exported for tests.
 */
export function descriptorChildrenToDefs(kids: any[] | undefined): any[] | undefined {
  return kids?.map((c: any) => ({
    id: c.id ?? generateNodeId(c.tag || 'node'),
    type: c.tag,
    styles: c.styles,
    attrs: c.attrs,
    name: c.name,
    textContent: c.textContent,
    children: descriptorChildrenToDefs(c.children),
  }));
}

/**
 * A FREE canvas node (dropped on empty canvas, not into a viewport) has NO flow
 * container, so a percentage width/height can't resolve — it collapses to
 * min-content / ~0 (the "drops as a narrow strip" bug for full-width sections).
 * On the canvas only px / auto are meaningful. Resolve the ROOT node's % dims to
 * concrete px against a reference width (the primary viewport), so a
 * `width: '100%'` section lands at full size. Descendants keep their `%` — they
 * resolve fine against this now-px root. Exported for tests.
 */
export function resolveCanvasNodeRootDims(
  styles: Record<string, string>,
  refWidth: number,
): Record<string, string> {
  const out = { ...styles };
  const asPct = (v: string | undefined): number | null =>
    typeof v === 'string' && /^-?[\d.]+%$/.test(v.trim()) ? parseFloat(v) : null;
  const wp = asPct(out.width);
  if (wp != null) out.width = `${Math.max(1, Math.round((wp / 100) * refWidth))}px`;
  // No reference height exists for a free node → a % height becomes content-driven.
  if (asPct(out.height) != null) out.height = 'auto';
  return out;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface CanvasDragOrchestratorOpts {
  jotaiStore: JotaiStore;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  /** Ref-like getter for the vpOverlay element (for setViewportHeadersVisible) */
  getVpOverlay: () => HTMLElement | null;
  /** Snap-guide render callback */
  onSnapGuidesChange: (g: SnapGuide[]) => void;
  /** Spacing-guide render callback */
  onSpacingGuidesChange: (g: SpacingGuide[]) => void;
  /** Drag-state callback (sets isDragging in Canvas state) */
  onDraggingChange: (dragging: boolean) => void;
  /** setCanvasInteracting atom setter */
  onCanvasInteractingChange: (v: boolean) => void;
  /** Live code getter */
  getCode: () => string;
  /** Live nodes getter */
  getNodes: () => NodeMap;
  /** Live selected-IDs getter */
  getSelectedIds: () => string[];
  /** Active file path getter */
  getActiveFilePath: () => string;
  /** Whether the active file is a component file (read at construction time — refreshed via updateDerivedFlags) */
  isComponentFile: boolean;
  /** setSelectedIds React setter — used by toolbar-drag 'add' branch */
  setSelectedIds: (ids: string[]) => void;
  /** Canvas renderer — used for setStructuralPending in reorder/move/remove branches */
  renderer: CanvasRenderer;
  /** interactingVpId getter (for onHighlightParent vpId fallback) */
  getInteractingVpId: () => string;
  /** setCode React state setter — used by toolbar-drag 'add' branch to write import-augmented code into codeAtom */
  setCode: (code: string) => void;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class CanvasDragOrchestrator {
  /** The inner DragCoordinator — kept public so Canvas.tsx can pass it to setToolbarDragCoordinator. */
  coordinator: DragCoordinator;
  /** The auto-pan controller for this mount. */
  private autoPanCtrl: ReturnType<typeof attachAutoPan> | null = null;
  /** Auto-pan tick unsubscribe */
  private unsubDragTick: (() => void) | null = null;
  /** Auto-pan idle unsubscribe */
  private unsubIdleTick: (() => void) | null = null;
  /** Window pointermove listener for auto-pan tracking */
  private autoPanMouseListener: ((e: PointerEvent) => void) | null = null;
  private opts: CanvasDragOrchestratorOpts;
  /** Mutable derived flags — updated via updateDerivedFlags after file switch */
  private isComponentFile: boolean;

  constructor(opts: CanvasDragOrchestratorOpts) {
    this.opts = opts;
    this.isComponentFile = opts.isComponentFile;

    // ─── Build DragCoordinator ─────────────────────────────────────────────
    this.coordinator = new DragCoordinator(
      opts.containerEl,
      opts.contentEl,
      {
        onSnapGuidesChange: opts.onSnapGuidesChange,
        onSpacingGuidesChange: opts.onSpacingGuidesChange,
        onCommit: (updates) => this.commitUpdates(updates),
        onHighlightParent: (parentId, vpId) => {
          if (parentId) {
            parentHighlightOps.show({ parentId, vpId: vpId || opts.getInteractingVpId() });
          } else {
            parentHighlightOps.hide();
          }
        },
        onDragStateChange: (dragging, strategyName) => {
          opts.onDraggingChange(dragging);
          opts.onCanvasInteractingChange(dragging);
          const vpOverlay = opts.getVpOverlay();
          if (vpOverlay) setViewportHeadersVisible(vpOverlay, !dragging);
          // Toggle the auto-pan tenant flag. Toolbar drags (Insert panel +
          // Library panel) START with the cursor over the LEFT sidebar,
          // which is inside the auto-pan left edge zone — auto-pan
          // immediately triggers and the canvas pans on the very first
          // pointermove, before the user has actually moved the cursor
          // toward a viewport. The pan moves the canvas content under
          // the cursor, which corrupts every downstream hit-test
          // (`findDeepestFrameAtPoint`, `getViewportIdAtPoint`) — the
          // strategy then can't find a stable drop target so the line
          // indicator and parent highlight never settle. Skip auto-pan
          // entirely for `toolbar` strategy. Existing-node drags still
          // get the auto-pan tenant flipped on drag-start as before.
          if (strategyName === 'toolbar') {
            this.autoPanCtrl?.setActive('drag', false);
          } else {
            this.autoPanCtrl?.setActive('drag', dragging);
          }
        },
        getCode: opts.getCode,
        getNodes: opts.getNodes,
        getSelectedIds: opts.getSelectedIds,
        getTransform: () => transformManager.getTransform(),
      },
    );

    // ─── Auto-pan loop ─────────────────────────────────────────────────────
    // Shared edge-pan that activates while a drag, marquee, or creator
    // gesture is running. The loop reads the mouse position fed in by
    // pointermove handlers, computes a per-axis pan velocity from the
    // distance to each edge (asymmetric — wider on left/right to account
    // for the editor's side panels), and on each tick:
    //   1. `transformManager.pan(dx, dy)` slides the canvas.
    //   2. Drag coordinator's `compensateAutoPan` re-anchors any in-flight
    //      drag so the dragged element stays under the cursor.
    // Tenant activation: drag uses the `onDragStateChange` callback above.
    // Marquee / creators wire their own `setActive('marquee', …)` etc.
    const ctrl = attachAutoPan(opts.containerEl);
    this.autoPanCtrl = ctrl;
    // Expose globally so creators (frame/text/shape/layout) can register
    // their tick handlers + activation flags without threading the
    // controller through every callback chain.
    setActiveAutoPan(ctrl);

    // Drag compensation — bumps the drag's startMouse + replays onMove
    // so the dragged element stays anchored under the cursor while the
    // canvas slides. Returns an unsubscribe so other tick listeners
    // (creators) can coexist independently.
    this.unsubDragTick = ctrl.onTick((dx, dy) => {
      this.coordinator.compensateAutoPan(dx, dy);
    });

    // Clear the `canvasInteracting` debounce the moment the loop goes
    // idle. transformManager.subscribe (registered elsewhere in Canvas.tsx)
    // sets the flag to TRUE on every pan tick with a 100 ms
    // debounce-back-to-false; without this, a creator that runs
    // flushNow() immediately after an auto-panned mouseup hits the
    // renderer's `interacting` skip and the new node never paints
    // until the next user action. Clearing on idle drains the lingering
    // state synchronously, so the post-flush render lands cleanly.
    this.unsubIdleTick = ctrl.onIdle(() => {
      opts.onCanvasInteractingChange(false);
      trace.action('autopan:idle-cleared-interacting');
    });

    // Window-level pointermove keeps the loop fed even when the cursor
    // briefly leaves a child element (e.g. crosses into a panel during
    // drag). The loop only consumes positions while a tenant is active,
    // so this listener is cheap during idle.
    this.autoPanMouseListener = (e: PointerEvent) => {
      ctrl.trackMouse(e);
    };
    window.addEventListener('pointermove', this.autoPanMouseListener, { passive: true });

    trace.action('drag-orchestrator:created', {
      containerTag: opts.containerEl.tagName,
      isComponentFile: this.isComponentFile,
    });
  }

  // ─── Derived flags update ────────────────────────────────────────────────
  /**
   * Call after a file switch so commitUpdates uses the correct file-type
   * branch (isComponentFile, isIconSetFilePath, etc.). The opts callbacks
   * (`getActiveFilePath`, `getNodes`, etc.) are already live closures;
   * only the derived boolean needs refreshing.
   */
  updateDerivedFlags(isComponentFile: boolean) {
    this.isComponentFile = isComponentFile;
    trace.action('drag-orchestrator:flags-updated', { isComponentFile });
  }

  /**
   * Update coordinator DOM refs when container/content elements change.
   * Mirrors the Canvas.tsx every-render useEffect that called
   * `dragCoordinatorRef.current.updateRefs(...)`.
   */
  updateRefs(containerEl: HTMLElement, contentEl: HTMLElement) {
    this.coordinator.updateRefs(containerEl, contentEl);
    trace.action('drag-orchestrator:refs-updated', {});
  }

  // ─── Public drag API ────────────────────────────────────────────────────

  get isDragging(): boolean { return this.coordinator.isDragging; }
  get isPending(): boolean { return this.coordinator.isPending; }
  get hasWindowListeners(): boolean { return this.coordinator.hasWindowListeners; }
  get lastDragViewportPrefix(): string { return this.coordinator.lastDragViewportPrefix; }

  handleMouseMove(e: MouseEvent): void {
    this.coordinator.handleMouseMove(e);
  }

  handleMouseUp(): void {
    this.coordinator.handleMouseUp();
  }

  startPending(nodeId: string, event: MouseEvent, viewportPrefix: string = '', options?: { gripAxis?: 'x' | 'y' }): void {
    this.coordinator.startPending(nodeId, event, viewportPrefix, options);
  }

  // ─── Commit ladder ─────────────────────────────────────────────────────
  /**
   * 5-branch commit ladder, ported verbatim from Canvas.tsx commitDragUpdates.
   *
   * Mechanical substitutions applied:
   *   nodesRef.current              → this.opts.getNodes()
   *   activeFilePath (closure var)  → this.opts.getActiveFilePath()
   *   isComponentFile (closure var) → this.isComponentFile
   *   jotaiStore.set/get            → this.opts.jotaiStore.set/get
   *   dragCoordinatorRef.current    → this.coordinator
   *   contentEl                     → this.opts.contentEl
   *   codeRef.current               → this.opts.getCode()
   *   cmsSchemas                    → this.opts.jotaiStore.get(collectionSchemasAtom)
   *   setSelectedIds([newId])       → this.opts.setSelectedIds([newId])
   *   renderer.*                    → this.opts.renderer.*
   */
  commitUpdates(updates: PendingUpdate[]): void {
    if (updates.length === 0) return;

    trace.fn('commitDragUpdates', { updateCount: updates.length, updates });

    const contentEl = this.opts.contentEl;
    const activeFilePath = this.opts.getActiveFilePath();
    const nodes = this.opts.getNodes();
    const cmsSchemas = this.opts.jotaiStore.get(collectionSchemasAtom);

    for (const update of updates) {
      if (update.type === 'style' && update.styles && contentEl) {
        // Component master page: dragging a ROOT node updates variantConfig position, not inline styles
        if (this.isComponentFile && update.styles.left && update.styles.top) {
          const node = nodes.get(update.nodeId);
          if (node && !node.parentId && !node.isCanvasNode) {
            // This is a variant root drag — determine which variant from the drag's viewport prefix.
            // Use the coordinator's context (has the exact viewport prefix from startPending).
            const dragVpPrefix = this.coordinator.lastDragViewportPrefix || '';
            const dragVpId = dragVpPrefix ? dragVpPrefix.replace(/-$/, '') : 'desktop';
            const variantName = (!dragVpId || dragVpId === 'desktop') ? 'default' : dragVpId;
            const x = parseFloat(update.styles.left) || 0;
            const y = parseFloat(update.styles.top) || 0;
            updateVariantPosition(activeFilePath, variantName, x, y);
            // Sync mutation queue with updated file (prevents stale code overwrite)
            const freshCode = projectFS.readFile(activeFilePath);
            if (freshCode) syncQueueCode(freshCode);
            // Don't write left/top to inline style — strip them
            const { left, top, ...otherStyles } = update.styles;
            if (Object.keys(otherStyles).length > 0) {
              updateNodeStyles({ id: update.nodeId, styles: otherStyles, contentEl });
            }
            continue;
          }
        }

        // Icon-set master page: dragging or resizing a vector card updates
        // iconConfig (mirrors variantConfig path above). Vectors are direct
        // children of the master root with data-id="icon-N", and their
        // position lives in iconConfig — not in inline styles. Intercept
        // left/top -> updateIconPosition, width/height -> updateIconSize,
        // strip those keys from the inline style write so the source code
        // stays clean.
        if (isIconSetFilePath(activeFilePath)) {
          // Treat the dragged node as a vector if it's listed in iconConfig
          // — that's the source of truth, NOT the parent-id, because the
          // generic drag system can hoist a vector OUT of the master root
          // into the canvasNodes fragment when the user drags it outside
          // the (often 0×0) master container. After hoist, parentId === null
          // / isCanvasNode === true, but it's still semantically a vector
          // and should route its position to iconConfig.
          const code = projectFS.readFile(activeFilePath) || '';
          const iconConfigs = parseIconSetConfig(code);
          const iconNames = new Set(iconConfigs.map(c => c.name));
          const isVector = iconNames.has(update.nodeId);
          if (isVector) {
            const styles = update.styles;
            const positionStyles: Record<string, string> = {};
            const otherStyles: Record<string, string> = {};
            let routedAny = false;
            // Keep the CURRENT config value for any axis not in this update
            // (single-axis change must not collapse the other to 0) AND for
            // any NON-PX value (a stray percent anchor misread as px is the
            // mouse-up jump bug — see iconConfigPx).
            const cur = iconConfigs.find(c => c.name === update.nodeId);
            if (styles.left || styles.top) {
              const x = iconConfigPx(styles.left, cur?.x ?? 0);
              const y = iconConfigPx(styles.top, cur?.y ?? 0);
              updateIconPosition(activeFilePath, update.nodeId, x, y);
              if (styles.left) positionStyles.left = styles.left;
              if (styles.top) positionStyles.top = styles.top;
              routedAny = true;
            }
            if (styles.width || styles.height) {
              const w = iconConfigPx(styles.width, cur?.width ?? 0);
              const h = iconConfigPx(styles.height, cur?.height ?? 0);
              updateIconSize(activeFilePath, update.nodeId, w, h);
              if (styles.width) positionStyles.width = styles.width;
              if (styles.height) positionStyles.height = styles.height;
              routedAny = true;
            }
            for (const [k, v] of Object.entries(styles)) {
              if (k === 'left' || k === 'top' || k === 'width' || k === 'height') continue;
              otherStyles[k] = v;
            }
            if (routedAny) {
              const freshCode = projectFS.readFile(activeFilePath);
              if (freshCode) syncQueueCode(freshCode);
              // domOnly: keep DOM left/top/width/height in sync with the
              // iconConfig values we just wrote, WITHOUT writing inline
              // styles back to the source file. Without this, the DOM
              // still shows the OLD position after mouseup (drag uses
              // CSS transform during the drag, never touching left/top
              // — so when the commit clears transform, left/top is still
              // at its pre-drag value and the vector visually reverts).
              if (Object.keys(positionStyles).length > 0) {
                updateNodeStyles({ id: update.nodeId, styles: positionStyles, contentEl, domOnly: true });
              }
              if (Object.keys(otherStyles).length > 0) {
                updateNodeStyles({ id: update.nodeId, styles: otherStyles, contentEl });
              }
              continue;
            }
          }
        }

        // Group child SVG drag: when the dragged node is a child of a
        // group SVG (an inner nested `<svg>` produced by groupSvgs),
        // CSS `left/top` doesn't position it — nested SVGs are placed via
        // `x/y` ATTRS in the parent's viewBox coords. Writing CSS
        // styles to source has no visual effect, so the drag visually
        // reverts on mouseup when the renderer re-paints from source.
        const dragNode = nodes.get(update.nodeId);
        const dragParent = dragNode?.parentId ? nodes.get(dragNode.parentId) : undefined;
        const isGroupChildSvg = dragNode?.type === 'svg' && dragParent?.type === 'svg';
        const hasPositionChange = isGroupChildSvg && (
          update.styles.left != null || update.styles.top != null ||
          update.styles.width != null || update.styles.height != null
        );
        if (isGroupChildSvg && hasPositionChange) {
          const styles = update.styles;
          const attrUpdates: Record<string, string> = {};
          const remaining: Record<string, string> = {};
          if (styles.left != null) attrUpdates.x = `${parseFloat(styles.left) || 0}`;
          if (styles.top != null) attrUpdates.y = `${parseFloat(styles.top) || 0}`;
          if (styles.width != null) attrUpdates.width = `${parseFloat(styles.width) || 0}`;
          if (styles.height != null) attrUpdates.height = `${parseFloat(styles.height) || 0}`;
          // ROTATED nested group: its `transform="rotate(θ cx cy)"` pivot must
          // follow the moved box to the new box CENTRE — else the committed
          // rotation pivots about a stale point and jumps on mouseup (the live
          // drag already shifted the DOM pivot; persist the same to source). The
          // parent refit below then shifts both x/y and the pivot together.
          const dragRot = (dragNode?.attrs?.transform || '').match(/rotate\(\s*(-?[\d.]+)/);
          if (dragRot) {
            const nx = parseFloat(attrUpdates.x ?? dragNode?.attrs?.x ?? '0') || 0;
            const ny = parseFloat(attrUpdates.y ?? dragNode?.attrs?.y ?? '0') || 0;
            const w = parseFloat(attrUpdates.width ?? dragNode?.attrs?.width ?? '0') || 0;
            const h = parseFloat(attrUpdates.height ?? dragNode?.attrs?.height ?? '0') || 0;
            attrUpdates.transform = `rotate(${dragRot[1]} ${Math.round((nx + w / 2) * 1000) / 1000} ${Math.round((ny + h / 2) * 1000) / 1000})`;
          }
          for (const [k, v] of Object.entries(styles)) {
            if (k === 'left' || k === 'top' || k === 'width' || k === 'height') continue;
            remaining[k] = v;
          }
          // Apply child + group refit in a single source mutation, then
          // mirror the FINAL post-refit values to the iframe DOM via
          // the bridge. Order matters: source-write first (returns
          // post-refit final values), then bridge-patch with those
          // same values. Without this, the renderer's later DOM patch
          // with post-refit values would create a momentary mismatch.
          const dragVpPrefix = this.coordinator.lastDragViewportPrefix || '';
          // Suppress overlays until renderer's next allRects pass
          // populates rectCache with the post-refit geometry. Same
          // atom + clear path as SvgEditorOverlay's exit flow.
          this.opts.jotaiStore.set(shapeEditCommitPendingAtom, true);
          // Queue an updateHtmlAttrs mutation as the SOURCE OF TRUTH write.
          // It writes x/y/width/height directly onto the group-child <svg>
          // WRAPPER (the element carrying `data-id="${update.nodeId}"`).
          // NOT updateSvgAttrs — that one always redirects to the inner
          // shape (<rect>/<path>), so the drag position would land on the
          // geometry element instead of the wrapper, double-offsetting
          // against moveChildAndRefitGroup's own wrapper write and making
          // the element jump on mouseup. Both go through the generator-attrs
          // `findJSXDataIdIndex` pipeline, so prefix edge cases (component
          // instance ids, viewport prefixes, ghost suffixes) are handled
          // either way. The refit below adds the group-bbox recompute on top;
          // if its source-write misses, these attrs still land on flush.
          queueMutation({
            type: 'updateHtmlAttrs',
            nodeId: update.nodeId,
            attrs: attrUpdates,
          });
          // DETACH COMPENSATION. Per-variant child positions are x/y translate
          // DELTAS relative to the base attrs (the only channel live motion
          // honors — probe-verified: attrX/attrY in variants is ignored on a
          // nested motion.svg). This primary commit rewrites the base attrs
          // old→new, which would shift every variant's absolute position by
          // the same amount — so rewrite each variant's delta by (old − new)
          // in the same flush, keeping every variant's painting EXACTLY where
          // the user put it. Legacy absolute attrX/attrY entries are migrated
          // to deltas (and cleared) here too.
          if (dragNode?.motionVariants && (attrUpdates.x != null || attrUpdates.y != null)) {
            const num = (v: string | number | undefined): number => {
              if (v == null || v === '') return 0;
              const n = parseFloat(String(v));
              return Number.isFinite(n) ? n : 0;
            };
            const oldX = num(dragNode.attrs?.x);
            const oldY = num(dragNode.attrs?.y);
            const newX = attrUpdates.x != null ? num(attrUpdates.x) : oldX;
            const newY = attrUpdates.y != null ? num(attrUpdates.y) : oldY;
            if (newX !== oldX || newY !== oldY) {
              for (const [vName, entry] of Object.entries(dragNode.motionVariants)) {
                if (vName === 'default' || !entry) continue;
                const hasAttrAbs = (entry.attrX != null && entry.attrX !== '') || (entry.attrY != null && entry.attrY !== '');
                const hasDelta = (entry.x != null && entry.x !== '') || (entry.y != null && entry.y !== '');
                if (!hasAttrAbs && !hasDelta) continue;
                const absX = entry.attrX != null && entry.attrX !== '' ? num(entry.attrX) : oldX + num(entry.x);
                const absY = entry.attrY != null && entry.attrY !== '' ? num(entry.attrY) : oldY + num(entry.y);
                queueMutation({
                  type: 'updateVariantStyle',
                  nodeId: update.nodeId,
                  variantName: vName,
                  styles: { x: `${absX - newX}`, y: `${absY - newY}`, attrX: '', attrY: '' },
                });
                trace.action('canvas:svg-group-child-variant-compensate', {
                  nodeId: update.nodeId, variantName: vName,
                  oldAttrs: { x: oldX, y: oldY }, newAttrs: { x: newX, y: newY },
                  abs: { x: absX, y: absY }, newDelta: { x: absX - newX, y: absY - newY },
                });
              }
              // Carrier-origin maintenance: the rotate/scale carrier's PX
              // origin (view-box) is derived from the base attrs this commit
              // just rewrote — refresh it in the same flush so variant
              // transforms keep pivoting at their (compensated, unchanged)
              // painted box centre.
              if (dragNode.styles?.transformBox === 'view-box') {
                const carrierParent = dragNode.parentId ? nodes.get(dragNode.parentId) : null;
                const refreshed = svgChildCarrierOrigin(
                  { ...dragNode.attrs, x: `${newX}`, y: `${newY}` },
                  carrierParent?.attrs?.viewBox,
                );
                queueMutation({ type: 'updateStyles', nodeId: update.nodeId, styles: refreshed as unknown as Record<string, string> });
                trace.action('canvas:svg-group-child-carrier-origin-refresh', { nodeId: update.nodeId, ...refreshed });
              }
            }
          }
          flushNow();
          // REFIT GATE: the refit re-bases the group's box/viewBox AND every
          // child's x/y attrs — geometry that is SHARED by every variant
          // painting. Once any child carries a per-variant position
          // (variants[v].attrX/attrY, or legacy x/y deltas), a primary refit
          // relocates the other variants' paintings (the user-reported
          // "moving the group on primary drags the replica along") and the
          // re-base no longer matches the live drag position (the mouseup
          // jump). Variant-positioned groups keep a FIXED box; children move
          // freely inside (overflow: visible), standard.
          // Shared with the resize commit's gate — positions, scales,
          // rotations, geometry d, px metadata all count (each is relative to
          // the shared geometry a refit would re-base).
          const groupChildHasVariantPosition = groupChildrenCarryVariantGeometry(dragNode!.parentId!);
          const finalState = groupChildHasVariantPosition
            ? null
            : moveChildAndRefitGroup(getActiveFilePath(), dragNode!.parentId!, update.nodeId, attrUpdates);
          trace.action('canvas:svg-group-drag-commit', {
            nodeId: update.nodeId,
            parentId: dragNode!.parentId,
            attrUpdates,
            refitOk: !!finalState,
            refitSkippedVariantPositions: groupChildHasVariantPosition,
          });
          if (finalState) {
            const bridge = getCanvasBridge();
            const childFinal = { ...attrUpdates, ...finalState.childAttrs };
            // Recompute the rotated group's pivot from the POST-refit x/y so the
            // DOM matches the source (the refit shifted both the box and the
            // pivot) — no 1-frame rotation offset on mouseup.
            if (dragRot && childFinal.x != null) {
              const fx = parseFloat(childFinal.x) || 0;
              const fy = parseFloat(childFinal.y ?? dragNode?.attrs?.y ?? '0') || 0;
              const fw = parseFloat(childFinal.width ?? dragNode?.attrs?.width ?? '0') || 0;
              const fh = parseFloat(childFinal.height ?? dragNode?.attrs?.height ?? '0') || 0;
              childFinal.transform = `rotate(${dragRot[1]} ${Math.round((fx + fw / 2) * 1000) / 1000} ${Math.round((fy + fh / 2) * 1000) / 1000})`;
            }
            // The commit's own left/top style write is sitting in the svg-child
            // attr-tick coalescer with PRE-refit values — its microtask would
            // post them AFTER these final patches (FIFO), leaving the DOM child
            // one refit behind the wrapper. Merge the finals into it first.
            supersedePendingSvgChildAttrTick(update.nodeId, dragVpPrefix, childFinal);
            bridge.patchAttrsAndStyles(update.nodeId, dragVpPrefix, childFinal, {});
            for (const [siblingId, siblingAttrs] of finalState.siblingAttrs) {
              bridge.patchAttrsAndStyles(siblingId, dragVpPrefix, siblingAttrs, {});
            }
            if (Object.keys(finalState.groupStyles).length > 0) {
              const groupAttrs: Record<string, string> = finalState.groupViewBox ? { viewBox: finalState.groupViewBox } : {};
              bridge.patchAttrsAndStyles(dragNode!.parentId!, dragVpPrefix, groupAttrs, finalState.groupStyles);
            }
            // Seed the IMPERATIVE cache with the committed values BEFORE the
            // forced render below — it renders from the cache, and the cache
            // still holds the PRE-drag attrs (updateNodeInCache mirrors styles
            // only). Rendering the stale attrs painted the child back at its
            // OLD position until the deferred parse fan-out landed — the
            // "0.2s jump to the previous position then snap" mouse-up flash
            // (user report 2026-07-28).
            const seedAttrs = (nid: string, attrs: Record<string, string>) => {
              const n = getNodeFromCache(nid);
              if (n) injectNodeIntoCache({ ...n, attrs: { ...n.attrs, ...attrs } });
            };
            seedAttrs(update.nodeId, childFinal);
            for (const [siblingId, siblingAttrs] of finalState.siblingAttrs) seedAttrs(siblingId, siblingAttrs);
            const groupNode = getNodeFromCache(dragNode!.parentId!);
            if (groupNode) {
              injectNodeIntoCache({
                ...groupNode,
                attrs: { ...groupNode.attrs, ...(finalState.groupViewBox ? { viewBox: finalState.groupViewBox } : {}) },
                styles: { ...groupNode.styles, ...finalState.groupStyles },
              });
            }
          } else {
            getCanvasBridge().patchAttrsAndStyles(update.nodeId, dragVpPrefix, attrUpdates, {});
          }
          // moveChildAndRefitGroup refit only the IMMEDIATE parent. If that
          // parent is itself a nested group, shrink-wrap every group above it
          // (recursive) so an outer group's box/selection never goes stale when
          // a deeply-nested child moves.
          const parentChain = getSvgGroupAncestorChain(dragNode!.parentId!)
            .filter(gid => gid !== dragNode!.parentId);
          if (parentChain.length > 0 && !groupChildHasVariantPosition) refitGroupChain(parentChain, getActiveFilePath());
          if (Object.keys(remaining).length > 0) {
            updateNodeStyles({ id: update.nodeId, styles: remaining, contentEl });
          }
          // Force a render so renderComplete fires and clears
          // shapeEditCommitPendingAtom (the CanvasRenderer's normal path
          // skips renders when `canvasUpdating` is set, which it is right
          // after a drag commit; without forcing, no renderComplete →
          // overlays stay suppressed forever). Also re-applies the
          // refit-adjusted source so any subsequent drag of an unrelated
          // element doesn't see stale source state for this group.
          forceCanvasRender();
          continue;
        }
        // Order-only updates (layout reorder): route through updateNodeStyles
        // so replicas auto-route to @media CSS for per-viewport order.
        // Position props always inline (commitDragPosition) — drag position
        // updates are inline-style-only, never @media/variant routed.
        const styleKeys = Object.keys(update.styles);
        if (styleKeys.length === 1 && styleKeys[0] === 'order') {
          updateNodeStyles({ id: update.nodeId, styles: update.styles, contentEl });
        } else {
          commitDragPosition(update.nodeId, update.styles, contentEl);
        }
      } else if (update.type === 'reorder' && update.newParentId != null && update.newIndex != null) {
        // Reorder changes DOM structure — force re-render after mutation
        this.opts.renderer.setStructuralPending(true);
        queueMutation({ type: 'reorder', nodeId: update.nodeId, parentId: update.newParentId, index: update.newIndex });
        requestAnimationFrame(() => { this.opts.renderer.setStructuralPending(false); });
      } else if (update.type === 'move') {
        // INSTANT REPARENT: move the element in the iframe DOM NOW so it snaps into
        // the layout (or out to canvas) and the siblings re-flow on mouseup, instead
        // of waiting ~0.3s for the `move` mutation to re-parse the big page. The
        // call is best-effort (no-ops if it can't resolve the element/target); the
        // mutation below still re-parses + guarantees the code, and the patchStyles
        // stale-element guard reconciles any brief duplicate.
        const liveVpPrefix = getViewportPrefix(this.opts.getInteractingVpId());
        getCanvasBridge().reparentLive?.(update.nodeId, liveVpPrefix, update.newParentId ?? null, update.newIndex ?? 0, update.styles ?? {});
        // Sync the IMPERATIVE NODE CACHE too — this drop-time move (flex/grid
        // slot entry, multi-select reparent) is the one reparent path whose
        // cache sync did NOT happen mid-drag in the strategy. With the drop
        // fan-out deferred, live cache readers un-hide right after mouseup —
        // the un-hide pass read `isCanvasNode: true` off the stale cache and
        // CanvasNodeNameDisplay re-showed the node's floating name label for
        // ~0.3s (until the fan-out's parse replaced the map). moveNodeInCache
        // flips parentId/isCanvasNode + bumps the structure version, so the
        // label set is correct on the FIRST post-mouseup render.
        moveNodeInCache(update.nodeId, update.newParentId ?? null);
        if (update.styles) updateNodeInCache(update.nodeId, update.styles);
        // Move changes parent — DOM must be fully rebuilt (can't patch reparenting)
        this.opts.renderer.setStructuralPending(true);
        queueMutation({ type: 'move', nodeId: update.nodeId, newParentId: update.newParentId ?? null, styles: update.styles, index: update.newIndex, insertBeforeId: update.insertBeforeId, canvasNode: update.canvasNode });
        // Same fade as a sibling reorder: a reparent (canvas→section / section→canvas)
        // mounts the selection overlay at the STALE drag spot before the new-slot rect
        // remeasures (async). Pulse so SelectionFade hides → fades in once it settles.
        repositionSignalOps.signal();
        // OVERLAY RE-HOMING: a canvas-node overlay is glued to its trigger
        // (design-tool parity). When the TRIGGER re-parents (e.g. dragged from the
        // canvas into a frame), the overlay must move with it — left behind as
        // a canvas node, its canvas-space positioning fights the in-frame
        // trigger's coordinates and it teleports/hides mid-drag (live e2e
        // 2026-06-12: ~292px jump at the enter boundary, display:none after).
        // Moved into the same parent it becomes a regular viewport overlay:
        // the portal system positions it from the trigger again.
        if (update.newParentId) {
          for (const n of nodes.values()) {
            if (!n.isCanvasNode || n.id === update.nodeId) continue;
            const ovAttr = n.attrs?.['data-overlay'];
            if (!ovAttr) continue;
            try {
              const cfg = JSON.parse(ovAttr);
              if (cfg?.triggerId === update.nodeId) {
                queueMutation({
                  type: 'move', nodeId: n.id, newParentId: update.newParentId,
                  styles: {}, canvasNode: false,
                });
                trace.action('canvas:overlay-rehomed-with-trigger', {
                  overlayId: n.id, triggerId: update.nodeId, newParentId: update.newParentId,
                });
              }
            } catch { /* unparseable config — leave it */ }
          }
        }
        requestAnimationFrame(() => { this.opts.renderer.setStructuralPending(false); });
      } else if (update.type === 'remove') {
        // Used by the consolidation-clone path: when a multi-vp visible
        // replica drag-out lands on mouseup, the clone (visual aid only)
        // is removed, and the actual `move` (or no-op) targets the
        // SOURCE node. DOM rebuilds because canvasNodes membership
        // changes — flag structural pending so the renderer doesn't
        // try to incrementally patch.
        this.opts.renderer.setStructuralPending(true);
        queueMutation({ type: 'removeNode', nodeId: update.nodeId });
        requestAnimationFrame(() => { this.opts.renderer.setStructuralPending(false); });
      } else if (update.type === 'clearContainerStyles') {
        // Wipe ALL @media/@container overrides for a node — used when moving to canvas
        // so stale `display: none` (and other viewport-scoped) rules don't follow the clone.
        queueMutation({ type: 'clearContainerStyles', nodeId: update.nodeId });
      } else if (update.type === 'updateContainerStyle') {
        // Viewport-specific responsive override (e.g. display:none in tablet).
        // LIVE: apply it inline to THAT viewport's copy so a drag-into-REPLICA shows
        // and orders instantly. reparentLive moved + cloned the node, but the move's
        // base style is `display:none` — the target viewport's `display:unset` is a
        // @container override committed only ~0.3s later, so without this the node
        // stays hidden in the replica it was dropped into until the re-render lands.
        let ovPrefix: string | null = null;
        for (const [vpId, w] of Object.entries(getViewportWidths())) {
          if (w === update.maxWidth) { ovPrefix = getViewportPrefix(vpId); break; }
        }
        // `important: true` — a replica's committed value paints via a
        // `!important` @container rule, and the OLD rule is still injected
        // at this point (a position-only commit SKIPS the render that
        // rebuilds the canvas CSS). A non-important inline patch loses to
        // that stale rule instantly — the sandbox handler even UNTRACKS the
        // strategy's own important drop-patch, so the node visibly snapped
        // back to its pre-drag position on mouseup and only corrected after
        // a page switch (live find 2026-07-21). With important the patch is
        // tracked as [data-live-important] residue and the next real render
        // sweeps it as the rebuilt CSS takes over seamlessly.
        if (ovPrefix != null) getCanvasBridge().patchStyles?.(update.nodeId, ovPrefix, update.styles!, true);
        queueMutation({ type: 'updateContainerStyle', nodeId: update.nodeId, maxWidth: update.maxWidth!, styles: update.styles! });
      } else if (update.type === 'updateVariantStyle') {
        // Component variant-specific style override (e.g. display:none in hover variant)
        queueMutation({ type: 'updateVariantStyle', nodeId: update.nodeId, variantName: update.variantName!, styles: update.styles! });
      } else if (update.type === 'setVariantVisibility') {
        // AnimatePresence + conditional render visibility for smooth
        // variant unmount animations (siblings FLIP into the gap).
        queueMutation({
          type: 'setVariantVisibility',
          nodeId: update.nodeId,
          hiddenVariants: update.hiddenVariants!,
          allVariants: update.allVariants!,
        });
      } else if (update.type === 'setConditionalOrder') {
        // Conditional order in style for layout FLIP reorder animation
        queueMutation({ type: 'setConditionalOrder', nodeId: update.nodeId, orderMap: update.orderMap! });
      } else if (update.type === 'setConditionalStyle') {
        // Per-variant inline style ternary (e.g. `display: variant === 'x' ? 'none'
        // : '<base>'`). Used by `hideInThis` to hide a CMS `.map()` ROW on a replica
        // detach — that row can't use the AnimatePresence/hiddenOnVariants wrapper
        // (can't wrap a node inside a `.map()` callback). The drag commit ladder must
        // handle this PendingUpdate type or the source-hide is SILENTLY DROPPED (the
        // detach then just duplicates without hiding the source).
        queueMutation({ type: 'setConditionalStyle', nodeId: update.nodeId, prop: update.prop!, variantName: update.variantName!, value: update.value! });
      } else if (update.type === 'add' && update.descriptor) {
        // Toolbar drag: create new element at drop target
        this.opts.renderer.setStructuralPending(true);
        const desc = update.descriptor;
        const newId = desc.id ?? update.nodeId;

        const convertChildren = descriptorChildrenToDefs;

        if (update.newParentId) {
          // Dropping into a container — addNode with parent
          queueMutation({
            type: 'addNode',
            parentId: update.newParentId,
            node: {
              id: newId,
              type: desc.tag,
              styles: desc.styles,
              attrs: desc.attrs,
              // See the addCanvasNode branch below for the rationale —
              // prefer the descriptor's friendly `name` from the toolbar
              // item / InsertItem, fall back to tag only when nothing else
              // is set.
              name: desc.name ?? desc.tag,
              textContent: desc.textContent,
              children: convertChildren(desc.children),
            },
            index: update.newIndex,
          });
        } else {
          // Dropping on canvas outside viewports — addCanvasNode (floating
          // element). A free canvas node has no flow container, so resolve the
          // root's % width/height to px against the primary viewport width
          // (else a `width: '100%'` section collapses to a narrow strip and its
          // zero-ish geometry can crash the selection overlay).
          let refW = DEFAULT_VIEWPORT_WIDTH;
          try {
            const cfgs = this.opts.jotaiStore.get(viewportsConfigAtom);
            const widths = getViewportWidths();
            const primary = cfgs.find((c) => c.isPrimary) ?? cfgs[0];
            if (primary) refW = widths[primary.id] ?? primary.width ?? DEFAULT_VIEWPORT_WIDTH;
          } catch { /* fall back to default */ }
          queueMutation({
            type: 'addCanvasNode',
            node: {
              id: newId,
              type: desc.tag,
              styles: resolveCanvasNodeRootDims(desc.styles, refW),
              attrs: desc.attrs,
              // Prefer the descriptor's friendly `name` ("Pricing Card",
              // "Sidebar Layout", etc.) — that's what the ToolbarDragStrategy
              // resolves from the InsertItem panel label + explicit
              // overrides. Falling back to `desc.tag` here used to hardcode
              // `data-name="div"` on every canvas drop, defeating the whole
              // labelling system. Tag fallback only when nothing meaningful
              // is set so layers panel doesn't blank-name an entry.
              name: desc.name ?? desc.tag,
              textContent: desc.textContent,
              children: convertChildren(desc.children),
            },
          });
        }
        // CMS-bound drop: after the wrapper + placeholder Item exist in
        // code, wrap the FIRST CHILD in a `.map()` over the chosen
        // collection. The wrapper is the .map()'s container; the first
        // child is the template the parser keys off. Both `addNode` and
        // `bindToCmsCollection` flush in order, so the binding sees the
        // freshly-added template and produces a valid wrapped JSX.
        if (desc.cmsCollectionSlug && desc.children && desc.children.length > 0) {
          const templateChildId = desc.children[0].id;
          if (templateChildId) {
            queueMutation({
              type: 'bindToCmsCollection',
              nodeId: templateChildId,
              collectionSlug: desc.cmsCollectionSlug,
            });
            trace.action('toolbar-drag:cms-bind', {
              wrapperId: newId,
              templateId: templateChildId,
              slug: desc.cmsCollectionSlug,
            });

            // Pre-bind the placeholder Item's image + heading to the
            // collection's first image/text fields so the user sees real
            // content the moment they drop, not the gray-box stub. The
            // template's children are: [imageDiv, heading], baked into
            // the toolbar item config — the order matters for this lookup.
            const schema = cmsSchemas.get(desc.cmsCollectionSlug);
            // Auto-name (design-tool parity): the CONTAINER is the PLURAL form, the
            // repeated TEMPLATE row is the SINGULAR — regardless of how the
            // collection is named. Always singularize first so it's idempotent:
            // "Advisors" → item "Advisor" + container "Advisors"; "Gallery" →
            // item "Gallery" + container "Galleries".
            const collName = (schema?.name || desc.cmsCollectionSlug).trim();
            if (collName) {
              const singular = singularize(collName);
              queueMutation({ type: 'updateHtmlAttrs', nodeId: newId, attrs: { 'data-name': pluralize(singular) } });
              queueMutation({ type: 'updateHtmlAttrs', nodeId: templateChildId, attrs: { 'data-name': singular } });
            }
            const itemDesc = desc.children[0];
            const imageChild = itemDesc.children?.[0];
            const headingChild = itemDesc.children?.[1];
            const firstImageField = schema?.fields.find((f: any) => f.type === 'image' || f.type === 'file');
            const firstTextField = schema?.fields.find((f: any) => f.type === 'text' || f.type === 'richtext' || f.type === 'textarea');
            if (imageChild?.id && firstImageField) {
              queueMutation({
                type: 'bindField', nodeId: imageChild.id,
                property: 'backgroundColor', // Fill control entry; field-type=image routes to backgroundImage
                fieldId: firstImageField.id, itemVar: 'item', fieldType: firstImageField.type,
              });
            }
            if (headingChild?.id && firstTextField) {
              queueMutation({
                type: 'bindField', nodeId: headingChild.id,
                property: 'textContent',
                fieldId: firstTextField.id, itemVar: 'item', fieldType: firstTextField.type,
              });
            }
            trace.action('toolbar-drag:cms-prebind', {
              imageField: firstImageField?.id ?? null,
              textField: firstTextField?.id ?? null,
            });

            // Auto-link each row to its own detail page. The template
            // div becomes a <Link> with the "This Row" slug binding
            // (`data-cms-nav="row"` + `href={\`/<col>/${item?._slug ?? ''}\`}`)
            // — same shape the Link tool's Slug control writes when the
            // user picks "This Row" by hand. Makes the dropped collection
            // immediately clickable: tap any card → its detail page.
            // Inheritance styles (`textDecoration: none; color: inherit`)
            // match the Link tool's own row-bind handler so the row
            // doesn't suddenly turn into a blue underlined link.
            queueMutation({ type: 'changeTag', nodeId: templateChildId, newTag: 'Link' });
            queueMutation({
              type: 'updateStyles', nodeId: templateChildId,
              styles: { textDecoration: 'none', color: 'inherit' },
            });
            queueMutation({
              type: 'setCmsNavHref',
              nodeId: templateChildId,
              mode: 'row',
              collection: desc.cmsCollectionSlug,
              itemVar: 'item',
            });
            trace.action('toolbar-drag:cms-row-link', {
              templateId: templateChildId,
              collection: desc.cmsCollectionSlug,
            });

            // Preemptively add `import Link from 'next/link'` to the
            // page's import block — same pattern as the PascalCase
            // component-import path below. `syncImports` would normally
            // pick `<Link>` up on flush via `/<Link[\s/>]/.test(body)`,
            // BUT the changeTag → Link rewrite happens INSIDE the same
            // flush as this orchestrator's other mutations, and the
            // user reported `ReferenceError: Link is not defined` at
            // runtime — meaning the import didn't get added in time.
            // Adding it directly to the code + syncing the queue
            // baseline makes the import unconditionally present before
            // the file write lands, mirroring the component-import
            // fail-safe at line 711+.
            const currentCode = this.opts.getCode();
            if (currentCode && !currentCode.includes("from 'next/link'") && !currentCode.includes('from "next/link"')) {
              const importLine = `import Link from 'next/link';`;
              const lines = currentCode.split('\n');
              let lastImportIdx = -1;
              let inBlockComment = false;
              for (let i = 0; i < lines.length; i++) {
                const t = lines[i].trim();
                if (inBlockComment) {
                  lastImportIdx = i;
                  if (t.includes('*/')) inBlockComment = false;
                  continue;
                }
                const opensBlock = t.startsWith('/**') || t.startsWith('/*');
                const closesOnSameLine = opensBlock && t.includes('*/');
                if (opensBlock && !closesOnSameLine) {
                  inBlockComment = true;
                  lastImportIdx = i;
                  continue;
                }
                if (
                  t.startsWith('import ')
                  || t.startsWith("'use client'")
                  || t.startsWith('"use client"')
                  || t === ''
                  || t.startsWith('//')
                  || closesOnSameLine
                ) {
                  lastImportIdx = i;
                } else if (lastImportIdx >= 0) {
                  break;
                }
              }
              lines.splice(lastImportIdx + 1, 0, importLine);
              const newCode = lines.join('\n');
              this.opts.setCode(newCode);
              // Sync the queue's baseline so the synchronous flushNow
              // below writes the file with the import already in place
              // (the codeAtom setter only propagates on the next React
              // commit, which is too late for flushNow).
              syncQueueCode(newCode);
              trace.action('toolbar-drag:cms-row-link-import', {
                collection: desc.cmsCollectionSlug,
              });
            }
          }
        }
        // If it's a component (uppercase tag), ensure import exists.
        // We push the import-added code into BOTH the codeAtom and the
        // mutation queue's `currentCode` baseline so the next `flushNow`
        // applies the queued addNode on top of code that already has the
        // import. Without `syncQueueCode`, the queue would still hold the
        // pre-import baseline and the synchronous flush would write the
        // file WITHOUT the import — the parser then sees `<YouTubeEmbed>`
        // as a plain JSX tag (no `componentFile` resolved), the canvas
        // shows a generic empty box, and ComponentPropsTool returns null.
        if (desc.tag && desc.tag[0] === desc.tag[0].toUpperCase() && desc.tag[0] !== desc.tag[0].toLowerCase()) {
          // Check if import already exists in the code, if not add it.
          // Master files live in separate folders: `components/` (design
          // components, code components) and `icons/` (icon-set masters).
          // Probe icons before components — we've seen
          // `installBuiltInCodeComponent`-era flows leave phantom
          // `components/X.tsx` placeholders that outlive the user's real
          // file. With components-first, those placeholders hijacked the
          // import for what's really an icon and the dropped instance
          // failed to render. Icon sets are write-once via the
          // LibraryPanel `+` flow, so when one of those files exists it's
          // the ground truth.
          //
          // If none exists, default to components/ — matches old behavior
          // for in-flight AI-generated tags whose file hasn't landed yet.
          const currentCode = this.opts.getCode();
          if (currentCode && !currentCode.includes(`import ${desc.tag} from`)) {
            const inIcons = projectFS.readFile(`icons/${desc.tag}.tsx`) != null;
            const inComponents = projectFS.readFile(`components/${desc.tag}.tsx`) != null;
            const importDir = (inIcons && !inComponents) ? 'icons'
              : 'components';
            trace.action('toolbar-drag:import-probe', {
              tag: desc.tag, inIcons, inComponents, importDir,
            });
            const importLine = `import ${desc.tag} from '@/${importDir}/${desc.tag}';`;
            // Insert after the last preamble line. The previous loop only
            // checked `t.startsWith('/*')`, which matched the FIRST line of
            // a multi-line `/** @canvas { ... } */` block but had no idea
            // about the closing `*/`. So when the @canvas block looked like
            //
            //   /** @canvas {
            //     "viewports": [ ... ]
            //   } */
            //
            // the loop's `lastImportIdx` froze at the opening `/** @canvas {`
            // line and the next iteration (`  "viewports": [`) bailed via
            // the `else if (lastImportIdx >= 0) break;` branch. The import
            // then got spliced one line below the opening — i.e. INSIDE the
            // comment block, corrupting the JSON. Track an explicit
            // `inBlockComment` state so a multi-line block is treated as one
            // contiguous preamble unit and `lastImportIdx` advances past
            // its closing `*/` line.
            const lines = currentCode.split('\n');
            let lastImportIdx = -1;
            let inBlockComment = false;
            for (let i = 0; i < lines.length; i++) {
              const t = lines[i].trim();
              if (inBlockComment) {
                lastImportIdx = i;
                if (t.includes('*/')) inBlockComment = false;
                continue;
              }
              const opensBlock = t.startsWith('/**') || t.startsWith('/*');
              const closesOnSameLine = opensBlock && t.includes('*/');
              if (opensBlock && !closesOnSameLine) {
                inBlockComment = true;
                lastImportIdx = i;
                continue;
              }
              if (
                t.startsWith('import ')
                || t.startsWith("'use client'")
                || t.startsWith('"use client"')
                || t === ''
                || t.startsWith('//')
                || closesOnSameLine
              ) {
                lastImportIdx = i;
              } else if (lastImportIdx >= 0) {
                break;
              }
            }
            lines.splice(lastImportIdx + 1, 0, importLine);
            const newCode = lines.join('\n');
            this.opts.setCode(newCode);
            // Immediately sync the queue's baseline — the codeAtom write
            // above schedules a useEffect-driven sync, which won't fire
            // until React commits, but `flushNow()` below runs SYNCHRONOUSLY.
            // Without this manual sync, the queue would still flush against
            // the import-less base and the file write would lose the import.
            syncQueueCode(newCode);
            trace.action('toolbar-drag:component-import-added', { tag: desc.tag });
          }
        }
        // Flush + select synchronously — the mutation queue's normal
        // requestIdleCallback path defers the file write to the next idle
        // slot. If we set selection before the parser has run on the new
        // code, `nodes.get(newId)` returns either undefined OR a partial
        // placeholder lacking fields the tools check (`componentFile` for
        // Code components, `variantConfig`, etc.) — so tools return null,
        // the panel goes blank, and remounts a tick later when the
        // canonical node arrives. By forcing the flush before selection,
        // the parser has already produced the fully-populated node by the
        // time the panel sees the new id, so every tool sub-tree mounts
        // once with real data and the panel never flickers.
        flushNow();
        // After flushNow, codeAtom has the new file, nodesAtom has been
        // re-derived, and `nodes.get(newId)` returns the canonical node.
        this.opts.renderer.setStructuralPending(false);
        this.opts.setSelectedIds([newId]);
      } else if (update.type === 'duplicateCollectionToCanvas') {
        // Replica drag-out clone of a CMS collection list — COPY the literal
        // `.map()` subtree into `canvasNodes` (map + `item.*` bindings preserved,
        // id-renamed by `cloneSuffix`). The paired `hideInThis` update (queued just
        // before this one) hides the ORIGINAL on the source replica ONLY; it stays
        // on primary + every other replica. Mirrors the toolbar/clone `add` tail:
        // structural rebuild + sync flush + select the new canvas node so selection
        // follows the clone onto the workspace.
        this.opts.renderer.setStructuralPending(true);
        const cloneId = update.nodeId + (update.cloneSuffix ?? '');
        queueMutation({
          type: 'duplicateCollectionToCanvas',
          nodeId: update.nodeId,
          source: update.cmsSource!,
          suffix: update.cloneSuffix!,
          styles: update.styles!,
        });
        flushNow();
        this.opts.renderer.setStructuralPending(false);
        this.opts.setSelectedIds([cloneId]);
        trace.action('drag-orchestrator:duplicate-collection-to-canvas', {
          srcId: update.nodeId, cloneId, source: update.cmsSource,
        });
      }
    }

    // Let the normal async mutation flush handle code persistence.
    // No flushNow() needed — startLeft/startTop is derived from the live
    // rect cache (via screen→CSS conversion) so it's always accurate.

    // DROP RENDER SKIP (pure position reposition — canvas nodes AND
    // absolute-in-frame children). When EVERY update is a position-only
    // commit (left/top/right/bottom pin values, position, transform — the
    // exact key set AbsoluteInFrameStrategy's `cs` emits, incl. `%` pins and
    // '' clears; replica drops carry the same keys as `updateContainerStyle`),
    // the strategy already patched the final position onto the sandbox DOM
    // via the bridge AND re-emitted the rect — so the drop's setCode→
    // re-render+full-measure (~130ms on a big page: renderNodes + allRects)
    // is entirely redundant. markCanvasUpdate makes CanvasRenderer skip that
    // ONE render; the parse still runs (deferred) so panels/undo update.
    // Previously this required `!parentId` (canvas nodes only) — an
    // absolute-in-frame move (dragging a logo inside the viewport) took the
    // full synchronous fan-out + render and felt ~0.5s on a big page while
    // the same gesture on a canvas node was instant. Any reparent /
    // structural / component-file commit takes an early `return` or a
    // non-style branch above and never reaches here, so those still render
    // normally. Component instances stay excluded (their style writes
    // redirect through the instance tag → expanded-node re-merge needs the
    // render).
    const POSITION_KEYS = new Set(['left', 'top', 'right', 'bottom', 'position', 'transform']);
    if (!this.isComponentFile && updates.length > 0 && updates.every(u =>
      (u.type === 'style' || u.type === 'updateContainerStyle') && !!u.styles
      && Object.keys(u.styles).every(k => POSITION_KEYS.has(k))
      && !nodes.get(u.nodeId)?.isComponentInstance
    )) {
      this.opts.renderer.markCanvasUpdate();
      // Defer the drop's setCode fan-out (nodesAtom re-parse + code-derived-atom
      // cascade) to the next frame so the mouseup returns instantly. Safe: the
      // render is skipped and DOM/rect caches are already patched. Applied in
      // reset()'s flushNow a moment later; undo/redo force it first.
      setDeferNextFanOut();
      trace.action('drag-orchestrator:canvas-position-render-skip', { nodeIds: updates.map(u => u.nodeId) });
    } else if (!this.isComponentFile && updates.length > 0 && updates.every(u =>
      u.type === 'move' || u.type === 'reorder'
      || (u.type === 'style' && !!u.styles && Object.keys(u.styles).every(k => k === 'left' || k === 'top' || k === 'transform' || k === 'order'))
    ) && updates.some(u => u.type === 'move' || u.type === 'reorder')) {
      // STRUCTURAL DROP FAN-OUT DEFER (reparent / reorder). Long-task profiling
      // (MutationObserver ground truth — the sandbox.evaluate poll lies, it
      // queues behind the busy thread) showed the mouseup runs ONE ~210ms task:
      // flush → parse → full React pass → effects; the iframe shares this event
      // loop, so `reparentLive` (posted within ~35ms of mouseup) could not
      // execute until that task ended — the node visually landed at ~218ms even
      // though its DOM move was queued at 35ms. Deferring the setCode fan-out
      // to the next frame shrinks the mouseup task to the string-splice + file
      // write (~40ms): the iframe then processes reparentLive + the order
      // patches almost immediately and the node SNAPS into its slot; the parse
      // + React cascade + render truth-up run a frame later as their own task.
      // Safe: the visual is already correct via reparentLive/patches, the node
      // cache is synchronously updated by the strategies, and undo/redo force
      // the pending fan-out first (flushPendingFanOut). NOT for component
      // files (variant wiring needs the synchronous parse) or non-structural
      // commits.
      setDeferNextFanOut();
      trace.action('drag-orchestrator:structural-fan-out-defer', { nodeIds: updates.map(u => u.nodeId) });
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  dispose(): void {
    this.unsubDragTick?.();
    this.unsubDragTick = null;
    this.unsubIdleTick?.();
    this.unsubIdleTick = null;
    if (this.autoPanMouseListener) {
      window.removeEventListener('pointermove', this.autoPanMouseListener);
      this.autoPanMouseListener = null;
    }
    this.autoPanCtrl?.destroy();
    this.autoPanCtrl = null;
    setActiveAutoPan(null);
    trace.action('drag-orchestrator:disposed', {});
  }
}
