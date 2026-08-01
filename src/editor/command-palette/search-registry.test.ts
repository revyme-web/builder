// search-registry.test.ts — The registry's job is composition, and the
// property worth pinning is fault isolation: one broken source (a
// malformed CMS schema, a plugin atom in a bad state) must not blank the
// whole palette. Losing CMS rows is an annoyance; losing Undo is a bug.

import { describe, expect, it, vi } from 'vitest';
import type { SearchableItem } from './search-types';

const okSource = vi.fn(
  (): SearchableItem[] => [
    { id: 'ok:1', name: 'Working', category: 'commands', keywords: [], action: { type: 'execute-command', commandId: 'undo' } },
  ],
);
const throwingSource = vi.fn((): SearchableItem[] => {
  throw new Error('malformed schema');
});
const querySpy = vi.fn((_ctx: { query: string }): SearchableItem[] => []);

vi.mock('./sources', () => ({
  SEARCH_SOURCES: [
    () => throwingSource(),
    () => okSource(),
    (ctx: { query: string }) => querySpy(ctx),
  ],
}));

const { getAllSearchableItems } = await import('./search-registry');

describe('getAllSearchableItems', () => {
  it('keeps working sources when another throws', () => {
    const items = getAllSearchableItems('x');
    expect(items.map((i) => i.id)).toContain('ok:1');
  });

  it('passes the query trimmed and lower-cased', () => {
    querySpy.mockClear();
    getAllSearchableItems('  HeAdEr  ');
    expect(querySpy).toHaveBeenCalledWith({ query: 'header' });
  });

  it('defaults to an empty query', () => {
    querySpy.mockClear();
    getAllSearchableItems();
    expect(querySpy).toHaveBeenCalledWith({ query: '' });
  });

  it('dedupes by id, first source winning', () => {
    okSource.mockReturnValueOnce([
      { id: 'dup', name: 'First', category: 'commands', keywords: [], action: { type: 'execute-command', commandId: 'a' } },
      { id: 'dup', name: 'Second', category: 'commands', keywords: [], action: { type: 'execute-command', commandId: 'b' } },
    ]);
    const items = getAllSearchableItems('x');
    expect(items.filter((i) => i.id === 'dup')).toHaveLength(1);
    expect(items.find((i) => i.id === 'dup')?.name).toBe('First');
  });
});
