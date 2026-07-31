// LayersPanel/drag.ts — the layer-tree drag-reorder handler, lifted verbatim from
// the `handleLayerDragStart` useCallback body in LayersPanel.tsx (Phase 7 god-file
// split, item 7.7). The component passes its state/refs via LayerDragContext; the
// handler body is unchanged.

import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import type { CanvasNode } from '@/code/parsing/parser';
import { flushNow, queueMutation } from '@/code/mutation/mutation-queue';
import { getContentRoot, isPrimaryViewport, findChildRects, findNodeComputedStyle, findNodeComputedStyles, forceRenderAfterExternalEdit } from '@/canvas/node-ops';
import { computeReorderAssignments, flexForFlowChildEnteringFlex } from '@/canvas/drag/reparent-utils';
import { commitOrderAssignments } from '@/canvas/drag/strategies/order-commit';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { queueReplicaCreationUnhide } from '@/canvas/creators/creator-utils';
import { detectParentLayoutById, getFlexDirectionById } from '@/canvas/drag/types';
import { queuePendingUpdates } from '@/canvas/arrow-nudge';
import { trace } from '@/shared/debug-trace';

export type DropIndicator = { layerId: string; nodeId: string; position: 'before' | 'after' | 'inside'; depth: number };

/** The viewport / variant PREFIX of a layer-row id. Row ids are viewport-prefixed
 *  (`"mobile:hero"`); viewport HEADER rows are `"__vp_mobile"`. Callers need the
 *  prefix to target the right tile — the bridge rect/corner caches are keyed
 *  `${vpPrefix}:${nodeId}`. (nodeIds are kebab-case and never contain ':'.) */
export function vpIdFromLayerId(layerId: string): string {
  return layerId.startsWith('__vp_') ? layerId.slice('__vp_'.length) : layerId.split(':')[0];
}

/** Auto-scroll delta (px/frame) for a cursor over the layers list during a drag.
 *  Negative = scroll up (cursor near/above the top edge), positive = scroll down
 *  (near/below the bottom). 0 when the cursor is in the middle or off the column.
 *  Speed ramps from ~0.2× at the inner edge of the band to full at the very edge
 *  (and stays full when the cursor is beyond the edge). Pure — unit-tested. */
export function computeEdgeAutoScrollDelta(
  clientX: number,
  clientY: number,
  rect: { left: number; right: number; top: number; bottom: number },
  zone = 52,
  maxSpeed = 16,
): number {
  if (clientX < rect.left - 24 || clientX > rect.right + 24) return 0;
  const topDist = clientY - rect.top;
  const botDist = rect.bottom - clientY;
  if (topDist < zone) return -maxSpeed * Math.min(1, Math.max(0.2, (zone - topDist) / zone));
  if (botDist < zone) return maxSpeed * Math.min(1, Math.max(0.2, (zone - botDist) / zone));
  return 0;
}

/** Everything the drag handler reads from the LayersPanel component: parsed nodes,
 *  viewport config, and the drag-state refs/setters. Row ids stay viewport-prefixed
 *  (`"desktop:features"`) — `layerId` vs the bare `nodeId` matters throughout. */
export interface LayerDragContext {
  nodes: Map<string, CanvasNode>;
  isCompMode: boolean;
  vpWidths: Record<string, number>;
  vpConfigs: Array<{ id: string; width: number; isPrimary: boolean }>;
  activeFilePath: string;
  dragStartPos: MutableRefObject<{ x: number; y: number } | null>;
  dragThresholdMet: MutableRefObject<boolean>;
  activeIdRef: MutableRefObject<string | null>;
  activeLayerIdRef: MutableRefObject<string | null>;
  dropIndicatorRef: MutableRefObject<DropIndicator | null>;
  setActiveId: (id: string | null) => void;
  setActiveLayerId: (id: string | null) => void;
  setDropIndicator: (d: DropIndicator | null) => void;
}

export function startLayerDrag(ctx: LayerDragContext, e: ReactMouseEvent, layerId: string, nodeId: string) {
  const {
    nodes, isCompMode, vpWidths, vpConfigs, activeFilePath,
    dragStartPos, dragThresholdMet, activeIdRef, activeLayerIdRef, dropIndicatorRef,
    setActiveId, setActiveLayerId, setDropIndicator,
  } = ctx;
    if (e.button !== 0) return;
    const node = nodes.get(nodeId);
    if (!node || node.fromLayout) return;

    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragThresholdMet.current = false;
    const startNodeId = nodeId;
    const startLayerId = layerId;

    // Auto-scroll the layers list while the drag hovers near its top/bottom
    // edge. A long list otherwise can't be scrolled during a drag without also
    // mouse-wheeling (the user's report). An RAF loop scrolls while the cursor
    // sits in the edge band — INCLUDING when the mouse is held still — reading
    // the latest cursor Y each frame; speed ramps up toward the very edge.
    // Started when the drag actually begins, cancelled on mouseup.
    const EDGE_ZONE = 52;      // px band at each edge that triggers scrolling
    const EDGE_MAX_SPEED = 12; // px/frame at the very edge (min ~0.2× inside the band)
    let scrollContainer: HTMLElement | null = null;
    let lastClientX = e.clientX;
    let lastClientY = e.clientY;
    let autoScrollRaf = 0;
    const autoScrollTick = () => {
      if (!dragStartPos.current) { autoScrollRaf = 0; return; } // drag ended
      const sc = scrollContainer;
      if (sc) {
        const dy = computeEdgeAutoScrollDelta(lastClientX, lastClientY, sc.getBoundingClientRect(), EDGE_ZONE, EDGE_MAX_SPEED);
        if (dy !== 0) sc.scrollTop += dy; // browser clamps to [0, max]
      }
      autoScrollRaf = requestAnimationFrame(autoScrollTick);
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStartPos.current) return;
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      if (!dragThresholdMet.current) {
        const dx = ev.clientX - dragStartPos.current.x;
        const dy = ev.clientY - dragStartPos.current.y;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        dragThresholdMet.current = true;
        setActiveId(startNodeId);
        activeIdRef.current = startNodeId;
        setActiveLayerId(startLayerId);
        activeLayerIdRef.current = startLayerId;
        document.body.style.cursor = 'grabbing';
        scrollContainer = document.querySelector('[data-layers-scroll]');
        if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollTick);
        trace.action('layers:drag-start', { nodeId: startNodeId, layerId: startLayerId });
      }

      if (!activeIdRef.current) return;

      const elements = document.elementsFromPoint(ev.clientX, ev.clientY);
      const layerEl = elements.find(el => {
        if (!el.hasAttribute('data-layer-id')) return false;
        // Page viewport header OR component-master VARIANT header (both
        // `__vp_*`, no node id) → a valid "drop inside" target. On a master,
        // dropping a canvas node onto a variant header inserts it into the
        // component tree and isolates it to that variant (handled in onMouseUp,
        // same way the canvas drag enters a variant). Previously variant
        // headers were rejected (`!isCompMode`) so the entrance went undetected.
        if ((el.getAttribute('data-layer-id') || '').startsWith('__vp_')) return true;
        // Normal node row — not the dragged node, not a header.
        const nid = el.getAttribute('data-layer-node-id');
        if (nid === null || nid === '' || nid === activeIdRef.current) return false;
        // TEMPLATE nodes (the merged `layout::…` header/footer/nav from the
        // page's Template) and the children-slot are NOT editable on a page —
        // they belong to the template's own file. Never a drop target here.
        if (nid.startsWith('layout::') || nid === 'children-slot') return false;
        return true;
      });

      if (!layerEl) { setDropIndicator(null); return; }

      // ── Viewport header → drop INSIDE the viewport, appended to the page
      // root as the LAST child. The page root is the top of the tree, so it's
      // never a descendant of the dragged node — no circular check needed.
      const hoveredLayerId = layerEl.getAttribute('data-layer-id') || '';
      if (hoveredLayerId.startsWith('__vp_')) {
        // Drop INSIDE the viewport / variant → append to its ROOT node.
        //  • Page: the page's REAL root is `root` (the merged template root on
        //    a templated page — NOT the synthetic `layout::root`, which has no
        //    entry in the file and a move there is lost / crashes).
        //  • Component master: the variant root is the PARENTLESS master
        //    element, which keeps its OWN data-id (e.g. `frame-…`), NOT `root`.
        //    Hardcoding `root` here made `nodes.get('root')` undefined in
        //    onMouseUp → the commit bailed and nothing inserted.
        let dropRootId = 'root';
        if (isCompMode) {
          for (const [id, n] of nodes) {
            if (!n.parentId && !n.isCanvasNode && n.type !== 'style' && !n.attrs?.['data-overlay']) { dropRootId = id; break; }
          }
        }
        setDropIndicator({ layerId: hoveredLayerId, nodeId: dropRootId, position: 'inside', depth: 0 });
        return;
      }

      const targetNodeId = layerEl.getAttribute('data-layer-node-id')!;
      const targetLayerId = layerEl.getAttribute('data-layer-id') || targetNodeId;
      const targetDepth = parseInt(layerEl.getAttribute('data-layer-depth') || '0', 10);
      const targetIsFrame = layerEl.getAttribute('data-layer-is-frame') === 'true';
      const targetNode = nodes.get(targetNodeId);
      if (!targetNode) { setDropIndicator(null); return; }

      // Circular reference check
      let check: string | undefined = targetNodeId;
      let isDescendant = false;
      while (check) {
        const n = nodes.get(check);
        if (!n) break;
        if (n.parentId === activeIdRef.current) { isDescendant = true; break; }
        check = n.parentId || undefined;
      }
      if (isDescendant) { setDropIndicator(null); return; }

      const rect = layerEl.getBoundingClientRect();
      const relativeY = ev.clientY - rect.top;
      const height = rect.height;
      const parent = targetNode.parentId ? nodes.get(targetNode.parentId) : null;
      const isLastChild = parent ? parent.children[parent.children.length - 1] === targetNodeId : false;
      const isComponentInstance = !!targetNode.componentFile;

      let position: 'before' | 'after' | 'inside';

      if (targetIsFrame && !isComponentInstance) {
        if (relativeY < height * 0.3) {
          position = 'before';
        } else if (isLastChild && relativeY > height * 0.7) {
          position = 'after';
        } else {
          position = 'inside';
        }
      } else {
        if (relativeY < height * 0.5) {
          position = 'before';
        } else {
          position = 'after';
        }
      }

      setDropIndicator({ layerId: targetLayerId, nodeId: targetNodeId, position, depth: targetDepth });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; }
      document.body.style.cursor = '';
      dragStartPos.current = null;

      const indicator = dropIndicatorRef.current;
      const draggedId = activeIdRef.current;
      activeIdRef.current = null;
      activeLayerIdRef.current = null;
      setActiveId(null);
      setActiveLayerId(null);
      setDropIndicator(null);

      if (!indicator || !draggedId) return;

      const draggedNode = nodes.get(draggedId);
      const targetNode = nodes.get(indicator.nodeId);
      if (!draggedNode || !targetNode) return;

      const contentEl = getContentRoot();
      if (!contentEl) return;

      trace.action('layers:drop', { draggedId, targetId: indicator.nodeId, targetLayerId: indicator.layerId, position: indicator.position });

      // Iframe mode: parent-frame DOM is empty, so the old moveNode/reorderNode
      // helpers (which look up elements via contentEl.querySelector) silently
      // bail. Queue mutations directly — the iframe Renderer will rebuild on
      // the next render cycle. flushNow() ensures any pending writes commit
      // before our structural change so the queue is consistent.
      //
      // Resolve {finalParentId, structuralInsertIndex, visualInsertIndex}:
      //   - `inside`        → new parent = drop target, insert at end
      //   - `before`/`after`→ new parent = drop target's parent, position
      //                       computed from sibling index
      // structuralInsertIndex is in JSX-children space (for `move`/`reorder`
      // mutations). visualInsertIndex is in CSS-order space (for the
      // order-commit pipeline below); under explicit `order` styles those
      // two diverge — we have to renumber based on what the user SAW.
      let finalParentId: string | null;
      let structuralInsertIndex: number;
      if (indicator.position === 'inside') {
        finalParentId = indicator.nodeId;
        const parent = nodes.get(finalParentId);
        structuralInsertIndex = parent ? parent.children.length : 0;
      } else {
        finalParentId = targetNode.parentId;
        if (!finalParentId) return;
        const parent = nodes.get(finalParentId);
        if (!parent) return;
        const siblingIndex = parent.children.indexOf(indicator.nodeId);
        if (siblingIndex === -1) return;
        structuralInsertIndex = indicator.position === 'after' ? siblingIndex + 1 : siblingIndex;
      }

      // Viewport id for this drop = the row's vp prefix (one layer row is
      // bound to one viewport; the user dragged within that viewport's tree).
      // We need it to (a) compute the visible-children sort same way the
      // canvas does, and (b) route order writes via commitOrderAssignments
      // (primary inline / page replica @container / variant conditional).
      const dropVpId = indicator.layerId.startsWith('__vp_')
        ? indicator.layerId.replace('__vp_', '')               // viewport-header drop
        : (indicator.layerId.split(':')[0] || 'desktop');      // node-row drop

      // If the target parent is a flex container OR an auto-placed grid,
      // CSS `order` decides paint order. Plain JSX `reorder`/`move` is
      // invisible whenever ANY sibling already carries an explicit `order`
      // — the new node lands at the default `order: 0` and stays at the
      // visual top regardless of where the user dropped. Mirror the
      // LayoutLiftedStrategy + arrow-nudge pipeline: compute desired visual
      // order, renumber every child sequentially, route via
      // commitOrderAssignments. Explicit grid placement
      // (`gridColumn: '1 / 3'`) ignores `order` — skip in that case
      // (matches the arrow-nudge guard).
      const parentLayout = detectParentLayoutById(finalParentId, dropVpId);
      let isOrderedLayout = parentLayout === 'flex';
      if (parentLayout === 'grid') {
        const gc = findNodeComputedStyle(finalParentId, dropVpId, 'gridColumn');
        if (!gc || gc === 'auto' || gc === 'auto / auto') isOrderedLayout = true;
      }

      flushNow();

      // ── Canvas-node ↔ tree boundary + replica routing — the SAME rules the
      // canvas drag strategy uses (CanvasDragStrategy + replica-context). ──
      const destNode = nodes.get(finalParentId);
      const destIsCanvas = !!destNode?.isCanvasNode;
      const sourceIsCanvas = !!draggedNode.isCanvasNode;

      // `canvasNode` flag for the move: true → land in the module-scope
      // `canvasNodes` fragment, false → land in the page tree (EXIT the
      // fragment — required when a canvas node enters a viewport, else it's
      // removed from the fragment but never inserted → lost node / crash),
      // undefined → ordinary tree↔tree move.
      const canvasNodeFlag: boolean | undefined =
        destIsCanvas ? true : (sourceIsCanvas ? false : undefined);

      const moveStyles: Record<string, string> = {};
      if (sourceIsCanvas && !destIsCanvas) {
        // Position the entering canvas node by the DESTINATION's layout — NOT
        // by page-vs-component. `parentLayout` was resolved above for the same
        // finalParentId + dropVpId.
        if (parentLayout === 'flex' || parentLayout === 'grid') {
          // FLEX / GRID container → the node must be a FLOW child to take part
          // in the layout. An absolute box (position:absolute + left/top) is
          // OUT of flow, so flex/grid ignores it and it floats over the corner
          // — the bug. Convert to relative + drop the inset (mirrors
          // `convertChildToRelative`). The order-commit pipeline below then
          // slots it at the visual drop index.
          moveStyles.position = 'relative';
          moveStyles.left = '';
          moveStyles.top = '';
          moveStyles.right = '';
          moveStyles.bottom = '';
        } else if (isCompMode) {
          // Component master with an ABSOLUTE root (children are absolutely
          // positioned) → keep position:absolute and land it at the variant's
          // top-left so it's visible — the canvas node's old canvas-space
          // left/top would resolve relative to the root and land off-screen.
          moveStyles.position = 'absolute';
          moveStyles.left = '0px';
          moveStyles.top = '0px';
        } else {
          // Page non-layout container → shed absolute canvas positioning so it
          // lands as a normal flow child (the layers tree is structural —
          // "last child", not a floating absolute box).
          moveStyles.position = '';
          moveStyles.left = '';
          moveStyles.top = '';
        }
      }
      // ── NO-LAYOUT DESTINATION → the child MUST be absolute-in-frame ──
      // A frame with neither flex nor grid positions its children by PINS. A
      // `relative` (or static) child there has no anchors at all, so it stacks at
      // the parent's top-left in source order — never where the drop meant. This
      // block previously only ran for `sourceIsCanvas`, so a TREE→TREE drop (a
      // node already in the viewport dragged into a no-layout frame) kept
      // `position: relative` and produced exactly that (live find 2026-07-25).
      //
      // Same rule the paste engine already enforces — `fixupPositionForParent`:
      // "No-layout parent → ALL children must be absolute-in-frame". Centre the
      // node in the destination so it lands visibly where the user aimed;
      // computed width/height are CSS px (unscaled), so no canvas-zoom math. A
      // cold cache reads 0 → fall back to the 0,0 anchors `ensureDefaultAnchors`
      // uses, which is still a valid pin.
      const destHasLayout = parentLayout === 'flex' || parentLayout === 'grid';
      if (!destHasLayout) {
        const pcs = findNodeComputedStyles(finalParentId, dropVpId, ['width', 'height']);
        const ncs = findNodeComputedStyles(draggedId, dropVpId, ['width', 'height']);
        const pw = parseFloat(pcs.width) || 0;
        const ph = parseFloat(pcs.height) || 0;
        const nw = parseFloat(ncs.width) || 0;
        const nh = parseFloat(ncs.height) || 0;
        moveStyles.position = 'absolute';
        moveStyles.left = `${Math.max(0, Math.round((pw - nw) / 2))}px`;
        moveStyles.top = `${Math.max(0, Math.round((ph - nh) / 2))}px`;
        // Clear the OTHER axis anchors: keeping a stale `right`/`bottom` next to
        // the new left/top pins both edges and stretches the node.
        moveStyles.right = '';
        moveStyles.bottom = '';
        trace.action('layers:drop-into-no-layout-absolute', {
          draggedId, finalParentId, dropVpId, parentLayout,
          left: moveStyles.left, top: moveStyles.top, pw, ph, nw, nh,
        });
      }

      // Any node entering a FLEX parent must be pinned to `0 0 auto` unless it
      // already sizes itself — a flow child with no explicit flex defaults to
      // shrink:1 and collapses to ~0 (the "disappears on drop into a flex
      // layout" bug). Applies to BOTH canvas nodes and tree rows dragged into a
      // flex child (drop `inside` OR before/after a flex sibling).
      const enterFlex = flexForFlowChildEnteringFlex(draggedNode.styles, parentLayout);
      if (enterFlex) moveStyles.flex = enterFlex;
      // A canvas node (present in NO viewport) entering a NON-PRIMARY page
      // replica should appear ONLY there — same as the canvas drag. Hide it on
      // the base here; the entered viewport's `@container` unhides it below. (A
      // normal tree node is already shared across every viewport — a structural
      // reorder must NOT silently hide it elsewhere, so it's excluded.)
      const enteringReplica = sourceIsCanvas && !isPrimaryViewport(dropVpId) && !isCompMode && !destIsCanvas;
      if (enteringReplica) moveStyles.display = 'none';
      // Component-master equivalent: a canvas node dropped onto a NON-PRIMARY
      // VARIANT header is isolated to that variant via setVariantVisibility
      // (AnimatePresence conditional render — see variant-visibility-gen). NO
      // inline display:none here: on a component file that freezes into
      // `variants.default`; the variant system owns visibility. Mirrors the
      // canvas drag's hideInAllOthers branch for component files. Dropping onto
      // the PRIMARY (default) variant keeps it as the shared base (shows in all
      // variants), exactly like dropping into a primary page viewport.
      const enteringVariant = sourceIsCanvas && !isPrimaryViewport(dropVpId) && isCompMode && !destIsCanvas;

      const moveExtras = {
        ...(Object.keys(moveStyles).length > 0 ? { styles: moveStyles } : {}),
        ...(canvasNodeFlag !== undefined ? { canvasNode: canvasNodeFlag } : {}),
      };

      // Structural mutation always runs — keeps JSX coherent for the parser,
      // codegen, and undo/redo even when CSS `order` does the visible work.
      if (indicator.position === 'inside') {
        // Pass the explicit end index. Moving to the page root ('root') with
        // NO index hits moveNodeInCode's "exit to canvas" special case
        // (isMovingToRoot) and re-stamps `data-canvas-node` — turning the node
        // into a canvas node instead of a child. An index = child insert.
        queueMutation({ type: 'move', nodeId: draggedId, newParentId: finalParentId, index: structuralInsertIndex, ...moveExtras });
      } else if (draggedNode.parentId === finalParentId) {
        queueMutation({ type: 'reorder', nodeId: draggedId, parentId: finalParentId, index: structuralInsertIndex });
      } else {
        queueMutation({ type: 'move', nodeId: draggedId, newParentId: finalParentId, index: structuralInsertIndex, ...moveExtras });
      }

      // Replica visibility — a canvas node entering a non-primary viewport
      // shows ONLY there. Same sequence as the canvas drag entry:
      //   1. base inline `display:'none'` (set in moveStyles above) hides it
      //      on every viewport by default,
      //   2. RESTORE its natural display in the entered viewport's @container
      //      (NOT '' — that just clears the override and the base none then
      //      hides it everywhere, the bug we're fixing) so it shows there,
      //   3. explicit @container hide on every OTHER replica (primary already
      //      covered by the inline none), and
      //   4. a `data-replica-solo` marker so later edits on this vp author the
      //      base values until it's unhidden elsewhere.
      if (enteringReplica) {
        const enteredVpWidth = vpWidths[dropVpId] ?? vpConfigs.find(v => v.id === dropVpId)?.width ?? 0;
        queueReplicaCreationUnhide(draggedId, dropVpId, enteredVpWidth, draggedNode.styles?.display ?? '');
        const rctx = getReplicaContext(dropVpId, activeFilePath, vpWidths);
        for (const hideUpdate of rctx.hideInAllOthers(draggedId)) {
          if (hideUpdate.type === 'updateContainerStyle') {
            const tgt = Object.keys(vpWidths).find(k => vpWidths[k] === hideUpdate.maxWidth);
            if (tgt && isPrimaryViewport(tgt)) continue; // inline display:none covers primary
          }
          queueMutation(hideUpdate as any);
        }
        queueMutation({ type: 'updateHtmlAttrs', nodeId: draggedId, attrs: { 'data-replica-solo': dropVpId } });
      }

      // Component-master variant isolation. The move above inserted the canvas
      // node into the component tree (shared by ALL variants); now restrict it
      // to the dropped variant by hiding it in every OTHER variant. The replica
      // context emits a single `setVariantVisibility` (AnimatePresence wrap) for
      // component files — the exact mutation the canvas drag uses.
      if (enteringVariant) {
        const rctx = getReplicaContext(dropVpId, activeFilePath, vpWidths);
        for (const hideUpdate of rctx.hideInAllOthers(draggedId)) {
          queueMutation(hideUpdate as any);
        }
        trace.action('layers:drop-canvas-into-variant', { draggedId, variant: dropVpId });
      }

      if (isOrderedLayout) {
        // Build desired visual order. The current visual order comes from
        // the bridge rect cache (same source LayoutLiftedStrategy and
        // arrow-nudge use), sorted on the parent's primary axis. Remove
        // the dragged id if it's already a child of finalParentId, then
        // insert it at the user-visible drop slot.
        const flexDir = getFlexDirectionById(finalParentId, dropVpId);
        const currentVisualIds = findChildRects(finalParentId, dropVpId)
          .slice()
          .sort((a, b) => flexDir === 'row' ? a.rect.left - b.rect.left : a.rect.top - b.rect.top)
          .map(c => c.id)
          .filter(id => !id.startsWith('layout::'));

        const withoutDragged = currentVisualIds.filter(id => id !== draggedId);

        // visualInsertIndex: for `inside`, append; for `before`/`after`,
        // anchor relative to the target id's position in the CURRENT visual
        // order (NOT the JSX index — under CSS `order` they may differ).
        let visualInsertIndex: number;
        if (indicator.position === 'inside') {
          visualInsertIndex = withoutDragged.length;
        } else {
          const targetVisualIndex = withoutDragged.indexOf(indicator.nodeId);
          if (targetVisualIndex === -1) {
            // Indicator node isn't a visible child (e.g. hidden by display:none
            // for this viewport, or filtered as layout::). Fall back to
            // structural index — at least the JSX reorder lands somewhere.
            visualInsertIndex = withoutDragged.length;
          } else {
            visualInsertIndex = indicator.position === 'after' ? targetVisualIndex + 1 : targetVisualIndex;
          }
        }

        const desired = [
          ...withoutDragged.slice(0, visualInsertIndex),
          draggedId,
          ...withoutDragged.slice(visualInsertIndex),
        ];

        const assignments = computeReorderAssignments(desired);
        // The `default` branch of the per-variant order ternary must PRESERVE the
        // PRIMARY tile's order. Read the DEFAULT tile's current visual order — NOT
        // `currentVisualIds`, which is the VARIANT tile being reordered: once the
        // variant's order diverges from the primary, using it makes the default
        // branch MIRROR the variant → the primary syncs to it on every drag (the
        // reported bug: `order: … ? 2 : 3` / `? 3 : 2` swapped the primary too).
        // Only the component-variant commit branch consumes this; a primary or
        // page-replica reorder leaves it undefined (its branch doesn't use it).
        let defaultOrders: Map<string, number> | undefined;
        if (isCompMode && !isPrimaryViewport(dropVpId)) {
          const primaryVisualIds = findChildRects(finalParentId, 'default')
            .slice()
            .sort((a, b) => flexDir === 'row' ? a.rect.left - b.rect.left : a.rect.top - b.rect.top)
            .map(c => c.id)
            .filter(id => !id.startsWith('layout::'));
          if (primaryVisualIds.length > 0) {
            defaultOrders = new Map(primaryVisualIds.map((id, i) => [id, i] as const));
          }
        }
        const updates = commitOrderAssignments(assignments, contentEl, dropVpId, defaultOrders);
        trace.action('layers:drop-order-commit', {
          finalParentId, dropVpId, flexDir, visualInsertIndex, desired,
          updateCount: updates.length,
        });
        queuePendingUpdates(updates);
      }

      // FORCE THE RENDER. A Layers-panel drop only queues mutations — unlike a
      // CANVAS drag it never patches the DOM imperatively, so the render-skip
      // that path depends on leaves the reorder invisible: the code is right, the
      // canvas is stale until a page switch or reload rebuilds it (the reported
      // bug). `move`/`reorder` are structural, so they aren't in the
      // render-resolved set `onBeforeFlush` consults either. Live find
      // 2026-07-25.
      forceRenderAfterExternalEdit('layers-panel:drop', {
        draggedId, finalParentId, dropVpId, position: indicator.position,
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}
