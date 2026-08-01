// LinkRelControl.tsx — multi-token editor for the `rel` attribute.
// Renders each selected user token as a row (label + ×) plus an "Add…" row
// whose dropdown lists every rel option with a ✓ for the selected ones
// (multi-select — the menu stays open). Non-user tokens (e.g. `noopener`) are
// preserved silently. The value column only; the caller supplies the label.

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { REL_OPTIONS, parseRelTokens, formatRelTokens, relLabel, isUserRelToken } from './link-rel-utils';
import { trace } from '@/shared/debug-trace';

interface LinkRelControlProps {
  /** Current `rel` string (space-separated). */
  value: string;
  /** Called with the new `rel` string. */
  onChange: (rel: string) => void;
}

export default function LinkRelControl({ value, onChange }: LinkRelControlProps) {
  const tokens = parseRelTokens(value);
  const userTokens = tokens.filter(isUserRelToken);
  const preserved = tokens.filter((t) => !isUserRelToken(t)); // e.g. noopener

  const [menuOpen, setMenuOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  trace.fn('LinkRelControl:render', { value, userTokens });

  const commit = useCallback((nextUser: string[]) => {
    onChange(formatRelTokens([...nextUser, ...preserved]));
  }, [onChange, preserved]);

  // Match the Add button (value column) width so the menu lines up under it,
  // and the full-width item rows give a full-width accent hover.
  const recalc = useCallback(() => {
    const el = addRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.left), width: r.width });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    recalc();
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)
          && addRef.current && !addRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', recalc, true);
    window.addEventListener('resize', recalc);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', recalc, true);
      window.removeEventListener('resize', recalc);
    };
  }, [menuOpen, recalc]);

  return (
    <div className="flex flex-col gap-2 w-full min-w-0">
      {userTokens.map((tok) => (
        <div
          key={tok}
          className="w-full h-8 flex items-center gap-2 px-2 rounded-[var(--radius-lg)] bg-[var(--control-bg)] border border-[var(--control-border)] text-xs text-[var(--text-primary)]"
        >
          <span className="truncate flex-1 min-w-0 text-left">{relLabel(tok)}</span>
          <span
            role="button"
            tabIndex={0}
            onClick={() => { trace.action('link-rel:remove', { tok }); commit(userTokens.filter((t) => t !== tok)); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') commit(userTokens.filter((t) => t !== tok)); }}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm leading-none shrink-0 cursor-pointer"
            title={`Remove ${relLabel(tok)}`}
          >
            ×
          </span>
        </div>
      ))}

      {/* Hide the Add row once every option is selected — nothing left. */}
      {userTokens.length < REL_OPTIONS.length && (
        <button
          ref={addRef}
          onClick={() => setMenuOpen((o) => !o)}
          className="w-full h-8 flex items-center gap-2 px-2 rounded-[var(--radius-lg)] bg-[var(--control-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-xs text-[var(--text-secondary)] transition-colors cursor-pointer"
        >
          <span className="w-4 h-4 rounded bg-white/10 flex items-center justify-center shrink-0 text-[10px]">+</span>
          <span className="truncate flex-1 text-left">Add…</span>
        </button>
      )}

      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-md py-1.5 space-y-0.5"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, zIndex: 100020 }}
        >
          {/* Only options NOT yet selected — picking one adds it (shown as a
              row above) and closes the menu; remove via the row's ×. No
              checkmarks / left gutter (Animation-tool dropdown style). */}
          {(() => {
            const available = REL_OPTIONS.filter((o) => !userTokens.includes(o.token));
            if (available.length === 0) {
              return <div className="px-2.5 py-1.5 text-xs text-[var(--text-secondary)] whitespace-nowrap">All added</div>;
            }
            return available.map((opt) => (
              <button
                key={opt.token}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  trace.action('link-rel:add', { token: opt.token });
                  commit([...userTokens, opt.token]);
                  setMenuOpen(false);
                }}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
              >
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">{opt.label}</span>
              </button>
            ));
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}
