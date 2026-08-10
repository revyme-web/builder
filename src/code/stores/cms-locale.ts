// cms-locale.ts — the CANVAS side of per-locale CMS field values.
//
// The translation model is one row with a translation per field per locale,
// stored ON the item as `_i18n` (see `localizeRows` in @revyme/runtime):
//
//   { "_id": "abc", "title": "Sunset sail", "_i18n": { "fr": { "title": "…" } } }
//
// The generated page wraps its collection source with `localizeRows(...)`, so
// the SOURCE resolves the locale by itself and the published site translates
// with no build step. The canvas has to agree with that exactly — so it calls
// the SAME function rather than reimplementing the merge. A second copy of
// this rule would be one more pair of sites to keep in sync, and today has
// been a long lesson in what happens when a pair drifts.

import { localizeRows } from '@revyme/runtime';
import type { CollectionItem } from '@/shared/types';

/** One collection's rows resolved for `locale`. Identity-preserving. */
export function localizeCollectionRows(rows: CollectionItem[], locale: string | null | undefined): CollectionItem[] {
  return localizeRows(rows as never, locale) as CollectionItem[];
}

/**
 * Every collection resolved for one locale.
 *
 * Returns the SAME Map when nothing applies — this re-runs on every project
 * version bump, i.e. every commit, and a fresh Map would re-render every
 * subscriber each time.
 */
export function localizeCollections(
  data: Map<string, CollectionItem[]>,
  locale: string | null | undefined,
): Map<string, CollectionItem[]> {
  if (!locale) return data;
  let changed = false;
  const out = new Map<string, CollectionItem[]>();
  for (const [slug, rows] of data) {
    const localized = localizeCollectionRows(rows, locale);
    if (localized !== rows) changed = true;
    out.set(slug, localized);
  }
  return changed ? out : data;
}
