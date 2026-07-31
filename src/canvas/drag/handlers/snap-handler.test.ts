import { describe, test, expect, beforeEach } from 'vitest';
import { calculateSnap, getMouseVelocity, resetSnapHysteresis } from './snap-handler';
import type { Rect } from '@/shared/types';

describe('calculateSnap', () => {
  // Reset hysteresis state between tests to ensure isolation
  beforeEach(() => resetSnapHysteresis());
  const makeSibling = (id: string, left: number, top: number, width: number, height: number) => ({
    id,
    rect: { left, top, width, height } as Rect,
  });

  test('snaps to left edge of sibling within threshold', () => {
    const dragged: Rect = { left: 97, top: 200, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 200, 100)];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(100); // snapped to sibling's left edge
  });

  test('snaps to right edge of sibling', () => {
    const dragged: Rect = { left: 298, top: 200, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 200, 100)]; // right edge at 300
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(300);
  });

  test('snaps to center of sibling', () => {
    const dragged: Rect = { left: 148, top: 200, width: 100, height: 50 };
    // Dragged center = 148 + 50 = 198. Sibling center = 100 + 100 = 200.
    const siblings = [makeSibling('sib', 100, 100, 200, 100)];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(true);
    // Should snap dragged center to sibling center (200)
    expect(result.x).toBe(150); // 200 - 50 (half width)
  });

  test('snaps to top edge of sibling', () => {
    const dragged: Rect = { left: 500, top: 98, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 200, 100)];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedY).toBe(true);
    expect(result.y).toBe(100);
  });

  test('no snap when outside threshold', () => {
    const dragged: Rect = { left: 50, top: 50, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 200, 200, 100, 100)];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.guides).toHaveLength(0);
  });

  test('returns guides for active snap lines', () => {
    const dragged: Rect = { left: 98, top: 200, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 200, 100)];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.guides.length).toBeGreaterThan(0);
    expect(result.guides[0].axis).toBe('x');
    expect(result.guides[0].position).toBe(100);
    expect(result.guides[0].referenceId).toBe('sib');
  });

  test('break-out: fast mouse disengages snap', () => {
    const dragged: Rect = { left: 98, top: 200, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 200, 100)];
    const result = calculateSnap(dragged, siblings, 20, 5); // velocity 20 > breakout threshold 8

    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.guides).toHaveLength(0);
  });

  test('snaps to closest when multiple candidates', () => {
    const dragged: Rect = { left: 197, top: 200, width: 100, height: 50 };
    const siblings = [
      makeSibling('a', 100, 100, 100, 100), // right edge at 200
      makeSibling('b', 195, 300, 100, 100),  // left edge at 195
    ];
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(true);
    // Should snap to closer edge (195 is 2px away, 200 is 3px)
  });

  test('handles empty siblings array', () => {
    const dragged: Rect = { left: 100, top: 200, width: 100, height: 50 };
    const result = calculateSnap(dragged, [], 0, 5);

    expect(result.snappedX).toBe(false);
    expect(result.snappedY).toBe(false);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });
});

describe('same-size snap (3 lines)', () => {
  beforeEach(() => resetSnapHysteresis());
  const makeSibling = (id: string, left: number, top: number, width: number, height: number) => ({
    id,
    rect: { left, top, width, height } as Rect,
  });

  test('shows 3 vertical guides when widths match', () => {
    // Dragged: 100px wide at x=98 (snaps to sibling's left=100)
    // Sibling: also 100px wide at x=100
    const dragged: Rect = { left: 98, top: 200, width: 100, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 100, 50)]; // same width!
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedX).toBe(true);
    // Should have 3 guides: left edge (100), center (150), right edge (200)
    const xGuides = result.guides.filter(g => g.axis === 'x');
    expect(xGuides.length).toBe(3);
    expect(xGuides.map(g => g.position).sort((a, b) => a - b)).toEqual([100, 150, 200]);
  });

  test('shows 3 horizontal guides when heights match', () => {
    const dragged: Rect = { left: 200, top: 98, width: 50, height: 80 };
    const siblings = [makeSibling('sib', 100, 100, 50, 80)]; // same height!
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.snappedY).toBe(true);
    const yGuides = result.guides.filter(g => g.axis === 'y');
    expect(yGuides.length).toBe(3);
    expect(yGuides.map(g => g.position).sort((a, b) => a - b)).toEqual([100, 140, 180]);
  });

  test('shows 1 guide when sizes differ', () => {
    const dragged: Rect = { left: 98, top: 200, width: 150, height: 50 };
    const siblings = [makeSibling('sib', 100, 100, 100, 50)]; // different width
    const result = calculateSnap(dragged, siblings, 0, 5);

    const xGuides = result.guides.filter(g => g.axis === 'x');
    expect(xGuides.length).toBe(1); // only 1 guide, not 3
  });
});

describe('equal-spacing distance bands', () => {
  beforeEach(() => resetSnapHysteresis());
  const makeSibling = (id: string, left: number, top: number, width: number, height: number) => ({
    id,
    rect: { left, top, width, height } as Rect,
  });

  test('detects equal horizontal spacing and snaps to extend pattern', () => {
    // Two siblings with 50px gap between them
    const siblings = [
      makeSibling('a', 100, 100, 80, 80),  // right edge at 180
      makeSibling('b', 230, 100, 80, 80),  // left edge at 230, gap = 50px
    ];
    // Dragged element near the right of B (should snap to 310+50 = 360)
    const dragged: Rect = { left: 358, top: 100, width: 80, height: 80 };
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.spacingGuides.length).toBeGreaterThan(0);
    expect(result.spacingGuides[0].distance).toBe(50);
    expect(result.spacingGuides[0].segments.length).toBe(2); // two bands shown
  });

  test('no spacing guide when gap is unequal', () => {
    const siblings = [
      makeSibling('a', 100, 100, 80, 80),
      makeSibling('b', 250, 100, 80, 80), // gap = 70px
    ];
    // Dragged at position that doesn't match any equal spacing
    const dragged: Rect = { left: 500, top: 100, width: 80, height: 80 };
    const result = calculateSnap(dragged, siblings, 0, 5);

    expect(result.spacingGuides.length).toBe(0);
  });
});

describe('snap hysteresis', () => {
  beforeEach(() => resetSnapHysteresis());

  test('once snapped, requires higher velocity to break free (1.5x breakout speed)', () => {
    const dragged: Rect = { left: 98, top: 200, width: 100, height: 50 };
    const siblings = [{ id: 'sib', rect: { left: 100, top: 100, width: 200, height: 100 } as Rect }];

    // First call snaps (velocity 0)
    const r1 = calculateSnap(dragged, siblings, 0, 5);
    expect(r1.snappedX).toBe(true);

    // Second call with velocity just above normal breakout (8) but below hysteresis breakout (12)
    // Should still snap because we're in hysteresis mode
    const r2 = calculateSnap(dragged, siblings, 10, 5);
    expect(r2.snappedX).toBe(true);

    // Third call with velocity above hysteresis breakout (12)
    const r3 = calculateSnap(dragged, siblings, 15, 5);
    expect(r3.snappedX).toBe(false);
  });

  test('resetSnapHysteresis clears sticky state', () => {
    const dragged: Rect = { left: 98, top: 200, width: 100, height: 50 };
    const siblings = [{ id: 'sib', rect: { left: 100, top: 100, width: 200, height: 100 } as Rect }];

    // Snap first
    calculateSnap(dragged, siblings, 0, 5);

    // Reset
    resetSnapHysteresis();

    // Now normal breakout speed should work (velocity 10 > 8)
    const result = calculateSnap(dragged, siblings, 10, 5);
    expect(result.snappedX).toBe(false);
  });
});

describe('getMouseVelocity', () => {
  test('calculates distance between two points', () => {
    const v = getMouseVelocity({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(v).toBe(5); // 3-4-5 triangle
  });

  test('returns 0 for same point', () => {
    const v = getMouseVelocity({ x: 10, y: 20 }, { x: 10, y: 20 });
    expect(v).toBe(0);
  });
});

// ─── Parent-as-snap-target (non-regression) ───────────────────────────────
//
// AbsoluteInFrameStrategy now passes the dragged child's PARENT rect into
// `siblingRects` so its edges become valid snap targets. These tests lock
// in that the snap math handles a "container" rect (one that fully encloses
// the dragged rect) the same as any other sibling, without misfiring on
// equal-spacing or same-size detection.

describe('calculateSnap with parent rect included', () => {
  beforeEach(() => resetSnapHysteresis());
  const parent = { id: 'parent', rect: { left: 0, top: 0, width: 1000, height: 600 } as Rect };

  test('snaps to parent left edge when child near left', () => {
    const dragged: Rect = { left: 2, top: 100, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(0);
  });

  test('snaps to parent right edge when child near right', () => {
    const dragged: Rect = { left: 798, top: 100, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(800); // dragged.right == parent.right(1000)
  });

  test('snaps to parent top edge when child near top', () => {
    const dragged: Rect = { left: 100, top: 3, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    expect(result.snappedY).toBe(true);
    expect(result.y).toBe(0);
  });

  test('snaps to parent center horizontally', () => {
    // parent center at 500, dragged center at 401 (drag left=301, width=200 → center=401).
    const dragged: Rect = { left: 397, top: 100, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(400); // dragged center → parent center (500)
  });

  test('does not trigger equal-spacing for the dragged-vs-parent overlap', () => {
    // Parent fully encloses dragged — gap collection skips negative gaps,
    // so no spacing guides should appear.
    const dragged: Rect = { left: 100, top: 100, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    expect(result.spacingGuides).toEqual([]);
  });

  test('does not trigger same-size detection for unequal sizes', () => {
    // Parent is 1000×600, dragged is 200×100 — same-size guides require
    // matching edges on BOTH sides, which can't happen.
    const dragged: Rect = { left: 0, top: 0, width: 200, height: 100 };
    const result = calculateSnap(dragged, [parent], 0, 5);
    // At most one guide per axis (the snapped edge), not three.
    const xGuides = result.guides.filter((g) => g.axis === 'x');
    const yGuides = result.guides.filter((g) => g.axis === 'y');
    expect(xGuides.length).toBeLessThanOrEqual(1);
    expect(yGuides.length).toBeLessThanOrEqual(1);
  });

  test('parent rect coexists with regular siblings (snap chooses closest)', () => {
    const sibling = { id: 'sib', rect: { left: 100, top: 100, width: 100, height: 50 } as Rect };
    // Drag at left=4 — parent left edge (0) is 4 away, sibling left edge (100)
    // is 96 away. Parent should win.
    const dragged: Rect = { left: 4, top: 100, width: 50, height: 50 };
    const result = calculateSnap(dragged, [parent, sibling], 0, 5);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(0);
  });
});

describe('transform-aware snap (rotated drag)', () => {
  beforeEach(() => resetSnapHysteresis());
  const sibling = { id: 'sib', rect: { left: 200, top: 100, width: 100, height: 100 } as Rect };

  test('rotated drag corner snaps exactly to sibling AABB edge', () => {
    // 45° rotated 100×100 element. AABB is ~141×141, much wider than visible quad.
    // dragRect (the AABB) is at left=130 — its right AABB edge at 270, but the
    // rightmost rotated corner is at x=200.71 — almost exactly on sibling.left=200.
    const dragRect: Rect = { left: 130, top: 130, width: 142, height: 142 };
    const dragCorners = {
      TL: { x: 201, y: 130 },
      TR: { x: 271, y: 200 },
      BR: { x: 201, y: 271 },
      BL: { x: 130, y: 201 },
    };
    const result = calculateSnap(dragRect, [sibling], 0, 5, dragCorners);
    expect(result.snappedX).toBe(true);
    // The shift moves the AABB so the closest corner (TL.x=201) lands at sibLeft=200
    expect(result.x).toBe(129); // 130 + (200 - 201) = 129
  });

  test('rotated drag does NOT snap via invisible AABB edges', () => {
    // dragRect AABB right at 270 — sibling left at 200.
    // The AABB-only snap WOULD have moved AABB.right→200 (shift -70).
    // We must NOT do that — the visible corners are nowhere near 200 here.
    const dragRect: Rect = { left: 130, top: 0, width: 142, height: 142 };
    // All corners are far from sibling.left=200 (closest is 200, but >5px from anywhere)
    const dragCorners = {
      TL: { x: 130, y: 71 },
      TR: { x: 213, y: 0 },
      BR: { x: 271, y: 71 },
      BL: { x: 188, y: 142 },
    };
    // Sibling at left=200; closest rotated corner TL.x=130 is 70 away,
    // TR.x=213 is 13 away, BL.x=188 is 12 away — all > threshold 5.
    const result = calculateSnap(dragRect, [sibling], 0, 5, dragCorners);
    expect(result.snappedX).toBe(false);
  });

  test('non-rotated drag still snaps via AABB edges (corners undefined)', () => {
    // Regression: making sure the AABB path is preserved when no corners provided
    const dragRect: Rect = { left: 197, top: 100, width: 100, height: 100 };
    const result = calculateSnap(dragRect, [sibling], 0, 5);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(200); // dragLeft → sibLeft
  });

  // ─── Ruler guides as snap targets ────────────────────────────────────

  test('vertical ruler guide snaps the dragged left edge', () => {
    const dragged: Rect = { left: 297, top: 200, width: 100, height: 50 };
    // Vertical guide at canvas-x = 300 → expect dragLeft to snap from 297 → 300.
    const result = calculateSnap(
      dragged, [], 0, 5, undefined, undefined,
      [{ id: 'g1', axis: 'x', position: 300 }],
    );
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(300);
    // Guide entry should reference the ruler-guide.
    expect(result.guides.some(g => g.referenceId === 'ruler-guide:g1' && g.axis === 'x' && g.position === 300)).toBe(true);
  });

  test('vertical ruler guide snaps the dragged right edge', () => {
    const dragged: Rect = { left: 198, top: 0, width: 100, height: 50 };
    // Right edge at 298, guide at 300 → snaps left to 200 (so right hits 300).
    const result = calculateSnap(
      dragged, [], 0, 5, undefined, undefined,
      [{ id: 'g1', axis: 'x', position: 300 }],
    );
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(200);
  });

  test('vertical ruler guide snaps the dragged horizontal center', () => {
    // Dragged center at 148, guide at 150 → snap left from 98 → 100.
    const dragged: Rect = { left: 98, top: 0, width: 100, height: 50 };
    const result = calculateSnap(
      dragged, [], 0, 5, undefined, undefined,
      [{ id: 'g1', axis: 'x', position: 150 }],
    );
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(100);
  });

  test('horizontal ruler guide snaps the dragged top edge', () => {
    const dragged: Rect = { left: 0, top: 197, width: 100, height: 50 };
    const result = calculateSnap(
      dragged, [], 0, 5, undefined, undefined,
      [{ id: 'g1', axis: 'y', position: 200 }],
    );
    expect(result.snappedY).toBe(true);
    expect(result.y).toBe(200);
  });

  test('ruler guide outside threshold does not snap', () => {
    const dragged: Rect = { left: 50, top: 0, width: 100, height: 50 };
    // Closest dragged X anchor (left=50, center=100, right=150) is 50 away from guide @ 0 — outside threshold.
    const result = calculateSnap(
      dragged, [], 0, 5, undefined, undefined,
      [{ id: 'g1', axis: 'x', position: 0 }],
    );
    expect(result.snappedX).toBe(false);
    expect(result.x).toBe(50);
  });

  test('rotated drag uses corner positions for ruler-guide snap (not AABB edges)', () => {
    // Rotated drag — only TL corner is near the guide. The AABB left (100)
    // is 100px from the guide @ 200 and would miss; the corner at 195 is
    // 5px away → snap fires and shifts AABB by +5 so TL lands on the guide.
    const dragRect: Rect = { left: 100, top: 100, width: 200, height: 200 };
    const dragCorners = {
      TL: { x: 195, y: 100 },
      TR: { x: 350, y: 195 },
      BR: { x: 250, y: 350 },
      BL: { x: 100, y: 250 },
    };
    const result = calculateSnap(
      dragRect, [], 0, 5, dragCorners, undefined,
      [{ id: 'g1', axis: 'x', position: 200 }],
    );
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(105);
  });

  test('rotated drag corner snaps to sibling rotated corner', () => {
    const sibCorners = new Map([
      ['sib', {
        TL: { x: 250, y: 150 },
        TR: { x: 320, y: 220 },
        BR: { x: 250, y: 290 },
        BL: { x: 180, y: 220 },
      }],
    ]);
    const sibAabb = { id: 'sib', rect: { left: 180, top: 150, width: 140, height: 140 } as Rect };
    const dragRect: Rect = { left: 320, top: 80, width: 142, height: 142 };
    const dragCorners = {
      TL: { x: 391, y: 80 },
      TR: { x: 461, y: 151 },
      BR: { x: 391, y: 222 },
      BL: { x: 320, y: 151 }, // BL corner near sibling TR (320, 220) — 71 away in y
    };
    // Adjust: place BL exactly 4px right of sibling TR
    dragCorners.BL.x = 324; // sibTR.x + 4 → snap pulls BL.x to 320
    const result = calculateSnap(dragRect, [sibAabb], 0, 5, dragCorners, sibCorners);
    expect(result.snappedX).toBe(true);
    expect(result.x).toBe(316); // 320 - 4 shift
  });
});
