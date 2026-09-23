// SearchableDropdown.tsx — generic type-to-filter combobox.
//
// The shared skeleton behind PageSelector (Layers panel) and
// CollectionSelector (CMS editor): a trigger button showing the current
// selection, and a dropdown with a search input + filtered item list.
// Auto-focuses the search input on open; closes on Escape, click outside,
// or selection. Item filtering, labels, icons and the trigger/input tint
// tiers are injected so each call site keeps its exact markup.

import { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface RowSubmenu {
  title?: string;
  options: { key: string; label: string; note?: string }[];
  activeKey: string | null;
  onPick: (key: string) => void;
}

/** Room between the list and a row's flyout — DropdownMenu's own gap. */
const SUBMENU_GAP = 6;
const SUBMENU_WIDTH = 168;

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
  /** Right-aligned note on a row ("in use", "edited"). */
  getTrailing?: (item: T) => ReactNode;
  /** Section the row belongs to — a small uppercase header is drawn wherever
   *  it changes (the agent's model select groups by vendor). Items must
   *  already be in group order. */
  getGroup?: (item: T) => string;
  /** A small mark beside a group's header (the model select's vendor logos). */
  getGroupIcon?: (group: string) => ReactNode;
  /**
   * A flyout beside a row — hovering the row opens it to the right, like the
   * editor's other cascading menus (DropdownMenu). For a choice that belongs
   * to ONE item (a model's thinking effort). Picking in it closes the whole
   * dropdown. `null` for a row with none; a row with one shows a chevron.
   */
  getSubmenu?: (item: T) => RowSubmenu | null;
  /** A row under the list (an action such as "New branch…"); `close` shuts the dropdown. */
  footer?: (close: () => void) => ReactNode;
  /** Trigger disabled (with `title` as the reason). */
  disabled?: boolean;
  title?: string;
  /** `data-testid` on the trigger button. */
  triggerTestId?: string;
  /** Position + width of the open panel (inline mode). Default: under the
   *  trigger, the trigger's own width. */
  panelClassName?: string;
  /**
   * Render the panel in a PORTAL on <body>, positioned from the trigger's
   * rect — for a trigger inside a clipped / overflow box (the agent
   * composer's footer), where an inline absolute panel would be cut off or
   * push the layout. `up` opens above the trigger, `down` below; `width` in
   * px. Repositions on scroll / resize while open.
   */
  portal?: { placement: 'up' | 'down'; width: number };
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
  getTrailing,
  getGroup,
  getGroupIcon,
  getSubmenu,
  footer,
  disabled,
  title,
  triggerTestId,
  panelClassName = 'left-0 right-0 top-full mt-1',
  portal,
}: SearchableDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null);
  // The row whose flyout is open, and where that row sits. One at a time:
  // hovering another row swaps it (or closes it, for a row with none).
  const [sub, setSub] = useState<{ key: string; rect: DOMRect } | null>(null);
  const subRef = useRef<HTMLDivElement>(null);

  // Portal placement: measured from the trigger, re-measured while open on
  // scroll / resize so the panel stays attached to the chip.
  useLayoutEffect(() => {
    if (!open || !portal) { setPortalStyle(null); return; }
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - portal.width - 8));
      setPortalStyle(
        portal.placement === 'up'
          ? { position: 'fixed', left, bottom: window.innerHeight - r.top + 6, width: portal.width }
          : { position: 'fixed', left, top: r.bottom + 6, width: portal.width },
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, portal?.placement, portal?.width]);

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

  // A closed dropdown, or a new query (the rows move), drops the flyout.
  useEffect(() => { setSub(null); }, [open, query]);

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
      const t = e.target as Node;
      // A portalled panel (and a row's flyout) is not inside the wrap — count it as inside.
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t) && !subRef.current?.contains(t)) {
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
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerClassName} disabled={disabled} title={title} data-testid={triggerTestId}>
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

      {open && (portal ? portalStyle && createPortal(panel(portalStyle), document.body) : panel(null))}
      {open && sub && flyout()}
    </div>
  );

  /** The open row's flyout: beside the list, top-aligned with the row,
   *  flipped left when the right has no room. */
  function flyout() {
    const item = filtered.find((it) => getKey(it) === sub!.key);
    const menu = item && getSubmenu?.(item);
    if (!menu) return null;
    const list = panelRef.current?.getBoundingClientRect() ?? sub!.rect;
    let left = list.right + SUBMENU_GAP;
    if (left + SUBMENU_WIDTH > window.innerWidth - 8) left = Math.max(8, list.left - SUBMENU_WIDTH - SUBMENU_GAP);
    const height = 12 + (menu.title ? 24 : 0) + menu.options.length * 30;
    const top = Math.max(8, Math.min(sub!.rect.top - 6, window.innerHeight - height - 8));
    return createPortal(
      <div
        ref={subRef}
        data-testid="searchable-dropdown-submenu"
        style={{ position: 'fixed', left, top, width: SUBMENU_WIDTH }}
        className="z-[99999] bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] py-1"
      >
        {menu.title && (
          <div className="px-2.5 pt-1.5 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{menu.title}</div>
        )}
        {menu.options.map((o) => {
          const on = o.key === menu.activeKey;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => { menu.onPick(o.key); setOpen(false); setQuery(''); }}
              className={`mx-1 my-0.5 flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                on ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-primary)] hover:bg-white/[0.06]'
              }`}
              style={{ width: 'calc(100% - 0.5rem)' }}
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.note && <span className={`shrink-0 text-[10px] ${on ? 'opacity-80' : 'text-[var(--text-secondary)]'}`}>{o.note}</span>}
            </button>
          );
        })}
      </div>,
      document.body,
    );
  }

  function panel(style: CSSProperties | null) {
    return (
        <div
          ref={panelRef}
          style={style ?? undefined}
          className={`${style ? 'z-[99999]' : `absolute ${panelClassName} z-[100]`} bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] overflow-hidden`}
        >
          <div className="p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className={inputClassName}
            />
          </div>
          {/* Inset hairlines, lighter than the panel in dark mode — the
              --border-light edge-to-edge rule read as a dark cut. */}
          <div aria-hidden className="mx-2 h-px bg-black/[0.08] dark:bg-white/10" />
          <div className={listClassName}>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">{emptyText}</div>
            ) : (
              filtered.map((item, i) => {
                const key = getKey(item);
                const isActive = key === activeKey;
                const group = getGroup?.(item);
                const header = group && (i === 0 || getGroup!(filtered[i - 1]) !== group) ? (
                  // --text-secondary: the dimmer --text-disabled was barely
                  // readable on the dark menu (owner, 2026-09-23).
                  <div key={`group:${group}`} className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">
                    {getGroupIcon?.(group)}
                    <span>{group}</span>
                  </div>
                ) : null;
                const row = (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelect(item)}
                    onMouseEnter={(e) => {
                      if (!getSubmenu) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setSub(getSubmenu(item) ? { key, rect } : null);
                    }}
                    data-submenu-open={sub?.key === key || undefined}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 mx-1 my-0.5 text-xs rounded text-left transition-colors ${
                      isActive
                        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'text-[var(--text-primary)] hover:bg-white/[0.06] data-[submenu-open]:bg-white/[0.06]'
                    }`}
                    style={{ width: 'calc(100% - 0.5rem)' }}
                  >
                    {itemIcon}
                    <span className="flex-1 truncate">{getLabel(item)}</span>
                    {getTrailing && <span className={`shrink-0 text-[10px] ${isActive ? 'opacity-80' : 'text-[var(--text-secondary)]'}`}>{getTrailing(item)}</span>}
                    {getSubmenu?.(item) && <span aria-hidden className={`shrink-0 text-[10px] ${isActive ? 'opacity-80' : 'text-[var(--text-secondary)]'}`}>›</span>}
                  </button>
                );
                return header ? [header, row] : row;
              })
            )}
          </div>
          {footer && (
            <>
            <div aria-hidden className="mx-2 h-px bg-black/[0.08] dark:bg-white/10" />
            <div className="p-1">
              {footer(() => { setOpen(false); setQuery(''); })}
            </div>
            </>
          )}
        </div>
    );
  }
}
