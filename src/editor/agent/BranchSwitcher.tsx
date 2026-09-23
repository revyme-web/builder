// agent/BranchSwitcher.tsx — which branch the agent's next turn lands on.
//
// The reference builder shows the branch in the top bar; here the chat is where the question
// comes up ("do it on a branch?"), so the branch sits in the composer's
// footer, next to the model chip: the branch the canvas — and therefore
// the run — is on, the same type-to-filter combobox the Layers panel's page
// picker is (SearchableDropdown), opening upward. Creating and switching are
// the Branches panel's own moves (branching/create.ts, switchBranchFile), so
// the panel and this control never disagree; "New branch…" opens the SAME
// dialog the panel's "+" opens (`BranchCreateModal`, on NameInputModal like
// "Name Component").
//
// Disabled while a run is live: a switch mid-run would move the queue base
// out from under the agent's writes (switchBranchFile refuses it anyway; the
// control says so instead of failing).

import { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { toast } from 'sonner';
import SearchableDropdown from '@/editor/ui/SearchableDropdown';
import { BranchCreateModal } from '@/editor/left-toolbar/panels/branches/BranchCreateModal';
import { branchesAtom, activeBranchIdAtom } from '@/code/stores/branch-store';
import { projectVersionAtom, MAIN_BRANCH_ID, type BranchInfo } from '@/code/project/project-fs';
import { switchBranchFile } from '@/code/branching/switch-workspace';
import { isBranchLocked } from '@/code/stores/agent-run-lock-store';
import { BranchIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

/** A footer control, not a field: quiet until hovered, the same height as
 *  the gear and the send circle beside it. */
const PICKER_TRIGGER_CLASS =
  'flex h-6 max-w-[min(11rem,100%)] items-center gap-1.5 px-1.5 text-[11px] cut-corners text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent';
const PICKER_INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] focus:bg-black/[0.12] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:focus:bg-white/[0.12] cut-corners text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors';

const STATUS_TEXT: Record<BranchInfo['status'], string> = { clean: '', dirty: 'edited', conflict: 'conflict' };

/** The list opens UPWARD from the footer, in a PORTAL: the chip sits inside
 *  the composer's clipped box, where an inline panel was cut off and pushed
 *  the layout. A readable fixed width — the trigger is a chip, not a field. */
const PANEL_PORTAL = { placement: 'up' as const, width: 224 };

/** The trigger shows the branch (accent when off main); the list every
 *  branch with its state, and "New branch…" under it. */
export function BranchSelector({ disabled, onRequestCreate }: { disabled: boolean; onRequestCreate: () => void }) {
  const branches = useAtomValue(branchesAtom);
  const activeId = useAtomValue(activeBranchIdAtom);
  const bump = useSetAtom(projectVersionAtom);
  const onMain = activeId === MAIN_BRANCH_ID;

  const goTo = (id: string) => {
    if (id === activeId) return;
    const refusal = switchBranchFile(id);
    // A refusal (a run in flight) is a toast, like the canvas's own refusals.
    if (refusal) toast.error(refusal);
    trace.action('agent-branch-switcher:switch', { id, refused: !!refusal });
    bump((v) => v + 1);
  };

  const items = useMemo(() => branches.map((b) => ({
    id: b.id,
    label: b.id === MAIN_BRANCH_ID ? 'main' : b.id,
    note: isBranchLocked(b.id) ? 'in use' : b.id === MAIN_BRANCH_ID ? 'publishes' : STATUS_TEXT[b.status],
  })), [branches]);

  return (
    // Gives way LAST in a narrow composer: the model chip truncates first
    // (shrink weight 1 vs 0.2), so a short name like "main" stays whole.
    <div data-testid="agent-branch-switcher" data-branch={activeId} className="relative min-w-0 shrink-[0.2]">
      <SearchableDropdown
        items={items}
        getKey={(b) => b.id}
        getLabel={(b) => b.label}
        getTrailing={(b) => b.note || null}
        matches={(b, q) => b.label.toLowerCase().includes(q)}
        activeKey={activeId}
        triggerLabel={onMain ? 'main' : activeId}
        triggerIcon={<BranchIcon size={12} className={`shrink-0 ${onMain ? 'text-[var(--text-tertiary)]' : 'text-[var(--accent)]'}`} />}
        itemIcon={<BranchIcon size={12} className="shrink-0" />}
        placeholder="Search branches…"
        emptyText="No branch matches."
        triggerClassName={PICKER_TRIGGER_CLASS}
        inputClassName={PICKER_INPUT_CLASS}
        listClassName="max-h-60 overflow-y-auto scrollbar-hide py-1"
        onSelect={(b) => goTo(b.id)}
        portal={PANEL_PORTAL}
        disabled={disabled}
        title={disabled ? 'Available when the agent has finished' : onMain ? 'On main — the version that publishes. Switch or create a branch' : `On branch ${activeId} — main is untouched until you apply it`}
        footer={(close) => (
          <button
            type="button"
            onClick={() => { close(); onRequestCreate(); }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded text-left text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New branch…
          </button>
        )}
      />
    </div>
  );
}

export { BranchCreateModal };
