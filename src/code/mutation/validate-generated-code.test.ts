import { describe, it, expect } from 'vitest';
import { validateGeneratedCode } from './mutation-queue';

const page = (body: string) => `'use client';\nimport React from 'react';\nfunction useResponsiveText(p: string, o: Record<number, string>, w: number[]) { return p; }\nexport default function Page() {\n  return <div data-id="root">${body}</div>;\n}\n`;

describe('validateGeneratedCode — character-indexed properties', () => {
  it('lets responsive-text overrides keyed by viewport width through (second viewport edit)', () => {
    // Regression 2026-09-07: editing text on mobile then tablet produced two
    // width-keyed overrides and the old regex blocked the mutation.
    const code = page(`<p data-id="t">{useResponsiveText("Cena je 768 dinara", {\n  375: "sdfdsf",\n  768: "kdxdxd"\n}, [375, 768, 1440])}</p>`);
    expect(validateGeneratedCode(code)).toBeNull();
  });
  it('still rejects a JSON string spread into sequential numeric keys', () => {
    const code = page(`<p data-id="t" style={{ 0: 'a', 1: 'b', 2: 'c' }} />`);
    expect(validateGeneratedCode(code)).toMatch(/character-indexed/);
  });
});

// DUPLICATE data-id — the same node written into the file twice.
//
// Every structural generator resolves a node by its data-id, so two copies make
// the document ambiguous: the parser registers two nodes, the layers tree shows
// two rows, and later edits hit whichever copy they find first. Until this
// guard, `validateGeneratedCode` accepted it and the corruption reached the
// project silently (CMS "Load More" duplicated by a drag, user report
// 2026-09-19 — repeated drags multiplied it to four rows).
describe('validateGeneratedCode — duplicate data-id', () => {
  const page = (body: string) => `export default function Page() {
  return (
    <div data-id="root">
${body}
    </div>
  );
}`;

  it('rejects the same data-id twice', () => {
    const err = validateGeneratedCode(page(`      <div data-id="more">A</div>
      <div data-id="more">A</div>`));
    expect(err).toBeTruthy();
    expect(err).toContain('more');
  });

  it('the message names both line numbers so the copy is findable', () => {
    const err = validateGeneratedCode(page(`      <div data-id="more">A</div>
      <div data-id="more">A</div>`));
    expect(err).toMatch(/line \d+/);
  });

  it('catches a duplicate that is nested rather than a sibling', () => {
    const err = validateGeneratedCode(page(`      <div data-id="more">A</div>
      <div data-id="wrap"><div data-id="more">A</div></div>`));
    expect(err).toBeTruthy();
  });

  // The real shape: a gated copy left behind by a splice that no-opped.
  it('catches a copy left inside a conditional wrapper', () => {
    const err = validateGeneratedCode(`export default function Page() {
  const items = []; const visible = 0; const LoadMore = () => null;
  return (
    <div data-id="root">
      {visible < items.length && <LoadMore data-id="more" />}
      <LoadMore data-id="more" />
    </div>
  );
}`);
    expect(err).toBeTruthy();
    expect(err).toContain('more');
  });

  it('accepts a file where every data-id is unique', () => {
    expect(validateGeneratedCode(page(`      <div data-id="a">A</div>
      <div data-id="b">B</div>`))).toBeNull();
  });

  // A computed id belongs to a .map() row — legitimately one per record at
  // runtime, but a single occurrence in source. It must not be compared.
  it('ignores computed data-id expressions', () => {
    expect(validateGeneratedCode(`export default function Page() {
  const items = [];
  return (
    <div data-id="root">
      {items.map((item, i) => <div data-id={\`row-\${i}\`} key={i}>{item.t}</div>)}
    </div>
  );
}`)).toBeNull();
  });

  it('a .map() row template with a literal id is still a single occurrence', () => {
    expect(validateGeneratedCode(`export default function Page() {
  const items = [];
  return (
    <div data-id="root">
      {items.map((item, i) => <div data-id="row" key={i}>{item.t}</div>)}
    </div>
  );
}`)).toBeNull();
  });
});
