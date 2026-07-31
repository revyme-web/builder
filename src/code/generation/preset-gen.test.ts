import { describe, test, expect } from 'vitest';
import {
  parsePresetTokens,
  serializePresetTokens,
  updatePresetTokenInCSS,
  addPresetTokenToCSS,
  removePresetTokenFromCSS,
} from './preset-gen';
import type { PresetToken } from '@/shared/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FULL_CSS = `/* Design Tokens — Presets */
:root {
  /* Colors */
  --color-brand: #6366f1;
  --color-brand-light: #818cf8;
  --color-surface: #ffffff;

  /* Typography */
  --typo-heading-size: 56px;
  --typo-body-size: 16px;

  /* Spacing */
  --space-section-y: 80px;
  --space-gap: 24px;

  /* Radius */
  --radius-card: 16px;
  --radius-button: 8px;

  /* Shadows */
  --shadow-card: 0 1px 3px rgba(0,0,0,0.06);
}
`;

const MINIMAL_CSS = `:root {
  --color-primary: #ff0000;
  --my-custom: hello;
}
`;

const NO_ROOT_CSS = `/* Just a comment */
body { margin: 0; }
`;

const EMPTY_CSS = '';

// ─── parsePresetTokens ─────────────────────────────────────────────────────

describe('parsePresetTokens', () => {
  test('extracts tokens from full CSS with category comments', () => {
    const tokens = parsePresetTokens(FULL_CSS);
    expect(tokens.length).toBe(10);

    // Check a color token
    const brand = tokens.find(t => t.name === 'color-brand');
    expect(brand).toBeDefined();
    expect(brand!.value).toBe('#6366f1');
    expect(brand!.category).toBe('color');

    // Check a typography token
    const headingSize = tokens.find(t => t.name === 'typo-heading-size');
    expect(headingSize).toBeDefined();
    expect(headingSize!.value).toBe('56px');
    expect(headingSize!.category).toBe('typography');

    // Check a spacing token
    const gap = tokens.find(t => t.name === 'space-gap');
    expect(gap).toBeDefined();
    expect(gap!.value).toBe('24px');
    expect(gap!.category).toBe('spacing');

    // Check a radius token
    const radiusCard = tokens.find(t => t.name === 'radius-card');
    expect(radiusCard).toBeDefined();
    expect(radiusCard!.value).toBe('16px');
    expect(radiusCard!.category).toBe('radius');

    // Check a shadow token
    const shadowCard = tokens.find(t => t.name === 'shadow-card');
    expect(shadowCard).toBeDefined();
    expect(shadowCard!.value).toBe('0 1px 3px rgba(0,0,0,0.06)');
    expect(shadowCard!.category).toBe('shadow');
  });

  test('detects category from name prefix when no comment hint', () => {
    const tokens = parsePresetTokens(MINIMAL_CSS);
    expect(tokens.length).toBe(2);

    const primary = tokens.find(t => t.name === 'color-primary');
    expect(primary!.category).toBe('color');

    const custom = tokens.find(t => t.name === 'my-custom');
    expect(custom!.category).toBe('other');
  });

  test('detects category from value heuristic', () => {
    const css = `:root {
  --my-red: #ff0000;
  --my-rgb: rgb(255, 0, 0);
  --my-shadow: 0 4px 12px rgba(0,0,0,0.1);
}`;
    const tokens = parsePresetTokens(css);

    expect(tokens.find(t => t.name === 'my-red')!.category).toBe('color');
    expect(tokens.find(t => t.name === 'my-rgb')!.category).toBe('color');
    expect(tokens.find(t => t.name === 'my-shadow')!.category).toBe('shadow');
  });

  test('detects image and video categories from prefix and url() value', () => {
    const css = `:root {
  --image-hero: url(https://example.com/hero.jpg);
  --image-bg: url('https://example.com/bg.png');
  --video-loop: https://example.com/loop.mp4;
  --random-asset: url(https://example.com/anon.gif);
}`;
    const tokens = parsePresetTokens(css);

    // Prefix-based detection takes priority.
    expect(tokens.find(t => t.name === 'image-hero')!.category).toBe('image');
    expect(tokens.find(t => t.name === 'image-bg')!.category).toBe('image');
    // Bare URLs in video- prefix tokens — runtime stores video presets as bare URL.
    expect(tokens.find(t => t.name === 'video-loop')!.category).toBe('video');
    // Falls through to value heuristic — url() defaults to image.
    expect(tokens.find(t => t.name === 'random-asset')!.category).toBe('image');
  });

  test('returns empty array when no :root block', () => {
    expect(parsePresetTokens(NO_ROOT_CSS)).toEqual([]);
  });

  test('returns empty array for empty CSS', () => {
    expect(parsePresetTokens(EMPTY_CSS)).toEqual([]);
  });
});

// ─── serializePresetTokens ──────────────────────────────────────────────────

describe('serializePresetTokens', () => {
  test('round-trip: parse then serialize preserves tokens', () => {
    const tokens = parsePresetTokens(FULL_CSS);
    const serialized = serializePresetTokens(tokens);
    const reparsed = parsePresetTokens(serialized);

    expect(reparsed.length).toBe(tokens.length);
    for (const original of tokens) {
      const found = reparsed.find(t => t.name === original.name);
      expect(found).toBeDefined();
      expect(found!.value).toBe(original.value);
      expect(found!.category).toBe(original.category);
    }
  });

  test('groups tokens by category with comment headers', () => {
    const tokens: PresetToken[] = [
      { name: 'space-x', value: '10px', category: 'spacing' },
      { name: 'color-a', value: '#000', category: 'color' },
    ];
    const css = serializePresetTokens(tokens);

    // Colors should come before spacing in canonical order
    const colorIdx = css.indexOf('/* Colors */');
    const spacingIdx = css.indexOf('/* Spacing */');
    expect(colorIdx).toBeLessThan(spacingIdx);
    expect(css).toContain('--color-a: #000;');
    expect(css).toContain('--space-x: 10px;');
  });

  test('serializes empty token list with empty :root', () => {
    const css = serializePresetTokens([]);
    expect(css).toContain(':root {');
    expect(css).toContain('}');
  });
});

// ─── updatePresetTokenInCSS ─────────────────────────────────────────────────

describe('updatePresetTokenInCSS', () => {
  test('changes value of existing token', () => {
    const updated = updatePresetTokenInCSS(FULL_CSS, 'color-brand', '#ff0000');
    expect(updated).toContain('--color-brand: #ff0000;');
    // Other tokens preserved
    expect(updated).toContain('--color-brand-light: #818cf8;');
    expect(updated).toContain('--typo-heading-size: 56px;');
  });

  test('preserves other tokens when updating', () => {
    const updated = updatePresetTokenInCSS(FULL_CSS, 'space-gap', '32px');
    expect(updated).toContain('--space-gap: 32px;');
    expect(updated).toContain('--color-brand: #6366f1;');
    expect(updated).toContain('--radius-card: 16px;');
  });

  test('returns unchanged CSS when token not found', () => {
    const result = updatePresetTokenInCSS(FULL_CSS, 'nonexistent', '99px');
    expect(result).toBe(FULL_CSS);
  });

  test('does not partially match similar token names', () => {
    // Updating 'color-brand' should NOT affect 'color-brand-light'
    const updated = updatePresetTokenInCSS(FULL_CSS, 'color-brand', '#000');
    expect(updated).toContain('--color-brand: #000;');
    expect(updated).toContain('--color-brand-light: #818cf8;');
  });
});

// ─── addPresetTokenToCSS ────────────────────────────────────────────────────

describe('addPresetTokenToCSS', () => {
  test('adds token to existing category group', () => {
    const token: PresetToken = { name: 'color-warning', value: '#f59e0b', category: 'color' };
    const updated = addPresetTokenToCSS(FULL_CSS, token);
    expect(updated).toContain('--color-warning: #f59e0b;');
    // Should be near other color tokens
    const tokens = parsePresetTokens(updated);
    const warningToken = tokens.find(t => t.name === 'color-warning');
    expect(warningToken).toBeDefined();
    expect(warningToken!.category).toBe('color');
  });

  test('adds token to a new category group', () => {
    const token: PresetToken = { name: 'other-misc', value: 'hello', category: 'other' };
    const updated = addPresetTokenToCSS(FULL_CSS, token);
    const tokens = parsePresetTokens(updated);
    const misc = tokens.find(t => t.name === 'other-misc');
    expect(misc).toBeDefined();
    expect(misc!.value).toBe('hello');
    expect(misc!.category).toBe('other');
  });

  test('creates :root block when CSS has none', () => {
    const token: PresetToken = { name: 'color-primary', value: '#000', category: 'color' };
    const result = addPresetTokenToCSS('/* empty */', token);
    expect(result).toContain(':root {');
    expect(result).toContain('--color-primary: #000;');
  });
});

// ─── addPresetTokenToCSS — duplicate prevention ─────────────────────────────

describe('addPresetTokenToCSS — duplicate prevention', () => {
  test('adding a token that already exists updates instead of duplicating', () => {
    const token: PresetToken = { name: 'color-brand', value: '#ff0000', category: 'color' };
    const updated = addPresetTokenToCSS(FULL_CSS, token);

    // Should have the new value
    expect(updated).toContain('--color-brand: #ff0000;');
    // Should NOT have the old value
    expect(updated).not.toContain('--color-brand: #6366f1;');

    // Count occurrences — should appear exactly once
    const matches = updated.match(/--color-brand\s*:/g);
    expect(matches).toHaveLength(1);

    // Other tokens should be preserved
    expect(updated).toContain('--color-brand-light: #818cf8;');
    expect(updated).toContain('--typo-heading-size: 56px;');
  });

  test('adding a token whose name is a substring of another does not false-positive', () => {
    // "color-brand" is a substring/prefix of "color-brand-light"
    // Adding "color-brand" should NOT match/update "color-brand-light"
    const token: PresetToken = { name: 'color-brand', value: '#updated', category: 'color' };
    const updated = addPresetTokenToCSS(FULL_CSS, token);

    // color-brand updated
    expect(updated).toContain('--color-brand: #updated;');
    // color-brand-light untouched
    expect(updated).toContain('--color-brand-light: #818cf8;');

    // Parse and verify token count is the same
    const originalTokens = parsePresetTokens(FULL_CSS);
    const updatedTokens = parsePresetTokens(updated);
    expect(updatedTokens.length).toBe(originalTokens.length);
  });

  test('adding a new token with a name that shares a prefix does not conflict', () => {
    // "color-brand-dark" is new but shares the "color-brand" prefix
    const token: PresetToken = { name: 'color-brand-dark', value: '#1a1a2e', category: 'color' };
    const updated = addPresetTokenToCSS(FULL_CSS, token);

    // New token added
    expect(updated).toContain('--color-brand-dark: #1a1a2e;');
    // Existing tokens untouched
    expect(updated).toContain('--color-brand: #6366f1;');
    expect(updated).toContain('--color-brand-light: #818cf8;');

    // One more token than original
    const originalTokens = parsePresetTokens(FULL_CSS);
    const updatedTokens = parsePresetTokens(updated);
    expect(updatedTokens.length).toBe(originalTokens.length + 1);
  });
});

// ─── removePresetTokenFromCSS ───────────────────────────────────────────────

describe('removePresetTokenFromCSS', () => {
  test('removes existing token', () => {
    const updated = removePresetTokenFromCSS(FULL_CSS, 'color-brand-light');
    expect(updated).not.toContain('--color-brand-light');
    // Other tokens preserved
    expect(updated).toContain('--color-brand: #6366f1;');
    expect(updated).toContain('--color-surface: #ffffff;');
  });

  test('preserves other tokens when removing', () => {
    const updated = removePresetTokenFromCSS(FULL_CSS, 'radius-button');
    expect(updated).not.toContain('--radius-button');
    expect(updated).toContain('--radius-card: 16px;');
    expect(updated).toContain('--color-brand: #6366f1;');
  });

  test('returns unchanged CSS when token not found', () => {
    const result = removePresetTokenFromCSS(FULL_CSS, 'nonexistent');
    expect(result).toBe(FULL_CSS);
  });

  test('does not partially match similar token names', () => {
    const updated = removePresetTokenFromCSS(FULL_CSS, 'color-brand');
    expect(updated).not.toContain('--color-brand:');
    // color-brand-light should survive
    expect(updated).toContain('--color-brand-light: #818cf8;');
  });
});
