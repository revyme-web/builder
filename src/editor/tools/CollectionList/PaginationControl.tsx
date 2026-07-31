// PaginationControl.tsx — Collection List "Pagination" row (design-tool parity).
// Empty → "Add…" opens a dropdown (Infinite Scroll / Load More), styled like the
// Animation tool's + menu. Choosing a mode applies it AND opens the Items popup
// (number-of-rows stepper). Active → a row showing the spinner glyph + "N Items"
// that re-opens the Items popup, plus a Remove ×. Drives setPagination /
// removePagination mutations.

import { useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { ControlLabel, ControlActionRow, RemoveButton, ToolRow, ToolInput, ToolPlusMinus } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import CollectionRowIcon from './CollectionRowIcon';
import { COLLECTION_VALUE_CLS } from './cms-filter-utils';
import type { PaginationConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

interface Props {
  pagination: PaginationConfig | null;
  onSet: (mode: 'loadMore' | 'infinite', perPage: number) => void;
  onRemove: () => void;
  /** Pagination is PRIMARY-ONLY (like Source). On a replica/variant (`editable=false`)
   *  it's read-only: no Add, no × — it only appears if set on the primary. */
  editable?: boolean;
}

const MODE_LABEL: Record<'loadMore' | 'infinite', string> = { loadMore: 'Load More', infinite: 'Infinite Scroll' };

// Mirrors the Animation tool's add-dropdown item (same hover-accent fill).
const ADD_ITEM = 'group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap';
const ADD_ITEM_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-white';

export default function PaginationControl({ pagination, onSet, onRemove, editable = true }: Props) {
  const [open, setOpen] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const addAnchorRef = useRef<HTMLDivElement>(null);

  const mode = pagination?.mode ?? 'loadMore';
  const perPage = pagination?.perPage ?? 3;

  // Close the add dropdown on outside click (mirrors AddEffectDropdown).
  useClickOutside(addAnchorRef, addMenu, () => setAddMenu(false));

  // Pick a mode from the dropdown → apply it, then drop straight into the Items
  // popup so the user sets the row count in one flow (matches the reference).
  const choose = (m: 'loadMore' | 'infinite') => {
    trace.action('pagination-control:add', { mode: m });
    onSet(m, perPage);
    setAddMenu(false);
    setOpen(true);
  };

  return (
    <div className="flex items-center justify-between w-full" ref={rowRef}>
      <ControlLabel label="Pagination" property="collectionPagination" plain />
      {pagination ? (
        // Active. On a replica/variant (read-only) the row shows the value but
        // has NO × and doesn't open the Items popup — pagination is primary-only.
        <ControlActionRow onClick={editable ? () => setOpen(true) : undefined} className={`${COLLECTION_VALUE_CLS} !pr-2${editable ? '' : ' !cursor-default'}`}>
          <CollectionRowIcon glyph="spinner" active={true} />
          <span className="flex-1 min-w-0 text-xs text-[var(--text-primary)] truncate text-left">{perPage} Items</span>
          {editable && <RemoveButton onClick={() => { trace.action('pagination-control:remove', {}); onRemove(); }} />}
        </ControlActionRow>
      ) : !editable ? (
        // Not editable + no pagination → a disabled "Add…" (can't add from a replica).
        <ControlActionRow className={`${COLLECTION_VALUE_CLS} !pr-2 opacity-50 !cursor-not-allowed`}>
          <CollectionRowIcon glyph="spinner" active={false} />
          <span className="flex-1 min-w-0 text-xs text-[var(--text-secondary)] text-left">Add…</span>
        </ControlActionRow>
      ) : (
        // Native floating dropdown anchored AT the row (no ToolPopup), exactly
        // like the Animation tool's + menu — the relative wrapper hosts both the
        // trigger and the absolutely-positioned mode list. `min-w-0` + the
        // matching `!pr-2` keep this box the SAME width as the active row (it
        // must never resize based on whether a × is present).
        <div className={`relative ${COLLECTION_VALUE_CLS}`} ref={addAnchorRef}>
          <ControlActionRow onClick={() => setAddMenu(v => !v)} className="w-full !pr-2 min-w-0">
            <CollectionRowIcon glyph="spinner" active={false} />
            <span className="flex-1 min-w-0 text-xs text-[var(--text-secondary)] text-left">Add…</span>
          </ControlActionRow>
          {addMenu && (
            <>
              <div className="fixed inset-0 z-50" onClick={() => setAddMenu(false)} />
              <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] space-y-0.5">
                {(['infinite', 'loadMore'] as const).map(m => (
                  <button key={m} type="button" onClick={() => choose(m)} className={ADD_ITEM}>
                    <span className={ADD_ITEM_LABEL}>{MODE_LABEL[m]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Items popup — number of rows per page (+ SEO note for infinite). */}
      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title="Pagination" anchorRef={rowRef} width={260}>
        <div className="flex flex-col gap-2">
          <ToolRow label="Items">
            <ToolInput
              value={String(perPage)}
              onChange={(v) => { const n = parseInt(v, 10); if (Number.isFinite(n) && n > 0) onSet(mode, n); }}
              step={1}
              className="!w-16 shrink-0"
            />
            <ToolPlusMinus value={perPage} onChange={(n) => onSet(mode, Math.max(1, n))} min={1} max={100} step={1} />
          </ToolRow>
          {mode === 'infinite' && (
            <p className="text-[11px] text-[var(--text-secondary)] leading-snug px-0.5">
              Enabling infinite scroll with footers can impact site SEO.
            </p>
          )}
        </div>
      </ToolPopup>
    </div>
  );
}
