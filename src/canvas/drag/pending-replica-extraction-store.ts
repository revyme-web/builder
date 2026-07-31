// pending-replica-extraction-store.ts — Module-level registry that
// tracks a snapshot of the source's pre-exit state during a multi-vp
// replica drag.
//
// During a page-replica drag of a multi-vp-visible element, the source
// JSX moves globally to canvas-root at exit (so every viewport renders
// the unparenting live, matching the user's "synced during drag" rule).
// If the user ends the drag on FREE CANVAS the intent flips: they wanted
// to REMOVE this element from THIS replica only — every other viewport
// should snap back to the source's original parent + position, while a
// fresh canvas clone takes the dragged element's place on the source vp.
//
// This store keeps the data we need on canvas-drop to perform that
// revert: original parent + index + base styles + @container overrides.
// The exit mutation chain (`clearContainerStyles` + `move`) is destructive
// on the JSX — we cannot recover those values from `context.nodes` later
// because the upcoming flush will overwrite them.
//
// CanvasDragStrategy.onEnd reads this on canvas-drop and queues the
// revert + clone mutations. Both onEnds clear the entry on parent-drop
// (the synced unparent makes the snapshot moot).

import { trace } from '@/shared/debug-trace';

export interface PendingReplicaExtraction {
  /** Viewport the drag started in — used for `@container display:'none'`
   *  on the source post-revert and to scope the clone's visibility. */
  sourceVpId: string;
  /** Source's parent id at drag start — where to move the source back
   *  to on canvas-drop. Null means the source was already a top-level
   *  canvas node (no revert needed, but we still register for trace
   *  consistency). */
  originalParentId: string | null;
  /** Sibling index within `originalParentId` at drag start. The move
   *  mutation accepts an `index` to slot the source back in place. */
  originalIndex: number;
  /** Snapshot of the source's base inline styles before the exit
   *  cleared / overwrote them. Used to restore left/top/width/etc on
   *  revert. */
  originalStyles: Record<string, string>;
  /** Snapshot of every per-vp `@container` rule on the source at drag
   *  start, keyed by max-width. The exit calls `clearContainerStyles`
   *  which wipes ALL of them, so without this snapshot the revert
   *  silently loses the user's responsive overrides. Inner map keys
   *  are CSS property names, values are CSS values. */
  originalContainerOverrides: Map<number, Map<string, string>>;
}

const pending = new Map<string, PendingReplicaExtraction>();

export function registerPendingReplicaExtraction(sourceId: string, info: PendingReplicaExtraction): void {
  pending.set(sourceId, info);
  trace.action('pending-replica-extraction:register', {
    sourceId,
    sourceVpId: info.sourceVpId,
    originalParentId: info.originalParentId,
    originalIndex: info.originalIndex,
    styleKeys: Object.keys(info.originalStyles),
    overrideVpCount: info.originalContainerOverrides.size,
  });
}

export function getPendingReplicaExtraction(sourceId: string): PendingReplicaExtraction | null {
  return pending.get(sourceId) ?? null;
}

export function clearPendingReplicaExtraction(sourceId: string): void {
  if (pending.delete(sourceId)) {
    trace.action('pending-replica-extraction:clear', { sourceId });
  }
}
