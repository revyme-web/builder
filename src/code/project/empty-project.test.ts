// empty-project.test.ts — Locks down the file set + page shape produced
// by `createEmptyProject()`. The dashboard's "Create New Website" flow
// seeds new sites with this exact bundle (ProjectLoader seeds it when the
// backend snapshot is empty), so changes here are user-visible regressions.
//
// Current shape (post-@revyme/runtime, page-pair, bare-layout era):
//   - Pages ship as a PAIR: `page.tsx` (server wrapper, owns metadata) +
//     `page.client.tsx` (the canvas-editable 'use client' body).
//   - A bare root `app/layout.tsx` (from `ensureLayoutFile()`) is REQUIRED —
//     without it the preview renders with no layout chain and anything
//     mounted there (e.g. the cursor runtime's `<CursorPortal />`) never
//     appears. This was the missing-layout bug for fresh cloud websites.
//   - `app/globals.css` backs the layout's `import './globals.css'`.
//   - Runtime helpers (`withResponsiveProps`, `withCursor`, `CursorPortal`)
//     live in the `@revyme/runtime` npm package — NOT seeded as `lib/` files.
//   - The i18n RUNTIME scaffold (providers.tsx wrapping children in
//     next-themes + NextIntlClientProvider, i18n/config.json, empty
//     messages/*.json) IS included — it's infrastructure, not demo content:
//     a bare layout crashed every localized page with a missing
//     NextIntlClientProvider context in preview and on the live build
//     (2026-07-22). Demo content (about page, CMS, components) still lives
//     only in `createDefaultProject`.

import { describe, expect, it } from 'vitest';
import { createEmptyProject } from './project-fs';

describe('createEmptyProject', () => {
  const files = createEmptyProject();

  it('contains the page pair + root layout + globals + the i18n runtime scaffold', () => {
    expect([...files.keys()].sort()).toEqual([
      'app/globals.css',
      'app/layout.tsx',
      'app/page.client.tsx',
      'app/page.tsx',
      'app/providers.tsx',
      'i18n/config.json',
      'messages/en.json',
    ]);
  });

  it('seeds exactly ONE language', () => {
    // A project used to start with en + fr + es configured and empty message
    // files for each — two languages nobody asked for, which also emitted a
    // route wrapper per page per locale in the published build. `addLocale`
    // provisions everything a real language needs, so the seed carries none.
    const config = JSON.parse(files.get('i18n/config.json')!);
    expect(config.locales).toEqual([{ code: 'en', label: 'English' }]);
    expect(config.defaultLocale).toBe('en');
    expect([...files.keys()].filter(k => k.startsWith('messages/'))).toEqual(['messages/en.json']);
    expect([...files.keys()].some(k => /^i18n\/(?!config)/.test(k))).toBe(false);
  });

  it('providers imports only the seeded locale', () => {
    // providers.tsx does one `import ... from '@/messages/<code>.json'` per
    // configured locale, so a drift here is a build error on a missing file.
    const providers = files.get('app/providers.tsx')!;
    expect(providers).toContain('messages/en.json');
    expect(providers).not.toContain('messages/fr.json');
    expect(providers).not.toContain('messages/es.json');
  });

  it('omits demo content (no about page, no CMS, no components) but keeps the i18n runtime', () => {
    const keys = [...files.keys()];
    expect(keys.some(k => k.startsWith('app/about/'))).toBe(false);
    expect(keys.some(k => k.startsWith('cms/'))).toBe(false);
    expect(keys.some(k => k.startsWith('components/'))).toBe(false);
    // Runtime scaffold present; messages start EMPTY (no demo copy).
    expect(files.get('app/providers.tsx')).toContain('NextIntlClientProvider');
    expect(files.get('messages/en.json')).toBe('{}');
  });

  describe('app/layout.tsx (root layout — required for CursorPortal etc.)', () => {
    const layout = files.get('app/layout.tsx')!;

    it('exists and exports a RootLayout with an <html><body> shell', () => {
      expect(layout.length).toBeGreaterThan(0);
      expect(layout).toContain('export default function RootLayout');
      expect(layout).toContain('<html');
      expect(layout).toContain('<body>');
      expect(layout).toContain('<Providers>');
      expect(layout).toContain('</body>');
      expect(layout).toContain('{children}');
    });

    it('imports globals.css (the seeded stylesheet)', () => {
      expect(layout).toContain("import './globals.css'");
    });
  });

  it('globals.css is seeded and non-empty', () => {
    expect(files.get('app/globals.css')!.length).toBeGreaterThan(0);
  });

  describe('app/page.tsx (server wrapper)', () => {
    const page = files.get('app/page.tsx')!;

    it('renders the sibling client page and owns metadata', () => {
      expect(page).toContain("import PageClient from './page.client'");
      expect(page).toContain('export const metadata');
      expect(page).toContain('export default function Page()');
      expect(page).toContain('<PageClient />');
    });
  });

  describe('app/page.client.tsx (canvas-editable body)', () => {
    const page = files.get('app/page.client.tsx')!;

    it('is a use-client React page', () => {
      expect(page).toMatch(/^'use client';/);
      expect(page).toContain('export default function Page()');
      expect(page).toContain("from 'react'");
    });

    it('declares only a Desktop viewport in @canvas with height 900', () => {
      const match = page.match(/\/\*\*\s*@canvas\s*([\s\S]*?)\*\//);
      expect(match).not.toBeNull();
      const config = JSON.parse(match![1]);
      expect(config.viewports).toHaveLength(1);
      expect(config.viewports[0]).toMatchObject({
        id: 'desktop',
        label: 'Desktop',
        width: 1440,
        isPrimary: true,
        order: 0,
        height: 900,
      });
      expect(Object.keys(config.positions)).toEqual(['desktop']);
    });

    it('renders a single root <div> with no children', () => {
      expect(page).toContain('data-id="root"');
      expect(page).toContain("height: '900px'");
      expect(page).toContain("backgroundColor: '#ffffff'");
      const rootBodyMatch = page.match(/<div data-id="root"[\s\S]*?>([\s\S]*?)<\/div>/);
      expect(rootBodyMatch).not.toBeNull();
      // Body is whitespace only — no other JSX tags inside.
      expect(rootBodyMatch![1].trim()).toBe('');
    });
  });
});
