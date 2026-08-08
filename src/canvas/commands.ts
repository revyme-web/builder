// commands.ts — High-level user commands (select, delete, wrap, unfold, lock, hide).
// Called from BOTH context menu AND keyboard shortcuts.
// Each command composes low-level operations from node-ops.ts.

import type { CanvasNode } from '@/code/parsing/parser';
import { TRANSPARENT_FILL } from '@/shared/css-utils';
import { getDefaultStore } from 'jotai';
import { removeNode, updateNodeStyles, isPrimaryViewport, getInteractingViewport, getActiveFilePath, patchNodeStyles, getViewportPrefix, vpIdFromPrefix, parseRectCacheKey, findNodeRect } from './node-ops';
import { isIconSetFilePath, isComponentFilePath } from '@/code/project/active-file-store';
import { removeVariant } from '@/code/variants/variant-ops';
import { nodesAtom, hoveredIdAtom, hoveredNodeIdAtom } from '@/code/stores/store';
import { toast } from 'sonner';
import { parseIconSetConfig } from '@/code/icons/icon-set-config';
import { removeIconFromSet } from '@/code/icons/icon-set-ops';
import { projectFS } from '@/code/project/project-fs';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { parseCanvasConfig, updateCanvasConfigInCode } from '@/code/project/canvas-config';
import { clearContainerStylesForWidth, removeResponsiveBreakpoint } from '@/code/generation/generator-styles';
import { modifyProjectFile } from '@/code/project/modify-file';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { parseOverlayCalls, parseOverlayTriggerCalls } from '@/code/parsing/overlay-parser';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { queueMutation, flushNow, setDeferNextFanOut } from '@/code/mutation/mutation-queue';
import { moveNodeInCache, updateNodeInCache, removeNodeFromCache } from '@/code/stores/store';
import { generateNodeId } from '@/shared/id-utils';
import { FIT_SIZE, isFitSize, isTextTag } from '@/shared/constants';
import { transformManager } from './transform';
import { trace } from '@/shared/debug-trace';
import { copyNodes } from '@/code/features/paste-engine';
import { executePaste } from '@/code/features/paste-engine/execute-from-ui';

// ─── Selection Navigation ───────────────────────────────────────────────────

/** Select the parent of the currently selected node */
export function selectParent(selectedId: string, nodesMap: Map<string, CanvasNode>): string | null {
  const node = nodesMap.get(selectedId);
  if (!node?.parentId) return null;
  // Templated page: the template is merged onto `root`, and the page's
  // sections sit in its `{children}` slot. When that slot is the template
  // root, a section's parent IS `root` (escape → viewport, one level —
  // same as a non-templated page). When a template NESTS `{children}` in
  // an inner container, the parent is a locked `layout::` node — escaping
  // there would select template chrome. Redirect any `layout::` parent
  // straight to the viewport so Escape always lands on the viewport.
  if (node.parentId.startsWith('layout::')) {
    trace.action('node-ops:select-parent', { from: selectedId, to: 'root', viaLayout: node.parentId });
    return 'root';
  }
  trace.action('node-ops:select-parent', { from: selectedId, to: node.parentId });
  return node.parentId;
}

/**
 * Walk up from `hitId` until we find the direct child of `containerId`,
 * or until we hit a top-level node (parentId === null) when no container
 * is active. Used by Figma-style nested selection: with direct-selection
 * OFF, a click on a deep child should resolve to whatever immediate
 * descendant of the user's "active container" wraps it.
 *
 *   - `containerId === null` → walk up to the topmost ancestor with no
 *     parent (the top-level frame on the page).
 *   - `containerId` set → walk up until the next step would BE that
 *     container; return the current id (= direct child of container).
 *   - `hitId === containerId`, or hitId IS the active container itself,
 *     or `hitId` is already a direct child of container → return hitId
 *     unchanged (no walk needed).
 *
 * Falls through to `hitId` unchanged if the walk runs out of parents
 * before reaching the container — a defensive guard for stale ids
 * after a delete or page switch.
 */
export function redirectToTopLevelChild(
  hitId: string,
  containerId: string | null,
  nodesMap: Map<string, CanvasNode>,
): string {
  // Hit IS the container itself → can't drill in further; return as-is
  // (Figma keeps the container selected when you click on its own
  // background area while inside it).
  if (containerId !== null && hitId === containerId) return hitId;
  let current: string = hitId;
  // Hard cap on the walk to avoid infinite loops if the node map has
  // a cycle (shouldn't happen, but parser bugs occasionally produce
  // self-referential parentIds during transient states).
  for (let i = 0; i < 50; i++) {
    const node = nodesMap.get(current);
    if (!node) return hitId;
    const parentId = node.parentId;
    if (parentId === containerId) return current;
    if (parentId === null || parentId === undefined) return current;
    current = parentId;
  }
  return hitId;
}

/** Get children IDs of the selected node */
export function selectChildren(selectedId: string, nodesMap: Map<string, CanvasNode>): string[] {
  const node = nodesMap.get(selectedId);
  if (!node || node.children.length === 0) return [];
  trace.action('node-ops:select-children', { parentId: selectedId, count: node.children.length });
  return node.children;
}

/** Siblings in FLOW order — the order the user SEES. The reorder engine moves
 *  nodes via CSS `order`, so source `parent.children` order ≠ visual order
 *  (this page's root sections carry shuffled order props from drag-reorders).
 *  Stepping by source index made Shift+Tab land on what LOOKS like the next
 *  sibling (live find 2026-07-21). Sort by numeric `order` (default 0, non-
 *  numeric ternaries → 0), stable by source index — the same flow rule the
 *  drag reorder math uses. */
function siblingsInFlowOrder(parent: CanvasNode, nodesMap: Map<string, CanvasNode>): string[] {
  return parent.children
    .filter((id) => {
      // Tab cycles the user's OWN flow content only:
      // - `layout::` template chrome (Header/Footer on a merged templated page)
      //   is LOCKED — not editable from the page, so cycling into it dead-ends
      //   the shortcut on an unselectable node (user report 2026-07-28).
      // - OVERLAYS are floating conditional layers (portaled/fixed, usually
      //   closed) — Tab jumped the selection onto an invisible fixed overlay.
      if (id.startsWith('layout::')) return false;
      if (nodesMap.get(id)?.attrs?.['data-overlay']) return false;
      return true;
    })
    .map((id, srcIdx) => {
      const raw = nodesMap.get(id)?.styles?.order;
      const n = typeof raw === 'string' || typeof raw === 'number' ? parseFloat(String(raw)) : NaN;
      return { id, srcIdx, order: Number.isFinite(n) ? n : 0 };
    })
    .sort((a, b) => a.order - b.order || a.srcIdx - b.srcIdx)
    .map((s) => s.id);
}

/** Select the next sibling (in visual/flow order) */
export function selectNextSibling(selectedId: string, nodesMap: Map<string, CanvasNode>): string | null {
  const node = nodesMap.get(selectedId);
  if (!node?.parentId) return null;
  const parent = nodesMap.get(node.parentId);
  if (!parent) return null;
  const flow = siblingsInFlowOrder(parent, nodesMap);
  const idx = flow.indexOf(selectedId);
  if (idx < 0) return null;
  const nextIdx = (idx + 1) % flow.length; // Wrap around
  trace.action('node-ops:select-next-sibling', { from: selectedId, to: flow[nextIdx] });
  return flow[nextIdx];
}

/** Select the previous sibling (in visual/flow order) */
export function selectPrevSibling(selectedId: string, nodesMap: Map<string, CanvasNode>): string | null {
  const node = nodesMap.get(selectedId);
  if (!node?.parentId) return null;
  const parent = nodesMap.get(node.parentId);
  if (!parent) return null;
  const flow = siblingsInFlowOrder(parent, nodesMap);
  const idx = flow.indexOf(selectedId);
  if (idx < 0) return null;
  const prevIdx = idx <= 0 ? flow.length - 1 : idx - 1; // Wrap around
  trace.action('node-ops:select-prev-sibling', { from: selectedId, to: flow[prevIdx] });
  return flow[prevIdx];
}

/** Select the next replica of a node (cycles through viewports: desktop→tablet→mobile→desktop) */
export function selectNextReplica(selectedId: string, _contentEl: HTMLElement): string | null {
  const bridge = getCanvasBridge();
  if (!('rectCache' in bridge)) return null;
  const cache = (bridge as any).rectCache as Map<string, DOMRect>;
  const vpIds: string[] = [];
  for (const key of cache.keys()) {
    const { vpPrefix, nodeId } = parseRectCacheKey(key) ?? { vpPrefix: '', nodeId: key };
    if (nodeId === selectedId) {
      const vpId = vpIdFromPrefix(vpPrefix);
      if (!vpIds.includes(vpId)) vpIds.push(vpId);
    }
  }
  if (vpIds.length <= 1) return null;
  const currentVpId = getInteractingViewport().vpId;
  const currentIdx = vpIds.indexOf(currentVpId);
  if (currentIdx === -1) return null;
  const nextIdx = (currentIdx + 1) % vpIds.length;
  trace.action('commands:select-next-replica', { from: currentVpId, to: vpIds[nextIdx] });
  return vpIds[nextIdx];
}

// ─── Node Manipulation ──────────────────────────────────────────────────────

/**
 * Delete nodes — viewport-aware.
 *
 * Primary viewport: always removes the node from code entirely.
 * Replica viewport:
 *   - If the node is only visible in this one viewport → remove from code entirely.
 *   - If visible in other viewports too → add display:none via @container for this viewport.
 */
export function deleteNode(nodeIdOrIds: string | string[], contentEl: HTMLElement): void {
  const ids = Array.isArray(nodeIdOrIds) ? nodeIdOrIds : [nodeIdOrIds];
  const { vpId, vpWidth } = getInteractingViewport();
  const isPrimary = isPrimaryViewport(vpId);

  // Filter out layout nodes and placeholder — they can't be deleted from page context
  const filteredIds = ids.filter(id => !id.startsWith('layout::') && id !== 'children-slot');
  if (filteredIds.length === 0) return;

  trace.action('commands:delete', { nodeIds: filteredIds, vpId, isPrimary });

  // Clear hover IMMEDIATELY if a node being deleted is currently hovered — otherwise
  // its hover border lingers at the deleted node's old spot ~0.2s: the rect cache
  // still holds the gone node's rect, and nothing re-detects hover until the next
  // mousemove. Same imperative-instant intent as the selection clear the callers do.
  // Covers every delete path below (page-root, variant, primary) since it runs first.
  {
    const store = getDefaultStore();
    const hov = store.get(hoveredIdAtom);
    if (hov && filteredIds.includes(hov)) {
      // Mirror the mouse controller's hover-off: clear id + nodeId (the viewport
      // atom is non-nullable and left as-is, exactly like the controller does).
      store.set(hoveredIdAtom, null);
      store.set(hoveredNodeIdAtom, null);
    }
  }

  // Page file: deleting the page ROOT on a NON-primary viewport means
  // "delete this replica viewport", NOT delete the page root (which would
  // wipe every viewport's render of it). Strips the viewport entry from
  // the page's `@canvas` config AND every `@media` override authored for
  // that breakpoint width. Primary-viewport root delete is blocked here —
  // pages are deleted via the Pages panel, not the canvas.
  const activeFile = getActiveFilePath();
  if (!isComponentFilePath(activeFile)) {
    const nodes = getDefaultStore().get(nodesAtom);
    const deletingPageRoot = filteredIds.some(id => {
      const n = nodes.get(id);
      return !!n && n.parentId == null && !n.isCanvasNode;
    });
    if (deletingPageRoot) {
      if (isPrimary) {
        toast.info('Primary viewport cannot be deleted. To delete the page, use the Pages panel.');
        trace.action('commands:delete-page-root-blocked-primary', { vpId });
        return;
      }
      removeReplicaViewport(activeFile, vpId);
      return;
    }
  }

  // Design-component master: deleting a top-level variant ROOT means
  // "delete this variant", NOT remove the root node — removing the root
  // JSX would wipe EVERY variant (they all render the same root node).
  // Route the root to removeVariant; the primary variant can't be deleted.
  if (isComponentFilePath(activeFile)) {
    const nodes = getDefaultStore().get(nodesAtom);
    const deletingRoot = filteredIds.some(id => {
      const n = nodes.get(id);
      return !!n && n.parentId == null && !n.isCanvasNode;
    });
    if (deletingRoot) {
      if (isPrimary) {
        toast.info('Primary variants are not deletable. To delete the component, use the Library panel.');
        trace.action('commands:delete-variant-blocked-primary', { vpId });
        return;
      }
      // For a component master, the interacting viewport id IS the variant name.
      removeVariant(activeFile, vpId);
      trace.action('commands:delete-variant', { variant: vpId, filePath: activeFile });
      return;
    }
  }

  if (isPrimary) {
    // Primary viewport: full delete from code.
    //
    // Pre-step: when on an icon-set master file, deleting
    // a VARIANT CONTAINER (a direct child of master root listed in
    // iconConfig) needs to clean up the config
    // array too. The regular `removeNode` mutation only strips the
    // JSX block; without also dropping the matching iconConfig
    // entry, the IconSetTool variant
    // picker keeps showing phantom thumbnails for the deleted variant
    // (clicking them lands on `null` content), and the parser's
    // config→node merge re-emits a 240×240 ghost rect on every
    // re-render. Route through the helper which writes
    // both the config strip AND the JSX strip in one transactional
    // file write, then skip the regular `removeNode` for that id.
    const ap = getActiveFilePath();
    const isIconMaster = isIconSetFilePath(ap);
    const containerSetVariantIds: Set<string> = new Set();
    if (isIconMaster) {
      const code = projectFS.readFile(ap) || '';
      const variantNames = new Set(parseIconSetConfig(code).map(c => c.name));
      for (const id of filteredIds) {
        if (variantNames.has(id)) containerSetVariantIds.add(id);
      }
      for (const id of containerSetVariantIds) {
        removeIconFromSet(ap, id);
        trace.action('commands:delete-container-set-variant', {
          id, kind: 'icon', filePath: ap,
        });
      }
    }
    // Detect overlays/triggers from the PARSED CODE, not the DOM. The canvas
    // lives in the iframe, so `findParentFrameElement`/`document.querySelector`
    // in the parent frame can't see overlay elements — the old DOM check always
    // returned null and fell through to a plain `removeNode`, which strips only
    // the element and leaves a dangling `{varOpen && ( )}` wrapper + orphaned
    // useState/useLayoutEffect (the "Unexpected token" parse error on delete).
    const overlayCode = projectFS.readFile(ap) || '';
    const overlayCalls = parseOverlayCalls(overlayCode);
    const triggerCalls = parseOverlayTriggerCalls(overlayCode);
    const deletedSet = new Set(filteredIds);
    // Dedupe overlay teardowns — an overlay can be reached as the directly
    // deleted node, as a trigger cascade, AND as an orphan; only queue once.
    const removedOverlayIds = new Set<string>();
    const removeOverlay = (overlayId: string, triggerId: string, reason: string) => {
      if (removedOverlayIds.has(overlayId)) return;
      removedOverlayIds.add(overlayId);
      queueMutation({ type: 'removeOverlay', overlayId, triggerId });
      trace.action('commands:remove-overlay', { overlayId, triggerId, reason });
    };

    for (const id of filteredIds) {
      // Skip regular removeNode for variants we already routed through
      // the kind-specific helper above — that helper strips the JSX
      // block via modifyProjectFile, so a follow-up `removeNode` would
      // queue a no-op mutation against an already-deleted block.
      if (containerSetVariantIds.has(id)) continue;
      // Overlay node: tear down the WHOLE mechanism (conditional block +
      // useState + useLayoutEffect + trigger attr/handler) via removeOverlay.
      const overlay = overlayCalls.find(o => o.overlayId === id);
      if (overlay) {
        const triggerId = overlay.config.triggerId
          || triggerCalls.find(t => t.config.targetId === id)?.triggerId
          || '';
        removeOverlay(id, triggerId, 'overlay-node');
        continue;
      }
      // Source/trigger node: an overlay can't outlive its trigger, so deleting
      // the source node tears down EVERY overlay attached to it — not just when
      // the overlay itself is deleted. Match in BOTH directions (any overlay
      // whose config.triggerId points here) so a desynced/missing
      // data-overlay-trigger attr still cascades.
      for (const o of overlayCalls) {
        if (o.config.triggerId === id) removeOverlay(o.overlayId, id, 'trigger-cascade');
      }
      removeNode({ id, contentEl });
    }

    // Orphan sweep. A relative overlay whose trigger node no longer exists —
    // deleted just now, OR already gone from a prior edit — is dead weight: it
    // can never be opened (no trigger to enter overlay mode) and is invisible
    // on canvas (overlays are display:none outside overlay mode), so the user
    // can't even select it to delete. It only bleeds an empty `{xOpen && <div/>}`
    // block into the source. Drop any such overlay we haven't already handled.
    // Trigger existence is checked against the SURVIVING node set (all page
    // nodes — incl. canvas nodes — minus the ids being deleted this call).
    const nodesNow = getDefaultStore().get(nodesAtom);
    for (const o of overlayCalls) {
      const trig = o.config.triggerId;
      const triggerGone = !trig || deletedSet.has(trig) || !nodesNow.has(trig);
      if (triggerGone) removeOverlay(o.overlayId, trig || '', 'orphan-sweep');
    }

    // If the overlay being EDITED was just removed (deleted directly, via its
    // trigger, or swept), exit overlay mode — otherwise the accent "Editing
    // Overlay" header stays up pointing at a node that no longer exists.
    const editingOverlayId = getDefaultStore().get(overlayEditingIdAtom);
    if (editingOverlayId && removedOverlayIds.has(editingOverlayId)) {
      getDefaultStore().set(overlayEditingIdAtom, null);
      trace.action('commands:delete-exit-overlay-mode', { overlayId: editingOverlayId });
    }
    return;
  }

  // Replica viewport: use ReplicaContext for correct routing (page vs component)
  const vpWidths = getViewportWidths();
  const rctx = getReplicaContext(vpId, getActiveFilePath(), vpWidths);

  // Overlay deletion is viewport-INDEPENDENT — an overlay is one mechanism, not
  // a per-replica box, so deleting it from ANY tile must fully remove it (and
  // exit overlay mode), never hide it via @container. Handle that here too (the
  // primary branch above does the same) so deleting from a replica tile works.
  const rOverlayCode = projectFS.readFile(getActiveFilePath()) || '';
  const rOverlayCalls = parseOverlayCalls(rOverlayCode);
  const rTriggerCalls = parseOverlayTriggerCalls(rOverlayCode);
  const editingOverlayId = getDefaultStore().get(overlayEditingIdAtom);
  const remainingIds: string[] = [];
  for (const id of filteredIds) {
    const overlay = rOverlayCalls.find(o => o.overlayId === id);
    if (overlay) {
      const triggerId = overlay.config.triggerId
        || rTriggerCalls.find(t => t.config.targetId === id)?.triggerId || '';
      queueMutation({ type: 'removeOverlay', overlayId: id, triggerId });
      if (editingOverlayId === id) getDefaultStore().set(overlayEditingIdAtom, null);
      trace.action('commands:delete-overlay-replica', { overlayId: id, triggerId });
      continue;
    }
    remainingIds.push(id);
  }

  for (const id of remainingIds) {
    const mutations = rctx.deleteUpdate(id, contentEl);
    for (const m of mutations) {
      if (m.type === 'remove') {
        trace.action('commands:delete-full', { id, vpId, reason: 'only-visible-here' });
        removeNode({ id, contentEl });
      } else {
        trace.action('commands:delete-hide', { id, vpId, vpWidth: rctx.vpWidth, isComponent: rctx.isComponent });
        // Hide in DOM immediately — use patchNodeStyles (bridge-compatible)
        const prefix = getViewportPrefix(vpId);
        patchNodeStyles(contentEl, id, prefix, { display: 'none' });
        queueMutation(m as any);
      }
    }
  }
}

/** Toggle lock on a node (prevents selection/drag) */
export function toggleLock(nodeId: string, contentEl: HTMLElement, nodesMap: Map<string, CanvasNode>): void {
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const isLocked = node.styles.pointerEvents === 'none';
  const newValue = isLocked ? '' : 'none';
  trace.action('node-ops:toggle-lock', { nodeId, locked: !isLocked });
  updateNodeStyles({ id: nodeId, styles: { pointerEvents: newValue }, contentEl });
}

/** Toggle visibility on a node */
export function toggleVisibility(nodeId: string, contentEl: HTMLElement, nodesMap: Map<string, CanvasNode>): void {
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const isHidden = node.styles.display === 'none';
  const newValue = isHidden ? '' : 'none';
  trace.action('node-ops:toggle-visibility', { nodeId, hidden: !isHidden });
  updateNodeStyles({ id: nodeId, styles: { display: newValue }, contentEl });
}

// ─── Structure Operations ───────────────────────────────────────────────────

/**
 * Wrap selected absolute (or canvas) nodes in a new frame at the bounding
 * box of the selection. Selected nodes become children with their `left` /
 * `top` rewritten to be frame-relative so visual positions stay stable.
 *
 * Supports two encapsulation contexts:
 *   • All selected nodes are canvas-level (`isCanvasNode`, `parentId === null`)
 *     → new frame is itself a canvas node sized at the bounding box.
 *   • All selected nodes share the same parent AND are absolute-positioned
 *     → new frame is an absolute child of that parent, sized at the
 *       bounding box of selection in parent-relative coords.
 *
 * Mixed selections (canvas + in-parent, or different parents, or non-
 * absolute flow children) abort with `null` — the operation requires a
 * coherent "wrap these into a box" gesture.
 */
export function wrapInFrame(
  nodeIds: string[],
  nodesMap: Map<string, CanvasNode>,
  _contentEl: HTMLElement,
  _onMouseDown?: (nodeId: string, e: MouseEvent) => void,
  /** `keepFlowChildren` opts out of the flow→absolute bake, giving the old
   *  content-hugging flow wrapper. For INTERNAL wraps that only want to give one
   *  element a box — Make Component on a bare text node — where a px-frozen
   *  frame would stop the master growing with its text
   *  ([[feedback_text_containers_never_fixed_size]]). The user-facing Create
   *  Frame gesture never sets it. */
  opts?: { keepFlowChildren?: boolean },
): string | null {
  return wrapInternal(nodeIds, nodesMap, /* layout */ false, !opts?.keepFlowChildren);
}

/**
 * Like `wrapInFrame` but the new frame is a flex column with center
 * alignment. Children move into the frame as flow items (their inline
 * `position`/`left`/`top` are cleared) so the layout engine takes over —
 * matches the user expectation that "Create Layout" reorganizes the
 * selection into a stack.
 */
export function wrapInLayout(
  nodeIds: string[],
  nodesMap: Map<string, CanvasNode>,
  _contentEl: HTMLElement,
  _onMouseDown?: (nodeId: string, e: MouseEvent) => void,
): string | null {
  return wrapInternal(nodeIds, nodesMap, /* layout */ true);
}

interface BoundingBox { left: number; top: number; width: number; height: number; }

function readNodeBox(node: CanvasNode): BoundingBox | null {
  const s = node.styles ?? {};
  const left = parseFloat(s.left ?? '');
  const top = parseFloat(s.top ?? '');
  const width = parseFloat(s.width ?? '');
  const height = parseFloat(s.height ?? '');
  if (![left, top, width, height].every((n) => Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * Live canvas-space boxes for a set of nodes, or `null` if ANY of them can't be
 * measured (bridge not ready, node culled). All-or-nothing: a partial set would
 * place some children against a bounding box that doesn't contain them.
 *
 * Inline geometry is unusable here — a flow child's size and position come from
 * the PARENT's layout, so `parseFloat(styles.width)` reads `auto` (NaN) or a
 * `%`, and `left`/`top` don't exist at all. Same lesson as
 * [[feedback_frame_encapsulate_auto_size]]: never parseFloat inline geometry for
 * containment or placement — read the bridge's measured rect.
 */
function measureCanvasBoxes(nodeIds: string[]): Map<string, BoundingBox> | null {
  const { vpId } = getInteractingViewport();
  const transform = transformManager.getTransform();
  const out = new Map<string, BoundingBox>();
  for (const id of nodeIds) {
    const r = getAbsoluteCanvasRectById(id, vpId, transform);
    if (!r || r.width <= 0 || r.height <= 0) return null;
    out.set(id, { left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return out;
}

/** `min-content` / FIT survive the flow→absolute move untouched: `align-self:
 *  stretch` only stretches an AUTO cross size, so a fit box shrink-wraps
 *  identically in both contexts — and baking px over it would flip the panel's
 *  Fit classification into a fixed size. */
function isShrinkWrapSize(v: string | undefined): boolean {
  return v === 'min-content' || v === FIT_SIZE;
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const b of boxes) {
    minL = Math.min(minL, b.left);
    minT = Math.min(minT, b.top);
    maxR = Math.max(maxR, b.left + b.width);
    maxB = Math.max(maxB, b.top + b.height);
  }
  return { left: minL, top: minT, width: maxR - minL, height: maxB - minT };
}

/**
 * Shared body for `wrapInFrame` and `wrapInLayout`. Builds the bounding
 * box, validates that all selected nodes share the same encapsulation
 * context (all canvas OR all same-parent absolute), then queues the
 * `addNode`/`addCanvasNode` for the wrapper plus a `move` per child.
 *
 * No DOM access — works in iframe mode, where `getNodeEl` returns null and
 * the previous imperative path silently bailed out (the original bug the
 * user hit).
 */
function wrapInternal(
  nodeIds: string[],
  nodesMap: Map<string, CanvasNode>,
  layout: boolean,
  bakeFlowToAbsolute = false,
): string | null {
  if (nodeIds.length === 0) return null;
  const nodes = nodeIds.map((id) => nodesMap.get(id)).filter((n): n is CanvasNode => !!n);
  if (nodes.length === 0) return null;

  // Classify the selection.
  //   • allCanvas: every node is a canvas-level frame (no parent)
  //   • allSameParentAbsolute: every node is absolute and shares a parent →
  //     wrapper goes at the bounding box, children stay absolute
  //   • allSameParentFlow: every node shares a parent and at least one
  //     isn't absolute → wrapper is a flow child of that parent, children
  //     keep their flow positions inside it. Covers flex / grid / static
  //     parents — useful for grouping siblings without moving them visually.
  const allCanvas = nodes.every((n) => n.isCanvasNode === true && !n.parentId);
  const sharedParentId = nodes[0].parentId;
  const allSameParent = !allCanvas
    && nodes.every((n) => n.parentId === sharedParentId);
  const allSameParentAbsolute = allSameParent
    && nodes.every((n) => (n.styles?.position ?? '') === 'absolute');
  const allSameParentFlow = allSameParent && !allSameParentAbsolute;
  // SINGLE absolute child: the wrapper INHERITS the child's exact positioning
  // (left/top/right/bottom/transform) verbatim — so it lands precisely where the
  // child rendered, with ZERO visual movement, WITHOUT interpreting the values.
  // A parseFloat-bbox mis-reads a `%` left (unit dropped → treated as px, the
  // wrapper flew ~900px off) and ignores `translate(-50%,-50%)` centering + SVG
  // box quirks (live find 2026-07-24: Create Layout/Frame on a centered absolute
  // SVG). Copying the raw strings sidesteps all of it. Multi-child selections
  // still need a real bounding box (below).
  const singleAbsChild = allSameParentAbsolute && nodes.length === 1 ? nodes[0] : null;

  if (!allCanvas && !allSameParent) {
    trace.action('commands:wrap-in-frame:invalid-selection', {
      ids: nodeIds, allCanvas, allSameParent,
    });
    return null;
  }

  // Bounding box only matters for absolute encapsulation. For flow
  // wrapping there's no positioning to compute — the wrapper just slots
  // into the parent's flow at the topmost selected child's index.
  // The single-absolute-child path INHERITS the child's position verbatim and
  // never needs a bounding box — skip it. That also lets an INSET-pinned child
  // (right/bottom, no left/top) be wrapped: readNodeBox requires all four and
  // would otherwise bail the whole command (its left/top parse to NaN).
  // CREATE FRAME ON FLOW CHILDREN. A frame is a free-positioning container — it
  // has no layout, so children inside it can only be placed by `position:
  // absolute`. Leaving them `relative` produced the contradiction the user hit:
  // a no-layout frame whose children still stack in document flow, ignoring the
  // frame entirely (report 2026-08-08). Two things have to be baked from the
  // live layout for the swap to be visually stable:
  //
  //   · the wrapper's SIZE — absolute children are out of flow, so a `width/
  //     height: auto` wrapper would collapse to 0×0 and the parent's flex/grid
  //     would reflow everything around the hole;
  //   · each child's POSITION AND SIZE — both were the parent layout's to
  //     decide (flex-grow width, stretched height, gap-derived offsets), and
  //     none of it survives the move.
  //
  // Measured up front so a failure falls back to the old flow wrapper rather
  // than emitting a frame with collapsed geometry. Create LAYOUT keeps the flow
  // model and is deliberately untouched.
  const wantsFlowBake = allSameParentFlow && !layout && bakeFlowToAbsolute;
  const flowBoxes = wantsFlowBake ? measureCanvasBoxes(nodeIds) : null;
  const flowBbox = flowBoxes ? unionBoxes([...flowBoxes.values()]) : null;
  const flowToAbsolute = !!flowBoxes && !!flowBbox;
  if (wantsFlowBake && !flowToAbsolute) {
    trace.action('commands:wrap-in-frame:flow-unmeasurable', { ids: nodeIds });
  }

  let bbox: BoundingBox | null = null;
  if ((allCanvas || allSameParentAbsolute) && !singleAbsChild) {
    const boxes = nodes.map(readNodeBox).filter((b): b is BoundingBox => !!b);
    if (boxes.length !== nodes.length) {
      trace.action('commands:wrap-in-frame:missing-box', { ids: nodeIds });
      return null;
    }
    bbox = unionBoxes(boxes);
    if (!bbox) return null;
  }

  const frameId = generateNodeId();
  // A frame that wraps TEXT must CLIP its overflow. Text with `line-height < 1`
  // (a tight display font like Koulen at 0.8) has a font-box far TALLER than its
  // line box, and that invisible overflow is HIT-TESTABLE. Stacked text frames
  // then steal each other's hover/click — a later sibling's overflow paints over
  // (and captures pointers on) the earlier word's visible center ("hover HOME →
  // activates WORK"). `overflow: hidden` clips the invisible overflow to the
  // frame bounds (the visible glyphs already fit) — matching every other frame,
  // which clips. Non-text wraps keep `visible` (unchanged) so a wrapped child's
  // shadow/overhang isn't clipped.
  const wrapsText = nodes.length > 0 && nodes.every((n) => isTextTag(n.type));
  const wrapOverflow = wrapsText ? 'hidden' : 'visible';
  // Flow wrapper must INHERIT the wrapped child's placement in the parent —
  // a flow child carries position/order/flex/margin/alignSelf that seat it
  // among its siblings. Left off the wrapper, the group loses its order (jumps
  // to the front) and, critically, Make-Component (which wraps a bare text node
  // in a frame FIRST) then has no wrapper-placement to lift onto the instance
  // tag → the component-master root's forced position:absolute leaks through
  // the `...style` spread and the element COLLAPSES in live preview. Inherit
  // the topmost child's placement onto the wrapper (and clear it on the moved
  // child below) so the instance carries position:relative + order + flex.
  const flowFirstNode = (() => {
    if (!allSameParentFlow) return undefined;
    const parent = nodesMap.get(sharedParentId!);
    if (!parent) return nodes[0];
    const ordered = nodeIds
      .map((id) => ({ id, idx: parent.children.indexOf(id) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx);
    return ordered.length ? nodesMap.get(ordered[0].id) : nodes[0];
  })();
  const flowPlacement: Record<string, string> = {};
  if (allSameParentFlow) {
    // Always relative — a flow wrapper is a positioning context and must not
    // inherit a stray absolute from a componentized master.
    flowPlacement.position = 'relative';
    const os = flowFirstNode?.styles ?? {};
    if (os.order != null && os.order !== '') flowPlacement.order = os.order;
    // flex/alignSelf/margin are per-child — only unambiguous when wrapping ONE
    // element (the Make-Component-on-text case). Multiple children keep their
    // own flex/margins inside the wrapper.
    if (nodes.length === 1) {
      for (const k of ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
        'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const) {
        const v = os[k];
        if (v != null && v !== '') flowPlacement[k] = v;
      }
    }
  }
  let baseFrameStyles: Record<string, string>;
  if (allSameParentFlow) {
    // Flow wrapper: parent is flex/grid/static and the selected children
    // are flow items. The wrapper drops into the parent's layout in place
    // of the topmost selected child (via flowPlacement above) and the
    // children keep flowing inside it.
    baseFrameStyles = layout
      ? {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          // Fit = min-content (NOT auto): a flex motion.div with layout={true}
          // won't shrink-to-content under `auto`, but does under min-content.
          width: FIT_SIZE,
          height: FIT_SIZE,
          backgroundColor: TRANSPARENT_FILL,
          overflow: wrapOverflow,
          ...flowPlacement,
        }
      : flowToAbsolute
      ? {
          // Absolute-positioning frame seated in the parent's flow. Its box is
          // the selection's measured union, so it occupies exactly the space
          // the wrapped children did — including the parent `gap`s BETWEEN
          // them, which the union naturally spans (the gaps around the group
          // are still the parent's to apply). `flex: 0 0 auto` keeps the parent
          // from growing or shrinking it off that measured size.
          width: `${Math.round(flowBbox!.width)}px`,
          height: `${Math.round(flowBbox!.height)}px`,
          flex: '0 0 auto',
          backgroundColor: TRANSPARENT_FILL,
          overflow: wrapOverflow,
          ...flowPlacement,
        }
      : {
          // Unmeasurable fallback — the pre-2026-08-08 flow wrapper. Children
          // keep flowing inside it; not a frame in the positioning sense, but
          // it never collapses.
          width: 'auto',
          height: 'auto',
          backgroundColor: TRANSPARENT_FILL,
          overflow: wrapOverflow,
          ...flowPlacement,
        };
  } else if (singleAbsChild) {
    // Wrapper inherits the child's exact positioning (see `singleAbsChild`).
    // Copying left/top/right/bottom/transform verbatim means the wrapper's box
    // resolves to the same screen spot the child was at — for ANY unit / center
    // transform / inset / SVG. The child is reset to the wrapper's origin below.
    const cs = singleAbsChild.styles ?? {};
    const inheritPos: Record<string, string> = { position: 'absolute' };
    for (const k of ['left', 'top', 'right', 'bottom', 'transform'] as const) {
      if (cs[k] != null && cs[k] !== '') inheritPos[k] = cs[k]!;
    }
    baseFrameStyles = layout
      ? {
          ...inheritPos,
          // FIT (min-content) so the flex column hugs the single child →
          // wrapper box == child box, and any inherited translate(-50%) resolves
          // against that same size (identical shift to the child's original).
          width: FIT_SIZE,
          height: FIT_SIZE,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: TRANSPARENT_FILL,
          overflow: wrapOverflow,
        }
      : {
          ...inheritPos,
          // Plain frame: take the child's own box so the child sits at 0,0 inside.
          // Real absolute elements always carry explicit width/height; fall back
          // to `auto` (hug) on the rare element that doesn't (no bbox here).
          width: cs.width || 'auto',
          height: cs.height || 'auto',
          backgroundColor: TRANSPARENT_FILL,
          overflow: wrapOverflow,
        };
  } else if (layout) {
    // Layout container at bounding box: hug the content. Children flow
    // vertically and center; the wrapper sizes to whatever the flex column
    // resolves to. Matches Figma's "Create Auto Layout" gesture.
    baseFrameStyles = {
      position: 'absolute',
      left: `${Math.round(bbox!.left)}px`,
      top: `${Math.round(bbox!.top)}px`,
      // Fit = min-content so the flex column hugs its content (auto won't shrink).
      width: FIT_SIZE,
      height: FIT_SIZE,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: TRANSPARENT_FILL,
      overflow: wrapOverflow,
    };
  } else {
    // Plain frame at bounding box: children stay absolute and keep their
    // relative positions, so the wrapper has to be the same shape as the
    // selection's outer rect.
    baseFrameStyles = {
      position: 'absolute',
      left: `${Math.round(bbox!.left)}px`,
      top: `${Math.round(bbox!.top)}px`,
      width: `${Math.round(bbox!.width)}px`,
      height: `${Math.round(bbox!.height)}px`,
      backgroundColor: TRANSPARENT_FILL,
      overflow: wrapOverflow,
    };
  }

  trace.action('commands:wrap-in-frame:plan', {
    frameId, childIds: nodeIds, layout, allCanvas, parentId: sharedParentId,
    bbox,
  });

  // Queue create + moves. The mutation queue applies them in order against
  // the same code string, so insert order is preserved.
  if (allCanvas) {
    queueMutation({
      type: 'addCanvasNode',
      node: { id: frameId, type: 'div', name: 'Frame', styles: baseFrameStyles },
    });
  } else {
    // Insert before the first selected child so the wrapper appears in
    // the same visual stacking position as the topmost selected element.
    const parent = nodesMap.get(sharedParentId!);
    const firstIdx = parent
      ? Math.min(
          ...nodeIds
            .map((id) => parent.children.indexOf(id))
            .filter((i) => i >= 0),
        )
      : undefined;
    queueMutation({
      type: 'addNode',
      parentId: sharedParentId!,
      index: Number.isFinite(firstIdx) ? firstIdx : undefined,
      node: { id: frameId, type: 'div', name: 'Frame', styles: baseFrameStyles },
    });
  }

  // Move each selected node into the new frame. Three style branches:
  //   • Flow wrapper (parent was flex/grid): leave each child's styles
  //     alone — they keep their flow placement inside the wrapper.
  //   • Layout wrapper at bbox: clear position/left/top so the flex column
  //     takes over (Create Layout on absolute selection).
  //   • Plain frame at bbox: rewrite left/top frame-relative (Create Frame
  //     on absolute or canvas selection).
  for (const node of nodes) {
    let styles: Record<string, string> | undefined;
    if (flowToAbsolute) {
      // Flow → absolute inside the new frame. Position is the child's measured
      // offset from the frame's origin: the frame has no border or padding, so
      // its padding box (an absolute child's containing block) starts exactly
      // at the union bbox's top-left.
      const r = flowBoxes!.get(node.id)!;
      const own = node.styles ?? {};
      // Size has to be baked for the same reason position does — it was the
      // parent layout's output. A flex-grown width or a stretched height reads
      // `auto`, and `auto` on an out-of-flow box means shrink-to-fit, so the
      // child would visibly collapse. Two values are left alone: a shrink-wrap
      // size (identical in both models) and a TEXT node's height, which stays
      // `auto` so editing the copy can still grow it — the baked width already
      // pins the wrap, so the resolved height is unchanged either way.
      const width = isShrinkWrapSize(own.width) ? '' : `${Math.round(r.width)}px`;
      const height = isShrinkWrapSize(own.height)
        ? ''
        : isTextTag(node.type) ? 'auto' : `${Math.round(r.height)}px`;
      styles = {
        position: 'absolute',
        left: `${Math.round(r.left - flowBbox!.left)}px`,
        top: `${Math.round(r.top - flowBbox!.top)}px`,
        right: '', bottom: '',
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        // Margins still apply to an absolute box and would offset it off the
        // computed left/top; the flex props are inert on an out-of-flow child
        // (an abspos child of a flex container is not a flex item) but keeping
        // them would mislead the panel about how the node is placed.
        margin: '', marginTop: '', marginRight: '', marginBottom: '', marginLeft: '',
        flex: '', flexGrow: '', flexShrink: '', flexBasis: '', alignSelf: '', order: '',
      };
    } else if (allSameParentFlow) {
      // The wrapper now carries the flow placement (flowPlacement above). Clear
      // the SINGLE wrapped child's copy so it doesn't double-apply (margin
      // twice, order fighting) — the child becomes an in-flow child of the
      // wrapper. Multi-child selections keep each child's own placement so
      // their relative order/spacing survives inside the wrapper.
      if (nodes.length === 1 && node.id === flowFirstNode?.id) {
        styles = {
          order: '0', alignSelf: '',
          margin: '', marginTop: '', marginRight: '', marginBottom: '', marginLeft: '',
        };
      } else {
        styles = undefined; // no style change — preserve flow placement
      }
    } else if (node.id === singleAbsChild?.id) {
      // Wrapper now carries the child's original position (inheritPos above),
      // so the child resets to the wrapper's origin — zero net movement.
      //   • Create Layout: clear positioning entirely → the flex column centers
      //     it (wrapper hugs it, so centered == fills the box == same spot).
      //   • Create Frame: stay absolute at 0,0 inside the child-sized wrapper.
      // Its own transform (translate centering) is cleared — the WRAPPER inherited
      // it; leaving it on the child too would double-shift.
      styles = layout
        ? { position: '', left: '', top: '', right: '', bottom: '', transform: '' }
        : { position: 'absolute', left: '0px', top: '0px', right: '', bottom: '', transform: '' };
    } else if (layout) {
      styles = {
        position: '',
        left: '',
        top: '',
        right: '',
        bottom: '',
      };
    } else {
      const box = readNodeBox(node);
      if (!box) continue;
      const newLeft = Math.round(box.left - bbox!.left);
      const newTop = Math.round(box.top - bbox!.top);
      styles = {
        position: 'absolute',
        left: `${newLeft}px`,
        top: `${newTop}px`,
      };
      // Clear far-edge insets — they were anchored to the old parent.
      if (node.styles?.right) styles.right = '';
      if (node.styles?.bottom) styles.bottom = '';
    }
    queueMutation({
      type: 'move',
      nodeId: node.id,
      newParentId: frameId,
      // Encapsulated canvas nodes become inline children of the new frame
      // — drop the canvasNode flag so the generator removes them from the
      // `canvasNodes` JSX fragment.
      canvasNode: false,
      styles,
    });
  }

  return frameId;
}

/** Unfold children — replace a parent with its children (promote children to grandparent) */
/**
 * Unfold children — promote a frame's children to its grandparent (or the
 * canvas, if the frame is a canvas node), then delete the empty frame.
 *
 * The right styles to write depend on the layout context the children land
 * in. Four cases (ported from the legacy builder's `unfoldChildren`):
 *
 *   1. Frame has layout (flex/grid), grandparent doesn't → children become
 *      `position: absolute` with positions / sizes measured from the live
 *      DOM (the layout engine's actual placement).
 *   2. Frame no layout, grandparent has layout → children become flow
 *      (`position: relative`, clear left/top/right/bottom, `flex: 0 0 auto`).
 *   3. Both have layout → children stay flow, just clear stale positioning.
 *   4. Neither has layout → children's `left/top` become grandparent-relative
 *      (frame.left + child.left). Bridge rect is the source of truth for
 *      transformed elements; falls back to inline-style addition otherwise.
 *
 * A frame with `isCanvasNode` and no parent is a special case: children
 * become canvas nodes themselves (parentId = null, canvasNode flag = true)
 * with their position re-projected into canvas space.
 *
 * No DOM access in the parent frame — uses `findNodeRect` (bridge) for any
 * needed measurement. The previous version called `getNodeEl` which returns
 * null in iframe mode, so this function silently no-op'd.
 */
export function unfoldChildren(
  nodeId: string,
  nodesMap: Map<string, CanvasNode>,
  contentEl: HTMLElement,
): void {
  const node = nodesMap.get(nodeId);
  if (!node || node.children.length === 0) return;

  // Clear the hover overlay if the frame being unfolded is the hovered node —
  // otherwise its hover border lingers ~0.2s over where it was (the atom still
  // points at the now-removed frame until the next mouse move). Mirrors deleteNode.
  {
    const store = getDefaultStore();
    if (store.get(hoveredIdAtom) === nodeId) {
      store.set(hoveredIdAtom, null);
      store.set(hoveredNodeIdAtom, null);
    }
  }

  // ── Instant-feel: blank the frame's own paint NOW ──────────────────────────
  // The queued move(children) + remove(frame) below re-parse the whole page
  // (~0.3s on a big page) before the canvas updates — so without this the frame
  // lingers fully painted, then pops away. Imperatively clear its bg / border /
  // shadow and unclip it across every viewport it renders in, so it appears to
  // VANISH the moment the command runs while its children (which don't move —
  // their left/top are rewritten to the same screen point) stay put. DOM-only;
  // the real removeNode lands on the next render. Same spirit as the FrameCreator
  // encapsulation instant-feel fix.
  {
    const blank = {
      backgroundColor: TRANSPARENT_FILL, backgroundImage: 'none',
      border: 'none', boxShadow: 'none', outline: 'none', overflow: 'visible',
    };
    const rectCache = (getCanvasBridge() as any).rectCache as Map<string, DOMRect> | undefined;
    // Primary viewport ('') + every replica prefix (`<vpId>-`) this frame renders
    // in — found by scanning the rect cache for keys that end in this node id.
    const prefixes = new Set<string>(['']);
    if (rectCache) {
      for (const key of rectCache.keys()) {
        if (key !== nodeId && key.endsWith(nodeId)) {
          const p = key.slice(0, key.length - nodeId.length);
          if (p.endsWith('-')) prefixes.add(p);
        }
      }
    }
    for (const prefix of prefixes) patchNodeStyles(contentEl, nodeId, prefix, blank);
    // Drop the frame's rect from the hit-test cache too. `getNodeHitsAtPoint` is
    // rect-cache based, so otherwise the Cmd-RELEASE re-hover that Cmd+Backspace
    // fires (CanvasMouseController.modifierHoverHandler re-runs updateHover at the
    // parked mouse position) re-detects the still-in-DOM frame and flashes the
    // cleared hover border back over it for ~0.2s. With its rect gone, the
    // re-hover falls through to whatever's actually under the cursor. The cache
    // is rebuilt sans-frame on the next render, so this only bridges the gap.
    if (rectCache) for (const prefix of prefixes) rectCache.delete(prefix + nodeId);
  }

  const scale = transformManager.getTransform().scale || 1;

  // Canvas-node frame (no parent) → children become canvas nodes.
  if (node.isCanvasNode && !node.parentId) {
    unfoldToCanvas(node, nodesMap, scale);
    return;
  }

  const grandparentId = node.parentId;
  if (!grandparentId) return;
  const grandparent = nodesMap.get(grandparentId);
  if (!grandparent) return;

  const frameHasLayout = hasLayout(node.styles);
  const gpHasLayout = hasLayout(grandparent.styles);

  const insertIdx = grandparent.children.indexOf(nodeId);
  const vpId = 'desktop';
  const gpRect = findNodeRect(grandparentId, vpId);
  const frameRect = findNodeRect(nodeId, vpId);

  // Inline-style position fallback when bridge rects aren't available
  // (component master files, edge timing). Parent-relative px live in
  // node.styles.left/top.
  const frameLeftStyle = parseFloat(node.styles?.left ?? '0') || 0;
  const frameTopStyle = parseFloat(node.styles?.top ?? '0') || 0;

  trace.action('commands:unfold-children:plan', {
    nodeId, grandparentId,
    childIds: node.children,
    frameHasLayout, gpHasLayout,
  });

  for (let i = 0; i < node.children.length; i++) {
    const childId = node.children[i];
    const child = nodesMap.get(childId);
    if (!child) continue;

    let styles: Record<string, string> | undefined;

    if (frameHasLayout && !gpHasLayout) {
      // CASE 1: layout → no-layout. Children become absolute at their
      // currently-rendered position. Use the bridge rect — it reflects the
      // layout engine's resolution. Set explicit width/height if the child
      // was relying on flex sizing.
      styles = absolutizeFromRects({ child, childId, vpId, gpRect, scale });
    } else if (!frameHasLayout && gpHasLayout) {
      // CASE 2: no-layout → layout. Children become flow items.
      styles = {
        position: 'relative',
        left: '', top: '', right: '', bottom: '',
        flex: '0 0 auto',
      };
    } else if (frameHasLayout && gpHasLayout) {
      // CASE 3: both layout. Children stay flow; just clear stale absolute
      // positioning that may have leaked in.
      styles = {
        position: 'relative',
        left: '', top: '',
      };
    } else {
      // CASE 4: no-layout → no-layout. Add frame offset to child position.
      // Bridge rects are most accurate (handles transforms); inline-style
      // arithmetic is the fallback.
      if ((child.styles?.position ?? '') === 'absolute') {
        const childRect = findNodeRect(childId, vpId);
        if (childRect && gpRect) {
          styles = {
            position: 'absolute',
            left: `${Math.round((childRect.left - gpRect.left) / scale)}px`,
            top: `${Math.round((childRect.top - gpRect.top) / scale)}px`,
          };
        } else {
          const childLeft = parseFloat(child.styles?.left ?? '0') || 0;
          const childTop = parseFloat(child.styles?.top ?? '0') || 0;
          styles = {
            position: 'absolute',
            left: `${Math.round(childLeft + frameLeftStyle)}px`,
            top: `${Math.round(childTop + frameTopStyle)}px`,
          };
        }
        // Clear inset if the child carried right/bottom — they were
        // anchored to the OLD parent's far edges.
        if (child.styles?.right) styles.right = '';
        if (child.styles?.bottom) styles.bottom = '';
      }
      // Non-absolute children in a no-layout frame: leave their styles
      // alone. They were probably static-flow text or similar; the move
      // alone (parent change) preserves their visual flow.
    }

    queueMutation({
      type: 'move',
      nodeId: childId,
      newParentId: grandparentId,
      index: insertIdx + i,
      styles,
    });
    // INSTANT (drop-parity): re-home the child in the iframe DOM NOW
    // (reparentLive replicates into every viewport's copy of the
    // grandparent) and sync the imperative node cache so live readers
    // (labels, layers, panels) flip this commit. Relying on the flush's
    // render alone broke after the render dedup work: onBeforeFlush marks
    // the canvas updated for non-structural flushes, the ONE deduped
    // render skipped, and the unfold only became visible after a page
    // switch (live find 2026-07-19).
    getCanvasBridge().reparentLive?.(childId, '', grandparentId, insertIdx + i, styles ?? {});
    moveNodeInCache(childId, grandparentId);
    if (styles) updateNodeInCache(childId, styles);
  }

  // Drop the now-empty frame — imperatively in the DOM (every viewport
  // copy) + the cache; the queued removeNode makes it permanent.
  getCanvasBridge().removeElement?.(nodeId);
  removeNodeFromCache(nodeId);
  queueMutation({ type: 'removeNode', nodeId });

  // Commit the string mutations NOW; defer the parse + React fan-out
  // through the fenced 32ms timer (same as drops — the DOM + cache are
  // already correct, so nothing visual waits on the parse).
  setDeferNextFanOut();
  flushNow();

  // Suppress unused-variable warning when the rect path isn't taken.
  void frameRect;
}

/** Helper — does this style block declare a flex/grid container? */
function hasLayout(styles: Record<string, string> | undefined): boolean {
  const d = styles?.display ?? '';
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
}

/**
 * Build the absolute-positioned style block for a child whose old parent
 * had layout but its new parent doesn't. Reads the live bridge rect for
 * actual rendered position + size, falls back to a sane minimum when the
 * rect isn't available yet.
 */
function absolutizeFromRects(opts: {
  child: CanvasNode;
  childId: string;
  vpId: string;
  gpRect: DOMRect | null;
  scale: number;
}): Record<string, string> {
  const { child, childId, vpId, gpRect, scale } = opts;
  const childRect = findNodeRect(childId, vpId);
  const styles: Record<string, string> = {
    position: 'absolute',
    flex: '0 0 auto',
  };
  if (childRect && gpRect) {
    styles.left = `${Math.round((childRect.left - gpRect.left) / scale)}px`;
    styles.top = `${Math.round((childRect.top - gpRect.top) / scale)}px`;
    // Lock in dimensions if the child was sized by the flex/grid container
    // (auto / missing) — without this they'd collapse once they leave the
    // layout flow.
    const w = child.styles?.width;
    const h = child.styles?.height;
    if (!w || isFitSize(w)) {
      styles.width = `${Math.round(childRect.width / scale)}px`;
    }
    if (!h || isFitSize(h)) {
      styles.height = `${Math.round(childRect.height / scale)}px`;
    }
  }
  // Clear flex-item props that don't apply outside the flex parent.
  if (child.styles?.alignSelf) styles.alignSelf = '';
  if (child.styles?.justifySelf) styles.justifySelf = '';
  if (child.styles?.gridColumn) styles.gridColumn = '';
  if (child.styles?.gridRow) styles.gridRow = '';
  if (child.styles?.gridArea) styles.gridArea = '';
  return styles;
}

/**
 * Unfold a canvas-node frame: every child becomes its own canvas node with
 * canvas-space `left/top/width/height`. Re-projects screen coords back to
 * canvas space using the iframe's offset + canvas transform.
 */
function unfoldToCanvas(
  node: CanvasNode,
  nodesMap: Map<string, CanvasNode>,
  scale: number,
): void {
  const vpId = 'desktop';
  const bridge = getCanvasBridge() as any;
  const iframeOffset = bridge?.getIframeOffset ? bridge.getIframeOffset() : { x: 0, y: 0 };
  const transform = transformManager.getTransform();

  trace.action('commands:unfold-children:to-canvas', {
    nodeId: node.id, childIds: node.children,
  });

  for (const childId of node.children) {
    const child = nodesMap.get(childId);
    if (!child) continue;
    const rect = findNodeRect(childId, vpId);
    let canvasLeft: number;
    let canvasTop: number;
    let width: number;
    let height: number;
    if (rect) {
      canvasLeft = (rect.left - iframeOffset.x - transform.x) / scale;
      canvasTop = (rect.top - iframeOffset.y - transform.y) / scale;
      width = rect.width / scale;
      height = rect.height / scale;
    } else {
      // Fallback: derive from inline styles + frame position.
      const cl = parseFloat(child.styles?.left ?? '0') || 0;
      const ct = parseFloat(child.styles?.top ?? '0') || 0;
      const fl = parseFloat(node.styles?.left ?? '0') || 0;
      const ft = parseFloat(node.styles?.top ?? '0') || 0;
      canvasLeft = cl + fl;
      canvasTop = ct + ft;
      width = parseFloat(child.styles?.width ?? '0') || 0;
      height = parseFloat(child.styles?.height ?? '0') || 0;
    }
    const styles: Record<string, string> = {
      position: 'absolute',
      left: `${Math.round(canvasLeft)}px`,
      top: `${Math.round(canvasTop)}px`,
      flex: '0 0 auto',
    };
    if (width > 0) styles.width = `${Math.round(width)}px`;
    if (height > 0) styles.height = `${Math.round(height)}px`;
    if (child.styles?.right) styles.right = '';
    if (child.styles?.bottom) styles.bottom = '';
    // Strip flex-item props.
    if (child.styles?.alignSelf) styles.alignSelf = '';
    if (child.styles?.justifySelf) styles.justifySelf = '';
    if (child.styles?.gridColumn) styles.gridColumn = '';
    if (child.styles?.gridRow) styles.gridRow = '';

    queueMutation({
      type: 'move',
      nodeId: childId,
      newParentId: null,
      canvasNode: true,
      styles,
    });
    // INSTANT (drop-parity) — same rationale as the in-page branch above.
    // reparentLive's exit path drops replica copies and lifts the child to
    // the content root with its canvas-space styles.
    getCanvasBridge().reparentLive?.(childId, '', null, 0, styles);
    moveNodeInCache(childId, null);
    updateNodeInCache(childId, styles);
  }

  getCanvasBridge().removeElement?.(node.id);
  removeNodeFromCache(node.id);
  queueMutation({ type: 'removeNode', nodeId: node.id });
  setDeferNextFanOut();
  flushNow();
}

/**
 * Delete a REPLICA viewport from the page — used when the user presses
 * Delete with the replica's root node selected.
 *
 * One file write transactionally removes:
 *   - the viewport's entry in the `@canvas` `viewports` array
 *   - its entry in `@canvas` `positions`
 *   - every `@media (max-width: <vpWidth>px) …` override authored for it
 *
 * Other viewports (primary + other replicas) are untouched. The primary
 * viewport is rejected upstream in `deleteNode`.
 */
function removeReplicaViewport(filePath: string, vpId: string): void {
  modifyProjectFile(filePath, (code) => {
    const cfg = parseCanvasConfig(code);
    if (!cfg) return code;
    const vp = cfg.viewports.find(v => v.id === vpId);
    if (!vp || vp.isPrimary) {
      trace.error('commands:remove-replica-viewport-not-found-or-primary', { vpId });
      return code;
    }
    const vpWidth = vp.width;
    const newPositions: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of Object.entries(cfg.positions)) {
      if (id !== vpId) newPositions[id] = pos;
    }
    const newConfig = {
      ...cfg,
      viewports: cfg.viewports.filter(v => v.id !== vpId),
      positions: newPositions,
    };
    let updated = updateCanvasConfigInCode(code, newConfig);
    updated = clearContainerStylesForWidth(updated, vpWidth);
    // Also drop this viewport from every instance's `data-responsive` — remove its keyed
    // per-viewport variant entry and refresh `_bp` to the remaining widths (else `_bp` keeps a
    // dead breakpoint + the orphaned variant entry lingers).
    const remainingWidths = newConfig.viewports.map(v => v.width);
    updated = removeResponsiveBreakpoint(updated, vpWidth, remainingWidths);
    trace.action('commands:remove-replica-viewport', { vpId, vpWidth, filePath });
    return updated;
  });
}

// ─── Duplicate ──────────────────────────────────────────────────────────────

/**
 * Duplicate the primary selected node: a one-shot copy+paste that preserves
 * the user's existing clipboard (duplicate is NOT a real clipboard
 * operation). Previously the same save/copy/paste/restore dance was
 * copy-pasted in shortcuts.ts (Ctrl+D), canvas-commands-bridge.ts and
 * menu-builders.tsx — all three now call this. Callers keep their own
 * trace.action calls.
 */
export function duplicateSelection(opts: {
  nodes: Map<string, CanvasNode>;
  primaryId: string | null;
  contentEl: HTMLElement | null;
  setSelectedIds: (ids: string[]) => void;
  handleNodeMouseDown: (nodeId: string, e: MouseEvent) => void;
}): void {
  const sel = opts.primaryId;
  if (!sel) return;
  trace.fn('commands:duplicateSelection', { nodeId: sel });
  const savedClipboard = localStorage.getItem('canvas_clipboard');
  copyNodes([sel], opts.nodes);
  executePaste(opts.nodes, opts.contentEl, sel, (id) => opts.setSelectedIds(id ? [id] : []), opts.handleNodeMouseDown);
  // Restore original clipboard
  if (savedClipboard) localStorage.setItem('canvas_clipboard', savedClipboard);
  else localStorage.removeItem('canvas_clipboard');
}
