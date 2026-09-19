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
import { branchesAtom, activeBranchIdAtom, toBranchId } from '@/code/stores/branch-store';
import { switchBranchFile } from '@/code/branching/switch-workspace';
import { isBranchLocked } from '@/code/stores/agent-run-lock-store';
import BranchChangesModal from './branches/BranchChangesModal';
import { trace } from '@/shared/debug-trace';

function BranchIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

const STATUS_TEXT: Record<BranchInfo['status'], string> = {
  clean: '', dirty: 'edited', conflict: 'conflict',
};

export default function BranchesPanel() {
  const branches = useAtomValue(branchesAtom);
  const activeId = useAtomValue(activeBranchIdAtom);
  const bump = useSetAtom(projectVersionAtom);

  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => bump((v) => v + 1), [bump]);

  const create = useCallback(() => {
    const id = toBranchId(draftName);
    if (!id) return;
    // Cut from what is on screen now, so a branch starts as a faithful copy
    // of the workspace the user was looking at.
    const refusal = projectFS.createBranch(id, { from: projectFS.getSnapshot() });
    if (refusal) { setError(refusal); return; }
    trace.action('branch-panel:create', { id });
    setDraftName('');
    setCreating(false);
    setError(null);
    const switchRefusal = switchBranchFile(id);
    if (switchRefusal) setError(switchRefusal);
    refresh();
  }, [draftName, refresh]);

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

  return (
    <div className="flex h-full flex-col">
      <SectionLabel right={<AddButton title="New branch" onClick={() => setCreating((v) => !v)} />}>
        Branches
      </SectionLabel>

      {creating && (
        <div className="px-3 pb-2">
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') { setCreating(false); setDraftName(''); }
            }}
            placeholder="branch name"
            className="w-full h-[var(--control-height)] px-[var(--control-pad-x)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] cut-corners cut-border focus:outline-none transition-colors"
          />
          {draftName && toBranchId(draftName) !== draftName && (
            <div className="pt-1 text-[10px] text-[var(--text-tertiary)]">
              will be created as “{toBranchId(draftName) || '—'}”
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {branches.map((b) => {
          const locked = isBranchLocked(b.id);
          const note = locked ? 'in use' : STATUS_TEXT[b.status];
          return (
            <SidebarRow
              key={b.id}
              icon={<BranchIcon color={b.id === activeId ? 'var(--accent)' : 'var(--text-secondary)'} />}
              label={b.id}
              isActive={b.id === activeId}
              onClick={() => goTo(b.id)}
              menuItems={menuFor(b)}
              right={note ? <span className="text-[10px] text-[var(--text-tertiary)]">{note}</span> : undefined}
            />
          );
        })}
      </div>

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
