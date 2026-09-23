// branching/apply.ts — P8 (iv): apply a branch onto main.
//
// Apply = merge (fast-forward when main is untouched since the branch base,
// else 3-way with explicit per-hunk resolutions) + validation pipeline +
// atomic-ish commit + rebase + changelog + one undo entry.
//
// Atomicity: the whole-file gate pre-verifies EVERYTHING (pure); only then
// does anything write. commitTurnFiles is honest (written[]), so a partial
// write is detected and rolled back to the pre-apply main snapshot —
// reported as refused, never a demi-état. Undo is the single history entry
// the commit pushes (main single-stack; per-branch stacks arrive in (vii)).
// Changelog is in-memory + traced (persisted envelope field in (vii) if the
// review flow needs cross-session audit — deliberately not in v2 yet).

import { projectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { gateTurnFiles, commitTurnFiles, type TurnFile } from '@/code/oracle/gate';
import { isBlockingModifyViolation } from '@/code/project/modify-file';
import { isLayoutFile, activeFilePathAtom } from '@/code/project/active-file-store';
import { getDefaultStore } from 'jotai';
import { oracleFileKind } from '@/code/oracle/file-kind';
import { syncImports } from '@/code/mutation/mutation-queue';
import { checkFile, ensureNodeDimensions, type FileKind } from '@/code/oracle/check-file';
import { recordOracleBounce } from '@/code/oracle/telemetry';
import { ensureLayoutRootOnComponentRoot } from '@/code/components/component-ops';
import { applyRuntimeGuarantees } from '@/code/generation/runtime-guarantees';
import { mergeMaps, resolveFileConflicts, type FileConflict, type ConflictChoice } from './merge';
import { syncQueueCode, flushNow, switchQueueFile } from '@/code/mutation/mutation-queue';
import { isBranchLocked, isAgentWriteOpen } from '@/code/stores/agent-run-lock-store';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { clearBridgeReadCaches } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';

export type ApplyStatus = 'applied' | 'conflicts' | 'refused';

export interface ApplyResult {
  status: ApplyStatus;
  /** Files written/deleted on main (applied only). */
  files: string[];
  conflicts: FileConflict[];
  /** Human-readable refusal (refused only). */
  reason?: string;
  changelog: ChangelogEntry;
}

export interface ChangelogEntry {
  at: number;
  branch: string;
  kind: 'apply-fast-forward' | 'apply-merge';
  files: string[];
  conflictsResolved: number;
  status: ApplyStatus;
}

const changelog: ChangelogEntry[] = [];

/** Session changelog (newest last). Memory + trace; envelope field in (vii) if needed. */
export function getChangelog(branchId?: string): ChangelogEntry[] {
  const list = branchId ? changelog.filter((e) => e.branch === branchId) : changelog;
  return [...list];
}

/** Tests + review UI reset. */
export function clearChangelog(): void {
  changelog.length = 0;
}

function recordChangelog(entry: ChangelogEntry): ChangelogEntry {
  changelog.push(entry);
  trace.action('branching-apply:changelog', { ...entry });
  return entry;
}

/** File kind for the gate (TurnFile carries page|component; the gate derives template/code-component internally). */
/** The gate's kind for a file it judges, or null for one it does not
 *  (CMS json, globals.css, server page wrappers, messages, _meta…). Judged as
 *  "page", every one of those bounced PROTECTED_PATH and NO apply of a real
 *  project could ever land (agent suite 2026-09-22). */
function kindFor(path: string, code: string): TurnFile['kind'] | null {
  const kind = oracleFileKind(path, code);
  if (kind === 'component' || kind === 'code-component') return 'component';
  if (kind === 'page' || kind === 'template') return 'page';
  return null;
}

/**
 * After the pointer moved to main: keep the file the user was on when main
 * has it (a page created on the branch lands on home), and re-base the queue
 * on THAT file. The old code re-based on the home page whatever was open — a
 * later edit on any other page would have composed on the wrong source.
 */
function landOnMain(): void {
  const store = getDefaultStore();
  const current = store.get(activeFilePathAtom);
  const landing = current && projectFS.readFile(current) != null ? current : 'app/page.client.tsx';
  store.set(activeFilePathAtom, landing);
  switchQueueFile(landing, { branchId: MAIN_BRANCH_ID });
  syncQueueCode(projectFS.readFile(landing) ?? '');
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Apply branch `branchId` onto main. With `resolutions` (path → per-hunk
 * choices in conflict order), conflicted files resolve; without, any
 * conflict aborts with {status:'conflicts'} and NOTHING writes.
 * `manualContents` (path → hand-edited file) overrides merged content per
 * file — the V1 manual-resolution escape hatch, validated by the same gate
 * below before anything writes.
 */
export function applyBranch(
  branchId: string,
  opts: { resolutions?: Record<string, ConflictChoice[]>; manualContents?: Record<string, string> } = {},
): ApplyResult {
  if (branchId === MAIN_BRANCH_ID) {
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: 'Cannot apply main onto itself.',
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind: 'apply-merge', files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }
  const base = projectFS.readBranchBase(branchId);
  const theirs = projectFS.readBranchFiles(branchId);
  if (!base || !theirs) {
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: `Unknown branch "${branchId}".`,
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind: 'apply-merge', files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }
  const ours = projectFS.readBranchFiles(MAIN_BRANCH_ID) ?? new Map<string, string>();

  // P8-SCOPED-LOCK: never merge a branch with an agent run in flight on it —
  // the run's pending writes would land mid-merge with no owning turn. The
  // run ITSELF may apply (apply_branch, inside its write window, after it
  // flushed): its writes are the ones being merged, and it is the holder.
  if (isBranchLocked(branchId) && !isAgentWriteOpen()) {
    const reason = `Branch "${branchId}" has an agent run in flight — stop it before applying.`;
    trace.error('branching-apply:refused-locked', { branch: branchId });
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason,
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind: 'apply-merge', files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }

  // Settle pending queue work onto the pre-apply state before touching maps.
  // Scoped to main: other branches' queued groups belong to runs in flight
  // and drain through their own scoped flush — a bare flush here would
  // commit them early under the human gate bar.
  // NOTE (port): canvas-poc's queue is not branch-partitioned yet — the
  // scoped drain arrives with the agent's concurrent-run support. One queue
  // means a bare flush drains exactly the pending work this apply must settle.
  flushNow();

  let merged: Map<string, string>;
  let conflicts: FileConflict[] = [];
  let kind: ChangelogEntry['kind'] = 'apply-merge';
  if (mapsEqual(base, ours)) {
    // Fast-forward: main untouched since the branch base — take the branch.
    merged = new Map(theirs);
    kind = 'apply-fast-forward';
    trace.action('branching-apply:fast-forward', { branch: branchId, files: merged.size });
  } else {
    const r = mergeMaps(base, ours, theirs);
    merged = r.merged;
    conflicts = r.conflicts;
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
      return {
        status: 'conflicts',
        files: [],
        conflicts,
        changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'conflicts' }),
      };
    }
    if (conflicts.length > 0) {
      // Resolve per file, in conflict order.
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
          return {
            status: 'conflicts',
            files: [],
            conflicts,
            changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'conflicts' }),
          };
        }
        const rr = resolveFileConflicts(
          base.get(path) ?? null,
          ours.get(path) ?? null,
          theirs.get(path) ?? null,
          { path, choices },
        );
        if ('error' in rr) {
          return {
            status: 'refused',
            files: [],
            conflicts,
            reason: `Resolution failed for ${path}: ${rr.error}`,
            changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'refused' }),
          };
        }
        if (rr.merged === null) merged.delete(path);
        else merged.set(path, rr.merged);
      }
      conflicts = [];
    }
  }

  // No-op short-circuit: merged == main already (re-apply, caught-up
  // branch) — applied with zero writes (no history spam), rebase to clean.
  // Manual contents override merged files first (validated below like the rest).
  if (opts.manualContents) {
    for (const [path, content] of Object.entries(opts.manualContents)) {
      if (typeof content === 'string' && content.length > 0) merged.set(path, content);
    }
  }
  if (mapsEqual(merged, ours)) {
    projectFS.rebaseBranch(branchId, new Map(ours));
    return {
      status: 'applied',
      files: [],
      conflicts: [],
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'applied' }),
    };
  }

  // Validation pipeline: the whole-file gate over what CHANGED against main,
  // for the files the gate judges (pure). Same blocking semantics as any
  // whole-file submit — violations refuse. Plain files (CMS json, css,
  // dictionaries) are carried as they are; unchanged files are not touched.
  const turnFiles: TurnFile[] = [];
  const plain: Array<[string, string]> = [];
  for (const [path, code] of merged) {
    if (ours.get(path) === code) continue;
    const kind = kindFor(path, code);
    if (kind) turnFiles.push({ path, code, kind }); else plain.push([path, code]);
  }
  const gated = gateTurnFiles(turnFiles, null);
  if (gated.violations.length > 0) {
    const codes = [...new Set(gated.violations.map((v) => v.code))].join(', ');
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: `Merged result fails the oracle gate (${codes}) — resolve the underlying conflict differently; nothing was written.`,
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }

  // Commit onto main. Switch the human pointer to main first so every
  // main-bound primitive (gate, commit, queue base, caches) stays coherent —
  // an apply lands the user on main by definition (traced, single gesture).
  // The rollback snapshot is the WHOLE of main — `ours` is the website view
  // (no shared editor state), and loadSnapshot replaces the map outright.
  const preApplyMain = projectFS.readBranchFiles(MAIN_BRANCH_ID, { shared: true }) ?? new Map(ours);
  const switchErr = projectFS.switchBranch(MAIN_BRANCH_ID);
  if (switchErr) {
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: switchErr,
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }
  const written = commitTurnFiles(gated.files);
  for (const [path, code] of plain) { projectFS.writeFile(path, code); written.push(path); }
  const expected = new Set(gated.files.map((f) => f.path));
  const missing = [...expected].filter((p) => !written.includes(p));
  // Deletions (in main, absent from merged): files the merge dropped.
  const deleted: string[] = [];
  for (const p of ours.keys()) {
    if (!merged.has(p)) {
      projectFS.deleteFile(p);
      deleted.push(p);
    }
  }
  if (missing.length > 0) {
    // Partial write: restore pre-apply main (active IS main here) + refuse.
    projectFS.loadSnapshot(preApplyMain);
    landOnMain();
    clearBridgeReadCaches();
    bumpProjectVersion();
    return {
      status: 'refused',
      files: [],
      conflicts: [],
      reason: `Partial apply refused and rolled back (not written: ${missing.join(', ')}).`,
      changelog: recordChangelog({ at: Date.now(), branch: branchId, kind, files: [], conflictsResolved: 0, status: 'refused' }),
    };
  }

  // Post-commit coherence (human is on main with new content).
  landOnMain();
  clearBridgeReadCaches();
  bumpProjectVersion();

  // Post-apply sync: the applied work now lives in main (commit-
  // normalized). The branch adopts post-commit main bytes so its diff
  // empties honestly (nothing left to merge) and the base moves with it.
  // Human-chosen resolutions are IN main — the branch does not keep a
  // parallel vision. Further branch edits diff fresh from here.
  const postMain = projectFS.readBranchFiles(MAIN_BRANCH_ID) ?? new Map<string, string>();
  for (const [path, content] of postMain) {
    if (merged.has(path)) projectFS.writeBranchFile(branchId, path, content);
  }
  for (const path of projectFS.readBranchFiles(branchId)?.keys() ?? []) {
    if (!postMain.has(path)) projectFS.deleteBranchFile(branchId, path);
  }
  const rebaseErr = projectFS.rebaseBranch(branchId, new Map(postMain));
  if (rebaseErr) {
    trace.error('branching-apply:rebase-failed', { branch: branchId, error: rebaseErr });
  }

  projectFS.clearBranchConflicts(branchId);
  const files = [...written, ...deleted];
  return {
    status: 'applied',
    files,
    conflicts: [],
    changelog: recordChangelog({
      at: Date.now(),
      branch: branchId,
      kind,
      files,
      conflictsResolved: 0,
      status: 'applied',
    }),
  };
}

/** Validate merged content without writing (review UI pre-check + tests). */
export function validateMergedFiles(files: Map<string, string>): Array<{ code: string; message: string }> {
  const turnFiles: TurnFile[] = [];
  for (const [path, code] of files) {
    const kind = kindFor(path, code);
    if (kind) turnFiles.push({ path, code, kind });
  }
  const gated = gateTurnFiles(turnFiles, null);
  return gated.violations.map((v) => ({ code: v.code, message: v.message }));
}

/**
 * Branch-scoped whole-file commit — the commitTurnFiles twin for agent runs
 * bound to a branch (P8 (vi)): same normalizers (dimensions, fixed-header
 * layout-scroll, runtime guarantees, import sync on new files), same
 * write-time re-verification with the modify predicate, same honest
 * `written[]` (a path appears only if its bytes really landed in the branch
 * map). Call ONLY after a clean gateTurnFiles with the branch base.
 *
 * Deliberately WITHOUT the human-path side effects: no setForceRender /
 * flushNow / history entry (branch maps drive no canvas and own no undo
 * stack — per-branch history arrives in (vii)), no cursor-portal / form-
 * route materialization (edge: withCursor/data-form on a branch heal at
 * apply time, when the merged files commit through commitTurnFiles).
 * Unknown branch → empty (trace, never throw — the tool reports).
 */
export function commitBranchFiles(branchId: string, files: TurnFile[]): string[] {
  const written: string[] = [];
  if (projectFS.readBranchFiles(branchId) == null) {
    trace.error('branching-commit:unknown-branch', { branchId });
    return written;
  }
  for (const f of files) {
    // Same kind derivation as commitTurnFiles (model-declared kinds are
    // re-derived from the path — a model can't dodge checks by mislabeling).
    const k: FileKind = f.kind === 'component'
      ? (/@controls\s*\{/.test(f.code) ? 'code-component' : 'component')
      : isLayoutFile(f.path) ? 'template' : 'page';
    let code = k === 'code-component' ? f.code : ensureNodeDimensions(f.code);
    if (k === 'component') {
      const fixed = ensureLayoutRootOnComponentRoot(code);
      if (fixed !== code) code = fixed;
    }
    if (k !== 'code-component') {
      const guaranteed = applyRuntimeGuarantees(code);
      if (guaranteed !== code) code = guaranteed;
    }
    const prevCode = projectFS.readBranchFile(branchId, f.path);
    const finalCode = prevCode == null ? syncImports(code) : code;
    // Re-verify the committed form (normalizers are transforms: they must
    // not carry a blocking violation onto the branch). New files judge
    // every node as new (no prior version — same rule as the gate). MODIF-2
    // escape, same as modifyProjectFile: a file that ALREADY carried
    // blocking violations before the transform is not frozen by them — only
    // a transform that INTRODUCES a blocking violation on a clean file
    // bounces.
    const existingDataIds = new Set<string>();
    if (prevCode) for (const m of prevCode.matchAll(/data-id="([^"]+)"/g)) existingDataIds.add(m[1]);
    const freshBlocking = checkFile(finalCode, { kind: k, path: f.path, existingDataIds })
      .filter((v) => isBlockingModifyViolation(v.code));
    let bounces = freshBlocking.length > 0;
    if (bounces && prevCode != null) {
      const beforeBlocking = checkFile(prevCode, { kind: k, path: f.path })
        .filter((v) => isBlockingModifyViolation(v.code));
      if (beforeBlocking.length > 0) bounces = false;
    }
    if (bounces) {
      trace.error('branching-commit:bounced', {
        branch: branchId,
        path: f.path,
        violationCodes: freshBlocking.map((v) => v.code),
      });
      recordOracleBounce();
      continue;
    }
    projectFS.writeBranchFile(branchId, f.path, finalCode);
    if (projectFS.readBranchFile(branchId, f.path) === finalCode) written.push(f.path);
    else trace.error('branching-commit:write-unconfirmed', { branch: branchId, path: f.path });
  }
  trace.action('branching-commit:committed', { branch: branchId, written });
  return written;
}
