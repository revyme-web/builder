import { describe, test, expect } from 'vitest';
import {
  parseRotationFromMatrix,
  buildRotationTransform,
  snapRotation,
  calculateRotationAngle,
  mergeRotation,
  parseSvgRotate,
  buildSvgRotate,
  mergeSvgRotate,
} from './RotateManager';

// ─── parseRotationFromMatrix ────────────────────────────────────────────────

describe('parseRotationFromMatrix', () => {
  test('null returns 0', () => {
    expect(parseRotationFromMatrix(null)).toBe(0);
  });

  test('undefined returns 0', () => {
    expect(parseRotationFromMatrix(undefined)).toBe(0);
  });

  test('"none" returns 0', () => {
    expect(parseRotationFromMatrix('none')).toBe(0);
  });

  test('empty string returns 0', () => {
    expect(parseRotationFromMatrix('')).toBe(0);
  });

  test('identity matrix returns 0', () => {
    expect(parseRotationFromMatrix('matrix(1, 0, 0, 1, 0, 0)')).toBe(0);
  });

  test('90 degree rotation', () => {
    // matrix(cos90, sin90, -sin90, cos90, 0, 0) = matrix(0, 1, -1, 0, 0, 0)
    const result = parseRotationFromMatrix('matrix(0, 1, -1, 0, 0, 0)');
    expect(result).toBeCloseTo(90);
  });

  test('45 degree rotation', () => {
    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);
    const result = parseRotationFromMatrix(`matrix(${cos45}, ${sin45}, ${-sin45}, ${cos45}, 0, 0)`);
    expect(result).toBeCloseTo(45);
  });

  test('-45 degree rotation', () => {
    const cos45 = Math.cos(-Math.PI / 4);
    const sin45 = Math.sin(-Math.PI / 4);
    const result = parseRotationFromMatrix(`matrix(${cos45}, ${sin45}, ${-sin45}, ${cos45}, 0, 0)`);
    expect(result).toBeCloseTo(-45);
  });

  test('180 degree rotation', () => {
    const result = parseRotationFromMatrix('matrix(-1, 0, 0, -1, 0, 0)');
    expect(result).toBeCloseTo(180);
  });

  test('matrix with translation (ignored for rotation)', () => {
    // Identity rotation with translation
    const result = parseRotationFromMatrix('matrix(1, 0, 0, 1, 100, 200)');
    expect(result).toBe(0);
  });

  test('invalid matrix format returns 0', () => {
    expect(parseRotationFromMatrix('translate(10px, 20px)')).toBe(0);
  });

  test('matrix with insufficient values returns 0', () => {
    expect(parseRotationFromMatrix('matrix(1)')).toBe(0);
  });
});

// ─── buildRotationTransform ─────────────────────────────────────────────────

describe('buildRotationTransform', () => {
  test('0 degrees returns empty string', () => {
    expect(buildRotationTransform(0)).toBe('');
  });

  test('90 degrees', () => {
    expect(buildRotationTransform(90)).toBe('rotate(90deg)');
  });

  test('45 degrees', () => {
    expect(buildRotationTransform(45)).toBe('rotate(45deg)');
  });

  test('-30 degrees', () => {
    expect(buildRotationTransform(-30)).toBe('rotate(-30deg)');
  });

  test('rounds to 1 decimal place', () => {
    expect(buildRotationTransform(45.678)).toBe('rotate(45.7deg)');
  });

  test('fractional rounding: 22.34 → 22.3', () => {
    expect(buildRotationTransform(22.34)).toBe('rotate(22.3deg)');
  });

  test('360 degrees', () => {
    expect(buildRotationTransform(360)).toBe('rotate(360deg)');
  });
});

// ─── snapRotation ───────────────────────────────────────────────────────────

describe('snapRotation', () => {
  test('exact 15 degree increments unchanged', () => {
    expect(snapRotation(0)).toBe(0);
    expect(snapRotation(15)).toBe(15);
    expect(snapRotation(30)).toBe(30);
    expect(snapRotation(45)).toBe(45);
    expect(snapRotation(90)).toBe(90);
    expect(snapRotation(180)).toBe(180);
    expect(snapRotation(360)).toBe(360);
  });

  test('rounds down to nearest 15', () => {
    expect(snapRotation(7)).toBe(0);
    expect(snapRotation(22)).toBe(15);
    expect(snapRotation(37)).toBe(30);
  });

  test('rounds up to nearest 15', () => {
    expect(snapRotation(8)).toBe(15);
    expect(snapRotation(23)).toBe(30);
    expect(snapRotation(38)).toBe(45);
  });

  test('negative angles', () => {
    expect(snapRotation(-7)).toBe(-0); // Math.round(-7/15)*15 = -0
    expect(snapRotation(-8)).toBe(-15);
    expect(snapRotation(-22)).toBe(-15);
    expect(snapRotation(-23)).toBe(-30);
  });

  test('midpoint rounds to nearest', () => {
    // 7.5 rounds to 15 (Math.round rounds .5 up)
    expect(snapRotation(7.5)).toBe(15);
  });
});

// ─── calculateRotationAngle ─────────────────────────────────────────────────

describe('calculateRotationAngle', () => {
  test('pointer directly to the right = 0 radians', () => {
    expect(calculateRotationAngle(100, 100, 200, 100)).toBeCloseTo(0);
  });

  test('pointer directly below = π/2 radians', () => {
    expect(calculateRotationAngle(100, 100, 100, 200)).toBeCloseTo(Math.PI / 2);
  });

  test('pointer directly to the left = π radians', () => {
    expect(Math.abs(calculateRotationAngle(100, 100, 0, 100))).toBeCloseTo(Math.PI);
  });

  test('pointer directly above = -π/2 radians', () => {
    expect(calculateRotationAngle(100, 100, 100, 0)).toBeCloseTo(-Math.PI / 2);
  });

  test('pointer at 45 degrees (bottom-right)', () => {
    expect(calculateRotationAngle(0, 0, 100, 100)).toBeCloseTo(Math.PI / 4);
  });

  test('pointer at center returns 0', () => {
    expect(calculateRotationAngle(100, 100, 100, 100)).toBe(0);
  });
});

// ─── mergeRotation ──────────────────────────────────────────────────────────

describe('mergeRotation', () => {
  test('preserves translateY(-50%) when adding rotation', () => {
    const result = mergeRotation('translateY(-50%)', 45);
    expect(result).toBe('translateY(-50%) rotate(45deg)');
  });

  test('preserves translateX(-50%) when adding rotation', () => {
    const result = mergeRotation('translateX(-50%)', 90);
    expect(result).toBe('translateX(-50%) rotate(90deg)');
  });

  test('preserves translate(-50%, -50%) when adding rotation', () => {
    const result = mergeRotation('translate(-50%, -50%)', 30);
    expect(result).toBe('translate(-50%, -50%) rotate(30deg)');
  });

  test('replaces existing rotation but keeps translate', () => {
    const result = mergeRotation('translateY(-50%) rotate(10deg)', 45);
    expect(result).toBe('translateY(-50%) rotate(45deg)');
  });

  test('replaces existing rotation and keeps multiple transforms', () => {
    const result = mergeRotation('translateX(-50%) rotate(10deg) scale(2)', 90);
    expect(result).toBe('translateX(-50%) scale(2) rotate(90deg)');
  });

  test('empty existing transform returns just rotation', () => {
    const result = mergeRotation('', 45);
    expect(result).toBe('rotate(45deg)');
  });

  test('rotation=0 returns just the non-rotation part', () => {
    const result = mergeRotation('translateY(-50%) rotate(30deg)', 0);
    expect(result).toBe('translateY(-50%)');
  });

  test('rotation=0 with no other transforms returns empty string', () => {
    const result = mergeRotation('rotate(30deg)', 0);
    expect(result).toBe('');
  });

  test('both rotation=0 and no existing transform returns empty string', () => {
    const result = mergeRotation('', 0);
    expect(result).toBe('');
  });

  test('rounds rotation to 1 decimal place', () => {
    const result = mergeRotation('', 45.678);
    expect(result).toBe('rotate(45.7deg)');
  });

  test('negative rotation preserved', () => {
    const result = mergeRotation('translateX(-50%)', -30);
    expect(result).toBe('translateX(-50%) rotate(-30deg)');
  });
});

// ─── parseSvgRotate ─────────────────────────────────────────────────────────

describe('parseSvgRotate', () => {
  test('null / undefined / "none" / empty → null', () => {
    expect(parseSvgRotate(null)).toBeNull();
    expect(parseSvgRotate(undefined)).toBeNull();
    expect(parseSvgRotate('none')).toBeNull();
    expect(parseSvgRotate('')).toBeNull();
  });

  test('no rotate() in the string → null', () => {
    expect(parseSvgRotate('translate(10 20)')).toBeNull();
    expect(parseSvgRotate('scale(2)')).toBeNull();
  });

  test('rotate(a cx cy) space-separated', () => {
    expect(parseSvgRotate('rotate(118 41 32)')).toEqual({ angle: 118, cx: 41, cy: 32 });
  });

  test('rotate(a, cx, cy) comma-separated', () => {
    expect(parseSvgRotate('rotate(45, 10, 20)')).toEqual({ angle: 45, cx: 10, cy: 20 });
  });

  test('bare rotate(a) → cx/cy default to 0', () => {
    expect(parseSvgRotate('rotate(90)')).toEqual({ angle: 90, cx: 0, cy: 0 });
  });

  test('negative + fractional values', () => {
    expect(parseSvgRotate('rotate(-205.5 124.06 168)')).toEqual({ angle: -205.5, cx: 124.06, cy: 168 });
  });

  test('extracts rotate() from a multi-transform string', () => {
    expect(parseSvgRotate('translate(372 64) rotate(118 41 32)')).toEqual({ angle: 118, cx: 41, cy: 32 });
  });
});

// ─── buildSvgRotate ─────────────────────────────────────────────────────────

describe('buildSvgRotate', () => {
  test('angle 0 → empty string (round-trips as "no rotation")', () => {
    expect(buildSvgRotate(0, 50, 50)).toBe('');
  });

  test('angle + pivot', () => {
    expect(buildSvgRotate(118, 41, 32)).toBe('rotate(118 41 32)');
  });

  test('rounds angle to 1 decimal, pivot to 2 decimals', () => {
    expect(buildSvgRotate(45.678, 124.0612, 167.999)).toBe('rotate(45.7 124.06 168)');
  });

  test('negative angle preserved', () => {
    expect(buildSvgRotate(-205.5, 124, 168)).toBe('rotate(-205.5 124 168)');
  });
});

// ─── mergeSvgRotate ─────────────────────────────────────────────────────────

describe('mergeSvgRotate', () => {
  test('empty existing attr → just the rotate()', () => {
    expect(mergeSvgRotate('', 90, 10, 20)).toBe('rotate(90 10 20)');
  });

  test('replaces an existing rotate()', () => {
    expect(mergeSvgRotate('rotate(10 10 20)', 90, 10, 20)).toBe('rotate(90 10 20)');
  });

  test('preserves a translate() while swapping the rotate()', () => {
    expect(mergeSvgRotate('translate(372 64) rotate(10 41 32)', 118, 41, 32))
      .toBe('translate(372 64) rotate(118 41 32)');
  });

  test('adds rotate() to a transform that had none', () => {
    expect(mergeSvgRotate('translate(372 64)', 118, 41, 32))
      .toBe('translate(372 64) rotate(118 41 32)');
  });

  test('angle 0 with other transforms → drops only the rotate()', () => {
    expect(mergeSvgRotate('translate(372 64) rotate(118 41 32)', 0, 41, 32))
      .toBe('translate(372 64)');
  });

  test('angle 0 with no other transforms → empty string', () => {
    expect(mergeSvgRotate('rotate(118 41 32)', 0, 41, 32)).toBe('');
  });
});
