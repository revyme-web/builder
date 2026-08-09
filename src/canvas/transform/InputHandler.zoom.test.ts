// InputHandler.zoom.test.ts — trackpad pinch and Ctrl+wheel are the same event
// with wildly different magnitudes.
//
// User report 2026-08-09: pinch-to-zoom on a trackpad was so slow it took five
// separate gestures to zoom in on one element. Browsers synthesise a pinch as a
// wheel event with `ctrlKey` set — indistinguishable in shape from Ctrl + mouse
// wheel — so a single sensitivity was serving a ~100-per-notch mouse and a
// ~1-20-per-event trackpad. Tuned for the mouse, the trackpad crawled.

import { describe, it, expect } from 'vitest';
import { isTrackpadPinch, wheelZoomFactor } from './InputHandler';
import {
  ZOOM_PINCH_SENSITIVITY, ZOOM_WHEEL_SENSITIVITY, ZOOM_MAX_DELTA,
} from './constants';

const ev = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode });
/** Cmd (macOS) or Ctrl physically held — the user asked for a zoom. */
const cmd = (deltaY: number) => ({ deltaY, deltaMode: 0, metaKey: true });

describe('isTrackpadPinch', () => {
  it('small pixel deltas are a pinch', () => {
    expect(isTrackpadPinch(ev(4))).toBe(true);
    expect(isTrackpadPinch(ev(-12))).toBe(true);
    expect(isTrackpadPinch(ev(0.5))).toBe(true);
  });

  it('a mouse notch is not', () => {
    expect(isTrackpadPinch(ev(100))).toBe(false);
    expect(isTrackpadPinch(ev(-120))).toBe(false);
  });

  it('Cmd + trackpad scroll is NOT a pinch, however small the deltas', () => {
    // THE REGRESSION: Cmd + two-finger scroll emits the same small pixel
    // deltas as a pinch, so it fell into the fast bucket and zoomed away.
    // A synthesised pinch never sets metaKey — that is the discriminator.
    expect(isTrackpadPinch(cmd(4))).toBe(false);
    expect(isTrackpadPinch(cmd(-12))).toBe(false);
    expect(isTrackpadPinch(cmd(0.5))).toBe(false);
  });

  it('LINE-mode deltas are never a pinch', () => {
    // Firefox reports a mouse wheel as deltaMode 1, deltaY ≈ 3 — small enough
    // to look like a pinch by magnitude alone, which is why mode is checked.
    expect(isTrackpadPinch(ev(3, 1))).toBe(false);
    expect(isTrackpadPinch(ev(-3, 1))).toBe(false);
  });
});

describe('wheelZoomFactor', () => {
  it('negative delta zooms IN, positive zooms OUT', () => {
    expect(wheelZoomFactor(ev(-10))).toBeGreaterThan(1);
    expect(wheelZoomFactor(ev(10))).toBeLessThan(1);
  });

  it('a pinch moves the scale several times further than the old linear form', () => {
    // THE BUG: this used to be `deltaY * 0.002`, i.e. 2% for a delta of 10.
    const old = 1 + 10 * ZOOM_WHEEL_SENSITIVITY;   // ≈ 1.02
    expect(wheelZoomFactor(ev(-10))).toBeGreaterThan(old);
    // A full gesture is ~200 of accumulated delta — that should now be a real
    // zoom, not a nudge.
    expect(Math.exp(200 * ZOOM_PINCH_SENSITIVITY)).toBeGreaterThan(4);
  });

  it('a mouse notch is UNCHANGED in feel — only the pinch got faster', () => {
    // Exponential vs the old linear form agree to first order at this size,
    // so existing mouse users notice nothing.
    const factor = wheelZoomFactor(ev(-100));
    expect(factor).toBeGreaterThan(1.15);
    expect(factor).toBeLessThan(1.30);
  });

  it('round-trips exactly — in then out returns to the starting scale', () => {
    // The old linear form did NOT: scale*(1+x) then *(1-x) loses x². Drifting
    // zoom across a pinch back-and-forth is exactly what that felt like.
    for (const d of [3, 10, 40]) {
      expect(wheelZoomFactor(ev(-d)) * wheelZoomFactor(ev(d))).toBeCloseTo(1, 10);
    }
  });

  it('Cmd + scroll keeps the OLD speed, not the pinch speed', () => {
    // Same gesture shape as a pinch, deliberately slower. If these ever
    // converge, Cmd+scroll has been swept into the pinch bucket again.
    const withCmd = wheelZoomFactor(cmd(-10));
    const asPinch = wheelZoomFactor(ev(-10));
    expect(withCmd).toBeLessThan(asPinch);
    expect(withCmd).toBeCloseTo(Math.exp(10 * ZOOM_WHEEL_SENSITIVITY), 12);
  });

  it('clamps a momentum flick so one event cannot jump the canvas', () => {
    const huge = wheelZoomFactor(ev(-4000));
    expect(huge).toBe(wheelZoomFactor(ev(-ZOOM_MAX_DELTA)));
    expect(huge).toBeLessThan(1.35);
  });

  it('is monotonic in delta', () => {
    const factors = [-40, -20, -5, 0, 5, 20, 40].map((d) => wheelZoomFactor(ev(d)));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThan(factors[i - 1]);
    }
  });

  it('zero delta is a no-op', () => {
    expect(wheelZoomFactor(ev(0))).toBe(1);
  });
});
