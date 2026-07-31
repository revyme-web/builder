// SearchResults.tsx — Grouped result list for the cmd+K palette's "All"
// tab. Pixel-perfect port from builder/src/builder/view/search/
// components/{SearchResults,SearchResultItem}.tsx: same padding
// (px-3 py-2.5), same row shape (icon + name + right-aligned hint
// or kbd), same mx-1 rounded-lg highlight band, same category header
// (10px uppercase, tracking-wider).
//
// Category icons are inline-SVG tiles in the builder's colors. Each
// 20×20 tile is rounded 5px with a category-specific glyph — see the
// builder reference for the exact paint specs. Kept in this file so
// adding a new category to `search-types.ts` immediately surfaces a
// place to draft its tile.

import React, { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useMegaSearch } from './useMegaSearch';
import { groupResultsByCategory } from './search-utils';
import { paletteQueryAtom } from '@/code/stores/palette-store';
import { IconSearchResults } from './IconSearchResults';
import {
  CATEGORY_CONFIG,
  CATEGORY_ORDER,
  type SearchCategory,
  type SearchResult,
} from './search-types';

// ─── Category tile icons ────────────────────────────────────────────────────
// Same colors + shapes as the builder reference. Each one is a small
// rounded SVG tile sized 20×20 px. We inline these rather than ship
// them as a separate icon module — they're palette-only assets.

const CategoryTiles: Record<SearchCategory, React.FC> = {
  project: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#0EA5E9" />
      <path d="M5 6h10M5 10h10M5 14h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  commands: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#F59E0B" />
      <path d="M6 7h8v2H6V7zm0 4h6v2H6v-2z" fill="white" />
    </svg>
  ),
  draw: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#EC4899" />
      <rect x="5" y="5" width="10" height="10" rx="1.5" stroke="white" strokeWidth="1.5" fill="none" />
    </svg>
  ),
  tabs: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#A855F7" />
      <rect x="4" y="6" width="5" height="3" rx="1" fill="white" />
      <rect x="10" y="6" width="5" height="3" rx="1" fill="white" opacity="0.5" />
      <rect x="4" y="10" width="11" height="4" rx="1" fill="white" opacity="0.7" />
    </svg>
  ),
  library: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#3B82F6" />
      <rect x="5" y="5" width="10" height="3" rx="1" fill="white" />
      <rect x="5" y="10" width="4" height="5" rx="1" fill="white" opacity="0.7" />
      <rect x="11" y="10" width="4" height="5" rx="1" fill="white" opacity="0.5" />
    </svg>
  ),
  plugins: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#A855F7" />
      <path d="M10 4L7 7H9V10H11V7H13L10 4Z" fill="white" />
      <rect x="6" y="11" width="8" height="2" rx="0.5" fill="white" opacity="0.7" />
      <rect x="6" y="14" width="8" height="2" rx="0.5" fill="white" opacity="0.5" />
    </svg>
  ),
  pages: () => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect width="20" height="20" rx="5" fill="#10B981" />
      <path d="M6 4h6l3 3v9H6V4z" stroke="white" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <path d="M12 4v3h3" stroke="white" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
    </svg>
  ),
};

// ─── Shortcut hint ──────────────────────────────────────────────────────────
// Lifted from builder/ShortcutHint.tsx — same `Modifier+Key` rendering.

const MODIFIER_MAP: Record<string, string> = {
  '⇧': 'Shift',
  '⌥': 'Alt',
  '⌃': 'Ctrl',
  '⌘': 'Cmd',
};

function parseShortcut(shortcut: string): { modifier?: string; value: string } {
  for (const [symbol, text] of Object.entries(MODIFIER_MAP)) {
    if (shortcut.startsWith(symbol)) {
      return { modifier: text, value: shortcut.slice(symbol.length) };
    }
  }
  return { value: shortcut };
}

function ShortcutHint({ shortcut }: { shortcut: string }) {
  const { modifier, value } = parseShortcut(shortcut);
  // text-secondary at full opacity reads well on the dark surface;
  // the builder's tertiary+opacity-60 was almost invisible against
  // the panel background here (different theme tokens).
  return (
    <span className="text-[11px] text-[var(--text-secondary)]">
      {modifier ? `${modifier}+${value}` : value}
    </span>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function SearchResults() {
  const { results, selectedIndex, setSelectedIndex, handleSelect } = useMegaSearch();
  const query = useAtomValue(paletteQueryAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the highlighted row into view on keyboard nav. Same
  // smoothing the builder uses. Skips when the row is already
  // visible (block: 'nearest' computes that).
  useEffect(() => {
    if (selectedRowRef.current && containerRef.current) {
      const container = containerRef.current;
      const selected = selectedRowRef.current;
      const containerRect = container.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      if (selectedRect.bottom > containerRect.bottom || selectedRect.top < containerRect.top) {
        selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  const grouped = groupResultsByCategory(results);
  // Map every result id → its index in the flat `results` array. The
  // grouped renderer below walks categories in CATEGORY_ORDER, but
  // `results` is sorted by score — so a running counter wouldn't
  // match `results[index]`. Looking up by id keeps the click action
  // pointing at the exact row the user clicked. This was the bug
  // where clicking "Frame Component" sometimes fired a plugin /
  // wrong action that happened to sit at the same score-position.
  const indexById = new Map<string, number>();
  results.forEach((r, i) => indexById.set(r.id, i));

  // Empty-state fallback only when there's NO registry match AND no
  // query (so no iconify section can rescue the view either). With a
  // typed query, IconSearchResults handles its own empty state.
  const showEmpty = results.length === 0 && (!query || query.trim().length < 2);
  if (showEmpty) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--text-secondary)]">No results</p>
        <p className="text-xs text-[var(--text-tertiary)] mt-1">
          Try a command, tool, panel, or library item
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="py-2">
      {CATEGORY_ORDER.map((category) => {
        const categoryResults = grouped.get(category);
        if (!categoryResults || categoryResults.length === 0) return null;

        const config = CATEGORY_CONFIG[category];

        return (
          <div key={category} className="mb-1">
            <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              {config.label}
            </div>
            {categoryResults.map((result) => {
              // Look up the row's TRUE index in the flat results
              // array. `runningIndex` would walk in category-display
              // order, which doesn't match results' score order.
              const globalIndex = indexById.get(result.id) ?? 0;
              const isSelected = globalIndex === selectedIndex;
              return (
                <div
                  key={result.id}
                  ref={isSelected ? selectedRowRef : undefined}
                >
                  <SearchRow
                    result={result}
                    isSelected={isSelected}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                    onClick={() => handleSelect(globalIndex)}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {/* Iconify icon search — fetched live from the Iconify API,
          rendered below the registry rows when the query is 2+ chars.
          Self-managed empty/loading states; renders null otherwise. */}
      <IconSearchResults query={query} />
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────────

function SearchRow({
  result,
  isSelected,
  onMouseEnter,
  onClick,
}: {
  result: SearchResult;
  isSelected: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const Tile = CategoryTiles[result.category];
  const ItemIcon = result.icon;
  const iconSize = 24;

  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors rounded-lg mx-1 ${
        isSelected ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
      }`}
    >
      {/* Icon — item-specific icon when provided (commands / tools /
          library items carry their own glyph), otherwise the category
          tile fills the slot. Both render at the same 24×24 size so
          rows align across categories. */}
      <div className="flex-shrink-0">
        {ItemIcon ? (
          <div
            className="flex items-center justify-center rounded-lg bg-[var(--bg-tertiary)]"
            style={{ width: iconSize, height: iconSize }}
          >
            <ItemIcon size={iconSize * 0.5} className="text-[var(--text-primary)]" />
          </div>
        ) : (
          <Tile />
        )}
      </div>

      {/* Name + optional secondary line (subcategory for library /
          plugin rows, description for plugin rows that have one). */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-secondary)] truncate">
            {result.name}
          </span>
          {result.subcategory && (
            <span className="text-[10px] text-[var(--text-tertiary)] flex-shrink-0">
              {result.subcategory}
            </span>
          )}
        </div>
        {result.description && (
          <div className="text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">
            {result.description}
          </div>
        )}
      </div>

      {/* Right-aligned shortcut hint. Pure visual — the actual
          keybinding lives in shortcuts.ts; this is just the user's
          memory aid. */}
      <div className="flex-shrink-0 flex items-center justify-end">
        {result.shortcut && <ShortcutHint shortcut={result.shortcut} />}
      </div>
    </div>
  );
}
