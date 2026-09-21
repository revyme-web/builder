import { describe, it, expect } from 'vitest';
import { pinFieldEditWrite, axisMode, centersOn, type PinSide } from './pin-field-resize';

// Frame B from the user's report: 183×195 at (519,105) in an 807×474 parent,
// positioned by left + top, with an explicit size.
const BOX = { left: 519, top: 105, width: 183, height: 195 };
const PARENT = { parentWidth: 807, parentHeight: 474 };
const FRAME_B = {
  position: 'absolute', left: '519px', top: '105px', width: '183px', height: '195px',
};

/** What the field currently reads for a side — the base of the first step. */
const paintedInset = (side: PinSide, box: typeof BOX) =>
  side === 'left' ? box.left
  : side === 'top' ? box.top
  : side === 'right' ? PARENT.parentWidth - box.left - box.width
  : PARENT.parentHeight - box.top - box.height;

const edit = (side: PinSide, valuePx: number, styles: Record<string, string> = FRAME_B, matrixStr = 'none', box = BOX, basePx?: number) =>
  pinFieldEditWrite({ side, valuePx, basePx: basePx ?? paintedInset(side, box), styles, box, ...PARENT, matrixStr });

describe('axisMode — which property CSS actually resolves the axis from', () => {
  it('start side wins when a size is present', () => {
    expect(axisMode(FRAME_B, false)).toEqual({ driver: 'top', inset: false });
    expect(axisMode(FRAME_B, true)).toEqual({ driver: 'left', inset: false });
  });

  it('both sides and no size is an inset', () => {
    expect(axisMode({ top: '10px', bottom: '20px' }, false)).toEqual({ driver: null, inset: true });
  });

  // The original bug in one assertion: `bottom` is inert here, whatever the
  // pin badge says, because `top` + `height` already resolve the axis.
  it('is NOT an inset when both sides and a size are present', () => {
    expect(axisMode({ top: '10px', bottom: '20px', height: '50px' }, false))
      .toEqual({ driver: 'top', inset: false });
  });

  it('end side drives when the start side is absent', () => {
    expect(axisMode({ bottom: '20px', height: '50px' }, false)).toEqual({ driver: 'bottom', inset: false });
  });

  it('an empty axis has no driver', () => {
    expect(axisMode({ height: '50px' }, false)).toEqual({ driver: null, inset: false });
  });

  it('treats auto and empty as absent', () => {
    expect(axisMode({ top: 'auto', bottom: '20px', height: '50px' }, false).driver).toBe('bottom');
    expect(axisMode({ top: '', bottom: '20px', height: '50px' }, false).driver).toBe('bottom');
  });
});

// Every field is its handle: T moves the top edge with the BOTTOM held, the
// mirror image of B. It used to reposition the whole box instead, because
// `top` drives the axis — but no resize handle moves the whole box.
describe('every side resizes, including the axis driver', () => {
  it('T moves the top edge and holds the bottom', () => {
    const out = edit('top', 40);            // from top 105, height 195
    expect(out.top).toBe('40px');
    expect(parseFloat(out.height)).toBeCloseTo(260, 1);   // bottom edge unmoved
    expect(40 + 260).toBeCloseTo(BOX.top + BOX.height, 1);
  });

  it('L moves the left edge and holds the right', () => {
    const out = edit('left', 500);          // from left 519, width 183
    expect(out.left).toBe('500px');
    expect(parseFloat(out.width)).toBeCloseTo(202, 1);
    expect(500 + 202).toBeCloseTo(BOX.left + BOX.width, 1);
  });

  it('T and B are mirror images of each other', () => {
    const t = edit('top', BOX.top + 10);                          // shrink by 10 from the top
    const b = edit('bottom', paintedInset('bottom', BOX) + 10);   // shrink by 10 from the bottom
    expect(parseFloat(t.height)).toBeCloseTo(parseFloat(b.height), 1);
  });

  it('positions, rather than resizes, an axis with nothing declared', () => {
    expect(edit('bottom', 40, { position: 'absolute', height: '195px' })).toEqual({ bottom: '40px' });
  });
});

describe('RESIZE — the edited side does not drive its axis', () => {
  // The reported case: B on a top-driven node. The bottom edge moves, the top
  // edge stays, and the height absorbs the difference — a bottom-handle drag.
  it('moves the bottom edge by changing the HEIGHT, not by adding an inset', () => {
    const out = edit('bottom', 120);
    // 474 − 105 (top, fixed) − 120 (typed) = 249
    expect(out.height).toBe('249px');
    expect(out.top).toBe('105px');       // the anchored edge is unchanged
    expect(out.bottom).toBeUndefined();  // no new pin invented
    expect(out.width).toBeUndefined();   // the other axis is untouched
  });

  it('moves the right edge by changing the WIDTH', () => {
    const out = edit('right', 276);
    expect(out.width).toBe(`${807 - 519 - 276}px`);
    expect(out.left).toBe('519px');
    expect(out.right).toBeUndefined();
  });

  // Why the inset version was wrong: a derived size collapses on a narrower
  // replica parent. An explicit px size mirrors to every viewport.
  it('keeps the dimension explicit so replicas can mirror it', () => {
    const out = edit('bottom', 120);
    expect(out.height).toMatch(/px$/);
    expect(out.height).not.toBe('');
  });

  it('clamps rather than writing a negative size', () => {
    const out = edit('bottom', 600); // past the top edge
    expect(parseFloat(out.height)).toBeGreaterThanOrEqual(0);
  });

  it('resizes from the top edge when bottom drives the axis', () => {
    const styles = { position: 'absolute', left: '519px', bottom: '174px', width: '183px', height: '195px' };
    const out = pinFieldEditWrite({ side: 'top', valuePx: 50, basePx: BOX.top, styles, box: BOX, ...PARENT, matrixStr: 'none' });
    // 474 − 174 (bottom, fixed) − 50 (typed) = 250
    expect(out.height).toBe('250px');
    expect(out.bottom).toBe('174px');
  });
});

describe('RESIZE — a true inset axis', () => {
  const insetStyles = { position: 'absolute', left: '519px', top: '105px', bottom: '174px', width: '183px' };
  const insetBox = { ...BOX, height: 474 - 105 - 174 };

  it('writes both sides and never a derived size', () => {
    const out = pinFieldEditWrite({ side: 'bottom', valuePx: 120, basePx: paintedInset('bottom', insetBox), styles: insetStyles, box: insetBox, ...PARENT, matrixStr: 'none' });
    expect(out.height).toBeUndefined();  // an inset derives it
    expect(out.bottom).toBe('120px');
    expect(out.top).toBe('105px');
  });
});

// Under rotation the four panel numbers are coupled: the hand resize moves ALL
// of them for a single-edge drag (resize:end in the user's trace shows left,
// right, top and bottom all changing). So the invariants to hold are not "the
// typed number lands" but the two the handle guarantees: the size changes by
// the step, and the opposite edge does not move visually.
describe('ROTATION — same invariants as a handle drag', () => {
  const matrixAt = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { str: `matrix(${Math.cos(r)}, ${Math.sin(r)}, ${-Math.sin(r)}, ${Math.cos(r)}, 0, 0)`,
             m: { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r) } };
  };
  const rotated = (deg: number) => ({ ...FRAME_B, transform: `rotate(${deg}deg)` });

  /** Spec, not the implementation: a transform pivots about the box centre. */
  const visual = (p: { x: number; y: number }, b: typeof BOX, m: { a: number; b: number; c: number; d: number }) => {
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + m.a * dx + m.c * dy, y: cy + m.b * dx + m.d * dy };
  };
  const topEdgeMid = (b: typeof BOX) => ({ x: b.left + b.width / 2, y: b.top });
  const boxAfter = (out: Record<string, string>, prev = BOX) => ({
    left: out.left !== undefined ? parseFloat(out.left) : prev.left,
    top: out.top !== undefined ? parseFloat(out.top) : prev.top,
    width: out.width !== undefined ? parseFloat(out.width) : prev.width,
    height: out.height !== undefined ? parseFloat(out.height) : prev.height,
  });

  const ANGLES = [0, 30, 90, 142, 150, 170, 180, 190, 210, 300];

  it.each(ANGLES)('at %i°, a 1px step changes the height by exactly 1px', (deg) => {
    const { str } = matrixAt(deg);
    const base = paintedInset('bottom', BOX);
    const out = edit('bottom', base + 1, rotated(deg), str, BOX, base);
    expect(parseFloat(out.height)).toBeCloseTo(BOX.height - 1, 1);
  });

  it.each(ANGLES)('at %i°, the opposite edge does not move visually', (deg) => {
    const { str, m } = matrixAt(deg);
    const base = paintedInset('bottom', BOX);
    const out = edit('bottom', base + 20, rotated(deg), str, BOX, base);
    const after = boxAfter(out);
    const before = visual(topEdgeMid(BOX), BOX, m);
    const now = visual(topEdgeMid(after), after, m);
    expect(now.x).toBeCloseTo(before.x, 1);
    expect(now.y).toBeCloseTo(before.y, 1);
  });

  // The 0xFFFFFF blow-up: a rectangle at 190° looks like one at 10°, so this is
  // an ordinary element. The absolute solve had gain (d−1)/(1+d) here; a delta
  // has none.
  it.each(ANGLES)('at %i°, every written number stays sane', (deg) => {
    const { str } = matrixAt(deg);
    const base = paintedInset('bottom', BOX);
    const out = edit('bottom', base + 2, rotated(deg), str, BOX, base);
    for (const [k, v] of Object.entries(out)) {
      expect(Math.abs(parseFloat(v)), `${k} = ${v}`).toBeLessThan(10000);
    }
  });

  it('does not throw the anchored side hundreds of px for a 2px edit', () => {
    const { str } = matrixAt(190);
    const base = paintedInset('bottom', BOX);
    const a = boxAfter(edit('bottom', base + 1, rotated(190), str, BOX, base));
    const b = boxAfter(edit('bottom', base + 3, rotated(190), str, BOX, base));
    // The user saw top go 252 → 234 → 157 → −177 for steps of 2.
    expect(Math.abs(b.top - a.top)).toBeLessThan(20);
    expect(Math.abs(b.left - a.left)).toBeLessThan(20);
  });

  it('a scrub of five steps shrinks the box by exactly five', () => {
    const { str } = matrixAt(142);
    let box = BOX;
    let base = paintedInset('bottom', box);
    for (let i = 0; i < 5; i++) {
      const out = edit('bottom', base + 1, rotated(142), str, box, base);
      box = boxAfter(out, box);
      base = base + 1;             // the field's own counter, as ToolInput scrubs
    }
    expect(box.height).toBeCloseTo(BOX.height - 5, 1);
  });
});

// The user's node was inset on BOTH axes (L+R+T+B). Editing the vertical axis
// rewrote left/right too, so the horizontal position drifted on every click.
describe('an inset axis edit leaves the other axis alone', () => {
  const bothInset = {
    position: 'absolute', left: '443px', right: '196px', top: '252px', bottom: '164px',
    transform: 'rotate(190deg)',
  };
  const box = { left: 443, top: 252, width: 807 - 443 - 196, height: 474 - 252 - 164 };
  const m190 = `matrix(${Math.cos(Math.PI * 190 / 180)}, ${Math.sin(Math.PI * 190 / 180)}, ${-Math.sin(Math.PI * 190 / 180)}, ${Math.cos(Math.PI * 190 / 180)}, 0, 0)`;

  it('writes only the edited side and never a derived size', () => {
    const out = pinFieldEditWrite({ side: 'bottom', valuePx: 170, basePx: paintedInset('bottom', box), styles: bothInset, box, ...PARENT, matrixStr: m190 });
    // A full inset recomputes all four sides from the compensated rect — the
    // same thing the hand resize does (resize:end shows left/right/top/bottom
    // all moving for a single-edge drag). Writing only `bottom` left left/right
    // stale, and the box drifted sideways as the chevron ran.
    expect(out.bottom).toBeDefined();
    expect(out.left).toBeDefined();
    expect(out.right).toBeDefined();
    expect(out.height).toBeUndefined();  // an inset derives it
  });
});

// Crossing zero: the handle mirrors the box across the anchored edge and keeps
// going (processZeroCrossing). Clamping at 0 instead made the field stall, then
// jump — user report 2026-09-20, "instead of just smoothly reverting the
// direction it increases in size".
describe('zero crossing', () => {
  // The frame from the screenshot: 62 wide, L+R+T+B all pinned.
  const NARROW = { left: 560, top: 73, width: 62, height: 143 };
  const STYLES = {
    position: 'absolute', left: '560px', right: '185px', top: '73px', bottom: '258px',
  };
  const base = PARENT.parentWidth - NARROW.left - NARROW.width; // the R field's value
  const step = (k: number, matrixStr = 'none', styles: Record<string, string> = STYLES) =>
    pinFieldEditWrite({ side: 'right', valuePx: base + k, basePx: base, styles, box: NARROW, ...PARENT, matrixStr });

  // A full inset writes no size — it is parentWidth − left − right.
  const geom = (out: Record<string, string>) => {
    const left = out.left !== undefined ? parseFloat(out.left) : NARROW.left;
    const right = out.right !== undefined ? parseFloat(out.right) : PARENT.parentWidth - NARROW.left - NARROW.width;
    return { left, right, width: PARENT.parentWidth - left - right };
  };
  const widthAt = (k: number) => geom(step(k)).width;

  it('mirrors instead of clamping at zero', () => {
    expect(widthAt(60)).toBeCloseTo(2, 1);
    expect(widthAt(62)).toBeCloseTo(0, 1);
    expect(widthAt(64)).toBeCloseTo(2, 1);   // through the crossing, growing again
    expect(widthAt(100)).toBeCloseTo(38, 1);
  });

  it('holds the anchored edge across the crossing', () => {
    // The left edge is the anchor; in a mirrored box it is the right edge, so
    // the anchored COORDINATE is what must stay continuous.
    for (const k of [60, 61, 62, 63, 64]) {
      const { left, width } = geom(step(k));
      const anchored = k <= 62 ? left : left + width;
      expect(anchored, `k=${k}`).toBeCloseTo(NARROW.left, 1);
    }
  });

  it('never jumps: consecutive steps stay one pixel apart', () => {
    let prev: number | null = null;
    for (let k = 58; k <= 68; k++) {
      const { left } = geom(step(k));
      if (prev !== null) expect(Math.abs(left - prev), `k=${k}`).toBeLessThanOrEqual(1.5);
      prev = left;
    }
  });

  it('mirrors under rotation too, holding the anchor visually', () => {
    const r = (142 * Math.PI) / 180;
    const m = { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r) };
    const matrixStr = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, 0, 0)`;
    const styles = { ...STYLES, transform: 'rotate(142deg)' };
    const visual = (p: { x: number; y: number }, b: typeof NARROW) => {
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const dx = p.x - cx, dy = p.y - cy;
      return { x: cx + m.a * dx + m.c * dy, y: cy + m.b * dx + m.d * dy };
    };
    const anchorBefore = visual({ x: NARROW.left, y: NARROW.top + NARROW.height / 2 }, NARROW);
    for (const k of [61, 62, 63, 70]) {
      const out = step(k, matrixStr, styles);
      const g = geom(out);
      const b = {
        left: g.left,
        top: out.top !== undefined ? parseFloat(out.top) : NARROW.top,
        width: g.width,
        height: NARROW.height,
      };
      // Mirrored, the anchored physical edge is the box's RIGHT edge.
      const px_ = k <= 62 ? b.left : b.left + b.width;
      const now = visual({ x: px_, y: b.top + b.height / 2 }, b);
      expect(now.x, `k=${k} x`).toBeCloseTo(anchorBefore.x, 0);
      expect(now.y, `k=${k} y`).toBeCloseTo(anchorBefore.y, 0);
    }
  });

  it('never writes a negative size', () => {
    for (let k = 0; k <= 120; k += 4) {
      expect(geom(step(k)).width, `k=${k}`).toBeGreaterThanOrEqual(-0.01);
      const out = step(k);
      if (out.width !== undefined) expect(parseFloat(out.width)).toBeGreaterThanOrEqual(0);
    }
  });
});

// The same crossing on a NON-inset axis, where the size is explicit.
describe('zero crossing with an explicit size', () => {
  const B = { left: 560, top: 73, width: 62, height: 143 };
  const STYLES = { position: 'absolute', left: '560px', top: '73px', width: '62px', height: '143px' };
  const base = PARENT.parentWidth - B.left - B.width;
  const step = (k: number) =>
    pinFieldEditWrite({ side: 'right', valuePx: base + k, basePx: base, styles: STYLES, box: B, ...PARENT, matrixStr: 'none' });

  it('mirrors the box and keeps the size positive', () => {
    expect(parseFloat(step(60).width)).toBeCloseTo(2, 1);
    expect(parseFloat(step(64).width)).toBeCloseTo(2, 1);
    expect(parseFloat(step(100).width)).toBeCloseTo(38, 1);
    for (let k = 0; k <= 120; k += 5) expect(parseFloat(step(k).width)).toBeGreaterThanOrEqual(0);
  });

  it('keeps the anchored left edge continuous through the crossing', () => {
    for (const k of [61, 62, 63, 64]) {
      const left = parseFloat(step(k).left);
      const width = parseFloat(step(k).width);
      expect(k <= 62 ? left : left + width, `k=${k}`).toBeCloseTo(B.left, 1);
    }
  });
});

// THE OSCILLATION. Every zero-crossing test above passes a fixed start box and
// a fixed base — i.e. it models a gesture anchored to its start. PinControl was
// instead re-basing on the PREVIOUS frame, so past zero the box mirrored to 1px
// and the next step shrank that 1px back to 0: 0-1-0-1 forever, never growing
// out (user report 2026-09-20). The two loops are compared here so the contract
// the caller has to honour is written down, not just implied.
describe('a gesture must be anchored to its start, not to the previous frame', () => {
  const B = { left: 560, top: 73, width: 62, height: 143 };
  const STYLES = { position: 'absolute', left: '560px', top: '73px', width: '62px', height: '143px' };
  const start = PARENT.parentWidth - B.left - B.width;
  // Start-anchored: BOTH the base value and the box come from the gesture's
  // start, every frame — what `resize:start` captures. Per-frame: each frame
  // measures against the one before it.
  const run = (rebasePerFrame: boolean) => {
    let box = B, base = start;
    const widths: number[] = [];
    for (let k = 1; k <= 8; k++) {
      const valuePx = start + k * 10;        // the field's own counter
      const out = pinFieldEditWrite({ side: 'right', valuePx, basePx: base, styles: STYLES, box, ...PARENT, matrixStr: 'none' });
      const width = parseFloat(out.width);
      widths.push(width);
      if (rebasePerFrame) {
        base = valuePx;
        box = { ...box, left: out.left !== undefined ? parseFloat(out.left) : box.left, width };
      }
    }
    return widths;
  };

  it('start-anchored: the width passes through zero and grows again', () => {
    const w = run(false);
    // 62 → 52, 42, 32, 22, 12, 2, then mirrored 8, 18 — monotone through zero.
    expect(w).toEqual([52, 42, 32, 22, 12, 2, 8, 18]);
  });

  it('per-frame rebasing oscillates once it crosses zero', () => {
    const w = run(true);
    const tail = w.slice(-4);
    // The signature of the bug: past zero the width stops growing steadily and
    // flip-flops instead of continuing outward.
    expect(tail, 'per-frame rebasing should NOT grow monotonically').not.toEqual([...tail].sort((a, b) => a - b));
    // and it never gets as far as the start-anchored run does
    expect(w[w.length - 1]).toBeLessThan(run(false)[w.length - 1]);
  });
});
