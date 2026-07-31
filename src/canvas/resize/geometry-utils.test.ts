import { describe, test, it, expect } from 'vitest';
import {
  midpoint,
  getElementCenter,
  hasTransforms,
  getHandlesFromDirection,
  getOppositeCorner,
  getEdgeMidpoints,
  getEdgeAngle,
  processZeroCrossing,
  updateDirectionAfterCrossing,
  isFullyInsideQuad,
  isFullyOutsideQuad,
  quadDiagonalIntersection,
  cornersAreAxisAligned,
  type ScreenCorners,
} from './geometry-utils';

describe('midpoint', () => {
  test('returns midpoint of two points', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });

  test('same point returns itself', () => {
    expect(midpoint({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe('getElementCenter', () => {
  test('returns center of 4 corners', () => {
    const corners: ScreenCorners = {
      TL: { x: 0, y: 0 },
      TR: { x: 100, y: 0 },
      BR: { x: 100, y: 50 },
      BL: { x: 0, y: 50 },
    };
    expect(getElementCenter(corners)).toEqual({ x: 50, y: 25 });
  });
});

describe('quadDiagonalIntersection', () => {
  test('axis-aligned rectangle → geometric centre', () => {
    const corners: ScreenCorners = {
      TL: { x: 0, y: 0 }, TR: { x: 100, y: 0 },
      BR: { x: 100, y: 50 }, BL: { x: 0, y: 50 },
    };
    const c = quadDiagonalIntersection(corners)!;
    expect(c.x).toBeCloseTo(50);
    expect(c.y).toBeCloseTo(25);
  });

  test('parallelogram (affine) → equals centroid', () => {
    // Sheared rectangle — diagonals still bisect each other.
    const corners: ScreenCorners = {
      TL: { x: 20, y: 0 }, TR: { x: 120, y: 0 },
      BR: { x: 100, y: 50 }, BL: { x: 0, y: 50 },
    };
    const diag = quadDiagonalIntersection(corners)!;
    expect(diag.x).toBeCloseTo(getElementCenter(corners).x);
    expect(diag.y).toBeCloseTo(getElementCenter(corners).y);
  });

  test('perspective trapezoid → diagonal crossing, NOT the centroid', () => {
    // Symmetric trapezoid: narrow top (x 40..60), wide bottom (x 0..100).
    const corners: ScreenCorners = {
      TL: { x: 40, y: 0 }, TR: { x: 60, y: 0 },
      BR: { x: 100, y: 100 }, BL: { x: 0, y: 100 },
    };
    const diag = quadDiagonalIntersection(corners)!;
    // By symmetry the crossing is on the vertical centre line x=50.
    expect(diag.x).toBeCloseTo(50);
    // It sits nearer the narrow (top) end — well above the centroid y=50.
    expect(diag.y).toBeLessThan(50);
    expect(diag.y).not.toBeCloseTo(getElementCenter(corners).y);
  });

  test('degenerate quad (parallel diagonals) → null', () => {
    const corners: ScreenCorners = {
      TL: { x: 0, y: 0 }, TR: { x: 10, y: 0 },
      BR: { x: 20, y: 0 }, BL: { x: 30, y: 0 },
    };
    expect(quadDiagonalIntersection(corners)).toBeNull();
  });
});

describe('cornersAreAxisAligned', () => {
  test('axis-aligned rectangle → true', () => {
    expect(cornersAreAxisAligned({
      TL: { x: 0, y: 0 }, TR: { x: 100, y: 0 },
      BR: { x: 100, y: 50 }, BL: { x: 0, y: 50 },
    })).toBe(true);
  });

  test('rotated quad → false', () => {
    expect(cornersAreAxisAligned({
      TL: { x: 10, y: 0 }, TR: { x: 100, y: 10 },
      BR: { x: 90, y: 100 }, BL: { x: 0, y: 90 },
    })).toBe(false);
  });

  test('perspective trapezoid (converging sides) → false', () => {
    expect(cornersAreAxisAligned({
      TL: { x: 40, y: 0 }, TR: { x: 60, y: 0 },
      BR: { x: 100, y: 100 }, BL: { x: 0, y: 100 },
    })).toBe(false);
  });

  test('sub-pixel jitter within epsilon → still true', () => {
    expect(cornersAreAxisAligned({
      TL: { x: 0, y: 0.2 }, TR: { x: 100, y: -0.1 },
      BR: { x: 100.3, y: 50 }, BL: { x: -0.2, y: 50 },
    })).toBe(true);
  });
});

describe('hasTransforms', () => {
  test('identity matrix returns false', () => {
    expect(hasTransforms('matrix(1, 0, 0, 1, 0, 0)')).toBe(false);
  });

  test('rotated matrix returns true', () => {
    expect(hasTransforms('matrix(0.707, 0.707, -0.707, 0.707, 0, 0)')).toBe(true);
  });

  test('none returns false', () => {
    expect(hasTransforms('none')).toBe(false);
  });

  test('empty string returns false', () => {
    expect(hasTransforms('')).toBe(false);
  });

  test('translated matrix returns true', () => {
    expect(hasTransforms('matrix(1, 0, 0, 1, 50, 30)')).toBe(true);
  });
});

describe('getHandlesFromDirection', () => {
  test('topLeft returns left + top', () => {
    expect(getHandlesFromDirection('topLeft')).toEqual({ xHandle: 'left', yHandle: 'top' });
  });

  test('bottomRight returns right + bottom', () => {
    expect(getHandlesFromDirection('bottomRight')).toEqual({ xHandle: 'right', yHandle: 'bottom' });
  });

  test('top returns null x + top y', () => {
    expect(getHandlesFromDirection('top')).toEqual({ xHandle: null, yHandle: 'top' });
  });

  test('right returns right x + null y', () => {
    expect(getHandlesFromDirection('right')).toEqual({ xHandle: 'right', yHandle: null });
  });
});

describe('getOppositeCorner', () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };

  test('topLeft opposite is bottomRight', () => {
    expect(getOppositeCorner('topLeft', rect)).toEqual({ x: 110, y: 70 });
  });

  test('bottomRight opposite is topLeft', () => {
    expect(getOppositeCorner('bottomRight', rect)).toEqual({ x: 10, y: 20 });
  });

  test('top opposite is bottom center', () => {
    expect(getOppositeCorner('top', rect)).toEqual({ x: 60, y: 70 });
  });

  test('left opposite is right center', () => {
    expect(getOppositeCorner('left', rect)).toEqual({ x: 110, y: 45 });
  });
});

describe('getEdgeMidpoints', () => {
  test('returns midpoints of all 4 edges', () => {
    const corners: ScreenCorners = {
      TL: { x: 0, y: 0 },
      TR: { x: 100, y: 0 },
      BR: { x: 100, y: 50 },
      BL: { x: 0, y: 50 },
    };
    const mids = getEdgeMidpoints(corners);
    expect(mids.top).toEqual({ x: 50, y: 0 });
    expect(mids.right).toEqual({ x: 100, y: 25 });
    expect(mids.bottom).toEqual({ x: 50, y: 50 });
    expect(mids.left).toEqual({ x: 0, y: 25 });
  });
});

describe('getEdgeAngle', () => {
  test('horizontal edge is 0 degrees', () => {
    expect(getEdgeAngle({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(0);
  });

  test('vertical edge is 90 degrees', () => {
    expect(getEdgeAngle({ x: 0, y: 0 }, { x: 0, y: 100 })).toBe(90);
  });

  test('45 degree diagonal', () => {
    expect(getEdgeAngle({ x: 0, y: 0 }, { x: 100, y: 100 })).toBe(45);
  });
});

describe('processZeroCrossing', () => {
  test('positive dimensions unchanged', () => {
    const result = processZeroCrossing(100, 50, 10, 20, 'left', 'top');
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.crossed).toBe(false);
  });

  test('negative width flips handle and adjusts left', () => {
    const result = processZeroCrossing(-30, 50, 100, 20, 'left', 'top');
    expect(result.width).toBe(30);
    expect(result.left).toBe(70);
    expect(result.xHandle).toBe('right');
    expect(result.crossed).toBe(true);
  });

  test('negative height flips handle and adjusts top', () => {
    const result = processZeroCrossing(100, -20, 10, 50, 'left', 'top');
    expect(result.height).toBe(20);
    expect(result.top).toBe(30);
    expect(result.yHandle).toBe('bottom');
    expect(result.crossed).toBe(true);
  });

  test('both negative flips both', () => {
    const result = processZeroCrossing(-30, -20, 100, 50, 'left', 'top');
    expect(result.width).toBe(30);
    expect(result.height).toBe(20);
    expect(result.xHandle).toBe('right');
    expect(result.yHandle).toBe('bottom');
    expect(result.crossed).toBe(true);
  });

  test('left position adjusts correctly on width crossing', () => {
    // Width = -50, left = 100 → finalLeft = 100 + (-50) = 50, finalWidth = 50
    const result = processZeroCrossing(-50, 80, 100, 30, 'right', 'bottom');
    expect(result.left).toBe(50);
    expect(result.width).toBe(50);
    expect(result.xHandle).toBe('left');
  });

  test('top position adjusts correctly on height crossing', () => {
    // Height = -40, top = 60 → finalTop = 60 + (-40) = 20, finalHeight = 40
    const result = processZeroCrossing(100, -40, 50, 60, 'left', 'bottom');
    expect(result.top).toBe(20);
    expect(result.height).toBe(40);
    expect(result.yHandle).toBe('top');
  });
});

describe('updateDirectionAfterCrossing', () => {
  test('corner: topLeft with flipped handles → bottomRight', () => {
    expect(updateDirectionAfterCrossing('right', 'bottom', 'topLeft')).toBe('bottomRight');
  });

  test('corner: bottomRight with flipped handles → topLeft', () => {
    expect(updateDirectionAfterCrossing('left', 'top', 'bottomRight')).toBe('topLeft');
  });

  test('edge: left with flipped handle → right', () => {
    expect(updateDirectionAfterCrossing('right', 'top', 'left')).toBe('right');
  });

  test('edge: top with flipped handle → bottom', () => {
    expect(updateDirectionAfterCrossing('left', 'bottom', 'top')).toBe('bottom');
  });
});

describe('isFullyInsideQuad / isFullyOutsideQuad', () => {
  const container: ScreenCorners = {
    TL: { x: 0,   y: 0   },
    TR: { x: 100, y: 0   },
    BR: { x: 100, y: 100 },
    BL: { x: 0,   y: 100 },
  };

  const inside: ScreenCorners = {
    TL: { x: 20, y: 20 }, TR: { x: 80, y: 20 },
    BR: { x: 80, y: 80 }, BL: { x: 20, y: 80 },
  };

  const partiallyOutside: ScreenCorners = {
    TL: { x: -10, y: 20 }, TR: { x: 50, y: 20 },
    BR: { x: 50, y: 80 }, BL: { x: -10, y: 80 },
  };

  const fullyOutside: ScreenCorners = {
    TL: { x: 200, y: 200 }, TR: { x: 250, y: 200 },
    BR: { x: 250, y: 250 }, BL: { x: 200, y: 250 },
  };

  test('isFullyInsideQuad: fully contained → true', () => {
    expect(isFullyInsideQuad(inside, container)).toBe(true);
  });

  test('isFullyInsideQuad: partially out → false', () => {
    expect(isFullyInsideQuad(partiallyOutside, container)).toBe(false);
  });

  test('isFullyInsideQuad: fully outside → false', () => {
    expect(isFullyInsideQuad(fullyOutside, container)).toBe(false);
  });

  test('isFullyOutsideQuad: fully contained → false', () => {
    expect(isFullyOutsideQuad(inside, container)).toBe(false);
  });

  test('isFullyOutsideQuad: partially overlapping → false', () => {
    // partiallyOutside has corners both inside and outside container
    expect(isFullyOutsideQuad(partiallyOutside, container)).toBe(false);
  });

  test('isFullyOutsideQuad: completely separated → true', () => {
    expect(isFullyOutsideQuad(fullyOutside, container)).toBe(true);
  });

  test('isFullyOutsideQuad: element wraps container (no corners inside but container inside element) → false', () => {
    // Element bigger than container, container fully inside element
    const wrappingEl: ScreenCorners = {
      TL: { x: -50, y: -50 }, TR: { x: 200, y: -50 },
      BR: { x: 200, y: 200 }, BL: { x: -50, y: 200 },
    };
    expect(isFullyOutsideQuad(wrappingEl, container)).toBe(false);
  });
});

// ─── matrixHasRotationSkewOrFlip — the 180°/flip detection hole ─────────────
import { matrixHasRotationSkewOrFlip } from './geometry-utils';

describe('matrixHasRotationSkewOrFlip', () => {
  it('rotate(180deg) → matrix(-1,0,0,-1) IS rotated (b=c=0, negative diagonal)', () => {
    expect(matrixHasRotationSkewOrFlip({ a: -1, b: 0, c: 0, d: -1 })).toBe(true);
  });
  it('mirror flips are rotated-class', () => {
    expect(matrixHasRotationSkewOrFlip({ a: -1, b: 0, c: 0, d: 1 })).toBe(true);
    expect(matrixHasRotationSkewOrFlip({ a: 1, b: 0, c: 0, d: -1 })).toBe(true);
  });
  it('plain scale / translate / identity are NOT', () => {
    expect(matrixHasRotationSkewOrFlip({ a: 1, b: 0, c: 0, d: 1 })).toBe(false);
    expect(matrixHasRotationSkewOrFlip({ a: 2, b: 0, c: 0, d: 0.5 })).toBe(false);
  });
  it('real rotations and skews still detect via b/c', () => {
    const r = (45 * Math.PI) / 180;
    expect(matrixHasRotationSkewOrFlip({ a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r) })).toBe(true);
    expect(matrixHasRotationSkewOrFlip({ a: 1, b: 0, c: 0.3, d: 1 })).toBe(true);
  });
});
