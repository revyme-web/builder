// pin-constraint-utils.test.ts — equality-guard behavior for the pin-lines
// RAF poll. The guard is what stands between per-frame object churn and
// React's update-depth limit, so its edge cases are load-bearing.

import { describe, it, expect } from 'vitest';
import { pinDataEqual } from './pin-constraint-utils';

const rect = (left: number, top = 0, width = 100, height = 50) => ({ left, top, width, height });
const pd = (er: ReturnType<typeof rect>, pr: ReturnType<typeof rect>) =>
  ({ lp: true, rp: false, tp: true, bp: false, er, pr });

describe('pinDataEqual', () => {
  it('same values → equal', () => {
    expect(pinDataEqual(pd(rect(1), rect(0)) as any, pd(rect(1), rect(0)) as any)).toBe(true);
  });

  it('null handling', () => {
    expect(pinDataEqual(null, null)).toBe(true);
    expect(pinDataEqual(null, pd(rect(1), rect(0)) as any)).toBe(false);
  });

  // NaN-stable equality (update-depth crash, 2026-07-30): a failed bridge
  // read mid-drag can produce NaN rect fields; with === the guard was
  // PERMANENTLY false → per-frame fresh state objects → synchronous
  // set→render→effect chain → "Maximum update depth exceeded" and a full
  // app crash. Object.is(NaN, NaN) is true, so the guard holds.
  it('treats identical NaN rects as EQUAL (guard must hold, not loop)', () => {
    const a = pd(rect(NaN), rect(0));
    const b = pd(rect(NaN), rect(0));
    expect(pinDataEqual(a as any, b as any)).toBe(true);
  });

  it('still detects real changes', () => {
    expect(pinDataEqual(pd(rect(1), rect(0)) as any, pd(rect(2), rect(0)) as any)).toBe(false);
    expect(pinDataEqual(pd(rect(1), rect(0)) as any, pd(rect(1), rect(3)) as any)).toBe(false);
  });
});
