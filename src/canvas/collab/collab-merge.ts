// collab-merge.ts — Rebase this client's unsent edits onto a collaborator's
// write to the same file.
//
// Reuses the branching 3-way merge (diff3, imports union, parse-validated —
// code/branching/merge.ts). Live collaboration can't stop and ask, so every
// conflict resolves to OURS: both sides touched the same lines (two people
// moved the same element), and the local edit is the one being replayed on
// top — the same "last to commit wins" the room had before, except now every
// client lands on the same result. If even that can't produce a parseable
// file, keep our whole file: the next send carries it, so the room still
// converges (it just drops the collaborator's edit to this file).

import { mergeFile, resolveFileConflicts } from '@/code/branching/merge';
import { trace } from '@/shared/debug-trace';

export function rebaseLocalEdits(
  path: string,
  base: string | null,
  ours: string,
  theirs: string,
): string {
  const r = mergeFile(base, ours, theirs, { path });
  if (r.status === 'clean') return r.merged ?? ours;
  const resolved = resolveFileConflicts(base, ours, theirs, {
    path,
    choices: r.conflicts.map(() => 'ours' as const),
  });
  if ('merged' in resolved && resolved.merged !== null) {
    trace.action('collab:rebase-conflicts-ours', { path, conflicts: r.conflicts.length, kinds: r.conflicts.map((c) => c.kind) });
    return resolved.merged;
  }
  trace.error('collab:rebase-unresolvable', { path, error: 'error' in resolved ? resolved.error : 'deleted' });
  return ours;
}
