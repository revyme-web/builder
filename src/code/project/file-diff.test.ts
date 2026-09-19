import { describe, it, expect } from 'vitest';
import { diffTurnChanges } from './file-diff';

const page = (inner: string) => `'use client';
import React from 'react';
export default function Page() {
  return (<div data-id="root" data-name="Page" style={{ position: 'relative' }}>
${inner}
  </div>);
}`;

const box = (id: string, style = "position: 'relative'", extra = '') =>
  `    <div data-id="${id}" data-name="${id}" style={{ ${style} }}${extra}></div>`;

describe('diffTurnChanges', () => {
  it('reports nothing when the code is identical', () => {
    const m = new Map([['app/page.client.tsx', page(box('a'))]]);
    expect(diffTurnChanges(m, new Map(m))).toEqual([]);
  });

  it('reports added / removed / changed ids per file', () => {
    const before = new Map([['p.tsx', page(box('a') + '\n' + box('b'))]]);
    const after = new Map([['p.tsx', page(box('a', "position: 'absolute'") + '\n' + box('c'))]]);
    const [d] = diffTurnChanges(before, after);
    expect(d.path).toBe('p.tsx');
    expect(d.changedIds).toContain('a');   // style edited
    expect(d.addedIds).toContain('c');
    expect(d.removedIds).toContain('b');
  });

  it('a reformat-only rewrite is NOT a change (nodes compared, not text)', () => {
    const before = new Map([['p.tsx', page(box('a'))]]);
    // same nodes, different whitespace
    const after = new Map([['p.tsx', page(box('a').replace('><', '>\n<'))]]);
    const d = diffTurnChanges(before, after);
    expect(d.every((f) => f.changedIds.length === 0)).toBe(true);
  });

  it('an unparseable side yields empty id sets rather than guesses', () => {
    const before = new Map([['p.tsx', page(box('a'))]]);
    const after = new Map([['p.tsx', 'export default function Page() { return (<div']]);
    expect(diffTurnChanges(before, after)).toEqual([
      { path: 'p.tsx', addedIds: [], removedIds: [], changedIds: [] },
    ]);
  });

  it('file creation and deletion are reported', () => {
    const before = new Map([['gone.tsx', page(box('a'))]]);
    const after = new Map([['new.tsx', page(box('z'))]]);
    const byPath = Object.fromEntries(diffTurnChanges(before, after).map((d) => [d.path, d]));
    expect(byPath['new.tsx'].addedIds).toContain('z');
    expect(byPath['gone.tsx'].removedIds).toContain('a');
  });

  it('output order is deterministic', () => {
    const before = new Map([['b.tsx', page(box('x'))], ['a.tsx', page(box('y'))]]);
    const after = new Map([['b.tsx', page(box('x2'))], ['a.tsx', page(box('y2'))]]);
    expect(diffTurnChanges(before, after).map((d) => d.path)).toEqual(['a.tsx', 'b.tsx']);
  });

  // The regression the derived projection exists to prevent.
  it('detects a change in a field the fork’s hand-written projection omitted', () => {
    // `order` is one of the 18 CanvasNode fields the fork never diffed.
    const before = new Map([['p.tsx', page(box('a', "position: 'relative', order: '1'"))]]);
    const after = new Map([['p.tsx', page(box('a', "position: 'relative', order: '2'"))]]);
    expect(diffTurnChanges(before, after)[0].changedIds).toContain('a');
  });

  it('detects an attribute-only change', () => {
    // `href` is a parser-captured attr (`title` is not — attrs are a whitelist).
    const before = new Map([['p.tsx', page(box('a', "position: 'relative'", ' href="/one"'))]]);
    const after = new Map([['p.tsx', page(box('a', "position: 'relative'", ' href="/two"'))]]);
    expect(diffTurnChanges(before, after)[0].changedIds).toContain('a');
  });
});
