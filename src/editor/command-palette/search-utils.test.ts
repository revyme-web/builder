// search-utils.test.ts — Locks in the scoring + grouping contract for
// the cmd+K palette's fuzzy matcher. New score buckets or category
// weights should bump the expectations here intentionally, not by
// accident.

import { describe, expect, it } from 'vitest';
import { fuzzySearch, groupResultsByCategory } from './search-utils';
import type { SearchableItem } from './search-types';

function item(partial: Partial<SearchableItem> & { id: string; name: string }): SearchableItem {
  return {
    category: 'commands',
    keywords: [],
    action: { type: 'execute-command', commandId: partial.id },
    ...partial,
  } as SearchableItem;
}

describe('fuzzySearch', () => {
  it('exact name match beats partial', () => {
    const items: SearchableItem[] = [
      item({ id: 'a', name: 'Frame' }),
      item({ id: 'b', name: 'Frame Tool' }),
      item({ id: 'c', name: 'Iframe' }),
    ];
    const r = fuzzySearch(items, 'frame');
    expect(r[0].id).toBe('a');
  });

  it('name startsWith beats name contains', () => {
    const items: SearchableItem[] = [
      item({ id: 'a', name: 'My Frame' }),     // contains
      item({ id: 'b', name: 'Framework' }),    // startsWith
    ];
    const r = fuzzySearch(items, 'fram');
    expect(r[0].id).toBe('b');
  });

  it('matches against keywords', () => {
    const items: SearchableItem[] = [
      item({ id: 'a', name: 'Rectangle', keywords: ['box', 'square'] }),
    ];
    const r = fuzzySearch(items, 'square');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('a');
  });

  it('empty query returns ONLY featured items (curated initial view)', () => {
    const items: SearchableItem[] = [
      item({ id: 'c1', name: 'Cmd 1', category: 'commands' }),                     // not featured
      item({ id: 'p1', name: 'Plugin 1', category: 'plugins', featured: true }),    // featured
      item({ id: 'pj1', name: 'New Project', category: 'project', featured: true }),// featured
      item({ id: 'l1', name: 'Lib 1', category: 'library' }),                       // not featured
    ];
    const r = fuzzySearch(items, '');
    expect(r.map((x) => x.id).sort()).toEqual(['p1', 'pj1']);
  });

  it('non-featured items still appear when the user types', () => {
    const items: SearchableItem[] = [
      item({ id: 'c1', name: 'Undo', category: 'commands' }),
      item({ id: 'p1', name: 'Plugin 1', category: 'plugins', featured: true }),
    ];
    const r = fuzzySearch(items, 'undo');
    expect(r.map((x) => x.id)).toContain('c1');
  });

  it('respects the limit', () => {
    const items: SearchableItem[] = Array.from({ length: 20 }, (_, i) =>
      item({ id: `i${i}`, name: `Frame ${i}` }),
    );
    expect(fuzzySearch(items, 'frame', 5)).toHaveLength(5);
  });

  it('drops items whose condition() returns false', () => {
    const items: SearchableItem[] = [
      item({ id: 'a', name: 'Active', condition: () => true }),
      item({ id: 'b', name: 'Hidden', condition: () => false }),
    ];
    const r = fuzzySearch(items, 'a');
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('filters out below-threshold matches', () => {
    const items: SearchableItem[] = [
      item({ id: 'a', name: 'Frame' }),
    ];
    // "xyz" shouldn't match "Frame" at all.
    expect(fuzzySearch(items, 'xyz')).toHaveLength(0);
  });
});

describe('groupResultsByCategory', () => {
  it('preserves display order and omits empty groups', () => {
    const items: SearchableItem[] = [
      item({ id: 'p1', name: 'Plugin', category: 'plugins', featured: true }),
      item({ id: 'pj1', name: 'Project', category: 'project', featured: true }),
    ];
    const results = fuzzySearch(items, '');
    const grouped = groupResultsByCategory(results);
    const cats = Array.from(grouped.keys());
    // Project appears before plugins per CATEGORY_ORDER (project leads
    // the empty view; plugins drop below commands/tools/library).
    expect(cats.indexOf('project')).toBeLessThan(cats.indexOf('plugins'));
    // Categories with no results are skipped.
    expect(cats).not.toContain('commands');
    expect(cats).not.toContain('pages');
  });
});
