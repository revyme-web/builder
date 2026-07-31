// @vitest-environment jsdom
// EMPIRICAL REPRO: a TEMPLATE's @media override (LayoutClient <style>:
// `[data-id="footer-nav"] { flex-wrap: wrap !important }`) on a TEMPLATED
// PAGE's replica tile. The merge renames template nodes to `layout::<id>` and
// the Renderer rewrites the layout CSS selectors to match — the reported bug
// (2026-07-13): the template's own artboard wraps the footer nav, the LIVE
// site wraps it, but the templated page's mobile/tablet tile renders it
// unwrapped (overflowing). Real parser + real renderNodes.
import { describe, it, expect, vi } from 'vitest';

const LAYOUT_CODE = `'use client';
import React from 'react';

export default function LayoutClient({ children }) {
  return <div data-id="root" data-name="Template" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: '#000000' }}>
  <style>{\`
    @media (max-width: 1199px) {
      [data-id="footer-nav"] { flex-wrap: wrap !important; gap: 18px !important; }
    }
  \`}</style>
      {children}
      <div data-id="site-footer" data-name="Footer" style={{ position: 'relative', order: '2', flex: '0 0 auto', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div data-id="footer-nav" data-name="Nav" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row', gap: '28px' }}>
          <p data-id="fn-a" data-name="A" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: 'auto', height: 'auto', margin: '0px' }}>Home</p>
          <p data-id="fn-b" data-name="B" style={{ position: 'relative', order: '1', flex: '0 0 auto', width: 'auto', height: 'auto', margin: '0px' }}>Works</p>
        </div>
      </div>
  </div>;
}
`;

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: (p: string) => {
      if (p === 'app/(Site)/LayoutClient.tsx') return LAYOUT_CODE;
      return '';
    },
    listFiles: () => [], exists: (p: string) => p === 'app/(Site)/layout.tsx',
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';
import { setStyleContext } from '@/canvas/node-ops';

// The PAGE source (what codeAtom holds for the active page).
const PAGE_CODE = `'use client';
import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <div data-id="sec-1" data-name="Section" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%', height: '50px' }}></div>
  </div>;
}
`;

// The MERGED node tree the store produces for a templated page: template root
// takes over the page root id, template nodes are layout::-prefixed + locked,
// page sections spliced in as siblings.
const MERGED_CODE = `'use client';
import React from 'react';

export default function Merged() {
  return <div data-id="root" data-name="Template" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: '#000000' }}>
    <div data-id="sec-1" data-name="Section" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '50px' }}></div>
    <div data-id="layout::site-footer" data-name="Footer" style={{ position: 'relative', order: '2', flex: '0 0 auto', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div data-id="layout::footer-nav" data-name="Nav" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row', gap: '28px' }}>
        <p data-id="layout::fn-a" data-name="A" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: 'auto', height: 'auto', margin: '0px' }}>Home</p>
        <p data-id="layout::fn-b" data-name="B" style={{ position: 'relative', order: '1', flex: '0 0 auto', width: 'auto', height: 'auto', margin: '0px' }}>Works</p>
      </div>
    </div>
  </div>;
}
`;

function mergedNodes() {
  const nodes = parseJSXToNodes(MERGED_CODE);
  for (const [id, n] of nodes) {
    if (id.startsWith('layout::')) {
      (n as any).fromLayout = true;
      (n as any).locked = true;
    }
  }
  return nodes;
}

describe('template @media overrides on a templated page replica', () => {
  it('SANDBOX path: pushed layout CSS applies (fs is stubbed in the iframe)', async () => {
    // In the real canvas, renderNodes runs in the sandbox where projectFS is a
    // stub — the fs fallback below reads nothing. The parent ships the
    // prefixed layout CSS via the render command (setPushedLayoutCss); this
    // locks that path: NO fs, only the pushed value.
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const { setPushedLayoutCss } = await import('@/canvas/renderer/responsive');
    setStyleContext('app/(Missing)/page.client.tsx', 'desktop', 1440);   // fs path resolves nothing
    setPushedLayoutCss(`
    @media (max-width: 1199px) {
      [data-id="layout::footer-nav"] { flex-wrap: wrap !important; gap: 18px !important; }
    }`);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true },
      { id: 'mobile', width: 375, x: 1600, y: 0 },
    ] as any;
    try {
      renderNodes(container, mergedNodes(), null, () => {}, viewports, PAGE_CODE);
      const mobileNav = container.querySelector('[data-node-id="mobile-layout::footer-nav"]') as HTMLElement | null;
      expect(mobileNav).toBeTruthy();
      expect(mobileNav!.style.flexWrap).toBe('wrap');
      expect(mobileNav!.style.gap).toBe('18px');
    } finally {
      setPushedLayoutCss(null);   // don't leak into the fs-fallback test
      container.remove();
    }
  });

  it('mobile tile applies the layout-prefixed flex-wrap override', async () => {
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    setStyleContext('app/(Site)/page.client.tsx', 'desktop', 1440);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true },
      { id: 'mobile', width: 375, x: 1600, y: 0 },
    ] as any;
    renderNodes(container, mergedNodes(), null, () => {}, viewports, PAGE_CODE);

    const { getResponsiveOverridesForNode } = await import('@/canvas/renderer/responsive');
    console.log('POST-RENDER resolve:', JSON.stringify(getResponsiveOverridesForNode('layout::footer-nav', 375)));
    const styleEl = container.querySelector('[data-canvas-styles]');
    console.log('canvas css has layout::footer-nav:', (styleEl?.textContent || '').includes('layout::footer-nav'));

    const mobileNav = container.querySelector('[data-node-id="mobile-layout::footer-nav"]') as HTMLElement | null;
    const primaryNav = container.querySelector('[data-node-id="layout::footer-nav"]') as HTMLElement | null;
    console.log('MOBILE flexWrap:', JSON.stringify(mobileNav?.style.flexWrap), '| gap:', JSON.stringify(mobileNav?.style.gap));
    console.log('PRIMARY flexWrap:', JSON.stringify(primaryNav?.style.flexWrap), '| gap:', JSON.stringify(primaryNav?.style.gap));
    expect(mobileNav).toBeTruthy();
    // Mobile (375 ≤ 1199) must get the template's responsive override.
    expect(mobileNav!.style.flexWrap).toBe('wrap');
    expect(mobileNav!.style.gap).toBe('18px');
    // Primary (1440 > 1199) must NOT.
    expect(primaryNav!.style.flexWrap).toBe('');
  });
});
