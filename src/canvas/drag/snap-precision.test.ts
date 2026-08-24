// The invariant: while an axis is SNAPPED, the committed position depends only
// on the snap target — never on where the mouse sits between two CSS pixels.
//
// Reported 2026-08-24: at high zoom a snapped element jiggled 1px left/right
// with every mouse move, and the dynamic-pin badge flipped L/R/L/R while it was
// visibly locked to a guide.

import { describe, it, expect } from 'vitest';
import { snapCorrection } from './snap-precision';

/** What a strategy commits for one node this frame. */
const commit = (startLocal: number, delta: number, targetAbs: number, parentOffset: number, snapped: boolean) =>
  Math.round(startLocal + delta + snapCorrection(startLocal + delta, targetAbs, parentOffset, snapped));

/** Mouse pixels → CSS px at a given zoom. 8× ⇒ one mouse pixel is 0.125 CSS px. */
const sweep = (scale: number, steps: number) =>
  Array.from({ length: steps }, (_, i) => i / scale);

describe('snapCorrection', () => {
  it('lands exactly on the target whatever the sub-pixel remainder', () => {
    const target = 220.4, parentOffset = 200;
    for (const raw of [13, 13.125, 13.5, 13.874, 14, -0.3]) {
      expect(raw + snapCorrection(raw, target, parentOffset, true)).toBeCloseTo(20.4, 10);
    }
  });

  it('is inert on an un-snapped axis — the drag follows the cursor', () => {
    for (const raw of [13, 13.125, 13.874]) {
      expect(snapCorrection(raw, 220.4, 200, false)).toBe(0);
    }
  });
});

describe('THE BUG: a snapped element must not move while the mouse does', () => {
  const startLocal = 13, targetAbs = 220.4, parentOffset = 200;

  it('holds one position across a sub-pixel sweep at 8× zoom', () => {
    const committed = sweep(8, 24).map((d) => commit(startLocal, d, targetAbs, parentOffset, true));
    expect(new Set(committed).size, `sawtoothed: ${committed.join(',')}`).toBe(1);
    expect(committed[0]).toBe(20);
  });

  it('holds at every zoom level — 1×, 4×, 16×', () => {
    for (const scale of [1, 4, 16]) {
      const committed = sweep(scale, 24).map((d) => commit(startLocal, d, targetAbs, parentOffset, true));
      expect(new Set(committed).size, `scale ${scale}: ${committed.join(',')}`).toBe(1);
    }
  });

  it('THE OLD ARITHMETIC sawtooths — proving the sweep can detect it', () => {
    // `correction = target - ROUND(raw)`, which is what both strategies did.
    // Without this the tests above could pass against a broken implementation
    // that merely happened to be stable.
    const broken = sweep(8, 24).map((d) => {
      const raw = startLocal + d;
      const correction = (targetAbs - parentOffset) - Math.round(raw);
      return Math.round(raw + correction);
    });
    expect(new Set(broken).size).toBeGreaterThan(1);
  });
});

describe('the dynamic-pin side stays decided', () => {
  // `snappedToRightEdge` = the element's right edge within 1px of the parent's
  // inner right edge. The old residue swung that distance by up to 0.875px, so
  // a TRUE distance of 0.6 crossed the 1px threshold and the pin flipped.
  const startLocal = 13, targetAbs = 220.4, parentOffset = 200;
  const elemW = 7, parentW = 28;

  const pinAt = (d: number) => {
    const raw = startLocal + d;
    const local = raw + snapCorrection(raw, targetAbs, parentOffset, true);
    return Math.abs(local + elemW - parentW) <= 1 ? 'right-px' : 'left-px';
  };

  it('never flips while the element is snapped', () => {
    const pins = sweep(8, 24).map(pinAt);
    expect(new Set(pins).size, pins.join(',')).toBe(1);
    expect(pins[0]).toBe('right-px'); // true distance is 0.6 → inside the 1px band
  });
});
