// useMegaSearch.ts — Orchestration hook for the cmd+K palette's "All"
// tab. Holds the result list, selected index, and keyboard navigation
// (Arrow / Enter / Tab / Esc). The palette UI consumes this hook;
// `useSearchActions.executeSearchAction()` does the actual side-effect.
//
// Result computation is debounced when the query is non-empty (80ms)
// and immediate when the query clears. We re-read the registry every
// time so projectFS / atom changes pick up without invalidation
// plumbing — the registry is < 100 items so the cost is trivial.

import { useCallback, useEffect, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { paletteResultsAtom, paletteSelectedIndexAtom } from './palette-store';
import { paletteOpenAtom, paletteQueryAtom } from '@/code/stores/palette-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { installedPluginsAtom } from '@/plugins/registry';
import { installedCloudPluginsAtom } from '@/plugins/cloud-plugins';
import { getAllSearchableItems } from './search-registry';
import { fuzzySearch } from './search-utils';
import { executeSearchAction } from './useSearchActions';

export function useMegaSearch() {
  const isOpen = useAtomValue(paletteOpenAtom);
  const query = useAtomValue(paletteQueryAtom);

  // Re-derive when ANY of these change. `projectVersionAtom` covers
  // file CRUD (components / vectors / pages / templates /
  // plugin files). The plugin atoms cover install/uninstall on the
  // localStorage + cloud sides — they don't bump projectVersionAtom
  // because they aren't projectFS writes.
  const projectVersion = useAtomValue(projectVersionAtom);
  const installedDev = useAtomValue(installedPluginsAtom);
  const installedCloud = useAtomValue(installedCloudPluginsAtom);

  const items = useMemo(
    () => getAllSearchableItems(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectVersion, installedDev, installedCloud, isOpen],
  );

  const [results, setResults] = useAtom(paletteResultsAtom);
  const [selectedIndex, setSelectedIndex] = useAtom(paletteSelectedIndexAtom);

  useEffect(() => {
    if (!isOpen) return;
    // Immediate for empty query (cheap), 80ms debounce for typed
    // queries. Matches the builder cadence — feels instant without
    // recomputing on every keystroke for users typing fast.
    const delay = query.trim() ? 80 : 0;
    const t = setTimeout(() => {
      setResults(fuzzySearch(items, query, 40));
      setSelectedIndex(0);
    }, delay);
    return () => clearTimeout(t);
  }, [isOpen, query, items]);

  const handleSelect = useCallback(
    (index?: number) => {
      const target = index ?? selectedIndex;
      const result = results[target];
      if (!result) return;
      executeSearchAction(result.action);
    },
    [results, selectedIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          break;
        case 'Tab':
          e.preventDefault();
          setSelectedIndex((i) => {
            if (e.shiftKey) return Math.max(0, i - 1);
            return Math.min(i + 1, results.length - 1);
          });
          break;
        case 'Enter':
          e.preventDefault();
          handleSelect();
          break;
        // Esc is handled at the palette level (closes the modal).
      }
    },
    [results.length, handleSelect],
  );

  return { results, selectedIndex, setSelectedIndex, handleSelect, handleKeyDown };
}
