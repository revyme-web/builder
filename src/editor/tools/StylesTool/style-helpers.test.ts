// style-helpers.test.ts — parse/format round-trips for StylesTool helpers.

import { describe, it, expect } from 'vitest';
import { parsePx, formatPx, parseBackdropBlur, formatBackdropBlur } from './style-helpers';

describe('parsePx / formatPx', () => {
  it('parses leading number from a px string', () => {
    expect(parsePx('14px')).toBe(14);
    expect(parsePx('0')).toBe(0);
  });
  it('returns 0 for missing/garbage', () => {
    expect(parsePx(undefined)).toBe(0);
    expect(parsePx('auto')).toBe(0);
  });
  it('formats a number to a bare string', () => {
    expect(formatPx(14)).toBe('14');
  });
});

describe('parseBackdropBlur', () => {
  it('parses the px radius out of blur()', () => {
    expect(parseBackdropBlur('blur(14px)')).toBe(14);
    expect(parseBackdropBlur('blur(8.5px)')).toBe(8.5);
    expect(parseBackdropBlur('blur( 10px )')).toBe(10);
  });
  it('returns 0 for absent / none / no blur()', () => {
    expect(parseBackdropBlur(undefined)).toBe(0);
    expect(parseBackdropBlur('')).toBe(0);
    expect(parseBackdropBlur('none')).toBe(0);
    expect(parseBackdropBlur('saturate(180%)')).toBe(0);
  });
  it('reads blur() even alongside other functions', () => {
    expect(parseBackdropBlur('blur(12px) saturate(180%)')).toBe(12);
  });
});

describe('formatBackdropBlur', () => {
  it('wraps a number into blur(Npx)', () => {
    expect(formatBackdropBlur(14)).toBe('blur(14px)');
    expect(formatBackdropBlur(0)).toBe('blur(0px)');
    expect(formatBackdropBlur(8.5)).toBe('blur(8.5px)');
  });
  it('round-trips with parseBackdropBlur', () => {
    for (const n of [0, 1, 8.5, 14, 30]) {
      expect(parseBackdropBlur(formatBackdropBlur(n))).toBe(n);
    }
  });
});
