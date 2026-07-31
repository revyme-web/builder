import { describe, test, expect } from 'vitest';
import {
  parseClipPath,
  formatClipPath,
  createDefaultClipPath,
  CLIPPATH_PRESETS,
  presetToPoints,
  pct,
  type CSSVal,
} from '@/shared/clippath-utils';

/** Helper: extract raw [number, number][] from CSSVal points for easier assertions */
function rawPts(points: [CSSVal, CSSVal][]): [number, number][] {
  return points.map(([x, y]) => [x.v, y.v]);
}

describe('parseClipPath', () => {
  test('returns null for empty/none', () => {
    expect(parseClipPath(undefined)).toBeNull();
    expect(parseClipPath('')).toBeNull();
    expect(parseClipPath('none')).toBeNull();
  });

  // ── Polygon ──
  test('parses simple polygon (triangle)', () => {
    const r = parseClipPath('polygon(50% 0%, 0% 100%, 100% 100%)');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('polygon');
    expect(rawPts(r!.points)).toEqual([[50, 0], [0, 100], [100, 100]]);
  });

  test('parses polygon without % suffix', () => {
    const r = parseClipPath('polygon(50 0, 0 100, 100 100)');
    expect(rawPts(r!.points)).toEqual([[50, 0], [0, 100], [100, 100]]);
  });

  test('parses complex polygon (star)', () => {
    const r = parseClipPath('polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)');
    expect(r!.type).toBe('polygon');
    expect(r!.points).toHaveLength(10);
  });

  test('parses polygon with decimal values', () => {
    const r = parseClipPath('polygon(50.5% 0.5%, 0% 99.9%)');
    expect(rawPts(r!.points)).toEqual([[50.5, 0.5], [0, 99.9]]);
  });

  test('parses polygon with mixed px and % units', () => {
    const r = parseClipPath('polygon(0 30px, 5% 0, 10% 25px, 100% 30px, 100% 100%, 0 100%)');
    expect(r!.points).toHaveLength(6);
    expect(r!.points[0][1].unit).toBe('px'); // 30px
    expect(r!.points[0][1].v).toBe(30);
    expect(r!.points[1][0].unit).toBe('%');  // 5%
    expect(r!.points[1][1].unit).toBe('%');  // 0 (no unit = %)
  });

  test('roundtrips polygon with mixed units', () => {
    const css = 'polygon(0% 30px, 5% 0%, 10% 25px)';
    const parsed = parseClipPath(css);
    const formatted = formatClipPath(parsed!);
    expect(formatted).toBe(css);
  });

  // ── Circle ──
  test('parses circle with position', () => {
    const r = parseClipPath('circle(50% at 50% 50%)');
    expect(r!.type).toBe('circle');
    expect(r!.radius).toBe(50);
    expect(r!.centerX).toBe(50);
    expect(r!.centerY).toBe(50);
  });

  test('parses circle without position', () => {
    const r = parseClipPath('circle(30%)');
    expect(r!.type).toBe('circle');
    expect(r!.radius).toBe(30);
    expect(r!.centerX).toBe(50);
    expect(r!.centerY).toBe(50);
  });

  test('parses circle with offset position', () => {
    const r = parseClipPath('circle(40% at 25% 75%)');
    expect(r!.radius).toBe(40);
    expect(r!.centerX).toBe(25);
    expect(r!.centerY).toBe(75);
  });

  // ── Ellipse ──
  test('parses ellipse with position', () => {
    const r = parseClipPath('ellipse(60% 40% at 50% 50%)');
    expect(r!.type).toBe('ellipse');
    expect(r!.radiusX).toBe(60);
    expect(r!.radiusY).toBe(40);
    expect(r!.centerX).toBe(50);
    expect(r!.centerY).toBe(50);
  });

  test('parses ellipse without position', () => {
    const r = parseClipPath('ellipse(25% 40%)');
    expect(r!.type).toBe('ellipse');
    expect(r!.radiusX).toBe(25);
    expect(r!.radiusY).toBe(40);
    expect(r!.centerX).toBe(50);
    expect(r!.centerY).toBe(50);
  });

  // ── Inset ──
  test('parses inset with 4 values', () => {
    const r = parseClipPath('inset(10% 20% 30% 40%)');
    expect(r!.type).toBe('inset');
    expect(r!.top).toBe(10);
    expect(r!.right).toBe(20);
    expect(r!.bottom).toBe(30);
    expect(r!.left).toBe(40);
    expect(r!.round).toBe(0);
  });

  test('parses inset with round', () => {
    const r = parseClipPath('inset(10% 20% 10% 20% round 8px)');
    expect(r!.top).toBe(10);
    expect(r!.right).toBe(20);
    expect(r!.round).toBe(8);
  });

  test('parses inset shorthand (1 value)', () => {
    const r = parseClipPath('inset(15%)');
    expect(r!.top).toBe(15);
    expect(r!.right).toBe(15);
    expect(r!.bottom).toBe(15);
    expect(r!.left).toBe(15);
  });

  test('parses inset shorthand (2 values)', () => {
    const r = parseClipPath('inset(10% 20%)');
    expect(r!.top).toBe(10);
    expect(r!.right).toBe(20);
    expect(r!.bottom).toBe(10);
    expect(r!.left).toBe(20);
  });

  test('parses inset shorthand (3 values)', () => {
    const r = parseClipPath('inset(10% 20% 30%)');
    expect(r!.top).toBe(10);
    expect(r!.right).toBe(20);
    expect(r!.bottom).toBe(30);
    expect(r!.left).toBe(20);
  });
});

describe('formatClipPath', () => {
  test('formats polygon', () => {
    const r = formatClipPath(createDefaultClipPath('polygon'));
    expect(r).toBe('polygon(50% 0%, 0% 100%, 100% 100%)');
  });

  test('formats circle', () => {
    const d = createDefaultClipPath('circle');
    const r = formatClipPath(d);
    expect(r).toBe('circle(50% at 50% 50%)');
  });

  test('formats ellipse', () => {
    const d = createDefaultClipPath('ellipse');
    const r = formatClipPath(d);
    expect(r).toBe('ellipse(50% 40% at 50% 50%)');
  });

  test('formats inset without round', () => {
    const d = createDefaultClipPath('inset');
    const r = formatClipPath(d);
    expect(r).toBe('inset(10% 10% 10% 10%)');
  });

  test('formats inset with round', () => {
    const d = { ...createDefaultClipPath('inset'), round: 12 };
    const r = formatClipPath(d);
    expect(r).toBe('inset(10% 10% 10% 10% round 12px)');
  });

  test('formats decimal values cleanly', () => {
    const d = createDefaultClipPath('polygon');
    d.points = [[pct(33.33), pct(0)], [pct(0), pct(66.67)], [pct(100), pct(66.67)]];
    expect(formatClipPath(d)).toBe('polygon(33.33% 0%, 0% 66.67%, 100% 66.67%)');
  });
});

describe('roundtrip', () => {
  test('polygon roundtrip', () => {
    const css = 'polygon(50% 0%, 0% 100%, 100% 100%)';
    const parsed = parseClipPath(css);
    expect(formatClipPath(parsed!)).toBe(css);
  });

  test('circle roundtrip', () => {
    const css = 'circle(40% at 25% 75%)';
    const parsed = parseClipPath(css);
    expect(formatClipPath(parsed!)).toBe(css);
  });

  test('ellipse roundtrip', () => {
    const css = 'ellipse(60% 40% at 30% 70%)';
    const parsed = parseClipPath(css);
    expect(formatClipPath(parsed!)).toBe(css);
  });

  test('inset roundtrip', () => {
    const css = 'inset(10% 20% 30% 40%)';
    const parsed = parseClipPath(css);
    expect(formatClipPath(parsed!)).toBe(css);
  });

  test('inset with round roundtrip', () => {
    const css = 'inset(5% 10% 5% 10% round 16px)';
    const parsed = parseClipPath(css);
    expect(formatClipPath(parsed!)).toBe(css);
  });
});

describe('presets', () => {
  test('all presets parse and roundtrip', () => {
    for (const preset of CLIPPATH_PRESETS) {
      const d = createDefaultClipPath('polygon');
      d.points = presetToPoints(preset.points);
      const css = formatClipPath(d);
      const parsed = parseClipPath(css);
      expect(parsed).not.toBeNull();
      expect(rawPts(parsed!.points)).toEqual(preset.points);
    }
  });

  test('presets have unique names', () => {
    const names = CLIPPATH_PRESETS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('createDefaultClipPath', () => {
  test('polygon default is triangle', () => {
    const d = createDefaultClipPath('polygon');
    expect(d.points).toHaveLength(3);
  });

  test('circle default is centered', () => {
    const d = createDefaultClipPath('circle');
    expect(d.centerX).toBe(50);
    expect(d.centerY).toBe(50);
  });
});
