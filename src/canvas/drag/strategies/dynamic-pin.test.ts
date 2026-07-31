// dynamic-pin.test.ts — auto-pin assignment coverage for both parent types.
//
// VIEWPORT parent (parentIsViewport = true):
//   • Y axis is always 'top-px'.
//   • X axis: 3-band split — left-px / left-percent / left-px (default) → right-px (snap).
//
// FRAME parent (parentIsViewport = false, the default):
//   • Both axes use 3-band split independently.
//   • X axis: left-px / left-percent / left-px (default) → right-px (snap).
//   • Y axis: top-px / top-percent / bottom-px (auto — no snap needed).

import { describe, test, expect } from 'vitest';
import { computeAutoPins } from './dynamic-pin';

const PARENT_W = 900;  // 3 × 300 bands
const PARENT_H = 600;  // 3 × 200 bands
const ELEM_W = 100;
const ELEM_H = 80;

describe('computeAutoPins — viewport parent (Y always top)', () => {
  test('left band → left-px, top-px', () => {
    const p = computeAutoPins(20, 20, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, true);
    expect(p).toEqual({ x: 'left-px', y: 'top-px' });
  });

  test('middle band → left-percent, top-px', () => {
    const p = computeAutoPins(350, 20, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, true);
    expect(p).toEqual({ x: 'left-percent', y: 'top-px' });
  });

  test('right band, no snap → left-px (default), top-px', () => {
    const p = computeAutoPins(700, 20, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, true);
    expect(p).toEqual({ x: 'left-px', y: 'top-px' });
  });

  test('right band + snapped-to-right → right-px, top-px', () => {
    const p = computeAutoPins(700, 20, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, true);
    expect(p).toEqual({ x: 'right-px', y: 'top-px' });
  });

  test('element low in viewport — Y stays top-px (never bottom)', () => {
    const p = computeAutoPins(20, PARENT_H - ELEM_H - 10, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, true);
    expect(p.y).toBe('top-px');
  });

  test('exact center of viewport — Y stays top-px (no top-percent)', () => {
    const cx = (PARENT_W - ELEM_W) / 2;
    const cy = (PARENT_H - ELEM_H) / 2;
    const p = computeAutoPins(cx, cy, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, true);
    expect(p).toEqual({ x: 'left-percent', y: 'top-px' });
  });
});

describe('computeAutoPins — frame parent (full 3×3 zones)', () => {
  // Helper: position so child CENTER lands in (bandX, bandY) of a 3×3 grid.
  // band indices 0=start, 1=middle, 2=end.
  const place = (bandX: 0 | 1 | 2, bandY: 0 | 1 | 2) => {
    const centerOf = (band: number, size: number) => {
      // mid-of-band: (band + 0.5) / 3 * size
      const c = ((band + 0.5) / 3) * size;
      return c;
    };
    const cx = centerOf(bandX, PARENT_W);
    const cy = centerOf(bandY, PARENT_H);
    return { left: cx - ELEM_W / 2, top: cy - ELEM_H / 2 };
  };

  test('top-left zone → left-px, top-px', () => {
    const { left, top } = place(0, 0);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'top-px' });
  });

  test('top-center zone → left-percent, top-px', () => {
    const { left, top } = place(1, 0);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-percent', y: 'top-px' });
  });

  test('top-right zone no snap → left-px (default), top-px', () => {
    const { left, top } = place(2, 0);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'top-px' });
  });

  test('top-right zone + snap-right → right-px, top-px', () => {
    const { left, top } = place(2, 0);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, false);
    expect(p).toEqual({ x: 'right-px', y: 'top-px' });
  });

  test('center-left zone → left-px, top-percent', () => {
    const { left, top } = place(0, 1);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'top-percent' });
  });

  test('exact center → left-percent, top-percent (no pin per axis)', () => {
    const { left, top } = place(1, 1);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-percent', y: 'top-percent' });
  });

  test('center-right zone no snap → left-px, top-percent', () => {
    const { left, top } = place(2, 1);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'top-percent' });
  });

  test('center-right zone + snap-right → right-px, top-percent', () => {
    const { left, top } = place(2, 1);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, false);
    expect(p).toEqual({ x: 'right-px', y: 'top-percent' });
  });

  test('bottom-left zone → left-px, bottom-px (Y auto-pins, no snap needed)', () => {
    const { left, top } = place(0, 2);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'bottom-px' });
  });

  test('bottom-center zone → left-percent, bottom-px', () => {
    const { left, top } = place(1, 2);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-percent', y: 'bottom-px' });
  });

  test('bottom-right zone no snap → left-px (default), bottom-px', () => {
    const { left, top } = place(2, 2);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'bottom-px' });
  });

  test('bottom-right zone + snap-right → right-px, bottom-px', () => {
    const { left, top } = place(2, 2);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, false);
    expect(p).toEqual({ x: 'right-px', y: 'bottom-px' });
  });

  test('snap-right in middle X band is ignored (only band 3 listens)', () => {
    const { left, top } = place(1, 1);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, false);
    expect(p.x).toBe('left-percent');
  });

  test('snap-right in left X band is ignored', () => {
    const { left, top } = place(0, 0);
    const p = computeAutoPins(left, top, ELEM_W, ELEM_H, PARENT_W, PARENT_H, true, false);
    expect(p.x).toBe('left-px');
  });
});

describe('computeAutoPins — boundary tiebreaks (frame parent)', () => {
  test('Y center exactly at band1End → middle band (top-percent)', () => {
    // childTop = 160, childHeight = 80 → center = 200 = PARENT_H / 3
    const p = computeAutoPins(20, 160, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p.y).toBe('top-percent');
  });

  test('Y center exactly at band2End → bottom band (bottom-px)', () => {
    // childTop = 360, childHeight = 80 → center = 400 = 2 * PARENT_H / 3
    const p = computeAutoPins(20, 360, ELEM_W, ELEM_H, PARENT_W, PARENT_H, false, false);
    expect(p.y).toBe('bottom-px');
  });

  test('parentInnerHeight = 0 → top-px fallback', () => {
    expect(computeAutoPins(0, 0, 100, 100, 100, 0, false, false).y).toBe('top-px');
  });
});

describe('computeAutoPins — overflow guards (element bigger than parent)', () => {
  test('child taller than parent → top-px regardless of band', () => {
    // child height 200, parent inner height 100 → child overflows on Y.
    // Without the guard, center=100 lands in band 3 → bottom-px would
    // produce `bottom = 100 - top - 200 = -200 - top` (negative),
    // visibly jumping the element above the parent.
    const p = computeAutoPins(20, 0, 80, 200, 300, 100, false, false);
    expect(p.y).toBe('top-px');
  });

  test('child wider than parent → left-px regardless of band', () => {
    const p = computeAutoPins(0, 20, 400, 80, 300, 100, false, false);
    expect(p.x).toBe('left-px');
  });

  test('overflow guard wins even with snap-to-right flag', () => {
    // Wide overflowing child + snap-right gesture: overflow still wins
    // (right-px would still produce a negative value).
    const p = computeAutoPins(0, 20, 400, 80, 300, 100, true, false);
    expect(p.x).toBe('left-px');
  });

  test('child equals parent size exactly → still left-px / top-px (safe fallback)', () => {
    // Edge case: childSize === parentSize means cs.right or cs.bottom
    // would be exactly 0. Not strictly negative but visually identical
    // to left-px / top-px so prefer the simpler form.
    const p = computeAutoPins(0, 0, 300, 100, 300, 100, false, false);
    expect(p).toEqual({ x: 'left-px', y: 'top-px' });
  });

  test('soft overflow on Y: element fits but bottom edge sticks past parent → top-px', () => {
    // childHeight 94 < parentInnerHeight 100 (fits), but childTop is
    // far enough down that the bottom edge exceeds the parent
    // (childTop + 94 > 100). Without the soft guard, band-3 detection
    // would produce `cs.bottom = 100 - childTop - 94` = negative, and
    // the element would visibly jump upward by |csBottom| px on entry
    // into the cell.
    // childTop = 25, childHeight = 94 → bottom edge at 119 (overflow by 19)
    // centerY = 72 → in band 3.
    const p = computeAutoPins(20, 25, 80, 94, 300, 100, false, false);
    expect(p.y).toBe('top-px');
  });

  test('soft overflow on X with snap-right: right edge sticks past parent → left-px', () => {
    // Snap-right gesture, but the element's right edge would sit past
    // the parent's right edge → fall back to left-px.
    // childLeft 250 + childWidth 80 = 330, parentInnerWidth 300 → overflow.
    // centerX = 290 → band 3 territory.
    const p = computeAutoPins(250, 0, 80, 50, 300, 100, true, false);
    expect(p.x).toBe('left-px');
  });

  test('band 3 with valid positive cs.bottom → bottom-px (still works)', () => {
    // Sanity: when the element FITS comfortably in band 3, the soft
    // guard doesn't fire and we still get bottom-px.
    // childTop 70, childHeight 20 → bottom at 90, fits inside 100.
    // centerY = 80 → band 3. cs.bottom = 10 (positive) → bottom-px.
    const p = computeAutoPins(20, 70, 80, 20, 300, 100, false, false);
    expect(p.y).toBe('bottom-px');
  });
});
