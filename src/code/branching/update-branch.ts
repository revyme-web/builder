// branching/update-branch.ts — P8-UX: "Update from main" (V1 property,
// V2 engine, new code — NOT V1's sync.ts restored).
//
// A branch forked earlier drifts when main moves: the fork-relative diff
// hides it (same display finding as the V1 divergence audit). This flow
// pulls main into the branch explicitly (human gesture, never automatic):
// 3-way merge (base = branch base, ours = branch files, theirs = main),
// validate, write merged maps into the branch, rebase the fork point.
// Conflicts (or a gate failure) write NOTHING and are recorded for the
// review UI — same honesty contract as applyBranch, opposite direction.

import { projectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import {
  mergeFile,
  resolveFileConflicts,
  type ConflictChoice,
  type FileConflict,
} from './merge';
import { validateMergedFiles } from './apply';
import { isBranchLocked } from '@/code/stores/agent-run-lock-store';
import { trace } from '@/shared/debug-trace';

export type UpdateStatus = 'updated' | 'conflicts' | 'uptodate' | 'refused';

export interface UpdateResult {
  status: UpdateStatus;
  /** Branch files written (updated only). */
  files: string[];
  conflicts: FileConflict[];
  reason?: string;
}

/** Parent drift since the fork: files where main differs from the base.
 *  Empty = the branch fork point is current ("up to date"). Pure read. */
export function getBranchDrift(branchId: string): { moved: boolean; changedPaths: string[] } {
  const base = projectFS.readBranchBase(branchId);
  const main = projectFS.readBranchFiles(MAIN_BRANCH_ID);
  if (!base || !main) return { moved: false, changedPaths: [] };
  const changedPaths: string[] = [];
  for (const path of new Set([...base.keys(), ...main.keys()])) {
    if (base.get(path) !== main.get(path)) changedPaths.push(path);
  }
  return { moved: changedPaths.length > 0, changedPaths: changedPaths.sort() };
}

/**
 * Pull main into `branchId` (explicit human gesture). With `resolutions`
 * (path → per-hunk 'ours'|'theirs' in conflict order), conflicted files
 * resolve; without, any conflict records + writes nothing. `manualContents`
 * (path → hand-edited file) overrides merged content, gate-validated like
 * the rest. On a clean merge the fork point advances (rebase) so the next
 * diff is relative to the new base. Refuses main/unknown/locked branches
 * and gate failures.
 */
export function updateBranchFromMain(
  branchId: string,
  opts: { resolutions?: Record<string, ConflictChoice[]>; manualContents?: Record<string, string> } = {},
): UpdateResult {
  if (branchId === MAIN_BRANCH_ID) {
    return { status: 'refused', files: [], conflicts: [], reason: 'Main is not updated from itself.' };
  }
  const base = projectFS.readBranchBase(branchId);
  const branchFiles = projectFS.readBranchFiles(branchId);
  if (!base || !branchFiles) {
    return { status: 'refused', files: [], conflicts: [], reason: `Unknown branch "${branchId}".` };
  }
  if (isBranchLocked(branchId)) {
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: `Branch "${branchId}" has an agent run in flight — stop it before updating.`,
    };
  }
  const main = projectFS.readBranchFiles(MAIN_BRANCH_ID) ?? new Map<string, string>();

  const merged = new Map<string, string>();
  let conflicts: FileConflict[] = [];
  for (const path of new Set([...base.keys(), ...branchFiles.keys(), ...main.keys()])) {
    const r = mergeFile(
      base.has(path) ? (base.get(path) as string) : null,
      branchFiles.has(path) ? (branchFiles.get(path) as string) : null,
      main.has(path) ? (main.get(path) as string) : null,
      { path },
    );
    if (r.status === 'clean') {
      if (r.merged !== null) merged.set(path, r.merged);
    } else {
      conflicts.push(...r.conflicts);
    }
  }

  const manualPaths = new Set(
    Object.entries(opts.manualContents ?? {})
      .filter(([, content]) => typeof content === 'string' && content.length > 0)
      .map(([path]) => path),
  );
  const conflictedPaths = new Set(conflicts.map((c) => c.path));
  const manualCoversAll = conflicts.length > 0 && [...conflictedPaths].every((p) => manualPaths.has(p));

  if (conflicts.length > 0 && !opts.resolutions && !manualCoversAll) {
    projectFS.setBranchStatus(branchId, 'conflict');
    projectFS.setBranchConflicts(branchId, conflicts);
    trace.action('branching-update:conflicts', { branch: branchId, count: conflicts.length });
    return { status: 'conflicts', files: [], conflicts };
  }
  if (conflicts.length > 0) {
    const byPath = new Map<string, FileConflict[]>();
    for (const c of conflicts) {
      if (!byPath.has(c.path)) byPath.set(c.path, []);
      byPath.get(c.path)!.push(c);
    }
    for (const [path, list] of byPath) {
      // Hand-edited version supersedes: validated + committed below.
      if (opts.manualContents?.[path]) continue;
      const choices = opts.resolutions?.[path];
      if (!choices || choices.length < list.length) {
        projectFS.setBranchStatus(branchId, 'conflict');
        projectFS.setBranchConflicts(branchId, conflicts);
        return { status: 'conflicts', files: [], conflicts };
      }
      const rr = resolveFileConflicts(
        base.get(path) ?? null,
        branchFiles.get(path) ?? null,
        main.get(path) ?? null,
        { path, choices },
      );
      if ('error' in rr) {
        return { status: 'refused', files: [], conflicts, reason: `Resolution failed for ${path}: ${rr.error}` };
      }
      if (rr.merged === null) merged.delete(path);
      else merged.set(path, rr.merged);
    }
    conflicts = [];
  }

  // Up to date: merged equals the branch already — rebase to clean, no writes.
  let same = merged.size === branchFiles.size;
  if (same) {
    for (const [p, c] of merged) {
      if (branchFiles.get(p) !== c) { same = false; break; }
    }
  }
  if (same) {
    projectFS.rebaseBranch(branchId, new Map(main));
    projectFS.clearBranchConflicts(branchId);
    trace.action('branching-update:uptodate', { branch: branchId });
    return { status: 'uptodate', files: [], conflicts: [] };
  }

  // Validate merged content before touching branch maps (same gate as apply).
  if (opts.manualContents) {
    for (const [path, content] of Object.entries(opts.manualContents)) {
      if (typeof content === 'string' && content.length > 0) merged.set(path, content);
    }
  }
  const violations = validateMergedFiles(merged);
  if (violations.length > 0) {
    const reason = `Merged result fails the oracle gate (${violations.map((v) => v.code).join(', ')}) — resolve the underlying conflict differently; nothing was written.`;
    trace.error('branching-update:gate-refused', { branch: branchId, codes: violations.map((v) => v.code) });
    return { status: 'refused', files: [], conflicts, reason };
  }

  const written: string[] = [];
  for (const [path, content] of merged) {
    if (branchFiles.get(path) !== content) {
      projectFS.writeBranchFile(branchId, path, content);
      written.push(path);
    }
  }
  for (const path of branchFiles.keys()) {
    if (!merged.has(path)) {
      projectFS.deleteBranchFile(branchId, path);
      written.push(path);
    }
  }
  projectFS.rebaseBranch(branchId, new Map(main));
  projectFS.clearBranchConflicts(branchId);
  trace.action('branching-update:updated', { branch: branchId, files: written.length });
  return { status: 'updated', files: written.sort(), conflicts: [] };
}
