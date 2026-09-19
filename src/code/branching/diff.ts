// branching/diff.ts — P8 (ii): grouped diff with coverage + invalidation.
//
// A branch diff is grouped per file (added/removed/changed data-ids, via the
// same pure projection as diffTurnChanges) and each group carries a COVERAGE
// envelope (I5'/I6'): which changed ids have actually been MEASURED. Review
// surfaces must never claim visual-clean on unmeasured nodes — coverage
// defaults to UNMEASURED (honest), callers with a live canvas attach real
// measurements. Pure + testable (no bridge import here by construction).
//
// Deviation note (file layout): the directeur lists model.ts/branch-store.ts
// under src/code/branching/. Branch STATE lives in project-fs.ts instead
// (InMemoryProjectFS owns every map): routing all existing readers through
// the active map required zero reader migration, where a separate store
// would have forced hundreds of call sites branch-aware. Envelope shape,
// lifecycle semantics and the no-new-singleton rule are unchanged.

import { diffTurnChanges } from '@/code/project/file-diff';
import type { TurnFileChange } from '@/code/project/file-diff';
import { simpleHash } from '@/shared/hash-utils';
import { trace } from '@/shared/debug-trace';

/** Coverage of one file group: measured ids vs unmeasured (never silently clean). */
export interface DiffCoverage {
  total: number;
  measured: number;
  /** Changed ids with no measurement (capped by the producer). */
  unmeasured: string[];
  /** True when the measurement predates the diffed state. */
  stale: boolean;
}

/** One file group of a branch diff. */
export interface GroupedFileDiff {
  path: string;
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
  coverage: DiffCoverage;
}

/** All-changed ids of a group (union, de-duplicated, stable order). */
export function groupChangedIds(group: Pick<GroupedFileDiff, 'addedIds' | 'removedIds' | 'changedIds'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...group.addedIds, ...group.removedIds, ...group.changedIds]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The honest default: nothing measured (headless, no canvas, no claim). */
export function unmeasuredCoverage(change: TurnFileChange): DiffCoverage {
  const total = change.addedIds.length + change.removedIds.length + change.changedIds.length;
  return {
    total,
    measured: 0,
    unmeasured: [...change.addedIds, ...change.removedIds, ...change.changedIds],
    stale: false,
  };
}

/**
 * Grouped diff of two file maps (usually branch.baseSnapshot → branch.files).
 * Pure: node-id projection via diffTurnChanges, coverage UNMEASURED unless
 * `measured` is provided (ids measured on a fresh epoch + stale flag).
 */
export function groupDiff(
  before: Map<string, string>,
  after: Map<string, string>,
  measured?: { ids: Set<string>; stale: boolean },
): GroupedFileDiff[] {
  const changes = diffTurnChanges(before, after);
  return changes.map((c) => {
    if (!measured) {
      return { path: c.path, addedIds: c.addedIds, removedIds: c.removedIds, changedIds: c.changedIds, coverage: unmeasuredCoverage(c) };
    }
    const all = [...c.addedIds, ...c.removedIds, ...c.changedIds];
    const unmeasured = all.filter((id) => !measured.ids.has(id));
    return {
      path: c.path,
      addedIds: c.addedIds,
      removedIds: c.removedIds,
      changedIds: c.changedIds,
      coverage: { total: all.length, measured: all.length - unmeasured.length, unmeasured, stale: measured.stale },
    };
  });
}

/** Content hash of a file map (cache keys). */
export function hashFiles(files: Map<string, string>): string {
  const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return simpleHash(entries.map(([k, v]) => `${k}\n${v}`).join('\n'));
}

export interface DiffCache {
  get(branchId: string, base: Map<string, string>, target: Map<string, string>, compute: () => GroupedFileDiff[]): GroupedFileDiff[];
  invalidate(branchId?: string): void;
}

/**
 * Invalidation cache for grouped diffs (P8 §10: "diff groupé + cache
 * d'invalidation"). Keyed by (branchId, baseHash, targetHash); any content
 * change misses naturally. invalidate(branchId) drops one branch (call after
 * merge/apply/commit on it); invalidate() drops everything (file switch).
 */
export function createDiffCache(): DiffCache {
  const cache = new Map<string, GroupedFileDiff[]>();
  const keyFor = (branchId: string, base: Map<string, string>, target: Map<string, string>): string =>
    `${branchId}\0${hashFiles(base)}\0${hashFiles(target)}`;
  return {
    get(branchId, base, target, compute) {
      const key = keyFor(branchId, base, target);
      const hit = cache.get(key);
      if (hit) {
        trace.fn('branching-diff:cache-hit', { branchId });
        return hit;
      }
      const value = compute();
      cache.set(key, value);
      trace.fn('branching-diff:cache-miss', { branchId, groups: value.length });
      return value;
    },
    invalidate(branchId?: string) {
      if (branchId === undefined) {
        cache.clear();
        return;
      }
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${branchId}\0`)) cache.delete(key);
      }
    },
  };
}
