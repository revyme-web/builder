// src/ai/agent/tools/observation-epoch.ts
//
// P6 (T4) — époque + couverture des observations canvas.
//
// Every agent observation (get_layout / get_visuals / audit_design /
// get_composition / batch audit / waitForRender) is served from the bridge's
// sync caches, which fill ASYNCHRONOUSLY after each render. Before P6 a
// `ready` verdict only meant "at least one rect cached" — a partial snapshot
// (2/10 nodes measured) reported `ready` + "No violations detected.", and a
// snapshot measured BEFORE the last mutation reported `ready` too.
//
// The honest envelope every observation now carries:
//
//   epoch:    { renderSeq, projectVersionAtFill, projectVersionNow, stale }
//   coverage: { withRect, total }
//   unmeasured: [ids…]            // capped, with unmeasuredTotal for the rest
//
// `ready` requires ALL THREE: viewport known + 100 % coverage + epoch fresh
// (fill version == current version). Anything else is `pending` (re-render
// in flight — retry) or `unavailable` (unknown viewport — fix the argument)
// with a reason that says which. `stale` is true when the project moved
// since the measurement; the caches refill on the next allRects.

import type { CanvasNode } from '@/code/parsing/parser';
import { getCanvasBridge, readProjectVersion, type CacheEpoch } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';
import { collectLayoutSnapshot, type AuditNode } from './design-audit';

/** Observation lifecycle — the single status dialect every read tool speaks. */
export type ObservationStatus = 'ready' | 'pending' | 'unavailable' | 'error';

/** Max node ids listed in `unmeasured` — the tail is counted, not dropped. */
export const UNMEASURED_CAP = 20;

/** Which cache generation an observation measured against + its coverage. */
export interface ObservationEpoch {
  /** Bridge render sequence the caches were filled against (null = unknown). */
  renderSeq: number | null;
  /** Project version at fill time (null = unknowable — no reader/epoch). */
  projectVersionAtFill: number | null;
  /** Project version when the observation was taken (null = unknowable). */
  projectVersionNow: number | null;
  /** True when the measurement predates the current project state. */
  stale: boolean;
  /** Nodes with a cached rect. */
  withRect: number;
  /** Nodes in the snapshot. */
  total: number;
  /** Ids without a cached rect (capped at UNMEASURED_CAP). */
  unmeasured: string[];
  /** Full count of unmeasured ids (≥ unmeasured.length). */
  unmeasuredTotal: number;
}

/** Snapshot + the epoch it was measured against — one call, no double read. */
export interface EpochSnapshot {
  nodes: AuditNode[];
  epoch: ObservationEpoch;
}

/**
 * The shared epoch-stamped reader: walk the node map through the bridge
 * caches (same `collectLayoutSnapshot` every observation uses) and stamp
 * the result with the bridge's fill epoch + the current project version.
 * Never throws: a missing bridge is a best-effort pass of null rects.
 */
export function collectEpochSnapshot(
  nodes: Map<string, CanvasNode>,
  vpId: string,
): EpochSnapshot {
  const snap = collectLayoutSnapshot(nodes, vpId);
  let cacheEpoch: CacheEpoch | null = null;
  try {
    cacheEpoch = getCanvasBridge().getCacheEpoch?.() ?? null;
  } catch {
    cacheEpoch = null;
  }
  const now = readProjectVersion();
  const withRect = snap.filter((n) => n.rect !== null).length;
  const unmeasuredAll = snap.filter((n) => n.rect === null).map((n) => n.id);
  const atFill = cacheEpoch?.projectVersion ?? null;
  // Nothing measured → pending covers it; stale is about a measurement that
  // predates the project, so it only applies when something WAS measured.
  // An exposed epoch with an unknowable version is unprovable → stale.
  const stale =
    withRect > 0 &&
    (cacheEpoch === null || atFill === null || now === null || atFill !== now);
  const epoch: ObservationEpoch = {
    renderSeq: cacheEpoch?.renderSeq ?? null,
    projectVersionAtFill: atFill,
    projectVersionNow: now,
    stale,
    withRect,
    total: snap.length,
    unmeasured: unmeasuredAll.slice(0, UNMEASURED_CAP),
    unmeasuredTotal: unmeasuredAll.length,
  };
  trace.fn('observation-epoch:collect', {
    vpId,
    withRect,
    total: snap.length,
    stale,
    renderSeq: epoch.renderSeq,
    atFill,
    now,
  });
  return { nodes: snap, epoch };
}

/** Serialize the epoch for a tool output — the stable `{epoch, coverage,
 *  unmeasured}` envelope every observation carries. */
export function formatEpochEnvelope(epoch: ObservationEpoch): {
  epoch: {
    renderSeq: number | null;
    projectVersionAtFill: number | null;
    projectVersionNow: number | null;
    stale: boolean;
  };
  coverage: { withRect: number; total: number };
  unmeasured: string[];
  unmeasuredTotal: number;
} {
  return {
    epoch: {
      renderSeq: epoch.renderSeq,
      projectVersionAtFill: epoch.projectVersionAtFill,
      projectVersionNow: epoch.projectVersionNow,
      stale: epoch.stale,
    },
    coverage: { withRect: epoch.withRect, total: epoch.total },
    unmeasured: [...epoch.unmeasured],
    unmeasuredTotal: epoch.unmeasuredTotal,
  };
}

/** One-line UNMEASURED mention for reasons/summaries — empty when full. */
export function formatUnmeasured(epoch: ObservationEpoch): string {
  if (epoch.unmeasuredTotal === 0) return '';
  const extra =
    epoch.unmeasuredTotal > epoch.unmeasured.length
      ? ` (+${epoch.unmeasuredTotal - epoch.unmeasured.length} more)`
      : '';
  return ` UNMEASURED: [${epoch.unmeasured.join(', ')}]${extra}.`;
}

/**
 * The P6 observation contract: `ready` requires a known viewport, a
 * non-empty snapshot, 100 % rect coverage AND a fresh epoch. Partial or
 * stale measurements are `pending` (the canvas is mid-render or changed
 * under the measurement — wait, then call again), never `ready`.
 */
export function observationStatusWithEpoch(
  vp: { id: string; width: number | null },
  epoch: ObservationEpoch,
): { status: ObservationStatus; reason: string } {
  if (vp.width === null) {
    return {
      status: 'unavailable',
      reason: `Unknown viewport id "${vp.id}" — no width match. Pass 'desktop' | 'tablet' | 'mobile' | a custom viewport id, or a width in px.`,
    };
  }
  if (epoch.total === 0 || epoch.withRect === 0) {
    return {
      status: 'pending',
      reason: 'No rects cached yet — the canvas may be mid-render; wait a moment and call again.',
    };
  }
  if (epoch.stale) {
    return {
      status: 'pending',
      reason:
        `Stale: the project changed since this measurement (fill v${epoch.projectVersionAtFill ?? '?'} → now v${epoch.projectVersionNow ?? '?'}) — wait for the re-render, then call again.` +
        formatUnmeasured(epoch),
    };
  }
  if (epoch.withRect < epoch.total) {
    return {
      status: 'pending',
      reason:
        `Not measured: ${epoch.withRect}/${epoch.total} nodes checked — the canvas is still rendering; wait a moment and call again.` +
        formatUnmeasured(epoch),
    };
  }
  return { status: 'ready', reason: 'Measured from the live canvas cache (full coverage, fresh epoch).' };
}
