import { describe, it, expect } from 'vitest';
import { calculateMultiAlign, type AlignRect } from './multi-align';

// Two boxes: A at x=100 (w=40), B at x=200 (w=80). Same y for clarity.
const A: AlignRect = { id: 'a', left: 100, top: 50, width: 40, height: 20 };
const B: AlignRect = { id: 'b', left: 200, top: 90, width: 80, height: 30 };
const rects = [A, B];

describe('calculateMultiAlign', () => {
  it('returns empty for <2 rects (nothing to align against)', () => {
    expect(calculateMultiAlign('left', [A]).size).toBe(0);
    expect(calculateMultiAlign('left', []).size).toBe(0);
  });

  it('align left → both snap to the leftmost edge (minLeft=100)', () => {
    const d = calculateMultiAlign('left', rects);
    expect(d.get('a')!.dx).toBe(0);    // already at 100
    expect(d.get('b')!.dx).toBe(-100); // 200 → 100
    // horizontal direction emits no dy
    expect(d.get('a')!.dy).toBeUndefined();
  });

  it('align right → right edges meet maxRight (200+80=280)', () => {
    const d = calculateMultiAlign('right', rects);
    // A target left = 280 - 40 = 240 → dx 140
    expect(d.get('a')!.dx).toBe(140);
    // B already ends at 280 → dx 0
    expect(d.get('b')!.dx).toBe(0);
  });

  it('center-h → each centred on group mid-X', () => {
    // bbox X: [100, 280] → centerX = 190
    const d = calculateMultiAlign('center-h', rects);
    // A target left = 190 - 20 = 170 → dx 70
    expect(d.get('a')!.dx).toBe(70);
    // B target left = 190 - 40 = 150 → dx -50
    expect(d.get('b')!.dx).toBe(-50);
  });

  it('align top → both snap to minTop=50', () => {
    const d = calculateMultiAlign('top', rects);
    expect(d.get('a')!.dy).toBe(0);   // already at 50
    expect(d.get('b')!.dy).toBe(-40); // 90 → 50
    expect(d.get('a')!.dx).toBeUndefined();
  });

  it('align bottom → bottom edges meet maxBottom (90+30=120)', () => {
    const d = calculateMultiAlign('bottom', rects);
    // A target top = 120 - 20 = 100 → dy 50
    expect(d.get('a')!.dy).toBe(50);
    // B already ends at 120 → dy 0
    expect(d.get('b')!.dy).toBe(0);
  });

  it('center-v → each centred on group mid-Y', () => {
    // bbox Y: [50, 120] → centerY = 85
    const d = calculateMultiAlign('center-v', rects);
    // A target top = 85 - 10 = 75 → dy 25
    expect(d.get('a')!.dy).toBe(25);
    // B target top = 85 - 15 = 70 → dy -20
    expect(d.get('b')!.dy).toBe(-20);
  });

  it('left-align is idempotent (re-running yields zero deltas)', () => {
    const first = calculateMultiAlign('left', rects);
    const moved = rects.map(r => ({ ...r, left: r.left + (first.get(r.id)!.dx ?? 0) }));
    const second = calculateMultiAlign('left', moved);
    expect(second.get('a')!.dx).toBe(0);
    expect(second.get('b')!.dx).toBe(0);
  });
});
