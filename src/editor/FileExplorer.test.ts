import { describe, test, expect, beforeEach } from 'vitest';
import { buildPageTree, extractSlug } from './FileExplorer';
import { createPageFile, createRouteGroup } from '../code/project/active-file-store';
import { projectFS, resetProjectFS } from '../code/project/project-fs';

beforeEach(() => {
  resetProjectFS();
});

// ─── buildPageTree ──────────────────────────────────────────────────────────

describe('buildPageTree', () => {
  test('returns home page at root level', () => {
    const tree = buildPageTree(0);
    const homePage = tree.find(e => e.isHome);
    expect(homePage).toBeDefined();
    // Home renders as 'Home' (standard), not '/' — matches the
    // human-readable label used in the Pages panel.
    expect(homePage!.label).toBe('Home');
    expect(homePage!.type).toBe('page');
    expect(homePage!.depth).toBe(0);
    expect(homePage!.group).toBeNull();
  });

  test('home page is always first', () => {
    createPageFile('About');
    createPageFile('Contact');
    const tree = buildPageTree(0);
    const pages = tree.filter(e => e.type === 'page');
    expect(pages[0].isHome).toBe(true);
  });

  test('includes additional pages at root level', () => {
    createPageFile('About');
    const tree = buildPageTree(0);
    const aboutEntry = tree.find(e => e.type === 'page' && e.label === '/about');
    expect(aboutEntry).toBeDefined();
    expect(aboutEntry!.depth).toBe(0);
    expect(aboutEntry!.group).toBeNull();
  });

  test('does NOT include any layout entries — layouts live elsewhere', () => {
    // Layout files (root or per-template) used to render in the Pages
    // panel; that's been moved out — the panel is pages-only. Editing a
    // template's LayoutClient happens via the right-panel Template
    // picker's Edit button.
    const tree = buildPageTree(0);
    expect(tree.find(e => e.type === 'layout')).toBeUndefined();
  });

  test('templated pages surface FLAT — no group wrapper in the tree', () => {
    // createRouteGroup with a layout = a Template. Templates are an
    // attribute of a page, not a parent in the panel — pages inside
    // them appear at root level just like bare pages.
    createRouteGroup('marketing');
    // Page-pair migration: buildPageTree keys off the .client.tsx half.
    projectFS.writeFile('app/(marketing)/landing/page.client.tsx', '"use client"; export default function Page() { return <div>Landing</div>; }');
    const tree = buildPageTree(0);
    // No group entry for the template
    expect(tree.find(e => e.type === 'group' && e.group === 'marketing')).toBeUndefined();
    // The templated page sits at root level
    const landing = tree.find(e => e.type === 'page' && e.label === '/landing');
    expect(landing).toBeDefined();
    expect(landing!.depth).toBe(0);
    expect(landing!.group).toBe('marketing');
  });

  test('plain route groups (no layout) DO render as folders', () => {
    // Organisational groups (no LayoutClient) keep their group entry —
    // the user explicitly created the folder for organisation, so we
    // honour that. Only Templates flatten.
    createRouteGroup('archive', false);
    // Page-pair migration: buildPageTree keys off the .client.tsx half.
    projectFS.writeFile('app/(archive)/old/page.client.tsx', '"use client"; export default function Page() { return <div>Old</div>; }');
    const tree = buildPageTree(0);
    const group = tree.find(e => e.type === 'group' && e.group === 'archive');
    expect(group).toBeDefined();
    expect(group!.label).toBe('(archive)');
    expect(group!.isTemplate).toBe(false);
    // Pages inside surface as that group's children, not at root.
    const oldPage = group!.children.find(e => e.type === 'page' && e.label === '/old');
    expect(oldPage).toBeDefined();
    expect(oldPage!.depth).toBe(1);
  });

  test('templated pages nest by path (/landing/team under /landing)', () => {
    createRouteGroup('marketing');
    // Use a slug that doesn't collide with the starter's `(default)/about`.
    // Page-pair migration: buildPageTree keys off the .client.tsx half.
    projectFS.writeFile('app/(marketing)/landing/page.client.tsx', '"use client"; export default function Page() { return <div>Landing</div>; }');
    projectFS.writeFile('app/(marketing)/landing/team/page.client.tsx', '"use client"; export default function Page() { return <div>Team</div>; }');
    const tree = buildPageTree(0);
    const landing = tree.find(e => e.type === 'page' && e.label === '/landing');
    expect(landing).toBeDefined();
    const team = landing!.children.find(e => e.type === 'page' && e.label === '/team');
    expect(team).toBeDefined();
    expect(team!.depth).toBe(1);
  });

  test('multiple plain route groups are sorted alphabetically', () => {
    createRouteGroup('aa-archive', false);
    createRouteGroup('zz-archive', false);
    projectFS.writeFile('app/(aa-archive)/x/page.tsx', '/* x */');
    projectFS.writeFile('app/(zz-archive)/y/page.tsx', '/* y */');
    const tree = buildPageTree(0);
    const groups = tree.filter(e => e.type === 'group');
    expect(groups.length).toBe(2);
    expect(groups[0].label).toBe('(aa-archive)');
    expect(groups[1].label).toBe('(zz-archive)');
  });

  test('sort order: home first, then everything alphabetical', () => {
    createRouteGroup('marketing');
    createPageFile('About');
    const tree = buildPageTree(0);
    // Home should always be first.
    expect(tree[0].isHome).toBe(true);
    // No `'layout'`-typed entries surface in the tree any more — layouts
    // are accessed via the Template picker / Library, not the page tree.
    expect(tree.every(e => e.type !== 'layout')).toBe(true);
  });
});

// ─── extractSlug ────────────────────────────────────────────────────────────

describe('extractSlug', () => {
  test('extracts slug from simple page path', () => {
    expect(extractSlug('app/about/page.tsx')).toBe('about');
  });

  test('returns empty for home page', () => {
    expect(extractSlug('app/page.tsx')).toBe('');
  });

  test('extracts slug from grouped page path', () => {
    expect(extractSlug('app/(marketing)/about/page.tsx')).toBe('about');
  });

  test('handles nested slugs', () => {
    expect(extractSlug('app/blog/posts/page.tsx')).toBe('blog/posts');
  });

  test('handles nested slugs inside groups', () => {
    expect(extractSlug('app/(marketing)/blog/posts/page.tsx')).toBe('blog/posts');
  });
});
