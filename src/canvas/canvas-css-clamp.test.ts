// @vitest-environment jsdom
// EMPIRICAL PIN — live find 2026-07-13: a per-viewport `font-size:
// clamp(40px, 11.6vw, 163px) !important` @media override (template footer
// wordmark) rendered at the clamp MAX on every canvas tile. The canvas
// @media→@container transform kept the raw vw, native CSS resolved it
// against the iframe window, and the !important rule beat patchElement's
// correctly-resolved inline merge. The injected canvas CSS must carry the
// vw pre-resolved per matching tile width.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

const PAGE = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <style>{\`
      @media (max-width: 375px) {
        [data-id="brand"] { font-size: clamp(40px, 11.6vw, 163px) !important; }
      }
      @media (max-width: 1199px) {
        [data-id="brand"] { letter-spacing: 1vw !important; }
      }
      \`}</style>
      <p data-id="brand" style={{ position: 'relative', margin: '0px', fontSize: '163px' }}>HUMANIZED</p>
    </div>
  );
}`;

describe('canvas CSS clamp/vw resolution', () => {
  it('injected @container blocks carry per-tile-resolved px instead of raw vw', () => {
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const container = document.createElement('div');
    container.setAttribute('data-content-root', 'true');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true },
      { id: 'tablet', width: 768, x: 1540, y: 0 },
      { id: 'mobile', width: 375, x: 2408, y: 0 },
    ] as any;

    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);

    const styleEl = document.querySelector('[data-canvas-styles]') as HTMLStyleElement;
    expect(styleEl).toBeTruthy();
    const css = styleEl.textContent || '';

    // Mobile-only clamp: resolved at 375 (11.6vw → 43.5px), no raw vw left.
    expect(css).toContain('clamp(40px, 43.5px, 163px)');
    // Multi-tile block: one exact-width copy per matching tile.
    expect(css).toContain('@container (min-width: 375px) and (max-width: 375px)');
    expect(css).toContain('@container (min-width: 768px) and (max-width: 768px)');
    expect(css).toContain('letter-spacing: 3.75px');
    expect(css).toContain('letter-spacing: 7.68px');
    expect(css).not.toMatch(/[\d.]vw/);
  });
});
