// decoration-helpers.test.ts — Tests for parseDecoShorthand and formatDecoShorthand.

import { describe, test, expect } from 'vitest';
import { parseDecoShorthand, formatDecoShorthand } from './decoration-helpers';

// ─── parseDecoShorthand ─────────────────────────────────────────────────────

describe('parseDecoShorthand', () => {
  test('"none" → defaults with line=none', () => {
    const result = parseDecoShorthand('none');
    expect(result).toEqual({ line: 'none', color: '#000000', style: 'solid', thickness: 1, offset: 0 });
  });

  test('empty string → defaults', () => {
    const result = parseDecoShorthand('');
    expect(result).toEqual({ line: 'none', color: '#000000', style: 'solid', thickness: 1, offset: 0 });
  });

  test('simple value "underline" → line=underline, defaults for rest', () => {
    const result = parseDecoShorthand('underline');
    expect(result.line).toBe('underline');
    expect(result.style).toBe('solid');
    expect(result.color).toBe('#000000');
    expect(result.thickness).toBe(1);
    expect(result.offset).toBe(0);
  });

  test('CSS shorthand "underline solid #a72222"', () => {
    const result = parseDecoShorthand('underline solid #a72222');
    expect(result).toEqual({
      line: 'underline',
      style: 'solid',
      color: '#a72222',
      thickness: 1,
      offset: 0,
    });
  });

  test('CSS shorthand with wavy style', () => {
    const result = parseDecoShorthand('overline wavy #ff0000');
    expect(result.line).toBe('overline');
    expect(result.style).toBe('wavy');
    expect(result.color).toBe('#ff0000');
  });

  test('CSS shorthand with line-through', () => {
    const result = parseDecoShorthand('line-through dashed #123456');
    expect(result.line).toBe('line-through');
    expect(result.style).toBe('dashed');
    expect(result.color).toBe('#123456');
  });

  test('legacy pipe format migration', () => {
    const result = parseDecoShorthand('underline|#a72222|solid|14.5px|0px');
    expect(result).toEqual({
      line: 'underline',
      color: '#a72222',
      style: 'solid',
      thickness: 14.5,
      offset: 0,
    });
  });

  test('legacy pipe format with different thickness and offset', () => {
    const result = parseDecoShorthand('overline|#ff0000|wavy|3px|5px');
    expect(result).toEqual({
      line: 'overline',
      color: '#ff0000',
      style: 'wavy',
      thickness: 3,
      offset: 5,
    });
  });

  test('legacy pipe format with missing parts uses defaults', () => {
    const result = parseDecoShorthand('underline||');
    expect(result.line).toBe('underline');
    expect(result.color).toBe('#000000');
    expect(result.style).toBe('solid');
    expect(result.thickness).toBe(1);
    expect(result.offset).toBe(0);
  });

  // Color extraction tests
  test('extracts 3-digit hex color', () => {
    const result = parseDecoShorthand('underline #abc');
    expect(result.color).toBe('#abc');
    expect(result.line).toBe('underline');
  });

  test('extracts 6-digit hex color', () => {
    const result = parseDecoShorthand('underline #aabbcc');
    expect(result.color).toBe('#aabbcc');
  });

  test('extracts 8-digit hex color (with alpha)', () => {
    const result = parseDecoShorthand('underline #aabbccdd');
    expect(result.color).toBe('#aabbccdd');
  });

  test('extracts rgb() color', () => {
    const result = parseDecoShorthand('underline rgb(255, 0, 0)');
    expect(result.color).toBe('rgb(255, 0, 0)');
    expect(result.line).toBe('underline');
  });

  test('extracts rgba() color', () => {
    const result = parseDecoShorthand('underline rgba(255, 0, 0, 0.5)');
    expect(result.color).toBe('rgba(255, 0, 0, 0.5)');
  });

  test('dotted style is detected', () => {
    const result = parseDecoShorthand('underline dotted #000');
    expect(result.style).toBe('dotted');
  });

  test('double style is detected', () => {
    const result = parseDecoShorthand('underline double #000');
    expect(result.style).toBe('double');
  });
});

// ─── formatDecoShorthand ────────────────────────────────────────────────────

describe('formatDecoShorthand', () => {
  test('line=none → "none"', () => {
    expect(formatDecoShorthand({ line: 'none', color: '#000000', style: 'solid', thickness: 1, offset: 0 })).toBe('none');
  });

  test('formats underline solid #a72222', () => {
    expect(formatDecoShorthand({ line: 'underline', style: 'solid', color: '#a72222', thickness: 1, offset: 0 }))
      .toBe('underline solid #a72222');
  });

  test('formats overline wavy #ff0000', () => {
    expect(formatDecoShorthand({ line: 'overline', style: 'wavy', color: '#ff0000', thickness: 2, offset: 3 }))
      .toBe('overline wavy #ff0000');
  });

  test('formats line-through dashed #123456', () => {
    expect(formatDecoShorthand({ line: 'line-through', style: 'dashed', color: '#123456', thickness: 1, offset: 0 }))
      .toBe('line-through dashed #123456');
  });
});

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('parseDecoShorthand ↔ formatDecoShorthand round-trip', () => {
  test('"underline solid #a72222" round-trips', () => {
    const original = 'underline solid #a72222';
    const parsed = parseDecoShorthand(original);
    const formatted = formatDecoShorthand(parsed);
    expect(formatted).toBe(original);
    // Second round-trip
    const reparsed = parseDecoShorthand(formatted);
    expect(reparsed.line).toBe(parsed.line);
    expect(reparsed.style).toBe(parsed.style);
    expect(reparsed.color).toBe(parsed.color);
  });

  test('"none" round-trips', () => {
    const parsed = parseDecoShorthand('none');
    const formatted = formatDecoShorthand(parsed);
    expect(formatted).toBe('none');
    const reparsed = parseDecoShorthand(formatted);
    expect(reparsed.line).toBe('none');
  });

  test('"overline wavy #ff0000" round-trips', () => {
    const original = 'overline wavy #ff0000';
    const parsed = parseDecoShorthand(original);
    const formatted = formatDecoShorthand(parsed);
    expect(formatted).toBe(original);
  });

  test('legacy pipe format migrates to CSS shorthand on round-trip', () => {
    const legacy = 'underline|#a72222|solid|14.5px|0px';
    const parsed = parseDecoShorthand(legacy);
    const formatted = formatDecoShorthand(parsed);
    // After formatting, it should be CSS shorthand (not pipe format)
    expect(formatted).toBe('underline solid #a72222');
    // Re-parsing CSS shorthand preserves line/style/color (thickness/offset lost in shorthand)
    const reparsed = parseDecoShorthand(formatted);
    expect(reparsed.line).toBe('underline');
    expect(reparsed.style).toBe('solid');
    expect(reparsed.color).toBe('#a72222');
  });
});
