// agent-run-lock-store.ts — P8-SCOPED-LOCK (ex-TEMP-P1 global lock, levé Porte 8 (vii)).
//
// Phase-2 concurrency (D-T5 inter-branches): an agent run locks ITS branch,
// not the world. Human truth lives on the ACTIVE branch; queue entries carry
// {author,file,branchId} and drain partitioned (Porte 8 (i-b)) — so a human
// editing an UNLOCKED branch can never interleave with a run on another branch:
//
//   - the run locks its branch for its whole duration (markRunning … finally);
//   - queueMutation/queueMutations refuse non-window writes whose ENTRY branch
//     is locked (same gate shape as viewer mode, traced `canvas-busy`);
//   - human gates (panels, drag, undo/redo, revert, file switch) key on the
//     ACTIVE branch — inert only when the human sits on a locked branch;
//   - unbranched runs lock the active branch at start (same-as-global behavior);
//   - the agent's own writes run inside agent-write windows and always pass.
//
// NOT a Jotai atom on purpose (same rationale as viewer-mode-store: the
// mutation queue runs in non-React contexts where `getDefaultStore()`
// returns the wrong store). Module-level state + `useSyncExternalStore`
// keeps reads consistent everywhere. Engine-owned: `src/code/*` never
// imports `src/ai/*` — the agent sets the lock, the engine enforces it.

import { useSyncExternalStore } from 'react';
import { projectFS } from '@/code/project/project-fs';
import { registerAgentEditingSource } from './viewer-mode-store';
import { trace } from '@/shared/debug-trace';

/** Locked branches with in-flight agent runs (refcounted — overlapping runs
 *  on one branch deepen instead of toggling; every lockBranch needs its
 *  unlockBranch, released in the run's terminal `finally`). */
const lockedBranches = new Map<string, number>();
/** Cached snapshot for useLockedBranches: useSyncExternalStore requires a
 *  STABLE getSnapshot reference between mutations (a fresh array per call
 *  re-renders infinitely). Refreshed on every lock transition. */
let lockedSnapshot: string[] = [];
/**
 * Whether the run currently holding a lock addresses explicit scopes
 * (branched run: file+branchId per mutation, queue base untouched) rather
 * than the legacy shared queue base (unbranched run on the active branch).
 * Decides narrowly-scoped navigation gates (branch/file switches on a
 * locked branch): a scoped holder never reads the human queue base, so
 * moving the human pointer cannot misfile its writes; a legacy holder
 * does, so the pointer must stay put. Fail-closed default (false):
 * unknown holders are treated as legacy. Set ONLY by the run lifecycle
 * alongside lockBranch (markRunning), cleared on every release path.
 */
let lockHolderScoped = false;
/** Re-entrant depth of agent tool-execution windows (see below). */
let _agentWriteDepth = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * Lock a branch for the duration of an agent run. Called by the run
 * lifecycle only (`runAgentTurn` — set in `markRunning`, cleared in the
 * terminal `finally`). Idempotent per branch only in the refcount sense —
 * pair every call with `unlockBranch`.
 */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function lockBranch(branchId: string): void {
  lockedBranches.set(branchId, (lockedBranches.get(branchId) ?? 0) + 1);
  lockedSnapshot = [...lockedBranches.keys()];
  trace.action('agent-lock:branch-locked', { branch: branchId, depth: lockedBranches.get(branchId) });
  emit();
}

/** Release one hold on a branch (never below zero — an unmatched release is
 *  traced, never a negative count). */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function unlockBranch(branchId: string): void {
  const depth = lockedBranches.get(branchId) ?? 0;
  if (depth <= 1) lockedBranches.delete(branchId);
  else lockedBranches.set(branchId, depth - 1);
  lockedSnapshot = [...lockedBranches.keys()];
  trace.action('agent-lock:branch-unlocked', { branch: branchId });
  emit();
}

/** True while an agent run holds `branchId` (its writes land there). */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function isBranchLocked(branchId: string): boolean {
  return lockedBranches.has(branchId);
}

/** Branches with in-flight agent runs (banner + review UI). Stable snapshot
 *  array — safe as a useSyncExternalStore getSnapshot. */
export function getLockedBranches(): string[] {
  return lockedSnapshot;
}

/** True while ANY agent run holds a lock (run-in-flight checks). */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function isHumanWritesLocked(): boolean {
  return lockedBranches.size > 0;
}

/**
 * Throw unless a human write may land now (visit locked-branch backstop for
 * direct-write paths OUTSIDE the queue — plugin SDK, file editors, settings
 * cleanups — which have no panel fieldset to inert them). Agent-write
 * windows pass; a locked active branch throws an actionable error (never
 * silent). Read-only helper: lock mechanics untouched. Queue / modify /
 * commit paths keep their own shaped refusals and must NOT call this.
 */
// P8-SCOPED-LOCK (visit locked-branch, additive reader)
export function throwIfLockedForHumanWrite(caller: string): void {
  if (!isAgentWriteOpen() && isActiveBranchLocked()) {
    trace.action('agent-lock:refused-canvas-busy', { caller, branch: projectFS.getActiveBranchId() });
    throw new Error(
      `Cannot write while an agent run holds branch "${projectFS.getActiveBranchId()}" — stop the run first.`,
    );
  }
}

/** True while an agent run holds the ACTIVE (human) branch — the single
 *  predicate every human gate keys on. */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function isActiveBranchLocked(): boolean {
  // No lock → no FS read. This sits under `isViewerMode()`, which hot paths
  // (updateNodeStyles, every queued mutation) call; with no run in flight
  // it must cost nothing — and must not touch a ProjectFS that a unit test
  // mocked down to `readFile`.
  if (lockedBranches.size === 0) return false;
  return lockedBranches.has(projectFS.getActiveBranchId());
}

/**
 * THE CANVAS IS BUSY: an agent run holds the branch the human is looking
 * at, and this is not the run's own write window. Every human editing
 * surface keys on this — panels go read-only (fieldset), drags / resizes /
 * creator tools / rename don't start, undo/redo, modifyProjectFile and page
 * switches are refused — so nothing the human does can interleave with the
 * run's queued mutations and checkpoints. A run on ANOTHER branch leaves
 * this branch fully editable. See `edit-lock.ts` for the combined
 * viewer-or-busy predicate the surfaces import.
 */
export function isCanvasBusy(): boolean {
  return isActiveBranchLocked() && !isAgentWriteOpen();
}

/**
 * True when the current lock holder addresses explicit scopes (branched
 * run — see lockHolderScoped). Navigation gates use it to tell a safe
 * pointer move (holder independent of the shared queue base) from the
 * legacy case (unbranched holder reads the base — pointer must stay put).
 */
// P8-SCOPED-LOCK (visit locked-branch, additive reader — lock mechanics untouched)
export function isLockHolderScoped(): boolean {
  return lockHolderScoped;
}

/** Record holder kind alongside lockBranch (run lifecycle only). */
export function setLockHolderScoped(scoped: boolean): void {
  lockHolderScoped = scoped;
  trace.action('agent-lock:holder-scoped', { scoped });
  emit();
}

/**
 * Open an agent-write window around `fn` (sync). Re-entrant: nested tool
 * executions (batch) deepen the counter instead of toggling a boolean.
 * Queue writes inside the window are the run's own — never refused.
 */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function withAgentWriteAccess<T>(fn: () => T): T {
  _agentWriteDepth += 1;
  try {
    return fn();
  } finally {
    _agentWriteDepth -= 1;
  }
}

/**
 * Open an agent-write window around an async `fn`. The window stays open
 * across awaits: a human gesture landing exactly during an await is let
 * through on an unlocked branch (the lock is per-branch now, so the hole
 * the global flag had is closed by construction — a gesture can only land
 * where no run holds the branch). Never throws beyond `fn` itself.
 */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export async function withAgentWriteAccessAsync<T>(fn: () => Promise<T>): Promise<T> {
  _agentWriteDepth += 1;
  try {
    return await fn();
  } finally {
    _agentWriteDepth -= 1;
  }
}

/** True inside an agent tool-execution window (the run's own writes). */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function isAgentWriteOpen(): boolean {
  return _agentWriteDepth > 0;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook — reactive read of the locked branches. Use for banner + review UI. */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function useLockedBranches(): string[] {
  return useSyncExternalStore(subscribe, getLockedBranches, getLockedBranches);
}

/** React hook — reactive read of the active-branch lock. Use for panels + banner. */
// P8-SCOPED-LOCK (ex-TEMP-P1, levé Porte 8 (vii))
export function useActiveBranchLocked(): boolean {
  return useSyncExternalStore(subscribe, isActiveBranchLocked, isActiveBranchLocked);
}

/** React hook — reactive read of the active branch id (banner + indicator).
 *  projectFS notifies on branch lifecycle + switch, so the id stays fresh. */
export function useActiveBranchId(): string {
  return useSyncExternalStore(
    (cb) => projectFS.subscribe(cb),
    () => projectFS.getActiveBranchId(),
    () => projectFS.getActiveBranchId(),
  );
}

// The run lock IS a viewer-mode reason (`'agent'`): every surface that goes
// read-only for a viewer or offline goes read-only while a run holds the
// branch the user is on — one mechanism, not a second one. Registered here
// because this store knows the active branch and the write window; the
// viewer store stays a leaf. Lock transitions re-emit its listeners.
registerAgentEditingSource({ busy: isCanvasBusy, locked: isActiveBranchLocked }, subscribe);
