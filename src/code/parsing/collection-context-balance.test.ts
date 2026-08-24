// The `.map()` visitor pushes a collection context on ENTER and pops it on
// EXIT. Both sides walk the call chain to decide whether the map is over a CMS
// collection — and they MUST agree, because an unbalanced push is not a local
// bug: the stack never returns to 0, so every node parsed afterwards inherits
// `isCollectionTemplate = true`.
//
// That flag gates CMS field binding (see editor/controls/cms-binding-scope.ts),
// so a leak means a component dropped in an unrelated section further down the
// page is offered `item.field` bindings that cannot resolve — a ReferenceError
// at render. Reported 2026-08-24 against the `localizeRows(...)` head, which
// enter() unwrapped and exit() did not.

import { describe, it, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

/** A page whose list uses `head`, followed by a sibling and a later section. */
const page = (head: string) => `'use client';
import { localizeRows } from '@revyme/runtime';
import collection1 from '@/cms/collection-1.json';
export default function Page() {
  const __activeLocale = 'en';
  return <div data-id="root" data-name="Page">
    <div data-id="list" data-name="Case studies">
      {${head}.map((item, idx) => <a data-id="row" data-name="Case study" key={idx}>{item.title}</a>)}
      <div data-id="sibling" data-name="Sibling of the map" />
    </div>
    <div data-id="far-away" data-name="Unrelated later section" />
  </div>;
}`;

/** The row is in the callback; nothing after it is. */
function expectBalanced(head: string) {
  const nodes = parseJSXToNodes(page(head));
  expect(nodes.get('row')?.isCollectionTemplate, `${head}: row should be a template`).toBe(true);
  expect(nodes.get('sibling')?.isCollectionTemplate, `${head}: sibling leaked`).toBeUndefined();
  expect(nodes.get('far-away')?.isCollectionTemplate, `${head}: later section leaked`).toBeUndefined();
}

describe('collection context stack stays balanced', () => {
  it('plain collection', () => expectBalanced('collection1'));

  it('localized head — the reported leak', () => {
    expectBalanced('localizeRows(collection1, __activeLocale)');
  });

  it('filter / sort / slice chains', () => {
    expectBalanced('collection1.filter(i => i.on)');
    expectBalanced('collection1.sort((a, b) => 0)');
    expectBalanced('collection1.slice(0, 3)');
    expectBalanced('collection1.filter(i => i.on).sort((a, b) => 0).slice(0, 3)');
  });

  it('localized head PLUS a chain', () => {
    expectBalanced('localizeRows(collection1, __activeLocale).filter(i => i.on)');
    expectBalanced('localizeRows(collection1, __activeLocale).slice(0, 2)');
  });

  it('two lists in one file do not compound', () => {
    // Each unbalanced push stacks, so a second list made the leak permanent
    // even if one side happened to pop.
    const code = `'use client';
import { localizeRows } from '@revyme/runtime';
import collection1 from '@/cms/collection-1.json';
export default function Page() {
  const __activeLocale = 'en';
  return <div data-id="root" data-name="Page">
    <div data-id="l1">{localizeRows(collection1, __activeLocale).map((item, i) => <a data-id="r1" key={i}>{item.t}</a>)}</div>
    <div data-id="l2">{localizeRows(collection1, __activeLocale).map((item, i) => <a data-id="r2" key={i}>{item.t}</a>)}</div>
    <div data-id="after" data-name="After both lists" />
  </div>;
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('r1')?.isCollectionTemplate).toBe(true);
    expect(nodes.get('r2')?.isCollectionTemplate).toBe(true);
    expect(nodes.get('after')?.isCollectionTemplate).toBeUndefined();
  });

  it('a non-collection .map() never pushes in the first place', () => {
    const code = `export default function Page() {
  const rows = window.stuff;
  return <div data-id="root">
    {rows.map((r, i) => <a data-id="row" key={i}>{r}</a>)}
    <div data-id="sibling" />
  </div>;
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('sibling')?.isCollectionTemplate).toBeUndefined();
  });
});
