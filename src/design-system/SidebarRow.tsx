// SidebarRow.tsx — Reusable row for sidebar lists (components, pages, layers, presets).
// Same visual design everywhere. Flexible: all behavior via props, only design is shared.
// Built-in ellipsis menu support via menuItems prop.
// Sizes: sm (compact), md (default), lg (insert panel categories).

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
} from "react";
import EllipsisMenu from "./EllipsisMenu";
import DropdownMenu, { type DropdownMenuEntry } from "./DropdownMenu";

type SidebarRowSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<
  SidebarRowSize,
  { row: string; icon: string; label: string }
> = {
  // Explicit `h-[28px]` (sm) / `h-8` (md) / `h-9` (lg) so rows are
  // pixel-identical regardless of how many spans sit inside (icon-only
  // vs chevron+icon for expandable folders, etc.). Without an explicit
  // height the row's vertical extent depends on the tallest child,
  // which can differ by 1–2 px between rows that look "the same" but
  // contain a different mix of inline elements — visible as a faint
  // height jitter between folder headers and component rows.
  sm: {
    row: "gap-1.5 px-2 h-[28px]",
    icon: "w-3.5 h-3.5",
    label: "text-[12px] font-medium",
  },
  md: {
    row: "gap-1.5 px-2 h-8",
    icon: "w-4 h-4",
    label: "text-xs font-medium",
  },
  lg: {
    row: "gap-2.5 px-2 h-9",
    icon: "w-5 h-5",
    label: "text-[13px] font-semibold",
  },
};

interface SidebarRowProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  icon: ReactNode;
  label: string;
  isActive?: boolean;
  menuItems?: DropdownMenuEntry[];
  right?: ReactNode;
  indent?: number;
  iconColor?: string;
  size?: SidebarRowSize;
  /** Optional element rendered BEFORE the icon, with the same gap the row
   *  uses between icon and label. Lets a consumer add a chevron without
   *  squishing it into the fixed-width icon slot. Used by the Pages
   *  panel for A/B-variant parent rows where both the chevron AND the
   *  page icon need to be visible. */
  prefixSlot?: ReactNode;
  /** Render an expand/collapse chevron before the icon. Used by folder
   *  rows in the Library panel (Project / creator-named groups). When
   *  `expanded` is true the chevron points down; false → right. The
   *  click toggle should be wired by the consumer through the row's
   *  `onClick` — the chevron itself isn't a separate button so the
   *  whole row toggles when clicked. */
  expandable?: { expanded: boolean };
  /** When set, the row swaps its label for an inline `<input>` pre-filled
   *  with `inlineEdit.initialValue`. Pressing Enter / clicking outside fires
   *  `onCommit(value)`; Escape fires `onCommit(initialValue)` (no-op).
   *  Mirrors the LayersPanel rename UX. */
  inlineEdit?: {
    initialValue: string;
    onCommit: (newValue: string) => void;
  };
}

const SidebarRow = forwardRef<HTMLDivElement, SidebarRowProps>(
  (
    {
      icon,
      label,
      isActive = false,
      menuItems,
      right,
      indent = 0,
      iconColor = "var(--accent-secondary, #a78bfa)",
      size = "sm",
      className = "",
      onContextMenu: userContextMenu,
      inlineEdit,
      expandable,
      prefixSlot,
      ...props
    },
    ref
  ) => {
    const s = SIZE_CLASSES[size];

    // Right-click opens the SAME menu list as the ellipsis dots, but
    // anchored at the cursor instead of the dots button. The cursor coords
    // are passed to DropdownMenu as a pure `anchorPoint` — NEVER as a
    // `position: fixed` virtual anchor div inside the row: the left panels
    // carry `willChange: 'transform'` (compositor-layer perf), which makes
    // the panel the CONTAINING BLOCK for fixed descendants, so a fixed
    // anchor at (clientX, clientY) actually painted at panel-origin +
    // cursor and the context menu opened ~52px down-right of the mouse.
    // DropdownMenu portals to document.body, so raw client coords are
    // viewport-true there. Two DropdownMenu instances (this one + the
    // EllipsisMenu's internal one) share the same items array — they're
    // independent state-wise but reuse the same actions.
    const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
    const menuOpen = cursorPos !== null;

    const handleContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
      if (menuItems && menuItems.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setCursorPos({ x: e.clientX, y: e.clientY });
      }
      userContextMenu?.(e);
    }, [menuItems, userContextMenu]);

    const handleCloseContextMenu = useCallback(() => {
      setCursorPos(null);
    }, []);

    return (
      <div
        ref={ref}
        className={`
        group flex items-center ${s.row} cut-corners transition-colors select-none
        ${
          isActive
            ? "bg-[var(--btn-secondary-bg)] text-[var(--text-primary)]"
            : menuOpen
              // Right-clicked row keeps the hover highlight while ITS context
              // menu is open (the cursor has left the row for the menu, so
              // :hover is gone) — makes clear which row the menu acts on.
              ? "bg-[var(--bg-hover)] text-[var(--text-secondary)]"
              : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
        }
        ${className}
      `.trim()}
        style={indent > 0 ? { paddingLeft: 8 + indent * 16 } : undefined}
        onContextMenu={handleContextMenu}
        {...props}
      >
        {expandable && (
          <span
            className={`shrink-0 flex items-center justify-center ${s.icon}`}
            aria-hidden="true"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: expandable.expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms",
              }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        )}
        {prefixSlot && (
          <span className="shrink-0 flex items-center justify-center">
            {prefixSlot}
          </span>
        )}
        <span
          className={`shrink-0 flex items-center justify-center ${s.icon}`}
          style={{ color: iconColor }}
        >
          {icon}
        </span>
        {inlineEdit ? (
          <SidebarRowRenameInput
            initialValue={inlineEdit.initialValue}
            onCommit={inlineEdit.onCommit}
            className={`flex-1 min-w-0 ${s.label}`}
          />
        ) : (
          <span className={`flex-1 min-w-0 ${s.label} truncate`}>{label}</span>
        )}
        {right}
        {menuItems && menuItems.length > 0 && (
          <>
            <EllipsisMenu items={menuItems} />
            <DropdownMenu
              isOpen={menuOpen}
              onClose={handleCloseContextMenu}
              items={menuItems}
              anchorPoint={cursorPos}
              position="bottom-left"
            />
          </>
        )}
      </div>
    );
  }
);

SidebarRow.displayName = "SidebarRow";

// ─── Inline rename input ────────────────────────────────────────────────────
// Mirrors the LayersPanel `RenameInput` UX so component / page / preset
// rename feels identical everywhere it's offered. Auto-focuses + selects
// on mount; commits on Enter or blur; cancels on Escape (commits the
// original value, which the caller can detect as a no-op since it equals
// `initialValue`).
//
// The 100 ms timeout before enabling `active` is the same workaround
// LayersPanel uses: focusing IMMEDIATELY in a layout-effect causes the
// triggering click's blur to fire on the just-mounted input, killing
// rename mode before the user types anything. Deferring focus past the
// click event's natural completion sidesteps that.
function SidebarRowRenameInput({
  initialValue,
  onCommit,
  className,
}: {
  initialValue: string;
  onCommit: (val: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    const t = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
        setActive(true);
      }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  const finish = (val: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommitRef.current(val.trim() || initialValue);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => { e.stopPropagation(); setValue(e.target.value); }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(initialValue);
      }}
      onBlur={() => { if (active) finish(value); }}
      className={`bg-white text-black border-0 outline-none px-1 py-0.5 rounded ${className ?? ""}`}
      style={{ minWidth: 40 }}
    />
  );
}

export default SidebarRow;
