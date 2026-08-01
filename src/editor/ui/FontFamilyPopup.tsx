// FontFamilyPopup.tsx -- Font family picker using react-window v2 List.
// Opens inside a ToolPopup. Shows search, category filter, and virtualised font list.
// Each row renders the font name in its own typeface with "Aa" preview.

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react';
import { useSetAtom } from 'jotai';
import { List, useListRef, type RowComponentProps } from 'react-window';
import { fetchGoogleFonts, DEFAULT_FONTS, FEELING_CATEGORIES, type FontItem } from '@/shared/google-fonts';
import { loadGoogleFont, loadFontFromCSSValue, loadCustomFont } from '@/shared/font-loader';
import { useWorkspaceFonts, ensureWorkspaceFonts, applyWorkspaceFontToProject } from '@/code/stores/workspace-fonts-store';
import type { WorkspaceFont } from '@/backend/types';
import ToolPopup from './ToolPopup';
import { ControlLabel } from '../controls';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { trace } from '@/shared/debug-trace';

interface FontFamilyPopupProps {
  value: string;
  onChange: (family: string) => void;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Render inline (no ToolPopup wrapper) — for use inside pushPanel */
  inline?: boolean;
  /** Hover preview — called with the CSS family value when the user hovers
   *  a row, and `null` when the cursor leaves it (or when the popup
   *  closes / a font is selected). The control wires this into either a
   *  scoped `injectCanvasCSS` rule (whole-element preview) or a TipTap
   *  fontFamily write (selected-text-portion preview), then reverts on
   *  unhover so nothing commits to the user's code unless they click. */
  onPreview?: (family: string | null) => void;
}

/** Extra props passed to each row via rowProps (react-window v2 injects index+style automatically) */
interface FontRowExtraProps {
  filteredFonts: FontItem[];
  currentFontName: string;
  onSelect: (font: FontItem) => void;
  onPreview?: (family: string | null) => void;
}

/** Row component for react-window v2 */
function FontRow({ index, style, filteredFonts, currentFontName, onSelect, onPreview }: RowComponentProps<FontRowExtraProps>) {
  const font = filteredFonts[index];
  if (!font) return null;

  const isSelected = font.family === currentFontName;
  // Load font when visible in virtualised list
  loadGoogleFont(font.family);
  // Same shape the parent ends up writing on commit — keep the hover
  // preview value consistent with that so the canvas doesn't visibly
  // shift between "previewing" and "selected" for the same row.
  const cssFamily = font.category ? `${font.family}, ${font.category}` : font.family;

  return (
    <div
      style={{ ...style, padding: '2px 0' }}
      onClick={() => onSelect(font)}
      onMouseDown={e => e.stopPropagation()}
      // Only fire ENTER per row. The container below has a single
      // mouseleave that reverts the preview when the cursor truly
      // exits the popup. Per-row mouseleave + the next row's
      // mouseenter race against the async TipTap mark write — the
      // restore-from-snapshot in between can land AFTER the next
      // hover's write, leaving the canvas pinned to the original
      // value mid-hover (visible as "stays stale, doesn't change").
      // Pickers in Figma / VS Code use the same "preview persists
      // until you move OFF the picker" idiom anyway.
      onMouseEnter={() => onPreview?.(cssFamily)}
    >
      <div
        className={`flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] cursor-pointer transition-colors ${
          isSelected
            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
            : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
        }`}
        style={{ fontFamily: font.family }}
      >
        <span className="text-sm truncate">{font.family}</span>
        <span className={`text-sm flex-shrink-0 ml-2 ${isSelected ? 'text-white/70' : 'text-[var(--text-secondary)]'}`}>Aa</span>
      </div>
    </div>
  );
}

export default function FontFamilyPopup({ value, onChange, isOpen, onClose, anchorRef, inline, onPreview }: FontFamilyPopupProps) {
  const [fonts, setFonts] = useState<FontItem[]>(DEFAULT_FONTS);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [loading, setLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useListRef(null);
  const setSuppressOverlay = useSetAtom(suppressSelectionOverlayAtom);
  const workspaceFonts = useWorkspaceFonts();

  // Hide the canvas SelectionOverlay while the picker is open. Hover
  // preview rapidly mutates the selected text's font, but the overlay's
  // RAF poll lags one frame and the box border ends up overflowing /
  // undershooting the new text bounds — visible as the outline drifting
  // off the text.
  //
  // Un-suppress on close has to wait for the iframe's NEXT render to
  // complete — the commit path (`onChange` → mutation queue → flush →
  // renderer rebuild → bridge `allRects` → parent `rectCache`) is
  // asynchronous, so painting the overlay the moment `isOpen` flips false
  // would read the bridge's STALE rect (still the previous font's
  // metrics) for one frame, then snap to the correct rect on the next
  // RAF tick. The user sees this as a visible "jump". Listening for
  // `revyme:render-complete` (dispatched from `Renderer.ts` after every
  // render cycle) guarantees the rectCache is fresh before the overlay
  // re-appears. A 250ms safety timeout falls back in case the event
  // doesn't fire (e.g. user closed via Esc with no actual change).
  useEffect(() => {
    if (!isOpen) return;
    setSuppressOverlay(true);
    return () => {
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.removeEventListener('revyme:render-complete', restore);
        clearTimeout(timeout);
        setSuppressOverlay(false);
      };
      window.addEventListener('revyme:render-complete', restore);
      const timeout = setTimeout(restore, 250);
    };
  }, [isOpen, setSuppressOverlay]);

  // Fetch Google Fonts on first open
  useEffect(() => {
    if (!isOpen) return;

    if (fonts !== DEFAULT_FONTS && fonts.length > DEFAULT_FONTS.length) return; // already fetched

    setLoading(true);
    trace.action('font-popup:fetch-start', {});

    fetchGoogleFonts()
      .then(result => {
        setFonts(result);
        trace.action('font-popup:fetch-done', { count: result.length });
      })
      .finally(() => setLoading(false));
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load current font on open
  useEffect(() => {
    if (isOpen && value) loadFontFromCSSValue(value);
  }, [isOpen, value]);

  // Reset search/category when popup closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSelectedCategory('All');
    }
  }, [isOpen]);

  // Filter fonts by category + search
  const filteredFonts = useMemo(() => {
    let filtered = fonts;

    if (selectedCategory !== 'All') {
      filtered = filtered.filter(font => {
        if (!font.tags || !Array.isArray(font.tags)) return false;
        return font.tags.some(tag => {
          const tagName = typeof tag === 'string' ? tag : tag?.name;
          if (!tagName || typeof tagName !== 'string') return false;
          return tagName.toLowerCase().includes(selectedCategory.toLowerCase());
        });
      });
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(font => font.family.toLowerCase().includes(query));
    }

    return filtered;
  }, [fonts, searchQuery, selectedCategory]);

  // Fetch the workspace font library the first time the picker opens.
  useEffect(() => {
    if (isOpen) ensureWorkspaceFonts();
  }, [isOpen]);

  // Workspace fonts → one representative entry per family (prefer the
  // closest-to-Regular upright weight), search-filtered. Only shown under the
  // 'All' category since custom fonts carry no feeling tags. The faces are
  // already registered with the FontFace API (by the store) so each row paints
  // in its own typeface.
  const workspaceFamilies = useMemo(() => {
    if (selectedCategory !== 'All') return [] as WorkspaceFont[];
    const rep = new Map<string, WorkspaceFont>();
    for (const f of workspaceFonts) {
      const cur = rep.get(f.family);
      if (!cur) { rep.set(f.family, f); continue; }
      const better =
        (f.style === 'normal' && cur.style !== 'normal') ||
        (f.style === cur.style && Math.abs(f.weight - 400) < Math.abs(cur.weight - 400));
      if (better) rep.set(f.family, f);
    }
    let arr = Array.from(rep.values());
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      arr = arr.filter(f => f.family.toLowerCase().includes(q));
    }
    return arr.sort((a, b) => a.family.localeCompare(b.family));
  }, [workspaceFonts, searchQuery, selectedCategory]);

  // Current font name for highlighting. CRITICAL: frozen to the value at
  // popup-open time, NOT the live `value` prop. Why:
  //
  // In text-portion preview mode (TipTap selection active), each hover
  // writes the previewed font as a TipTap mark on the selected text.
  // That mark flows back through the snapshot atom → useTextStyles →
  // `value` prop. If we derive the highlight from the live `value`, every
  // hover makes the popup highlight a NEW row — the one the user is
  // hovering. The user perceives "I just hovered Concert One and the
  // popup says it's now selected" — clicks and hovers feel
  // indistinguishable.
  //
  // The "real" selected font (what's committed on click) is what the
  // popup OPENED with. Freeze it here so the highlight stays anchored.
  // Re-snapshot when the popup re-opens. Whole-element mode doesn't hit
  // this loop (its preview path uses injectCanvasCSS, not a value write),
  // but using the same freeze for both modes keeps the UX consistent.
  const [frozenValue, setFrozenValue] = useState<string>('');
  useEffect(() => {
    if (isOpen) setFrozenValue(value);
    else setFrozenValue('');
    // Snapshot ONLY on open transition — `value` changes during preview
    // are exactly what we want to ignore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const currentFontName = (frozenValue || value)?.split(',')[0]?.trim().replace(/['"]/g, '') || '';

  // Auto-scroll to selected font ONCE per open. Re-scrolling on every
  // `value` change drives a feedback loop with the hover-preview path:
  // hover row → preview writes new value → effect re-fires → list scrolls
  // → cursor lands on a different row → that row's onMouseEnter fires →
  // preview writes again → repeat. The user sees the popup self-scroll
  // and the canvas font cycle wildly. The guard pins scroll to "happens
  // when the popup opens / filter changes", not "happens whenever the
  // active font value changes". Reset on close so the next open scrolls
  // again to wherever the user committed last.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      didInitialScrollRef.current = false;
      return;
    }
    if (didInitialScrollRef.current) return;
    if (!listRef.current || filteredFonts.length === 0 || !value) return;

    const idx = filteredFonts.findIndex(f =>
      f.family === currentFontName || value.includes(f.family)
    );

    if (idx !== -1) {
      didInitialScrollRef.current = true;
      setTimeout(() => {
        listRef.current?.scrollToRow({ index: idx, align: 'center' });
      }, 100);
    }
    // `value` intentionally excluded from deps — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filteredFonts, currentFontName, listRef]);

  // Focus search input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  const handleFontSelect = useCallback((font: FontItem) => {
    trace.action('font-popup:select', { family: font.family, category: font.category });
    loadGoogleFont(font.family);
    const fontValue = font.category ? `${font.family}, ${font.category}` : font.family;
    // Clear any active hover preview before committing — onChange writes
    // the selected family, but the parent's preview state may still hold
    // a reference to the previously-hovered row that would otherwise be
    // restored on the next mouseleave.
    onPreview?.(null);
    onChange(fontValue);
    onClose();
  }, [onChange, onClose, onPreview]);

  const handleWorkspaceSelect = useCallback((font: WorkspaceFont) => {
    trace.action('font-popup:select-workspace', { family: font.family });
    loadCustomFont({ family: font.family, url: font.url, weight: font.weight, style: font.style });
    // Match the Google path's `Family, fallback` shape so the committed value
    // and the highlight (which strips the fallback) line up.
    const fontValue = `${font.family}, sans-serif`;
    onPreview?.(null);
    onChange(fontValue);
    // Declare the @font-face in the project (globals.css) so the canvas iframe
    // resolves it and it ships on publish — runs after onChange so the queued
    // fontFamily write flushes first.
    applyWorkspaceFontToProject(font.family);
    onClose();
  }, [onChange, onClose, onPreview]);

  // Cancel any in-flight preview when the popup closes (Escape, outside
  // click, or programmatic close). Without this, mousing OUT of a row
  // and immediately closing leaves the canvas pinned at the preview
  // family with no way to revert.
  useEffect(() => {
    if (!isOpen) onPreview?.(null);
  }, [isOpen, onPreview]);

  // Row props for react-window v2
  const rowProps: FontRowExtraProps = useMemo(() => ({
    filteredFonts,
    currentFontName,
    onSelect: handleFontSelect,
    onPreview,
  }), [filteredFonts, currentFontName, handleFontSelect, onPreview]);

  // Container-level mouseleave fires once when the cursor truly exits
  // the popup (NOT when transitioning between rows — those are nested,
  // their leave/enter cancel out with `relatedTarget` still inside).
  // This is the single revert point for the hover preview.
  const handleContainerLeave = useCallback(() => {
    onPreview?.(null);
  }, [onPreview]);

  const content = (
    <div onMouseLeave={handleContainerLeave}>
      {/* Search + Category filter */}
      <div className={`flex flex-col gap-2 ${inline ? '' : '-mx-3 px-3'} pb-2 border-b border-[var(--border-light)]`}>
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full bg-[var(--bg-hover)] rounded-md px-8 py-1.5 text-sm focus:outline-none text-[var(--text-primary)]"
            placeholder="Search fonts..."
          />
          <svg className="absolute left-2 top-2 w-3.5 h-3.5 text-[var(--text-secondary)]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <div className="flex items-center gap-2">
          <ControlLabel label="Category" property="" plain />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            className="flex-1 bg-[var(--bg-hover)] rounded-md px-2 py-1 text-xs focus:outline-none text-[var(--text-primary)] cursor-pointer"
          >
            {FEELING_CATEGORIES.map(cat => (
              <option key={cat} value={cat}>{cat === 'All' ? 'All Categories' : cat}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Font list */}
      <div className="-mx-3 px-1.5">
        {/* Workspace fonts — uploaded to the workspace library, shown above
            the Google catalog under their own divider, each in its own face. */}
        {workspaceFamilies.length > 0 && (
          <div className="mb-1">
            <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              Workspace fonts
            </div>
            <div className="max-h-[150px] overflow-y-auto [&::-webkit-scrollbar]:hidden">
              {workspaceFamilies.map(font => {
                const isSelected = font.family === currentFontName;
                const cssFamily = `${font.family}, sans-serif`;
                return (
                  <div
                    key={font.id}
                    className="py-[2px]"
                    onClick={() => handleWorkspaceSelect(font)}
                    onMouseDown={e => e.stopPropagation()}
                    onMouseEnter={() => onPreview?.(cssFamily)}
                  >
                    <div
                      className={`flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                          : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                      }`}
                      style={{ fontFamily: `"${font.family}"` }}
                    >
                      <span className="text-sm truncate">{font.family}</span>
                      <span className={`text-sm flex-shrink-0 ml-2 ${isSelected ? 'text-white/70' : 'text-[var(--text-secondary)]'}`}>Aa</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-t border-[var(--border-light)]">
              All fonts
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--text-primary)]" />
          </div>
        ) : filteredFonts.length === 0 ? (
          workspaceFamilies.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[var(--text-secondary)] text-sm">
              No fonts found
            </div>
          ) : null
        ) : (
          <List
            listRef={listRef}
            rowCount={filteredFonts.length}
            rowHeight={36}
            rowComponent={FontRow}
            rowProps={rowProps}
            style={{ height: workspaceFamilies.length > 0 ? 200 : 308, scrollbarWidth: 'none', msOverflowStyle: 'none' } as CSSProperties}
            className="[&::-webkit-scrollbar]:hidden"
          />
        )}
      </div>
    </div>
  );

  if (inline) return content;

  return (
    <ToolPopup isOpen={isOpen} onClose={onClose} title="Font Family" anchorRef={anchorRef} width={280}>
      {content}
    </ToolPopup>
  );
}
