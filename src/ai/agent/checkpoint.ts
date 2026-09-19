// src/ai/agent/checkpoint.ts
//
// Turn-scoped ProjectFS checkpoint for agent runs. The first mutating tool of
// a run (via ToolContext.ensureCheckpoint) opens one checkpoint: ProjectFS
// snapshot + history coalescing hold. end() releases the hold and returns
// per-file id diffs; a non-empty diff seals exactly ONE editor undo entry
// (pushHistoryImmediate cancels any debounce that release() scheduled).

import { projectFS } from '@/code/project/project-fs';
import {
  holdHistoryCoalescing,
  pushHistoryImmediate,
  releaseHistoryCoalescing,
  sealPendingHistory,
} from '@/code/mutation/history';
import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';
import type { TurnFileChange, TurnCheckpointHandle } from '@/ai/agent';
import { trace } from '@/shared/debug-trace';

export class TurnCheckpoint implements TurnCheckpointHandle {
  private began = false;
  private before: Map<string, string> | null = null;
  private lastSealed: { before: Map<string, string>; after: Map<string, string> } | null = null;
  /** Branch whose maps this checkpoint snapshots (null = active maps, legacy). */
  private branchId: string | null = null;

  /**
   * Bind the checkpoint to a branch's maps (P8-D1). Reads switch from the
   * active maps to `readBranchFiles(branchId)`; the history push at end()
   * is skipped (branch writes own no history — same rule as the scoped
   * queue drain and commitBranchFiles). Unbound checkpoints behave
   * byte-identically to legacy. Call before begin().
   */
  bindBranch(branchId: string): void {
    this.branchId = branchId;
  }

  /** Snapshot source: branch maps when bound, active maps otherwise. Null
   *  when a bound branch is unknown (deleted mid-run) — end() then reports
   *  no measurable change instead of diffing the wrong maps. */
  private snapshotNow(): Map<string, string> | null {
    if (this.branchId == null) return projectFS.getSnapshot();
    return projectFS.readBranchFiles(this.branchId);
  }

  /** Idempotent within a turn: only the first call snapshots and holds. */
  begin(): void {
    if (this.began) return;
    // D-T2: seal the pending human history FIRST — a debounced human edit
    // still in flight when the run's first mutating tool fires would otherwise
    // fold into this run's diff, and a later revert would erase human work
    // (Porte 5 §10: humain-pending + run, pas de pliage).
    sealPendingHistory();
    this.began = true;
    this.before = this.snapshotNow();
    holdHistoryCoalescing();
  }

  end(): TurnFileChange[] {
    if (!this.began) return [];
    this.began = false;
    const before = this.before;
    const after = this.snapshotNow();
    releaseHistoryCoalescing();
    if (!before || !after) return [];
    const changes = diffTurnChanges(before, after);
    if (changes.length > 0 && this.branchId == null) {
      // Guarantees one undo entry even if the whole-file write path never
      // called pushHistory; the immediate push cancels the debounce that
      // release() may have scheduled, so the run lands as exactly one entry.
      pushHistoryImmediate('');
    }
    this.lastSealed = { before, after };
    return changes;
  }

  /** Whether a checkpoint is currently open (begin called but not yet ended). */
  isActive(): boolean {
    return this.began;
  }

  /**
   * Seal the checkpoint on any terminal path (done/error/timeout/abort).
   * Idempotent — returns [] if not active. Traces the seal reason.
   */
  seal(reason: string): TurnFileChange[] {
    if (!this.began) return [];
    trace.action('checkpoint:seal', { reason });
    return this.end();
  }

  /**
   * Last sealed full snapshots (not just ids) — the undo store restores the
   * complete file contents from them for revert/redo. null until the first
   * end().
   */
  snapshots(): { before: Map<string, string>; after: Map<string, string> } | null {
    return this.lastSealed;
  }
}

/**
 * Flat helper for agent-store terminal paths: seal the checkpoint if active,
 * tracing the terminal reason. Minimal function per ticket (no new layer).
 */
export function sealCheckpoint(checkpoint: TurnCheckpoint, reason: string): TurnFileChange[] {
  return checkpoint.seal(reason);
}

/**
 * Per-file id diffs between two ProjectFS snapshots — the shared shape both
 * the turn checkpoint (end()) and the batch tool's per-bulk diagnostics use.
 * Exported so bulk updates can report created/modified/removed ids per batch.
 */
export function diffTurnChanges(
  before: Map<string, string>,
  after: Map<string, string>,
): TurnFileChange[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: TurnFileChange[] = [];
  // Deterministic order.
  for (const path of [...paths].sort()) {
    if (before.get(path) === after.get(path)) continue;
    changes.push(diffFile(path, before.get(path), after.get(path)));
  }
  return changes;
}

function diffFile(
  path: string,
  beforeCode: string | undefined,
  afterCode: string | undefined,
): TurnFileChange {
  const beforeNodes = parseNodes(beforeCode);
  const afterNodes = parseNodes(afterCode);
  if (beforeNodes === null || afterNodes === null) {
    // A side failed to parse: report the file with empty id sets rather than
    // guessing ids we could not verify.
    return { path, addedIds: [], removedIds: [], changedIds: [] };
  }
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];
  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) addedIds.push(id);
    else if (projection(prev) !== projection(node)) changedIds.push(id);
  }
  for (const id of beforeNodes.keys()) {
    if (!afterNodes.has(id)) removedIds.push(id);
  }
  return { path, addedIds, removedIds, changedIds };
}

function parseNodes(code: string | undefined): Map<string, CanvasNode> | null {
  if (code === undefined) return new Map();
  try {
    const nodes = parseJSXToNodes(code);
    // parseJSXToNodes swallows Babel errors and returns an empty map ("user is
    // typing"); treat an empty parse of non-empty code as a parse failure.
    return nodes.size === 0 && code.trim().length > 0 ? null : nodes;
  } catch {
    return null;
  }
}

function projection(node: CanvasNode): string {
  // JSON.stringify omits optional fields that are undefined.
  return JSON.stringify({
    type: node.type,
    name: node.name,
    parentId: node.parentId,
    children: node.children,
    styles: node.styles,
    attrs: node.attrs,
    textContent: node.textContent,
    styleVariables: node.styleVariables,
    translationKey: node.translationKey,
    attrTranslationKeys: node.attrTranslationKeys,
    afterCSS: node.afterCSS,
  });
}
