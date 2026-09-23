// BranchesPanel.tsx — create, switch between and apply branches.
//
// A branch is a full copy of the project's files plus the base it was cut
// from. Main stays the publish truth at all times: work happens on a branch,
// and `applyBranch` merges it back through the oracle gate. Switching is a
// pointer move inside ProjectFS — every reader already routes through the
// active branch, so the canvas follows with no special handling here.

import { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import SectionLabel from '@/design-system/SectionLabel';
import AddButton from '@/design-system/AddButton';
import SidebarRow from '@/design-system/SidebarRow';
import ConfirmDialog from '@/design-system/ConfirmDialog';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { projectFS, projectVersionAtom, MAIN_BRANCH_ID, type BranchInfo } from '@/code/project/project-fs';
import { branchesAtom, activeBranchIdAtom } from '@/code/stores/branch-store';
import { switchBranchFile } from '@/code/branching/switch-workspace';
import { isBranchLocked } from '@/code/stores/agent-run-lock-store';
import BranchChangesModal from './branches/BranchChangesModal';
import SearchBar from '@/design-system/SearchBar';
import { BranchCreateModal } from './branches/BranchCreateModal';
import { BranchIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

const STATUS_TEXT: Record<BranchInfo['status'], string> = {
  clean: '', dirty: 'edited', conflict: 'conflict',
};

export default function BranchesPanel() {
  const branches = useAtomValue(branchesAtom);
  const activeId = useAtomValue(activeBranchIdAtom);
  const bump = useSetAtom(projectVersionAtom);

  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => bump((v) => v + 1), [bump]);

  const goTo = useCallback((id: string) => {
    if (id === activeId) return;
    const refusal = switchBranchFile(id);
    setError(refusal);
    trace.action('branch-panel:switch', { id, refused: !!refusal });
    refresh();
  }, [activeId, refresh]);

  const remove = useCallback((id: string) => {
    // Leave the branch before deleting it, or the editor would be pointing at
    // a map that no longer exists.
    if (id === activeId) switchBranchFile(MAIN_BRANCH_ID);
    const refusal = projectFS.deleteBranch(id);
    setError(refusal);
    trace.action('branch-panel:delete', { id, refused: !!refusal });
    setConfirmDelete(null);
    refresh();
  }, [activeId, refresh]);

  const menuFor = (b: BranchInfo): DropdownMenuEntry[] | undefined => {
    if (b.protected) return undefined;
    return [
      { id: 'review', label: 'Review changes…', onClick: () => setReviewing(b.id) },
      { id: 'delete', label: 'Delete', danger: true, onClick: () => setConfirmDelete(b.id) },
    ];
  };

  const q = search.trim().toLowerCase();
  const shown = q ? branches.filter((b) => b.id.toLowerCase().includes(q)) : branches;

  return (
    <div className="flex h-full flex-col">
      {/* The left-toolbar panel chrome the Localization / CMS panels use —
          search, divider, section label with "+", rows inset by px-2 — so a
          branch row sits exactly where a locale row sits. */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <SearchBar value={search} onChange={setSearch} placeholder="Search branches…" />
      </div>
      <div data-tool-divider className="h-px bg-[var(--border-light)] mx-3 mt-1.5 mb-0" />

      <SectionLabel size="md" right={<AddButton title="New branch" onClick={() => { setError(null); setCreating(true); }} />}>
        Branches
      </SectionLabel>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="flex flex-col">
          {shown.map((b) => {
            const locked = isBranchLocked(b.id);
            const note = locked ? 'in use' : STATUS_TEXT[b.status];
            return (
              <SidebarRow
                key={b.id}
                icon={<BranchIcon size={14} style={{ color: b.id === activeId ? 'var(--accent)' : 'var(--text-secondary)' }} />}
                label={b.id}
                isActive={b.id === activeId}
                onClick={() => goTo(b.id)}
                menuItems={menuFor(b)}
                right={note ? <span className="text-[10px] text-[var(--text-tertiary)]">{note}</span> : undefined}
              />
            );
          })}
          {q && shown.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-[var(--text-tertiary)]">No branch matches “{search.trim()}”.</div>
          )}
        </div>
      </div>

      {/* The same "New Branch" dialog the agent chat's switcher opens — the
          Name Component modal shape, not a bespoke inline field. */}
      <BranchCreateModal
        isOpen={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => { trace.action('branch-panel:create', { id }); setError(null); refresh(); }}
      />

      {error && (
        <div className="border-t border-[var(--border-default)] px-3 py-2 text-[11px] text-[var(--accent-danger,#dc2626)]">
          {error}
        </div>
      )}

      {reviewing && (
        <BranchChangesModal
          branchId={reviewing}
          isOpen
          onClose={() => { setReviewing(null); refresh(); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        title="Delete branch"
        message={`“${confirmDelete}” and everything changed on it will be discarded. Main is untouched.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
