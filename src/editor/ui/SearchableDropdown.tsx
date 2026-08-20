// SearchableDropdown.tsx — generic type-to-filter combobox.
//
// The shared skeleton behind PageSelector (Layers panel) and
// CollectionSelector (CMS editor): a trigger button showing the current
// selection, and a dropdown with a search input + filtered item list.
// Auto-focuses the search input on open; closes on Escape, click outside,
// or selection. Item filtering, labels, icons and the trigger/input tint
// tiers are injected so each call site keeps its exact markup.

import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';

interface SearchableDropdownProps<T> {
  items: T[];
  /** Stable per-item key. */
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  /** Type-to-filter predicate — receives the lowercased trimmed query. */
  matches: (item: T, q: string) => boolean;
  /** Key of the currently-active item (highlighted row). */
  activeKey: string | null;
  /** Label shown in the trigger button. */
  triggerLabel: string;
  /** Icon in the trigger button (size-14 tier). */
  triggerIcon: ReactNode;
  /** Icon on each list row (size-12 tier). */
  itemIcon: ReactNode;
  placeholder: string;
  emptyText: string;
  /** Full class string for the trigger button (tint tier differs per host panel). */
  triggerClassName: string;
  /** Full class string for the search input. */
  inputClassName: string;
  /** Class string for the scrolling list container. */
  listClassName: string;
  /** Called with the picked item; the dropdown closes + clears the query itself. */
  onSelect: (item: T) => void;
}

export default function SearchableDropdown<T>({
  items,
  getKey,
  getLabel,
  matches,
  activeKey,
  triggerLabel,
  triggerIcon,
  itemIcon,
  placeholder,
  emptyText,
  triggerClassName,
  inputClassName,
  listClassName,
  onSelect,
}: SearchableDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => matches(it, q));
  }, [items, query, matches]);

  const handleSelect = useCallback(
    (item: T) => {
      onSelect(item);
      setOpen(false);
      setQuery('');
    },
    [onSelect],
  );

  // Auto-focus the search input when the dropdown opens so the user
  // can type-to-filter immediately without an extra click.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Click-outside + Escape close the dropdown. Both attach only while
  // open so we don't pay for window listeners during the panel's
  // (much more common) closed state.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerClassName}>
        {triggerIcon}
        <span className="flex-1 text-left truncate">{triggerLabel}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-[100] bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] overflow-hidden">
          <div className="p-1.5 border-b border-[var(--border-light)]">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className={inputClassName}
            />
          </div>
          <div className={listClassName}>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">{emptyText}</div>
            ) : (
              filtered.map((item) => {
                const key = getKey(item);
                const isActive = key === activeKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelect(item)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 mx-1 my-0.5 text-xs rounded text-left transition-colors ${
                      isActive
                        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'text-[var(--text-primary)] hover:bg-white/[0.06]'
                    }`}
                    style={{ width: 'calc(100% - 0.5rem)' }}
                  >
                    {itemIcon}
                    <span className="truncate">{getLabel(item)}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
