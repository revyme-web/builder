// gradient-geometry — the gradient overlay works in the element's own box and
// maps through its transformed quad, so it follows rotated / flipped frames.
import { describe, it, expect } from 'vitest';
import {
  elementFrame, linearGradientLine, linearRotateZones, rotatedGradientAngle, localToScreen, screenToLocal,
} from './gradient-geometry';

type P = { x: number; y: number };
const quad = (map: (x: number, y: number) => P, w: number, h: number) => ({
  TL: map(0, 0), TR: map(w, 0), BR: map(w, h), BL: map(0, h),
});
const close = (a: P, b: P) => { expect(a.x).toBeCloseTo(b.x, 4); expect(a.y).toBeCloseTo(b.y, 4); };

const W = 200, H = 100;
const plain = elementFrame(quad((x, y) => ({ x, y }), W, H));
// Rotated 90° clockwise on screen, offset to (500, 300).
const rot90 = elementFrame(quad((x, y) => ({ x: 500 - y, y: 300 + x }), W, H), { w: W, h: H });
// Flipped horizontally (scaleX(-1)).
const flipped = elementFrame(quad((x, y) => ({ x: 400 - x, y }), W, H), { w: W, h: H });

describe('linearGradientLine — CSS Images 3 gradient line, in the local box', () => {
  it('180deg runs top centre → bottom centre', () => {
    const { start, end } = linearGradientLine(plain, 180);
    close(start, { x: 100, y: 0 });
    close(end, { x: 100, y: 100 });
  });
  it('90deg runs left → right', () => {
    const { start, end } = linearGradientLine(plain, 90);
    close(start, { x: 0, y: 50 });
    close(end, { x: 200, y: 50 });
  });
  it('45deg: length |W·sin| + |H·cos| — the corner-to-corner perpendiculars', () => {
    const { start, end } = linearGradientLine(plain, 45);
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo((W + H) * Math.SQRT1_2, 4);
  });
  it('a ROTATED frame turns the line with it (screen-space math drew it top→bottom)', () => {
    const { start, end } = linearGradientLine(rot90, 180);
    close(start, { x: 500, y: 400 });   // local top-centre (100, 0)
    close(end, { x: 400, y: 400 });     // local bottom-centre (100, 100): right → left on screen
  });
  it('local ⇄ screen round-trips through the quad', () => {
    const s = localToScreen(rot90, 37, 81);
    close(screenToLocal(rot90, s.x, s.y), { x: 37, y: 81 });
  });
});

describe('linearRotateZones — just beyond the outermost stops', () => {
  it('sits `gap` past the first and last stop, pointing outward', () => {
    const { start, end } = linearGradientLine(plain, 180);
    const z = linearRotateZones(start, end, 25, 37, 20)!;
    close(z.before, { x: 100, y: 5 });
    close(z.after, { x: 100, y: 57 });
    const norm = (d: number) => ((d % 360) + 360) % 360;
    expect(norm(z.before.outwardDeg)).toBeCloseTo(270);   // up
    expect(norm(z.after.outwardDeg)).toBeCloseTo(90);     // down
  });
  it('follows the gradient when it rotates', () => {
    const { start, end } = linearGradientLine(plain, 90);
    const z = linearRotateZones(start, end, 0, 100, 20)!;
    close(z.after, { x: 220, y: 50 });
    expect(z.after.outwardDeg).toBeCloseTo(0);
  });
});

describe('rotatedGradientAngle — the frame rotate math, in the element space', () => {
  it('never jumps on grab', () => {
    expect(rotatedGradientAngle(plain, 180, { x: 103, y: 130 }, { x: 103, y: 130 }, false)).toBe(180);
  });
  it('adds the pointer\'s turn around the centre: a quarter turn clockwise = +90', () => {
    // grab below the centre (100,50), move to its left
    expect(rotatedGradientAngle(plain, 180, { x: 100, y: 130 }, { x: 20, y: 50 }, false)).toBe(270);
  });
  it('Shift snaps to 15°', () => {
    expect(rotatedGradientAngle(plain, 180, { x: 100, y: 130 }, { x: 22, y: 41 }, true) % 15).toBe(0);
  });
  it('on a rotated frame the screen turn and the gradient turn agree', () => {
    // centre of rot90 on screen = (450, 400); grab below it, move to its left (quarter turn clockwise)
    expect(rotatedGradientAngle(rot90, 180, { x: 450, y: 480 }, { x: 370, y: 400 }, false)).toBe(270);
  });
  it('on a FLIPPED frame a clockwise screen turn is counter-clockwise locally', () => {
    // centre (300, 50); grab below, move left on screen = the local right
    expect(rotatedGradientAngle(flipped, 180, { x: 300, y: 130 }, { x: 220, y: 50 }, false)).toBe(90);
  });
});
