// sources/cms.ts — CMS collections and their items.
//
// Collections are always emitted (there are only ever a handful, and
// they're read from cached schema files). Items are gated behind
// MIN_CONTENT_QUERY because `getCollectionData` reads and parses the
// whole JSON file per collection — fine on demand, wasteful on every
// keystroke of a one-character query.
//
// Both activate as navigation, not insertion: they open the CMS panel
// focused on the collection. Binding a field to an element is a
// different gesture entirely and belongs on the canvas, not here.

import { CmsIcon } from '@/shared/icons';
import {
  listCollections,
  getCollectionSchema,
  getCollectionData,
  cmsItemLabel,
} from '@/code/project/cms-ops';
import { trace } from '@/shared/debug-trace';
import type { SearchableItem } from '../search-types';
import { type SearchSource, MIN_CONTENT_QUERY } from './types';

/** Per-collection cap so one big blog can't monopolise the result list. */
const MAX_ITEMS_PER_COLLECTION = 8;

export const cmsSource: SearchSource = ({ query }) => {
  const items: SearchableItem[] = [];

  let slugs: string[];
  try {
    slugs = listCollections();
  } catch (err) {
    // A malformed schema file shouldn't take down the whole palette.
    trace.error('palette:cms-source-failed', { error: String(err) });
    return [];
  }

  for (const slug of slugs) {
    const schema = getCollectionSchema(slug);
    if (!schema) continue;

    items.push({
      id: `cms:collection:${slug}`,
      name: schema.name,
      category: 'cms',
      subcategory: 'Collection',
      icon: CmsIcon,
      keywords: [schema.name.toLowerCase(), slug.toLowerCase(), 'cms', 'collection', 'content'],
      action: { type: 'open-cms', slug },
    });

    if (query.length < MIN_CONTENT_QUERY) continue;

    let data;
    try {
      data = getCollectionData(slug);
    } catch (err) {
      trace.error('palette:cms-items-failed', { slug, error: String(err) });
      continue;
    }

    let emitted = 0;
    for (const item of data) {
      if (emitted >= MAX_ITEMS_PER_COLLECTION) break;
      const label = cmsItemLabel(item, schema);
      if (!label.toLowerCase().includes(query)) continue;
      items.push({
        id: `cms:item:${slug}:${item._id}`,
        name: label,
        category: 'cms',
        subcategory: item._status === 'draft' ? 'Draft' : 'Item',
        breadcrumb: [schema.name],
        keywords: [label.toLowerCase(), item._slug?.toLowerCase() ?? '', 'cms', 'item', 'entry'],
        action: { type: 'open-cms', slug, itemId: item._id },
      });
      emitted++;
    }
  }

  return items;
};
