// One overlay in the source rendered as four identical `Overlay` rows in the
// layers panel (user report 2026-09-21). The file was fine and the parse was
// fine — the tree assembly emitted the same node from more than one loop.

import { describe, it, expect } from 'vitest';
import { dedupeLayerRows } from './rows';

const row = (id: string) => ({ id });

describe('dedupeLayerRows', () => {
  it('keeps a list with no duplicates untouched', () => {
    const rows = [row('desktop:a'), row('desktop:b'), row('tablet:a')];
    const out = dedupeLayerRows(rows);
    expect(out.rows).toEqual(rows);
    expect(out.duplicates).toEqual([]);
  });

  it('drops a repeated row id and reports it', () => {
    const out = dedupeLayerRows([row('desktop:overlay-1'), row('desktop:frame'), row('desktop:overlay-1')]);
    expect(out.rows.map(r => r.id)).toEqual(['desktop:overlay-1', 'desktop:frame']);
    expect(out.duplicates).toEqual(['desktop:overlay-1']);
  });

  it('keeps the FIRST occurrence, which carries the correct depth', () => {
    const first = { id: 'desktop:x', depth: 2 };
    const second = { id: 'desktop:x', depth: 1 };
    expect(dedupeLayerRows([first, second]).rows[0]).toBe(first);
  });

  // The same node legitimately appears once per variant tile — those ids differ
  // by their viewport prefix and must all survive.
  it('never collapses the same node across viewports', () => {
    const rows = [row('desktop:overlay-1'), row('tablet:overlay-1'), row('mobile:overlay-1')];
    expect(dedupeLayerRows(rows).rows).toHaveLength(3);
  });

  it('handles the reported shape: four rows for one overlay', () => {
    const out = dedupeLayerRows(Array.from({ length: 4 }, () => row('desktop:overlay-frame-mub1m4ft-8-4')));
    expect(out.rows).toHaveLength(1);
    expect(out.duplicates).toHaveLength(3);
  });

  it('survives an empty list', () => {
    expect(dedupeLayerRows([])).toEqual({ rows: [], duplicates: [] });
  });
});
