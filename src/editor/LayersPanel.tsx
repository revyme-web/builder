// LayersPanel.tsx — Tree view of all nodes on the canvas.
// Exact styling from old builder's optimized-layers.tsx.
// Click to select (syncs with canvas), expand/collapse, drag to reorder/reparent.
// Uses node-ops for all mutations (imperative-first pattern).

import React, { useState, useCallback, useRef, useMemo, useEffect, useDeferredValue } from 'react';
import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { nodesAtom, selectedNodeAtom, selectedIdsAtom, isMapTemplateSelectedAtom, layerDropTargetAtom, nodeTreeStructureVersionAtom, getCachedNodesMap } from '@/code/stores/store';
import { activeFilePathAtom, isComponentFilePath, isComponentLikeFilePath, isIconSetFilePath, getLayoutForPage, getLayoutClientPath } from '@/code/project/active-file-store';
import { flushNow } from '@/code/mutation/mutation-queue';
import { visibleViewportsAtom, interactingViewportIdAtom, viewportsConfigAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { activeLocaleAtom, isDefaultLocaleAtom } from '@/code/stores/locale-store';
import { getContentRoot, updateNodeStyles, setStyleContext, isPrimaryViewport, flushAndForceStructuralRender, redirectToFitTextWrapper } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { renameVariant } from '@/code/variants/variant-ops';
import { toggleLock } from '@/canvas/commands';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';
import { contextMenuAtom, renamingNodeIdAtom } from '@/code/stores/context-menu-store';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import SectionLabel from '@/design-system/SectionLabel';
import SearchBar from '@/design-system/SearchBar';
import PageSelector from '@/editor/left-toolbar/panels/PageSelector';
import ToolDivider from '@/editor/controls/ToolDivider';

// Row components + pure helpers, the drag-reorder handler, and the search filter
// live in LayersPanel/ (Phase 7 god-file split, item 7.7). computeSelectionSets +
// FlatLayer are re-exported below for existing importers of this module.
import { LayerRow, computeSelectionSets, isNodeUnderOverlay, resolveDisplayForLayer, sortChildrenByVisualOrder, type FlatLayer } from './LayersPanel/rows';
import { startLayerDrag, vpIdFromLayerId } from './LayersPanel/drag';
import { filterLayersForSearch } from './LayersPanel/search';

export { computeSelectionSets, type FlatLayer } from './LayersPanel/rows';

// ─── Component ──────────────────────────────────────────────────────────────

export default function LayersPanel() {
  // DEFERRED tree source: LayersPanel rebuilds its whole tree (several
  // whole-map memos over ~860 nodes on a big page) on every commit. Doing
  // that inside the URGENT render pass kept the main thread busy after a
  // drop — and since the canvas sandbox iframe shares this event loop, the
  // iframe's render task (the thing that makes the drop visually land)
  // couldn't run until the tree rebuild finished. useDeferredValue moves the
  // rebuild into a deferred pass that React schedules AFTER urgent work
  // yields — the canvas paints first, the layer rows catch up a beat later.
  const parsedNodesUrgent = useAtomValue(nodesAtom);
  const parsedNodes = useDeferredValue(parsedNodesUrgent);
  // LIVE mid-drag re-nesting: reparent commits during a drag do NOT re-derive
  // nodesAtom (the deferred-drag-flush stashes the whole setCode fan-out —
  // 100ms+ parse per flush on big imports), but the drag strategies keep the
  // IMPERATIVE node cache authoritative at every enter/exit commit and bump
  // `nodeTreeStructureVersionAtom`. Deriving the tree from the cache makes the
  // rows re-nest the moment an element enters/leaves a frame, with zero
  // parse. The cache is refreshed from every parse, so outside drags it
  // equals parsedNodes.
  const structureVersion = useAtomValue(nodeTreeStructureVersionAtom);
  const nodes = useMemo(() => {
    const cached = getCachedNodesMap();
    return cached.size > 0 ? cached : parsedNodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedNodes, structureVersion]);
  // Viewers may browse the layer tree and single-click to select a node
  // for inspection, but every edit affordance — drag-reorder, double-
  // click rename, context menu, lock/visibility toggles — is disabled.
  const isViewer = useIsViewer();
  const viewports = useAtomValue(visibleViewportsAtom);
  const [interactingVpId, setInteractingVpId] = useAtom(interactingViewportIdAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  // Overlay-edit mode: clicking an overlay row enters it (like the Overlay
  // tool's chip); an overlay's children only show in the tree while its
  // overlay is the one being edited.
  const [editingOverlayId, setOverlayEditingId] = useAtom(overlayEditingIdAtom);
  const isMapTemplate = useAtomValue(isMapTemplateSelectedAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const isCompMode = isComponentFilePath(activeFilePath);
  // COLOR/icon only: a template (LayoutClient) is component-LIKE, so its layer
  // rows use the purple accent-secondary just like a component master — but its
  // viewport/order/visibility LAYOUT stays page-like (`isCompMode`), since a
  // template renders Desktop/Tablet/Mobile viewports, not variant columns.
  const isCompLikeMode = isComponentLikeFilePath(activeFilePath);
  // Per-viewport visibility resolution: read the parsed @media overrides
  // (page replicas) and the full viewport config (sizes + isPrimary) so each
  // layer row can reflect its viewport-specific display state, not just the
  // base node.styles.
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const vpConfigs = useAtomValue(viewportsConfigAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  // Auto-expand all viewport headers + root by default
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    new Set(['root', ...viewports.map(v => `__vp_${v.id}`)])
  );
  // Layer search: when non-empty, the walk treats every collapsed row as
  // expanded so matches deep inside a closed subtree still surface. The
  // visible list is then filtered to (matches ∪ ancestors-of-matches ∪
  // viewport headers) below in `displayLayers`. Clearing the input
  // restores the user's manual expand state untouched — we never write
  // to the `expanded` set during search.
  const [layerSearchQuery, setLayerSearchQuery] = useState('');
  const layerSearchActive = layerSearchQuery.trim().length > 0;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ layerId: string; nodeId: string; position: 'before' | 'after' | 'inside'; depth: number } | null>(null);
  // Optimistic eye-icon state (nodeId → isHidden). The eye indicator falls back to
  // the bridge computed-cache, which is STALE for a few ms after a visibility toggle
  // (the canvas re-renders async), so without this the eye only flips on the NEXT
  // unrelated re-render (e.g. clicking elsewhere). On toggle we record the INTENDED
  // state for an instant flip, then clear it once the canvas render has settled so
  // the indicator reconciles with the real (now-fresh) resolved + bridge state.
  const [optimisticVis, setOptimisticVis] = useState<Map<string, boolean>>(() => new Map());
  const dropIndicatorRef = useRef(dropIndicator);
  dropIndicatorRef.current = dropIndicator;

  // Mirror the drop indicator to the canvas: when the tree shows a drop-INSIDE
  // over a layer, outline that node on the canvas so the user sees which
  // container will receive the layer. before/after (sibling reorders) don't
  // highlight a container. vpId comes from the viewport-prefixed layerId
  // (`"mobile:hero"` / `"__vp_mobile"`), same parse as handleSelect.
  const setLayerDropTarget = useSetAtom(layerDropTargetAtom);
  useEffect(() => {
    if (dropIndicator?.position === 'inside') {
      setLayerDropTarget({ nodeId: dropIndicator.nodeId, vpId: vpIdFromLayerId(dropIndicator.layerId) });
    } else {
      setLayerDropTarget(null);
    }
  }, [dropIndicator, setLayerDropTarget]);
  // Belt-and-suspenders: clear the highlight if the panel unmounts mid-drag.
  useEffect(() => () => setLayerDropTarget(null), [setLayerDropTarget]);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragThresholdMet = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const activeLayerIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Find root nodes (no parentId, not style elements)
  const rootNodeIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id, node] of nodes) {
      if (!node.parentId && node.type !== 'style') ids.push(id);
    }
    return ids;
  }, [nodes]);

  // Cache: reuse FlatLayer objects when their content hasn't changed.
  // This makes React.memo on LayerRow actually work — when only `expanded` changes
  // (from auto-expand on click), rows that didn't change keep their old reference.
  const layerCacheRef = useRef(new Map<string, FlatLayer>());
  const vpHeaderCacheRef = useRef(new Map<string, { layer: FlatLayer; childCount: number }>());

  function cachedLayer(id: string, nodeId: string | null, node: CanvasNode, depth: number,
    hasChildren: boolean, isExpanded: boolean, vpId: string,
    vpLabel?: string, vpWidth?: number): FlatLayer {
    const prev = layerCacheRef.current.get(id);
    if (prev && prev.node === node && prev.depth === depth &&
        prev.hasChildren === hasChildren && prev.isExpanded === isExpanded) {
      return prev;
    }
    const layer: FlatLayer = { id, nodeId, node, depth, hasChildren, isExpanded, viewportId: vpId };
    if (vpLabel) layer.viewportLabel = vpLabel;
    if (vpWidth) layer.viewportWidth = vpWidth;
    // CMS collection-list icons (mirrors the reference): the container that holds the
    // `.map()` gets the stacked CMS icon; the template ROW root (a template
    // node whose PARENT is the container, i.e. not itself nested in a template)
    // gets the single-cylinder item icon. Descendants keep their type icon.
    if (node.collectionList) layer.isCmsContainer = true;
    else if (node.isCollectionTemplate && node.parentId && !!nodes.get(node.parentId)?.collectionList) {
      layer.isCmsItem = true;
    }
    layerCacheRef.current.set(id, layer);
    return layer;
  }

  // Flatten tree: viewport headers → root nodes → children
  // Each node row gets a viewport-prefixed ID (e.g. "desktop:features") so
  // selecting in one viewport doesn't highlight the same node in other viewports.
  const layers = useMemo(() => {
    const result: FlatLayer[] = [];

    // Overlays (fixed/relative) are portaled as SIBLINGS of their trigger in the
    // JSX — usually the page `root`'s last child — so `parentId` places them at
    // the wrong spot in the tree. Show them nested under their TRIGGER SOURCE
    // instead (the node whose `data-overlay.triggerId` points at it), INCLUDING
    // when that source is a component instance (e.g. a <Header/>). Index the
    // trigger→overlays link here; `walk` surfaces the overlay under its trigger
    // and the collection loops below drop it from its raw parent position. This
    // covers BOTH fixed and relative overlays, AND canvas-node overlays (a
    // relative overlay dragged out with its trigger becomes a `data-canvas-node`
    // overlay — it must still nest under its source, not sit loose in the canvas
    // section). An orphan overlay whose trigger no longer exists keeps its
    // natural spot (so it's never lost).
    const overlaysByTrigger = new Map<string, string[]>();
    const reparentedOverlayIds = new Set<string>();
    for (const [ovId, ovNode] of nodes) {
      const raw = ovNode.attrs?.['data-overlay'];
      if (!raw) continue;
      let triggerId: string | undefined;
      try { triggerId = JSON.parse(raw).triggerId; } catch { continue; }
      if (!triggerId || !nodes.has(triggerId)) continue;
      let arr = overlaysByTrigger.get(triggerId);
      if (!arr) { arr = []; overlaysByTrigger.set(triggerId, arr); }
      arr.push(ovId);
      reparentedOverlayIds.add(ovId);
    }

    function walk(nodeId: string, depth: number, vpId: string) {
      const node = nodes.get(nodeId);
      if (!node) return;
      if (node.type === 'style') return;

      // FIT text SVG wrapper: flatten to show the inner text element directly.
      // Skip the SVG and foreignObject layers — show the inner <p>/<h1>/etc at this depth.
      if (node.type === 'svg' && nodeId.endsWith('-svg')) {
        // Walk through foreignObject children to find the actual text element
        for (const foId of node.children) {
          const foNode = nodes.get(foId);
          if (!foNode) continue;
          if (foNode.type === 'foreignObject') {
            for (const innerId of foNode.children) {
              walk(innerId, depth, vpId);
            }
          } else {
            walk(foId, depth, vpId);
          }
        }
        return;
      }
      // Skip foreignObject itself (shouldn't appear alone, but safety net)
      if (node.type === 'foreignObject') return;

      const rowId = `${vpId}:${nodeId}`;
      // Component instances are ALWAYS shown as leaf nodes in the layers
      // panel — both on pages AND when editing a parent component file. The
      // parser expands every instance into the wrapper + the resolved root
      // (id `instanceId:rootId`) so the renderer can paint the component
      // contents, but layers should treat the wrapper as the user-facing
      // unit. Recursing into `node.children` would surface the expanded
      // root as a second row (it shares the wrapper's `data-name`, so the
      // user sees "Frame" twice with the same icon — confusing). Double-
      // click on the instance still opens its source file to edit inside.
      //
      // Skip expanded component roots themselves too — if anything walks
      // into one, render its subtree without an extra row for the root.
      // (This guards against any path that bypasses the instance check
      // above, e.g. component-mode root iteration.)
      if (node.componentInstanceId && node.isComponentRoot) {
        for (const childId of sortChildrenByVisualOrder(node, node.children, vpId, nodes, vpConfigs, containerOverrides, isCompMode)) {
          walk(childId, depth, vpId);
        }
        return;
      }
      const isComponentInstance = !!node.componentFile && !node.componentInstanceId;
      // Sketch wrappers (`<svg data-sketch="true">`) host brush-stroke
      // <path> children — but to the user those strokes are paint, not
      // structural elements. Showing each stroke as its own layer row
      // makes a 50-stroke sketch look like a 50-row tree, which is
      // useless for selection (you can't click an individual stroke
      // meaningfully) and noise in the layers panel. Treat the sketch
      // as a leaf — same UX as a CDN-linked component instance.
      // The path nodes still exist in `node.children` for the Renderer
      // and for sketch-edit-mode bbox computation; we just don't
      // surface them in this panel.
      const isSketch = node.type === 'svg'
        && (node.attrs?.['data-sketch'] === 'true' || node.name === 'Sketch');
      // An svg SHAPE (a "Triangle" = `<svg><polygon/></svg>`, or an imported
      // `<svg><g><rect/><path/></g></svg>`) is a LEAF in the layers. Its inner
      // geometry (polygon/path/rect/g/circle/…) is paint, not a structural
      // layer you select — surfacing each as its own row is the same noise as
      // the per-stroke sketch case, and editing geometry happens through
      // shape-edit mode (double-click), not by selecting the inner element.
      // A shape is told apart from an svg GROUP by its children: a GROUP nests
      // `<svg>` wrappers (each a real layer row), a SHAPE nests only geometry.
      // So: an svg with NO svg-type child is a shape → leaf. The geometry
      // nodes still exist in `node.children` for the Renderer and shape-edit
      // bbox; we just don't surface them here.
      const isSvgShapeLeaf = node.type === 'svg'
        && !isSketch
        && node.children.length > 0
        && !node.children.some((cid) => nodes.get(cid)?.type === 'svg');
      const isLeafForced = isComponentInstance || isSketch || isSvgShapeLeaf;
      // Overlays are re-parented under their trigger (below), so drop them from
      // this node's real-children set — else an overlay authored directly under
      // its trigger would render twice (once here, once via overlaysByTrigger).
      const realChildren = node.children.filter((cid) => !reparentedOverlayIds.has(cid));
      // An overlay's inner children stay HIDDEN in the tree unless its overlay is
      // the one currently being edited — matching the canvas, where overlay
      // contents only render in overlay mode. Click the overlay row to enter it.
      const isOverlayNode = !!node.attrs?.['data-overlay'];
      const overlayChildrenHidden = isOverlayNode && editingOverlayId !== nodeId;
      const hasRealChildren = !isLeafForced && !overlayChildrenHidden && realChildren.length > 0;
      // A node that TRIGGERS an overlay shows it as a child — even a component
      // instance, which is otherwise a forced leaf.
      const ownsOverlay = overlaysByTrigger.has(nodeId);
      const hasChildren = hasRealChildren || ownsOverlay;
      // Search override: while the layer search is active, every row is
      // treated as expanded so matches hidden inside a closed subtree
      // still surface in the flat list (the filter pass below trims
      // back to matches + their ancestors). Clearing the search restores
      // the user's manual `expanded` state untouched — we never write to
      // that set during search.
      const isExp = expanded.has(rowId) || layerSearchActive;
      result.push(cachedLayer(rowId, nodeId, node, depth, hasChildren, isExp, vpId));

      if (isExp && hasRealChildren) {
        for (const childId of sortChildrenByVisualOrder(node, realChildren, vpId, nodes, vpConfigs, containerOverrides, isCompMode)) {
          walk(childId, depth + 1, vpId);
        }
      }
      // Surface triggered overlays as children of the trigger source node.
      if (isExp && ownsOverlay) {
        for (const ovId of overlaysByTrigger.get(nodeId)!) {
          walk(ovId, depth + 1, vpId);
        }
      }
    }

    // Collect page children + canvas-node roots.
    //
    // `rootNodeIds` contains every node with no parentId — that includes BOTH
    // the page root ("root") AND every top-level canvas-node frame from the
    // `const canvasNodes = (<>...</>)` fragment (parser sets `parentId: null`
    // and `isCanvasNode: true` on those). Children of a canvas-node frame
    // inherit `isCanvasNode: false` (parser.ts:1220), so the previous logic —
    // which classified each rootNode's children by their own `isCanvasNode`
    // flag — pushed the canvas-node frame's CHILDREN into `pageChildren` and
    // never added the canvas-node frames themselves anywhere. Result: the
    // canvas frame disappeared from layers and its inner text showed up
    // under each viewport's tree instead.
    //
    // Correct shape: a top-level canvas-node frame goes straight into
    // `canvasChildren`; only the actual page root contributes to
    // `pageChildren` (flattened so its kids show directly under viewports).
    const pageChildren: string[] = [];
    const canvasChildren: string[] = [];
    for (const rootId of rootNodeIds) {
      const rootNode = nodes.get(rootId);
      if (!rootNode) continue;
      if (reparentedOverlayIds.has(rootId)) continue; // canvas-node overlay → shown under its trigger
      // Top-level canvas-node frame — show at the end (its children walk
      // recursively below).
      if (rootNode.isCanvasNode) {
        canvasChildren.push(rootId);
        continue;
      }
      // Otherwise this is a page-tree root. Flatten its direct children
      // into the per-viewport list — handle both `data-id="root"` (id is
      // literally 'root') and any wrapper that contains a 'root' child.
      for (const childId of rootNode.children) {
        const child = nodes.get(childId);
        if (!child) continue;
        if (reparentedOverlayIds.has(childId)) continue; // shown under its trigger
        // Defensive: if a canvas-node ever ends up nested under root, still
        // surface it at the end rather than per-viewport.
        if (child.isCanvasNode) {
          canvasChildren.push(childId);
          continue;
        }
        if (childId === 'root') {
          // Flatten the "Page" wrapper — show root's grandchildren directly.
          const pageRoot = nodes.get('root');
          if (pageRoot) {
            for (const pageChildId of pageRoot.children) {
              if (reparentedOverlayIds.has(pageChildId)) continue; // shown under its trigger
              const pageChild = nodes.get(pageChildId);
              if (pageChild?.isCanvasNode) canvasChildren.push(pageChildId);
              else pageChildren.push(pageChildId);
            }
          }
          continue;
        }
        pageChildren.push(childId);
      }
    }

    // Component mode: show each variant as a header with its children underneath
    // Each variant maps to a viewport entry from visibleViewportsAtom.
    // All variants share the same node tree — the renderer creates separate viewport containers.
    const isComponentMode = isComponentFilePath(activeFilePath);
    if (isComponentMode) {
      // Build the variant children list. The page-mode collection loop
      // ABOVE already populated `canvasChildren` from the same
      // `rootNodeIds` — re-adding here would double up (one canvas-node
      // becomes two layer rows). Skip canvas-node roots entirely; they're
      // already routed to the canvas section at the end of the panel.
      // The variant master root is whatever's left.
      const variantChildren: string[] = [];
      for (const rootId of rootNodeIds) {
        const rootNode = nodes.get(rootId);
        if (!rootNode) continue;
        if (rootNode.type === 'style') continue;
        if (rootNode.isCanvasNode) continue; // already in canvasChildren
        if (rootId === 'root') {
          // Root wrapper — variant children are root's non-canvas children
          for (const childId of rootNode.children) {
            const child = nodes.get(childId);
            if (child && !child.isCanvasNode && !reparentedOverlayIds.has(childId)) variantChildren.push(childId);
          }
        } else if (rootNode.children.includes('root')) {
          const pageRoot = nodes.get('root');
          if (pageRoot) {
            for (const childId of pageRoot.children) {
              const child = nodes.get(childId);
              if (child && !child.isCanvasNode && !reparentedOverlayIds.has(childId)) variantChildren.push(childId);
            }
          }
        } else {
          variantChildren.push(rootId);
        }
      }

      // Show each variant as a collapsible header (like viewport headers on pages)
      // The variant header IS the master root visually — when expanded we walk
      // the master root's CHILDREN (depth 1), not the master root itself.
      // hasChildren must therefore reflect whether ANY entry in
      // `variantChildren` has actual children to show. A single-root component
      // with no inner JSX still has variantChildren = [masterRoot] (length 1)
      // but renders nothing on expand — chevron must not appear.
      const variantHasRenderableChildren = variantChildren.some(id => {
        const n = nodes.get(id);
        return !!n && n.children.length > 0;
      });
      for (const vp of viewports) {
        const vpRowId = `__vp_${vp.id}`;
        // See the comment on the regular `walk` above — layer search
        // forces every viewport / variant header to recurse so deep
        // matches still surface; the filter pass trims back afterwards.
        const vpExpanded = expanded.has(vpRowId) || layerSearchActive;
        const hasChildren = variantHasRenderableChildren;

        // Variant header — synthetic node. Cache invalidation must
        // include the variant `label`: renaming a variant changes
        // `vp.label` but not `childCount`, and stale cache reuse would
        // pin the displayed name to the old label forever.
        const prevHeader = vpHeaderCacheRef.current.get(vpRowId);
        let vpNode: CanvasNode;
        if (prevHeader && prevHeader.childCount === variantChildren.length && prevHeader.layer.node.name === vp.label) {
          vpNode = prevHeader.layer.node;
        } else {
          vpNode = { id: vpRowId, type: 'viewport', name: vp.label, parentId: null, children: variantChildren, styles: {}, attrs: {}, textContent: '', order: vp.order, isCanvasNode: false } as CanvasNode;
        }
        const headerLayer = cachedLayer(vpRowId, null, vpNode, 0, hasChildren, vpExpanded, vp.id, vp.label, vp.width);
        headerLayer.isVariantHeader = true;
        vpHeaderCacheRef.current.set(vpRowId, { layer: headerLayer, childCount: variantChildren.length });
        result.push(headerLayer);

        if (vpExpanded) {
          // Walk the variant root's CHILDREN directly — the header IS the root,
          // so showing the root again as a child would be redundant (Card > Card > p, p)
          for (const rootChildId of variantChildren) {
            const rootChild = nodes.get(rootChildId);
            if (rootChild) {
              // Sort per-variant: the same JSX children may have variant- or
              // conditional-style `order` overrides that differ between
              // variants, so a flex master with CSS-order-driven reorder reads
              // correctly in EACH variant row.
              for (const childId of sortChildrenByVisualOrder(rootChild, rootChild.children, vp.id, nodes, vpConfigs, containerOverrides, isCompMode)) {
                walk(childId, 1, vp.id);
              }
            }
          }
        }
      }
    } else if (isIconSetFilePath(activeFilePath)) {
      // Icon-set master: skip the viewport header entirely. The "Master"
      // wrapper row was just visual noise — there's only one viewport in
      // a vector set and the user's mental model is "the panel shows my
      // vectors". Mirror the component-master flow but without the
      // synthetic header: walk the master root's children at depth 0
      // so each top-level vector reads as a top-level layer (matching
      // how a dropped component instance sits at root level on a page).
      for (const childId of pageChildren) {
        walk(childId, 0, 'desktop');
      }
    } else {
      // For each viewport, add a viewport header then the page children underneath
      // (canvas nodes are shown separately at the end, not per-viewport)
      for (const vp of viewports) {
        const vpRowId = `__vp_${vp.id}`;
        // Layer-search override: viewport headers always expand while
        // searching so a deep match isn't hidden behind a collapsed
        // viewport row. See the comment on `walk` for the full story.
        const vpExpanded = expanded.has(vpRowId) || layerSearchActive;
        const hasChildren = pageChildren.length > 0;

        // Viewport header — use synthetic CanvasNode (cache it too).
        // Cache must invalidate on `vp.label` change too — page viewport
        // labels are static today but the same cache entry shape is
        // shared with the variant branch above, where labels DO change
        // via rename. Match the same invalidation rule for consistency.
        const prevHeader = vpHeaderCacheRef.current.get(vpRowId);
        let vpNode: CanvasNode;
        if (prevHeader && prevHeader.childCount === pageChildren.length && prevHeader.layer.node.name === vp.label) {
          vpNode = prevHeader.layer.node;
        } else {
          vpNode = { id: vpRowId, type: 'viewport', name: vp.label, parentId: null, children: pageChildren, styles: {}, attrs: {}, textContent: '', order: vp.order, isCanvasNode: false } as CanvasNode;
        }
        const headerLayer = cachedLayer(vpRowId, null, vpNode, 0, hasChildren, vpExpanded, vp.id, vp.label, vp.width);
        vpHeaderCacheRef.current.set(vpRowId, { layer: headerLayer, childCount: pageChildren.length });
        result.push(headerLayer);

        // If expanded, walk root's children directly (skip root "Page" node).
        // Sort per-viewport: page replicas write `order` to `@container`
        // (max-width) overrides, so tablet/mobile may have a different visual
        // order than desktop for the same children. Reading the order through
        // sortChildrenByVisualOrder with `vp.id` picks up that override.
        // `parentForOrder` is the `'root'` node (the flex container) — page
        // root wrapper sits ABOVE root and is typically display:block, so
        // sorting against it would short-circuit; we want root.styles.display.
        if (vpExpanded) {
          const parentForOrder = nodes.get('root') ?? null;
          for (const childId of sortChildrenByVisualOrder(parentForOrder, pageChildren, vp.id, nodes, vpConfigs, containerOverrides, isCompMode)) {
            walk(childId, 1, vp.id);
          }
        }
      }
    }

    // Canvas nodes: shown once at the end (not per-viewport)
    for (const childId of canvasChildren) {
      walk(childId, 0, 'desktop'); // use desktop viewport context
    }

    return result;
  }, [nodes, expanded, viewports, rootNodeIds, activeFilePath, layerSearchActive, editingOverlayId]);

  // ─── Layer search filter ───────────────────────────────────────────────
  // When the search box is non-empty, narrow the flat list to:
  //   • rows whose name/type matches the query (case-insensitive), and
  //   • their ancestors (so the user sees the tree path leading down),
  //   • plus every viewport header (always kept so the UI stays anchored).
  // When the search is empty we pass `layers` through untouched — no cost.
  // The walk above already widened recursion to ignore collapse state
  // while searching, so even matches behind a closed parent end up in
  // `layers` to be filtered here.
  const displayLayers = useMemo(
    () => filterLayersForSearch(layers, layerSearchActive, layerSearchQuery, nodes),
    [layers, layerSearchActive, layerSearchQuery, nodes],
  );

  // Drive the per-row selection/hover background so it stays inset from BOTH
  // visible edges while the tree scrolls horizontally (standard). Each
  // row's background is an absolutely-positioned layer whose width is pinned
  // to the panel's visible width and which is counter-translated by the
  // horizontal scroll offset — both fed by these CSS vars. Cheap: one var
  // write per scroll/resize, applied to every row via CSS inheritance.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sync = () => {
      el.style.setProperty('--layers-vw', `${el.clientWidth}px`);
      el.style.setProperty('--layers-sx', `${el.scrollLeft}px`);
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro.disconnect(); };
  }, [displayLayers]);

  // Which viewport+node combo is selected in the layers panel
  // Format: "desktop:nodeId" or null. When selecting from canvas, we pick the
  // interacting viewport. When selecting from layers, we set it directly.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);

  // Flag: skip the canvas→layers sync when the selection originated from a layer click
  const selectionFromLayerRef = useRef(false);

  // Auto-expand parents when selecting FROM CANVAS (not from layer clicks)
  useEffect(() => {
    if (!selectedId) { setSelectedLayerId(null); return; }
    // Skip if selection came from a layer click — we already set selectedLayerId
    if (selectionFromLayerRef.current) {
      selectionFromLayerRef.current = false;
      return;
    }

    const node = nodes.get(selectedId);
    // No early bail-out trap: on component RE-entry this effect can fire
    // while `nodes` still holds the PREVIOUS file's map (parse in flight) —
    // the selected master root isn't in it yet. `nodes` is in the deps
    // below, so the effect re-runs when the new file's parse lands and the
    // highlight resolves then (first-entry only worked by winning this
    // race — user report 2026-07-31).
    if (!node) return;

    // Use the interacting viewport to determine which tree to highlight
    const isComponentMode = isComponentFilePath(activeFilePath);
    const vpId = interactingVpId;

    // If the selected node is a top-level node, select the header row.
    // On pages: root nodes (no parentId) → viewport header.
    // On components: variant root children (parentId='root') → variant header.
    const isVariantRoot = isComponentMode && node.parentId === 'root';
    if ((!node.parentId || isVariantRoot) && !node.isCanvasNode) {
      // Guard: the interacting vp can lag a file switch (a page vp id like
      // 'desktop' while this file's headers are variant-keyed). If no header
      // exists for it, highlight the FIRST header instead of nothing.
      const headerVpId = viewports.some(v => v.id === vpId) ? vpId : (viewports[0]?.id ?? vpId);
      setSelectedLayerId(`__vp_${headerVpId}`);
    } else {
      // FIT SVG wrapper: resolve to inner text element for layer highlighting
      // (the SVG wrapper is hidden in layers, the inner text is shown instead)
      let resolvedId = selectedId;
      if (node.type === 'svg' && selectedId.endsWith('-svg')) {
        const innerTextId = selectedId.replace(/-svg$/, '');
        if (nodes.has(innerTextId)) resolvedId = innerTextId;
      }
      const layerId = `${vpId}:${resolvedId}`;
      setSelectedLayerId(layerId);
    }

    // Expand the viewport header + all parent nodes in that viewport
    const toExpand: string[] = [`__vp_${vpId}`];
    let parentId = node.parentId;
    while (parentId) {
      const prefixed = `${vpId}:${parentId}`;
      if (!expanded.has(prefixed)) toExpand.push(prefixed);
      parentId = nodes.get(parentId)?.parentId ?? null;
    }
    if (toExpand.length > 0) {
      trace.action('layers:auto-expand-from-canvas', { selectedId, vpId, expandedIds: toExpand });
      setExpanded(prev => {
        // Identity-stable: this effect now re-runs on every parse (nodes is
        // a dep) — returning a fresh Set when nothing changed would re-render
        // the whole panel per parse.
        let changed = false;
        const next = new Set(prev);
        for (const id of toExpand) {
          if (!next.has(id)) { next.add(id); changed = true; }
        }
        return changed ? next : prev;
      });
    }
  }, [selectedId, interactingVpId, viewports, nodes, activeFilePath]);

  // Auto-scroll to selected layer
  useEffect(() => {
    if (!selectedLayerId || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-layer-id="${CSS.escape(selectedLayerId)}"]`) as HTMLElement;
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedLayerId, layers]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const expanding = !next.has(id);
      if (expanding) next.add(id);
      else next.delete(id);
      trace.action('layers:toggle-expand', { id, expanded: expanding });
      return next;
    });
  }, []);

  const handleSelect = useCallback((layerId: string, nodeId: string, additive = false) => {
    // Mark that this selection came from a layer click — skip canvas→layers sync
    selectionFromLayerRef.current = true;
    // Viewport/variant header click → select the page root or variant root.
    // An empty nodeId means "the page viewport root" — that's always `root`
    // now: on a templated page the template is merged ONTO the page root, so
    // there is no separate `layout::root` layer (matches the canvas
    // viewport-header click; see ViewportHeaderManager).
    let rawNodeId = nodeId || 'root';
    // COMPONENT MASTERS have no `root` node — resolve the fallback (and any
    // id missing from the map, e.g. after a cross-file navigation left a
    // stale row) to the MASTER ROOT so the selection never lands on a
    // nonexistent id (which unmounted the whole Properties panel — user
    // report 2026-07-29, MotionLink-root master).
    if (isComponentFilePath(activeFilePath) && !nodes.has(rawNodeId)) {
      for (const [nid, n] of nodes) {
        if (!n.parentId && n.type !== 'style' && !n.isCanvasNode) { rawNodeId = nid; break; }
      }
      trace.action('layers:select-resolved-master-root', { requested: nodeId || 'root', resolved: rawNodeId });
    }
    // FIT text is a PAIR (svg wrapper + inner text) with ONE selection target:
    // the wrapper. Canvas clicks already redirect (redirectToFitTextWrapper);
    // without the same here a layers-row click selected the INNER while a
    // canvas click selected the WRAPPER — two different "things" selectable
    // for what the user sees as one element (live find 2026-07-13).
    const effectiveNodeId = redirectToFitTextWrapper(rawNodeId, nodes) ?? rawNodeId;
    if (additive) {
      // Shift/Cmd/Ctrl+click → TOGGLE in multi-select, exactly like the canvas
      // (CanvasMouseController shift+click). Rows highlight off `selectedIds`
      // (see the LayerRow `isSelected` prop), so adding to the array lights up
      // every selected row. On REMOVE we clear `selectedLayerId` so the single
      // `layer.id === selectedLayerId` highlight doesn't pin the just-removed
      // row; the remaining rows stay lit via `selectedIds`.
      const willRemove = selectedIds.includes(effectiveNodeId);
      setSelectedIds(willRemove
        ? selectedIds.filter(id => id !== effectiveNodeId)
        : [effectiveNodeId, ...selectedIds]);
      setSelectedLayerId(willRemove ? null : layerId);
    } else {
      setSelectedLayerId(layerId);
      setSelectedIds([effectiveNodeId]);
    }

    // Update interacting viewport so SelectionOverlay targets the correct viewport's element
    const vpId = vpIdFromLayerId(layerId);
    if (vpId) setInteractingVpId(vpId);

    trace.action('layers:select', { layerId, nodeId, vpId });

    // Auto-expand the selected node if it has children
    const node = nodes.get(nodeId);
    if (node && node.children.length > 0) {
      setExpanded(prev => {
        if (prev.has(layerId)) return prev; // already expanded, skip
        const next = new Set(prev);
        next.add(layerId);
        return next;
      });
    }

    // Overlay-edit mode: clicking an overlay row ENTERS its edit mode (same as
    // the Overlay tool's "Overlay" chip → the canvas opens the overlay). Clicking
    // a node OUTSIDE the currently-edited overlay EXITS it (a child of the overlay
    // keeps it open). Skip for additive/multi-select clicks.
    if (!additive) {
      const clicked = nodes.get(effectiveNodeId);
      if (clicked?.attrs?.['data-overlay']) {
        setOverlayEditingId(effectiveNodeId);
      } else if (editingOverlayId && !isNodeUnderOverlay(effectiveNodeId, editingOverlayId, nodes)) {
        setOverlayEditingId(null);
      }
    }
  }, [setSelectedIds, selectedIds, nodes, editingOverlayId, setOverlayEditingId, activeFilePath]);

  // ─── Lock & Visibility ──────────────────────────────────────────────────
  const handleToggleLock = useCallback((nodeId: string) => {
    const contentEl = getContentRoot();
    if (!contentEl) return;
    toggleLock(nodeId, contentEl, nodes);
  }, [nodes]);

  // Toggle visibility per-layer. The eye on a non-primary viewport / non-
  // default variant row writes to that viewport's @media rule (page) or
  // the variant's motionVariants entry (component master) — not the base
  // styles. Routing relies on `setStyleContext` because `updateNodeStyles`
  // reads its viewport context from a module-level variable that's
  // normally synced from the React atom in Canvas.tsx during render. We
  // can't trip a re-render mid-callback, so we set the context
  // imperatively for the duration of this single write and Canvas's
  // render-time sync (Canvas.tsx:412) will restore on the next pass.
  const handleToggleVisibility = useCallback((nodeId: string, layerVpId?: string) => {
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const node = nodes.get(nodeId);
    if (!node) return;

    const targetVpId = layerVpId || interactingVpId;
    let { isHidden } = resolveDisplayForLayer(node, targetVpId, vpConfigs, containerOverrides, isCompMode);
    // Same bridge-cache safety net used in the layer row render: when the
    // parser-side cascade misses a hide path (e.g. ancestor display:none, an
    // override format we don't map yet), the rendered element's computed
    // `display` still reflects it. Without this, clicking the eye on such a
    // row would write 'none' AGAIN (no-op) instead of '' (unhide).
    if (!isHidden) {
      const bridge = getCanvasBridge() as { getCachedComputedStyle?: (id: string, prefix: string, prop: string) => string };
      if (bridge.getCachedComputedStyle) {
        const prefix = isPrimaryViewport(targetVpId) ? '' : `${targetVpId}-`;
        const cachedDisplay = bridge.getCachedComputedStyle(nodeId, prefix, 'display');
        if (cachedDisplay === 'none') isHidden = true;
      }
    }
    // Hidden → write '' to remove the override (or clear base); visible →
    // write 'none' which lands either in the @media rule (replica) or
    // motionVariants (variant) per `updateNodeStyles`'s routing.
    const newDisplay = isHidden ? '' : 'none';

    const targetVpWidth = vpWidths[targetVpId] ?? vpConfigs.find(v => v.id === targetVpId)?.width ?? 0;
    setStyleContext(activeFilePath, targetVpId, targetVpWidth, activeLocale, isDefaultLocale);
    trace.action('layers:toggle-visibility', { nodeId, layerVpId: targetVpId, isHidden, newDisplay, isCompMode });
    // Flip the eye INSTANTLY (optimistic) — the indicator's bridge-cache fallback is
    // stale until the canvas re-render settles, so otherwise the eye lags until a
    // click elsewhere. Clear after the render settles → indicator reconciles with the
    // real resolved/bridge state. Keyed per (nodeId, viewport) so per-variant rows
    // don't clobber each other.
    const optKey = `${targetVpId}:${nodeId}`;
    setOptimisticVis(m => { const n = new Map(m); n.set(optKey, !isHidden); return n; });
    setTimeout(() => setOptimisticVis(m => { if (!m.has(optKey)) return m; const n = new Map(m); n.delete(optKey); return n; }), 350);
    updateNodeStyles({ id: nodeId, styles: { display: newDisplay }, contentEl });
    // The eye toggle on a COMPONENT layer routes the hide through the variant
    // visibility systems (`setVariantVisibility`/hiddenOnVariants for a normal node,
    // a per-variant `display` ternary for a CMS `.map()` row) — both of which the
    // updateNodeStyles DOM-patch DOESN'T apply directly (display is stripped/strategy-
    // owned), so they only take effect on a FULL Renderer cycle. A panel write doesn't
    // trigger one, so the eye toggle silently does nothing on a variant (rows/container
    // stay until a drag). Flush + force a render so it hides/shows immediately, matching
    // the Styles Hide control (which does the same via `flushAndForceStructuralRender`).
    // Page-file layers patch the DOM live (@container !important) so they don't need it —
    // scope to component files plus any CMS row.
    const parentNode = node.parentId ? nodes.get(node.parentId) : null;
    const isCmsRow = !!parentNode?.collectionList
      && Object.values(parentNode.collectionList.templateIds ?? {}).includes(nodeId);
    if (isCompMode || isCmsRow) {
      flushAndForceStructuralRender();
    }
  }, [nodes, interactingVpId, vpConfigs, vpWidths, containerOverrides, isCompMode, activeFilePath, activeLocale, isDefaultLocale]);

  // ─── Drag and Drop (mousemove-based) ─────────────────────────────────────

  const handleLayerDragStart = useCallback((e: React.MouseEvent, layerId: string, nodeId: string) => {
    startLayerDrag({
      nodes, isCompMode, vpWidths, vpConfigs, activeFilePath,
      dragStartPos, dragThresholdMet, activeIdRef, activeLayerIdRef, dropIndicatorRef,
      setActiveId, setActiveLayerId, setDropIndicator,
    }, e, layerId, nodeId);
  }, [nodes, isCompMode, vpWidths, vpConfigs, activeFilePath]);

  // Context menu on right-click
  const setContextMenu = useSetAtom(contextMenuAtom);
  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string | null) => {
    if (!nodeId) return;
    // Same FIT-pair redirect as handleSelect — right-click must not select the inner.
    const ctxNodeId = redirectToFitTextWrapper(nodeId, nodes) ?? nodeId;
    setSelectedIds([ctxNodeId]);
    setContextMenu({ show: true, x: e.clientX, y: e.clientY, nodeId: ctxNodeId });
  }, [setSelectedIds, setContextMenu, nodes]);

  // Inline rename
  // Double-click detection (ref lives in parent — survives child re-renders)
  const lastLayerClickRef = useRef<{ time: number; layerId: string }>({ time: 0, layerId: '' });

  // Use LOCAL state for rename to avoid cross-component re-render cascades
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Also sync with the atom so context menu can trigger rename
  const [renamingFromMenu] = useAtom(renamingNodeIdAtom);
  const setRenamingAtom = useSetAtom(renamingNodeIdAtom);
  useEffect(() => {
    if (renamingFromMenu) {
      // Context menu sets nodeId — convert to layerId using selected viewport
      const vpId = selectedLayerId?.split(':')[0] || 'desktop';
      setRenamingId(`${vpId}:${renamingFromMenu}`);
      setRenamingAtom(null);
    }
  }, [renamingFromMenu]);

  // Wrap onSelect to detect double-clicks
  const handleLayerClick = useCallback((layerId: string, nodeId: string, e?: React.MouseEvent) => {
    const node = nodes.get(nodeId);

    // Layout and placeholder nodes are not selectable
    if (node?.fromLayout || node?.isChildrenSlot) return;

    // Shift / Cmd / Ctrl + click → additive multi-select (same modifiers the
    // canvas honors). Skip the double-click rename path entirely so a
    // modifier-click only ever toggles the selection.
    const additive = !!e && (e.shiftKey || e.metaKey || e.ctrlKey);
    if (additive) {
      lastLayerClickRef.current = { time: Date.now(), layerId };
      handleSelect(layerId, nodeId, true);
      return;
    }

    const now = Date.now();
    const last = lastLayerClickRef.current;
    const isDouble = now - last.time < 350 && last.layerId === layerId;
    lastLayerClickRef.current = { time: now, layerId };

    // Viewers get single-click select only — double-click rename is an
    // edit affordance, so the double-click branch is skipped entirely.
    if (isDouble && nodeId && !isViewer) {
      // Double click → start rename (use layerId so only THIS viewport's row shows input)
      setRenamingId(layerId);
      return;
    }

    // Single click → select
    handleSelect(layerId, nodeId);
  }, [handleSelect, setRenamingId, nodes, isViewer]);

  const handleDoubleClickLayout = useCallback((node: CanvasNode) => {
    if (node.fromLayout) {
      const layoutPath = getLayoutForPage(activeFilePath);
      if (layoutPath) {
        const clientPath = getLayoutClientPath(layoutPath);
        trace.action('layers:navigate-to-layout', { from: activeFilePath, layoutPath, clientPath });
        flushNow();
        setActiveFile(clientPath);
        setSelectedIds([]);
      }
    }
  }, [activeFilePath, setActiveFile, setSelectedIds]);

  const handleRenameCommit = useCallback((nodeId: string, newName: string) => {
    // 1. Update DOM attributes
    const contentEl = getContentRoot();
    if (contentEl) {
      contentEl.querySelectorAll(`[data-id="${nodeId}"]`).forEach(el => {
        (el as HTMLElement).setAttribute('data-name', newName);
      });
    }
    // 2. Update code via mutation queue (updates data-name in JSX)
    queueMutation({ type: 'renameNode', nodeId, name: newName });
    setRenamingId(null);
  }, []);

  // Variant-header rename — only fires in component-master mode where each
  // top-level layer row is a variant viewport. We rewrite the `label` field
  // in `const variantConfig = [...]` (the user-facing display string), NOT
  // the internal `name` key, because `name` is referenced from every
  // `variants` object, motion prop, and connection config in the file —
  // changing it would silently desync those references.
  //
  // The variant 'default' maps to viewport id 'desktop' on the way OUT
  // (visibleViewportsAtom) so we reverse that here before calling the op.
  const handleVariantRenameCommit = useCallback((variantVpId: string, newLabel: string) => {
    if (!isCompMode) { setRenamingId(null); return; }
    const variantName = variantVpId === 'desktop' ? 'default' : variantVpId;
    renameVariant(activeFilePath, variantName, newLabel);
    setRenamingId(null);
  }, [activeFilePath, isCompMode]);

  // ─── Precompute selection state (O(n) instead of O(n²) per row) ─────────

  // Selection sets read from the FULL `layers` list, NOT `displayLayers`.
  // The user can still click into a node whose name doesn't match the
  // current search; this keeps the "last highlighted child" / "child of
  // selected" cascade complete regardless of what's filtered out below.
  const { childOfSelectedSet, highlightedChildrenSet, lastHighlightedChildSet } = useMemo(
    () => computeSelectionSets(selectedLayerId, layers, nodes),
    [selectedLayerId, layers, nodes],
  );

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
      {/* Header layout (top-down): PageSelector + SearchBar live ABOVE
          the SectionLabel so the navigation chrome (switch page / filter
          tree) sits at the very top of the panel where the user lands.
          The label and the tree share the lower half. No top divider —
          the search row floats flush against the panel top. The
          divider beneath the search separates it from the SectionLabel
          + tree combo below.
          • The PageSelector lets the user switch pages without leaving
            the Layers tab — picking a page swaps the active file via
            `switchActiveFile`, and the layer tree re-parses against
            the new file on the next render.
          • The SearchBar filters the tree by node name/type and force-
            expands every collapsed branch so deep matches still surface
            (see `displayLayers` above for the filter semantics). */}
      <div className="px-3 pt-3 flex flex-col gap-2 shrink-0">
        {/* The page switcher only makes sense on a real PAGE — hide it when
            editing a design-component master or a template (both
            component-like), where there are no pages to switch between. */}
        {!isCompLikeMode && <PageSelector />}
        <SearchBar
          value={layerSearchQuery}
          onChange={setLayerSearchQuery}
          placeholder="Search layers…"
        />
      </div>
      <ToolDivider />

      {/* "Layers" label below the search controls — same `SectionLabel`
          the other panels use so the typography matches. */}
      <SectionLabel size="md">Layers</SectionLabel>

      {layers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-[var(--text-disabled)]">No layers yet</p>
        </div>
      ) : displayLayers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <p className="text-xs text-[var(--text-disabled)] text-center">
            No layers match “{layerSearchQuery}”
          </p>
        </div>
      ) : (
      /* Tree */
      <div
        ref={listRef}
        className="flex-1 px-2 overflow-y-auto overflow-x-auto scrollbar-hide"
        // Hard-cut the scrolling content at the 8px left inset (matching the
        // selection pill's inset) so names never bleed into the left margin /
        // over the toolbar as the tree scrolls. The mask is fixed to the
        // viewport, so the inset stays clean at every scroll position.
        style={{
          minHeight: 0,
          WebkitMaskImage: 'linear-gradient(to right, transparent 8px, #000 8px)',
          maskImage: 'linear-gradient(to right, transparent 8px, #000 8px)',
        }}
        data-layers-scroll
      >
        {/* min-w-max so the column grows to the WIDEST row; each row below is
            width:100% of this wrapper, so every selection/hover background
            shares one flush right edge regardless of nesting depth or how far
            the tree is scrolled horizontally. */}
        <div className="min-w-max">
        {displayLayers.map((layer) => {
          // Resolve per-viewport hidden state for THIS row. Skips viewport
          // header rows (no nodeId). For node rows on a non-primary
          // viewport / non-default variant, this surfaces @media or variant
          // `display: none` overrides to the eye icon; on primary viewports
          // it falls through to the base node.styles check.
          // Optimistic override (set on eye-toggle for an instant flip; cleared once
          // the canvas render settles). When present it wins over the resolved/bridge
          // state, which is momentarily stale right after a toggle.
          const optHidden = layer.nodeId != null
            ? optimisticVis.get(`${layer.viewportId || interactingVpId}:${layer.nodeId}`)
            : undefined;
          let effectiveHidden = optHidden !== undefined
            ? optHidden
            : layer.nodeId
              ? resolveDisplayForLayer(layer.node, layer.viewportId, vpConfigs, containerOverrides, isCompMode).isHidden
              : false;
          // Bridge-cache safety net: the parser-side cascade above can
          // miss storage paths that haven't been wired into the resolver
          // yet (e.g. component-instance child overrides redirected to the
          // instance tag, nested-component variant cascades, ancestor
          // display:none, anything the source doesn't store on this exact
          // node). The rendered element's computed `display` already
          // reflects every source the browser applied, so when the
          // parser-side check returns "visible" we cross-check the
          // bridge's computed-cache for this node + viewport prefix and
          // mark hidden if the cache says so. Cache-only lookup (no
          // fallback round-trip) — when the cache is empty for a row, we
          // accept the parser-side answer, so this stays cheap (O(1) Map
          // get per row, no postMessage round-trips).
          if (optHidden === undefined && !effectiveHidden && layer.nodeId && layer.viewportId) {
            const bridge = getCanvasBridge() as { getCachedComputedStyle?: (id: string, prefix: string, prop: string) => string };
            if (bridge.getCachedComputedStyle) {
              const prefix = isPrimaryViewport(layer.viewportId) ? '' : `${layer.viewportId}-`;
              const cachedDisplay = bridge.getCachedComputedStyle(layer.nodeId, prefix, 'display');
              if (cachedDisplay === 'none') effectiveHidden = true;
            }
          }
          return (
            <LayerRow
              key={layer.id}
              layer={layer}
              isSelected={layer.id === selectedLayerId || (layer.nodeId != null && selectedIds.includes(layer.nodeId) && layer.viewportId === interactingVpId)}
              isMapTemplate={isMapTemplate}
              isChildOfSelected={childOfSelectedSet.has(layer.id)}
              hasHighlightedChildren={highlightedChildrenSet.has(layer.id)}
              isLastHighlightedChild={lastHighlightedChildSet.has(layer.id)}
              isDragOver={dropIndicator?.layerId === layer.id && !!activeId}
              dropPosition={dropIndicator?.layerId === layer.id ? dropIndicator.position : null}
              dropDepth={dropIndicator?.layerId === layer.id ? dropIndicator.depth : 0}
              isDragging={!!activeLayerId && activeLayerId === layer.id}
              effectiveHidden={effectiveHidden}
              onSelect={handleLayerClick}
              onToggleExpand={toggleExpand}
              onDragStart={handleLayerDragStart}
              onContextMenu={handleContextMenu}
              onToggleLock={handleToggleLock}
              onToggleVisibility={handleToggleVisibility}
              isRenaming={(!!layer.nodeId || !!layer.isVariantHeader) && layer.id === renamingId}
              onRenameCommit={handleRenameCommit}
              onVariantRenameCommit={handleVariantRenameCommit}
              onDoubleClickLayout={handleDoubleClickLayout}
              isComponentMode={isCompLikeMode}
            />
          );
        })}
        </div>
      </div>
      )}
    </div>
  );
}
