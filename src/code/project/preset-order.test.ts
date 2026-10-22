// preset-order.test.ts — every preset picker lists a category in the Presets
// panel's order (user report 2026-10-22: the panel was reordered, the
// typography popup still showed globals.css order).
import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { effectivePresetRootOrder, flattenPresetOrder, orderPresetTokens, type PresetOrderFolder } from './preset-order';
import type { PresetToken } from '@/shared/types';

const tok = (name: string, category: PresetToken['category']): PresetToken => ({ name, value: '1px', category });

describe('panel order', () => {
  const folders: PresetOrderFolder[] = [
    { id: 'pfld-1', parentId: null, children: ['b', 'pfld-2'] },
    { id: 'pfld-2', parentId: 'pfld-1', children: ['d'] },
  ];

  test('root order: stale ids dropped, unfiled items appended', () => {
    expect(effectivePresetRootOrder(['c', 'gone', 'pfld-1'], folders, ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'pfld-1', 'a', 'e']);
  });

  test('flattened: folders expand in place, depth-first', () => {
    expect(flattenPresetOrder(['c', 'pfld-1'], folders, ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'b', 'd', 'a', 'e']);
  });

  test('an item only an unreachable folder holds still comes out', () => {
    const orphan: PresetOrderFolder[] = [{ id: 'pfld-9', parentId: 'pfld-missing', children: ['x'] }];
    expect(flattenPresetOrder(['y'], orphan, ['x', 'y'])).toEqual(['y', 'x']);
  });
});

describe('orderPresetTokens', () => {
  const tokens = [
    tok('color-a', 'color'), tok('color-b', 'color'),
    tok('typo-body-font', 'typography'), tok('typo-body-size', 'typography'),
    tok('typo-hero-font', 'typography'), tok('typo-hero-size', 'typography'),
    tok('color-c', 'color'),
  ];
  const files: Record<string, { rootOrder: string[]; folders: PresetOrderFolder[] }> = {
    color: { rootOrder: ['color-c', 'color-a'], folders: [] },
    typography: { rootOrder: ['hero', 'body'], folders: [] },
  };
  const read = (cat: string) => files[cat] ?? { rootOrder: [], folders: [] };

  test('each category in panel order; categories keep their slots; groups move whole', () => {
    expect(orderPresetTokens(tokens, read).map((t) => t.name)).toEqual([
      'color-c', 'color-a',
      'typo-hero-font', 'typo-hero-size', 'typo-body-font', 'typo-body-size',
      'color-b',
    ]);
  });

  test('no folder file → globals.css order', () => {
    expect(orderPresetTokens(tokens, () => ({ rootOrder: [], folders: [] }))).toEqual(tokens);
  });
});
