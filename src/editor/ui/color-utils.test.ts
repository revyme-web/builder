// color-utils.test.ts — Tests for color conversion utilities.

import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  rgbToHsl,
  hslToRgb,
  parseColor,
  formatColor,
  rgbaToHex,
  toHexDisplay,
} from './color-utils';

// ─── hexToRgb ───────────────────────────────────────────────────────────────

describe('hexToRgb', () => {
  it('parses standard 6-char hex', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('parses shorthand 3-char hex', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('parses 8-char hex (ignores alpha channel)', () => {
    expect(hexToRgb('#ff0000cc')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#00ff0080')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('parses 4-char hex (ignores alpha channel)', () => {
    // #f00a → ff0000aa, takes first 6 chars → ff0000
    expect(hexToRgb('#f00a')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('handles hex without # prefix', () => {
    expect(hexToRgb('ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('returns black for invalid input', () => {
    expect(hexToRgb('#xyz')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('handles mixed case', () => {
    expect(hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#Ff00Ff')).toEqual({ r: 255, g: 0, b: 255 });
  });
});

// ─── rgbToHex ───────────────────────────────────────────────────────────────

describe('rgbToHex', () => {
  it('converts standard RGB to hex', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000');
    expect(rgbToHex({ r: 0, g: 255, b: 0 })).toBe('#00ff00');
    expect(rgbToHex({ r: 0, g: 0, b: 255 })).toBe('#0000ff');
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe('#ffffff');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  it('pads single-digit hex values', () => {
    expect(rgbToHex({ r: 0, g: 0, b: 1 })).toBe('#000001');
    expect(rgbToHex({ r: 15, g: 15, b: 15 })).toBe('#0f0f0f');
  });

  it('clamps out-of-range values', () => {
    expect(rgbToHex({ r: 300, g: -10, b: 128 })).toBe('#ff0080');
  });

  it('rounds fractional values', () => {
    expect(rgbToHex({ r: 127.6, g: 0, b: 0 })).toBe('#800000');
    expect(rgbToHex({ r: 127.4, g: 0, b: 0 })).toBe('#7f0000');
  });
});

// ─── rgbToHsv / hsvToRgb round-trip ────────────────────────────────────────

describe('rgbToHsv', () => {
  it('converts pure red', () => {
    const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
    expect(hsv.h).toBeCloseTo(0, 0);
    expect(hsv.s).toBeCloseTo(100, 0);
    expect(hsv.v).toBeCloseTo(100, 0);
  });

  it('converts pure green', () => {
    const hsv = rgbToHsv({ r: 0, g: 255, b: 0 });
    expect(hsv.h).toBeCloseTo(120, 0);
    expect(hsv.s).toBeCloseTo(100, 0);
    expect(hsv.v).toBeCloseTo(100, 0);
  });

  it('converts pure blue', () => {
    const hsv = rgbToHsv({ r: 0, g: 0, b: 255 });
    expect(hsv.h).toBeCloseTo(240, 0);
    expect(hsv.s).toBeCloseTo(100, 0);
    expect(hsv.v).toBeCloseTo(100, 0);
  });

  it('converts white', () => {
    const hsv = rgbToHsv({ r: 255, g: 255, b: 255 });
    expect(hsv.h).toBe(0);
    expect(hsv.s).toBe(0);
    expect(hsv.v).toBeCloseTo(100, 0);
  });

  it('converts black', () => {
    const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
    expect(hsv.h).toBe(0);
    expect(hsv.s).toBe(0);
    expect(hsv.v).toBe(0);
  });

  it('converts gray', () => {
    const hsv = rgbToHsv({ r: 128, g: 128, b: 128 });
    expect(hsv.h).toBe(0);
    expect(hsv.s).toBe(0);
    expect(hsv.v).toBeCloseTo(50.2, 0);
  });
});

describe('hsvToRgb', () => {
  it('converts pure red', () => {
    expect(hsvToRgb({ h: 0, s: 100, v: 100 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('converts pure green', () => {
    expect(hsvToRgb({ h: 120, s: 100, v: 100 })).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('converts pure blue', () => {
    expect(hsvToRgb({ h: 240, s: 100, v: 100 })).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('converts white', () => {
    expect(hsvToRgb({ h: 0, s: 0, v: 100 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('converts black', () => {
    expect(hsvToRgb({ h: 0, s: 0, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('rgb ↔ hsv round-trip', () => {
  const testCases = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },   // yellow
    { r: 0, g: 255, b: 255 },   // cyan
    { r: 255, g: 0, b: 255 },   // magenta
    { r: 255, g: 255, b: 255 }, // white
    { r: 0, g: 0, b: 0 },       // black
    { r: 128, g: 128, b: 128 }, // gray
    { r: 100, g: 200, b: 50 },  // arbitrary color
  ];

  for (const rgb of testCases) {
    it(`round-trips (${rgb.r}, ${rgb.g}, ${rgb.b})`, () => {
      const hsv = rgbToHsv(rgb);
      const result = hsvToRgb(hsv);
      expect(result.r).toBeCloseTo(rgb.r, 0);
      expect(result.g).toBeCloseTo(rgb.g, 0);
      expect(result.b).toBeCloseTo(rgb.b, 0);
    });
  }
});

// ─── rgbToHsl / hslToRgb ───────────────────────────────────────────────────

describe('rgbToHsl', () => {
  it('converts pure red', () => {
    const hsl = rgbToHsl({ r: 255, g: 0, b: 0 });
    expect(hsl.h).toBeCloseTo(0, 0);
    expect(hsl.s).toBeCloseTo(100, 0);
    expect(hsl.l).toBeCloseTo(50, 0);
  });

  it('converts pure green', () => {
    const hsl = rgbToHsl({ r: 0, g: 255, b: 0 });
    expect(hsl.h).toBeCloseTo(120, 0);
    expect(hsl.s).toBeCloseTo(100, 0);
    expect(hsl.l).toBeCloseTo(50, 0);
  });

  it('converts pure blue', () => {
    const hsl = rgbToHsl({ r: 0, g: 0, b: 255 });
    expect(hsl.h).toBeCloseTo(240, 0);
    expect(hsl.s).toBeCloseTo(100, 0);
    expect(hsl.l).toBeCloseTo(50, 0);
  });

  it('converts white', () => {
    const hsl = rgbToHsl({ r: 255, g: 255, b: 255 });
    expect(hsl.s).toBe(0);
    expect(hsl.l).toBeCloseTo(100, 0);
  });

  it('converts black', () => {
    const hsl = rgbToHsl({ r: 0, g: 0, b: 0 });
    expect(hsl.s).toBe(0);
    expect(hsl.l).toBe(0);
  });

  it('converts gray (achromatic)', () => {
    const hsl = rgbToHsl({ r: 128, g: 128, b: 128 });
    expect(hsl.h).toBe(0);
    expect(hsl.s).toBe(0);
    expect(hsl.l).toBeCloseTo(50.2, 0);
  });
});

describe('hslToRgb', () => {
  it('converts pure red', () => {
    expect(hslToRgb({ h: 0, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('converts achromatic (gray)', () => {
    const result = hslToRgb({ h: 0, s: 0, l: 50 });
    expect(result.r).toBe(128);
    expect(result.g).toBe(128);
    expect(result.b).toBe(128);
  });

  it('converts white', () => {
    expect(hslToRgb({ h: 0, s: 0, l: 100 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('converts black', () => {
    expect(hslToRgb({ h: 0, s: 0, l: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('rgb ↔ hsl round-trip', () => {
  const testCases = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
    { r: 0, g: 255, b: 255 },
    { r: 255, g: 0, b: 255 },
    { r: 255, g: 255, b: 255 },
    { r: 0, g: 0, b: 0 },
    { r: 128, g: 128, b: 128 },
    { r: 100, g: 200, b: 50 },
  ];

  for (const rgb of testCases) {
    it(`round-trips (${rgb.r}, ${rgb.g}, ${rgb.b})`, () => {
      const hsl = rgbToHsl(rgb);
      const result = hslToRgb(hsl);
      expect(result.r).toBeCloseTo(rgb.r, 0);
      expect(result.g).toBeCloseTo(rgb.g, 0);
      expect(result.b).toBeCloseTo(rgb.b, 0);
    });
  }
});

// ─── parseColor ─────────────────────────────────────────────────────────────

describe('parseColor', () => {
  it('parses 6-char hex', () => {
    const result = parseColor('#ff0000');
    expect(result.rgb).toEqual({ r: 255, g: 0, b: 0 });
    expect(result.alpha).toBe(1);
  });

  it('parses 3-char hex', () => {
    const result = parseColor('#fff');
    expect(result.rgb).toEqual({ r: 255, g: 255, b: 255 });
    expect(result.alpha).toBe(1);
  });

  it('parses 8-char hex with alpha', () => {
    const result = parseColor('#ff000080');
    expect(result.rgb).toEqual({ r: 255, g: 0, b: 0 });
    // 0x80 = 128, 128/255 ≈ 0.50
    expect(result.alpha).toBeCloseTo(0.50, 1);
  });

  it('parses 4-char hex with alpha', () => {
    const result = parseColor('#f008');
    expect(result.rgb).toEqual({ r: 255, g: 0, b: 0 });
    // 0x88 = 136, 136/255 ≈ 0.53
    expect(result.alpha).toBeCloseTo(0.53, 1);
  });

  it('parses rgb()', () => {
    const result = parseColor('rgb(100, 200, 50)');
    expect(result.rgb).toEqual({ r: 100, g: 200, b: 50 });
    expect(result.alpha).toBe(1);
  });

  it('parses rgba()', () => {
    const result = parseColor('rgba(100, 200, 50, 0.5)');
    expect(result.rgb).toEqual({ r: 100, g: 200, b: 50 });
    expect(result.alpha).toBe(0.5);
  });

  it('parses hsl()', () => {
    const result = parseColor('hsl(0, 100%, 50%)');
    expect(result.rgb.r).toBeCloseTo(255, 0);
    expect(result.rgb.g).toBeCloseTo(0, 0);
    expect(result.rgb.b).toBeCloseTo(0, 0);
    expect(result.alpha).toBe(1);
  });

  it('parses hsla()', () => {
    const result = parseColor('hsla(0, 100%, 50%, 0.75)');
    expect(result.rgb.r).toBeCloseTo(255, 0);
    expect(result.alpha).toBe(0.75);
  });

  it('parses "transparent"', () => {
    const result = parseColor('transparent');
    expect(result.rgb).toEqual({ r: 0, g: 0, b: 0 });
    expect(result.alpha).toBe(0);
  });

  it('is case-insensitive', () => {
    const result = parseColor('#FF0000');
    expect(result.rgb).toEqual({ r: 255, g: 0, b: 0 });

    const result2 = parseColor('TRANSPARENT');
    expect(result2.alpha).toBe(0);
  });

  it('trims whitespace', () => {
    const result = parseColor('  #ff0000  ');
    expect(result.rgb).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('returns black for invalid/unrecognized strings', () => {
    const result = parseColor('not-a-color');
    expect(result.rgb).toEqual({ r: 0, g: 0, b: 0 });
    expect(result.alpha).toBe(1);
  });

  it('returns black for empty string', () => {
    const result = parseColor('');
    expect(result.rgb).toEqual({ r: 0, g: 0, b: 0 });
    expect(result.alpha).toBe(1);
  });
});

// ─── formatColor ────────────────────────────────────────────────────────────

describe('formatColor', () => {
  it('returns hex when alpha is 1', () => {
    expect(formatColor({ r: 255, g: 0, b: 0 }, 1)).toBe('#ff0000');
    expect(formatColor({ r: 0, g: 255, b: 0 }, 1)).toBe('#00ff00');
  });

  it('returns hex when alpha > 1 (treated as opaque)', () => {
    expect(formatColor({ r: 255, g: 0, b: 0 }, 1.5)).toBe('#ff0000');
  });

  it('returns rgba when alpha < 1', () => {
    expect(formatColor({ r: 255, g: 0, b: 0 }, 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(formatColor({ r: 100, g: 200, b: 50 }, 0)).toBe('rgba(100, 200, 50, 0)');
  });

  it('rounds alpha to 2 decimal places', () => {
    expect(formatColor({ r: 0, g: 0, b: 0 }, 0.333)).toBe('rgba(0, 0, 0, 0.33)');
    expect(formatColor({ r: 0, g: 0, b: 0 }, 0.666)).toBe('rgba(0, 0, 0, 0.67)');
  });

  it('rounds RGB values', () => {
    expect(formatColor({ r: 127.6, g: 0.4, b: 255.9 }, 0.5)).toBe('rgba(128, 0, 256, 0.5)');
  });
});

// ─── rgbaToHex ──────────────────────────────────────────────────────────────

describe('rgbaToHex', () => {
  it('opaque → 6-digit uppercase hex', () => {
    expect(rgbaToHex({ r: 255, g: 0, b: 0 }, 1)).toBe('#FF0000');
    expect(rgbaToHex({ r: 18, g: 52, b: 86 }, 1)).toBe('#123456');
  });

  it('alpha < 1 → 8-digit hex', () => {
    expect(rgbaToHex({ r: 255, g: 255, b: 255 }, 0.75)).toBe('#FFFFFFBF');
    expect(rgbaToHex({ r: 0, g: 0, b: 0 }, 0)).toBe('#00000000');
    expect(rgbaToHex({ r: 0, g: 255, b: 0 }, 0.5)).toBe('#00FF0080');
  });

  it('clamps out-of-range channels', () => {
    expect(rgbaToHex({ r: -10, g: 300, b: 128 }, 1)).toBe('#00FF80');
  });
});

// ─── toHexDisplay ───────────────────────────────────────────────────────────

describe('toHexDisplay', () => {
  it('rgba → 8-digit hex (the Fill control case)', () => {
    expect(toHexDisplay('rgba(255, 255, 255, 0.75)')).toBe('#FFFFFFBF');
  });

  it('rgb → 6-digit hex', () => {
    expect(toHexDisplay('rgb(255, 0, 0)')).toBe('#FF0000');
  });

  it('normalizes hex shorthand and case', () => {
    expect(toHexDisplay('#fff')).toBe('#FFFFFF');
    expect(toHexDisplay('#ffffffbf')).toBe('#FFFFFFBF');
    expect(toHexDisplay('#abc')).toBe('#AABBCC');
  });

  it('hsl / hsla → hex', () => {
    expect(toHexDisplay('hsl(0, 100%, 50%)')).toBe('#FF0000');
    expect(toHexDisplay('hsla(120, 100%, 50%, 0.5)')).toBe('#00FF0080');
  });

  it('transparent → #00000000', () => {
    expect(toHexDisplay('transparent')).toBe('#00000000');
  });

  it('leaves var(), gradients and CSS keywords untouched', () => {
    expect(toHexDisplay('var(--color-primary)')).toBe('var(--color-primary)');
    expect(toHexDisplay('linear-gradient(90deg, #fff, #000)')).toBe('linear-gradient(90deg, #fff, #000)');
    expect(toHexDisplay('currentColor')).toBe('currentColor');
    expect(toHexDisplay('none')).toBe('none');
  });

  it('empty input → empty', () => {
    expect(toHexDisplay('')).toBe('');
  });

  // Named colours / oklch / lab are resolved via the browser's CSS parser
  // (a 2D-canvas context). In jsdom that context is unavailable, so the
  // value is returned unchanged — assert only that it never throws.
  it('non-regex formats do not throw', () => {
    expect(() => toHexDisplay('rebeccapurple')).not.toThrow();
    expect(() => toHexDisplay('oklch(0.7 0.15 30)')).not.toThrow();
  });
});
