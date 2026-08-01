// VariableTypePicker.tsx — standard "+" dropdown: search + pick a variable TYPE to create.
//
// Rendered as a fixed-position floating panel anchored under the trigger (the modal header "+"). Lists
// VARIABLE_TYPES with their filled icons; typing filters by label. Picking one calls onSelect(typeDef).
// A full-screen transparent backdrop catches outside clicks; Escape closes too.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VARIABLE_TYPES, type VariableTypeDef } from './variable-types';
import { trace } from '@/shared/debug-trace';

interface VariableTypePickerProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (type: VariableTypeDef) => void;
  onClose: () => void;
}

export function VariableTypePicker({ anchorRef, onSelect, onClose }: VariableTypePickerProps) {
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const PANEL_W = 240;

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    // Open to the RIGHT of the trigger (the + sits at the modal's right edge) so the dropdown sits
    // beside the modal instead of covering its form. Falls back to the left if it would overflow.
    let left = r.left;
    if (left + PANEL_W > window.innerWidth - 8) left = Math.max(8, r.right - PANEL_W);
    setPos({ top: r.bottom + 6, left });
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    trace.action('variable-type-picker:open', {});
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pickable = VARIABLE_TYPES.filter(t => t.pickable !== false);
  const filtered = query.trim()
    ? pickable.filter(t => t.label.toLowerCase().includes(query.trim().toLowerCase()))
    : pickable;

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 100020 }} onMouseDown={onClose} onPointerDown={(e) => e.stopPropagation()}>
      {pos && (
        <div
          ref={panelRef}
          // Same shell as the editor's other dropdown menus: solid `--dropdown-bg`, large shadow, py-1.5.
          className="absolute bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] py-1.5 overflow-hidden flex flex-col"
          style={{ top: pos.top, left: pos.left, width: PANEL_W, maxHeight: '60vh' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Search */}
          <div className="flex items-center gap-2 mx-1.5 mb-1 px-2.5 h-8 rounded-[var(--radius-sm)] bg-[var(--grid-line)] shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-[var(--text-secondary)] shrink-0">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search…"
              className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none"
            />
          </div>
          {/* Type list — inset accent-hover rows, same as ControlLabel's menu (no icons). */}
          <div className="overflow-y-auto scrollbar-hide space-y-0.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-[var(--text-secondary)]">No matching type</div>
            ) : filtered.map(t => (
              <button
                key={t.id}
                onClick={() => { trace.action('variable-type-picker:select', { type: t.id }); onSelect(t); }}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] transition-colors"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
