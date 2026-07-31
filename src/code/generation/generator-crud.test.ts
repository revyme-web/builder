import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { setVariantTextBindingInCode, setVariantStyleBindingInCode, removeNodeInCode } from './generator-crud';

const parsesOk = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

describe('removeNodeInCode — attr value containing `>` (arrow handler)', () => {
  // Regression: a self-closing <input> with `onChange={(e) => …}` — the `=>` has
  // a `>` that the old indexOf('>') mistook for the tag close → delete bailed and
  // "the node just comes back". findTagClose (brace-aware) fixes it.
  const PAGE = `import React, { useState } from 'react';
export default function Page() {
  const [q, setQ] = useState("");
  return <div data-id="root">
    <input data-id="search" type="text" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} /><div data-id="list" style={{}}>items</div>
  </div>;
}`;

  it('removes the self-closing input even though onChange holds a `>`', () => {
    const out = removeNodeInCode(PAGE, 'search');
    expect(out).not.toContain('data-id="search"');
    expect(out).toContain('data-id="list"'); // sibling untouched
    parsesOk(out);
  });

  it('returns the code unchanged for a missing id', () => {
    expect(removeNodeInCode(PAGE, 'nope')).toBe(PAGE);
  });
});

// A design component master (no useState → discriminator is `initialVariant`) with a
// collection list whose row heading is CMS-bound to `item.role`.
const MASTER = `
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }, { name: 'variant-2' }];
function Frame({ initialVariant = 'default' }) {
  return (
    <div data-id="root">
      {advisors.map((item, idx) => (
        <div data-id="row" key={idx}>
          <h3 data-id="heading">{item.role}</h3>
        </div>
      ))}
    </div>
  );
}
`;
const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

describe('setVariantTextBindingInCode — per-variant CMS text binding', () => {
  it('rebinds variant-1 to a DIFFERENT field, keeping item.role as the base', () => {
    const out = setVariantTextBindingInCode(MASTER, 'heading', 'variant-1', { kind: 'field', field: 'title' }, 'item');
    expect(out).toMatch(/initialVariant === ["']variant-1["'] \? item\.title : item\.role/);
    parses(out);
  });

  it('unbind→default on variant-1 = a literal branch, base stays item.role', () => {
    const out = setVariantTextBindingInCode(MASTER, 'heading', 'variant-1', { kind: 'literal', value: '' }, 'item');
    expect(out).toMatch(/initialVariant === ["']variant-1["'] \? ["']["'] : item\.role/);
    parses(out);
  });

  it('editing the PRIMARY (default) rebinds the BASE, not a dead branch', () => {
    const out = setVariantTextBindingInCode(MASTER, 'heading', 'default', { kind: 'field', field: 'name' }, 'item');
    expect(out).toContain('item.name');
    expect(out).not.toMatch(/=== ["']default["']/);
    parses(out);
  });

  it('clear reverts the variant branch → collapses back to the plain base binding', () => {
    const bound = setVariantTextBindingInCode(MASTER, 'heading', 'variant-1', { kind: 'field', field: 'title' }, 'item');
    const cleared = setVariantTextBindingInCode(bound, 'heading', 'variant-1', { kind: 'clear' }, 'item');
    expect(cleared).toContain('{item.role}'); // collapsed back to plain base binding
    expect(cleared).not.toContain('item.title'); // the variant-1 override is gone
    parses(cleared);
  });

  it('a SECOND variant override preserves the first', () => {
    let out = setVariantTextBindingInCode(MASTER, 'heading', 'variant-1', { kind: 'field', field: 'title' }, 'item');
    out = setVariantTextBindingInCode(out, 'heading', 'variant-2', { kind: 'literal', value: 'N/A' }, 'item');
    expect(out).toContain('item.title');     // variant-1 preserved
    expect(out).toMatch(/["']N\/A["']/);     // variant-2 added
    expect(out).toContain('item.role');      // base preserved
    parses(out);
  });
});

// A row with an IMAGE style binding (backgroundImage: url(item.image)).
const STYLE_MASTER = [
  "const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }, { name: 'variant-2' }];",
  "function Frame({ initialVariant = 'default' }) {",
  "  return <div data-id=\"root\">{advisors.map((item, idx) => (",
  "    <div data-id=\"img\" key={idx} style={{ width: '60px', backgroundImage: `url(${item.image})` }} />",
  "  ))}</div>;",
  "}",
].join("\n");

describe('setVariantStyleBindingInCode — per-variant CMS style binding (image)', () => {
  it('unbind image on variant-1 → literal branch, base url(item.image) kept', () => {
    const out = setVariantStyleBindingInCode(STYLE_MASTER, 'img', 'backgroundImage', 'variant-1', { kind: 'literal', value: '' }, 'item');
    expect(out).toMatch(/initialVariant === ["']variant-1["'] \? "" :/);
    expect(out).toContain('url(${item.image})'); // base binding preserved on other variants
    parses(out);
  });

  it('rebind variant-1 to a DIFFERENT image field (url-wrapped), base kept', () => {
    const out = setVariantStyleBindingInCode(STYLE_MASTER, 'img', 'backgroundImage', 'variant-1', { kind: 'field', field: 'photo', isImage: true }, 'item');
    expect(out).toContain('url(${item.photo})'); // variant-1 rebound
    expect(out).toContain('url(${item.image})'); // base kept
    parses(out);
  });

  it('clear reverts the variant branch → collapses back to the plain base binding', () => {
    const bound = setVariantStyleBindingInCode(STYLE_MASTER, 'img', 'backgroundImage', 'variant-1', { kind: 'literal', value: 'none' }, 'item');
    const cleared = setVariantStyleBindingInCode(bound, 'img', 'backgroundImage', 'variant-1', { kind: 'clear' }, 'item');
    expect(cleared).not.toContain("'none'");        // override gone
    expect(cleared).not.toContain('"none"');
    expect(cleared).toContain('url(${item.image})'); // base restored
    parses(cleared);
  });
});

// ─── removeNodeInCode on a .map() collection-list TEMPLATE row ───────────────
// Deleting the template body must NOT strip just the JSX (that leaves
// `…map((item, idx) => )}` — a syntax error that blocks the batch; live find
// 2026-07-08). It empties the callback to `null` instead, keeping the `.map()`
// as a refillable Empty-State collection list inside the surviving container.
describe('removeNodeInCode — map template body', () => {
  const LIST_PAGE = `import React from 'react';
import works from '@/cms/works.json';
import Link from 'next/link';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <div data-id="col-c" data-name="Column C" style={{ position: 'relative', order: '0', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '30px' }}>
      {works.slice(4).map((item, index) => <Link key={item._id} data-cms-nav="row" data-id="col-c-card" href={\`/works/\${item?._slug ?? ''}\`} style={{ position: 'relative', order: '0', flex: '0 0 auto' }}>
        <div data-id="col-c-img" style={{ position: 'relative', order: '0', flex: '0 0 auto', height: '300px' }} />
      </Link>)}
    </div>
  </div>;
}`;

  it('deleting the template ROW empties the map to null (container + .map survive)', () => {
    const out = removeNodeInCode(LIST_PAGE, 'col-c-card');
    expect(out).not.toContain('col-c-card');
    expect(out).toMatch(/works\.slice\(4\)\.map\(\(item, index\) => null\)/);
    expect(out).toContain('data-id="col-c"'); // container survives
    // and the result PARSES (the old behavior produced `=> )}`)
    parsesOk(out);
  });

  it('deleting a CHILD inside the template uses the normal strip', () => {
    const out = removeNodeInCode(LIST_PAGE, 'col-c-img');
    expect(out).not.toContain('col-c-img');
    expect(out).toContain('col-c-card'); // template row survives
    expect(out).toContain('.map((item, index) =>');
  });
});
