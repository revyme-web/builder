// ToolRow.tsx — Single control row on the shared two-column grid:
//   grid-template-columns: var(--tool-label-col) minmax(0, 1fr)
//   ├── label cell (min-w-0, truncation; chevron overlays absolutely
//   │   inside the cell — negative margins only extend hit areas and
//   │   can no longer change the value column's width)
//   └── value cell (exactly the remaining width, flush right)
//
// Value-cell composition contract:
//   - children sit in a flex row (gap-2, width 100%)
//   - exactly ONE primary control per row takes `flex-1 min-w-0`
//   - adornments (unit toggle, ±, ×, expand, chevron) are fixed-width slots
//   - nothing inside the value cell sets its own outer margin

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHoistMenuItem } from './hoist-context';
import ControlLabel from './ControlLabel';

interface Props {
  label: string;
  children: React.ReactNode;
  labelStyle?: React.CSSProperties;
  /** When set, clicking the label shows a "Reset Override" menu item */
  onResetOverride?: () => void;
  /** Extra label-menu items (e.g. Localize) — presence delegates the label to
   *  the canonical ControlLabel, same as design-prop rows. */
  extraMenuItems?: import('./control-menu-items').MenuItem[];
  /** Accent (blue) label independent of labelStyle — override indicator. */
  overridden?: boolean;
  /** Ellipsize a too-long label (single line) instead of letting it wrap /
   *  overflow into the value control. Used for arbitrary-length labels like
   *  template-variable names (`ejorigjerghositedvar`). */
  truncateLabel?: boolean;
}

export default function ToolRow({ label, children, labelStyle, onResetOverride, truncateLabel, extraMenuItems, overridden }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const labelRef = useRef<HTMLButtonElement>(null);

  // Ambient "Hoist Variable" item — set by `<HoistMenuItemProvider>` above
  // (ComponentPropsTool wraps each Code component/code-component control row with one
  // when the active file is a component master). Surfacing it here gives
  // Code component controls (Intensity, Grain Scale, …) the same chevron menu the
  // design-component prop rows already have — so a code component dropped
  // inside a master can hoist its controls into the master's props. Null
  // everywhere else, so non-master ToolRows stay plain (zero blast radius).
  const hoistItem = useHoistMenuItem();

  // When a hoist item is present we delegate the label to the canonical
  // `ControlLabel` — it reads the SAME `useHoistMenuItem()` context, merges
  // the item into its proper portal menu (correct gap / z-index / design,
  // matching every other property menu), and hides the standard
  // style-specific items. The bespoke menu below is then only used for the
  // `onResetOverride` (responsive-override) case on non-hoist rows.
  // Locale-capable rows (extraMenuItems / overridden) use the canonical
  // ControlLabel too — same menu design + Localize entry as design-prop rows.
  const useControlLabel = !!hoistItem || !!extraMenuItems?.length || !!overridden;
  const hasMenu = !!onResetOverride && !useControlLabel;
  const isOverride = !!labelStyle?.color || !!overridden; // blue label = has override

  const openMenu = useCallback(() => {
    if (!hasMenu || !labelRef.current) return;
    const rect = labelRef.current.getBoundingClientRect();
    // Match ControlLabel's chevron-menu geometry: 180px wide, 16px gap, open
    // to the LEFT of the label (clear of the properties panel) and fall back
    // to the right / clamp inside the viewport. Keeps code-component-control menus
    // visually identical to every other property menu.
    const MENU_WIDTH = 180;
    const GAP = 16;
    const PAD = 8;
    let x = rect.left - MENU_WIDTH - GAP;
    if (x < PAD) x = rect.right + GAP;
    if (x + MENU_WIDTH > window.innerWidth - PAD) x = window.innerWidth - MENU_WIDTH - PAD;
    let y = rect.top;
    if (y + 80 > window.innerHeight - PAD) y = window.innerHeight - 100;
    if (y < PAD) y = PAD;
    setMenuPos({ x, y });
    setMenuOpen(true);
  }, [hasMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [menuOpen]);

  return (
    <div data-tool-row className="grid grid-cols-[var(--tool-label-col)_minmax(0,1fr)] items-center w-full">
      {useControlLabel ? (
        // Canonical label + chevron menu (the hoist item is merged in via the
        // shared HoistMenuItem context). `property=""` because Code component controls
        // map to no CSS property — the menu shows only the injected item.
        <ControlLabel label={label} property="" cell hideLocalize plain={false}
          extraMenuItems={extraMenuItems} overridden={overridden} onResetOverride={useControlLabel ? onResetOverride : undefined} />
      ) : (
        // `pl-[18px] -ml-[18px]` extends the chevron hit-area into the panel's
        // left padding. On the grid this is a pure overlay — the label track is
        // fixed by --tool-label-col, so negative margins can't shift the value
        // column (the old flex layout needed an extra mr-[2px] shim for that).
        <div className="min-w-0 select-none pl-[18px] -ml-[18px]">
          {hasMenu ? (
            <button
              ref={labelRef}
              onClick={openMenu}
              className="group relative text-left cursor-pointer w-full"
            >
              {/* Left chevron */}
              <span className="absolute -left-[14px] top-1/2 -translate-y-1/2 text-[var(--text-secondary)] group-hover:text-[var(--accent)] transition-all duration-200 group-hover:-translate-x-0.5">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </span>
              <span
                className={`text-xs font-bold transition-colors ${isOverride ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'}`}
                style={!isOverride ? labelStyle : undefined}
              >
                {label}
              </span>
            </button>
          ) : (
            <span
              className={`text-xs font-bold text-[var(--text-secondary)]${truncateLabel ? ' block truncate' : ''}`}
              style={labelStyle}
              title={truncateLabel ? label : undefined}
            >
              {label}
            </span>
          )}
        </div>
      )}
      {/* `min-w-0` lets a too-wide value (e.g. a long variable-pill name) shrink +
          truncate instead of overflowing the panel. No-op when the value fits. */}
      <div data-tool-row-value className="flex items-center gap-2 w-full min-w-0">
        {children}
      </div>

      {/* Bespoke "Reset Override" menu — only used on non-hoist rows. The
          hoist case routes through ControlLabel's own portal menu above. */}
      {menuOpen && createPortal(
        <>
          <div className="fixed inset-0 z-[10000]" onClick={() => setMenuOpen(false)} />
          <div
            className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-[10001] min-w-45 border border-[var(--border-light)] space-y-0.5"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            {onResetOverride && (
              <button
                onClick={() => { onResetOverride(); setMenuOpen(false); }}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent)] transition-colors"
              >
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white">
                  Reset Override
                </span>
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
