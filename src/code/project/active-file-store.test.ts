// active-file-store.test.ts — Tests for getFileDisplayName and file type helpers.

import { describe, it, test, expect, beforeEach } from 'vitest';
import {
  getFileDisplayName,
  isComponentFilePath,
  isTemplateFilePath,
  isComponentLikeFilePath,
  isCodeComponentPath,
  isLayoutFile,
  isDesignComponentFile,
  isMasterFilePath,
  isRegularPageFile,
  NOT_FOUND_PATH,
  isNotFoundPage,
  notFoundExists,
  createNotFoundPageFile,
  listPageFiles,
  getHomePageFilePath,
  filePathToAbPagePath,
  getVariantBasePage,
  isVariantFile,
  getVariantTemplateOverride,
  setVariantTemplate,
  getRouteGroup,
  getLayoutForPage,
  uniqueRouteSlug,
} from './active-file-store';
import { projectFS, resetProjectFS } from './project-fs';

beforeEach(() => {
  resetProjectFS();
});

// ─── getFileDisplayName ─────────────────────────────────────────────────────

describe('getFileDisplayName', () => {
  test('returns / for app/page.tsx', () => {
    expect(getFileDisplayName('app/page.tsx')).toBe('/');
  });

  test('returns /about for app/about/page.tsx', () => {
    expect(getFileDisplayName('app/about/page.tsx')).toBe('/about');
  });

  test('returns /blog for app/blog/page.tsx', () => {
    expect(getFileDisplayName('app/blog/page.tsx')).toBe('/blog');
  });

  test('strips route groups — a grouped home resolves to / (not /(Body))', () => {
    expect(getFileDisplayName('app/(Body)/page.client.tsx')).toBe('/');
    expect(getFileDisplayName('app/(Body)/page.tsx')).toBe('/');
  });

  test('strips route groups for a grouped sub-page', () => {
    expect(getFileDisplayName('app/(marketing)/about/page.client.tsx')).toBe('/about');
    // The exact paths the Layers-panel PageSelector dropdown labels via
    // getPageRouteLabel — a grouped collection page and its nested [slug]
    // detail must surface the FULL route, not the bare leaf segment.
    expect(getFileDisplayName('app/(Body)/advisors/page.client.tsx')).toBe('/advisors');
    expect(getFileDisplayName('app/(Body)/blog/[slug]/page.client.tsx')).toBe('/blog/[slug]');
  });
});

describe('getHomePageFilePath', () => {
  it('finds a route-grouped home page (app/(Body)/page.client.tsx)', () => {
    projectFS.writeFile('app/(Body)/page.client.tsx', 'export default function P(){return <div/>;}');
    expect(getHomePageFilePath()).toBe('app/(Body)/page.client.tsx');
  });

  it('finds a bare home page', () => {
    projectFS.writeFile('app/page.client.tsx', 'export default function P(){return <div/>;}');
    expect(getHomePageFilePath()).toBe('app/page.client.tsx');
  });

  test('returns filename for component without @name annotation', () => {
    projectFS.writeFile('components/HeroCard.tsx', `
      export default function HeroCard() { return <div />; }
    `);
    expect(getFileDisplayName('components/HeroCard.tsx')).toBe('HeroCard');
  });

  test('returns @name annotation value from component file', () => {
    projectFS.writeFile('components/XyzAbc.tsx', `
import React from 'react';
/** @name "Hero Section" */
const variantConfig = [];
export default function XyzAbc() { return <div />; }
    `);
    expect(getFileDisplayName('components/XyzAbc.tsx')).toBe('Hero Section');
  });

  test('returns @name with special characters', () => {
    projectFS.writeFile('components/AbcDef.tsx', `
/** @name "header component v2" */
export default function AbcDef() { return <div />; }
    `);
    expect(getFileDisplayName('components/AbcDef.tsx')).toBe('header component v2');
  });

  test('returns filename fallback when component file does not exist', () => {
    expect(getFileDisplayName('components/Missing.tsx')).toBe('Missing');
  });

  test('returns raw path for unknown file types', () => {
    expect(getFileDisplayName('lib/utils.ts')).toBe('lib/utils.ts');
  });

  test('returns filename when @name annotation has different format', () => {
    projectFS.writeFile('components/Test.tsx', `
// @name "Not Valid" — single-line comment, not jsdoc
export default function Test() { return <div />; }
    `);
    // Only /** @name "..." */ or /* @name "..." */ format should work
    expect(getFileDisplayName('components/Test.tsx')).toBe('Test');
  });
});

// ─── File type detection ────────────────────────────────────────────────────

describe('isComponentFilePath', () => {
  test('returns true for components/ paths', () => {
    expect(isComponentFilePath('components/Hero.tsx')).toBe(true);
    expect(isComponentFilePath('components/nested/Card.tsx')).toBe(true);
  });

  test('returns false for non-component paths', () => {
    expect(isComponentFilePath('app/page.tsx')).toBe(false);
    expect(isComponentFilePath('app/layout.tsx')).toBe(false);
  });
});

describe('isTemplateFilePath / isComponentLikeFilePath', () => {
  test('isTemplateFilePath = the editable LayoutClient, NOT the server layout.tsx', () => {
    expect(isTemplateFilePath('app/(site)/LayoutClient.tsx')).toBe(true);
    expect(isTemplateFilePath('LayoutClient.tsx')).toBe(true);
    expect(isTemplateFilePath('app/(site)/layout.tsx')).toBe(false); // server shell
    expect(isTemplateFilePath('app/page.client.tsx')).toBe(false);
    expect(isTemplateFilePath('components/Hero.tsx')).toBe(false);
  });

  test('isComponentLikeFilePath = real components OR templates', () => {
    expect(isComponentLikeFilePath('components/Hero.tsx')).toBe(true);
    expect(isComponentLikeFilePath('app/(site)/LayoutClient.tsx')).toBe(true);
    // pages, server layouts, icon masters are NOT component-like here
    expect(isComponentLikeFilePath('app/page.client.tsx')).toBe(false);
    expect(isComponentLikeFilePath('app/(site)/layout.tsx')).toBe(false);
    expect(isComponentLikeFilePath('icons/Lucide.tsx')).toBe(false);
  });
});

describe('isMasterFilePath / isRegularPageFile', () => {
  const masters = ['components/Hero.tsx', 'icons/Lucide.tsx'];
  const pages = ['app/page.client.tsx', 'app/about/page.client.tsx', 'app/(marketing)/LayoutClient.tsx'];

  test('masters are masters, not regular pages', () => {
    for (const p of masters) {
      expect(isMasterFilePath(p)).toBe(true);
      expect(isRegularPageFile(p)).toBe(false);
    }
  });

  test('pages + layout files are regular pages, not masters', () => {
    for (const p of pages) {
      expect(isMasterFilePath(p)).toBe(false);
      expect(isRegularPageFile(p)).toBe(true);
    }
  });

  test('empty path is neither (guards the camera effect from "" prev)', () => {
    expect(isRegularPageFile('')).toBe(false);
  });
});

describe('isCodeComponentPath', () => {
  test('returns true for components/ paths', () => {
    expect(isCodeComponentPath('components/Counter.tsx')).toBe(true);
    expect(isCodeComponentPath('components/Hero.tsx')).toBe(true);
  });

  test('returns false for non-component paths', () => {
    expect(isCodeComponentPath('app/page.tsx')).toBe(false);
    expect(isCodeComponentPath('app/layout.tsx')).toBe(false);
  });
});

describe('isLayoutFile', () => {
  test('returns true for layout files', () => {
    expect(isLayoutFile('app/layout.tsx')).toBe(true);
    expect(isLayoutFile('app/blog/layout.tsx')).toBe(true);
    expect(isLayoutFile('app/LayoutClient.tsx')).toBe(true);
  });

  test('returns false for non-layout files', () => {
    expect(isLayoutFile('app/page.tsx')).toBe(false);
    expect(isLayoutFile('components/Hero.tsx')).toBe(false);
  });
});

// ─── isDesignComponentFile ──────────────────────────────────────────────────

describe('isDesignComponentFile', () => {
  beforeEach(() => {
    projectFS.writeFile('app/page.tsx', '/* empty */');
    projectFS.writeFile('components/WithVariant.tsx', '');
    projectFS.writeFile('components/WithName.tsx', '');
    projectFS.writeFile('components/WithBoth.tsx', '');
    projectFS.writeFile('components/Plain.tsx', '');
  });

  it('returns true when component file has variantConfig', () => {
    projectFS.writeFile(
      'components/WithVariant.tsx',
      `'use client';\nconst variantConfig = [{ name: 'default' }];\nexport default function X() { return <div />; }`,
    );
    expect(isDesignComponentFile('components/WithVariant.tsx')).toBe(true);
  });

  it('returns true when component file has @name annotation', () => {
    projectFS.writeFile(
      'components/WithName.tsx',
      `'use client';\n/** @name "Hero" */\nexport default function X() { return <div />; }`,
    );
    expect(isDesignComponentFile('components/WithName.tsx')).toBe(true);
  });

  it('returns true when both variantConfig and @name are present', () => {
    projectFS.writeFile(
      'components/WithBoth.tsx',
      `'use client';\n/** @name "Card" */\nconst variantConfig = [{ name: 'default' }];\nexport default function X() { return <div />; }`,
    );
    expect(isDesignComponentFile('components/WithBoth.tsx')).toBe(true);
  });

  it('returns false for plain component file with neither annotation', () => {
    projectFS.writeFile(
      'components/Plain.tsx',
      `'use client';\nexport default function X() { return <div />; }`,
    );
    expect(isDesignComponentFile('components/Plain.tsx')).toBe(false);
  });

  it('returns false for non-component path even if it has variantConfig', () => {
    projectFS.writeFile(
      'app/page.tsx',
      `'use client';\nconst variantConfig = [{ name: 'default' }];\nexport default function X() { return <div />; }`,
    );
    expect(isDesignComponentFile('app/page.tsx')).toBe(false);
  });

  it('returns false for missing file', () => {
    expect(isDesignComponentFile('components/DoesNotExist.tsx')).toBe(false);
  });
});

// ─── 404 / not-found page ─────────────────────────────────────────────────

describe('NOT_FOUND_PATH', () => {
  it('points at the Next.js reserved file location', () => {
    // Hard-pin: changing this path silently would either (a) break the
    // panel row's existence check or (b) write the file somewhere
    // Next.js doesn't pick up. Either way the user wouldn't see a 404
    // at runtime. Pin the constant so any rename is intentional.
    expect(NOT_FOUND_PATH).toBe('app/not-found.tsx');
  });
});

describe('isNotFoundPage', () => {
  it('returns true for the canonical path', () => {
    expect(isNotFoundPage('app/not-found.tsx')).toBe(true);
  });

  it('returns false for regular pages', () => {
    expect(isNotFoundPage('app/page.tsx')).toBe(false);
    expect(isNotFoundPage('app/about/page.tsx')).toBe(false);
  });

  it('returns false for component / icon-set paths', () => {
    expect(isNotFoundPage('components/Card.tsx')).toBe(false);
    expect(isNotFoundPage('icons/Logo.tsx')).toBe(false);
  });

  it('does NOT match nested not-found.tsx files (route-group locals)', () => {
    // Next.js DOES support per-route-group not-found.tsx, but the
    // Revyme UX exposes only the project-wide one. A scaffold or
    // import that drops a `not-found.tsx` inside a route group should
    // NOT be picked up as the editable 404. Same goes for any future
    // file with `not-found` in its name.
    expect(isNotFoundPage('app/(marketing)/not-found.tsx')).toBe(false);
    expect(isNotFoundPage('app/dashboard/not-found.tsx')).toBe(false);
    expect(isNotFoundPage('not-found.tsx')).toBe(false);
  });
});

describe('notFoundExists / createNotFoundPageFile', () => {
  it('returns false on a fresh project', () => {
    expect(notFoundExists()).toBe(false);
  });

  it('createNotFoundPageFile writes the canonical path and returns it', () => {
    const path = createNotFoundPageFile();
    expect(path).toBe(NOT_FOUND_PATH);
    expect(notFoundExists()).toBe(true);
  });

  it('createNotFoundPageFile is a no-op when the file already exists (no clobber)', () => {
    createNotFoundPageFile();
    const original = projectFS.readFile(NOT_FOUND_PATH);
    // Mutate to detect clobber.
    projectFS.writeFile(NOT_FOUND_PATH, '/* user-edited */');
    const path = createNotFoundPageFile();
    expect(path).toBe(NOT_FOUND_PATH);
    expect(projectFS.readFile(NOT_FOUND_PATH)).toBe('/* user-edited */');
    expect(original).not.toBe('/* user-edited */');
  });

  it('scaffolds Next.js-compatible source ("use client" + default export)', () => {
    createNotFoundPageFile();
    const code = projectFS.readFile(NOT_FOUND_PATH) ?? '';
    // Must be client-side so the canvas can render it without RSC
    // boundary issues.
    expect(code).toContain("'use client'");
    // Default export named NotFound — Next.js routing accepts any
    // default export, but the conventional name aids debuggability.
    expect(code).toMatch(/export default function NotFound\b/);
  });

  it('scaffold has the expected data-id markers (root, title, subtitle, home-link)', () => {
    createNotFoundPageFile();
    const code = projectFS.readFile(NOT_FOUND_PATH) ?? '';
    // The Pages panel + Renderer rely on these for selection on first
    // paint. Drift = "click on the title doesn't select anything."
    for (const id of ['root', 'title', 'subtitle', 'home-link']) {
      expect(code).toContain(`data-id="${id}"`);
    }
  });

  it('scaffold includes a back-to-home link (`href="/"`)', () => {
    createNotFoundPageFile();
    const code = projectFS.readFile(NOT_FOUND_PATH) ?? '';
    expect(code).toMatch(/href="\/"/);
  });
});

describe('getFileDisplayName for 404', () => {
  it('returns "404" instead of "/not-found"', () => {
    // The naive app/-stripping would produce "/not-found", which reads
    // like a route. The user thinks of this page as "the 404 page"
    // not "/not-found".
    expect(getFileDisplayName(NOT_FOUND_PATH)).toBe('404');
  });
});

describe('createNotFoundPageFile parser roundtrip', () => {
  it('the scaffolded source produces a node map with all four data-ids', async () => {
    // Locks the scaffold against parser drift: if a future parser
    // change rejects the template (e.g. tighter style-object handling),
    // this test fails BEFORE the user creates a 404 and finds an empty
    // canvas.
    createNotFoundPageFile();
    const code = projectFS.readFile(NOT_FOUND_PATH) ?? '';
    const { parseJSXToNodes } = await import('@/code/parsing/parser');
    const nodes = parseJSXToNodes(code);
    const ids = new Set(nodes.keys());
    for (const expected of ['root', 'title', 'subtitle', 'home-link']) {
      expect(ids, `parser should produce node "${expected}"`).toContain(expected);
    }
  });
});

describe('listPageFiles excludes the 404', () => {
  it('does not include app/not-found.tsx in the navigable page list', () => {
    // Critical: LinkTool's page-picker + LivePreview's page list both
    // call listPageFiles(). The 404 has no slug — including it would
    // surface an unlinkable, slug-less entry in the page picker.
    createNotFoundPageFile();
    const pages = listPageFiles();
    expect(pages).not.toContain(NOT_FOUND_PATH);
  });

  it('still includes regular page.client.tsx files alongside an existing 404', () => {
    // Pages now ship as a pair — the canonical entry in listPageFiles
    // is the .client.tsx half (the canvas-editable body). The 404 is
    // a single file at app/not-found.tsx and must NOT bleed into this
    // list either way.
    projectFS.writeFile('app/about/page.client.tsx', 'export default function P() { return null; }');
    createNotFoundPageFile();
    const pages = listPageFiles();
    expect(pages).toContain('app/about/page.client.tsx');
  });
});

// ─── filePathToAbPagePath ───────────────────────────────────────────────────
// Regression: the A/B-test create handler used to strip only `.tsx`, leaving
// `page.client` (a dot) which the backend's PAGE_PATH_RX rejects. The result
// must never contain a character outside /^[a-z0-9/_-]+$/.
describe('filePathToAbPagePath', () => {
  const RX = /^[a-z0-9/_-]{1,255}$/; // mirrors backend PAGE_PATH_RX

  test('home page → "page" (both halves of the pair)', () => {
    expect(filePathToAbPagePath('app/page.client.tsx')).toBe('page');
    expect(filePathToAbPagePath('app/page.tsx')).toBe('page');
  });

  test('strips .client.tsx so there is no dot in the path', () => {
    expect(filePathToAbPagePath('app/advisors/page.client.tsx')).toBe('advisors/page');
  });

  test('strips route groups: app/(Body)/advisors/page.client.tsx → advisors/page', () => {
    expect(filePathToAbPagePath('app/(Body)/advisors/page.client.tsx')).toBe('advisors/page');
  });

  test('nested + grouped pages keep their slug segments', () => {
    expect(filePathToAbPagePath('app/(marketing)/blog/post/page.tsx')).toBe('blog/post/page');
    expect(filePathToAbPagePath('app/page-copy/page.tsx')).toBe('page-copy/page');
  });

  test('output always satisfies the backend page-path regex', () => {
    for (const f of [
      'app/page.client.tsx',
      'app/(Body)/advisors/page.client.tsx',
      'app/(marketing)/blog/[slug]/page.tsx'.replace('[slug]', 'slug'),
      'app/page-copy/page.tsx',
    ]) {
      expect(filePathToAbPagePath(f)).toMatch(RX);
    }
  });
});

// ─── A/B variant → parent page template resolution ───────────────────────────
// Bug: creating an A/B test forked the page into `_revyme/variants/…`, which is
// outside the `app/` route-group tree. The variant then lost its Template
// (header/footer + the Template tool) because route/layout resolution found
// nothing. A variant must resolve to its parent page for all template purposes.
describe('getVariantBasePage + variant-aware template resolution', () => {
  const PAGE = 'app/(Body)/advisors/page.client.tsx';
  const VARIANT = '_revyme/variants/test123/b.tsx';

  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile(PAGE, 'export default function P(){ return null; }');
    projectFS.writeFile('app/(Body)/layout.tsx', 'export default function L({children}){ return children; }');
    projectFS.writeFile('app/(Body)/LayoutClient.tsx', 'export default function LC({children}){ return children; }');
    projectFS.writeFile('_revyme/variants/test123/test.json', JSON.stringify({
      testId: 'test123', pagePath: PAGE, variants: [{ id: 'a' }, { id: 'b' }],
    }));
    projectFS.writeFile(VARIANT, 'export default function P(){ return null; }');
  });

  test('isVariantFile is a pure path check (no FS)', () => {
    expect(isVariantFile(VARIANT)).toBe(true);
    expect(isVariantFile('_revyme/variants/abc/test.json')).toBe(false);
    expect(isVariantFile(PAGE)).toBe(false);
    expect(isVariantFile('app/page.client.tsx')).toBe(false);
  });

  test('resolves a variant file to its parent page (from the manifest)', () => {
    expect(getVariantBasePage(VARIANT)).toBe(PAGE);
  });

  test('returns null for a normal page (not a variant)', () => {
    expect(getVariantBasePage(PAGE)).toBeNull();
    expect(getVariantBasePage('app/page.client.tsx')).toBeNull();
  });

  test('returns null when the manifest is missing or malformed', () => {
    expect(getVariantBasePage('_revyme/variants/ghost/b.tsx')).toBeNull();
    projectFS.writeFile('_revyme/variants/bad/test.json', '{ not json');
    expect(getVariantBasePage('_revyme/variants/bad/b.tsx')).toBeNull();
  });

  test('getRouteGroup reports the parent page Template for a variant', () => {
    expect(getRouteGroup(PAGE)).toBe('Body');
    expect(getRouteGroup(VARIANT)).toBe('Body'); // same as the page it tests
  });

  test('getLayoutForPage resolves a variant to its parent page layout', () => {
    expect(getLayoutForPage(PAGE)).toBe('app/(Body)/layout.tsx');
    expect(getLayoutForPage(VARIANT)).toBe('app/(Body)/layout.tsx');
  });
});

// ─── Per-variant Template override (design-tool parity: variant ≠ Control template) ─
describe('per-variant template override', () => {
  const PAGE = 'app/(Body)/page.client.tsx';
  const VARIANT = '_revyme/variants/t1/b.tsx';
  const MANIFEST = '_revyme/variants/t1/test.json';

  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile(PAGE, 'export default function P(){ return null; }');
    projectFS.writeFile('app/(Body)/layout.tsx', 'export default function L({children}){ return children; }');
    projectFS.writeFile('app/(Marketing)/layout.tsx', 'export default function L({children}){ return children; }');
    projectFS.writeFile(MANIFEST, JSON.stringify({
      testId: 't1', pagePath: PAGE, variants: [{ id: 'a' }, { id: 'b' }],
    }));
    projectFS.writeFile(VARIANT, 'export default function P(){ return null; }');
  });

  test('no override → inherits the Control template', () => {
    expect(getVariantTemplateOverride(VARIANT)).toBeUndefined();
    expect(getRouteGroup(VARIANT)).toBe('Body');
    expect(getLayoutForPage(VARIANT)).toBe('app/(Body)/layout.tsx');
  });

  test('override to a DIFFERENT template wins over the Control', () => {
    setVariantTemplate(VARIANT, 'Marketing');
    expect(getVariantTemplateOverride(VARIANT)).toBe('Marketing');
    expect(getRouteGroup(VARIANT)).toBe('Marketing');
    expect(getLayoutForPage(VARIANT)).toBe('app/(Marketing)/layout.tsx');
    // The Control page is untouched.
    expect(getRouteGroup(PAGE)).toBe('Body');
  });

  test('override to None → no template, even though the Control has one', () => {
    setVariantTemplate(VARIANT, '');
    expect(getVariantTemplateOverride(VARIANT)).toBe('');
    expect(getRouteGroup(VARIANT)).toBeNull();
    expect(getLayoutForPage(VARIANT)).toBeNull();
  });

  test('clearing the override (null) returns to inheriting the Control', () => {
    setVariantTemplate(VARIANT, 'Marketing');
    setVariantTemplate(VARIANT, null);
    expect(getVariantTemplateOverride(VARIANT)).toBeUndefined();
    expect(getRouteGroup(VARIANT)).toBe('Body'); // back to inherited
  });

  test('override to a template with no layout file → no layout (safe)', () => {
    setVariantTemplate(VARIANT, 'Ghost'); // no app/(Ghost)/layout.tsx exists
    expect(getRouteGroup(VARIANT)).toBe('Ghost');
    expect(getLayoutForPage(VARIANT)).toBeNull();
  });
});

// ─── getRouteGroup on a template's LayoutClient path ─────────────────────────
// Used by the Library panel to decide whether to navigate away after deleting
// a template (if the active file is inside that template's group, exit to the
// breadcrumb origin instead of stranding on the now-deleted LayoutClient).
describe('getRouteGroup on a LayoutClient/layout path', () => {
  beforeEach(() => resetProjectFS());

  test('resolves the template (route group) name', () => {
    expect(getRouteGroup('app/(bd2)/LayoutClient.tsx')).toBe('bd2');
    expect(getRouteGroup('app/(bd2)/layout.tsx')).toBe('bd2');
  });

  test('a page inside the group still resolves to it; root files do not', () => {
    expect(getRouteGroup('app/(bd2)/about/page.client.tsx')).toBe('bd2');
    expect(getRouteGroup('app/layout.tsx')).toBeNull();
    expect(getRouteGroup('app/page.client.tsx')).toBeNull();
  });
});

// ─── uniqueRouteSlug ────────────────────────────────────────────────────────

describe('uniqueRouteSlug', () => {
  it('returns the base slug unchanged when no page exists', () => {
    expect(uniqueRouteSlug('blog')).toBe('blog');
  });

  it('bumps to -2 when the slug is taken by a BARE page', () => {
    projectFS.writeFile('app/blog/page.client.tsx', 'export default function P(){return <div/>;}');
    expect(uniqueRouteSlug('blog')).toBe('blog-2');
  });

  it('detects a page that lives in a ROUTE GROUP (the /blog-in-(Body) bug)', () => {
    // The duplicate-page bug: a bare `app/blog/…` existence check misses this.
    projectFS.writeFile('app/(Body)/blog/page.client.tsx', 'export default function P(){return <div/>;}');
    expect(uniqueRouteSlug('blog')).toBe('blog-2');
  });

  it('keeps incrementing past taken numbered slugs', () => {
    projectFS.writeFile('app/(Body)/blog/page.client.tsx', 'export default function P(){return <div/>;}');
    projectFS.writeFile('app/blog-2/page.client.tsx', 'export default function P(){return <div/>;}');
    expect(uniqueRouteSlug('blog')).toBe('blog-3');
  });

  it('routeSuffix checks a deeper route — detail page `/blog/[slug]`', () => {
    projectFS.writeFile('app/(Body)/blog/[slug]/page.client.tsx', 'export default function P(){return <div/>;}');
    // The bare /blog index is free, but the detail route is taken → bump folder.
    expect(uniqueRouteSlug('blog', '/[slug]')).toBe('blog-2');
    expect(uniqueRouteSlug('blog')).toBe('blog'); // index slug still free
  });
});

// ─── activeCodeAtom same-content guard ──────────────────────────────────────

describe('activeCodeAtom — identical-content writes are no-ops', () => {
  it('skips the ProjectFS write and version bump when content is unchanged', async () => {
    const { createStore } = await import('jotai');
    const { activeCodeAtom, activeFilePathAtom } = await import('./active-file-store');
    const { projectVersionAtom } = await import('./project-fs');
    const store = createStore();
    projectFS.writeFile('app/page.client.tsx', 'const A = 1;');
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    const v0 = store.get(projectVersionAtom);

    // Same content (different string instance, equal value) → no bump.
    store.set(activeCodeAtom, 'const A' + ' = 1;');
    expect(store.get(projectVersionAtom)).toBe(v0);

    // Changed content → write + bump.
    store.set(activeCodeAtom, 'const A = 2;');
    expect(store.get(projectVersionAtom)).toBe(v0 + 1);
    expect(projectFS.readFile('app/page.client.tsx')).toBe('const A = 2;');
  });
});
