// DropdownMenu.tsx — Centralized dropdown menu matching context menu design.
// Used for: Components +, Pages +, toolbar dropdowns, any popup menu.
// Configurable hover accent: blue (context menu) or subtle gray (panel menus).
//
// Cascading submenus:
//   Items can carry `submenuItems`. Hovering such an item opens a SECOND
//   menu portal positioned to the right (or left if there's no room) and
//   top-aligned with the item. Submenus can themselves contain submenus
//   (the menu structure is recursive). Hover state persists while the
//   cursor moves between parent item and submenu so the user can navigate
//   without closing accidentally.

import { useRef, useEffect, useLayoutEffect, useState, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Right-side icon — rendered between the label and the shortcut.
   *  Used by the Preferences submenu's check glyph so it sits at the
   *  END of the row (the leading `icon` slot would put it on the left
   *  and the row layout looks unbalanced for boolean toggles). */
  trailingIcon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Cascading submenu — opens to the right on hover. Recursive. */
  submenuItems?: DropdownMenuEntry[];
  /** Force-render a right chevron next to the label. Auto-rendered when
   *  `submenuItems` is set; this flag is only needed for parent items
   *  whose submenu lives in a custom rendering (older state-machine path
   *  — kept for backward compat). */
  hasSubmenu?: boolean;
  /** When true the menu does NOT auto-close after onClick. Mostly useful
   *  for legacy state-machine flows; cascading submenus don't need it
   *  because parent items don't run onClick at all (hover opens submenu). */
  keepOpen?: boolean;
  onClick: () => void;
}

interface DropdownMenuSeparator {
  type: 'separator';
}

export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuSeparator;

function isSeparator(entry: DropdownMenuEntry): entry is DropdownMenuSeparator {
  return 'type' in entry && entry.type === 'separator';
}

/** Collapse runs of separators into one and drop leading/trailing ones.
 *  Menus often build entries like `[…, sep, ...maybeEmptyGroup, sep, delete]`
 *  where a conditionally-empty group (e.g. "Move to folder…" with no folders)
 *  leaves two separators adjacent — rendering a double divider. Normalizing
 *  here fixes it for EVERY menu in one place. */
export function normalizeSeparators(items: DropdownMenuEntry[]): DropdownMenuEntry[] {
  const out: DropdownMenuEntry[] = [];
  for (const entry of items) {
    // Skip a separator that would be leading or directly follow another.
    if (isSeparator(entry) && (out.length === 0 || isSeparator(out[out.length - 1]))) continue;
    out.push(entry);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop(); // drop trailing
  return out;
}

interface DropdownMenuProps {
  isOpen: boolean;
  onClose: () => void;
  items: DropdownMenuEntry[];
  /** Anchor element for positioning. Optional when `anchorPoint` is given. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Viewport-coordinate anchor POINT (e.g. a right-click cursor position).
   *  When set, positioning uses this 0×0 point INSTEAD of anchorRef's rect.
   *  Pass raw clientX/clientY — the menu portals to document.body, so the
   *  coords are never re-based by a transformed/will-change ancestor the
   *  way a `position: fixed` virtual-anchor div inside a panel is (the
   *  left panels carry `willChange: 'transform'`, which makes them the
   *  containing block for fixed descendants and shifted context menus by
   *  the panel's own top/left). */
  anchorPoint?: { x: number; y: number } | null;
  /** Position relative to anchor. `right-start` opens BESIDE the anchor
   *  (to its right, top edges aligned) instead of below it. */
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'right-start';
  /** Minimum width */
  minWidth?: number;
  /** Hover style: 'accent' (blue highlight, like context menu) or 'subtle' (gray) */
  hoverStyle?: 'accent' | 'subtle';
  /** Render a "Type to search…" row at the top of the ROOT menu. Typing
   *  opens a results flyout to the right combining every matching leaf
   *  from the whole submenu tree; hovering a real item swaps the flyout
   *  for that item's normal submenu. Submenus never get the search row. */
  searchable?: boolean;
}

/** Recursively collect ENABLED leaf items (no submenu) whose label matches
 *  the query, depth-first so results follow the menu's visual order.
 *  Exported for tests. */
export function collectMatchingLeaves(
  entries: DropdownMenuEntry[],
  query: string,
  out: DropdownMenuItem[] = [],
  seen: Set<string> = new Set(),
): DropdownMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return out;
  for (const entry of entries) {
    if (isSeparator(entry)) continue;
    if (entry.submenuItems && entry.submenuItems.length > 0) {
      collectMatchingLeaves(entry.submenuItems, query, out, seen);
      continue;
    }
    if (entry.disabled || seen.has(entry.id)) continue;
    if (entry.label.toLowerCase().includes(q)) {
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

// ─── Position helpers ──────────────────────────────────────────────────────

const VIEWPORT_PADDING = 8;
const SUBMENU_GAP = 10;
const ESTIMATED_ITEM_HEIGHT = 32;

/** Pick (x, y) for a submenu opening to the right of `parentRect`,
 *  flipping left when there's no room. Top-aligned with the parent item;
 *  shifts upward if the submenu would overflow the viewport bottom. */
function chooseSubmenuPosition(
  parentRect: DOMRect,
  panelWidth: number,
  itemCount: number,
): { left: number; top: number } {
  const panelHeight = Math.min(itemCount * ESTIMATED_ITEM_HEIGHT + 16, 360);

  // X: prefer right of the parent item, fall back to left.
  let left = parentRect.right + SUBMENU_GAP;
  if (left + panelWidth > window.innerWidth - VIEWPORT_PADDING) {
    left = parentRect.left - panelWidth - SUBMENU_GAP;
  }
  if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;

  // Y: top-align with the parent item, flip up if it would overflow.
  let top = parentRect.top;
  if (top + panelHeight > window.innerHeight - VIEWPORT_PADDING) {
    top = parentRect.bottom - panelHeight;
  }
  if (top < VIEWPORT_PADDING) top = VIEWPORT_PADDING;

  return { left, top };
}

// ─── Inner renderer (shared between root menu + submenus) ──────────────────

interface MenuPanelProps {
  items: DropdownMenuEntry[];
  hoverStyle: 'accent' | 'subtle';
  minWidth?: number;
  onClose: () => void;
  /** Inline style for absolute/fixed placement. */
  style: React.CSSProperties;
  /** Optional ref forwarded to the root panel `<div>` so the parent
   *  can measure it for viewport clamping. Submenus don't supply
   *  this — they self-position via `chooseSubmenuPosition`. */
  rootRef?: React.RefObject<HTMLDivElement | null>;
  /** Root menu only — renders the "Type to search…" row. */
  searchable?: boolean;
}

/** Sentinel `openSubId` value for the search-results flyout. It shares the
 *  one-submenu-at-a-time slot with real item submenus, which gives the
 *  desired interplay for free: hovering a real item replaces the results
 *  flyout with that item's normal submenu. */
const SEARCH_SUB_ID = '__search__';

function MenuPanel({ items, hoverStyle, minWidth, onClose, style, rootRef, searchable }: MenuPanelProps) {
  // Track which item's submenu is currently shown (one at a time). Set
  // on hover-enter, cleared when hovering a sibling item that has no
  // submenu. Submenu portal manages its own outside-click via this same
  // root onClose, so closing the root cascades down.
  const [openSubId, setOpenSubId] = useState<string | null>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // ── Search (root menu only) ──
  // The flyout opens ONLY on a query CHANGE (type or delete a letter) —
  // re-focusing the input alone never reopens it; the user has to alter
  // the text. State resets naturally on menu close (panel unmounts).
  const [query, setQuery] = useState('');
  // Anchor the results flyout to the PANEL (not the search row): the row
  // sits below the panel's top padding, so row-anchoring rendered the
  // flyout slightly lower than the menu. Panel-anchoring top-aligns both.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchResults = useMemo(
    () => (searchable && query.trim() ? collectMatchingLeaves(items, query) : []),
    [searchable, items, query],
  );

  const itemHoverClass = hoverStyle === 'accent'
    ? 'hover:bg-[var(--accent)] hover:text-white'
    : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]';

  return (
    <div
      ref={(el) => {
        panelRef.current = el;
        if (rootRef) rootRef.current = el;
      }}
      className="fixed bg-[var(--dropdown-bg,var(--bg-surface))] shadow-[var(--shadow-lg,0_4px_24px_rgba(0,0,0,0.3))] rounded-[var(--radius-md,8px)]"
      style={{
        ...style,
        minWidth,
        whiteSpace: 'nowrap',
        zIndex: 99998,
        display: 'flex',
        flexDirection: 'column',
        rowGap: 2,
        paddingTop: 8,
        paddingBottom: 8,
      }}
    >
      {searchable && (
        <>
          <div className="flex items-center gap-2 mx-1.5 px-2 h-8">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={(e) => {
                const v = e.target.value;
                setQuery(v);
                // Open/refresh the flyout on every text CHANGE; clearing
                // the field closes it. Focus alone never opens it.
                setOpenSubId(v.trim() ? SEARCH_SUB_ID : null);
              }}
              placeholder="Type to search..."
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs font-medium text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </div>
          <div className="h-px bg-white/10 mx-2 my-1" />
        </>
      )}

      {/* Search-results flyout — combined matching leaves from the whole
          tree, anchored beside the search row like a regular submenu.
          Leaving its panel is a no-op (it closes only via a real item
          hover, clearing the query, or closing the menu). */}
      {searchable && openSubId === SEARCH_SUB_ID && searchResults.length > 0 && createPortal(
        <CascadingSubmenu
          parentEl={panelRef.current}
          items={searchResults}
          hoverStyle={hoverStyle}
          onClose={onClose}
          onMouseLeavePanel={() => {}}
        />,
        document.body,
      )}

      {normalizeSeparators(items).map((entry, i) => {
        if (isSeparator(entry)) {
          return <div key={`sep-${i}`} className="h-px bg-white/10 mx-2 my-1" />;
        }

        const hasSubmenu = (entry.submenuItems && entry.submenuItems.length > 0) || entry.hasSubmenu;
        const isOpen = openSubId === entry.id;

        return (
          <div key={entry.id} className="relative">
            <button
              ref={(el) => {
                if (el) itemRefs.current.set(entry.id, el);
                else itemRefs.current.delete(entry.id);
              }}
              onMouseEnter={() => {
                // Hovering an item with a submenu opens it; hovering a
                // leaf item closes any sibling's submenu so only one is
                // ever visible at a time. Disabled items neither open
                // their submenu nor close the currently-open sibling
                // submenu — same drop-through behaviour the native
                // disabled HTML attribute gives for clicks.
                if (entry.disabled) return;
                if (entry.submenuItems && entry.submenuItems.length > 0) {
                  setOpenSubId(entry.id);
                } else {
                  setOpenSubId(null);
                }
              }}
              onClick={(e) => {
                // React synthetic events bubble through the React tree
                // (not the DOM tree) — so a click in this portaled menu
                // would otherwise fire the host row's `onClick={onEdit}`
                // and open the component editor on top of running the
                // menu action. Stop the propagation explicitly so menu
                // clicks stay scoped to the item.
                e.stopPropagation();
                // Parent items (those with a submenu) don't fire onClick
                // — the submenu opens on hover and the user clicks a leaf
                // inside it. Skipping the click here also prevents an
                // accidental tap from collapsing the cascade.
                if (entry.submenuItems && entry.submenuItems.length > 0) return;
                entry.onClick();
                if (!entry.keepOpen) onClose();
              }}
              disabled={entry.disabled}
              className={`
                group flex items-center gap-3 mx-1.5 px-2 h-8
                w-[calc(100%-12px)] rounded-[var(--radius-sm,4px)]
                text-xs
                ${entry.disabled
                  // Disabled items: no hover, no pointer, no
                  // open-state highlight — just greyed-out text.
                  // (Tailwind's `hover:` selector still fires on
                  // disabled buttons, so we have to OMIT the hover
                  // classes entirely rather than rely on `disabled:`.)
                  ? 'opacity-40 cursor-default text-[var(--text-primary)]'
                  : entry.danger
                    ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300 cursor-pointer'
                    : `text-[var(--text-primary)] ${itemHoverClass} cursor-pointer`
                }
                ${isOpen && !entry.danger && !entry.disabled
                  ? (hoverStyle === 'accent' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)]')
                  : ''
                }
              `}
            >
              {entry.icon && <span className="shrink-0 w-4 flex items-center justify-center opacity-80 group-hover:opacity-100">{entry.icon}</span>}
              <span className="flex-1 text-left font-medium">{entry.label}</span>
              {entry.trailingIcon && <span className="shrink-0 w-4 flex items-center justify-center opacity-90 group-hover:opacity-100">{entry.trailingIcon}</span>}
              {entry.shortcut && <span className="text-[10px] text-[var(--text-secondary)] group-hover:text-white/70">{entry.shortcut}</span>}
              {hasSubmenu && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70 group-hover:opacity-100">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>

            {/* Cascading submenu — portal'd separately so it can escape
                any parent panel's clipping or scroll behaviour. */}
            {entry.submenuItems && entry.submenuItems.length > 0 && isOpen && createPortal(
              <CascadingSubmenu
                parentEl={itemRefs.current.get(entry.id) ?? null}
                items={entry.submenuItems}
                hoverStyle={hoverStyle}
                onClose={onClose}
                onMouseLeavePanel={() => setOpenSubId(null)}
              />,
              document.body,
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Cascading submenu wrapper — measures + recurses ───────────────────────

interface CascadingSubmenuProps {
  parentEl: HTMLElement | null;
  items: DropdownMenuEntry[];
  hoverStyle: 'accent' | 'subtle';
  onClose: () => void;
  /** Callback when the cursor leaves the submenu without entering another
   *  item — lets the parent close this submenu so a different sibling's
   *  submenu can open. */
  onMouseLeavePanel: () => void;
}

function CascadingSubmenu({ parentEl, items, hoverStyle, onClose, onMouseLeavePanel }: CascadingSubmenuProps) {
  const parentRect = parentEl?.getBoundingClientRect();
  if (!parentRect) return null;
  const SUB_WIDTH = 200;
  const { left, top } = chooseSubmenuPosition(parentRect, SUB_WIDTH, items.filter(i => !isSeparator(i)).length);

  // Hover bridge — when the user moves the cursor from the parent item to
  // the submenu, the SUBMENU_GAP (~10 px) of empty space between the two
  // panels triggers `onMouseLeave` on the parent or fails to land on the
  // submenu, closing the cascade before the user can reach an item in it.
  // We render an invisible div spanning that gap *as a child of the
  // submenu wrapper* so the cursor stays inside the submenu's hit zone
  // while traversing the gap. Same trick most native menus (macOS,
  // Photoshop, Figma) use.
  return (
    <div
      data-cascading-menu
      onMouseLeave={onMouseLeavePanel}
      style={{ position: 'fixed', left, top, zIndex: 99999 }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          // Push the bridge to span from just past the parent's right edge
          // up to the submenu's left edge. SUBMENU_GAP + a small overlap so
          // sub-pixel rounding doesn't leave a 1 px crack.
          left: -(SUBMENU_GAP + 2),
          top: 0,
          width: SUBMENU_GAP + 4,
          // Match the submenu's full vertical extent. Estimate via item
          // count + padding (matches `chooseSubmenuPosition`'s heuristic);
          // exact pixel-perfect height isn't needed — slight overshoot is
          // fine, the bridge just has to cover the typical cursor path.
          height: Math.min(items.filter(i => !isSeparator(i)).length * ESTIMATED_ITEM_HEIGHT + 16, 360),
        }}
      />
      <MenuPanel
        items={items}
        hoverStyle={hoverStyle}
        minWidth={SUB_WIDTH}
        onClose={onClose}
        style={{ position: 'static' }}
      />
    </div>
  );
}

// ─── Root component ────────────────────────────────────────────────────────

export default function DropdownMenu({
  isOpen, onClose, items, anchorRef, anchorPoint,
  position = 'bottom-right', minWidth,
  hoverStyle = 'accent', searchable,
}: DropdownMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click — covers BOTH the root menu and any open
  // submenus. The submenu portals are siblings (under document.body) so
  // we check `closest('[data-cascading-menu]')` to see if the click hit
  // any menu surface; otherwise close.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-cascading-menu]')) return;
      if (anchorRef?.current && anchorRef.current.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose, anchorRef]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, onClose]);

  // Two-phase positioning so the menu never flashes off-screen on
  // anchors near the viewport edge.
  //
  //   1. First paint: render the panel off-screen (top/left = -9999)
  //      so the layout has measurable dimensions but the user doesn't
  //      see a flash at the wrong place.
  //   2. useLayoutEffect: measure the rendered panel + the anchor,
  //      compute the desired position from the `position` prop, then
  //      clamp/flip against the viewport (same rules
  //      `chooseSubmenuPosition` uses for submenus). Setting state
  //      schedules a synchronous repaint before the browser draws so
  //      the user sees only the clamped position.
  //
  // The clamp prefers flipping to the opposite side over shifting
  // (e.g. anchor near bottom + position='bottom-*' → flip to render
  // ABOVE the anchor) before falling back to a viewport-edge shift.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!isOpen) { setPos(null); return; }
    // A coordinate anchorPoint (cursor context menus) wins over the DOM
    // anchor: element rects are viewport-true, but a virtual fixed-position
    // anchor DIV can be re-based by a will-change/transform ancestor, so
    // consumers pass the raw cursor coords instead of a DOM proxy.
    const anchor = anchorPoint
      ? { left: anchorPoint.x, right: anchorPoint.x, top: anchorPoint.y, bottom: anchorPoint.y }
      : anchorRef?.current?.getBoundingClientRect();
    const panel = measureRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;

    const PAD = VIEWPORT_PADDING;
    const GAP = 4;
    const w = panel.width;
    const h = panel.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Desired position from the prop.
    let left: number;
    let top: number;
    if (position === 'right-start') {
      // Open BESIDE the anchor — top edges aligned. Flip to the left
      // side of the anchor if the panel would overflow the viewport.
      top = anchor.top;
      left = anchor.right + GAP;
      if (left + w > vw - PAD) left = anchor.left - w - GAP;
    } else {
      // Right/left names a horizontal EDGE alignment ("right" = right
      // edge of panel aligns with right edge of anchor); top/bottom
      // names which side of the anchor the panel sits on.
      left = position.includes('right') ? anchor.right - w : anchor.left;
      top  = position.includes('top')   ? anchor.top - h - GAP : anchor.bottom + GAP;
    }

    // Vertical clamp — prefer flipping to the opposite side first.
    if (top + h > vh - PAD) {
      // Overflowing bottom — try above the anchor.
      const flipped = anchor.top - h - GAP;
      top = flipped >= PAD ? flipped : Math.max(PAD, vh - PAD - h);
    }
    if (top < PAD) top = PAD;

    // Horizontal clamp — flip alignment, then shift if still
    // overflowing. Both the right→left flip and the left→right shift
    // are bounded so the panel always lands fully inside the viewport
    // when it fits at all.
    if (left + w > vw - PAD) {
      const flipped = anchor.right - w;            // try aligning to anchor.right
      left = flipped >= PAD ? flipped : vw - PAD - w;
    }
    if (left < PAD) left = PAD;

    setPos({ left, top });
  }, [isOpen, position, anchorRef, anchorPoint, items]);

  if (!isOpen) return null;

  // Phase-1 render uses a -9999 placement so the panel can be measured
  // without a visible flash. `pos` switches to the clamped values once
  // the layout effect runs.
  const style: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div ref={rootRef} data-cascading-menu>
      {/* Invisible full-screen click-catcher → context-menu behavior: a click
          anywhere outside the panel ONLY closes the menu, it does NOT also
          select a canvas node / another row / clear selection.
          CRITICAL: do NOT close on mousedown. Closing there unmounts this
          backdrop mid-gesture, so the trailing mouseup+click fall through to
          (and "enter") whatever is underneath. Instead swallow the whole press
          (preventDefault + stopPropagation, backdrop stays mounted) and close
          on the COMPLETED click / contextmenu — the entire down→up→click
          sequence lands on the backdrop, so nothing below ever receives it. */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 99997 }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onMouseUp={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
      />
      <MenuPanel
        items={items}
        hoverStyle={hoverStyle}
        minWidth={minWidth}
        onClose={onClose}
        style={style}
        rootRef={measureRef}
        searchable={searchable}
      />
    </div>,
    document.body,
  );
}
