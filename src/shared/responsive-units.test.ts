// responsive-units.test.ts — Coverage for the per-viewport vw/vh resolver.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveResponsiveUnits,
  getResponsiveVpWidth,
  resolveResponsiveStyles,
  resolveContainerQueryUnits,
  simulatedVpHeight,
  FALLBACK_VP_WIDTH,
} from './responsive-units';

describe('resolveResponsiveUnits', () => {
  it('returns non-vw/vh values untouched', () => {
    expect(resolveResponsiveUnits('16px', 1440)).toBe('16px');
    expect(resolveResponsiveUnits('1.5rem', 1440)).toBe('1.5rem');
    expect(resolveResponsiveUnits('auto', 1440)).toBe('auto');
    expect(resolveResponsiveUnits('', 1440)).toBe('');
    expect(resolveResponsiveUnits('red', 1440)).toBe('red');
  });

  it('resolves a simple vw value at the desktop width', () => {
    expect(resolveResponsiveUnits('9vw', 1440)).toBe('129.6px');
  });

  it('resolves the SAME source vw differently per viewport', () => {
    expect(resolveResponsiveUnits('9vw', 1440)).toBe('129.6px');
    expect(resolveResponsiveUnits('9vw', 768)).toBe('69.12px');
    expect(resolveResponsiveUnits('9vw', 375)).toBe('33.75px');
  });

  it('resolves vw inside clamp/calc', () => {
    expect(resolveResponsiveUnits('clamp(16px, 4vw, 48px)', 1440)).toBe('clamp(16px, 57.6px, 48px)');
    expect(resolveResponsiveUnits('clamp(16px, 4vw, 48px)', 768)).toBe('clamp(16px, 30.72px, 48px)');
    expect(resolveResponsiveUnits('calc(100vw - 32px)', 375)).toBe('calc(375px - 32px)');
  });

  it('resolves vh against width × device-class height ratio', () => {
    // Desktop (>= 1024): width * 0.625
    expect(resolveResponsiveUnits('100vh', 1440)).toBe(`${1440 * 0.625}px`);
    // Tablet (>= 500, < 1024): width * 1.33
    expect(resolveResponsiveUnits('100vh', 768)).toBe(`${768 * 1.33}px`);
    // Phone (< 500): width * 2.16
    expect(resolveResponsiveUnits('100vh', 375)).toBe(`${375 * 2.16}px`);
  });

  it('resolves negative vw values', () => {
    expect(resolveResponsiveUnits('-9vw', 1440)).toBe('-129.6px');
  });

  it('passes through malformed values without crashing', () => {
    expect(resolveResponsiveUnits('vw', 1440)).toBe('vw');
    expect(resolveResponsiveUnits('abcvw', 1440)).toBe('abcvw');
  });
});

describe('getResponsiveVpWidth', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns FALLBACK_VP_WIDTH when element is null', () => {
    expect(getResponsiveVpWidth(null)).toBe(FALLBACK_VP_WIDTH);
  });

  it('returns FALLBACK_VP_WIDTH when element has no [data-viewport] ancestor', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(getResponsiveVpWidth(el)).toBe(FALLBACK_VP_WIDTH);
  });

  it('reads data-viewport-width from the closest [data-viewport]', () => {
    const vp = document.createElement('div');
    vp.setAttribute('data-viewport', 'tablet');
    vp.setAttribute('data-viewport-width', '768');
    const child = document.createElement('p');
    vp.appendChild(child);
    document.body.appendChild(vp);
    expect(getResponsiveVpWidth(child)).toBe(768);
  });

  it('falls back when data-viewport-width is missing or invalid', () => {
    const vp = document.createElement('div');
    vp.setAttribute('data-viewport', 'tablet');
    document.body.appendChild(vp);
    expect(getResponsiveVpWidth(vp)).toBe(FALLBACK_VP_WIDTH);

    vp.setAttribute('data-viewport-width', 'not-a-number');
    expect(getResponsiveVpWidth(vp)).toBe(FALLBACK_VP_WIDTH);

    vp.setAttribute('data-viewport-width', '0');
    expect(getResponsiveVpWidth(vp)).toBe(FALLBACK_VP_WIDTH);
  });

  it('uses the nearest viewport when nested', () => {
    const outer = document.createElement('div');
    outer.setAttribute('data-viewport', 'desktop');
    outer.setAttribute('data-viewport-width', '1440');
    const inner = document.createElement('div');
    inner.setAttribute('data-viewport', 'tablet');
    inner.setAttribute('data-viewport-width', '768');
    const leaf = document.createElement('p');
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(getResponsiveVpWidth(leaf)).toBe(768);
  });
});

describe('resolveResponsiveStyles', () => {
  it('resolves every entry in a styles map', () => {
    const out = resolveResponsiveStyles(
      { fontSize: '9vw', padding: '16px', height: '100vh', color: 'red' },
      1440,
    );
    expect(out).toEqual({
      fontSize: '129.6px',
      padding: '16px',
      height: `${1440 * 0.625}px`,
      color: 'red',
    });
  });

  it('preserves empty strings (delete-property sentinel)', () => {
    const out = resolveResponsiveStyles({ fontSize: '', width: '100vw' }, 768);
    expect(out.fontSize).toBe('');
    expect(out.width).toBe('768px');
  });
});

// EMPIRICAL PIN — live find 2026-07-13: a per-viewport font-size override
// `clamp(40px, 11.6vw, 163px) !important` (template footer wordmark, mobile
// @media block) painted at the clamp MAX on every canvas tile: the
// @media→@container transform kept the raw vw, native CSS resolved it
// against the IFRAME window, and the !important beat patchElement's
// correctly-resolved inline merge. Correct on live, giant on canvas.
describe('resolveContainerQueryUnits', () => {
  const WIDTHS = [375, 768, 1440];

  it('resolves clamp vw inside a mobile-only block against the matching tile', () => {
    const css = '@container (max-width: 375px) {\n  [data-id="brand"] { font-size: clamp(40px, 11.6vw, 163px) !important; }\n}';
    const out = resolveContainerQueryUnits(css, WIDTHS);
    expect(out).toContain('@container (min-width: 375px) and (max-width: 375px)');
    expect(out).toContain(`clamp(40px, ${(11.6 / 100) * 375}px, 163px)`);
    expect(out).not.toContain('vw');
  });

  it('duplicates a multi-tile block once per matching width with per-width px', () => {
    const css = '@container (max-width: 1199px) { [data-id="t"] { font-size: 10vw !important; } }';
    const out = resolveContainerQueryUnits(css, WIDTHS);
    expect(out).toContain('@container (min-width: 375px) and (max-width: 375px)');
    expect(out).toContain('@container (min-width: 768px) and (max-width: 768px)');
    expect(out).not.toContain('@container (min-width: 1440px)');
    expect(out).toContain('font-size: 37.5px !important');
    expect(out).toContain('font-size: 76.8px !important');
  });

  it('respects min-width bounds when picking matching tiles', () => {
    const css = '@container (max-width: 768px) and (min-width: 376px) { [data-id="t"] { width: 50vw; } }';
    const out = resolveContainerQueryUnits(css, WIDTHS);
    expect(out).toContain('width: 384px');
    expect(out).not.toContain('@container (min-width: 375px) and (max-width: 375px)');
  });

  it('resolves vh via the device-class height heuristic', () => {
    const css = '@container (max-width: 375px) { [data-id="t"] { height: 50vh; } }';
    const out = resolveContainerQueryUnits(css, WIDTHS);
    expect(out).toContain(`height: ${0.5 * simulatedVpHeight(375)}px`);
  });

  it('passes through blocks without vw/vh and non-block text untouched', () => {
    const css = ':root { --x: 1; }\n@container (max-width: 375px) { [data-id="t"] { display: none !important; } }';
    expect(resolveContainerQueryUnits(css, WIDTHS)).toBe(css);
  });

  it('fast-path: css without vw/vh returns identity', () => {
    const css = '@container (max-width: 768px) { [data-id="t"] { color: red; } }';
    expect(resolveContainerQueryUnits(css, WIDTHS)).toBe(css);
  });

  it('no matching widths → block kept verbatim', () => {
    const css = '@container (max-width: 300px) { [data-id="t"] { font-size: 10vw; } }';
    expect(resolveContainerQueryUnits(css, WIDTHS)).toContain('10vw');
  });

  it('keeps surrounding rules intact while rewriting the vw block', () => {
    const css = '.a { color: blue; }\n@container (max-width: 375px) { [data-id="t"] { font-size: 8vw; } }\n.b { color: green; }';
    const out = resolveContainerQueryUnits(css, WIDTHS);
    expect(out).toContain('.a { color: blue; }');
    expect(out).toContain('.b { color: green; }');
    expect(out).toContain('font-size: 30px');
  });
});
