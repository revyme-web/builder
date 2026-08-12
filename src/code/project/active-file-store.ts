// active-file-store.ts — Active file tracking for the multi-file project.
// Provides activeFilePathAtom and activeCodeAtom.
// activeCodeAtom is the adapter: existing codeAtom consumers migrate to this.

import { atom, getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from './project-fs';
import { setForceRender } from '../mutation/mutation-queue';
import { overlayEditingIdAtom } from '../stores/overlay-store';
import { parseComponentName } from '../components/component-ops';
import { COMMENTS_FILE_PATH, parseComments, serializeComments } from './comments-config';
import { bumpProjectVersion, modifyProjectFile } from './modify-file';
import { clearBridgeReadCaches } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';
import { healMissingInstanceDataIds } from '@/code/parsing/heal-data-ids';
import { syncLocaleRoutes } from './locale-route-ops';
import { getI18nConfig } from './locale-ops';
import { normalizePageRootShell } from '../generation/page-root-shell';

// ─── Active File ────────────────────────────────────────────────────────────

/** Which file is currently being edited on the canvas + code editor */
// Initial active file = the canvas-editable Home client body. Pages
// are a pair (`page.tsx` server wrapper + `page.client.tsx` canvas
// body); the editor always activates the .client.tsx half.
export const activeFilePathAtom = atom<string>('app/page.client.tsx');

/**
 * Component editing breadcrumb stack.
 * When entering a component (double-click), push the current file path.
 * When going back, pop and restore. Empty = at page level (not inside any component).
 *
 * Example: user is on page.tsx, double-clicks <Hero />, then double-clicks <Button /> inside Hero:
 *   breadcrumb = ['app/page.tsx', 'components/Hero.tsx']
 *   activeFilePath = 'components/Button.tsx'
 */
export const componentBreadcrumbAtom = atom<string[]>([]);

/**
 * Read/write the active file's code from ProjectFS.
 * This replaces codeAtom as the primary code accessor.
 *
 * GET: reads activeFilePath from ProjectFS
 * SET: writes to ProjectFS + bumps version (triggers re-renders)
 */
export const activeCodeAtom = atom(
  (get) => {
    const filePath = get(activeFilePathAtom);
    // Subscribe to version so we re-read when files change
    get(projectVersionAtom);
    const content = projectFS.readFile(filePath);
    return typeof content === 'string' ? content : '';
  },
  (get, set, newCode: string) => {
    const filePath = get(activeFilePathAtom);
    // No-op on identical content. Undo/redo restores files through ProjectFS
    // FIRST (history.ts applyDiffs + its own version bump) and then mirrors
    // the code into this atom — without this guard the mirror re-wrote the
    // same 400KB+ string and bumped the version AGAIN, doubling the full
    // parse (~95ms) and the 3-viewport render (~250ms) on every Cmd+Z press
    // (live find 2026-07-17: laggy undo on an 810-node page).
    if (projectFS.readFile(filePath) === newCode) {
      trace.fn('activeCodeAtom:set-skip-identical', { filePath, length: newCode.length });
      return;
    }
    projectFS.writeFile(filePath, newCode);
    set(projectVersionAtom, (v) => v + 1);
  },
);

// ─── File Type Detection ────────────────────────────────────────────────────
// Pure path-kind predicates live in file-path-kind.ts (leaf — importable
// from canvas/node-ops without a cycle); re-exported here for callers.

import { isComponentFilePath, isTemplateFilePath, isComponentLikeFilePath, isIconSetFilePath, isLayoutFile } from './file-path-kind';
export { isComponentFilePath, isTemplateFilePath, isComponentLikeFilePath, isIconSetFilePath, isLayoutFile };

/** Combined: any "master" file (component or icon set)
 *  — useful for the breadcrumb gate and other "user is editing a
 *  master, not a page" branches that should treat them the same. */
export function isMasterFilePath(path: string): boolean {
  return isComponentFilePath(path) || isIconSetFilePath(path);
}

/** A regular editable PAGE surface (page or its LayoutClient) — i.e. NOT a
 *  component / icon-set master. Per-page camera persistence and
 *  other "page, not master" behaviours gate on this. Masters own their own
 *  camera flow (component-navigation + breadcrumb), so they're excluded. */
export function isRegularPageFile(path: string): boolean {
  return !!path && !isMasterFilePath(path);
}

/** A node's `componentFile` points at a VECTOR SET (an imported
 *  icon/vector instance), NOT a code component. These are the `<Icon … />`
 *  instances whose master is a `icons/` set (or a vectors
 *  CDN url). Single source of truth shared by the layers panel (accent colour +
 *  vector icon) and the resize logic (intrinsic aspect-ratio lock). */
export function isVectorSetComponentFile(cf: string | null | undefined): boolean {
  return !!cf && (
    cf.startsWith('icons/') ||
    (cf.startsWith('http') && cf.includes('/vectors/'))
  );
}

/** Check if a file path is a code component file */
export function isCodeComponentPath(path: string): boolean {
  return path.startsWith('components/');
}

/**
 * Check if a file is a "design component" — a component file authored visually
 * (has variantConfig array or @name annotation), as opposed to a raw code component.
 * Used by the design-component AI chat to decide whether to show the bubble.
 */
export function isDesignComponentFile(path: string): boolean {
  if (!isComponentFilePath(path)) {
    trace.fn('isDesignComponentFile', { path, result: false, reason: 'not-component-path' });
    return false;
  }
  const code = projectFS.readFile(path) ?? '';
  if (!code) {
    trace.fn('isDesignComponentFile', { path, result: false, reason: 'empty-or-missing' });
    return false;
  }
  const hasVariantConfig = /const\s+variantConfig\s*=/.test(code);
  const hasName = /\/\*\*\s*@name\b/.test(code);
  const result = hasVariantConfig || hasName;
  trace.fn('isDesignComponentFile', { path, result, hasVariantConfig, hasName });
  return result;
}

// isLayoutFile moved to file-path-kind.ts (leaf) so node-ops can import it
// cycle-free; re-exported below with the other path predicates.

/**
 * Pages live as a PAIR of files in the App Router:
 *   - `<route>/page.tsx`         server wrapper (owns `metadata`)
 *   - `<route>/page.client.tsx`  the user-editable client body
 *
 * Next.js's `export const metadata` only works on server components, but
 * the canvas-generated JSX needs `'use client'` for hooks / motion
 * / refs. The wrapper file is the metadata host; the client file is what
 * the canvas reads + writes. Everywhere outside this module that talks
 * about "the page file" should mean the .client.tsx — that's the one
 * the editor activates, parses, and mutates.
 */

/** True when the path is `<dir>/page.client.tsx` — the canvas-editable
 *  half of a page pair. */
export function isPageClientFile(path: string): boolean {
  return path.endsWith('/page.client.tsx') || path === 'page.client.tsx';
}

/** True when the path is `<dir>/page.tsx` — the server wrapper half of
 *  a page pair. */
export function isPageServerFile(path: string): boolean {
  return (path.endsWith('/page.tsx') || path === 'page.tsx') && !isPageClientFile(path);
}

/** Convert a page's server-wrapper path to its client-body path.
 *    `app/page.tsx` → `app/page.client.tsx`
 *    `app/about/page.tsx` → `app/about/page.client.tsx`
 *  Returns the input unchanged when it doesn't look like a server page. */
export function getPageClientPath(serverPath: string): string {
  if (!isPageServerFile(serverPath)) return serverPath;
  return serverPath.replace(/\/?page\.tsx$/, (m) => m.replace('page.tsx', 'page.client.tsx'));
}

/** Inverse of `getPageClientPath`. */
export function getPageServerPath(clientPath: string): string {
  if (!isPageClientFile(clientPath)) return clientPath;
  return clientPath.replace(/\/?page\.client\.tsx$/, (m) => m.replace('page.client.tsx', 'page.tsx'));
}

/** Get the LayoutClient.tsx path for a given layout.tsx path */
export function getLayoutClientPath(layoutPath: string): string {
  return layoutPath.replace(/layout\.(tsx|jsx)$/, 'LayoutClient.tsx');
}

/**
 * For an A/B-test variant file (`_revyme/variants/{testId}/{variantId}.tsx`),
 * return the parent PAGE file path it was forked from — read from the test's
 * manifest `_revyme/variants/{testId}/test.json` (`pagePath` field). Returns
 * null for any non-variant path.
 *
 * A variant is "the same page" for every Template/layout/route purpose (it
 * shares the page's URL and must keep its header/footer), but it lives
 * OUTSIDE the `app/` route-group tree, so route/layout resolvers would
 * otherwise find nothing. They route through this first so a variant
 * inherits exactly what its page has. Cheap for the common case — the regex
 * rejects non-variant paths before any FS read.
 */
/** Cheap path-only check: is this an A/B-test variant file? (no FS read,
 *  unlike getVariantBasePage). Use on hot render paths. */
export function isVariantFile(filePath: string): boolean {
  return /^_revyme\/variants\/[^/]+\/[^/]+\.tsx$/.test(filePath);
}

export function getVariantBasePage(filePath: string): string | null {
  const m = filePath.match(/^(_revyme\/variants\/[^/]+)\/[^/]+\.tsx$/);
  if (!m) return null;
  const raw = projectFS.readFile(`${m[1]}/test.json`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { pagePath?: unknown };
    return typeof parsed.pagePath === 'string' && parsed.pagePath ? parsed.pagePath : null;
  } catch {
    return null;
  }
}

/**
 * A variant's PER-VARIANT Template override, read from its `test.json` manifest
 * (`variants[].template`). Three states:
 *   - `undefined` → INHERIT the Control page's template (the default; existing
 *     variants have no `template` key).
 *   - `''`        → explicit NONE (no template, even if the Control has one).
 *   - `'Body'`    → use that template (route group), regardless of the Control.
 * This is what lets an A/B variant run a completely different template than its
 * Control (design-tool parity). `getRouteGroup`/`getLayoutForPage` resolve through it.
 */
export function getVariantTemplateOverride(filePath: string): string | undefined {
  const m = filePath.match(/^(_revyme\/variants\/[^/]+)\/([^/]+)\.tsx$/);
  if (!m) return undefined;
  const raw = projectFS.readFile(`${m[1]}/test.json`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { variants?: Array<{ id?: string; template?: unknown }> };
    const entry = Array.isArray(parsed.variants) ? parsed.variants.find((v) => v.id === m[2]) : undefined;
    return entry && typeof entry.template === 'string' ? entry.template : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a variant's Template override into its manifest. `templateName`:
 *   - a template (route-group) name → that template,
 *   - `''` → explicit NONE,
 *   - `null` → clear the override (back to INHERIT the Control).
 * Caller bumps the project version so the canvas re-merges. No file move (a
 * variant is a flat file under `_revyme/variants/`), unlike `assignTemplate`.
 */
export function setVariantTemplate(filePath: string, templateName: string | null): void {
  const m = filePath.match(/^(_revyme\/variants\/[^/]+)\/([^/]+)\.tsx$/);
  if (!m) return;
  const manifestPath = `${m[1]}/test.json`;
  const raw = projectFS.readFile(manifestPath);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { variants?: Array<{ id?: string; template?: string }> };
    const entry = Array.isArray(parsed.variants) ? parsed.variants.find((v) => v.id === m[2]) : undefined;
    if (!entry) return;
    if (templateName === null) delete entry.template;  // back to inherit
    else entry.template = templateName;                // '' = none, name = template
    projectFS.writeFile(manifestPath, JSON.stringify(parsed, null, 2));
  } catch {
    /* malformed manifest — leave it alone */
  }
}

/**
 * Find the layout file that applies to a given page.
 * Walks up the directory tree from the page to root (Next.js nested layout resolution).
 * e.g. app/blog/page.client.tsx → checks app/blog/layout.tsx, then app/layout.tsx
 * Accepts either the server wrapper (`page.tsx`) or the client body
 * (`page.client.tsx`) — both live in the same directory.
 * A/B variant files resolve to their parent page first so they share its layout.
 */
export function getLayoutForPage(pagePath: string): string | null {
  if (isVariantFile(pagePath)) {
    const override = getVariantTemplateOverride(pagePath);
    if (override !== undefined) {
      // Explicit per-variant choice: '' = none (bare, no merge); else that
      // template's group layout. Independent of the Control's template.
      if (!override) return null;
      const lp = `app/(${override})/layout.tsx`;
      return projectFS.exists(lp) ? lp : null;
    }
    // No override → inherit: resolve from the parent page (walk below).
    pagePath = getVariantBasePage(pagePath) ?? pagePath;
  }
  const parts = pagePath.split('/');
  parts.pop(); // remove page.tsx or page.client.tsx
  while (parts.length > 0) {
    const layoutPath = parts.join('/') + '/layout.tsx';
    if (projectFS.exists(layoutPath)) return layoutPath;
    parts.pop();
  }
  return null;
}

// ─── URL ↔ Page Sync ────────────────────────────────────────────────────

/**
 * Convert a file path to a URL-friendly page slug.
 * app/page.tsx → 'home'
 * app/(default)/page.tsx → 'home'    (templated home — group stripped)
 * app/about/page.tsx → 'about'
 * app/(marketing)/about/page.tsx → 'about'
 * components/Hero.tsx → 'component:Hero'
 *
 * Route-group folders are URL-invisible (Next.js convention) and represent
 * Templates in this project — see `template-ops.ts`. Two pages with the
 * same slug-after-group-strip would collide at build time, so the URL can
 * safely ignore which template a page is assigned to.
 */
export function filePathToSlug(filePath: string): string {
  if (filePath.startsWith('app/')) {
    const stripped = filePath
      .replace(/^app\//, '')
      // Strip route group folder: (marketing)/about/page.client.tsx → about/page.client.tsx
      .replace(/\([^)]+\)\//, '');
    // Match both halves of the page pair so callers can pass either
    // `page.tsx` (server wrapper) or `page.client.tsx` (canvas body).
    if (stripped === 'page.tsx' || stripped === 'page.client.tsx') return 'home';
    return stripped.replace(/\/page\.client\.tsx$/, '').replace(/\/page\.tsx$/, '');
  }
  if (filePath.startsWith('components/')) {
    return 'component:' + filePath.replace(/^components\//, '').replace(/\.tsx$/, '');
  }
  return filePath;
}

/**
 * Canonical A/B-test `page_path` for a page file, matching what the
 * backend stores and validates (`PAGE_PATH_RX = /^[a-z0-9/_-]{1,255}$/`).
 * Unlike `filePathToSlug`, this KEEPS the trailing `page` segment:
 *   app/page.client.tsx                 → 'page'        (home)
 *   app/(Body)/advisors/page.client.tsx → 'advisors/page'
 *   app/page-copy/page.tsx              → 'page-copy/page'
 * Accepts either half of the page pair (`page.tsx` server wrapper OR
 * `page.client.tsx` canvas body) — stripping `.client.tsx` is what was
 * missing before, which left a `.` in the path and got rejected.
 */
export function filePathToAbPagePath(filePath: string): string {
  return filePath
    .replace(/^app\//, '')
    .replace(/\(.+?\)\//g, '')      // strip route group(s): (Body)/ → ''
    .replace(/\.client\.tsx$/, '')  // page.client.tsx → page
    .replace(/\.tsx$/, '');         // fallback: page.tsx → page
}

/**
 * Convert a URL slug back to a file path.
 * 'home' → app/page.tsx
 * 'about' → app/about/page.tsx
 * 'component:Hero' → components/Hero.tsx
 *
 * Templates: a slug like `about` could live at either `app/about/page.tsx`
 * or `app/(template)/about/page.tsx`. We probe the bare path first, then
 * scan all route-group folders for a match — so the URL doesn't have to
 * encode the user's template choice. First match wins; ambiguity is
 * impossible inside Next.js anyway (two pages with the same final slug
 * would collide at build time).
 */
export function slugToFilePath(slug: string): string {
  if (slug.startsWith('component:')) {
    return 'components/' + slug.replace('component:', '') + '.tsx';
  }
  // Return the .client.tsx half of the page pair — that's the canvas-
  // editable file. The server wrapper `page.tsx` is implicit (always
  // sits next to the client file and just re-exports it).
  const filename = 'page.client.tsx';
  const path = !slug || slug === 'home' ? filename : `${slug}/${filename}`;
  const bare = `app/${path}`;
  if (projectFS.exists(bare)) return bare;
  // Scan templated locations: `app/(name)/<path>`.
  for (const file of projectFS.listFiles('app/')) {
    const m = file.match(/^app\/\(([^)]+)\)\/(.+)$/);
    if (m && m[2] === path) return file;
  }
  // Legacy fallback: pre-split projects had `page.tsx` directly as the
  // editable file. If we can't find a `.client.tsx`, try the legacy
  // path so old in-flight tabs don't immediately break.
  const legacyFilename = !slug || slug === 'home' ? 'page.tsx' : `${slug}/page.tsx`;
  const legacyBare = `app/${legacyFilename}`;
  if (projectFS.exists(legacyBare)) return legacyBare;
  // Caller will surface "no such page" downstream.
  return bare;
}

/**
 * Return a page route slug that DOESN'T collide with an existing page —
 * appending `-2`, `-3`, … until free (`blog` → `blog-2`). Used by every page
 * creator so two pages can never share a route.
 *
 * ROUTE-GROUP AWARE: existence is checked via `slugToFilePath`, which probes
 * the bare `app/<slug>/…` AND scans `app/(group)/<slug>/…`. A bare-path-only
 * check is the bug behind "let me create a 2nd /blog" — the existing `/blog`
 * lived at `app/(Body)/blog/page.client.tsx`, invisible to `app/blog/…`.
 *
 * `routeSuffix` lets callers test a deeper route — e.g. `'/[slug]'` for a CMS
 * detail page so `blog/[slug]` collisions bump the COLLECTION folder to
 * `blog-2/[slug]`.
 */
export function uniqueRouteSlug(baseSlug: string, routeSuffix = ''): string {
  const taken = (s: string) => projectFS.exists(slugToFilePath(`${s}${routeSuffix}`));
  if (!taken(baseSlug)) return baseSlug;
  let n = 2;
  while (taken(`${baseSlug}-${n}`)) n++;
  return `${baseSlug}-${n}`;
}

/**
 * The PARENT listing page of a CMS `[slug]` detail page, used as the slug
 * breadcrumb's "back / origin" fallback when no explicit referrer was recorded.
 *   app/blog/[slug]/page.client.tsx          → app/blog/page.client.tsx (/blog)
 *   app/(Body)/shop/items/[id]/page.client…  → the /shop/items page, if it exists
 * Drops the dynamic LAST route segment and resolves the parent slug to a real
 * page file. Returns null when there's no parent (top-level `[slug]`) or the
 * parent page doesn't exist.
 */
export function getSlugPageParentFile(slugFilePath: string): string | null {
  const slug = filePathToSlug(slugFilePath); // e.g. 'blog/[slug]'
  const parts = slug.split('/');
  if (parts.length < 2) return null; // no parent segment to go up to
  parts.pop(); // drop the dynamic param segment ([slug] / [id] / …)
  const parentSlug = parts.join('/');
  if (!parentSlug) return null;
  const file = slugToFilePath(parentSlug);
  return projectFS.exists(file) ? file : null;
}

/** Update the ?page= query param without navigation. */
export function syncUrlToPage(filePath: string): void {
  const slug = filePathToSlug(filePath);
  const url = new URL(window.location.href);
  if (slug === 'home') {
    url.searchParams.delete('page');
  } else {
    url.searchParams.set('page', slug);
  }
  history.replaceState(null, '', url.toString());
  trace.action('active-file:url-sync', { filePath, slug });
}

/** Read the ?page= query param and return the file path. Returns the
 *  .client.tsx half — the canvas-editable file the editor activates. */
export function getPageFromUrl(): string {
  if (typeof window === 'undefined') return 'app/page.client.tsx';
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('page');
  return slugToFilePath(slug || '');
}

// ─── CMS Overlay URL sync ──────────────────────────────────────────────────
// `?cms=<slug>` opens the CMS editor overlay on that collection.
// `&item=<id>` expands a row. `&field=<fieldId>` highlights a specific field.
// Used so canvas double-click on a CMS-bound text node deep-links to the
// matching collection/row/field — same shape as `?page=component:<id>`.

export function syncUrlToCms(slug: string | null, itemId?: string | null, fieldId?: string | null): void {
  const url = new URL(window.location.href);
  if (!slug) {
    url.searchParams.delete('cms');
    url.searchParams.delete('item');
    url.searchParams.delete('field');
  } else {
    url.searchParams.set('cms', slug);
    if (itemId) url.searchParams.set('item', itemId);
    else url.searchParams.delete('item');
    if (fieldId) url.searchParams.set('field', fieldId);
    else url.searchParams.delete('field');
  }
  history.replaceState(null, '', url.toString());
  trace.action('cms:url-sync', { slug, itemId, fieldId });
}

export function getCmsFromUrl(): { slug: string | null; itemId: string | null; fieldId: string | null } {
  if (typeof window === 'undefined') return { slug: null, itemId: null, fieldId: null };
  const params = new URLSearchParams(window.location.search);
  return {
    slug: params.get('cms'),
    itemId: params.get('item'),
    fieldId: params.get('field'),
  };
}

// ─── File Switching ─────────────────────────────────────────────────────────

/**
 * Switch active file safely: sync queue, flush, clear selection, set new path.
 * Use this everywhere instead of manually calling syncQueueCode + flushNow + setSelectedIds + setActiveFile.
 *
 * @param from - Current active file path
 * @param to - New file path to switch to
 * @param setters - Atom setters from the React component
 * @param queue - Mutation queue functions (passed to avoid circular imports)
 */
/** Camera-memory hook, registered by the canvas layer (which can reach
 *  transformManager). Called inside `switchActiveFile` BEFORE the render,
 *  so a saved camera can be applied synchronously. Null in tests/headless. */
let _switchCameraHandler: ((from: string, to: string) => void) | null = null;
export function setSwitchCameraHandler(fn: ((from: string, to: string) => void) | null): void {
  _switchCameraHandler = fn;
}

export function switchActiveFile(
  from: string,
  to: string,
  setters: {
    setActiveFile: (path: string) => void;
    setSelectedIds: (ids: string[]) => void;
    setUpdatingFromCanvas: (v: boolean) => void;
  },
  queue: {
    syncQueueCode: (code: string) => void;
    flushNow: () => void;
  },
): void {
  if (from === to) return;
  trace.action('active-file:switch', { from, to });
  const freshCode = projectFS.readFile(from);
  if (freshCode) {
    queue.syncQueueCode(freshCode);
    queue.flushNow();
  }
  setters.setUpdatingFromCanvas(false);
  setters.setSelectedIds([]);
  // Camera memory hook — runs BEFORE the render-triggering `setActiveFile`
  // below, so it can apply the target page's saved pan/zoom SYNCHRONOUSLY
  // (the new content then renders at the correct camera from its first
  // frame, no scale-down flash). Same ordering the breadcrumb "back to
  // page" uses. The canvas layer registers it; null in headless/tests.
  _switchCameraHandler?.(from, to);
  // Force the next Renderer cycle to do a FULL rebuild (not a diff patch).
  // Without this, when the same data-id exists in both files (e.g. a Marquee
  // carried into a component master keeps its data-id), the Renderer's diff
  // sees "kept" and skips re-emitting rects for those nodes — the bridge
  // rect cache stays on the previous file's coordinates and every polled
  // overlay (selection box, slot handle, slot connectors) paints stale on
  // first entry until any subsequent action triggers another render cycle.
  // Same pattern the creators use after a full code replacement.
  setForceRender();
  // Self-heal the DESTINATION before it becomes active: instance tags
  // without `data-id` parse as `auto_<n>` and every mutation against them
  // silently no-ops (drag-out reverts on the next parse — user report
  // 2026-07-30). `modifyProjectFile` is safe here: `to` is not the active
  // file yet, so the queue's currentCode is untouched.
  modifyProjectFile(to, (code) => healMissingInstanceDataIds(code).code);
  setters.setActiveFile(to);
  // Bump the project version so derived atoms (stable nodes/code, anything
  // gated on `projectVersionAtom`) re-evaluate after the switch lands.
  bumpProjectVersion();
  // Clear overlay mode on page switch
  getDefaultStore().set(overlayEditingIdAtom, null);
  // Wipe the bridge's read caches so the next selection/hover/slot-handle
  // poll doesn't read stale rect/corners entries from the previous file
  // — same data-id can appear in both files (e.g. a Marquee carried into
  // a component master keeps its data-id) and the cache key is just
  // `vpPrefix:nodeId`, so without this the overlay momentarily snaps to
  // the old file's position until the new file's `allRects` event lands.
  clearBridgeReadCaches();
  syncUrlToPage(to);

  // "Fake user action" — re-prime atoms a moment after the switch so the
  // iframe's freshly-rendered state propagates back into selection/hover
  // overlays. Matches what any real user action does (mutation → flush →
  // setCode → re-derivations → fresh allRects).
  //
  // Timing notes from experimentation:
  //   - 3-rAF chain (~48ms): fires DURING iframe paint → freezes hover.
  //   - first `revyme:render-complete` event: fires before iframe is
  //     fully settled (the renderer dispatches it post-DOM-build but
  //     pre-allRects on some paths) → also freezes hover.
  //   - setTimeout(600ms): works but produces a visible flash.
  //   - setTimeout(250ms): works, flash barely perceptible — chosen value.
  //   - setTimeout(100ms): too early, iframe still settling → freeze.
  // 250ms is the confirmed safe floor; don't drop it without re-testing.
  // No cache clear in the bump — the synchronous clear above already ran;
  // clearing again post-iframe-paint would wipe the just-populated cache
  // and leave a one-frame hole where overlays poll empty.
  setTimeout(() => {
    setForceRender();
    bumpProjectVersion();
    trace.action('active-file:switch-late-bump', { to });
  }, 250);
}

// ─── File Operations ────────────────────────────────────────────────────────

export function getFileDisplayName(filePath: string): string {
  // app/page.client.tsx → /
  // app/about/page.client.tsx → /about
  // app/not-found.tsx → "404"  (project-wide 404 page; not a route slug)
  // components/Xyz.tsx → @name annotation or filename fallback
  //
  // Accepts BOTH halves of a page pair — server wrapper (`page.tsx`)
  // and client body (`page.client.tsx`) — so call sites that still hold
  // a wrapper path (e.g. legacy URL params) keep displaying correctly.
  if (filePath === NOT_FOUND_PATH) return '404';
  if (filePath.startsWith('app/')) {
    const slug = filePath
      .replace(/^app\//, '')
      // Route groups `(name)/` are URL-INVISIBLE in Next.js — a page at
      // `app/(Body)/page.client.tsx` lives at `/`, not `/(Body)`. Strip them so
      // a grouped home resolves to '/' → "Home" (PageSelector's
      // getPageRouteLabel maps this '/' to "Home") instead of showing the
      // raw group in the breadcrumb.
      .replace(/\(.+?\)\//g, '')
      .replace(/\/page\.client\.tsx$/, '')
      .replace(/page\.client\.tsx$/, '')
      .replace(/\/page\.tsx$/, '')
      .replace(/page\.tsx$/, '');
    return '/' + slug;
  }
  if (filePath.startsWith('components/')) {
    // Try to read @name annotation from the component file
    const code = projectFS.readFile(filePath);
    if (code) {
      const displayName = parseComponentName(code);
      if (displayName) return displayName;
    }
    return filePath.replace(/^components\//, '').replace(/\.tsx$/, '');
  }
  if (filePath.startsWith('icons/')) {
    // Same @name lookup as components — icon-set files share the
    // annotation convention. Falls back to file basename.
    const code = projectFS.readFile(filePath);
    if (code) {
      const displayName = parseComponentName(code);
      if (displayName) return displayName;
    }
    return filePath.replace(/^icons\//, '').replace(/\.tsx$/, '');
  }
  if (filePath.startsWith('plugins/')) {
    // Tier 2 plugins share the @name convention (written by the Library
    // panel's Rename action). Falls back to the file basename.
    const code = projectFS.readFile(filePath);
    if (code) {
      const displayName = parseComponentName(code);
      if (displayName) return displayName;
    }
    return filePath.replace(/^plugins\//, '').replace(/\.tsx$/, '');
  }
  // A/B-test variant file (`_revyme/variants/<testId>/<vid>.tsx`):
  // read the sidecar manifest to surface the friendly variant name
  // ("Variant", "Variant 1", "Control", whatever the user renamed it
  // to). Lets the breadcrumb show "Variant" instead of the opaque
  // `_revyme/variants/97297995-…` path.
  const variantMatch = filePath.match(/^_revyme\/variants\/([^/]+)\/([^/]+)\.tsx$/);
  if (variantMatch) {
    const testId = variantMatch[1]!;
    const variantId = variantMatch[2]!;
    const manifestJson = projectFS.readFile(`_revyme/variants/${testId}/test.json`);
    if (manifestJson) {
      try {
        const manifest = JSON.parse(manifestJson) as { variants?: Array<{ id: string; name: string }> };
        const v = manifest.variants?.find(x => x.id === variantId);
        if (v?.name) return v.name;
      } catch {
        // fall through to the path-based fallback below
      }
    }
    return `Variant ${variantId.toUpperCase()}`;
  }
  return filePath;
}

/** Get page slug from file path (for page files only) */
export function getPageSlug(filePath: string): string {
  if (!filePath.startsWith('app/')) return filePath;
  const slug = filePath
    .replace(/^app\//, '')
    // Strip route group folder: (marketing)/about/page.client.tsx → about/page.client.tsx
    .replace(/\([^)]+\)\//, '')
    // Match both halves of the page pair.
    .replace(/\/page\.client\.tsx$/, '')
    .replace(/page\.client\.tsx$/, '')
    .replace(/\/page\.tsx$/, '')
    .replace(/page\.tsx$/, '');
  return '/' + slug;
}

/** Check if a file path is a page file */

/** List all page file paths — one per route. Returns the .client.tsx
 *  (canvas-editable) half of each page pair, since that's the
 *  canonical "page" everywhere else in the editor treats. The server
 *  wrapper (`page.tsx`) is implicit alongside each entry. */
export function listPageFiles(): string[] {
  return projectFS.listFiles('app/').filter(f => f.endsWith('page.client.tsx'));
}

/** The canvas-editable HOME page file (slug 'home'), accounting for route
 *  groups — the home page may live at `app/(Body)/page.client.tsx`, not the
 *  bare `app/page.client.tsx`. Used as the breadcrumb's page root when none is
 *  recorded (template/component opened directly) and as the "back to page"
 *  fallback. Falls back to the bare path if no home page is found. */
export function getHomePageFilePath(): string {
  return listPageFiles().find(p => filePathToSlug(p) === 'home') ?? 'app/page.client.tsx';
}

// ─── 404 / not-found page ─────────────────────────────────────────────────

/**
 * Reserved Next.js path for the project-wide 404 page. vinext picks
 * this up at build time and Cloudflare Workers serves it on any
 * unmatched route — no special wiring needed beyond writing the file.
 *
 * One file per project (the reference model, not Next.js's per-route-group
 * model). The Pages panel surfaces it inline with a "404" badge; the
 * Pages "+" dropdown offers a "404 Page" entry only when this file
 * doesn't yet exist.
 */
export const NOT_FOUND_PATH = 'app/not-found.tsx';

/** True when `path === NOT_FOUND_PATH`. Cheap sentinel check used by
 *  panel rendering, Link-tool filter, breadcrumb display, etc. */
export function isNotFoundPage(path: string): boolean {
  return path === NOT_FOUND_PATH;
}

/** True when the project has a 404 page on disk. The Pages "+" dropdown
 *  hides its "404 Page" item when this returns true (one file allowed). */
export function notFoundExists(): boolean {
  return projectFS.exists(NOT_FOUND_PATH);
}

/**
 * Scaffold `app/not-found.tsx` with a sensible default — full-bleed
 * dark background, centered "404 — Page not found" + back-to-home
 * button. Standard Next.js source, no canvas-specific transform: the
 * file renders directly when the user publishes. `data-id` markers on
 * each element so the canvas selects + edits everything from the
 * first paint without the parser having to fall back on auto-ids.
 *
 * No-op when the file already exists. Returns the path either way so
 * callers can `setActiveFile(createNotFoundPageFile())` unconditionally.
 */
export function createNotFoundPageFile(): string {
  if (notFoundExists()) return NOT_FOUND_PATH;
  const template = `'use client';

export default function NotFound() {
  return (
    <main data-id="root" style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '24px',
      padding: '48px',
      textAlign: 'center',
      backgroundColor: '#0a0a0a',
      color: '#ffffff',
    }}>
      <h1 data-id="title" style={{ fontSize: '120px', fontWeight: 700, lineHeight: 1, margin: 0 }}>404</h1>
      <p data-id="subtitle" style={{ fontSize: '18px', color: '#888888', margin: 0 }}>Page not found</p>
      <a data-id="home-link" href="/" style={{
        marginTop: '16px',
        padding: '12px 24px',
        backgroundColor: '#ffffff',
        color: '#000000',
        borderRadius: '8px',
        textDecoration: 'none',
        fontWeight: 500,
      }}>
        Back to home
      </a>
    </main>
  );
}
`;
  projectFS.writeFile(NOT_FOUND_PATH, template);
  return NOT_FOUND_PATH;
}

/** Create a new page. Emits TWO files (the page pair):
 *    `<dir>/page.tsx`         — server wrapper. Owns the SEO
 *                                `metadata` export and re-exports the
 *                                client body as default.
 *    `<dir>/page.client.tsx`  — the canvas-editable body. `'use client'`
 *                                plus the @canvas viewport config and
 *                                the empty-root JSX.
 *  Returns the CLIENT path because that's what callers want to activate
 *  in the editor — the server wrapper is implicit. */
let pageCounter = 0;
export function createPageFile(name?: string, groupDir?: string): string {
  pageCounter++;
  const pageName = name || `Page ${pageCounter + 2}`;
  // Never collide with an existing page route (incl. ones in route groups).
  const slug = uniqueRouteSlug(pageName.toLowerCase().replace(/\s+/g, '-'));
  const baseDir = groupDir || 'app';
  const serverPath = `${baseDir}/${slug}/page.tsx`;
  const clientPath = `${baseDir}/${slug}/page.client.tsx`;

  const serverCode = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

  const clientCode = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 }
  }
} */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="${pageName}" style={{
  position: 'relative', width: '100%', minHeight: '900px',
  backgroundColor: '#ffffff'
}}>
</div>
  );
}`;

  projectFS.writeFile(serverPath, serverCode);
  projectFS.writeFile(clientPath, clientCode);
  trace.action('active-file:create-page', { clientPath, serverPath, pageName });
  syncLocaleRoutes(getI18nConfig());
  return clientPath;
}

/** Delete a page. Removes BOTH halves of the page pair (the server
 *  wrapper at `page.tsx` and the client body at `page.client.tsx`) and
 *  GCs comments scoped to either path. Accepts either path on input —
 *  callers historically pass the canonical client path, but we tolerate
 *  the wrapper for older URL params / undo entries. */
export function deletePageFile(filePath: string): void {
  const clientPath = isPageServerFile(filePath) ? getPageClientPath(filePath) : filePath;
  const serverPath = isPageClientFile(clientPath) ? getPageServerPath(clientPath) : filePath;

  if (projectFS.exists(clientPath)) projectFS.deleteFile(clientPath);
  if (clientPath !== serverPath && projectFS.exists(serverPath)) projectFS.deleteFile(serverPath);
  pruneCommentsForFilePath(clientPath);
  if (clientPath !== serverPath) pruneCommentsForFilePath(serverPath);
  syncLocaleRoutes(getI18nConfig());
  trace.action('active-file:delete-page', { clientPath, serverPath });
}

/**
 * Move a page to a new path. Moves BOTH halves of the page pair
 * atomically and rewrites every comment's `filePath` field so threads
 * stay attached after a rename / route-group move.
 *
 * `oldPath` / `newPath` can be either the server wrapper or the client
 * body — we derive the corresponding partner for each. Used for
 * drag-drop nesting and route group assignment.
 */
export function movePageFile(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  const oldClient = isPageServerFile(oldPath) ? getPageClientPath(oldPath) : oldPath;
  const newClient = isPageServerFile(newPath) ? getPageClientPath(newPath) : newPath;
  const oldServer = isPageClientFile(oldClient) ? getPageServerPath(oldClient) : oldPath;
  const newServer = isPageClientFile(newClient) ? getPageServerPath(newClient) : newPath;

  if (projectFS.exists(oldClient)) {
    projectFS.moveFile(oldClient, newClient);
    retargetCommentsForFilePath(oldClient, newClient);
  }
  if (oldServer !== oldClient && projectFS.exists(oldServer)) {
    projectFS.moveFile(oldServer, newServer);
    retargetCommentsForFilePath(oldServer, newServer);
  }
  // TEMPLATE-BOUNDARY ROOT NORMALIZATION. A templated page's `data-id="root"` collides
  // with the template's root in the canvas node map — its shell styles are DROPPED on the
  // canvas but still render live (the page-root `overflowX: 'hidden'` became a live nested
  // scroll container → double scrollbar, 2026-07-28). Crossing INTO a template strips the
  // root to the bare canonical (keeps its flex column, loses overflow/background/padding);
  // crossing OUT restores the standalone shell (overflowX 'clip' + background). Done here —
  // not in assignTemplate — so every path shares it: the Template picker, the MCP bulk
  // apply, AND the Pages-panel drag (which calls movePageFile directly).
  const wasTemplated = routeGroupHasLayoutClient(oldClient);
  const isTemplated = routeGroupHasLayoutClient(newClient);
  if (wasTemplated !== isTemplated && isPageClientFile(newClient) && projectFS.exists(newClient)) {
    const code = projectFS.readFile(newClient);
    if (code) {
      const normalized = normalizePageRootShell(code, isTemplated ? 'templated' : 'standalone');
      if (normalized !== code) {
        projectFS.writeFile(newClient, normalized);
        trace.action('active-file:move-page-root-normalized', {
          path: newClient, mode: isTemplated ? 'templated' : 'standalone',
        });
      }
    }
  }
  trace.action('active-file:move-page', {
    fromClient: oldClient, toClient: newClient, fromServer: oldServer, toServer: newServer,
  });
  syncLocaleRoutes(getI18nConfig());
}

/** Is this path inside a route group that is a real TEMPLATE (has a LayoutClient)?
 *  Organisational route groups (pages only, no LayoutClient) are NOT templates — moving
 *  between them must not touch the page root. Inlined (vs importing template-ops) to keep
 *  this module cycle-free: template-ops imports movePageFile from here. */
function routeGroupHasLayoutClient(filePath: string): boolean {
  const group = getRouteGroup(filePath);
  return !!group && projectFS.exists(`app/(${group})/LayoutClient.tsx`);
}

/** Remove every comment whose `filePath === filePath` from
 *  `_meta/comments.json`. Inlined here (rather than calling
 *  `commentOps.removeCommentsForFilePath`) so this module doesn't have
 *  to import comment-store and re-create the active-file-store ↔
 *  comment-store dependency cycle. */
function pruneCommentsForFilePath(filePath: string): void {
  const json = projectFS.readFile(COMMENTS_FILE_PATH);
  if (!json) return;
  const before = parseComments(json);
  const after = before.filter((c) => c.filePath !== filePath);
  if (after.length === before.length) return;
  projectFS.writeFile(COMMENTS_FILE_PATH, serializeComments(after));
  bumpProjectVersion();
  trace.action('active-file:prune-comments', { filePath, removed: before.length - after.length });
}

/** Rewrite `filePath` on every comment matching `oldPath` so threads
 *  follow the page through a rename / move. */
function retargetCommentsForFilePath(oldPath: string, newPath: string): void {
  const json = projectFS.readFile(COMMENTS_FILE_PATH);
  if (!json) return;
  const before = parseComments(json);
  let changed = false;
  const after = before.map((c) => {
    if (c.filePath !== oldPath) return c;
    changed = true;
    return { ...c, filePath: newPath };
  });
  if (!changed) return;
  projectFS.writeFile(COMMENTS_FILE_PATH, serializeComments(after));
  bumpProjectVersion();
  trace.action('active-file:retarget-comments', { from: oldPath, to: newPath });
}

/**
 * Create a new route group folder with optional layout.
 * Route groups use (name) syntax — they don't affect URLs.
 */
export function createRouteGroup(name: string, withLayout: boolean = true): string {
  const groupDir = `app/(${name})`;

  if (withLayout) {
    // Group layouts are NOT root layouts — no html/body/globals.css.
    // They just wrap content with their own visual chrome.
    const layoutCode = `import LayoutClient from './LayoutClient';

export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;
    projectFS.writeFile(`${groupDir}/layout.tsx`, layoutCode);

    const clientCode = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{
      position: 'relative',
      width: '100%',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {children}
    </div>
  );
}
`;
    projectFS.writeFile(`${groupDir}/LayoutClient.tsx`, clientCode);
  }

  trace.action('active-file:create-route-group', { name, groupDir, withLayout });
  return groupDir;
}

/**
 * Get the route group name from a file path, or null if not in a group.
 * e.g. 'app/(marketing)/about/page.tsx' → 'marketing'
 * A/B variant files resolve to their parent page first, so a variant reports
 * the SAME Template (route group) as the page it tests — keeping the Template
 * tool present and correct while editing a variant.
 */
export function getRouteGroup(filePath: string): string | null {
  if (isVariantFile(filePath)) {
    const override = getVariantTemplateOverride(filePath);
    if (override !== undefined) return override || null;  // '' → null (none)
    const base = getVariantBasePage(filePath);            // inherit the Control's
    return base ? getRouteGroup(base) : null;             // (base is never a variant)
  }
  const match = filePath.match(/app\/\(([^)]+)\)\//);
  return match ? match[1] : null;
}

/**
 * List all route groups in the project.
 * Returns group names (without parentheses).
 */
export function listRouteGroups(): string[] {
  const groups = new Set<string>();
  for (const file of projectFS.listFiles('app/')) {
    const group = getRouteGroup(file);
    if (group) groups.add(group);
  }
  return [...groups].sort();
}
