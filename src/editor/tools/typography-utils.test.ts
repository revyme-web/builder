// typography-utils.test.ts — Tests for shared typography preset helpers.
// Source file (typography-utils.ts) exports: groupTypoTokens, getTypoTokenValue,
// detectActivePreset, createDefaultTypoTokens, TYPO_SUFFIXES, RESPONSIVE_PROPS, TypoGroup.

import { describe, test, expect } from 'vitest';
import {
  groupTypoTokens,
  getTypoTokenValue,
  getTypoTag,
  typoTagLabel,
  detectActivePreset,
  createDefaultTypoTokens,
  TYPO_SUFFIXES,
  TYPO_TAG_OPTIONS,
  RESPONSIVE_PROPS,
  bakePresetStyles,
} from './typography-utils';
import type { TypoGroup } from './typography-utils';
import type { PresetToken } from '@/shared/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeToken(name: string, value: string): PresetToken {
  return { name, value, category: 'typography' };
}

const HEADING_TOKENS: PresetToken[] = [
  makeToken('typo-heading-font', "'Inter', sans-serif"),
  makeToken('typo-heading-weight', '700'),
  makeToken('typo-heading-size', '48px'),
  makeToken('typo-heading-spacing', '0px'),
  makeToken('typo-heading-line-height', '1.2'),
  makeToken('typo-heading-color', '#000000'),
  makeToken('typo-heading-transform', 'none'),
  makeToken('typo-heading-decoration', 'none'),
  makeToken('typo-heading-shadow', 'none'),
  makeToken('typo-heading-min-default', '1200'),
  makeToken('typo-heading-min-md', '600'),
];

const BODY_TOKENS: PresetToken[] = [
  makeToken('typo-body-font', "'Inter', sans-serif"),
  makeToken('typo-body-weight', '400'),
  makeToken('typo-body-size', '16px'),
  makeToken('typo-body-spacing', '0px'),
  makeToken('typo-body-line-height', '1.5'),
  makeToken('typo-body-color', '#333333'),
  makeToken('typo-body-transform', 'none'),
  makeToken('typo-body-decoration', 'none'),
  makeToken('typo-body-shadow', 'none'),
  makeToken('typo-body-min-default', '1200'),
  makeToken('typo-body-min-md', '600'),
];

const HEADING_RESPONSIVE_TOKENS: PresetToken[] = [
  ...HEADING_TOKENS,
  makeToken('typo-heading-size-md', '36px'),
  makeToken('typo-heading-spacing-md', '-0.5px'),
  makeToken('typo-heading-line-height-md', '1.3'),
];

// ─── groupTypoTokens ────────────────────────────────────────────────────────

describe('groupTypoTokens', () => {
  test('groups heading tokens into a single group', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('heading');
    expect(groups[0].tokens).toHaveLength(HEADING_TOKENS.length);
  });

  test('groups multiple presets into separate groups', () => {
    const groups = groupTypoTokens([...HEADING_TOKENS, ...BODY_TOKENS]);
    expect(groups).toHaveLength(2);
    const names = groups.map(g => g.name).sort();
    expect(names).toEqual(['body', 'heading']);
  });

  test('generates label from group name: "heading" → "Heading"', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    expect(groups[0].label).toBe('Heading');
  });

  test('generates label for multi-word name: "my-custom" → "My Custom"', () => {
    const tokens = [makeToken('typo-my-custom-font', "'Roboto'")];
    const groups = groupTypoTokens(tokens);
    expect(groups[0].name).toBe('my-custom');
    expect(groups[0].label).toBe('My Custom');
  });

  test('responsive suffix tokens belong to the same group (not a separate one)', () => {
    const groups = groupTypoTokens(HEADING_RESPONSIVE_TOKENS);
    // Should still be ONE group "heading", not a separate "heading-size" group
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('heading');
    expect(groups[0].tokens).toHaveLength(HEADING_RESPONSIVE_TOKENS.length);
  });

  test('min-width tokens belong to the same group', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    expect(groups).toHaveLength(1);
    // min-default and min-md tokens should be in the heading group
    const minTokens = groups[0].tokens.filter(t => t.name.includes('-min-'));
    expect(minTokens).toHaveLength(2);
  });

  test('ignores non-typography tokens', () => {
    const mixed: PresetToken[] = [
      ...HEADING_TOKENS,
      { name: 'color-brand', value: '#6366f1', category: 'color' },
      { name: 'space-gap', value: '24px', category: 'spacing' },
    ];
    const groups = groupTypoTokens(mixed);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('heading');
  });

  test('returns empty array for empty input', () => {
    expect(groupTypoTokens([])).toEqual([]);
  });
});

// ─── getTypoTokenValue ──────────────────────────────────────────────────────

describe('getTypoTokenValue', () => {
  test('finds token value by suffix', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const group = groups[0];
    expect(getTypoTokenValue(group, 'font')).toBe("'Inter', sans-serif");
    expect(getTypoTokenValue(group, 'weight')).toBe('700');
    expect(getTypoTokenValue(group, 'size')).toBe('48px');
  });

  test('returns empty string for missing suffix', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const group = groups[0];
    expect(getTypoTokenValue(group, 'nonexistent')).toBe('');
  });

  test('finds responsive suffix token', () => {
    const groups = groupTypoTokens(HEADING_RESPONSIVE_TOKENS);
    const group = groups[0];
    expect(getTypoTokenValue(group, 'size-md')).toBe('36px');
  });
});

// ─── detectActivePreset ─────────────────────────────────────────────────────

describe('detectActivePreset', () => {
  test('detects var(--typo-heading-font) in fontFamily → returns heading group', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles = { fontFamily: 'var(--typo-heading-font)' };
    const result = detectActivePreset(styles, groups);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('heading');
  });

  test('returns null when no var() reference in fontFamily', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles = { fontFamily: "'Inter', sans-serif" };
    expect(detectActivePreset(styles, groups)).toBeNull();
  });

  test('returns null when fontFamily is empty', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles = { fontFamily: '' };
    expect(detectActivePreset(styles, groups)).toBeNull();
  });

  test('returns null when fontFamily is missing', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles: Record<string, string> = {};
    expect(detectActivePreset(styles, groups)).toBeNull();
  });

  test('returns null for non-typo var() reference', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles = { fontFamily: 'var(--color-brand)' };
    expect(detectActivePreset(styles, groups)).toBeNull();
  });

  test('returns null when var references a group that does not exist', () => {
    const groups = groupTypoTokens(HEADING_TOKENS);
    const styles = { fontFamily: 'var(--typo-nonexistent-font)' };
    expect(detectActivePreset(styles, groups)).toBeNull();
  });

  test('detects correct group among multiple groups', () => {
    const groups = groupTypoTokens([...HEADING_TOKENS, ...BODY_TOKENS]);
    const styles = { fontFamily: 'var(--typo-body-font)' };
    const result = detectActivePreset(styles, groups);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('body');
  });
});

// ─── createDefaultTypoTokens ────────────────────────────────────────────────

describe('createDefaultTypoTokens', () => {
  test('returns 12 tokens (incl. the tag)', () => {
    const tokens = createDefaultTypoTokens('heading');
    expect(tokens).toHaveLength(12);
  });

  test('all tokens have category "typography"', () => {
    const tokens = createDefaultTypoTokens('body');
    for (const token of tokens) {
      expect(token.category).toBe('typography');
    }
  });

  test('includes min-default and min-md tokens', () => {
    const tokens = createDefaultTypoTokens('heading');
    const names = tokens.map(t => t.name);
    expect(names).toContain('typo-heading-min-default');
    expect(names).toContain('typo-heading-min-md');
  });

  test('token names use provided slug', () => {
    const tokens = createDefaultTypoTokens('my-custom');
    for (const token of tokens) {
      expect(token.name).toMatch(/^typo-my-custom-/);
    }
  });

  test('includes core typography suffixes', () => {
    const tokens = createDefaultTypoTokens('test');
    const names = tokens.map(t => t.name);
    expect(names).toContain('typo-test-font');
    expect(names).toContain('typo-test-weight');
    expect(names).toContain('typo-test-size');
    expect(names).toContain('typo-test-spacing');
    expect(names).toContain('typo-test-line-height');
    expect(names).toContain('typo-test-color');
    expect(names).toContain('typo-test-transform');
    expect(names).toContain('typo-test-decoration');
    expect(names).toContain('typo-test-shadow');
  });
});

// ─── TYPO_SUFFIXES constant ─────────────────────────────────────────────────

describe('TYPO_SUFFIXES', () => {
  test('is an array of strings', () => {
    expect(Array.isArray(TYPO_SUFFIXES)).toBe(true);
    for (const s of TYPO_SUFFIXES) {
      expect(typeof s).toBe('string');
    }
  });

  test('includes responsive suffixes', () => {
    expect(TYPO_SUFFIXES).toContain('size-md');
    expect(TYPO_SUFFIXES).toContain('size-sm');
  });

  test('includes base property suffixes', () => {
    expect(TYPO_SUFFIXES).toContain('font');
    expect(TYPO_SUFFIXES).toContain('weight');
    expect(TYPO_SUFFIXES).toContain('size');
    expect(TYPO_SUFFIXES).toContain('line-height');
  });
});

// ─── RESPONSIVE_PROPS constant ──────────────────────────────────────────────

describe('RESPONSIVE_PROPS', () => {
  test('maps token suffixes to CSS properties', () => {
    expect(RESPONSIVE_PROPS).toHaveProperty('size');
    expect(RESPONSIVE_PROPS).toHaveProperty('spacing');
    expect(RESPONSIVE_PROPS).toHaveProperty('line-height');
  });

  test('maps to correct CSS property names', () => {
    expect(RESPONSIVE_PROPS['size']).toBe('fontSize');
    expect(RESPONSIVE_PROPS['spacing']).toBe('letterSpacing');
    expect(RESPONSIVE_PROPS['line-height']).toBe('lineHeight');
  });
});

// ─── Tag (Paragraph / Heading) ──────────────────────────────────────────────

describe('typography preset tag', () => {
  test('createDefaultTypoTokens stores the tag (defaults to p)', () => {
    const tokens = createDefaultTypoTokens('body');
    expect(tokens.find(t => t.name === 'typo-body-tag')?.value).toBe('p');
    const h2 = createDefaultTypoTokens('title', 'h2');
    expect(h2.find(t => t.name === 'typo-title-tag')?.value).toBe('h2');
  });

  test('an invalid tag falls back to p at creation', () => {
    const tokens = createDefaultTypoTokens('x', 'marquee');
    expect(tokens.find(t => t.name === 'typo-x-tag')?.value).toBe('p');
  });

  test('grouping keeps the -tag token inside its group (suffix recognized)', () => {
    const tokens: PresetToken[] = createDefaultTypoTokens('heading', 'h1');
    const groups = groupTypoTokens(tokens);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('heading');
    expect(getTypoTokenValue(groups[0], 'tag')).toBe('h1');
  });

  test('getTypoTag returns the stored tag, p for legacy groups without a tag token', () => {
    const withTag = groupTypoTokens(createDefaultTypoTokens('h', 'h3'))[0];
    expect(getTypoTag(withTag)).toBe('h3');
    const legacy: TypoGroup = { name: 'old', label: 'Old', tokens: [
      { name: 'typo-old-font', value: 'Inter', category: 'typography' },
    ] };
    expect(getTypoTag(legacy)).toBe('p');
  });

  test('getTypoTag ignores an unknown stored value', () => {
    const g: TypoGroup = { name: 'g', label: 'G', tokens: [
      { name: 'typo-g-tag', value: 'blink', category: 'typography' },
    ] };
    expect(getTypoTag(g)).toBe('p');
  });

  test('typoTagLabel formats the badge text', () => {
    expect(typoTagLabel('p')).toBe('P');
    expect(typoTagLabel('h4')).toBe('H4');
    expect(typoTagLabel(undefined)).toBe('P');
  });

  test('TYPO_TAG_OPTIONS covers paragraph + 6 headings', () => {
    expect(TYPO_TAG_OPTIONS.map(o => o.value)).toEqual(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  });
});

describe('bakePresetStyles (detach preset → keep look)', () => {
  // group "body": font var bound, size literal-overridden on the node.
  const body: TypoGroup = { name: 'body', label: 'Body', tokens: [
    makeToken('typo-body-font', "'Inter', sans-serif"),
    makeToken('typo-body-weight', '400'),
    makeToken('typo-body-size', '16px'),
    makeToken('typo-body-line-height', '1.7'),
    makeToken('typo-body-color', 'var(--color-white)'),
  ] };

  test('bakes a preset-BOUND prop to its resolved literal value', () => {
    const out = bakePresetStyles(body, { fontFamily: 'var(--typo-body-font)' });
    expect(out.fontFamily).toBe("'Inter', sans-serif");
  });

  test('does NOT touch a LITERAL override (custom font-size stays)', () => {
    const out = bakePresetStyles(body, {
      fontFamily: 'var(--typo-body-font)',
      fontSize: '60px',          // user override — must be left untouched
      fontWeight: '700',         // user override
    });
    expect(out.fontFamily).toBe("'Inter', sans-serif"); // bound → baked
    expect(out.fontSize).toBeUndefined();               // literal → not in patch
    expect(out.fontWeight).toBeUndefined();
  });

  test('only bakes the preset\'s OWN var (a different var is left alone)', () => {
    const out = bakePresetStyles(body, {
      fontFamily: 'var(--typo-body-font)',
      color: 'var(--color-white)',  // not the preset's color var (--typo-body-color)
    });
    expect(out.fontFamily).toBe("'Inter', sans-serif");
    expect(out.color).toBeUndefined(); // unchanged
  });

  test('bakes the preset\'s color var when the node IS bound to it', () => {
    const out = bakePresetStyles(body, {
      fontFamily: 'var(--typo-body-font)',
      color: 'var(--typo-body-color)',
    });
    expect(out.color).toBe('var(--color-white)'); // resolved token value (may itself be a var)
  });

  test('tolerant of whitespace inside var()', () => {
    const out = bakePresetStyles(body, { fontFamily: 'var( --typo-body-font )' });
    expect(out.fontFamily).toBe("'Inter', sans-serif");
  });

  test('returns {} when nothing is bound', () => {
    expect(bakePresetStyles(body, { fontFamily: 'Georgia, serif', fontSize: '20px' })).toEqual({});
  });
});
