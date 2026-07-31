// consolidation-clone-store.ts — Module-level registry for "consolidation clones".
//
// When `AbsoluteInFrameStrategy` detects a multi-vp visible drag-out from a
// non-primary replica, it creates a CLONE at canvas root that the user
// visually drags around. The SOURCE JSX node stays in place (so primary +
// other replicas keep rendering it). On mouseup, `CanvasDragStrategy.onEnd`
// looks up this registry to know:
//   - which dragged id is a consolidation clone (vs. a "real" canvas node
//     that was always at canvas root)
//   - the source node id to actually mutate (move/remove)
//   - the source viewport id (for the `@media display:none` write on
//     canvas-drop)
//
// The clone itself is removed at consolidation time; the registered entry is
// the bridge between the two strategies (no shared state via DragContext).

import { trace } from '@/shared/debug-trace';

export interface ConsolidationInfo {
  /** Original node id whose subtree was cloned. Mutations on mouseup target this. */
  sourceId: string;
  /** Viewport the drag started in — used to write `@media display:none`
   *  if the user drops the clone on canvas free space. */
  sourceVpId: string;
  /** Source's parent id at drag start — for "drop on canvas" we don't
   *  need it, but trace logging keeps it for diagnostics. */
  sourceParentId: string | null;
  /** When true, the strategy already wrote `@container display:'none'`
   *  on `sourceVpId` to hide the source's duplicate render during drag.
   *  CanvasDragStrategy.onEnd uses this to decide whether to revert
   *  the hide on parent-drop (revert) vs. keep it on canvas-drop. */
  sourceVpHidden?: boolean;
}

const pending = new Map<string, ConsolidationInfo>();

export function getConsolidationClone(cloneId: string): ConsolidationInfo | null {
  return pending.get(cloneId) ?? null;
}

export function clearConsolidationClone(cloneId: string): void {
  if (pending.delete(cloneId)) {
    trace.action('consolidation-clone:clear', { cloneId });
  }
}
