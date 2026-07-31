// Generated per-locale route wrappers — path math + sync lifecycle.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetProjectFS, projectFS } from './project-fs';
import {
  localeRoutePath, pageUrlPath, buildLocaleRouteSource, syncLocaleRoutes, isLocaleRouteFile,
} from './locale-route-ops';
import type { I18nConfig } from '@/shared/types';

const CFG: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
    { code: 'it', label: 'Italian' },
  ],
};

describe('localeRoutePath', () => {
  it('home page', () => {
    expect(localeRoutePath('app/page.client.tsx', 'fr')).toBe('app/fr/page.tsx');
  });
  it('subdir page', () => {
    expect(localeRoutePath('app/about/page.client.tsx', 'fr')).toBe('app/fr/about/page.tsx');
  });
  it('route-group page keeps the template layout chain (locale INSIDE the group)', () => {
    expect(localeRoutePath('app/(Body)/about/page.client.tsx', 'it')).toBe('app/(Body)/it/about/page.tsx');
    expect(localeRoutePath('app/(Body)/page.client.tsx', 'fr')).toBe('app/(Body)/fr/page.tsx');
  });
  it('CMS dynamic segment', () => {
    expect(localeRoutePath('app/[slug]/page.client.tsx', 'fr')).toBe('app/fr/[slug]/page.tsx');
  });
});

describe('pageUrlPath', () => {
  it('strips groups and maps home to /', () => {
    expect(pageUrlPath('app/page.client.tsx')).toBe('/');
    expect(pageUrlPath('app/(Body)/about/page.client.tsx')).toBe('/about');
    expect(pageUrlPath('app/blog/[slug]/page.client.tsx')).toBe('/blog/[slug]');
  });
});

describe('buildLocaleRouteSource', () => {
  it('re-exports the server wrapper + hreflang alternates', () => {
    const src = buildLocaleRouteSource('app/(Body)/about/page.client.tsx', 'fr', CFG);
    expect(src).toContain("export { default } from '@/app/(Body)/about/page';");
    expect(src).toContain("canonical: '/fr/about'");
    expect(src).toContain("'en': '/about'");
    expect(src).toContain("'it': '/it/about'");
    expect(src).toContain('@revyme-locale-route fr');
  });
  it('dynamic routes skip static alternates but keep the route', () => {
    const src = buildLocaleRouteSource('app/[slug]/page.client.tsx', 'fr', CFG);
    expect(src).toContain("export { default } from '@/app/[slug]/page';");
    expect(src).not.toContain('alternates');
  });
});

describe('syncLocaleRoutes', () => {
  beforeEach(() => {
    resetProjectFS(new Map([
      ['app/page.client.tsx', 'x'], ['app/page.tsx', 'x'],
      ['app/about/page.client.tsx', 'x'], ['app/about/page.tsx', 'x'],
    ]));
  });

  it('creates pages × non-default locales, idempotently', () => {
    const first = syncLocaleRoutes(CFG);
    expect(first.written.sort()).toEqual([
      'app/fr/about/page.tsx', 'app/fr/page.tsx',
      'app/it/about/page.tsx', 'app/it/page.tsx',
    ]);
    expect(isLocaleRouteFile('app/fr/page.tsx')).toBe(true);
    const second = syncLocaleRoutes(CFG);
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('removes wrappers for removed locales and deleted pages', () => {
    syncLocaleRoutes(CFG);
    projectFS.deleteFile('app/about/page.client.tsx');
    projectFS.deleteFile('app/about/page.tsx');
    const noIt: I18nConfig = { ...CFG, locales: CFG.locales.filter(l => l.code !== 'it') };
    const out = syncLocaleRoutes(noIt);
    expect(out.removed.sort()).toEqual([
      'app/fr/about/page.tsx', 'app/it/about/page.tsx', 'app/it/page.tsx',
    ]);
    expect(projectFS.readFile('app/fr/page.tsx')).toBeTruthy();
  });

  it('never clobbers a REAL page named like a locale', () => {
    projectFS.writeFile('app/fr/page.client.tsx', 'real french page');
    projectFS.writeFile('app/fr/page.tsx', 'real server wrapper');
    const out = syncLocaleRoutes(CFG);
    expect(projectFS.readFile('app/fr/page.tsx')).toBe('real server wrapper');
    expect(out.removed).not.toContain('app/fr/page.tsx');
  });
});
