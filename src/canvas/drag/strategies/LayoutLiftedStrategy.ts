// LayoutLiftedStrategy.ts — standard drag for flex/grid children.
//
// THE FULL FLOW:
// 1. On drag start: snapshot original styles, create visible placeholder, lift node to canvas coords
// 2. During drag over parent: detect reorder position (direction-aware midpoints), move placeholder
// 3. During drag outside parent: hide placeholder, element floats freely (canvas mode)
// 4. During drag back into parent: show placeholder again, resume reorder
// 5. On drop inside parent: reorder (update children order in code)
// 6. On drop outside parent: detach from parent → position absolute on canvas
//
// Bridge-compatible: all DOM reads use findNodeRect/findNodeComputedStyle/findChildRects,
// all DOM writes use patchNodeStyles/bridge commands. No getNodeEl() calls.
// Placeholders created via bridge.createPlaceholder, nodes lifted via bridge.liftNode.

import type { Point, PendingUpdate, Rect, NewNodeDescriptor } from '@/shared/types';
import { nextFrames } from '@/shared/dom-utils';
import { buildCanvasCloneDescriptor } from '../clone-descriptor';
import { queueBorderOverlayDuplicates } from '@/canvas/creators/creator-utils';
import type { DragContext, DragStrategy, DragMoveResult } from '../types';
import { detectParentLayoutById, getFlexDirectionById } from '../types';
import { getCanvasDelta, isInsideRect, getAbsoluteCanvasRectById, screenToPct } from '@/canvas/canvas-math';
import { isPrimaryViewport, vpIdFromPrefix, getActiveFilePath, getViewportPrefix, patchNodeStyles, findNodeRect, findNodeComputedStyle, findNodeComputedStyles, findVisibleChildRects, getNodeHitsAtPoint, injectCanvasCSS, removeCanvasCSS, parseRectCacheKey } from '@/canvas/node-ops';
import { getScreenCornersById, nodeOrAncestorHasRotationOrSkewById, type ScreenCorners } from '@/canvas/resize/geometry-utils';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getIframeOffset } from '../helpers/coords';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import { getNodeFromCache } from '@/code/stores/store';
import { getReplicaContext } from '../replica-context';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { containerOverridesAtom, getOverrideValue, resolveEffectiveStylesForViewport, type ContainerOverrideMap } from '@/code/stores/container-query-store';
import { getDefaultStore } from 'jotai';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { isComponentFilePath, isLayoutFile } from '@/code/project/active-file-store';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { trace } from '@/shared/debug-trace';
import { nodeAcceptsChildren } from '@/shared/constants';
import { calculateLayoutInsertIndexById, computeReorderAssignments } from '../reparent-utils';
import { rankToOrder, pickPlaceholderOrder, normalizeFlowSpans } from './order-positioning';
import { commitOrderAssignments, computeLayoutBrackets } from './order-commit';
import { queueMutation, flushNow, hasPendingDeferredFanOut } from '@/code/mutation/mutation-queue';
import { commitExitToCanvas, flushExitToCanvas } from '../exit-commit';
import { registerDragEndRestore } from '../drag-end-restores';
import { computeExitCanvasPosition } from '../transform-reparent';
import { repositionSignalOps } from '../reposition-signal';
import { forceCanvasRender, flushAndForceStructuralRender } from '@/canvas/node-ops';
import { calculateSnap, getMouseVelocity } from '../handlers/snap-handler';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import { SNAP_THRESHOLD } from '@/shared/constants';

const PLACEHOLDER_BG = 'rgba(59, 130, 246, 0.15)';
const PLACEHOLDER_RADIUS = '4px';
const PLACEHOLDER_TRANSITION = 'all 150ms ease';
const PLACEHOLDER_COOLDOWN_MS = 0; // instant reorder detection

/**
 * Adapter over the shared canonical clone builder (`drag/clone-descriptor.ts`):
 * converts its `AddNodeDef` shape (`{ type }`) into the PendingUpdate `add`
 * path's `NewNodeDescriptor` shape (`{ tag }`) and merges the canvas-drop
 * `rootStyles` onto the clone root — the two signature divergences the old
 * private ~70-line reimplementation existed for. The canonical builder gives
 * this path the full detach semantics AbsoluteInFrameStrategy already had
 * (source-vp visibility drop, textOverrides + effective-order resolution,
 * motion-prop → CSS transform folding, dead `ref` drop, per-node variant
 * bake). `motionProps` are dropped in the conversion — `NewNodeDescriptor`
 * has no channel for them (the orchestrator's add-handler never forwarded
 * them, matching the old private impl's behavior).
 *
 * `sourceVariant` resolves per-variant ternary text (`{variant === 'v1' ? 'A'
 * : 'B'}` → `conditionalText[v1]`). The clone lives at canvas root with no
 * variant context, so the ternary would otherwise fall through to the default
 * branch — which is often the `\u200b` zero-width placeholder. Bake in the
 * source variant's value when present.
 */
function buildCanvasCloneForLayoutDrop(
  nodeId: string,
  nodes: Map<string, import('@/code/parsing/parser').CanvasNode>,
  rootStyles: Record<string, string>,
  sourceVariant?: string,
  /** Source PAGE-replica viewport width (e.g. 768) — used to bake the instance's
   *  per-viewport variant from `data-responsive[width].initialVariant`. */
  sourceVpWidth?: number,
  /** Filled with sourceId → cloneId for the subtree — lets the caller copy
   *  per-id side-band state (::after border rules) onto the clones. */
  idMap: Map<string, string> = new Map(),
): NewNodeDescriptor | null {
  const def = buildCanvasCloneDescriptor(nodeId, nodes, idMap, sourceVpWidth, sourceVariant);
  if (!def) return null;
  const toDescriptor = (d: import('@/code/generation/generator-crud').AddNodeDef, isRoot: boolean): NewNodeDescriptor => ({
    tag: d.type,
    id: d.id,
    name: d.name,
    styles: isRoot ? { ...d.styles, ...rootStyles } : d.styles,
    attrs: d.attrs,
    textContent: d.textContent,
    children: d.children?.map(c => toDescriptor(c, false)),
  });
  return toDescriptor(def, true);
}

/**
 * Merged desired child order for a TEMPLATED page root: every child keeps its
 * DOM slot EXCEPT the reorderable page sections, which take the new sequence.
 *
 * Only ids that are IN `pageSectionOrder` consume from it. The old fill
 * treated ANY non-`layout::` child as a section slot — but a merged root can
 * hold out-of-flow children that never participate in the reorder (an OVERLAY
 * portal child, absolutes). The overlay ate the first slot, so every section
 * shifted one early: `restoreNode(desiredMerged.indexOf(id))` re-inserted the
 * dragged section one slot ABOVE where it was dropped (even a no-move drop
 * jumped up, then snapped back ~0.5s later when the async JSX-reorder render
 * landed — or stayed wrong when that render was skipped), and the run-off
 * `?? id` fallback duplicated the last section in the list (trace 2026-07-28:
 * `desiredMerged` carried `frame-ms0usxa4-7` twice). Exported for tests.
 */
export function computeMergedTemplatedOrder(mergedChildren: string[], pageSectionOrder: string[]): string[] {
  const sectionSet = new Set(pageSectionOrder);
  const out: string[] = [];
  let psi = 0;
  for (const id of mergedChildren) {
    out.push(sectionSet.has(id) ? (pageSectionOrder[psi++] ?? id) : id);
  }
  return out;
}

export class LayoutLiftedStrategy implements DragStrategy {
  readonly name = 'layout-lifted';

  private parentNodeId: string | null = null;
  /** ID of the viewport ancestor node (for exit detection) */
  private viewportNodeId: string | null = null;
  /** One placeholder per dragged node, tracked by placeholder ID */
  private placeholderIds: Set<string> = new Set();
  /** Map from nodeId → placeholderId for lookup */
  private nodeToPlaceholderId: Map<string, string> = new Map();
  /** Per-placeholder recreation spec, captured at create time so the
   *  alt-duplicate swap (placeholder → duplicate → placeholder) can rebuild
   *  the EXACT same placeholder on alt-release. Keyed by the original
   *  dragged-node ID (not placeholder ID) since that's how callers look
   *  it up. */
  private placeholderSpecs: Map<string, {
    placeholderId: string;
    parentId: string;
    vpPrefix: string;
    beforeNodeId: string | null;
    styles: Record<string, string>;
  }> = new Map();
  /** Alt-duplicate ID → its intended visual rank (= dragged's
   *  originalRank). Tracked HERE instead of writing the spaced-rank
   *  `order: '40'` into source — source stays clean (the duplicate
   *  inherits the dragged element's source `order` like a normal copy);
   *  the spaced rank is applied IMPERATIVELY to the iframe DOM via
   *  `reNeutralizeSiblingOrders` after every force-render so the drag-
   *  time visual position is correct without polluting committed code. */
  private altDuplicateRanks: Map<string, number> = new Map();
  private liftedPositions: Map<string, { left: number; top: number; width: number; height: number }> = new Map();
  private originalStyles: Map<string, Record<string, string>> = new Map();
  /** Fresh object per drag — async work (the live-size correction reads)
   *  captures it and no-ops if a resolve lands after the drag ended. */
  private dragSession: object = {};

  /** The min/max box-constraint props captured at lift and re-applied on every
   *  restore path. liftStyles neutralizes them because the lifted node lives
   *  under contentRoot, where percentage constraints resolve against a
   *  zero-size containing block and collapse the drag overlay. */
  private boxConstraintRestore(orig: Record<string, string>): Record<string, string> {
    return {
      maxWidth: orig.maxWidth ?? '',
      maxHeight: orig.maxHeight ?? '',
      minWidth: orig.minWidth ?? '',
      minHeight: orig.minHeight ?? '',
    };
  }
  /** Original child index of each dragged node within the parent (for preserving relative order on drop) */
  private originalChildIndices: Map<string, number> = new Map();
  /** Complete child ID order at drag start (for computing correct sequential reorder indices) */
  private originalChildOrder: string[] = [];
  private currentInsertIndex: number = -1;
  private isOverParent: boolean = true;
  private flexDirection: 'row' | 'column' = 'column';
  private isGridParent = false;
  /** True when the flex parent is `flex-wrap: wrap` — children flow across
   *  MULTIPLE lines, so reorder must be 2D (which line + position in line) like a
   *  grid, NOT 1D along a single axis. */
  private isWrapParent = false;
  /** True when grid children use explicit placement (gridColumn: '1 / 3') — DOM reorder is meaningless */
  private isExplicitGridPlacement = false;
  /** Original grid placements for siblings (for restoring after swap) */
  private originalGridPlacements: Map<string, { gridColumn: string; gridRow: string; gridArea: string }> = new Map();
  /** Original sibling screen positions (frozen at drag start — used for stable detection) */
  private originalSiblingRects: { id: string; rect: DOMRect }[] = [];
  /** Frozen parent bounding rect from drag start (for consistent coordinate conversion with frozen sibling rects) */
  private frozenParentRect: DOMRect | null = null;
  /** Original computed order values per node, captured before neutralization (for cancel restore) */
  private originalOrderValues: Map<string, string> = new Map();
  private prevMouse: Point = { x: 0, y: 0 };
  /** Last detected drag direction along the flex axis. `true` = moving
   *  along positive axis (down for column, right for row), `false` =
   *  negative. `null` until the user has moved enough to register a
   *  direction. Used by calculateReorderIndex to make the placeholder
   *  land in front of the cursor (i+1 going forward, i going back) so
   *  reorder feels "instant and forward" in BOTH directions instead of
   *  asymmetric (instant one way, slow the other). */
  private lastMovingForward: boolean | null = null;
  /** PLACEHOLDER HYSTERESIS: the sibling whose span contained the cursor when
   *  the current insert index was chosen. While the cursor stays inside that
   *  same sibling's span, the direction-aware inside-sibling rule is FROZEN —
   *  wiggling over the just-created placeholder must not flip the index (the
   *  "placeholder jumps back on a 1px reverse move" report). Cleared the
   *  moment the cursor exits into a gap / another sibling / past the ends. */
  /** The dragged primary's insert index AT DRAG START (sibling-space). Rects
   *  are FROZEN for the whole gesture (mid-drag remeasure is suppressed —
   *  gesture-end reconcile owns it), but moving the placeholder DOES reflow
   *  the real screen via CSS order. calculateReorderIndex therefore rebuilds
   *  each sibling's ON-SCREEN span virtually: siblings between the
   *  placeholder's current slot and this start slot are displaced by the
   *  dragged node's flow size. Hit-testing the VIRTUAL spans makes hovering
   *  the placeholder inherently stable (it's a virtual gap) and hovering a
   *  displaced sibling fire instantly at its true screen position. */
  private dragStartInsertIndex: number = -1;
  /** Main-axis outer size (size + one gap) of the dragged primary — the
   *  displacement the placeholder imposes on siblings it moves past. */
  private draggedFlowSize: number = 0;
  /** Minimum-ever first-sibling flow start this gesture — the TRUE flow
   *  origin. A rect refresh while the placeholder sits at slot 0 leaves the
   *  hole BEFORE the first sibling, invisible to adjacent-gap detection;
   *  comparing against this origin closes that front hole too. */
  private flowStartMin: number | null = null;

  private lastPlaceholderMoveTime = 0;
  /** Current viewport ID (cached from context for bridge calls in helper methods) */
  private currentVpId: string = 'desktop';
  /** False until the post-lift bridge.prefetchChildRects() resolves. The lift
   *  patches DOM via postMessage but the parent rectCache only refreshes on
   *  the next allRects emit — between the lift and the first refresh the
   *  cache holds PRE-lift sibling positions, which makes the reorder math
   *  pick the wrong slot for the first ~30ms (visible bug: drag an element
   *  at index 0, placeholder snaps to index 1). Prefetch closes that gap. */
  private siblingRectsReady: boolean = true;

  /** When dragging an item that lives inside a CMS collection list, the list's
   *  DOM-only ghost copies are hidden for the drag so the user moves a single
   *  clean item. Stores the collection container + its vp prefix so cleanup can
   *  re-show them (ghost elements are reused across renders → inline visibility
   *  would otherwise persist). Null when the drag isn't inside a collection. */
  private hiddenGhostsContainerId: string | null = null;
  private hiddenGhostsVpPrefix: string = '';
  /** Set when the drag happened ANYWHERE inside a collection-list template row
   *  (not just ON the row — `hiddenGhostsContainerId` covers that narrower
   *  case). The DOM-only ghost rows are clones of the template, and the
   *  Renderer's patch fast-path can only re-sync them when the template's DOM
   *  STRUCTURE or its CMS BINDINGS changed. A reorder inside the row changes
   *  neither — it rewrites `order` styles — so the ghosts kept a stale copy of
   *  the row and the node the user had just dropped in went missing from every
   *  ghost until a page switch rebuilt them (user report 2026-07-26). Cleanup
   *  forces one render so the rebuild happens on drop instead. */
  private draggedInsideCollectionRow = false;
  /** Canvas-CSS selector hiding the dragged node's synced REPLICAS in the OTHER
   *  page viewports during a layout drag (drag-time only, restored on drop/cancel).
   *  Without this the other viewport tiles reflow/flicker as the code-first move
   *  commits live. Null when no replicas are hidden. */
  private hiddenReplicaSelector: string | null = null;
  /** Set by the mid-drag handoff to CanvasDragStrategy: the gesture outlives
   *  this strategy, so cleanup() must hand the synced-replica restore to the
   *  drag-end registry instead of unhiding the twins mid-drag. */
  private deferReplicaRestoreToDragEnd = false;
  /** Replica overlay copies stamped with an inline `display:none !important` at
   *  drag start (a stylesheet rule can't beat overlay edit mode's show rule).
   *  Cleared in the cleanup — drop AND cancel both pass through there. */
  private hiddenReplicaOverlays: Array<{ id: string; vpPrefix: string }> = [];

  /** Templated page: locked `layout::` template sections that come AFTER the
   *  page content get a high `order` for the drag duration so the page
   *  sections' spaced neutralize ranks don't collide with them at 0 (which
   *  reverses the template chrome mid-drag). Cleared on cleanup + on drop. */
  private bracketedLayoutSectionIds: Set<string> = new Set();
  /** Pre-drag inline `order` of each bracketed chrome section (the MERGE
   *  bracket, e.g. the footer's '100013') — restored ATOMICALLY on drop and
   *  on cancel. Clearing to '' instead left the footer at order 0 until the
   *  next render re-applied the merge bracket; on a replica whose sections
   *  still carried source orders, the footer sorted up under the hero
   *  (mobile footer-under-hero, 2026-07-28). */
  private bracketedChromePrevOrders: Map<string, string> = new Map();

  /** Cross-parent drop state: target parent when dragging outside original parent */
  private intendedParentId: string | null = null;
  private intendedInsertIndex: number = -1;

  canHandle(context: DragContext): boolean {
    const firstNode = context.draggedNodes[0];
    if (!firstNode || !firstNode.startParentId) return false;

    // Canvas nodes are free-floating — always handled by CanvasDragStrategy
    const nodeData = context.nodes.get(firstNode.id);
    if (nodeData?.isCanvasNode) return false;

    // Layout wrappers are not real parents for drag purposes
    if (firstNode.startParentId.startsWith('layout::')) return false;

    // Read EFFECTIVE styles for the active viewport, not just base. A
    // node can be `position: relative` in base inline AND
    // `position: absolute !important` in the active vp's `@container`
    // rule (e.g. user removed the parent's flex layout on a replica via
    // LayoutTool — the convert-to-absolute writes go to the replica's
    // @container, not the base). Reading only `nodeData.styles?.position`
    // would say "relative" and pick the layout-lifted strategy, even
    // though on this vp the child is absolute and should be handled by
    // AbsoluteInFrameStrategy. Bridge-cached computed styles already
    // reflect the active @container cascade, so use those.
    const vpId = vpIdFromPrefix(context.viewportPrefix);
    const childComputedPosition = findNodeComputedStyle(firstNode.id, vpId, 'position');
    const cachePosition = nodeData?.styles?.position || '';
    const position = childComputedPosition || cachePosition || '';

    // Check parent layout from NodeMap
    const parentNode = context.nodes.get(firstNode.startParentId);
    if (!parentNode) return false;
    // SVG container: nested SVG children are positioned via x/y attrs,
    // not CSS flow. Hard-fail here so AbsoluteInFrameStrategy gets the
    // next turn and treats them as absolute (its commit path emits
    // left/top, which node-ops's updateNodeStyles redirects to the
    // wrapper's x/y attrs in source).
    if (parentNode.type === 'svg') return false;
    // Effective parent display — same rationale as the child position
    // check above (replica @container can override base flex/grid with
    // a `display: 'block'` from LayoutTool's remove-layout).
    const parentComputedDisplay = findNodeComputedStyle(firstNode.startParentId, vpId, 'display');
    const parentDisplay = parentComputedDisplay || parentNode.styles?.display || '';
    const parentIsFlex = parentDisplay === 'flex' || parentDisplay === 'inline-flex';

    // A computed `absolute`/`fixed` normally routes to AbsoluteInFrameStrategy.
    // BUT the bridge computed-style cache goes STALE for a beat right after a node
    // ENTERS a flex parent: it was a canvas node / absolute a moment ago and the
    // cache hasn't picked up the freshly-committed `relative` yet. Trusting the
    // stale value routes a genuine flow child to the absolute strategy, which PINS
    // canvas left/top onto it — and a `position: relative` child with a huge
    // canvas inset renders thousands of px off its flex slot, i.e. it VANISHES
    // (the "flex child disappears when I drag it again" bug). Reconcile against the
    // node's OWN cache: when the cache says a flow position (relative/static/unset)
    // AND the parent is really flex, the computed:absolute is stale → keep the node
    // in THIS layout strategy. The genuine @container-absolute case (a replica where
    // the parent's flex was REMOVED) has a NON-flex parent, so it still bails.
    const cacheIsFlow = cachePosition === '' || cachePosition === 'relative' || cachePosition === 'static';
    const staleAbsInFlex = (position === 'absolute' || position === 'fixed') && cacheIsFlow && parentIsFlex;
    if ((position === 'absolute' || position === 'fixed') && !staleAbsInFlex) return false;

    if (parentIsFlex) return true;
    // Grid parents go through `GridDragStrategy` (registered BEFORE
    // this one in `DragCoordinator.strategies`). Grid needs cell-aware
    // detection + explicit-placement swaps that don't fit the
    // order-based reorder model this strategy uses. Returning false
    // here lets the coordinator fall through to whichever strategy is
    // next — for non-grid parents we keep handling flex/block below.
    if (parentDisplay === 'grid' || parentDisplay === 'inline-grid') return false;
    // Block flow: check if parent has any non-absolute children
    return parentDisplay !== 'none' && !position;
  }

  onStart(context: DragContext): void {
    this.dragSession = {};
    const { draggedNodes, transform } = context;
    const primary = draggedNodes[0];
    const parentId = primary.startParentId;
    if (!parentId) return;

    this.parentNodeId = parentId;
    this.prevMouse = context.startMouse;
    this.isOverParent = true;
    const startVpId = vpIdFromPrefix(context.viewportPrefix);
    this.currentVpId = startVpId;
    const vpPrefix = getViewportPrefix(startVpId);

    // SYNCED-REPLICA HIDE (drag-time only): temporarily hide this node's replicas
    // in the OTHER page viewports (its "synced family" — the same data-id rendered
    // under each `<vp>-` prefix). The code-first move commits live, so without this
    // the other viewport tiles reflow/flicker on every mouse move. DOM-only canvas
    // CSS, restored on drop/cancel in the cleanup. The SOURCE viewport (the one
    // being dragged) stays visible. No-op for a single-viewport context.
    this.hiddenReplicaSelector = null;
    this.deferReplicaRestoreToDragEnd = false;
    const otherVpIds = Object.keys(getViewportWidths()).filter(v => v !== startVpId);
    if (otherVpIds.length > 0) {
      // An OPEN overlay whose trigger is being dragged must be hidden with its
      // replica, not left behind. The overlay is portaled OUT of the viewport
      // root, so hiding the replica trigger doesn't touch it — the other tiles
      // kept showing a dropdown pointing at a now-invisible source. Collect the
      // overlay ids that hang off any dragged node and hide those replica copies
      // too. Live find 2026-07-25.
      const draggedIds = new Set(draggedNodes.map(n => n.id));
      const overlayIdsForDragged: string[] = [];
      for (const [, n] of context.nodes) {
        const ovAttr = n.attrs?.['data-overlay'];
        if (!ovAttr) continue;
        try {
          const ovCfg = JSON.parse(ovAttr) as { triggerId?: string };
          if (ovCfg.triggerId && draggedIds.has(ovCfg.triggerId)) overlayIdsForDragged.push(n.id);
        } catch { /* malformed config — leave that overlay alone */ }
      }
      const parts: string[] = [];
      for (const ovp of otherVpIds) {
        const op = getViewportPrefix(ovp);
        for (const dn of draggedNodes) parts.push(`[data-node-id="${op}${dn.id}"]`);
      }
      if (parts.length > 0) {
        this.hiddenReplicaSelector = parts.join(', ');
        injectCanvasCSS(this.hiddenReplicaSelector, 'display: none !important;');
      }
      // Overlays can NOT be hidden by a stylesheet rule. Overlay edit mode injects
      // `[data-id="…"][data-overlay-node] { display: block !important; }`
      // (Canvas.tsx), and TWO attribute selectors out-specify our single
      // `[data-node-id="…"]` — both are `!important`, so specificity decides and the
      // show rule wins. The hide silently did nothing at drag start; what the user
      // eventually saw was `positionOverlayInPortal`'s zero-rect guard stamping
      // `visibility: hidden` once a replay ran mid-move, which is why the overlay
      // lagged the node by "a bit of movement". Stamp INLINE `!important` instead —
      // it beats any stylesheet `!important` regardless of specificity. Same
      // technique the Renderer's per-replica overlay hide already uses.
      this.hiddenReplicaOverlays = [];
      const startBridge = getCanvasBridge();
      if (overlayIdsForDragged.length > 0 && 'patchStyles' in startBridge) {
        for (const ovp of otherVpIds) {
          const op = getViewportPrefix(ovp);
          for (const oid of overlayIdsForDragged) {
            (startBridge as PostMessageBridge).patchStyles(oid, op, { display: 'none' }, true);
            this.hiddenReplicaOverlays.push({ id: oid, vpPrefix: op });
          }
        }
      }
      trace.action('layout-lifted:hide-synced-replicas', {
        startVpId, otherVpIds, count: parts.length,
        overlays: overlayIdsForDragged, overlayCopies: this.hiddenReplicaOverlays.length,
      });
    }

    // Detect layout via bridge
    this.flexDirection = getFlexDirectionById(parentId, startVpId);
    const parentDisplay = findNodeComputedStyle(parentId, startVpId, 'display') || '';
    this.isGridParent = parentDisplay === 'grid' || parentDisplay === 'inline-grid';
    // Flex-wrap → 2D reorder (multi-line). Source style first (sync, reliable),
    // computed as fallback for containers nested in a code component.
    const parentNodeForWrap = getNodeFromCache(parentId);
    const parentWrap = parentNodeForWrap?.styles?.flexWrap || parentNodeForWrap?.styles?.['flex-wrap']
      || findNodeComputedStyle(parentId, startVpId, 'flexWrap') || findNodeComputedStyle(parentId, startVpId, 'flex-wrap') || '';
    // NOT gated on the computed `display`: `findNodeComputedStyle(...,'display')`
    // can MISS the cache for the parent (it isn't prefetched at drag start) and
    // return '' — which silently left isWrapParent false, so the 1D reorder ran and
    // shuffled the wrap layout the moment you started dragging. The flexWrap value
    // is read from the SOURCE style (reliable) and a non-flex parent has none, so
    // `!grid && flexWrap===wrap` is sufficient and robust.
    this.isWrapParent = !this.isGridParent && (parentWrap === 'wrap' || parentWrap === 'wrap-reverse');

    // Detect explicit grid placement from NodeMap styles (not DOM)
    this.isExplicitGridPlacement = false;
    this.originalGridPlacements.clear();
    this.originalSiblingRects = [];
    if (this.isGridParent) {
      const parentNode = getNodeFromCache(parentId);
      if (parentNode) {
        for (const childId of parentNode.children) {
          if (childId.startsWith('layout::')) continue;
          const childNode = getNodeFromCache(childId);
          if (!childNode) continue;
          if (childNode.isCanvasNode) continue;
          const gc = childNode.styles?.gridColumn || '';
          const gr = childNode.styles?.gridRow || '';
          if (gc.includes('/') || gr.includes('/')) {
            this.isExplicitGridPlacement = true;
          }
          this.originalGridPlacements.set(childId, {
            gridColumn: gc, gridRow: gr, gridArea: childNode.styles?.gridArea || '',
          });
        }
      }
    }

    // Neutralize CSS order for drag: read computed order for each child,
    // then set inline order:0 on all children via bridge. This overrides any @media order rules
    // and lets insertion order control visual position during drag.
    // On drop, we assign CSS order from final order.
    // Skip for explicit grid placement — those use gridColumn/gridRow, not order.
    // Visual order captured here is reused below for `originalChildIndices`
    // so dragging a child whose JSX position differs from its visual rank
    // (because a previous drag committed `style.order` to swap them) starts
    // from the correct index — without this the placeholder pops to the
    // child's JSX position instead of where the user grabbed it.
    let visualOrderIds: string[] | null = null;
    if (!this.isExplicitGridPlacement) {
      const parentNode = getNodeFromCache(parentId);
      if (parentNode) {
        // Get layout children (exclude absolute/fixed, canvas nodes, layout:: IDs)
        const layoutChildIds = this.getLayoutChildIds(parentId);

        // Read inline `order` straight from the NodeMap (parsed JSX). The
        // bridge's computed cache only has properties that were prefetched
        // or emitted via computedUpdate after a patchStyles — `order` isn't
        // in that set, so findNodeComputedStyle('order') would commonly
        // return '' for previously-reordered children, falling back to 0
        // and giving the wrong drag-start index.
        //
        // REPLICA OVERRIDE: on a non-primary viewport, the @media rule's
        // `order` wins at render time but never makes it into the inline
        // style. Without consulting the container-override store, drag
        // start sees the PRIMARY's order layout (and so picks the wrong
        // visual rank for the dragged element on this viewport — bug
        // report: "yellow at end on tablet, placeholder jumps to middle
        // instantly"). Look up the override for this viewport's max-width
        // first; fall back to inline when there's no override.
        // Defensive read — tests mock parts of the jotai graph and the
        // codeAtom dependency may be unstubbed there. Falling back to
        // inline-only order on parse failure is the same baseline the
        // pre-fix code used, so this can't be worse than before.
        let overridesForReplica: ContainerOverrideMap | null = null;
        if (!isPrimaryViewport(startVpId)) {
          try {
            overridesForReplica = getDefaultStore().get(containerOverridesAtom);
          } catch {
            overridesForReplica = null;
          }
        }
        const vpWidthForReplica = overridesForReplica
          ? (getViewportWidths()[startVpId] ?? 0)
          : 0;
        // Component master replica (non-primary variant): the per-variant
        // order lives in `conditionalStyles.order` as a parsed ternary
        // (`order: variant === 'variant-1' ? 1 : 0` → `{ 'variant-1':
        // '1', default: '0' }`). The cached `styles.order` holds only the
        // DEFAULT branch (always 0 in practice), so the legacy read fell
        // back to 0 for every child on the variant — neutralize-order
        // then SWAPPED siblings to match the (wrong) "all zero, sort by
        // JSX" order at the moment the drag started. Visible symptom:
        // grabbing pink on a variant tile instantly reorders green/
        // orange before the user moves the cursor at all.
        const isComponentFile = isComponentFilePath(getActiveFilePath());
        const conditionalVariantName = isComponentFile && !isPrimaryViewport(startVpId)
          ? startVpId
          : null;
        const readOrder = (id: string): number => {
          if (overridesForReplica && vpWidthForReplica > 0) {
            const overrideRaw = getOverrideValue(overridesForReplica, id, 'order', vpWidthForReplica);
            if (overrideRaw != null) {
              const n = parseInt(String(overrideRaw), 10);
              if (!isNaN(n)) return n;
            }
          }
          const cn = getNodeFromCache(id);
          if (conditionalVariantName && cn?.conditionalStyles) {
            const orderBranches = cn.conditionalStyles.order;
            if (orderBranches) {
              const branch = orderBranches[conditionalVariantName] ?? orderBranches.default;
              if (branch != null) {
                const n = parseInt(String(branch), 10);
                if (!isNaN(n)) return n;
              }
            }
          }
          const raw = cn?.styles?.order;
          if (typeof raw === 'string' || typeof raw === 'number') {
            const n = parseInt(String(raw), 10);
            if (!isNaN(n)) return n;
          }
          return 0;
        };

        // Capture original order values BEFORE neutralization (for cancel restore)
        for (const childId of layoutChildIds) {
          this.originalOrderValues.set(childId, String(readOrder(childId)));
        }

        // Sort by inline order. Stable secondary sort by JSX index so
        // children with the same order value keep their relative position.
        const jsxIndex = new Map(layoutChildIds.map((id, i) => [id, i]));
        const sorted = [...layoutChildIds].sort((a, b) => {
          const aOrder = readOrder(a);
          const bOrder = readOrder(b);
          if (aOrder !== bOrder) return aOrder - bOrder;
          return (jsxIndex.get(a) ?? 0) - (jsxIndex.get(b) ?? 0);
        });
        visualOrderIds = sorted;

        // Assign each sibling a SPACED integer order matching its current visual
        // rank: 0, 10, 20, 30, ... The gap of 10 leaves room for the placeholder
        // to slot between any two siblings during drag (e.g., placeholder.order
        // = 15 puts it between rank-1 (order=10) and rank-2 (order=20)) without
        // having to renumber siblings every move.
        //
        // Crucially, this preserves the user's pre-drag visual layout — the
        // OLD behavior of patching everyone to order=0 collapsed the visual
        // rank back to JSX order, causing the layout to visually shuffle the
        // moment the drag started. Now the visible positions stay where the
        // user left them; the placeholder takes the dragged element's slot.
        //
        // Use patchMultipleStyles (single Comlink call) so the iframe applies
        // every order change atomically and doesn't emit per-element
        // rectUpdates with intermediate-state rects in between.
        const bridgeForNeutralize = getCanvasBridge();
        const rankAssignments = sorted.map((childId, rank) => ({
          nodeId: childId,
          vpPrefix,
          styles: { order: String(rankToOrder(rank)) },
          important: true,
        }));

        // TEMPLATED PAGE: the merged root also holds the template's LOCKED
        // `layout::` sections (a fixed Header before the {children} content, CTA/
        // Footer after). They carry no `order`, so the spaced ranks above
        // collide with them at 0 and the template chrome reverses/jumps to the
        // top the moment the drag starts. Bracket the ones AFTER the page
        // content with a high order so they stay last for the drag; a fixed
        // Header before it is out of flow. Cleared on cleanup + on drop.
        //
        // SAME BATCH as the rank stamps — the bracket used to go in a SECOND
        // patchMultipleStyles, and the sandbox painted between the two
        // messages: in that frame the not-yet-bracketed footer (order '' = 0)
        // sorted ABOVE every ×10-stamped section, so the whole page flashed
        // scrambled the instant a drag started (trace 2026-07-28). One
        // message = one sandbox task = atomic.
        this.bracketedLayoutSectionIds.clear();
        this.bracketedChromePrevOrders.clear();
        const mergedKids = parentNode.children;
        const firstPageDom = mergedKids.findIndex(id => layoutChildIds.includes(id));
        if (firstPageDom >= 0) {
          for (const { id, i } of mergedKids.map((mid, mi) => ({ id: mid, i: mi }))) {
            if (id.startsWith('layout::') && i > firstPageDom) {
              this.bracketedLayoutSectionIds.add(id);
              this.bracketedChromePrevOrders.set(id, getNodeFromCache(id)?.styles?.order ?? '');
              rankAssignments.push({ nodeId: id, vpPrefix, styles: { order: '1000000' }, important: true });
            }
          }
          if (this.bracketedLayoutSectionIds.size > 0) {
            trace.action('layout-lifted:templated-page-bracket', { bracketed: [...this.bracketedLayoutSectionIds] });
          }
        }

        if ('patchMultipleStyles' in bridgeForNeutralize) {
          (bridgeForNeutralize as PostMessageBridge).patchMultipleStyles(rankAssignments);
        } else {
          for (const a of rankAssignments) {
            patchNodeStyles(context.contentEl, a.nodeId, a.vpPrefix, a.styles, true);
          }
        }
        trace.action('layout-lifted:neutralize-order', {
          childCount: sorted.length,
          jsxOrder: layoutChildIds,
          visualOrder: sorted,
          rankAssignments: rankAssignments.map(a => ({ id: a.nodeId, order: a.styles.order })),
          inlineOrders: layoutChildIds.map(id => ({ id, order: getNodeFromCache(id)?.styles?.order ?? '' })),
        });
      }
    }

    // Find the top-level viewport/root ancestor — exit detection uses THIS, not the direct parent.
    // Walk up the NodeMap parent chain to find a viewport root.
    this.viewportNodeId = this.findViewportAncestorId(parentId);

    trace.action('layout-lifted:start', {
      parentId: this.parentNodeId,
      viewportId: this.viewportNodeId || 'content-root',
      flexDirection: this.flexDirection,
      nodeCount: draggedNodes.length,
    });

    // THREE-PASS APPROACH:
    // 1. Measure all positions + snapshot styles BEFORE any changes
    // 2. Create grouped placeholders at primary's position (replacing all dragged nodes)
    // 3. Lift all nodes using pre-measured positions
    //
    // This prevents placeholders from shifting element positions before measurement.

    // Get iframe offset for canvas-absolute coordinate conversion
    const iframeOffset = getIframeOffset();

    // Pass 1: Measure positions and snapshot styles from NodeMap + bridge rects (no DOM mutations)
    const measurements = new Map<string, { left: number; top: number; width: number; height: number }>();

    // Record full child order. Prefer the visual order captured pre-
    // neutralization (computed `style.order`) over the raw NodeMap order:
    // after a previous reorder the JSX position and visual rank diverge,
    // and the user grabs by what they SEE. Falls back to NodeMap order for
    // explicit-grid parents where `style.order` doesn't apply.
    const parentNode = getNodeFromCache(parentId);
    const jsxChildIds = parentNode ? parentNode.children.filter(id => {
      if (id.startsWith('layout::')) return false;
      const cn = getNodeFromCache(id);
      return cn && !cn.isCanvasNode;
    }) : [];
    const allChildIds = visualOrderIds ?? jsxChildIds;
    this.originalChildOrder = allChildIds;

    for (let idx = 0; idx < allChildIds.length; idx++) {
      const childId = allChildIds[idx];
      // Record original child index (for preserving relative order on drop)
      this.originalChildIndices.set(childId, idx);
    }

    for (const node of draggedNodes) {
      // Snapshot original styles from NodeMap
      const nodeData = getNodeFromCache(node.id);
      const ns = nodeData?.styles || {};
      this.originalStyles.set(node.id, {
        display: ns.display || '',
        position: ns.position || '',
        left: ns.left || '',
        top: ns.top || '',
        width: ns.width || '',
        height: ns.height || '',
        zIndex: ns.zIndex || '',
        flex: ns.flex || '',
        flexShrink: ns.flexShrink || '',
        flexGrow: ns.flexGrow || '',
        flexBasis: ns.flexBasis || '',
        alignSelf: ns.alignSelf || '',
        margin: ns.margin || '',
        // Grid placement — preserved so it can be restored on drop
        gridColumn: ns.gridColumn || '',
        gridRow: ns.gridRow || '',
        gridArea: ns.gridArea || '',
        // Box constraints — neutralized during the lift (see liftStyles) and
        // restored on drop via boxConstraintRestore().
        maxWidth: ns.maxWidth || '',
        maxHeight: ns.maxHeight || '',
        minWidth: ns.minWidth || '',
        minHeight: ns.minHeight || '',
      });

      // Measure dimensions from bridge rect
      const nodeRect = findNodeRect(node.id, startVpId);
      if (!nodeRect) {
        trace.action('layout-lifted:skip-no-rect', { nodeId: node.id });
        continue;
      }

      // Width / height come from the element's COMPUTED CSS box, NOT from
      // the screen AABB. The AABB bakes in the element's own transform —
      // for a rotated element the AABB is √2× larger than the CSS box; for
      // a `transform: scale(2)` element the AABB is exactly 2× larger.
      // Committing the AABB as `width`/`height` on lift would inflate the
      // layout box AND keep the element's transform on top, doubling the
      // visible size the moment the user starts a layout drag.
      const computed = findNodeComputedStyles(node.id, startVpId, ['width', 'height']);
      const computedW = parseFloat(computed.width);
      const computedH = parseFloat(computed.height);
      const cssWidth = Number.isFinite(computedW) && computedW > 0
        ? computedW
        : nodeRect.width / transform.scale;
      const cssHeight = Number.isFinite(computedH) && computedH > 0
        ? computedH
        : nodeRect.height / transform.scale;

      // Canvas-absolute position: convert AABB top-left to canvas-space and
      // shift inward by half the (aabbW - cssW) so the layout box's center
      // lands at the AABB center. Same `exitToCanvasRoot` formula used on
      // strategy exit — keeps the visual center stable for rotated/scaled
      // elements when the layout box is smaller than the AABB.
      const aabbLeft = (nodeRect.left - iframeOffset.x - transform.x) / transform.scale;
      const aabbTop = (nodeRect.top - iframeOffset.y - transform.y) / transform.scale;
      const aabbW = nodeRect.width / transform.scale;
      const aabbH = nodeRect.height / transform.scale;
      const canvasLeft = aabbLeft + (aabbW - cssWidth) / 2;
      const canvasTop = aabbTop + (aabbH - cssHeight) / 2;

      measurements.set(node.id, {
        left: canvasLeft,
        top: canvasTop,
        width: cssWidth,
        height: cssHeight,
      });

      // Record insert index of the primary node.
      //
      // INDEX SPACE: `currentInsertIndex` lives in the VISIBLE-sibling space —
      // the list `calculateReorderIndex` walks and `movePlaceholders` splices
      // (`getLayoutSiblingRects`, which drops zero-size/hidden flow children).
      // The full-child rank (`originalChildIndices`) also counts INVISIBLE
      // flow children (e.g. an empty zero-size frame from a Figma import), so
      // seeding from it started the drag one slot too high per invisible
      // child before the dragged: "drop after the last section" then compared
      // EQUAL to the start index and the reorder never fired (the
      // Footer-to-end no-op), and every other drop was one slot off.
      if (node.id === primary.id) {
        const fullRank = this.originalChildIndices.get(node.id) ?? 0;
        const visibleSibs = this.getLayoutSiblingRects(new Set(draggedNodes.map(n => n.id)));
        // Cold rect cache (no visible siblings measurable) → fall back to the
        // full-space rank; the siblingRectsReady gate keeps early moves sane.
        const childIdx = visibleSibs.length > 0
          ? visibleSibs.filter(s =>
              (this.originalChildIndices.get(s.id) ?? Number.MAX_SAFE_INTEGER) < fullRank,
            ).length
          : fullRank;
        this.currentInsertIndex = childIdx;
        this.dragStartInsertIndex = childIdx;
        const pl = this.liftedPositions.get(node.id);
        // flexDirection may not be assigned yet on this path — leave 0 and
        // let the lazy capture in calculateReorderIndex derive it with the
        // axis known.
        this.draggedFlowSize = pl && this.flexDirection
          ? (this.flexDirection === 'column' ? pl.height : pl.width)
          : 0;
      }
    }

    // Pass 2: Create placeholders via bridge.
    // All placeholders are grouped at the primary's position.
    const bridge = getCanvasBridge();

    // LIVE-SIZE CORRECTION reads — sent BEFORE any placeholder/lift mutation,
    // so postMessage FIFO guarantees they measure the PRE-lift live DOM. The
    // lift sizes come from the rect/computed CACHES, which can be STALE for a
    // section deep down the page (offscreen-section replay serves remembered
    // geometry): a component instance measuring 657px live was lifted and
    // placeholdered at a cached 418px, visibly collapsing it for the rest of
    // the session — the live site and a page-switch rebuild were fine, only
    // the canvas kept the stale height (user report 2026-07-27). When the
    // read returns mid-drag we correct the lifted element + placeholder +
    // the reorder model. Rotated/scaled elements are skipped: getRectAsync
    // returns the AABB, which is bigger than the CSS box the lift needs.
    const liveSizeReads = new Map<string, Promise<DOMRect | null>>();
    if ('getRectAsync' in bridge) {
      for (const node of draggedNodes) {
        const ns0 = getNodeFromCache(node.id)?.styles ?? {};
        if (ns0.transform || ns0.rotate) continue;
        liveSizeReads.set(
          node.id,
          (bridge as PostMessageBridge).getRectAsync(node.id, vpPrefix).catch(() => null),
        );
      }
    }
    const primaryIdx = this.originalChildIndices.get(primary.id) ?? 0;
    // Find the node ID that comes AFTER the primary in the child list (for insertBefore)
    const childIdsAfterPrimary = allChildIds.slice(primaryIdx + 1);
    const beforeNodeId = childIdsAfterPrimary.find(id => !draggedNodes.some(n => n.id === id)) || null;

    for (const node of draggedNodes) {
      const nodeRect = findNodeRect(node.id, startVpId);
      if (!nodeRect) continue;
      const nodeData = getNodeFromCache(node.id);
      const ns = nodeData?.styles || {};

      // Placeholder fills the LAYOUT slot the dragged element was using —
      // that's the CSS box (offsetWidth-equivalent), NOT the screen AABB.
      // For a rotated/scaled element the AABB is bigger than the layout
      // slot, so using AABB here puffed the placeholder up and pushed
      // siblings around. Reuse the cssWidth/cssHeight we already computed
      // for `measurements`; fall back to AABB-divided-by-zoom if missing.
      const measured = measurements.get(node.id);
      const phComputed = measured ? null : findNodeComputedStyles(node.id, startVpId, ['width', 'height']);
      const phComputedW = phComputed ? parseFloat(phComputed.width) : NaN;
      const phComputedH = phComputed ? parseFloat(phComputed.height) : NaN;
      // A ZERO measurement is a failed measurement, not a size — `??` let 0
      // through and styled the placeholder 0px tall: no hole on screen, so
      // the reorder model (which assumes a dragged-sized hole at the slot)
      // dead-zoned the whole downward direction (trace-diagnosed 2026-07-23).
      const posSize = (v: number | undefined): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
      let phWidthPx = posSize(measured?.width)
        ?? posSize(phComputedW)
        ?? posSize(nodeRect.width / transform.scale)
        ?? posSize(this.liftedPositions.get(node.id)?.width)
        ?? 0;
      let phHeightPx = posSize(measured?.height)
        ?? posSize(phComputedH)
        ?? posSize(nodeRect.height / transform.scale)
        ?? posSize(this.liftedPositions.get(node.id)?.height)
        ?? 0;
      // Placeholder is ALWAYS the dragged element's exact size — with live
      // rects (placeholder mutations re-emit the parent scope) the hit-test
      // tracks the real hole, so no compact-band workaround is needed.
      if (node.id === primary.id) {
        this.draggedFlowSize = this.flexDirection === 'column' ? phHeightPx : phWidthPx;
      }
      trace.action('layout-lifted:placeholder-size', {
        nodeId: node.id, phWidthPx: Math.round(phWidthPx), phHeightPx: Math.round(phHeightPx),
        measured: measured ? { w: measured.width, h: measured.height } : null,
      });

      const phId = `ph-${node.id}`;
      this.placeholderIds.add(phId);
      this.nodeToPlaceholderId.set(node.id, phId);

      // Match the dragged element's spaced rank order so the placeholder
      // visually replaces the lifted element 1:1. See order-positioning.ts
      // for the spaced-rank scheme — rankToOrder(N) here matches the rank
      // assignments produced by neutralize-order above.
      const draggedRank = this.originalChildIndices.get(node.id) ?? 0;
      const phOrder = String(rankToOrder(draggedRank));

      const phStyles: Record<string, string> = {
        width: `${phWidthPx}px`,
        height: `${phHeightPx}px`,
        // Paint ABOVE absolute overlays (e.g. a 100%×100% GradientAura code
        // component at z-index:0). A positioned element outpaints a static-flow
        // placeholder regardless of DOM order, so without this the reorder gap
        // vanished behind the aura (visible only once the aura was deleted).
        // position:relative + a high z keeps the placeholder in flow but on top.
        position: 'relative',
        zIndex: '9999',
        backgroundColor: PLACEHOLDER_BG,
        borderRadius: PLACEHOLDER_RADIUS,
        transition: PLACEHOLDER_TRANSITION,
        flexShrink: '0',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        order: phOrder,
        // Preserve flex properties
        ...(ns.flexGrow ? { flexGrow: ns.flexGrow } : {}),
        ...(ns.flexBasis ? { flexBasis: ns.flexBasis } : {}),
        ...(ns.margin ? { margin: ns.margin } : {}),
        ...(ns.alignSelf ? { alignSelf: ns.alignSelf } : {}),
        // Preserve grid placement (spans, areas) so placeholder occupies correct grid cells
        ...(ns.gridColumn ? { gridColumn: ns.gridColumn } : {}),
        ...(ns.gridRow ? { gridRow: ns.gridRow } : {}),
        ...(ns.gridArea ? { gridArea: ns.gridArea } : {}),
      };

      if ('createPlaceholder' in bridge) {
        (bridge as PostMessageBridge).createPlaceholder(phId, parentId, vpPrefix, beforeNodeId, phStyles);
      }

      // Snapshot the placeholder's recreation args for the alt-duplicate
      // swap (placeholder hides → duplicate fills the slot → on alt-up
      // the placeholder is recreated identically). Keyed by the dragged
      // node ID so the coordinator can look up by source ID.
      this.placeholderSpecs.set(node.id, {
        placeholderId: phId,
        parentId,
        vpPrefix,
        beforeNodeId,
        styles: phStyles,
      });
    }

    // Pass 3: Lift all nodes using pre-measured positions via bridge.liftNode
    for (const node of draggedNodes) {
      const measured = measurements.get(node.id);
      if (!measured) continue;

      this.liftedPositions.set(node.id, measured);

      const liftStyles: Record<string, string> = {
        position: 'absolute',
        left: `${measured.left}px`,
        top: `${measured.top}px`,
        width: `${measured.width}px`,
        height: `${measured.height}px`,
        zIndex: '9999',
        pointerEvents: 'none',
        flex: '',
        flexShrink: '',
        flexGrow: '',
        flexBasis: '',
        // Clear grid placement so element flows outside grid
        gridColumn: '',
        gridRow: '',
        gridArea: '',
        // Neutralize box constraints for the drag overlay: the lift reparents
        // the node to contentRoot, where a PERCENTAGE maxWidth/maxHeight
        // resolves against a zero-size containing block and collapses the
        // overlay to 0px (live find 2026-07-17: icon with maxWidth: '100%'
        // dragged invisibly). The measured px width/height above are the
        // stable size; min/max must not fight them mid-drag.
        maxWidth: 'none',
        maxHeight: 'none',
        minWidth: '0px',
        minHeight: '0px',
      };

      if ('liftNode' in bridge) {
        (bridge as PostMessageBridge).liftNode(node.id, vpPrefix, liftStyles);
      } else {
        // Direct mode fallback: patch styles via bridge
        patchNodeStyles(context.contentEl, node.id, vpPrefix, liftStyles);
      }
    }

    // Apply the live-size corrections as the pre-lift reads resolve (see the
    // read block above). Guarded by the drag-session token so a resolve after
    // mouseup/cancel touches nothing.
    {
      const session = this.dragSession;
      const scale = transform.scale || 1;
      for (const [nodeId, read] of liveSizeReads) {
        read.then((live) => {
          if (this.dragSession !== session) return;         // drag ended
          if (!live || !(live.width > 0) || !(live.height > 0)) return;
          const pos = this.liftedPositions.get(nodeId);
          if (!pos) return;
          const liveW = live.width / scale;
          const liveH = live.height / scale;
          if (Math.abs(liveW - pos.width) < 1 && Math.abs(liveH - pos.height) < 1) return;
          trace.action('layout-lifted:live-size-correct', {
            nodeId, from: { w: Math.round(pos.width), h: Math.round(pos.height) },
            to: { w: Math.round(liveW), h: Math.round(liveH) },
          });
          pos.width = liveW;
          pos.height = liveH;
          if (nodeId === primary.id) {
            this.draggedFlowSize = this.flexDirection === 'column' ? liveH : liveW;
          }
          const sizePatch = { width: `${Math.round(liveW)}px`, height: `${Math.round(liveH)}px` };
          patchNodeStyles(context.contentEl, nodeId, vpPrefix, sizePatch);
          const phId = this.nodeToPlaceholderId.get(nodeId);
          if (phId && 'patchPlaceholderStyles' in bridge) {
            (bridge as PostMessageBridge).patchPlaceholderStyles(phId, vpPrefix, sizePatch);
          }
        });
      }
    }

    // Lock the lifted nodes AND every visible sibling from patchElement
    // style application. Two reasons:
    //
    //  • Lifted nodes need their `position: absolute` + `zIndex: 9999` to
    //    survive mid-drag force-renders. Without the lock, patchElement
    //    re-applies source styles (which usually have `position:
    //    relative`) and the dragged overlay snaps into flex flow.
    //
    //  • Visible siblings need their neutralized `order: N !important`
    //    (set in the `patchMultipleStyles` block above) to survive
    //    mid-drag force-renders. CSSOM `el.style.order = '1'` REMOVES
    //    any prior `!important`, so without locking, patchElement
    //    reverts every sibling to their SEQUENTIAL source order — the
    //    spaced-rank gap collapses, `pickPlaceholderOrder` can't find
    //    integer midpoints, and the placeholder lands wrong / on top
    //    of an existing sibling.
    //
    // Cleared in `cleanup()`. Bridge call is fire-and-forget; the iframe
    // applies it before processing any subsequent `render` message.
    const visibleSiblingIds = visualOrderIds ?? jsxChildIds;
    const allLockedIds: string[] = [
      ...draggedNodes.map(n => n.id),
      ...visibleSiblingIds.filter(id => !draggedNodes.some(d => d.id === id)),
    ];
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds(allLockedIds);
    }

    // CMS collection list: collapse the DOM-only ghost copies ONLY while the
    // dragged node IS a collection ITEM (the data-index-0 template node) — so
    // that one item drags cleanly without the repeated rows. Dragging a child
    // INSIDE the item, or any sibling node, must leave the list intact, so this
    // checks the DIRECT parent (the `collectionList` container) and that the
    // dragged node is one of its template nodes — NOT an ancestor walk.
    this.hiddenGhostsContainerId = null;
    const ghostParent = getNodeFromCache(parentId);
    if (
      ghostParent?.collectionList &&
      Object.values(ghostParent.collectionList.templateIds).includes(draggedNodes[0]?.id ?? '')
    ) {
      this.hiddenGhostsContainerId = parentId;
    }
    if (this.hiddenGhostsContainerId && 'setCollectionGhostsHidden' in bridge) {
      this.hiddenGhostsVpPrefix = vpPrefix;
      (bridge as PostMessageBridge).setCollectionGhostsHidden(this.hiddenGhostsContainerId, vpPrefix, true);
    }

    // Was this drag anywhere inside a collection-list row? Walk the ANCESTORS
    // (the check above is direct-parent-only, for dragging the row itself).
    // Drives the forced ghost rebuild in cleanup — see the field doc.
    this.draggedInsideCollectionRow = false;
    for (let cur = getNodeFromCache(parentId), i = 0; cur && i < 50; i++) {
      if (cur.collectionList) { this.draggedInsideCollectionRow = true; break; }
      cur = cur.parentId ? getNodeFromCache(cur.parentId) : undefined;
    }

    // Freeze sibling positions for grid parents (placeholder reflow shifts grid items).
    // Flex/block uses live rects — DOM insertBefore keeps layout consistent.
    this.frozenParentRect = null;
    if (this.isGridParent) {
      this.frozenParentRect = findNodeRect(parentId, startVpId) ?? null;
      this.originalSiblingRects = this.getLayoutSiblingRects(
        new Set(draggedNodes.map(n => n.id))
      );
    }

    // Refresh sibling rects post-lift. The lift patch shifts every sibling
    // visually (the gap closes around the now-absolute element) but the
    // bridge rectCache only refreshes on the next allRects emit. For flex/
    // block parents that's roughly one render cycle later — which is too
    // late, onMove fires within ~16ms with stale rects and computes the
    // wrong reorder index. Especially noticeable right after a previous
    // reorder commit when the cache is already holding pre-render rects.
    // Skip for grid parents (they use frozen rects captured above).
    if (!this.isGridParent && 'prefetchChildRects' in bridge) {
      this.siblingRectsReady = false;
      (bridge as PostMessageBridge).prefetchChildRects(parentId, vpPrefix)
        .then(() => {
          this.siblingRectsReady = true;
          trace.action('layout-lifted:sibling-rects-refreshed', { parentId });
        })
        .catch(() => {
          // Bridge round-trip failed — fall back to using whatever's in cache.
          // The strategy's hysteresis check will filter out spurious moves.
          this.siblingRectsReady = true;
        });
    } else {
      this.siblingRectsReady = true;
    }

    trace.action('layout-lifted:lifted', {
      positions: Object.fromEntries(this.liftedPositions),
      insertIndex: this.currentInsertIndex,
      isExplicitGrid: this.isExplicitGridPlacement,
    });
  }

  onMove(context: DragContext, mouseScreen: Point): DragMoveResult {
    const { draggedNodes, startMouse, transform } = context;
    const vpId = vpIdFromPrefix(context.viewportPrefix);
    const vpPrefix = getViewportPrefix(vpId);
    const gripAxis = context.gripAxis ?? null;

    // Canvas-space delta
    const screenDx = mouseScreen.x - startMouse.x;
    const screenDy = mouseScreen.y - startMouse.y;
    const delta = getCanvasDelta(screenDx, screenDy, transform.scale);

    // Grip axis constraint: lock the non-grip axis
    if (gripAxis === 'x') {
      delta.y = 0;
    } else if (gripAxis === 'y') {
      delta.x = 0;
    }

    // (Mouse direction tracking removed — reorder is now pure cursor-
    // position via midpoint check. No hysteresis, no velocity gates.
    // Whatever sibling/gap the cursor is over IS where the placeholder
    // goes, every frame.)

    // Grip mode: clamp the dragged element so it can NEVER leave the parent's
    // bounds, even if the mouse goes far off. Reorder still happens (mouse
    // crosses sibling midpoints), but visually the element stays trapped inside
    // its flex parent — same UX as the old builder grip.
    if (gripAxis && this.parentNodeId) {
      const primaryLifted = this.liftedPositions.get(draggedNodes[0].id);
      if (primaryLifted) {
        const parentCanvasRect = getAbsoluteCanvasRectById(this.parentNodeId, vpId, transform);
        if (parentCanvasRect) {
          const minLeft = parentCanvasRect.left;
          const maxLeft = parentCanvasRect.left + parentCanvasRect.width - primaryLifted.width;
          const minTop = parentCanvasRect.top;
          const maxTop = parentCanvasRect.top + parentCanvasRect.height - primaryLifted.height;
          const desiredLeft = primaryLifted.left + delta.x;
          const desiredTop = primaryLifted.top + delta.y;
          const clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
          const clampedTop = Math.max(minTop, Math.min(maxTop, desiredTop));
          delta.x = clampedLeft - primaryLifted.left;
          delta.y = clampedTop - primaryLifted.top;
        }
      }
    }

    // ── Off-parent canvas snap — pre-patch ──────────────────────────────
    // When the cursor is on the canvas (out of the source viewport),
    // run canvas-style snap and FOLD its result into the lift patch
    // below. CRITICAL: compute the dragged rect from `lifted + delta`
    // (cursor-driven values), NOT from `findNodeRect` (DOM read).
    // Reading the DOM creates a feedback loop — last tick's snap-locked
    // position is what `findNodeRect` returns, so calculateSnap sees a
    // rect already at the snap target and fires snap again with the
    // same value, but the lift's `lifted + delta` produces a different
    // value, and the two writes oscillate (visible as freeze / jitter).
    // Using `lifted + delta` makes snap a pure function of cursor
    // movement: same cursor → same snap, no DOM read involved, single
    // write per tick.
    let canvasSnap: ReturnType<typeof calculateSnap> | null = null;
    let snapPrimaryLifted: { left: number; top: number } | null = null;
    if (!gripAxis) {
      // Determine off-parent state inline (don't wait for the
      // exit/re-entry block below — it runs AFTER the patch).
      const viewportScreenRect = this.getViewportScreenRect();
      const cursorOffParent = !!viewportScreenRect && !isInsideRect(mouseScreen, viewportScreenRect);
      if (cursorOffParent) {
        const primary = draggedNodes[0];
        const primaryLifted = this.liftedPositions.get(primary.id);
        if (primaryLifted) {
          const draggedSet = new Set(draggedNodes.map(n => n.id));
          const draggedRect: Rect = {
            left: primaryLifted.left + delta.x,
            top: primaryLifted.top + delta.y,
            width: primaryLifted.width,
            height: primaryLifted.height,
          };
          const bridge = getCanvasBridge();
          const iframeOffset = getIframeOffset();
          const siblingRects: Array<{ id: string; rect: Rect }> = [];
          const cache = 'rectCache' in bridge ? (bridge as { rectCache: Map<string, DOMRect> }).rectCache : null;
          if (cache) {
            for (const [key] of cache) {
              const { vpPrefix: prefix, nodeId: dataId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
              if (!dataId || draggedSet.has(dataId)) continue;
              const otherNode = context.nodes.get(dataId);
              if (!otherNode) continue;
              if (otherNode.parentId && dataId !== 'root') continue;
              const screenRect = bridge.getRect(dataId, prefix);
              if (!screenRect) continue;
              siblingRects.push({
                id: prefix ? `${prefix}${dataId}` : dataId,
                rect: {
                  left: (screenRect.left - iframeOffset.x - transform.x) / transform.scale,
                  top: (screenRect.top - iframeOffset.y - transform.y) / transform.scale,
                  width: screenRect.width / transform.scale,
                  height: screenRect.height / transform.scale,
                },
              });
            }
          }
          const velocity = getMouseVelocity(this.prevMouse, mouseScreen);
          canvasSnap = calculateSnap(
            draggedRect,
            siblingRects,
            velocity,
            SNAP_THRESHOLD / transform.scale,
            undefined,
            undefined,
            getActiveRulerGuideSnapLines(),
          );
          snapPrimaryLifted = { left: primaryLifted.left, top: primaryLifted.top };
        }
      }
    }

    // Move all lifted nodes via bridge — fold snap into the inline write.
    // Per-node offset = (node.lifted - primary.lifted) so multi-select
    // preserves relative geometry while primary locks to the snap line.
    for (const node of draggedNodes) {
      const lifted = this.liftedPositions.get(node.id);
      if (!lifted) continue;

      let finalLeft = lifted.left + delta.x;
      let finalTop = lifted.top + delta.y;
      if (canvasSnap && snapPrimaryLifted) {
        if (canvasSnap.snappedX) {
          finalLeft = canvasSnap.x + (lifted.left - snapPrimaryLifted.left);
        }
        if (canvasSnap.snappedY) {
          finalTop = canvasSnap.y + (lifted.top - snapPrimaryLifted.top);
        }
      }
      patchNodeStyles(context.contentEl, node.id, vpPrefix, {
        left: `${Math.round(finalLeft)}px`,
        top: `${Math.round(finalTop)}px`,
      });
    }

    // Grip mode: parent-exit detection is disabled. The clamp above guarantees
    // the element stays inside the parent, so we always treat ourselves as "over
    // parent" — placeholders stay visible, drop line keeps tracking reorder.
    if (gripAxis) {
      if (!this.isOverParent) {
        this.showPlaceholders(context);
        this.isOverParent = true;
      }
    } else {
      // Exit detection uses the TOP-LEVEL VIEWPORT ANCESTOR rect, not the
      // direct layout parent. While the cursor is anywhere within the
      // viewport hierarchy (over an ancestor of the original layout, over a
      // sibling section, etc.) the dragged element should remain "lifted"
      // into its source layout — the placeholder stays where it would slot
      // back in. Only when the cursor reaches the actual canvas (outside any
      // viewport) does the user truly mean to detach. Same intent as canvas-
      // node drag: stay parented until the cursor leaves all viewports.
      const viewportScreenRect = this.getViewportScreenRect();
      if (!viewportScreenRect) {
        // COLD-RECT EARLY-OUT: the viewport root's rect isn't in the bridge
        // cache yet (typical on the very FIRST drag after page load, before the
        // first allRects emit). Returning here every frame = "no detection on
        // first drag, works on the second". Trace it so the gate is visible.
        trace.action('layout-lifted:onmove-no-viewport-rect', {
          viewportNodeId: this.viewportNodeId, parentNodeId: this.parentNodeId, vpId: this.currentVpId,
        });
        this.prevMouse = mouseScreen;
        return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
      }

      const isNowOverParent = isInsideRect(mouseScreen, viewportScreenRect);

      // Handle parent exit / re-entry. Stay in layout-lifted mode while
      // off-parent so re-entering the original parent's hierarchy during
      // the SAME drag re-injects placeholders and resumes reorder. The
      // commit-to-canvas + strategy switch only fires when the cursor
      // actually enters a DIFFERENT parent on the canvas (handled below
      // via hit-test). Without this gate, dragging out and back in would
      // commit prematurely and break the round-trip — the user's
      // explicit request: "drag back to parent should still be active
      // if during same drag I go back to the full hierarchy".
      if (this.isOverParent && !isNowOverParent) {
        // EXITING viewport → hide placeholders + drop line + parent highlight
        this.hidePlaceholders();
        dropLineOps.hide();
        parentHighlightOps.hide();
        this.isOverParent = false;
        trace.action('layout-lifted:exit-parent');
      } else if (!this.isOverParent && isNowOverParent) {
        // RE-ENTERING viewport → show placeholders
        this.showPlaceholders(context);
        this.isOverParent = true;
        trace.action('layout-lifted:reenter-parent');
      }

      // Off-parent + cursor over a DIFFERENT frame on the canvas →
      // commit move-to-canvas now and switch to CanvasDragStrategy so
      // the user gets canvas/absolute-in-frame entry behavior into the
      // new parent. The original parent's hierarchy is reachable via the
      // re-entry branch above; only when the user actually picks a new
      // parent do we break the back-to-parent round-trip. Without this,
      // moving the dragged element over (e.g.) a sibling no-layout frame
      // would never show drop-line / parent-highlight for the new
      // target, and on mouseup the element would land at canvas root
      // instead of inside the new frame.
      // Icon-set masters: only block the mid-drag strategy switch when the
      // dragged element is a VECTOR CONTAINER (parented to master root).
      // Shapes inside vectors should be free to exit their vector mid-drag
      // and land on canvas / a sibling vector via the regular flow.
      // The variant card is the unit of position, and its position lives
      // in the iconConfig array, never on the JSX inline style. Match the
      // umbrella in AbsoluteInFrameStrategy so a variant card can't
      // detach mid-drag.
      const ap = getActiveFilePath();
      const isIconSetMasterMove = ap.startsWith('icons/');
      const isVectorContainerMove = isIconSetMasterMove && this.parentNodeId === 'root';
      if (!this.isOverParent && !gripAxis && !isVectorContainerMove) {
        const hits = getNodeHitsAtPoint(mouseScreen.x, mouseScreen.y);
        const draggedSet = new Set(draggedNodes.map(n => n.id));
        // Walk hit list (smallest area first) for any frame-acceptable
        // candidate that ISN'T the original parent or its ancestors.
        const originalAncestors = new Set<string>();
        let walker: string | null = this.parentNodeId;
        while (walker) {
          originalAncestors.add(walker);
          const wn = context.nodes.get(walker);
          walker = wn?.parentId ?? null;
        }
        let foundNewParent: string | null = null;
        for (const hit of hits) {
          if (draggedSet.has(hit.id)) continue;
          if (hit.id === 'root' || hit.id.startsWith('layout::') || hit.id === 'children-slot') continue;
          if (originalAncestors.has(hit.id)) continue;
          const node = context.nodes.get(hit.id);
          if (!node) continue;
          const tag = (node as any).tag || node.type || 'div';
          if (!nodeAcceptsChildren(node)) continue;
          foundNewParent = hit.id;
          break;
        }

        if (foundNewParent) {
          // Same exit-to-canvas commit as my earlier full-exit version,
          // but gated on actually entering a different frame. After the
          // commit, CanvasDragStrategy takes over with skipRebuild +
          // canvas-space coords — its entry detection picks up the new
          // parent on the very next tick.
          dropLineOps.hide();
          parentHighlightOps.hide();
          trace.action('layout-lifted:exit-to-canvas-on-new-parent', {
            newParent: foundNewParent,
            originalParent: this.parentNodeId,
          });

          const liveIframeOffset = getIframeOffset();
          const exitVpId = vpIdFromPrefix(context.viewportPrefix);
          // On component master files exitVpId IS the source variant
          // name (e.g., 'desktop' for default, 'variant-1'). Used below
          // so `moveNodeInCode`'s strip walker resolves variant ternary
          // text into a plain string for the canvas-rooted clone.
          const exitSourceVariant = isComponentFilePath(getActiveFilePath()) ? exitVpId : undefined;
          const exitOverrides = new Map<string, { startLeft: number; startTop: number; startParentId: string | null }>();

          for (const node of draggedNodes) {
            patchNodeStyles(context.contentEl, node.id, getViewportPrefix(exitVpId), { pointerEvents: '' });
            const lifted = this.liftedPositions.get(node.id);
            const liveRect = findNodeRect(node.id, exitVpId);
            let canvasLeft = lifted ? lifted.left : 0;
            let canvasTop = lifted ? lifted.top : 0;
            if (liveRect) {
              // Shared exit math (`aabbTL + (aabb - css)/2` centre-stable
              // conversion) — keeps the visual centre fixed for rotated/
              // scaled elements and corrects the anchor under perspective.
              const cssW = lifted?.width ?? liveRect.width / transform.scale;
              const cssH = lifted?.height ?? liveRect.height / transform.scale;
              const pos = computeExitCanvasPosition(node.id, exitVpId, liveRect, transform, liveIframeOffset, cssW, cssH);
              canvasLeft = pos.canvasLeft;
              canvasTop = pos.canvasTop;
            }
            const ms: Record<string, string> = {
              position: 'absolute',
              left: `${Math.round(canvasLeft)}px`,
              top: `${Math.round(canvasTop)}px`,
            };
            if (lifted) {
              ms.width = `${Math.round(lifted.width)}px`;
              ms.height = `${Math.round(lifted.height)}px`;
            }
            commitExitToCanvas({ nodeId: node.id, styles: ms, sourceVariant: exitSourceVariant });
            exitOverrides.set(node.id, {
              startLeft: Math.round(canvasLeft),
              startTop: Math.round(canvasTop),
              startParentId: null,
            });
          }

          flushExitToCanvas();

          // Restore original `order` styles on the parent's remaining
          // siblings — the spaced-rank scheme from neutralize-on-lift is
          // only meaningful while ghost slots exist.
          if (this.parentNodeId) {
            const vpPrefix = getViewportPrefix(exitVpId);
            for (const [childId, origOrder] of this.originalOrderValues) {
              patchNodeStyles(context.contentEl, childId, vpPrefix, { order: '' });
              if (origOrder && origOrder !== '0') {
                patchNodeStyles(context.contentEl, childId, vpPrefix, { order: origOrder });
              }
            }
            this.originalOrderValues.clear();
          }
          this.removePlaceholdersViaBridge();
          // The drag continues under CanvasDragStrategy — keep the synced
          // twins in the other viewports hidden until the gesture ends.
          this.deferReplicaRestoreToDragEnd = true;
          this.cleanup();

          return {
            snap: null,
            dropTarget: null,
            highlightParentId: null,
            axisLock: gripAxis,
            switchRequest: {
              toStrategy: 'canvas',
              reason: 'layout-lifted-enter-new-parent',
              skipRebuild: true,
              nodeStateOverrides: exitOverrides,
              ...(context.viewportPrefix !== '' ? { newViewportPrefix: '' } : {}),
            },
          };
        }
      }
    }

    // If over parent, detect reorder position.
    let dropTarget = null;
    // DIAGNOSTIC: log the cheap reorder gates so a "no detection" first drag is
    // attributable — isOverParent false / no placeholders / siblingRectsReady
    // still false each produce the same dead symptom. (Sibling rects/coords are
    // logged by the reorder-coords trace inside the block — no recompute here.)
    if (this.isOverParent && this.parentNodeId) {
      trace.action('layout-lifted:onmove-reorder-gates', {
        isOverParent: this.isOverParent, placeholders: this.placeholderIds.size,
        siblingRectsReady: this.siblingRectsReady,
      });
    }
    if (this.isOverParent && this.parentNodeId && this.placeholderIds.size > 0) {
      const now = performance.now();
      // Grid parents use frozen rects — no cooldown needed (no reflow oscillation).
      // Flex uses live rects — need cooldown to prevent reflow feedback loops.
      const cooldown = this.isGridParent ? 0 : PLACEHOLDER_COOLDOWN_MS;
      const cooldownOk = cooldown === 0 || now - this.lastPlaceholderMoveTime > cooldown;

      // Skip reorder math while sibling rects are still stale post-lift —
      // see siblingRectsReady comment. The placeholder stays at the source
      // index (which IS the correct starting position) until fresh rects
      // arrive from the iframe. Without this, dragging the first child
      // sees the placeholder snap to index 1 for one frame.
      if (cooldownOk && this.siblingRectsReady) {
        // Grid: frozen rects (placeholder reflow shifts grid cells → oscillation).
        // Flex/block: live rects (DOM insertBefore keeps layout consistent with visual).
        const siblingRects = this.isGridParent
          ? this.originalSiblingRects
          : this.getLayoutSiblingRects(new Set(draggedNodes.map(n => n.id)));

        // Cursor as the reorder reference (not dragged center — see
        // earlier note about tall draggeds making the center "ahead"
        // of cursor and causing asymmetric perception).
        let reorderMouse: Point = mouseScreen;
        // Flex-wrap reorders in 2D — keep the FULL cursor (both axes) so the drop
        // target tracks which LINE the mouse is over. Locking the cross axis to the
        // grip axis (as a 1D row/column flex does, to steady the placeholder) would
        // pin the drop to the start line and is why wrap dragging "glitched".
        if (!this.isWrapParent) {
          if (gripAxis === 'x') {
            reorderMouse = { x: mouseScreen.x, y: startMouse.y };
          } else if (gripAxis === 'y') {
            reorderMouse = { x: startMouse.x, y: mouseScreen.y };
          }
        }

        // Direction-aware reorder: the placeholder should appear in
        // the direction of drag, not behind it. Going down → placeholder
        // BELOW the sibling under cursor (return i+1). Going up →
        // placeholder ABOVE the sibling (return i). Both feel "instant"
        // and "forward" — the placeholder leads, not trails.
        //
        // Direction is detected from this frame's cursor delta. When
        // delta is zero (mouse hasn't moved), reuse the previous
        // direction. Without this, "cursor inside sibling = return i"
        // felt great for upward (placeholder above cursor = ahead of
        // motion) and broken for downward (placeholder above cursor =
        // BEHIND motion, looks like nothing moved).
        const cursorDelta = this.flexDirection === 'column'
          ? reorderMouse.y - this.prevMouse.y
          : reorderMouse.x - this.prevMouse.x;
        let movingForward: boolean | null = null;
        if (cursorDelta > 0.5) movingForward = true;
        else if (cursorDelta < -0.5) movingForward = false;
        else movingForward = this.lastMovingForward;
        this.lastMovingForward = movingForward;

        // PURE CURSOR semantics (final spec): the overlay is IGNORED — the
        // hit test is literally which sibling/gap the MOUSE is over in the
        // reconstructed on-screen layout.
        const newIndex = this.calculateReorderIndex(reorderMouse, siblingRects, movingForward);

        trace.action('layout-lifted:reorder-check', {
          newIndex, currentIndex: this.currentInsertIndex,
          siblingCount: siblingRects.length,
          isGrid: this.isGridParent,
          mouseX: Math.round(reorderMouse.x), mouseY: Math.round(reorderMouse.y),
        });

        // NO hysteresis, NO velocity check, NO direction match. Pure
        // cursor-position semantics: whatever sibling/gap the cursor is
        // currently over IS where the placeholder goes, every frame.
        // `calculateReorderIndex` already uses midpoint-only (no
        // direction shortcut), so the result is stable for any given
        // cursor position — moving the mouse 1 px never flips the index
        // unless the cursor actually crossed a sibling midpoint.
        if (newIndex !== this.currentInsertIndex) {
          // Pass axis-sorted siblingRects so movePlaceholders' visual
          // ordering MATCHES calculateReorderIndex's basis.
          this.movePlaceholders(newIndex, context, siblingRects);
          this.currentInsertIndex = newIndex;
          this.lastPlaceholderMoveTime = now;

          trace.action('layout-lifted:reorder', { newIndex, gripAxis });
        }
      }

      dropTarget = {
        parentId: this.parentNodeId || '',
        index: this.currentInsertIndex,
        position: 'inside' as const,
      };

      // Over original parent — clear cross-parent target
      this.intendedParentId = null;
      this.intendedInsertIndex = -1;
    }

    // ─── Phase C: Cross-parent drop detection ───
    // When NOT over the original parent, scan for other flex/grid containers
    // Uses NodeMap + bridge rects instead of DOM querySelectorAll
    if (!this.isOverParent) {
      const draggedIds = new Set(draggedNodes.map(n => n.id));
      let bestParentId: string | null = null;
      let bestArea = Infinity;

      // Iterate NodeMap entries and use bridge rects for containment check
      for (const [candidateId, candidateNode] of context.nodes) {
        if (draggedIds.has(candidateId)) continue;
        if (candidateId === this.parentNodeId) continue;
        const tag = candidateNode.type || 'div';
        if (!nodeAcceptsChildren(candidateNode)) continue;

        // Use bridge for candidate rect
        const frameRect = findNodeRect(candidateId, vpId);
        if (!frameRect) continue;
        const frameScreenRect: Rect = { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height };

        // Check if mouse center is inside the frame
        if (!isInsideRect(mouseScreen, frameScreenRect)) continue;

        // Pick the smallest (most nested) container
        const area = frameScreenRect.width * frameScreenRect.height;
        if (area < bestArea) {
          bestArea = area;
          bestParentId = candidateId;
        }
      }

      if (bestParentId) {
        const parentLayout = detectParentLayoutById(bestParentId, vpId);
        const isLayoutParent = parentLayout === 'flex' || parentLayout === 'grid';

        let insertIdx = -1;
        if (isLayoutParent) {
          // Layout parent: calculate insertion index using bridge-compatible helper
          const dir = getFlexDirectionById(bestParentId, vpId);
          insertIdx = calculateLayoutInsertIndexById(mouseScreen, bestParentId, vpId, dir, draggedIds);
        }

        this.intendedParentId = bestParentId;
        this.intendedInsertIndex = insertIdx;

        dropTarget = {
          parentId: bestParentId,
          index: insertIdx,
          position: 'inside' as const,
        };

        trace.action('layout-lifted:cross-parent-target', {
          targetParentId: bestParentId,
          insertIndex: insertIdx,
          direction: getFlexDirectionById(bestParentId, vpId),
        });
      } else {
        // Not over any flex/grid container — clear cross-parent state
        if (this.intendedParentId) {
          dropLineOps.hide();
          parentHighlightOps.hide();
          trace.action('layout-lifted:cross-parent-cleared');
        }
        this.intendedParentId = null;
        this.intendedInsertIndex = -1;
      }
    }

    this.prevMouse = mouseScreen;

    return {
      // Snap result for guide rendering + position lock during off-parent.
      // In-parent reorder uses sibling midpoints, not snap. Grip mode
      // uses clamping, not snap.
      snap: canvasSnap,
      dropTarget,
      highlightParentId: null,
      axisLock: gripAxis,
    };
  }

  onEnd(context: DragContext): PendingUpdate[] {
    const updates: PendingUpdate[] = [];
    const { draggedNodes, contentEl, transform } = context;
    const endVpId = vpIdFromPrefix(context.viewportPrefix);
    const vpPrefix = getViewportPrefix(endVpId);

    // Icon-set master files: only VECTOR CONTAINERS (children of master
    // root) get pinned. Shapes inside vectors are allowed to exit their
    // vector normally — to canvas, or into a sibling vector via the
    // generic strategy switch. Without this distinction the guard was
    // too aggressive and shapes-inside-vectors couldn't be moved out.
    // Same umbrella as the move-time guard above.
    const apEnd = getActiveFilePath();
    const isIconSetMaster = apEnd.startsWith('icons/');
    const isVectorContainer = isIconSetMaster && this.parentNodeId === 'root';
    if (isVectorContainer) {
      this.isOverParent = true;
    }

    trace.action('layout-lifted:onEnd-start', {
      isOverParent: this.isOverParent,
      isExplicitGrid: this.isExplicitGridPlacement,
      currentInsertIndex: this.currentInsertIndex,
      originalChildOrder: this.originalChildOrder,
      draggedIds: draggedNodes.map(n => n.id),
    });

    // Remove all placeholders via bridge. EXCEPT on a templated-root primary
    // drop: there the removal rides INSIDE the atomic `commitMergedOrder`
    // (same sandbox task as the restore) — removing them a message earlier
    // let the column close the gap for one painted frame before the restore
    // landed, part of the "jumps for 0.2s then repositions" glitch
    // (2026-07-28). If any sub-path below skips the templated commit,
    // cleanup() still removes leftovers — nothing can leak.
    const deferPlaceholderRemoval = this.isOverParent && this.willCommitMergedTemplatedOrder();
    if (!deferPlaceholderRemoval) this.removePlaceholdersViaBridge();

    // Tell the selection overlay a layout reposition is committing so it can
    // HIDE until the node's new-slot rect is remeasured — otherwise it paints a
    // frame at the stale drag (cursor) position before the box snaps to the new
    // slot (the `restoreNode` DOM move is an async bridge round-trip). Only for
    // drop-INSIDE-parent (a real reorder / grid swap); exit-to-canvas drops go
    // through a different path and don't have the snap-back jump. Resize/pan/zoom
    // never reach here, so they're untouched. See SelectionFade.
    if (this.isOverParent) {
      repositionSignalOps.signal();
      trace.action('layout-lifted:reposition-signal', { draggedIds: draggedNodes.map(n => n.id) });
    }

    if (this.isOverParent && this.isExplicitGridPlacement) {
      // DROP INSIDE PARENT (explicit grid) → swap grid placements, not DOM order
      for (const node of draggedNodes) {
        // Restore original styles via bridge
        const orig = this.originalStyles.get(node.id);
        if (orig) {
          patchNodeStyles(contentEl, node.id, vpPrefix, {
            ...(orig.display ? { display: orig.display } : {}),
            position: orig.position,
            left: orig.left,
            top: orig.top,
            width: orig.width,
            height: orig.height,
            zIndex: orig.zIndex,
            flex: orig.flex,
            flexShrink: orig.flexShrink,
            flexGrow: orig.flexGrow,
            flexBasis: orig.flexBasis,
            alignSelf: orig.alignSelf,
            margin: orig.margin,
            ...this.boxConstraintRestore(orig),
            pointerEvents: '',
          });
        }

        // Find which sibling we swapped with (the one at currentInsertIndex)
        const siblings = this.originalChildOrder.filter(id => id !== node.id);
        const swapTargetId = siblings[Math.min(this.currentInsertIndex, siblings.length - 1)];
        const swapTargetOrig = swapTargetId ? this.originalGridPlacements.get(swapTargetId) : null;
        const draggedOrig = this.originalGridPlacements.get(node.id);

        if (swapTargetOrig && draggedOrig && swapTargetId !== node.id) {
          // Set the dragged element to the target's grid placement via bridge
          patchNodeStyles(contentEl, node.id, vpPrefix, {
            gridColumn: swapTargetOrig.gridColumn,
            gridRow: swapTargetOrig.gridRow,
            gridArea: swapTargetOrig.gridArea,
          });

          // Commit: update dragged element's grid placement in code
          updates.push({
            nodeId: node.id,
            type: 'style',
            styles: {
              gridColumn: swapTargetOrig.gridColumn,
              gridRow: swapTargetOrig.gridRow,
              ...(swapTargetOrig.gridArea ? { gridArea: swapTargetOrig.gridArea } : {}),
            },
          });

          // Commit: update target element's grid placement in code
          updates.push({
            nodeId: swapTargetId,
            type: 'style',
            styles: {
              gridColumn: draggedOrig.gridColumn,
              gridRow: draggedOrig.gridRow,
              ...(draggedOrig.gridArea ? { gridArea: draggedOrig.gridArea } : {}),
            },
          });

          // Restore target's style via bridge
          patchNodeStyles(contentEl, swapTargetId, vpPrefix, {
            gridColumn: draggedOrig.gridColumn,
            gridRow: draggedOrig.gridRow,
            gridArea: draggedOrig.gridArea,
          });

          trace.action('layout-lifted:drop-grid-swap', {
            draggedId: node.id, targetId: swapTargetId,
            draggedPlacement: swapTargetOrig, targetPlacement: draggedOrig,
          });
        } else {
          // No swap (dropped back at original position) — restore original grid placement
          if (draggedOrig) {
            patchNodeStyles(contentEl, node.id, vpPrefix, {
              gridColumn: draggedOrig.gridColumn,
              gridRow: draggedOrig.gridRow,
              gridArea: draggedOrig.gridArea,
            });
          }
        }
      }
    } else if (this.isOverParent) {
      // DROP INSIDE PARENT (flex/auto-placed grid) → reorder via CSS order
      const sortedNodes = [...draggedNodes].sort((a, b) => {
        const idxA = this.originalChildIndices.get(a.id) ?? 0;
        const idxB = this.originalChildIndices.get(b.id) ?? 0;
        return idxA - idxB;
      });
      const sortedIds = sortedNodes.map(n => n.id);

      // Compute desired child order from CURRENT source children (not the
      // lift-time snapshot) so alt-duplicates added mid-drag participate
      // in the final assignment. Sort by current `style.order` so the
      // splice index lines up with `currentInsertIndex` (which was
      // computed against visually-ordered live siblings in
      // `calculateReorderIndex` + `movePlaceholders`).
      const draggedIdSet = new Set(sortedIds);
      const currentParentNode = this.parentNodeId ? getNodeFromCache(this.parentNodeId) : null;
      const currentChildIds = currentParentNode ? currentParentNode.children.filter(id => {
        if (id.startsWith('layout::')) return false;
        const cn = getNodeFromCache(id);
        if (!cn) return false;
        if (cn.isCanvasNode) return false;
        const pos = cn.styles?.position || '';
        if (pos === 'absolute' || pos === 'fixed') return false;
        if (draggedIdSet.has(id)) return false;
        return true;
      }) : [];
      // Order resolution: originals → spaced rank from lift snapshot;
      // alt-duplicates → their explicit `style.order` from source.
      const idToOrder = new Map<string, number>();
      for (const id of currentChildIds) {
        const rank = this.originalChildIndices.get(id);
        if (rank !== undefined) {
          idToOrder.set(id, rankToOrder(rank));
        } else {
          // Alt-duplicate: use registered rank (source carries the clean
          // sequential order, NOT the spaced-rank value).
          const dupRank = this.altDuplicateRanks.get(id);
          if (dupRank !== undefined) {
            idToOrder.set(id, rankToOrder(dupRank));
          } else {
            const cn = getNodeFromCache(id);
            const orderStr = cn?.styles?.order || '0';
            idToOrder.set(id, parseFloat(orderStr) || 0);
          }
        }
      }
      const nonDraggedIds = [...currentChildIds].sort(
        (a, b) => (idToOrder.get(a) ?? 0) - (idToOrder.get(b) ?? 0),
      );
      // SPACE CONVERSION: `currentInsertIndex` indexes the VISIBLE sibling
      // list (calculateReorderIndex's basis) but `nonDraggedIds` additionally
      // contains INVISIBLE flow children (zero-size frames a Figma import
      // leaves behind), so a raw splice landed one slot short of the
      // placeholder for every invisible child before the drop slot — "drag
      // the Footer to the end, it commits before the last section".
      // Re-anchor: the index means "insert before visible sibling N", or
      // after the LAST visible sibling when it points past the end.
      const visibleIds = this.getLayoutSiblingRects(draggedIdSet)
        .map(s => s.id)
        .filter(id => nonDraggedIds.includes(id));
      let spliceIdx: number;
      if (visibleIds.length === 0) {
        spliceIdx = Math.min(this.currentInsertIndex, nonDraggedIds.length);
      } else if (this.currentInsertIndex >= visibleIds.length) {
        spliceIdx = nonDraggedIds.indexOf(visibleIds[visibleIds.length - 1]) + 1;
      } else {
        spliceIdx = nonDraggedIds.indexOf(visibleIds[this.currentInsertIndex]);
      }
      const desiredOrder = [...nonDraggedIds];
      desiredOrder.splice(spliceIdx, 0, ...sortedIds);

      // ── TEMPLATED PAGE: reorder page sections in the PAGE source (not CSS) ──
      // On a page that uses a template, the canvas MERGES the page's sections
      // with the template's LOCKED `layout::` sections (Header before the
      // {children} slot, CTA/Footer after). Those locked sections carry no
      // `order`, so a CSS-order reorder of the page sections collides with them
      // at order 0 and scrambles the template chrome into the middle (symptom:
      // drag a page section → the template "reverses"/jumps, placeholder
      // unstable). The page sections live in the PAGE file, so reorder THEM in
      // source + CLEAR every CSS order; the merge then re-places them between the
      // template chrome by DOM order. Same JSX-reorder shape as the template
      // children-slot branch (lock-clear + synchronous flush + force-render).
      const mergedChildren = this.parentNodeId ? (getNodeFromCache(this.parentNodeId)?.children ?? []) : [];
      const isMergedTemplatedRoot = mergedChildren.some(id => id.startsWith('layout::'));
      // ONLY the PRIMARY viewport reorders the page SOURCE (a global JSX reorder
      // — every viewport inherits it). A REPLICA drag must produce a PER-VIEWPORT
      // order (different order per breakpoint), so it falls through to the
      // CSS-order path below (commitOrderAssignments → @media), which adds the
      // `layout::` bracket for the merged-templated case. See that path.
      if (this.parentNodeId && isMergedTemplatedRoot && isPrimaryViewport(this.currentVpId)) {
        const tpBridge = getCanvasBridge();
        const tpHasRestore = 'restoreNode' in tpBridge;
        const tpHasAtomic = 'commitMergedOrder' in tpBridge;
        // Page sections only (skip the locked template sections + the slot).
        const pageSectionOrder = desiredOrder.filter(id => !id.startsWith('layout::') && id !== 'children-slot');
        const desiredMerged = computeMergedTemplatedOrder(mergedChildren, pageSectionOrder);
        const tpRestores = sortedNodes.map(node => {
          const orig = this.originalStyles.get(node.id);
          const restoreStyles: Record<string, string> = orig ? {
            ...(orig.display ? { display: orig.display } : {}),
            position: orig.position, left: orig.left, top: orig.top,
            width: orig.width, height: orig.height, zIndex: orig.zIndex,
            flex: orig.flex, flexShrink: orig.flexShrink, flexGrow: orig.flexGrow,
            flexBasis: orig.flexBasis, alignSelf: orig.alignSelf, margin: orig.margin,
            gridColumn: orig.gridColumn, gridRow: orig.gridRow, gridArea: orig.gridArea,
            ...this.boxConstraintRestore(orig),
            pointerEvents: '', order: '',
          } : { pointerEvents: '', order: '' };
          return { nodeId: node.id, styles: restoreStyles };
        });
        // Bracketed chrome goes back to its PRE-DRAG merge order in the same
        // task (never cleared to '' — see bracketedChromePrevOrders).
        const tpChromeRestores = [...this.bracketedLayoutSectionIds].map(id => ({
          nodeId: id, order: this.bracketedChromePrevOrders.get(id) ?? '',
        }));
        if (tpHasAtomic && this.parentNodeId) {
          // ONE message = ONE sandbox task: placeholders out, dragged restored,
          // the PARTICIPANT sections arranged into their new sequence using
          // their own DOM slots (template chrome + a fixed-video OVERLAY are
          // never moved or touched — "the overlay must be completely ignored
          // in all drag calculations", 2026-07-28), participant rank stamps
          // cleared, chrome brackets restored. The browser can never paint an
          // intermediate state — the old multi-message flow painted between
          // macrotasks ("jumps above for 0.2s then repositions").
          (tpBridge as PostMessageBridge).commitMergedOrder(
            this.parentNodeId, vpPrefix, pageSectionOrder, tpRestores, [...this.placeholderIds], tpChromeRestores,
          );
          this.placeholderIds.clear();
        } else {
          // DirectBridge fallback — same ops, non-atomic.
          this.removePlaceholdersViaBridge();
          for (const r of tpRestores) {
            if (tpHasRestore) {
              (tpBridge as PostMessageBridge).restoreNode(r.nodeId, this.parentNodeId, vpPrefix, Math.max(0, desiredMerged.indexOf(r.nodeId)), r.styles);
            } else {
              patchNodeStyles(contentEl, r.nodeId, vpPrefix, r.styles);
            }
          }
          for (const id of mergedChildren) patchNodeStyles(contentEl, id, vpPrefix, { order: '' });
        }
        // Clear the drag-lock so the eventual (async) re-render can reconcile
        // the formerly-lifted section. cleanup() also clears it; doing it here
        // too just makes it deterministic.
        if ('setDragLockedNodeIds' in tpBridge) {
          (tpBridge as PostMessageBridge).setDragLockedNodeIds([]);
        }
        // Apply the SAME atomic endgame to every REPLICA viewport so they
        // update INSTANTLY too — otherwise only the primary (where the drag
        // happened) is live-correct and the replicas re-align ~0.5s later when
        // the async source re-render lands. The drag lifted only the primary's
        // element, so each replica's section is already in flow: arrange +
        // clear orders per replica (one message each, atomic per tile).
        const tpAllVpIds = Object.keys(getViewportWidths());
        for (const rvp of tpAllVpIds) {
          const rPh = getViewportPrefix(rvp);
          if (rPh === vpPrefix || !this.parentNodeId) continue; // primary already done
          if (tpHasAtomic) {
            (tpBridge as PostMessageBridge).commitMergedOrder(
              this.parentNodeId, rPh, pageSectionOrder,
              sortedNodes.map(node => ({ nodeId: node.id, styles: { order: '', pointerEvents: '' } })),
              [], tpChromeRestores,
            );
            continue;
          }
          for (const node of sortedNodes) {
            if (tpHasRestore) {
              (tpBridge as PostMessageBridge).restoreNode(node.id, this.parentNodeId, rPh, Math.max(0, desiredMerged.indexOf(node.id)), { order: '', pointerEvents: '' });
            }
          }
          for (const id of mergedChildren) patchNodeStyles(contentEl, id, rPh, { order: '' });
        }
        // Re-measure NOW (LAST op before the deferred commit) so the sandbox
        // emits fresh corners; the overlay poll then snaps to the new layout.
        if ('forceRemeasureAllRects' in tpBridge) {
          (tpBridge as PostMessageBridge).forceRemeasureAllRects();
        }
        // DEFER the source commit by two frames. Flushing it now re-parses the
        // WHOLE (big) page synchronously (~0.3s) and blocks the main thread —
        // and a same-origin iframe shares that thread, so the sandbox re-measure
        // rAF AND the overlay poll rAF freeze for the whole block, leaving the
        // selection box at the drop spot until the re-parse finishes (the 0.3s
        // lag). The LIVE DOM is already correct, so let the overlay + re-measure
        // fire on the next frame FIRST, then commit the JSX reorder on the frame
        // after (the user just released, so the brief re-parse is imperceptible).
        const tpParent = this.parentNodeId;
        const tpOrder = [...pageSectionOrder];
        nextFrames(2, () => {
          tpOrder.forEach((id, idx) => {
            queueMutation({ type: 'reorder', nodeId: id, parentId: tpParent, index: idx });
            queueMutation({ type: 'updateStyles', nodeId: id, styles: { order: '' } });
          });
        });
        trace.action('layout-lifted:templated-page-section-jsx-reorder', { pageSectionOrder, desiredMerged, draggedIds: sortedIds });
      } else

      // ── ROBUST path: TEMPLATE top-level sections (column holds {children}) ──
      // CSS `order` can't position sections around the `{children}` slot: the
      // slot is a JSX expression with no element, so an `order` write to it is a
      // dropped no-op and the relative-order workaround diverges from source
      // (the cache re-sequentializes negative orders → the canvas renders one
      // thing, the source says another → intermittent snap-back). So commit a
      // JSX REORDER (move the sections in source) and CLEAR every CSS `order`,
      // making visual order == source order with nothing left to diverge. Only
      // when editing the layout file and the slot is actually a sibling.
      if (this.parentNodeId && isLayoutFile(getActiveFilePath()) && desiredOrder.includes('children-slot')) {
        // Full desired JSX child order: non-flex children (a fixed Header, etc.)
        // keep their JSX slots; the flex children (incl. the {children} slot)
        // take the `desiredOrder` sequence. `reorderNodeInCode` counts the
        // {children} expression as a slot, so a section's target index here maps
        // straight to a JSX reorder.
        const allChildIds = (getNodeFromCache(this.parentNodeId)?.children) ?? [];
        const flexSet = new Set(desiredOrder);
        // Non-flex children (a position:fixed/absolute Header, etc.) are
        // positioned INDEPENDENTLY of the flex column — their JSX position is
        // cosmetic, so place them FIRST (relative order preserved), then the
        // flex children in `desiredOrder`. Deriving indices off the LIVE
        // allChildIds order instead inherits any prior corruption (e.g. a
        // section that landed BEFORE the fixed Header on an earlier reorder)
        // and offsets every target index — which is exactly the bug where
        // "Footer to the end" reverted. Reordering the sections to these
        // indices also self-heals the Header back to the front.
        const nonFlexChildren = allChildIds.filter(id => !flexSet.has(id));
        const desiredFull = [...nonFlexChildren, ...desiredOrder];

        const bridge = getCanvasBridge();
        const hasRestore = 'restoreNode' in bridge;
        // Restore each dragged section to layout flow with NO order (JSX governs)
        // + move it to the right DOM slot for instant feedback.
        for (const node of sortedNodes) {
          const orig = this.originalStyles.get(node.id);
          const restoreStyles: Record<string, string> = orig ? {
            ...(orig.display ? { display: orig.display } : {}),
            position: orig.position, left: orig.left, top: orig.top,
            width: orig.width, height: orig.height, zIndex: orig.zIndex,
            flex: orig.flex, flexShrink: orig.flexShrink, flexGrow: orig.flexGrow,
            flexBasis: orig.flexBasis, alignSelf: orig.alignSelf, margin: orig.margin,
            gridColumn: orig.gridColumn, gridRow: orig.gridRow, gridArea: orig.gridArea,
            ...this.boxConstraintRestore(orig),
            pointerEvents: '', order: '',
          } : { pointerEvents: '', order: '' };
          if (hasRestore) {
            (bridge as PostMessageBridge).restoreNode(node.id, this.parentNodeId, vpPrefix, desiredFull.indexOf(node.id), restoreStyles);
          } else if (orig) {
            patchNodeStyles(contentEl, node.id, vpPrefix, restoreStyles);
          }
        }

        // Release the renderer drag-lock NOW — BEFORE the synchronous re-render
        // below. The PRIMARY tile reuses + patches its existing DOM elements,
        // and patchChildElements SKIPS any still-locked (lifted) child, so it
        // would never physically reposition the dragged section → the primary
        // keeps the OLD order while the replicas (which rebuild fresh elements)
        // already show the new one. That was the "desktop tile stale, replicas
        // correct" bug.
        if ('setDragLockedNodeIds' in bridge) {
          (bridge as PostMessageBridge).setDragLockedNodeIds([]);
        }

        // JSX reorder for every SECTION (skip the {children} expression — it has
        // no data-id to target and lands correctly as the sections move around
        // it). Each `reorder`'s index is the section's ABSOLUTE position in the
        // desired full order (reorderNodeInCode removes-then-inserts at that
        // index, so the result is order-independent). Also CLEAR every flex
        // child's CSS `order` so JSX order is the single source of truth.
        //
        // Queue DIRECTLY (not updates.push) + flushNow + forceCanvasRender so
        // the source change re-parses and the PRIMARY rebuilds from the new JSX
        // order in THIS tick — with the lock already cleared so the dragged
        // section is reconciled, not skipped. Deferring to the orchestrator left
        // a window where the structural render reconciled the primary while the
        // section was still lock-skipped (replicas were fine; primary stale).
        for (const id of desiredOrder) {
          // Clear the LIVE inline `order` on EVERY flex child INCLUDING the
          // {children} slot. The drag's `neutralize-order` step stamps a spaced
          // rank (e.g. "10") onto the slot's placeholder element via the bridge,
          // and patchElement's stale-clear ignores externally-set keys — so a
          // leftover `order` on the slot survives on the PRIMARY tile (replicas
          // rebuild fresh → unaffected) and CSS `order` shoves the placeholder
          // to the bottom even though the DOM child order is already correct.
          // This is the "desktop tile stale" bug: the DOM was right, an orphan
          // inline `order:10` on the slot overrode it. So clear it BEFORE the
          // `continue` that skips the (data-id-less) slot's JSX reorder.
          patchNodeStyles(contentEl, id, vpPrefix, { order: '' });
          if (id === 'children-slot') continue;
          queueMutation({ type: 'reorder', nodeId: id, parentId: this.parentNodeId, index: desiredFull.indexOf(id) });
          queueMutation({ type: 'updateStyles', nodeId: id, styles: { order: '' } });
        }
        flushNow();
        forceCanvasRender();
        trace.action('layout-lifted:template-section-jsx-reorder', {
          desiredOrder, desiredFull, draggedIds: sortedIds,
        });
      } else {

      // Compute sequential order assignments for all children
      const orderAssignments = computeReorderAssignments(desiredOrder);

      trace.action('layout-lifted:drop-reorder-order', {
        index: this.currentInsertIndex, nodeCount: sortedNodes.length,
        desiredOrder, orderAssignments,
      });

      // Pre-compute order map for the dragged elements
      const orderMap = new Map(orderAssignments.map(a => [a.nodeId, a.order]));

      // Index of each dragged node in the desired layout (used to put it
      // back into its parent at the right position).
      const desiredIndexOf = new Map<string, number>();
      desiredOrder.forEach((id, idx) => desiredIndexOf.set(id, idx));

      // Restore all dragged elements with correct order already set
      const bridge = getCanvasBridge();
      const hasRestore = 'restoreNode' in bridge;
      for (const node of sortedNodes) {
        // Set new order BEFORE restoring styles
        const newOrder = orderMap.get(node.id);
        if (newOrder !== undefined) {
          patchNodeStyles(contentEl, node.id, vpPrefix, { order: String(newOrder) });
        }

        // Restore original styles (back to layout flow)
        const orig = this.originalStyles.get(node.id);
        const restoreStyles: Record<string, string> = orig ? {
          ...(orig.display ? { display: orig.display } : {}),
          position: orig.position,
          left: orig.left,
          top: orig.top,
          width: orig.width,
          height: orig.height,
          zIndex: orig.zIndex,
          flex: orig.flex,
          flexShrink: orig.flexShrink,
          flexGrow: orig.flexGrow,
          flexBasis: orig.flexBasis,
          alignSelf: orig.alignSelf,
          margin: orig.margin,
          gridColumn: orig.gridColumn,
          gridRow: orig.gridRow,
          gridArea: orig.gridArea,
          ...this.boxConstraintRestore(orig),
          pointerEvents: '',
          // Clear order: String(newOrder) which we set above so it's restored
          // alongside the rest. The bridge `restoreNode` writes these too.
          order: String(newOrder ?? ''),
        } : { pointerEvents: '' };

        if (hasRestore && this.parentNodeId) {
          // Move element BACK into its parent at the right index — eliminates
          // the (0,0) flash where it would otherwise sit at contentRoot until
          // React re-renders from the new code. Restore styles applied first.
          //
          // Collection template item: restore to slot 0 (FIRST) instead of the
          // drop index. The clones mirror its `order`, so its first-ness is by
          // DOM position; the ghost handler re-pins it to first on the next
          // render anyway, so parking it at the drop index here just makes it
          // visibly JUMP from the wrong spot to first on mouseup. Restoring it
          // straight to 0 lands it correct instantly (no jump).
          const targetIndex = this.hiddenGhostsContainerId ? 0 : (desiredIndexOf.get(node.id) ?? 0);
          (bridge as PostMessageBridge).restoreNode(node.id, this.parentNodeId, vpPrefix, targetIndex, restoreStyles);
        } else if (orig) {
          // Fallback: just patch styles. Element stays at contentRoot until next render.
          patchNodeStyles(contentEl, node.id, vpPrefix, restoreStyles);
        }
      }

      // Apply order to ALL nodes via bridge + route the commit through the
      // shared helper (primary → inline, page replica → @container,
      // component replica → conditional order). Same path arrow-nudge uses.
      updates.push(...commitOrderAssignments(orderAssignments, contentEl, this.currentVpId));

      // MERGED TEMPLATED ROOT on a REPLICA: the page sections share one flex root
      // with the template's locked `layout::` sections (Header before, CTA/Footer
      // after). The per-viewport orders we just wrote (0..N-1) would otherwise
      // COLLIDE with those order-0 template sections on the canvas merge (page
      // sections jump past the Footer). So BRACKET them per-viewport: leading
      // `layout::` sections get a very LOW order, trailing a very HIGH one, so the
      // page sections always slot between regardless of DOM position. Written to
      // the PAGE's <style> on the template sections' `layout::`-PREFIXED ids —
      // the canvas merge prefixes template nodes' data-ids (`[data-id="layout::X"]`,
      // Renderer.ts), so the bracket must match THAT. In the deployed page those
      // `layout::` elements don't exist, so the bracket rule is simply a DEAD
      // no-op there — and deploy doesn't need it anyway (page sections live in
      // their own root div, separate from the template's Header/CTA/Footer). So
      // the bracket is inherently canvas-only and never touches the shared template.
      if (isMergedTemplatedRoot) {
        const bracketWidth = getViewportWidths()[this.currentVpId] || 0;
        const brackets = computeLayoutBrackets(mergedChildren);
        for (const { id, order } of brackets) {
          // Live (instant): patch the merged child's order with !important so the
          // canvas re-sequences immediately (bridge resolves the `layout::` id).
          patchNodeStyles(contentEl, id, vpPrefix, { order: String(order) }, true);
          // Commit: page-local @media rule keyed on the `layout::`-PREFIXED id so
          // it matches the canvas merge's prefixed element (dead no-op in deploy).
          updates.push({ nodeId: id, type: 'updateContainerStyle', maxWidth: bracketWidth, styles: { order: String(order) } });
        }
        trace.action('layout-lifted:templated-replica-order', { vpId: this.currentVpId, orderAssignments, brackets });
      }
      } // end CSS-order (non-template) commit
    } else if (this.intendedParentId) {
      // Phase C: DROP INTO A DIFFERENT FLEX/GRID CONTAINER
      // Sort by original order for consistent insertion
      const sortedCross = [...draggedNodes].sort((a, b) => {
        const idxA = this.originalChildIndices.get(a.id) ?? 0;
        const idxB = this.originalChildIndices.get(b.id) ?? 0;
        return idxA - idxB;
      });

      trace.action('layout-lifted:drop-cross-parent', {
        nodes: sortedCross.map(n => n.id),
        newParentId: this.intendedParentId,
        insertIndex: this.intendedInsertIndex,
      });

      let crossOffset = 0;
      for (const node of sortedCross) {
        patchNodeStyles(contentEl, node.id, vpPrefix, { pointerEvents: '' });

        updates.push({
          nodeId: node.id,
          type: 'move',
          newParentId: this.intendedParentId,
          newIndex: this.intendedInsertIndex >= 0 ? this.intendedInsertIndex + crossOffset : undefined,
          styles: {
            position: 'relative',
            left: '',
            top: '',
            right: '',
            bottom: '',
            // Re-parenting into a new flex/grid container ⇒ Fixed/Hug
            // (shrink: 0), never the CSS-default shrink: 1 that collapses the
            // child in a height-constrained column. design-tool parity.
            flex: '0 0 auto',
          },
        });
        crossOffset++;
      }

      // Renumber old parent's remaining children. Read from CURRENT source
      // (not lift-time snapshot) and sort by current `style.order` so any
      // alt-duplicates added mid-drag participate in the sequential
      // renumber at their visual position. Without this, alt-duplicates
      // keep their drag-time spaced-rank order (e.g. `10`) while other
      // siblings get sequential `0, 1, ...` — the duplicate ends up at
      // the END of the parent in visual order instead of where it sat
      // during the drag.
      if (this.parentNodeId) {
        const draggedIdSet = new Set(draggedNodes.map(n => n.id));
        const crossParentNode = getNodeFromCache(this.parentNodeId);
        const remainingChildIds = crossParentNode ? crossParentNode.children.filter(id => {
          if (id.startsWith('layout::')) return false;
          const cn = getNodeFromCache(id);
          if (!cn) return false;
          if (cn.isCanvasNode) return false;
          const pos = cn.styles?.position || '';
          if (pos === 'absolute' || pos === 'fixed') return false;
          if (draggedIdSet.has(id)) return false;
          return true;
        }) : [];
        const crossIdToOrder = new Map<string, number>();
        for (const id of remainingChildIds) {
          const rank = this.originalChildIndices.get(id);
          if (rank !== undefined) {
            crossIdToOrder.set(id, rankToOrder(rank));
          } else {
            const dupRank = this.altDuplicateRanks.get(id);
            if (dupRank !== undefined) {
              crossIdToOrder.set(id, rankToOrder(dupRank));
              continue;
            }
            const cn = getNodeFromCache(id);
            const orderStr = cn?.styles?.order || '0';
            crossIdToOrder.set(id, parseFloat(orderStr) || 0);
          }
        }
        const remainingIds = [...remainingChildIds].sort(
          (a, b) => (crossIdToOrder.get(a) ?? 0) - (crossIdToOrder.get(b) ?? 0),
        );
        const renumberAssignments = computeReorderAssignments(remainingIds);
        // Was a hand-rolled copy of `commitOrderAssignments`' three-branch
        // routing, and it had drifted in two ways the shared version gets
        // right: it hardcoded `default: 0` in the variant orderMap — collapsing
        // every remaining sibling's PRIMARY order to 0 the moment a node was
        // dragged out of the parent on a variant tile — and it read
        // `currentVpId === 'desktop'` without the `'default'` alias. Both are
        // exactly the drift the routing-invariant test now guards against.
        updates.push(...commitOrderAssignments(renumberAssignments, contentEl, this.currentVpId));
      }
    } else {
      // DROP OUTSIDE PARENT → detach OR hide-in-this-replica.
      //
      // Rule (per user): dragging a replica out only "removes" the element when
      // it's the LAST visible copy. Otherwise just hide in this replica so the
      // other counterparts (where it's still visible) stay untouched.
      //
      //   primary drop-out                      → full move to canvas (always)
      //   replica drop-out, others all hidden   → full move to canvas
      //   replica drop-out, some others visible → hideInThis (no canvas clone)

      let rootNodeId = this.viewportNodeId;
      if (rootNodeId && rootNodeId.startsWith('layout::')) {
        const layoutRootNode = context.nodes.get(rootNodeId);
        const pageRoot = layoutRootNode?.children.find(cid => !cid.startsWith('layout::') && cid !== 'children-slot');
        rootNodeId = pageRoot || 'root';
      }

      const dropVpId = vpIdFromPrefix(context.viewportPrefix);
      const exitVpWidths = getViewportWidths();
      const dropRctx = getReplicaContext(dropVpId, getActiveFilePath(), exitVpWidths);

      trace.action('layout-lifted:drop-canvas', {
        nodes: draggedNodes.map(n => n.id),
        rootNodeId,
        dropVpId,
        isPrimary: dropRctx.isPrimary,
      });

      // The iframe DOM is currently positioned at the drop point (onMove patched
      // left/top to lifted + delta during the drag). Read live coords from the
      // bridge and convert back to canvas-space.
      // Track which nodes actually moved out vs were just hidden — only the
      // moved-out set should trigger sibling renumber below (hidden-only nodes
      // stay in JSX so siblings keep their existing order).
      const actuallyExited = new Set<string>();

      const liveIframeOffset = getIframeOffset();
      for (const node of draggedNodes) {
        patchNodeStyles(contentEl, node.id, vpPrefix, { pointerEvents: '' });

        // Compute drop position once, used by all paths below.
        // For TRANSFORMED elements (rotate/scale) the live screen rect is the
        // post-transform AABB — bigger than the layout box. Committing
        // `left/top` from the AABB top-left puts the layout box at the wrong
        // canvas position because the transform reapplies on top, shifting
        // the visible AABB by `(aabbW - cssW) / 2`. Mirror the lift formula
        // (`aabbLeft + (aabbW - cssWidth) / 2`) so the visual center stays
        // stable across mouseup. Identity-transform elements (no rotate /
        // scale) have aabbW === cssWidth, so the compensation is a no-op.
        const lifted = this.liftedPositions.get(node.id);
        const liveRect = findNodeRect(node.id, endVpId);
        let currentLeft: string;
        let currentTop: string;
        if (liveRect) {
          const aabbW = liveRect.width / transform.scale;
          const aabbH = liveRect.height / transform.scale;
          // Prefer the lifted CSS dims (already used on lift); fall back to
          // computed lookup on the off-chance lifted is missing.
          const cssW = lifted?.width ?? (() => {
            const c = findNodeComputedStyles(node.id, endVpId, ['width']);
            const v = parseFloat(c.width);
            return Number.isFinite(v) && v > 0 ? v : aabbW;
          })();
          const cssH = lifted?.height ?? (() => {
            const c = findNodeComputedStyles(node.id, endVpId, ['height']);
            const v = parseFloat(c.height);
            return Number.isFinite(v) && v > 0 ? v : aabbH;
          })();
          // Shared exit math — centre-stable AABB→CSS-box conversion (see
          // computeExitCanvasPosition; also perspective-corrects the anchor).
          const { canvasLeft, canvasTop } = computeExitCanvasPosition(node.id, endVpId, liveRect, transform, liveIframeOffset, cssW, cssH);
          currentLeft = `${Math.round(canvasLeft)}px`;
          currentTop = `${Math.round(canvasTop)}px`;
        } else {
          currentLeft = lifted ? `${Math.round(lifted.left)}px` : '0px';
          currentTop = lifted ? `${Math.round(lifted.top)}px` : '0px';
        }
        const currentWidth = lifted ? `${Math.round(lifted.width)}px` : '';
        const currentHeight = lifted ? `${Math.round(lifted.height)}px` : '';

        // Replica drag-out: two sub-paths, mirroring AbsoluteInFrameStrategy's
        // replica exit:
        //
        //   - replica-only (this vp is the ONLY one rendering it; pattern is
        //     inline `display:'none'` + `@media display:'unset'` on this vp,
        //     `@media display:'none'` on every other vp): move the SOURCE
        //     itself to canvas + clearContainerStyles + reset inline display
        //     so the canvas-rooted element shows up with no leftover @media
        //     overrides hiding it. This is the case the user reported — a
        //     "standalone tablet replica" that disappeared after drag-out.
        //
        //   - multi-vp visible (other replicas also render the source): build
        //     a fresh canvas clone with new ids (so existing @media rules on
        //     the original don't follow the clone) + hideInThis on the source.
        //     Strip inline `display:'none'` from the clone since it would
        //     otherwise carry through and hide the canvas-rooted clone.
        if (!dropRctx.isPrimary) {
          const inlineDisplay = context.nodes.get(node.id)?.styles?.display;
          // Iterate component-master variant viewports when on a
          // component file. `getViewportWidths()` returns the PAGE
          // breakpoints (`desktop`/`tablet`/`mobile`) regardless of
          // active file, so on a master with variants
          // `default`/`variant-1`/`variant-2` the loop never probed
          // `variant-1`/`variant-2` and `isReplicaOnly` always returned
          // true — dragging out of one variant moved the source to
          // canvas even when another variant still rendered it.
          // Mirror of the same fix in AbsoluteInFrameStrategy.
          const isOnComponentMaster = isComponentFilePath(getActiveFilePath());
          const otherVpIds = isOnComponentMaster
            ? parseVariantConfig(projectFS.readFile(getActiveFilePath()) ?? '')
                .map(v => v.name === 'default' ? 'desktop' : v.name)
            : Object.keys(getViewportWidths());
          const isReplicaOnly = (() => {
            // Component master: with the AnimatePresence + conditional-
            // render pattern, visibility lives on `hiddenOnVariants`
            // (NOT inline `display`). The legacy `display: 'none'`
            // baseline is no longer written for component variants, so
            // the old inline-display check always returned false and
            // exit-from-solo-variant kept producing `{false && <el/>}`
            // wrappers instead of a full remove. Check the hidden set
            // directly: the element is solo on `dropVpId` iff every
            // OTHER variant is in `hiddenOnVariants`.
            if (isOnComponentMaster) {
              const draggedNode = context.nodes.get(node.id);
              const hidden = draggedNode?.hiddenOnVariants;
              if (!hidden || hidden.size === 0) return false;
              const currentVariant = dropVpId === 'desktop' ? 'default' : dropVpId;
              for (const otherVpId of otherVpIds) {
                const variantName = otherVpId === 'desktop' ? 'default' : otherVpId;
                if (variantName === currentVariant) continue;
                if (!hidden.has(variantName)) return false;
              }
              return true;
            }
            // Page replicas: keep the legacy inline-display baseline
            // check — pages don't use AnimatePresence wrapping.
            if (inlineDisplay !== 'none') return false;
            for (const otherVpId of otherVpIds) {
              if (otherVpId === dropVpId) continue;
              const otherDisplay = findNodeComputedStyle(node.id, otherVpId, 'display');
              if (otherDisplay && otherDisplay !== 'none') return false;
            }
            return true;
          })();
          trace.action('layout-lifted:drop-canvas-replica-visibility', {
            nodeId: node.id, dropVpId, inlineDisplay, isReplicaOnly,
          });

          if (isReplicaOnly) {
            // Source is the only visible copy. Move SOURCE to canvas + wipe
            // every @media/@container override + reset inline display so the
            // element renders at canvas root with no inherited responsive
            // hides. Same shape as the primary path below + an explicit
            // `display: ''` reset and renumber-trigger via actuallyExited.
            //
            // For COMPONENT variants: read the effective display from
            // `motionVariants[variantKey]` and apply that instead of ''.
            // Otherwise the user's flex/grid layout from the variant
            // override gets clobbered — they see the element at canvas
            // root with display:block (no flex), children stack
            // naturally, layout lost. Mirrors the page-replica @container
            // resolution in AbsoluteInFrameStrategy:1917.
            let effectiveDisplay = '';
            if (isOnComponentMaster) {
              const variantKey = endVpId === 'desktop' ? 'default' : endVpId;
              const variantOverride = context.nodes.get(node.id)?.motionVariants?.[variantKey];
              const vd = variantOverride?.display;
              if (vd && vd !== '' && vd !== 'auto') effectiveDisplay = vd;
            }
            const ms = {
              position: 'absolute',
              left: currentLeft,
              top: currentTop,
              width: currentWidth,
              height: currentHeight,
              display: effectiveDisplay,
            };
            // Queue + imperative cache + DOM patch directly (NOT via
            // updates.push). flushExitToCanvas at the end of the for-loop
            // processes the queue synchronously so nodesAtom re-derives
            // BEFORE SelectionOverlay un-hides on mouseup. Without it, the
            // overlay paints stale "layout child" state for ~100-200ms then
            // jumps to the canvas-node final form. Same pattern as the
            // mid-drag exit branch at ~line 827.
            commitExitToCanvas({
              nodeId: node.id,
              styles: ms,
              sourceVariant: isComponentFilePath(getActiveFilePath()) ? endVpId : undefined,
              patch: { contentEl, vpPrefix, styles: ms, when: 'after-cache' },
            });
            actuallyExited.add(node.id);
            continue;
          }

          // COLLECTION LIST (.map() repeater) — the generic clone path below
          // (buildCanvasCloneDescriptor) serializes the EXPANDED/resolved tree: it
          // walks the MODEL `node.children` (just the template row — ghosts are
          // DOM-only) and treats the CMS-bound <Item/> as a static leaf, so the
          // dragged-out node loses the `{items.map(...)}` wrapper, `key={idx}`, AND
          // every CMS prop binding (`image={item.image}`, `linkHref`, …) = ONE
          // unbound ghost ("kills all the ghosts" — user repro). Instead COPY the
          // literal `.map()` SOURCE subtree into `canvasNodes` with id-renamed
          // clones (the verbatim cms-paste round-trip), KEEPING the original in the
          // page + `hideInThis` on the source replica — exactly the normal-node
          // replica drag-out (clone to canvas + `display:none` on THIS vp only),
          // just map-preserving. Net: original stays on primary + other replicas,
          // hidden only here; a new data-canvas-node collection list renders all
          // the CMS ghosts on the workspace.
          const listMeta = context.nodes.get(node.id)?.collectionList;
          if (listMeta) {
            const srcNode = context.nodes.get(node.id);
            const suffix = `-c${Math.random().toString(36).slice(2, 8)}`;
            const cloneId = `${node.id}${suffix}`;
            // Bake the SOURCE REPLICA's EFFECTIVE container styles (base overlaid with
            // this viewport's @media overrides) — a canvas node lives outside the
            // viewport tree so the per-viewport rules no longer apply; the replica's
            // resolved values become the canvas node's own style. E.g. tablet's
            // `gridTemplateColumns: repeat(2,…)` + row/column-gap overrides win over
            // the desktop base `repeat(3,…)`. Then add the canvas-drop position.
            const srcVpWidth = getViewportWidths()[endVpId] ?? 0;
            const effectiveSrcStyles = resolveEffectiveStylesForViewport(
              srcNode?.styles, node.id, srcVpWidth, getDefaultStore().get(containerOverridesAtom),
            );
            const cloneStyles: Record<string, string> = {
              ...effectiveSrcStyles,
              position: 'absolute',
              left: currentLeft,
              top: currentTop,
              width: currentWidth,
              height: currentHeight,
            };
            if (cloneStyles.display === 'none') delete cloneStyles.display;
            updates.push(dropRctx.hideInThis(node.id));
            updates.push({
              nodeId: node.id,
              type: 'duplicateCollectionToCanvas',
              cmsSource: listMeta.source,
              cloneSuffix: suffix,
              styles: cloneStyles,
            });
            trace.action('layout-lifted:drop-canvas-collection-list-clone', {
              srcId: node.id, cloneId, dropVpId, source: listMeta.source,
            });
            continue;
          }

          // On a component master file, `endVpId` is the source VARIANT
          // name (e.g., 'desktop' for default, 'variant-1'). Pass it so
          // per-variant ternary text (`{variant === 'v1' ? 'A' : 'B'}`,
          // parsed into `conditionalText`) gets baked into the clone with
          // the source variant's value — at canvas root there's no
          // variant context so the ternary would otherwise resolve to
          // the default branch (often a `​` placeholder).
          const cloneSourceVariant = isComponentFilePath(getActiveFilePath()) ? endVpId : undefined;
          // PAGE replica → the source vp WIDTH (e.g. tablet → 768), so the clone can
          // bake the instance's per-viewport variant from data-responsive[width].
          const cloneSourceVpWidth = isComponentFilePath(getActiveFilePath()) ? undefined : (getViewportWidths()[endVpId] ?? undefined);
          const cloneIdMap = new Map<string, string>();
          const desc = buildCanvasCloneForLayoutDrop(node.id, context.nodes, {
            position: 'absolute',
            left: currentLeft,
            top: currentTop,
            width: currentWidth,
            height: currentHeight,
          }, cloneSourceVariant, cloneSourceVpWidth, cloneIdMap);
          if (desc) {
            // Clone copies the source's inline styles. If the source carried
            // `display:'none'` (replica-only baseline + @media unset pattern)
            // the clone inherits it and renders invisible at canvas root —
            // there's no @media context to flip it back on. Reset to '' so
            // the clone shows. Multi-vp visible sources without the hide-by-
            // default pattern (display !== 'none' inline) skip this branch.
            if (desc.styles && desc.styles.display === 'none') {
              desc.styles.display = '';
            }
            trace.action('layout-lifted:drop-canvas-clone-replica', {
              srcId: node.id, cloneId: desc.id, dropVpId,
            });
            updates.push(dropRctx.hideInThis(node.id));
            updates.push({ nodeId: desc.id!, type: 'add', descriptor: desc });
            // Detach clone = fresh ids; copy the subtree's ::after border-
            // overlay rules onto them (rule edits the <style> block only, so
            // queueing before the pending 'add' flush is order-safe).
            queueBorderOverlayDuplicates(cloneIdMap);
          } else {
            trace.error('layout-lifted:clone-descriptor-failed', { nodeId: node.id });
          }
          continue;
        }
        actuallyExited.add(node.id);

        // Primary drag-out: full move to canvas (single id, no duplication).
        // Wipe ALL @media/@container overrides for this node — those rules were
        // scoped to its position inside the layout (e.g. `display: none` from a
        // prior replica-insert). After the move they'd still match the canvas
        // clone (same data-id) and hide it.
        //
        // Queue mutations DIRECTLY (not via updates.push) so the trailing
        // flushExitToCanvas below can drain them synchronously
        // before SelectionOverlay un-hides on mouseup. Without that path the
        // overlay paints stale "layout child" state (auto height, L/R-only
        // handles, gap handles offset wrong) for ~100-200ms then visibly
        // jumps to the canvas-node final form when the queue eventually
        // flushes + nodesAtom re-derives. Same pattern as the mid-drag exit
        // branch at ~line 827.
        const primaryMs = {
          position: 'absolute',
          left: currentLeft,
          top: currentTop,
          width: currentWidth,
          height: currentHeight,
        };
        commitExitToCanvas({
          nodeId: node.id,
          styles: primaryMs,
          sourceVariant: isComponentFilePath(getActiveFilePath()) ? endVpId : undefined,
          patch: { contentEl, vpPrefix, styles: primaryMs, when: 'after-cache' },
        });
      }

      // Synchronous flush so nodesAtom re-derives + iframe re-renders BEFORE
      // SelectionOverlay's first post-mouseup frame. Mirrors the mid-drag
      // exit pattern (see line ~838). Without this, the overlay would un-
      // hide on the same React tick as canvasInteracting flipping false,
      // reading stale `nodes` from before the queue flushed.
      if (actuallyExited.size > 0) {
        // RELEASE the drag lock FIRST. The exited node is still in the lock set
        // (it was a layout child while dragging), and `patchElement` SKIPS locked
        // nodes — so the canvas-dropped clone keeps its stale, live-bound DOM
        // (item-0's resolved "Marcus Chen" + photo) and only repaints to the
        // dormantized "Missing" state on the NEXT drag (which releases the lock).
        // Clearing here lets the render below patch the clone from the committed
        // (dormantized) code immediately on mouse-up.
        const lockBridge = getCanvasBridge();
        if ('setDragLockedNodeIds' in lockBridge) (lockBridge as PostMessageBridge).setDragLockedNodeIds([]);
        flushExitToCanvas();
        // The synchronous render can still be clobbered by the drag-coordinator's
        // post-onEnd DOM settle (selection un-hide, `updates` apply) + the also-
        // emptied source list's ghosts. A deferred render after the tick settles
        // re-derives from the committed code and finalizes both on mouse-up.
        //
        // SKIP while the drag-end fan-out is deferred: this rAF fires on the
        // first frame AFTER the mouseup drain — BEFORE the fan-out's setCode —
        // so nodesAtom still memo-hits the PRE-exit code and the force render
        // full-rebuilds the dragged node BACK INTO its old flex parent (the
        // user-visible "snaps back to the original slot, then jumps to canvas"
        // flash, root-caused from the recorded trace 2026-07-19: stale
        // forceRender at +136ms with 70 canvas roots, correct render at +488ms
        // with 71). The fan-out's own setCode render IS the truth-up in that
        // mode; the live DOM is already correct via the exit-commit's
        // imperative reparentLive.
        requestAnimationFrame(() => { if (!hasPendingDeferredFanOut()) forceCanvasRender(); });
      }

      // Renumber remaining siblings in old parent — only when nodes actually
      // exited (full move to canvas). Hide-only drops leave the element in JSX
      // so the original sibling order stays valid.
      if (this.parentNodeId && actuallyExited.size > 0) {
        const remainingIds = this.originalChildOrder.filter(id => !actuallyExited.has(id));
        const renumberAssignments = computeReorderAssignments(remainingIds);

        for (const { nodeId, order } of renumberAssignments) {
          // DOM update: primary sets on all copies, replica sets on local el with !important
          if (dropRctx.isPrimary) {
            patchNodeStyles(contentEl, nodeId, vpPrefix, { order: String(order) });
          } else {
            patchNodeStyles(contentEl, nodeId, vpPrefix, { order: String(order) }, true);
          }
          // Code update: routes to inline/container/variant as appropriate
          updates.push(...dropRctx.styleUpdate(nodeId, { order: String(order) }));
        }
      }
    }

    this.cleanup();
    return updates;
  }

  onCancel(context: DragContext): void {
    const vpPrefix = getViewportPrefix(this.currentVpId);

    // Remove all placeholders via bridge
    this.removePlaceholdersViaBridge();

    // Restore all elements to original styles via bridge
    for (const node of context.draggedNodes) {
      const orig = this.originalStyles.get(node.id);
      if (orig) {
        patchNodeStyles(context.contentEl, node.id, vpPrefix, {
          position: orig.position,
          left: orig.left,
          top: orig.top,
          width: orig.width,
          height: orig.height,
          zIndex: orig.zIndex,
          flex: orig.flex,
          flexShrink: orig.flexShrink,
          flexGrow: orig.flexGrow,
          flexBasis: orig.flexBasis,
          alignSelf: orig.alignSelf,
          margin: orig.margin,
          ...this.boxConstraintRestore(orig),
          pointerEvents: '',
        });
      }
    }

    // Restore original order values on all siblings (undoes neutralization).
    if (this.parentNodeId) {
      for (const [childId, origOrder] of this.originalOrderValues) {
        // Clear !important flag by setting to empty first, then restore original value
        patchNodeStyles(context.contentEl, childId, vpPrefix, { order: '' });
        if (origOrder && origOrder !== '0') {
          patchNodeStyles(context.contentEl, childId, vpPrefix, { order: origOrder });
        }
      }
    }

    this.cleanup();
  }

  /**
   * Register an alt-duplicate's intended visual rank. Called by
   * DragCoordinator when alt-down adds the duplicate. Lets the strategy
   * compute the correct spaced-rank `order` for the iframe DOM
   * (`reNeutralizeSiblingOrders`, `movePlaceholders`) without polluting
   * the source code with the spaced-rank value.
   *
   * Also extends the renderer drag-lock to include the alt-duplicate —
   * subsequent force-renders mustn't clear its `!important` order via
   * patchElement (CSSOM `el.style.order='x'` removes prior `!important`).
   */
  registerAltDuplicateRank(duplicateId: string, rank: number): void {
    this.altDuplicateRanks.set(duplicateId, rank);
    this.refreshDragLockSet();
  }

  /** Reverse of `registerAltDuplicateRank` — called on alt-release. */
  unregisterAltDuplicateRank(duplicateId: string): void {
    this.altDuplicateRanks.delete(duplicateId);
    this.refreshDragLockSet();
  }

  /** Push the current set of locked node IDs (dragged + visible siblings
   *  + alt-duplicates) to the renderer. Called on lift, alt-add, alt-remove. */
  private refreshDragLockSet(): void {
    if (!this.parentNodeId) return;
    const parentNode = getNodeFromCache(this.parentNodeId);
    if (!parentNode) return;
    const locked: string[] = [];
    for (const childId of parentNode.children) {
      if (childId.startsWith('layout::')) continue;
      const cn = getNodeFromCache(childId);
      if (!cn) continue;
      if (cn.isCanvasNode) continue;
      const pos = cn.styles?.position || '';
      if (pos === 'absolute' || pos === 'fixed') continue;
      locked.push(childId);
    }
    const bridge = getCanvasBridge();
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds(locked);
    }
    trace.action('layout-lifted:drag-lock-refresh', { count: locked.length });
  }

  /**
   * Re-apply the spaced-rank `order` (with `!important`) to every visible
   * sibling AND the alt-duplicate. Called by DragCoordinator after a
   * mid-drag force-render — the renderer's `patchElement` re-applies
   * SOURCE styles to each sibling, and since `el.style.order = '0'` in
   * CSSOM clears the previously-set `!important` priority, the lift-time
   * neutralization is WIPED. The siblings end up with their sequential
   * source orders (gap=1) and `pickPlaceholderOrder` can no longer find
   * an integer midpoint → placeholder lands on top of an existing
   * sibling or doesn't move at all.
   *
   * For each current sibling we re-patch:
   *  - Originals (tracked in `originalChildIndices`) → rankToOrder(rank).
   *  - Alt-duplicates (NOT in originalChildIndices) → their `source.order`
   *    which was committed at alt-down to match the dragged's spaced rank.
   *
   * All writes use `important: true` so the next force-render's
   * non-!important source-style application can't blow it away.
   */
  reNeutralizeSiblingOrders(): void {
    if (!this.parentNodeId || this.isExplicitGridPlacement) return;
    const parentNode = getNodeFromCache(this.parentNodeId);
    if (!parentNode) return;
    const vpPrefix = getViewportPrefix(this.currentVpId);
    const bridge = getCanvasBridge();
    const assignments: Array<{
      nodeId: string;
      vpPrefix: string;
      styles: Record<string, string>;
      important: boolean;
    }> = [];
    for (const childId of parentNode.children) {
      if (childId.startsWith('layout::')) continue;
      const cn = getNodeFromCache(childId);
      if (!cn) continue;
      if (cn.isCanvasNode) continue;
      const pos = cn.styles?.position || '';
      if (pos === 'absolute' || pos === 'fixed') continue;
      const rank = this.originalChildIndices.get(childId);
      let orderValue: string;
      if (rank !== undefined) {
        orderValue = String(rankToOrder(rank));
      } else {
        // Alt-duplicate: NOT in originalChildIndices (added mid-drag).
        // Look up its intended rank in altDuplicateRanks (registered by
        // DragCoordinator at alt-down). The duplicate replaces the
        // dragged at the dragged's spaced-rank slot.
        const dupRank = this.altDuplicateRanks.get(childId);
        if (dupRank !== undefined) {
          orderValue = String(rankToOrder(dupRank));
        } else {
          // Genuine new node (not alt-duplicate). Use source.order verbatim.
          orderValue = cn.styles?.order || '0';
        }
      }
      assignments.push({
        nodeId: childId,
        vpPrefix,
        styles: { order: orderValue },
        important: true,
      });
    }
    if (assignments.length === 0) return;
    if ('patchMultipleStyles' in bridge) {
      (bridge as PostMessageBridge).patchMultipleStyles(assignments);
    } else {
      for (const a of assignments) {
        bridge.patchStyles(a.nodeId, a.vpPrefix, a.styles, true);
      }
    }
    trace.action('layout-lifted:re-neutralize-orders', { count: assignments.length });
  }

  /**
   * Refresh the bridge rect cache after a structural change (alt-
   * duplicate add/remove). The new/removed iframe DOM element shifts
   * every sibling's rect, but `bridge.rectCache` is updated by an
   * observer that fires AFTER the next renderer cycle — until then
   * `findVisibleChildRects` returns the PRE-change rect set, and the
   * cursor maps to wrong sibling indices. `bridge.prefetchChildRects`
   * force-reads fresh rects; `onMove` gates on `siblingRectsReady`
   * until the prefetch resolves.
   *
   * Also resets `currentInsertIndex = -1` so the next `onMove` treats
   * any computed newIndex as "different" and runs the placeholder
   * update — necessary because the structural change might leave the
   * placeholder at a stale spot.
   */
  resetReorderGatesForStructuralChange(): void {
    this.currentInsertIndex = -1;
    this.dragStartInsertIndex = -1;
    this.draggedFlowSize = 0;
    this.flowStartMin = null;
    if (this.parentNodeId && !this.isGridParent) {
      const bridge = getCanvasBridge();
      if ('prefetchChildRects' in bridge) {
        const parentId = this.parentNodeId;
        const vpPrefix = getViewportPrefix(this.currentVpId);
        this.siblingRectsReady = false;
        (bridge as PostMessageBridge).prefetchChildRects(parentId, vpPrefix)
          .then(() => {
            this.siblingRectsReady = true;
            trace.action('layout-lifted:sibling-rects-refreshed-alt', { parentId });
          })
          .catch(() => {
            this.siblingRectsReady = true;
          });
      }
    }
    trace.action('layout-lifted:reset-reorder-gates');
  }

  // ─── Placeholder (bridge-based) ──────────────────────────────────────

  /** Will onEnd take the templated-root atomic commit (commitMergedOrder)?
   *  Mirrors that branch's gate exactly — used to DEFER the early placeholder
   *  removal into the atomic message so the column never paints the closed
   *  gap before the restore lands. */
  private willCommitMergedTemplatedOrder(): boolean {
    if (!this.parentNodeId || !isPrimaryViewport(this.currentVpId)) return false;
    const bridge = getCanvasBridge();
    if (!('commitMergedOrder' in bridge)) return false;
    const kids = getNodeFromCache(this.parentNodeId)?.children ?? [];
    return kids.some(id => id.startsWith('layout::'));
  }

  private removePlaceholdersViaBridge(): void {
    if (this.placeholderIds.size === 0) return;
    const bridge = getCanvasBridge();
    if ('removePlaceholders' in bridge) {
      (bridge as PostMessageBridge).removePlaceholders([...this.placeholderIds]);
    }
    trace.action('layout-lifted:removePlaceholders', { count: this.placeholderIds.size });
  }

  /**
   * Re-stamp the FULL lift styles (position/left/top/width/height/zIndex/
   * pointerEvents) on every lifted node, with `left`/`top` computed from
   * the LIVE cursor position. Called after a force-render (e.g. alt-
   * duplicate addNode + render) — the renderer's `patchElement` re-
   * applies source styles per node, which can clobber the imperative
   * `position: absolute` patch the lift relies on AND the lift's zIndex.
   *
   * Why we fold the cursor delta into this single patch instead of
   * letting the next `onMove` tick update left/top: if rehydrate sets
   * left/top to lift-TIME values and onMove THEN sets them to lift+delta,
   * the browser can paint between the two writes — the user sees the
   * overlay snap to its drag-START position for one frame, then jump to
   * the cursor. By writing the live cursor position directly in the
   * rehydrate, the overlay teleports from "wherever the renderer left it"
   * straight to the correct cursor-tracking position in one paint.
   */
  rehydrateLiftAfterForceRender(context: DragContext, mouseDelta: Point): void {
    if (this.liftedPositions.size === 0) return;
    const vpPrefix = getViewportPrefix(this.currentVpId);
    // Convert screen-pixel mouse delta to parent-local-pixel delta (the
    // lift coords live in parent-local space, divided by canvas zoom).
    const scale = context.transform?.scale || 1;
    const dx = mouseDelta.x / scale;
    const dy = mouseDelta.y / scale;
    for (const [nodeId, lifted] of this.liftedPositions) {
      patchNodeStyles(context.contentEl, nodeId, vpPrefix, {
        position: 'absolute',
        left: `${Math.round(lifted.left + dx)}px`,
        top: `${Math.round(lifted.top + dy)}px`,
        width: `${lifted.width}px`,
        height: `${lifted.height}px`,
        zIndex: '9999',
        pointerEvents: 'none',
        flex: '',
        flexShrink: '',
        flexGrow: '',
        flexBasis: '',
        gridColumn: '',
        gridRow: '',
        gridArea: '',
      });
    }
    trace.action('layout-lifted:rehydrate-lift', { count: this.liftedPositions.size, dx, dy });
  }

  /**
   * Returns the slot info DragCoordinator needs to insert an alt-duplicate
   * as a REAL FLEX SIBLING.
   *
   * Subtle distinction:
   *   - `order` is `rankToOrder(VISUAL rank)` — controls where the
   *     duplicate appears VISUALLY in the parent's flex flow.
   *   - `insertIndex` is the dragged element's SOURCE child index in
   *     `parent.children` — controls where the duplicate goes in JSX.
   *
   * After several reorders, source and visual diverge (source.children
   * stays as whatever order things were inserted in; visual is driven by
   * `style.order` reshuffles). `addNodeInCode` interprets its `index`
   * parameter as SOURCE position — passing the visual rank instead would
   * insert the duplicate in the wrong JSX slot and subsequent
   * `currentChildIds` reads (which use `parent.children` source order +
   * sort by `style.order`) would compute different geometry than the
   * lift-time snapshot expected. Compute both from the right space.
   */
  getAltDuplicateInsertSpec(originalNodeId: string): {
    rank: number;
    insertIndex: number;
    parentId: string;
  } | null {
    const spec = this.placeholderSpecs.get(originalNodeId);
    if (!spec) return null;
    const visualRank = this.originalChildIndices.get(originalNodeId);
    if (visualRank === undefined || visualRank < 0) return null;
    const parentNode = getNodeFromCache(spec.parentId);
    const sourceIndex = parentNode ? parentNode.children.indexOf(originalNodeId) : -1;
    if (sourceIndex < 0) return null;
    return {
      rank: visualRank,
      insertIndex: sourceIndex,
      parentId: spec.parentId,
    };
  }

  private hidePlaceholders(): void {
    const bridge = getCanvasBridge();
    // Hide by patching display:none on each placeholder via bridge styles
    for (const phId of this.placeholderIds) {
      if ('patchStyles' in bridge) {
        // Placeholders don't have data-id, they have data-placeholder-id.
        // Use removePlaceholders and recreate when showing to handle iframe mode.
        // For simplicity, remove them entirely on hide and recreate on show.
      }
    }
    // Actually remove them — we'll recreate on show
    this.removePlaceholdersViaBridge();
  }

  private showPlaceholders(context: DragContext): void {
    if (!this.parentNodeId) return;
    const vpPrefix = getViewportPrefix(this.currentVpId);
    const bridge = getCanvasBridge();
    const parentId = this.parentNodeId;

    // Get current child ordering for insertion position
    const layoutChildIds = this.getLayoutChildIds(parentId);
    const draggedIds = new Set(context.draggedNodes.map(n => n.id));
    const nonDraggedIds = layoutChildIds.filter(id => !draggedIds.has(id));

    // Determine beforeNodeId for current insert index
    const beforeNodeId = this.currentInsertIndex < nonDraggedIds.length
      ? nonDraggedIds[this.currentInsertIndex]
      : null;

    // Recreate placeholders
    this.placeholderIds.clear();
    this.nodeToPlaceholderId.clear();
    const transform = context.transform;

    for (const node of context.draggedNodes) {
      const nodeData = getNodeFromCache(node.id);
      const ns = nodeData?.styles || {};
      const nodeRect = findNodeRect(node.id, this.currentVpId);

      // Placeholder fills the LAYOUT slot — same rationale as the lift-time
      // placeholder: use computed CSS width/height, NOT the post-transform
      // AABB. Rotated/scaled elements have AABB > layout box.
      const computed = findNodeComputedStyles(node.id, this.currentVpId, ['width', 'height']);
      const computedW = parseFloat(computed.width);
      const computedH = parseFloat(computed.height);
      const phWidthPx = Number.isFinite(computedW) && computedW > 0
        ? computedW
        : nodeRect ? nodeRect.width / transform.scale : 100;
      const phHeightPx = Number.isFinite(computedH) && computedH > 0
        ? computedH
        : nodeRect ? nodeRect.height / transform.scale : 40;

      const phId = `ph-${node.id}`;
      this.placeholderIds.add(phId);
      this.nodeToPlaceholderId.set(node.id, phId);

      const phStyles: Record<string, string> = {
        width: `${phWidthPx}px`,
        height: `${phHeightPx}px`,
        // Paint ABOVE absolute overlays (e.g. a 100%×100% GradientAura code
        // component at z-index:0). A positioned element outpaints a static-flow
        // placeholder regardless of DOM order, so without this the reorder gap
        // vanished behind the aura (visible only once the aura was deleted).
        // position:relative + a high z keeps the placeholder in flow but on top.
        position: 'relative',
        zIndex: '9999',
        backgroundColor: PLACEHOLDER_BG,
        borderRadius: PLACEHOLDER_RADIUS,
        transition: PLACEHOLDER_TRANSITION,
        flexShrink: '0',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        ...(ns.flexGrow ? { flexGrow: ns.flexGrow } : {}),
        ...(ns.flexBasis ? { flexBasis: ns.flexBasis } : {}),
        ...(ns.margin ? { margin: ns.margin } : {}),
        ...(ns.alignSelf ? { alignSelf: ns.alignSelf } : {}),
        ...(ns.gridColumn ? { gridColumn: ns.gridColumn } : {}),
        ...(ns.gridRow ? { gridRow: ns.gridRow } : {}),
        ...(ns.gridArea ? { gridArea: ns.gridArea } : {}),
      };

      if ('createPlaceholder' in bridge) {
        (bridge as PostMessageBridge).createPlaceholder(phId, parentId, vpPrefix, beforeNodeId, phStyles);
      }
    }
  }

  private movePlaceholders(
    newIndex: number,
    context: DragContext,
    siblingRectsAxisSorted?: { id: string; rect: DOMRect }[],
  ): void {
    if (this.placeholderIds.size === 0 || !this.parentNodeId) return;
    const vpPrefix = getViewportPrefix(this.currentVpId);
    const bridge = getCanvasBridge();
    const parentId = this.parentNodeId;

    // For explicit-placement grids: swap grid placement CSS between
    // placeholder and the target sibling so they visually swap positions.
    if (this.isExplicitGridPlacement) {
      // Restore ALL siblings to their original grid placements first
      for (const [childId, orig] of this.originalGridPlacements) {
        patchNodeStyles(context.contentEl, childId, vpPrefix, {
          gridColumn: orig.gridColumn,
          gridRow: orig.gridRow,
          gridArea: orig.gridArea,
        });
      }

      // Find the sibling at the target index
      const draggedIds = new Set(context.draggedNodes.map(n => n.id));
      const siblings = this.originalChildOrder.filter(id => !draggedIds.has(id));
      const targetIdx = Math.min(newIndex, siblings.length - 1);
      const targetChildId = siblings[targetIdx];
      if (!targetChildId) return;

      // Get the dragged element's original placement
      const firstDraggedId = context.draggedNodes[0]?.id;
      const phId = firstDraggedId ? this.nodeToPlaceholderId.get(firstDraggedId) : null;
      const draggedOrig = firstDraggedId ? this.originalGridPlacements.get(firstDraggedId) : null;
      if (!draggedOrig || !phId) return;

      // Target takes the dragged element's original placement
      const targetOrig = this.originalGridPlacements.get(targetChildId);
      if (targetOrig) {
        patchNodeStyles(context.contentEl, targetChildId, vpPrefix, {
          gridColumn: draggedOrig.gridColumn,
          gridRow: draggedOrig.gridRow,
          gridArea: draggedOrig.gridArea,
        });
      }
      return;
    }

    // For flex/auto-placed grids: move placeholders via CSS `order` value
    // updates. At drag start each non-dragged sibling was assigned a spaced
    // rank order (see neutralize-order block above and order-positioning.ts).
    // The placeholder picks an intermediate value that slots it visually at
    // the requested index. No DOM moves — flex layout is driven entirely by
    // `order` now, and DOM insertBefore would not change visual position
    // anyway since orders dominate.
    //
    // CRITICAL: derive the sibling sequence from `siblingRectsAxisSorted`
    // (live, axis-sorted from `getLayoutSiblingRects`) — NOT from any
    // source-derived order computation. `newIndex` was computed against
    // this exact axis-sorted set by `calculateReorderIndex`. Sorting
    // siblings here by some other criterion (rank → rankToOrder, source
    // style.order, etc.) and feeding that to `pickPlaceholderOrder`
    // creates a basis mismatch: when an alt-duplicate's effective DOM
    // order doesn't equal its computed order (which can happen for
    // various subtle reasons — !important conflicts, the duplicate
    // being a fresh element without neutralization), the placeholder
    // lands at a slot the cursor isn't over. Always trust the axis order.
    const draggedIds = new Set(context.draggedNodes.map(n => n.id));
    let visualSiblingIds: string[];
    if (siblingRectsAxisSorted && siblingRectsAxisSorted.length > 0) {
      visualSiblingIds = siblingRectsAxisSorted
        .map(r => r.id)
        .filter(id => !draggedIds.has(id));
    } else {
      // Fallback (only for legacy callers without siblingRects): rebuild
      // from current source children. Same filters as `getLayoutChildIds`.
      const parentNode = getNodeFromCache(parentId);
      visualSiblingIds = parentNode ? parentNode.children.filter(id => {
        if (id.startsWith('layout::')) return false;
        const cn = getNodeFromCache(id);
        if (!cn) return false;
        if (cn.isCanvasNode) return false;
        const pos = cn.styles?.position || '';
        if (pos === 'absolute' || pos === 'fixed') return false;
        if (draggedIds.has(id)) return false;
        return true;
      }) : [];
    }
    // Resolve each sibling's CURRENT effective `order`. Originals (lift-
    // time tracked) use `rankToOrder(originalChildIndices.get(id))` — the
    // neutralized value imperatively patched into the iframe at lift.
    // Alt-duplicates aren't in `originalChildIndices` but DO have an
    // explicit `style.order` in source. The two combined cover every
    // sibling. The values matter for `pickPlaceholderOrder` to compute an
    // intermediate placeholder order — order MUST be monotonic across
    // `visualSiblingIds` (since that array is axis-sorted = visual-
    // order-sorted under flex). If they're not monotonic, the flex
    // layout's visual order disagrees with our model and the placeholder
    // will still land off — but at least axis-ordered indexing aligns
    // with `calculateReorderIndex`'s basis.
    const siblingOrders = visualSiblingIds.map(id => {
      const rank = this.originalChildIndices.get(id);
      if (rank !== undefined) return rankToOrder(rank);
      // Alt-duplicate: use its registered rank (intentionally NOT in
      // source as a spaced-rank string — source carries the clean
      // sequential order matching the dragged element).
      const dupRank = this.altDuplicateRanks.get(id);
      if (dupRank !== undefined) return rankToOrder(dupRank);
      const cn = getNodeFromCache(id);
      const orderStr = cn?.styles?.order;
      if (orderStr) return parseFloat(orderStr) || 0;
      return 0;
    });
    const phOrder = pickPlaceholderOrder(siblingOrders, newIndex);

    for (const phId of this.placeholderIds) {
      // Placeholders aren't real nodes — bridge.patchStyles wouldn't find them
      // by data-node-id. The bridge supports placeholders via movePlaceholder
      // (which writes to data-placeholder-id), but movePlaceholder only takes
      // a beforeNodeId for DOM insertion. Use a direct iframe call instead via
      // a new patchPlaceholderStyles RPC. See bridge-host.ts for the helper.
      if ('patchPlaceholderStyles' in bridge) {
        (bridge as PostMessageBridge & {
          patchPlaceholderStyles: (id: string, vpPrefix: string, styles: Record<string, string>) => void;
        }).patchPlaceholderStyles(phId, vpPrefix, { order: String(phOrder) });
      }
    }
    trace.action('layout-lifted:placeholder-order', {
      newIndex,
      phOrder,
      siblings: visualSiblingIds.map((id, i) => ({ id, order: siblingOrders[i] })),
    });
  }

  // ─── Reorder calculation (direction-aware, parent-local space) ──────

  /**
   * Calculate insert index using parent-local coordinates:
   * - Check if mouse is OVER a sibling (not in gap)
   * - Use mouse direction to decide before/after (prevents jitter)
   * - Fallback to midpoint if no direction detected
   */
  private calculateReorderIndex(
    mouseScreen: Point,
    siblings: { id: string; rect: DOMRect }[],
    movingForward: boolean | null = null,
  ): number {
    if (siblings.length === 0) return 0;

    // Build a parent-local coordinate space once per call. The space is
    // accurate under any cumulative ancestor transform — that's what makes
    // the reorder hit-test fire when the layout container sits inside a
    // rotated/skewed hierarchy. See getParentLocalSpace for details.
    const space = this.getParentLocalSpace();
    if (!space) return this.currentInsertIndex;
    const localMouse = space.toLocal(mouseScreen.x, mouseScreen.y);

    // Grid AND flex-wrap: 2D nearest-item detection — find the closest sibling by
    // distance to center in parent-local space (NOT screen space — under rotation
    // the screen-space Euclidean distance can pick the wrong item because the AABBs
    // of rotated items overlap heavily). For flex-wrap the `siblings` array is
    // already in ROW-MAJOR flow order (getLayoutSiblingRects), so nearest-index +
    // before/after along the MAIN axis lands at the correct flat flow position — a
    // child under the mouse on line 2 inserts within line 2, not mixed across lines.
    if (this.isGridParent || this.isWrapParent) {
      const isColumnFlow = this.flexDirection === 'column';
      // Same lazy capture as the 1D path — the 2D branch returns before it.
      if (this.dragStartInsertIndex < 0) this.dragStartInsertIndex = this.currentInsertIndex;
      if (this.draggedFlowSize <= 0 && this.liftedPositions.size > 0) {
        const first = this.liftedPositions.values().next().value as { width: number; height: number } | undefined;
        if (first) this.draggedFlowSize = isColumnFlow ? first.height : first.width;
      }
      let sibLocals = siblings.map(s => space.sibAabb(s.id, s.rect));
      // WRAP (not grid — grids use explicit placement): apply the same
      // VIRTUAL displacement as the 1D path. Rects are frozen mid-drag but
      // the placeholder physically reflowed the flow axis — without this a
      // wrap parent (a plain column with flex-wrap set counts!) hit-tests
      // midpoints of stale spans: instant one way, half-a-sibling late the
      // other (the asymmetric-reorder report).
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < siblings.length; i++) {
        const r = sibLocals[i];
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = Math.hypot(localMouse.x - cx, localMouse.y - cy);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }
      const r = sibLocals[nearestIdx];
      const primary = isColumnFlow ? localMouse.y : localMouse.x;
      const spanStart = isColumnFlow ? r.top : r.left;
      const spanEnd = isColumnFlow ? r.top + r.height : r.left + r.width;
      // INSIDE the (displaced) nearest sibling → direction-biased like the
      // 1D path: the reorder fires from the sibling's FIRST pixel in the
      // drag direction, not its midpoint. Outside (virtual gap = the
      // placeholder) → keep the current index when it maps there, else
      // midpoint fallback.
      if (primary >= spanStart && primary <= spanEnd && movingForward !== null && this.isWrapParent && !this.isGridParent) {
        return movingForward ? nearestIdx + 1 : nearestIdx;
      }
      const mid = isColumnFlow ? r.top + r.height / 2 : r.left + r.width / 2;
      return primary < mid ? nearestIdx : nearestIdx + 1;
    }

    // Flex/block: 1D axis-based detection in parent-local space.
    const isColumn = this.flexDirection === 'column';

    // LAZY SELF-HEAL: several init/re-entry paths set currentInsertIndex
    // without passing through the drag-start capture — without D the
    // displacement silently disables and the walk regresses to stale spans
    // (placeholder hover reorders + early fires). Captured here, BEFORE the
    // coords trace, so the trace always shows the effective D.
    if (this.dragStartInsertIndex < 0) this.dragStartInsertIndex = this.currentInsertIndex;
    if (!(this.draggedFlowSize > 0)) {
      const first = this.liftedPositions.values().next().value as { width?: number; height?: number } | undefined;
      const cand = first ? (isColumn ? first.height : first.width) : undefined;
      if (typeof cand === 'number' && Number.isFinite(cand) && cand > 0) {
        this.draggedFlowSize = cand;
      }
      trace.action('layout-lifted:flow-size-capture', {
        liftedCount: this.liftedPositions.size,
        first: first ? { w: first.width, h: first.height } : null,
        isColumn, captured: this.draggedFlowSize,
      });
    }

    // Precompute sibling local AABBs once — getScreenCornersById reads the
    // bridge cornersCache, which is cheap but not free; doing it inside the
    // loop would re-read the same id 2-3× per call.
    const sibLocals = siblings.map(s => space.sibAabb(s.id, s.rect));

    // Debug: show sibling bounds + mouse for diagnosis. Includes left/right
    // (row axis) and top/bottom (column axis) so the trace is useful for
    // both flex directions; also dumps every sibling, not just first/last,
    // so we can tell whether iteration order matches visual order after a
    // reorder. `mode` flags which path produced the coords (quad-pct vs
    // aabb-px) so traces are interpretable in isolation.
    if (siblings.length > 0) {
      const sibBounds = sibLocals.map((local, i) => ({
        id: siblings[i].id,
        left: Math.round(local.left),
        right: Math.round(local.left + local.width),
        top: Math.round(local.top),
        bot: Math.round(local.top + local.height),
      }));
      trace.action('layout-lifted:reorder-coords', {
        isColumn,
        k: this.currentInsertIndex, k0: this.dragStartInsertIndex,
        D: Math.round(this.draggedFlowSize),
        mode: space.mode,
        localMouse: { x: Math.round(localMouse.x), y: Math.round(localMouse.y) },
        siblings: sibBounds,
        cnt: siblings.length, curIdx: this.currentInsertIndex,
      });
    }

    // PRE-MOVEMENT GUARD. When `movingForward` is null the user hasn't
    // moved the cursor yet (mousedown only). Returning anything other
    // than `currentInsertIndex` makes the placeholder jump to a
    // different slot before the drag has even started — symptom seen
    // on replicas where the dragged's start position differs from
    // primary's: cursor lands inside another sibling's region, the
    // strategy "snaps" the placeholder there immediately even though
    // the user hasn't done anything. Hold the start position until
    // there's actual cursor delta.
    if (movingForward === null) return this.currentInsertIndex;

    // DIRECTION-AWARE boundary check. The placeholder should appear in
    // FRONT of the cursor (in the drag direction), not behind it — that
    // makes reorder feel "instant" symmetrically.
    //
    //   - Cursor inside sibling[i], moving FORWARD (down/right) → i+1
    //     (placeholder lands BELOW/AFTER sibling[i], i.e. where the user
    //     is heading).
    //   - Cursor inside sibling[i], moving BACKWARD (up/left) → i
    //     (placeholder lands ABOVE/BEFORE sibling[i], i.e. ahead of
    //     motion).
    //   - Cursor in the gap between sibling[i] and sibling[i+1] → i+1
    //     either way (it's the only slot the gap maps to).
    //
    // Earlier symmetric "return i always" worked great upward but felt
    // broken downward — when going down, the placeholder above the
    // sibling you just entered is BEHIND you and feels like nothing
    // happened. Direction-awareness solves that without hysteresis.
    const forwardBias = movingForward === true;
    // OVERLAP NORMALIZATION: clip each sibling's flow span to start at or
    // after the previous one's end (see normalizeFlowSpans). Negative-margin
    // siblings otherwise contain the cursor TWICE and the walk flip-flops.
    const rawSpans = sibLocals.map(r => isColumn
      ? { start: r.top, end: r.top + r.height }
      : { start: r.left, end: r.left + r.width });
    // VIRTUAL LAYOUT (trace-verified 2026-07-23): the frozen sibling rects
    // are COLLAPSED — measured with the dragged lifted out and the flow
    // closed up (spans are contiguous; no placeholder hole). The real
    // screen at any moment is therefore frozen + the placeholder inserted
    // at slot k: every sibling j >= k sits one dragged-size D further
    // along the flow axis. The placeholder becomes the virtual gap before
    // sibling k — stable to hover in any direction — and every sibling
    // hit-tests at its TRUE on-screen position, so reorders fire from the
    // first pixel both ways.
    // LIVE RECTS (canvas-dnd parity, 2026-07-23): placeholder mutations now
    // re-emit the parent scope from the sandbox, so these spans track the
    // real screen every frame. The walk is the old library's exact
    // semantics — inside a sibling → direction-biased; in a gap (incl. the
    // placeholder's real hole) → the gap's slot, which equals the current
    // index when hovering the placeholder → stable.
    const spans = normalizeFlowSpans(rawSpans);
    const pointer = isColumn ? localMouse.y : localMouse.x;
    for (let i = 0; i < siblings.length; i++) {
      const span = spans[i];
      if (pointer >= span.start && pointer <= span.end) {
        return forwardBias ? i + 1 : i;
      }
      if (i < siblings.length - 1
        && pointer > span.end && pointer < spans[i + 1].start) {
        // Gap (incl. the placeholder's real hole) → that slot; equals the
        // current index when hovering the placeholder → stable.
        return i + 1;
      }
    }

    // Mouse is before first or after last
    if (pointer < spans[0].start) return 0;
    if (pointer > spans[siblings.length - 1].end) return siblings.length;

    return this.currentInsertIndex; // no change
  }

  /**
   * Build a screen → parent-local coordinate mapper that's accurate under any
   * cumulative ancestor transform chain (rotation, skew, scale, perspective).
   *
   * Why: the previous implementation subtracted the parent's AABB origin and
   * inverted ONLY the parent's own CSS transform. That works when the parent
   * is the only transformed element in the chain, but breaks the moment ANY
   * ancestor has rotation/skew — the bridge's `findNodeRect` then returns the
   * post-transform AABB (the visible-quad's bounding rect, larger than the
   * painted parallelogram), and naive subtraction yields offsets that don't
   * correspond to layout-space positions. Result: the flex-reorder hit-test
   * compares mouse-vs-sibling on the wrong axis and never fires.
   *
   * The quad path consults `nodeOrAncestorHasRotationOrSkewById` (same gate
   * used by AbsoluteInFrameStrategy + CanvasDragStrategy for entry/exit
   * detection — keeps behaviour consistent) and, when true, derives a
   * parent-local pct space from the parent's painted screen corners via the
   * shared `screenToPct` helper (inverse bilinear interpolation across the
   * 4-corner quad). Pct is fine as the unit because reorder math is purely
   * relative ("which side of midpoint" / "between which two siblings").
   *
   * The AABB path preserves the original behaviour byte-for-byte for the
   * untransformed-ancestor case (fast, no DOMMatrix work).
   */
  private getParentLocalSpace(): {
    toLocal: (sx: number, sy: number) => Point;
    sibAabb: (sibId: string, sibRect: DOMRect) => Rect;
    mode: 'quad' | 'aabb';
  } | null {
    if (!this.parentNodeId) return null;
    const parentId = this.parentNodeId;
    const vpId = this.currentVpId;

    // Quad path: any ancestor (including parent itself) carries rotation/skew.
    if (nodeOrAncestorHasRotationOrSkewById(parentId, vpId)) {
      const parentCorners = getScreenCornersById(parentId, vpId);
      if (parentCorners) {
        const toLocal = (sx: number, sy: number): Point => {
          const [xPct, yPct] = screenToPct(parentCorners, sx, sy);
          return { x: xPct, y: yPct };
        };
        const sibAabb = (sibId: string, sibRect: DOMRect): Rect => {
          // Prefer the bridge's painted-quad corners for the sibling (these
          // already encode any sibling-self rotation). Fall back to the AABB
          // rect mapped through the parent quad if the sibling cache misses.
          const sibCorners: ScreenCorners | null = getScreenCornersById(sibId, vpId)
            ?? {
              TL: { x: sibRect.left, y: sibRect.top },
              TR: { x: sibRect.right, y: sibRect.top },
              BR: { x: sibRect.right, y: sibRect.bottom },
              BL: { x: sibRect.left, y: sibRect.bottom },
            };
          const p1 = toLocal(sibCorners.TL.x, sibCorners.TL.y);
          const p2 = toLocal(sibCorners.TR.x, sibCorners.TR.y);
          const p3 = toLocal(sibCorners.BR.x, sibCorners.BR.y);
          const p4 = toLocal(sibCorners.BL.x, sibCorners.BL.y);
          const xs = [p1.x, p2.x, p3.x, p4.x];
          const ys = [p1.y, p2.y, p3.y, p4.y];
          const minX = Math.min(...xs); const maxX = Math.max(...xs);
          const minY = Math.min(...ys); const maxY = Math.max(...ys);
          return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
        };
        return { toLocal, sibAabb, mode: 'quad' };
      }
      // Quad path requested but parent corners unavailable — fall through to
      // AABB path so we still produce SOME answer rather than bailing.
    }

    // AABB path (no rotation/skew anywhere up the chain).
    const parentRect = this.frozenParentRect || findNodeRect(parentId, vpId);
    if (!parentRect) return null;
    const transformVal = findNodeComputedStyle(parentId, vpId, 'transform');
    let inverseSelf: DOMMatrix | null = null;
    if (transformVal && transformVal !== 'none') {
      try {
        inverseSelf = new DOMMatrix(transformVal).inverse();
      } catch { /* identity */ }
    }
    const toLocal = (sx: number, sy: number): Point => {
      const relX = sx - parentRect.left;
      const relY = sy - parentRect.top;
      if (!inverseSelf) return { x: relX, y: relY };
      const local = new DOMPoint(relX, relY).matrixTransform(inverseSelf);
      return { x: local.x, y: local.y };
    };
    const sibAabb = (_sibId: string, sibRect: DOMRect): Rect => {
      if (!inverseSelf) {
        return { left: sibRect.left - parentRect.left, top: sibRect.top - parentRect.top, width: sibRect.width, height: sibRect.height };
      }
      const p1 = toLocal(sibRect.left, sibRect.top);
      const p2 = toLocal(sibRect.right, sibRect.top);
      const p3 = toLocal(sibRect.right, sibRect.bottom);
      const p4 = toLocal(sibRect.left, sibRect.bottom);
      const xs = [p1.x, p2.x, p3.x, p4.x];
      const ys = [p1.y, p2.y, p3.y, p4.y];
      const minX = Math.min(...xs); const maxX = Math.max(...xs);
      const minY = Math.min(...ys); const maxY = Math.max(...ys);
      return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    };
    return { toLocal, sibAabb, mode: 'aabb' };
  }

  /**
   * Get sibling DOMRects via bridge (screen-space).
   * Excludes dragged nodes, placeholders, canvas nodes, layout:: IDs, AND
   * any sibling that is `display:none` for the current vpId — a hidden
   * sibling has a 0×0 rect at its inline `left`/`top`, and including it
   * here surfaces a phantom reorder slot in the gap math (most visible
   * when reordering inside a primary viewport that has variant-only
   * children defined for tablet/mobile).
   */
  private getLayoutSiblingRects(excludeIds: Set<string>): { id: string; rect: DOMRect }[] {
    if (!this.parentNodeId) return [];

    const childRects = findVisibleChildRects(this.parentNodeId, this.currentVpId);
    const rects: { id: string; rect: DOMRect }[] = [];
    for (const child of childRects) {
      if (excludeIds.has(child.id)) continue;
      if (child.id.startsWith('layout::')) continue;
      const childNode = getNodeFromCache(child.id);
      if (childNode?.isCanvasNode) continue;
      // Skip absolute/fixed children (not layout participants)
      const pos = childNode?.styles?.position || '';
      if (pos === 'absolute' || pos === 'fixed') continue;
      rects.push(child);
    }
    // When editing the TEMPLATE itself (LayoutClient.tsx), the `{children}`
    // placeholder is a REAL reorderable sibling — the user moves sections
    // above/below it. `findVisibleChildRects` strips `children-slot` (correct
    // for PAGE editing, where the slot is the page-content region, not a reorder
    // target), so add it back here. Without it the reorder sees one fewer
    // sibling and can never position a section relative to the placeholder
    // (placeholder never moves). The commit then pins it at order 0 via
    // computeReorderAssignments. Matches `getLayoutChildIds`, which already
    // includes the slot (so neutralize counts it but reorder didn't — the bug).
    if (
      !excludeIds.has('children-slot') &&
      // findVisibleChildRects now includes the slot itself on template files
      // (2026-07-27) — this add-back stays only as a fallback for a slot the
      // rect walk missed, and must not duplicate an entry it already has.
      !rects.some(r => r.id === 'children-slot') &&
      isLayoutFile(getActiveFilePath()) &&
      this.getLayoutChildIds(this.parentNodeId).includes('children-slot')
    ) {
      const slotRect = findNodeRect('children-slot', this.currentVpId);
      if (slotRect) rects.push({ id: 'children-slot', rect: slotRect });
    }
    // FLOW-RANK SORT (1D): during a lifted drag the spaced-rank model
    // (`originalChildIndices` / `altDuplicateRanks`, written as !important
    // CSS `order` at lift) IS the authoritative visual order — geometric
    // axis sorting is only a proxy for it, and the proxy breaks when a
    // sibling's NEGATIVE MARGIN pulls it over its neighbour: the AABBs
    // overlap, the axis order inverts against the rank order, and the
    // placeholder model disagrees with the real flex layout (the reorder
    // oscillates on every tick and the drop lands at the wrong slot).
    // Sort by rank whenever every sibling has one; the geometric sorts
    // below stay as the fallback (and flex-wrap keeps its 2D row-major
    // ordering, where ranks don't encode line structure).
    if (!this.isWrapParent) {
      const rankOf = (id: string): number | null => {
        const r = this.originalChildIndices.get(id);
        if (r !== undefined) return rankToOrder(r);
        const d = this.altDuplicateRanks.get(id);
        if (d !== undefined) return rankToOrder(d);
        return null;
      };
      if (rects.length > 0 && rects.every(r => rankOf(r.id) != null)) {
        rects.sort((a, b) => rankOf(a.id)! - rankOf(b.id)!);
        return rects;
      }
    }
    // Sort by primary axis position so iteration matches visual order. After
    // the first reorder the strategy uses CSS `order: N` to reshuffle items
    // without rewriting the JSX, so NodeMap children order diverges from
    // visual order. calculateReorderIndex walks siblings sequentially expecting
    // visual order — without this sort, the second reorder lands one slot off
    // because siblings are iterated in their pre-reorder JSX order while
    // their rects sit at post-reorder visual positions.
    //
    // Use parent-local axis ordering (not screen-space `rect.top`/`rect.left`)
    // so the sort is correct under any cumulative ancestor transform. Under
    // pure rotation the post-transform AABBs of sequential children can
    // have nearly-identical screen `top` even though their painted centers
    // are staggered along the layout axis — sorting by screen AABB then
    // produces the wrong "visual order".
    const space = this.getParentLocalSpace();
    if (this.isWrapParent && space) {
      // ROW-MAJOR (flex-wrap): group into LINES by the CROSS axis, order within a
      // line by the MAIN axis — so the flat list matches the visual reading order
      // (left→right then wrap for row-wrap; top→bottom then wrap for column-wrap).
      // calculateReorderIndex + movePlaceholders both consume this order, so a 2D
      // drop lands at the correct flat index. Tolerance = half the smaller item's
      // cross size, so align-items variations don't split one line into two.
      const isColWrap = this.flexDirection === 'column';
      rects.sort((a, b) => {
        const la = space.sibAabb(a.id, a.rect);
        const lb = space.sibAabb(b.id, b.rect);
        const aCross = isColWrap ? la.left + la.width / 2 : la.top + la.height / 2;
        const bCross = isColWrap ? lb.left + lb.width / 2 : lb.top + lb.height / 2;
        const aMain = isColWrap ? la.top + la.height / 2 : la.left + la.width / 2;
        const bMain = isColWrap ? lb.top + lb.height / 2 : lb.left + lb.width / 2;
        const tol = Math.min(isColWrap ? la.width : la.height, isColWrap ? lb.width : lb.height) / 2;
        if (Math.abs(aCross - bCross) <= tol) return aMain - bMain;
        return aCross - bCross;
      });
    } else if (space) {
      const isColumn = this.flexDirection === 'column';
      rects.sort((a, b) => {
        const la = space.sibAabb(a.id, a.rect);
        const lb = space.sibAabb(b.id, b.rect);
        const ca = isColumn ? la.top + la.height / 2 : la.left + la.width / 2;
        const cb = isColumn ? lb.top + lb.height / 2 : lb.left + lb.width / 2;
        return ca - cb;
      });
    } else if (this.flexDirection === 'column') {
      rects.sort((a, b) => a.rect.top - b.rect.top);
    } else {
      rects.sort((a, b) => a.rect.left - b.rect.left);
    }
    return rects;
  }

  /**
   * Get layout child IDs from NodeMap (excludes absolute/fixed, canvas nodes, layout:: IDs).
   */
  private getLayoutChildIds(parentId: string): string[] {
    const parentNode = getNodeFromCache(parentId);
    if (!parentNode) return [];
    return parentNode.children.filter(childId => {
      if (childId.startsWith('layout::')) return false;
      const childNode = getNodeFromCache(childId);
      if (!childNode) return false;
      if (childNode.isCanvasNode) return false;
      const pos = childNode.styles?.position || '';
      if (pos === 'absolute' || pos === 'fixed') return false;
      return true;
    });
  }

  /**
   * Get the viewport/root ancestor's screen bounds (for exit detection).
   * Uses bridge rects via findNodeRect.
   */
  private getViewportScreenRect(): Rect | null {
    const vpNodeId = this.viewportNodeId || this.parentNodeId;
    if (!vpNodeId) return null;
    const bridgeRect = findNodeRect(vpNodeId, this.currentVpId);
    if (!bridgeRect) return null;
    // UNION with the root's direct children (sections) + the drag's source
    // parent — NOT the root box alone. An imported page root carries the
    // viewport's FIXED height (e.g. `height: '900px'` from the vp config)
    // while its sections overflow far below; the root box alone said
    // "outside the viewport" for any drag below that line, so exit-detection
    // fired on the FIRST move, the hit-test picked an overlapping frame from
    // another branch as a "new parent", and the gesture exit-committed +
    // switched to canvas before the placeholder ever showed — reorder inside
    // a below-the-fold layout was unreachable (user trace 2026-08-05,
    // `layout-lifted:exit-parent` 3ms after `drag:start`). The bounds that
    // mean "still over the page" are the CONTENT bounds.
    let left = bridgeRect.left, top = bridgeRect.top;
    let right = bridgeRect.left + bridgeRect.width, bottom = bridgeRect.top + bridgeRect.height;
    const union = (r: { left: number; top: number; width: number; height: number } | null) => {
      if (!r) return;
      left = Math.min(left, r.left); top = Math.min(top, r.top);
      right = Math.max(right, r.left + r.width); bottom = Math.max(bottom, r.top + r.height);
    };
    const rootNode = getNodeFromCache(vpNodeId);
    for (const childId of rootNode?.children ?? []) union(findNodeRect(childId, this.currentVpId));
    if (this.parentNodeId && this.parentNodeId !== vpNodeId) union(findNodeRect(this.parentNodeId, this.currentVpId));
    return { left, top, width: right - left, height: bottom - top };
  }

  /**
   * Walk up the NodeMap parent chain to find the top-level viewport ancestor.
   * Returns the ID of the viewport root node — the node whose `parentId` is
   * null (e.g. `'root'` for pages, the master root for components).
   *
   * The exit-detection in `onMove` uses THIS rect as "in-parent" — the
   * cursor must leave the entire viewport tree before placeholders hide.
   * Returning the immediate layout parent's frame instead (an earlier bug)
   * would hide placeholders the moment the cursor crossed into a sibling
   * section like `features` while still inside the page, breaking the
   * round-trip drag-back-into-source-hierarchy behavior.
   */
  private findViewportAncestorId(nodeId: string): string {
    let current = nodeId;
    // Walk up the parent chain via NodeMap to the root.
    for (let depth = 0; depth < 50; depth++) { // safety limit
      const node = getNodeFromCache(current);
      if (!node || !node.parentId) break;
      current = node.parentId;
    }
    return current; // topmost ancestor (root)
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  private cleanup(): void {
    this.dragSession = {};
    // Release the renderer drag-lock so subsequent source-triggered renders
    // (file switches, undo, etc.) patch styles on the formerly-lifted
    // nodes normally — without this they'd be permanently invisible to
    // patchElement until next page load.
    const bridge = getCanvasBridge();
    if ('setDragLockedNodeIds' in bridge) {
      (bridge as PostMessageBridge).setDragLockedNodeIds([]);
    }
    // Re-show the collection-list ghosts hidden on lift (ghost elements are
    // reused across renders, so their inline visibility must be cleared here).
    if (this.hiddenGhostsContainerId && 'setCollectionGhostsHidden' in bridge) {
      (bridge as PostMessageBridge).setCollectionGhostsHidden(this.hiddenGhostsContainerId, this.hiddenGhostsVpPrefix, false);
    }
    this.hiddenGhostsContainerId = null;
    this.hiddenGhostsVpPrefix = '';
    // Collection-list ghosts are clones of the template row, re-synced by the
    // Renderer's patch only when the row's DOM structure or CMS bindings move.
    // A reorder inside the row rewrites `order` styles — neither signal fires,
    // and an `updateStyles`-only flush is allowed to skip its render — so the
    // ghosts stayed stale (the just-dropped node missing from every ghost row)
    // until a page switch. Force ONE render on drop; the ghost pass re-clones.
    if (this.draggedInsideCollectionRow) {
      this.draggedInsideCollectionRow = false;
      trace.action('layout-lifted:force-collection-ghost-rebuild', {});
      // `flushAndForceStructuralRender` = flushNow() then rAF(forceCanvasRender())
      // — the shared helper with the proven frame-gap timing (CONTRIBUTING's
      // "Forcing a render after a structural write"). The flush lands the drop's
      // order/style mutations first so the rebuilt ghosts clone the FINAL row.
      flushAndForceStructuralRender();
    }
    // Restore the synced replicas hidden in the other viewports on drag start
    // (drop AND cancel both pass through here). EXCEPTION: the mid-drag
    // handoff to CanvasDragStrategy also runs cleanup() while the GESTURE is
    // still live — restoring there made the dragged node's other-viewport
    // twin pop back visible and shadow the rest of the drag as a duplicate
    // (replica → primary drag-out, 2026-08-05). The handoff sets
    // deferReplicaRestoreToDragEnd; the restore then transfers to the
    // DragCoordinator's drag-end reset (mouseup/cancel/detach), AFTER the
    // drop flush has removed the twins from the other viewports' DOM.
    if (this.deferReplicaRestoreToDragEnd
      && (this.hiddenReplicaSelector || this.hiddenReplicaOverlays.length > 0)) {
      const deferredSelector = this.hiddenReplicaSelector;
      const deferredOverlays = this.hiddenReplicaOverlays;
      this.hiddenReplicaSelector = null;
      this.hiddenReplicaOverlays = [];
      trace.action('layout-lifted:defer-replica-restore-to-drag-end', {
        overlays: deferredOverlays.length, hasSelector: !!deferredSelector,
      });
      registerDragEndRestore(() => {
        const endBridge = getCanvasBridge();
        if (deferredOverlays.length > 0 && 'patchStyles' in endBridge) {
          for (const h of deferredOverlays) {
            (endBridge as PostMessageBridge).patchStyles(h.id, h.vpPrefix, { display: '' }, true);
          }
        }
        if (deferredSelector) {
          removeCanvasCSS(deferredSelector);
          (endBridge as PostMessageBridge).repositionOverlays?.();
        }
      });
    }
    this.deferReplicaRestoreToDragEnd = false;
    if (this.hiddenReplicaOverlays.length > 0 && 'patchStyles' in bridge) {
      for (const h of this.hiddenReplicaOverlays) {
        (bridge as PostMessageBridge).patchStyles(h.id, h.vpPrefix, { display: '' }, true);
      }
      trace.action('layout-lifted:restore-synced-replica-overlays', { count: this.hiddenReplicaOverlays.length });
      this.hiddenReplicaOverlays = [];
    }
    if (this.hiddenReplicaSelector) {
      removeCanvasCSS(this.hiddenReplicaSelector);
      this.hiddenReplicaSelector = null;
      // …and re-place the overlays IMMEDIATELY. The measure funnel's replay is
      // settle-DEBOUNCED (150ms after the DOM stops mutating), which reads as
      // the overlay visibly catching up a beat after the node lands. Firing here
      // — the moment the drop restores the replicas — puts it in the same frame
      // as the reorder. The debounced pass stays as the backstop for a trigger
      // that keeps animating (framer-motion `layout` FLIP).
      (bridge as PostMessageBridge).repositionOverlays?.();
    }
    // RESTORE the pre-drag `order` on locked template sections we bracketed
    // during a templated-page section drag (covers cancel; the drop path
    // restores them atomically inside commitMergedOrder). Restoring — not
    // clearing — keeps the footer's MERGE bracket ('100013') intact with no
    // order-0 window (mobile footer-under-hero, 2026-07-28).
    if (this.bracketedLayoutSectionIds.size > 0 && 'patchStyles' in bridge) {
      const ph = getViewportPrefix(this.currentVpId);
      for (const id of this.bracketedLayoutSectionIds) {
        (bridge as PostMessageBridge).patchStyles(id, ph, { order: this.bracketedChromePrevOrders.get(id) ?? '' }, false);
      }
    }
    this.bracketedLayoutSectionIds.clear();
    this.bracketedChromePrevOrders.clear();
    this.removePlaceholdersViaBridge();
    this.placeholderIds.clear();
    this.nodeToPlaceholderId.clear();
    this.placeholderSpecs.clear();
    this.altDuplicateRanks.clear();
    this.parentNodeId = null;
    this.viewportNodeId = null;
    this.liftedPositions.clear();
    this.originalStyles.clear();
    this.originalChildIndices.clear();
    this.originalChildOrder = [];
    this.currentInsertIndex = -1;
    this.dragStartInsertIndex = -1;
    this.draggedFlowSize = 0;
    this.flowStartMin = null;
    this.intendedParentId = null;
    this.intendedInsertIndex = -1;
    this.isOverParent = true;
    this.isGridParent = false;
    this.isWrapParent = false;
    this.isExplicitGridPlacement = false;
    this.originalGridPlacements.clear();
    this.originalSiblingRects = [];
    this.originalOrderValues.clear();
    this.frozenParentRect = null;
    this.prevMouse = { x: 0, y: 0 };
    this.lastMovingForward = null;
    this.lastPlaceholderMoveTime = 0;
    this.currentVpId = 'desktop';
    this.siblingRectsReady = true;

    // Hide overlay indicators
    dropLineOps.hide();
    parentHighlightOps.hide();
  }
}
