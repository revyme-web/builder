// preset-ops.test.ts — token-resolution helpers used for editor preview swatches.

import { describe, test, expect } from 'vitest';
import { resolveCssTokens, resolveTokenValue, addWorkspaceFontFacesToCss, type WorkspaceFontFaceSpec } from './preset-ops';
import type { PresetToken } from '@/shared/types';

const TOKENS: PresetToken[] = [
  { name: 'color-green-mint', value: '#1e3c1b', category: 'color' },
  { name: 'color-lime', value: '#93a961', category: 'color' },
  { name: 'color-glass', value: 'rgba(16,20,14,0.4)', category: 'color' },
];

describe('resolveTokenValue', () => {
  test('resolves a var(--name) reference to its value', () => {
    expect(resolveTokenValue('var(--color-green-mint)', TOKENS)).toBe('#1e3c1b');
  });
  test('returns null for an unknown token', () => {
    expect(resolveTokenValue('var(--color-nope)', TOKENS)).toBeNull();
  });
});

describe('resolveCssTokens', () => {
  // THE BUG: a gradient swatch in the editor frame rendered empty because
  // var(--color-green-mint) isn't defined there → invalid gradient. Resolving
  // the token to its hex makes the preview valid.
  test('resolves a token-coloured gradient stop to its hex', () => {
    const css = 'linear-gradient(180deg, #000000 39%, var(--color-green-mint) 22%)';
    expect(resolveCssTokens(css, TOKENS)).toBe(
      'linear-gradient(180deg, #000000 39%, #1e3c1b 22%)',
    );
  });

  test('resolves multiple token refs in one value', () => {
    const css = 'linear-gradient(90deg, var(--color-lime), var(--color-green-mint))';
    expect(resolveCssTokens(css, TOKENS)).toBe(
      'linear-gradient(90deg, #93a961, #1e3c1b)',
    );
  });

  test('resolves a token whose value is rgba()', () => {
    expect(resolveCssTokens('var(--color-glass)', TOKENS)).toBe('rgba(16,20,14,0.4)');
  });

  test('leaves unknown tokens untouched (graceful no-op)', () => {
    const css = 'linear-gradient(0deg, var(--color-mystery), #fff)';
    expect(resolveCssTokens(css, TOKENS)).toBe(css);
  });

  test('returns the input unchanged when there is no var()', () => {
    const css = 'linear-gradient(180deg, #000000 0%, #1e3c1b 100%)';
    expect(resolveCssTokens(css, TOKENS)).toBe(css);
    expect(resolveCssTokens('', TOKENS)).toBe('');
  });
});

describe('addWorkspaceFontFacesToCss', () => {
  const font = (over: Partial<WorkspaceFontFaceSpec> = {}): WorkspaceFontFaceSpec => ({
    family: 'Brand Sans',
    url: 'https://assets.revyme.app/workspaces/w1/fonts/abc.woff2',
    weight: 400,
    style: 'normal',
    ext: 'woff2',
    ...over,
  });

  test('appends an @font-face with the right family/format/weight/style', () => {
    const out = addWorkspaceFontFacesToCss(':root { --x: 1; }', [font()]);
    expect(out).toContain('@font-face');
    expect(out).toContain("font-family: 'Brand Sans'");
    expect(out).toContain("src: url('https://assets.revyme.app/workspaces/w1/fonts/abc.woff2') format('woff2')");
    expect(out).toContain('font-weight: 400');
    expect(out).toContain('font-style: normal');
    expect(out).toContain('font-display: swap');
  });

  test('maps ext → format() hint', () => {
    expect(addWorkspaceFontFacesToCss('', [font({ url: 'a.otf', ext: 'otf' })])).toContain("format('opentype')");
    expect(addWorkspaceFontFacesToCss('', [font({ url: 'a.ttf', ext: 'ttf' })])).toContain("format('truetype')");
    expect(addWorkspaceFontFacesToCss('', [font({ url: 'a.woff', ext: 'woff' })])).toContain("format('woff')");
  });

  test('is idempotent — skips a url already declared', () => {
    const first = addWorkspaceFontFacesToCss('', [font()]);
    const second = addWorkspaceFontFacesToCss(first, [font()]);
    expect(second).toBe(first);
    // and only one @font-face block exists
    expect(second.match(/@font-face/g)?.length).toBe(1);
  });

  test('adds every weight of a family but only the header once', () => {
    const out = addWorkspaceFontFacesToCss('', [
      font({ url: 'r.woff2', weight: 400 }),
      font({ url: 'b.woff2', weight: 700 }),
    ]);
    expect(out.match(/@font-face/g)?.length).toBe(2);
    expect(out.match(/Workspace custom fonts/g)?.length).toBe(1);
    expect(out).toContain('font-weight: 700');
  });

  test('appends AFTER existing @import lines (CSS requires @import first)', () => {
    const css = "@import url('https://fonts.googleapis.com/x');\n:root { --x: 1; }";
    const out = addWorkspaceFontFacesToCss(css, [font()]);
    expect(out.indexOf('@import')).toBeLessThan(out.indexOf('@font-face'));
  });
});
