// router.ts — File-system → URL routing, mirroring Next.js app/ conventions.
//
// Pages live as a PAIR — `<dir>/page.tsx` (server wrapper, owns the SEO
// `metadata` export) and `<dir>/page.client.tsx` (the canvas-editable
// body). The preview sandbox routes against the `.client.tsx` half
// since that's the file we actually render.
//
// Rules:
//   • `app/page.client.tsx` → `/`
//   • `app/about/page.client.tsx` → `/about`
//   • `app/(marketing)/page.client.tsx` → `/` (route group, parens don't appear in URL)
//   • `app/blog/[slug]/page.client.tsx` → `/blog/:slug` (dynamic segment)
//   • `app/shop/[...path]/page.client.tsx` → `/shop/*` (catch-all)
// For each page, walk up the directory tree collecting `layout.tsx` files —
// outermost layout is applied first when rendering. `(group)` directories
// disappear from the URL but their layout still wraps.
//
// Not implemented (rare; defer): `[[...slug]]` optional catch-all,
// `@modal` parallel routes, `(.)about` intercepting routes.

export interface Route {
  /** Compiled regex matching the URL path. */
  pattern: RegExp;
  /** Names of dynamic segment captures (in match-group order). */
  paramNames: string[];
  /** ProjectFS path of the page component. */
  pageFile: string;
  /** ProjectFS paths of layouts, outer-most first. */
  layoutChain: string[];
  /** Params resolved from a URL match (populated by resolveRoute). */
  params?: Record<string, string>;
}

export function buildRouteTable(files: Map<string, string>): Route[] {
  const routes: Route[] = [];
  const filePaths = Array.from(files.keys());

  for (const file of filePaths) {
    if (!file.startsWith('app/')) continue;
    // Route against the canvas-editable .client.tsx half of each page
    // pair. The server-wrapper `page.tsx` lives next to it but is
    // skipped here — it's just a 5-line shim that re-exports the client.
    // EXCEPTION: generated LOCALE ROUTES (app/fr/... wrappers, see
    // locale-route-ops.ts) are plain page.tsx files with NO client half —
    // they ARE real routes (/fr/...) and must resolve in preview or
    // switching locale blanks the page. Marker-gated so stray server
    // wrappers never double-route.
    if (!file.endsWith('/page.client.tsx') && file !== 'app/page.client.tsx') {
      const hasClientHalf = files.has(file.replace(/\/page\.tsx$/, '/page.client.tsx'));
      const isLocaleWrapper = file.endsWith('/page.tsx') && !hasClientHalf
        && (files.get(file) ?? '').includes('@revyme-locale-route');
      if (!isLocaleWrapper) continue;
    }

    const segments = file
      .replace(/^app\//, '')
      .replace(/\/page(\.client)?\.tsx$/, '')
      .replace(/^page(\.client)?\.tsx$/, '')
      .split('/')
      .filter(Boolean);

    const urlSegs: string[] = [];
    const paramNames: string[] = [];

    for (const s of segments) {
      // Route group: `(marketing)` — hidden from URL.
      if (/^\([^)]+\)$/.test(s)) continue;
      // Catch-all: `[...slug]` → captures the rest.
      const catchAll = s.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) {
        urlSegs.push('(.+)');
        paramNames.push(catchAll[1]);
        continue;
      }
      // Dynamic segment: `[slug]`.
      const dyn = s.match(/^\[(.+)\]$/);
      if (dyn) {
        urlSegs.push('([^/]+)');
        paramNames.push(dyn[1]);
        continue;
      }
      // Static — escape regex metas just in case.
      urlSegs.push(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }

    const pattern = urlSegs.length === 0
      ? /^\/?$/
      : new RegExp('^/' + urlSegs.join('/') + '/?$');

    // Walk up collecting layouts. Start from the page's directory; for each
    // ancestor, look for `<dir>/layout.tsx` in ProjectFS.
    const layoutChain: string[] = [];
    let dir = file.slice(0, file.lastIndexOf('/'));
    while (true) {
      const layoutPath = dir + '/layout.tsx';
      if (files.has(layoutPath)) layoutChain.unshift(layoutPath);
      if (dir === 'app') break;
      const next = dir.slice(0, dir.lastIndexOf('/'));
      if (next === dir || next === '') break;
      dir = next;
    }

    routes.push({ pattern, paramNames, pageFile: file, layoutChain });
  }

  // Sort: more-specific routes (more segments, fewer dynamic params) first
  // so `/blog/published` wins over `/blog/[slug]` when both exist.
  routes.sort((a, b) => {
    const aDyn = a.paramNames.length;
    const bDyn = b.paramNames.length;
    if (aDyn !== bDyn) return aDyn - bDyn;
    return b.pattern.source.length - a.pattern.source.length;
  });

  return routes;
}

export function resolveRoute(routes: Route[], url: string): Route | null {
  for (const r of routes) {
    const m = url.match(r.pattern);
    if (m) {
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? ''; });
      return { ...r, params };
    }
  }
  return null;
}
