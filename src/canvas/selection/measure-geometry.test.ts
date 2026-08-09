// measure-geometry.test.ts — the ALT measuring overlay's geometry.
//
// Pure module, so these are plain object literals — no jsdom, no DOMRect.
//
// The INSET cases are a regression lock: that picture is the long-standing
// "distance to parent" feature, and the numbers/endpoints here are the ones it
// has always drawn. The GAP cases are the new hover measurement.

import { describe, it, expect } from 'vitest';
import {
  axisGap, overlapBand, isUsableRect,
  computeGapMeasure, computeInsetMeasure, computePairMeasure,
  resolveMeasureTarget, measureEqual,
  type MRect, type MeasureResult, type MeasureSegment,
} from './measure-geometry';

const r = (left: number, top: number, right: number, bottom: number): MRect =>
  ({ left, top, right, bottom });

const strip = (id: string) => id.replace(/__\d+$/, '');

/** The sole segment — asserts the boxes are separated on exactly one axis. */
const one = (segs: MeasureSegment[]): MeasureSegment => {
  expect(segs).toHaveLength(1);
  return segs[0];
};

/** Both segments of a diagonal pair. Horizontal is emitted first. */
const diag = (segs: MeasureSegment[]) => {
  expect(segs.map((sg) => sg.key)).toEqual(['gap-h', 'gap-v']);
  return { h: segs[0], v: segs[1] };
};

// ─── Primitives ─────────────────────────────────────────────────────────────

describe('axisGap', () => {
  it('is positive when separated, in either order', () => {
    expect(axisGap(0, 10, 30, 40)).toBe(20);   // b after a
    expect(axisGap(30, 40, 0, 10)).toBe(20);   // a after b — same magnitude
  });

  it('is zero when flush', () => {
    expect(axisGap(0, 10, 10, 20)).toBe(0);
  });

  it('is negative by the overlap amount', () => {
    expect(axisGap(0, 10, 6, 20)).toBe(-4);
    // Containment: the magnitude is the SHORTEST separating translation (past
    // the near edge), not the contained box's width.
    expect(axisGap(0, 100, 10, 20)).toBe(-20);
  });
});

describe('overlapBand', () => {
  it('returns the shared span', () => {
    expect(overlapBand(0, 100, 40, 200)).toEqual({ min: 40, max: 100 });
  });
  it('is null when disjoint or merely touching', () => {
    expect(overlapBand(0, 10, 30, 40)).toBeNull();
    expect(overlapBand(0, 10, 10, 20)).toBeNull();  // zero-width band is not an overlap
  });
});

describe('isUsableRect', () => {
  it('rejects null, NaN fields and zero-area boxes', () => {
    expect(isUsableRect(null)).toBe(false);
    expect(isUsableRect(r(NaN, 0, 10, 10))).toBe(false);
    expect(isUsableRect(r(5, 5, 5, 5))).toBe(false);
    expect(isUsableRect(r(0, 0, 10, 10))).toBe(true);
  });
});

// ─── Gap mode ───────────────────────────────────────────────────────────────

describe('computeGapMeasure — straight runs', () => {
  it('B to the right: measures the facing edges, no elbow', () => {
    const seg = one(computeGapMeasure(r(0, 0, 100, 100), r(150, 20, 250, 80), 1));
    expect(seg.isH).toBe(true);
    expect(seg.value).toBe(50);          // 150 - 100
    expect([seg.x1, seg.x2]).toEqual([100, 150]);
    expect(seg.dash).toBeUndefined();
  });

  it('B to the left: mirrored endpoints, same magnitude', () => {
    const seg = one(computeGapMeasure(r(150, 0, 250, 100), r(0, 20, 100, 80), 1));
    expect(seg.value).toBe(50);
    expect([seg.x1, seg.x2]).toEqual([100, 150]);  // B.right → A.left
  });

  it('B below and B above measure the same magnitude', () => {
    const below = one(computeGapMeasure(r(0, 0, 100, 100), r(20, 160, 80, 260), 1));
    const above = one(computeGapMeasure(r(0, 160, 100, 260), r(20, 0, 80, 100), 1));
    expect(below.isH).toBe(false);
    expect(below.value).toBe(60);
    expect(above.value).toBe(60);
  });

  it('sits at the OVERLAP BAND centre, not the selection centre', () => {
    // Tall selection, short target inside its range. The selection's own centre
    // (200) would run the line past the target entirely.
    const seg = one(computeGapMeasure(r(0, 0, 100, 400), r(150, 50, 250, 90), 1));
    expect(seg.y1).toBe(70);             // (50 + 90) / 2
    expect(seg.dash).toBeUndefined();    // inside the band → straight line
  });

  it('falls back to the selection centre when the target spans it', () => {
    const seg = one(computeGapMeasure(r(0, 100, 100, 200), r(150, 0, 250, 400), 1));
    expect(seg.y1).toBe(150);            // A's centre; band centre coincides
  });
});

describe('computeGapMeasure — diagonals draw BOTH axes', () => {
  // The Framer picture the user matched against (screenshot 2026-08-09): a
  // heading in the desktop tile, an image in the mobile tile. Framer shows the
  // horizontal distance AND the vertical one, each with its own elbow. Real
  // coordinates from that screenshot so the expected numbers are checkable.
  const A = r(232, 220, 594, 332);       // selection: desktop heading
  const B = r(1152, 655, 1305, 790);     // target: mobile image, down and right

  it('emits one measurement per separated axis, horizontal first', () => {
    const { h, v } = diag(computeGapMeasure(A, B, 1));
    expect(h.value).toBe(558);           // 1152 - 594
    expect(v.value).toBe(323);           // 655 - 332
  });

  it('each solid runs between the facing edges at the selection centre', () => {
    const { h, v } = diag(computeGapMeasure(A, B, 1));
    expect([h.x1, h.x2]).toEqual([594, 1152]);
    expect(h.y1).toBe(276);              // A's centre y — no band on a diagonal
    expect([v.y1, v.y2]).toEqual([332, 655]);
    expect(v.x1).toBe(413);              // A's centre x
  });

  it('both elbows terminate at the SAME point: the target\u2019s near corner', () => {
    // This is what makes the pair read as one bracket rather than two unrelated
    // lines. It holds for every diagonal: separation on an axis means the
    // selection\u2019s centre is outside the target\u2019s range on that axis, so each
    // clamp lands on the target\u2019s near edge.
    const { h, v } = diag(computeGapMeasure(A, B, 1));
    expect({ x: h.dash!.x2, y: h.dash!.y2 }).toEqual({ x: 1152, y: 655 });
    expect({ x: v.dash!.x2, y: v.dash!.y2 }).toEqual({ x: 1152, y: 655 });
  });

  it('holds in every diagonal quadrant', () => {
    const sel = r(0, 0, 100, 100);
    for (const [b, corner] of [
      [r(200, 200, 300, 300), { x: 200, y: 200 }],
      [r(-300, -300, -200, -200), { x: -200, y: -200 }],
      [r(200, -300, 300, -200), { x: 200, y: -200 }],
      [r(-300, 200, -200, 300), { x: -200, y: 200 }],
    ] as const) {
      const { h, v } = diag(computeGapMeasure(sel, b, 1));
      expect({ x: h.dash!.x2, y: h.dash!.y2 }).toEqual(corner);
      expect({ x: v.dash!.x2, y: v.dash!.y2 }).toEqual(corner);
    }
  });

  it('measures a long thin selection on both axes instead of choosing for you', () => {
    // A 1000x50 bar with the target up and to the right. An earlier rule kept
    // only the axis with the shorter elbow and would have dropped the 150.
    const { h, v } = diag(computeGapMeasure(r(0, 0, 1000, 50), r(1100, 200, 1150, 250), 1));
    expect(h.value).toBe(100);
    expect(v.value).toBe(150);
  });

  it('a single separated axis still yields exactly one segment', () => {
    // The straight case needs no special handling: the boxes overlap on y, so
    // only the horizontal axis is separated.
    const segs = computeGapMeasure(r(0, 0, 100, 100), r(200, 20, 300, 80), 1);
    expect(segs.map((sg) => sg.key)).toEqual(['gap-h']);
    expect(segs[0].dash).toBeUndefined();
  });

  it('corner touch: both axes read zero', () => {
    const { h, v } = diag(computeGapMeasure(r(0, 0, 100, 100), r(100, 100, 200, 200), 1));
    expect([h.value, v.value]).toEqual([0, 0]);
  });
});

// ─── End caps ───────────────────────────────────────────────────────────────
// A cap is a tick CENTRED on the line, so it protrudes 4px each side. At the
// corner where the elbow turns, the half pointing away from the elbow reads as
// the solid run overshooting past the turn (user report 2026-08-09). The turn
// gets no cap; every true terminus keeps one.

describe('end caps', () => {
  /** The point where the elbow leaves the solid run. */
  const elbowOrigin = (seg: MeasureSegment) => ({ x: seg.dash!.x1, y: seg.dash!.y1 });

  it('a straight measurement caps both ends', () => {
    const seg = one(computeGapMeasure(r(0, 0, 100, 100), r(0, 200, 100, 300), 1));
    expect(seg.dash).toBeUndefined();
    expect(seg.capStart).toBe(true);
    expect(seg.capEnd).toBe(true);
  });

  it('target AFTER the selection: the far end turns, so only the near end caps', () => {
    for (const seg of computeGapMeasure(r(0, 0, 100, 100), r(200, 200, 300, 300), 1)) {
      expect(seg.capStart).toBe(true);
      expect(seg.capEnd).toBe(false);
      // The uncapped end is exactly where the elbow leaves.
      expect(elbowOrigin(seg)).toEqual({ x: seg.x2, y: seg.y2 });
    }
  });

  it('target BEFORE the selection: the segment runs target\u2192selection, so the START turns', () => {
    // The mirror case. Anchoring the elbow by position rather than by role is
    // what put it on the wrong end before.
    for (const seg of computeGapMeasure(r(200, 200, 300, 300), r(0, 0, 100, 100), 1)) {
      expect(seg.capStart).toBe(false);
      expect(seg.capEnd).toBe(true);
      expect(elbowOrigin(seg)).toEqual({ x: seg.x1, y: seg.y1 });
    }
  });

  it('exactly one end is ever uncapped', () => {
    for (const b of [r(200, 200, 300, 300), r(-300, -300, -200, -200),
                     r(200, -300, 300, -200), r(-300, 200, -200, 300)]) {
      for (const seg of computeGapMeasure(r(0, 0, 100, 100), b, 1)) {
        expect(seg.dash).toBeDefined();
        expect([seg.capStart, seg.capEnd].filter(Boolean)).toHaveLength(1);
      }
    }
  });

  it('inset sides are all true termini and keep both caps', () => {
    for (const seg of computeInsetMeasure(r(20, 20, 80, 80), r(0, 0, 100, 100), 1)) {
      expect(seg.capStart).toBe(true);
      expect(seg.capEnd).toBe(true);
      expect(seg.dash).toBeUndefined();
    }
  });

  it('a cap change alone counts as a change, so the redraw is not skipped', () => {
    const a = computeGapMeasure(r(0, 0, 100, 100), r(200, 200, 300, 300), 1)[0];
    const flipped = { ...a, capStart: !a.capStart };
    expect(measureEqual({ kind: 'gap', segments: [a] }, { kind: 'gap', segments: [flipped] }))
      .toBe(false);
  });
});

describe('computeGapMeasure — degenerate', () => {
  it('flush edges give a zero measurement rather than nothing', () => {
    // Snapped-together elements are exactly when you want confirmation.
    const seg = one(computeGapMeasure(r(0, 0, 100, 100), r(100, 20, 200, 80), 1));
    expect(seg.value).toBe(0);
    expect(seg.x1).toBe(seg.x2);
    expect(seg.dash).toBeUndefined();
  });

  it('no segments at all when the boxes overlap on both axes', () => {
    expect(computeGapMeasure(r(0, 0, 100, 100), r(50, 50, 150, 150), 1)).toEqual([]);
    expect(computeGapMeasure(r(0, 0, 100, 100), r(20, 20, 40, 40), 1)).toEqual([]);
  });

  it('sub-pixel overlap still counts as separated (eps)', () => {
    const seg = one(computeGapMeasure(r(0, 0, 100, 100), r(99.6, 20, 200, 80), 1));
    expect(seg.value).toBe(0);
  });
});

describe('computeGapMeasure — zoom', () => {
  it('divides the value by scale but never the coordinates', () => {
    const a = r(0, 0, 100, 100), b = r(200, 20, 300, 80);
    const at1 = one(computeGapMeasure(a, b, 1));
    const at05 = one(computeGapMeasure(a, b, 0.5));
    const at2 = one(computeGapMeasure(a, b, 2));
    expect(at1.value).toBe(100);
    expect(at05.value).toBe(200);        // zoomed out — 100 screen px is 200 css px
    expect(at2.value).toBe(50);
    for (const s of [at05, at2]) {
      expect([s.x1, s.y1, s.x2, s.y2]).toEqual([at1.x1, at1.y1, at1.x2, at1.y2]);
    }
  });

  it('treats scale 0 as 1 rather than dividing by zero', () => {
    expect(one(computeGapMeasure(r(0, 0, 100, 100), r(200, 20, 300, 80), 0)).value).toBe(100);
  });
});

// ─── Inset mode (the original parent picture) ───────────────────────────────

describe('computeInsetMeasure', () => {
  const outer = r(0, 0, 400, 300);
  const inner = r(50, 40, 300, 260);

  it('produces the four gaps with the historical endpoints', () => {
    const segs = computeInsetMeasure(inner, outer, 1);
    expect(segs.map((s) => s.key).sort()).toEqual(['bottom', 'left', 'right', 'top']);
    const by = Object.fromEntries(segs.map((s) => [s.key, s]));
    expect(by.top.value).toBe(40);
    expect(by.right.value).toBe(100);
    expect(by.bottom.value).toBe(40);
    expect(by.left.value).toBe(50);
    // Lines run from the inner box's centre axis — unchanged behaviour.
    const cx = 175, cy = 150;
    expect([by.top.x1, by.top.x2]).toEqual([cx, cx]);
    expect([by.left.y1, by.left.y2]).toEqual([cy, cy]);
    // Label sits at the segment midpoint.
    expect(by.top.ly).toBe(20);
    expect(by.left.lx).toBe(25);
  });

  it('drops sides that are flush or overflowing', () => {
    const flushLeft = r(0, 40, 300, 260);
    expect(computeInsetMeasure(flushLeft, outer, 1).map((s) => s.key)).not.toContain('left');
    const overflowing = r(-20, 40, 300, 260);
    expect(computeInsetMeasure(overflowing, outer, 1).map((s) => s.key)).not.toContain('left');
  });

  it('divides every side by scale', () => {
    const segs = computeInsetMeasure(inner, outer, 0.5);
    expect(segs.find((s) => s.key === 'top')!.value).toBe(80);
  });
});

// ─── Dispatcher ─────────────────────────────────────────────────────────────

describe('computePairMeasure', () => {
  it('boxes separated on one axis give one gap segment', () => {
    const res = computePairMeasure(r(0, 0, 100, 100), r(200, 20, 300, 80), 1);
    expect(res.kind).toBe('gap');
    expect(res.segments).toHaveLength(1);
  });

  it('a diagonal pair gives two, and the keys stay unique for React', () => {
    const res = computePairMeasure(r(0, 0, 100, 100), r(200, 200, 300, 300), 1);
    expect(res.kind).toBe('gap');
    expect(new Set(res.segments.map((sg) => sg.key)).size).toBe(2);
  });

  it('B contains A: insets of A inside B', () => {
    const res = computePairMeasure(r(50, 50, 100, 100), r(0, 0, 400, 400), 1);
    expect(res.kind).toBe('inset');
    expect(res.segments.find((s) => s.key === 'top')!.value).toBe(50);
  });

  it('A contains B: roles swap by area', () => {
    const res = computePairMeasure(r(0, 0, 400, 400), r(50, 50, 100, 100), 1);
    expect(res.kind).toBe('inset');
    expect(res.segments.find((s) => s.key === 'top')!.value).toBe(50);
  });

  it('partial intersection keeps only the sides that make sense', () => {
    const res = computePairMeasure(r(0, 0, 100, 100), r(50, 50, 300, 300), 1);
    expect(res.kind).toBe('inset');
    expect(res.segments.every((s) => s.value > 0)).toBe(true);
  });

  it('identical boxes produce NO segments — the caller falls back', () => {
    const res = computePairMeasure(r(0, 0, 100, 100), r(0, 0, 100, 100), 1);
    expect(res.kind).toBe('inset');
    expect(res.segments).toHaveLength(0);
  });
});

// ─── Target resolution ──────────────────────────────────────────────────────

describe('resolveMeasureTarget', () => {
  const base = {
    selectedId: 'sel', selectedVpId: 'desktop', parentId: 'par',
    hoveredId: null as string | null, hoveredNodeId: null as string | null,
    hoveredVpId: null as string | null, stripGhost: strip,
  };

  it('no hover → the parent picture', () => {
    expect(resolveMeasureTarget(base)).toEqual({ mode: 'parent', id: 'par', vpId: 'desktop' });
  });

  it('hovering yourself → the parent picture', () => {
    expect(resolveMeasureTarget({ ...base, hoveredId: 'sel', hoveredVpId: 'desktop' }))
      .toMatchObject({ mode: 'parent' });
  });

  it('hovering your own parent → the parent picture (no mode churn)', () => {
    expect(resolveMeasureTarget({ ...base, hoveredId: 'par', hoveredVpId: 'desktop' }))
      .toMatchObject({ mode: 'parent' });
  });

  it('the SAME parent id in another viewport is a different box → hover', () => {
    expect(resolveMeasureTarget({ ...base, hoveredId: 'par', hoveredVpId: 'tablet' }))
      .toEqual({ mode: 'hover', id: 'par', vpId: 'tablet' });
  });

  it('a ghost hover measures to THAT ghost, not the template', () => {
    const t = resolveMeasureTarget({
      ...base, hoveredId: 'card', hoveredNodeId: 'card__3', hoveredVpId: 'desktop',
    });
    expect(t).toEqual({ mode: 'hover', id: 'card__3', vpId: 'desktop' });
  });

  it('a null hovered viewport falls back to the selection\'s', () => {
    expect(resolveMeasureTarget({ ...base, hoveredId: 'other', hoveredVpId: null }))
      .toEqual({ mode: 'hover', id: 'other', vpId: 'desktop' });
  });

  it('the artboard root is a valid target', () => {
    expect(resolveMeasureTarget({ ...base, hoveredId: 'root', hoveredVpId: 'desktop' }))
      .toMatchObject({ mode: 'hover', id: 'root' });
  });

  it('no parent and no hover → nothing to measure', () => {
    expect(resolveMeasureTarget({ ...base, parentId: null })).toBeNull();
  });
});

// ─── The React bail-out guard ───────────────────────────────────────────────

describe('measureEqual', () => {
  const mk = (v: number): MeasureResult => ({
    kind: 'gap',
    segments: [{ key: 'gap-h', isH: true, x1: 0, y1: 0, x2: v, y2: 0, value: v, lx: 0, ly: 0, capStart: true, capEnd: true }],
  });

  it('equal values compare equal, so React can bail out', () => {
    expect(measureEqual(mk(10), mk(10))).toBe(true);
  });

  it('any differing coordinate compares unequal', () => {
    expect(measureEqual(mk(10), mk(11))).toBe(false);
  });

  it('NaN compares EQUAL to NaN — the crash this guard exists for', () => {
    // With `===`, NaN !== NaN made the guard permanently false: every poll set
    // a fresh object and the set→render→effect chain blew React's update-depth
    // limit and took the app down. Object.is is load-bearing.
    expect(measureEqual(mk(NaN), mk(NaN))).toBe(true);
  });

  it('a dash appearing or disappearing counts as a change', () => {
    const withDash = { ...mk(10) };
    withDash.segments = [{ ...withDash.segments[0], dash: { x1: 0, y1: 0, x2: 0, y2: 5 } }];
    expect(measureEqual(mk(10), withDash)).toBe(false);
  });

  it('different kinds or segment counts compare unequal', () => {
    expect(measureEqual(mk(10), { kind: 'inset', segments: mk(10).segments })).toBe(false);
    expect(measureEqual(mk(10), { kind: 'gap', segments: [] })).toBe(false);
  });

  it('null handling', () => {
    expect(measureEqual(null, null)).toBe(true);
    expect(measureEqual(null, mk(1))).toBe(false);
  });
});
