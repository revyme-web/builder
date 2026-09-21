import { describe, it, expect } from 'vitest';
import { pinFieldDisplayPx, pinFieldCommitValue, paintedPinPx } from './pin-field-units';

describe('pinFieldDisplayPx', () => {
  it('passes px through', () => {
    expect(pinFieldDisplayPx('649px', 807)).toBe(649);
    expect(pinFieldDisplayPx('-12px', 807)).toBe(-12);
  });

  // The reported bug: 36.7802% of an 807px parent paints at ~297px, but the
  // field showed 37 and the first chevron committed 36px.
  it('resolves a percentage against the parent', () => {
    expect(pinFieldDisplayPx('36.7802%', 807)).toBeCloseTo(296.81, 1);
  });

  it('is 0 with no value and with an unresolvable parent', () => {
    expect(pinFieldDisplayPx(undefined, 807)).toBe(0);
    expect(pinFieldDisplayPx('', 807)).toBe(0);
    expect(pinFieldDisplayPx('36.7802%', 0)).toBe(0);
    expect(pinFieldDisplayPx('auto', 807)).toBe(0);
  });
});

describe('pinFieldCommitValue', () => {
  it('appends px when the source is px or unset', () => {
    expect(pinFieldCommitValue('36', '649px', 807)).toBe('36px');
    expect(pinFieldCommitValue('36', undefined, 807)).toBe('36px');
  });

  it('writes back in percent when the source is percent', () => {
    // 297px of 807 ≈ the value it came from — the chevron moves by 1px, not
    // by 260px.
    expect(pinFieldCommitValue('297', '36.7802%', 807)).toBe('36.803%');
    expect(pinFieldCommitValue('296', '36.7802%', 807)).toBe('36.6791%');
  });

  it('round-trips within a pixel', () => {
    const shown = Math.round(pinFieldDisplayPx('36.7802%', 807));
    const back = pinFieldCommitValue(String(shown), '36.7802%', 807);
    expect(pinFieldDisplayPx(back, 807)).toBeCloseTo(shown, 3);
  });

  it('keeps an explicit unit the user typed', () => {
    expect(pinFieldCommitValue('50%', '649px', 807)).toBe('50%');
    expect(pinFieldCommitValue('50px', '36.7802%', 807)).toBe('50px');
  });

  it('empty clears the property', () => {
    expect(pinFieldCommitValue('', '36.7802%', 807)).toBe('');
  });

  it('falls back to px when the parent is unknown', () => {
    expect(pinFieldCommitValue('297', '36.7802%', 0)).toBe('297px');
  });
});

describe('paintedPinPx', () => {
  // Frame B: 183×195 at (519,105) in an 807×474 parent. The source declares
  // left+top only, so R and B had no value and the fields read 0 — the first
  // chevron then committed -1px and slammed it against the edge.
  const RECT = { left: 519, top: 105, width: 183, height: 195, parentWidth: 807, parentHeight: 474 };

  it('derives the undeclared sides from the painted box', () => {
    const p = paintedPinPx(RECT, 0, 0);
    expect(p.left).toBe(519);
    expect(p.top).toBe(105);
    expect(p.right).toBe(807 - 519 - 183);   // 105
    expect(p.bottom).toBe(474 - 105 - 195);  // 174 — what the user's B field should have shown
  });

  it('removes the centering translate, like livePinValues', () => {
    // Painted at 519 with translateX(-50%) means CSS left is 519 + 91.5.
    const p = paintedPinPx(RECT, -91.5, 0);
    expect(p.left).toBe(610.5);
    expect(p.right).toBe(807 - 610.5 - 183);
  });

  it('opposite sides always sum to the parent minus the box', () => {
    const p = paintedPinPx(RECT, 0, 0);
    expect(p.left + p.right + RECT.width).toBe(RECT.parentWidth);
    expect(p.top + p.bottom + RECT.height).toBe(RECT.parentHeight);
  });
});
