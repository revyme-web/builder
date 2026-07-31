import { describe, it, expect } from 'vitest';
import { normalizePageRootShell, TEMPLATED_PAGE_ROOT_STYLE } from './page-root-shell';

// The home page's real pre-fix root shape: shell props (overflowX/background) that COLLIDE
// with the template root once the page moves into a route group — dropped on the canvas,
// but live the `overflowX: 'hidden'` computed to `overflow-y: auto` and the root became a
// nested scroll container (double-scrollbar, 2026-07-28).
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

describe('normalizePageRootShell', () => {
  it('templated: strips shell props (overflow, background, justifyContent) but keeps the flex column', () => {
    const out = normalizePageRootShell(STYLED_PAGE, 'templated');
    expect(out).not.toMatch(/overflowX/);
    expect(out).not.toMatch(/backgroundColor/);
    expect(out).not.toMatch(/justifyContent/);
    // The bare canonical survives — the page still stacks its own sections.
    expect(out).toMatch(/display: 'flex'/);
    expect(out).toMatch(/flexDirection: 'column'/);
    expect(out).toMatch(/alignItems: 'center'/);
    expect(out).toMatch(/position: 'relative'/);
    expect(out).toMatch(/width: '100%'/);
    // Children untouched.
    expect(out).toMatch(/data-id="hero"/);
  });

  it('standalone: restores the shell with overflowX clip (never hidden) + background', () => {
    const bare = normalizePageRootShell(STYLED_PAGE, 'templated');
    const out = normalizePageRootShell(bare, 'standalone');
    expect(out).toMatch(/overflowX: 'clip'/);
    expect(out).not.toMatch(/overflowX: 'hidden'/);
    expect(out).toMatch(/backgroundColor: '#ffffff'/);
    expect(out).toMatch(/flexDirection: 'column'/);
  });

  it('is a no-op when the root is already the bare canonical', () => {
    const bare = normalizePageRootShell(STYLED_PAGE, 'templated');
    expect(normalizePageRootShell(bare, 'templated')).toBe(bare);
  });

  it('unparsable code returns unchanged', () => {
    expect(normalizePageRootShell('not jsx at all {{{', 'templated')).toBe('not jsx at all {{{');
  });

  it('the templated canonical matches the oracle bare-root contract', () => {
    expect(TEMPLATED_PAGE_ROOT_STYLE).toEqual({
      position: 'relative', width: '100%', height: 'auto',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    });
  });
});
