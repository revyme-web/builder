// editor/plugin-editor/plugin-bundler.ts — TSX → self-contained HTML blob URL.
//
// What this does:
//   1. Compile the user's plugin TSX source via @babel/standalone.
//   2. Scan the source for bare `import` specifiers and route them:
//      - Host-provided ones (`@revyme/plugin-sdk`, `react`, `react-dom`,
//        `react-dom/client`) → mapped to known URLs in the import map.
//        The SDK is served as a blob: URL of `SDK_RUNTIME_SOURCE` so
//        plugins work fully offline (no network for our own runtime).
//      - Anything else → auto-resolved through `https://esm.sh/<name>`
//        so plugin authors can import any npm package (`lodash`,
//        `date-fns`, etc.) without an `npm install` step. esm.sh is
//        CloudFlare-cached and bundles CommonJS to ESM on the fly.
//   3. Build an HTML shell with the import map and a `<script type="module">`
//      containing the compiled plugin code. Plugin imports resolve
//      natively via the importmap — no regex rewriting at the JS level.
//   4. Convert the HTML to a `blob:` URL — that's what the iframe's
//      `src` becomes, so the plugin runs in a fully sandboxed origin
//      with no access to the parent window beyond postMessage.
//
// Import maps require Chrome 89+ / Firefox 108+ / Safari 16.4+ — all
// shipping for years; fine for a web design tool. If we ever need to
// support older browsers, fall back to the `window.revymeSDK` global
// pattern (kept in git history, see the v1 `plugin-sdk-runtime.ts`
// IIFE form).
//
// Why we don't reuse `code-component-runtime`: that path compiles
// components into the SAME frame and runs them via `new Function()`.
// Plugins must run in an iframe (security + the SDK protocol assumes
// `window.parent !== window`). So plugins get their own bundler with
// an iframe-friendly output shape.

import { transform } from '@babel/standalone';
import { SDK_RUNTIME_SOURCE } from './plugin-sdk-runtime';
import { trace } from '@/shared/debug-trace';

/**
 * Cached blob URL for the SDK source. Built once on first plugin
 * bundle, reused for every subsequent one. Living on the module
 * scope means it persists across editor sessions as long as the page
 * stays loaded; revoked at full-page unload by the browser.
 *
 * Used for the LOCAL Tier 2 plugin path — blob URLs are scoped to the
 * creating frame's document, so they only work when the iframe is
 * mounted by the same Revyme page that built the bundle.
 *
 * For portable (cloud-distributable) bundles, see `getSdkDataUrl`.
 */
let sdkBlobUrlCache: string | null = null;
function getSdkBlobUrl(): string {
  if (sdkBlobUrlCache) return sdkBlobUrlCache;
  const blob = new Blob([SDK_RUNTIME_SOURCE], { type: 'application/javascript' });
  sdkBlobUrlCache = URL.createObjectURL(blob);
  return sdkBlobUrlCache;
}

/**
 * Cached data URL for the SDK source. Used when the bundle needs to
 * be portable across origins / iframe contexts — for instance, when
 * Copy URL uploads it to R2 and a friend's Revyme later loads it
 * from `https://assets.revyme.app/...`. Blob URLs would be unresolvable
 * in that flow; data URLs work everywhere because they carry their
 * own content.
 *
 * Cost: ~33% bigger than the raw bytes (base64 overhead). On a ~40 KB
 * SDK that's ~13 KB extra per bundle. Acceptable for cloud distribution.
 */
let sdkDataUrlCache: string | null = null;
function getSdkDataUrl(): string {
  if (sdkDataUrlCache) return sdkDataUrlCache;
  // SDK source can contain UTF-8 (emoji in trace messages, smart
  // quotes in strings, etc.) — btoa only accepts Latin-1, so encode
  // via TextEncoder → bytes → base64 to support the full UTF-8 range.
  const bytes = new TextEncoder().encode(SDK_RUNTIME_SOURCE);
  let binary = '';
  // Chunked conversion — `String.fromCharCode(...bytes)` blows the
  // stack for sources past ~100 KB. Split into 8 KB chunks instead.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  sdkDataUrlCache = `data:application/javascript;base64,${btoa(binary)}`;
  return sdkDataUrlCache;
}

/**
 * Bare import specifiers we provide ourselves. Mapped explicitly so
 * the bundler doesn't accidentally route them through esm.sh (which
 * would either 404 for our own scoped package or download a stranger's
 * "react" mock for the SDK).
 *
 * `@revyme/plugin-sdk` → blob URL of our hand-mirrored runtime.
 * `react` / `react-dom/client` → esm.sh, pinned to React 18 to match
 *   what the editor itself uses (component-runtime, etc.).
 *
 * Future: when we add `framer-motion` etc. as host-provided
 * deps to save a network round-trip per use, add their entries here
 * and inline their source the same way as the SDK.
 */
/**
 * Builds the host-provided import map. When `portable=true`, the SDK
 * is served via a data URL (works in any iframe / from any origin —
 * required for cloud-distributed plugins). When `portable=false`
 * (default), the SDK is served via a blob URL (faster, but only valid
 * within the Revyme tab that created it — fine for local Tier 2
 * preview where the iframe is mounted by the same Revyme instance).
 *
 * Other imports (react, jsx-runtime, etc.) go through esm.sh either
 * way — they're CDN URLs, already portable.
 */
function buildHostImports(portable: boolean): Record<string, () => string> {
  return {
    '@revyme/plugin-sdk': portable ? getSdkDataUrl : getSdkBlobUrl,
    'react': () => 'https://esm.sh/react@18',
    'react-dom': () => 'https://esm.sh/react-dom@18',
    'react-dom/client': () => 'https://esm.sh/react-dom@18/client',
    // JSX runtime entry points — required by babel's `runtime: 'automatic'`
    // preset, which transforms `<div />` into `import { jsx } from
    // 'react/jsx-runtime'; jsx('div')` (production) or
    // `'react/jsx-dev-runtime'` (development). Without these mapped,
    // the iframe gets "module not found" on the very first render.
    'react/jsx-runtime': () => 'https://esm.sh/react@18/jsx-runtime',
    'react/jsx-dev-runtime': () => 'https://esm.sh/react@18/jsx-dev-runtime',
  };
}

/**
 * Pull every bare-specifier import out of compiled plugin source.
 * Bare = doesn't start with `./`, `../`, `/`, or a URL scheme.
 *
 * Regex matches the four common forms:
 *   import X from 'name'
 *   import * as X from 'name'
 *   import { a, b } from 'name'
 *   import 'name'             (side-effect)
 *
 * Tradeoff: not a real AST traversal (would need to visit every
 * `ImportDeclaration` node). Plugin source is small + flat, so a
 * regex pass is sufficient. If we ever support dynamic imports
 * (`import()` expressions) we'd extend this; currently the bundler
 * only handles top-level static imports.
 */
function findBareImports(source: string): string[] {
  const set = new Set<string>();
  const re = /^\s*import\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const spec = m[1];
    // Skip relative paths and absolute URLs — the importmap only
    // needs to resolve bare specifiers (`react`, `lodash`, etc.).
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) continue;
    if (/^[a-z]+:/i.test(spec)) continue; // http://, https://, blob:, etc.
    set.add(spec);
  }
  return [...set];
}

/**
 * Build the import map JSON. Host-provided specifiers win; everything
 * else falls through to esm.sh. The map's `imports` keys are bare
 * specifiers exactly as plugin authors write them.
 */
function buildImportMap(source: string, portable: boolean): string {
  const bareSpecs = findBareImports(source);
  const imports: Record<string, string> = {};

  // Always include the host-provided set — even if the plugin doesn't
  // use them, importmap entries are cheap and it future-proofs adding
  // imports to the plugin without rebuilding the map shape.
  for (const [spec, urlFn] of Object.entries(buildHostImports(portable))) {
    imports[spec] = urlFn();
  }

  // Auto-route any unknown bare imports through esm.sh.
  for (const spec of bareSpecs) {
    if (imports[spec]) continue;
    // esm.sh accepts the npm package name verbatim. Subpath imports
    // like 'lodash/debounce' work too — esm.sh resolves them. Plugin
    // authors writing 'lodash-es/debounce' get the ESM build directly.
    imports[spec] = `https://esm.sh/${spec}`;
  }

  return JSON.stringify({ imports }, null, 2);
}

export interface BundleOptions {
  /** Reverse-DNS plugin id — passed to createPlugin's handshake. */
  pluginId: string;
  /** Display name shown in the iframe `<title>`. */
  pluginName: string;
  /**
   * When true, the SDK is embedded as a data URL instead of a blob URL.
   * Required for any HTML that will be persisted / uploaded / loaded
   * cross-origin — blob URLs are scoped to the creating frame and won't
   * resolve from R2 or another Revyme instance. Use this for the
   * Copy URL → cloud-distribution flow. Defaults to false (faster blob
   * URL is fine for the local Tier 2 iframe).
   */
  portable?: boolean;
}

/**
 * Compile plugin TSX source + assemble the iframe HTML + return a
 * blob URL. Caller is responsible for `URL.revokeObjectURL` when the
 * iframe unmounts (we leak otherwise — every Run click creates a new
 * blob). Row components revoke on close; the editor preview revokes
 * on each Run.
 */
export function bundlePluginToBlobUrl(source: string, opts: BundleOptions): string {
  let compiled: string;
  try {
    compiled = transform(source, {
      presets: [
        ['typescript', { allExtensions: true, isTSX: true, onlyRemoveTypeImports: false }],
        // `runtime: 'automatic'` makes babel inject
        // `import { jsx as _jsx } from 'react/jsx-runtime'` (or
        // `jsx-dev-runtime` in dev) instead of emitting
        // `React.createElement` calls. Without `automatic` we'd need
        // `import React from 'react'` injected (via classic runtime
        // + auto-inject) or have `React` as a global — we have
        // neither in the iframe shell, so the dev preview throws
        // "React is not defined" on the first render.
        ['react', { runtime: 'automatic', development: true }],
      ],
      filename: 'plugin.tsx',
    }).code ?? '';
  } catch (e) {
    trace.error('plugin-bundler:compile-failed', { error: String(e) });
    throw new Error(`Plugin compile error: ${(e as Error).message}`);
  }

  // Build the import map FROM THE COMPILED SOURCE so any imports
  // babel preserves (i.e. all real imports — TypeScript only strips
  // type-only ones) get mapped. Type-only imports leave no trace in
  // compiled output, so they correctly don't show up in the map.
  const importMap = buildImportMap(compiled, opts.portable ?? false);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.pluginName)}</title>
<script type="importmap">
${importMap}
</script>
<style>
  /* Strip default browser margins — the plugin's content goes
     edge-to-edge of the iframe. The OUTER shell (ToolPopup)
     already provides ~12px padding around the iframe, so we
     don't add any inside. Plugins that want their own internal
     padding apply it on their root component. */
  html, body { margin: 0; padding: 0; background: transparent; color: #eee; font: 12px/1.5 system-ui, sans-serif; }
  #root { padding: 0; }
  #__plugin-error { padding: 12px; background: #2a1010; color: #ff7474; font-family: ui-monospace, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
  /* Standalone landing — shown when this bundle is opened directly
     (not embedded in the builder). Branded, calm, no scary errors.
     Mirrors the reference's plugin-CDN page UX. */
  .standalone-host { display: none; position: fixed; inset: 0; background: #0a0a0a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  .standalone-host.show { display: flex; }
  .standalone-card { max-width: 360px; }
  .standalone-icon { width: 40px; height: 40px; margin: 0 auto 18px; display: flex; align-items: center; justify-content: center; }
  .standalone-title { font-size: 14px; font-weight: 600; color: #f8fafc; margin: 0 0 8px; }
  .standalone-body { font-size: 13px; line-height: 1.55; color: rgba(248,250,252,0.6); margin: 0; }
  .standalone-link { color: #3b82f6; text-decoration: none; }
  .standalone-link:hover { color: #60a5fa; }
</style>
</head>
<body>
<div id="root"></div>
<div id="__plugin-error" hidden></div>

<!-- Standalone landing card — only shown when window.parent === window
     (bundle opened directly in a browser tab, not embedded in the builder).
     The runtime guard below toggles a .show class on this element and
     silences the module script's errors so the visitor sees the branded
     page instead of plugin internals or a "must run inside an iframe" stack. -->
<div class="standalone-host" id="__standalone-host">
  <div class="standalone-card">
    <div class="standalone-icon">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="36" height="36" rx="9" fill="#3b82f6"/>
        <path d="M14 12 L26 20 L14 28 Z" fill="white"/>
      </svg>
    </div>
    <p class="standalone-title">This is a Revyme plugin.</p>
    <p class="standalone-body">
      Open it inside the Revyme builder to use it.
      <a class="standalone-link" href="https://revyme.com/plugins" target="_blank" rel="noopener noreferrer">Learn more</a>
    </p>
  </div>
</div>

<script>
  // Standalone guard — runs BEFORE the module script. When this iframe
  // wasn't embedded by a host (window.parent === window), we:
  //   1. Show the branded standalone landing card
  //   2. Suppress error handlers so the module script's failures don't
  //      leak SDK internals into the page ("createPlugin: must run
  //      inside an iframe…" etc.)
  //   3. Stop the module script from mounting React into #root by
  //      removing the element — createRoot(null) errors silently
  //      under the suppressed handler
  // Strict equality check + a top-frame check (window.top is the same
  // window) so embedding via document.write doesn't bypass it.
  var __standalone = (window.parent === window) || (window.top === window);
  if (__standalone) {
    var __card = document.getElementById('__standalone-host');
    if (__card) __card.classList.add('show');
    var __root = document.getElementById('root');
    if (__root) __root.remove();
    window.addEventListener('error', function (e) { e.preventDefault(); }, true);
    window.addEventListener('unhandledrejection', function (e) { e.preventDefault(); }, true);
  } else {
    // Hosted mode: surface uncaught errors / unhandled rejections in a
    // visible banner inside the iframe so plugin authors see them
    // immediately (rather than buried in DevTools).
    window.addEventListener('error', function (e) {
      var el = document.getElementById('__plugin-error');
      if (!el) return;
      el.hidden = false;
      el.textContent = (e.error && e.error.stack) || String(e.message || e);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var el = document.getElementById('__plugin-error');
      if (!el) return;
      el.hidden = false;
      el.textContent = (e.reason && e.reason.stack) || String(e.reason);
    });
  }
</script>
<script type="module">
${compiled}
</script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  trace.action('plugin-bundler:bundled', { id: opts.pluginId, sizeBytes: html.length });
  return url;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Returns the starter source for a brand-new plugin. Lives in the
 * bundler module so the template's import paths match what the
 * importmap actually resolves — keeping them in the same file means
 * a change to either forces the matching change.
 */
export function buildStarterTemplate(pluginId: string, displayName: string): string {
  return `// ${displayName} — Revyme plugin.
// Imports resolve via an iframe import map: \`@revyme/plugin-sdk\` is
// served as a blob URL of our SDK runtime; \`react\` + \`react-dom/client\`
// route through esm.sh. Any other bare import (e.g. \`lodash\`) is
// auto-routed through esm.sh too — same syntax as a Tier 1 plugin.
//
// SDK reference:
//   plugin.revyme.canvas.getSelection()    → Promise<string[]>
//   plugin.revyme.canvas.setSelection(ids) → Promise<void>
//   plugin.revyme.canvas.getNode(id)       → Promise<NodeInfo>
//   plugin.revyme.canvas.getRect(id)       → Promise<{x,y,width,height}>
//   plugin.revyme.subscribe.selection(handler) → unsubscribe fn
//   plugin.revyme.ui.notify(message, level?)

import { createPlugin } from '@revyme/plugin-sdk';
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App({ plugin }) {
  const [ids, setIds] = useState([]);
  useEffect(() => {
    return plugin.revyme.subscribe.selection(setIds);
  }, [plugin]);
  return (
    <div>
      <h3 style={{ margin: '0 0 8px' }}>${displayName}</h3>
      <p style={{ margin: 0, opacity: 0.8 }}>Selected: {ids.length}</p>
    </div>
  );
}

const plugin = await createPlugin({ pluginId: '${pluginId}' });
createRoot(document.getElementById('root')).render(<App plugin={plugin} />);
`;
}
