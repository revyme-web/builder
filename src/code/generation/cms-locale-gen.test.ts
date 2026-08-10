// cms-locale-gen.test.ts — a collection list that resolves its own locale.
//
// The SOURCE does the work, not the renderer: `localizeRows` merges each row's
// `_i18n[locale]` over its base fields, so the published site translates itself
// with no build step. Before this, a translated collection saved fine and
// showed English everywhere (user report 2026-08-10).

import { describe, it, expect } from 'vitest';
import { localizeCollectionListsInCode } from './cms-locale-gen';
import { parseJSXToNodes } from '@/code/parsing/parser';

const PAGE = `'use client';
import programme from '@/cms/programme.json';
import reviews from '@/cms/reviews.json';
export default function Page() {
  return <div data-id="root">
    <div data-id="row">
      {programme.map((item, idx) => (
        <div data-id="card" key={idx}><h3 data-id="t">{item.title}</h3></div>
      ))}
    </div>
  </div>;
}
`;

describe('localizeCollectionListsInCode', () => {
  it('wraps the collection source', () => {
    expect(localizeCollectionListsInCode(PAGE))
      .toContain('localizeRows(programme, __activeLocale).map(');
  });

  it('adds the runtime import and the locale hook', () => {
    const out = localizeCollectionListsInCode(PAGE);
    expect(out).toMatch(/import \{ localizeRows \} from '@revyme\/runtime'/);
    expect(out).toMatch(/import \{ useLocale \} from 'next-intl'/);
    expect(out).toContain('const __activeLocale = useLocale();');
  });

  it('is IDEMPOTENT — healing on every load must not keep rewriting', () => {
    const once = localizeCollectionListsInCode(PAGE);
    expect(localizeCollectionListsInCode(once)).toBe(once);
  });

  it('returns the code UNCHANGED when nothing applies', () => {
    // The on-load heal runs over every file; an untouched project must not
    // come back modified (it would dirty history and autosave).
    const plain = `export default function Page() { return <div data-id="root" />; }`;
    expect(localizeCollectionListsInCode(plain)).toBe(plain);
  });

  it('leaves NON-CMS maps alone', () => {
    // An inline `const` array is not CMS content and has no `_i18n`.
    const inline = `import programme from '@/cms/programme.json';
const faqs = [{ q: 'a' }];
export default function Page() {
  return <div data-id="root">{faqs.map((f, i) => <p data-id="q" key={i}>{f.q}</p>)}</div>;
}`;
    expect(localizeCollectionListsInCode(inline)).toBe(inline);
  });

  it('keeps the filter/sort chain OUTSIDE the wrapper', () => {
    // The chain must still operate on whole rows, not on the wrapper call.
    const filtered = PAGE.replace('programme.map(', 'programme.filter(item => item.x === "y").sort((a, b) => 0).map(');
    const out = localizeCollectionListsInCode(filtered);
    expect(out).toContain('localizeRows(programme, __activeLocale).filter(item => item.x === "y").sort(');
  });

  it('handles several lists in one file', () => {
    const two = PAGE.replace('</div>\n  </div>;',
      '</div>\n    <div data-id="row2">{reviews.map((r, i) => <p data-id="q" key={i}>{r.quote}</p>)}</div>\n  </div>;');
    const out = localizeCollectionListsInCode(two);
    expect(out).toContain('localizeRows(programme, __activeLocale)');
    expect(out).toContain('localizeRows(reviews, __activeLocale)');
  });

  it('the result still PARSES as a collection list — the whole point', () => {
    // A localized list must stay fully editable: repeated rows, CMS panel,
    // live bindings. If the parser can't read the head back, the list goes
    // dark in the builder (which is exactly what a hand-written locale filter
    // did — user report 2026-08-09).
    const nodes = parseJSXToNodes(localizeCollectionListsInCode(PAGE));
    expect(nodes.get('row')?.collectionList?.source).toBe('programme');
    expect(nodes.get('row')?.collectionList?.itemVar).toBe('item');
    expect(nodes.get('t')?.binding).toEqual({ field: 'title', property: 'text' });
  });

  it('matches the IMPORT IDENTIFIER, not the slug', () => {
    // A slug can hold characters illegal in a JS identifier, so
    // `cms/collection-1.json` is imported as `collection1`. Matching on the
    // slug missed every hyphenated collection and the heal silently did
    // nothing for them (user report 2026-08-10).
    const hyphenated = `import collection1 from '@/cms/collection-1.json';
export default function Page() {
  return <div data-id="root">{collection1.map((item, idx) => <p data-id="t" key={idx}>{item.title}</p>)}</div>;
}`;
    expect(localizeCollectionListsInCode(hyphenated))
      .toContain('localizeRows(collection1, __activeLocale).map(');
  });

  it('does nothing in a file with no CMS import', () => {
    const none = `export default function Page() {
  const xs = [1];
  return <div data-id="root">{xs.map((x, i) => <p data-id="t" key={i}>{x}</p>)}</div>;
}`;
    expect(localizeCollectionListsInCode(none)).toBe(none);
  });
});
