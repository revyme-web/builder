// Reported 2026-08-26: replica → canvas → no-layout frame never reparented,
// while the same gesture from the primary did. CanvasDragStrategy measured the
// dragged element under the node MODEL's viewport (canvas → `desktop`) after
// the mid-drag handoff, but the live element was still in the mobile tile and
// the desktop copy had been hidden at drag start. See dragged-node-rect.ts.

import { describe, it, expect, vi } from 'vitest';
import { isMeasurableRect, resolveDraggedRect } from './dragged-node-rect';

const rect = (width: number, height: number) => ({ width, height });
const VISIBLE = rect(440, 198);
/** How `display: none` reaches the rect cache when the entry survives. */
const HIDDEN = rect(0, 0);

describe('isMeasurableRect', () => {
  it('a painted rect is measurable', () => {
    expect(isMeasurableRect(VISIBLE)).toBe(true);
  });

  it('missing and zero-area both read as not-on-screen', () => {
    expect(isMeasurableRect(null)).toBe(false);
    expect(isMeasurableRect(undefined)).toBe(false);
    expect(isMeasurableRect(HIDDEN)).toBe(false);
  });

  it('a single collapsed axis is still unmeasurable', () => {
    // Containment against a zero-width box answers "outside" rather than
    // failing — the silent mode this whole module exists to prevent.
    expect(isMeasurableRect(rect(440, 0))).toBe(false);
    expect(isMeasurableRect(rect(0, 198))).toBe(false);
  });
});

describe('resolveDraggedRect', () => {
  it('THE BUG: falls back to the tile still painting the element', () => {
    // Post-handoff state: model says canvas (`desktop`), DOM is in `mobile`,
    // and drag start hid the desktop + tablet copies.
    const lookup = (vpId: string) => (vpId === 'mobile' ? VISIBLE : HIDDEN);
    expect(resolveDraggedRect('desktop', ['desktop', 'tablet', 'mobile'], lookup))
      .toEqual({ vpId: 'mobile', rect: VISIBLE });
  });

  it('an absent preferred copy falls back too', () => {
    const lookup = (vpId: string) => (vpId === 'mobile' ? VISIBLE : null);
    expect(resolveDraggedRect('desktop', ['mobile'], lookup)?.vpId).toBe('mobile');
  });

  it('the ordinary drag never scans — preferred wins and is asked once', () => {
    const lookup = vi.fn(() => VISIBLE);
    expect(resolveDraggedRect('desktop', ['tablet', 'mobile'], lookup))
      .toEqual({ vpId: 'desktop', rect: VISIBLE });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not re-test the preferred viewport listed among the fallbacks', () => {
    const lookup = vi.fn((vpId: string) => (vpId === 'mobile' ? VISIBLE : HIDDEN));
    resolveDraggedRect('desktop', ['desktop', 'mobile'], lookup);
    expect(lookup.mock.calls.filter(([vp]) => vp === 'desktop')).toHaveLength(1);
  });

  it('returns the FIRST painting viewport, in the order given', () => {
    const lookup = () => VISIBLE;
    expect(resolveDraggedRect('desktop', ['tablet', 'mobile'], () =>
      lookup() as any)?.vpId).toBe('desktop');
    expect(resolveDraggedRect('gone', ['tablet', 'mobile'], (vp) =>
      vp === 'gone' ? HIDDEN : VISIBLE)?.vpId).toBe('tablet');
  });

  it('nothing paints it anywhere → null, and the caller bails as before', () => {
    expect(resolveDraggedRect('desktop', ['tablet', 'mobile'], () => HIDDEN)).toBeNull();
    expect(resolveDraggedRect('desktop', [], () => null)).toBeNull();
  });
});
