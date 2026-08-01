// PageVariableChip.tsx — Blue value-column pill showing a bound PAGE variable
// (design-tool parity for the Search Field: the input's "Variable" row + a dynamic
// filter's "Value" row both display the page variable driving them).
//
// MISSING state: when the bound var name isn't a declared page variable on this
// page (e.g. a Search Field pasted from another page — the var didn't travel),
// the chip reads "Missing" so the user knows to pick/create one.
//
// Two modes:
//  • default (no `selectable`)   → clicking opens the variable-manage modal.
//  • `selectable` provided       → a caret opens a DROPDOWN to pick an existing
//    page variable or create a new one (design-tool parity), so a Missing input stays
//    Missing until the user explicitly chooses. The parent wires the rebind.

import { useMemo, useState, useRef } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { useAtomValue, useSetAtom } from 'jotai';
import { variableModalRequestAtom, codeAtom } from '@/code/stores/store';
import { parsePageVariables } from '@/code/features/page-variables';
import { trace } from '@/shared/debug-trace';

interface SelectableConfig {
  /** Existing (type-matching) page variables offered in the dropdown. */
  options: { name: string }[];
  /** Bind to an existing variable. */
  onSelect: (name: string) => void;
}

// Inset rows (mx-1.5 + w-[calc(100%-12px)] + rounded) so the hover fill stays
// within the dropdown's padding — matches every other native dropdown.
const MENU_ITEM = 'group flex items-center gap-2 mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:!bg-[var(--accent)] hover:text-[var(--accent-fg)] transition-colors border-none bg-transparent whitespace-nowrap';

export default function PageVariableChip({ name, onRemove, selectable }: { name: string; onRemove?: () => void; selectable?: SelectableConfig }) {
  const openVariableModal = useSetAtom(variableModalRequestAtom);
  const code = useAtomValue(codeAtom);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A variable is MISSING when this page doesn't declare it (pasted cross-page).
  const isMissing = useMemo(() => {
    if (!name) return false;
    const declared = new Set((parsePageVariables(code)?.variables ?? []).map(v => v.name));
    return !declared.has(name);
  }, [code, name]);

  useClickOutside(ref, open, () => setOpen(false));

  if (!name) return null;
  const label = isMissing ? 'Missing' : name;

  const handleClick = () => {
    if (selectable) { setOpen(v => !v); return; }
    trace.action('page-variable-chip:open-modal', { name, isMissing });
    openVariableModal({ property: '', propertyLabel: 'Variable', currentValue: '', variableRef: name, nameEditable: isMissing });
  };

  return (
    <div className="relative w-full min-w-0" ref={ref}>
      <button
        type="button"
        onClick={handleClick}
        // `min-w-0` lets the label truncate inside the flex row instead of pushing
        // the chip past the panel (a long var name like "searchReadTime" overflowed).
        className="w-full max-w-full min-w-0 h-8 flex items-center gap-2 pl-1 pr-2 rounded-[var(--radius-lg)] border border-transparent bg-clip-padding text-xs font-medium text-[var(--accent-fg)] cursor-pointer transition-colors hover:opacity-90"
        style={{ backgroundColor: 'var(--accent)' }}
        title={isMissing ? `Missing variable "${name}" — click to choose or create one` : `Page variable: ${name}`}
      >
        <span className="w-4 h-4 rounded bg-white/20 flex items-center justify-center shrink-0 text-[10px] font-bold leading-none">T</span>
        <span className="flex-1 min-w-0 truncate text-left">{label}</span>
        {onRemove ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onRemove(); } }}
            className="text-white/70 hover:text-white text-sm leading-none shrink-0 cursor-pointer"
            title="Remove variable"
          >
            ×
          </span>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80 shrink-0">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {selectable && open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] max-w-[260px] bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1.5">
            {selectable.options.length === 0 ? (
              <div className="mx-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)]">No matching variables</div>
            ) : selectable.options.map((o) => (
              <button key={o.name} type="button" className={MENU_ITEM}
                onClick={() => { trace.action('page-variable-chip:select', { name: o.name }); selectable.onSelect(o.name); setOpen(false); }}>
                <span className="w-3 shrink-0 text-white/90 group-hover:text-[var(--accent-fg)]">
                  {o.name === name && !isMissing ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : null}
                </span>
                <span className="flex-1 min-w-0 truncate">{o.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
