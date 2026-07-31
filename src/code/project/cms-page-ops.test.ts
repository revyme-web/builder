// cms-page-ops.test.ts — Tests for CMS page-pair creation.
//
// CMS index/detail pages must emit a server + client pair (`page.tsx` +
// `page.client.tsx`) like hand-made pages — otherwise the page-pair
// helpers (PageSelector, delete/move, duplicate-detection) can't resolve
// them. These tests lock that contract.

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// In-memory FS — declared via vi.hoisted so it exists before the hoisted
// vi.mock factory runs (see cms-ops.test.ts for the rationale).
const fsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('./project-fs', () => ({
  projectFS: {
    writeFile: vi.fn((path: string, content: string) => { fsStore.set(path, content); }),
    readFile: vi.fn((path: string) => fsStore.get(path) ?? null),
    exists: vi.fn((path: string) => fsStore.has(path)),
    // slugToFilePath/uniqueRouteSlug are route-group aware now: they scan
    // `app/(group)/<path>` locations via projectFS.listFiles('app/')
    // (active-file-store.ts), so the mock must provide it.
    listFiles: vi.fn((dir: string = '') => {
      const prefix = dir && !dir.endsWith('/') ? `${dir}/` : dir;
      return [...fsStore.keys()].filter((p) => !prefix || p.startsWith(prefix)).sort();
    }),
  },
}));

vi.mock('./cms-ops', () => ({
  getCollectionSchema: vi.fn(() => ({
    name: 'Blog',
    slug: 'blog',
    fields: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'body', name: 'Body', type: 'richtext' },
      // A hyphenated id simulates a collection from before field ids were
      // made identifier-safe — page-gen must bracket-access it.
      { id: 'cover-image', name: 'Cover Image', type: 'image' },
    ],
  })),
}));

import { createCmsIndexPageFile, createCmsDetailPageFile, parseCmsPageMeta, findCmsPageFile } from './cms-page-ops';

beforeEach(() => { fsStore.clear(); vi.clearAllMocks(); });

// ── Index page ──────────────────────────────────────────────────────────────

describe('createCmsIndexPageFile', () => {
  test('emits a server + client page pair', () => {
    const ret = createCmsIndexPageFile('blog');
    expect(ret).toBe('app/blog/page.client.tsx');
    expect(fsStore.has('app/blog/page.tsx')).toBe(true);
    expect(fsStore.has('app/blog/page.client.tsx')).toBe(true);
  });

  test('server wrapper re-exports the client body, no use-client', () => {
    createCmsIndexPageFile('blog');
    const server = fsStore.get('app/blog/page.tsx')!;
    expect(server).toContain("import PageClient from './page.client'");
    expect(server).toContain('export const metadata');
    expect(server).not.toContain("'use client'");
  });

  test('client body is the canvas-editable half', () => {
    createCmsIndexPageFile('blog');
    const client = fsStore.get('app/blog/page.client.tsx')!;
    expect(client.startsWith("'use client'")).toBe(true);
    expect(client).toContain('@canvas');
    expect(client).toContain("from '@/cms/blog.json'");
  });

  test('each card is a next/link to the detail route via the item slug', () => {
    createCmsIndexPageFile('blog');
    const client = fsStore.get('app/blog/page.client.tsx')!;
    // The card is a Next.js <Link> whose href resolves the current item.
    expect(client).toContain("import Link from 'next/link'");
    expect(client).toContain('<Link data-id="card"');
    // Row links carry the data-cms-nav marker + the SAFE optional-slug form
    // (matches the generator's cmsNavHrefExpr; oracle CMS_NAV_LINK_MISSING_MARKER).
    expect(client).toContain('data-cms-nav="row"');
    expect(client).toContain("href={`/blog/${item?._slug ?? ''}`}");
  });
});

// ── Detail page ─────────────────────────────────────────────────────────────

describe('createCmsDetailPageFile', () => {
  test('emits a server + client page pair under [slug]', () => {
    const ret = createCmsDetailPageFile('blog');
    expect(ret).toBe('app/blog/[slug]/page.client.tsx');
    expect(fsStore.has('app/blog/[slug]/page.tsx')).toBe(true);
    expect(fsStore.has('app/blog/[slug]/page.client.tsx')).toBe(true);
  });

  test('server wrapper carries no use-client / canvas / cmsPage', () => {
    createCmsDetailPageFile('blog');
    const server = fsStore.get('app/blog/[slug]/page.tsx')!;
    expect(server).toContain("import PageClient from './page.client'");
    expect(server).not.toContain("'use client'");
    expect(server).not.toContain('@cmsPage');
  });

  test('the @cmsPage annotation lives in the client file and resolves', () => {
    createCmsDetailPageFile('blog');
    const client = fsStore.get('app/blog/[slug]/page.client.tsx')!;
    expect(client.startsWith("'use client'")).toBe(true);
    expect(client).toContain('@cmsPage');
    expect(client).toContain('useParams');
    // The editor parses the client file — its annotation must resolve.
    expect(parseCmsPageMeta(client)).toEqual({ collection: 'blog', kind: 'detail' });
  });

  // Two detail URLs resolve to the SAME component, so React reconciles in place and the
  // entrance animations never replay on next/prev. Keying the root by the slug makes each
  // record a fresh subtree. Live find 2026-07-30.
  test('the root is keyed by the slug so next/prev remounts and replays animations', () => {
    createCmsDetailPageFile('blog');
    const client = fsStore.get('app/blog/[slug]/page.client.tsx')!;
    expect(client).toContain(`key={String(params?.slug ?? '')}`);
    // the key sits on the page's OWN root — never on a layout, which would remount the
    // header (resetting its variant state) and PageTransitions (orphaning finishRef).
    expect(client).toMatch(/<div data-id="root" key=\{String\(params\?\.slug \?\? ''\)\}/);
  });

  test('a digit in the slug yields a valid import identifier', () => {
    createCmsDetailPageFile('collection-2');
    const client = fsStore.get('app/collection-2/[slug]/page.client.tsx')!;
    // `import collection-2` is a syntax error — the var name must be a
    // valid identifier while the JSON path keeps the kebab-case slug.
    expect(client).toContain("import collection2 from '@/cms/collection-2.json'");
    expect(client).not.toContain('import collection-2 ');
    expect(client).toContain('collection2.find(');
  });

  test('a hyphenated (legacy) field id uses bracket access, not dot', () => {
    createCmsDetailPageFile('blog');
    const client = fsStore.get('app/blog/[slug]/page.client.tsx')!;
    // `item.cover-image` is a syntax error; identifier ids stay dot-access.
    expect(client).toContain('item["cover-image"]');
    expect(client).not.toContain('item.cover-image');
    expect(client).toContain('item.title');
  });
});

// ─── findCmsPageFile — locate an existing CMS page wherever it lives ─────────
// The "New CMS Page" menu greyed entries via a bare `app/<slug>/…` probe, so a
// detail page a Template had moved into a route group
// (`app/(Body)/collection-1/[slug]/page.client.tsx`) stayed offered forever
// (user report 2026-07-28).
describe('findCmsPageFile', () => {
  const DETAIL_IN_GROUP = `'use client';

/** @cmsPage {
  "collection": "collection-1",
  "kind": "detail"
} */

export default function Page() { return <div data-id="root" />; }`;

  test('finds a detail page inside a route group via its annotation', () => {
    fsStore.set('app/(Body)/collection-1/[slug]/page.client.tsx', DETAIL_IN_GROUP);
    expect(findCmsPageFile('collection-1', 'detail')).toBe('app/(Body)/collection-1/[slug]/page.client.tsx');
    // …and its absence for the other kind / another collection stays null.
    expect(findCmsPageFile('collection-1', 'index')).toBeNull();
    expect(findCmsPageFile('collection-2', 'detail')).toBeNull();
  });

  test('finds a detail page in a BUMPED route folder via its annotation', () => {
    fsStore.set('app/collection-1-2/[slug]/page.client.tsx', DETAIL_IN_GROUP);
    expect(findCmsPageFile('collection-1', 'detail')).toBe('app/collection-1-2/[slug]/page.client.tsx');
  });

  test('falls back to the route-group-aware route probe for annotation-less index pages', () => {
    fsStore.set('app/(Body)/collection-1/page.client.tsx', `'use client';
export default function Page() { return <div data-id="root" />; }`);
    expect(findCmsPageFile('collection-1', 'index')).toBe('app/(Body)/collection-1/page.client.tsx');
  });

  test('null when nothing exists', () => {
    expect(findCmsPageFile('collection-1', 'detail')).toBeNull();
    expect(findCmsPageFile('collection-1', 'index')).toBeNull();
  });

  test('createCmsDetailPageFile returns the EXISTING detail page instead of scaffolding a second route', () => {
    fsStore.set('app/(Body)/collection-1/[slug]/page.client.tsx', DETAIL_IN_GROUP);
    const before = new Set(fsStore.keys());
    const path = createCmsDetailPageFile('collection-1');
    expect(path).toBe('app/(Body)/collection-1/[slug]/page.client.tsx');
    expect(new Set(fsStore.keys())).toEqual(before); // nothing new created
  });
});
