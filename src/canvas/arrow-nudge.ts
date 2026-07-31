// arrow-nudge.ts — Arrow-key nudging for the canvas selection.
//
// Two behaviors, dispatched by nudgeSelection (added in a later task):
//   A. Absolute node  → move 1/10/100px in the pressed direction, adjusting
//      whichever sides the Position tool has pinned (left/right/top/bottom).
//   B. Layout child   → move the node's CSS `order` one slot along the
//      container's main axis (replica-aware via commitOrderAssignments).

import { computeReorderAssignments } from './drag/reparent-utils';
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

// ─── Pure: layout-child order nudge ─────────────────────────────────────────

/**
 * Compute new sequential order assignments for moving `selectedId` one slot
 * along the main axis. Returns null when the arrow is cross-axis, the node is
 * already at the edge, or the node isn't in the sibling list.
 */
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
export function nudgeSelection(direction: NudgeDirection, step: number, ctx: NudgeContext): void {
  const { selectedIds, nodes, contentEl, vpId } = ctx;
  if (selectedIds.length === 0) return;
  trace.action('arrow-nudge:start', { direction, step, count: selectedIds.length, vpId });

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
    const patch = computeAbsoluteNudge(node.styles ?? {}, direction, step, parentInner);
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
      mutation = { type: 'setConditionalOrder', nodeId: update.nodeId, orderMap: update.orderMap };
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
  const visualOrderIds = findChildRects(parentId, vpId)
    .slice()
    .sort((a, b) => (flexDir === 'row' ? a.rect.left - b.rect.left : a.rect.top - b.rect.top))
    .map(c => c.id);

  const assignments = computeOrderNudge(id, visualOrderIds, direction, flexDir);
  if (!assignments) {
    trace.action('arrow-nudge:order-noop', { id, direction, flexDir, visualOrderIds });
    return;
  }

  const updates = commitOrderAssignments(assignments, contentEl, vpId);
  trace.action('arrow-nudge:order', {
    id, direction, assignments, updateCount: updates.length,
  });
  queuePendingUpdates(updates);
  scheduleFlush();
}
