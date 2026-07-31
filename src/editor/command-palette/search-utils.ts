// search-utils.ts — In-house fuzzy matcher for the cmd+K palette.
//
// Why not fuse.js: extra dependency for a feature that only needs
// "name + keywords + subcategory matched case-insensitively with a
// score." The scoring is intentionally simple — substring is fine for
// a 100-item palette and stays predictable. If the catalog ever grows
// into the thousands we can swap to fuse without changing the call
// sites (`fuzzySearch` signature stays).
//
// Scoring (higher = better):
//   - exact name match            → 100
//   - name starts with query      → 80
//   - name contains query         → 60 - (index / nameLen) * 20
//   - keyword exact match         → 50
//   - keyword starts with query   → 35
//   - keyword contains query      → 20
//   - subcategory contains query  → 15
//   - description contains query  →  5
// Multiplied by `CATEGORY_CONFIG[category].weight`.
//
// Empty query → `getDefaultResults` builds a top-N per category in the
// declared `CATEGORY_ORDER` so the palette has a useful "browse" view
// when first opened.

import {
  type SearchableItem,
  type SearchResult,
  type SearchCategory,
  CATEGORY_CONFIG,
  CATEGORY_ORDER,
} from './search-types';

const MIN_SCORE = 5;

function filterByCondition(items: SearchableItem[]): SearchableItem[] {
  return items.filter((item) => !item.condition || item.condition());
}

function scoreItem(item: SearchableItem, q: string): { score: number; matched: string[] } {
  const matched: string[] = [];
  let best = 0;

  const name = item.name.toLowerCase();
  if (name === q) {
    best = Math.max(best, 100);
    matched.push(item.name);
  } else if (name.startsWith(q)) {
    best = Math.max(best, 80);
    matched.push(item.name);
  } else if (name.includes(q)) {
    const idx = name.indexOf(q);
    best = Math.max(best, 60 - (idx / Math.max(1, name.length)) * 20);
    matched.push(item.name);
  }

  for (const kw of item.keywords) {
    const k = kw.toLowerCase();
    if (k === q) { best = Math.max(best, 50); matched.push(kw); }
    else if (k.startsWith(q)) { best = Math.max(best, 35); matched.push(kw); }
    else if (k.includes(q)) { best = Math.max(best, 20); matched.push(kw); }
  }

  if (item.subcategory && item.subcategory.toLowerCase().includes(q)) {
    best = Math.max(best, 15);
    matched.push(item.subcategory);
  }
  if (item.description && item.description.toLowerCase().includes(q)) {
    best = Math.max(best, 5);
  }

  return { score: best, matched };
}

/**
 * Filter + rank items against a query. Empty query returns a curated
 * default set (see `getDefaultResults`). Non-empty query runs the
 * scorer above with the category-weight multiplier.
 */
export function fuzzySearch(
  items: SearchableItem[],
  query: string,
  limit = 30,
): SearchResult[] {
  const filtered = filterByCondition(items);
  const q = query.trim().toLowerCase();
  if (!q) return getDefaultResults(filtered, limit);

  const results: SearchResult[] = [];
  for (const item of filtered) {
    const { score, matched } = scoreItem(item, q);
    if (score < MIN_SCORE) continue;
    const weight = CATEGORY_CONFIG[item.category]?.weight ?? 1;
    results.push({ ...item, score: score * weight, matchedTerms: matched });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Empty-query default: only items explicitly marked `featured: true`
 * appear here. The rest of the catalog is "search-only" — it surfaces
 * the moment the user starts typing.
 *
 * The point is to keep the empty-state palette tight and high-signal
 * (Browse marketplace + top installed plugins + a couple project
 * actions), instead of dumping every command/tool/file/page. Mirrors
 * the reference's cmd+K starter view.
 *
 * Featured items keep their category, so the grouped renderer still
 * shows nice "Plugins" / "Project" headers without extra wiring.
 * Stops adding once `limit` is reached.
 */
function getDefaultResults(items: SearchableItem[], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const cat of CATEGORY_ORDER) {
    const config = CATEGORY_CONFIG[cat];
    const featuredOfCat = items.filter((i) => i.category === cat && i.featured);
    for (const item of featuredOfCat) {
      out.push({ ...item, score: config.weight, matchedTerms: [] });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Group sorted results into per-category buckets, preserving order. */
export function groupResultsByCategory(
  results: SearchResult[],
): Map<SearchCategory, SearchResult[]> {
  const grouped = new Map<SearchCategory, SearchResult[]>();
  for (const r of results) {
    const arr = grouped.get(r.category) ?? [];
    arr.push(r);
    grouped.set(r.category, arr);
  }
  // Return in declared display order, omitting empty groups.
  const ordered = new Map<SearchCategory, SearchResult[]>();
  for (const cat of CATEGORY_ORDER) {
    const arr = grouped.get(cat);
    if (arr && arr.length > 0) ordered.set(cat, arr);
  }
  return ordered;
}
