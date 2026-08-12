// SelectIconPopup.tsx — compact iconify search for the select caret icon.
//
// A slimmed-down reuse of the Insert ▸ Icons panel's search: one input hitting
// `api.iconify.design/search` across every collection, a flat results grid,
// click to apply. No packs drill-in, no drag — the pick writes straight onto
// the selected <select> (see select-icon.ts). The Color row re-bakes the
// already-picked icon's data URI.

import { useState, useEffect } from 'react';
import { ToolRow, ToolInput } from '../../controls';
import ColorInput from '../../controls/ColorInput';
import { getIconFilter, isColorfulIcon, useIsDarkMode } from '../../left-toolbar/panels/insert/IconPanel';
import type { SelectIconSpec } from './select-icon';
import { DEFAULT_SELECT_ICON_COLOR } from './select-icon';
import { trace } from '@/shared/debug-trace';

const RESULT_LIMIT = 96;

export default function SelectIconPopup({ current, onPick, onColor, onColorLive }: {
  current: SelectIconSpec | null;
  onPick: (iconName: string) => void;
  /** Commit — fires once on pointer-up. */
  onColor: (color: string) => void;
  /** Per-frame drag channel — MUST stay cheap (DOM-only canvas CSS patch).
   *  Without it ColorInput routes every drag frame into `onColor`, i.e. a
   *  full mutation flush + re-parse + canvas render per frame — the exact
   *  slideshow this popup shipped with (user report 2026-08-12). */
  onColorLive: (color: string) => void;
}) {
  // Carets are the whole point of this picker — seed the search so the first
  // paint is already a wall of usable chevrons.
  const [query, setQuery] = useState('chevron down');
  const [icons, setIcons] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const isDark = useIsDarkMode();

  useEffect(() => {
    const q = query.trim();
    if (!q) { setIcons([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${RESULT_LIMIT}`);
        const data = await res.json();
        if (!cancelled) setIcons(Array.isArray(data?.icons) ? data.icons : []);
      } catch (err) {
        trace.error('select-icon-popup:search-failed', { error: String(err) });
        if (!cancelled) setIcons([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  return (
    <div className="flex flex-col gap-2 p-1">
      <ToolRow label="Search">
        <ToolInput value={query} onChange={setQuery} placeholder="chevron, caret, arrow…" text />
      </ToolRow>
      <div className="grid grid-cols-6 gap-1 max-h-[168px] overflow-y-auto rounded-[var(--radius-md)] p-1"
        style={{ backgroundColor: 'var(--grid-line)' }}>
        {icons.map((icon) => (
          <button
            key={icon}
            type="button"
            title={icon}
            onClick={() => onPick(icon)}
            className="flex items-center justify-center w-7 h-7 rounded cursor-pointer border-none bg-transparent hover:!bg-[var(--accent)]"
            style={current?.icon === icon ? { backgroundColor: 'var(--accent)' } : undefined}
          >
            <img
              src={`https://api.iconify.design/${icon}.svg`}
              alt={icon}
              width={18}
              height={18}
              loading="lazy"
              style={{ filter: getIconFilter(isColorfulIcon(icon), isDark) }}
            />
          </button>
        ))}
        {!loading && icons.length === 0 && (
          <div className="col-span-6 py-3 text-center text-xs text-[var(--text-secondary)]">No icons found</div>
        )}
      </div>
      <ToolRow label="Color">
        <ColorInput
          value={current?.color ?? DEFAULT_SELECT_ICON_COLOR}
          empty={!current}
          showAlpha
          onChange={onColor}
          onChangeLive={onColorLive}
        />
      </ToolRow>
    </div>
  );
}
