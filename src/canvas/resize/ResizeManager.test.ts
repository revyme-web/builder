import { describe, test, expect } from 'vitest';
import {
  resolvePos,
  calculateResizeDelta,
  applyAspectRatioLock,
  applyVectorAspectLock,
  applySymmetricResize,
  getResizeCommitProperties,
  parseDimUnit,
  formatResizeDimension,
  lockedShiftHeight,
} from './ResizeManager';

// ─── parseDimUnit ────────────────────────────────────────────────────────────

describe('parseDimUnit', () => {
  test('reads vh / vw / % / px', () => {
    expect(parseDimUnit('100vh')).toBe('vh');
    expect(parseDimUnit('80vw')).toBe('vw');
    expect(parseDimUnit('50%')).toBe('%');
    expect(parseDimUnit('320px')).toBe('px');
  });
  test('reads font / container units', () => {
    expect(parseDimUnit('1.5rem')).toBe('rem');
    expect(parseDimUnit('2em')).toBe('em');
    expect(parseDimUnit('40cqh')).toBe('cqh');
  });
  test('case-insensitive + whitespace tolerant', () => {
    expect(parseDimUnit('100VH')).toBe('vh');
    expect(parseDimUnit('  100 vh  ')).toBe('vh');
  });
  test('keyword / empty / negative values', () => {
    expect(parseDimUnit('auto')).toBe('px');
    expect(parseDimUnit('min-content')).toBe('px');
    expect(parseDimUnit('')).toBe('px');
    expect(parseDimUnit(undefined)).toBe('px');
    expect(parseDimUnit('-10vh')).toBe('vh');
  });
});

// ─── formatResizeDimension ───────────────────────────────────────────────────

describe('formatResizeDimension', () => {
  const px = (n: number) => `${Math.round(n)}px`;

  test('preserves vh via the element start ratio (the reported bug)', () => {
    // Element is 100vh and currently 812px tall → 8.12px per vh.
    // Drag to 900px should commit ~111vh, NOT 900px.
    expect(formatResizeDimension(900, 'vh', 812 / 100, 0, px)).toBe('111vh');
    // Unchanged size round-trips back to exactly 100vh (stable).
    expect(formatResizeDimension(812, 'vh', 812 / 100, 0, px)).toBe('100vh');
  });

  test('preserves vw and rem the same way', () => {
    expect(formatResizeDimension(720, 'vw', 1440 / 100, 0, px)).toBe('50vw'); // 1440px = 100vw
    expect(formatResizeDimension(48, 'rem', 16, 0, px)).toBe('3rem');         // 16px per rem
  });

  test('% stays parent-relative (existing behaviour intact)', () => {
    expect(formatResizeDimension(400, '%', 0, 800, px)).toBe('50%');
  });

  test('% with no known parent size falls back to px', () => {
    expect(formatResizeDimension(400, '%', 0, 0, px)).toBe('400px');
  });

  test('px unit uses the caller pxFormat', () => {
    expect(formatResizeDimension(123.4, 'px', 0, 0, px)).toBe('123px');
    expect(formatResizeDimension(123.4, 'px', 0, 0, (n) => `${Math.round(n * 1000) / 1000}px`)).toBe('123.4px');
  });

  test('non-px unit with a degenerate (0) ratio falls back to px', () => {
    expect(formatResizeDimension(900, 'vh', 0, 0, px)).toBe('900px');
  });
});

// ─── resolvePos ─────────────────────────────────────────────────────────────

describe('resolvePos', () => {
  test('parses px value', () => {
    expect(resolvePos('100px', undefined, 50, 800, '', 'x')).toBe(100);
  });

  test('parses 0px as 0', () => {
    expect(resolvePos('0px', undefined, 50, 800, '', 'x')).toBe(0);
  });

  test('parses percentage value', () => {
    // 50% of 800 = 400
    expect(resolvePos('50%', undefined, 50, 800, '', 'x')).toBe(400);
  });

  test('percentage with translateX(-50%) compensation on x axis', () => {
    // 50% of 800 = 400, minus size/2 = 400 - 25 = 375
    expect(resolvePos('50%', undefined, 50, 800, 'translateX(-50%)', 'x')).toBe(375);
  });

  test('percentage with translate(-50%) shorthand on x axis', () => {
    expect(resolvePos('50%', undefined, 50, 800, 'translate(-50%, -50%)', 'x')).toBe(375);
  });

  test('percentage with translate(-50%, -50%) on y axis', () => {
    // 50% of 600 = 300, minus size/2 = 300 - 20 = 280
    expect(resolvePos('50%', undefined, 40, 600, 'translate(-50%, -50%)', 'y')).toBe(280);
  });

  test('percentage with translateY(-50%) on y axis', () => {
    expect(resolvePos('50%', undefined, 40, 600, 'translateY(-50%)', 'y')).toBe(280);
  });

  test('percentage without translate centering on y axis', () => {
    // No translate, just 50% of 600 = 300
    expect(resolvePos('50%', undefined, 40, 600, '', 'y')).toBe(300);
  });

  test('opposite side inset fallback (right → left)', () => {
    // parentSize(800) - oppProp(50) - size(100) = 650
    expect(resolvePos(undefined, '50px', 100, 800, '', 'x')).toBe(650);
  });

  test('opposite side inset with zero', () => {
    // parentSize(800) - 0 - 100 = 700
    expect(resolvePos(undefined, '0px', 100, 800, '', 'x')).toBe(700);
  });

  test('uses fallback when no CSS property is set', () => {
    expect(resolvePos(undefined, undefined, 50, 800, '', 'x', 42)).toBe(42);
  });

  test('default fallback is 0', () => {
    expect(resolvePos(undefined, undefined, 50, 800, '', 'x')).toBe(0);
  });

  test('px value takes priority over opposite prop', () => {
    expect(resolvePos('100px', '50px', 50, 800, '', 'x')).toBe(100);
  });

  test('percentage value takes priority over opposite prop', () => {
    expect(resolvePos('25%', '50px', 50, 800, '', 'x')).toBe(200);
  });
});

// ─── calculateResizeDelta ───────────────────────────────────────────────────

describe('calculateResizeDelta', () => {
  const base = { curWidth: 100, curHeight: 80, curLeft: 50, curTop: 30 };

  test('right handle: width increases, left unchanged', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 20, 0, 'right', null, false);
    expect(r.width).toBe(120);
    expect(r.left).toBe(50);
    expect(r.height).toBe(80);
    expect(r.top).toBe(30);
  });

  test('left handle: width decreases, left moves right', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 20, 0, 'left', null, false);
    expect(r.width).toBe(80);
    expect(r.left).toBe(70);
  });

  test('bottom handle: height increases, top unchanged', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 0, 15, null, 'bottom', false);
    expect(r.height).toBe(95);
    expect(r.top).toBe(30);
  });

  test('top handle: height decreases, top moves down', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 0, 15, null, 'top', false);
    expect(r.height).toBe(65);
    expect(r.top).toBe(45);
  });

  test('corner (bottomRight): both width and height increase', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 10, 20, 'right', 'bottom', false);
    expect(r.width).toBe(110);
    expect(r.height).toBe(100);
    expect(r.left).toBe(50);
    expect(r.top).toBe(30);
  });

  test('corner (topLeft): width/height decrease, left/top move', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 10, 10, 'left', 'top', false);
    expect(r.width).toBe(90);
    expect(r.height).toBe(70);
    expect(r.left).toBe(60);
    expect(r.top).toBe(40);
  });

  test('layout mode: right handle, no left/top change', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 20, 0, 'right', null, true);
    expect(r.width).toBe(120);
    expect(r.left).toBe(50); // unchanged in layout
  });

  test('layout mode: left handle, no left/top change', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 20, 0, 'left', null, true);
    expect(r.width).toBe(80);
    expect(r.left).toBe(50); // unchanged in layout
  });

  test('layout mode: top handle, no top change', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 0, 15, null, 'top', true);
    expect(r.height).toBe(65);
    expect(r.top).toBe(30); // unchanged in layout
  });

  test('null handles: no dimension changes', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 20, 15, null, null, false);
    expect(r.width).toBe(100);
    expect(r.height).toBe(80);
    expect(r.left).toBe(50);
    expect(r.top).toBe(30);
  });

  test('negative delta makes width shrink past zero', () => {
    const r = calculateResizeDelta(base.curWidth, base.curHeight, base.curLeft, base.curTop, 150, 0, 'right', null, false);
    // width = 100 + 150 = 250 (no clamping here, that's processZeroCrossing's job)
    expect(r.width).toBe(250);
  });
});

// ─── applyAspectRatioLock ───────────────────────────────────────────────────

describe('applyAspectRatioLock', () => {
  test('locks height to width / aspectRatio', () => {
    const r = applyAspectRatioLock(200, 999, 100, 50, 2, 'bottom', false);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100); // 200 / 2 = 100
  });

  test('top handle adjusts top to compensate', () => {
    // curHeight = 100, locked height = 200/2 = 100, delta = 0
    const r = applyAspectRatioLock(200, 999, 80, 50, 2, 'top', false);
    expect(r.height).toBe(100);
    expect(r.top).toBe(50 + (80 - 100)); // 50 + (80 - 100) = 30
  });

  test('top handle in layout mode does NOT adjust top', () => {
    const r = applyAspectRatioLock(200, 999, 100, 50, 2, 'top', true);
    expect(r.height).toBe(100);
    expect(r.top).toBe(50); // unchanged
  });

  test('bottom handle does not adjust top', () => {
    const r = applyAspectRatioLock(200, 999, 100, 50, 2, 'bottom', false);
    expect(r.top).toBe(50);
  });

  test('null yHandle does not adjust top', () => {
    const r = applyAspectRatioLock(200, 999, 100, 50, 2, null, false);
    expect(r.top).toBe(50);
  });

  test('aspect ratio 1:1', () => {
    const r = applyAspectRatioLock(150, 999, 100, 50, 1, 'bottom', false);
    expect(r.width).toBe(150);
    expect(r.height).toBe(150);
  });
});

// ─── applyVectorAspectLock (vector set: always locked, any handle) ───────────
describe('applyVectorAspectLock', () => {
  // ratio 2 (w/h). cur 200×100 at (10,20).
  test('corner bottom-right: width drives height, no reposition', () => {
    const r = applyVectorAspectLock(400, 999, 200, 100, 10, 20, 2, 'right', 'bottom', false);
    expect(r.width).toBe(400);
    expect(r.height).toBe(200);   // 400/2
    expect(r.left).toBe(10);
    expect(r.top).toBe(20);       // bottom-right pins top-left
  });
  test('corner top-left: pins the BOTTOM (top moves by the height delta)', () => {
    const r = applyVectorAspectLock(400, 999, 200, 100, 10, 20, 2, 'left', 'top', false);
    expect(r.height).toBe(200);
    expect(r.top).toBe(20 + (100 - 200)); // curTop + (curH - h) = -80, bottom stays
  });
  test('horizontal edge (right): height follows SYMMETRICALLY (centre y fixed)', () => {
    const r = applyVectorAspectLock(400, 100, 200, 100, 10, 20, 2, 'right', null, false);
    expect(r.width).toBe(400);
    expect(r.height).toBe(200);
    expect(r.top).toBe(20 - (200 - 100) / 2); // -30, vertical centre unchanged
  });
  test('vertical edge (bottom): width follows symmetrically from height', () => {
    const r = applyVectorAspectLock(200, 300, 200, 100, 10, 20, 2, null, 'bottom', false);
    expect(r.height).toBe(300);
    expect(r.width).toBe(600);     // 300*2
    expect(r.left).toBe(10 - (600 - 200) / 2); // -190, horizontal centre unchanged
  });
  test('in layout: width/height locked but NO position re-anchor', () => {
    const r = applyVectorAspectLock(400, 100, 200, 100, 10, 20, 2, 'right', null, true);
    expect(r.width).toBe(400);
    expect(r.height).toBe(200);
    expect(r.left).toBe(10);
    expect(r.top).toBe(20);        // layout positions it — left/top untouched
  });
});

// ─── applySymmetricResize (Alt-resize) ──────────────────────────────────────

describe('applySymmetricResize', () => {
  test('corner grow — doubles both deltas, centre stays fixed', () => {
    // 100×100 at (50,50) → centre (100,100). Normal resize was to 150×130.
    const r = applySymmetricResize(100, 100, 50, 50, 150, 130);
    expect(r.width).toBe(200);   // 100 + (150-100)*2
    expect(r.height).toBe(160);  // 100 + (130-100)*2
    expect(r.left).toBe(0);      // 50 - 50
    expect(r.top).toBe(20);      // 50 - 30
    expect(r.left + r.width / 2).toBe(100);  // centre unchanged
    expect(r.top + r.height / 2).toBe(100);
  });

  test('single-axis (edge) — only the dragged axis grows', () => {
    // Edge handle → height delta is 0, so height + top are untouched.
    const r = applySymmetricResize(100, 100, 50, 50, 140, 100);
    expect(r.width).toBe(180);
    expect(r.height).toBe(100);
    expect(r.left).toBe(10);
    expect(r.top).toBe(50);
  });

  test('shrink — centre still held', () => {
    const r = applySymmetricResize(200, 200, 0, 0, 150, 200);
    expect(r.width).toBe(100);   // 200 + (-50)*2
    expect(r.left).toBe(50);     // 0 - (-50)
    expect(r.left + r.width / 2).toBe(100);
  });

  test('no change — identity', () => {
    expect(applySymmetricResize(100, 100, 50, 50, 100, 100))
      .toEqual({ width: 100, height: 100, left: 50, top: 50 });
  });
});

// ─── getResizeCommitProperties ──────────────────────────────────────────────

describe('getResizeCommitProperties', () => {
  const styles = {
    width: '200px', height: '100px',
    left: '50px', right: '30px',
    top: '20px', bottom: '40px',
  };

  test('basic absolute: commits width, height, left, top (fixed px)', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: false, bottom: false },
      false, true, true, false, false, false,
    );
    expect(r.width).toBe('200px');
    expect(r.height).toBe('100px');
    expect(r.left).toBe('50px');
    expect(r.top).toBe('20px');
    expect(r.right).toBeUndefined();
    expect(r.bottom).toBeUndefined();
  });

  test('layout mode: only width and height', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: false, bottom: false },
      true, false, false, false, false, false,
    );
    expect(r.width).toBe('200px');
    expect(r.height).toBe('100px');
    expect(r.left).toBeUndefined();
    expect(r.top).toBeUndefined();
  });

  test('pinned left + right: commits both sides, width', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: true, top: false, bottom: false },
      false, true, false, false, false, false,
    );
    expect(r.left).toBe('50px');
    expect(r.right).toBe('30px');
    expect(r.width).toBe('200px');
  });

  test('pinned all 4 sides', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: true, top: true, bottom: true },
      false, true, true, false, false, false,
    );
    expect(r.left).toBe('50px');
    expect(r.right).toBe('30px');
    expect(r.top).toBe('20px');
    expect(r.bottom).toBe('40px');
  });

  test('horizontal inset: no width', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: true, top: false, bottom: false },
      false, true, false, true, false, false,
    );
    expect(r.width).toBeUndefined();
    expect(r.left).toBe('50px');
    expect(r.right).toBe('30px');
  });

  test('vertical inset: no height', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: true, bottom: true },
      false, false, true, false, true, false,
    );
    expect(r.height).toBeUndefined();
    expect(r.top).toBe('20px');
    expect(r.bottom).toBe('40px');
  });

  test('variant root: strips left and top', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: false, top: true, bottom: false },
      false, true, true, false, false, true,
    );
    expect(r.left).toBeUndefined();
    expect(r.top).toBeUndefined();
    expect(r.width).toBe('200px');
    expect(r.height).toBe('100px');
  });

  test('single pin right: commits right, not left', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: true, top: false, bottom: false },
      false, false, false, false, false, false,
    );
    expect(r.right).toBe('30px');
    expect(r.left).toBeUndefined();
  });

  test('single pin bottom: commits bottom, not top', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: false, bottom: true },
      false, false, false, false, false, false,
    );
    expect(r.bottom).toBe('40px');
    expect(r.top).toBeUndefined();
  });

  test('both insets: neither width nor height in output', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: true, top: true, bottom: true },
      false, true, true, true, true, false,
    );
    expect(r.width).toBeUndefined();
    expect(r.height).toBeUndefined();
    expect(r.left).toBe('50px');
    expect(r.right).toBe('30px');
    expect(r.top).toBe('20px');
    expect(r.bottom).toBe('40px');
  });

  test('no insets: both width and height present', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: false, bottom: false },
      false, true, true, false, false, false,
    );
    expect(r.width).toBe('200px');
    expect(r.height).toBe('100px');
    expect(r.left).toBe('50px');
    expect(r.top).toBe('20px');
  });

  test('horizontal inset with L+R pins: all inset sides present, no width', () => {
    const r = getResizeCommitProperties(styles,
      { left: true, right: true, top: false, bottom: false },
      false, true, true, true, false, false,
    );
    expect(r.width).toBeUndefined();
    expect(r.height).toBe('100px');
    expect(r.left).toBe('50px');
    expect(r.right).toBe('30px');
    expect(r.top).toBe('20px');
  });

  test('vertical inset with T+B pins: all inset sides present, no height', () => {
    const r = getResizeCommitProperties(styles,
      { left: false, right: false, top: true, bottom: true },
      false, true, true, false, true, false,
    );
    expect(r.height).toBeUndefined();
    expect(r.width).toBe('200px');
    expect(r.top).toBe('20px');
    expect(r.bottom).toBe('40px');
    expect(r.left).toBe('50px');
  });
});

// ─── lockedShiftHeight — Shift aspect lock in the custom SVG resize loops ────
// The rotated-shape / rotated-group loops bypass startResize's shared
// applyAspectRatioLock, so Shift on an SVG corner did nothing (frame-parity
// gap, live find 2026-07-24). Width drives height, same as the shared helper.

describe('lockedShiftHeight (SVG Shift aspect lock)', () => {
  test('corner drag with Shift locks height to width / ratio', () => {
    // 2:1 shape resized to width 300 → height must become 150.
    expect(lockedShiftHeight(300, 999, true, 'right', 'bottom', 2)).toBe(150);
  });

  test('no Shift → height passes through', () => {
    expect(lockedShiftHeight(300, 80, false, 'right', 'bottom', 2)).toBe(80);
  });

  test('edge drags never lock (frame parity — Shift lock is corner-only)', () => {
    expect(lockedShiftHeight(300, 80, true, 'right', null, 2)).toBe(80);
    expect(lockedShiftHeight(300, 80, true, null, 'bottom', 2)).toBe(80);
  });

  test('degenerate ratio (0 / negative / NaN start height) passes through', () => {
    expect(lockedShiftHeight(300, 80, true, 'left', 'top', 0)).toBe(80);
    expect(lockedShiftHeight(300, 80, true, 'left', 'top', -1)).toBe(80);
    expect(lockedShiftHeight(300, 80, true, 'left', 'top', NaN)).toBe(80);
  });

  test('locked height clamps to MIN_SIZE', () => {
    // Tiny width against a huge ratio → derived height would be ~0.001.
    expect(lockedShiftHeight(1, 80, true, 'left', 'top', 1000)).toBe(1);
  });
});

// ─── getResizeCommitProperties — center-positioned axes (translate -50%) ─────
//
// `left: N%` + `translateX(-50%)` (the un-pinned-axis form PositionTool
// writes) is neither pinned nor fixed-px, so the commit used to drop `left`
// entirely — an edge drag changed only width while the center % stayed put,
// growing BOTH sides around it (user report 2026-07-29, only-top-pinned
// resize). With centeredX/centeredY the re-aimed center % from the live loop
// commits, but only for the axis the handle actually resized.

describe('getResizeCommitProperties — centered axes', () => {
  const styles = {
    width: '357.612px', height: '155px',
    left: '43.4707%', right: '',
    top: '96px', bottom: '',
  };
  const noPins = { left: false, right: false, top: false, bottom: false };

  test('centeredX + left-edge drag commits the re-aimed center %', () => {
    const r = getResizeCommitProperties(styles, { ...noPins, top: true },
      false, false, true, false, false, false, 'left', true, false,
    );
    expect(r.left).toBe('43.4707%');
    expect(r.width).toBe('357.612px');
    expect(r.top).toBe('96px');
  });

  test('vertical-only drag without a transform does NOT commit left (caller passes false)', () => {
    // The flag is caller-computed from what the live loop actually wrote:
    // a vertical drag on an UN-rotated centered node never writes left.
    const r = getResizeCommitProperties(styles, { ...noPins, top: true },
      false, false, true, false, false, false, 'bottom', false, false,
    );
    expect(r.left).toBeUndefined();
    expect(r.width).toBeUndefined();
    expect(r.height).toBe('155px');
  });

  test('ROTATED vertical drag commits left too (rotation couples height→x)', () => {
    // transform: translateX(-50%) rotate(22.5deg), direction "top" — the
    // compensation moves newLeft on a height resize, the live loop writes
    // it, and the commit must keep it (trace 2026-07-29: left was dropped
    // → per-resize horizontal drift).
    const r = getResizeCommitProperties(styles, { ...noPins, top: true },
      false, false, true, false, false, false, 'top', true, false,
    );
    expect(r.left).toBe('43.4707%');
    expect(r.height).toBe('155px');
    expect(r.width).toBeUndefined();
    expect(r.top).toBe('96px');
  });

  test('centeredY + top-edge drag commits the re-aimed center top %', () => {
    const s = { ...styles, top: '50.0743%', left: '52px' };
    const r = getResizeCommitProperties(s, noPins,
      false, true, false, false, false, false, 'top', false, true,
    );
    expect(r.top).toBe('50.0743%');
    expect(r.left).toBe('52px');
  });

  test('non-centered % left still NOT committed (plain relative positioning)', () => {
    const r = getResizeCommitProperties(styles, { ...noPins, top: true },
      false, false, true, false, false, false, 'left', false, false,
    );
    expect(r.left).toBeUndefined();
    expect(r.width).toBe('357.612px');
  });

  test('empty left never committed even when centeredX', () => {
    const r = getResizeCommitProperties({ ...styles, left: '' }, { ...noPins, top: true },
      false, false, true, false, false, false, 'left', true, false,
    );
    expect(r.left).toBeUndefined();
  });
});
