// branch-store.ts — reactive view over ProjectFS's branch state.
//
// ProjectFS owns branches (it owns every file map); this module is only the
// jotai surface the UI reads. Nothing here holds branch data of its own — a
// second copy would drift from the maps the editor actually writes to.
//
// Reads are derived from `projectVersionAtom`, the same pulse every other
// panel re-derives on, so creating / switching / editing a branch refreshes
// the list without a bespoke subscription.

import { atom } from 'jotai';
import { projectFS, projectVersionAtom, type BranchInfo } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

/** Every branch, main first, then by sibling order. */
export const branchesAtom = atom<BranchInfo[]>((get) => {
  get(projectVersionAtom);          // re-derive on any project write
  return projectFS.listBranches();
});

/** The branch the canvas is currently showing. */
export const activeBranchIdAtom = atom<string>((get) => {
  get(projectVersionAtom);
  return projectFS.getActiveBranchId();
});

/** True while the editor is on main (publish truth). */
export const isOnMainAtom = atom<boolean>((get) => get(activeBranchIdAtom) === 'main');

/** Branches with uncommitted work — what the review surface offers to apply. */
export const dirtyBranchesAtom = atom<BranchInfo[]>((get) =>
  get(branchesAtom).filter((b) => !b.protected && b.status !== 'clean'));

/**
 * Turn a user-typed branch name into a legal id.
 *
 * ProjectFS accepts `^[a-z0-9-]{1,48}$` and refuses anything else, so the
 * panel normalizes rather than bouncing the user for typing a capital or a
 * space. Returns '' when nothing legal survives — the caller keeps the
 * Create button disabled rather than creating a branch called "-".
 */
export function toBranchId(raw: string): string {
  const id = raw.toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  trace.fn('branch-store:toBranchId', { raw, id });
  return id;
}
