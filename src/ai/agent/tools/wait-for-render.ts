// src/ai/agent/tools/wait-for-render.ts
// waitForRender — bounded polling until the canvas rect cache is populated
// for requested nodes in a given viewport. Uses collectLayoutSnapshot
// (design-audit.ts) — the same shared reader the observation tools use.

// Contract (same rules as observationStatus):
//   • unavailable  — viewport id unknown / width null  →  immédiat
//   • ready      — every nodeId that was requested has a non-null rect
//                 (or, if no nodeIds were requested, withRect > 0 globally)
//   • pending    — timeout reached without all rects filling — jamais de throw
//                 / attente infinie.
//   • Poll borné   : attempts = ceil(timeoutMs / intervalMs), break early,
//                 waitedMs mesumé.
//   • P6 (T4)      : the result also carries the epoch + coverage envelope
//                 ({epoch, coverage, unmeasured}) — callers decide freshness;
//                 waitForRender itself only waits for rect FILL.
// Trace: trace.fn('wait-for-render', { vpId, requested, withRect, waitedMs, status, stale })

import { getDefaultStore } from 'jotai';
import {
  collectEpochSnapshot,
  formatEpochEnvelope,
} from './observation-epoch';
import { getNodesSnapshot } from '@/code/stores/store';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { projectFS } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

export interface WaitForRenderResult {
  ready: boolean;
  status: 'ready' | 'pending' | 'unavailable';
  waitedMs: number;
  withRect: number;
  /** P6 (T4) — the epoch + coverage the verdict measured against. */
  epoch: {
    renderSeq: number | null;
    projectVersionAtFill: number | null;
    projectVersionNow: number | null;
    stale: boolean;
  };
  coverage: { withRect: number; total: number };
  unmeasured: string[];
  unmeasuredTotal: number;
}

export interface WaitForRenderOptions {
  nodeIds?: string[];
  vpId: string;
  timeoutMs?: number;
  intervalMs?: number;
  /**
   * P8 (vi): branch the waiter serves. When set to a branch the canvas does
   * not show, no render will ever fill these rects — immediate unavailable
   * (never a bounded wait for nothing). Absent = human active context.
   */
  branchId?: string;
}

export function waitForRender(
  opts: WaitForRenderOptions,
): Promise<WaitForRenderResult> {
  const { nodeIds, vpId, timeoutMs = 1200, intervalMs = 100, branchId } = opts;

  return new Promise<WaitForRenderResult>((resolve) => {
    const store = getDefaultStore();
    const widths = getViewportWidths();
    const vpWidth = widths[vpId];

    // P8 (vi): off-canvas-branch — no render will ever fill these rects.
    if (branchId !== undefined && branchId !== projectFS.getActiveBranchId()) {
      trace.fn('wait-for-render', {
        vpId,
        requested: nodeIds,
        withRect: 0,
        waitedMs: 0,
        status: 'unavailable',
        branch: branchId,
      });
      resolve({
        ready: false,
        status: 'unavailable',
        waitedMs: 0,
        withRect: 0,
        epoch: { renderSeq: null, projectVersionAtFill: null, projectVersionNow: null, stale: false },
        coverage: { withRect: 0, total: 0 },
        unmeasured: [...(nodeIds ?? [])],
        unmeasuredTotal: (nodeIds ?? []).length,
      });
      return;
    }

    // Unavailable: viewport id unknown / width null — immediate.
    if (vpWidth == null) {
      const { epoch } = collectEpochSnapshot(getNodesSnapshot(), vpId);
      const envelope = formatEpochEnvelope(epoch);
      trace.fn('wait-for-render', {
        vpId,
        requested: nodeIds,
        withRect: 0,
        waitedMs: 0,
        status: 'unavailable',
      });
      resolve({
        ready: false,
        status: 'unavailable',
        waitedMs: 0,
        withRect: 0,
        ...envelope,
      });
      return;
    }

    const attempts = Math.ceil(timeoutMs / intervalMs);
    let waitedMs = 0;
    let resolved = false;

    function poll(): void {
      if (resolved) return;
      const { nodes: snapshot, epoch } = collectEpochSnapshot(getNodesSnapshot(), vpId);
      const withRect = epoch.withRect;

      waitedMs += intervalMs;

      const allFilled = nodeIds
        ? nodeIds.every((id) => {
            const node = snapshot.find((n) => n.id === id);
            // Note: `!=` lâche (pas `!==`) — un nœud ABSENT du snapshot
            // (undefined) ne doit jamais compter comme rempli, sinon un id
            // fantôme rendrait ready immédiatement (faux ready).
            return node?.rect != null;
          })
          : withRect > 0;

      if (allFilled) {
        resolved = true;
        trace.fn('wait-for-render', {
          vpId,
          requested: nodeIds,
          withRect,
          waitedMs,
          status: 'ready',
          stale: epoch.stale,
        });
        resolve({
          ready: true,
          status: 'ready',
          waitedMs,
          withRect,
          ...formatEpochEnvelope(epoch),
        });
        return;
      }

      if (waitedMs >= timeoutMs && !resolved) {
        resolved = true;
        trace.fn('wait-for-render', {
          vpId,
          requested: nodeIds,
          withRect,
          waitedMs,
          status: 'pending',
          stale: epoch.stale,
        });
        resolve({
          ready: false,
          status: 'pending',
          waitedMs,
          withRect,
          ...formatEpochEnvelope(epoch),
        });
      } else {
        setTimeout(poll, intervalMs);
      }
    }

    poll();
  });
}
