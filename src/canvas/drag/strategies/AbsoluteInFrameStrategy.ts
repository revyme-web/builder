// AbsoluteInFrameStrategy.ts — Drag absolute-positioned elements INSIDE a frame.
// Positions are relative to the parent frame, not the canvas.
// Handles:
//   - Parent exit detection: if element is dragged fully outside parent bounds,
//     transition to canvas (reparent to root).
//   - Parent entry detection: if dragged over another frame, transition into it.
// This is the strategy for elements that have position:absolute but ARE inside a viewport/frame.
//
// Bridge-compatible: all DOM reads use findNodeRect/findNodeComputedStyle,
// all DOM writes use patchNodeStyles. No getNodeEl() calls.

import type { Point, PendingUpdate, Rect } from '@/shared/types';
import { buildCanvasCloneDescriptor, dropDynamicStyleBindings } from '../clone-descriptor';
import type { DragContext, DragStrategy, DragMoveResult } from '../types';
import { getParentCanvasOffsetById, getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { calculateSnap, getMouseVelocity } from '../handlers/snap-handler';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { overlayEditingIdAtom, overlayTriggerCallsAtom } from '@/code/stores/overlay-store';
import { beginOverlayFollow } from '@/canvas/drag/overlay-follow';
import { nodesAtom } from '@/code/stores/store';
import { getDefaultStore } from 'jotai';
import { SNAP_THRESHOLD, nodeAcceptsChildren } from '@/shared/constants';
import { updateNodeStyles, vpIdFromPrefix, isPrimaryViewport, getActiveFilePath, patchNodeStyles, findNodeRect, findNodeComputedStyle, findNodeComputedStyles, findChildRects, getNodeHitsAtPoint, forceCanvasRender, parseRectCacheKey, forceCanvasRenderDeferredDuringDrag } from '@/canvas/node-ops';
import { isOverlayNode } from '@/code/parsing/overlay-parser';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getIframeOffset, screenPointToCanvas } from '../helpers/coords';
import { getScreenCornersById, pointInQuad, isFullyInsideQuad, isFullyOutsideQuad, nodeOrAncestorHasRotationOrSkewById, cornersAreAxisAligned , matrixHasRotationSkewOrFlip } from '@/canvas/resize/geometry-utils';
import { isComponentFilePath, isIconSetFilePath } from '@/code/project/active-file-store';
import { buildParentScreenMapProjective, invertProjective, buildParentSvgGroupMap, invertAffine, queueBorderOverlayDuplicates } from '@/canvas/creators/creator-utils';
import { parseTranslateOffset, stripTranslateFunctions } from './transform-utils';
import { computeAutoPins } from './dynamic-pin';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { getReplicaContext } from '../replica-context';
import { getConsolidationClone, clearConsolidationClone } from '../consolidation-clone-store';
import { registerPendingReplicaExtraction, getPendingReplicaExtraction, clearPendingReplicaExtraction } from '../pending-replica-extraction-store';
import { commitExitToCanvas } from '../exit-commit';
import { getInsetState } from '@/shared/pin-utils';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { detectParentLayoutById, getFlexDirectionById } from '../types';
import { trace } from '@/shared/debug-trace';
import { motionPropsToCSSTransform, MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { calculateLayoutInsertIndexById } from '../reparent-utils';
import { computeEntryParentLocalPosition, computeExitCanvasPosition } from '../transform-reparent';
import { queueMutation, flushNow, flushNowDeferredDuringDrag } from '@/code/mutation/mutation-queue';
import { moveNodeInCache, updateNodeInCache, getVariantOverriddenKeys, getNodeFromCache } from '@/code/stores/store';

/** Frames the element must be poking outside the non-layout parent before exit
 *  triggers. Instant (1) for non-layout — user expects "touch the canvas → unparent". */
const EXIT_FRAME_THRESHOLD = 1;

/** Minimum fraction of the dragged element's area that must overlap a sibling frame to trigger entry */
const SIBLING_ENTRY_OVERLAP_THRESHOLD = 0.5;

/** Number of consecutive frames inside a sibling frame before switch is confirmed */
const ENTRY_GRACE_FRAMES = 5;

/**
 * True iff the computed CSS `transform` value represents a non-identity
 * transform. Empty / unset / 'none' / identity matrix all count as no
 * transform — used to gate the (more expensive) quad-containment path.
 */
function isNonIdentityTransform(transform: string | null | undefined): boolean {
  if (!transform) return false;
  const t = transform.trim();
  if (!t || t === 'none') return false;
  if (t === 'matrix(1, 0, 0, 1, 0, 0)' || t === 'matrix(1,0,0,1,0,0)') return false;
  return true;
}

/** AABB exit predicate routed by destination. `canvas` → any element edge
 *  outside parent (not fully inside). `grandparent` → element rect entirely
 *  separated from parent rect (fully outside). */
function aabbExit(
  elRect: DOMRect,
  parentRect: DOMRect,
  destination: 'canvas' | 'grandparent',
): boolean {
  if (destination === 'canvas') {
    // not fully inside — any corner of the element AABB outside the parent
    return (
      elRect.left < parentRect.left ||
      elRect.left + elRect.width > parentRect.left + parentRect.width ||
      elRect.top < parentRect.top ||
      elRect.top + elRect.height > parentRect.top + parentRect.height
    );
  }
  // fully outside — element AABB doesn't overlap parent AABB at all
  return (
    elRect.left + elRect.width < parentRect.left ||
    elRect.left > parentRect.left + parentRect.width ||
    elRect.top + elRect.height < parentRect.top ||
    elRect.top > parentRect.top + parentRect.height
  );
}


export class AbsoluteInFrameStrategy implements DragStrategy {
  readonly name = 'absolute-in-frame';

  /** Active CSS-pin removal timers, keyed by selector. Lets the next
   * drag on the same element cancel the previous drag's pending removal
   * so the pin doesn't get yanked mid-animation on subsequent drags. */
  private static pendingPinRemovals = new Map<string, ReturnType<typeof setTimeout>>();

  /** When the strategy hands off to CanvasDragStrategy, this is the
   * vpPrefix the new strategy should use. For variant exit the dragged
   * is now a hoisted canvas node — its DOM has no viewport prefix, so
   * patches must use ''. Read by the DragCoordinator's switch handler. */
  private exitVpPrefix: string | null = null;


  private parentId: string | null = null;
  private prevMouse: Point = { x: 0, y: 0 };
  private framesOutsideParent = 0;
  /** Whether the element ALREADY overflowed its parent at gesture start
   *  (e.g. a group whose rotated variant child bleeds past the clipped frame
   *  edge). The canvas-exit contract is "any corner outside" for responsive
   *  drag-out — but applied to a pre-overflowing element it fires on frame
   *  one and detaches a within-frame drag (live find 2026-06-12: dragging a
   *  group on a variant tile detached it to a canvas node in 84ms). When the
   *  overflow is pre-existing, exit requires the CURSOR to leave the parent.
   *  null = not yet sampled (captured on the first exit-check frame). */
  private startedNotFullyInside: boolean | null = null;
  private exitedParent = false;
  private candidateSiblingId: string | null = null;
  private framesInCandidateSibling = 0;
  private siblingEntryConfirmed = false;
  /** Pending insertion into a layout sibling, set while cursor previews over
   *  it. Committed on mouseup in onEnd. Cleared if cursor leaves before drop. */
  private pendingLayoutDrop: { siblingId: string; insertIndex: number } | null = null;
  // (Reserved — kept for future preview-based flows. Currently unused
  // because non-layout sibling reparents are committed live during drag,
  // matching the smooth grandparent-exit experience.)
  private pendingSiblingDrop: { siblingId: string } | null = null;
  // Switch the parent-exit predicate from "element AABB outside parent"
  // to "cursor outside parent". Set when this strategy reparents into a
  // non-layout sibling during the drag (sibling-entry path). The element
  // can then be freely positioned anywhere inside the sibling's screen
  // area without the AABB-based exit predicate bouncing it straight back
  // out — exit fires only when the cursor itself leaves the parent.
  private useCursorExit = false;
  private entryGraceCounter = 0;
  private static readonly ENTRY_GRACE_PERIOD = 10;
  private parentIsFlexGrid = false;
  /** Set once at onStart — `true` if the parent has any non-identity CSS
   *  transform. The exit detector then uses point-in-quad against the
   *  parent's rotated corners instead of the AABB fast path. Cached to
   *  avoid a bridge round-trip every frame. */
  private parentHasTransform = false;
  private vpId: string = 'desktop';
  private lastPositions: Map<string, { left: number; top: number }> = new Map();
  private lastStyles: Map<string, Record<string, string>> = new Map();

  private startInsets = new Map<string, {
    right: number;
    bottom: number;
    inset: ReturnType<typeof getInsetState>;
    isPercentMode: boolean;
    startLeftPercent: number;
    startTopPercent: number;
    parentWidth: number;
    parentHeight: number;
    /** Un-rotated CSS box width (computed style — NOT the screen-space
     *  bounding rect). Required for correct auto-pin math on rotated /
     *  skewed elements: switching from `top-px` → `bottom-px` writes
     *  `bottom = parentHeight - newTopCss - elemCssHeight` where the
     *  height must be the LAYOUT box height. `getBoundingClientRect`
     *  (and therefore `node.height`) returns the rotated AABB, which
     *  is larger than the layout box — using it produces a vertical
     *  jump exactly equal to `(rotatedAABB - layoutBox)` on the pin
     *  switch. Same for X with rotation around the box centre. */
    elemCssWidth: number;
    elemCssHeight: number;
  }>();
  /** Canvas-space coords captured at exit-commit time. Sent via switchRequest
   *  to the next strategy so it doesn't rebuild from a stale cache.
   *  `transform` is the post-strip value — the receiving strategy uses
   *  this to seed its `originalTransforms` so per-frame writes don't
   *  re-apply the stale source translate over the new css position. */
  private exitOverrides: Map<string, {
    startLeft: number;
    startTop: number;
    startParentId: string | null;
    width?: number;
    height?: number;
    transform?: string;
  }> | null = null;

  /** Lift-time canvas-space corners — see CanvasDragStrategy for rationale. */
  private liftCorners: Map<string, import('../handlers/snap-handler').ScreenCorners> = new Map();

  /** Per-node flag: true → the user has manually pinned this node (source
   *  has `data-pinned="true"`), so we keep the existing inset/pin logic
   *  unchanged for it. False → element is unlocked; we auto-pick which
   *  sides to anchor to each drag tick based on element vs parent
   *  geometry (standard dynamic pinning). The flag is reset
   *  (removed from source attrs) on re-parent / unparent. */
  private dynamicPinNodes: Set<string> = new Set();
  /** True while dragging on an icon-set MASTER. The master canvas is a FIXED
   *  px coordinate space — card positions round-trip through iconConfig as
   *  raw numbers (the drag/resize commits parseFloat them). standard
   *  dynamic pinning (middle band → `left: 48.6%`, right band → right-px)
   *  is a responsive-page feature; on a wide icon master every mid-band
   *  card committed a PERCENT that got misread as px (48.6% → x:49) and
   *  jumped to the far left on mouse-up. Dynamic pinning is disabled here
   *  wholesale — the locked-pin fallback writes plain px. */
  private isIconSetMaster = false;
  // SVG group-children whose parent group is a FLEX/FLOW child (position ≠
  // absolute). For these, the live drag writes x/y attrs each frame (so the
  // sandbox `liveRefitGroup` reads the real position) and re-fits the group to
  // its painted bounds live — instead of the GPU `transform: translate` path
  // (which leaves x/y stale until mouseup → refit can't see the drag). Maps
  // child nodeId → group nodeId. Absolute groups stay on the transform path.
  private flexGroupChildRefit: Map<string, string> = new Map();
  // Top-level SVG (shape/group) that was `position: static` at drag start — its
  // inline left/top were ignored, so a plain commit snaps it back. We re-baseline
  // it to its visual position, patch position:absolute live, and commit it too.
  private svgNeedsAbsolute: Set<string> = new Set();
  // ROTATED nested groups: their rotation lives in the SVG `transform="rotate(θ
  // cx cy)"` ATTRIBUTE. The GPU `transform: translate` drag path would CLOBBER
  // that attribute (un-rotate it) — so instead we write x/y attrs + shift the
  // rotate pivot (cx,cy move with the group) each frame. Maps id → base rotation.
  private rotatedSvgGroupNodes: Map<string, { angle: number; cx0: number; cy0: number }> = new Map();

  /** True when `this.parentId`'s own parentId is null (it's the top-most
   *  node in the page/layout tree — the "viewport" frame). Selects the
   *  viewport-only auto-pin rule (Y always `top-px`; pages can scroll
   *  arbitrarily so bottom pins against the viewport are wrong). False
   *  for any nested frame, where the full 3×3 zone rule applies. */
  private parentIsViewport: boolean = false;

  /** Shift+drag axis lock state. `lockedAxis` is decided once on the
   *  first move past the 5px threshold (whichever delta is larger
   *  wins) and held for the rest of the drag while shift stays
   *  pressed. Releasing shift clears both fields so the user can
   *  toggle in/out of axis-lock mid-drag. Mirrors the implementation
   *  in `CanvasDragStrategy` so absolute-in-frame drags behave the
   *  same way under shift. */
  private lockedAxis: 'x' | 'y' | null = null;
  private axisLockDetermined: boolean = false;

  /** Lift-time inline `transform` value per node — preserved through the
   *  drag and prepended to the per-frame `translate(...)` write so the
   *  user's existing rotation / scale / etc. composes correctly with the
   *  drag offset. See CanvasDragStrategy for the complete rationale. */
  private originalTransforms: Map<string, string> = new Map();

  /** Where this drag's exit will land:
   *  - `'canvas'` when grandparent is the viewport top-level (parent.parentId
   *    has no parent). Exiting means becoming a free-floating canvas node.
   *  - `'grandparent'` when there's a deeper frame ancestor that can receive
   *    the element (3+ levels of nesting). Exiting reparents up one level
   *    and the strategy continues with the new parent.
   *  Determined ONCE at lift; predicate + commit branch off this. */
  private exitDestination: 'canvas' | 'grandparent' = 'canvas';
  /** Set when `exitDestination === 'grandparent'` — the node id we'd
   *  reparent into when this drag pokes out of the current parent. */
  private grandparentId: string | null = null;

  canHandle(context: DragContext): boolean {
    const firstNode = context.draggedNodes[0];
    if (!firstNode || !firstNode.startParentId) return false;
    const nodeData = context.nodes.get(firstNode.id);
    if (nodeData?.isCanvasNode) return false;
    if (firstNode.startParentId.startsWith('layout::')) return false;
    const parentNode = context.nodes.get(firstNode.startParentId);
    if (!parentNode) return false;
    return true;
  }

  onStart(context: DragContext): void {
    const firstNode = context.draggedNodes[0];
    this.parentId = firstNode.startParentId!;
    this.prevMouse = context.startMouse;
    this.framesOutsideParent = 0;
    this.startedNotFullyInside = null;
    this.exitedParent = false;
    this.candidateSiblingId = null;
    this.framesInCandidateSibling = 0;
    this.siblingEntryConfirmed = false;
    this.lastPositions.clear();
    this.lastStyles.clear();
    this.entryGraceCounter = AbsoluteInFrameStrategy.ENTRY_GRACE_PERIOD;
    this.vpId = vpIdFromPrefix(context.viewportPrefix);

    const parentDisplay = findNodeComputedStyle(this.parentId, this.vpId, 'display');
    this.parentIsFlexGrid = parentDisplay === 'flex' || parentDisplay === 'inline-flex'
      || parentDisplay === 'grid' || parentDisplay === 'inline-grid';

    // Layout-child parent (this.parentId is a child of a flex/grid):
    // switch to CURSOR-based exit instead of element-rect-based. Two
    // reasons this matters specifically for layout cells:
    //   • Grid cells are typically small. The dragged element's
    //     rotated-AABB / quad easily sticks past the cell edges even
    //     when its CENTRE is inside, so the strict
    //     `!isFullyInsideQuad(elCorners, parentCorners)` predicate
    //     fires → exit → re-enter → oscillation (the bug the user
    //     showed with a rotated element bouncing in/out of a cell).
    //   • The user's mental model is "I'm dropping into THIS cell" —
    //     the cell's CURSOR-over status is the authoritative signal,
    //     not whether the rotated AABB squeezed into its bounds.
    // Same rule sibling-reparent uses post-entry — extending it here
    // covers canvas-drag entries (which currently start with default
    // exit semantics and bounce).
    const startParentNode = context.nodes.get(this.parentId);
    const startGrandparentId = (startParentNode as any)?.parentId ?? null;
    const startGrandparentDisplay = startGrandparentId
      ? findNodeComputedStyle(startGrandparentId, this.vpId, 'display')
      : '';
    const parentIsLayoutChild =
      startGrandparentDisplay === 'grid' || startGrandparentDisplay === 'inline-grid'
      || startGrandparentDisplay === 'flex' || startGrandparentDisplay === 'inline-flex';
    this.useCursorExit = parentIsLayoutChild;

    // Cache transform detection ONCE at lift — transforms don't change
    // during a drag, and per-frame bridge reads were stuttering the loop.
    // Drives the point-in-quad exit check below.
    const parentTransformAtStart = findNodeComputedStyle(this.parentId, this.vpId, 'transform');
    this.parentHasTransform = isNonIdentityTransform(parentTransformAtStart);

    // Determine the exit destination ONCE at lift. The exit predicate +
    // commit branch off this:
    //   - `canvas`     → "not fully inside" trigger; element becomes a
    //                    free-floating canvas node on exit.
    //   - `grandparent`→ "fully outside" trigger; element reparents one
    //                    level up and the strategy continues there.
    // Rule: if the grandparent is a frame that accepts children and is
    // NOT a flex/grid layout, the exit walks up into it. It does NOT
    // need to be nested itself — a top-level canvas frame is still a
    // valid container. Punting to canvas in that case made
    // CanvasDragStrategy immediately re-detect the inner frame as a
    // drop target and re-enter it, producing rapid reparent/unparent
    // oscillation at the inner frame's edge.
    //
    // The page/viewport root ('root') counts as a valid reparent
    // target too — it's a normal container that accepts children
    // (the viewport is just a frame from the layout system's point
    // of view, including in every replica viewport). Without this,
    // dragging out of a child of root used the eager "not fully
    // inside" predicate and detached to canvas the moment any
    // corner crossed the frame edge — even though the user clearly
    // intended to keep the element inside the viewport. The
    // conservative "fully outside" predicate matches the rest of
    // the unparent flow: you have to drag the element completely
    // off the viewport before it pops out to canvas.
    const parentNode = context.nodes.get(this.parentId);
    const grandparentId = parentNode?.parentId ?? null;
    const grandparentNode = grandparentId ? context.nodes.get(grandparentId) : null;
    // When grandparent is flex/grid, exit must go to CANVAS (not grandparent
    // reparent) so CanvasDragStrategy can take over and show layout drop-line
    // preview inside the flex grandparent. Reparenting directly into a flex
    // parent skips the layout-aware insert (no drop-line, wrong order). The
    // user can still re-enter the original no-layout parent during drag —
    // CanvasDragStrategy's entry detection handles the round-trip via the
    // canvas-node-into-no-layout-frame path.
    const grandparentLayout = grandparentId
      ? detectParentLayoutById(grandparentId, this.vpId)
      : null;
    const grandparentIsLayout = grandparentLayout === 'flex' || grandparentLayout === 'grid';
    // ICON-SET master ROOT is NOT a reparent target: its direct
    // children are the variant cards, so reparenting a dragged-out vector THERE
    // drops a loose svg next to the cards (reads as a phantom variant). Route it
    // to CANVAS instead → the generic hoist makes it a floating canvasNodes
    // element, cleanly separated from the variant level.
    const grandparentIsContainerSetRoot = grandparentId === 'root'
      && isIconSetFilePath(getActiveFilePath());
    const grandparentIsReparentTarget = !!grandparentNode
      && nodeAcceptsChildren(grandparentNode)
      && !grandparentIsLayout
      && !grandparentIsContainerSetRoot;
    this.exitDestination = grandparentIsReparentTarget ? 'grandparent' : 'canvas';
    this.grandparentId = grandparentIsReparentTarget ? grandparentId : null;

    // Detect viewport parent: the top-most node in the page/layout tree
    // has no parent itself. Viewport-parent drives the auto-pin rule
    // toward "always top-px on Y" (pages scroll arbitrarily — bottom
    // pins against the viewport are wrong). Frame parents (anything
    // nested) get the full 3×3 zone rule. Computed once here; the per-
    // frame loop reads `this.parentIsViewport` to pick the right path.
    this.parentIsViewport = grandparentId === null;

    trace.action('abs-in-frame:parent-layout', {
      parentId: this.parentId, parentDisplay, parentIsFlexGrid: this.parentIsFlexGrid,
      parentHasTransform: this.parentHasTransform,
      exitDestination: this.exitDestination, grandparentId: this.grandparentId,
      grandparentLayout, grandparentIsLayout,
    });

    // Multi-vp replica drag: snapshot every dragged source's pre-drag
    // state NOW so a later canvas-exit can perform the vp-only
    // extraction (revert source on every non-source vp, create a fresh
    // canvas clone, hide source on source vp). The snapshot has to
    // happen at onStart — NOT at the exit-time mutation site — because
    // by the time the canvas exit triggers, the source may have already
    // been reparented up one or more levels (pink frame → root → canvas)
    // via the conservative grandparent path, and the exit-time
    // `this.parentId` is the intermediate parent (root), not the
    // original (pink frame). The user's revert intent is "back to where
    // this lived BEFORE the drag started" — so the snapshot is keyed
    // to onStart's parent + index + base styles + container overrides.
    //
    // The CanvasDragStrategy.onEnd vp-only handler keeps a defensive
    // path for entries that survive that far; the primary trigger lives
    // in the canvas-exit branch below (live during the drag, not on
    // mouseup).
    const isReplicaDrag = context.viewportPrefix !== '';
    if (isReplicaDrag && this.parentId) {
      const parentNodeAtStart = context.nodes.get(this.parentId);
      const containerOverridesAtStart = getDefaultStore().get(containerOverridesAtom);
      for (const node of context.draggedNodes) {
        const nd = context.nodes.get(node.id);
        if (!nd) continue;
        // isReplicaOnly check (same predicate as the exit branch). Skip
        // the snapshot for these — replica-only nodes go through the
        // "hop source to canvas" exit, no vp-only extraction needed
        // (there's nothing to revert on other vps; they don't render
        // the element).
        let isReplicaOnly: boolean;
        if (isComponentFilePath(getActiveFilePath())) {
          // Component master: check `hiddenOnVariants` instead of inline
          // display (AnimatePresence pattern; see exit branch for full
          // rationale).
          const hidden = nd.hiddenOnVariants;
          if (!hidden || hidden.size === 0) {
            isReplicaOnly = false;
          } else {
            const variantVpIds = parseVariantConfig(projectFS.readFile(getActiveFilePath()) ?? '')
              .map(v => v.name === 'default' ? 'desktop' : v.name);
            const currentVariant = this.vpId === 'desktop' ? 'default' : this.vpId;
            isReplicaOnly = true;
            for (const otherVpId of variantVpIds) {
              const variantName = otherVpId === 'desktop' ? 'default' : otherVpId;
              if (variantName === currentVariant) continue;
              if (!hidden.has(variantName)) { isReplicaOnly = false; break; }
            }
          }
        } else {
          const inlineDisplay = nd.styles?.display;
          isReplicaOnly = inlineDisplay === 'none';
          if (isReplicaOnly) {
            for (const otherVpId of Object.keys(getViewportWidths())) {
              if (otherVpId === this.vpId) continue;
              const otherDisplay = findNodeComputedStyle(node.id, otherVpId, 'display');
              if (otherDisplay && otherDisplay !== 'none') {
                isReplicaOnly = false;
                break;
              }
            }
          }
        }
        if (isReplicaOnly) continue;
        const parentChildren = parentNodeAtStart?.children ?? [];
        const sourceIndex = parentChildren.indexOf(node.id);
        const originalOverrides = new Map<number, Map<string, string>>();
        const ovTree = containerOverridesAtStart.get(node.id);
        if (ovTree) {
          for (const [maxWidth, props] of ovTree) {
            originalOverrides.set(maxWidth, new Map(props));
          }
        }
        registerPendingReplicaExtraction(node.id, {
          sourceVpId: this.vpId,
          originalParentId: this.parentId,
          originalIndex: sourceIndex >= 0 ? sourceIndex : 0,
          originalStyles: { ...nd.styles },
          originalContainerOverrides: originalOverrides,
        });
      }
    }

    this.startInsets.clear();
    this.originalTransforms.clear();
    this.dynamicPinNodes.clear();
    this.flexGroupChildRefit.clear();
    this.svgNeedsAbsolute.clear();
    this.rotatedSvgGroupNodes.clear();
    this.lockedAxis = null;
    this.axisLockDetermined = false;
    // Read replica overrides once for this onStart. Used per-node to
    // compute EFFECTIVE styles (base + active-viewport @media) before
    // inset detection. A `data-pinned` element that was pinned full-
    // inset only on a replica (left+right+top+bottom in the @media
    // rule, but only left+top in the base) would otherwise be
    // mis-detected as single-corner pinned — drag commits would
    // overwrite the replica's right/bottom pins. Same merge logic
    // ResizeManager + PinControl use, kept in sync here.
    const containerOverrides = getDefaultStore().get(containerOverridesAtom);
    const allVps = getDefaultStore().get(viewportsConfigAtom);
    const currentVpConfig = allVps.find(v => v.id === this.vpId);
    const currentVpMaxWidth = currentVpConfig?.width ?? 0;

    // See the field doc: NO dynamic pinning on icon-set masters (fixed px space).
    this.isIconSetMaster = isIconSetFilePath(getActiveFilePath());

    for (const node of context.draggedNodes) {
      const nodeData = context.nodes.get(node.id);
      const ns = nodeData?.styles || {};
      // Dynamic pinning: nodes NOT marked `data-pinned="true"` get
      // standard auto-pin every drag tick. Once the user manually
      // edits a pin in the Position panel (which writes
      // `data-pinned: 'true'` to the node's attrs), this set excludes
      // the node and the existing inset/pin logic takes over again.
      //
      // EXCEPTION: an SVG shape inside an SVG GROUP is positioned by its
      // `x`/`y` attributes, not CSS pins. Auto-pinning it makes the
      // per-frame dynamic-pin branch write CSS `right/bottom/transform`
      // every tick — which can't move the child but DOES fight its real
      // attr-driven movement, producing the random jumps/offsets the user
      // sees. Exclude it so the GPU transform path (and the group-refit
      // commit) handle it cleanly.
      const parentNode = nodeData?.parentId ? context.nodes.get(nodeData.parentId) : null;
      const isSvgGroupChild = nodeData?.type === 'svg' && parentNode?.type === 'svg';
      // ANY svg (a shape OR a group, whether a group-child or a top-level shape/
      // group dragged inside a frame) drags as a simple unit — no DYNAMIC pinning
      // (auto left↔right conversion mid-drag). The pin/inset auto-model doesn't
      // apply to vector content; auto-pinning it writes CSS right/bottom every
      // tick that fights its movement. NOTE: this is orthogonal to the pin
      // CONSTRAINT LINES — an absolute SVG still shows those (they visualize the
      // authored left/top/right/bottom pins), same as a `data-pinned` frame,
      // which is likewise excluded here yet shows lines. See PinConstraintLines.
      const isSvg = nodeData?.type === 'svg';
      if (nodeData?.attrs?.['data-pinned'] !== 'true' && !isSvg && !this.isIconSetMaster) {
        this.dynamicPinNodes.add(node.id);
      }
      // A ROTATED nested group carries its rotation in the `transform="rotate(θ
      // cx cy)"` ATTRIBUTE. The GPU `transform: translate` drag path writes
      // `style.transform`, which OVERRIDES the attribute → the group un-rotates
      // and the selection outline detaches mid-drag. Mark it so the per-frame
      // loop writes x/y attrs + shifts the rotate pivot instead (keeping it
      // rotated). Detected BEFORE `flexGroupChildRefit` so that path can exclude
      // it (the rotated branch does its own x/y write + live chain refit).
      if (isSvgGroupChild) {
        const rm = (nodeData?.attrs?.transform || '').match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
        if (rm) {
          this.rotatedSvgGroupNodes.set(node.id, { angle: parseFloat(rm[1]), cx0: parseFloat(rm[2]), cy0: parseFloat(rm[3]) });
        }
      }
      // EVERY svg-group child (shape or sub-group) gets the live x/y-write +
      // group auto-fit path (`flexGroupChildRefit`) instead of the GPU
      // `transform: translate`. This applies at ANY nesting depth — a
      // grandchild's `liveRefitGroup` walks the whole `<svg>`-group chain:
      // a flex/flow TOP reflows its layout live, and an ABSOLUTE top (canvas
      // group) slides/grows its box live via `liveRefitAbsoluteTopGroupEl` —
      // the dashed group outline expands in real time as the child is dragged
      // (it used to stay frozen on canvas groups; the absolute case was
      // excluded here AND bailed in the sandbox chain refit, 2026-07-28).
      // (Rotated groups use the rotated branch above — exclude them here.)
      if (isSvgGroupChild && nodeData?.parentId && !this.rotatedSvgGroupNodes.has(node.id)) {
        this.flexGroupChildRefit.set(node.id, nodeData.parentId);
      }
      // A top-level SVG (shape OR group) that is `position: static` can't be
      // dragged — its inline left/top are ignored, so a commit snaps it back to
      // its flow spot. Make it absolute so left/top stick, re-baselining
      // startLeft/Top to its CURRENT VISUAL (parent-relative) position so it
      // doesn't jump to the now-applied stale inline left/top. Patch it live so
      // the drag is consistent from the first frame.
      if (isSvg && !isSvgGroupChild && nodeData?.parentId) {
        const svgPos = findNodeComputedStyles(node.id, this.vpId, ['position']).position || '';
        if (svgPos !== 'absolute' && svgPos !== 'fixed') {
          const elRect = findNodeRect(node.id, this.vpId);
          const parentRect = findNodeRect(nodeData.parentId, this.vpId);
          if (elRect && parentRect) {
            const scale = context.transform.scale || 1;
            node.startLeft = Math.round((elRect.left - parentRect.left) / scale);
            node.startTop = Math.round((elRect.top - parentRect.top) / scale);
          }
          this.svgNeedsAbsolute.add(node.id);
          patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, {
            position: 'absolute', left: `${node.startLeft}px`, top: `${node.startTop}px`,
          });
        }
      }
      // Merge active-viewport @media overrides on top of base before
      // inset detection. `'auto'` from the inset-pin auto-emit
      // (generator-styles.ts) and `''` (delete convention) both mean
      // "treat as not-set" for pin detection — `auto` width with full
      // inset IS the inset state.
      const replicaProps = containerOverrides.get(node.id)?.get(currentVpMaxWidth);
      const effectiveNs: Record<string, string> = { ...ns };
      if (replicaProps && replicaProps.size > 0) {
        for (const [prop, val] of replicaProps) {
          if (val === '' || val === 'auto') delete effectiveNs[prop];
          else effectiveNs[prop] = val;
        }
      }
      const es: Record<string, string> = {};
      for (const k of ['left', 'right', 'top', 'bottom', 'width', 'height']) { if (effectiveNs[k]) es[k] = effectiveNs[k]; }
      const inset = getInsetState(es);
      const isPercentMode = (effectiveNs.left || '').includes('%') || (effectiveNs.top || '').includes('%');
      const parentDimRect = findNodeRect(this.parentId, this.vpId);
      // Snapshot pre-drag transform so per-frame writes can prepend
      // `translate(dx, dy)` without losing the user's rotation/scale.
      // Read from EFFECTIVE styles (base + active-viewport @media
      // merged) — otherwise a transform that lives only in the replica
      // rule (common with mid-replica rotates / skews) is missing from
      // `originalTransforms`, and per-frame `translate(dx, dy) +
      // emptyString` overwrites the painted rotation. User-visible
      // symptom: replica element appears axis-aligned during drag and
      // snaps back to rotated on mouseup. We KEEP the translate (no
      // stripping) — the percent-mode branch in onMove already maps
      // dx → percent delta correctly, so source + transform compose to
      // the right visible position on commit.
      // Rotation/scale/skew now live as motion MOTION props (rotate/scaleX/…)
      // — in @media (page replica, already merged into effectiveNs) AND/OR in
      // motionVariants[activeVariant] (component variant), NEITHER of which is
      // in `transform`. Fold both into the captured `orig` so the per-frame
      // `translate(dx,dy) + orig` write keeps the element rotated during the
      // drag (otherwise it appears axis-aligned mid-drag and snaps back rotated
      // on mouseup). Passing the merged map to motionPropsToCSSTransform is
      // safe — it only reads the transform-family keys.
      const variantKey = this.vpId === 'desktop' ? 'default' : this.vpId;
      const variantStyles = nodeData?.motionVariants?.[variantKey] ?? {};
      // Component INSTANCES (e.g. vector sets) keep per-variant motion props as
      // INLINE `rotate: variant === 'v' ? … : …` conditionals → node.conditionalStyles,
      // NOT a motionVariants object. Resolve the transform-family ones for the
      // active variant too, else the captured `orig` misses the rotation and the
      // per-frame `translate(dx,dy)` overwrites it — the element appears
      // axis-aligned mid-drag and snaps back rotated on mouseup.
      const condTransform: Record<string, string> = {};
      for (const [prop, branches] of Object.entries(nodeData?.conditionalStyles ?? {})) {
        if (!MOTION_TRANSFORM_PROPS.has(prop)) continue;
        const b = branches as Record<string, string>;
        const val = b[variantKey] ?? b['default'];
        if (val != null) condTransform[prop] = val;
      }
      const motionCss = motionPropsToCSSTransform({ ...effectiveNs, ...variantStyles, ...condTransform });
      const cssT = (effectiveNs.transform || '').trim();
      const tv = [cssT === 'none' ? '' : cssT, motionCss].filter(Boolean).join(' ').trim();
      this.originalTransforms.set(node.id, tv);

      // SCALE FIX: parentDimRect is in SCREEN px (from findNodeRect),
      // but `dx`/`dy` in onMove are CSS px (delta.* is divided by
      // scale via getCanvasDelta). The percent-mode formula
      // `startLeftPercent + (dx / parentWidth) * 100` only works
      // when both are in the same units — pre-dividing parentWidth/
      // Height by scale here gives us CSS-px parent dimensions and
      // the percent commit lands at the right value at any zoom.
      const scaleAtStart = context.transform.scale || 1;
      // Un-rotated CSS box dimensions for pin math on transformed
      // elements. computedCache hits — sync, fast at 60fps. Fall back
      // to the screen-rect height/width over scale only if the cache
      // miss returns a non-numeric value (defensive — shouldn't happen
      // for elements the strategy has already lifted).
      const cssDims = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
      const cssW = parseFloat(cssDims.width);
      const cssH = parseFloat(cssDims.height);
      // Parent CSS box dimensions for the dynamic-pin band math.
      // `findNodeRect / scale` returns the parent's SCREEN AABB
      // (post-transform) — for a rotated/skewed parent (or one
      // inheriting transforms from an ancestor) that AABB is the
      // bounding box of the painted quad, NOT the layout box.
      // Banding against the AABB makes the bands the wrong size →
      // element auto-pins to the wrong position → visible offset on
      // every dynamic-pin write while inside a transformed cell.
      // The parent's computed `width`/`height` give the un-rotated
      // layout box regardless of transform stack — what the bands
      // should actually be measured against.
      const parentCssDims = findNodeComputedStyles(this.parentId, this.vpId, ['width', 'height']);
      const parentCssW = parseFloat(parentCssDims.width);
      const parentCssH = parseFloat(parentCssDims.height);
      this.startInsets.set(node.id, {
        // Read right/bottom/left/top from the effective styles so a
        // replica-only inset pin captures the correct starting values
        // for the locked-pin onMove math (`cs.right = sd.right - dx`).
        // Base-only reads would store 0 here for an element whose
        // right/bottom live exclusively in the @media rule, and the
        // commit would write `right: -dx` instead of preserving the
        // user's pin.
        right: parseFloat(effectiveNs.right || '0') || 0,
        bottom: parseFloat(effectiveNs.bottom || '0') || 0,
        inset,
        isPercentMode,
        startLeftPercent: parseFloat(effectiveNs.left || '0') || 0,
        startTopPercent: parseFloat(effectiveNs.top || '0') || 0,
        parentWidth: Number.isFinite(parentCssW) && parentCssW > 0
          ? parentCssW
          : (parentDimRect?.width ?? 1) / scaleAtStart,
        parentHeight: Number.isFinite(parentCssH) && parentCssH > 0
          ? parentCssH
          : (parentDimRect?.height ?? 1) / scaleAtStart,
        elemCssWidth: Number.isFinite(cssW) ? cssW : node.width / scaleAtStart,
        elemCssHeight: Number.isFinite(cssH) ? cssH : node.height / scaleAtStart,
      });
    }

    if (this.parentId) {
      const parentTransform = findNodeComputedStyle(this.parentId, this.vpId, 'transform');
      trace.action('abs-in-frame:start', {
        nodeId: firstNode.id, parentId: firstNode.startParentId, parentTransform,
        parentHasRotation: parentTransform && parentTransform !== 'none'
          ? (() => { const m = new DOMMatrix(parentTransform); return matrixHasRotationSkewOrFlip(m); })()
          : false,
        scale: context.transform.scale, vpId: this.vpId,
      });
    }

    // Snapshot lift-time corners (canvas-space) for transform-aware snap.
    this.liftCorners.clear();
    this.refreshLiftCorners(context.draggedNodes.map(n => n.id), context.transform);
  }

  /** Snapshot the current screen corners of each given node into
   *  `liftCorners` (in canvas-space). The per-frame snap path projects
   *  these by the CSS drag delta to get the live corner positions.
   *
   *  Called at:
   *    • `onStart` — captures original lift-time corners.
   *    • Both reparent paths (grandparent / sibling) — the snap
   *      baseline must move with the reparent because `startLeft/Top`
   *      get reset to the new parent's local coords. Without this
   *      refresh, the next onMove projects the OLD canvas-space corners
   *      by a delta computed against the NEW parent — snap lines fire
   *      at wildly wrong positions until the user drops and restarts.
   *
   *  The corner read goes through `getScreenCornersById` which composes
   *  the full ancestor transform matrix — works correctly regardless of
   *  how many rotated frames sit between the element and the canvas. */
  private refreshLiftCorners(
    nodeIds: string[],
    transform: { x: number; y: number; scale: number },
  ): void {
    const iframeOffset = getIframeOffset();
    const toCanvas = (p: { x: number; y: number }) => screenPointToCanvas(p, transform, iframeOffset);
    for (const id of nodeIds) {
      const c = getScreenCornersById(id, this.vpId);
      if (c) {
        this.liftCorners.set(id, {
          TL: toCanvas(c.TL), TR: toCanvas(c.TR),
          BR: toCanvas(c.BR), BL: toCanvas(c.BL),
        });
      } else {
        // Corners cache miss after the reparent flush. Drop the stale
        // entry so the snap path falls through to AABB-only (handled
        // by `snap-handler` when corners are absent) instead of using
        // the old-parent corners — better to lose corner precision
        // for one frame than to snap to the wrong position.
        this.liftCorners.delete(id);
      }
    }
  }

  onMove(context: DragContext, mouseScreen: Point): DragMoveResult {
    const { draggedNodes, startMouse, transform, contentEl } = context;
    const screenDx = mouseScreen.x - startMouse.x;
    const screenDy = mouseScreen.y - startMouse.y;
    const primary = draggedNodes[0];

    // Convert the SCREEN drag delta into the parent's LOCAL coord
    // system via PROJECTIVE inversion. Same approach handles affine
    // and perspective parents uniformly — the projective math reduces
    // to the affine basis-inverse formula when the parent's quad is a
    // parallelogram (perspective row collapses to [0, 0, 1]).
    //
    // The previous implementation tried to approximate perspective by
    // sampling the child's local Jacobian — that worked at the lift
    // point but drifted exponentially as the cursor moved toward (or
    // away from) the vanishing direction, because a 2×2 affine basis
    // can't capture the position-dependent foreshortening of a
    // projective map. Inverting the FULL 3×3 homography fixes that:
    // we project both the start cursor and the current cursor through
    // the inverse map, then take the local difference — so the local
    // delta is exact at any cursor position, no matter how deep into
    // the perspective the drag goes.
    //
    // Geometrically: if the user grabs a point P (in parent-local
    // space) on the element, that point's screen position must track
    // the cursor. P moves by `localCurrent − localStart` in parent
    // coords. The element follows by that same delta.
    //
    // No parent (canvas-level drag) falls back to plain scaled delta.
    let delta: Point;
    if (this.parentId) {
      // SVG GROUP parent: invert the STABLE wrapper matrix (M_topSvg, from the
      // `__svgm*` keys). It maps the group's viewBox-user space (where the
      // child's x/y ATTRS live) ↔ screen, and — unlike the getBBox-based
      // corner homography — does NOT move as the child being dragged shifts the
      // group's painted bounds. Correct at any zoom + rotation, no jitter.
      const svgMap = buildParentSvgGroupMap(this.parentId, this.vpId);
      const svgInv = svgMap ? invertAffine(svgMap) : null;
      if (svgInv) {
        const ls = svgInv.invertScreen(startMouse.x, startMouse.y);
        const lc = svgInv.invertScreen(mouseScreen.x, mouseScreen.y);
        delta = { x: lc.x - ls.x, y: lc.y - ls.y };
      } else {
        // Non-SVG (or no matrix yet): the projective corner homography handles
        // rotated/perspective HTML parents.
        const projMap = buildParentScreenMapProjective(this.parentId, this.vpId);
        const inv = projMap ? invertProjective(projMap) : null;
        if (inv) {
          const localStart = inv.invertScreen(startMouse.x, startMouse.y);
          const localCurrent = inv.invertScreen(mouseScreen.x, mouseScreen.y);
          delta = { x: localCurrent.x - localStart.x, y: localCurrent.y - localStart.y };
        } else {
          delta = { x: screenDx / transform.scale, y: screenDy / transform.scale };
        }
      }
    } else {
      delta = { x: screenDx / transform.scale, y: screenDy / transform.scale };
    }

    // Shift+drag → lock movement to the dominant axis (5px threshold
    // for the initial decision; afterwards the locked axis is held
    // while shift stays pressed). Releasing shift resets so the user
    // can engage / disengage mid-drag. Matches `CanvasDragStrategy`'s
    // implementation — both strategies handle the same gesture the
    // same way.
    if (context.modifiers.shift) {
      if (!this.axisLockDetermined && (Math.abs(delta.x) > 5 || Math.abs(delta.y) > 5)) {
        this.lockedAxis = Math.abs(delta.x) > Math.abs(delta.y) ? 'x' : 'y';
        this.axisLockDetermined = true;
      }
      if (this.lockedAxis === 'x') delta.y = 0;
      if (this.lockedAxis === 'y') delta.x = 0;
    } else if (this.axisLockDetermined) {
      this.lockedAxis = null;
      this.axisLockDetermined = false;
    }

    const parentOffset = this.parentId ? getParentCanvasOffsetById(this.parentId, this.vpId, transform) : { x: 0, y: 0 };
    const newLeft = Math.round(primary.startLeft + delta.x);
    const newTop = Math.round(primary.startTop + delta.y);
    const absLeft = parentOffset.x + newLeft;
    const absTop = parentOffset.y + newTop;

    const draggedIds = new Set(draggedNodes.map(n => n.id));
    const excludedIds = new Set(draggedIds);
    for (const node of draggedNodes) {
      const nd = context.nodes.get(node.id);
      if (nd?.children) { const addD = (ids: string[]) => { for (const c of ids) { excludedIds.add(c); const cn = context.nodes.get(c); if (cn?.children) addD(cn.children); } }; addD(nd.children); }
    }

    // When the parent (or ANY ancestor) is rotated/skewed, the normal
    // sibling-AABB snap targets are visually nonsensical: a rotated
    // parent's children have AABBs that don't line up with what the
    // user sees, and "snap left edge of dragged to left edge of
    // sibling" lands somewhere off the visible quad. For now, just
    // disable snap entirely in this case — guides go away, drag
    // follows the raw cursor. The `snap` block further down handles
    // the suppression; here we still collect siblings for the
    // non-transformed code paths to share the same array.
    // SVG-GROUP CHILD: snap is disabled the same way. The child's position
    // lives in the group's VIEWBOX units while the snap engine measures
    // canvas-CSS rects — at any zoom/scale mismatch the threshold covers
    // half the group and the child PINS to a guide on every tick
    // (trace 2026-07-28: `snap:result snappedX:true` on every move — the
    // dragged letter "offsets completely" instead of following the mouse).
    const primaryNodeForSnap = getNodeFromCache(context.draggedNodes[0]?.id ?? '');
    const isSvgGroupChildDrag = primaryNodeForSnap?.type === 'svg'
      && (primaryNodeForSnap.parentId ? getNodeFromCache(primaryNodeForSnap.parentId)?.type === 'svg' : false);
    const insideTransformedAncestor = (!!this.parentId
      && nodeOrAncestorHasRotationOrSkewById(this.parentId, this.vpId))
      || isSvgGroupChildDrag;

    const siblingRects: { id: string; rect: Rect }[] = [];
    if (this.parentId && !insideTransformedAncestor) {
      for (const child of findChildRects(this.parentId, this.vpId)) {
        if (excludedIds.has(child.id)) continue;
        const ar = getAbsoluteCanvasRectById(child.id, this.vpId, transform);
        if (ar) siblingRects.push({ id: child.id, rect: ar });
      }
      // Include the parent's own rect so its edges/center are snap targets.
      // Without this, dragging a child to the parent's left/top/right/bottom
      // edge produced no snap — the user expects a guide there because the
      // parent IS the visible boundary the child is moving inside. Spacing
      // and same-size detection naturally ignore it (parent is much bigger
      // than the dragged child, and any gap to siblings comes out negative).
      const parentRect = getAbsoluteCanvasRectById(this.parentId, this.vpId, transform);
      if (parentRect) siblingRects.push({ id: this.parentId, rect: parentRect });
    }

    // Container-set masters (icon-set): every node on the
    // master canvas — variant containers (children of `root`) AND
    // free-floating canvas nodes alongside them — should snap against
    // every other one. Without this extra collection, a variant being
    // dragged ONLY sees other variants (its siblings under root), and
    // canvas nodes are invisible to the snap engine; conversely a
    // dragged canvas node only sees other canvas nodes. Cross-class
    // snapping is what the user expects: align a variant card to a
    // floating shape, or vice versa, with the same alignment guides
    // they get on a regular page.
    const apForSnap = getActiveFilePath();
    const isContainerMasterForSnap = isIconSetFilePath(apForSnap);
    // Skip the container-master cross-class collection when we're in
    // transformed-parent mode — adding canvas nodes / variant cards
    // back would re-introduce the multi-target snap noise we just
    // collapsed to a single centre point.
    if (isContainerMasterForSnap && !insideTransformedAncestor) {
      const seen = new Set(siblingRects.map(s => s.id));
      for (const [otherId, otherNode] of context.nodes) {
        if (excludedIds.has(otherId)) continue;
        if (seen.has(otherId)) continue;
        // Only top-level pieces of the master canvas:
        //   - canvas nodes (`isCanvasNode === true`, `parentId === null`)
        //   - root's direct children (variant containers)
        const isRootChild = otherNode.parentId === 'root';
        const isCanvasNode = !!otherNode.isCanvasNode;
        if (!isRootChild && !isCanvasNode) continue;
        const ar = getAbsoluteCanvasRectById(otherId, this.vpId, transform);
        if (ar) siblingRects.push({ id: otherId, rect: ar });
      }
    }

    // Overlays are portal-rendered siblings of normal frame children — never a
    // valid snap target (an overlay follows its own trigger, so a node snapping
    // to it glitches). Drop them from the candidate set — EXCEPT the drag PARENT:
    // a child dragged INSIDE a fixed/relative overlay must snap to that overlay's
    // OWN edges/center like any parent (line 855 added it on purpose). Without
    // this skip, an overlay's absolute child got ZERO snap guides — the parent
    // was added then immediately spliced out here because it's an overlay.
    for (let i = siblingRects.length - 1; i >= 0; i--) {
      if (siblingRects[i].id === this.parentId) continue;
      if (isOverlayNode(context.nodes.get(siblingRects[i].id))) siblingRects.splice(i, 1);
    }

    // primary.width/height are SCREEN pixels (from findNodeRect). Sibling rects
    // are CSS pixels (canvas-space). Divide by scale so the dragged AABB right/
    // bottom edges land in the same coordinate space as siblings — otherwise
    // right and bottom edge snaps fail at any zoom ≠ 1.
    const dragCssWidth = primary.width / transform.scale;
    const dragCssHeight = primary.height / transform.scale;

    // Visible-vs-CSS offset from the element's `transform: translate(...)`.
    // `absLeft/absTop` are derived from `startLeft + delta` which is the CSS
    // position, NOT the visible rect. For a percent-translated element
    // (`translate(-50%, -50%)` for centering) the visible position is
    // shifted by -W/2 / -H/2. Shifting the draggedRect by that offset
    // makes snap candidates align with the EDGES the user actually sees;
    // we shift snap.x/y back to CSS coords below so the strategy's
    // commit math (`startLeft + dx`) still produces the right css value.
    const tOrig = this.originalTransforms.get(primary.id) ?? '';
    const tOffset = parseTranslateOffset(tOrig, dragCssWidth, dragCssHeight);
    const draggedRect: Rect = {
      left: absLeft + tOffset.x,
      top: absTop + tOffset.y,
      width: dragCssWidth,
      height: dragCssHeight,
    };
    const velocity = getMouseVelocity(this.prevMouse, mouseScreen);

    // Transform-aware: project lift-time corners by total drag delta.
    let aifDragCorners: import('../handlers/snap-handler').ScreenCorners | null = null;
    const liftedAifC = this.liftCorners.get(primary.id);
    if (liftedAifC) {
      const dxCss = newLeft - primary.startLeft;
      const dyCss = newTop - primary.startTop;
      aifDragCorners = {
        TL: { x: liftedAifC.TL.x + dxCss, y: liftedAifC.TL.y + dyCss },
        TR: { x: liftedAifC.TR.x + dxCss, y: liftedAifC.TR.y + dyCss },
        BR: { x: liftedAifC.BR.x + dxCss, y: liftedAifC.BR.y + dyCss },
        BL: { x: liftedAifC.BL.x + dxCss, y: liftedAifC.BL.y + dyCss },
      };
    }
    // Siblings don't move during drag — read corners fresh and convert once.
    const aifIframeOffset = getIframeOffset();
    const aifToCanvas = (p: { x: number; y: number }) => screenPointToCanvas(p, transform, aifIframeOffset);
    const aifSiblingCorners = new Map<string, import('../handlers/snap-handler').ScreenCorners>();
    for (const { id } of siblingRects) {
      const c = getScreenCornersById(id, this.vpId);
      if (c) {
        aifSiblingCorners.set(id, {
          TL: aifToCanvas(c.TL), TR: aifToCanvas(c.TR), BR: aifToCanvas(c.BR), BL: aifToCanvas(c.BL),
        });
      }
    }

    // Disable snap entirely when dragging inside a transformed
    // ancestor chain — the engine's edge / corner / spacing guides
    // don't line up with what the user sees once rotation/skew is in
    // play, and even the centre-only fallback feels noisy. Return an
    // empty snap result so the drag uses the raw position.
    const snap = insideTransformedAncestor
      ? {
          x: draggedRect.left,
          y: draggedRect.top,
          snappedX: false,
          snappedY: false,
          guides: [],
          spacingGuides: [],
        }
      : calculateSnap(
          draggedRect,
          siblingRects,
          velocity,
          SNAP_THRESHOLD / transform.scale,
          aifDragCorners,
          aifSiblingCorners,
          getActiveRulerGuideSnapLines(),
        );
    this.prevMouse = mouseScreen;

    // `snap.x/y` are in VISIBLE coords (we shifted draggedRect by tOffset
    // above). Shift back to CSS coords so the strategy's downstream math
    // — which expects css positions — gets the right value. For an
    // un-snapped axis, fall back to the un-shifted absLeft/absTop
    // (which are already in css coords).
    const finalAbsLeft = snap.snappedX ? (snap.x - tOffset.x) : absLeft;
    const finalAbsTop = snap.snappedY ? (snap.y - tOffset.y) : absTop;
    const snapOffsetX = (finalAbsLeft - parentOffset.x) - newLeft;
    const snapOffsetY = (finalAbsTop - parentOffset.y) - newTop;

    for (const node of draggedNodes) {
      const dx = delta.x + snapOffsetX;
      const dy = delta.y + snapOffsetY;
      const sd = this.startInsets.get(node.id);
      const inset = sd?.inset;
      const isRep = !!context.viewportPrefix;
      const cs: Record<string, string> = {};

      const isDynamicPin = this.dynamicPinNodes.has(node.id);

      if (isDynamicPin && sd) {
        // ── DYNAMIC PINNING (standard) ─────────────────────────────
        // Each tick: pick pin sides based on the element's CURRENT
        // parent-local rect.
        //
        // Rule selection by parent type (computed at strategy start):
        //   • VIEWPORT parent (page/layout root) → Y is ALWAYS top-px.
        //     Pages scroll arbitrarily; a bottom pin against the
        //     viewport would jump as the page grows.
        //   • FRAME parent (any nested container) → full 3×3 zone rule
        //     on both axes.
        //
        // 3-band rule keyed on the child's CENTER position (center-
        // based avoids flicker for elements straddling band edges):
        //   X axis (both parent types):
        //     • Band 1 (left)   → `left` in px
        //     • Band 2 (middle) → `left` in % (free horizontal)
        //     • Band 3 (right)  → `left` in px BY DEFAULT
        //                        → `right` in px ONLY when snapped to
        //                          the parent's right inner edge
        //   Y axis (frame parents only — viewport stays top-px):
        //     • Band 1 (top)    → `top` in px
        //     • Band 2 (middle) → `top` in % (free vertical)
        //     • Band 3 (bottom) → `bottom` in px (auto — no snap needed)
        // Un-rotated CSS box dims for the snapshot (set in onStart /
        // reparent). For NON-transformed elements `node.width / scale`
        // matches `elemCssWidth`; for rotated/skewed elements the
        // bounding rect is the larger AABB and using it here would jump
        // the element on pin-switch (`bottom = parentH - top - height`).
        // Fall back to the screen-rect-over-scale only when the
        // snapshot is missing (defensive — should never happen since
        // every node in `dynamicPinNodes` had `sd` set above).
        const elemCssW = sd.elemCssWidth || (node.width / context.transform.scale);
        const elemCssH = sd.elemCssHeight || (node.height / context.transform.scale);
        const newLeftCss = node.startLeft + dx;
        const newTopCss = node.startTop + dy;

        // Snap-to-right detection: element's right edge sits within 1px
        // of the parent's inner right edge. Tied to the same snap output
        // as the visual snap guides — when the user sees the right
        // snap line light up, the pin promotes to `right-px`.
        const elemRightInParent = newLeftCss + elemCssW;
        const snappedToRightEdge =
          snap.snappedX && Math.abs(elemRightInParent - sd.parentWidth) <= 1;

        const pins = computeAutoPins(
          newLeftCss, newTopCss,
          elemCssW, elemCssH,
          sd.parentWidth, sd.parentHeight,
          snappedToRightEdge,
          this.parentIsViewport,
        );

        // X axis — left-px / left-percent / right-px.
        if (pins.x === 'right-px') {
          cs.right = `${Math.round(sd.parentWidth - newLeftCss - elemCssW)}px`;
          cs.left = '';
        } else if (pins.x === 'left-percent') {
          // Percent anchor matches the user's manual "LEFT %" pin.
          // Guard against div-by-zero — collapsed parent has no anchor.
          const pct = sd.parentWidth > 0 ? (newLeftCss / sd.parentWidth) * 100 : 0;
          cs.left = `${pct.toFixed(4)}%`;
          cs.right = '';
        } else {
          // 'left-px' (band 1 default, or band 3 without snap)
          cs.left = `${Math.round(newLeftCss)}px`;
          cs.right = '';
        }

        // Y axis — top-px / top-percent / bottom-px.
        if (pins.y === 'bottom-px') {
          cs.bottom = `${Math.round(sd.parentHeight - newTopCss - elemCssH)}px`;
          cs.top = '';
        } else if (pins.y === 'top-percent') {
          const pct = sd.parentHeight > 0 ? (newTopCss / sd.parentHeight) * 100 : 0;
          cs.top = `${pct.toFixed(4)}%`;
          cs.bottom = '';
        } else {
          // 'top-px' (viewport always, or frame band 1)
          cs.top = `${Math.round(newTopCss)}px`;
          cs.bottom = '';
        }
      } else {
        // ── LOCKED PINS (existing inset/percent logic) ─────────────────
        // User has manually pinned via Position panel (data-pinned="true").
        // Compute the WOULD-BE inset/percent values (committed on mouseup).
        // Per-frame DOM write below uses `transform: translate(...)` for
        // the visual offset (compositor-only, no layout pass per tick)
        // and lets these computed style values land in JSX only at
        // commit time.
        if (inset?.pins.left && inset?.pins.right) { cs.left = `${Math.round(node.startLeft + dx)}px`; cs.right = `${Math.round(sd!.right - dx)}px`; }
        else if (inset?.pins.right && !inset?.pins.left) { cs.right = `${Math.round(sd!.right - dx)}px`; }
        else if (sd?.isPercentMode && !inset?.pins.left) { cs.left = `${(sd.startLeftPercent + (dx / sd.parentWidth) * 100).toFixed(4)}%`; }
        else { cs.left = `${Math.round(node.startLeft + dx)}px`; }

        if (inset?.pins.top && inset?.pins.bottom) { cs.top = `${Math.round(node.startTop + dy)}px`; cs.bottom = `${Math.round(sd!.bottom - dy)}px`; }
        else if (inset?.pins.bottom && !inset?.pins.top) { cs.bottom = `${Math.round(sd!.bottom - dy)}px`; }
        else if (sd?.isPercentMode && !inset?.pins.top) { cs.top = `${(sd.startTopPercent + (dy / sd.parentHeight) * 100).toFixed(4)}%`; }
        else { cs.top = `${Math.round(node.startTop + dy)}px`; }
      }

      // Per-frame visual update.
      //
      // DYNAMIC-PIN nodes: BROADCAST `cs.left/right/top` + `transform: orig`
      // to every viewport via `updateNodeStyles({ domOnly: true })`. Real
      // pin values land on the DOM each tick — visual position, pin
      // constraint lines, and Position panel pin badges all agree.
      // `transform: orig` (no drag-delta) — cs already represents the
      // cursor-following position; a per-frame `translate(dx, dy)` would
      // stack on top → 2× speed.
      //
      // Broadcasting (not single-vp patch) makes ALL replicas track the
      // primary live — px values are viewport-independent (`left: 100px`
      // looks the same on desktop / tablet / mobile), and percent values
      // resolve per-viewport against each parent. The replica fan-out
      // below SKIPS dynamic-pin nodes (this broadcast already covered
      // them).
      //
      // `updateNodeInCache` mirrors cs into the imperative cache.
      // PinControl + PinConstraintLines RAF-poll `getNodeFromCache` mid-
      // drag (bypasses jotai entirely — no signal fires, no render
      // cascade through unrelated components like SketchEditOverlay).
      //
      // LOCKED nodes: GPU-cheap `transform: translate` path; cs values
      // commit on mouseup via `lastStyles`.
      const orig = this.originalTransforms.get(node.id) ?? '';
      const isDynamicPinNode = this.dynamicPinNodes.has(node.id);
      if (isDynamicPinNode) {
        updateNodeStyles({
          id: node.id,
          styles: { ...cs, transform: orig },
          contentEl,
          domOnly: true,
        });
        updateNodeInCache(node.id, cs);
        // Note: no jotai signal fired here. The Position panel + pin
        // constraint lines pick up the live `cs` via their own RAF poll
        // (PinControl / PinConstraintLines call `getNodeFromCache` mid-
        // drag while `canvasInteractingAtom` is true — bypasses jotai
        // entirely, no render cascade through any other component).
      } else if (this.flexGroupChildRefit.has(node.id)) {
        // Flex group-child: write the new x/y LIVE (updateNodeStyles redirects
        // left/top → x/y attrs for a group child) so the sandbox refit reads the
        // real dragged position, then auto-fit the group to its painted bounds.
        // NOT the GPU transform path — that leaves x/y stale until mouseup.
        trace.action('abs-in-frame:svg-child-tick', {
          id: node.id, startLeft: node.startLeft, startTop: node.startTop,
          dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100,
          mouse: { x: Math.round(mouseScreen.x), y: Math.round(mouseScreen.y) },
          start: { x: Math.round(startMouse.x), y: Math.round(startMouse.y) },
        });
        updateNodeStyles({
          id: node.id,
          styles: { left: `${Math.round(node.startLeft + dx)}px`, top: `${Math.round(node.startTop + dy)}px` },
          contentEl,
          domOnly: true,
        });
        getCanvasBridge().liveRefitGroup?.(this.flexGroupChildRefit.get(node.id)!, context.viewportPrefix);
      } else if (this.rotatedSvgGroupNodes.has(node.id)) {
        // Rotated nested group: write x/y ATTRS + shift the rotate pivot by the
        // drag delta (pivot moves with the group), so the `transform` attribute
        // rotation is preserved live (the CSS `transform: translate` path would
        // clobber it). cs (left/top) still commits to x/y attrs on mouseup.
        const r = this.rotatedSvgGroupNodes.get(node.id)!;
        const nx = Math.round(node.startLeft + dx);
        const ny = Math.round(node.startTop + dy);
        getCanvasBridge().patchAttrsAndStyles?.(node.id, context.viewportPrefix, {
          x: `${nx}`, y: `${ny}`,
          transform: `rotate(${r.angle} ${Math.round((r.cx0 + dx) * 1000) / 1000} ${Math.round((r.cy0 + dy) * 1000) / 1000})`,
        }, {});
        // Auto-fit the ancestor chain live (flex-layout top reflows; no-op on canvas).
        const rp = getNodeFromCache(node.id)?.parentId;
        if (rp) getCanvasBridge().liveRefitGroup?.(rp, context.viewportPrefix);
      } else {
        const transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)${orig ? ' ' + orig : ''}`;
        patchNodeStyles(contentEl, node.id, context.viewportPrefix, { transform }, isRep);
      }

      // A static svg made draggable this gesture commits position:absolute so its
      // left/top actually take effect (cs → lastStyles → source on mouseup).
      if (this.svgNeedsAbsolute.has(node.id)) cs.position = 'absolute';

      this.lastPositions.set(node.id, { left: Math.round(node.startLeft + dx), top: Math.round(node.startTop + dy) });
      this.lastStyles.set(node.id, cs);
    }

    for (const node of draggedNodes) {
      // ── Replica fan-out ───────────────────────────────────────────────
      // For PERCENT-mode elements, a constant px translate would visually
      // offset replicas wrong: `left: 50%` on a 1440-px parent vs a 768-px
      // parent renders at different x positions; a px-equal drag delta
      // moves them by the same screen amount instead of the same
      // fractional amount. Scale the per-replica translate by
      // `replicaParentWidth / primaryParentWidth` so each viewport sees
      // the SAME PERCENT shift.
      //
      // DYNAMIC-PIN nodes: SKIP the fan-out entirely. The per-frame loop
      // above already wrote `{ ...cs, transform: orig }` to the primary;
      // a transform write here on top would double the visual offset
      // (cs already positions the element + translate(dx, dy) shifts it
      // AGAIN). Replicas don't update mid-drag for dynamic-pin nodes;
      // they sync on mouseup via the cs commit to source.
      if (this.dynamicPinNodes.has(node.id)) continue;
      // FLEX group-child: same reason — the per-frame loop already wrote its x/y
      // live (and ran the group refit). A transform fan-out here would stack on
      // top → the dragged child moves at 2× speed. Its x/y is viewport-
      // independent (SVG attrs, not @media), so replicas need no live update;
      // they sync on the mouseup commit.
      if (this.flexGroupChildRefit.has(node.id)) continue;
      // Rotated nested group: handled by the x/y-attrs + pivot write above; its
      // position is viewport-independent (SVG attrs), so no replica fan-out (a
      // transform write here would clobber the rotation again).
      if (this.rotatedSvgGroupNodes.has(node.id)) continue;
      // SVG GROUP CHILD on the GPU-transform path (absolute group) — the third
      // sibling of the two skips above, missed originally. Its position is
      // either the shared x/y ATTRS (replicas sync on the mouseup commit) or a
      // per-variant x/y delta painted as that variant's OWN folded transform.
      // Fanning translate(dx,dy) here clobbers an independently-positioned
      // variant child live (user find 2026-06-11: primary drag visually synced
      // the variant-1 child, which snapped back on mouseup once the commit
      // compensation ran — the final state was right, the mid-drag override
      // wasn't).
      {
        const fanNode = context.nodes.get(node.id);
        const fanParent = fanNode?.parentId ? context.nodes.get(fanNode.parentId) : null;
        if (fanNode?.type === 'svg' && fanParent?.type === 'svg') continue;
      }

      const orig = this.originalTransforms.get(node.id) ?? '';
      const dx = delta.x + snapOffsetX;
      const dy = delta.y + snapOffsetY;
      const sd = this.startInsets.get(node.id);

      // Per-viewport effective transform helper. The dragged viewport's
      // `orig` already reflects its own @media transform (snapshotted
      // at onStart from effectiveNs). For OTHER viewports, the base
      // transform may differ from their per-replica `@media` transform
      // — applying the dragged viewport's transform uniformly would
      // bleed (e.g.) a tablet-only rotation onto the primary's
      // painting during drag. Compute each viewport's effective
      // transform individually here.
      const nodeBaseTransform = ((context.nodes.get(node.id)?.styles?.transform) || '').trim();
      const containerOverridesForFan = getDefaultStore().get(containerOverridesAtom);
      const allVpsForFan = getDefaultStore().get(viewportsConfigAtom);
      const getEffectiveTransformForVp = (vpId: string): string => {
        if (vpId === this.vpId) return orig;
        const vpCfg = allVpsForFan.find(v => v.id === vpId);
        const maxWidth = vpCfg?.width ?? 0;
        const replicaProps = containerOverridesForFan.get(node.id)?.get(maxWidth);
        const overrideT = replicaProps?.get('transform');
        if (overrideT && overrideT !== '' && overrideT !== 'auto' && overrideT !== 'none') return overrideT;
        return nodeBaseTransform === 'none' ? '' : nodeBaseTransform;
      };

      const replicaTransformStr = (replicaDx: number, replicaDy: number, replicaOrig: string) =>
        `translate(${Math.round(replicaDx)}px, ${Math.round(replicaDy)}px)${replicaOrig ? ' ' + replicaOrig : ''}`;

      // Asymmetric fan-out — same routing semantics as
      // `updateNodeStyles({ domOnly: true })`:
      //   • Drag started on REPLICA → write only to that replica's
      //     painting. Other viewports (incl. primary) stay at their
      //     own base styles. A replica drag must NEVER move the
      //     primary's painting — the user perceives that as the
      //     dragged element "ghosting" into desktop.
      //   • Drag started on PRIMARY → write to primary AND fan out
      //     to every replica's painting with each one's own effective
      //     transform (so a replica-only rotation isn't bled into
      //     other viewports). Replicas inherit the live primary
      //     position because that's the cascade direction — base
      //     styles propagate up to replicas via the editor's
      //     responsive cascade.
      const draggedOnPrimary = isPrimaryViewport(this.vpId);
      const isPercentMode = !!sd?.isPercentMode;
      const bridge = getCanvasBridge();

      if (isPercentMode && draggedOnPrimary) {
        // Percent-mode fan-out with per-parent percent scaling.
        // A constant px translate would offset replicas wrong for
        // percent-positioned elements: `left: 50%` on a 1440-px
        // parent vs a 768-px parent renders at different x positions,
        // and a px-equal drag delta moves them by the same screen
        // amount instead of the same fractional amount. Scale by
        // `replicaParentWidth / primaryParentWidth` so each viewport
        // sees the SAME PERCENT shift. Primary's own write happens
        // via the per-frame loop above (patchNodeStyles).
        const primaryNode = context.nodes.get(node.id);
        const primaryParentId = primaryNode?.parentId;
        if (primaryParentId && 'rectCache' in bridge) {
          const primaryParentRect = findNodeRect(primaryParentId, this.vpId);
          const primaryParentCssW = (primaryParentRect?.width ?? 1) / context.transform.scale;
          const primaryParentCssH = (primaryParentRect?.height ?? 1) / context.transform.scale;
          if (primaryParentCssW > 0 && primaryParentCssH > 0) {
            const cache = (bridge as any).rectCache as Map<string, DOMRect>;
            for (const key of cache.keys()) {
              const parsed = parseRectCacheKey(key);
              if (!parsed) continue;
              const { vpPrefix: prefix, nodeId: dataId } = parsed;
              if (dataId !== node.id) continue;
              if (prefix === context.viewportPrefix) continue;
              const replicaVpId = vpIdFromPrefix(prefix);
              // A variant that owns its position (left/top or x/y deltas in
              // its entry) must NOT mirror the primary's drag — it would
              // live-sync then snap back on mouseup (live report 2026-06-13).
              const ovr1 = getVariantOverriddenKeys(node.id, replicaVpId);
              if (ovr1?.has('transform')) continue;
              const replicaParentRect = findNodeRect(primaryParentId, replicaVpId);
              if (!replicaParentRect) continue;
              const replicaParentCssW = replicaParentRect.width / context.transform.scale;
              const replicaParentCssH = replicaParentRect.height / context.transform.scale;
              const ratioX = replicaParentCssW / primaryParentCssW;
              const ratioY = replicaParentCssH / primaryParentCssH;
              const replicaOrig = getEffectiveTransformForVp(replicaVpId);
              bridge.patchStyles(node.id, prefix, {
                transform: replicaTransformStr(dx * ratioX, dy * ratioY, replicaOrig),
              }, false);
            }
          }
        }
        continue;  // primary write already handled in per-frame loop
      }

      // Px-mode or replica drag: write to the DRAGGED viewport always.
      bridge.patchStyles(node.id, context.viewportPrefix, {
        transform: replicaTransformStr(dx, dy, orig),
      }, !isPrimaryViewport(this.vpId));

      // Only fan out to other viewports when the drag started on
      // primary. A replica drag is intentionally isolated to its own
      // viewport — replica @media commits at mouseup, NOT mid-drag,
      // and primary stays at its base position throughout. The
      // per-frame loop above patches the dragged primary directly,
      // so the iteration below is the cross-vp mirror for those
      // primary updates.
      if (draggedOnPrimary && 'rectCache' in bridge) {
        const cache = (bridge as unknown as { rectCache: Map<string, DOMRect> }).rectCache;
        for (const key of cache.keys()) {
          const parsed = parseRectCacheKey(key);
          if (!parsed) continue;
          const { vpPrefix: prefix, nodeId: dataId } = parsed;
          if (dataId !== node.id) continue;
          if (prefix === context.viewportPrefix) continue;
          const replicaVpId = vpIdFromPrefix(prefix);
          // Independent-position variants don't follow the primary drag
          // (same rule as the percent-scaled loop above).
          const ovr2 = getVariantOverriddenKeys(node.id, replicaVpId);
          if (ovr2?.has('transform')) continue;
          const replicaOrig = getEffectiveTransformForVp(replicaVpId);
          bridge.patchStyles(node.id, prefix, {
            transform: replicaTransformStr(dx, dy, replicaOrig),
          }, !isPrimaryViewport(replicaVpId));
        }
      }
    }

    if (snap.snappedX || snap.snappedY || snap.spacingGuides.length > 0) {
      trace.action('snap:result', { strategy: 'absolute-in-frame', snappedX: snap.snappedX, snappedY: snap.snappedY, guides: snap.guides.length, spacingGuides: snap.spacingGuides.length });
    }

    if (this.entryGraceCounter > 0) this.entryGraceCounter--;

    // Exit detection via bridge rects
    if (!this.parentIsFlexGrid && this.parentId && !this.exitedParent && this.entryGraceCounter === 0) {
      const elRect = findNodeRect(primary.id, this.vpId);
      const parentRect = findNodeRect(this.parentId, this.vpId);
      if (elRect && parentRect) {
        // Exit predicate depends on the destination determined at lift:
        //   - `canvas`      → "not fully inside" (aggressive — any corner
        //                     out unparents to canvas immediately).
        //   - `grandparent` → "fully outside" (conservative — wait until
        //                     the element has completely left its parent
        //                     before walking up the hierarchy).
        //   - `useCursorExit` (set after a sibling-reparent during drag)
        //                  → cursor-leaves-parent. The element rect can
        //                    extend past the new parent's edges without
        //                    triggering exit; only the cursor leaving
        //                    the parent counts. Mirrors the user's
        //                    mental model: "while my cursor is over
        //                    green, I'm parenting into green".
        // For rotated parents we route through point-in-quad helpers
        // (or a point-in-quad cursor check when useCursorExit is on).
        let out: boolean;
        // Icon-set master files: only VARIANT CONTAINERS
        // (data-id listed in iconConfig — direct children
        // of the master root) are pinned to master root. Shapes INSIDE
        // those containers (sub-shapes inside a vector, including
        // sketches drawn into a vector card) are allowed to exit
        // normally — they should be draggable out to canvas or into a
        // sibling card. Each master is a grid of variant cards
        // pinned at master root, and the position of those cards lives
        // in the iconConfig array, not inline styles.
        const isContainerSetMaster = isIconSetFilePath(getActiveFilePath());
        const isVectorContainer = isContainerSetMaster && this.parentId === 'root';
        // SVG group child: nested SVGs inside a group SVG (vector set)
        // are positioned via x/y attrs in the parent's viewBox coords.
        // Pin them to the parent so the group stays a coherent unit
        // (Figma "isolated group" semantics: dragging a child inside
        // never detaches; you have to ungroup first to break the
        // hierarchy). Without this, dragging a child far enough
        // triggers exit-to-canvas / grandparent-reparent and the user
        // sees the shape pop out of the group on first drag.
        const dragParent = this.parentId ? getNodeFromCache(this.parentId) : null;
        const isSvgGroupChild = dragParent?.type === 'svg';
        if (isVectorContainer || isSvgGroupChild) {
          out = false;
        } else if (this.useCursorExit) {
          // `parentHasTransform` is the parent's OWN transform only. Also
          // take the quad path when the parent sits inside a transformed
          // ancestor chain (`insideTransformedAncestor`, computed above
          // over the full hierarchy) — a parent with no transform of its
          // own is still painted as a rotated quad when an ancestor is
          // rotated, and its AABB is far larger than its visual box.
          if (this.parentHasTransform || insideTransformedAncestor) {
            const parentCorners = getScreenCornersById(this.parentId, this.vpId);
            out = parentCorners
              ? !pointInQuad(mouseScreen.x, mouseScreen.y, parentCorners)
              : (mouseScreen.x < parentRect.left || mouseScreen.x > parentRect.left + parentRect.width
                || mouseScreen.y < parentRect.top || mouseScreen.y > parentRect.top + parentRect.height);
          } else {
            out = mouseScreen.x < parentRect.left
              || mouseScreen.x > parentRect.left + parentRect.width
              || mouseScreen.y < parentRect.top
              || mouseScreen.y > parentRect.top + parentRect.height;
          }
        } else {
          // Quad exit when the parent OR the dragged element is visually
          // transformed:
          //   - `parentHasTransform` / `insideTransformedAncestor` —
          //     a rotated parent, or a parent painted as a rotated quad
          //     because an ancestor is rotated.
          //   - `elVisuallyTransformed` — the ELEMENT itself is rotated /
          //     skewed / perspective-distorted while the parent is plain
          //     (e.g. a perspective canvas node dragged into a flat
          //     frame). Its AABB is the bounding box of the painted
          //     trapezoid, far larger than the visible shape, so AABB
          //     exit mis-fires the instant a corner of that oversized
          //     box crosses the parent edge — the node bounces straight
          //     back out to canvas. `cornersAreAxisAligned` detects
          //     rotation / skew / perspective from the painted corners.
          // The painted corners bake in the full cumulative transform,
          // so the quad test fires exactly when the element visually
          // enters / leaves the parent.
          const parentCorners = getScreenCornersById(this.parentId, this.vpId);
          const elCorners = getScreenCornersById(primary.id, this.vpId);
          const elVisuallyTransformed = !!elCorners && !cornersAreAxisAligned(elCorners);
          const useQuadExit = this.parentHasTransform || insideTransformedAncestor
            || elVisuallyTransformed;
          if (useQuadExit && parentCorners && elCorners) {
            out = this.exitDestination === 'canvas'
              // Any element corner outside the parent quad.
              ? !isFullyInsideQuad(elCorners, parentCorners)
              // No element corner inside parent AND no parent corner
              // inside element — completely separated visually.
              : isFullyOutsideQuad(elCorners, parentCorners);
          } else {
            // Axis-aligned, or a corner read failed — plain AABB exit.
            out = aabbExit(elRect, parentRect, this.exitDestination);
          }
        }
        if (this.exitDestination === 'canvas') {
          if (this.startedNotFullyInside === null) this.startedNotFullyInside = out;
          if (out && this.startedNotFullyInside) {
            // Pre-existing overflow: the not-fully-inside test is permanently
            // true, so it can't express intent. Exit only when the CURSOR
            // leaves the parent (quad-aware for transformed parents).
            const pc = getScreenCornersById(this.parentId, this.vpId);
            if (pc && !cornersAreAxisAligned(pc)) {
              out = !pointInQuad(mouseScreen.x, mouseScreen.y, pc);
            } else {
              const pr = findNodeRect(this.parentId, this.vpId);
              out = !pr
                || mouseScreen.x < pr.left || mouseScreen.x > pr.left + pr.width
                || mouseScreen.y < pr.top || mouseScreen.y > pr.top + pr.height;
            }
          }
        }
        if (out) {
          this.framesOutsideParent++;
          if (this.framesOutsideParent >= EXIT_FRAME_THRESHOLD) {
            const scale = transform.scale || 1;
            // ── Grandparent reparent path ──────────────────────────────
            // The current parent has a deeper frame ancestor that can receive
            // the element. Reparent up one level, recompute drag state, and
            // KEEP the strategy alive so the user can continue dragging into
            // the grandparent's space (or further out).
            if (this.exitDestination === 'grandparent' && this.grandparentId) {
              const newParentId = this.grandparentId;
              const newParentRect = findNodeRect(newParentId, this.vpId);
              trace.action('abs-in-frame:grandparent-reparent-begin', {
                fromParentId: this.parentId, toParentId: newParentId,
                framesOutside: this.framesOutsideParent,
              });
              // The reparented parent-local position per node — captured
              // so the post-reparent baseline below reuses it.
              const ggEntryLocalPos = new Map<string, { l: number; t: number }>();
              // Track nodes whose inset state was changed during this
              // reparent (right/bottom cleared, explicit width/height set).
              // Used below to OVERRIDE the standard re-init's inset state
              // — context.nodes may not reflect updateNodeInCache yet,
              // so the re-init would otherwise read stale "still inset"
              // styles and keep writing cs.right/bottom in onMove,
              // which mouseup would commit and re-introduce the inset.
              const insetClearedIds = new Set<string>();
              for (const node of draggedNodes) {
                const nr = findNodeRect(node.id, this.vpId);
                // Transform-aware entry math. `(nr.left - newParentRect.left)`
                // subtracts the grandparent's post-transform AABB origin,
                // which is NOT its CSS-local (0,0) once the grandparent is
                // rotated / skewed / perspective'd — the element would jump
                // on entry. `computeEntryParentLocalPosition` anchors the
                // element's AABB centre into the grandparent's CSS-local
                // frame via its own transform matrix.
                let rl = 0, rt = 0;
                if (nr) {
                  const entry = computeEntryParentLocalPosition(
                    node.id, newParentId, nr, this.vpId, scale,
                  );
                  if (entry) { rl = entry.parentRelLeft; rt = entry.parentRelTop; }
                }
                ggEntryLocalPos.set(node.id, { l: rl, t: rt });
                const orig = this.originalTransforms.get(node.id) ?? '';
                // Strip translate — `rl/rt` from `computeEntryParentLocalPosition`
                // is the visible top-left in the new parent's coords. Keeping
                // the original `translate(-50%, -50%)` would shift the element
                // by W/2 in the new parent.
                const reparentTransform = stripTranslateFunctions(orig);

                // INSET PRESERVATION: if source has `right`/`bottom`, the
                // inset constraint was anchored to the OLD parent's
                // dimensions. Carrying it into the new parent (which
                // typically has different dimensions) makes the element
                // resize to the new parent's `parentInner - left - right`,
                // which is wildly wrong. Clear right/bottom AND lock in
                // the element's current visible width/height so the size
                // stays stable across the reparent.
                const nodeSrc = context.nodes.get(node.id)?.styles ?? {};
                const hasInsetW = !!nodeSrc.left && !!nodeSrc.right;
                const hasInsetH = !!nodeSrc.top && !!nodeSrc.bottom;
                const reparentStyles: Record<string, string> = {
                  position: 'absolute',
                  left: `${rl}px`,
                  top: `${rt}px`,
                  transform: reparentTransform,
                };
                if (hasInsetW || hasInsetH) {
                  // Use COMPUTED CSS box (layout box, pre-transform)
                  // not `nr.width / scale` (the rotated/scaled SCREEN
                  // AABB). For a rotated full-inset element the AABB
                  // is √2× wider than the layout box; committing that
                  // as `width` with the rotation transform still
                  // applied makes the element visibly jump to ~2×
                  // its size on next render. Computed `width` IS the
                  // browser-resolved `parentW - left - right` layout
                  // box. Same fix applied in the canvas-exit path and
                  // the sibling-reparent inset-clear below.
                  const computedReparent = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
                  const reparentCssW = parseFloat(computedReparent.width);
                  const reparentCssH = parseFloat(computedReparent.height);
                  if (hasInsetW) {
                    reparentStyles.width = `${Math.round(Number.isFinite(reparentCssW) && reparentCssW > 0 ? reparentCssW : (nr ? nr.width / scale : node.width))}px`;
                    reparentStyles.right = '';
                  }
                  if (hasInsetH) {
                    reparentStyles.height = `${Math.round(Number.isFinite(reparentCssH) && reparentCssH > 0 ? reparentCssH : (nr ? nr.height / scale : node.height))}px`;
                    reparentStyles.bottom = '';
                  }
                }

                queueMutation({
                  type: 'move',
                  nodeId: node.id,
                  newParentId,
                  styles: reparentStyles,
                });
                // IMPERATIVE-FIRST RE-HOME — same contract as CanvasDragStrategy's
                // entry blocks and commitExitToCanvas: the drag-locked render can
                // no longer move the DOM parent, and the OLD parent is typically
                // overflow:hidden — without this the element stays clipped inside
                // it (fully INVISIBLE) for the rest of the drag while its new
                // parent-local left/top resolve against the wrong box. `-1` =
                // append, no sibling CSS `order` renumber (absolute child).
                getCanvasBridge().reparentLive?.(node.id, context.viewportPrefix, newParentId, -1, { ...reparentStyles, transform: reparentTransform });
                // Imperative cache sync — match the canvas-exit pattern so
                // any rebuildContext sees the new parent immediately.
                moveNodeInCache(node.id, newParentId);
                updateNodeInCache(node.id, reparentStyles);
                // Patch the live inline transform to the stripped value so
                // the per-frame translate offset doesn't survive the reparent.
                patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform: reparentTransform });

                // Mark this node as inset-cleared; we'll override the
                // re-init's startInsets below so onMove doesn't keep
                // writing cs.right/cs.bottom from stale state.
                if (hasInsetW || hasInsetH) insetClearedIds.add(node.id);
              }
              flushNowDeferredDuringDrag();
              forceCanvasRenderDeferredDuringDrag();

              // Promote grandparent to current parent and refresh derived
              // state (transform check, layout flag, exit destination for the
              // NEXT level up). startLeft / startTop / startMouse are reset
              // so subsequent onMove deltas are relative to the new parent.
              this.parentId = newParentId;
              // The element just left a cursor-exit-tracked sibling. The new
              // (outer) parent should use normal AABB exit semantics again —
              // we're back in standard "drag inside an outer frame" mode.
              this.useCursorExit = false;
              const newParentTransform = findNodeComputedStyle(newParentId, this.vpId, 'transform');
              this.parentHasTransform = isNonIdentityTransform(newParentTransform);
              const newParentDisplay = findNodeComputedStyle(newParentId, this.vpId, 'display');
              this.parentIsFlexGrid = newParentDisplay === 'flex' || newParentDisplay === 'inline-flex'
                || newParentDisplay === 'grid' || newParentDisplay === 'inline-grid';
              // Refresh dynamic-pin parent-type rule. Walking from a frame
              // up to the viewport root flips this to true (Y always
              // top-px), and walking from the viewport back into a nested
              // frame flips it back to false (full 3×3 zone rule). Without
              // this refresh, the per-frame loop keeps the original parent's
              // rule and the user has to drop+restart drag to get correct
              // pin behaviour in the new parent.
              {
                const gpNode = context.nodes.get(newParentId);
                this.parentIsViewport = (gpNode?.parentId ?? null) === null;
              }

              // Post-reparent drag baseline — reuse the transform-aware
              // `rl/rt` just committed (parent-LOCAL, matching the
              // parent-local delta `onMove` adds), not a naive AABB
              // re-derivation that breaks for a transformed grandparent.
              for (const node of draggedNodes) {
                const ep = ggEntryLocalPos.get(node.id);
                if (ep) { node.startLeft = ep.l; node.startTop = ep.t; }
                node.startParentId = newParentId;
              }
              context.startMouse = { x: mouseScreen.x, y: mouseScreen.y };
              this.framesOutsideParent = 0;
              this.entryGraceCounter = AbsoluteInFrameStrategy.ENTRY_GRACE_PERIOD;

              // Re-snapshot lift-time corners against the post-reparent
              // position. `startLeft/Top` were just reset to NEW-parent
              // local coords; the per-frame snap projects `liftCorners +
              // (newLeft - startLeft, newTop - startTop)`, so the
              // baseline must match the new starting position or snap
              // candidates land at wildly wrong canvas-space positions.
              this.refreshLiftCorners(draggedNodes.map(n => n.id), context.transform);

              // Re-init startInsets for the new parent (parent dimensions
              // changed so inset arithmetic must use the new container).
              this.startInsets.clear();
              for (const node of draggedNodes) {
                const nd = context.nodes.get(node.id); const ns = nd?.styles || {};
                const es: Record<string, string> = {};
                for (const k of ['left', 'right', 'top', 'bottom', 'width', 'height']) { if (ns[k]) es[k] = ns[k]; }
                const inset = getInsetState(es);
                const isPercentMode = (ns.left || '').includes('%') || (ns.top || '').includes('%');
                const ggCssDims = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
                const ggCssW = parseFloat(ggCssDims.width);
                const ggCssH = parseFloat(ggCssDims.height);
                // Parent CSS box (un-rotated) for transform-correct
                // dynamic-pin bands. Same rule as onStart — see comment
                // there for the rationale.
                const ggParentCssDims = findNodeComputedStyles(newParentId, this.vpId, ['width', 'height']);
                const ggParentCssW = parseFloat(ggParentCssDims.width);
                const ggParentCssH = parseFloat(ggParentCssDims.height);
                this.startInsets.set(node.id, {
                  right: parseFloat(ns.right || '0') || 0,
                  bottom: parseFloat(ns.bottom || '0') || 0,
                  inset, isPercentMode,
                  startLeftPercent: parseFloat(ns.left || '0') || 0,
                  startTopPercent: parseFloat(ns.top || '0') || 0,
                  parentWidth: Number.isFinite(ggParentCssW) && ggParentCssW > 0
                    ? ggParentCssW
                    : (newParentRect?.width ?? 1) / scale,
                  parentHeight: Number.isFinite(ggParentCssH) && ggParentCssH > 0
                    ? ggParentCssH
                    : (newParentRect?.height ?? 1) / scale,
                  elemCssWidth: Number.isFinite(ggCssW) ? ggCssW : node.width / scale,
                  elemCssHeight: Number.isFinite(ggCssH) ? ggCssH : node.height / scale,
                });
              }

              // Reparent → unlock dynamic pinning. Per the design, any
              // reparent (grandparent / sibling / canvas) resets the
              // "user pinned this" flag so the new context picks pins
              // automatically. Drops `data-pinned` via an updateHtmlAttrs
              // mutation so source matches (empty value removes the attr).
              // (Icon-set masters stay OUT of dynamic pinning — see field doc.)
              for (const node of draggedNodes) {
                if (!this.isIconSetMaster) this.dynamicPinNodes.add(node.id);
                queueMutation({
                  type: 'updateHtmlAttrs',
                  nodeId: node.id,
                  attrs: { 'data-pinned': '' },
                });
              }

              // OVERRIDE startInsets for nodes whose inset we just cleared.
              // The standard re-init above reads from context.nodes which
              // may not reflect updateNodeInCache yet — would leave
              // pins.right=true and onMove writes cs.right; mouseup commit
              // then re-introduces the inset we tried to strip.
              for (const node of draggedNodes) {
                if (!insetClearedIds.has(node.id)) continue;
                const ggOvCss = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
                const ggOvCssW = parseFloat(ggOvCss.width);
                const ggOvCssH = parseFloat(ggOvCss.height);
                this.startInsets.set(node.id, {
                  right: 0,
                  bottom: 0,
                  inset: getInsetState({
                    left: `${node.startLeft}px`,
                    top: `${node.startTop}px`,
                    width: `${node.width / scale}px`,
                    height: `${node.height / scale}px`,
                  }),
                  isPercentMode: false,
                  startLeftPercent: 0,
                  startTopPercent: 0,
                  parentWidth: (newParentRect?.width ?? 1) / scale,
                  parentHeight: (newParentRect?.height ?? 1) / scale,
                  elemCssWidth: Number.isFinite(ggOvCssW) ? ggOvCssW : node.width / scale,
                  elemCssHeight: Number.isFinite(ggOvCssH) ? ggOvCssH : node.height / scale,
                });
              }

              // Recompute exit destination for the new parent — the next
              // exit could either walk further up or fall through to canvas.
              // Same flex/grid skip as in onStart: if the new grandparent is
              // a layout container, the next exit goes to canvas so
              // CanvasDragStrategy can drive layout-aware insertion.
              const newParentNode = context.nodes.get(newParentId);
              const ggpId = newParentNode?.parentId ?? null;
              const ggpNode = ggpId ? context.nodes.get(ggpId) : null;
              const ggpLayout = ggpId
                ? detectParentLayoutById(ggpId, this.vpId)
                : null;
              const ggpIsLayout = ggpLayout === 'flex' || ggpLayout === 'grid';
              // Viewport root ('root') counts — see onStart rationale.
              const ggpIsReparentTarget = !!ggpNode
                && nodeAcceptsChildren(ggpNode)
                && !ggpIsLayout;
              this.exitDestination = ggpIsReparentTarget ? 'grandparent' : 'canvas';
              this.grandparentId = ggpIsReparentTarget ? ggpId : null;

              trace.action('abs-in-frame:grandparent-reparent-done', {
                newParentId, exitDestination: this.exitDestination,
                grandparentId: this.grandparentId,
              });
              // Skip the canvas-commit branch below; stay in strategy.
              return { snap, dropTarget: null, highlightParentId: this.parentId, highlightVpId: this.vpId, axisLock: null };
            }

            // ── Canvas exit path (default) ─────────────────────────────
            this.exitedParent = true;
            this.exitOverrides = new Map();
            // Set by the vp-only clone-extraction branch below — decides
            // whether the post-loop flush runs the full synchronous
            // pipeline (clone needs its DOM built) or defers to the drop.
            let usedCloneExtraction = false;
            trace.action('abs-in-frame:exit-begin', {
              parentId: this.parentId,
              vpId: this.vpId,
              transformX: transform.x,
              transformY: transform.y,
              scale,
              mouseScreen: { x: mouseScreen.x, y: mouseScreen.y },
              elRectScreen: { left: elRect.left, top: elRect.top, width: elRect.width, height: elRect.height },
              parentRectScreen: { left: parentRect.left, top: parentRect.top, width: parentRect.width, height: parentRect.height },
            });
            // Canvas-space conversion: as a canvas node the element's
            // left/top become contentRoot-relative, NOT parent-relative.
            // Using `pos` (parent-local) here would commit the element at the
            // wrong canvas position, producing the 1-frame jump you saw.
            // Convert the live screen rect → canvas-space CSS pixels.
            const iframeOffset = getIframeOffset();
            for (const node of draggedNodes) {
              const dim = findNodeRect(node.id, this.vpId);
              const nodeSrcStyles = context.nodes.get(node.id)?.styles ?? {};
              // For elements with BOTH left+right (or top+bottom) set,
              // the visible size is parent-constrained — the computed
              // `width` from the bridge cache may be stale or otherwise
              // disagree with the actual rendered AABB (parent has
              // overflow:hidden so the OFFSCREEN computed width can be
              // larger than what the user sees). Trust the live screen
              // rect / scale for these — that's what the user is
              // looking at and what we want preserved on unparent.
              //
              // For non-inset-constrained elements: prefer computed CSS
              // box (offsetWidth-equivalent), NOT the screen AABB,
              // because the AABB bakes in the element's own transform
              // (e.g. `scale(2)` doubles AABB vs the layout box).
              const widthFromInset =
                !!nodeSrcStyles.left && !!nodeSrcStyles.right;
              const heightFromInset =
                !!nodeSrcStyles.top && !!nodeSrcStyles.bottom;
              const computed = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
              const computedW = parseFloat(computed.width);
              const computedH = parseFloat(computed.height);
              // Prefer the COMPUTED CSS box (= layout box, pre-transform)
              // for the commit. Falls back to `dim.width / scale` (the
              // rotated/scaled SCREEN AABB) only when computed is
              // missing.
              //
              // The previous inset-branch used `dim.width / scale`
              // directly: for a rotated FULL-INSET element the AABB
              // can be √2× wider than the layout box, and committing
              // that as `width` left the rotation transform stacked
              // on top — visible size jumped to AABB × √2 (about 2×
              // the original) on unparent or sibling-entry. The
              // computed `width` IS the browser-resolved
              // `parentW - left - right` layout box for an inset
              // element AND the layout box for a non-inset element,
              // so the same expression works for both cases without
              // the transform-AABB inflation.
              const cssWidth = Number.isFinite(computedW) && computedW > 0
                ? computedW
                : (dim ? dim.width / scale : node.width);
              const cssHeight = Number.isFinite(computedH) && computedH > 0
                ? computedH
                : (dim ? dim.height / scale : node.height);
              // Suppress unused-variable warnings — these are now
              // implicit in the unified `cssWidth/cssHeight` formula
              // above. Kept as named locals so future revisions can
              // re-branch if the AABB path is ever needed (e.g. for
              // SVG groups that don't resolve a computed width).
              void widthFromInset;
              void heightFromInset;
              // Position via `computeExitCanvasPosition` — anchors the
              // element's CSS-box CENTRE (the painted quad's diagonal
              // crossing for a perspective element, the AABB centre
              // otherwise) so the shape stays put on unparent instead of
              // jumping. Shared with CanvasDragStrategy's exit path.
              let cssLeft = 0;
              let cssTop = 0;
              if (dim) {
                const exitPos = computeExitCanvasPosition(
                  node.id, this.vpId, dim, transform, iframeOffset, cssWidth, cssHeight,
                );
                cssLeft = Math.round(exitPos.canvasLeft);
                cssTop = Math.round(exitPos.canvasTop);
              }
              const nd = context.nodes.get(node.id);
              const orig = this.originalTransforms.get(node.id) ?? '';
              // STRIP translate(...) from the transform we commit on exit.
              // `cssLeft/cssTop` from `computeExitCanvasPosition` is the
              // VISIBLE top-left in canvas-space — applying the original
              // `translate(-50%, -50%)` on top would shift the element by
              // W/2 / H/2 (the very offset the drag was already accounting
              // for inside the parent). Keep rotate/scale/skew untouched.
              const exitTransform = stripTranslateFunctions(orig);
              const ms: Record<string, string> = {
                position: 'absolute',
                left: `${cssLeft}px`,
                top: `${cssTop}px`,
                width: `${Math.round(cssWidth)}px`,
                height: `${Math.round(cssHeight)}px`,
                transform: exitTransform,
              };
              if (nd?.styles?.right || nd?.styles?.bottom) { ms.right = ''; ms.bottom = ''; }

              // ── Variant exit (immediate detach to canvas) ──
              //
              // Same shape as page-primary drag-out: queue hide on the
              // source variant + addCanvasNode for a clone, swap the
              // dragged id to the clone, flush + force-render. The
              // strategy switch below routes to CanvasDragStrategy
              // operating on the clone's id.
              //
              // The CRITICAL fix is `viewportPrefix: ''` in the
              // exitOverrides — once swapped to the clone, subsequent
              // patches need to target the clone's actual data-node-id
              // (no prefix, since canvas nodes are hoisted to the
              // container without per-viewport prefixing). Without this,
              // patches go to `variant-1-<cloneId>` which doesn't exist
              // and the drag visibly freezes until mouseup.
              const isComponentFile = isComponentFilePath(getActiveFilePath());
              const isVariantExit = isComponentFile && context.viewportPrefix !== '';

              if (isVariantExit) {
                const sourceVariant = vpIdFromPrefix(context.viewportPrefix);
                const idMap = new Map<string, string>();
                // Pass the source vp's width so cloned text nodes that
                // use `useResponsiveText(primary, overrides)` resolve to
                // the override visible on this vp (the primary often
                // holds a zero-width placeholder when the user only
                // authored text on a non-primary vp).
                const sourceVpWidth = getViewportWidths()[this.vpId] ?? 0;
                const cloneRoot = buildCanvasCloneDescriptor(node.id, context.nodes, idMap, sourceVpWidth, sourceVariant);
                if (cloneRoot) {
                  cloneRoot.styles = {
                    ...cloneRoot.styles,
                    position: 'absolute',
                    left: `${cssLeft}px`,
                    top: `${cssTop}px`,
                    width: `${Math.round(cssWidth)}px`,
                    height: `${Math.round(cssHeight)}px`,
                    // Strip translate — `cssLeft/cssTop` is visible top-left,
                    // keeping the translate would shift the clone by W/2.
                    transform: exitTransform,
                  };
                  // For replica-only variant elements (e.g. inline
                  // `display:'none'` + `variants[variantName].display = 'unset'`),
                  // the inline `display:'none'` carries through the clone copy.
                  // The clone lives at canvas root with no variants context,
                  // so the inline `display:'none'` wins and the clone is
                  // invisible — the user sees the dragged element vanish on
                  // exit. Reset to '' so the canvas-rooted clone shows up.
                  // Multi-variant-visible elements (display !== 'none' inline)
                  // skip this — they don't have the hide-by-default pattern.
                  if (cloneRoot.styles.display === 'none') {
                    cloneRoot.styles.display = '';
                  }
                  if (cloneRoot.styles.right) delete cloneRoot.styles.right;
                  if (cloneRoot.styles.bottom) delete cloneRoot.styles.bottom;
                  patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform: orig }, true);

                  // Variant-only detection — symmetric with page-replica
                  // `isReplicaOnly`. If the source is invisible on EVERY
                  // other variant (no rect / display:'none'), this is a
                  // standalone variant element. Hiding it on the source
                  // variant alone leaves orphaned dead JSX that won't
                  // render anywhere; the user's mental model is "I dragged
                  // it out, so the original should be gone". Delete the
                  // source entirely; the clone takes over as a canvas node.
                  // If at least one other variant renders the source,
                  // keep the original and just hide it on the source
                  // variant (the existing behavior — preserves the
                  // original on every other variant).
                  //
                  // Iterate the COMPONENT MASTER's variant viewports
                  // (`variantConfig`), not `getViewportWidths()` — the
                  // latter returns the PAGE viewport widths
                  // (`desktop`/`tablet`/`mobile`) regardless of active
                  // file, so on a component master with variants
                  // `default`/`variant-1`/`variant-2` the loop never
                  // probed `variant-2` and incorrectly concluded
                  // "variant-only" → full remove (visible bug: drag a
                  // child out of variant-1 with variant-2 still
                  // displaying it, and the node disappeared everywhere).
                  const variantVpIds = parseVariantConfig(projectFS.readFile(getActiveFilePath()) ?? '')
                    .map(v => v.name === 'default' ? 'desktop' : v.name);
                  const isVariantOnly = (() => {
                    for (const otherVpId of variantVpIds) {
                      if (otherVpId === sourceVariant) continue;
                      const d = findNodeComputedStyle(node.id, otherVpId, 'display');
                      if (d && d !== 'none') return false;
                    }
                    return true;
                  })();
                  trace.action('abs-in-frame:variant-exit-visibility', {
                    nodeId: node.id, sourceVariant, isVariantOnly,
                  });
                  // ORDER MATTERS: add the clone, then CLONE the overlay while the
                  // SOURCE trigger still exists (cloneCanvasOverlay reads the source
                  // trigger→overlay), and only THEN remove/hide the source. Queuing
                  // removeNode first deleted the source trigger before the clone
                  // could find the overlay → canvas node with a broken trigger
                  // ("Overlay missing"). Capture the source overlay id up front.
                  const variantSrcId = node.id; // still the source (swap is below)
                  const srcOverlayId = getDefaultStore().get(overlayTriggerCallsAtom)
                    .find(t => t.triggerId === variantSrcId)?.config.targetId;
                  queueMutation({ type: 'addCanvasNode', node: cloneRoot });
                  // Detach clone = fresh ids; copy the subtree's ::after
                  // border-overlay rules onto them or the border is lost.
                  queueBorderOverlayDuplicates(idMap);
                  // Clone the overlay onto the canvas clone (config resolved for THIS
                  // variant) — same as the page-replica path, just variant-keyed.
                  queueMutation({
                    type: 'cloneCanvasOverlay',
                    sourceTriggerId: variantSrcId,
                    cloneTriggerId: cloneRoot.id,
                    vpWidth: sourceVpWidth,
                    variant: sourceVariant,
                  });
                  // DETACH vs full-remove, by whether COUNTERPARTS are still
                  // visible on other variants (`isVariantOnly`):
                  //   - others HIDDEN → this was the node's last variant → full
                  //     remove (+ its overlay). The canvas clone takes over.
                  //   - others VISIBLE → DETACH: keep the source node on the other
                  //     variants and just HIDE it on the source variant; the clone
                  //     takes its place on the canvas. Removing it outright here
                  //     wiped it from primary/other variants too — the user-reported
                  //     "drag out of variant 2 deleted it everywhere" regression.
                  // (The earlier "duplicate overlay" that prompted an always-remove
                  // over-correction was actually the canvas↔viewport round-trip
                  // ghost + entry re-homing corruption, both fixed separately —
                  // re-homing removal + `pruneOverlayDuplicatesInCode`. The source
                  // overlay legitimately stays for the OTHER variants; on the
                  // source variant its trigger is now hidden so the portal
                  // auto-hides it there, no duplicate.)
                  if (isVariantOnly) {
                    queueMutation({ type: 'removeNode', nodeId: node.id });
                    if (srcOverlayId) queueMutation({ type: 'removeOverlay', overlayId: srcOverlayId, triggerId: variantSrcId });
                  } else {
                    queueMutation({
                      type: 'updateVariantStyle',
                      nodeId: node.id,
                      variantName: sourceVariant,
                      styles: { display: 'none' },
                    });
                  }
                  // CLEAR the pending-replica-extraction snapshot `onStart`
                  // registered for the SOURCE. The variant-exit handled the
                  // detach its OWN way (clone + hide/remove) and swaps the drag id
                  // to the clone below, so `CanvasDragStrategy.onEnd` never
                  // consumes it. If left behind, a LATER drag of the SAME source
                  // (e.g. then dragging its surviving primary copy out) hits the
                  // stale snapshot in onEnd Case 2 → it re-injects the source back
                  // into primary AND spawns a second clone (the user-reported
                  // "remove from variant 2, then primary → re-injects + 2 ghosts").
                  clearPendingReplicaExtraction(variantSrcId);
                  // Editing overlay while detaching → follow the detached clone so
                  // it stays visible on the canvas (mirrors the page-replica path).
                  {
                    const store = getDefaultStore();
                    const isTrigger = store.get(overlayTriggerCallsAtom).some(t => t.triggerId === variantSrcId);
                    if (isTrigger && store.get(overlayEditingIdAtom)) {
                      store.set(overlayEditingIdAtom, `${cloneRoot.id}-overlay`);
                    }
                  }
                  const cloneId = cloneRoot.id;
                  node.id = cloneId;
                  node.startParentId = null;
                  node.startLeft = cssLeft;
                  node.startTop = cssTop;
                  this.exitOverrides!.set(cloneId, {
                    startLeft: cssLeft, startTop: cssTop, startParentId: null,
                  });
                  // The clone is hoisted as a canvas node — its
                  // data-node-id has NO viewport prefix. Tell the
                  // DragCoordinator to reset viewportPrefix so the
                  // post-switch CanvasDragStrategy patches the right
                  // element instead of `variant-1-<cloneId>`.
                  this.exitVpPrefix = '';
                  // Selection must follow the clone — the original source
                  // is now hidden on the source variant (display:'none')
                  // and may be invisible on every other variant too
                  // (replica-only). SelectionOverlay / PinConstraintLines
                  // would otherwise render at zero/stale coords. Switch
                  // selection + interacting viewport to the canvas-rooted
                  // clone in one event so the overlay tracks the moving
                  // element from the next frame.
                  window.dispatchEvent(new CustomEvent('revyme:select-viewport', {
                    detail: { nodeId: cloneId, vpId: 'desktop' },
                  }));
                  trace.action('abs-in-frame:variant-exit-clone', {
                    cloneId, sourceVariant, cssLeft, cssTop,
                  });
                }
              } else {
                // Page replica or primary exit. All exit kinds take the
                // SAME direct-move path now — the source JSX hops to
                // canvasNodes globally, so every viewport sees the
                // unparenting live during the drag (no clone, no
                // duplicate render). The user's words:
                //   "when I unparent on a replica, the replica is
                //    completely synced in the unparenting — sync
                //    happening DURING the drag, not only on mouseup."
                //
                // Two historical sub-paths used to live here:
                //  1. Replica-only (display:none everywhere except this
                //     vp) → direct move. Kept.
                //  2. Multi-vp visible replica → CLONE at canvas root +
                //     source stays in place + `@container display:'none'`
                //     on source vp. REMOVED — that's exactly the
                //     architecture that produced the "duplicate during
                //     drag" the user reported (clone moving + source
                //     visible on every other vp at the original parent).
                //  3. Primary exit → direct move. Kept (this code path).
                //
                // Trade-off: canvas-drop on a multi-vp replica no longer
                // creates a vp-only-extraction clone — the source just
                // becomes a canvas-node (synced extraction on every vp).
                // If the user later asks for vp-only extraction back on
                // canvas-drop, the right place is CanvasDragStrategy.onEnd:
                // snapshot source's start state (parent, position, container
                // overrides) at exit time, then on canvas-drop create a
                // fresh canvas clone and revert the source to its original
                // parent. The snapshot would live in a new
                // pending-replica-extraction store keyed by sourceId.
                if (context.viewportPrefix !== '') this.exitVpPrefix = '';
                const isReplicaExit = context.viewportPrefix !== '';
                const isReplicaOnly = (() => {
                  if (!isReplicaExit) return false;
                  // Component master: visibility lives on `hiddenOnVariants`
                  // (AnimatePresence + conditional render), NOT inline
                  // `display`. The legacy display:'none' baseline is no
                  // longer written for component variants — the old check
                  // would always return false, so exit-from-solo-variant
                  // ended up wrapping in `{false && <el/>}` instead of
                  // doing a full remove. Mirror of the same fix in
                  // LayoutLiftedStrategy.
                  if (isComponentFilePath(getActiveFilePath())) {
                    const hidden = nd?.hiddenOnVariants;
                    if (!hidden || hidden.size === 0) return false;
                    const variantVpIds = parseVariantConfig(projectFS.readFile(getActiveFilePath()) ?? '')
                      .map(v => v.name === 'default' ? 'desktop' : v.name);
                    const currentVariant = this.vpId === 'desktop' ? 'default' : this.vpId;
                    for (const otherVpId of variantVpIds) {
                      const variantName = otherVpId === 'desktop' ? 'default' : otherVpId;
                      if (variantName === currentVariant) continue;
                      if (!hidden.has(variantName)) return false;
                    }
                    return true;
                  }
                  // Page replicas: keep the legacy inline-display
                  // baseline check.
                  const inlineDisplay = nd?.styles?.display;
                  if (inlineDisplay !== 'none') return false;
                  for (const otherVpId of Object.keys(getViewportWidths())) {
                    if (otherVpId === this.vpId) continue;
                    const otherDisplay = findNodeComputedStyle(node.id, otherVpId, 'display');
                    if (otherDisplay && otherDisplay !== 'none') return false;
                  }
                  return true;
                })();
                trace.action('abs-in-frame:exit-visibility', {
                  nodeId: node.id, isReplicaExit, isReplicaOnly,
                  inlineDisplay: nd?.styles?.display,
                  fromVpId: this.vpId,
                });

                {
                  // Capture the source id BEFORE the potential identity
                  // swap below (`node.id = cloneId`) so we can clear the
                  // registry entry by its real key.
                  const originalSourceId = node.id;
                  const pSnap = isReplicaExit ? getPendingReplicaExtraction(originalSourceId) : null;
                  if (pSnap) {
                    // ── VP-ONLY EXTRACTION (live, during drag) ──
                    // The user exited the entire viewport hierarchy on a
                    // multi-vp replica drag. Their intent is "remove
                    // from THIS replica only" — every other viewport
                    // should snap the source back to where it lived
                    // before the drag (the snapshot's originalParentId,
                    // captured at onStart so any intermediate
                    // grandparent reparents don't overwrite it), and a
                    // fresh canvas clone takes the dragged element's
                    // place on the source vp.
                    //
                    // This happens NOW (live) — not on mouseup — so
                    // the user sees the revert + extraction the moment
                    // they cross the viewport edge. The post-extraction
                    // drag operates on the CLONE (identity swap below)
                    // for the rest of the drag.
                    const idMap = new Map<string, string>();
                    // Pass the source vp's width so cloned text nodes
                    // pick the override visible on this vp (see the
                    // variant-exit-clone block for full rationale).
                    const sourceVpWidthForClone = getViewportWidths()[pSnap.sourceVpId] ?? 0;
                    const cloneRoot = buildCanvasCloneDescriptor(node.id, context.nodes, idMap, sourceVpWidthForClone);
                    if (cloneRoot) {
                      // Build the clone with the ORIGINAL styles as
                      // base (size, color, transform — pre-drag values
                      // from the snapshot), then override position with
                      // the canvas-exit coords so the clone appears
                      // exactly where the user released the parent.
                      // `pSnap.originalStyles` is the source's RAW pre-drag style map — for an
                      // fx instance it still holds the live motion-value bindings
                      // (`scale: 'var:…FxCScale'`, `opacity: 'var:…'`, …). Strip them (and they'd
                      // crash the module-scope clone); the data-instance-fx spec preserves them.
                      cloneRoot.styles = dropDynamicStyleBindings({
                        ...pSnap.originalStyles,
                        position: 'absolute',
                        left: `${cssLeft}px`,
                        top: `${cssTop}px`,
                        width: `${Math.round(cssWidth)}px`,
                        height: `${Math.round(cssHeight)}px`,
                        transform: exitTransform,
                      });
                      if (cloneRoot.styles.right) delete cloneRoot.styles.right;
                      if (cloneRoot.styles.bottom) delete cloneRoot.styles.bottom;
                      // 1. Revert SOURCE: move back to original parent
                      //    + index + pre-drag styles. The grandparent
                      //    reparents along the way had been moving the
                      //    source globally; this undoes them on every
                      //    viewport's JSX rendering.
                      queueMutation({
                        type: 'move',
                        nodeId: originalSourceId,
                        newParentId: pSnap.originalParentId,
                        index: pSnap.originalIndex,
                        styles: pSnap.originalStyles,
                        canvasNode: false,
                      });
                      // 2. Restore source's @container overrides that
                      //    may have been mutated during drag.
                      for (const [maxWidth, props] of pSnap.originalContainerOverrides) {
                        const stylesObj: Record<string, string> = {};
                        for (const [k, v] of props) stylesObj[k] = v;
                        queueMutation({
                          type: 'updateContainerStyle',
                          nodeId: originalSourceId,
                          maxWidth,
                          styles: stylesObj,
                        });
                      }
                      // 3. Hide source on source vp (clone takes its
                      //    place on this vp).
                      const sourceVpWidth = getViewportWidths()[pSnap.sourceVpId] ?? 0;
                      queueMutation({
                        type: 'updateContainerStyle',
                        nodeId: originalSourceId,
                        maxWidth: sourceVpWidth,
                        styles: { display: 'none' },
                      });
                      // 4. Add the canvas clone. queueMutation order:
                      //    after the source revert/hide so the clone's
                      //    id is unique against the live tree.
                      queueMutation({ type: 'addCanvasNode', node: cloneRoot });
                  // Detach clone = fresh ids; copy the subtree's ::after
                  // border-overlay rules onto them or the border is lost.
                  queueBorderOverlayDuplicates(idMap);
                      // 4b. If the dragged node owned an overlay, clone the
                      //     overlay onto the canvas clone too (paired to the
                      //     clone's id, config resolved for this replica's
                      //     width). No-op when the source isn't a trigger.
                      queueMutation({
                        type: 'cloneCanvasOverlay',
                        sourceTriggerId: originalSourceId,
                        cloneTriggerId: cloneRoot.id,
                        vpWidth: sourceVpWidth,
                      });
                      // 4c. If we're EDITING that overlay while detaching, hand
                      //     the overlay-edit mode to the clone so the detached
                      //     overlay stays VISIBLE on the canvas during the drag.
                      //     Otherwise the source overlay sticks to the now-hidden
                      //     replica trigger (top-left, zero rect) and the clone —
                      //     a hidden canvas node — only appears on re-open.
                      {
                        const store = getDefaultStore();
                        const isTrigger = store.get(overlayTriggerCallsAtom)
                          .some(t => t.triggerId === originalSourceId);
                        if (isTrigger && store.get(overlayEditingIdAtom)) {
                          store.set(overlayEditingIdAtom, `${cloneRoot.id}-overlay`);
                        }
                      }
                      // 5. Hide clone on every non-source viewport.
                      for (const otherVpId of Object.keys(getViewportWidths())) {
                        if (otherVpId === pSnap.sourceVpId) continue;
                        const otherWidth = getViewportWidths()[otherVpId] ?? 0;
                        queueMutation({
                          type: 'updateContainerStyle',
                          nodeId: cloneRoot.id,
                          maxWidth: otherWidth,
                          styles: { display: 'none' },
                        });
                      }
                      // 6. Swap dragged identity to the clone so the
                      //    post-switch CanvasDragStrategy operates on
                      //    it instead of the now-reverted source.
                      const cloneId = cloneRoot.id;
                      node.id = cloneId;
                      node.startParentId = null;
                      node.startLeft = cssLeft;
                      node.startTop = cssTop;
                      this.exitOverrides!.set(cloneId, {
                        startLeft: cssLeft, startTop: cssTop, startParentId: null,
                        width: Math.round(cssWidth) * context.transform.scale,
                        height: Math.round(cssHeight) * context.transform.scale,
                        transform: exitTransform,
                      });
                      // Selection must follow the clone — the source
                      // is now hidden on source vp via @container, so
                      // SelectionOverlay queries against sourceId at
                      // sourceVp would float at stale coords.
                      window.dispatchEvent(new CustomEvent('revyme:select-viewport', {
                        detail: { nodeId: cloneId, vpId: 'desktop' },
                      }));
                      // The snapshot is keyed by the SOURCE id (pre-
                      // identity-swap). The source has been reverted
                      // and the registry entry is no longer needed.
                      clearPendingReplicaExtraction(originalSourceId);
                      usedCloneExtraction = true;
                      trace.action('abs-in-frame:vp-only-canvas-extraction-live', {
                        sourceId: originalSourceId, cloneId,
                        sourceVpId: pSnap.sourceVpId,
                        revertParentId: pSnap.originalParentId,
                        revertIndex: pSnap.originalIndex,
                        cssLeft, cssTop,
                      });
                    } else {
                      // Defensive — descriptor build failed. Fall
                      // through to the regular canvas exit below.
                      trace.error('abs-in-frame:vp-only-clone-build-failed', { nodeId: node.id });
                    }
                  } else {
                    // ── Direct-move exit (primary / replica-only) ──
                    if (isReplicaOnly) {
                      // The base inline had `display: 'none'` (the
                      // hide-on-non-source-vp baseline from the
                      // canvas-node-into-replica entry). On canvas
                      // root there are no @container rules to flip it
                      // back, so we must restore the EFFECTIVE display
                      // the user saw on the source vp — not just clear
                      // to ''. Otherwise a frame whose source vp was
                      // showing `display: 'flex'` via the
                      // `@container` override comes back to canvas as
                      // a plain block container → children stack
                      // naturally, layout is lost.
                      const overridesForExit = getDefaultStore().get(containerOverridesAtom);
                      const sourceVpWidth = getViewportWidths()[this.vpId] ?? 0;
                      const ovTreeForNode = overridesForExit.get(node.id)?.get(sourceVpWidth);
                      const sourceDisplay = ovTreeForNode?.get('display');
                      const effectiveDisplay =
                        sourceDisplay && sourceDisplay !== '' && sourceDisplay !== 'auto' && sourceDisplay !== 'unset'
                          ? sourceDisplay
                          : '';
                      if (ms.display === undefined) ms.display = effectiveDisplay;
                    }
                    // Shared choreography (commitExitToCanvas): always wipes
                    // @media/@container rules when moving to canvas root —
                    // canvas nodes are independent of viewport context (see
                    // exit-commit.ts for the full rationale).
                    //
                    // Pass `sourceVpWidth` so the move generator can
                    // unwrap any `{useResponsiveText(...)}` text-content
                    // calls in the moved subtree into plain text. On
                    // canvas root there's no viewport context for the
                    // hook to bucket against — the primary arg (often a
                    // zero-width-space placeholder when text was authored
                    // on a non-primary vp) would otherwise render empty
                    // and collapse the element to width:0.
                    //
                    // Also pass `sourceVariant` so the strip walker
                    // resolves per-variant ternaries
                    // (`{variant === 'X' ? 'A' : 'B'}`) into the source
                    // variant's text — on canvas root the `variant`
                    // identifier is undefined and the ternary would
                    // either throw or fall through to the default branch.
                    //
                    // The extra `updateHtmlAttrs` mutation: exit-to-canvas
                    // → unlock dynamic pinning. Canvas nodes have no parent
                    // frame for pin-arithmetic to apply to, but clearing
                    // the attr keeps the source clean and makes a future
                    // drop-back-into-parent re-pick pins automatically
                    // (the reference's "drag back in resets to auto" behavior).
                    // Exit-to-canvas also clears `data-replica-solo`
                    // — once the element lives at canvas root it has
                    // no viewport context, so the "solo on this
                    // replica, redirect edits to base" contract no
                    // longer applies. Leaving the attribute would
                    // cause the next click on the element (still on
                    // a replica vp via the canvas iframe) to route
                    // through the solo-redirect path and write to
                    // inline base — which is now the canvas-root
                    // styling itself, producing wrong commits.
                    commitExitToCanvas({
                      nodeId: node.id,
                      styles: ms,
                      sourceVpWidth: getViewportWidths()[this.vpId] ?? 0,
                      sourceVariant: isComponentFilePath(getActiveFilePath()) ? this.vpId : undefined,
                      extraMutations: [{
                        type: 'updateHtmlAttrs',
                        nodeId: node.id,
                        attrs: { 'data-pinned': '', 'data-replica-solo': '' },
                      }],
                      patch: { contentEl: context.contentEl, vpPrefix: context.viewportPrefix, styles: { transform: orig }, when: 'before-cache' },
                    });
                    // Stash post-commit dims so the receiving strategy
                    // (CanvasDragStrategy) gets accurate width/height
                    // for its snap math instead of inheriting the
                    // rotated AABB captured at lift. Convert CSS px
                    // → screen px (multiply by canvas scale) to match
                    // the screen-pixel semantics DragCoordinator uses
                    // for draggedNode.width / draggedNode.height.
                    this.exitOverrides!.set(node.id, {
                      startLeft: cssLeft,
                      startTop: cssTop,
                      startParentId: null,
                      width: Math.round(cssWidth) * context.transform.scale,
                      height: Math.round(cssHeight) * context.transform.scale,
                      transform: exitTransform,
                    });
                    trace.action('abs-in-frame:exit-node-commit', {
                      nodeId: node.id,
                      dimScreen: dim ? { left: dim.left, top: dim.top, width: dim.width, height: dim.height } : null,
                      iframeOffset,
                      cssLeft,
                      cssTop,
                      cssWidth: Math.round(cssWidth),
                      cssHeight: Math.round(cssHeight),
                      committedStyles: ms,
                    });
                  }
                }
              }
            }
            // The CLONE-extraction branch needs the FULL synchronous mid-drag
            // pipeline (a brand-new node — no imperative primitive can create
            // its DOM; deferring left the clone invisible until drop). Plain
            // unparent exits defer like every other transition — running the
            // 470KB string pipeline + render here was the "unparenting is
            // slow" stall (5 mid-drag flushes in one traced session).
            if (usedCloneExtraction) {
              flushNow();
              forceCanvasRender();
            } else {
              flushNowDeferredDuringDrag();
              forceCanvasRenderDeferredDuringDrag();
            }
            // Re-arm overlay-follow on the POST-SWAP (clone) ids. `beginOverlayFollow`
            // ran at drag START with the ORIGINAL ids — before the detach clone (and
            // its cloned overlay) existed — so the detached overlay sat frozen until
            // the next drag. Now the clone overlay is in the live nodes map (flushNow
            // applied the clone mutations), so re-arming makes it glide with its
            // canvas-node trigger for the REST of this same drag. No-op when no
            // dragged node owns an overlay.
            beginOverlayFollow(getDefaultStore().get(nodesAtom), context.draggedNodes.map(n => n.id), context.contentEl);
            // Mirror the entry-side event — the dragged node is now at
            // canvas root (no vpPrefix). SelectionOverlay /
            // PinConstraintLines / write-routing all key off
            // interactingViewportIdAtom; if it's still 'tablet' from the
            // pre-drag interaction, those overlays will keep looking up
            // `tablet-<id>` which no longer exists. Reset to 'desktop'
            // (the canvas-root primary) so the next frame's overlays
            // resolve against the actual canvas-rendered DOM.
            if (context.viewportPrefix !== '') {
              window.dispatchEvent(new CustomEvent('revyme:set-interacting-viewport', {
                detail: { vpId: 'desktop' },
              }));
            }
            trace.action('abs-in-frame:exit-flushed', {
              overrides: Array.from(this.exitOverrides!.entries()).map(([id, o]) => ({ id, ...o })),
            });
            trace.action('abs-in-frame:code-first-exit', { nodeIds: draggedNodes.map(n => n.id), parentId: this.parentId, framesOutside: this.framesOutsideParent });
          }
        } else { this.framesOutsideParent = 0; }
      }
    }

    if (this.exitedParent) {
      parentHighlightOps.hide(); dropLineOps.hide();
      const overrides = this.exitOverrides;
      const switchVpPrefix = this.exitVpPrefix;
      this.exitOverrides = null;
      this.exitVpPrefix = null;
      return {
        snap: null,
        dropTarget: null,
        highlightParentId: null,
        axisLock: null,
        switchRequest: {
          toStrategy: 'canvas',
          reason: 'parent-exit',
          skipRebuild: !!overrides,
          nodeStateOverrides: overrides ?? undefined,
          ...(switchVpPrefix !== null ? { newViewportPrefix: switchVpPrefix } : {}),
        },
      };
    }

    // Sibling entry detection — cursor-driven (NOT element-overlap-driven).
    // The earlier overlap rule (≥50% of dragged rect inside sibling) caused
    // surprise switches: dragging an absolute element across the parent meant
    // the dragged rect would naturally overlap siblings even though the user
    // hadn't moved their cursor over one. Now we only consider a sibling that
    // the cursor is actually over, mirroring CanvasDragStrategy's rule:
    //   layout sibling: cursor over → enter
    //   non-layout sibling: cursor over + dragged element fully inside → enter
    //   anything else: no candidate, suppress drop-line
    if (!this.parentIsFlexGrid && !this.exitedParent && this.entryGraceCounter === 0 && this.parentId) {
      const elRect = findNodeRect(primary.id, this.vpId);
      if (elRect) {
        const esr: Rect = { left: elRect.left, top: elRect.top, width: elRect.width, height: elRect.height };
        let bestId: string | null = null;
        const hits = getNodeHitsAtPoint(mouseScreen.x, mouseScreen.y);
        const siblingIds = new Set(
          findChildRects(this.parentId, this.vpId)
            .map((s) => s.id)
            .filter((id) => !draggedIds.has(id) && id !== this.parentId),
        );
        let bestIsLayout = false;
        for (const hit of hits) {
          // Treat hits as eligible drop targets when they're either:
          //   • a DIRECT sibling of the dragged element, OR
          //   • a CHILD of a sibling whose display is `grid` OR `flex`.
          //     Each cell / flex slot is a visually distinct drop zone;
          //     cursor-over the slot means "drop INTO this slot", not
          //     "drop into the outer layout container". Same rule
          //     CanvasDragStrategy's layout-child override uses, kept
          //     in sync (the same physical drop pattern shouldn't
          //     diverge by which strategy is currently active).
          let isEligibleHit = siblingIds.has(hit.id);
          let isLayoutChildHit = false;
          if (!isEligibleHit) {
            const hitParentId = context.nodes.get(hit.id)?.parentId;
            if (hitParentId && siblingIds.has(hitParentId)) {
              const parentDisplay = findNodeComputedStyle(hitParentId, this.vpId, 'display');
              if (
                parentDisplay === 'grid' || parentDisplay === 'inline-grid'
                || parentDisplay === 'flex' || parentDisplay === 'inline-flex'
              ) {
                isEligibleHit = true;
                isLayoutChildHit = true;
              }
            }
          }
          if (!isEligibleHit) continue;
          const sn = context.nodes.get(hit.id);
          if (!nodeAcceptsChildren(sn)) continue;
          // Overlays are portal-positioned (they follow their own trigger) — NEVER
          // a drop parent. Dragging the SOURCE over its open overlay must not
          // reparent it INTO the overlay (the overlap is purely visual).
          if (isOverlayNode(sn)) continue;
          const sr = findNodeRect(hit.id, this.vpId);
          if (!sr) continue;

          const sl = detectParentLayoutById(hit.id, this.vpId);
          const isLayoutSib = sl === 'flex' || sl === 'grid';
          if (isLayoutSib) {
            // Layout sibling under cursor — show drop-line PREVIEW. We do not
            // switch strategies or commit the reparent here. On mouseup, if
            // this preview is still active, onEnd commits the insertion.
            // This matches canvas-drag UX (proposal then commit) and avoids
            // the "trapped in layout-lifted" experience.
            bestId = hit.id;
            bestIsLayout = true;
            break;
          }
          // Layout-child hit (non-layout child of a flex/grid sibling):
          // cursor-over is enough — skip the fully-inside check that
          // would otherwise suppress entry for elements bigger than
          // the slot/cell.
          if (isLayoutChildHit) {
            bestId = hit.id;
            break;
          }
          // Non-layout direct sibling: require the dragged element to be fully inside.
          const fullyInside =
            esr.left >= sr.left &&
            esr.left + esr.width <= sr.left + sr.width &&
            esr.top >= sr.top &&
            esr.top + esr.height <= sr.top + sr.height;
          if (!fullyInside) break;
          bestId = hit.id;
          break;
        }
        // Suppress unused warning — kept for legacy callers.
        void SIBLING_ENTRY_OVERLAP_THRESHOLD;

        // ─── Layout-sibling preview branch ──────────────────────────────
        if (bestIsLayout && bestId) {
          const sd = getFlexDirectionById(bestId, this.vpId);
          const sc = findChildRects(bestId, this.vpId);
          const insertIndex = sc.length > 0
            ? calculateLayoutInsertIndexById(mouseScreen, bestId, this.vpId, sd, draggedIds)
            : 0;
          if (sc.length > 0) {
            dropLineOps.show({ parentId: bestId, insertIndex, vpId: this.vpId });
          } else {
            // Empty layout sibling — no siblings to draw a line between.
            // Mark the layout-drop flag so PinConstraintLines + snap-
            // guides hide alongside the parent-highlight preview, just
            // like the with-children case.
            dropLineOps.markEmptyLayoutDrop();
          }
          this.pendingLayoutDrop = { siblingId: bestId, insertIndex };
          // Reset non-layout candidate tracking — these branches are mutually exclusive.
          this.candidateSiblingId = null;
          this.framesInCandidateSibling = 0;
          this.siblingEntryConfirmed = false;
          return { snap, dropTarget: null, highlightParentId: bestId, highlightVpId: this.vpId, axisLock: null };
        }
        // Cursor is no longer over a layout sibling — clear any pending preview.
        if (this.pendingLayoutDrop) {
          this.pendingLayoutDrop = null;
          dropLineOps.hide();
        }

        if (bestId !== this.candidateSiblingId) {
          this.candidateSiblingId = bestId; this.framesInCandidateSibling = bestId ? 1 : 0; this.siblingEntryConfirmed = false;
          if (!bestId) dropLineOps.hide();
        } else if (bestId) {
          this.framesInCandidateSibling++;
          if (!this.siblingEntryConfirmed && this.framesInCandidateSibling >= ENTRY_GRACE_FRAMES) {
            this.siblingEntryConfirmed = true;
            trace.action('abs-in-frame:sibling-entry-confirmed', { nodeId: primary.id, siblingId: bestId, framesInside: this.framesInCandidateSibling });
          }
        }

        if (this.siblingEntryConfirmed && this.candidateSiblingId) {
          const sl = detectParentLayoutById(this.candidateSiblingId, this.vpId);
          if (sl === 'flex' || sl === 'grid') {
            const sd = getFlexDirectionById(this.candidateSiblingId, this.vpId);
            const sc = findChildRects(this.candidateSiblingId, this.vpId);
            if (sc.length > 0) { const ii = calculateLayoutInsertIndexById(mouseScreen, this.candidateSiblingId, this.vpId, sd, draggedIds); dropLineOps.show({ parentId: this.candidateSiblingId, insertIndex: ii, vpId: this.vpId }); }
            else dropLineOps.markEmptyLayoutDrop();
            trace.action('abs-in-frame:sibling-layout-entry', { siblingId: this.candidateSiblingId, layout: sl });
            return { snap: null, dropTarget: null, highlightParentId: this.candidateSiblingId, axisLock: null, switchRequest: { toStrategy: 'layout-lifted', reason: 'sibling-layout-entry' } };
          }

          // Live (code-first) reparent into the sibling — symmetric with
          // the grandparent-reparent exit path: re-parenting happens DURING
          // the drag, not deferred to mouseup. Once committed, the strategy
          // continues with the new parent so the user can keep dragging
          // smoothly inside.
          //
          // Three things must happen ATOMICALLY with the reparent so the
          // element doesn't visibly jump on the post-reparent frame:
          //   1. Include `transform: orig` in the move mutation styles.
          //      Without this, the JSX commit reapplies left/top but the
          //      per-frame `translate(dx, dy)` from the prior tick still
          //      lives in the inline `transform` — element snaps to
          //      (rl + dx, rt + dy) until the next onMove tick clears it.
          //   2. Sync the imperative node cache (moveNodeInCache +
          //      updateNodeInCache). The next onMove tick reads from the
          //      cache to recompute snap targets / derived state; without
          //      the sync it sees stale parent + lift coords.
          //   3. Patch the inline `transform` back to `orig` immediately
          //      via patchNodeStyles so the DOM update lands BEFORE the
          //      browser's next paint (the JSX flush + render path can
          //      take a frame to land in the iframe).
          // The reparented parent-local position per node — captured
          // here so the post-reparent baseline (`node.startLeft/Top`)
          // below reuses it instead of re-deriving with naive AABB math.
          const entryLocalPos = new Map<string, { l: number; t: number }>();
          // Track nodes whose inset we stripped — used below to override
          // the post-reparent `startInsets` re-init so onMove stops
          // writing cs.right/cs.bottom (which would re-introduce the
          // inset on mouseup). See grandparent-reparent path for the
          // full rationale.
          const insetClearedIds = new Set<string>();

          // LAYOUT-CHILD entry (cell of grid OR slot of flex): anchor
          // at CURSOR position. The dragged element's rect may have
          // been moved elsewhere by dynamic-pin on the previous tick,
          // AND `computeEntryParentLocalPosition` internally uses the
          // bridge's cached CORNERS as the anchor — bypassing the
          // `nr` we'd pass in — so a synthesized cursor-anchored rect
          // wouldn't take effect. Compute the cursor-anchored
          // parent-local coords DIRECTLY here for layout-child targets
          // so the cached-corner path is bypassed entirely. Element
          // lands at the cursor's location within the new slot/cell,
          // matching what the user pointed at.
          //
          // For direct-sibling entry the existing helper is fine —
          // the dragged element is cursor-following via transform AND
          // the corners cache reflects that (no dynamic-pin drift
          // when the cursor is over an immediate sibling frame).
          const candidateNode = context.nodes.get(this.candidateSiblingId!);
          const candidateParentId = (candidateNode as any)?.parentId;
          const candidateParentDisplay = candidateParentId
            ? findNodeComputedStyle(candidateParentId, this.vpId, 'display')
            : '';
          const isLayoutChildTarget =
            candidateParentDisplay === 'grid' || candidateParentDisplay === 'inline-grid'
            || candidateParentDisplay === 'flex' || candidateParentDisplay === 'inline-flex';

          for (const node of context.draggedNodes) {
            const nr = findNodeRect(node.id, this.vpId);
            let rl = 0, rt = 0;
            if (isLayoutChildTarget) {
              // Cursor-anchored entry — map cursor to the target's
              // local CSS coords via its PAINTED QUAD corners (handles
              // arbitrary ancestor transforms: rotated grid, skewed
              // flex, etc.). See CanvasDragStrategy's matching block
              // for the full rationale on why corners beat AABB here.
              const corners = getScreenCornersById(this.candidateSiblingId!, this.vpId);
              const sibCssDims = findNodeComputedStyles(this.candidateSiblingId!, this.vpId, ['width', 'height']);
              const sibCssW = parseFloat(sibCssDims.width);
              const sibCssH = parseFloat(sibCssDims.height);
              const elemComputed = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
              const cssW = parseFloat(elemComputed.width) || (nr ? nr.width / transform.scale : 0);
              const cssH = parseFloat(elemComputed.height) || (nr ? nr.height / transform.scale : 0);
              if (corners && Number.isFinite(sibCssW) && sibCssW > 0 && Number.isFinite(sibCssH) && sibCssH > 0) {
                // 2D affine solve — works for any combination of
                // rotation / skew / scale on the cell's ancestor chain.
                // See CanvasDragStrategy's matching block for the full
                // derivation. The dot-product projection this replaced
                // gave wrong results for skewed transforms because the
                // cell's local axes are non-orthogonal in that case.
                const xAxisX = corners.TR.x - corners.TL.x;
                const xAxisY = corners.TR.y - corners.TL.y;
                const yAxisX = corners.BL.x - corners.TL.x;
                const yAxisY = corners.BL.y - corners.TL.y;
                const dx = mouseScreen.x - corners.TL.x;
                const dy = mouseScreen.y - corners.TL.y;
                const det = xAxisX * yAxisY - yAxisX * xAxisY;
                const relX = det !== 0 ? (dx * yAxisY - dy * yAxisX) / det : 0;
                const relY = det !== 0 ? (dy * xAxisX - dx * xAxisY) / det : 0;
                rl = Math.round(relX * sibCssW - cssW / 2);
                rt = Math.round(relY * sibCssH - cssH / 2);
              } else {
                // Fallback: AABB-relative for non-transformed cases.
                const sibScreenRect = findNodeRect(this.candidateSiblingId!, this.vpId);
                if (sibScreenRect) {
                  const cursorLocalX = (mouseScreen.x - sibScreenRect.left) / transform.scale;
                  const cursorLocalY = (mouseScreen.y - sibScreenRect.top) / transform.scale;
                  rl = Math.round(cursorLocalX - cssW / 2);
                  rt = Math.round(cursorLocalY - cssH / 2);
                }
              }
            } else if (nr) {
              // Direct-sibling path: existing transform-aware helper.
              const entry = computeEntryParentLocalPosition(
                node.id, this.candidateSiblingId!, nr, this.vpId, transform.scale,
              );
              if (entry) { rl = entry.parentRelLeft; rt = entry.parentRelTop; }
            }
            entryLocalPos.set(node.id, { l: rl, t: rt });
            const orig = this.originalTransforms.get(node.id) ?? '';
            // Strip translate — `rl/rt` is visible top-left in new parent's
            // coords; keeping the translate would shift by W/2.
            const entryTransform = stripTranslateFunctions(orig);

            // INSET PRESERVATION (mirror grandparent-reparent above): clear
            // `right`/`bottom` if source had them and lock current visible
            // width/height so the element doesn't resize against the new
            // parent's dimensions.
            const nodeSrc = context.nodes.get(node.id)?.styles ?? {};
            const hasInsetW = !!nodeSrc.left && !!nodeSrc.right;
            const hasInsetH = !!nodeSrc.top && !!nodeSrc.bottom;
            const entryStyles: Record<string, string> = {
              position: 'absolute',
              left: `${rl}px`,
              top: `${rt}px`,
              transform: entryTransform,
            };
            if ((hasInsetW || hasInsetH) && nr) {
              // Use COMPUTED CSS box (layout box, pre-transform) for
              // the width/height commit on inset-clear. `nr.width /
              // scale` is the rotated/scaled SCREEN AABB — for a
              // rotated full-inset element the AABB can be √2× wider
              // than the layout box, and committing that as `width`
              // with the rotation transform still applied makes the
              // element visibly jump to ~2× its size on the next
              // render. The computed `width` IS the browser-resolved
              // `parentW - left - right` layout box, which is what
              // we want to lock in.
              const computedEntry = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
              const entryCssW = parseFloat(computedEntry.width);
              const entryCssH = parseFloat(computedEntry.height);
              if (hasInsetW) {
                entryStyles.width = `${Math.round(Number.isFinite(entryCssW) && entryCssW > 0 ? entryCssW : nr.width / transform.scale)}px`;
                entryStyles.right = '';
              }
              if (hasInsetH) {
                entryStyles.height = `${Math.round(Number.isFinite(entryCssH) && entryCssH > 0 ? entryCssH : nr.height / transform.scale)}px`;
                entryStyles.bottom = '';
              }
              insetClearedIds.add(node.id);
            }

            queueMutation({
              type: 'move',
              nodeId: node.id,
              newParentId: this.candidateSiblingId!,
              styles: entryStyles,
            });
            // IMPERATIVE-FIRST RE-HOME — same contract as the grandparent-
            // reparent block above: the drag-locked render can no longer move
            // the DOM parent, so without this the element keeps the OLD
            // containing block (often overflow:hidden → clipped invisible, or
            // wrong ancestor → offset) for the rest of the drag. This is also
            // the TRANSFORMED-target entry path (affine solve above) — the
            // committed sibling-local coords only paint right once the element
            // actually lives under the sibling. `-1` = append, no order slots.
            getCanvasBridge().reparentLive?.(node.id, context.viewportPrefix, this.candidateSiblingId!, -1, entryStyles);
            moveNodeInCache(node.id, this.candidateSiblingId!);
            updateNodeInCache(node.id, entryStyles);
            patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { transform: entryTransform });
          }

          // Make the layout-child target a CONTAINING BLOCK for its
          // newly-absolute children. A grid cell / flex slot that lives
          // as a plain `<div>` with no `position` style is NOT a
          // containing block — an absolute child inside it resolves its
          // `left/top` against the nearest POSITIONED ancestor (typically
          // the outer grid/flex container, which is much bigger). Our
          // entry math is correct relative to the target cell, but the
          // browser interprets the same px values relative to the wrong
          // ancestor → element renders far from where we placed it.
          // Adding `position: relative` on the target makes the cell
          // its own containing block; absolute coords resolve against
          // it as intended. Flex children often inherit this naturally;
          // grid cells almost never do — this hits primarily on grid
          // entries, but applies uniformly to any layout-child target
          // for consistency.
          if (isLayoutChildTarget && this.candidateSiblingId) {
            const targetStyles = context.nodes.get(this.candidateSiblingId)?.styles ?? {};
            const existingPos = targetStyles.position || '';
            // Only force when the target lacks an effective positioning
            // anchor (static or absent). `relative` / `absolute` /
            // `sticky` / `fixed` all create containing blocks, so leave
            // those alone — we shouldn't override the user's choice.
            if (!existingPos || existingPos === 'static') {
              queueMutation({
                type: 'updateStyles',
                nodeId: this.candidateSiblingId,
                styles: { position: 'relative' },
              });
              updateNodeInCache(this.candidateSiblingId, { position: 'relative' });
              patchNodeStyles(context.contentEl, this.candidateSiblingId, context.viewportPrefix, { position: 'relative' });
              trace.action('abs-in-frame:promote-target-to-relative', {
                targetId: this.candidateSiblingId,
                reason: 'layout-child-needs-containing-block',
              });
            }
          }

          flushNowDeferredDuringDrag();
          forceCanvasRenderDeferredDuringDrag();
          trace.action('abs-in-frame:code-first-sibling-reparent', { siblingId: this.candidateSiblingId });
          this.parentId = this.candidateSiblingId;
          // Recompute exit-derived state for the new parent — same shape
          // as the grandparent-reparent path. Without this, exitDestination
          // keeps the original onStart value (often 'canvas' for a
          // grandparent that's a flex root), so any minor drag past the
          // new sibling's edge punts the element straight to canvas.
          const newParentTransform = findNodeComputedStyle(this.parentId!, this.vpId, 'transform');
          this.parentHasTransform = isNonIdentityTransform(newParentTransform);
          const newParentDisplay = findNodeComputedStyle(this.parentId!, this.vpId, 'display');
          this.parentIsFlexGrid = newParentDisplay === 'flex' || newParentDisplay === 'inline-flex'
            || newParentDisplay === 'grid' || newParentDisplay === 'inline-grid';
          const newParentNode = context.nodes.get(this.parentId!);
          const ggpId = newParentNode?.parentId ?? null;
          const ggpNode = ggpId ? context.nodes.get(ggpId) : null;
          const ggpLayout = ggpId ? detectParentLayoutById(ggpId, this.vpId) : null;
          const ggpIsLayout = ggpLayout === 'flex' || ggpLayout === 'grid';
          // Viewport root ('root') counts — see onStart rationale.
          const ggpIsReparentTarget = !!ggpNode
            && nodeAcceptsChildren(ggpNode)
            && !ggpIsLayout;
          this.exitDestination = ggpIsReparentTarget ? 'grandparent' : 'canvas';
          this.grandparentId = ggpIsReparentTarget ? ggpId : null;
          // Refresh dynamic-pin parent-type rule: dragging from the
          // viewport into a sibling frame flips this from true → false,
          // so the per-frame loop immediately picks up the full 3×3
          // zone rule (Y can land in any band) on the very next tick.
          // Without this refresh, the user has to drop and restart the
          // drag inside the sibling to get bottom-pin / top-percent
          // behaviour.
          this.parentIsViewport = (newParentNode?.parentId ?? null) === null;
          // Mark this reparent as cursor-driven so exit detection above
          // (line 441) uses cursor-out-of-parent, NOT the element's AABB.
          // Reason: the entry predicate required the element rect to be
          // FULLY INSIDE the sibling, but once committed the user can
          // freely drag the element anywhere within the sibling's
          // SCREEN area — including across its edges (rotation handles,
          // overflowing content). Element-rect-based exit would bounce
          // the element straight back out as soon as ANY corner crossed
          // an edge. Cursor-based exit matches the user's mental model:
          // "while my cursor is over green, I'm parenting into green".
          this.useCursorExit = true;
          // Post-reparent drag baseline. `onMove` does
          // `newLeft = startLeft + delta` where `delta` is in
          // parent-LOCAL coords (projective inversion). So `startLeft`
          // must also be parent-local — reuse the transform-aware
          // `rl/rt` we just committed, NOT a naive `(nr.left - pr.left)`
          // AABB re-derivation (which would be wrong for a transformed
          // sibling AND timing-dependent on the bridge cache refresh).
          for (const node of context.draggedNodes) {
            const ep = entryLocalPos.get(node.id);
            if (ep) { node.startLeft = ep.l; node.startTop = ep.t; }
            node.startParentId = this.parentId!;
          }
          context.startMouse = { x: mouseScreen.x, y: mouseScreen.y };
          this.candidateSiblingId = null; this.framesInCandidateSibling = 0; this.siblingEntryConfirmed = false;
          this.framesOutsideParent = 0; this.entryGraceCounter = AbsoluteInFrameStrategy.ENTRY_GRACE_PERIOD;

          // Re-snapshot lift-time corners against the post-reparent
          // position. Same rationale as the grandparent-reparent path:
          // `startLeft/Top` were just reset to NEW-sibling local coords,
          // and the per-frame snap projects `liftCorners + delta` — that
          // delta is now in the new parent's space, so the baseline
          // must be the element's current canvas-space corners (post-
          // sibling-entry). Without this, snap guides fire at random
          // positions until the user drops and restarts the drag.
          this.refreshLiftCorners(context.draggedNodes.map(n => n.id), context.transform);

          this.startInsets.clear();
          for (const node of context.draggedNodes) {
            const nd = context.nodes.get(node.id); const ns = nd?.styles || {};
            const es: Record<string, string> = {}; for (const k of ['left', 'right', 'top', 'bottom', 'width', 'height']) { if (ns[k]) es[k] = ns[k]; }
            const pr = findNodeRect(this.parentId!, this.vpId);
            // parentWidth/Height in CSS px — `findNodeRect` returns
            // screen-space dimensions, but auto-pin math (band thresholds,
            // newLeftCss) runs in CSS px. Divide by scale so bands are
            // correct at any zoom level (was raw screen px → off by
            // `scale` at zoom != 100%).
            // elemCssWidth/Height from computedCache — un-rotated layout
            // box so the pin-switch math (`bottom = parentH - top - height`)
            // doesn't jump on rotated elements (rotated AABB ≠ layout box).
            const sibCssDims = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
            const sibCssW = parseFloat(sibCssDims.width);
            const sibCssH = parseFloat(sibCssDims.height);
            // Parent CSS box dims — un-rotated layout box, correct
            // for transformed parents. Same rule as onStart.
            const sibParentCssDims = findNodeComputedStyles(this.parentId!, this.vpId, ['width', 'height']);
            const sibParentCssW = parseFloat(sibParentCssDims.width);
            const sibParentCssH = parseFloat(sibParentCssDims.height);
            this.startInsets.set(node.id, {
              right: parseFloat(ns.right || '0') || 0,
              bottom: parseFloat(ns.bottom || '0') || 0,
              inset: getInsetState(es),
              isPercentMode: (ns.left || '').includes('%'),
              startLeftPercent: parseFloat(ns.left || '0') || 0,
              startTopPercent: parseFloat(ns.top || '0') || 0,
              parentWidth: Number.isFinite(sibParentCssW) && sibParentCssW > 0
                ? sibParentCssW
                : (pr?.width ?? 1) / context.transform.scale,
              parentHeight: Number.isFinite(sibParentCssH) && sibParentCssH > 0
                ? sibParentCssH
                : (pr?.height ?? 1) / context.transform.scale,
              elemCssWidth: Number.isFinite(sibCssW) ? sibCssW : node.width / context.transform.scale,
              elemCssHeight: Number.isFinite(sibCssH) ? sibCssH : node.height / context.transform.scale,
            });
          }
          // Sibling-entry → unlock dynamic pinning for these nodes.
          // Source `data-pinned` is dropped so the new context picks
          // pins automatically. Same rationale as the grandparent-
          // reparent unlock above.
          for (const node of context.draggedNodes) {
            this.dynamicPinNodes.add(node.id);
            queueMutation({
              type: 'updateHtmlAttrs',
              nodeId: node.id,
              attrs: { 'data-pinned': '' },
            });
          }

          // Override startInsets for inset-cleared nodes so onMove
          // doesn't keep writing cs.right/cs.bottom from stale state.
          // Same rationale as the grandparent-reparent override above.
          const pr2 = findNodeRect(this.parentId!, this.vpId);
          for (const node of context.draggedNodes) {
            if (!insetClearedIds.has(node.id)) continue;
            const sibOvCss = findNodeComputedStyles(node.id, this.vpId, ['width', 'height']);
            const sibOvCssW = parseFloat(sibOvCss.width);
            const sibOvCssH = parseFloat(sibOvCss.height);
            this.startInsets.set(node.id, {
              right: 0,
              bottom: 0,
              inset: getInsetState({
                left: `${node.startLeft}px`,
                top: `${node.startTop}px`,
                width: `${node.width / transform.scale}px`,
                height: `${node.height / transform.scale}px`,
              }),
              isPercentMode: false,
              startLeftPercent: 0,
              startTopPercent: 0,
              parentWidth: (pr2?.width ?? 1) / transform.scale,
              parentHeight: (pr2?.height ?? 1) / transform.scale,
              elemCssWidth: Number.isFinite(sibOvCssW) ? sibOvCssW : node.width / transform.scale,
              elemCssHeight: Number.isFinite(sibOvCssH) ? sibOvCssH : node.height / transform.scale,
            });
          }
        }
      }
    }

    return { snap, dropTarget: null, highlightParentId: this.candidateSiblingId ?? this.parentId, highlightVpId: this.vpId, axisLock: null };
  }

  onEnd(context: DragContext): PendingUpdate[] {
    const updates: PendingUpdate[] = [];

    // Drop-in-parent on a multi-vp replica drag is a SYNCED UNPARENT —
    // the source already moved globally during drag, the new parent is
    // now its committed home, every vp renders it there. Any pending
    // vp-only-extraction snapshot becomes moot because we're not going
    // to canvas. Clear the registry to keep it from leaking to the
    // next drag.
    for (const node of context.draggedNodes) {
      if (getPendingReplicaExtraction(node.id)) {
        clearPendingReplicaExtraction(node.id);
        trace.action('abs-in-frame:clear-extraction-snapshot-on-parent-drop', { nodeId: node.id });
      }
    }

    // SYNCED-UNPARENT short-circuit. If any dragged node is a
    // consolidation clone (created by a replica drag-out in
    // AbsoluteInFrameStrategy and registered in
    // consolidation-clone-store), the user clearly continued out of
    // the source parent INTO a new parent — the strategy switched
    // AbsoluteInFrame(old) → Canvas → AbsoluteInFrame(new) and we're
    // now in the new instance about to commit the CLONE at the new
    // parent. That's the wrong target: a synced unparent moves the
    // SOURCE globally so every viewport renders it at the new spot.
    //
    // CanvasDragStrategy.onEnd has the matching cleanup for the case
    // where the user drops on free canvas; this branch handles the
    // "enter a new parent then drop" case which never reaches
    // CanvasDragStrategy.onEnd.
    //
    // Per the user's "no hidden in other viewport" rule, we wipe
    // every per-vp `display: none` on the source so the unparent is
    // a fresh placement everywhere.
    const consolidations: Array<{ cloneId: string; info: import('../consolidation-clone-store').ConsolidationInfo }> = [];
    for (const node of context.draggedNodes) {
      const info = getConsolidationClone(node.id);
      if (info) consolidations.push({ cloneId: node.id, info });
    }
    if (consolidations.length > 0 && this.parentId) {
      const newParentId = this.parentId;
      for (const { cloneId, info } of consolidations) {
        // Re-use the clone's final position (lastStyles, which the
        // strategy tracked during this segment of the drag inside the
        // entered parent) for the source's new placement.
        const last = this.lastStyles.get(cloneId) ?? {};
        const styles: Record<string, string> = {
          position: 'absolute',
        };
        if (last.left != null) styles.left = last.left;
        if (last.top != null) styles.top = last.top;
        if (last.right != null) styles.right = last.right;
        if (last.bottom != null) styles.bottom = last.bottom;
        updates.push({
          nodeId: info.sourceId,
          type: 'move',
          newParentId,
          styles,
        });
        // Wipe every per-vp display:none on the source. Covers the
        // drag-exit-time write on the source vp plus any pre-existing
        // hide that the user's rule says shouldn't survive a synced
        // unparent.
        for (const vpId of Object.keys(getViewportWidths())) {
          const vpWidth = getViewportWidths()[vpId] ?? 0;
          updates.push({
            nodeId: info.sourceId,
            type: 'updateContainerStyle',
            maxWidth: vpWidth,
            styles: { display: '' },
          });
        }
        updates.push({ nodeId: cloneId, type: 'remove' });
        clearConsolidationClone(cloneId);
        trace.action('abs-in-frame:consolidate-synced-unparent', {
          cloneId, sourceId: info.sourceId, sourceVpId: info.sourceVpId,
          newParentId, styles,
        });
      }
      // Skip the regular commit path — the consolidation drives the
      // entire commit and the clone's lastStyles/lastPositions are no
      // longer relevant once it's removed.
      this.cleanup();
      return updates;
    }

    // ATOMIC final-state inline patch: write the would-be inset values
    // (lastStyles — left/right/top/bottom or percent) AND clear transform
    // back to <orig> in ONE patchNodeStyles call per node. If we cleared
    // the transform first and committed insets via the mutation queue
    // afterward, there would be a 1+ frame gap where the element snapped
    // back to its lift inline position before the JSX flush bumped it
    // forward — visible as an ugly two-step on mouseup. One patch keeps
    // the visual state continuous from the last drag frame.
    //
    // Fan-out cleanup: in component master files, mid-drag mirrored the
    // `transform` to every variant viewport's painting (with `important`
    // so it beat framer-motion). On mouseup we must restore those
    // paintings' transform to its pre-drag value too — otherwise the
    // leftover `translate(...)` stays glued to each variant's element
    // and after the JSX commit the variants visibly jump to "base
    // position + leftover translate".
    // Mid-drag fan-out only happens when the DRAG started on the primary
    // viewport — `updateNodeStyles` enters its component-primary branch
    // and blasts the transform across every viewport's painting. When the
    // drag started on a non-primary variant, only that variant's own
    // painting was ever touched mid-drag (the variantName-or-replica
    // branch in `updateNodeStyles` patches a single element). So the
    // onEnd cleanup must mirror that: fan out only when this drag came
    // from the primary; otherwise stick to the dragged prefix and leave
    // the other paintings completely untouched, otherwise we'd blast the
    // variant's drag styles onto the primary (the user-reported "primary
    // jumps a bit when dragging a replica child").
    const wasPrimaryDrag = context.viewportPrefix === '';
    const bridge = getCanvasBridge();
    for (const node of context.draggedNodes) {
      const orig = this.originalTransforms.get(node.id) ?? '';
      const liveStyles = this.lastStyles.get(node.id) ?? {};
      // VARIANT drag of an svg GROUP CHILD: skip the restore entirely. The
      // restore would (a) write `transform: orig` — the PRE-drag fold, whose
      // x/y deltas are the OLD position — and (b) push liveStyles' left/top
      // through patchNodeStyles' svg redirect as NEW x/y attr patches:
      // old delta + new attrs double-count, the painting flashes wrong, then
      // the flush rebuild snaps it right — the user-visible "jumps from
      // previous to new position on mouseup". The live tick's
      // `translate(dx,dy) + orig` already paints EXACTLY the final fold
      // (translate composes linearly with the entry deltas), so leaving it
      // until the rebuild replaces it with the identical folded transform is
      // seamless.
      const restoreNode = getNodeFromCache(node.id);
      const restoreParent = restoreNode?.parentId ? getNodeFromCache(restoreNode.parentId) : null;
      const isVariantSvgChildDrag = !!context.viewportPrefix
        && isComponentFilePath(getActiveFilePath())
        && restoreNode?.type === 'svg' && restoreParent?.type === 'svg';
      if (isVariantSvgChildDrag) {
        trace.action('abs-in-frame:skip-variant-svg-child-restore', { nodeId: node.id, prefix: context.viewportPrefix });
      } else {
        patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, { ...liveStyles, transform: orig }, !!context.viewportPrefix);
      }

      // Variant drag (non-primary in a component master): the upcoming
      // JSX commit updates `variants[variantName]` from OLD → NEW.
      // framer-motion's `layout={true}` element notices the layout
      // change and animates a translate3d via `transform` — visible as
      // the "variant offsets on mouseup" flicker. The fix lives inside
      // `updateVariantStyleInCode` (generator-styles.ts), which now
      // writes `transition: { duration: 0 }` into the variant entry
      // alongside the new styles so framer-motion applies the value
      // instantly. Nothing to do here.

      if (!wasPrimaryDrag) continue;

      // Primary drag fan-out: walk the rectCache to find every other
      // prefix that painted this node mid-drag; on each one, atomically
      // clear our drag transform AND apply the final liveStyles. Two
      // reasons for the atomic patch:
      //
      //   1. If we only cleared the transform, the variant element
      //      would briefly fall back to the inline left/top in the
      //      currently-rendered JSX (which is still the PRE-drag
      //      value, since the JSX commit hasn't flushed yet). That
      //      shows up as a 1-frame snap-back to the previous position
      //      followed by another snap to the new one once the JSX
      //      lands — exactly the glitch the user reported.
      //
      //   2. Variant overrides are preserved: properties the variant
      //      has its own value for in the variants object are filtered
      //      out so we don't temporarily clobber a per-variant left/top
      //      with the primary's value.
      if ('rectCache' in bridge) {
        const cache = (bridge as any).rectCache as Map<string, DOMRect>;
        for (const key of cache.keys()) {
          const parsed = parseRectCacheKey(key);
          if (!parsed) continue;
          const { vpPrefix: prefix, nodeId: dataId } = parsed;
          if (dataId !== node.id) continue;
          if (prefix === context.viewportPrefix) continue;
          const variantName = prefix.endsWith('-') ? prefix.slice(0, -1) : prefix;
          const overridden = getVariantOverriddenKeys(node.id, variantName);
          let mirrorStyles: Record<string, string> = liveStyles;
          if (overridden && overridden.size > 0) {
            mirrorStyles = {};
            for (const [k, v] of Object.entries(liveStyles)) {
              if (!overridden.has(k)) mirrorStyles[k] = v;
            }
          }
          // A variant that owns its position owns its TRANSFORM (per-variant
          // x/y deltas paint as that painting's folded translate —
          // getVariantOverriddenKeys maps them to 'transform'). Restoring the
          // primary's `orig` there would clobber the variant's own position
          // for a frame on mouseup.
          if (overridden?.has('transform')) {
            if (Object.keys(mirrorStyles).length > 0) bridge.patchStyles(node.id, prefix, mirrorStyles, true);
          } else {
            bridge.patchStyles(node.id, prefix, { ...mirrorStyles, transform: orig }, true);
          }
        }
      }
    }

    // Commit a pending layout-sibling drop: insert the dragged element as a
    // flex/grid child at the previewed insertion index. position/left/top are
    // stripped — the element joins the layout flow. `flex: '0 0 auto'` is baked
    // so the new flow child never inherits the CSS-default flex-shrink: 1,
    // which collapses it to ~0 computed height in a height-constrained flex
    // column (design-tool parity: flow children are always shrink: 0 / Fixed-Hug).
    if (this.pendingLayoutDrop && !this.exitedParent) {
      const { siblingId, insertIndex } = this.pendingLayoutDrop;
      trace.action('abs-in-frame:commit-layout-sibling-drop', {
        nodeIds: context.draggedNodes.map(n => n.id),
        siblingId, insertIndex,
      });
      for (const node of context.draggedNodes) {
        updates.push({
          type: 'move',
          nodeId: node.id,
          newParentId: siblingId,
          newIndex: insertIndex,
          styles: { position: '', left: '', top: '', right: '', bottom: '', flex: '0 0 auto' },
        });
      }
      this.cleanup();
      return updates;
    }

    if (this.exitedParent) {
      trace.action('abs-in-frame:onEnd-exit-fallback', { nodeIds: context.draggedNodes.map(n => n.id) });
      for (const node of context.draggedNodes) { const p = this.lastPositions.get(node.id); if (p) updates.push({ nodeId: node.id, type: 'style', styles: { left: `${p.left}px`, top: `${p.top}px` } }); }
    } else {
      const origParent = context.draggedNodes[0]?.startParentId ?? null;
      const didReparent = this.parentId !== null && this.parentId !== origParent;
      if (didReparent) {
        trace.action('abs-in-frame:commit-sibling-reparent-position', { nodeIds: context.draggedNodes.map(n => n.id), originalParentId: origParent, newParentId: this.parentId });
        for (const node of context.draggedNodes) { const s = this.lastStyles.get(node.id); if (s) updates.push({ nodeId: node.id, type: 'style', styles: s }); }
      } else {
        // Drag without reparenting — commit final position. Standard
        // routing is via `getReplicaContext().styleUpdate()` which on a
        // replica vp emits `updateContainerStyle` PendingUpdates (so
        // the replica gets its per-vp position override).
        //
        // EXCEPTION: nodes marked `data-replica-solo="<vpId>"` need
        // the SOLO-REDIRECT contract — final position writes go to
        // BASE inline, with the same active-vp `@container` clear my
        // updateNodeStyles redirect performs. Pushing as `type:'style'`
        // (instead of going through rctx) makes the orchestrator route
        // through `commitDragPosition`, which already has the solo
        // redirect + active-vp clear baked in.
        const rctx = getReplicaContext(this.vpId, getActiveFilePath(), getViewportWidths());
        for (const node of context.draggedNodes) {
          const s = this.lastStyles.get(node.id);
          if (!s) continue;
          // Read from the IMPERATIVE node cache (`getNodeFromCache`)
          // rather than `context.nodes` (the jotai atom snapshot
          // captured at drag start). The `data-replica-solo` attribute
          // is set synchronously into the imperative cache the moment
          // a creator / drag-entry fires `updateHtmlAttrs`, but the
          // jotai atom doesn't refresh until the next React tick. If
          // we read from the stale atom here the first solo node
          // (just entered into a variant) misses the redirect, lands
          // its position in the variant override, and stays out of
          // sync with the inline baseline forever.
          const ndCache = getNodeFromCache(node.id) ?? context.nodes.get(node.id);
          const isSolo = !!ndCache?.attrs?.['data-replica-solo'];
          if (isSolo) {
            updates.push({ nodeId: node.id, type: 'style', styles: s });
          } else {
            updates.push(...rctx.styleUpdate(node.id, s));
          }
        }
      }
    }
    this.cleanup();
    return updates;
  }

  getDropViewportId(_context: DragContext): string { return this.vpId; }

  onCancel(context: DragContext): void {
    // Restore each node to its lift state: original transform + lift
    // left/top in case any inline patch has drifted from those values.
    for (const node of context.draggedNodes) {
      const orig = this.originalTransforms.get(node.id) ?? '';
      patchNodeStyles(context.contentEl, node.id, context.viewportPrefix, {
        left: `${node.startLeft}px`, top: `${node.startTop}px`, transform: orig,
      });
      // Pending replica-extraction snapshot from an exit earlier in
      // this drag's lifecycle: cancel must revert the source's JSX
      // back to its original parent + styles + container overrides.
      // Without this the cancelled drag still leaves the source at
      // canvas-root with cleared container styles.
      const pSnap = getPendingReplicaExtraction(node.id);
      if (pSnap) {
        queueMutation({
          type: 'move',
          nodeId: node.id,
          newParentId: pSnap.originalParentId,
          index: pSnap.originalIndex,
          styles: pSnap.originalStyles,
          canvasNode: false,
        });
        for (const [maxWidth, props] of pSnap.originalContainerOverrides) {
          const stylesObj: Record<string, string> = {};
          for (const [k, v] of props) stylesObj[k] = v;
          queueMutation({
            type: 'updateContainerStyle',
            nodeId: node.id,
            maxWidth,
            styles: stylesObj,
          });
        }
        clearPendingReplicaExtraction(node.id);
      }
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.parentId = null; this.startInsets.clear(); this.lastPositions.clear(); this.lastStyles.clear();
    this.originalTransforms.clear();
    this.flexGroupChildRefit.clear();
    this.svgNeedsAbsolute.clear();
    this.framesOutsideParent = 0; this.exitedParent = false; this.parentIsFlexGrid = false;
    this.candidateSiblingId = null; this.framesInCandidateSibling = 0; this.siblingEntryConfirmed = false;
    this.pendingLayoutDrop = null;
    this.pendingSiblingDrop = null;
    this.useCursorExit = false;
    this.exitVpPrefix = null;
    dropLineOps.hide(); parentHighlightOps.hide();
  }
}
