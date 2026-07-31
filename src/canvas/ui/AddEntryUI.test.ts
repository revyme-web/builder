// AddEntryUI.test.ts — locks the shared placement scan extracted from the
// AddVariantUI / AddVectorUI pair (9.4b). The scan starts one `padding` past
// the source's far edge and pushes past every overlapping obstacle so the
// "+ Variant" / "+ Vector" card never lands on another entry.

import { describe, it, expect } from 'vitest';
import { scanPastRects, showText, showIcon } from './AddEntryUI';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('scanPastRects — right axis', () => {
  it('places one padding past the source right edge when clear', () => {
    const out = scanPastRects('right', rect(0, 0, 100, 50), 20, []);
    expect(out).toEqual({ left: 120, top: 0, width: 100, height: 50 });
  });

  it('pushes past an overlapping sibling (+ padding)', () => {
    // Candidate would be [120..220) — sibling occupies [150..300).
    const sibling = rect(150, 0, 150, 50);
    const out = scanPastRects('right', rect(0, 0, 100, 50), 20, [sibling]);
    expect(out.left).toBe(300 + 20);
    expect(out.top).toBe(0);
  });

  it('ignores obstacles on a different row (no vertical overlap)', () => {
    const farBelow = rect(120, 500, 100, 50);
    const out = scanPastRects('right', rect(0, 0, 100, 50), 20, [farBelow]);
    expect(out.left).toBe(120);
  });
});

describe('scanPastRects — below axis', () => {
  it('places one padding past the source bottom edge when clear', () => {
    const out = scanPastRects('below', rect(0, 0, 100, 50), 10, []);
    expect(out).toEqual({ left: 0, top: 60, width: 100, height: 50 });
  });

  it('pushes past an overlapping sibling below (+ padding)', () => {
    // Candidate would be [60..110) vertically — sibling occupies [80..200).
    const sibling = rect(0, 80, 100, 120);
    const out = scanPastRects('below', rect(0, 0, 100, 50), 10, [sibling]);
    expect(out.top).toBe(200 + 10);
    expect(out.left).toBe(0);
  });
});

describe('card content thresholds', () => {
  it('showText needs 80×50, showIcon needs 30×30 (screen px)', () => {
    expect(showText({ left: 0, top: 0, width: 80, height: 50 })).toBe(true);
    expect(showText({ left: 0, top: 0, width: 79, height: 50 })).toBe(false);
    expect(showIcon({ left: 0, top: 0, width: 30, height: 30 })).toBe(true);
    expect(showIcon({ left: 0, top: 0, width: 29, height: 30 })).toBe(false);
  });
});
