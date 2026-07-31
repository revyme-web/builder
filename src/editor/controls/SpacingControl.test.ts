import { describe, it, expect } from 'vitest';
import { clampSpacingValue } from './SpacingControl';

// SpacingControl is shared by margin, padding, and radius. Padding/radius can't
// be negative in CSS (lower bound 0); margin CAN (allowNegative) — needed for
// overlap / pull-up layouts. This pins the clamp bounds per unit.
describe('clampSpacingValue — negative allowed only for margin', () => {
  it('clamps the lower bound to 0 when negatives are NOT allowed (padding/radius)', () => {
    expect(clampSpacingValue(-100, 'px', false)).toBe(0);
    expect(clampSpacingValue(-5, '%', false)).toBe(0);
    expect(clampSpacingValue(-2, 'rem', false)).toBe(0);
    expect(clampSpacingValue(24, 'px', false)).toBe(24); // positives pass
  });

  it('allows negatives down to -max when allowed (margin)', () => {
    expect(clampSpacingValue(-100, 'px', true)).toBe(-100);
    expect(clampSpacingValue(-30, '%', true)).toBe(-30);
    expect(clampSpacingValue(-1.5, 'rem', true)).toBe(-1.5);
  });

  it('clamps to the per-unit max (both directions)', () => {
    expect(clampSpacingValue(9999, 'px', true)).toBe(999);
    expect(clampSpacingValue(-9999, 'px', true)).toBe(-999);
    expect(clampSpacingValue(500, '%', true)).toBe(100);
    expect(clampSpacingValue(-500, '%', true)).toBe(-100);
    expect(clampSpacingValue(999, 'rem', true)).toBe(99);
  });
});
