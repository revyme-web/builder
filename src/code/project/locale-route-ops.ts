// locale-route-ops.ts — generated per-locale route wrappers ("/fr/..." URLs).
//
// Every page × non-default locale gets a tiny GENERATED pointer route:
//   app/(Body)/about/page.client.tsx  →  app/(Body)/fr/about/page.tsx
// The pointer re-exports the page's own SERVER wrapper (params flow through
// untouched — CMS [slug] detail pages included) and declares hreflang
// alternates. The locale segment is inserted AFTER any leading route-group
// dirs so a template's layout still wraps its localized routes, and the
// active locale itself is resolved route-first by app/providers.tsx (see
// providers-gen.ts) — which is also why a template's shared header
// translates on /fr/ URLs.
//
// "Source is deploy reality": these are real files in the project; the
// deploy pipeline does nothing special. The editor keeps them in sync on
// project load, locale add/remove, and page create/move/delete. They carry a
// marker comment so sync can safely delete stale ones, and they are
// invisible in the Pages panel (which lists page.client.tsx files only).

import { projectFS } from './project-fs';
import { trace } from '@/shared/debug-trace';
import type { I18nConfig } from '@/shared/types';

export const LOCALE_ROUTE_MARKER = '@revyme-locale-route';

/** Is this path a generated locale route wrapper? */
export function isLocaleRouteFile(path: string, code?: string): boolean {
  if (!path.startsWith('app/') || !path.endsWith('/page.tsx')) return false;
  const c = code ?? projectFS.readFile(path) ?? '';
  return c.includes(LOCALE_ROUTE_MARKER);
}

/** app/(Body)/about/page.client.tsx + 'fr' → app/(Body)/fr/about/page.tsx.
 *  The locale segment goes after the leading route-group dirs so the
 *  template layout chain still applies to the localized route. */
export function localeRoutePath(pageClientPath: string, locale: string): string {
  const dir = pageClientPath.replace(/\/page\.client\.tsx$/, '');
  const segs = dir.split('/');
  let insertAt = 1; // after 'app'
  while (insertAt < segs.length && /^\(.+\)$/.test(segs[insertAt])) insertAt++;
  return [...segs.slice(0, insertAt), locale, ...segs.slice(insertAt)].join('/') + '/page.tsx';
}

/** URL a page file serves: app/(Body)/about/page.client.tsx → '/about'
 *  (route groups vanish from URLs; the home page → '/'). */
export function pageUrlPath(pageClientPath: string): string {
  const dir = pageClientPath.replace(/\/page\.client\.tsx$/, '');
  const segs = dir.split('/').slice(1).filter((s) => !/^\(.+\)$/.test(s));
  return '/' + segs.join('/');
}

/** The pointer file's source. `pageDir` = the page's dir (holds page.tsx). */
export function buildLocaleRouteSource(
  pageClientPath: string,
  locale: string,
  config: I18nConfig,
): string {
  const pageDir = pageClientPath.replace(/\/page\.client\.tsx$/, '');
  const url = pageUrlPath(pageClientPath);
  const localeUrl = url === '/' ? `/${locale}` : `/${locale}${url}`;
  // Dynamic segments ([slug]) have no static URL — skip the alternates
  // metadata; the route itself still works.
  const isDynamic = url.includes('[');
  const languages = config.locales
    .map((l) => {
      const u = l.code === config.defaultLocale
        ? url
        : (url === '/' ? `/${l.code}` : `/${l.code}${url}`);
      return `      '${l.code}': '${u}',`;
    })
    .join('\n');
  const metadata = isDynamic ? '' : `
export const metadata = {
  alternates: {
    canonical: '${localeUrl}',
    languages: {
${languages}
    },
  },
};
`;
  return `/** ${LOCALE_ROUTE_MARKER} ${locale} — GENERATED route for ${localeUrl}.
 *  Content lives in ${pageClientPath}; app/providers.tsx resolves the locale
 *  from the URL. The editor regenerates this file on locale/page changes.
 *  Do not edit. */
export { default } from '@/${pageDir}/page';
${metadata}`;
}

/** Bring the wrapper set in line with (pages × non-default locales).
 *  Idempotent; returns what changed. */
export function syncLocaleRoutes(config: I18nConfig): { written: string[]; removed: string[] } {
  const pages = projectFS.listFiles('app/').filter((f) => f.endsWith('page.client.tsx'));
  const locales = config.locales
    .map((l) => l.code)
    .filter((c) => c !== config.defaultLocale && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(c));

  const desired = new Map<string, string>();
  for (const page of pages) {
    for (const locale of locales) {
      const wrapperPath = localeRoutePath(page, locale);
      // COLLISION GUARD: a real page named like the locale (app/fr/page.client.tsx)
      // owns that route — never clobber its server wrapper.
      const sibling = wrapperPath.replace(/\/page\.tsx$/, '/page.client.tsx');
      if (projectFS.readFile(sibling) != null) {
        trace.action('locale-routes:skip-collision', { wrapperPath, page, locale });
        continue;
      }
      desired.set(wrapperPath, buildLocaleRouteSource(page, locale, config));
    }
  }

  const written: string[] = [];
  const removed: string[] = [];
  for (const [path, src] of desired) {
    if (projectFS.readFile(path) !== src) {
      projectFS.writeFile(path, src);
      written.push(path);
    }
  }
  // Delete stale wrappers (marker-carrying page.tsx not in the desired set —
  // removed locales, deleted/moved pages).
  for (const f of projectFS.listFiles('app/')) {
    if (!f.endsWith('/page.tsx') || desired.has(f)) continue;
    if (isLocaleRouteFile(f)) {
      projectFS.deleteFile(f);
      removed.push(f);
    }
  }
  if (written.length > 0 || removed.length > 0) {
    trace.action('locale-routes:sync', { written, removed, pages: pages.length, locales });
  }
  return { written, removed };
}
