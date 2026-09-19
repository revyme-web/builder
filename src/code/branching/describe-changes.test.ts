// branching/describe-changes.test.ts — P8-UX: human change rows.

import { describe, it, expect } from 'vitest';
import { describeFileChanges } from './describe-changes';

const PAGE = (body: string): string =>
  `export default function Page() { return (<div data-id="root">${body}</div>); }`;
const A = `<p data-id="a" data-name="Title" style={{ position: 'relative', color: 'red' }}>hi</p>`;

describe('describeFileChanges', () => {
  it('reports added and removed nodes with titles', () => {
    const r = describeFileChanges(PAGE(A), PAGE(`${A}<p data-id="b" data-name="Sub" style={{ position: 'relative' }}>new</p>`));
    expect(r.unparsed).toBe(false);
    expect(r.changes.filter((c) => c.kind === 'added').map((c) => c.id)).toEqual(['b']);
    expect(r.changes.find((c) => c.id === 'b')?.title).toBe('Sub');
    const r2 = describeFileChanges(PAGE(`${A}<p data-id="b">x</p>`), PAGE(A));
    expect(r2.changes.find((c) => c.id === 'b')?.kind).toBe('removed');
  });

  it('labels style and text changes with before/after', () => {
    const r = describeFileChanges(
      PAGE(A),
      PAGE(`<p data-id="a" data-name="Title" style={{ position: 'relative', color: 'blue', fontSize: '20px' }}>hello</p>`),
    );
    const changed = r.changes.filter((c) => c.kind === 'changed');
    expect(changed.map((c) => c.id)).toEqual(['a']);
    const labels = changed[0].props.map((p) => p.label);
    expect(labels).toContain('Color');
    expect(labels).toContain('Font size');
    expect(labels).toContain('Text');
    const color = changed[0].props.find((p) => p.label === 'Color')!;
    expect(color.before).toContain('red');
    expect(color.after).toContain('blue');
  });

  it('reports moves by parent change', () => {
    const before = PAGE(`${A}<section data-id="s" style={{ position: 'relative' }}></section>`);
    const after = PAGE(`<section data-id="s" style={{ position: 'relative' }}>${A}</section>`);
    const r = describeFileChanges(before, after);
    expect(r.changes.find((c) => c.id === 'a')?.kind).toBe('moved');
  });

  it('never throws on odd input; null sides read as empty', () => {
    // The parser is lenient and consistent: same odd input both sides
    // yields no phantom diff; a null side reads as an empty map
    // (whole-side add/remove).
    expect(describeFileChanges('not jsx (((( ', 'not jsx (((( ').changes).toEqual([]);
    expect(describeFileChanges(null, PAGE(A)).changes.filter((c) => c.kind === 'added').length).toBeGreaterThan(0);
  });

  it('is silent when nothing changed', () => {
    expect(describeFileChanges(PAGE(A), PAGE(A)).changes).toEqual([]);
  });
});
