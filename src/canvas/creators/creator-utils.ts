// creator-utils.ts — Shared utilities for all creation tools (frame, text, shape).
// Parent detection, insertion index, encapsulation, ID generation.
// Uses bridge helpers (node-ops.ts) for all geometry reads — no direct DOM access.

import { getDefaultStore } from 'jotai';
import { toKebab } from '@/shared/css-utils';
import { generateNodeId } from '@/shared/id-utils';
import { getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { getNodeHitsAtPoint, findChildRects, findNodeComputedStyles, findRootHitAtPoint, findNodeRect } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import { getScreenCornersById } from '@/canvas/resize/geometry-utils';
import { computeLayoutInsertOrderUpdates } from '@/canvas/drag/reparent-utils';
import { commitOrderAssignments } from '@/canvas/drag/strategies/order-commit';
import { queuePendingUpdates } from '@/canvas/arrow-nudge';
import { getNodeFromCache } from '@/code/stores/store';
import { canAcceptChildren, isTextTag } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { getCurrentCode } from '@/code/mutation/mutation-queue';
import { extractStyleCSS } from '@/code/parsing/parser';
import { extractBorderAfterRuleBody } from '@/editor/ui/border-utils';
import { bakeNodeForTile, type TileContext } from '@/canvas/replica-bake';
import type { Transform, Rect } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';

// ─── Parent Detection ───────────────────────────────────────────────────────

/**
 * Find the deepest parent node at a screen point.
 * Uses getNodeHitsAtPoint() (bridge rect cache) and walks results checking canAcceptChildren.
 * Skips text elements (can't be containers).
 * Also returns the vpPrefix so callers can determine viewport context.
 */
export function findParentAtPoint(
  screenX: number,
  screenY: number,
  nodes: Map<string, CanvasNode>,
): { nodeId: string; vpPrefix: string } | null {
  const hits = getNodeHitsAtPoint(screenX, screenY);

  // OVERLAY EDIT MODE — a new element must land INSIDE the overlay being edited,
  // never in page content that merely sits visually BEHIND it. The hit stack is
  // sorted by DOM DEPTH, so a deep page section (a descendant of root) outranks
  // the SHALLOW overlay (also a child of root, but visually on top via z-index)
  // — without this guard the new frame parents into that page section, landing
  // behind the overlay (the "inserts behind instead of over" bug). Restrict
  // eligible parents to the overlay's own subtree. Inert when not editing.
  const overlayEditId = getDefaultStore().get(overlayEditingIdAtom);
  const withinEditedOverlay = (nodeId: string): boolean => {
    if (!overlayEditId) return true;
    let cur: CanvasNode | undefined = nodes.get(nodeId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.id === overlayEditId) return true;
      seen.add(cur.id);
      cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    }
    return false;
  };

  for (const hit of hits) {
    const nodeId = hit.id;
    // `layout::`-prefixed nodes belong to the layout file, not the page being
    // edited. Mutations against them would target the wrong file's AST and
    // silently no-op. `children-slot` is the placeholder marker for the
    // layout's `{children}` — also not a real container in the page file.
    if (nodeId.startsWith('layout::') || nodeId === 'children-slot') continue;
    const node = nodes.get(nodeId);
    if (!node) continue;
    // Component instances are OPAQUE drop targets. You can't insert into an instance tag
    // (`<MyCard/>` — its children come from the external component file), nor into its expanded
    // INTERNALS (`componentInstanceId` set — those belong to the master's definition, not this
    // page). Drawing over either should behave as if it isn't there: keep walking the hit stack
    // (sorted deepest-first, ancestors included) so the new node lands in the instance's real
    // PARENT, positioned where the user drew. Without this the creator tried to nest into the
    // instance and the mutation silently targeted the wrong tree.
    if (node.isComponentInstance || node.componentInstanceId) continue;
    // Skip text/inline elements — they can't be containers for new nodes
    if (isTextTag(node.type)) continue;
    // Skip elements that can't accept children (img, svg shapes, etc.)
    if (!canAcceptChildren(node.type)) continue;
    // Overlay edit: only the overlay + its descendants are eligible parents.
    if (!withinEditedOverlay(nodeId)) continue;

    trace.fn('creator.findParentAtPoint', { nodeId, tag: node.type, vpPrefix: hit.vpPrefix, screenX, screenY });
    return { nodeId, vpPrefix: hit.vpPrefix };
  }

  // Overlay edit fallback: no eligible hit inside the overlay → drop into the
  // overlay itself (in the viewport under the cursor), NOT the page root behind it.
  if (overlayEditId && nodes.get(overlayEditId)) {
    const rh = findRootHitAtPoint(screenX, screenY);
    trace.fn('creator.findParentAtPoint:overlay-fallback', { overlayEditId, vpPrefix: rh?.vpPrefix ?? '' });
    return { nodeId: overlayEditId, vpPrefix: rh?.vpPrefix ?? '' };
  }

  // Fallback: cursor is over a viewport but no smaller eligible frame is
  // there (e.g. empty page where only root exists, or hovering whitespace
  // between two `<p>` children). Drop into the page's `root` so the new
  // element lands in the active page file.
  const rootHit = findRootHitAtPoint(screenX, screenY);
  if (rootHit) {
    trace.fn('creator.findParentAtPoint:root-fallback', { vpPrefix: rootHit.vpPrefix, screenX, screenY });
    return { nodeId: rootHit.id, vpPrefix: rootHit.vpPrefix };
  }
  return null;
}

// ─── Layout Detection ───────────────────────────────────────────────────────

export type InsertionMode = 'absolute' | 'flex-row' | 'flex-column' | 'grid';

/**
 * Determine how children are positioned within a parent.
 * Reads computed style via bridge to detect flex/grid layout.
 */
export function getInsertionMode(parentId: string, vpId: string): InsertionMode {
  const computed = findNodeComputedStyles(parentId, vpId, ['display', 'flexDirection']);
  const display = computed.display || '';

  if (display === 'flex' || display === 'inline-flex') {
    const dir = computed.flexDirection || 'row';
    return dir === 'column' || dir === 'column-reverse' ? 'flex-column' : 'flex-row';
  }
  if (display === 'grid' || display === 'inline-grid') return 'grid';
  return 'absolute';
}

/**
 * Calculate insertion index within a flex/grid parent based on a canvas-space point.
 * Compares the draw center with child midpoints to find the right slot.
 * Uses findChildRects (bridge) and getAbsoluteCanvasRectById for canvas-space conversion.
 */
/** A child's flex `order` as a number (default 0). */
function flexOrderOf(nodeId: string): number {
  const raw = getNodeFromCache(nodeId)?.styles?.order;
  const n = parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? n : 0;
}

export function getFlexInsertIndex(
  parentId: string,
  vpId: string,
  canvasCenterX: number,
  canvasCenterY: number,
  transform: Transform,
  mode: 'flex-row' | 'flex-column' | 'grid',
): number {
  const childRects = findChildRects(parentId, vpId);
  const isColumn = mode === 'flex-column';

  // FLOW order (ascending `order` CSS, DOM sequence breaks ties) — NOT raw DOM
  // order. When siblings carry explicit `order` (from prior reorders) the DOM
  // order inverts against how they actually lay out, so a naive DOM-order scan
  // returns a mid-stack index and the new node lands in the middle instead of
  // where it was drawn (live find 2026-07-24). Mirrors the drag path's
  // sortChildRectsByFlow. Array.sort is stable → equal orders keep DOM order.
  const sorted = [...childRects].sort((a, b) => flexOrderOf(a.id) - flexOrderOf(b.id));
  const drawCenter = isColumn ? canvasCenterY : canvasCenterX;

  // Midpoints clamped MONOTONIC along the flow walk (same as the drag's
  // calculateLayoutInsertIndexById): a negative-margin/overlapping sibling's raw
  // midpoint can sit before the previous one's, which would make the
  // first-midpoint-past-the-point scan pick an unreachable slot.
  let lastMid = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const canvasRect = getAbsoluteCanvasRectById(sorted[i].id, vpId, transform);
    if (!canvasRect) continue;
    const rawMid = isColumn
      ? canvasRect.top + canvasRect.height / 2
      : canvasRect.left + canvasRect.width / 2;
    const mid = Math.max(rawMid, lastMid + 1);
    lastMid = mid;
    if (drawCenter < mid) return i;
  }
  return sorted.length;
}

/**
 * After a creator inserts a new flow child at `insertIndex`, renumber the flex
 * `order` styles so it lands at the drawn FLOW position — but ONLY when the
 * parent already has explicit `order` on its children. Without this the new
 * node keeps the CSS default `order: 0` and visually jumps to the start / mid
 * of an explicitly-ordered stack, regardless of its JSX index (live find
 * 2026-07-24). Shared by every draw-to-create creator (Frame / Layout / Text /
 * Shape / Sketch).
 *
 * Routed through `commitOrderAssignments`, NOT queued as a raw `updateStyles`.
 * A raw style write is only correct on the primary viewport: on a component
 * master's variant tile `updateNodeStyles` sends it to `variants[X].order = N`,
 * which framer-motion then tweens as a float and overlays on top of the inline
 * value — the node ends up parked at the wrong slot (user report 2026-07-27),
 * and CLAUDE.md's "order goes in inline style as a ternary, never in variant
 * objects" is broken in the file itself.
 */
export function queueCreatorFlexOrder(
  parentId: string,
  vpId: string,
  insertIndex: number,
  newNodeId: string,
  mode: 'flex-row' | 'flex-column' | 'grid',
  contentEl: HTMLElement,
): void {
  const direction = mode === 'flex-column' ? 'column' : 'row';
  const updates = computeLayoutInsertOrderUpdates(
    parentId, vpId, insertIndex, [newNodeId], direction,
    (id) => getNodeFromCache(id)?.styles?.order,
  );
  if (updates.length === 0) return;
  trace.action('creator:flex-order-renumber', { parentId, vpId, insertIndex, newNodeId, count: updates.length });
  queuePendingUpdates(commitOrderAssignments(updates, contentEl, vpId));
}

// ─── Encapsulation ──────────────────────────────────────────────────────────

/**
 * Detect child elements fully enclosed by the drawn rectangle.
 * Returns node IDs that should be wrapped (encapsulated) by the new frame.
 * Uses findChildRects (bridge) for child positions.
 */
function detectEncapsulatedChildren(
  parentId: string,
  vpId: string,
  drawnRect: Rect,
  transform: Transform,
): string[] {
  const childRects = findChildRects(parentId, vpId);
  const enclosed: string[] = [];

  for (const { id } of childRects) {
    // Convert child rect to canvas-space for comparison with drawnRect (also canvas-space)
    const canvasRect = getAbsoluteCanvasRectById(id, vpId, transform);
    if (!canvasRect) continue;

    if (
      canvasRect.left >= drawnRect.left &&
      canvasRect.top >= drawnRect.top &&
      canvasRect.left + canvasRect.width <= drawnRect.left + drawnRect.width &&
      canvasRect.top + canvasRect.height <= drawnRect.top + drawnRect.height
    ) {
      enclosed.push(id);
    }
  }

  trace.fn('creator.detectEncapsulatedChildren', { count: enclosed.length, enclosed });
  return enclosed;
}

// ─── ID & Color Generation ──────────────────────────────────────────────────

/**
 * INSTANT-APPEAR for creation tools. Extracted from FrameCreator's proven path.
 *
 * Problem: a creator inserts the node imperatively, then `setForceRender()` +
 * `flushNow()` re-parse the whole page and FULLY REBUILD the canvas DOM (~0.3s on
 * a big page). That rebuild destroys the imperative node until the real one
 * paints → the element visibly vanishes then reappears, and the selection overlay
 * lands ~0.3s late (it has no rect/computed to read yet).
 *
 * Fix: keep the drawing PREVIEW as a placeholder. It lives in the CONTAINER
 * (outside the Renderer's content tree), so the rebuild never touches it — it
 * covers the gap. We also seed the bridge rect + computed caches from it so the
 * selection box/handles resolve immediately. The placeholder is dropped when the
 * real node paints (`revyme:render-complete`) or after a safety timeout.
 *
 * Call this in `onUp` right before `setForceRender()`/`flushNow()`, passing the
 * KEPT preview element (detach it from module state first so cancel can't double-
 * remove it). No-op-safe if `placeholder` is null.
 */
export function holdCreationPlaceholder(
  nodeId: string,
  vpPrefix: string,
  placeholder: HTMLElement | SVGElement | null,
  styles: Record<string, string>,
  seedRect?: DOMRect,
): void {
  const bridge = getCanvasBridge();
  // Restyle ONLY a div placeholder (frame/layout/shape/text). An SVG placeholder
  // (the sketch stroke) already reads correctly and has no border/bg to drop.
  if (placeholder instanceof HTMLElement) {
    const ps = placeholder.style;
    // Read as the committed node: drop the blue drawing border/tint, and sit at
    // zIndex 1 — above the iframe (0) so it shows through the gap, but BELOW the
    // selection handles (2-4) so they're never painted over.
    ps.border = 'none';
    if (styles.backgroundColor) ps.backgroundColor = styles.backgroundColor;
    if (styles.borderRadius) ps.borderRadius = styles.borderRadius;
    ps.zIndex = '1';
  }
  // Seed the rect → getScreenCornersById falls back to findNodeRect for a
  // non-rotated node, so the blue box + handles appear instantly. `seedRect`
  // lets callers pass a tighter rect than the placeholder's own box (sketch: the
  // stroke path, not its full-viewport host <svg>).
  const rect = seedRect ?? placeholder?.getBoundingClientRect();
  if (rect && bridge.seedRectFromScreen) {
    bridge.seedRectFromScreen(nodeId, vpPrefix, rect);
  }
  // Seed computed styles too (radius/padding/gap handles + the rotation gate read
  // them via the bridge). Fresh node → known defaults from `styles`. Both
  // camelCase + kebab; replaced by the real measured values on the next allRects.
  if (bridge.seedComputed) {
    const radius0 = (styles.borderRadius || '0px').split(' ')[0];
    const pad0 = (styles.padding || '0px').split(' ')[0];
    const base: Record<string, string> = {
      transform: styles.transform || 'none',
      display: styles.display || 'block',
      flexDirection: styles.flexDirection || 'row',
      flexWrap: styles.flexWrap || 'nowrap',
      gap: styles.gap || 'normal',
      gridAutoFlow: 'row',
      borderTopLeftRadius: radius0,
      paddingTop: pad0, paddingRight: pad0, paddingBottom: pad0, paddingLeft: pad0,
      width: styles.width || '', height: styles.height || '',
      left: styles.left || 'auto', top: styles.top || 'auto',
      position: styles.position || 'static',
    };
    const computed: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
      computed[k] = v;
      computed[toKebab(k)] = v; // kebab too
    }
    bridge.seedComputed(nodeId, vpPrefix, computed);
  }
  // Drop the placeholder once the real node paints; safety-net timeout fallback.
  // Listener registered BEFORE the (synchronous) commit so it can't be missed.
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    placeholder?.remove();
    window.removeEventListener('revyme:render-complete', remove);
  };
  window.addEventListener('revyme:render-complete', remove);
  setTimeout(remove, 1500);
}

/**
 * INSTANT flex/grid-slot appearance for a creator. When a node is drawn INSIDE a
 * flex/grid parent it commits as a FLOW child — its final spot is a layout SLOT,
 * not the drawn rect — but `setForceRender()`+`flushNow()` re-parse the page and
 * re-render (~0.3s on a big page). So `holdCreationPlaceholder`'s drawn-rect
 * placeholder lingers under the cursor, then JUMPS into the slot (the ugly two-
 * step). Instead, drop a BRIDGE placeholder styled as the committed child into
 * the iframe's flex slot so it appears in the layout INSTANTLY; the renderer
 * removes it ATOMICALLY when the real node paints (`patchChildElements` drops
 * `data-placeholder-id="create-<id>"` for any node it renders → no overlap /
 * reflow flash). The drawn-rect placeholder is dropped on the next frame (after
 * the slot placeholder has landed → no blank gap).
 *
 * No-ops on a bridge without `createPlaceholder` (DirectBridge — same-frame DOM,
 * so the imperative createNode insert already shows and the draw-placeholder hold
 * covers the gap).
 */
export function holdFlexSlotPlaceholder(opts: {
  nodeId: string;
  parentId: string;
  vpPrefix: string;
  beforeNodeId: string | null;
  styles: Record<string, string>;
  drawPlaceholder: HTMLElement | null;
}): void {
  const { nodeId, parentId, vpPrefix, beforeNodeId, styles, drawPlaceholder } = opts;
  const bridge = getCanvasBridge();
  if (!('createPlaceholder' in bridge)) {
    // DirectBridge (no iframe): there's no slot placeholder to inject — fall back
    // to the drawn-rect hold (drop it once the real node paints). NEVER leave the
    // draw placeholder lingering.
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      try { drawPlaceholder?.remove(); } catch { /* ignore */ }
      window.removeEventListener('revyme:render-complete', remove);
    };
    window.addEventListener('revyme:render-complete', remove);
    setTimeout(remove, 1500);
    return;
  }
  const pmb = bridge as PostMessageBridge;
  const phId = `create-${nodeId}`;
  pmb.createPlaceholder(phId, parentId, vpPrefix, beforeNodeId, { ...styles, pointerEvents: 'none' });
  trace.action('creator:flex-slot-placeholder', { nodeId, parentId, beforeNodeId });
  // Drop the drawn-rect placeholder once the slot placeholder has landed.
  requestAnimationFrame(() => { try { drawPlaceholder?.remove(); } catch { /* ignore */ } });
  // Safety net only — the renderer's atomic swap handles the normal case.
  setTimeout(() => { try { pmb.removePlaceholders([phId]); } catch { /* ignore */ } }, 1500);
}

/**
 * Build a faithful clone descriptor for an existing node: same type / name /
 * styles / attrs / textContent / children, but every id (root and every
 * descendant) freshly generated. Used by alt-drag-duplicate so the commit
 * doesn't end up with two JSX elements sharing the same data-id (which would
 * blow up the parser's lookups).
 *
 * Unlike `buildCanvasCloneDescriptor` (canvas-extraction-specific —
 * unwraps `useResponsiveText`, drops hidden-on-source-vp children,
 * reorders by source-vp flex order), this helper is a 1:1 clone for
 * duplicating in place at the SAME viewport.
 *
 * `tile` is the viewport/variant the user duplicated ON. Every per-tile
 * channel — the page's `@media` block, the component's `<id>Variants` object,
 * inline `variant === 'x' ? …` ternaries — is addressed by the SOURCE's
 * data-id, so a clone with a fresh id can never inherit any of them. Cloning
 * `node.styles` verbatim therefore reproduced the PRIMARY, not the tile: a
 * 100%-wide button duplicated on `variant-2` came out auto-width, and a text
 * node with a tablet font-size override came out at desktop size (user report
 * 2026-08-08). Baking the tile's resolved values in is exactly right here,
 * because a duplicate made on a replica is created SOLO (see the
 * `hideInAllOthers` + source-vp unhide in DragCoordinator) — the tile it was
 * made on is the only place it renders.
 */
export function buildDuplicateDescriptor(
  sourceId: string,
  nodes: Map<string, CanvasNode>,
  /** Filled with sourceId → newId for the WHOLE subtree — lets the caller
   *  carry per-id side-band state (::after border rules) onto the clones. */
  idMap?: Map<string, string>,
  tile?: TileContext,
): import('@/code/generation/generator-crud').AddNodeDef | null {
  const src = nodes.get(sourceId);
  if (!src) return null;
  const childDescriptors: import('@/code/generation/generator-crud').AddNodeDef[] = [];
  for (const childId of src.children ?? []) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    // Expanded component instance internals re-derive at parse time
    // from their master — duplicating them inline would break the
    // master/instance link.
    if (childNode.componentInstanceId) continue;
    const childDescriptor = buildDuplicateDescriptor(childId, nodes, idMap, tile);
    if (childDescriptor) childDescriptors.push(childDescriptor);
  }
  const newId = generateNodeId('dup');
  idMap?.set(sourceId, newId);
  const baked = bakeNodeForTile(src, tile ?? { kind: 'primary' });
  return {
    id: newId,
    type: src.type,
    name: src.name,
    styles: baked.styles,
    attrs: baked.attrs,
    textContent: baked.textContent,
    children: childDescriptors.length > 0 ? childDescriptors : undefined,
  };
}

/**
 * Queue `updateBorderOverlay` copies for duplicated nodes whose SOURCE has a
 * `[data-id="…"]::after` border rule in the current file's <style> block.
 * The rule is keyed by data-id, so a clone with a fresh id silently loses
 * its border without this (same carry the paste engine does via
 * `borderAfterCSS`; this is the in-file flavor for alt-drag duplicate).
 */
export function queueBorderOverlayDuplicates(idMap: Map<string, string>): void {
  if (idMap.size === 0) return;
  const css = extractStyleCSS(getCurrentCode());
  if (!css) return;
  let count = 0;
  for (const [oldId, newId] of idMap) {
    const body = extractBorderAfterRuleBody(css, oldId);
    if (body && body.trim()) {
      queueMutation({ type: 'updateBorderOverlay', nodeId: newId, afterCSS: body.trim() });
      count++;
    }
  }
  if (count > 0) trace.action('creator:border-overlay-duplicated', { count });
}

const FRAME_COLORS = [
  '#97cffc', '#ffb3ba', '#ffdfba', '#ffffba', '#baffc9',
  '#bae1ff', '#e0baff', '#ffcccb', '#d4f0d4', '#f0d4f0',
];
let _colorIdx = 0;

/** Get next frame background color (cycles through palette). */
export function nextFrameColor(): string {
  return FRAME_COLORS[(_colorIdx++) % FRAME_COLORS.length];
}

// ─── Create-on-replica unhide routing ───────────────────────────────────────
//
// When a creation tool drops a new element on a NON-PRIMARY viewport
// replica, the element is added with base `display: 'none'` (so it's
// hidden everywhere by default) plus an override that re-shows it on
// the active replica only.
//
// PAGE files: the override is an `@media (max-width: <vpWidth>)` rule
// that targets the real viewport width — written via `updateContainerStyle`.
//
// COMPONENT files: variants are NOT viewports. `@media` queries don't
// match them at runtime, and the "vpWidth" available here is the
// variant's effective canvas width (often the master-root width), so
// any @media rule lands with a threshold that never fires on a real
// browser. The element ends up silently hidden everywhere — exactly
// the symptom users hit when they "draw on variant-1" and then can't
// see it on the parent component or the page.
//
// In a component file we instead write the per-variant override
// through `updateVariantStyle`, which lands in the framer-motion
// `variants` object the Renderer's `resolveVariantStyles` already
// reads. The element shows on that variant and stays hidden on the
// others — no @media involved.

import { queueMutation } from '@/code/mutation/mutation-queue';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { getActiveFilePath } from '@/canvas/node-ops';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { getActiveAutoPan } from '@/canvas/transform';

// ─── Auto-pan integration for creators ─────────────────────────────────────
//
// Frame / text / shape / layout / selection-box creators are all "draw a
// rect from start to current cursor" gestures. While the user drags toward
// a panel edge, the canvas should pan AND the preview rect should keep
// growing as the cursor effectively moves through canvas space (even
// though it stays at the same screen position).
//
// `attachCreatorAutoPan` packages the boilerplate every creator needs:
//   1. Sets the auto-pan tenant flag so the loop ticks while drawing.
//   2. Subscribes a per-tick callback that re-runs the creator's redraw
//      with the LAST seen screen cursor — `screenToCanvas` then re-projects
//      against the freshly-panned transform, so the preview rect grows
//      naturally without a real mousemove.
// Returns a cleanup function the creator MUST call from its onUp/cancel
// path (otherwise the loop keeps panning forever).

export function attachCreatorAutoPan(
  tenant: string,
  redraw: (clientX: number, clientY: number) => void,
): { trackMouse: (clientX: number, clientY: number) => void; cleanup: () => void } {
  const ctrl = getActiveAutoPan();
  if (!ctrl) {
    // No-op fallback when AutoPan isn't initialised yet (e.g. tests).
    return { trackMouse: () => {}, cleanup: () => {} };
  }

  const last = { x: 0, y: 0 };
  ctrl.setActive(tenant, true);
  const unsub = ctrl.onTick(() => redraw(last.x, last.y));
  trace.action('creator-utils:autopan-attached', { tenant });

  return {
    trackMouse: (clientX, clientY) => {
      last.x = clientX;
      last.y = clientY;
    },
    cleanup: () => {
      unsub();
      ctrl.setActive(tenant, false);
      trace.action('creator-utils:autopan-detached', { tenant });
    },
  };
}

/**
 * Queue the right "show on this replica only" override for a freshly-
 * created element. Caller still sets base `display: 'none'` directly on
 * the new element's styles before calling `createNode` — this helper
 * only handles the unhide override for the active replica.
 *
 * `vpId` is the active variant id in component files (e.g. "variant-1")
 * and the active viewport id in page files (e.g. "tablet"). `vpWidth` is
 * unused for component files but kept as a single signature so callers
 * don't branch.
 */
export function queueReplicaCreationUnhide(
  nodeId: string,
  vpId: string,
  vpWidth: number,
  /** Original `display` value to restore on the source vp. Defaults to
   *  `'unset'` (used at CREATION when the element has no prior
   *  display). At ENTRY (canvas-node → replica) the element may
   *  already carry `display: 'flex'` / `'grid'` / `'block'` etc. —
   *  pass that here so the source vp's `@container` override
   *  restores the original layout instead of collapsing to UA default
   *  (which kills any flex/grid layout the element had as a canvas
   *  node). */
  originalDisplay?: string,
): void {
  const isComponent = isComponentFilePath(getActiveFilePath());
  // Use `'unset'` as a sensible default when no original is provided.
  // Empty/auto/'none' from a caller is treated as "use unset" too —
  // empty is the "no value" baseline, and `none` would defeat the
  // purpose of an unhide.
  const displayForVp = originalDisplay && originalDisplay !== '' && originalDisplay !== 'auto' && originalDisplay !== 'none'
    ? originalDisplay
    : 'unset';
  if (isComponent) {
    // For component variants the visibility is now expressed via the
    // AnimatePresence + conditional render pattern (`setVariantVisibility`)
    // — wrapping the JSX in `<AnimatePresence mode="popLayout">{cond &&
    // <element/>}</AnimatePresence>` so siblings smoothly FLIP into the
    // gap when the element unmounts on a variant transition. This
    // replaces the legacy `variants[X].display = 'none'/'unset'`
    // pattern that caused snap-show/snap-hide with no animation.
    //
    // Hidden = ALL variants except the current one (solo on this
    // variant). `setVariantVisibility` reads variantConfig to compute
    // the full list, and the generator writes the AnimatePresence
    // wrapper + condition. Subsequent unhides on other variants
    // remove those variants from the hidden set (handled by the
    // unhide path's read-current-state + delta logic).
    try {
      const code = projectFS.readFile(getActiveFilePath()) ?? '';
      const cfg = parseVariantConfig(code);
      const allVariants = cfg.length > 0 ? cfg.map(v => v.name) : ['default', vpId];
      const currentVariant = vpId === 'desktop' ? 'default' : vpId;
      const hiddenVariants = allVariants.filter(v => v !== currentVariant);
      queueMutation({
        type: 'setVariantVisibility',
        nodeId,
        hiddenVariants,
        allVariants,
      });
      trace.action('creator-utils:replica-unhide-variant-via-AnimatePresence', {
        nodeId, currentVariant, hiddenVariants, displayForVp,
      });
    } catch (e) {
      // Fallback: legacy `updateVariantStyle` so creation doesn't
      // wedge on a parse error.
      trace.error('creator-utils:setVariantVisibility-failed-fallback', { error: String(e) });
      queueMutation({
        type: 'updateVariantStyle',
        nodeId,
        variantName: vpId,
        styles: { display: displayForVp },
      });
    }
  } else {
    queueMutation({
      type: 'updateContainerStyle',
      nodeId,
      maxWidth: vpWidth,
      styles: { display: displayForVp },
    });
    trace.action('creator-utils:replica-unhide-media', { nodeId, vpId, vpWidth, displayForVp });
  }
  // SOLO-REPLICA marker (BOTH file kinds). Every creator (Frame / Layout /
  // Shape / Text / Sketch / dblclick-to-add-text) ends up here when the
  // element is born on a non-primary page viewport OR a non-primary
  // component variant — pair the visibility unhide with the
  // `data-replica-solo="<vpId>"` attribute so the same contract that
  // powers canvas-node → replica drag-entries also covers freshly-created
  // elements: while the attribute is present (i.e. until the user
  // unhides on another vp/variant), every non-display style write the
  // user makes — AND text content edits — redirect to BASE inline. That
  // way `useResponsiveText`-wrapped text authored on tablet, a variant
  // ternary that would otherwise be auto-created on a design-component
  // variant edit, and any size / position / color / etc. all build the
  // MASTER values, so a future unhide on another vp/variant inherits
  // them. Without this attribute on design-component variants, edits in
  // a solo variant collapse into `{variant === 'X' ? 'A' : 'B'}`
  // ternaries that lock the value to one variant only — the wrong
  // contract here.
  queueMutation({
    type: 'updateHtmlAttrs',
    nodeId,
    attrs: { 'data-replica-solo': vpId },
  });
}

// ─── Local-coord drawing (standard draw inside transformed parents) ──────
// Shared by FrameCreator / TextCreator / ShapeCreator / LayoutCreator /
// SketchCreator. Lets a drag-to-create tool produce a rectangle in the
// parent's LOCAL coordinate system — so when the parent is rotated /
// scaled / skewed, the preview tilts with it and the committed
// width/height/left/top live in parent-local space (matching the
// drawn shape exactly).
//
// Built from the parent's 4 cached screen corners (`getScreenCornersById`,
// same source the resize/rotate handles use) + the parent's
// pre-transform layout size (`__offsetWidth/Height` synthetic bridge
// keys). The 4-corner sample captures any 2D affine; `offsetWidth/
// Height` is the load-bearing detail — without it the basis vectors
// get normalised by the bounding-rect AABB, which is inflated by
// rotation, and the committed rect comes out smaller than the preview.

export interface AffineMap {
  /** Origin in screen space (parent local (0,0) → screen). */
  ox: number; oy: number;
  /** Basis vector for local x axis, length = 1 local unit, in screen px. */
  ux: number; uy: number;
  /** Basis vector for local y axis. */
  vx: number; vy: number;
}

/** Build the parent's local-to-screen affine map. Returns null when
 *  the corner cache hasn't populated yet (early-render race) or the
 *  parent has zero layout size (degenerate). */
export function buildParentScreenMap(parentId: string, vpId: string): AffineMap | null {
  const corners = getScreenCornersById(parentId, vpId);
  if (!corners) return null;
  const styles = findNodeComputedStyles(parentId, vpId, ['__offsetWidth', '__offsetHeight']);
  const width = parseFloat(styles.__offsetWidth) || 0;
  const height = parseFloat(styles.__offsetHeight) || 0;
  if (width <= 0 || height <= 0) return null;
  return {
    ox: corners.TL.x, oy: corners.TL.y,
    ux: (corners.TR.x - corners.TL.x) / width,
    uy: (corners.TR.y - corners.TL.y) / width,
    vx: (corners.BL.x - corners.TL.x) / height,
    vy: (corners.BL.y - corners.TL.y) / height,
  };
}

/** Invert an affine map. Returns null for degenerate (zero-area) maps. */
export function invertAffine(m: AffineMap): { invertScreen: (sx: number, sy: number) => { x: number; y: number } } | null {
  const det = m.ux * m.vy - m.uy * m.vx;
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const ax =  m.vy * invDet, bx = -m.vx * invDet;
  const ay = -m.uy * invDet, by =  m.ux * invDet;
  return {
    invertScreen: (sx, sy) => {
      const dx = sx - m.ox;
      const dy = sy - m.oy;
      return { x: ax * dx + bx * dy, y: ay * dx + by * dy };
    },
  };
}

/** CSS matrix() string for the parent's local-to-screen map. Apply to
 *  the preview element so it appears tilted/scaled exactly like the
 *  parent. Pair with `transform-origin: 0 0` so the matrix translation
 *  lands the preview at the right origin. */
export function affineToCSSMatrix(m: AffineMap): string {
  return `matrix(${m.ux}, ${m.uy}, ${m.vx}, ${m.vy}, ${m.ox}, ${m.oy})`;
}

/** Compose a translate(left, top) in LOCAL space onto an affine map.
 *  Used to bake the rect offset into the matrix translation so the
 *  preview element can be drawn at `left:0; top:0; width:W; height:H`
 *  in local units. */
export function composeMapWithLocalOffset(m: AffineMap, left: number, top: number): AffineMap {
  return {
    ox: m.ox + m.ux * left + m.vx * top,
    oy: m.oy + m.uy * left + m.vy * top,
    ux: m.ux, uy: m.uy,
    vx: m.vx, vy: m.vy,
  };
}

// ─── Projective math (handles 3D perspective parents) ───────────────────────
//
// AffineMap above is enough for any 2D transform — rotate, skew, scale,
// translate, or arbitrary `matrix(...)` combinations. But CSS `perspective(...)`
// (used with `rotateX` / `rotateY` or applied via a `perspective` property on
// an ancestor) produces a TRAPEZOID at the painted corners, not a
// parallelogram. The 4 corners don't satisfy `BR = TL + (TR-TL) + (BL-TL)`,
// so a 6-DOF affine basis can't represent them — we need the 8-DOF projective
// (homography) transform.
//
// The projective map is a 3×3 matrix `H` such that a local point `(x, y)` maps
// to a screen point via homogeneous coordinates:
//
//   x_screen = (a*x + b*y + c) / (g*x + h*y + i)
//   y_screen = (d*x + e*y + f) / (g*x + h*y + i)
//
// For the affine sub-case, `g = h = 0, i = 1` and the divide degenerates to 1
// — so this representation handles affine + perspective uniformly.
//
// We build `H` from the parent's 4 painted screen corners (`TL`, `TR`, `BR`,
// `BL` — all 4 now, vs the 3 the affine path used) using the standard closed-
// form unit-square → quad homography, then right-multiplied by a scale to map
// the parent's local rectangle `(0..W, 0..H)` onto the unit square.
//
// The browser's CSS `matrix3d(...)` encoding accepts the full 4×4 form, so
// `projectiveToCSSMatrix3d` emits a 16-value matrix3d that the browser
// applies (including the perspective divide) when the preview element renders.

export interface ProjectiveMap {
  /** Row-major 3×3: [a, b, c, d, e, f, g, h, i].
   *  Forward: screen = (a*x + b*y + c, d*x + e*y + f) / (g*x + h*y + i). */
  h: [number, number, number, number, number, number, number, number, number];
}

/**
 * Build the parent's local-to-screen projective map from its 4 painted
 * corners. Handles BOTH affine and perspective parents — the homography
 * solver collapses to the affine case when `BR` lies in the parallelogram
 * defined by `TL/TR/BL`.
 *
 * Returns null on the same degeneracy conditions as the affine builder
 * (no corner cache, zero layout size).
 */
export function buildParentScreenMapProjective(parentId: string, vpId: string): ProjectiveMap | null {
  const corners = getScreenCornersById(parentId, vpId);
  if (!corners) return null;
  const styles = findNodeComputedStyles(parentId, vpId, ['__offsetWidth', '__offsetHeight']);
  const width = parseFloat(styles.__offsetWidth) || 0;
  const height = parseFloat(styles.__offsetHeight) || 0;
  // SVG elements have no offsetWidth/Height (always 0) → null here. SVG GROUP
  // parents must NOT use this corner-based homography: the cached corners are
  // getBBox-based and getBBox INCLUDES the child being dragged, so the parent
  // frame would move with the child (glitchy jumps / wrong speed). They use
  // `buildParentSvgGroupMap` instead — the STABLE wrapper matrix.
  if (width <= 0 || height <= 0) return null;
  return solveHomography(width, height, corners.TL, corners.TR, corners.BR, corners.BL);
}

/** The STABLE local(viewBox-user)→screen affine for an SVG GROUP parent,
 *  read from the synthetic `__svgm*` computed keys (the sandbox emits the
 *  group's `M_topSvg`, which is built from the wrapper box / transform-origin /
 *  zoom — NOT getBBox, so it does NOT move as a child is dragged). Invert it
 *  (`invertAffine`) to map a screen drag delta to the child's x/y delta —
 *  correct at any zoom and rotation. Returns null for non-SVG / missing data. */
export function buildParentSvgGroupMap(parentId: string, vpId: string): AffineMap | null {
  const s = findNodeComputedStyles(parentId, vpId, ['__svgm0', '__svgm1', '__svgm2', '__svgm3', '__svgm4', '__svgm5']);
  const a = parseFloat(s.__svgm0), b = parseFloat(s.__svgm1), c = parseFloat(s.__svgm2);
  const d = parseFloat(s.__svgm3), e = parseFloat(s.__svgm4), f = parseFloat(s.__svgm5);
  if ([a, b, c, d, e, f].every(Number.isFinite) && Math.abs(a * d - b * c) >= 1e-9) {
    // AffineMap: screen = (ox + ux·x + vx·y, oy + uy·x + vy·y); the affine tuple
    // is [a,b,c,d,e,f] with screen.x = a·x + c·y + e, screen.y = b·x + d·y + f.
    return { ox: e, oy: f, ux: a, uy: b, vx: c, vy: d };
  }
  // FALLBACK: `__svgm*` only lands in the computed cache during the sandbox's
  // MEASURE sweep — a group dropped moments ago (or one the sweep hasn't
  // covered yet) has none, and the drag then fell back to the projective map
  // built from PAINTED (getBBox) corners. That frame MOVES as the dragged
  // child grows the painted bounds — a feedback loop that ate the delta
  // (child froze after ~2 ticks, "offsets completely during drag",
  // 2026-07-28). For the common un-rotated axis-aligned group, derive the
  // SAME stable affine from the group's layout rect (rectCache — the box, not
  // the painted bbox) + its viewBox attr: scale = rect/viewBox, origin =
  // rect - viewBoxMin·scale.
  const node = getNodeFromCache(parentId);
  if (node?.type !== 'svg') return null;
  const vb = (node.attrs?.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return null;
  const rotated = /rotate/.test(node.styles?.transform ?? '') || /rotate\(/.test(node.attrs?.transform ?? '');
  if (rotated) return null; // rotation needs the real matrix — wait for the sweep
  const rect = findNodeRect(parentId, vpId);
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const sx = rect.width / vb[2];
  const sy = rect.height / vb[3];
  return { ox: rect.left - vb[0] * sx, oy: rect.top - vb[1] * sy, ux: sx, uy: 0, vx: 0, vy: sy };
}

/**
 * Closed-form solver for the homography H that maps:
 *   (0, 0) → P0,  (W, 0) → P1,  (W, H) → P2,  (0, H) → P3
 *
 * Two-stage:
 *   1. Solve `Hu` mapping the UNIT square `(0,0)/(1,0)/(1,1)/(0,1)` → quad.
 *      Standard formula from Heckbert ("Fundamentals of Texture Mapping &
 *      Image Warping", 1989). Falls back to affine basis when the 4 corners
 *      form a parallelogram (perspective DOF is zero).
 *   2. Right-multiply by `diag(1/W, 1/H, 1)` so the local-space rectangle
 *      `(0..W, 0..H)` lands on the unit square before `Hu` is applied.
 *
 * Geometry source: Paul Heckbert's classic derivation, used in every modern
 * image-warping / texture-mapping toolkit.
 */
function solveHomography(
  width: number, height: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): ProjectiveMap {
  // Stage 1 — Hu: unit square → quad.
  // dx3/dy3 = "how far BR strays from the parallelogram closure":
  //   = (P0 - P1 + P2 - P3) — zero when the quad IS a parallelogram.
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let g: number, h: number;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // Affine sub-case: no perspective DOF, bottom row is [0, 0, 1].
    g = 0; h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-9) {
      // Degenerate quad (3+ corners colinear). Treat as identity scale —
      // the preview will draw axis-aligned, which is the safest fallback.
      g = 0; h = 0;
    } else {
      const invDet = 1 / det;
      g = (dx3 * dy2 - dx2 * dy3) * invDet;
      h = (dx1 * dy3 - dx3 * dy1) * invDet;
    }
  }

  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  // bottom row: (g, h, 1)

  // Stage 2 — scale local-space `(0..W, 0..H)` to the unit square.
  // Right-multiply Hu by diag(1/W, 1/H, 1):
  //   columns 0 and 1 of Hu get divided by W and H respectively.
  const invW = 1 / width;
  const invH = 1 / height;
  return {
    h: [
      a * invW, b * invH, c,
      d * invW, e * invH, f,
      g * invW, h * invH, 1,
    ],
  };
}

/**
 * Invert a projective map. Returns null on degenerate (det ≈ 0) input.
 *
 * `invertScreen(sx, sy)` projects a screen point back into parent-local
 * coords, performing the perspective divide (so points further into the
 * vanishing direction correctly unwarp to their true local positions).
 */
export function invertProjective(m: ProjectiveMap): { invertScreen: (sx: number, sy: number) => { x: number; y: number } } | null {
  const [a, b, c, d, e, f, g, h, i] = m.h;
  // Standard 3×3 cofactor inverse.
  const A =  (e * i - f * h);
  const B = -(b * i - c * h);
  const C =  (b * f - c * e);
  const D = -(d * i - f * g);
  const E =  (a * i - c * g);
  const F = -(a * f - c * d);
  const G =  (d * h - e * g);
  const H = -(a * h - b * g);
  const I =  (a * e - b * d);
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const ia = A * invDet, ib = B * invDet, ic = C * invDet;
  const id = D * invDet, ie = E * invDet, ifv = F * invDet;
  const ig = G * invDet, ih = H * invDet, ii = I * invDet;
  return {
    invertScreen: (sx, sy) => {
      // Apply inverse homography in homogeneous coords + perspective divide.
      const w = ig * sx + ih * sy + ii;
      // Guard against the rare case where the screen point lies on the
      // vanishing line (w ≈ 0) — return the parent origin as a fallback so
      // the preview doesn't fly off to infinity.
      if (Math.abs(w) < 1e-9) return { x: 0, y: 0 };
      const invW = 1 / w;
      return {
        x: (ia * sx + ib * sy + ic) * invW,
        y: (id * sx + ie * sy + ifv) * invW,
      };
    },
  };
}

/**
 * Emit a CSS `matrix3d(...)` for the projective map. The browser applies the
 * 4×4 matrix and the perspective divide automatically, so the preview tilts
 * with the parent under any 2D-affine OR perspective transform.
 *
 * The 2D projective 3×3 `H` lifts into a 4×4 (column-major, CSS convention):
 *
 *   m11=a, m12=d, m13=0, m14=g  ← column 1: x basis + its perspective weight
 *   m21=b, m22=e, m23=0, m24=h  ← column 2: y basis + its perspective weight
 *   m31=0, m32=0, m33=1, m34=0  ← column 3: z basis (we're 2D, keep identity)
 *   m41=c, m42=f, m43=0, m44=i  ← column 4: translation + perspective bias
 *
 * Pair with `transform-origin: 0 0` (same as the affine path) so the
 * translation column lands the preview at the right screen origin.
 */
export function projectiveToCSSMatrix3d(m: ProjectiveMap): string {
  const [a, b, c, d, e, f, g, h, i] = m.h;
  return `matrix3d(${a}, ${d}, 0, ${g}, ${b}, ${e}, 0, ${h}, 0, 0, 1, 0, ${c}, ${f}, 0, ${i})`;
}

/**
 * Compose a translate(left, top) in LOCAL space onto a projective map.
 * Right-multiplication by the local-translation matrix T(left, top):
 *
 *   H * T  produces a new column-c (and bottom-row-c) that bakes the offset
 *   so the preview can render at `left:0; top:0; width:W; height:H` while
 *   the matrix3d carries the offset into screen space.
 */
export function composeProjectiveWithLocalOffset(m: ProjectiveMap, left: number, top: number): ProjectiveMap {
  const [a, b, c, d, e, f, g, h, i] = m.h;
  return {
    h: [
      a, b, a * left + b * top + c,
      d, e, d * left + e * top + f,
      g, h, g * left + h * top + i,
    ],
  };
}

/**
 * Compose a screen-space translate(-dx, -dy) onto a projective map. I.e.,
 * produce a new map whose output is the old map's output shifted by
 * `(-dx, -dy)` in screen coords. Used to re-base a screen-space map into
 * a CONTAINER's coordinate space when the preview element lives inside
 * a container offset from the viewport origin.
 *
 * The math is LEFT-multiplication: `T_screen(-dx, -dy) * H`, which mixes
 * the perspective row (`g, h, i`) into every entry of the top two rows.
 * Naively subtracting from `c` and `f` only (the way the AFFINE path did)
 * is correct for affine maps because their `i = 1` and `g = h = 0` — but
 * under perspective `i ≠ 1` after `composeProjectiveWithLocalOffset`, so
 * the naive subtract under-corrects (or over-corrects) by a factor of `i`.
 * Symptom: the preview drifts away from the cursor as you move toward
 * the vanishing direction.
 */
export function composeProjectiveWithScreenOffset(m: ProjectiveMap, dx: number, dy: number): ProjectiveMap {
  const [a, b, c, d, e, f, g, h, i] = m.h;
  return {
    h: [
      a - dx * g, b - dx * h, c - dx * i,
      d - dy * g, e - dy * h, f - dy * i,
      g, h, i,
    ],
  };
}
