// svg-path-model.test.ts — Tests for SVG path data model.

import { describe, test, expect } from 'vitest';
import {
  SvgPath,
  SvgPoint,
  SvgControlPoint,
  SvgItem,
  MoveTo,
  LineTo,
  CurveTo,
  QuadraticBezierCurveTo,
  HorizontalLineTo,
  VerticalLineTo,
  ClosePath,
  SmoothCurveTo,
  SmoothQuadraticBezierCurveTo,
  EllipticalArcTo,
} from '@/shared/svg-path/svg-path-model';

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Approximate equality for floating point comparisons. */
function near(actual: number, expected: number, epsilon = 0.001): void {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon);
}

// ─── SvgItem.Make factory ────────────────────────────────────────────────────

describe('SvgItem.Make — factory from parser tokens', () => {
  test('creates MoveTo from M tokens', () => {
    const item = SvgItem.Make(['M', '10', '20']);
    expect(item).toBeInstanceOf(MoveTo);
    expect(item.values).toEqual([10, 20]);
    expect(item.relative).toBe(false);
  });

  test('creates relative LineTo from l tokens', () => {
    const item = SvgItem.Make(['l', '50', '60']);
    expect(item).toBeInstanceOf(LineTo);
    expect(item.values).toEqual([50, 60]);
    expect(item.relative).toBe(true);
  });

  test('creates HorizontalLineTo from H tokens', () => {
    const item = SvgItem.Make(['H', '100']);
    expect(item).toBeInstanceOf(HorizontalLineTo);
    expect(item.values).toEqual([100]);
  });

  test('creates VerticalLineTo from V tokens', () => {
    const item = SvgItem.Make(['V', '200']);
    expect(item).toBeInstanceOf(VerticalLineTo);
    expect(item.values).toEqual([200]);
  });

  test('creates ClosePath from Z', () => {
    const item = SvgItem.Make(['Z']);
    expect(item).toBeInstanceOf(ClosePath);
    expect(item.values).toEqual([]);
  });

  test('creates CurveTo from C tokens', () => {
    const item = SvgItem.Make(['C', '10', '20', '30', '40', '50', '60']);
    expect(item).toBeInstanceOf(CurveTo);
    expect(item.values).toEqual([10, 20, 30, 40, 50, 60]);
  });

  test('creates SmoothCurveTo from S tokens', () => {
    const item = SvgItem.Make(['S', '30', '40', '50', '60']);
    expect(item).toBeInstanceOf(SmoothCurveTo);
    expect(item.values).toEqual([30, 40, 50, 60]);
  });

  test('creates QuadraticBezierCurveTo from Q tokens', () => {
    const item = SvgItem.Make(['Q', '50', '50', '100', '0']);
    expect(item).toBeInstanceOf(QuadraticBezierCurveTo);
    expect(item.values).toEqual([50, 50, 100, 0]);
  });

  test('creates SmoothQuadraticBezierCurveTo from T tokens', () => {
    const item = SvgItem.Make(['T', '200', '0']);
    expect(item).toBeInstanceOf(SmoothQuadraticBezierCurveTo);
    expect(item.values).toEqual([200, 0]);
  });

  test('creates EllipticalArcTo from A tokens', () => {
    const item = SvgItem.Make(['A', '10', '10', '0', '0', '1', '100', '100']);
    expect(item).toBeInstanceOf(EllipticalArcTo);
    expect(item.values).toEqual([10, 10, 0, 0, 1, 100, 100]);
  });
});

// ─── Construction and roundtrip ──────────────────────────────────────────────

describe('SvgPath — construction and asString', () => {
  test('simple triangle roundtrips', () => {
    const d = 'M 0 0 L 100 0 L 100 100 Z';
    const path = new SvgPath(d);
    expect(path.path).toHaveLength(4);
    expect(path.asString()).toBe('M 0 0 L 100 0 L 100 100 Z');
  });

  test('path with curves roundtrips', () => {
    const d = 'M 0 0 C 10 20 30 40 50 60';
    const path = new SvgPath(d);
    expect(path.path).toHaveLength(2);
    expect(path.asString()).toBe('M 0 0 C 10 20 30 40 50 60');
  });

  test('path with arcs roundtrips', () => {
    const d = 'M 0 0 A 25 25 0 0 1 50 0';
    const path = new SvgPath(d);
    expect(path.path).toHaveLength(2);
    expect(path.asString()).toBe('M 0 0 A 25 25 0 0 1 50 0');
  });

  test('relative commands preserve case', () => {
    const d = 'M 0 0 l 50 50 z';
    const path = new SvgPath(d);
    expect(path.asString()).toBe('M 0 0 l 50 50 z');
  });

  test('asString with decimals truncates values', () => {
    const path = new SvgPath('M 1.23456 7.89012');
    expect(path.asString(2)).toBe('M 1.23 7.89');
  });

  test('asString with decimals removes trailing zeros', () => {
    const path = new SvgPath('M 10 20');
    expect(path.asString(2)).toBe('M 10 20');
  });
});

// ─── targetLocations ─────────────────────────────────────────────────────────

describe('SvgPath — targetLocations', () => {
  test('triangle has 3 anchor points (M, L, L), Z has none', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100 Z');
    const locs = path.targetLocations();
    expect(locs).toHaveLength(3);
    expect(locs[0]).toMatchObject({ x: 0, y: 0, itemIndex: 0 });
    expect(locs[1]).toMatchObject({ x: 100, y: 0, itemIndex: 1 });
    expect(locs[2]).toMatchObject({ x: 100, y: 100, itemIndex: 2 });
  });

  test('path with curve has anchor at curve endpoint', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const locs = path.targetLocations();
    expect(locs).toHaveLength(2);
    expect(locs[0]).toMatchObject({ x: 0, y: 0 });
    expect(locs[1]).toMatchObject({ x: 50, y: 60 });
  });

  test('H and V produce correct absolute positions', () => {
    const path = new SvgPath('M 10 20 H 50 V 80');
    const locs = path.targetLocations();
    expect(locs).toHaveLength(3);
    expect(locs[0]).toMatchObject({ x: 10, y: 20 });
    expect(locs[1]).toMatchObject({ x: 50, y: 20 }); // H: x=50, y stays 20
    expect(locs[2]).toMatchObject({ x: 50, y: 80 }); // V: x stays 50, y=80
  });

  test('all points are SvgPoint instances', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const locs = path.targetLocations();
    for (const loc of locs) {
      expect(loc).toBeInstanceOf(SvgPoint);
    }
  });
});

// ─── controlLocations ────────────────────────────────────────────────────────

describe('SvgPath — controlLocations', () => {
  test('L commands have no control handles', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100');
    expect(path.controlLocations()).toHaveLength(0);
  });

  test('C command has 2 control handles', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const cps = path.controlLocations();
    expect(cps).toHaveLength(2);
    expect(cps[0]).toMatchObject({ x: 10, y: 20, itemIndex: 1, subIndex: 0 });
    expect(cps[1]).toMatchObject({ x: 30, y: 40, itemIndex: 1, subIndex: 1 });
  });

  test('Q command has 1 control handle', () => {
    const path = new SvgPath('M 0 0 Q 50 50 100 0');
    const cps = path.controlLocations();
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ x: 50, y: 50, itemIndex: 1, subIndex: 0 });
  });

  test('S command has 1 control handle', () => {
    const path = new SvgPath('M 0 0 S 30 40 50 60');
    const cps = path.controlLocations();
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ x: 30, y: 40, itemIndex: 1, subIndex: 0 });
  });

  test('all control points are SvgControlPoint instances', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const cps = path.controlLocations();
    for (const cp of cps) {
      expect(cp).toBeInstanceOf(SvgControlPoint);
    }
  });

  test('mixed path: C has handles, L does not', () => {
    const path = new SvgPath('M 0 0 L 100 0 C 110 20 130 40 150 60 L 200 0');
    const cps = path.controlLocations();
    // Only the C (at index 2) has handles
    expect(cps).toHaveLength(2);
    expect(cps[0].itemIndex).toBe(2);
    expect(cps[1].itemIndex).toBe(2);
  });
});

// ─── setLocation — anchor points ─────────────────────────────────────────────

describe('SvgPath — setLocation on anchors', () => {
  test('moving an L endpoint updates its values', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const anchors = path.targetLocations();
    path.setLocation(anchors[1], { x: 200, y: 150 });
    expect(path.path[1].values).toEqual([200, 150]);
    // Verify refresh updated absolute positions
    const newAnchors = path.targetLocations();
    expect(newAnchors[1]).toMatchObject({ x: 200, y: 150 });
  });

  test('moving an M endpoint updates origin', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const anchors = path.targetLocations();
    path.setLocation(anchors[0], { x: 10, y: 20 });
    expect(path.path[0].values).toEqual([10, 20]);
    const newAnchors = path.targetLocations();
    expect(newAnchors[0]).toMatchObject({ x: 10, y: 20 });
  });

  test('moving anchor of C also shifts control points', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const anchors = path.targetLocations();
    const cpsBefore = path.controlLocations();
    const cp1Before = { x: cpsBefore[0].x, y: cpsBefore[0].y };
    const cp2Before = { x: cpsBefore[1].x, y: cpsBefore[1].y };

    // Move endpoint by +10, +10
    path.setLocation(anchors[1], { x: 60, y: 70 });

    const cpsAfter = path.controlLocations();
    near(cpsAfter[0].x, cp1Before.x + 10);
    near(cpsAfter[0].y, cp1Before.y + 10);
    near(cpsAfter[1].x, cp2Before.x + 10);
    near(cpsAfter[1].y, cp2Before.y + 10);
  });

  test('moving H anchor only changes x', () => {
    const path = new SvgPath('M 10 20 H 50');
    const anchors = path.targetLocations();
    path.setLocation(anchors[1], { x: 80, y: 999 }); // y should be ignored
    const newAnchors = path.targetLocations();
    expect(newAnchors[1].x).toBe(80);
    expect(newAnchors[1].y).toBe(20); // stays at previous y
  });

  test('moving V anchor only changes y', () => {
    const path = new SvgPath('M 10 20 V 80');
    const anchors = path.targetLocations();
    path.setLocation(anchors[1], { x: 999, y: 50 }); // x should be ignored
    const newAnchors = path.targetLocations();
    expect(newAnchors[1].x).toBe(10); // stays at previous x
    expect(newAnchors[1].y).toBe(50);
  });
});

// ─── setLocation — control handles ───────────────────────────────────────────

describe('SvgPath — setLocation on control handles', () => {
  test('moving a control handle moves only that handle', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const cps = path.controlLocations();

    // Move first control handle
    path.setLocation(cps[0], { x: 15, y: 25 });

    const newCps = path.controlLocations();
    expect(newCps[0]).toMatchObject({ x: 15, y: 25 });
    // Second control handle unchanged
    expect(newCps[1]).toMatchObject({ x: 30, y: 40 });
  });

  test('moving second control handle of C works', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    const cps = path.controlLocations();

    path.setLocation(cps[1], { x: 35, y: 45 });

    const newCps = path.controlLocations();
    expect(newCps[0]).toMatchObject({ x: 10, y: 20 }); // first unchanged
    expect(newCps[1]).toMatchObject({ x: 35, y: 45 });
  });

  test('moving control handle of Q updates values', () => {
    const path = new SvgPath('M 0 0 Q 50 50 100 0');
    const cps = path.controlLocations();

    path.setLocation(cps[0], { x: 60, y: 70 });

    const newCps = path.controlLocations();
    expect(newCps[0]).toMatchObject({ x: 60, y: 70 });
    // Endpoint unchanged
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 100, y: 0 });
  });

  test('moving S control handle works', () => {
    const path = new SvgPath('M 0 0 S 30 40 50 60');
    const cps = path.controlLocations();
    path.setLocation(cps[0], { x: 35, y: 45 });
    const newCps = path.controlLocations();
    expect(newCps[0]).toMatchObject({ x: 35, y: 45 });
  });
});

// ─── insert ──────────────────────────────────────────────────────────────────

describe('SvgPath — insert', () => {
  test('inserting into a line segment increases item count', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100');
    expect(path.path).toHaveLength(3);
    path.insert(0); // insert between M and first L
    expect(path.path).toHaveLength(4);
  });

  test('inserted point on line is at midpoint', () => {
    const path = new SvgPath('M 0 0 L 100 0');
    path.insert(0);
    // The new item should be at (50, 0)
    const newItem = path.path[1]; // inserted after index 0
    expect(newItem).toBeInstanceOf(LineTo);
    const end = newItem.getEndPoint();
    near(end.x, 50);
    near(end.y, 0);
  });

  test('inserting into a C segment produces two C segments', () => {
    const path = new SvgPath('M 0 0 C 100 0 100 100 0 100');
    expect(path.path).toHaveLength(2);
    path.insert(0);
    expect(path.path).toHaveLength(3);
    expect(path.path[1]).toBeInstanceOf(CurveTo);
    expect(path.path[2]).toBeInstanceOf(CurveTo);
  });

  test('insert at invalid index is a no-op', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const countBefore = path.path.length;
    path.insert(-1);
    expect(path.path.length).toBe(countBefore);
    path.insert(10);
    expect(path.path.length).toBe(countBefore);
  });

  test('insert at last index is a no-op', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const countBefore = path.path.length;
    path.insert(1); // afterIndex = last item, no next segment
    expect(path.path.length).toBe(countBefore);
  });

  test('inserting into a Q segment produces two Q segments', () => {
    const path = new SvgPath('M 0 0 Q 50 100 100 0');
    expect(path.path).toHaveLength(2);
    path.insert(0);
    expect(path.path).toHaveLength(3);
    expect(path.path[1]).toBeInstanceOf(QuadraticBezierCurveTo);
    expect(path.path[2]).toBeInstanceOf(QuadraticBezierCurveTo);
  });
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe('SvgPath — delete', () => {
  test('deleting a middle point decreases item count', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100 Z');
    expect(path.path).toHaveLength(4);
    path.delete(2); // delete second L
    expect(path.path).toHaveLength(3);
  });

  test('cannot delete below 2 items', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    expect(path.path).toHaveLength(2);
    path.delete(1);
    expect(path.path).toHaveLength(2); // still 2, delete was blocked
  });

  test('deleting first item (M) promotes next point to M', () => {
    const path = new SvgPath('M 0 0 L 100 100 L 200 200');
    path.delete(0);
    expect(path.path[0]).toBeInstanceOf(MoveTo);
    const end = path.path[0].getEndPoint();
    expect(end).toMatchObject({ x: 100, y: 100 });
  });

  test('deleting last item works', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100');
    path.delete(2);
    expect(path.path).toHaveLength(2);
  });

  test('delete at invalid index is a no-op', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100');
    const count = path.path.length;
    path.delete(-1);
    expect(path.path.length).toBe(count);
    path.delete(10);
    expect(path.path.length).toBe(count);
  });
});

// ─── changeType ──────────────────────────────────────────────────────────────

describe('SvgPath — changeType', () => {
  test('L → C adds control points', () => {
    const path = new SvgPath('M 0 0 L 90 0');
    expect(path.controlLocations()).toHaveLength(0);

    path.changeType(1, 'C');
    expect(path.path[1]).toBeInstanceOf(CurveTo);
    expect(path.controlLocations()).toHaveLength(2);

    // Control points should be at 1/3 and 2/3 along the line
    const cps = path.controlLocations();
    near(cps[0].x, 30);
    near(cps[0].y, 0);
    near(cps[1].x, 60);
    near(cps[1].y, 0);

    // Endpoint preserved
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 90, y: 0 });
  });

  test('C → L removes control points', () => {
    const path = new SvgPath('M 0 0 C 10 20 30 40 50 60');
    expect(path.controlLocations()).toHaveLength(2);

    path.changeType(1, 'L');
    expect(path.path[1]).toBeInstanceOf(LineTo);
    expect(path.controlLocations()).toHaveLength(0);

    // Endpoint preserved
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 50, y: 60 });
  });

  test('L → Q adds one control handle at midpoint', () => {
    const path = new SvgPath('M 0 0 L 100 0');
    path.changeType(1, 'Q');
    expect(path.path[1]).toBeInstanceOf(QuadraticBezierCurveTo);
    expect(path.controlLocations()).toHaveLength(1);
    // Endpoint preserved
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 100, y: 0 });
  });

  test('C → Q averages two handles into one', () => {
    const path = new SvgPath('M 0 0 C 20 40 80 40 100 0');
    path.changeType(1, 'Q');
    expect(path.path[1]).toBeInstanceOf(QuadraticBezierCurveTo);
    const cps = path.controlLocations();
    expect(cps).toHaveLength(1);
    // Average of (20,40) and (80,40) = (50, 40)
    near(cps[0].x, 50);
    near(cps[0].y, 40);
  });

  test('Q → C elevates quadratic to cubic', () => {
    const path = new SvgPath('M 0 0 Q 50 50 100 0');
    path.changeType(1, 'C');
    expect(path.path[1]).toBeInstanceOf(CurveTo);
    const cps = path.controlLocations();
    expect(cps).toHaveLength(2);
    // Q→C: cp1 = start + 2/3*(qcp-start), cp2 = end + 2/3*(qcp-end)
    // qcp = (50,50), start = (0,0), end = (100,0)
    // cp1 = (0 + 2/3*50, 0 + 2/3*50) = (33.33, 33.33)
    // cp2 = (100 + 2/3*(50-100), 0 + 2/3*(50-0)) = (66.67, 33.33)
    near(cps[0].x, 33.333);
    near(cps[0].y, 33.333);
    near(cps[1].x, 66.667);
    near(cps[1].y, 33.333);

    // Endpoint preserved
    const anchors = path.targetLocations();
    near(anchors[1].x, 100);
    near(anchors[1].y, 0);
  });

  test('L → H preserves x', () => {
    const path = new SvgPath('M 10 20 L 50 20');
    path.changeType(1, 'H');
    expect(path.path[1]).toBeInstanceOf(HorizontalLineTo);
    const anchors = path.targetLocations();
    expect(anchors[1].x).toBe(50);
  });

  test('L → V preserves y', () => {
    const path = new SvgPath('M 10 20 L 10 80');
    path.changeType(1, 'V');
    expect(path.path[1]).toBeInstanceOf(VerticalLineTo);
    const anchors = path.targetLocations();
    expect(anchors[1].y).toBe(80);
  });

  test('L → A creates arc with computed radius', () => {
    const path = new SvgPath('M 0 0 L 100 0');
    path.changeType(1, 'A');
    expect(path.path[1]).toBeInstanceOf(EllipticalArcTo);
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 100, y: 0 });
  });
});

// ─── Complex mixed-command path ──────────────────────────────────────────────

describe('SvgPath — complex mixed commands', () => {
  test('path with M, L, C, Q, Z', () => {
    const d = 'M 0 0 L 100 0 C 120 0 130 20 130 40 Q 130 80 100 100 Z';
    const path = new SvgPath(d);

    expect(path.path).toHaveLength(5);
    expect(path.path[0]).toBeInstanceOf(MoveTo);
    expect(path.path[1]).toBeInstanceOf(LineTo);
    expect(path.path[2]).toBeInstanceOf(CurveTo);
    expect(path.path[3]).toBeInstanceOf(QuadraticBezierCurveTo);
    expect(path.path[4]).toBeInstanceOf(ClosePath);

    // Anchors: M, L, C endpoint, Q endpoint (no Z anchor)
    const anchors = path.targetLocations();
    expect(anchors).toHaveLength(4);

    // Control handles: C has 2, Q has 1
    const controls = path.controlLocations();
    expect(controls).toHaveLength(3);
    // C controls at item index 2
    expect(controls[0].itemIndex).toBe(2);
    expect(controls[1].itemIndex).toBe(2);
    // Q control at item index 3
    expect(controls[2].itemIndex).toBe(3);
  });

  test('complex path with H, V, S, T, A', () => {
    const d = 'M 10 10 H 100 V 100 S 80 120 60 100 T 20 80 A 20 20 0 0 1 10 10 Z';
    const path = new SvgPath(d);

    expect(path.path).toHaveLength(7);
    expect(path.path[0]).toBeInstanceOf(MoveTo);
    expect(path.path[1]).toBeInstanceOf(HorizontalLineTo);
    expect(path.path[2]).toBeInstanceOf(VerticalLineTo);
    expect(path.path[3]).toBeInstanceOf(SmoothCurveTo);
    expect(path.path[4]).toBeInstanceOf(SmoothQuadraticBezierCurveTo);
    expect(path.path[5]).toBeInstanceOf(EllipticalArcTo);
    expect(path.path[6]).toBeInstanceOf(ClosePath);
  });
});

// ─── Relative commands ───────────────────────────────────────────────────────

describe('SvgPath — relative commands compute correct absolute positions', () => {
  test('relative l computes absolute from previous point', () => {
    const path = new SvgPath('M 10 20 l 30 40');
    const anchors = path.targetLocations();
    expect(anchors[0]).toMatchObject({ x: 10, y: 20 });
    // l 30 40 relative to (10,20) = (40,60)
    expect(anchors[1]).toMatchObject({ x: 40, y: 60 });
  });

  test('relative h computes absolute from previous y', () => {
    const path = new SvgPath('M 10 20 h 30');
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 40, y: 20 });
  });

  test('relative v computes absolute from previous x', () => {
    const path = new SvgPath('M 10 20 v 30');
    const anchors = path.targetLocations();
    expect(anchors[1]).toMatchObject({ x: 10, y: 50 });
  });

  test('relative c computes absolute control points from previous', () => {
    const path = new SvgPath('M 10 20 c 5 10 15 20 25 30');
    const anchors = path.targetLocations();
    // Endpoint: (10+25, 20+30) = (35, 50)
    expect(anchors[1]).toMatchObject({ x: 35, y: 50 });

    const cps = path.controlLocations();
    // cp1: (10+5, 20+10) = (15, 30)
    expect(cps[0]).toMatchObject({ x: 15, y: 30 });
    // cp2: (10+15, 20+20) = (25, 40)
    expect(cps[1]).toMatchObject({ x: 25, y: 40 });
  });

  test('relative q computes absolute control point from previous', () => {
    const path = new SvgPath('M 10 20 q 20 30 40 0');
    const anchors = path.targetLocations();
    // Endpoint: (10+40, 20+0) = (50, 20)
    expect(anchors[1]).toMatchObject({ x: 50, y: 20 });

    const cps = path.controlLocations();
    // cp: (10+20, 20+30) = (30, 50)
    expect(cps[0]).toMatchObject({ x: 30, y: 50 });
  });

  test('chained relative commands accumulate correctly', () => {
    const path = new SvgPath('M 0 0 l 10 0 l 10 0 l 10 0');
    const anchors = path.targetLocations();
    expect(anchors[0]).toMatchObject({ x: 0, y: 0 });
    expect(anchors[1]).toMatchObject({ x: 10, y: 0 });
    expect(anchors[2]).toMatchObject({ x: 20, y: 0 });
    expect(anchors[3]).toMatchObject({ x: 30, y: 0 });
  });

  test('relative m sets new origin for z', () => {
    const path = new SvgPath('m 10 20 l 50 0 l 0 50 z');
    const anchors = path.targetLocations();
    expect(anchors[0]).toMatchObject({ x: 10, y: 20 }); // m 10 20
    expect(anchors[1]).toMatchObject({ x: 60, y: 20 }); // l 50 0
    expect(anchors[2]).toMatchObject({ x: 60, y: 70 }); // l 0 50
    // Z goes back to origin (10, 20)
    const zEnd = path.path[3].getEndPoint();
    expect(zEnd).toMatchObject({ x: 10, y: 20 });
  });

  test('relative a computes absolute endpoint', () => {
    const path = new SvgPath('M 50 50 a 25 25 0 0 1 50 0');
    const anchors = path.targetLocations();
    // Endpoint: (50+50, 50+0) = (100, 50)
    expect(anchors[1]).toMatchObject({ x: 100, y: 50 });
  });

  test('setLocation on relative item updates relative values correctly', () => {
    const path = new SvgPath('M 10 20 l 30 40');
    const anchors = path.targetLocations();
    // Move l endpoint from absolute (40,60) to (50,70)
    path.setLocation(anchors[1], { x: 50, y: 70 });
    // Relative values should be (50-10, 70-20) = (40, 50)
    expect(path.path[1].values).toEqual([40, 50]);
    const newAnchors = path.targetLocations();
    expect(newAnchors[1]).toMatchObject({ x: 50, y: 70 });
  });

  test('setLocation on relative c control handle', () => {
    const path = new SvgPath('M 10 20 c 5 10 15 20 25 30');
    const cps = path.controlLocations();
    // Move cp1 from absolute (15,30) to (20,35)
    path.setLocation(cps[0], { x: 20, y: 35 });
    // Relative values: (20-10, 35-20) = (10, 15)
    expect(path.path[1].values[0]).toBe(10);
    expect(path.path[1].values[1]).toBe(15);
  });
});

// ─── getType ─────────────────────────────────────────────────────────────────

describe('SvgItem — getType', () => {
  test('getType(true) returns uppercase', () => {
    const item = SvgItem.Make(['l', '10', '20']);
    expect(item.getType(true)).toBe('L');
    expect(item.getType()).toBe('L'); // default
  });

  test('getType(false) respects relative flag', () => {
    const item = SvgItem.Make(['l', '10', '20']);
    expect(item.getType(false)).toBe('l');
  });

  test('getType(false) for absolute returns uppercase', () => {
    const item = SvgItem.Make(['L', '10', '20']);
    expect(item.getType(false)).toBe('L');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('SvgPath — edge cases', () => {
  test('single M command', () => {
    const path = new SvgPath('M 50 50');
    expect(path.path).toHaveLength(1);
    expect(path.targetLocations()).toHaveLength(1);
    expect(path.targetLocations()[0]).toMatchObject({ x: 50, y: 50 });
  });

  test('empty string produces empty path', () => {
    const path = new SvgPath('');
    expect(path.path).toHaveLength(0);
    expect(path.targetLocations()).toHaveLength(0);
    expect(path.controlLocations()).toHaveLength(0);
  });

  test('asString on empty path is empty', () => {
    const path = new SvgPath('');
    expect(path.asString()).toBe('');
  });

  test('ClosePath endpoint returns to origin', () => {
    const path = new SvgPath('M 10 20 L 100 200 Z');
    const zItem = path.path[2];
    expect(zItem.getEndPoint()).toMatchObject({ x: 10, y: 20 });
  });

  test('negative coordinates work', () => {
    const path = new SvgPath('M -10 -20 L -30 -40');
    const anchors = path.targetLocations();
    expect(anchors[0]).toMatchObject({ x: -10, y: -20 });
    expect(anchors[1]).toMatchObject({ x: -30, y: -40 });
  });

  test('floating point coordinates preserved', () => {
    const path = new SvgPath('M 1.5 2.5 L 3.75 4.25');
    const anchors = path.targetLocations();
    near(anchors[0].x, 1.5);
    near(anchors[0].y, 2.5);
    near(anchors[1].x, 3.75);
    near(anchors[1].y, 4.25);
  });
});

// ─── SvgItem.MakeFrom — type conversion ─────────────────────────────────────

describe('SvgItem.MakeFrom — relative flag', () => {
  test('MakeFrom with lowercase type creates relative item', () => {
    const path = new SvgPath('M 0 0 L 100 100');
    const item = path.path[1];
    const previous = { x: 0, y: 0 };
    const newItem = SvgItem.MakeFrom(item, previous, 'c');
    expect(newItem.relative).toBe(true);
    expect(newItem).toBeInstanceOf(CurveTo);
  });

  test('MakeFrom with uppercase type creates absolute item', () => {
    const path = new SvgPath('M 0 0 l 100 100');
    const item = path.path[1];
    item.refresh({ x: 0, y: 0 }, { x: 0, y: 0 });
    const previous = { x: 0, y: 0 };
    const newItem = SvgItem.MakeFrom(item, previous, 'C');
    expect(newItem.relative).toBe(false);
    expect(newItem).toBeInstanceOf(CurveTo);
  });
});

// ─── Cubic Bezier de Casteljau split ─────────────────────────────────────────

describe('SvgPath — insert de Casteljau split', () => {
  test('split at t=0.5 preserves the overall curve shape', () => {
    // Cubic from (0,0) via cp1=(100,0) cp2=(100,100) to (0,100)
    const path = new SvgPath('M 0 0 C 100 0 100 100 0 100');
    path.insert(0);

    // Should now have M, C (first half), C (second half) = 3 items
    expect(path.path).toHaveLength(3);

    // The midpoint (t=0.5) of this cubic is at (75, 50) via de Casteljau
    const midEnd = path.path[1].getEndPoint();
    near(midEnd.x, 75);
    near(midEnd.y, 50);

    // Final endpoint must still be (0, 100)
    const finalEnd = path.path[2].getEndPoint();
    near(finalEnd.x, 0);
    near(finalEnd.y, 100);
  });
});

// ─── Stress: many operations in sequence ─────────────────────────────────────

describe('SvgPath — sequential operations', () => {
  test('insert, delete, changeType in sequence', () => {
    const path = new SvgPath('M 0 0 L 100 0 L 100 100 L 0 100 Z');
    expect(path.path).toHaveLength(5);

    // Insert between first L and second L
    path.insert(1);
    expect(path.path).toHaveLength(6);

    // Change the inserted point to a curve
    path.changeType(2, 'C');
    expect(path.path[2]).toBeInstanceOf(CurveTo);

    // Delete the point after it
    path.delete(3);
    expect(path.path).toHaveLength(5);

    // Path should still serialize cleanly
    const d = path.asString();
    expect(d.length).toBeGreaterThan(0);

    // Re-parse should produce same structure
    const path2 = new SvgPath(d);
    expect(path2.path.length).toBe(path.path.length);
  });
});
