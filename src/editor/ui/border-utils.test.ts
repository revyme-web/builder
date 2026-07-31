// border-utils.test.ts — Tests for border CSS parsing utilities.

import { describe, it, expect } from 'vitest';
import {
  parseBorderShorthand,
  parseBorderState,
  formatBorderShorthand,
  formatBorderUniform,
  formatBorderIndividual,
  extractBorderAfterRuleBody,
  formatBorderAfterCSS,
  parseBorderAfterCSS,
} from './border-utils';

// ─── parseBorderShorthand ─────────────────────────────────────────────────────

describe('parseBorderShorthand', () => {
  it('parses a full shorthand: width style color', () => {
    expect(parseBorderShorthand('1px solid red')).toEqual({
      width: 1,
      style: 'solid',
      color: 'red',
    });
  });

  it('parses width and dashed style with hex color', () => {
    expect(parseBorderShorthand('2px dashed #ff0000')).toEqual({
      width: 2,
      style: 'dashed',
      color: '#ff0000',
    });
  });

  it('parses style-only input', () => {
    expect(parseBorderShorthand('solid')).toEqual({
      width: 0,
      style: 'solid',
      color: '#000000',
    });
  });

  it('parses width and style with no color', () => {
    expect(parseBorderShorthand('1px solid')).toEqual({
      width: 1,
      style: 'solid',
      color: '#000000',
    });
  });

  it('parses "none" as zero border', () => {
    expect(parseBorderShorthand('none')).toEqual({
      width: 0,
      style: 'none',
      color: '#000000',
    });
  });

  it('parses "0" as zero border', () => {
    expect(parseBorderShorthand('0')).toEqual({
      width: 0,
      style: 'none',
      color: '#000000',
    });
  });

  it('parses rgba() color with commas inside parens', () => {
    const result = parseBorderShorthand('3px solid rgba(255, 0, 0, 0.5)');
    expect(result).toEqual({
      width: 3,
      style: 'solid',
      color: 'rgba(255, 0, 0, 0.5)',
    });
  });

  it('defaults style to solid when width > 0 but no style given', () => {
    // Edge case: "2px #ff0000" — width and color but no style
    const result = parseBorderShorthand('2px #ff0000');
    expect(result.width).toBe(2);
    expect(result.style).toBe('solid');
    expect(result.color).toBe('#ff0000');
  });

  it('handles dotted style', () => {
    expect(parseBorderShorthand('1px dotted blue')).toEqual({
      width: 1,
      style: 'dotted',
      color: 'blue',
    });
  });

  it('handles double style', () => {
    expect(parseBorderShorthand('4px double green')).toEqual({
      width: 4,
      style: 'double',
      color: 'green',
    });
  });

  it('handles empty string gracefully', () => {
    const result = parseBorderShorthand('');
    expect(result.width).toBe(0);
    expect(result.style).toBe('none');
    expect(result.color).toBe('#000000');
  });
});

// ─── parseBorderState ─────────────────────────────────────────────────────────

describe('parseBorderState', () => {
  it('returns all-none defaults for empty styles', () => {
    const state = parseBorderState({});
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(state[side]).toEqual({ width: 0, style: 'none', color: '#000000' });
    }
    expect(state.isUniform).toBe(true);
  });

  it('applies global border shorthand to all 4 sides', () => {
    const state = parseBorderState({ border: '2px solid blue' });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(state[side]).toEqual({ width: 2, style: 'solid', color: 'blue' });
    }
    expect(state.isUniform).toBe(true);
  });

  it('applies borderWidth, borderStyle, borderColor to all sides', () => {
    const state = parseBorderState({
      borderWidth: '3px',
      borderStyle: 'dashed',
      borderColor: 'red',
    });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(state[side]).toEqual({ width: 3, style: 'dashed', color: 'red' });
    }
    expect(state.isUniform).toBe(true);
  });

  it('handles 4-value borderWidth: T R B L', () => {
    const state = parseBorderState({
      borderStyle: 'solid',
      borderColor: 'black',
      borderWidth: '1px 2px 3px 4px',
    });
    expect(state.top.width).toBe(1);
    expect(state.right.width).toBe(2);
    expect(state.bottom.width).toBe(3);
    expect(state.left.width).toBe(4);
    expect(state.isUniform).toBe(false);
  });

  it('handles 2-value borderWidth: TB RL', () => {
    const state = parseBorderState({
      borderStyle: 'solid',
      borderColor: 'black',
      borderWidth: '5px 10px',
    });
    expect(state.top.width).toBe(5);
    expect(state.right.width).toBe(10);
    expect(state.bottom.width).toBe(5);
    expect(state.left.width).toBe(10);
    expect(state.isUniform).toBe(false);
  });

  it('handles 3-value borderWidth: T RL B', () => {
    const state = parseBorderState({
      borderStyle: 'solid',
      borderColor: 'black',
      borderWidth: '1px 2px 3px',
    });
    expect(state.top.width).toBe(1);
    expect(state.right.width).toBe(2);
    expect(state.bottom.width).toBe(3);
    expect(state.left.width).toBe(2);
  });

  it('per-side shorthand overrides global border', () => {
    const state = parseBorderState({
      border: '1px solid black',
      borderTop: '5px dashed red',
    });
    expect(state.top).toEqual({ width: 5, style: 'dashed', color: 'red' });
    expect(state.right).toEqual({ width: 1, style: 'solid', color: 'black' });
    expect(state.bottom).toEqual({ width: 1, style: 'solid', color: 'black' });
    expect(state.left).toEqual({ width: 1, style: 'solid', color: 'black' });
    expect(state.isUniform).toBe(false);
  });

  it('per-side longhand overrides per-side shorthand', () => {
    const state = parseBorderState({
      border: '1px solid black',
      borderTop: '5px dashed red',
      borderTopWidth: '10px',
    });
    expect(state.top.width).toBe(10);
    expect(state.top.style).toBe('dashed');
    expect(state.top.color).toBe('red');
  });

  it('handles 4-value borderColor', () => {
    const state = parseBorderState({
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'red green blue yellow',
    });
    expect(state.top.color).toBe('red');
    expect(state.right.color).toBe('green');
    expect(state.bottom.color).toBe('blue');
    expect(state.left.color).toBe('yellow');
    expect(state.isUniform).toBe(false);
  });

  it('handles 4-value borderStyle', () => {
    const state = parseBorderState({
      borderWidth: '1px',
      borderStyle: 'solid dashed dotted double',
      borderColor: 'black',
    });
    expect(state.top.style).toBe('solid');
    expect(state.right.style).toBe('dashed');
    expect(state.bottom.style).toBe('dotted');
    expect(state.left.style).toBe('double');
    expect(state.isUniform).toBe(false);
  });

  it('per-side longhands: borderTopStyle, borderRightColor, etc.', () => {
    const state = parseBorderState({
      border: '2px solid black',
      borderTopStyle: 'dashed',
      borderRightColor: 'red',
      borderBottomWidth: '4px',
      borderLeftColor: 'blue',
    });
    expect(state.top).toEqual({ width: 2, style: 'dashed', color: 'black' });
    expect(state.right).toEqual({ width: 2, style: 'solid', color: 'red' });
    expect(state.bottom).toEqual({ width: 4, style: 'solid', color: 'black' });
    expect(state.left).toEqual({ width: 2, style: 'solid', color: 'blue' });
    expect(state.isUniform).toBe(false);
  });

  it('isUniform is true when all 4 sides are identical', () => {
    const state = parseBorderState({ border: '1px solid red' });
    expect(state.isUniform).toBe(true);
  });

  it('isUniform is false when sides differ', () => {
    const state = parseBorderState({
      borderWidth: '1px 2px',
      borderStyle: 'solid',
      borderColor: 'black',
    });
    expect(state.isUniform).toBe(false);
  });

  it('auto-fixes: side with width>0 and style none gets style solid', () => {
    const state = parseBorderState({
      borderWidth: '2px',
      borderColor: 'black',
      // no borderStyle → defaults to none, should become solid
    });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(state[side].style).toBe('solid');
    }
  });

  it('combines global border with axis shorthand override', () => {
    const state = parseBorderState({
      border: '1px solid black',
      borderWidth: '3px',
    });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(state[side].width).toBe(3);
      expect(state[side].style).toBe('solid');
      expect(state[side].color).toBe('black');
    }
  });
});

// ─── formatBorderShorthand ────────────────────────────────────────────────────

describe('formatBorderShorthand', () => {
  it('formats a basic border side to shorthand string', () => {
    expect(formatBorderShorthand({ width: 2, style: 'solid', color: '#ff0000' })).toBe('2px solid #ff0000');
  });

  it('returns "none" for a zero-width border', () => {
    expect(formatBorderShorthand({ width: 0, style: 'none', color: '#000000' })).toBe('none');
  });

  it('returns "none" for zero width even if style is solid', () => {
    expect(formatBorderShorthand({ width: 0, style: 'solid', color: 'red' })).toBe('none');
  });

  it('formats dashed border with rgba color', () => {
    expect(formatBorderShorthand({ width: 3, style: 'dashed', color: 'rgba(255, 0, 0, 0.5)' }))
      .toBe('3px dashed rgba(255, 0, 0, 0.5)');
  });

  it('formats dotted border', () => {
    expect(formatBorderShorthand({ width: 1, style: 'dotted', color: 'blue' })).toBe('1px dotted blue');
  });
});

// ─── formatBorderUniform ──────────────────────────────────────────────────────

describe('formatBorderUniform', () => {
  it('returns border shorthand for all 4 sides', () => {
    const result = formatBorderUniform({ width: 1, style: 'solid', color: 'red' });
    expect(result.border).toBe('1px solid red');
  });

  it('returns exactly 16 keys total', () => {
    const result = formatBorderUniform({ width: 1, style: 'solid', color: 'red' });
    // 1 (border) + 12 per-side longhands + 3 axis shorthands = 16
    expect(Object.keys(result)).toHaveLength(16);
  });

  it('clears all 12 per-side longhands with empty string', () => {
    const result = formatBorderUniform({ width: 1, style: 'solid', color: 'red' });
    const longhands = [
      'borderTopWidth', 'borderTopStyle', 'borderTopColor',
      'borderRightWidth', 'borderRightStyle', 'borderRightColor',
      'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
      'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
    ];
    for (const key of longhands) {
      expect(result[key]).toBe('');
    }
  });

  it('clears axis shorthands: borderWidth, borderStyle, borderColor', () => {
    const result = formatBorderUniform({ width: 1, style: 'solid', color: 'red' });
    expect(result.borderWidth).toBe('');
    expect(result.borderStyle).toBe('');
    expect(result.borderColor).toBe('');
  });

  it('formats "none" shorthand for zero border', () => {
    const result = formatBorderUniform({ width: 0, style: 'none', color: '#000000' });
    expect(result.border).toBe('none');
  });

  it('contains border as a key', () => {
    const result = formatBorderUniform({ width: 2, style: 'dashed', color: 'blue' });
    expect('border' in result).toBe(true);
    expect(result.border).toBe('2px dashed blue');
  });
});

// ─── formatBorderIndividual ───────────────────────────────────────────────────

describe('formatBorderIndividual', () => {
  const uniformState = parseBorderState({ border: '1px solid red' });
  const mixedState = parseBorderState({
    border: '1px solid red',
    borderTop: '2px dashed blue',
  });

  it('returns exactly 16 keys total', () => {
    const result = formatBorderIndividual(uniformState);
    expect(Object.keys(result)).toHaveLength(16);
  });

  it('sets all 12 per-side longhands for uniform border', () => {
    const result = formatBorderIndividual(uniformState);
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (const side of sides) {
      expect(result[`border${side}Width`]).toBe('1px');
      expect(result[`border${side}Style`]).toBe('solid');
      expect(result[`border${side}Color`]).toBe('red');
    }
  });

  it('sets per-side longhands correctly for mixed border', () => {
    const result = formatBorderIndividual(mixedState);
    expect(result.borderTopWidth).toBe('2px');
    expect(result.borderTopStyle).toBe('dashed');
    expect(result.borderTopColor).toBe('blue');
    expect(result.borderRightWidth).toBe('1px');
    expect(result.borderRightStyle).toBe('solid');
    expect(result.borderRightColor).toBe('red');
    expect(result.borderBottomWidth).toBe('1px');
    expect(result.borderBottomStyle).toBe('solid');
    expect(result.borderBottomColor).toBe('red');
    expect(result.borderLeftWidth).toBe('1px');
    expect(result.borderLeftStyle).toBe('solid');
    expect(result.borderLeftColor).toBe('red');
  });

  it('clears the 4 shorthands: border, borderWidth, borderStyle, borderColor', () => {
    const result = formatBorderIndividual(uniformState);
    expect(result.border).toBe('');
    expect(result.borderWidth).toBe('');
    expect(result.borderStyle).toBe('');
    expect(result.borderColor).toBe('');
  });
});

// ─── formatGradientBorderAfterCSS ────────────────────────────────────────────

import {
  formatGradientBorderAfterCSS,
  parseGradientBorderAfterCSS,
  isGradientBorder,
} from './border-utils';

describe('formatGradientBorderAfterCSS', () => {
  it('includes mask-composite: exclude (gradient border signature)', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 2);
    expect(css).toContain('mask-composite: exclude');
  });

  it('includes -webkit-mask-composite: xor', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 2);
    expect(css).toContain('-webkit-mask-composite: xor');
  });

  it('sets padding to the given width in px', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 3);
    expect(css).toContain('padding: 3px');
  });

  it('sets background to the gradient CSS', () => {
    const gradientCSS = 'linear-gradient(45deg, red, blue)';
    const css = formatGradientBorderAfterCSS(gradientCSS, 2);
    expect(css).toContain(`background: ${gradientCSS}`);
  });

  it('includes position: absolute and inset: 0', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 1);
    expect(css).toContain('position: absolute');
    expect(css).toContain('inset: 0');
  });

  it('includes border-radius: inherit', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 1);
    expect(css).toContain('border-radius: inherit');
  });

  it('includes pointer-events: none and z-index: 1', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 1);
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('z-index: 1');
  });

  it('includes both -webkit-mask and mask properties', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 2);
    expect(css).toContain('-webkit-mask:');
    expect(css).toContain('mask:');
  });
});

// ─── parseGradientBorderAfterCSS ──────────────────────────────────────────────

describe('parseGradientBorderAfterCSS', () => {
  it('returns null for a solid border (no mask-composite)', () => {
    const solidCSS = `
      content: '';
      position: absolute;
      inset: 0;
      border-width: 2px;
      border-style: solid;
      border-color: red;
    `;
    expect(parseGradientBorderAfterCSS(solidCSS)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGradientBorderAfterCSS('')).toBeNull();
  });

  it('roundtrips with formatGradientBorderAfterCSS: simple gradient', () => {
    const gradientCSS = 'linear-gradient(red, blue)';
    const width = 2;
    const css = formatGradientBorderAfterCSS(gradientCSS, width);
    const parsed = parseGradientBorderAfterCSS(css);
    expect(parsed).not.toBeNull();
    expect(parsed!.gradientCSS).toBe(gradientCSS);
    expect(parsed!.width).toBe(width);
  });

  it('roundtrips with formatGradientBorderAfterCSS: angled gradient with multiple stops', () => {
    const gradientCSS = 'linear-gradient(45deg, #ff0000, #00ff00, #0000ff)';
    const width = 4;
    const css = formatGradientBorderAfterCSS(gradientCSS, width);
    const parsed = parseGradientBorderAfterCSS(css);
    expect(parsed).not.toBeNull();
    expect(parsed!.gradientCSS).toBe(gradientCSS);
    expect(parsed!.width).toBe(width);
  });

  it('roundtrips with a radial gradient', () => {
    const gradientCSS = 'radial-gradient(circle, red 0%, blue 100%)';
    const width = 3;
    const css = formatGradientBorderAfterCSS(gradientCSS, width);
    const parsed = parseGradientBorderAfterCSS(css);
    expect(parsed).not.toBeNull();
    expect(parsed!.gradientCSS).toBe(gradientCSS);
    expect(parsed!.width).toBe(width);
  });

  it('extracts correct width when width is 1', () => {
    const css = formatGradientBorderAfterCSS('linear-gradient(red, blue)', 1);
    const parsed = parseGradientBorderAfterCSS(css);
    expect(parsed!.width).toBe(1);
  });
});

// ─── isGradientBorder ─────────────────────────────────────────────────────────

describe('isGradientBorder', () => {
  it('returns true when borderImageSource contains "gradient"', () => {
    expect(isGradientBorder({ borderImageSource: 'linear-gradient(red, blue)' })).toBe(true);
  });

  it('returns true for radial-gradient in borderImageSource', () => {
    expect(isGradientBorder({ borderImageSource: 'radial-gradient(circle, red, blue)' })).toBe(true);
  });

  it('returns false when styles are empty', () => {
    expect(isGradientBorder({})).toBe(false);
  });

  it('returns false for solid border styles', () => {
    expect(isGradientBorder({ border: '1px solid red' })).toBe(false);
  });

  it('returns false when borderImageSource is a url() (not a gradient)', () => {
    expect(isGradientBorder({ borderImageSource: 'url(/img/border.png)' })).toBe(false);
  });

  it('returns false when borderImageSource is absent but other border props exist', () => {
    expect(isGradientBorder({ borderWidth: '2px', borderStyle: 'solid', borderColor: 'blue' })).toBe(false);
  });
});

// ─── Roundtrip ────────────────────────────────────────────────────────────────

describe('roundtrip: parseBorderState → formatBorderUniform → parseBorderState', () => {
  it('uniform border survives a full roundtrip', () => {
    const original = parseBorderState({ border: '1px solid red' });
    const formatted = formatBorderUniform(original.top);
    const roundtripped = parseBorderState(formatted);

    expect(roundtripped.isUniform).toBe(true);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(roundtripped[side].width).toBe(original[side].width);
      expect(roundtripped[side].style).toBe(original[side].style);
      expect(roundtripped[side].color).toBe(original[side].color);
    }
  });

  it('individual borders survive roundtrip via formatBorderIndividual', () => {
    const original = parseBorderState({
      border: '1px solid red',
      borderTop: '2px dashed blue',
    });
    const formatted = formatBorderIndividual(original);
    const roundtripped = parseBorderState(formatted);

    expect(roundtripped.top).toEqual(original.top);
    expect(roundtripped.right).toEqual(original.right);
    expect(roundtripped.bottom).toEqual(original.bottom);
    expect(roundtripped.left).toEqual(original.left);
  });
});

// ─── extractBorderAfterRuleBody ──────────────────────────────────────────────

describe('extractBorderAfterRuleBody', () => {
  const solidBody = formatBorderAfterCSS({
    top: { width: 2, style: 'solid', color: '#ff0000' },
    right: { width: 2, style: 'solid', color: '#ff0000' },
    bottom: { width: 2, style: 'solid', color: '#ff0000' },
    left: { width: 2, style: 'solid', color: '#ff0000' },
    isUniform: true,
  });

  it('extracts the ::after rule body for a node (data-id spelling)', () => {
    const css = `.foo { color: red; }\n[data-id="hero-1"]::after {${solidBody}}\n.bar { top: 0; }`;
    const body = extractBorderAfterRuleBody(css, 'hero-1');
    expect(body).not.toBeNull();
    // Round-trips through the standard parser — the exact body the Border panel wrote.
    const state = parseBorderAfterCSS(body!);
    expect(state?.top).toEqual({ width: 2, style: 'solid', color: '#ff0000' });
  });

  it('matches the sandbox data-node-id spelling too', () => {
    const css = `[data-node-id="hero-1"]::after {${solidBody}}`;
    expect(extractBorderAfterRuleBody(css, 'hero-1')).not.toBeNull();
  });

  it('round-trips a GRADIENT border rule (mask-composite technique)', () => {
    const body = formatGradientBorderAfterCSS('linear-gradient(135deg, #00ff88, #0066ff)', 3);
    const css = `[data-id="card-2"]::after {\n${body}\n}`;
    const extracted = extractBorderAfterRuleBody(css, 'card-2');
    expect(extracted).not.toBeNull();
    const grad = parseGradientBorderAfterCSS(extracted!);
    expect(grad?.width).toBe(3);
    expect(grad?.gradientCSS).toBe('linear-gradient(135deg, #00ff88, #0066ff)');
  });

  it('returns null when the node has no overlay rule / for other nodes', () => {
    const css = `[data-id="hero-1"]::after {${solidBody}}`;
    expect(extractBorderAfterRuleBody(css, 'other-node')).toBeNull();
    expect(extractBorderAfterRuleBody('', 'hero-1')).toBeNull();
    expect(extractBorderAfterRuleBody(css, '')).toBeNull();
  });

  it('does not cross-match a node id that is a prefix of another', () => {
    const css = `[data-id="hero-10"]::after {${solidBody}}`;
    expect(extractBorderAfterRuleBody(css, 'hero-1')).toBeNull();
  });
});
