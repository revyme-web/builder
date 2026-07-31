import { describe, test, expect } from 'vitest';
import { cornersEqual, type ScreenCorners } from '../resize/geometry-utils';

// ─── cornersEqual ──────────────────────────────────────────────────────────

describe('cornersEqual', () => {
  const makeCorners = (tlx: number, tly: number, trx: number, try_: number,
    brx: number, bry: number, blx: number, bly: number): ScreenCorners => ({
    TL: { x: tlx, y: tly },
    TR: { x: trx, y: try_ },
    BR: { x: brx, y: bry },
    BL: { x: blx, y: bly },
  });

  test('both null returns true', () => {
    expect(cornersEqual(null, null)).toBe(true);
  });

  test('one null returns false', () => {
    const c = makeCorners(0, 0, 100, 0, 100, 50, 0, 50);
    expect(cornersEqual(null, c)).toBe(false);
    expect(cornersEqual(c, null)).toBe(false);
  });

  test('same reference returns true', () => {
    const c = makeCorners(0, 0, 100, 0, 100, 50, 0, 50);
    expect(cornersEqual(c, c)).toBe(true);
  });

  test('identical corners returns true', () => {
    const a = makeCorners(10, 20, 110, 20, 110, 70, 10, 70);
    const b = makeCorners(10, 20, 110, 20, 110, 70, 10, 70);
    expect(cornersEqual(a, b)).toBe(true);
  });

  test('corners within tolerance (0.5) returns true', () => {
    const a = makeCorners(10, 20, 110, 20, 110, 70, 10, 70);
    const b = makeCorners(10.4, 20.3, 110.1, 19.8, 109.7, 70.2, 10.3, 69.6);
    expect(cornersEqual(a, b)).toBe(true);
  });

  test('corners outside tolerance returns false', () => {
    const a = makeCorners(10, 20, 110, 20, 110, 70, 10, 70);
    const b = makeCorners(10.6, 20, 110, 20, 110, 70, 10, 70); // TL.x off by 0.6
    expect(cornersEqual(a, b)).toBe(false);
  });

  test('single corner difference detected', () => {
    const a = makeCorners(0, 0, 100, 0, 100, 100, 0, 100);
    // Only BR differs
    const b = makeCorners(0, 0, 100, 0, 101, 100, 0, 100);
    expect(cornersEqual(a, b)).toBe(false);
  });

  test('BL corner difference detected', () => {
    const a = makeCorners(0, 0, 100, 0, 100, 100, 0, 100);
    const b = makeCorners(0, 0, 100, 0, 100, 100, 0, 101);
    expect(cornersEqual(a, b)).toBe(false);
  });
});
