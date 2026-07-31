import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { parseInstanceEventBindings, setInstanceEventDelayInCode } from './instance-event-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = `import React from 'react';
import LoadMore from '@/components/LoadMore';
import advisors from '@/cms/advisors.json';
export default function Page() {
  const [visList, setVisList] = React.useState(6);
  return <div data-id="root">
    <div data-id="list" style={{ display: 'flex' }}>
      {advisors.slice(0, visList).map((item, idx) => <div data-id="row" key={idx}>{item.name}</div>)}
      {visList < advisors.length && <LoadMore data-id="loadmore-list" data-pagination-ui="true" onLoadMore={() => setVisList((c) => c + 6)} />}
    </div>
  </div>;
}`;

describe('parseInstanceEventBindings', () => {
  it('reports a bound event prop + its handler source', () => {
    const r = parseInstanceEventBindings(PAGE, 'loadmore-list', ['onLoadMore']);
    expect(r).toHaveLength(1);
    expect(r[0].propName).toBe('onLoadMore');
    expect(r[0].bound).toBe(true);
    expect(r[0].handler).toBe('() => setVisList((c) => c + 6)');
  });

  it('reports an unbound event prop when the instance omits the handler', () => {
    const noHandler = PAGE.replace(' onLoadMore={() => setVisList((c) => c + 6)}', '');
    const r = parseInstanceEventBindings(noHandler, 'loadmore-list', ['onLoadMore']);
    expect(r).toHaveLength(1);
    expect(r[0].bound).toBe(false);
    expect(r[0].handler).toBeNull();
  });

  it('returns empty for an unknown data-id', () => {
    expect(parseInstanceEventBindings(PAGE, 'nope', ['onLoadMore'])).toEqual([]);
  });

  it('returns empty when no event prop names are given', () => {
    expect(parseInstanceEventBindings(PAGE, 'loadmore-list', [])).toEqual([]);
  });

  it('does not crash on unparseable code', () => {
    expect(parseInstanceEventBindings('function (((', 'loadmore-list', ['onLoadMore'])).toEqual([]);
  });

  it('ignores event props that are not present on the tag (only the named ones)', () => {
    const r = parseInstanceEventBindings(PAGE, 'loadmore-list', ['onLoadMore', 'onClose']);
    expect(r.find(b => b.propName === 'onLoadMore')?.bound).toBe(true);
    expect(r.find(b => b.propName === 'onClose')?.bound).toBe(false);
  });

  it('reports delay 0 for an un-delayed handler', () => {
    expect(parseInstanceEventBindings(PAGE, 'loadmore-list', ['onLoadMore'])[0].delay).toBe(0);
  });
});

describe('setInstanceEventDelayInCode', () => {
  it('wraps the core call in setTimeout (delay in seconds → ms)', () => {
    const out = setInstanceEventDelayInCode(PAGE, 'loadmore-list', 'onLoadMore', 1.5);
    expect(out).toContain('onLoadMore={() => setTimeout(() => setVisList((c) => c + 6), 1500)}');
    parses(out);
    // round-trips: parsing the delayed handler reports 1.5s
    expect(parseInstanceEventBindings(out, 'loadmore-list', ['onLoadMore'])[0].delay).toBe(1.5);
  });

  it('re-applying a different delay replaces (does not double-wrap)', () => {
    const a = setInstanceEventDelayInCode(PAGE, 'loadmore-list', 'onLoadMore', 1);
    const b = setInstanceEventDelayInCode(a, 'loadmore-list', 'onLoadMore', 2);
    expect((b.match(/setTimeout/g) || []).length).toBe(1);
    expect(b).toContain('setTimeout(() => setVisList((c) => c + 6), 2000)');
    parses(b);
  });

  it('delay 0 unwraps back to the bare handler', () => {
    const delayed = setInstanceEventDelayInCode(PAGE, 'loadmore-list', 'onLoadMore', 1.5);
    const off = setInstanceEventDelayInCode(delayed, 'loadmore-list', 'onLoadMore', 0);
    expect(off).toContain('onLoadMore={() => setVisList((c) => c + 6)}');
    expect(off).not.toContain('setTimeout');
    parses(off);
  });

  it('is a no-op for an unknown node', () => {
    expect(setInstanceEventDelayInCode(PAGE, 'nope', 'onLoadMore', 1)).toBe(PAGE);
  });
});
