// cms-locale-dialect.test.ts — the gate for translated CMS collections.
//
// The bug these rules exist for shipped to a real customer page (2026-08-10):
// an AI wrote per-locale DUPLICATE rows plus a `row.language` filter, hoisted
// the result into a const, and mapped that. It rendered — so no rule fired —
// but the parser could not resolve the head, and the builder saw no collection
// list and lost the field bindings on two of three sections. The owner could no
// longer edit their own content.
//
// The last test in this file is that exact page shape end-to-end.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codesOf = (code: string, kind: 'page' | 'component' = 'page') =>
  checkFile(code, { kind }).map((x) => x.code);

const page = (body: string, head = '') => `'use client';
import programme from '@/cms/programme.json';
import { useLocale } from 'next-intl';
${head}
export default function Page() {
  const locale = useLocale();
${body}
}
`;

const NATIVE = page(`  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" data-name="List" style={{ display: 'flex' }}>
        {localizeRows(programme, __activeLocale).map((row, idx) => (
          <div data-id="prog-card" data-name="Card" key={idx} style={{ width: '100px', height: '100px' }}>
            <h3 data-id="prog-title" data-name="Title" style={{ fontSize: '16px' }}>{row.title}</h3>
          </div>
        ))}
      </div>
    </div>
  );`, `import { localizeRows } from '@revyme/runtime';`).replace(
  'const locale = useLocale();', 'const __activeLocale = useLocale();');

describe('CMS_LOCALE_FILTER — selecting rows by language', () => {
  it('flags a filter against the active locale variable', () => {
    const code = page(`  const rows = programme.filter((row) => row.language === locale);
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {rows.map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}
      </div>
    </div>
  );`);
    expect(codesOf(code)).toContain('CMS_LOCALE_FILTER');
  });

  it('flags the FALLBACK half too — fixing only one line leaves it broken', () => {
    const code = page(`  const fb = programme.filter((row) => row.language === 'en');
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {fb.map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}
      </div>
    </div>
  );`);
    expect(codesOf(code)).toContain('CMS_LOCALE_FILTER');
  });

  it('teaches _i18n AND localizeRows in the message', () => {
    const code = page(`  const rows = programme.filter((row) => row.language === locale);
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <div data-id="prog-row" style={{ display: 'flex' }}>{rows.map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}</div>
  </div>);`);
    const msg = checkFile(code, { kind: 'page' }).find((x) => x.code === 'CMS_LOCALE_FILTER')!.message;
    expect(msg).toContain('_i18n');
    expect(msg).toContain('localizeRows(<collection>, __activeLocale)');
    expect(msg).toContain('never duplicate rows');
  });

  it('does NOT flag a content field that happens to be compared', () => {
    // A real CMS field named `category` is content, not a locale axis.
    const code = page(`  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {programme.filter((row) => row.category === 'talks').map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}
      </div>
    </div>
  );`);
    expect(codesOf(code)).not.toContain('CMS_LOCALE_FILTER');
  });

  it('does NOT flag a non-CMS array filtered by locale', () => {
    // The locale SWITCHER legitimately filters its own inline list of locales.
    const code = `'use client';
import { useLocale } from 'next-intl';
const LOCALES = [{ code: 'en' }, { code: 'fr' }];
export default function Page() {
  const locale = useLocale();
  const others = LOCALES.filter((l) => l.code !== locale);
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <div data-id="sw" style={{ display: 'flex' }}>{others.map((l, idx) => (<span data-id="sw-item" key={idx} style={{ fontSize: '12px' }}>{l.code}</span>))}</div>
  </div>);
}
`;
    expect(codesOf(code)).not.toContain('CMS_LOCALE_FILTER');
  });
});

describe('CMS_I18N_DIRECT_ACCESS — hand-rolling the merge', () => {
  it('flags reading the translation bag inline', () => {
    const code = page(`  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {programme.map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row._i18n?.[locale]?.title ?? row.title}</div>))}
      </div>
    </div>
  );`);
    expect(codesOf(code)).toContain('CMS_I18N_DIRECT_ACCESS');
  });

  it('stays silent on the native form', () => {
    expect(codesOf(NATIVE)).not.toContain('CMS_I18N_DIRECT_ACCESS');
  });
});

describe('CMS_MAP_UNRESOLVED — the general net (tier 3)', () => {
  it('flags a hoisted derivation the parser cannot resolve', () => {
    const code = page(`  const rows = programme.slice(0, 3);
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {rows.map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}
      </div>
    </div>
  );`);
    const violations = checkFile(code, { kind: 'page' });
    const hit = violations.find((x) => x.code === 'CMS_MAP_UNRESOLVED');
    expect(hit, 'a hoisted const head must be rejected').toBeDefined();
    expect(hit!.tier).toBe(3);
    expect(hit!.message).toContain('CHAIN AFTER the head');
  });

  it('ACCEPTS the inline chain — filters belong in the .map() head', () => {
    const code = page(`  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {programme.filter((row) => row.category === 'talks').slice(0, 6).map((row, idx) => (<div data-id="prog-card" key={idx} style={{ width: '10px', height: '10px' }}>{row.title}</div>))}
      </div>
    </div>
  );`);
    expect(codesOf(code)).not.toContain('CMS_MAP_UNRESOLVED');
  });

  it('ACCEPTS the localized head — the whole point of the migration', () => {
    expect(codesOf(NATIVE)).not.toContain('CMS_MAP_UNRESOLVED');
  });

  it('ignores a .map() that does not render JSX', () => {
    const code = page(`  const titles = programme.map((row) => row.title).join(', ');
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}><p data-id="t" style={{ fontSize: '12px' }}>{titles}</p></div>);`);
    expect(codesOf(code)).not.toContain('CMS_MAP_UNRESOLVED');
  });

  it("ACCEPTS the builder's own CMS index scaffold — it must pass its own gate", () => {
    // Shape of createCmsIndexPageFile: bare collection head, row <Link> with
    // data-cms-nav, inside a data-id container.
    const code = `'use client';
import Link from 'next/link';
import programme from '@/cms/programme.json';
export default function Page() {
  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="card-list" style={{ position: 'relative', display: 'grid', gap: '20px' }}>
      {programme.map((item, idx) => (
        <Link data-id="card" data-name="Card" key={idx} data-cms-nav="row" href={\`/programme/\${item?._slug ?? ''}\`} style={{ position: 'relative', display: 'flex' }}>
          <h3 data-id="card-title" style={{ fontSize: '18px' }}>{item.title}</h3>
        </Link>
      ))}
      </div>
    </div>
  );
}
`;
    expect(codesOf(code)).not.toContain('CMS_MAP_UNRESOLVED');
  });

  it('ignores a non-CMS rendered map', () => {
    const code = `'use client';
export default function Page() {
  const items = [{ label: 'a' }];
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <div data-id="row" style={{ display: 'flex' }}>{items.map((i, idx) => (<span data-id="cell" key={idx} style={{ fontSize: '12px' }}>{i.label}</span>))}</div>
  </div>);
}
`;
    expect(codesOf(code)).not.toContain('CMS_MAP_UNRESOLVED');
  });
});

describe('the real customer page (2026-08-10)', () => {
  // Verbatim shape of what shipped: duplicate rows per locale, a language
  // filter, an `…Locale.length > 0 ? … : …Fallback` ternary, and a map over the
  // derived const. The parser resolved programme-row to collectionList `null`.
  const BROKEN = `'use client';
import programme from '@/cms/programme.json';
import { useLocale } from 'next-intl';

export default function Page() {
  const locale = useLocale();
  const programmeFallback = programme.filter((row) => row.language === 'en');
  const programmeLocale = programme.filter((row) => row.language === locale);
  const programmeRows = programmeLocale.length > 0 ? programmeLocale : programmeFallback;
  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="programme-row" data-name="Programme" style={{ display: 'flex' }}>
        {programmeRows.map((row, idx) => (
          <div data-id="prog-card" data-name="Card" key={idx} style={{ width: '100px', height: '100px' }}>
            <h3 data-id="prog-title" data-name="Title" style={{ fontSize: '16px' }}>{row.title}</h3>
          </div>
        ))}
      </div>
    </div>
  );
}
`;

  it('is REJECTED — it was not before these rules', () => {
    const codes = codesOf(BROKEN);
    expect(codes).toContain('CMS_LOCALE_FILTER');
    expect(codes).toContain('CMS_MAP_UNRESOLVED');
  });

  it('flags BOTH filter lines, so a half-fix cannot pass', () => {
    const hits = checkFile(BROKEN, { kind: 'page' }).filter((x) => x.code === 'CMS_LOCALE_FILTER');
    expect(hits.length).toBe(2);
  });

  it('the migrated native form PASSES cleanly', () => {
    const FIXED = `'use client';
import { localizeRows } from '@revyme/runtime';
import programme from '@/cms/programme.json';
import { useLocale } from 'next-intl';

export default function Page() {
  const __activeLocale = useLocale();
  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="programme-row" data-name="Programme" style={{ display: 'flex' }}>
        {localizeRows(programme, __activeLocale).map((row, idx) => (
          <div data-id="prog-card" data-name="Card" key={idx} style={{ width: '100px', height: '100px' }}>
            <h3 data-id="prog-title" data-name="Title" style={{ fontSize: '16px' }}>{row.title}</h3>
          </div>
        ))}
      </div>
    </div>
  );
}
`;
    const codes = codesOf(FIXED);
    expect(codes).not.toContain('CMS_LOCALE_FILTER');
    expect(codes).not.toContain('CMS_MAP_UNRESOLVED');
    expect(codes).not.toContain('CMS_I18N_DIRECT_ACCESS');
  });
});
