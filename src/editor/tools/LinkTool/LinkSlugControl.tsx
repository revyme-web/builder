// LinkSlugControl — CMS detail-page link slug control for the Link tool.
//
// Two ways to drive the link, mirroring the reference's "Slug" control:
//   - LITERAL — a text input with an autocomplete dropdown of the
//     collection's item slugs; picking one links to that exact item.
//   - VARIABLE — the "Slug" ControlLabel's dropdown carries a "Set
//     Variable" submenu (Current / Previous / Next). Picking one binds
//     the link to that item and the control becomes a blue chip with ✕.

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { ControlLabel } from '../../controls';
import type { MenuItem } from '../../controls/control-menu-items';
import { collectionDataAtom } from '@/code/stores/cms-store';
import { trace } from '@/shared/debug-trace';

// `'row'` binds the link's href to the CURRENT row's item slug when the
// element lives inside a `.map((item) => …)` over a CMS collection — the
// same shape as `'self'` on a detail page, just resolved from the map's
// iterator variable instead of `params.slug`. So each rendered row links
// to its own detail page.
export type CmsNavMode = 'none' | 'self' | 'prev' | 'next' | 'row';

const MODE_LABEL: Record<'self' | 'prev' | 'next' | 'row', string> = {
  self: 'Current',
  prev: '← Previous',
  next: 'Next →',
  row: 'This Row',
};

/**
 * Which variable options to surface in the "Set Variable" submenu.
 *   - 'detail' — Current / Previous / Next (only valid on a detail page
 *     where `params.slug` exists).
 *   - 'row'    — "This Row" (only valid inside a CMS `.map()` template
 *     where the iterator variable is in scope).
 *   - 'both'   — Both groups (rare — when a detail page itself contains
 *     a CMS map, e.g. a "related posts" widget inline).
 */
// 'none' → literal slug picker ONLY (no "Set Variable"/"This Row"). Used when
// the link targets a DIFFERENT collection than the one the element lives in —
// e.g. an advisor card linking to `/blog/:slug`: "This Row" (= this advisor's
// own slug) is meaningless against a blog route, so only a literal blog item
// can be picked.
export type SlugVariantContext = 'detail' | 'row' | 'both' | 'none';

export default function LinkSlugControl({
  navMode, literalSlug, collection, variantContext, onNavModeChange, onLiteralSlugChange,
}: {
  navMode: CmsNavMode;
  literalSlug: string;
  collection: string;
  /** Which "Set Variable" options to show — depends on whether the
   *  selection lives on a detail page, inside a CMS map, or both. */
  variantContext: SlugVariantContext;
  onNavModeChange: (mode: CmsNavMode) => void;
  onLiteralSlugChange: (slug: string) => void;
}) {
  const bound = navMode !== 'none';
  const allData = useAtomValue(collectionDataAtom);
  const slugs = useMemo(
    () => (allData.get(collection) ?? []).map(i => i._slug).filter(Boolean) as string[],
    [allData, collection],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(literalSlug);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The autocomplete is PORTALED to <body> (position: fixed) so it escapes the
  // Link popup's clipping/stacking context — an `absolute` menu was cut off by
  // the ToolPopup. Position measured from the input's rect.
  const [menuPos, setMenuPos] = useState<{ left: number; width: number; placeAbove: boolean; maxHeight: number; top?: number; bottom?: number } | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const recalcMenuPos = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const PAD = 8;
    const EST_H = 200; // max-h-48 list + padding
    const spaceBelow = window.innerHeight - r.bottom - PAD;
    const spaceAbove = r.top - PAD;
    const placeAbove = spaceBelow < EST_H && spaceAbove > spaceBelow;
    setMenuPos({
      left: r.left, width: r.width, placeAbove,
      maxHeight: Math.max(100, Math.min(EST_H, placeAbove ? spaceAbove : spaceBelow)),
      top: placeAbove ? undefined : r.bottom + 4,
      bottom: placeAbove ? window.innerHeight - r.top + 4 : undefined,
    });
  }, []);
  // Fade-in on open (cleared on close so it re-fades).
  useEffect(() => {
    if (!open) { setMenuVisible(false); return; }
    const id = requestAnimationFrame(() => setMenuVisible(true));
    return () => cancelAnimationFrame(id);
  }, [open]);
  trace.fn('LinkSlugControl:render', { navMode, literalSlug, slugCount: slugs.length });

  // Re-sync the input when the underlying literal changes (file switch /
  // external edit / cleared by a variable bind).
  useEffect(() => { setQuery(literalSlug); }, [literalSlug]);

  // Close on outside click (the portaled menu is OUTSIDE wrapRef, so check it
  // too) + keep the portal glued to the input as the panel/page scrolls.
  useEffect(() => {
    if (!open) return;
    recalcMenuPos();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', recalcMenuPos, true);
    window.addEventListener('resize', recalcMenuPos);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', recalcMenuPos, true);
      window.removeEventListener('resize', recalcMenuPos);
    };
  }, [open, recalcMenuPos]);

  // "Set Variable" submenu injected into the Slug ControlLabel's dropdown.
  // The available variables depend on context: "Current / Previous / Next"
  // only make sense on a detail page (where `params.slug` exists), and
  // "This Row" only makes sense inside a CMS map (where the iterator
  // variable is in scope). Both at once is rare but supported.
  // 'none' → no variable options at all (literal pick only); the "Set Variable"
  // chevron is suppressed entirely (ControlLabel rendered `plain` below).
  const hasVarOptions = variantContext !== 'none';
  const extraMenuItems: MenuItem[] = useMemo(() => {
    if (!hasVarOptions) return [];
    const items: MenuItem['submenuItems'] = [];
    if (variantContext === 'row' || variantContext === 'both') {
      items!.push({ label: 'This Row', show: true, onClick: () => onNavModeChange('row') });
    }
    if (variantContext === 'detail' || variantContext === 'both') {
      items!.push({ label: 'Current', show: true, onClick: () => onNavModeChange('self') });
      items!.push({ label: 'Previous', show: true, onClick: () => onNavModeChange('prev') });
      items!.push({ label: 'Next', show: true, onClick: () => onNavModeChange('next') });
    }
    return [{ label: 'Set Variable', show: true, onClick: () => {}, submenuItems: items }];
  }, [onNavModeChange, variantContext, hasVarOptions]);

  const filtered = query.trim()
    ? slugs.filter(s => s.toLowerCase().includes(query.trim().toLowerCase()))
    : slugs;

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel
        label="Slug"
        property="__cms-nav"
        plain={!hasVarOptions}
        extraMenuItems={extraMenuItems}
        overridden={bound}
        hideResetStyle
        hideCreateVariable
        hideCmsBinding
        hideVariableMenu
        hideCopyPasteStyle
      />
      <div ref={wrapRef} className="relative flex items-center w-full">
        {bound ? (
          // Variable-bound — blue chip with the direction + an ✕ to clear.
          <div
            className="w-full h-7 flex items-center gap-1.5 px-2 cut-corners text-xs font-medium text-[var(--accent-fg)]"
            style={{ backgroundColor: 'var(--accent)' }}
            title="CMS navigation variable"
          >
            <span className="truncate flex-1">{MODE_LABEL[navMode as 'self' | 'prev' | 'next' | 'row']}</span>
            <span
              role="button"
              onClick={() => onNavModeChange('none')}
              title="Remove"
              className="text-[var(--accent-fg)] opacity-70 hover:opacity-100 text-sm leading-none shrink-0 cursor-pointer"
            >
              &times;
            </span>
          </div>
        ) : (
          // Literal — slug autocomplete input.
          <>
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Item slug…"
              onFocus={() => setOpen(true)}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onLiteralSlugChange(query.trim()); setOpen(false); }
                else if (e.key === 'Escape') { setOpen(false); }
              }}
              className="w-full h-[var(--control-height-sm)] px-2 text-xs bg-[var(--control-bg)] border border-[var(--control-border)] cut-corners cut-border focus:[--cut-border-color:var(--accent)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
            />
            {open && filtered.length > 0 && menuPos && createPortal(
              <div
                ref={menuRef}
                className="overflow-y-auto bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] py-1.5 space-y-0.5 transition-opacity duration-150 ease-out"
                style={{
                  position: 'fixed', left: menuPos.left, width: menuPos.width, maxHeight: menuPos.maxHeight, zIndex: 100020,
                  opacity: menuVisible ? 1 : 0,
                  ...(menuPos.placeAbove ? { bottom: menuPos.bottom } : { top: menuPos.top }),
                }}
              >
                {filtered.map(s => (
                  <button
                    key={s}
                    onMouseDown={(e) => { e.preventDefault(); onLiteralSlugChange(s); setQuery(s); setOpen(false); }}
                    className={`w-[calc(100%-12px)] mx-1.5 flex items-center px-2.5 py-1.5 text-xs font-medium cut-corners text-left cursor-pointer transition-colors ${
                      s === literalSlug
                        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>,
              document.body,
            )}
          </>
        )}
      </div>
    </div>
  );
}
