// BranchChangesModal.tsx — review what a branch changed, then apply it.
//
// Rows come from `describeFileChanges` (per-node, human property labels),
// so the review reads as "Hero — Font size 14px → 18px", not as a text diff.
// Applying routes through `applyBranch`, which gates every merged file
// through the oracle before anything is written; a conflict aborts and
// nothing lands.

import { useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import SectionLabel from '@/design-system/SectionLabel';
import { projectFS, projectVersionAtom, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { describeFileChanges, type NodeChange } from '@/code/branching/describe-changes';
import { applyBranch } from '@/code/branching/apply';
import { trace } from '@/shared/debug-trace';

const KIND_LABEL: Record<NodeChange['kind'], string> = {
  added: 'Added', removed: 'Removed', moved: 'Moved', changed: 'Changed',
};
const KIND_COLOR: Record<NodeChange['kind'], string> = {
  added: 'var(--accent)', removed: 'var(--accent-danger, #dc2626)',
  moved: 'var(--text-secondary)', changed: 'var(--text-primary)',
};

export default function BranchChangesModal({ branchId, isOpen, onClose }: {
  branchId: string; isOpen: boolean; onClose: () => void;
}) {
  const bump = useSetAtom(projectVersionAtom);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-file rows: base (what the branch was cut from) vs the branch's files.
  const files = useMemo(() => {
    if (!isOpen) return [];
    const base = projectFS.readBranchBase(branchId);
    const theirs = projectFS.readBranchFiles(branchId);
    if (!base || !theirs) return [];
    const paths = [...new Set([...base.keys(), ...theirs.keys()])].sort();
    return paths
      .filter((p) => base.get(p) !== theirs.get(p))
      .map((path) => ({ path, ...describeFileChanges(base.get(path) ?? null, theirs.get(path) ?? null) }));
  }, [branchId, isOpen]);

  const total = files.reduce((n, f) => n + f.changes.length, 0);

  const apply = () => {
    setApplying(true);
    setError(null);
    const res = applyBranch(branchId);
    trace.action('branch-panel:apply', { branchId, status: res.status, files: res.files.length });
    setApplying(false);
    if (res.status === 'applied') { bump((v) => v + 1); onClose(); return; }
    setError(
      res.status === 'conflicts'
        ? `${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'} conflict with main. Nothing was written — resolve on the branch, then apply again.`
        : res.reason ?? 'Apply was refused. Nothing was written.',
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Changes on “${branchId}”`} width={560}>
      <div className="flex max-h-[60vh] flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {files.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
              No changes yet — this branch matches what it was created from.
            </div>
          )}
          {files.map((f) => (
            <div key={f.path}>
              <SectionLabel size="xs">{f.path}</SectionLabel>
              {f.unparsed && (
                <div className="px-3 pb-2 text-[11px] text-[var(--text-disabled)]">
                  This file couldn’t be inspected — it will still be merged.
                </div>
              )}
              {f.changes.map((c, i) => (
                <div key={`${c.title}-${i}`} className="px-3 py-1.5 text-[12px]">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: KIND_COLOR[c.kind] }}>
                      {KIND_LABEL[c.kind]}
                    </span>
                    <span className="truncate text-[var(--text-primary)]">{c.title}</span>
                  </div>
                  {c.props.map((p) => (
                    <div key={p.label} className="pl-2 text-[11px] text-[var(--text-tertiary)]">
                      {p.label}: <span className="line-through">{p.before || '—'}</span> → <span className="text-[var(--text-secondary)]">{p.after || '—'}</span>
                    </div>
                  ))}
                  {c.moreProps > 0 && (
                    <div className="pl-2 text-[11px] text-[var(--text-disabled)]">+{c.moreProps} more</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {error && <div className="px-3 py-2 text-[12px] text-[var(--accent-danger,#dc2626)]">{error}</div>}

        <div className="flex items-center justify-between border-t border-[var(--border-default)] px-3 py-2">
          <span className="text-[11px] text-[var(--text-tertiary)]">
            {total} change{total === 1 ? '' : 's'} across {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={apply}
            disabled={applying || files.length === 0}
            className="cut-corners bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-contrast,#111)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {applying ? 'Applying…' : `Apply to ${MAIN_BRANCH_ID}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
