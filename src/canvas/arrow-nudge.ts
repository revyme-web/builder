// arrow-nudge.ts — Arrow-key nudging for the canvas selection.
//
// Two behaviors, dispatched by nudgeSelection (added in a later task):
//   A. Absolute node  → move 1/10/100px in the pressed direction, adjusting
//      whichever sides the Position tool has pinned (left/right/top/bottom).
//   B. Layout child   → move the node's CSS `order` one slot along the
//      container's main axis (replica-aware via commitOrderAssignments).

import { computeReorderAssignments, computeReplicaOrderMirrorUpdates } from './drag/reparent-utils';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';
import type { PendingUpdate } from '@/shared/types';
import {
  findNodeComputedStyle, findNodeParentInnerSize, findChildRects,
  getViewportPrefix, isPrimaryViewport, getActiveFilePath, patchNodeStyles,
} from './node-ops';
import { detectParentLayoutById, getFlexDirectionById } from './drag/types';
import { getReplicaContext } from './drag/replica-context';
import { commitOrderAssignments } from './drag/strategies/order-commit';
import { queueMutation, flushNow, type Mutation } from '@/code/mutation/mutation-queue';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { getDefaultStore } from 'jotai';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { bakeStylesForTile, tileContextFor } from './replica-bake';
import { resolveOverlayConfig } from '@/code/parsing/overlay-parser';
import type { OverlayConfig } from '@/shared/types';

export type NudgeDirection = 'up' | 'down' | 'left' | 'right';

// ─── Debounced flush ────────────────────────────────────────────────────────
// flushNow() regenerates source code + re-renders — too expensive to run on
// every keypress. With auto-repeat (~30Hz) the main thread saturates and the
// element appears stuck until the user releases the key. Instead, the DOM is
// patched per-keystroke (instant visual feedback) and the queue flush is
// debounced — fires ~200ms after the last nudge. Mirrors the drag pattern:
// patch live, commit once on release.

const FLUSH_DEBOUNCE_MS = 200;
let pendingFlushHandle: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (pendingFlushHandle != null) clearTimeout(pendingFlushHandle);
  pendingFlushHandle = setTimeout(() => {
    pendingFlushHandle = null;
    trace.action('arrow-nudge:debounced-flush-fired');
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
}

/** Cancel any pending debounced flush and flush immediately. Call this when
 *  another system needs the source to be current (e.g. undo, file save). */
export function flushPendingNudge(): void {
  if (pendingFlushHandle == null) return;
  clearTimeout(pendingFlushHandle);
  pendingFlushHandle = null;
  trace.action('arrow-nudge:forced-flush');
  flushNow();
}

// ─── Pure: absolute position nudge ──────────────────────────────────────────

/**
 * Compute the style patch for nudging an absolutely-positioned node.
 * Reads which sides are pinned from `styles` (left/right/top/bottom). Moving
 * "right"/"down" means: increase left/top, decrease right/bottom. An axis with
 * no pinned side produces no patch entry. `%` values are nudged by the
 * percentage-equivalent of `step` px against the parent inner dimension.
 */
export function computeAbsoluteNudge(
  styles: Record<string, string>,
  direction: NudgeDirection,
  step: number,
  parentInner: { width: number; height: number },
): Record<string, string> {
  const horiz = direction === 'left' || direction === 'right';
  const sides: readonly [string, string] = horiz ? ['left', 'right'] : ['top', 'bottom'];
  const parentPx = horiz ? parentInner.width : parentInner.height;
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  const patch: Record<string, string> = {};

  for (const side of sides) {
    const raw = styles[side];
    if (!raw || raw.trim() === '' || raw.trim() === 'auto') continue;
    // left/top move WITH the visual direction; right/bottom move AGAINST it.
    const sideSign = side === 'left' || side === 'top' ? sign : -sign;
    const nudged = nudgeValue(raw, sideSign * step, parentPx);
    if (nudged !== null) patch[side] = nudged;
  }
  return patch;
}

function nudgeValue(raw: string, deltaPx: number, parentPx: number): string | null {
  const trimmed = raw.trim();
  const num = parseFloat(trimmed);
  if (Number.isNaN(num)) return null;

  if (trimmed.endsWith('%')) {
    if (parentPx <= 0) return null;
    const deltaPct = (deltaPx / parentPx) * 100;
    return `${+(num + deltaPct).toFixed(4)}%`;
  }

  // px or unitless → treat as px. Any other unit (em/rem/vw/calc/…) is not
  // safely nudgeable by a px delta, so bail and leave that side untouched.
  // Note: a fractional starting px value is intentionally snapped to an
  // integer here — px nudges are whole-pixel by design.
  const isPxOrUnitless = trimmed.endsWith('px') || /^-?\d*\.?\d+$/.test(trimmed);
  if (!isPxOrUnitless) return null;
  return `${Math.round(num + deltaPx)}px`;
}

// ─── Effective styles for the interacting tile ──────────────────────────────

/** Variant-tile effective styles on a COMPONENT MASTER: base + per-variant
 *  conditionalStyles + the always-on 'default' entry + the tile's own variant
 *  entry — the precedence the Renderer paints with, because it IS the
 *  Renderer's resolver. Pure; exported for tests. */
export function mergeVariantEffectiveStyles(node: CanvasNode, variant: string): Record<string, string> {
  return bakeStylesForTile(node, { kind: 'variant', variant });
}

/** The node's EFFECTIVE styles for the interacting tile. `node.styles` alone
 *  is the PRIMARY's truth — a replica's left/top live in its @media band and a
 *  variant tile's in the variant object. Reading base meant every nudge
 *  computed `base ± step`: the first press JUMPED to a wrong value and every
 *  repeat recomputed the SAME number → "arrows do nothing on replicas"
 *  (user trace 2026-08-06: identical `top: 478px` patch on consecutive
 *  presses). Same class as [[feedback_replica_effective_style_resolution]]. */
function effectiveStylesFor(node: CanvasNode, vpId: string): Record<string, string> {
  return bakeStylesForTile(node, tileContextFor(vpId, getActiveFilePath(), getViewportWidths()));
}

// ─── Pure: layout-child order nudge ─────────────────────────────────────────

/**
 * Compute new sequential order assignments for moving `selectedId` one slot
 * along the main axis. Returns null when the arrow is cross-axis, the node is
 * already at the edge, or the node isn't in the sibling list.
 */
/**
 * The siblings that actually occupy a slot in the parent's flow, in visual
 * order along the main axis.
 *
 * OUT-OF-FLOW CHILDREN TAKE NO SLOT. `order` has no effect on an absolutely
 * positioned box, so if one is allowed to sit in this list, nudging past it
 * renumbers everything but produces the *same* arrangement on screen — the
 * node reads as "stuck" and pressing the key again never helps, because the
 * geometry that produced the list didn't change either.
 *
 * The case that surfaced it: a Hero column whose first flow child had a
 * rotated, absolutely-positioned label sitting between it and the next
 * section. Up was a no-op (already index 0) and Down only swapped with the
 * label, so that one child could not be moved by keyboard at all while its
 * siblings could, and dragging it worked fine.
 *
 * Pure over its inputs so the rule is testable without a canvas bridge.
 */
export function computeFlowSiblingOrder(
  children: {
    id: string;
    rect: { left: number; top: number };
    position: string | null | undefined;
    order?: number | null;
    /** Not rendered on this viewport/variant. Such a child has NO usable
     *  geometry — see the placement note below. */
    hidden?: boolean;
  }[],
  flexDirection: 'row' | 'column',
): string[] {
  const kept = children
    // TEMPLATE CHROME excluded: on a templated page the flat merge makes
    // `layout::` nodes siblings of the sections — including them here made an
    // arrow reorder renumber the template footer/nav in SECTION space (the
    // band-corruption commitOrderAssignments now also guards against).
    .map((c, index) => ({ ...c, index }))
    .filter(c => !c.id.startsWith('layout::') && c.id !== 'children-slot')
    .filter(c => c.position !== 'absolute' && c.position !== 'fixed');

  // HIDDEN siblings are placed by `order`, never by geometry.
  //
  // A hidden element's rect is (0,0,0,0) — the iframe's top-left — so it does
  // not merely sort imprecisely, it sorts BEFORE every laid-out sibling and
  // never reaches the tie-break below. The caller renumbers this sequence
  // 0..n-1, so the hidden child was rewritten to `order: 0` on every nudge: its
  // authored position was silently destroyed and it reappeared at the front of
  // the parent when unhidden (user report 2026-09-19). The shift is uniform, so
  // the VISIBLE result stayed correct — which is why this went unnoticed.
  //
  // `order` is the only record of where a hidden child belongs, so it is what
  // places it: sort the visible ones by geometry as before, then splice each
  // hidden one in at the point its `order` puts it among them.
  const visible = kept.filter(c => !c.hidden);
  const hidden = kept.filter(c => c.hidden);

  visible.sort((a, b) => {
    const d = flexDirection === 'row' ? a.rect.left - b.rect.left : a.rect.top - b.rect.top;
    // A ZERO-SIZE sibling ties on the main axis with the sibling that follows
    // it (a code component whose min-content width squeezed its flex siblings
    // to 0px, live find 2026-09-06). A geometry tie must fall back to what
    // CSS itself uses to place them — `order`, then source index — otherwise
    // the tie keeps INPUT (source) order, the moved node reads as still first,
    // and every arrow press is a no-op or rewrites the same assignments.
    if (Math.abs(d) > 0.5) return d;
    const ao = a.order ?? 0; const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    return a.index - b.index;
  });

  if (hidden.length === 0) return visible.map(c => c.id);

  // Lowest order first, so equal-order hidden children keep their source order
  // relative to each other rather than reversing.
  hidden.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.index - b.index);
  const out = [...visible];
  for (const h of hidden) {
    const ho = h.order ?? 0;
    // First visible child whose order is GREATER — the hidden one belongs just
    // before it. Equal orders keep the hidden child after, matching how CSS
    // breaks an `order` tie by source position.
    let at = out.findIndex(c => !c.hidden && (c.order ?? 0) > ho);
    if (at === -1) at = out.length;
    out.splice(at, 0, h);
  }
  return out.map(c => c.id);
}

export function computeOrderNudge(
  selectedId: string,
  visualOrderIds: string[],
  direction: NudgeDirection,
  flexDirection: 'row' | 'column',
): { nodeId: string; order: number }[] | null {
  const isMainAxis = flexDirection === 'row'
    ? direction === 'left' || direction === 'right'
    : direction === 'up' || direction === 'down';
  if (!isMainAxis) return null;

  const idx = visualOrderIds.indexOf(selectedId);
  if (idx === -1) return null;

  const forward = direction === 'right' || direction === 'down';
  const target = forward ? idx + 1 : idx - 1;
  if (target < 0 || target >= visualOrderIds.length) return null;

  const reordered = visualOrderIds.slice();
  reordered.splice(idx, 1);
  reordered.splice(target, 0, selectedId);
  return computeReorderAssignments(reordered);
}

// ─── Impure: orchestration ──────────────────────────────────────────────────

export interface NudgeContext {
  selectedIds: string[];
  nodes: Map<string, CanvasNode>;
  contentEl: HTMLElement;
  vpId: string;
}

/**
 * Dispatch arrow-key nudging for the current selection.
 *  - A single non-absolute node whose parent is flex/auto-grid → ORDER nudge.
 *  - Every absolute/fixed node in the selection → position nudge by `step` px.
 * Mutations are queued + flushed immediately; the DOM is also patched via the
 * bridge for instant visual feedback.
 */
// ─── Pure: overlay offset nudge ─────────────────────────────────────────────

/**
 * An OVERLAY is `position: fixed` but its placement is not left/top — the
 * runtime derives it from the trigger rect + the overlay config's offset. So
 * an arrow press on a selected overlay must nudge `offsetX` / `offsetY`,
 * routed exactly like the overlay drag commit: primary tile → base config,
 * component variant tile → that variant's override, page replica → that
 * width's override. (Before: the absolute path wrote left/top, which the
 * portal placement ignored — "arrows do nothing on a selected overlay",
 * live find 2026-09-06.)
 */
export function computeOverlayNudge(
  config: OverlayConfig,
  direction: NudgeDirection,
  step: number,
  tile: { vpId: string; vpWidth: number; isPrimary: boolean; isComponentFile: boolean },
): { patch: { offsetX: number; offsetY: number }; vpWidth: number | null; variant: string | null } {
  const eff = tile.isPrimary
    ? { offsetX: config.offsetX ?? 0, offsetY: config.offsetY ?? 0 }
    : resolveOverlayConfig(config, tile.vpId, tile.vpWidth);
  const dx = direction === 'left' ? -step : direction === 'right' ? step : 0;
  const dy = direction === 'up' ? -step : direction === 'down' ? step : 0;
  const variant = (!tile.isPrimary && tile.isComponentFile) ? tile.vpId : null;
  return {
    patch: { offsetX: (eff.offsetX ?? 0) + dx, offsetY: (eff.offsetY ?? 0) + dy },
    vpWidth: variant ? null : (tile.isPrimary ? null : tile.vpWidth),
    variant,
  };
}

export function nudgeSelection(direction: NudgeDirection, step: number, ctx: NudgeContext): void {
  const { selectedIds, nodes, contentEl, vpId } = ctx;
  if (selectedIds.length === 0) return;
  trace.action('arrow-nudge:start', { direction, step, count: selectedIds.length, vpId });

  // Single OVERLAY selection → offset nudge (config write, not left/top).
  if (selectedIds.length === 1) {
    const ovNode = nodes.get(selectedIds[0]);
    const rawCfg = ovNode?.attrs?.['data-overlay'];
    if (ovNode && rawCfg) {
      let config: OverlayConfig | null = null;
      try { config = JSON.parse(rawCfg) as OverlayConfig; } catch { config = null; }
      if (config) {
        const widths = getViewportWidths();
        const isPrimary = isPrimaryViewport(vpId);
        const { patch, vpWidth, variant } = computeOverlayNudge(config, direction, step, {
          vpId, vpWidth: widths[vpId] ?? 0, isPrimary, isComponentFile: isComponentFilePath(getActiveFilePath()),
        });
        queueMutation({
          type: 'updateOverlayConfig', overlayId: ovNode.id, patch,
          vpWidth, variant, breakpoints: Object.values(widths),
        });
        flushNow();
        trace.action('arrow-nudge:overlay-offset', { id: ovNode.id, direction, step, patch, vpWidth, variant });
        return;
      }
    }
  }

  // Single layout-child selection → ORDER nudge (multi-select reorder is
  // ambiguous, so it falls through to the absolute path which no-ops on
  // non-absolute nodes).
  if (selectedIds.length === 1) {
    const id = selectedIds[0];
    const pos = findNodeComputedStyle(id, vpId, 'position');
    if (pos !== 'absolute' && pos !== 'fixed') {
      const parentId = nodes.get(id)?.parentId;
      if (parentId) {
        const layout = detectParentLayoutById(parentId, vpId);
        if (layout === 'flex' || layout === 'grid') {
          nudgeOrder(id, parentId, direction, ctx);
        } else {
          trace.action('arrow-nudge:noop-non-layout', { id, parentId, layout });
        }
      } else {
        trace.action('arrow-nudge:noop-non-layout', { id, parentId });
      }
      return;
    }
  }

  // Absolute nudge for every absolute/fixed node in the selection.
  // getReplicaContext args are loop-invariant — compute once before the loop.
  const rctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
  const updates: PendingUpdate[] = [];
  for (const id of selectedIds) {
    const pos = findNodeComputedStyle(id, vpId, 'position');
    if (pos !== 'absolute' && pos !== 'fixed') continue;
    const node = nodes.get(id);
    if (!node) continue;
    const parentInner = findNodeParentInnerSize(id, vpId);
    const patch = computeAbsoluteNudge(effectiveStylesFor(node, vpId), direction, step, parentInner);
    if (Object.keys(patch).length === 0) continue;
    patchNodeStyles(contentEl, id, getViewportPrefix(vpId), patch, !isPrimaryViewport(vpId));
    updates.push(...rctx.styleUpdate(id, patch));
    trace.action('arrow-nudge:absolute', { id, patch });
  }
  if (updates.length > 0) {
    queuePendingUpdates(updates);
    scheduleFlush();
  } else {
    trace.action('arrow-nudge:noop-absolute', { count: selectedIds.length });
  }
}

/**
 * Convert the routed `PendingUpdate[]` produced by `getReplicaContext().styleUpdate`
 * and `commitOrderAssignments` into mutation-queue `Mutation`s and queue them.
 * Mirrors the equivalent style/variant/container branches of
 * `CanvasDragOrchestrator.commitUpdates` — nudging can only produce these four
 * update kinds (inline `style`, `updateContainerStyle`, `updateVariantStyle`,
 * `setConditionalOrder`). Anything else is a routing bug and is traced as an error.
 */
export function queuePendingUpdates(updates: PendingUpdate[]): void {
  for (const update of updates) {
    let mutation: Mutation | null = null;
    if (update.type === 'style' && update.styles) {
      mutation = { type: 'updateStyles', nodeId: update.nodeId, styles: update.styles };
    } else if (update.type === 'updateContainerStyle' && update.styles && update.maxWidth != null) {
      mutation = {
        type: 'updateContainerStyle', nodeId: update.nodeId,
        maxWidth: update.maxWidth, styles: update.styles,
      };
    } else if (update.type === 'updateVariantStyle' && update.styles && update.variantName != null) {
      mutation = {
        type: 'updateVariantStyle', nodeId: update.nodeId,
        variantName: update.variantName, styles: update.styles,
      };
    } else if (update.type === 'setConditionalOrder' && update.orderMap != null) {
      mutation = {
        type: 'setConditionalOrder', nodeId: update.nodeId,
        orderMap: update.orderMap, pinVariants: update.pinVariants,
      };
    }
    if (mutation) {
      queueMutation(mutation);
    } else {
      trace.error('arrow-nudge:unroutable-update', { update });
    }
  }
}

function nudgeOrder(
  id: string,
  parentId: string,
  direction: NudgeDirection,
  ctx: NudgeContext,
): void {
  const { contentEl, vpId } = ctx;

  // Explicit grid placement (gridColumn: '1 / 3' etc.) → `order` has no effect,
  // skip — mirrors LayoutLiftedStrategy's isExplicitGridPlacement guard.
  if (detectParentLayoutById(parentId, vpId) === 'grid') {
    const gc = findNodeComputedStyle(id, vpId, 'gridColumn');
    if (gc && gc !== 'auto' && gc !== 'auto / auto') {
      trace.action('arrow-nudge:order-skip-explicit-grid', { id, gridColumn: gc });
      return;
    }
  }

  const flexDir = getFlexDirectionById(parentId, vpId);
  const visualOrderIds = computeFlowSiblingOrder(
    findChildRects(parentId, vpId).map(c => ({
      id: c.id,
      rect: c.rect,
      position: findNodeComputedStyle(c.id, vpId, 'position'),
      order: parseInt(findNodeComputedStyle(c.id, vpId, 'order') || '0', 10) || 0,
      // Both tests matter: `display:none` is the authored hide, and a 0x0 rect
      // catches the same degenerate geometry from a mid-flush remeasure.
      hidden: findNodeComputedStyle(c.id, vpId, 'display') === 'none'
        || (c.rect.width === 0 && c.rect.height === 0),
    })),
    flexDir,
  );

  const assignments = computeOrderNudge(id, visualOrderIds, direction, flexDir);
  if (!assignments) {
    trace.action('arrow-nudge:order-noop', { id, direction, flexDir, visualOrderIds });
    return;
  }

  const updates = commitOrderAssignments(assignments, contentEl, vpId);
  // Viewports with an INDEPENDENT @media order map need their own band write
  // for the moved node — exactly like a drag drop (see
  // computeReplicaOrderMirrorUpdates, the "tablet jumped way above" class).
  // Component masters route per-variant via setConditionalOrder instead.
  if (!isComponentFilePath(getActiveFilePath())) {
    updates.push(...computeReplicaOrderMirrorUpdates({
      draggedIds: [id],
      desiredVisualOrder: assignments.map(a => a.nodeId),
      getNodeStyles: (nid) => ctx.nodes.get(nid)?.styles,
      overrides: getDefaultStore().get(containerOverridesAtom),
      vpWidths: getViewportWidths(),
      dropVpId: vpId,
    }));
  }
  trace.action('arrow-nudge:order', {
    id, direction, assignments, updateCount: updates.length,
  });
  queuePendingUpdates(updates);
  scheduleFlush();
}
