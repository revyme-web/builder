import { describe, it, expect } from 'vitest';
import { clampSpacingValue } from './SpacingControl';

// SpacingControl is shared by margin, padding, and radius — PX-ONLY since
// 2026-08-12 (the %/rem unit cycle was removed; every commit writes `<n>px`).
// Padding/radius can't be negative in CSS (lower bound 0); margin CAN
// (allowNegative) — needed for overlap / pull-up layouts.
describe('clampSpacingValue — negative allowed only for margin', () => {
  it('clamps the lower bound to 0 when negatives are NOT allowed (padding/radius)', () => {
    expect(clampSpacingValue(-100, false)).toBe(0);
    expect(clampSpacingValue(-5, false)).toBe(0);
    expect(clampSpacingValue(24, false)).toBe(24); // positives pass
  });

  it('allows negatives down to -999 when allowed (margin)', () => {
    expect(clampSpacingValue(-100, true)).toBe(-100);
    expect(clampSpacingValue(-30, true)).toBe(-30);
  });

  it('clamps to ±999 (both directions)', () => {
    expect(clampSpacingValue(9999, true)).toBe(999);
    expect(clampSpacingValue(-9999, true)).toBe(-999);
    expect(clampSpacingValue(-9999, false)).toBe(0);
  });
});
