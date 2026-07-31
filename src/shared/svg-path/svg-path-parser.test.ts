// svg-path-parser.test.ts — Tests for SVG path `d` attribute parser.

import { describe, test, it, expect } from 'vitest';
import { parseSvgPath } from '@/shared/svg-path/svg-path-parser';

// ─── Basic commands ───────────────────────────────────────────────────────────

describe('parseSvgPath — basic commands', () => {
  test('M (moveto absolute)', () => {
    expect(parseSvgPath('M0,0')).toEqual([['M', '0', '0']]);
    expect(parseSvgPath('M 10 20')).toEqual([['M', '10', '20']]);
    expect(parseSvgPath('M10,20')).toEqual([['M', '10', '20']]);
  });

  test('m (moveto relative)', () => {
    expect(parseSvgPath('m5,5')).toEqual([['m', '5', '5']]);
  });

  test('L (lineto absolute)', () => {
    expect(parseSvgPath('M0,0 L100,100')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '100'],
    ]);
  });

  test('l (lineto relative)', () => {
    expect(parseSvgPath('M0,0 l50,50')).toEqual([
      ['M', '0', '0'],
      ['l', '50', '50'],
    ]);
  });

  test('H (horizontal absolute)', () => {
    expect(parseSvgPath('M0,0 H100')).toEqual([
      ['M', '0', '0'],
      ['H', '100'],
    ]);
  });

  test('h (horizontal relative)', () => {
    expect(parseSvgPath('M0,0 h50')).toEqual([
      ['M', '0', '0'],
      ['h', '50'],
    ]);
  });

  test('V (vertical absolute)', () => {
    expect(parseSvgPath('M0,0 V200')).toEqual([
      ['M', '0', '0'],
      ['V', '200'],
    ]);
  });

  test('v (vertical relative)', () => {
    expect(parseSvgPath('M0,0 v-30')).toEqual([
      ['M', '0', '0'],
      ['v', '-30'],
    ]);
  });

  test('Z (closepath)', () => {
    expect(parseSvgPath('M0,0 L100,0 L100,100 Z')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '0'],
      ['L', '100', '100'],
      ['Z'],
    ]);
  });

  test('z (closepath lowercase)', () => {
    expect(parseSvgPath('M0,0 L100,100 z')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '100'],
      ['z'],
    ]);
  });
});

// ─── Curve commands ───────────────────────────────────────────────────────────

describe('parseSvgPath — curve commands', () => {
  test('C (cubic bezier absolute)', () => {
    expect(parseSvgPath('M0,0 C10,20,30,40,50,60')).toEqual([
      ['M', '0', '0'],
      ['C', '10', '20', '30', '40', '50', '60'],
    ]);
  });

  test('c (cubic bezier relative)', () => {
    expect(parseSvgPath('M0,0 c10 20 30 40 50 60')).toEqual([
      ['M', '0', '0'],
      ['c', '10', '20', '30', '40', '50', '60'],
    ]);
  });

  test('S (smooth cubic absolute)', () => {
    expect(parseSvgPath('M0,0 S30,40,50,60')).toEqual([
      ['M', '0', '0'],
      ['S', '30', '40', '50', '60'],
    ]);
  });

  test('s (smooth cubic relative)', () => {
    expect(parseSvgPath('M0,0 s10,20,30,40')).toEqual([
      ['M', '0', '0'],
      ['s', '10', '20', '30', '40'],
    ]);
  });

  test('Q (quadratic bezier absolute)', () => {
    expect(parseSvgPath('M0,0 Q50,50,100,0')).toEqual([
      ['M', '0', '0'],
      ['Q', '50', '50', '100', '0'],
    ]);
  });

  test('q (quadratic bezier relative)', () => {
    expect(parseSvgPath('M0,0 q25,50,50,0')).toEqual([
      ['M', '0', '0'],
      ['q', '25', '50', '50', '0'],
    ]);
  });

  test('T (smooth quadratic absolute)', () => {
    expect(parseSvgPath('M0,0 Q50,50,100,0 T200,0')).toEqual([
      ['M', '0', '0'],
      ['Q', '50', '50', '100', '0'],
      ['T', '200', '0'],
    ]);
  });

  test('t (smooth quadratic relative)', () => {
    expect(parseSvgPath('M0,0 q25,50,50,0 t50,0')).toEqual([
      ['M', '0', '0'],
      ['q', '25', '50', '50', '0'],
      ['t', '50', '0'],
    ]);
  });
});

// ─── Arc commands ─────────────────────────────────────────────────────────────

describe('parseSvgPath — arc commands', () => {
  test('A (arc absolute) with spaces', () => {
    expect(parseSvgPath('M0,0 A10 10 0 0 1 100 100')).toEqual([
      ['M', '0', '0'],
      ['A', '10', '10', '0', '0', '1', '100', '100'],
    ]);
  });

  test('a (arc relative)', () => {
    expect(parseSvgPath('M0,0 a25,25,0,0,1,50,0')).toEqual([
      ['M', '0', '0'],
      ['a', '25', '25', '0', '0', '1', '50', '0'],
    ]);
  });

  test('arc flags without spaces between them', () => {
    // The two flag params (0 and 1) are adjacent with no separator.
    expect(parseSvgPath('M0,0 A10,10,0,01,100,100')).toEqual([
      ['M', '0', '0'],
      ['A', '10', '10', '0', '0', '1', '100', '100'],
    ]);
  });

  test('arc with large-arc-flag and sweep-flag packed', () => {
    expect(parseSvgPath('M80,80A45,45,0,0,0,125,125')).toEqual([
      ['M', '80', '80'],
      ['A', '45', '45', '0', '0', '0', '125', '125'],
    ]);
  });
});

// ─── Implicit L after M ──────────────────────────────────────────────────────

describe('parseSvgPath — implicit lineto after moveto', () => {
  test('M with extra coordinate pairs becomes L', () => {
    expect(parseSvgPath('M0,0 100,100')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '100'],
    ]);
  });

  test('m with extra coordinate pairs becomes l', () => {
    expect(parseSvgPath('m0,0 10,10 20,20')).toEqual([
      ['m', '0', '0'],
      ['l', '10', '10'],
      ['l', '20', '20'],
    ]);
  });
});

// ─── Repeated parameter sets ─────────────────────────────────────────────────

describe('parseSvgPath — repeated parameter sets', () => {
  test('multiple L coordinates', () => {
    expect(parseSvgPath('M0,0 L10,10 20,20 30,30')).toEqual([
      ['M', '0', '0'],
      ['L', '10', '10'],
      ['L', '20', '20'],
      ['L', '30', '30'],
    ]);
  });

  test('multiple H values', () => {
    expect(parseSvgPath('M0,0 H10 20 30')).toEqual([
      ['M', '0', '0'],
      ['H', '10'],
      ['H', '20'],
      ['H', '30'],
    ]);
  });

  test('multiple C parameter sets', () => {
    expect(parseSvgPath('M0,0 C1,2,3,4,5,6 7,8,9,10,11,12')).toEqual([
      ['M', '0', '0'],
      ['C', '1', '2', '3', '4', '5', '6'],
      ['C', '7', '8', '9', '10', '11', '12'],
    ]);
  });
});

// ─── Separator edge cases ─────────────────────────────────────────────────────

describe('parseSvgPath — separator edge cases', () => {
  test('no space after command letter', () => {
    expect(parseSvgPath('M0,0')).toEqual([['M', '0', '0']]);
  });

  test('spaces as separators', () => {
    expect(parseSvgPath('M 0 0')).toEqual([['M', '0', '0']]);
  });

  test('no separator between commands', () => {
    expect(parseSvgPath('M0,0L100,100')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '100'],
    ]);
  });

  test('commas between all params', () => {
    expect(parseSvgPath('C0,0,50,50,100,100')).toEqual([
      ['C', '0', '0', '50', '50', '100', '100'],
    ]);
  });

  test('tabs and newlines as whitespace', () => {
    expect(parseSvgPath('M\t0\n0\rL\f100 100')).toEqual([
      ['M', '0', '0'],
      ['L', '100', '100'],
    ]);
  });

  test('negative numbers as implicit separators', () => {
    // '-5' starts a new number, so '10-5' is two numbers: 10 and -5.
    expect(parseSvgPath('M10-5')).toEqual([['M', '10', '-5']]);
  });

  test('decimal points as implicit separators', () => {
    // '10.5.3' is two numbers: 10.5 and .3
    expect(parseSvgPath('M10.5.3')).toEqual([['M', '10.5', '.3']]);
  });
});

// ─── Scientific notation ──────────────────────────────────────────────────────

describe('parseSvgPath — scientific notation', () => {
  test('integer with exponent', () => {
    expect(parseSvgPath('M1e2,0')).toEqual([['M', '1e2', '0']]);
  });

  test('decimal with negative exponent', () => {
    expect(parseSvgPath('M1.5e-3,2.5E+1')).toEqual([['M', '1.5e-3', '2.5E+1']]);
  });
});

// ─── Negative numbers and signs ───────────────────────────────────────────────

describe('parseSvgPath — negative numbers', () => {
  test('negative coordinates', () => {
    expect(parseSvgPath('M-10,-20')).toEqual([['M', '-10', '-20']]);
  });

  test('positive sign', () => {
    expect(parseSvgPath('M+10,+20')).toEqual([['M', '+10', '+20']]);
  });

  test('mixed signs without separators', () => {
    expect(parseSvgPath('M10-20')).toEqual([['M', '10', '-20']]);
  });
});

// ─── Complex real-world paths ─────────────────────────────────────────────────

describe('parseSvgPath — real-world paths', () => {
  test('triangle', () => {
    expect(parseSvgPath('M150,0 L75,200 L225,200 Z')).toEqual([
      ['M', '150', '0'],
      ['L', '75', '200'],
      ['L', '225', '200'],
      ['Z'],
    ]);
  });

  test('rounded rectangle snippet', () => {
    const d = 'M10,0 H90 A10,10,0,0,1,100,10 V90 A10,10,0,0,1,90,100 H10 A10,10,0,0,1,0,90 V10 A10,10,0,0,1,10,0 Z';
    const result = parseSvgPath(d);
    // M, H, A, V, A, H, A, V, A, Z = 10 commands
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual(['M', '10', '0']);
    expect(result[1]).toEqual(['H', '90']);
    expect(result[2]).toEqual(['A', '10', '10', '0', '0', '1', '100', '10']);
    expect(result[9]).toEqual(['Z']);
  });

  test('heart shape (cubic beziers)', () => {
    const d = 'M10,30 A20,20,0,0,1,50,30 A20,20,0,0,1,90,30 Q90,60,50,90 Q10,60,10,30 Z';
    const result = parseSvgPath(d);
    expect(result).toHaveLength(6);
    expect(result[0][0]).toBe('M');
    expect(result[1][0]).toBe('A');
    expect(result[2][0]).toBe('A');
    expect(result[3][0]).toBe('Q');
    expect(result[4][0]).toBe('Q');
    expect(result[5][0]).toBe('Z');
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('parseSvgPath — error handling', () => {
  test('empty string returns empty array', () => {
    expect(parseSvgPath('')).toEqual([]);
  });

  test('whitespace-only string returns empty array', () => {
    expect(parseSvgPath('   ')).toEqual([]);
  });

  test('invalid character at start stops parsing', () => {
    // 'X' is not a valid SVG path command — parser stops.
    expect(parseSvgPath('X0,0')).toEqual([]);
  });

  test('invalid character mid-path stops parsing at that point', () => {
    // Parses M0,0 then hits 'X' and stops.
    expect(parseSvgPath('M0,0 X50,50')).toEqual([['M', '0', '0']]);
  });

  test('command with missing params emits nothing for that command', () => {
    // Z has no params, L needs params but none given — L produces no commands.
    // But after L with no params, Z is still a command letter so it parses.
    expect(parseSvgPath('M0,0 Z')).toEqual([['M', '0', '0'], ['Z']]);
  });

  test('command with insufficient params stops parsing at that point', () => {
    // L needs 2 params, only 1 given ('50'), then 'Z' follows.
    // parseComponents for L reads '50', then commaWsp eats the space, but 'Z' doesn't
    // match kNumberRegex. The param set fails. Cursor stays at '50'.
    // Main loop tries kCommandTypeRegex on '50 Z' — '5' is not a command letter, so parsing stops.
    // Result: only the M command is captured; L and Z are lost.
    const result = parseSvgPath('M0,0 L50 Z');
    expect(result).toEqual([['M', '0', '0']]);
  });
});

// ─── Whitespace variations ────────────────────────────────────────────────────

describe('parseSvgPath — whitespace variations', () => {
  test('leading whitespace is skipped', () => {
    expect(parseSvgPath('  M0,0')).toEqual([['M', '0', '0']]);
  });

  test('trailing whitespace is handled', () => {
    expect(parseSvgPath('M0,0  ')).toEqual([['M', '0', '0']]);
  });

  test('multiple spaces between params', () => {
    expect(parseSvgPath('M  0  ,  0')).toEqual([['M', '0', '0']]);
  });
});

// ─── Floating point values ────────────────────────────────────────────────────

describe('parseSvgPath — floating point', () => {
  test('decimal values', () => {
    expect(parseSvgPath('M0.5,1.5')).toEqual([['M', '0.5', '1.5']]);
  });

  test('leading decimal point', () => {
    expect(parseSvgPath('M.5,.3')).toEqual([['M', '.5', '.3']]);
  });

  test('trailing decimal point', () => {
    expect(parseSvgPath('M5.,3.')).toEqual([['M', '5.', '3.']]);
  });

  test('adjacent decimals as separators', () => {
    // '1.2.3.4' → 1.2, .3, .4 — but M only takes 2 params.
    // Actually our kNumberRegex matches '1.2' first, then '.3' second. M is satisfied.
    // The '.4' would remain unconsumed (no implicit L here since M already got 2 params,
    // but then the repeated-params loop tries again and needs 2 numbers for implicit L).
    // '.4' alone is only 1 number, so implicit L fails. '.4' stays unconsumed.
    expect(parseSvgPath('M1.2.3')).toEqual([['M', '1.2', '.3']]);
  });
});

// ─── dToElementAttrs ──────────────────────────────────────────────────────────

import { dToElementAttrs } from '@/shared/svg-path/svg-path-model';

describe('dToElementAttrs — path d to native element attributes', () => {
  test('path tag returns d as-is', () => {
    expect(dToElementAttrs('path', 'M0,0 L100,100')).toEqual({ d: 'M0,0 L100,100' });
  });

  test('path tag with complex d string', () => {
    const d = 'M10,30 A20,20,0,0,1,50,30 Z';
    expect(dToElementAttrs('path', d)).toEqual({ d });
  });

  test('line tag extracts x1/y1/x2/y2 from M...L... path', () => {
    const result = dToElementAttrs('line', 'M 5 10 L 20 30');
    expect(result).toEqual({ x1: '5', y1: '10', x2: '20', y2: '30' });
  });

  test('line tag with integer coordinates', () => {
    const result = dToElementAttrs('line', 'M 0 0 L 100 200');
    expect(result).toEqual({ x1: '0', y1: '0', x2: '100', y2: '200' });
  });

  test('polygon tag extracts points without trailing Z segment', () => {
    const result = dToElementAttrs('polygon', 'M 0 0 L 10 0 L 10 10 Z');
    expect(result).toHaveProperty('points');
    // Should contain 3 coordinate pairs (the Z close is not a point)
    const pts = result.points!.split(' ');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toBe('0,0');
    expect(pts[1]).toBe('10,0');
    expect(pts[2]).toBe('10,10');
  });

  test('polyline tag extracts points (no Z)', () => {
    const result = dToElementAttrs('polyline', 'M 0 0 L 10 0 L 10 10');
    expect(result).toHaveProperty('points');
    const pts = result.points!.split(' ');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toBe('0,0');
    expect(pts[1]).toBe('10,0');
    expect(pts[2]).toBe('10,10');
  });

  test('polygon with many points', () => {
    const result = dToElementAttrs('polygon', 'M 0 0 L 50 0 L 50 50 L 0 50 Z');
    const pts = result.points!.split(' ');
    expect(pts).toHaveLength(4);
    expect(pts[0]).toBe('0,0');
    expect(pts[3]).toBe('0,50');
  });

  test('rect tag falls back to d (may be deformed)', () => {
    const d = 'M 0 0 L 100 0 L 100 50 L 0 50 Z';
    const result = dToElementAttrs('rect', d);
    expect(result).toEqual({ d });
  });

  test('circle tag falls back to d (may be deformed)', () => {
    const d = 'M -10 0 C -10 -5.52 -5.52 -10 0 -10';
    const result = dToElementAttrs('circle', d);
    expect(result).toEqual({ d });
  });

  test('ellipse tag falls back to d', () => {
    const d = 'M -20 0 C -20 -11.05 -11.05 -20 0 -20';
    const result = dToElementAttrs('ellipse', d);
    expect(result).toEqual({ d });
  });

  test('unknown tag returns d', () => {
    const d = 'M0,0 L50,50';
    // An unrecognized tag is not in the switch, so it should return { d }
    expect(dToElementAttrs('g', d)).toEqual({ d });
  });
});

// ─── dToElementAttrs round-trip tests ───────────────────────────────────────

describe('dToElementAttrs — round-trip conversions', () => {
  test('polygon points "0,0 10,0 10,10" round-trips through d and back', () => {
    // Simulate what elementToD does for a polygon: points → d string
    // polygonToD: "0,0 10,0 10,10" → "M0,0 L10,0 L10,10 Z"
    const d = 'M0,0 L10,0 L10,10 Z';
    const result = dToElementAttrs('polygon', d);
    expect(result).toHaveProperty('points');
    expect(result.points).toBe('0,0 10,0 10,10');
  });

  test('polygon with decimal coordinates round-trips', () => {
    const d = 'M1.5,2.5 L10.5,0 L10.5,10.5 Z';
    const result = dToElementAttrs('polygon', d);
    expect(result).toHaveProperty('points');
    expect(result.points).toBe('1.5,2.5 10.5,0 10.5,10.5');
  });

  test('line x1/y1/x2/y2 round-trips through d and back', () => {
    // Simulate what elementToD does for a line: attrs → d string
    // lineToD: x1=5, y1=10, x2=95, y2=80 → "M5,10 L95,80"
    const d = 'M5,10 L95,80';
    const result = dToElementAttrs('line', d);
    expect(result).toEqual({ x1: '5', y1: '10', x2: '95', y2: '80' });
  });

  test('line with zero coordinates round-trips', () => {
    const d = 'M0,0 L0,0';
    const result = dToElementAttrs('line', d);
    expect(result).toEqual({ x1: '0', y1: '0', x2: '0', y2: '0' });
  });

  test('line with negative coordinates round-trips', () => {
    const d = 'M-10,-20 L30,40';
    const result = dToElementAttrs('line', d);
    expect(result).toEqual({ x1: '-10', y1: '-20', x2: '30', y2: '40' });
  });

  test('polyline points round-trip (no closing Z)', () => {
    const d = 'M0,0 L50,0 L50,50 L0,50';
    const result = dToElementAttrs('polyline', d);
    expect(result).toHaveProperty('points');
    expect(result.points).toBe('0,0 50,0 50,50 0,50');
  });

  test('polygon square round-trips correctly', () => {
    // A square polygon: 4 points + Z close
    const d = 'M0,0 L100,0 L100,100 L0,100 Z';
    const result = dToElementAttrs('polygon', d);
    expect(result.points).toBe('0,0 100,0 100,100 0,100');
  });

  test('path d passes through unchanged', () => {
    const d = 'M0,0 C10,20,30,40,50,60 Q70,80,90,100 Z';
    const result = dToElementAttrs('path', d);
    expect(result).toEqual({ d });
  });
});

import { pathDToCss, cssDToPath, elementToD } from '@/shared/svg-path/svg-path-parser';

describe('CSS `d` helpers (per-tile geometry override format)', () => {
  it('pathDToCss wraps a d into path("…")', () => {
    expect(pathDToCss('M0,0 L10,10 Z')).toBe('path("M0,0 L10,10 Z")');
    expect(pathDToCss('  ')).toBe(''); // empty → no override
  });
  it('cssDToPath round-trips and passes a bare d through', () => {
    expect(cssDToPath('path("M0,0 L10,10 Z")')).toBe('M0,0 L10,10 Z');
    expect(cssDToPath("path('M1,1 Z')")).toBe('M1,1 Z');
    expect(cssDToPath('M2,2 Z')).toBe('M2,2 Z'); // already raw
    expect(cssDToPath(pathDToCss('M3,3 L4,4 Z'))).toBe('M3,3 L4,4 Z');
  });
});

describe('elementToD — polygon→path normalization (per-tile geometry foundation)', () => {
  it('converts a polygon to a closed path d', () => {
    const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 10,0 5,10" /></svg>', 'image/svg+xml');
    const poly = doc.querySelector('polygon')!;
    expect(elementToD(poly)).toBe('M0,0 L10,0 L5,10 Z');
  });
});
