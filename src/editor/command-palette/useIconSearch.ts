// useIconSearch.ts — Cross-library Iconify search for the cmd+K "All" tab.
//
// Ported from `builder/src/builder/view/search/hooks/useIconSearch.ts`.
// Differences vs the builder version:
//   - Same set of target libraries (matches `IconPanel`'s curated list
//     so palette + sidebar return the same shape of results).
//   - Hits `api.iconify.design/search` in parallel per library, caps at
//     48 results total (8 cols × 6 rows).
//   - 400 ms debounce + AbortController so fast typing doesn't pile up
//     network calls.
//
// The hook is read-only — selection / insertion lives in
// `insertIconAtCanvasCenter` in this folder.

import { useEffect, useRef, useState } from 'react';

export interface IconResult {
  /** Full iconify id like `lucide:home` */
  icon: string;
  /** Short display name, the part after `:` */
  name: string;
  /** Library prefix, the part before `:` */
  prefix: string;
}

// Mirrors the LibraryPanel/IconPanel curated set. Match the builder's
// list as far as it overlaps with Revyme — `pepicons-pop` was in
// builder but not in Revyme's IconPanel; we keep it here so the
// palette feels at least as rich, since `useIconSearch` is independent
// of which packs Revyme ships sidebar buttons for.
const SEARCH_LIBRARIES = [
  'material-symbols',
  'fa6-solid',
  'phosphor',
  'heroicons',
  'tabler',
  'lucide',
  'bi',
  'pixelarticons',
  'pepicons-pop',
  'game-icons',
];

const DEBOUNCE_MS = 400;
const MAX_RESULTS = 48;

export function useIconSearch(query: string): { icons: IconResult[]; isLoading: boolean } {
  const [icons, setIcons] = useState<IconResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Don't fire for empty / 1-char queries — too many false matches.
    if (!query || query.trim().length < 2) {
      setIcons([]);
      setIsLoading(false);
      return;
    }

    // Cancel any prior in-flight search before kicking off a new one.
    // Without this, slow typers see results from earlier queries
    // overwrite the latest ones when their requests resolve last.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const run = async () => {
      setIsLoading(true);
      try {
        const perLibrary = await Promise.all(
          SEARCH_LIBRARIES.map(async (prefix) => {
            try {
              const url = `https://api.iconify.design/search?query=${encodeURIComponent(query.trim())}&prefix=${prefix}&limit=50`;
              const res = await fetch(url, { signal: ctrl.signal });
              if (!res.ok) return [] as IconResult[];
              const data = await res.json();
              const ids: string[] = data.icons ?? [];
              return ids.map((full) => {
                const [p, n] = full.split(':');
                return { icon: full, name: n, prefix: p };
              });
            } catch (err) {
              if ((err as Error).name === 'AbortError') throw err;
              return [] as IconResult[];
            }
          }),
        );
        if (ctrl.signal.aborted) return;
        const flat = perLibrary.flat().slice(0, MAX_RESULTS);
        setIcons(flat);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setIcons([]);
      } finally {
        if (!ctrl.signal.aborted) setIsLoading(false);
      }
    };

    const t = setTimeout(run, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  return { icons, isLoading };
}
