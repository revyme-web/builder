// branching/create.ts — the ONE way a branch is created and entered.
//
// Three doors open a branch — the Branches panel, the agent's create_branch,
// the chat header's switcher — and they must cut it from the same snapshot
// (what is on screen now) and switch the same way (switchBranchFile, which
// owns the queue base and cache hygiene). One helper, so they cannot drift.

import { projectFS } from '@/code/project/project-fs';
import { toBranchId } from '@/code/stores/branch-store';
import { switchBranchFile } from './switch-workspace';
import { trace } from '@/shared/debug-trace';

export type CreateBranchResult = { id: string } | { error: string };

/** Create `name` (normalised to an id) from the current workspace and switch to it. */
export function createBranchAndSwitch(name: string): CreateBranchResult {
  const id = toBranchId(name);
  if (!id) return { error: 'A branch needs a name (letters, digits, hyphens).' };
  const refusal = projectFS.createBranch(id, { from: projectFS.getSnapshot() });
  if (refusal) return { error: refusal };
  const switched = switchBranchFile(id);
  if (switched) return { error: `Branch "${id}" was created but the editor could not switch to it: ${switched}` };
  trace.action('branching:create-and-switch', { id });
  return { id };
}
