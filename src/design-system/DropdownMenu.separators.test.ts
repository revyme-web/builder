// Separator normalization for DropdownMenu — collapse adjacent separators and
// drop leading/trailing ones, so a conditionally-empty group (e.g. "Move to
// folder…" with no folders) never renders a double divider.
import { describe, test, expect } from 'vitest';
import { normalizeSeparators, type DropdownMenuEntry } from './DropdownMenu';

const sep = { type: 'separator' as const };
const item = (id: string): DropdownMenuEntry => ({ id, label: id, onClick: () => {} });
const ids = (entries: DropdownMenuEntry[]) =>
  entries.map((e) => ('type' in e && e.type === 'separator' ? '—' : (e as { id: string }).id));

describe('normalizeSeparators', () => {
  test('collapses two adjacent separators into one (the Templates menu bug)', () => {
    // edit, rename, sep, <empty move-to-folder>, sep, delete
    const got = normalizeSeparators([item('edit'), item('rename'), sep, sep, item('delete')]);
    expect(ids(got)).toEqual(['edit', 'rename', '—', 'delete']);
  });

  test('collapses a longer run of separators', () => {
    const got = normalizeSeparators([item('a'), sep, sep, sep, item('b')]);
    expect(ids(got)).toEqual(['a', '—', 'b']);
  });

  test('drops leading and trailing separators', () => {
    const got = normalizeSeparators([sep, item('a'), sep, item('b'), sep]);
    expect(ids(got)).toEqual(['a', '—', 'b']);
  });

  test('leaves a clean menu untouched', () => {
    const input = [item('edit'), item('rename'), sep, item('delete')];
    expect(ids(normalizeSeparators(input))).toEqual(['edit', 'rename', '—', 'delete']);
  });

  test('all-separator / empty input collapses to nothing', () => {
    expect(normalizeSeparators([sep, sep])).toEqual([]);
    expect(normalizeSeparators([])).toEqual([]);
  });
});
