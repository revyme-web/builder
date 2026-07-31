import { describe, it, expect } from 'vitest';
import { scalePathD, scalePoints, scaleShapeGeometry, translatePathD, translatePoints, translateShapeGeometry, geometryBBox, rotatedGeometryBBox, ellipsePathD } from '@/shared/svg-geometry';

describe('translatePathD / translatePoints (re-base geometry to origin)', () => {
  it('shifts absolute M/L coords by (dx, dy)', () => {
    expect(translatePathD('M 78 0 L 156 313 L 229 -67 z', -78, 67)).toBe('M 0 67 L 78 380 L 151 0 z');
  });
  it('shifts cubic control points too', () => {
    expect(translatePathD('M 10 10 C 20 20 30 30 40 40', -10, -10)).toBe('M 0 0 C 10 10 20 20 30 30');
  });
  it('leaves relative (lowercase) deltas unchanged, shifting only the absolute start', () => {
    expect(translatePathD('M 10 10 l 5 5', -10, -10)).toBe('M 0 0 l 5 5');
  });
  it('translatePoints shifts each pair', () => {
    expect(translatePoints('78,0 156,313 229,-67', -78, 67)).toBe('0,67 78,380 151,0');
  });
  it('translateShapeGeometry dispatches by tag', () => {
    expect(translateShapeGeometry('polygon', { points: '10,10 20,20' }, -10, -10)).toEqual({ points: '0,0 10,10' });
    expect(translateShapeGeometry('rect', { x: '5', y: '8' }, -5, -8)).toEqual({ x: '0', y: '0' });
  });
});

describe('scalePathD', () => {
  it('scales M/L/Z coordinates by (sx, sy)', () => {
    expect(scalePathD('M0,0 L100,50 Z', 2, 3)).toBe('M 0 0 L 200 150 Z');
  });

  it('scales cubic bézier control points', () => {
    // every C param is an alternating x/y
    expect(scalePathD('M10,10 C20,20 30,30 40,40', 2, 0.5)).toBe(
      'M 20 5 C 40 10 60 15 80 20',
    );
  });

  it('scales H by sx and V by sy only', () => {
    expect(scalePathD('M0,0 H100 V100', 3, 4)).toBe('M 0 0 H 300 V 400');
  });

  it('leaves arc rotation + flags untouched, scales rx/ry/endpoint', () => {
    // A: rx ry x-axis-rotation large-arc sweep x y
    expect(scalePathD('M0,0 A10,20 45 0 1 30,40', 2, 3)).toBe(
      'M 0 0 A 20 60 45 0 1 60 120',
    );
  });
});

describe('scalePoints', () => {
  it('scales a comma+space points list', () => {
    expect(scalePoints('0,0 100,0 50,80', 2, 0.5)).toBe('0,0 200,0 100,40');
  });

  it('scales a space-only points list', () => {
    expect(scalePoints('10 10 20 30', 3, 3)).toBe('30,30 60,90');
  });
});

describe('scaleShapeGeometry', () => {
  it('scales a polygon (triangle)', () => {
    const out = scaleShapeGeometry('polygon', { points: '276,0 552,515 0,515' }, 1.5, 1);
    expect(out).toEqual({ points: '414,0 828,515 0,515' });
  });

  it('scales a path d', () => {
    const out = scaleShapeGeometry('path', { d: 'M0,0 L10,10 Z' }, 2, 2);
    expect(out).toEqual({ d: 'M 0 0 L 20 20 Z' });
  });

  it('scales rect geometry attrs', () => {
    const out = scaleShapeGeometry('rect', { x: '5', y: '10', width: '100', height: '50' }, 2, 3);
    expect(out).toEqual({ x: '10', y: '30', width: '200', height: '150' });
  });

  it('scales ellipse radii and center', () => {
    const out = scaleShapeGeometry('ellipse', { cx: '50', cy: '40', rx: '50', ry: '40' }, 1.2, 1);
    expect(out).toEqual({ cx: '60', cy: '40', rx: '60', ry: '40' });
  });

  it('ignores missing geometry attrs', () => {
    expect(scaleShapeGeometry('path', {}, 2, 2)).toEqual({});
    expect(scaleShapeGeometry('polygon', { points: undefined }, 2, 2)).toEqual({});
  });

  it('PRESERVES percentage ellipse attrs (they scale with the viewBox, not baked)', () => {
    // A `<ellipse cx="50%" rx="50%">` is relative to its <svg>'s viewBox, which
    // already scales during a group resize — baking it dropped the `%` and
    // collapsed the circle (50% → literal 50 → ×factor → tiny). Must be untouched.
    const out = scaleShapeGeometry('ellipse', { cx: '50%', cy: '50%', rx: '50%', ry: '50%' }, 1.178, 1);
    expect(out).toEqual({});
  });

  it('mixes: scales absolute attrs but leaves percentage ones alone', () => {
    const out = scaleShapeGeometry('rect', { x: '10', y: '0%', width: '100%', height: '50' }, 2, 3);
    expect(out).toEqual({ x: '20', height: '150' });
  });
});

describe('geometryBBox — percentage geometry has no absolute bbox (refit must skip)', () => {
  it('returns null for a percentage ellipse (don\'t shrink-wrap to 2×50=100)', () => {
    expect(geometryBBox('ellipse', { cx: '50%', cy: '50%', rx: '50%', ry: '50%' })).toBeNull();
  });
  it('returns null for a percentage circle', () => {
    expect(geometryBBox('circle', { cx: '50%', cy: '50%', r: '50%' })).toBeNull();
  });
  it('still computes an absolute ellipse bbox', () => {
    expect(geometryBBox('ellipse', { cx: '50', cy: '40', rx: '50', ry: '40' }))
      .toEqual({ x: 0, y: 0, width: 100, height: 80 });
  });
});

describe('ellipsePathD — standard bézier ellipse (absolute coords, geometry-safe)', () => {
  it('is a closed path whose bbox is the full box (tight, no %)', () => {
    const d = ellipsePathD(100, 100);
    expect(d.startsWith('M')).toBe(true);
    expect(d.trim().endsWith('Z')).toBe(true);
    const bb = geometryBBox('path', { d })!;
    expect(bb.x).toBeCloseTo(0, 1);
    expect(bb.y).toBeCloseTo(0, 1);
    expect(bb.width).toBeCloseTo(100, 1);
    expect(bb.height).toBeCloseTo(100, 1);
  });
  it('scales with the box like any path (group resize)', () => {
    const scaled = scaleShapeGeometry('path', { d: ellipsePathD(100, 100) }, 2, 3);
    const bb = geometryBBox('path', { d: scaled.d })!;
    expect(bb.width).toBeCloseTo(200, 1);
    expect(bb.height).toBeCloseTo(300, 1);
  });
  it('non-square ellipse keeps its aspect', () => {
    const bb = geometryBBox('path', { d: ellipsePathD(353, 397) })!;
    expect(bb.width).toBeCloseTo(353, 1);
    expect(bb.height).toBeCloseTo(397, 1);
  });
  it('rotated circle bound stays tight (on-curve samples, not control-point hull)', () => {
    // A circle's AABB is rotation-invariant. Sampling ON the curve keeps the
    // rotated bound ~100×100; the bézier CONTROL-POINT hull would rotate out to
    // ~141×141 (the box corners) — the whitespace the user saw on the group box.
    const b = rotatedGeometryBBox('path', { d: ellipsePathD(100, 100) }, 45, 50, 50)!;
    expect(b.width).toBeGreaterThan(98);
    expect(b.width).toBeLessThan(108);
    expect(b.height).toBeLessThan(108);
  });
});

describe('translateShapeGeometry — leaves percentage centers alone', () => {
  it('does not bake a percentage ellipse center to absolute', () => {
    const out = translateShapeGeometry('ellipse', { cx: '50%', cy: '50%' }, 10, 20);
    expect(out).toEqual({});
  });
  it('translates an absolute ellipse center', () => {
    const out = translateShapeGeometry('ellipse', { cx: '50', cy: '40' }, 10, 20);
    expect(out).toEqual({ cx: '60', cy: '60' });
  });
});

describe('geometryBBox', () => {
  it('path with absolute L lines (reshape output) is exact', () => {
    const b = geometryBBox('path', { d: 'M-142.92705 920.51006L588 306L0 306z' });
    expect(b!.x).toBeCloseTo(-142.92705, 3);
    expect(b!.y).toBeCloseTo(306, 3);
    expect(b!.width).toBeCloseTo(730.92705, 3);
    expect(b!.height).toBeCloseTo(614.51006, 3);
  });

  it('path with relative commands resolves to absolute positions', () => {
    // M 10 10 l 20 0 l 0 30 z → points (10,10),(30,10),(30,40)
    const b = geometryBBox('path', { d: 'M10 10 l20 0 l0 30 z' });
    expect(b).toEqual({ x: 10, y: 10, width: 20, height: 30 });
  });

  it('path H/V commands', () => {
    const b = geometryBBox('path', { d: 'M0 0 H100 V50 z' });
    expect(b).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('polygon points', () => {
    expect(geometryBBox('polygon', { points: '148,0 296,302 0,302' }))
      .toEqual({ x: 0, y: 0, width: 296, height: 302 });
  });

  it('rect / ellipse / circle / line', () => {
    expect(geometryBBox('rect', { x: '5', y: '8', width: '100', height: '50' })).toEqual({ x: 5, y: 8, width: 100, height: 50 });
    expect(geometryBBox('ellipse', { cx: '50', cy: '40', rx: '50', ry: '40' })).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(geometryBBox('circle', { cx: '30', cy: '30', r: '30' })).toEqual({ x: 0, y: 0, width: 60, height: 60 });
    expect(geometryBBox('line', { x1: '10', y1: '20', x2: '40', y2: '5' })).toEqual({ x: 10, y: 5, width: 30, height: 15 });
  });

  it('returns null for empty / missing geometry', () => {
    expect(geometryBBox('path', {})).toBeNull();
    expect(geometryBBox('polygon', { points: '' })).toBeNull();
  });
});

describe('rotatedGeometryBBox', () => {
  it('bboxes the geometry after rotating its vertices around the pivot', () => {
    // triangle (0,0)(10,0)(10,10) rotated 90deg around (0,0):
    //  (0,0)->(0,0), (10,0)->(0,10), (10,10)->(-10,10)
    const b = rotatedGeometryBBox('polygon', { points: '0,0 10,0 10,10' }, 90, 0, 0)!;
    expect(b.x).toBeCloseTo(-10, 3);
    expect(b.y).toBeCloseTo(0, 3);
    expect(b.width).toBeCloseTo(10, 3);
    expect(b.height).toBeCloseTo(10, 3);
  });
  it('0 deg equals the plain geometry bbox', () => {
    expect(rotatedGeometryBBox('polygon', { points: '0,0 10,0 10,10' }, 0, 5, 5))
      .toEqual(geometryBBox('polygon', { points: '0,0 10,0 10,10' }));
  });
});
