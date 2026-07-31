// camera-stash.ts — Per-file camera transform memory.
//
// When the user enters a master file (component / icon-set
// master) from a page, we want the breadcrumb's "back to page"
// button to put the camera EXACTLY where the user left it — not at a
// generic "fit all viewports" zoom. Without this, returning to a
// page from a deep edit feels disorienting: the user was last
// zoomed in on a specific section, and breadcrumb-back snapped them
// to a far-out fit of the entire page.
//
// We stash the current camera (`{ x, y, scale }`) keyed by the file
// the user is leaving, snapshotted at the moment `enterComponentFile`
// switches activeFile. The breadcrumb's exit path looks up its
// target file in the stash and restores that exact transform if
// present, falling through to the existing `computeFileEntryBounds`
// pre-zoom otherwise (e.g. fresh page load, no prior visit).
//
// Module-level Map (not a Jotai atom) for the same reason as
// `dragStateOps` / `parentHighlightOps`: writers live in imperative
// code paths that can't reach the Provider-scoped store reliably.
// The breadcrumb reads from it via `useSyncExternalStore`.

import type { Transform } from './TransformManager';

const stash = new Map<string, Transform>();
const listeners = new Set<() => void>();

export const cameraStash = {
  /** Save the camera transform for the given file path. Overwrites
   *  any previous entry — re-entering a master from the same page
   *  should pick up whatever the latest pre-entry camera was. */
  save(filePath: string, transform: Transform): void {
    stash.set(filePath, { ...transform });
    for (const fn of listeners) fn();
  },
  /** Read the stashed transform for a file. Returns null when the
   *  user hasn't visited that file before (or after `forget`).
   *  Returns a fresh object so a caller's accidental mutation
   *  doesn't corrupt the stash entry. */
  get(filePath: string): Transform | null {
    const t = stash.get(filePath);
    return t ? { ...t } : null;
  },
  /** Snapshot of every stashed camera as `[filePath, transform]` pairs (fresh
   *  copies). Used by the persistence layer (camera-persist.ts) to mirror the
   *  whole stash to `_meta/page-camera.json`. */
  entries(): [string, Transform][] {
    return Array.from(stash.entries()).map(([k, v]) => [k, { ...v }] as [string, Transform]);
  },
  /** Drop the stash entry for a file. Call when the file no longer
   *  exists (project reset, file deletion) so a future write to the
   *  same path doesn't restore a phantom camera. */
  forget(filePath: string): void {
    if (stash.delete(filePath)) {
      for (const fn of listeners) fn();
    }
  },
  /** Remove every entry — used on full-project reset. */
  clear(): void {
    if (stash.size === 0) return;
    stash.clear();
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
