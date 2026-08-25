// DragCoordinator.ts — Main drag orchestrator.
// Routes mouse events to the active strategy. Handles threshold detection,
// strategy selection, modifier keys, and committing updates to code.
//
// DESIGN:
// - Strategies do the WHAT (calculate positions, detect reorder, etc.)
// - Coordinator does the WHEN (threshold, start/move/end lifecycle)
// - Structural mutations (entry/exit) commit immediately via flushNow() in strategies
// - Final position updates commit on mouseUp (via PendingUpdate[])
// - DOM updates happen on every mouseMove (for 60fps visual feedback)

import type { Transform, NodeMap, DraggedNode, PendingUpdate, Point, SnapGuide, SpacingGuide } from '@/shared/types';
import type { DragContext, DragStrategy } from './types';
import { MIN_DRAG_DISTANCE } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';

import { beginOverlayFollow, updateOverlayFollow, endOverlayFollow } from './overlay-follow';
import { CanvasDragStrategy } from './strategies/CanvasDragStrategy';
import { LayoutLiftedStrategy } from './strategies/LayoutLiftedStrategy';
import { GridDragStrategy } from './strategies/GridDragStrategy';
import { OverlayDragStrategy as OverlayDragStrategyInstance } from './strategies/OverlayDragStrategy';
import { AbsoluteInFrameStrategy } from './strategies/AbsoluteInFrameStrategy';
import { ToolbarDragStrategy } from './strategies/ToolbarDragStrategy';
import type { ToolbarItem } from './toolbar-item-config';
import { dragStateOps } from './drag-state-store';
import { resetSnapHysteresis } from './handlers/snap-handler';
import { findNodeRect, vpIdFromPrefix, findNodeComputedStyles } from '@/canvas/node-ops';
import { getIframeOffset } from './helpers/coords';
import { getNodeFromCache } from '@/code/stores/store';
import { getDefaultStore } from 'jotai';
import { getNodesSnapshot } from '@/code/stores/store';
import { visibleViewportsAtom, interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { isDefaultLocaleAtom } from '@/code/stores/locale-store';
import { getScreenCornersById, getElementCenter } from '@/canvas/resize/geometry-utils';
import { buildDuplicateDescriptor, queueBorderOverlayDuplicates, queueReplicaCreationUnhide } from '@/canvas/creators/creator-utils';
import { tileContextFor } from '@/canvas/replica-bake';
import { queueMutation, flushNow, setForceRender, setDeferNextFanOut, hasQueuedMutations } from '@/code/mutation/mutation-queue';
import { isComponentLikeFilePath } from '@/code/project/file-path-kind';
import { forceCanvasRender, isPrimaryViewport, getActiveFilePath } from '@/canvas/node-ops';
import { holdHistoryCoalescing, releaseHistoryCoalescing } from '@/code/mutation/history';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { getReplicaContext } from './replica-context';
import { runDragEndRestores } from './drag-end-restores';

// ─── Callbacks ─────────────────────────────────────────────────────────────
// The coordinator doesn't know about Jotai, React, or the code generator.
// It communicates results via callbacks. The Canvas component provides these.

export interface DragCallbacks {
  /** Called with snap guides to render (or empty to clear) */
  onSnapGuidesChange: (guides: SnapGuide[]) => void;

  /** Called with spacing distance bands to render (or empty to clear) */
  onSpacingGuidesChange: (guides: SpacingGuide[]) => void;

  /** Called when drag completes with pending updates to commit to code */
  onCommit: (updates: PendingUpdate[]) => void;

  /** Called to highlight a parent frame (or null to clear) */
  onHighlightParent: (parentId: string | null, vpId?: string) => void;

  /** Called when drag starts/ends (for UI state like cursor changes).
   *  `strategyName` is the active strategy at the moment the state
   *  flipped — so consumers can gate behavior per strategy (auto-pan
   *  is intentionally disabled for `toolbar` drags so dragging from
   *  the left sidebar's Library / Insert panels doesn't immediately
   *  trigger a left-edge pan that breaks the strategy's hit-test). */
  onDragStateChange: (isDragging: boolean, strategyName?: string) => void;

  /** Get the current code string (needed for DragContext) */
  getCode: () => string;

  /** Get the current parsed nodes */
  getNodes: () => NodeMap;

  /** Get the current selected IDs */
  getSelectedIds: () => string[];

  /** Get the current transform */
  getTransform: () => Transform;

}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Start position (in the group's viewBox space) for an SVG group child
 *  (nested `<svg>` positioned by x/y ATTRS). The PAINTED position on the
 *  active variant is:
 *    - `variants[active].attrX/attrY` when present — ABSOLUTE per-variant
 *      attribute positions (the current commit format; motion animates the
 *      real attributes through attrX/attrY, fully detached from primary).
 *    - else `base attrs + variants[active].x/y` — LEGACY translate-delta
 *      entries (still painted by foldMotionTransforms on old files).
 *    - else the base attrs (primary / page replicas).
 *  Baselining from the base attrs alone made variant drags commit positions
 *  offset by the active override — the mouseup jump. vpId 'desktop' maps to
 *  the 'default' variant. Exported for tests. */
export function svgGroupChildStartPosition(
  node: { attrs?: Record<string, string> | null; motionVariants?: Record<string, Record<string, string>> | null } | null | undefined,
  vpId: string,
): { x: number; y: number } {
  const variantName = vpId === 'desktop' ? 'default' : vpId;
  // Inheritance: untouched variants paint the default entry's motion values.
  const vgOwn = node?.motionVariants?.[variantName];
  const vgDefault = variantName !== 'default' ? node?.motionVariants?.default : undefined;
  const variantGeom = (vgOwn || vgDefault) ? { ...(vgDefault ?? {}), ...(vgOwn ?? {}) } : undefined;
  const num = (v: string | number | undefined): number => {
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };
  const hasAbs = (v: string | number | undefined): boolean =>
    v != null && v !== '' && Number.isFinite(parseFloat(String(v)));
  // Per-variant SCALE (the size channel — replica-context groupChildBoxToMotion):
  // the fill-box 50% origin grows the box around its CENTER, so the PAINTED
  // top-left includes a base·(1 − s)/2 term. The drag baseline must read the
  // painted edge, not the raw delta sum — otherwise a scaled child jumps by
  // that term on the first variant drag after a resize.
  const numOr1 = (v: string | number | undefined): number => {
    if (v == null || v === '') return 1;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 1;
  };
  const sx = numOr1(variantGeom?.scaleX);
  const sy = numOr1(variantGeom?.scaleY);
  // GEOMETRY channel (rotated children): painted size = px METADATA in the
  // entry (size baked into per-variant inner `d`s); falls back to attr×scale.
  const metaW = num(variantGeom?.width);
  const metaH = num(variantGeom?.height);
  const paintedW = metaW > 0 ? metaW : num(node?.attrs?.width) * sx;
  const paintedH = metaH > 0 ? metaH : num(node?.attrs?.height) * sy;
  return {
    x: hasAbs(variantGeom?.attrX)
      ? num(variantGeom?.attrX)
      : num(node?.attrs?.x) + num(variantGeom?.x) + (num(node?.attrs?.width) - paintedW) / 2,
    y: hasAbs(variantGeom?.attrY)
      ? num(variantGeom?.attrY)
      : num(node?.attrs?.y) + num(variantGeom?.y) + (num(node?.attrs?.height) - paintedH) / 2,
  };
}

// ─── Coordinator ───────────────────────────────────────────────────────────

export class DragCoordinator {
  private containerEl: HTMLElement;
  private contentEl: HTMLElement;
  private callbacks: DragCallbacks;

  // Available strategies (checked in order — first canHandle() wins)
  // Order matters: more specific strategies first, canvas drag is the fallback.
  // GridDragStrategy sits BEFORE LayoutLiftedStrategy because the latter
  // hard-bails on grid parents now — without this ordering, a grid child
  // would fall through to AbsoluteInFrameStrategy / CanvasDragStrategy
  // and lose its cell-aware swap behavior.
  private strategies: DragStrategy[] = [
    OverlayDragStrategyInstance,      // overlay nodes → offset from trigger, no drop targets
    new GridDragStrategy(),           // grid children → cell-aware swap (explicit) or reorder (auto-flow)
    new LayoutLiftedStrategy(),       // flex/block children → lift + placeholder + order-based reorder
    new AbsoluteInFrameStrategy(),    // absolute children inside a frame → position relative to parent
    new CanvasDragStrategy(),         // fallback — absolute on canvas root
  ];

  // Active drag state
  private context: DragContext | null = null;
  private activeStrategy: DragStrategy | null = null;
  private isDragStarted = false;   // true after threshold met and strategy.onStart called
  private pendingNodeId: string | null = null;
  private pendingMouseEvent: MouseEvent | null = null;
  private pendingViewportPrefix: string = '';
  private dragStartRootRects = new Map<string, DOMRect>();
  private pendingGripAxis: 'x' | 'y' | null = null;
  // Latest cursor position seen by handleMouseMove. Auto-pan needs this so
  // it can replay onMove with the same screen coords after panning the
  // canvas — otherwise the strategy would only repaint when the user
  // physically moves the mouse, and the dragged element would lag the
  // cursor while panning.
  private lastMouseScreen: Point = { x: 0, y: 0 };

  // Alt-duplicate state. While ALT is held during a drag, a "ghost"
  // copy of every dragged node is committed in real time at its drag-
  // START position. Releasing ALT removes them again. Mouseup with
  // ALT held leaves them in place (they're already in source). The
  // map tracks `originalId → duplicateId` so we can remove the right
  // node on ALT keyup / cancel.
  private altDuplicateIds: Map<string, string> = new Map();
  private altDuplicateKeyListeners: (() => void) | null = null;

  // Toolbar drag state
  private toolbarItem: ToolbarItem | null = null;
  private toolbarStrategy: ToolbarDragStrategy = new ToolbarDragStrategy();

  constructor(
    containerEl: HTMLElement,
    contentEl: HTMLElement,
    callbacks: DragCallbacks,
  ) {
    this.containerEl = containerEl;
    this.contentEl = contentEl;
    this.callbacks = callbacks;
  }

  /** True when window-level listeners handle mousemove (React handlers should skip) */
  get hasWindowListeners(): boolean { return this.pendingWindowListeners !== null; }

  /** The viewport prefix of the last/current drag (for commit routing) */
  get lastDragViewportPrefix(): string { return this.context?.viewportPrefix ?? this.pendingViewportPrefix ?? ''; }

  /** Update refs if DOM elements change */
  updateRefs(containerEl: HTMLElement, contentEl: HTMLElement) {
    this.containerEl = containerEl;
    this.contentEl = contentEl;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Called on mousedown on a node. Doesn't start drag yet — waits for threshold.
   */
  /** Window-level mousemove/mouseup listeners for drag — bypasses React event system
   *  which can be blocked by synchronous re-renders during selection change. */
  private pendingWindowListeners: (() => void) | null = null;

  /** Renderer drag-lock for the dragged node(s) — ALL strategies. A mid-drag
   *  render (structural reparent forceRender, mutation-queue flush) re-applies
   *  the COMMIT-TIME left/top/transform to the dragged element; before the
   *  incremental-render speedups those renders were slow/rare enough to hide
   *  it, now they land fast and the element visibly snapped "off and on"
   *  during exit/entry (live find 2026-07-17). LayoutLiftedStrategy manages
   *  its own richer lock set (dragged + neutralized siblings) — the central
   *  lock skips it to avoid clobbering.  */
  private setCentralDragLocks(ids: string[]): void {
    const bridge = getCanvasBridge();
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds(ids);
      trace.action('drag:central-locks', { ids });
    }
  }

  /** Bumped on every lock (re-)arm AND on reset — a pending deferred unlock
   *  (see reset()) only fires if no newer arm happened in the meantime. */
  private lockGeneration = 0;

  private applyCentralDragLocks(): void {
    if (!this.context || !this.activeStrategy) return;
    if (this.activeStrategy.name === 'layout-lifted') return;
    this.lockGeneration++;
    this.setCentralDragLocks(this.context.draggedNodes.map(n => n.id));
  }

  startPending(nodeId: string, event: MouseEvent, viewportPrefix: string = '', options?: { gripAxis?: 'x' | 'y' }): void {
    // View-only: viewers can SELECT a node (the caller still runs the
    // selection set) but never drag it. Bailing here keeps selection
    // working while no drag pending/active state is ever created.
    if (isViewerMode()) {
      trace.action('drag:pending-blocked-viewer', { nodeId });
      return;
    }
    // If there's an active drag (shouldn't happen, but safety), cancel it first
    if (this.isDragStarted) {
      this.cancel();
    }
    this.pendingNodeId = nodeId;
    this.pendingMouseEvent = event;
    this.pendingViewportPrefix = viewportPrefix;
    this.pendingGripAxis = options?.gripAxis ?? null;
    trace.action('drag:pending', { nodeId, viewportPrefix, gripAxis: this.pendingGripAxis, mouse: { x: event.clientX, y: event.clientY } });

    // Attach window-level mousemove during PENDING phase only.
    // React's onMouseMove can be blocked when heavy re-renders (from selection change)
    // monopolize the main thread. Window listeners bypass React's event system.
    // Once drag STARTS, clean up — React handlers take over for the active drag.
    this.cleanupPendingWindowListeners();
    const onMove = (e: MouseEvent) => {
      this.handleMouseMove(e);
    };
    const onUp = () => {
      this.handleMouseUp();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    this.pendingWindowListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }

  /**
   * Start a toolbar drag — element being dragged from the insert panel.
   * No threshold needed (drag intent is unambiguous from toolbar).
   * Strategy is selected explicitly (not via canHandle scan).
   */
  startToolbarDrag(item: ToolbarItem, event: PointerEvent): void {
    // If there's an active drag, cancel it first
    if (this.isDragStarted) {
      this.cancel();
    }

    this.toolbarItem = item;
    trace.action('drag:toolbar-start', { itemId: item.id, elementType: item.elementType });

    // Build minimal context (no draggedNodes — they don't exist yet)
    this.context = {
      draggedNodes: [],
      startMouse: { x: event.clientX, y: event.clientY },
      transform: this.callbacks.getTransform(),
      containerRect: this.containerEl.getBoundingClientRect(),
      contentEl: this.contentEl,
      code: this.callbacks.getCode(),
      nodes: this.callbacks.getNodes(),
      selectedIds: [],
      modifiers: { alt: false, shift: false, ctrl: false },
      viewportPrefix: '',
    };

    // Activate toolbar strategy directly
    this.toolbarStrategy.setToolbarItem(item);
    this.activeStrategy = this.toolbarStrategy;
    this.activeStrategy.onStart(this.context);
    this.isDragStarted = true;
    dragStateOps.set(true);
    this.callbacks.onDragStateChange(true, this.activeStrategy.name);

    // Window-level pointer listeners (same pattern as startPending)
    this.cleanupPendingWindowListeners();
    const onMove = (e: PointerEvent) => {
      this.handleMouseMove(e as any);
    };
    const onUp = () => {
      this.handleMouseUp();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.pendingWindowListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    // Synthetic onMove with the triggering event's coords so the strategy
    // computes its first drop target / indicator state RIGHT AWAY. The
    // Library panel calls `startToolbarDrag` from inside its own
    // pointermove handler (after the click→drag threshold is met). Window
    // listeners registered during the dispatch of that pointermove don't
    // fire for the same event in most browsers, so the strategy's onMove
    // would otherwise wait for the NEXT pointermove tick — and if the
    // user has already crossed into the iframe by then, the parent window
    // never sees that next event (the iframe captures it via
    // canvas-dnd) so indicators never show. The Insert panel doesn't hit
    // this because its drag starts on pointerdown — by the time the user
    // moves to threshold the listeners are long-since-registered and have
    // fired many times. Forcing one synthetic onMove makes both call
    // sites behave identically.
    this.handleMouseMove(event);
  }

  private cleanupPendingWindowListeners(): void {
    if (this.pendingWindowListeners) {
      this.pendingWindowListeners();
      this.pendingWindowListeners = null;
    }
  }

  /**
   * Called on every mousemove. Handles threshold detection and delegates to strategy.
   */
  handleMouseMove(event: MouseEvent): void {
    // If no pending drag, nothing to do
    if (!this.pendingNodeId && !this.isDragStarted) return;

    // Check threshold (haven't started drag yet)
    if (this.pendingNodeId && !this.isDragStarted) {
      const dx = event.clientX - (this.pendingMouseEvent?.clientX ?? 0);
      const dy = event.clientY - (this.pendingMouseEvent?.clientY ?? 0);

      if (Math.abs(dx) < MIN_DRAG_DISTANCE && Math.abs(dy) < MIN_DRAG_DISTANCE) {
        return; // Below threshold, not a drag yet
      }

      // TRANSLATION MODE: dragging is disabled — locale mode edits
      // translations only (localization overhaul Phase 2). Blocked HERE
      // (threshold crossing), NOT in startPending: the mousedown flow's
      // bookkeeping (lastClick → dblclick text-edit detection, selection)
      // must run untouched — an early startPending bail broke canvas
      // double-click text editing in translation mode.
      if (!getDefaultStore().get(isDefaultLocaleAtom)) {
        trace.action('drag:threshold-blocked-translation-mode', { nodeId: this.pendingNodeId });
        this.pendingNodeId = null;
        this.pendingMouseEvent = null;
        return;
      }

      // Threshold met — initialize drag
      this.initializeDrag(this.pendingNodeId, this.pendingMouseEvent!);
      this.pendingNodeId = null;
      this.pendingMouseEvent = null;

      if (!this.isDragStarted) return; // initializeDrag failed
    }

    // Delegate to active strategy
    if (!this.activeStrategy || !this.context) return;

    const mouseScreen: Point = { x: event.clientX, y: event.clientY };
    this.lastMouseScreen = mouseScreen;
    const mouseDelta: Point = {
      x: event.clientX - this.context.startMouse.x,
      y: event.clientY - this.context.startMouse.y,
    };

    // Update modifier keys (they can change during drag)
    this.context.modifiers.shift = event.shiftKey;
    this.context.modifiers.alt = event.altKey;

    const result = this.activeStrategy.onMove(this.context, mouseScreen, mouseDelta);

    // Keep any open overlay glued to its (dragged) trigger live — reads the
    // trigger's cached rect (already snapped) per viewport.
    updateOverlayFollow();

    // ─── Mid-drag strategy switching ───
    if (result.switchRequest) {
      trace.action('drag:strategy-switch', {
        from: this.activeStrategy.name,
        to: result.switchRequest.toStrategy,
        reason: result.switchRequest.reason,
      });

      // Strategy switch — no deferred updates needed (code commits happen immediately)
      const newStrategy = this.strategies.find(s => s.name === result.switchRequest!.toStrategy);
      if (newStrategy) {
        trace.action('drag:switch-pre-rebuild', {
          from: this.activeStrategy.name,
          to: result.switchRequest.toStrategy,
          skipRebuild: !!result.switchRequest.skipRebuild,
          hasOverrides: !!result.switchRequest.nodeStateOverrides,
          mouseScreen: { x: event.clientX, y: event.clientY },
          existingNodes: this.context.draggedNodes.map(n => ({
            id: n.id, startLeft: n.startLeft, startTop: n.startTop, parent: n.startParentId,
            mouseOffsetX: n.mouseOffsetX, mouseOffsetY: n.mouseOffsetY,
          })),
        });
        if (result.switchRequest.skipRebuild && result.switchRequest.nodeStateOverrides) {
          // Strategy already wrote authoritative coords — apply them in place
          // and just refresh startMouse + transform so the new strategy's
          // dx/dy starts at zero. Avoids the rebuild-from-stale-cache problem.
          const overrides = result.switchRequest.nodeStateOverrides;
          for (const node of this.context.draggedNodes) {
            const o = overrides.get(node.id);
            if (o) {
              node.startLeft = o.startLeft;
              node.startTop = o.startTop;
              node.startParentId = o.startParentId;
              // Optional dim override — set by exit handlers that
              // know the dragged's post-commit AABB (e.g. exit from
              // a rotated parent, where the lift-time AABB was
              // inflated by the parent's rotation). Without this,
              // the receiving strategy keeps using the inflated
              // width/height for snap math and edge-snap fires off
              // by AABB-extra/2 until the bridge rectCache catches
              // up — typically only after the user releases and
              // re-grabs.
              if (typeof o.width === 'number') node.width = o.width;
              if (typeof o.height === 'number') node.height = o.height;
              // Transform override — exiting strategy stripped translates
              // from the source `transform`; the receiving strategy needs
              // this so its `originalTransforms` doesn't re-compose with
              // the stale source value (context.nodes might not reflect
              // the just-flushed commit yet).
              if (typeof o.transform === 'string') {
                node.transformOverride = o.transform;
              }
            }
          }
          this.context = {
            ...this.context,
            startMouse: { x: event.clientX, y: event.clientY },
            transform: this.callbacks.getTransform(),
            containerRect: this.containerEl.getBoundingClientRect(),
            code: this.callbacks.getCode(),
            nodes: this.callbacks.getNodes(),
            // Variant exit hoists the dragged to canvas root (no
            // prefix). The new strategy's bridge calls must use the
            // updated prefix or they'll target a non-existent
            // `<oldPrefix><cloneId>` and the drag visibly freezes.
            ...(result.switchRequest.newViewportPrefix !== undefined
              ? { viewportPrefix: result.switchRequest.newViewportPrefix }
              : {}),
          };
          trace.action('drag:context-skipped-rebuild', {
            nodeCount: this.context.draggedNodes.length,
            startMouse: this.context.startMouse,
            nodes: this.context.draggedNodes.map(n => ({
              id: n.id, left: n.startLeft, top: n.startTop, parent: n.startParentId,
              mouseOffsetX: n.mouseOffsetX, mouseOffsetY: n.mouseOffsetY,
            })),
          });
        } else {
          this.rebuildContext(event);
        }
        newStrategy.onStart(this.context);
        this.activeStrategy = newStrategy;
        this.applyCentralDragLocks();

        trace.action('drag:strategy-switch-complete', {
          newStrategy: newStrategy.name,
          nodeCount: this.context.draggedNodes.length,
        });
      }
    }

    // Update visual helpers
    this.callbacks.onSnapGuidesChange(result.snap?.guides ?? []);
    this.callbacks.onSpacingGuidesChange(result.snap?.spacingGuides ?? []);
    // Suppress parent border when a line indicator (dropTarget) is active —
    // the line indicator already makes the target container obvious.
    this.callbacks.onHighlightParent(
      result.dropTarget ? null : result.highlightParentId,
      result.highlightVpId,
    );

    trace.fn('drag:move-result', { strategy: this.activeStrategy.name, snap: !!result.snap, switchRequest: result.switchRequest?.toStrategy });
  }

  /**
   * Called on mouseup. Commits the drag result to code.
   */
  handleMouseUp(): void {
    this.cleanupPendingWindowListeners();
    endOverlayFollow(); // commit re-render repositions the overlay from the trigger's final spot
    // Always clear pending state on mouseUp (prevents stale state on re-click)
    if (!this.isDragStarted) {
      this.pendingNodeId = null;
      this.pendingMouseEvent = null;
      return;
    }

    if (!this.activeStrategy || !this.context) {
      this.reset();
      return;
    }

    trace.action('drag:end', { strategy: this.activeStrategy.name, nodeIds: this.context.selectedIds });
    const endingStrategyName = this.activeStrategy.name;

    // Get pending updates from strategy
    const updates = this.activeStrategy.onEnd(this.context);
    trace.fn('strategy.onEnd', { updates });

    // A node that ended up on the CANVAS lives in no viewport, but
    // `interactingViewportIdAtom` still names the tile the drag STARTED in
    // (e.g. `tablet`). The selection overlay resolves the selected id under
    // that viewport's prefix, so it looks for a tablet copy that no longer
    // exists: `selection-overlay:poll-resolve … found: false`, a box painted
    // from the last cached rect, Layers showing nothing selected, and style
    // edits landing nowhere (reported 2026-08-24, three times — the first two
    // fixes addressed the grid exit, but the trace shows `strategy: canvas`
    // with zero grid actions, so the culprit was never the strategy).
    //
    // Re-point the viewport at the primary — the prefix a canvas node renders
    // under — so the overlay, the Layers panel and every tool resolve the same
    // element the user is looking at.
    {
      const nodes = getNodesSnapshot();
      // Two shapes of canvas drop, and the REPLICA one is not visible in
      // `selectedIds`:
      //  • PRIMARY drag-out is a `move` — the dragged id itself becomes a
      //    canvas node, so looking it up in the node map answers the question.
      //  • REPLICA drag-out is `hideInThis` + `add` — the SOURCE stays in its
      //    parent (merely hidden on this replica) and the canvas node is a
      //    CLONE with a fresh id, which the orchestrator selects. Checking only
      //    `selectedIds` therefore said "not a canvas drop", the viewport stayed
      //    on `tablet`, and the overlay resolved the freshly-selected clone
      //    under a prefix it does not render in — a ghost box drawn from stale
      //    corners while the panel showed the clone's real values (reported
      //    2026-08-24; this is what the earlier attempts missed).
      //  • MOVE INTO a canvas-rooted parent — entering a new parent mid-drag
      //    hands off to CanvasDragStrategy, which emits a plain `move` with a
      //    `newParentId`. The node map still holds the PRE-move parent at this
      //    point, so the destination has to come from the update itself.
      const landsOnCanvas = (parentId: string | null | undefined): boolean => {
        if (parentId === null) return true;      // canvas root
        if (!parentId) return false;             // undefined → not a move
        let cursor: string | null | undefined = parentId;
        for (let hops = 0; cursor && hops < 50; hops++) {
          const n = nodes.get(cursor);
          if (!n) return false;
          if (n.isCanvasNode) return true;       // inside a free canvas frame
          cursor = n.parentId;
        }
        return false;                            // reached a viewport root
      };
      const droppedOnCanvas =
        updates.some((u) => u.type === 'add' && !!u.descriptor)
        || updates.some((u) => u.type === 'move' && landsOnCanvas(u.newParentId))
        || (this.context?.selectedIds ?? []).some((id) => {
          const n = nodes.get(id);
          return !!n && n.parentId === null;
        });
      // INBOUND: dropped INTO a viewport. `context.viewportPrefix` is where the
      // drag STARTED — exactly wrong here — so the destination comes from the
      // strategy.
      const ctx = this.context;
      const dropVpId = ctx
        ? (this.activeStrategy as { getDropViewportId?: (c: DragContext) => string | undefined })
            .getDropViewportId?.(ctx)
        : undefined;
      if (!droppedOnCanvas && dropVpId) {
        const store = getDefaultStore();
        if (store.get(interactingViewportIdAtom) !== dropVpId) {
          trace.action('drag:viewport-drop-adopt-viewport', {
            from: store.get(interactingViewportIdAtom), to: dropVpId,
          });
          store.set(interactingViewportIdAtom, dropVpId);
        }
      }
      if (droppedOnCanvas) {
        const store = getDefaultStore();
        const vps = store.get(visibleViewportsAtom);
        const primaryId = (vps.find((v) => v.isPrimary) ?? vps[0])?.id;
        if (primaryId && store.get(interactingViewportIdAtom) !== primaryId) {
          trace.action('drag:canvas-drop-reset-viewport', {
            from: store.get(interactingViewportIdAtom), to: primaryId,
            nodeIds: this.context?.selectedIds,
          });
          store.set(interactingViewportIdAtom, primaryId);
        }
      }
    }

    // Clear visual helpers
    this.callbacks.onSnapGuidesChange([]);
    this.callbacks.onSpacingGuidesChange([]);
    this.callbacks.onHighlightParent(null);
    this.callbacks.onDragStateChange(false, endingStrategyName);

    // No deferred updates or viewport exit handling needed —
    // entry/exit mutations are committed during drag via flushNow().
    // onEnd only produces final position updates (left/top).

    // ALT-DUPLICATE — the ghost was committed live on ALT keydown via
    // `applyAltDuplicateState(true)` (for both absolute AND flow
    // strategies). If ALT was released before mouseup, the keyup listener
    // already removed them. If ALT is still held at mouseup, the
    // duplicates stay in source. For flow duplicates, also clear the
    // `data-alt-duplicate` marker so the node becomes a regular permanent
    // sibling (the strategy's reorder filter only applied during drag).
    if (this.context?.modifiers?.alt && this.altDuplicateIds.size > 0) {
      const wasFlowStrategy = endingStrategyName === 'layout-lifted' || endingStrategyName === 'grid';
      trace.action('drag:alt-duplicate-kept-on-mouseup', {
        count: this.altDuplicateIds.size,
        pairs: Array.from(this.altDuplicateIds.entries()),
        flow: wasFlowStrategy,
      });
      // STRUCTURAL RENDER OWED. The duplicate was created mid-drag via
      // `addNode`, and drag-scoped flushes are STASHED (deferred-drag-flush) with
      // their drain deferred to fan-out — so the new node exists in source but
      // never gets a render that materializes it. Starting another alt-drag
      // re-defers the drain, which is why several duplicates stayed invisible
      // and then all appeared at once when the user finally stopped
      // ("nothing happens for 3 drags then suddenly all the duplicates appear",
      // 2026-08-08). Mark the render owed so the post-drag flush carries the
      // new node instead of being skipped as a no-op re-render.
      setForceRender();

      if (wasFlowStrategy) {
        // Duplicate is already a real flex sibling at its source index
        // and was participating in reorder calcs throughout the drag.
        // The only thing to "settle" is the `data-alt-duplicate`
        // marker — we used it to identify ghosts at alt-up / cancel
        // / mouseup. Clear it so the node is indistinguishable from
        // any other sibling going forward. Strategy `cleanup` already
        // unwound the spaced-rank `order` neutralization on all
        // siblings, so the duplicate now sits at its natural source
        // position with the placeholder's original order — exactly
        // where the dragged element used to be.
        for (const [, dupId] of this.altDuplicateIds) {
          queueMutation({
            type: 'updateHtmlAttrs',
            nodeId: dupId,
            attrs: { 'data-alt-duplicate': '' },
          });
        }
      }
    }
    this.teardownAltDuplicate();
    this.altDuplicateIds.clear();

    // Commit to code
    if (updates.length > 0) {
      this.callbacks.onCommit(updates);
    }

    this.reset();
  }

  /**
   * Cancel the current drag (e.g., Escape key).
   */
  cancel(): void {
    this.cleanupPendingWindowListeners();
    endOverlayFollow();
    const cancellingStrategyName = this.activeStrategy?.name;
    if (this.activeStrategy && this.context) {
      this.activeStrategy.onCancel(this.context);
    }
    // Cancel = user pressed Esc. Throw away any ALT-duplicate ghost
    // (treat as a non-commit) so the cancelled drag leaves no
    // accidental copies behind.
    this.applyAltDuplicateState(false);
    this.teardownAltDuplicate();
    this.altDuplicateIds.clear();

    this.callbacks.onSnapGuidesChange([]);
    this.callbacks.onSpacingGuidesChange([]);
    this.callbacks.onHighlightParent(null);
    this.callbacks.onDragStateChange(false, cancellingStrategyName);
    this.reset();
  }

  /**
   * Whether a drag is currently in progress.
   */
  get isDragging(): boolean {
    return this.isDragStarted;
  }

  /**
   * Auto-pan compensation hook — called by the AutoPan loop after each
   * canvas pan tick. Bumps `context.startMouse` by the pan delta so the
   * next `mouseScreen - startMouse` calculation produces a `mouseDelta`
   * that already accounts for the pan, then re-runs the active strategy's
   * `onMove` with the LAST seen screen position. Net effect: the dragged
   * element stays anchored under the cursor while the canvas slides
   * underneath.
   *
   * Math (proof for `startMouse += panDx`):
   *   mouseDelta = mouseScreen - startMouse
   *   nodeLeft   = startLeft + mouseDelta / scale
   *   After pan, we want nodeLeft to decrease by panDx/scale (the canvas
   *   moved right by panDx in screen space, so the element's canvas-space
   *   position must drop by that amount to remain under the cursor).
   *   Adding panDx to startMouse subtracts panDx from mouseDelta — exactly
   *   the desired offset. Sign convention matches `transformManager.pan(dx, dy)`.
   *
   * @param panDx - Pan delta in screen px (X axis). Positive = canvas right.
   * @param panDy - Pan delta in screen px (Y axis). Positive = canvas down.
   */
  compensateAutoPan(panDx: number, panDy: number): void {
    if (!this.isDragStarted || !this.context || !this.activeStrategy) return;

    this.context.startMouse.x += panDx;
    this.context.startMouse.y += panDy;

    // Refresh transform on context so strategies that read `context.transform.scale`
    // (or .x/.y) see the post-pan values. Without this, the per-tick onMove
    // computes against the stale snapshot taken at drag start.
    this.context.transform = this.callbacks.getTransform();

    // Re-emit onMove with the unchanged screen position so the dragged
    // element repaints from the compensated baseline. Without this, the
    // canvas pans but the element only catches up on the next physical
    // mousemove — visible lag.
    const mouseScreen: Point = { ...this.lastMouseScreen };
    const mouseDelta: Point = {
      x: mouseScreen.x - this.context.startMouse.x,
      y: mouseScreen.y - this.context.startMouse.y,
    };
    try {
      this.activeStrategy.onMove(this.context, mouseScreen, mouseDelta);
    } catch (err) {
      trace.error('drag:compensate-autopan-onMove-failed', err);
    }
  }

  /**
   * Whether a drag is pending (mousedown happened, threshold not met yet).
   */
  get isPending(): boolean {
    return this.pendingNodeId !== null;
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private initializeDrag(nodeId: string, event: MouseEvent): void {
    const transform = this.callbacks.getTransform();
    const nodes = this.callbacks.getNodes();
    const selectedIds = this.callbacks.getSelectedIds();
    const code = this.callbacks.getCode();
    const containerRect = this.containerEl.getBoundingClientRect();

    // Build dragged node list (either just clicked node, or all selected if clicked is selected)
    const rawIdsToDrag = selectedIds.includes(nodeId) ? selectedIds : [nodeId];

    // Filter to TOP-LEVEL nodes only. If a user multi-selects a parent
    // AND one of its descendants, dragging the parent already moves the
    // descendant via the parent's transform — moving the descendant
    // INDEPENDENTLY as well double-applies the delta and the descendant
    // shoots off relative to the parent. Drop any node whose ancestor
    // is also in the drag list. Same behavior as the old builder:
    // multi-select drag operates only on the topmost selected nodes.
    const dragSet = new Set(rawIdsToDrag);
    const idsToGrag = rawIdsToDrag.filter(id => {
      let walker: string | null = id;
      // Walk ancestors; if any is in the drag set, drop this id.
      const node = getNodeFromCache(id) ?? nodes.get(id);
      walker = node?.parentId ?? null;
      while (walker) {
        if (dragSet.has(walker)) return false;
        const wn = getNodeFromCache(walker) ?? nodes.get(walker);
        walker = wn?.parentId ?? null;
      }
      return true;
    });
    if (idsToGrag.length !== rawIdsToDrag.length) {
      trace.action('dragcoord:filter-descendants', {
        before: rawIdsToDrag.length, after: idsToGrag.length,
        dropped: rawIdsToDrag.filter(id => !idsToGrag.includes(id)),
      });
    }

    const draggedNodes: DraggedNode[] = [];
    const vpPrefix = this.pendingViewportPrefix;
    const vpId = vpIdFromPrefix(vpPrefix);
    const nodeCtx = { contentEl: this.contentEl, viewportPrefix: vpPrefix };
    for (const id of idsToGrag) {
      // Read from internal cache directly (bypasses atom staleness after prior drag/resize)
      const node = getNodeFromCache(id) ?? nodes.get(id);

      // Use bridge helper for geometry reads (elements live in the sandbox iframe)
      const elRect = findNodeRect(id, vpId);
      if (!elRect) continue;

      // Read startLeft/startTop from the element's actual RENDERED CSS
      // values, not the JSX inline base. For component master variants
      // the visible element's left/top is the variants[active] value
      // applied by framer-motion at runtime — `node.styles` only
      // reflects the JSX inline base (the master/default values), so
      // `parseFloat(node.styles.left)` gives a stale "what the JSX
      // declares" rather than "where the user actually sees the
      // element". Using the wrong base mid-drag → cs.left =
      // staleLeft + dx instead of renderedLeft + dx → on commit, the
      // element jumps to the stale-derived position. That's the
      // user-reported "drag drops it offset from where I let go".
      //
      // The bridge's `findNodeComputedStyles` reads `getComputedStyle`
      // from the iframe (correctly reflects framer-motion's animate
      // assignments). For rotated elements `getComputedStyle().left`
      // is still the CSS-declared (non-rotated) value, which is what
      // the strategy needs.
      // SVG-group child fast-path: nested `<svg>` elements positioned via
      // `x/y` ATTRS (not CSS) report `left/top: auto` from getComputedStyle,
      // so the CSS-based read below would return 0 — the drag would then
      // compute new position = `0 + mouseDelta` instead of `actualX +
      // mouseDelta`, dropping the child wildly far from where the user
      // released. Read from the parser-extracted `node.attrs.x/y` instead.
      // We override startLeft/startTop here, then fall through to the
      // standard `draggedNodes.push(...)` so mouseOffset/width/height/etc
      // come from the same code path as every other drag (no missing
      // fields → no mid-drag freeze).
      const parentNodeForStart = node?.parentId ? (getNodeFromCache(node.parentId) ?? nodes.get(node.parentId)) : undefined;
      const isSvgGroupChild = node?.type === 'svg' && parentNodeForStart?.type === 'svg';
      let startLeft: number;
      let startTop: number;
      const computed = findNodeComputedStyles(id, vpId, ['left', 'top']);
      const cssLeft = computed.left && computed.left !== 'auto' ? parseFloat(computed.left) : NaN;
      const cssTop = computed.top && computed.top !== 'auto' ? parseFloat(computed.top) : NaN;
      if (isSvgGroupChild) {
        // PAINTED position, not base attrs. On a non-primary variant the
        // child paints at `base attrs + variants[variant].x/y` (per-variant
        // translate DELTAS — motion transform on live, foldMotionTransforms
        // on canvas; replica-context's leftTopToXY commits the same delta
        // form). Baselining from the base attrs alone committed positions
        // offset by the previous delta — the variant-replica mouseup jump.
        const pos = svgGroupChildStartPosition(node, vpId);
        startLeft = pos.x;
        startTop = pos.y;
      } else if (Number.isFinite(cssLeft) && Number.isFinite(cssTop)) {
        startLeft = cssLeft;
        startTop = cssTop;
      } else if (node?.styles?.left != null && node?.styles?.top != null) {
        startLeft = parseFloat(node.styles.left) || 0;
        startTop = parseFloat(node.styles.top) || 0;
      } else if (elRect) {
        // FALLBACK FOR VARIANT ROOTS: top-level nodes in a component
        // master store their canvas position in variantConfig.x/y, NOT
        // in inline left/top. Derive from screen rect.
        const t = transform;
        const offset = getIframeOffset();
        startLeft = Math.round((elRect.left - offset.x - t.x) / (t.scale || 1));
        startTop = Math.round((elRect.top - offset.y - t.y) / (t.scale || 1));
      } else {
        startLeft = 0;
        startTop = 0;
      }

      draggedNodes.push({
        id,
        startLeft,
        startTop,
        mouseOffsetX: event.clientX - elRect.left,
        mouseOffsetY: event.clientY - elRect.top,
        width: elRect.width,
        height: elRect.height,
        startParentId: node?.parentId ?? null,
      });
    }

    if (draggedNodes.length === 0) return;

    // Phase D: Improved offset calculation for rotated/skewed elements.
    // Use bridge corners cache for visual center (works in iframe mode).
    for (const node of draggedNodes) {
      const corners = getScreenCornersById(node.id, vpId);
      if (corners) {
        // Check if corners differ from axis-aligned (indicates rotation)
        const rect = findNodeRect(node.id, vpId);
        if (rect) {
          const bcrCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          const visualCenter = getElementCenter(corners);
          // If visual center differs from BCR center, element is rotated
          if (Math.abs(visualCenter.x - bcrCenter.x) > 1 || Math.abs(visualCenter.y - bcrCenter.y) > 1) {
            node.mouseOffsetX = event.clientX - visualCenter.x;
            node.mouseOffsetY = event.clientY - visualCenter.y;
            trace.action('drag:transform-offset-corrected', {
              nodeId: node.id, visualCenter, bcrCenter,
              mouseOffset: { x: node.mouseOffsetX, y: node.mouseOffsetY },
            });
          }
        }
      }
    }

    // Build context
    this.context = {
      draggedNodes,
      startMouse: { x: event.clientX, y: event.clientY },
      transform,
      containerRect,
      contentEl: this.contentEl,
      code,
      nodes,
      selectedIds: idsToGrag,
      modifiers: {
        alt: event.altKey,
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
      },
      viewportPrefix: vpPrefix,
      gripAxis: this.pendingGripAxis ?? undefined,
    };

    // Fixed overlays (modals) are NOT draggable — they cover the whole viewport
    // and are positioned by the runtime/Renderer, not by canvas coords. Block the
    // drag entirely by leaving it un-started (isDragStarted / onDragStateChange
    // are set only AFTER strategy selection below, and onMove/onEnd no-op without
    // an active strategy). OverlayDragStrategy already declines fixed overlays,
    // but they're children of the viewport root so the AbsoluteInFrame fallback
    // would otherwise grab and move them.
    if (draggedNodes.length > 0 && draggedNodes.every(n => {
      const attr = nodes.get(n.id)?.attrs?.['data-overlay'];
      if (!attr) return false;
      try { return JSON.parse(attr).type === 'fixed'; } catch { return false; }
    })) {
      trace.action('drag:blocked-fixed-overlay', { nodeIds: draggedNodes.map(n => n.id) });
      return;
    }

    // Pick strategy (first that canHandle wins)
    this.activeStrategy = null;
    for (const strategy of this.strategies) {
      if (strategy.canHandle(this.context)) {
        this.activeStrategy = strategy;
        break;
      }
    }

    if (!this.activeStrategy) {
      trace.action('drag:fallback-to-canvas', { reason: 'no-strategy-matched' });
      this.activeStrategy = this.strategies[this.strategies.length - 1]; // CanvasDragStrategy
    }

    trace.action('drag:start', {
      strategy: this.activeStrategy.name,
      nodes: draggedNodes.map(n => ({ id: n.id, left: n.startLeft, top: n.startTop, parent: n.startParentId })),
      modifiers: this.context.modifiers,
    });

    // Start the strategy
    this.activeStrategy.onStart(this.context);
    this.applyCentralDragLocks();
    // Snapshot the dragged roots' SCREEN rects — the drag-end subtree cache
    // nudge (see handleMouseUp) shifts each root's descendants by the root's
    // own start→end screen delta.
    this.dragStartRootRects.clear();
    const startVpId = vpIdFromPrefix(this.context.viewportPrefix);
    for (const n of draggedNodes) {
      const startRect = findNodeRect(n.id, startVpId);
      if (startRect) this.dragStartRootRects.set(n.id, startRect);
    }
    // Glue any open overlay to its trigger if the trigger is being dragged, so
    // the overlay tracks it LIVE (every viewport, not just on mouse-up).
    beginOverlayFollow(this.context.nodes, draggedNodes.map(n => n.id), this.contentEl);
    this.isDragStarted = true;
    dragStateOps.set(true);
    this.callbacks.onDragStateChange(true, this.activeStrategy.name);
    this.installAltDuplicateKeyListeners();
    // If ALT was already held when the drag started (user pressed ALT
    // BEFORE clicking + dragging), the keydown listener won't fire —
    // OS-level key events for already-pressed keys don't generate a
    // new keydown when a different keydown (or our installation moment)
    // happens. Reconcile against the initial modifier state captured
    // from the triggering pointer event so the ghost appears on the
    // very first frame of the drag.
    if (this.context.modifiers.alt) {
      this.applyAltDuplicateState(true);
    }
  }

  /**
   * Window-level ALT keydown/keyup listeners installed on every drag start.
   * Why not piggyback on pointermove: pressing ALT without moving the mouse
   * wouldn't fire a pointermove, so the live ghost wouldn't appear until
   * the next cursor movement. Explicit key listeners give the user instant
   * feedback the moment they press ALT.
   */
  private installAltDuplicateKeyListeners(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (!this.context) return;
      this.context.modifiers.alt = true;
      this.applyAltDuplicateState(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Some browsers fire keyup with `e.altKey === true` if another key is
      // released — only treat as alt-release when ALT itself is the key.
      if (e.key !== 'Alt' && e.code !== 'AltLeft' && e.code !== 'AltRight') return;
      if (!this.context) return;
      this.context.modifiers.alt = false;
      this.applyAltDuplicateState(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.altDuplicateKeyListeners = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }

  /**
   * Reconcile alt-duplicate state. Adds duplicates if `active && none yet`;
   * removes them if `!active && some exist`. Idempotent — repeated calls
   * with the same state are no-ops. Source mutations are queued and
   * flushed synchronously so the iframe renders the ghost on the same
   * frame as the keypress.
   */
  private applyAltDuplicateState(active: boolean): void {
    if (!this.context || !this.isDragStarted) return;
    const strategyName = this.activeStrategy?.name;
    const isFlowStrategy = strategyName === 'layout-lifted' || strategyName === 'grid';
    if (active && this.altDuplicateIds.size === 0) {
      // Replica-aware: on a non-primary page viewport, the ALT-
      // duplicate must follow the same solo-replica visibility
      // pattern every other replica-creation does (inline
      // `display: 'none'` baseline + `@container display: <original>`
      // on the source vp + `@container display: 'none'` on every
      // OTHER vp). Otherwise the duplicate appears on every viewport
      // — bug the user reported on tablet, where the ghost showed on
      // desktop and mobile too.
      const vpId = this.context.viewportPrefix
        ? this.context.viewportPrefix.replace(/-$/, '')
        : 'desktop';
      const isReplica = !isPrimaryViewport(vpId);
      const vpWidths = getViewportWidths();
      const vpWidth = vpWidths[vpId] ?? 0;
      const rctx = isReplica
        ? getReplicaContext(vpId, getActiveFilePath(), vpWidths)
        : null;
      // BAKE THE TILE'S TRUTH INTO THE CLONE. Per-tile styles live in channels
      // keyed by the SOURCE's data-id (@media block, `<id>Variants` object,
      // inline `variant === …` ternaries), so a fresh-id clone inherits none
      // of them and would render the PRIMARY's values — the 100%-wide button
      // duplicated on variant-2 came out auto-width. Resolve what the tile
      // paints and write that in as the duplicate's flat base styles.
      const tile = tileContextFor(vpId, getActiveFilePath(), vpWidths);
      // For flow strategies (LayoutLifted), the duplicate is a CLEAN
      // REAL FLEX SIBLING inserted at the dragged element's original
      // source index, with the placeholder's spaced-rank `order` so
      // it visually lands at the original slot. It participates in
      // sibling reorder calculations like any other flex child —
      // placeholder dances around the duplicate naturally, drop
      // target lands wherever the placeholder is.
      const strategyInsertSpecFor = (originalId: string): {
        rank: number;
        insertIndex: number;
        parentId: string;
      } | null => {
        if (!isFlowStrategy) return null;
        const s = this.activeStrategy as DragStrategy & {
          getAltDuplicateInsertSpec?: (id: string) => {
            rank: number;
            insertIndex: number;
            parentId: string;
          } | null;
        };
        return s.getAltDuplicateInsertSpec ? s.getAltDuplicateInsertSpec(originalId) : null;
      };
      for (const draggedNode of this.context.draggedNodes) {
        const sourceNode = getNodeFromCache(draggedNode.id);
        if (!sourceNode) continue;
        // Subtree source→clone id map: ::after border-overlay rules are keyed
        // by data-id in the <style> block, so each clone needs its own copy
        // (queued below) or the duplicate silently loses its border.
        const dupIdMap = new Map<string, string>();
        const descriptor = buildDuplicateDescriptor(draggedNode.id, this.context.nodes, dupIdMap, tile);
        if (!descriptor) continue;
        const insertSpec = strategyInsertSpecFor(draggedNode.id);
        if (insertSpec) {
          // Flow strategies (flex/grid via LayoutLifted): the duplicate
          // is a CLEAN REAL FLEX SIBLING. SOURCE inherits the dragged
          // element's styles verbatim (including its existing
          // sequential `order`) — we do NOT write the spaced-rank
          // value (e.g. '40') into source. The spaced-rank order is
          // applied IMPERATIVELY to the iframe DOM via the strategy's
          // `reNeutralizeSiblingOrders` after every force-render
          // (which looks up `altDuplicateRanks` populated below). So
          // the visual position is correct during drag, but committed
          // code never contains the cryptic '40' / '50' values.
          descriptor.attrs = { ...(descriptor.attrs || {}), 'data-alt-duplicate': 'true' };
        } else {
          // Absolute strategies: duplicate goes at the drag's start spot.
          descriptor.styles = {
            ...descriptor.styles,
            left: `${draggedNode.startLeft}px`,
            top: `${draggedNode.startTop}px`,
          };
        }
        // On a replica: stamp the inline `display: 'none'` hide-baseline
        // before creating so every OTHER vp renders it hidden by default.
        const originalDisplay = descriptor.styles.display;
        if (isReplica) {
          descriptor.styles.display = 'none';
        }
        if (sourceNode.isCanvasNode || !draggedNode.startParentId) {
          queueMutation({ type: 'addCanvasNode', node: descriptor as any });
        } else if (insertSpec) {
          // Flow: real flex sibling at the original's source index.
          // Participates in reorder calculations like any other child.
          queueMutation({
            type: 'addNode',
            parentId: insertSpec.parentId,
            node: descriptor as any,
            index: insertSpec.insertIndex,
          });
        } else {
          queueMutation({
            type: 'addNode',
            parentId: draggedNode.startParentId,
            node: descriptor as any,
          });
        }
        if (isReplica && rctx) {
          // Hide on every OTHER vp via @container — matches the
          // canvas-node-into-replica entry recipe.
          for (const hideUpdate of rctx.hideInAllOthers(descriptor.id)) {
            queueMutation(hideUpdate as any);
          }
          // Unhide on the source vp — restore the original display
          // (flex/grid/etc.) so the layout survives.
          queueReplicaCreationUnhide(descriptor.id, vpId, vpWidth, originalDisplay);
        }
        // Copy ::after border-overlay rules onto the clones (whole subtree).
        queueBorderOverlayDuplicates(dupIdMap);
        this.altDuplicateIds.set(draggedNode.id, descriptor.id);
        // Notify the strategy about the new alt-duplicate. For flex
        // (LayoutLifted) this also registers the rank so
        // `reNeutralizeSiblingOrders` + `movePlaceholders` compute the
        // duplicate's spaced-rank `order` (rank * 10) for the iframe
        // DOM — keeps source clean while the visual position is
        // correct during drag. For grid the rank is unused (grid uses
        // `gridColumn` / `gridRow` placement) but the call still
        // refreshes the renderer drag-lock set so the duplicate's
        // inline `display: 'none'` baseline survives any subsequent
        // force-render that would otherwise re-apply source styles.
        if (isFlowStrategy) {
          const strategyWithRegister = this.activeStrategy as DragStrategy & {
            registerAltDuplicateRank?: (id: string, rank: number) => void;
          };
          strategyWithRegister.registerAltDuplicateRank?.(descriptor.id, insertSpec?.rank ?? 0);
        }
      }
      if (this.altDuplicateIds.size > 0) {
        // Force a render so the iframe paints the new ghost element NOW
        // — without this the canvasUpdating skip-flag would suppress
        // the post-flush render and the ghost wouldn't appear until
        // the next unrelated re-render.
        // ONE HISTORY ENTRY PER GESTURE. The duplicate's structural flush lands
        // immediately (it must, or the node never paints — see the stash
        // bypass), and the drop commit flushes again. Two flushes = two undo
        // steps, so the first Cmd+Z only appeared to change the selection and a
        // SECOND was needed to remove the node (2026-08-08). Hold the history
        // group open for the rest of the gesture so both merge into the single
        // entry the user thinks of as "the duplicate".
        holdHistoryCoalescing();
        setForceRender();
        flushNow();
        forceCanvasRender();
        trace.action('drag:alt-duplicate-ghost-show', {
          count: this.altDuplicateIds.size,
          pairs: Array.from(this.altDuplicateIds.entries()),
        });
        this.resyncDraggedAfterGhostChange();
      }
    } else if (!active && this.altDuplicateIds.size > 0) {
      const strategyWithUnregister = this.activeStrategy as DragStrategy & {
        unregisterAltDuplicateRank?: (id: string) => void;
      };
      for (const [, dupId] of this.altDuplicateIds) {
        queueMutation({ type: 'removeNode', nodeId: dupId });
        strategyWithUnregister.unregisterAltDuplicateRank?.(dupId);
      }
      const count = this.altDuplicateIds.size;
      this.altDuplicateIds.clear();
      setForceRender();
      flushNow();
      forceCanvasRender();
      trace.action('drag:alt-duplicate-ghost-hide', { count });
      this.resyncDraggedAfterGhostChange();
    }
  }

  /**
   * Re-apply the strategy's live drag state after a mid-drag force-render.
   * The render rebuilds the iframe DOM and the Renderer re-applies source
   * styles — wiping the strategy's per-frame `transform: translate(dx,
   * dy)` patch on the dragged element. AbsoluteInFrameStrategy (which
   * patches the replica-prefixed element with `important` setProperty)
   * is the worst hit: the dragged node visually DISAPPEARS into its
   * stale source-known spot until the next pointermove tick re-paints.
   *
   * Calling `onMove` synchronously with the last known cursor position
   * makes the strategy re-emit its per-frame patches, so the dragged
   * element snaps back to the live drag position on the SAME frame as
   * the ghost append/remove.
   */
  private resyncDraggedAfterGhostChange(): void {
    if (!this.activeStrategy || !this.context) return;
    const mouseDelta: Point = {
      x: this.lastMouseScreen.x - this.context.startMouse.x,
      y: this.lastMouseScreen.y - this.context.startMouse.y,
    };
    try {
      // The force-render that just ran called `patchElement` on every node
      // including the lifted dragged element. patchElement re-applies
      // source styles, which clobbers the lift's `position: absolute` +
      // zIndex when the source had `position: relative` (common for flex
      // children with stacking context). Re-stamp the FULL lift styles
      // with `left`/`top` computed from the LIVE cursor in a single
      // atomic patch — so the iframe paints the post-render frame with
      // the overlay already at the cursor (not at lift-time-position
      // then jumping to cursor on the next onMove tick).
      const strategyExt = this.activeStrategy as DragStrategy & {
        rehydrateLiftAfterForceRender?: (context: DragContext, mouseDelta: Point) => void;
        resetReorderGatesForStructuralChange?: () => void;
        reNeutralizeSiblingOrders?: () => void;
      };
      // The force-render's `patchElement` re-applied source styles to all
      // siblings, which clears the `!important` flag from the lift-time
      // neutralized orders (CSSOM: `el.style.order = '0'` removes existing
      // !important). Sibling orders revert to their SEQUENTIAL source
      // values (e.g. 0, 1, 2, 3 — gap of 1), while the new duplicate has
      // its spaced-rank source order (e.g. '40'). With sequential orders
      // pickPlaceholderOrder can't find integer midpoints, and the
      // duplicate's 40 sits past everything → placeholder lands wrong.
      // Re-apply the spaced ranks with `!important` so the layout
      // matches what movePlaceholders expects.
      if (strategyExt.reNeutralizeSiblingOrders) {
        strategyExt.reNeutralizeSiblingOrders();
      }
      if (strategyExt.rehydrateLiftAfterForceRender) {
        strategyExt.rehydrateLiftAfterForceRender(this.context, mouseDelta);
      }
      // Structural change just happened (alt-duplicate added/removed):
      // every sibling's rect shifted to accommodate the new flex item
      // count. The strategy's hysteresis + cooldown would normally
      // prevent the very next onMove tick from updating the placeholder
      // position — fine for normal drag oscillation, but exactly wrong
      // here. Reset the gates so the upcoming onMove re-maps the cursor
      // to the right slot in the NEW sibling geometry.
      if (strategyExt.resetReorderGatesForStructuralChange) {
        strategyExt.resetReorderGatesForStructuralChange();
      }
      // Two onMove ticks: the FIRST tick refreshes the strategy's
      // internal state (reads the post-render rect snapshot, recomputes
      // reorder index from the cursor against the NEW sibling layout,
      // moves the placeholder accordingly). The SECOND tick is defensive
      // — for absolute strategies it's a no-op; for LayoutLifted it
      // confirms the placeholder lands at the correct order even if the
      // first tick's bridge.rectCache was a frame stale.
      this.activeStrategy.onMove(this.context, this.lastMouseScreen, mouseDelta);
      this.activeStrategy.onMove(this.context, this.lastMouseScreen, mouseDelta);
    } catch (err) {
      trace.error('drag:alt-duplicate-resync-failed', { error: String(err) });
    }
  }

  /** Remove the listeners + clear any lingering ghost state. */
  private teardownAltDuplicate(): void {
    if (this.altDuplicateKeyListeners) {
      this.altDuplicateKeyListeners();
      this.altDuplicateKeyListeners = null;
    }
    // Note: ghost duplicates are NOT removed here — endDrag's mouseup
    // commit path decides whether they're kept (ALT held = duplicate
    // becomes real) or removed (ALT released before mouseup =
    // applyAltDuplicateState(false) already cleared them).
  }

  /**
   * Rebuild drag context with current DOM positions.
   * Called during mid-drag strategy switching so the new strategy starts
   * from the element's CURRENT position (not where drag originally started).
   */
  private rebuildContext(event: MouseEvent): void {
    if (!this.context) return;

    const vpPrefix = this.context.viewportPrefix;
    const nodeCtx = { contentEl: this.contentEl, viewportPrefix: vpPrefix };
    const newDraggedNodes: DraggedNode[] = [];

    const rebuildVpId = vpIdFromPrefix(vpPrefix);
    const transform = this.callbacks.getTransform();
    const nodes = this.callbacks.getNodes();
    for (const node of this.context.draggedNodes) {
      // Bridge-aware: parent's contentEl is empty in iframe mode. Fall back
      // to bridge rects + NodeMap so the rebuild produces a valid DraggedNode
      // after a live reparent strategy switch.
      const elRect = findNodeRect(node.id, rebuildVpId);
      if (!elRect) continue;

      const nodeData = (getNodeFromCache(node.id) as any) ?? nodes.get(node.id);

      // Parent from NodeMap (cache reflects post-flush state).
      const startParentId = nodeData?.parentId ?? null;

      // Compute startLeft/startTop in PARENT-LOCAL CSS pixels. After a
      // live-reparent the NodeMap styles may be stale (atom hasn't re-derived
      // yet), so derive the position from screen rects: dragged element's
      // screen rect minus its current parent's screen rect, divided by scale.
      // This guarantees visual continuity — the element stays under the cursor
      // because subsequent onMove uses (startLeft + dx, startTop + dy) as the
      // base, and dx/dy = currentMouse - rebuildStartMouse = 0 at switch time.
      let startLeft: number;
      let startTop: number;
      if (startParentId) {
        const parentRect = findNodeRect(startParentId, rebuildVpId);
        if (parentRect) {
          startLeft = Math.round((elRect.left - parentRect.left) / (transform.scale || 1));
          startTop = Math.round((elRect.top - parentRect.top) / (transform.scale || 1));
        } else {
          startLeft = parseFloat(nodeData?.styles?.left || '0') || 0;
          startTop = parseFloat(nodeData?.styles?.top || '0') || 0;
        }
      } else {
        // Canvas root (no parent) — read from NodeMap styles. After
        // flushNow() in the AbsoluteInFrameStrategy exit path, the move
        // mutation has committed and updateNodeInCache has refreshed
        // nodeData with the canvas-space left/top. The rectCache (iframe
        // local DOM) is stale because canvasInteracting=true blocks
        // bridge.render() during drag — so deriving from elRect would
        // pick up the OLD parent-relative position. NodeMap is the
        // authoritative source here.
        startLeft = parseFloat(nodeData?.styles?.left || '0') || 0;
        startTop = parseFloat(nodeData?.styles?.top || '0') || 0;
      }

      newDraggedNodes.push({
        id: node.id,
        startLeft,
        startTop,
        mouseOffsetX: event.clientX - elRect.left,
        mouseOffsetY: event.clientY - elRect.top,
        width: elRect.width,
        height: elRect.height,
        startParentId,
      });
    }

    // Update context with refreshed positions and current mouse as new start.
    // Keep the SAME viewportPrefix — the element's data-node-id hasn't changed,
    // so the prefix must stay as-is for rect lookups to find it.
    this.context = {
      ...this.context,
      draggedNodes: newDraggedNodes,
      startMouse: { x: event.clientX, y: event.clientY },
      transform: this.callbacks.getTransform(),
      containerRect: this.containerEl.getBoundingClientRect(),
      code: this.callbacks.getCode(),
      nodes: this.callbacks.getNodes(),
    };

    trace.action('drag:context-rebuilt', {
      nodeCount: newDraggedNodes.length,
      nodes: newDraggedNodes.map(n => ({ id: n.id, left: n.startLeft, top: n.startTop, parent: n.startParentId })),
    });
  }

  private reset(): void {
    // Reset snap hysteresis state so next drag starts fresh
    resetSnapHysteresis();

    // UNLOCK the dragged node(s) SYNCHRONOUSLY, right before the drop flush.
    // The dropped node still carries its per-frame drag `transform` inline;
    // the drop render below must PATCH it (clear the transform, apply the
    // committed left/top) — but a locked node is skipped, so the unlock has
    // to precede the render. Doing this then draining the queue in the same
    // synchronous block means the drop render is the FIRST render since drag
    // start (mid-drag renders are gated) and it already carries the final
    // committed state → no stale frame, no blink.
    //
    // (This REPLACES a 120ms deferred unlock that fired a full
    // `forceCanvasRender()` truth-up AFTER the drop render — a redundant
    // 863-node render + full measure on every drop, landing hundreds of ms
    // late = the "~1s to settle / selection overlay slow to reappear" find.
    // The blink it guarded against came from MID-DRAG renders re-applying
    // stale coords; those no longer happen now the mutation queue is gated
    // for the whole gesture.)
    this.setCentralDragLocks([]);

    // Captured before the context is nulled — consumed by the subtree cache
    // nudge after the drain below.
    const nudgeRootIds = this.context?.draggedNodes.map(n => n.id) ?? [];
    const nudgeVpId = vpIdFromPrefix(this.context?.viewportPrefix ?? '');

    this.context = null;
    this.activeStrategy = null;
    this.isDragStarted = false;
    dragStateOps.set(false);
    // DRAIN the mutation queue in ONE chain now that the drag is over. All
    // mid-drag transition commits were HELD (flushNowDeferredDuringDrag + the
    // processQueue element-drag gate) so the 470KB string pipeline never ran
    // mid-gesture — this single flush produces ONE applyMutation chain → ONE
    // setCode → ONE parse + React fan-out at drop (was two full pipelines:
    // the stashed mid-drag code, then the drop commit ~450ms later). The
    // dropped node is now UNLOCKED, so this render reconciles it too.
    //
    // FAN-OUT DEFER for every drag-end drain (generalizes the orchestrator's
    // reposition/structural branches): long-task tracing (2026-07-19) showed
    // a drag-out-of-frame mouseup running ONE 326ms task — string pipeline
    // (~130ms) + synchronous setCode → parse (~130ms) + cascade — no frame
    // until it all finished, so cache-driven overlays (pin lines, name
    // labels) stayed visually stale the whole time. The canvas DOM + node
    // cache are already live-correct (imperative reparents + cache syncs in
    // the strategies), so the parse/React cascade rides the fenced 32ms
    // timer; the drain below shrinks the mouseup task to the string ops.
    // Component files keep the synchronous fan-out (variant wiring reads the
    // fresh parse — same exclusion as the orchestrator branches). Empty
    // queue must NOT arm: flushNow's empty-queue fence would immediately
    // apply it synchronously — a redundant full setCode on plain clicks.
    if (hasQueuedMutations() && !isComponentLikeFilePath(getActiveFilePath() ?? '')) {
      setDeferNextFanOut();
      trace.action('drag:end-drain-fan-out-defer', {});
    }
    flushNow();
    // Seal the alt-duplicate gesture's merged history entry (opened at
    // ghost-show). Released unconditionally — a no-op when no hold is active.
    releaseHistoryCoalescing();
    // Deferred whole-gesture restores (synced-replica unhides handed over by
    // a mid-drag strategy switch). AFTER the drop flush so the twins are
    // already gone from the other viewports' DOM when the hide lifts — no
    // one-frame flash of the pre-drag copies.
    runDragEndRestores();
    // SUBTREE CACHE NUDGE — shift each dragged root's DESCENDANTS' cached
    // rects by the root's own start→end screen delta. The root's entry stays
    // fresh via the per-frame drag emits, but the descendants' do not: the
    // per-patch subtree walk is suppressed during interaction, reposition
    // drops SKIP the render (no allRects re-measure), and the sandbox's
    // gesture-end reconcile proved unreliable under live tracing — children
    // of a moved canvas frame kept their pre-drag cached rects and were
    // un-hoverable/un-selectable until a camera move (2026-07-19). This is
    // parent-side and deterministic; structural drops additionally get trued
    // up by their own render's measure pass.
    this.nudgeDraggedSubtreeCaches(nudgeRootIds, nudgeVpId);
    this.pendingNodeId = null;
    this.pendingMouseEvent = null;
    this.pendingGripAxis = null;
    this.toolbarItem = null;
  }

  private nudgeDraggedSubtreeCaches(rootIds: string[], vpId: string): void {
    const bridge = getCanvasBridge();
    if (!bridge.shiftCachedSubtree || rootIds.length === 0) { this.dragStartRootRects.clear(); return; }
    for (const rootId of rootIds) {
      const start = this.dragStartRootRects.get(rootId);
      const end = findNodeRect(rootId, vpId);
      if (!start || !end) continue;
      const dx = end.left - start.left;
      const dy = end.top - start.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      // Descendants from the imperative node cache — structurally current at
      // this point (strategies/orchestrator sync it at commit time). `seen`
      // bounds the recursion: a corrupt cache with a parentId cycle blew this
      // walk with a stack overflow (collection-list drag-out, 2026-07-29).
      const descendants: string[] = [];
      const seen = new Set<string>([rootId]);
      const walk = (id: string) => {
        const node = getNodeFromCache(id);
        if (!node?.children) return;
        for (const childId of node.children) {
          if (seen.has(childId)) {
            trace.error('drag:nudge-subtree-cycle', { rootId, childId });
            continue;
          }
          seen.add(childId);
          descendants.push(childId);
          walk(childId);
        }
      };
      walk(rootId);
      if (descendants.length === 0) continue;
      trace.action('drag:nudge-subtree-caches', { rootId, descendants: descendants.length, dx: Math.round(dx), dy: Math.round(dy) });
      bridge.shiftCachedSubtree(descendants, dx, dy);
    }
    this.dragStartRootRects.clear();
  }
}
