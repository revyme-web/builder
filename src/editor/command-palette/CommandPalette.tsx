// CommandPalette.tsx — Bottom-toolbar cmd+K palette. Ported pixel-perfect
// from builder/`CommandPalette.tsx` with two adjustments:
//   - Revyme only ships the "Plugins" filter for now (other filters
//     come later as commands/blocks/templates land)
//   - measurement targets `id="bottom-toolbar-container"` which we add
//     to Revyme's BottomToolbar
//
// Renders as a portal to document.body so the floating panel escapes
// any overflow:hidden ancestors and lives above every other surface
// (z-99999). Closes on outside-click, ESC, and the global cmd+K toggle.

import React, { useEffect, useRef } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAtom, useSetAtom } from 'jotai';
import { paletteFilterAtom, paletteSelectedIndexAtom } from './palette-store';
import { paletteOpenAtom, paletteQueryAtom } from '@/code/stores/palette-store';
import { PluginGrid } from './PluginGrid';
import { SearchResults } from './SearchResults';
import { useMegaSearch } from './useMegaSearch';
import { parsePluginUrl } from './marketplace-client';
import { trace } from '@/shared/debug-trace';

export function CommandPalette() {
  const [isOpen, setIsOpen] = useAtom(paletteOpenAtom);
  const [query, setQuery] = useAtom(paletteQueryAtom);
  const [filter, setFilter] = useAtom(paletteFilterAtom);
  const setSelectedIndex = useSetAtom(paletteSelectedIndexAtom);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = React.useState<number>(500);
  // Keyboard nav (arrows / Enter / Tab) lives in the mega-search hook
  // so it can read the result list directly. We forward keydown into
  // it from the search input; Esc is handled separately at the
  // palette level so it always closes regardless of focus state.
  const { handleKeyDown: handleResultsKeyDown } = useMegaSearch();

  // Measure bottom toolbar width to size the palette consistently with
  // it. Remeasure on resize + after a short delay so toolbar animations
  // settle. Tracks the same id (`bottom-toolbar-container`) as the
  // builder so the pattern is identical.
  useEffect(() => {
    const measure = () => {
      const toolbar = document.getElementById('bottom-toolbar-container');
      if (toolbar) setToolbarWidth(toolbar.offsetWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setTimeout(measure, 100);
    return () => {
      window.removeEventListener('resize', measure);
      clearTimeout(t);
    };
  }, [isOpen]);

  // Global cmd+K listener — toggles even when focus is on inputs
  // (matching builder behaviour). Excludes Cmd+Alt+K which the
  // component editor uses elsewhere; we don't grab Alt-combos here.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen((v) => !v);
        trace.action('palette:toggle', { source: 'cmd-k' });
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        trace.action('palette:close', { source: 'escape' });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, setIsOpen]);

  // Global plugin-URL paste detection lives in `canvas/shortcuts.ts`
  // alongside the existing component/vector/sketch URL paste handler,
  // so all clipboard intercept logic sits in one place. When a plugin
  // URL is pasted on a non-editable surface, that handler writes
  // `paletteOpenAtom` + `paletteQueryAtom` and this palette renders.

  // Focus the input on open. Tiny delay so the modal has mounted and
  // the input has a real layout before we focus — without it, focus
  // sometimes lands on the previous focusable target.
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Reset search state on close. Without this the query persists in
  // the atom so re-opening the palette would land the user back on
  // their last typed search — usually not what they want (cmd+K is a
  // launcher, not a persistent search session). Runs after every
  // close path (Esc, outside-click, cmd+K toggle, executed action,
  // install grid click) since they all flip `paletteOpenAtom` false.
  useEffect(() => {
    if (isOpen) return;
    setQuery('');
    setSelectedIndex(0);
  }, [isOpen, setQuery, setSelectedIndex]);

  // Outside-click close — but ignore clicks on the toolbar's search
  // button (so the search button toggles cleanly instead of opening +
  // immediately closing).
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (target.closest('[data-palette-toggle]')) return;
        setIsOpen(false);
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onMouseDown), 100);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [isOpen, setIsOpen]);

  if (!isOpen) return null;

  return createPortal(
    <AnimatePresence>
      <div className="fixed bottom-[76px] left-0 right-0 z-[99999] flex justify-center pointer-events-none">
        <motion.div
          ref={containerRef}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ type: 'spring', bounce: 0.15, duration: 0.25 }}
          className="pointer-events-auto"
        >
          <div
            className="max-h-[400px] bg-[var(--bg-surface)] rounded-[var(--radius-md)] shadow-2xl border border-[var(--border-light)] overflow-hidden flex flex-col"
            style={{ width: `${toolbarWidth}px` }}
          >
            {/* Search input */}
            <div className="p-2 border-b border-[var(--border-light)]">
              <div className="flex items-center gap-2 px-2.5 h-8 bg-[var(--grid-line)] border border-[var(--control-border)] rounded-lg">
                <SearchIcon className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Only forward navigation keys to mega-search when
                    // the "All" tab is active. The "Plugins" tab has
                    // its own grid layout that doesn't use keyboard nav.
                    if (filter === 'all') handleResultsKeyDown(e);
                  }}
                  onPaste={(e) => {
                    // Belt-and-suspenders: in some browsers paste into
                    // a controlled input fires `paste` but not `change`
                    // until the next tick. Read the clipboard directly
                    // so URL detection fires synchronously and the
                    // install card appears immediately on paste.
                    const text = e.clipboardData?.getData('text');
                    if (text && parsePluginUrl(text)) {
                      e.preventDefault();
                      setQuery(text);
                    }
                  }}
                  placeholder={filter === 'plugins' ? 'Search plugins or paste a URL...' : 'Search layers, components, pages, CMS, icons, commands...'}
                  className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] placeholder:opacity-60 focus:outline-none"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <kbd className="flex-shrink-0 flex items-center px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] rounded border border-[var(--border-light)]">
                  ESC
                </kbd>
              </div>
            </div>

            {/* Two tabs:
                - All: mega-search across project state — commands,
                  tools, panels, local library files, pages, installed
                  plugins, plus inline Iconify icon results when the
                  query is 2+ chars. Curated Project / Plugins headline
                  the empty-query view.
                - Plugins: marketplace browser. Only this tab fetches
                  the CDN — components/vectors stay scoped
                  to the current project everywhere else (no CDN dump
                  in the All view, by user preference). */}
            <div className="flex items-center gap-1 px-2 py-2 border-b border-[var(--border-light)]">
              <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterTab>
              {/* Marketplace browser — cloud-only (fetches /api/plugins/approved). */}
              {CLOUD_ENABLED && (
                <FilterTab active={filter === 'plugins'} onClick={() => setFilter('plugins')}>Plugins</FilterTab>
              )}
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto max-h-[340px]">
              {filter === 'all' ? <SearchResults /> : <PluginGrid />}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}

function FilterTab({
  active, onClick, disabled, children,
}: {
  active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={`px-2 py-1 rounded text-[10px] transition-colors ${
        disabled
          ? 'text-[var(--text-disabled)] bg-[var(--button-secondary-bg)] cursor-not-allowed opacity-50'
          : active
            ? 'text-[var(--text-primary)] bg-black/[0.13] dark:bg-white/[0.16] cursor-pointer'
            : 'text-[var(--text-secondary)] bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] cursor-pointer'
      }`}
    >
      {children}
    </button>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Setter helper used by the BottomToolbar search button. Kept here so
 *  callers don't need to import the atom directly. */
export function usePaletteToggle() {
  const set = useSetAtom(paletteOpenAtom);
  return () => set((v) => !v);
}

