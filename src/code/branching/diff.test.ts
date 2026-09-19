// branching/diff.test.ts — P8 (ii): grouped diff + coverage + invalidation.

import { describe, it, expect } from 'vitest';
import { groupDiff, groupChangedIds, unmeasuredCoverage, createDiffCache, hashFiles } from './diff';

const BEFORE = new Map([
  ['app/page.client.tsx', `<div data-id="root" style={{position:'relative'}}><p data-id="a" style={{position:'relative'}}>hi</p></div>`],
  ['app/other.tsx', `<div data-id="root" style={{position:'relative'}} />`],
]);
const AFTER = new Map([
  ['app/page.client.tsx', `<div data-id="root" style={{position:'relative'}}><p data-id="a" style={{position:'relative'}}>HELLO</p><p data-id="b" style={{position:'relative'}}>new</p></div>`],
  ['app/other.tsx', `<div data-id="root" style={{position:'relative'}} />`],
]);

describe('groupDiff', () => {
  it('groups per changed file with node deltas, untouched files absent', () => {
    const groups = groupDiff(BEFORE, AFTER);
    expect(groups).toHaveLength(1);
    expect(groups[0].path).toBe('app/page.client.tsx');
    expect(groups[0].addedIds).toContain('b');
    expect(groups[0].changedIds).toContain('a');
  });

  it('defaults to UNMEASURED coverage (never silently clean)', () => {
    const [g] = groupDiff(BEFORE, AFTER);
    expect(g.coverage.measured).toBe(0);
    expect(g.coverage.stale).toBe(false);
    expect(g.coverage.unmeasured).toEqual(expect.arrayContaining(['a', 'b']));
    expect(g.coverage.total).toBe(g.coverage.unmeasured.length);
  });

  it('attaches caller-provided measurements with stale flag', () => {
    const [g] = groupDiff(BEFORE, AFTER, { ids: new Set(['a']), stale: true });
    expect(g.coverage.measured).toBe(1);
    expect(g.coverage.unmeasured).not.toContain('a');
    expect(g.coverage.unmeasured).toContain('b');
    expect(g.coverage.stale).toBe(true);
  });

  it('groupChangedIds unions stably without duplicates', () => {
    expect(groupChangedIds({ addedIds: ['b'], removedIds: ['c'], changedIds: ['a', 'b'] })).toEqual(['b', 'c', 'a']);
  });

  it('unmeasuredCoverage counts honestly', () => {
    expect(unmeasuredCoverage({ path: 'x', addedIds: ['a'], removedIds: [], changedIds: ['b'] })).toEqual({
      total: 2,
      measured: 0,
      unmeasured: ['a', 'b'],
      stale: false,
    });
  });
});

describe('diff cache', () => {
  it('hits on identical content, misses on change, invalidates per branch', () => {
    const cache = createDiffCache();
    let computes = 0;
    const compute = () => {
      computes += 1;
      return groupDiff(BEFORE, AFTER);
    };
    const first = cache.get('a', BEFORE, AFTER, compute);
    expect(computes).toBe(1);
    expect(cache.get('a', BEFORE, AFTER, compute)).toBe(first);
    expect(computes).toBe(1);
    // Same content, other branch → separate key, recompute.
    cache.get('b', BEFORE, AFTER, compute);
    expect(computes).toBe(2);
    // Changed target → miss.
    cache.get('a', BEFORE, new Map([...AFTER, ['n.tsx', 'x']]), compute);
    expect(computes).toBe(3);
    // Invalidate one branch only.
    cache.invalidate('b');
    cache.get('a', BEFORE, AFTER, compute);
    expect(computes).toBe(3);
    cache.get('b', BEFORE, AFTER, compute);
    expect(computes).toBe(4);
    cache.invalidate();
    cache.get('a', BEFORE, AFTER, compute);
    expect(computes).toBe(5);
  });

  it('hashFiles is order-insensitive and content-sensitive', () => {
    const m1 = new Map([['a', '1'], ['b', '2']]);
    const m2 = new Map([['b', '2'], ['a', '1']]);
    expect(hashFiles(m1)).toBe(hashFiles(m2));
    expect(hashFiles(m1)).not.toBe(hashFiles(new Map([['a', '1'], ['b', '3']])));
  });
});
