// order-commit.ts — Shared CSS `order` commit routing.
//
// Given sequential { nodeId, order }[] for ALL children of a flex/auto-grid
// parent + the active viewport id, this:
//   1. Patches `order` onto every child via the bridge (instant visual feedback).
//   2. Returns the routed PendingUpdate[] for the mutation queue:
//        primary viewport      → inline `style`
//        page replica          → `updateContainerStyle` (@container CSS)
//        component master repl. → `setConditionalOrder` (variant ternary)
//
// Used by LayoutLiftedStrategy (drop-reorder) and arrow-nudge (keyboard reorder)
// so both reorder paths route identically.

import type { PendingUpdate } from '@/shared/types';
import {
  patchNodeStyles, getViewportPrefix, isPrimaryViewport,
  getActiveFilePath, findNodeComputedStyle,
} from '@/canvas/node-ops';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { getNodeFromCache } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

// computeLayoutBrackets moved to shared/flex-helpers (2026-07-27): the store's
// template merge needs it too, and importing from here would cycle
// (store → order-commit → node-ops → store). Re-exported for existing callers.
export { computeLayoutBrackets } from '@/shared/flex-helpers';

export function commitOrderAssignments(
  orderAssignments: { nodeId: string; order: number }[],
  contentEl: HTMLElement,
  vpId: string,
  /** Per-node CURRENT order for the DEFAULT (primary-variant) branch of a
   *  component-master reorder. Authoritative when provided — the Layers-panel
   *  passes each child's visual index, which is correct even when the child has
   *  NO inline `order` at all (pure flow order) where the model/computed reads
   *  both see 0 and would collapse the primary tile. */
  defaultOrders?: Map<string, number>,
): PendingUpdate[] {
  const vpPrefix = getViewportPrefix(vpId);
  const isPrimary = isPrimaryViewport(vpId);
  const updates: PendingUpdate[] = [];
  let branch: 'primary' | 'pageReplica' | 'compMaster';

  if (isPrimary) {
    branch = 'primary';
    for (const { nodeId, order } of orderAssignments) {
      patchNodeStyles(contentEl, nodeId, vpPrefix, { order: String(order) });
      updates.push({ nodeId, type: 'style', styles: { order: String(order) } });
    }
  } else {
    // Non-primary: set inline order with !important for instant visual feedback.
    for (const { nodeId, order } of orderAssignments) {
      patchNodeStyles(contentEl, nodeId, vpPrefix, { order: String(order) }, true);
    }
    const isCompMaster = getActiveFilePath().startsWith('components/');
    if (isCompMaster) {
      branch = 'compMaster';
      // Component master page: write order as conditional style (variant ternary).
      const variantName = vpId === 'desktop' || vpId === 'default' ? 'default' : vpId;
      for (const { nodeId, order } of orderAssignments) {
        // The DEFAULT (primary-variant) branch MUST preserve the node's CURRENT
        // order. Priority:
        //   1. `defaultOrders` (the caller's current visual index) — authoritative,
        //      and the ONLY correct source when the child has no inline `order` at
        //      all (pure flow order). The Layers-panel reorder passes this; without
        //      it the primary tile collapsed (every default → 0) because both reads
        //      below saw 0 and the structural JSX reorder then moved the primary.
        //   2. the MODEL — an existing ternary's default, or a plain inline order.
        //   3. the computed style — warm only on the canvas-drag path.
        const node = getNodeFromCache(nodeId);
        const primaryOrder = defaultOrders?.get(nodeId) ?? (parseInt(
          node?.conditionalStyles?.order?.default ??
          node?.styles?.order ??
          findNodeComputedStyle(nodeId, 'desktop', 'order') ??
          '0',
          10,
        ) || 0);
        updates.push({
          nodeId,
          type: 'setConditionalOrder',
          orderMap: { default: primaryOrder, [variantName]: order },
        });
      }
    } else {
      branch = 'pageReplica';
      // Page replica: write order via @container (max-width) CSS.
      const vpWidth = getViewportWidths()[vpId] || 0;
      for (const { nodeId, order } of orderAssignments) {
        updates.push({
          nodeId,
          type: 'updateContainerStyle',
          maxWidth: vpWidth,
          styles: { order: String(order) },
        });
      }
    }
  }

  trace.action('order-commit:commitOrderAssignments', {
    vpId, isPrimary, branch, count: orderAssignments.length, updates,
  });
  return updates;
}
