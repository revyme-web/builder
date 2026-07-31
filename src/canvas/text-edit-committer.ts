// text-edit-committer.ts — module-level bridge so non-canvas UI (e.g. the
// right-header Play / preview button) can COMMIT an in-progress text-edit
// session before it acts.
//
// Text-edit style changes (color/font/… set while a TipTap session is live)
// only land in the code when the session EXITS. So entering the live preview
// without first committing would read stale code and the preview would miss
// the just-made edits. Canvas registers its async `commitTextEdit`; callers
// `await commitActiveTextEdit()` first. No-op when nothing is being edited.

import { trace } from '@/shared/debug-trace';

let _committer: (() => Promise<void>) | null = null;

/** Canvas registers (and clears on unmount) its commitTextEdit here. */
export function registerTextEditCommitter(fn: (() => Promise<void>) | null): void {
  _committer = fn;
}

/** Commit any in-progress text-edit session (flushing its style edits to code),
 *  then resolve. Safe to call when not editing — resolves immediately. */
export async function commitActiveTextEdit(): Promise<void> {
  if (!_committer) return;
  trace.action('text-edit-committer:commit-active', {});
  await _committer();
}
