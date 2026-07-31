import { describe, test, expect, beforeEach } from 'vitest';
import { createPageFile, getPageSlug, movePageFile, createRouteGroup, getRouteGroup, listRouteGroups } from './active-file-store';
import { projectFS, resetProjectFS } from './project-fs';

beforeEach(() => {
  resetProjectFS();
});

describe('pages-store', () => {
  test('createPageFile creates a page in ProjectFS', () => {
    const filePath = createPageFile('Test Page');
    expect(projectFS.exists(filePath)).toBe(true);
    const code = projectFS.readFile(filePath)!;
    expect(code).toContain('data-id="root"');
    expect(code).toContain('Test Page');
    // Cleanup
    projectFS.deleteFile(filePath);
  });

  test('createPageFile generates unique file paths', () => {
    const path1 = createPageFile('Page A');
    const path2 = createPageFile('Page B');
    expect(path1).not.toBe(path2);
    // Cleanup
    projectFS.deleteFile(path1);
    projectFS.deleteFile(path2);
  });

  test('createPageFile code has root element with position', () => {
    const filePath = createPageFile('My Page');
    const code = projectFS.readFile(filePath)!;
    expect(code).toContain('data-name=');
    expect(code).toContain("position: 'relative'");
    expect(code).toContain("width: '100%'");
    expect(code).toContain('/** @canvas');
    // Cleanup
    projectFS.deleteFile(filePath);
  });

  test('getPageSlug returns URL-safe slug', () => {
    expect(getPageSlug('app/page.tsx')).toBe('/');
    expect(getPageSlug('app/about/page.tsx')).toBe('/about');
    expect(getPageSlug('app/my-page/page.tsx')).toBe('/my-page');
  });
});

describe('movePageFile', () => {
  // Pages are now a PAIR (`page.tsx` server wrapper + `page.client.tsx`
  // canvas body). `createPageFile` returns the .client.tsx half;
  // `movePageFile` moves both halves atomically.

  test('moves a page to a new path', () => {
    const path = createPageFile('Team');
    movePageFile(path, 'app/about/team/page.client.tsx');
    expect(projectFS.exists('app/about/team/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/about/team/page.tsx')).toBe(true);
    expect(projectFS.exists(path)).toBe(false);
  });

  test('preserves file content on move', () => {
    const path = createPageFile('Team');
    const content = projectFS.readFile(path);
    movePageFile(path, 'app/about/team/page.client.tsx');
    expect(projectFS.readFile('app/about/team/page.client.tsx')).toBe(content);
  });

  test('no-op when paths are the same', () => {
    const path = createPageFile('Team');
    movePageFile(path, path);
    expect(projectFS.exists(path)).toBe(true);
  });
});

describe('createRouteGroup', () => {
  test('creates group with layout files', () => {
    createRouteGroup('marketing');
    expect(projectFS.exists('app/(marketing)/layout.tsx')).toBe(true);
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(true);
  });

  test('creates group without layout when withLayout=false', () => {
    createRouteGroup('bare', false);
    expect(projectFS.exists('app/(bare)/layout.tsx')).toBe(false);
  });

  test('LayoutClient has @canvas block', () => {
    createRouteGroup('dashboard');
    const code = projectFS.readFile('app/(dashboard)/LayoutClient.tsx')!;
    expect(code).toContain('/** @canvas');
    expect(code).toContain('LayoutClient');
  });
});

describe('getRouteGroup', () => {
  test('extracts group from path', () => {
    expect(getRouteGroup('app/(marketing)/about/page.tsx')).toBe('marketing');
    expect(getRouteGroup('app/(dashboard)/settings/page.tsx')).toBe('dashboard');
  });

  test('returns null for ungrouped paths', () => {
    expect(getRouteGroup('app/contact/page.tsx')).toBeNull();
    expect(getRouteGroup('app/page.tsx')).toBeNull();
  });
});

describe('listRouteGroups', () => {
  test('lists all groups', () => {
    createRouteGroup('marketing');
    createRouteGroup('dashboard');
    const groups = listRouteGroups();
    expect(groups).toContain('marketing');
    expect(groups).toContain('dashboard');
  });
});

describe('getPageSlug with groups', () => {
  test('strips route group from slug', () => {
    expect(getPageSlug('app/(marketing)/about/page.tsx')).toBe('/about');
    expect(getPageSlug('app/(dashboard)/settings/page.tsx')).toBe('/settings');
  });
});

describe('movePageFile — template-boundary root normalization', () => {
  const STYLED_PAGE = `'use client';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{
    overflowX: 'hidden',
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'center',
    flexDirection: 'column',
    position: 'relative',
    width: '100%',
    height: 'auto',
    backgroundColor: '#ffffff'
  }}>
    <div data-id="hero" data-name="Hero" style={{ position: 'relative', width: '100%', height: 'auto' }}></div>
  </div>;
}`;

  function seedPage(path: string) {
    projectFS.writeFile(path, STYLED_PAGE);
    projectFS.writeFile(path.replace('page.client.tsx', 'page.tsx'),
      `import Page from './page.client';\nexport default Page;`);
  }

  test('moving INTO a template strips the root shell (overflowX/background gone, flex kept)', () => {
    createRouteGroup('body', true); // template: has a LayoutClient
    seedPage('app/about/page.client.tsx');
    movePageFile('app/about/page.client.tsx', 'app/(body)/about/page.client.tsx');
    const code = projectFS.readFile('app/(body)/about/page.client.tsx')!;
    expect(code).not.toMatch(/overflowX/);
    expect(code).not.toMatch(/backgroundColor/);
    expect(code).toMatch(/flexDirection: 'column'/);
    expect(code).toMatch(/data-id="hero"/);
  });

  test('moving OUT of a template restores the standalone shell with overflowX clip', () => {
    createRouteGroup('body', true);
    seedPage('app/(body)/about/page.client.tsx');
    movePageFile('app/(body)/about/page.client.tsx', 'app/about/page.client.tsx');
    const code = projectFS.readFile('app/about/page.client.tsx')!;
    expect(code).toMatch(/overflowX: 'clip'/);
    expect(code).not.toMatch(/overflowX: 'hidden'/);
    expect(code).toMatch(/backgroundColor: '#ffffff'/);
  });

  test('moving between NON-template locations leaves the root untouched', () => {
    createRouteGroup('org', false); // organisational group: no LayoutClient
    seedPage('app/about/page.client.tsx');
    movePageFile('app/about/page.client.tsx', 'app/(org)/about/page.client.tsx');
    const code = projectFS.readFile('app/(org)/about/page.client.tsx')!;
    expect(code).toMatch(/overflowX: 'hidden'/); // unchanged — no template boundary crossed
    expect(code).toMatch(/backgroundColor: '#ffffff'/);
  });
});
