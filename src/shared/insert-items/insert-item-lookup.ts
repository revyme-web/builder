// insert-item-lookup.ts — Flat itemId → InsertItem map derived from
// element-data's CATEGORIES. Single source of truth for "given an item
// id, what does its card look like?" — used by both the secondary panel
// (cards) and the toolbar drag ghost so the ghost matches the card 1:1.
//
// Lazy-built once at first lookup; CATEGORIES is a static module export
// so we don't need to subscribe / invalidate. Adding a new InsertItem
// to element-data automatically surfaces in the ghost.

import { CATEGORIES, CREATIVE_CATEGORIES, type InsertItem } from '@/shared/insert-items/element-data';

let _cache: Map<string, InsertItem> | null = null;

function build(): Map<string, InsertItem> {
  const out = new Map<string, InsertItem>();
  // Walk BOTH the Insert categories AND the Creative categories — they
  // were one tree when this file was written; Creative has since been
  // promoted to its own top-level group (sibling of Insert) with its
  // sub-rows defined in CREATIVE_CATEGORIES. Without merging them here
  // the ghost overlay would resolve `null` for every cs-* effect /
  // cursor / text-effect drag id and fall back to an empty 56×56 box.
  for (const cat of [...CATEGORIES, ...CREATIVE_CATEGORIES]) {
    for (const section of cat.sections) {
      for (const item of section.items) {
        out.set(item.id, item);
      }
    }
  }
  return out;
}

/** Look up the full InsertItem (icon + brand metadata) for a toolbar
 *  drag id. Returns null for ids that don't originate in CATEGORIES
 *  (CMS, code components, dividers, components — those don't have card metadata). */
export function getInsertItem(itemId: string): InsertItem | null {
  if (!_cache) _cache = build();
  return _cache.get(itemId) ?? null;
}
