// sources/types.ts — Contract every cmd+K search source implements.
//
// A source is a plain function, not a class or a registered singleton.
// `search-registry.ts` calls all of them on each search and merges the
// result. That keeps every source independently testable and means
// adding one touches exactly two files (the source, and the index that
// lists it).
//
// Sources receive the query because two of them cannot afford to be
// query-blind: `layers` would otherwise materialise a row (and walk an
// ancestor chain for a breadcrumb) for every node on the page, and `cms`
// would load every item of every collection. Static sources ignore it.

import type { SearchableItem } from '../search-types';

export interface SourceContext {
  /** Trimmed + lower-cased. Empty string when the palette has no query. */
  query: string;
}

export type SearchSource = (ctx: SourceContext) => SearchableItem[];

/**
 * Query length below which the expensive, high-cardinality sources stay
 * silent. One character matches too much to be useful and makes the list
 * jump around while the user is still typing.
 */
export const MIN_CONTENT_QUERY = 2;
