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
import { outOfFlowLayeringForOrders, type LayerAssignment } from '../out-of-flow-order';
import { trace } from '@/shared/debug-trace';

// computeLayoutBrackets moved to shared/flex-helpers (2026-07-27): the store's
// template merge needs it too, and importing from here would cycle
// (store → order-commit → node-ops → store). Re-exported for existing callers.
export { computeLayoutBrackets } from '@/shared/flex-helpers';

/** TEMPLATE CHROME is never a reorder target from a PAGE. The canvas's flat
 *  template merge makes `layout::` nodes SIBLINGS of the page sections, so a
 *  root reorder enumerated them and wrote section-space `order` values into
 *  the page's replica band (`[data-id="layout::TaWeNu-…"] { order: 2 }`) —
 *  slotting the template FOOTER between page sections on that tile only. The
 *  live site can't even express that (chrome lives OUTSIDE the page root in
 *  the layout file), so such writes are pure corruption (user report
 *  2026-08-06, mobile-only footer-above-sections). */
function isTemplateChrome(id: string): boolean {
  return id.startsWith('layout::') || id === 'children-slot';
}

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
  // Strip chrome from the assignment set; remember the ids so the page-replica
  // branch can HEAL previously-corrupted bands (order: '' deletes the key).
  const chromeIds = orderAssignments.filter(a => isTemplateChrome(a.nodeId)).map(a => a.nodeId);
  if (chromeIds.length > 0) {
    orderAssignments = orderAssignments.filter(a => !isTemplateChrome(a.nodeId));
    trace.action('order-commit:template-chrome-excluded', { vpId, chromeIds });
  }
  // OUT-OF-FLOW SIBLINGS: Chrome paints an absolute/fixed child of a flex
  // container as if its `order` were 0, so once a flow sibling gets `order ≥ 1`
  // every overlay that follows it in the DOM drops behind it (the pinned hero
  // vanished under the next section, 2026-09-09). Give those overlays
  // `z-index: 1` (when they have none) — see out-of-flow-order.ts.
  let layering: LayerAssignment[] = [];
  if (orderAssignments.length > 0) {
    // The DRAGGED node's cache entry may still point at its OLD parent (or
    // none, for a canvas node) at commit time — take the parent from the
    // first assignment whose node already lives in a parent that contains
    // another assigned sibling, else the first non-null parent.
    const assignedIds = new Set(orderAssignments.map(a => a.nodeId));
    let parentId: string | null = null;
    for (const a of orderAssignments) {
      const pid = getNodeFromCache(a.nodeId)?.parentId ?? null;
      if (!pid) continue;
      const kids = getNodeFromCache(pid)?.children ?? [];
      if (kids.some(k => k !== a.nodeId && assignedIds.has(k))) { parentId = pid; break; }
      if (parentId === null) parentId = pid;
    }
    const parent = parentId ? getNodeFromCache(parentId) : undefined;
    if (parent?.children?.length) {
      layering = outOfFlowLayeringForOrders(
        orderAssignments,
        parent.children.filter(id => !isTemplateChrome(id)),
        (id) => {
          const pos = (getNodeFromCache(id)?.styles?.position || findNodeComputedStyle(id, vpId, 'position') || '').trim();
          return pos === 'absolute' || pos === 'fixed';
        },
        (id) => getNodeFromCache(id)?.styles?.zIndex,
      );
      if (layering.length) trace.action('order-commit:out-of-flow-layering', { vpId, parentId, layering });
    }
  }
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
    for (const { nodeId, zIndex } of layering) {
      patchNodeStyles(contentEl, nodeId, vpPrefix, { zIndex: String(zIndex) });
      updates.push({ nodeId, type: 'style', styles: { zIndex: String(zIndex) } });
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
      for (const { nodeId, zIndex } of layering) {
        patchNodeStyles(contentEl, nodeId, vpPrefix, { zIndex: String(zIndex) }, true);
        updates.push({ nodeId, type: 'style', styles: { zIndex: String(zIndex) } });
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
      for (const { nodeId, zIndex } of layering) {
        patchNodeStyles(contentEl, nodeId, vpPrefix, { zIndex: String(zIndex) }, true);
        updates.push({ nodeId, type: 'updateContainerStyle', maxWidth: vpWidth, styles: { zIndex: String(zIndex) } });
      }
      // HEAL: delete any chrome `order` a pre-guard reorder wrote into this
      // band ('' = remove-key; no-op when absent). The template merge's own
      // bracket orders then place the chrome correctly again.
      for (const nodeId of chromeIds) {
        updates.push({
          nodeId,
          type: 'updateContainerStyle',
          maxWidth: vpWidth,
          styles: { order: '' },
        });
      }
    }
  }

  trace.action('order-commit:commitOrderAssignments', {
    vpId, isPrimary, branch, count: orderAssignments.length, updates,
  });
  return updates;
}
