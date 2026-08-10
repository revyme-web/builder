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

// ─── The hook must land INSIDE the component ────────────────────────────────
//
// `ensureLocaleHook` anchored at the FIRST function declaration in the file. On
// any page carrying an injected module-scope helper (useResponsiveText /
// useMediaQuery) that helper comes first, so the hook was declared inside IT and
// the component threw "__activeLocale is not defined" on every render — the whole
// page blank. This is the same trap ensureMediaGate was fixed for on 2026-07-03;
// this function never inherited the fix (live find 2026-08-10, hit every project
// that opened after the CMS locale heal shipped).

const HELPER = `function useResponsiveText(primary, overrides, vpWidths) {
  const ref = useRef(null);
  return primary;
}
// @useResponsiveText-end`;

const WITH_HELPER = `'use client';
import { useLocale } from 'next-intl';
import React, { useState, useRef } from 'react';
import collection1 from '@/cms/collection-1.json';

${HELPER}

export default function Page() {
  return <div data-id="root">
    <div data-id="faqs">
      {collection1.map((item, idx) => (<div data-id="item" key={idx}>{item.title}</div>))}
    </div>
  </div>;
}
`;

/** The slice of the file that is the component body. */
const componentBody = (code: string) => code.slice(code.indexOf('export default function'));
const helperBody = (code: string) =>
  code.slice(code.indexOf('function useResponsiveText'), code.indexOf('export default function'));

describe('__activeLocale placement', () => {
  it('declares the hook INSIDE the component, not the helper above it', () => {
    const out = localizeCollectionListsInCode(WITH_HELPER);
    expect(componentBody(out)).toContain('const __activeLocale = useLocale();');
    expect(helperBody(out), 'the hook must NOT be in useResponsiveText').not.toContain('const __activeLocale');
  });

  it('declares it exactly once', () => {
    const out = localizeCollectionListsInCode(WITH_HELPER);
    expect(out.match(/const __activeLocale = useLocale\(\);/g)).toHaveLength(1);
  });

  it('REPAIRS a file already broken by the old anchor', () => {
    // Already wrapped + hook stuck in the helper: the exact on-disk state of
    // every project healed before the fix. It must not need a re-wrap to heal.
    const broken = `'use client';
import { useLocale } from 'next-intl';
import { localizeRows } from '@revyme/runtime';
import React, { useState, useRef } from 'react';
import collection1 from '@/cms/collection-1.json';

function useResponsiveText(primary, overrides, vpWidths) {
  const __activeLocale = useLocale();
  const ref = useRef(null);
  return primary;
}

export default function Page() {
  return <div data-id="root">
    <div data-id="faqs">
      {localizeRows(collection1, __activeLocale).map((item, idx) => (<div data-id="item" key={idx}>{item.title}</div>))}
    </div>
  </div>;
}
`;
    const out = localizeCollectionListsInCode(broken);
    expect(helperBody(out), 'the stale declaration must be removed').not.toContain('const __activeLocale');
    expect(componentBody(out)).toContain('const __activeLocale = useLocale();');
    expect(out.match(/const __activeLocale = useLocale\(\);/g)).toHaveLength(1);
  });

  it('the repaired file RESOLVES — no dangling reference left', () => {
    const out = localizeCollectionListsInCode(WITH_HELPER);
    const body = componentBody(out);
    // The declaration must precede the JSX reference inside the same body.
    expect(body.indexOf('const __activeLocale = useLocale();'))
      .toBeLessThan(body.indexOf('localizeRows(collection1, __activeLocale)'));
  });

  it('still a no-op on a correctly-placed file (idempotent)', () => {
    const once = localizeCollectionListsInCode(WITH_HELPER);
    expect(localizeCollectionListsInCode(once)).toBe(once);
  });
});
