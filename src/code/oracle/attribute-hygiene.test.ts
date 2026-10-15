// attribute-hygiene.test.ts — duplicate JSX attributes (judged + healed on
// load) and large inline base64 data URIs (judged in source, refused in a
// site's custom code). Both came out of one customer project (2026-10-15).

import { describe, expect, it, vi } from 'vitest';
import { checkFile } from './check-file';
import { healDuplicateJsxAttributes } from '@/code/generation/duplicate-attr-heal';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { setSiteMetadataTool } from '@/ai/agent/tools/pages-more';

const page = (inner: string) => `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%', height: 'auto' }}>
      ${inner}
    </div>
  );
}
`;

const codes = (src: string) => checkFile(src, { kind: 'page' }).map((v) => v.code);

describe('DUPLICATE_ATTRIBUTE', () => {
  it('flags a repeated attribute on one element, with its data-id and line', () => {
    const src = page(`<img data-id="pic" alt="a" src="/x.png" alt={label} style={{ position: 'relative', width: '10px', height: '10px' }} />`);
    const v = checkFile(src, { kind: 'page' }).find((x) => x.code === 'DUPLICATE_ATTRIBUTE')!;
    expect(v).toBeTruthy();
    expect(v.elementId).toBe('pic');
    expect(v.line).toBe(8);
    expect(v.message).toMatch(/"alt"/);
  });

  it('is silent for distinct attributes, spreads and look-alike names', () => {
    const src = page(`<div data-id="a" data-name="A" name="x" {...rest} style={{ position: 'relative', width: '10px', height: '10px' }}></div>`);
    expect(codes(src)).not.toContain('DUPLICATE_ATTRIBUTE');
  });
});

describe('healDuplicateJsxAttributes', () => {
  it('keeps the LAST copy (the one that renders) and nothing else changes', () => {
    const src = page(`<Hero data-id="h" layout="a" title="T" layout={b} />`);
    const healed = healDuplicateJsxAttributes(src);
    expect(healed).toBe(src.replace(' layout="a"', ''));
  });

  it('a nested-brace expression copy is removed whole', () => {
    const src = page(`<Hero data-id="h" items={[{ a: { b: 1 } }]} items={[]} />`);
    expect(healDuplicateJsxAttributes(src)).toContain('<Hero data-id="h" items={[]} />');
  });

  it('no duplicates → the same string back', () => {
    const src = page('<Hero data-id="h" a="1" b={2} />');
    expect(healDuplicateJsxAttributes(src)).toBe(src);
  });

  it('runs on project load for pages and components', () => {
    resetProjectFS();
    projectFS.loadSnapshot(new Map([
      ['app/page.client.tsx', page(`<Hero data-id="h" onViewportEnter={a} onViewportEnter={b} />`)],
      ['components/Card.tsx', `export default function Card() { return <div data-id="c" x="1" x="2" />; }`],
    ]));
    expect(projectFS.readFile('app/page.client.tsx')).toContain('<Hero data-id="h" onViewportEnter={b} />');
    expect(projectFS.readFile('components/Card.tsx')).toContain('<div data-id="c" x="2" />');
  });
});

describe('INLINE_DATA_URI_TOO_LARGE', () => {
  const blob = 'A'.repeat(30_000);

  it('flags a large base64 data URI in a page, quiet for a small one', () => {
    expect(codes(page(`<div data-id="bg" style={{ position: 'relative', width: '10px', height: '10px', backgroundImage: 'url(data:image/png;base64,${blob})' }}></div>`))).toContain('INLINE_DATA_URI_TOO_LARGE');
    expect(codes(page(`<div data-id="bg" style={{ position: 'relative', width: '10px', height: '10px', backgroundImage: 'url(data:image/png;base64,${'A'.repeat(500)})' }}></div>`))).not.toContain('INLINE_DATA_URI_TOO_LARGE');
  });
});

describe('set_site_metadata custom code', () => {
  const ctx = () => ({ ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal });
  const layout = (head: string) => `import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: '',
  description: '',
};

export const siteConfig = {
  language: 'en',
  theme: 'light',
  customHead: ${JSON.stringify(head)},
  customBody: '',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html><body><Providers>{children}</Providers></body></html>);
}
`;
  const font = `<style>@font-face{font-family:'PR Serif';src:url(data:font/woff2;base64,${'B'.repeat(40_000)}) format('woff2')}</style>`;

  it('refuses a NEW inline font in custom code, writes nothing', async () => {
    resetProjectFS();
    projectFS.loadSnapshot(new Map([['app/layout.tsx', layout('')]]));
    const before = projectFS.readFile('app/layout.tsx');
    const r = await setSiteMetadataTool.execute({ custom_code_head: font }, ctx());
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/font\/woff2 \(\d+ KB\).*font library/);
    expect(projectFS.readFile('app/layout.tsx')).toBe(before);
  });

  it('an inline font already there does not block an unrelated custom-code change — it warns', async () => {
    resetProjectFS();
    projectFS.loadSnapshot(new Map([['app/layout.tsx', layout(font)]]));
    const r = await setSiteMetadataTool.execute({ custom_code_head: `${font}<meta name="x" content="y">` }, ctx());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as { text: string }).text).warning).toMatch(/still embeds font\/woff2/);
  });
});
