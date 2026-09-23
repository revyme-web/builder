// branches/BranchCreateModal.tsx — the "New Branch" dialog.
//
// The compact name modal every other "name a thing" flow uses (Name Component,
// new page, new template), so a branch is created the way everything else is:
// one field, one accent button, Enter to confirm. Shared by the Branches
// panel's "+" and the agent chat's branch switcher, so the two entry points
// cannot drift. Creating + switching is `createBranchAndSwitch`
// (branching/create.ts) — the same call the agent's create_branch tool makes.

import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import NameInputModal from '@/editor/ui/NameInputModal';
import { branchesAtom, toBranchId } from '@/code/stores/branch-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { createBranchAndSwitch } from '@/code/branching/create';
import { trace } from '@/shared/debug-trace';

/** `onCreated` is each caller's follow-up (the panel clears its error strip;
 *  the chat needs nothing — its header re-renders off the version bump). */
export function BranchCreateModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const branches = useAtomValue(branchesAtom);
  const bump = useSetAtom(projectVersionAtom);
  const validate = (name: string): string | null => {
    const id = toBranchId(name);
    if (!id) return 'Use letters, digits or spaces.';
    if (branches.some((b) => b.id === id)) return `“${id}” already exists.`;
    return null;
  };
  const create = (name: string) => {
    const created = createBranchAndSwitch(name);
    // The modal has already validated the name; what is left is a refusal
    // (a run in flight) — a toast, like the canvas's own refusals.
    if ('error' in created) { toast.error(created.error); return; }
    trace.action('branch-create-modal:create', { id: created.id });
    bump((v) => v + 1);
    onCreated?.(created.id);
  };
  return (
    <NameInputModal
      isOpen={isOpen}
      onClose={onClose}
      onSubmit={create}
      title="New Branch"
      description="A copy of the project as it is now. Main stays untouched until you apply the branch."
      placeholder="Branch name"
      submitLabel="Create Branch"
      validate={validate}
    />
  );
}
