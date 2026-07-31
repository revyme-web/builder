// palette-store.ts — Jotai atoms for the bottom-toolbar cmd+K command palette.
//
// The palette opens above the bottom toolbar, sized to match the toolbar
// width. State is small: active filter tab + result-list atoms (the
// cross-layer open flag + query atoms live in code/stores/palette-store.ts).
// Future result categories (commands, blocks, templates) just add new
// filter values + result components — the atom shape doesn't change.

import { atom } from 'jotai';
import type { SearchResult } from './search-types';

export type PaletteFilter = 'all' | 'plugins';

/** Active filter tab. Default is 'all' — the mega-search across
 *  commands, tools, panels, library, plugins, pages. The 'plugins'
 *  tab keeps the marketplace browser grid for installing approved
 *  cloud plugins, which is a separate flow from the searchable
 *  installed-plugin rows the 'all' tab includes. */
export const paletteFilterAtom = atom<PaletteFilter>('all');

/** Live result list for the "All" tab. Lifted to an atom (rather than
 *  local hook state) so the palette's search input AND the results
 *  list — which both call `useMegaSearch()` — share one source of
 *  truth. Without this, arrow-key nav from the input would update
 *  one hook instance's `selectedIndex` while the displayed list
 *  reads a different one. */
export const paletteResultsAtom = atom<SearchResult[]>([]);

/** Currently-highlighted row index into `paletteResultsAtom`. Reset
 *  to 0 every time the query/result list changes. */
export const paletteSelectedIndexAtom = atom<number>(0);
