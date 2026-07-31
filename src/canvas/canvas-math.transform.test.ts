import { describe, it, expect, vi } from 'vitest';
import { getTransformedPoint } from './canvas-math';

// jsdom ships no CSS geometry interfaces — without these stubs the product's
// try/catch fallback in getTransformedPoint swallows the ReferenceError and
// returns every point untransformed (browser behavior is the reference).
// Minimal 2D implementations of exactly what the product uses:
// `new DOMMatrix('<transform-list>')` + `new DOMPoint(x, y, z, w).matrixTransform(m)`.
class TestDOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(transformList?: string) {
    if (!transformList || transformList === 'none') return;
    const m = /^matrix\(([^)]+)\)$/.exec(transformList.trim());
    if (!m) throw new SyntaxError(`TestDOMMatrix: unsupported transform list "${transformList}"`);
    [this.a, this.b, this.c, this.d, this.e, this.f] = m[1].split(',').map(Number);
  }
}
class TestDOMPoint {
  constructor(
    public x = 0, public y = 0, public z = 0, public w = 1,
  ) {}
  matrixTransform(m: TestDOMMatrix): TestDOMPoint {
    return new TestDOMPoint(
      m.a * this.x + m.c * this.y + m.e * this.w,
      m.b * this.x + m.d * this.y + m.f * this.w,
      this.z,
      this.w,
    );
  }
}
vi.stubGlobal('DOMMatrix', TestDOMMatrix);
vi.stubGlobal('DOMPoint', TestDOMPoint);

describe('getTransformedPoint', () => {
  it('returns original point for no transform', () => {
    const result = getTransformedPoint(50, 50, { x: 0, y: 0, width: 100, height: 100 }, 'none');
    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
  });

  it('returns original point for identity matrix', () => {
    const result = getTransformedPoint(50, 50, { x: 0, y: 0, width: 100, height: 100 }, 'matrix(1, 0, 0, 1, 0, 0)');
    expect(result.x).toBeCloseTo(50);
    expect(result.y).toBeCloseTo(50);
  });

  it('handles 90 degree rotation correctly', () => {
    // matrix(0, 1, -1, 0, 0, 0) = 90° rotation
    // Point (100, 50) relative to center (50, 50) = (50, 0)
    // After 90° rotation: (0, 50) + center = (50, 100)
    const result = getTransformedPoint(100, 50, { x: 0, y: 0, width: 100, height: 100 }, 'matrix(0, 1, -1, 0, 0, 0)');
    expect(result.x).toBeCloseTo(50);
    expect(result.y).toBeCloseTo(100);
  });

  it('handles 45 degree rotation correctly', () => {
    // cos(45°) ≈ 0.707, sin(45°) ≈ 0.707
    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);
    const matrix = `matrix(${cos45}, ${sin45}, ${-sin45}, ${cos45}, 0, 0)`;

    // Top-right corner (100, 0) relative to center (50, 50) = (50, -50)
    // After 45° rotation: (50*cos45 - (-50)*sin45, 50*sin45 + (-50)*cos45) = (70.7, 0) + center = (120.7, 50)
    const result = getTransformedPoint(100, 0, { x: 0, y: 0, width: 100, height: 100 }, matrix);
    expect(result.x).toBeCloseTo(120.71, 0);
    expect(result.y).toBeCloseTo(50, 0);
  });

  it('handles scale transform', () => {
    // matrix(2, 0, 0, 2, 0, 0) = 2x scale
    // Point (75, 50) relative to center (50, 50) = (25, 0)
    // After 2x scale: (50, 0) + center = (100, 50)
    const result = getTransformedPoint(75, 50, { x: 0, y: 0, width: 100, height: 100 }, 'matrix(2, 0, 0, 2, 0, 0)');
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(50);
  });

  it('handles element with offset position', () => {
    // Element at (200, 100), center at (250, 150)
    const result = getTransformedPoint(300, 200, { x: 200, y: 100, width: 100, height: 100 }, 'matrix(1, 0, 0, 1, 0, 0)');
    expect(result.x).toBeCloseTo(300);
    expect(result.y).toBeCloseTo(200);
  });
});
