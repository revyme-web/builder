// main.tsx — Preview iframe entrypoint.
//
// Boot sequence:
//   1. Mount a placeholder ("Waiting for project…") into #root.
//   2. Listen for a `preview:project-files` postMessage from the parent
//      carrying the user's ProjectFS contents.
//   3. Build a Next.js-style route table from `app/**/page.tsx`.
//   4. On every URL change (popstate / pushState shim), pick the matching
//      route, compile every file in its layout chain via Babel, and render.
//   5. On `preview:file-update` postMessage, re-compile the changed file and
//      re-render the active route — instant hot reload.
//
// Module resolution: each compiled file's `import` statements are rewritten
// to look up the named export in MODULE_MAP. `react`, `react-dom`,
// `next-themes`, `framer-motion`, and the `next/{link,image,navigation}`
// shims are bundled at build time. User-defined imports
// (`@/components/Foo`, `./helpers`) compile from ProjectFS the same way.

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { captureThumbnail } from './capture-thumbnail';
import { ThemeProvider as NextThemeProvider, useTheme } from 'next-themes';
import { transform } from '@babel/standalone';
// Bundle motion (framer-motion v12+) so user code can `import { motion } from
// 'framer-motion'` or `'motion/react'` without resolving to npm. Star-import
// re-exports the whole namespace (motion, AnimatePresence, useAnimation,
// useScroll, useTransform, MotionConfig, LayoutGroup, useInView, etc.).
import * as MotionReact from 'motion/react';
// Bundle next-intl's client surface so user pages can `import { useTranslations,
// useLocale } from 'next-intl'` and `import { NextIntlClientProvider } from
// 'next-intl'`. The full namespace re-export keeps every named entry point
// the user might reach for (NextIntlClientProvider, useTranslations,
// useLocale, useFormatter, useMessages, ...).
import * as NextIntl from 'next-intl';
// Bundle `@revyme/runtime` so user code can `import { withResponsiveProps,
// withCursor, CursorPortal } from '@revyme/runtime'`. Same pattern as
// `motion/react` and `next-intl` — re-export the whole namespace through
// MODULE_MAP. Revyme has the package linked via `file:../runtime`, so
// this import resolves to the same code that runs in the canvas editor and
// in production.
import * as RevymeRuntime from '@revyme/runtime';

import { buildRouteTable, resolveRoute, type Route } from './router';
import { templatePreviewPages } from '@/preview/template-preview';
import { LinkShim, ImageShim, useRouter as useRouterShim, usePathname, useSearchParams, useParams as useParamsShim, setCurrentParams } from './next-shims';

// ─── Project files (mirror of parent ProjectFS) ────────────────────────────

const projectFiles: Map<string, string> = new Map();
const compiledModuleCache: Map<string, any> = new Map();

// ─── Preview: neutralize form submissions ──────────────────────────────────
// In the inline preview the real page runs, so a form's onSubmit fires
// fetch('/api/form') — which would 404 here (that relay route only exists on
// the deployed Worker) and must NEVER send a real email from the editor. Shim
// fetch so the form-submit endpoint resolves to a no-op success: the form
// behaves like a successful submit (resets) but nothing is sent. The deployed
// site never loads this file, so its forms work for real — we mock the
// ENVIRONMENT, not the form source (source = deploy reality).
(() => {
  const w = window as unknown as { fetch?: typeof fetch; __revymeFormShim?: boolean };
  if (typeof window === 'undefined' || !w.fetch || w.__revymeFormShim) return;
  w.__revymeFormShim = true;
  const realFetch = w.fetch.bind(window);
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url;
      if (typeof raw === 'string') {
        const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
        if (path === '/api/form') {
          console.info('[preview] form submit intercepted — not sent (preview mode)');
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, preview: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
      }
    } catch {
      /* fall through to the real fetch */
    }
    return realFetch(input, init);
  }) as typeof fetch;
})();


// ─── Module map (deps available to user code via `import …`) ───────────────

// Intercept `<html>` and `<body>` JSX from the user's RootLayout — the
// standard Next.js shape is `<html><body>{children}</body></html>`, but
// rendering that into our `<div id="root">` triggers React's "html cannot
// be a child of div" hydration error and the whole tree fails to mount
// (YouTube iframes, hooks, everything). Next.js itself handles these tags
// at the framework level (they become the actual document.documentElement
// / document.body). We do the same here: drop the wrapper, copy `lang`,
// `className`, and `style` to the real document elements so the user's
// styling and i18n still apply.
function unwrapDocumentTags(type: any, props: any): { handled: true; children: any } | { handled: false } {
  if (type !== 'html' && type !== 'body') return { handled: false };
  if (type === 'html' && props) {
    if (typeof props.lang === 'string' && document.documentElement.lang !== props.lang) {
      document.documentElement.lang = props.lang;
    }
    if (typeof props.className === 'string') {
      document.documentElement.className = props.className;
    }
  }
  if (type === 'body' && props) {
    if (typeof props.className === 'string') {
      document.body.className = props.className;
    }
    if (props.style && typeof props.style === 'object') {
      Object.assign(document.body.style, props.style);
    }
  }
  return { handled: true, children: props?.children };
}

// HTML void elements — React THROWS ("X is a void element tag and must neither
// have children…") if one gets children, crashing the WHOLE preview. A malformed
// master (e.g. a <form> made into a component carrying a stray child on an
// <input>, or an <input> left with orphan <option>s after a Type change) would
// take the page down. The tolerant canvas Renderer never passes void tags
// children — match that here so the preview degrades gracefully instead.
const PREVIEW_VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'area', 'base', 'col', 'embed', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function previewJsx(type: any, props: any, key?: any) {
  const unwrap = unwrapDocumentTags(type, props);
  if (unwrap.handled) {
    return React.createElement(React.Fragment, key !== undefined ? { key } : null, unwrap.children);
  }
  if (props && props.children != null && typeof type === 'string' && PREVIEW_VOID_TAGS.has(type)) {
    const { children, ...rest } = props;
    return React.createElement(type, key !== undefined ? { ...rest, key } : rest);
  }
  return React.createElement(type, key !== undefined ? { ...props, key } : props);
}

// Babel's `_interopRequireDefault(require('mod'))` wraps a non-ESM result
// in `{ default: result }` — so `import Link from 'next/link'` gets
// `{ default: { default: LinkShim } }` and `<Link/>` blows up with
// "Element type is invalid: got object". Setting `__esModule: true` tells
// the interop helper "this is already ESM, return it as-is" so the user's
// destructure resolves to the real component/function.
function esm<T extends Record<string, any>>(exports: T): T & { __esModule: true } {
  return { ...exports, __esModule: true };
}

const MODULE_MAP: Record<string, any> = {
  react: React,
  'react/jsx-runtime': esm({ jsx: previewJsx, jsxs: previewJsx, Fragment: React.Fragment }),
  'react/jsx-dev-runtime': esm({ jsxDEV: previewJsx, Fragment: React.Fragment }),
  'react-dom': esm({ createPortal: (children: any) => children }),
  'next-themes': esm({ ThemeProvider: NextThemeProvider, useTheme }),
  'next/link': esm({ default: LinkShim }),
  'next/image': esm({ default: ImageShim }),
  'next/navigation': esm({ useRouter: useRouterShim, usePathname, useSearchParams, useParams: useParamsShim }),
  // Server-only modules — stubbed so client-rendered preview doesn't crash.
  'next/headers': esm({ cookies: () => new Map(), headers: () => new Map() }),
  'next/cache': esm({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: any) => fn }),
  // motion (formerly framer-motion). Both import paths point to the same
  // namespace so user code authored against either name works. `MotionReact`
  // is already a real ESM namespace from the `motion/react` package, so
  // we don't need to add `__esModule` — Vite's namespace import gives it
  // the right shape automatically.
  'framer-motion': MotionReact,
  'motion/react': MotionReact,
  'motion': MotionReact,
  // next-intl — client surface only. Server-only entries (next-intl/server,
  // next-intl/middleware) are stubbed because the preview is a pure-client
  // SPA — there's no Next.js request context here. The user's pages should
  // only `import` from 'next-intl' (the client root) anyway; pages-router
  // server APIs are out of scope for the preview iframe.
  'next-intl': NextIntl,
  'next-intl/server': esm({
    getLocale: async () => 'en',
    getMessages: async () => ({}),
    getTranslations: async () => (() => ''),
    getFormatter: async () => ({}),
  }),
  // Revyme's runtime helpers — `withResponsiveProps`, `withCursor`,
  // `CursorPortal`. Generated user code (Code component templates, design components,
  // cursor-gen output) imports from `@revyme/runtime` post-2026-05-06.
  //
  // We wrap in `esm()` rather than handing back the namespace object
  // directly because Vite's optimizer may rewrite the linked-package
  // namespace in a way that drops named exports through Babel's CommonJS
  // interop (`(0, _runtime.withResponsiveProps)` ends up undefined). The
  // explicit shape + `__esModule: true` flag guarantees Babel resolves
  // named imports against the right keys.
  '@revyme/runtime': esm({
    withResponsiveProps: RevymeRuntime.withResponsiveProps,
    withCursor: RevymeRuntime.withCursor,
    CursorPortal: RevymeRuntime.CursorPortal,
    // The package default returns `false` (= "I am NOT the static canvas
    // renderer, animate normally"), which is exactly what we want in the
    // live preview. Code components see `false` and run their full rAF loop.
    useStaticCanvas: RevymeRuntime.useStaticCanvas,
    // Sketch draw-on animation player — generated `useEffect` blocks
    // call this with the wrapper SVG + the user's animation options.
    playSketchDraw: RevymeRuntime.playSketchDraw,
    RevymeSplitText: RevymeRuntime.RevymeSplitText,
  }),
  // Legacy `@/lib/...` entries — old projects that still use these paths
  // resolve to the same package functions, so they keep working without a
  // codemod. Same `esm()` wrapping rationale as above.
  '@/lib/withResponsiveProps': esm({ default: RevymeRuntime.withResponsiveProps, withResponsiveProps: RevymeRuntime.withResponsiveProps }),
  'lib/withResponsiveProps': esm({ default: RevymeRuntime.withResponsiveProps, withResponsiveProps: RevymeRuntime.withResponsiveProps }),
  '@/lib/cursor-runtime': esm({
    withCursor: RevymeRuntime.withCursor,
    CursorPortal: RevymeRuntime.CursorPortal,
  }),
  'lib/cursor-runtime': esm({
    withCursor: RevymeRuntime.withCursor,
    CursorPortal: RevymeRuntime.CursorPortal,
  }),
};

// ─── Compile a single file from ProjectFS ──────────────────────────────────
//
// Babel transforms TSX → ESM-style JS, but we run it via `new Function` so
// imports must be redirected. The transform output uses CommonJS style
// (`require(...)`), so we hand-roll a lightweight require that consults
// MODULE_MAP first, then ProjectFS for relative + `@/` paths.

function resolveImportPath(importPath: string, fromFile: string): string | null {
  // External package — handled by MODULE_MAP at runtime.
  if (!importPath.startsWith('.') && !importPath.startsWith('@/')) return null;

  // `@/` → src root → user's project root for our purposes.
  let target = importPath;
  if (target.startsWith('@/')) {
    target = target.slice(2); // strip `@/`
  } else {
    // Relative — resolve against the importing file's directory.
    const dir = fromFile.split('/').slice(0, -1).join('/');
    const parts = (dir + '/' + target).split('/');
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') { stack.pop(); continue; }
      stack.push(p);
    }
    target = stack.join('/');
  }

  // Try common extensions in order.
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    const candidate = target + ext;
    if (projectFiles.has(candidate)) return candidate;
  }
  return null;
}

// ─── CDN URL imports — pre-loaded async, served sync from cache ─────────
// User code that does `import X from "https://assets.revyme.app/..."` can't
// be resolved by the synchronous CommonJS-style `requireFn` below
// (Babel-CJS require is sync; native dynamic `import()` is async). Fix:
// scan all project files for CDN URL imports BEFORE compiling, dynamically
// import each, populate a cache. requireFn then synchronously hits the
// cache when it sees an http URL.
//
// Same model as the canvas sandbox's `loadCdnComponent` — different layer.

// Matches `/components/...` (code + design components) and
// `/vectors/...` (icon sets) so a
// project that imports any kind of CDN bundle gets preloaded into the
// cache before render. Without both branches, the missing-kind's
// URLs skip preloading; the synchronous `requireFn` then returns
// `undefined` for the import, React tries to render `<undefined />`,
// and you see "Element type is invalid: got object" with our
// cache-miss warning.
const CDN_URL_PATTERN = /from\s*["'](https:\/\/assets\.revyme\.app\/(?:components|vectors)\/[^"']+\.js)["']/g;
const cdnModuleCache = new Map<string, any>();

async function preloadCdnImports(): Promise<void> {
  const allUrls = new Set<string>();
  for (const content of projectFiles.values()) {
    const matches = content.matchAll(CDN_URL_PATTERN);
    for (const m of matches) allUrls.add(m[1]);
  }

  // Skip URLs we already have cached.
  const toLoad = [...allUrls].filter(u => !cdnModuleCache.has(u));
  if (toLoad.length === 0) return;

  await Promise.all(toLoad.map(async (url) => {
    try {
      const mod = await import(/* @vite-ignore */ url);
      // Wrap with __esModule:true so Babel's CommonJS interop unwraps
      // `default` correctly. Without this, native ES module namespace
      // objects (which don't carry __esModule) get treated AS the
      // default export → user code's `import X from "URL"` lands on
      // the WHOLE namespace `{ default, __moduleMeta__, ... }`
      // instead of the actual React component, and React errors with
      // "Element type is invalid: got object". Spread the namespace
      // so any named exports stay accessible too.
      cdnModuleCache.set(url, { __esModule: true, ...mod });
    } catch (err) {
      console.error('[preview] CDN import failed', url, err);
      // Cache an empty stub so requireFn doesn't keep retrying on each
      // re-render and the page still renders (with a missing component).
      cdnModuleCache.set(url, { __esModule: true, default: () => null });
    }
  }));
}

function compileFile(filePath: string): any {
  if (compiledModuleCache.has(filePath)) return compiledModuleCache.get(filePath);
  const source = projectFiles.get(filePath);
  if (!source) throw new Error(`preview: file not found in ProjectFS: ${filePath}`);

  // Strip Next.js-specific directives that aren't valid TS. `'use client'`
  // and `'use server'` are no-ops in the client-only preview.
  const stripped = source
    .replace(/^\s*['"]use client['"];?\s*$/m, '')
    .replace(/^\s*['"]use server['"];?\s*$/m, '');

  let transformed: { code?: string };
  try {
    transformed = transform(stripped, {
      presets: [
        ['env', { targets: { esmodules: true }, modules: 'commonjs' }],
        // Automatic JSX runtime — Babel emits `import { jsx } from
        // 'react/jsx-runtime'` (which env preset converts to a require) instead
        // of `React.createElement(...)`. Modern Next.js code doesn't `import
        // React from 'react'` so the classic runtime would crash with
        // "React is not defined" the moment any user file uses JSX.
        ['react', { runtime: 'automatic' }],
        'typescript',
      ],
      filename: filePath,
    });
  } catch (err) {
    throw new Error(`preview: babel failed for ${filePath}: ${(err as Error).message}`);
  }
  if (!transformed.code) throw new Error(`preview: babel returned empty code for ${filePath}`);

  const moduleObj: { exports: any } = { exports: {} };
  const requireFn = (importPath: string) => {
    // 1. External package — go straight to MODULE_MAP.
    if (MODULE_MAP[importPath]) return MODULE_MAP[importPath];

    // 1b. CDN URL import — pre-loaded by preloadCdnImports() before
    //     the render started. The bundle was dynamic-imported and its
    //     module namespace is in `cdnModuleCache`. Babel-CJS require
    //     expects a `module.exports`-shaped object; the namespace
    //     already has `default` and any named exports, so it works as-is.
    if (importPath.startsWith('http://') || importPath.startsWith('https://')) {
      const cached = cdnModuleCache.get(importPath);
      if (cached) return cached;
      console.warn('[preview] CDN URL not preloaded', importPath);
      return { default: () => null };
    }

    // 2. Resolve relative / `@/` paths against ProjectFS.
    const resolved = resolveImportPath(importPath, filePath);
    if (resolved) {
      // Non-JS files: don't pass them to Babel.
      if (resolved.endsWith('.css')) {
        injectCss(resolved, projectFiles.get(resolved) || '');
        return {};
      }
      if (resolved.endsWith('.json')) {
        try { return JSON.parse(projectFiles.get(resolved) || '{}'); }
        catch { return {}; }
      }
      // .tsx / .ts / .jsx / .js → compile + cache.
      return compileFile(resolved);
    }

    console.warn('[preview] unknown import:', importPath, 'from', filePath);
    return {};
  };

  try {
     
    const fn = new Function('module', 'exports', 'require', transformed.code!);
    fn(moduleObj, moduleObj.exports, requireFn);
  } catch (err) {
    throw new Error(`preview: runtime error in ${filePath}: ${(err as Error).message}`);
  }
  compiledModuleCache.set(filePath, moduleObj.exports);
  return moduleObj.exports;
}

// ─── CSS injection ─────────────────────────────────────────────────────────

const cssRegistry = new Map<string, HTMLStyleElement>();
function injectCss(path: string, css: string): void {
  let el = cssRegistry.get(path);
  if (!el) {
    el = document.createElement('style');
    el.dataset.previewCss = path;
    document.head.appendChild(el);
    cssRegistry.set(path, el);
  }
  el.textContent = css;
}

/**
 * Dedicated tokens style element for preset CSS variables. Lives separately
 * from the regular per-file <style> registry so:
 *   1. It can be appended LAST (highest priority) — preset token writes
 *      always win over an older copy in another stylesheet.
 *   2. The parent can update tokens on the fly (`preview:tokens`) without
 *      replacing all of globals.css.
 *   3. Easy to verify: `document.querySelector('[data-preview-tokens]')` in
 *      DevTools shows exactly which tokens are live.
 */
let tokensStyleEl: HTMLStyleElement | null = null;

/** Theme forced by the parent (`preview:force-theme`). When set, a
 *  MutationObserver on `<html>.class` re-asserts the value against any
 *  next-themes write so the canvas + preview agree on which mode is
 *  active. */
let forcedTheme: string | null = null;
let themeEnforcer: MutationObserver | null = null;
function injectTokens(css: string): void {
  if (!tokensStyleEl) {
    tokensStyleEl = document.createElement('style');
    tokensStyleEl.dataset.previewTokens = '';
    document.head.appendChild(tokensStyleEl);
  } else {
    // Re-append to keep it last in <head> — survives any later injectCss
    // calls that would otherwise insert AFTER the tokens block.
    document.head.appendChild(tokensStyleEl);
  }
  tokensStyleEl.textContent = css;
}

// ─── App shell ─────────────────────────────────────────────────────────────

let routes: Route[] = [];

// Component-isolation preview: when the editor is sitting on a `components/X.tsx`
// master file, the parent sends `preview:component` with that file path. We
// skip routing entirely and render the component's default export standalone
// (Storybook-style — centered on a neutral backdrop). Cleared by sending
// `filePath: null`.
let previewComponentFile: string | null = null;
// A/B variant page override: keyed by the BASE page path (e.g. `app/page.tsx`),
// value is the variant file path the user is currently editing
// (e.g. `_revyme/variants/<testId>/b.tsx`). When the route resolver lands on
// a `pageFile` that matches a key here, we compile the override INSTEAD —
// rendering the variant inside the base page's layout chain so the user sees
// the variant as a full page, not just a stripped-down component. Cleared by
// sending `variantFilePath: null` (e.g. when the editor leaves the variant).
const variantPageOverrides = new Map<string, string>();
// Variant the component preview should boot in. Mirrors the editor's
// selection: clicking inside a variant's hierarchy and pressing Play sends
// the variant name here so the preview opens in that state instead of
// always defaulting to the primary. `null` = use the component's own
// `initialVariant` default (which is 'default' / the primary variant).
let previewInitialVariant: string | null = null;

function PreviewApp() {
  const [url, setUrl] = React.useState(() => location.pathname + location.search);
  React.useEffect(() => {
    const onPop = () => setUrl(location.pathname + location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Component-isolation mode short-circuits the route-resolution path. The
  // component is compiled with the same `compileFile` that pages use, so
  // its imports (motion, hooks, presets) resolve normally — only the wrapper
  // chrome differs.
  if (previewComponentFile) {
    try {
      const Component = compileFile(previewComponentFile).default;
      // A component is a function OR a React "exotic" type — an OBJECT with a
      // `$$typeof` tag: forwardRef / memo / lazy. Since runtime 0.0.7,
      // `withResponsiveProps` returns forwardRef (the animated-style socket
      // pins scroll-target refs to its wrapper), so EVERY design/code
      // component's default export is a forwardRef object — the bare
      // `typeof === 'function'` check false-positived "has no default export"
      // for every component preview (live find 2026-07-14: Ring). Same
      // pattern as code-component-runtime's isRenderableComponent.
      const isRenderableComponent = typeof Component === 'function'
        || (typeof Component === 'object' && Component !== null && (Component as any).$$typeof != null);
      if (!isRenderableComponent) {
        return (
          <div style={{ padding: 24, fontFamily: 'monospace', color: '#b91c1c' }}>
            <strong>Component preview:</strong> {previewComponentFile} has no default export.
          </div>
        );
      }
      // Backdrop matches the editor's `--bg-canvas` token (defined in
       // src/styles/globals.css: #eeeeee light / #1d1d1d dark). The iframe
       // is a separate document so the var isn't inherited — we hard-code the
       // values and follow the OS theme via prefers-color-scheme. Keep these
       // in sync with the globals.css definition if the canvas color changes.
      const isDark = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      const bgCanvas = isDark ? '#1d1d1d' : '#eeeeee';
      // Pass `initialVariant` only when one was sent — the component's own
      // default ('default') already covers the unspecified case, and
      // forwarding `undefined` would force `useState(undefined)` which
      // breaks the variant-driven `animate={variant}` chain on first paint.
      const variantProp: { initialVariant?: string } = previewInitialVariant
        ? { initialVariant: previewInitialVariant }
        : {};
      // The generated master root carries the canvas-space coords baked
      // into its inline style (e.g. `position: 'absolute', left: '1135px',
      // top: '161px'`). On canvas the Renderer overrides per-variant
      // viewport, but in this standalone preview the component renders
      // bare and the inline coords shove the root to that pixel offset —
      // visible as the component glued to one corner of the preview
      // instead of being centered. Passing `style` overrides via the
      // component prop doesn't work because framer-motion's `motion.div`
      // + `layout={true}` re-emits the original inline coords to the DOM.
      // Use a scoped CSS rule with `!important` to override the inline
      // positioning on the immediate `[data-id]` child of the wrapper.
      return (
        <div
          data-preview-component-root
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
            background: bgCanvas,
          }}
        >
          <style>{`
            [data-preview-component-root] > [data-id] {
              position: relative !important;
              left: auto !important;
              top: auto !important;
              right: auto !important;
              bottom: auto !important;
            }
          `}</style>
          <Component {...variantProp} />
        </div>
      );
    } catch (err) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#b91c1c' }}>
          <strong>Component preview compile error</strong>
          <br />
          {(err as Error).message}
        </div>
      );
    }
  }

  const path = url.split('?')[0] || '/';
  const route = resolveRoute(routes, path);

  // Publish the resolved route params to the shim so `useParams()` calls
  // inside any client component get `{ slug: 'alice-johnson' }` instead of
  // crashing on the missing hook. Done before the layout chain mounts so
  // the params are already correct on first render — no flash of empty
  // params during initial paint.
  setCurrentParams((route?.params as Record<string, string | string[]>) ?? {});

  if (!route) {
    // 404 — try app/not-found.tsx, fall back to default message.
    if (projectFiles.has('app/not-found.tsx')) {
      try {
        const NotFound = compileFile('app/not-found.tsx').default;
        return <NotFound />;
      } catch { /* fall through */ }
    }
    return (
      <div style={{ padding: 64, textAlign: 'center', color: '#888' }}>
        <h1>404</h1>
        <p>No route matches <code>{path}</code></p>
      </div>
    );
  }

  let tree: React.ReactNode;
  try {
    // Variant page override: when the user is editing an A/B variant, the
    // parent has registered a swap from base page file → variant file. Same
    // route, same layout chain, different page module. The variant is
    // compiled with the same `compileFile` so all its imports (motion,
    // `@/components/...`) resolve through the standard project-file pipeline.
    const pageFileToCompile = variantPageOverrides.get(route.pageFile) ?? route.pageFile;
    const Page = compileFile(pageFileToCompile).default;
    tree = <Page params={route.params} searchParams={Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''))} />;
    // Wrap in layouts (innermost first as we walk back up the chain).
    for (let i = route.layoutChain.length - 1; i >= 0; i--) {
      const Layout = compileFile(route.layoutChain[i]).default;
      tree = <Layout params={route.params}>{tree}</Layout>;
    }
  } catch (err) {
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#b91c1c' }}>
        <strong>Preview compile error</strong>
        <br />
        {(err as Error).message}
      </div>
    );
  }
  return <>{tree}</>;
}

// ─── Boot ──────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root')!);

function rebuildRoutes(): void {
  routes = buildRouteTable(projectFiles);
}

function rerender(): void {
  // Clear compiled cache so file edits propagate.
  compiledModuleCache.clear();
  // Inject any imported CSS files we already know about.
  for (const [p, src] of projectFiles) {
    if (p.endsWith('.css')) injectCss(p, src);
  }

  // Pre-load any CDN URL imports BEFORE first paint. Without this the
  // synchronous `requireFn` would return `undefined` for URL imports on
  // the first render → React errors with "Element type is invalid".
  // Renders an empty page while loading, then re-renders with content.
  preloadCdnImports().then(() => {
    root.render(<PreviewApp />);
  }).catch((err) => {
    // Even if preload fails, render so the user sees an error rather
    // than a blank screen. requireFn falls back to a stub component.
    console.error('[preview] preload failed, rendering anyway', err);
    root.render(<PreviewApp />);
  });
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'preview:project-files') {
    projectFiles.clear();
    for (const [path, content] of msg.files as Array<[string, string]>) {
      projectFiles.set(path, content);
    }
    // Templates (route-group LayoutClient files) have no page of their own, so
    // inject a placeholder page per template group — makes them routable for
    // preview around a "page content" placeholder (mirrors the canvas).
    for (const { file, content } of templatePreviewPages(projectFiles.keys())) {
      projectFiles.set(file, content);
    }
    rebuildRoutes();
    rerender();
  } else if (msg.type === 'preview:file-update') {
    projectFiles.set(msg.path, msg.content);
    if (msg.path.startsWith('app/') && (msg.path.endsWith('/page.tsx') || msg.path.endsWith('/layout.tsx'))) {
      rebuildRoutes();
    }
    rerender();
  } else if (msg.type === 'preview:navigate') {
    history.pushState(null, '', msg.url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } else if (msg.type === 'preview:force-theme') {
    // Mirror the canvas's hard-coded light mode in the iframe. The canvas
    // Renderer skips `:root.dark` (per src/styles/globals.css comment) so
    // user edits to `:root { --foo: … }` always show on canvas. The iframe
    // runs the user's real Providers, so next-themes follows the OS theme
    // by default → on a dark-mode OS, the iframe enters `<html class="dark">`
    // and resolves vars from `:root.dark` (unedited defaults) instead of
    // the user's `:root` edits. Pin the iframe to whatever theme the parent
    // requests so preset edits are immediately visible.
    const theme = typeof msg.theme === 'string' ? msg.theme : 'light';
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
    const html = document.documentElement;
    if (theme === 'light') html.classList.remove('dark');
    else if (theme === 'dark') html.classList.add('dark');
    // Re-apply on every render — next-themes will keep trying to set the
    // class on its mount cycle. A MutationObserver on `<html>.class`
    // re-removes any unwanted class without triggering a render war.
    if (!themeEnforcer) {
      themeEnforcer = new MutationObserver(() => {
        if (forcedTheme === 'light' && html.classList.contains('dark')) {
          html.classList.remove('dark');
        } else if (forcedTheme === 'dark' && !html.classList.contains('dark')) {
          html.classList.add('dark');
        }
      });
      themeEnforcer.observe(html, { attributes: true, attributeFilter: ['class'] });
    }
    forcedTheme = theme;
  } else if (msg.type === 'preview:force-locale') {
    // Pin the locale the EDITOR is showing. The generated `providers.tsx`
    // resolves an unprefixed route's locale from `localStorage.getItem('locale')`
    // and mirrors it onto `<html lang>` — and this iframe has its OWN origin, so
    // its own localStorage. A locale chosen in an earlier preview session stuck
    // forever, every `:lang(xx)` rule in the page fired, and the preview diverged
    // from both the canvas and the published site: a legacy
    // `:lang(fr) […] { display: flex !important }` collapsed a 3-column grid into
    // a row here while the live site rendered it correctly (user find 2026-07-26).
    //
    // Written through the app's OWN channel — the `locale` key plus the
    // `locale-change` event `Providers` already listens for — so no
    // preview-specific hack, and `<html lang>` follows from the app's effect.
    const locale = typeof msg.locale === 'string' && msg.locale ? msg.locale : 'en';
    try { localStorage.setItem('locale', locale); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent('locale-change', { detail: { locale } }));
  } else if (msg.type === 'preview:tokens') {
    // Eager preset-token injection — guarantees `var(--shadow-elevated)` etc.
    // resolve on first paint, even if the regular file-CSS pipeline lags or
    // the page doesn't transitively import globals.css.
    if (typeof msg.css === 'string') {
      injectTokens(msg.css);
    }
  } else if (msg.type === 'preview:variant-page') {
    // A/B variant page swap. `variantFilePath` + `basePagePath` both set →
    // register the override; `variantFilePath: null` → clear all overrides
    // (used by PreviewOverlay every time it opens a non-variant page so
    // stale state from a prior session doesn't leak across previews).
    const variantPath = typeof msg.variantFilePath === 'string' && msg.variantFilePath ? msg.variantFilePath : null;
    const basePath = typeof msg.basePagePath === 'string' && msg.basePagePath ? msg.basePagePath : null;
    if (variantPath && basePath) {
      const prev = variantPageOverrides.get(basePath);
      if (prev !== variantPath) {
        variantPageOverrides.clear();
        variantPageOverrides.set(basePath, variantPath);
        rerender();
      }
    } else {
      if (variantPageOverrides.size > 0) {
        variantPageOverrides.clear();
        rerender();
      }
    }
  } else if (msg.type === 'preview:component') {
    // Switch into / out of component-isolation mode. `filePath: null` clears
    // it (used when the editor switches back to a page master), so a single
    // overlay session can transition between component <-> page previews
    // without needing a reload.
    const next = typeof msg.filePath === 'string' && msg.filePath ? msg.filePath : null;
    // `initialVariant` rides along with each component-mode message — null
    // clears it (e.g. switching back to page mode) so a stale variant
    // doesn't leak across previews when the user re-opens the overlay
    // against a different component.
    const nextVariant = typeof msg.initialVariant === 'string' && msg.initialVariant
      ? msg.initialVariant
      : null;
    const fileChanged = next !== previewComponentFile;
    const variantChanged = nextVariant !== previewInitialVariant;
    if (fileChanged || variantChanged) {
      previewComponentFile = next;
      previewInitialVariant = nextVariant;
      rerender();
    }
  } else if (msg.type === 'preview:capture-thumbnail') {
    // Parent (PreviewOverlay) asks us to snapshot the rendered page for the
    // dashboard thumbnail. captureThumbnail() defers + posts `preview:thumbnail`
    // back; fire-and-forget so the message handler stays sync.
    void captureThumbnail();
  }
});

// Sync <html lang> from the LocaleSwitcher Code component's `locale` localStorage key
// and `locale-change` window event so user CSS rules like
// `:lang(fr) [data-id="cta"] { ... }` fire on locale change. Older Code component
// templates only persisted the locale to storage / dispatched the event but
// never wrote `<html lang>`, so no `:lang(...)` selectors ever matched.
function syncHtmlLang(locale: string): void {
  if (locale && document.documentElement.lang !== locale) {
    document.documentElement.lang = locale;
  }
}
const initialLocale = (() => {
  try { return localStorage.getItem('locale') || ''; } catch { return ''; }
})();
if (initialLocale) syncHtmlLang(initialLocale);
window.addEventListener('locale-change', (e) => {
  const detail = (e as CustomEvent).detail;
  if (detail && typeof detail.locale === 'string') syncHtmlLang(detail.locale);
});

// Tell the parent we're alive and ready to receive files.
parent.postMessage({ type: 'preview:ready' }, '*');
