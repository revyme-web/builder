// ToolbarDragStrategy.ts — Handles creating new elements by dragging from the insert panel.
// Ghost overlay follows cursor. On drop, creates element via PendingUpdate { type: 'add' }.
// Never auto-selected by DragCoordinator (canHandle = false). Invoked explicitly.

import type { DragContext, DragStrategy, DragMoveResult } from '../types';
import { normalizeLayoutDescriptor } from '../layout-normalize';
import type { ToolbarItem } from '../toolbar-item-config';
import type { PendingUpdate, Point } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';
import { generateNodeId } from '@/shared/id-utils';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { vpIdFromPrefix, getNodeHitsAtPoint, findNodeRect, isPrimaryViewport, getActiveFilePath, parseRectCacheKey } from '@/canvas/node-ops';
import { calculateLayoutInsertIndexById, applyLayoutEdgeMagnet, computeLayoutInsertOrderUpdates } from '../reparent-utils';
import { commitOrderAssignments } from './order-commit';
import { detectParentLayoutById, getFlexDirectionById } from '../types';
import { nodeAcceptsChildren } from '@/shared/constants';
import { screenToCanvas } from '@/canvas/canvas-math';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { toolbarGhostOps } from './toolbar-ghost-atom';
import { getReplicaContext } from '../replica-context';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { projectFS, installBuiltInCodeComponent } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { getInsertItem } from '@/shared/insert-items/insert-item-lookup';
import { parseFlex } from '@/shared/flex-helpers';
import { trace } from '@/shared/debug-trace';

/** Bridge-aware viewport hit-test: which viewport's root rect contains (x, y)?
 *  Returns `{ vpId, rootNodeId }` when the point lands inside a viewport's
 *  root rect, `null` otherwise.
 *
 *  "Viewport root" = any parentless, non-canvas-node from the parsed `nodes`
 *  map. On a regular page that's literally `id="root"`. On a component
 *  master file the root carries the component's slug (`hero-root`,
 *  `pricingcard-root`, …) — restricting to the literal id `'root'` was the
 *  bug that hid drop indicators on master pages. The downstream code needs
 *  the actual root id (not just the viewport) so it can resolve layout +
 *  insert index against the right parent in the bridge cache. */
function getViewportIdAtPoint(
  x: number,
  y: number,
  nodes: Map<string, CanvasNode>,
): { vpId: string; rootNodeId: string } | null {
  const bridge = getCanvasBridge();
  if (!('rectCache' in bridge)) return null;
  const cache = (bridge as any).rectCache as Map<string, DOMRect>;

  // Collect the set of valid root node ids once. Walking the map is O(n) but
  // master pages have very few parentless nodes (one per variant). Cached
  // would be premature — `nodes` shifts on every parse.
  const rootIds = new Set<string>();
  for (const node of nodes.values()) {
    if (!node.parentId && !node.isCanvasNode) rootIds.add(node.id);
  }
  if (rootIds.size === 0) return null;

  for (const [key] of cache) {
    const { vpPrefix, nodeId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
    if (!rootIds.has(nodeId)) continue;
    const rect = bridge.getRect(nodeId, vpPrefix);
    if (!rect) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return { vpId: vpIdFromPrefix(vpPrefix), rootNodeId: nodeId };
    }
  }
  return null;
}

/** Find the DEEPEST frame-tag node at point (x, y) within a viewport.
 *  Uses point-containment (not full-rect-containment) so smaller nested
 *  containers (a card inside a Features row) detect even when they're
 *  smaller than the ghost — matches the UX of moving an existing node. */
function findDeepestFrameAtPoint(
  x: number, y: number, nodes: Map<string, CanvasNode>, vpId: string,
): { id: string; rect: DOMRect } | null {
  const hits = getNodeHitsAtPoint(x, y);
  // hits sorted smallest-area-first → first frame-tag match is the deepest
  for (const hit of hits) {
    // `layout::`-prefixed IDs belong to the layout file, not the active
    // page — picking one as a drop parent routes the addNode mutation to
    // the page file with a parentId the page doesn't contain, so the
    // generator silently no-ops and the element never lands. `children-slot`
    // is the placeholder marker for the layout's `{children}` slot — also
    // not a real container. Skip both; the caller's root fallback will
    // land the drop into the page's own root.
    if (hit.id.startsWith('layout::') || hit.id === 'children-slot') continue;
    const node = nodes.get(hit.id);
    if (!node) continue;
    const tag = node.type || 'div';
    if (!nodeAcceptsChildren(node)) continue;
    const rect = findNodeRect(hit.id, vpId);
    if (!rect) continue;
    return { id: hit.id, rect };
  }
  return null;
}

/** Parse a CSS value to px number. Returns null for non-px values (%, auto, fill, etc.) */
function parsePxValue(value: string | undefined): number | null {
  if (!value) return null;
  if (value.endsWith('px')) {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

/** True iff (x, y) lands on a parent-frame editor panel surface (LeftPanel
 *  primary, Insert secondary, etc.). These panels overlay the canvas
 *  containerRect at z-[5000+], so a "is mouse inside containerRect" check
 *  alone reads them as "over canvas" and would commit drops into the
 *  active page on mouseup. Walking up from `elementFromPoint` to a
 *  `[data-editor-panel]` marker is robust to portal'd panels (Insert's
 *  secondary panel renders into document.body, NOT inside containerEl). */
function isOverEditorPanel(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  return el.closest('[data-editor-panel]') !== null;
}

export class ToolbarDragStrategy implements DragStrategy {
  readonly name = 'toolbar';

  private item: ToolbarItem | null = null;
  private currentVpId: string | null = null;
  private dropParentId: string | null = null;
  private dropIndex: number | undefined = undefined;
  private isOverCanvas = false;
  private lastMouseScreen: Point = { x: 0, y: 0 };

  setToolbarItem(item: ToolbarItem): void {
    this.item = item;
  }

  canHandle(): boolean {
    return false; // never auto-selected
  }

  onStart(context: DragContext): void {
    if (!this.item) return;
    trace.action('toolbar-drag:strategy-start', { itemId: this.item.id });
    // Show ghost at start mouse position
    toolbarGhostOps.show({
      item: this.item,
      screenPos: { ...context.startMouse },
      vpId: null,
      canvasPos: null,
    });
  }

  onMove(context: DragContext, mouseScreen: Point): DragMoveResult {
    this.lastMouseScreen = mouseScreen;

    if (!this.item) {
      return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    // If the cursor is currently over a left-side editor panel (the
    // primary sidebar OR the hovered secondary panel) treat the drag as
    // "outside canvas" — ghost still follows, but no drop indicators
    // light up and onEnd will cancel instead of insert. The user dragged
    // FROM these panels; releasing while still over them means "I changed
    // my mind", not "drop here".
    if (isOverEditorPanel(mouseScreen.x, mouseScreen.y)) {
      this.isOverCanvas = false;
      this.dropParentId = null;
      this.dropIndex = undefined;
      this.currentVpId = null;
      dropLineOps.hide();
      parentHighlightOps.hide();
      toolbarGhostOps.show({
        item: this.item,
        screenPos: mouseScreen,
        vpId: null,
        canvasPos: null,
      });
      trace.fn('toolbar-drag:move', {
        isOverCanvas: false,
        reason: 'over-editor-panel',
      });
      return { snap: null, dropTarget: null, highlightParentId: null, axisLock: null };
    }

    // Bridge-aware viewport hit-test (parent-frame DOM is empty in iframe mode).
    // `context.nodes` is the parsed page/master tree — we use it to recognize
    // any parentless root id, not just the literal 'root' (component masters
    // have ids like `hero-root`).
    const hit = getViewportIdAtPoint(mouseScreen.x, mouseScreen.y, context.nodes);

    if (hit) {
      // Phase 3: Over a viewport — find drop target
      const { vpId, rootNodeId } = hit;
      this.currentVpId = vpId;
      this.isOverCanvas = true;

      // Canvas-space position for ghost
      const canvasPos = screenToCanvas(mouseScreen.x, mouseScreen.y, context.transform, context.containerRect);

      // Find deepest frame-tag container at the cursor point. Point-based —
      // not full-rect-containment — so nested cards smaller than the ghost
      // still detect. Matches the existing-node-drag UX: hover over a child,
      // drop into it.
      let frame = findDeepestFrameAtPoint(mouseScreen.x, mouseScreen.y, context.nodes, vpId);

      // Edge-magnet promotion: same UX as CanvasDragStrategy. When the
      // cursor sits within ~12px of a layout-axis edge of `frame` and
      // `frame`'s parent is a layout container, promote so the drop-line
      // shows BETWEEN siblings of the parent rather than INTO `frame`.
      // Critical for two flush-touching viewport sections: without the
      // magnet, every cursor position lands inside one section and the
      // "between sections" drop is unreachable from a toolbar drag.
      frame = applyLayoutEdgeMagnet(frame, mouseScreen, context.nodes, vpId);

      if (frame) {
        const layout = detectParentLayoutById(frame.id, vpId);
        if (layout === 'flex' || layout === 'grid' || layout === 'block') {
          // Layout container — show drop line
          const direction = getFlexDirectionById(frame.id, vpId);
          const insertIndex = calculateLayoutInsertIndexById(mouseScreen, frame.id, vpId, direction);
          this.dropParentId = frame.id;
          this.dropIndex = insertIndex;
          dropLineOps.show({ parentId: frame.id, insertIndex, vpId });
          parentHighlightOps.hide();
        } else {
          // Absolute container — show parent highlight
          this.dropParentId = frame.id;
          this.dropIndex = undefined;
          dropLineOps.hide();
          parentHighlightOps.show({ parentId: frame.id, vpId });
        }
      } else {
        // Over viewport but not over any frame — drop into the viewport's
        // root. Use the actual matched root id (`rootNodeId`); component
        // masters use slug-based ids like `hero-root` rather than the
        // literal `'root'` a regular page uses.
        this.dropParentId = rootNodeId;
        const vpLayout = detectParentLayoutById(rootNodeId, vpId);
        if (vpLayout === 'flex' || vpLayout === 'grid' || vpLayout === 'block') {
          const direction = getFlexDirectionById(rootNodeId, vpId);
          const insertIndex = calculateLayoutInsertIndexById(mouseScreen, rootNodeId, vpId, direction);
          this.dropIndex = insertIndex;
          dropLineOps.show({ parentId: rootNodeId, insertIndex, vpId });
          parentHighlightOps.hide();
        } else {
          this.dropIndex = undefined;
          parentHighlightOps.show({ parentId: rootNodeId, vpId });
          dropLineOps.hide();
        }
      }

      // Update ghost in canvas-space
      toolbarGhostOps.show({
        item: this.item,
        screenPos: mouseScreen,
        vpId,
        canvasPos,
      });
    } else {
      // Not over a viewport. Before falling back to a free-floating drop, try a
      // FREE CANVAS-NODE container — a section/frame dropped earlier onto the
      // canvas. Detecting with an empty vp-prefix naturally EXCLUDES viewport
      // frames (their rects are keyed under a real prefix and miss the '' lookup),
      // so a plugin / Insert-panel drag lands INTO a floating layout with the
      // same line / inside indicators as dragging an existing node — no viewport
      // required. (This is the "it's literally the canvas drag strategy" case:
      // flex/grid → drop line; non-layout → inside highlight.)
      const CANVAS_VP = '';
      const canvasPos = screenToCanvas(mouseScreen.x, mouseScreen.y, context.transform, context.containerRect);
      let cnFrame = findDeepestFrameAtPoint(mouseScreen.x, mouseScreen.y, context.nodes, CANVAS_VP);
      cnFrame = applyLayoutEdgeMagnet(cnFrame, mouseScreen, context.nodes, CANVAS_VP);

      if (cnFrame) {
        this.isOverCanvas = true;
        this.currentVpId = null; // canvas-node drop — no replica / variant routing
        const layout = detectParentLayoutById(cnFrame.id, CANVAS_VP);
        if (layout === 'flex' || layout === 'grid' || layout === 'block') {
          const direction = getFlexDirectionById(cnFrame.id, CANVAS_VP);
          const insertIndex = calculateLayoutInsertIndexById(mouseScreen, cnFrame.id, CANVAS_VP, direction);
          this.dropParentId = cnFrame.id;
          this.dropIndex = insertIndex;
          dropLineOps.show({ parentId: cnFrame.id, insertIndex, vpId: CANVAS_VP });
          parentHighlightOps.hide();
        } else {
          this.dropParentId = cnFrame.id;
          this.dropIndex = undefined;
          dropLineOps.hide();
          parentHighlightOps.show({ parentId: cnFrame.id, vpId: CANVAS_VP });
        }
        toolbarGhostOps.show({ item: this.item, screenPos: mouseScreen, vpId: null, canvasPos });
      } else {
        // Empty canvas (Phase 2 = inside container, Phase 1 = outside): free
        // node on drop, no insert indicators.
        const containerRect = context.containerRect;
        const overContainer = mouseScreen.x >= containerRect.left && mouseScreen.x <= containerRect.right &&
                              mouseScreen.y >= containerRect.top && mouseScreen.y <= containerRect.bottom;
        this.isOverCanvas = overContainer;
        this.dropParentId = null;
        this.dropIndex = undefined;
        this.currentVpId = null;
        toolbarGhostOps.show({
          item: this.item,
          screenPos: mouseScreen,
          vpId: null,
          canvasPos: overContainer ? canvasPos : null,
        });
        dropLineOps.hide();
        parentHighlightOps.hide();
      }
    }

    trace.fn('toolbar-drag:move', {
      isOverCanvas: this.isOverCanvas,
      vpId: this.currentVpId,
      dropParentId: this.dropParentId,
      dropIndex: this.dropIndex,
    });

    // Two drop modes:
    //   1. Layout container (`dropIndex` is set) — emit `dropTarget` so the
    //      coordinator routes it through onHighlightParent(null) and the
    //      drop-LINE indicator carries the parent affordance on its own.
    //   2. Non-layout container (`dropIndex === undefined`) — emit
    //      `highlightParentId` instead. The coordinator's
    //      `onHighlightParent` callback then triggers the parent border
    //      outline. Without this, the toolbar strategy's own
    //      `parentHighlightOps.show()` call gets immediately undone by the
    //      coordinator's suppress-when-dropTarget logic — visible bug:
    //      hovering a no-layout frame highlights for one frame and
    //      vanishes (or never shows depending on call order).
    const isLayoutDrop = this.dropParentId !== null && this.dropIndex !== undefined;
    return {
      snap: null,
      dropTarget: isLayoutDrop
        ? { parentId: this.dropParentId!, index: this.dropIndex!, position: 'inside' as const }
        : null,
      highlightParentId: !isLayoutDrop ? this.dropParentId : null,
      highlightVpId: this.currentVpId ?? undefined,
      axisLock: null,
    };
  }

  onEnd(context: DragContext): PendingUpdate[] {
    // Hide ghost and indicators
    toolbarGhostOps.hide();
    dropLineOps.hide();
    parentHighlightOps.hide();

    if (!this.item) {
      this.reset();
      return [];
    }

    if (!this.isOverCanvas) {
      trace.action('toolbar-drag:cancelled', { reason: 'outside-canvas' });
      this.reset();
      return [];
    }

    // Lazy-install built-in code component file. The Insert panel's `cs-*` IDs map to
    // PascalCase tags (e.g. `'AuroraBackground'`). If the user is dropping
    // one for the first time, write the code component file from the registry NOW so
    // the import the generator's `syncImports` will add (`@/components/
    // AuroraBackground`) resolves on the next render. No-op for already-
    // installed code components, lowercase tags (`'div'`, `'p'`, …), and unknown
    // PascalCase tags (user-created components — those are already in
    // ProjectFS by definition).
    installBuiltInCodeComponent(projectFS, this.item.elementType);

    // CDN-linked component drop: ensure the URL `import` line exists
    // on the active page before the JSX instance lands. Without this
    // the bare `<Slug />` tag the descriptor inserts has no resolution
    // at all (no entry in the registry, no projectFS file, no URL
    // import). Mirrors the `importComponentFromUrl` paste flow's
    // `ensureUrlImport` step but lifted into the drag drop site.
    if (this.item.cdnUrl) {
      const cdnUrl = this.item.cdnUrl;
      const componentName = this.item.elementType;
      const activeFile = getActiveFilePath();
      modifyProjectFile(activeFile, (code) => {
        if (code.includes(cdnUrl) || new RegExp(`import\\s+${componentName}\\s+from`).test(code)) {
          return code;
        }
        // Naive insert at the top of the imports block — finds the last
        // `import …` line and splices the new one after it. The page
        // TSX always has at least `import React from 'react'`.
        const lines = code.split('\n');
        let lastImportIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
          else if (lastImportIdx >= 0 && lines[i].trim() !== '') break;
        }
        const importLine = `import ${componentName} from "${cdnUrl}";`;
        lines.splice(lastImportIdx + 1, 0, importLine);
        return lines.join('\n');
      });
    }

    const nodeId = generateNodeId(this.item.elementType === 'div' ? 'frame' : this.item.elementType);

    const styles = { ...this.item.defaultStyles };

    if (!this.dropParentId) {
      // Dropping on canvas with no parent — absolute position centered on cursor.
      // Resolve width/height to px for centering offset (handles px, %, auto).
      const w = parsePxValue(styles.width) ?? this.item.ghostSize.width;
      const h = parsePxValue(styles.height) ?? this.item.ghostSize.height;
      const canvasPos = screenToCanvas(
        this.lastMouseScreen.x, this.lastMouseScreen.y,
        context.transform, context.containerRect,
      );
      styles.position = 'absolute';
      styles.left = `${Math.round(canvasPos.x - w / 2)}px`;
      styles.top = `${Math.round(canvasPos.y - h / 2)}px`;
      // Percentage / viewport sizes have nothing to resolve against on the
      // bare canvas (a free node's `width: 100%` spans the whole workspace)
      // — materialise the ghost-footprint px instead. Section blueprints
      // carry `width: '100%'` / `height: '100vh'` for their in-page life.
      if (/%$/.test(styles.width ?? '')) styles.width = `${w}px`;
      if (/(%|vh)$/.test(styles.height ?? '')) styles.height = `${h}px`;
    } else if (this.dropIndex === undefined) {
      // Non-layout frame parent (no flex / grid / block flow). `onMove`
      // signals this with `dropParentId` set + `dropIndex === undefined`,
      // and shows a `parentHighlightOps` outline rather than a drop line.
      // Insert as `position: absolute` and center under the cursor in
      // parent-local coords. Without this branch the descriptor's default
      // `position: 'relative'` lands the node at the parent's top-left,
      // ignoring where the user actually dropped.
      // `currentVpId` is NULL for a CANVAS-NODE parent (no replica routing) —
      // vpId '' resolves the '' bridge prefix canvas nodes are cached under,
      // so the same math places the drop inside a floating frame too (the
      // old `&& this.currentVpId` guard skipped this branch entirely and
      // canvas-node drops landed at the parent's top-left).
      const w = parsePxValue(styles.width) ?? this.item.ghostSize.width;
      const h = parsePxValue(styles.height) ?? this.item.ghostSize.height;
      const parentRect = findNodeRect(this.dropParentId, this.currentVpId ?? '');
      if (parentRect) {
        const scale = context.transform.scale || 1;
        // Subtract parent's screen origin and divide by canvas scale so
        // the px we write are in CSS units the parent's rect computed at.
        const localX = (this.lastMouseScreen.x - parentRect.left) / scale;
        const localY = (this.lastMouseScreen.y - parentRect.top) / scale;
        styles.position = 'absolute';
        styles.left = `${Math.round(localX - w / 2)}px`;
        styles.top = `${Math.round(localY - h / 2)}px`;
        // Clear `flex: '0 0 auto'` (carried by some toolbar defaults for
        // layout-friendly insertion) — irrelevant for absolute children
        // and would only confuse the SizeTool's display.
        delete (styles as Record<string, string>).flex;
      } else {
        // Bridge cache miss — fall back to the same parent-relative
        // position the descriptor came with.
        styles.position = 'relative';
      }
    } else if (this.dropIndex !== undefined) {
      // LAYOUT DROP — the new node joins a flex/grid parent as a flow child.
      // Force flex-shrink: 0 so it never inherits the CSS default (shrink: 1),
      // which collapses it to ~0 computed height in a height-constrained flex
      // column (design-tool parity: flow children are Fixed/Hug). A grow > 0 item
      // (Fill) keeps its grow + basis; everything else lands at `0 0 auto`.
      const f = parseFlex(styles.flex || '0 0 auto');
      styles.flex = f.grow > 0 ? `${f.grow} 0 ${f.basis}` : '0 0 auto';
    }

    // Generate children if the item has a children factory (e.g. row/column with default frames)
    const children = this.item.children?.();

    // ORACLE CONFORMANCE — the built-in Insert catalogue goes through the SAME
    // normaliser as plugin-supplied trees (`toolbar-drag-bridge`). It was only
    // ever wired to the plugin path, so the builder's own items shipped shapes
    // its own oracle rejects: `makeFlexChildren` writes `flex: '1'` (grow 1 with
    // shrink 1 → FLEX_CHILD_SHRINKS, the "collapses to 0 in a constrained
    // column" bug) and no `order` at all (FLEX_CHILD_MISSING_ORDER → the child
    // snaps to the front of the order:0 group on first drag-to-reorder). A live
    // page carried 29 of these (user report 2026-07-26).
    //
    // Normalising the WHOLE descriptor (not each child alone) is what assigns
    // sequential `order` — the rule is a property of the parent/child relation,
    // so the children must be seen together. It runs AFTER the drop-context
    // placement above, and only ever tightens it: offsets are stripped just for
    // relative/static roots, so an absolute drop keeps its left/top.
    const normalized = normalizeLayoutDescriptor({
      tag: this.item.elementType, id: nodeId, styles, children,
      attrs: this.item.defaultAttrs, textContent: this.item.textContent,
      // Name rides along so the svg shape decomposition can label its
      // per-shape children ("Ahrefs 1/2/3" instead of "Shape 1/2/3").
      name: this.item.name ?? getInsertItem(this.item.id)?.name,
    });

    // CMS-bound list: the toolbar item id encodes the collection slug
    // (`cms:<slug>`). Surface it on the descriptor so Canvas's add-handler
    // can fire a bindToCmsCollection on the first child after the add
    // lands. The slug stays in the strategy's input — no other code-path
    // cares about it.
    const cmsCollectionSlug = this.item.id.startsWith('cms:')
      ? this.item.id.slice('cms:'.length)
      : undefined;

    // Replica drop logic — mirrors the create-on-replica pattern in
    // FrameCreator/TextCreator/etc. and the canvas-drag entry-into-replica
    // path. When the drop lands inside a non-primary viewport (page replica)
    // or a non-default variant (component master) the new node must:
    //   1. Carry inline `display: 'none'` so the primary stays empty (no
    //      @container rule covers the primary, so without this the node
    //      would render on every viewport).
    //   2. Get explicit `display: 'none'` overrides for every OTHER replica/
    //      variant via `hideInAllOthers` so smaller breakpoints don't
    //      inherit the entered's `display: 'unset'` via @media cascade.
    //   3. Get a `display: 'unset'` override for the entered viewport's
    //      @container / variant — overrides the inline hide on the one
    //      viewport the user actually dropped into.
    // Without this trio, the new node either appears on every viewport
    // (primary leaks) or nowhere (over-hidden everywhere).
    //
    // Component-instance exception: when the dropped item is a component
    // instance (uppercase tag like `<YouTubeEmbed>`), inline styles get
    // MERGED onto the component's inner root at parse time
    // (`expandComponent`). The `@media display: unset` rule targets the
    // wrapper's data-id — not the inner root — so the inner root stays
    // `display: none` and nothing renders. Skip the inline write for
    // instances; the per-viewport @media hide rules from `hideInAllOthers`
    // already cover the primary range (every breakpoint emits a bounded
    // `@media (max-width:X) and (min-width:Y+1)` thanks to generator-styles'
    // breakpoint sort), so no primary leak.
    const isReplicaDrop = this.currentVpId !== null && !isPrimaryViewport(this.currentVpId);
    const isComponentInstance = /^[A-Z]/.test(this.item.elementType);
    if (isReplicaDrop && !isComponentInstance) {
      styles.display = 'none';
    }

    const update: PendingUpdate = {
      nodeId,
      type: 'add',
      descriptor: {
        tag: this.item.elementType,
        id: nodeId,
        // Friendly name → `data-name="..."` on the JSX so the Layers
        // panel reads "Pricing Card" / "Sidebar Layout" instead of the
        // bare tag (`div`). Source priority:
        //   1. Explicit `name` on the toolbar item (rare — only for cases
        //      where the InsertItem panel label is too abbreviated, e.g.
        //      cards ("Basic" → "Basic Card") and layouts ("2 Row" →
        //      "2 Row Layout").
        //   2. InsertItem.name from element-data.ts (the panel label) —
        //      single source of truth for "what to call this element".
        //      Captures Frame / Column / Row / Image / Button / Heading
        //      / Paragraph / Quote / etc. automatically.
        //   3. Undefined → generator skips `data-name`, layers falls back
        //      to the tag name (legacy behavior).
        name: this.item.name ?? getInsertItem(this.item.id)?.name,
        styles: normalized.styles,
        attrs: normalized.attrs,
        textContent: normalized.textContent,
        children: normalized.children,
        cmsCollectionSlug,
      },
      newParentId: this.dropParentId ?? undefined,
      newIndex: this.dropIndex,
    };

    trace.action('toolbar-drag:drop', {
      nodeId,
      parentId: this.dropParentId,
      index: this.dropIndex,
      tag: this.item.elementType,
      vpId: this.currentVpId,
      isReplicaDrop,
    });

    // Order matters here: hide/unhide CSS lands BEFORE the add. The add
    // triggers a full renderer rebuild that paints the new element on
    // every viewport's DOM. If the @media `display:none` rules aren't yet
    // in the canvas <style>, the primary briefly shows the new node — the
    // user sees a frame of layout shift before the CSS arrives and removes
    // it. Inserting CSS first means the rule is already matching when
    // the element first hits the DOM, so primary stays visually still.
    const updates: PendingUpdate[] = [];

    if (isReplicaDrop && this.currentVpId) {
      const vpId = this.currentVpId;
      const activeFilePath = getActiveFilePath();
      const vpWidths = getViewportWidths();
      const rctx = getReplicaContext(vpId, activeFilePath, vpWidths);
      const isComponent = isComponentFilePath(activeFilePath);

      // Hide on all OTHER replicas/variants. For component masters this also
      // hides on `default` (the framer-motion baseline), which is the
      // correct way to keep the new node out of the primary variant.
      for (const hide of rctx.hideInAllOthers(nodeId)) {
        updates.push(hide);
      }

      // Unhide on the entered replica/variant. Mirrors
      // `queueReplicaCreationUnhide` from creator-utils — same shape, but
      // emitted as PendingUpdates so they ride the same onCommit path as the
      // `add` mutation (no race between flushNow and queueMutation).
      //
      // Component-instance exception: skip the unhide entirely. We didn't
      // write the inline `display:'none'` (because that would merge onto the
      // inner root and break rendering — see comment above), so there's
      // nothing to override on the entered viewport. The wrapper renders
      // as a `<div>` (Renderer.VALID_TAGS fallback) with default
      // `display: block`. Writing `display: 'unset' !important` here would
      // FORCE the wrapper to `display: inline` (CSS `unset` resolves to
      // the initial value, which is `inline` for any element when an
      // !important author rule beats the UA stylesheet), and inline boxes
      // ignore width/height — the embed renders at 0×0.
      if (!isComponentInstance) {
        if (isComponent) {
          updates.push({
            nodeId,
            type: 'updateVariantStyle',
            variantName: vpId,
            styles: { display: 'unset' },
          });
        } else {
          updates.push({
            nodeId,
            type: 'updateContainerStyle',
            maxWidth: vpWidths[vpId] ?? 0,
            styles: { display: 'unset' },
          });
        }
      }

      trace.action('toolbar-drag:replica-writes', {
        nodeId, vpId, isComponent, hideCount: updates.length - 1,
      });
    }

    // `add` last — its rebuild is what makes the new element visible.
    // The hide/unhide rules above are already in the iframe's <style> block
    // by the time this re-render runs.
    updates.push(update);

    // Renumber sibling `order` styles when the drop parent already has
    // explicit `order:N` on its children (set by a previous reorder).
    // Without this, the new element ships to the JSX position the user
    // asked for — but its CSS `order` is the default `0`, so it visually
    // lands at the top of the layout instead of where the drop-line
    // showed. `computeLayoutInsertOrderUpdates` returns [] when no
    // sibling has an explicit order, so the cost in the common case is
    // a single bridge cache lookup. Mirrors the same call
    // CanvasDragStrategy makes after a layout-entry move.
    if (
      this.dropParentId &&
      this.dropIndex !== undefined &&
      this.currentVpId
    ) {
      const direction = getFlexDirectionById(this.dropParentId, this.currentVpId);
      const orderUpdates = computeLayoutInsertOrderUpdates(
        this.dropParentId,
        this.currentVpId,
        this.dropIndex,
        [nodeId],
        direction === 'column' ? 'column' : 'row',
        (id) => context.nodes.get(id)?.styles?.order,
      );
      // Routed, never raw. A raw `type: 'style'` order write is only correct on
      // the primary viewport — on a component master's variant tile
      // `updateNodeStyles` sends it to `variants[X].order = N`, which
      // framer-motion tweens as a float and overlays on the inline value, so
      // the node parks at the wrong slot (user report 2026-07-27).
      updates.push(...commitOrderAssignments(orderUpdates, context.contentEl, this.currentVpId));
    }

    this.reset();
    return updates;
  }

  onCancel(): void {
    toolbarGhostOps.hide();
    dropLineOps.hide();
    parentHighlightOps.hide();
    trace.action('toolbar-drag:cancel');
    this.reset();
  }

  /** Test helper — set internal state for unit testing onEnd logic. */
  _setTestState(state: { isOverCanvas: boolean; dropParentId: string | null; dropIndex?: number; currentVpId?: string | null }): void {
    if (state.currentVpId !== undefined) this.currentVpId = state.currentVpId;
    this.isOverCanvas = state.isOverCanvas;
    this.dropParentId = state.dropParentId;
    this.dropIndex = state.dropIndex;
  }

  private reset(): void {
    this.item = null;
    this.currentVpId = null;
    this.dropParentId = null;
    this.dropIndex = undefined;
    this.isOverCanvas = false;
    this.lastMouseScreen = { x: 0, y: 0 };
  }
}
