// search-registry.ts — Composes every cmd+K search source into one list.
//
// This used to hold all the item definitions inline. They now live in
// `sources/`, one file per source, because the catalogue grew past the
// point where a single module was readable — and because sources like
// `layers` and `cms` need the query in order to stay cheap, which a flat
// "register everything up front" shape couldn't express.
//
// There is no long-lived registry object and no `initialize()`. Items are
// rebuilt on every search from live state (projectFS, node map, plugin
// atoms), which is why a component you created a second ago is findable
// without any invalidation plumbing. The cost is a few hundred object
// literals — trivial next to the debounce that gates it.

import { SEARCH_SOURCES } from './sources';
import type { SearchableItem } from './search-types';
import { trace } from '@/shared/debug-trace';

/**
 * Build the searchable item list for a query.
 *
 * @param query Raw user input. Sources receive it trimmed + lower-cased.
 *              Query-blind sources ignore it; `layers` and `cms` use it to
 *              avoid materialising rows for content nobody asked for.
 *
 * A throwing source is skipped rather than allowed to blank the palette —
 * one malformed CMS schema shouldn't cost the user their command list.
 */
export function getAllSearchableItems(query = ''): SearchableItem[] {
  const ctx = { query: query.trim().toLowerCase() };
  const items = new Map<string, SearchableItem>();

  for (const source of SEARCH_SOURCES) {
    let produced: SearchableItem[];
    try {
      produced = source(ctx);
    } catch (err) {
      trace.error('palette:source-failed', { error: String(err) });
      continue;
    }
    for (const item of produced) {
      // First write wins. Ids are source-namespaced so this only fires
      // on a genuine duplicate within one source.
      if (!items.has(item.id)) items.set(item.id, item);
    }
  }

  return Array.from(items.values());
}
