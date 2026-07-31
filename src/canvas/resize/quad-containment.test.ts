// quad-containment.test.ts — Pure-math tests for the canvas-dnd-ported
// transform-aware containment helpers. Used by drag entry detection so a
// rotated parent's AABB doesn't trigger entry while the dragged element is
// still visually outside its rotated quad.

import { describe, test, expect } from 'vitest';
import { pointInQuad, isFullyInsideQuad, cornersFromRect, type ScreenCorners } from './geometry-utils';

function aabbCorners(left: number, top: number, w: number, h: number): ScreenCorners {
  return {
    TL: { x: left, y: top },
    TR: { x: left + w, y: top },
    BR: { x: left + w, y: top + h },
    BL: { x: left, y: top + h },
  };
}

/** Build a 200×200 square rotated 45° around origin (math CCW; screen visually CW). */
function rotatedSquare(): ScreenCorners {
  // Square corners at (-100..100). Rotate by 45° CCW.
  const r = Math.PI / 4;
  const c = Math.cos(r), s = Math.sin(r);
  const pts = [
    { x: -100, y: -100 }, { x: 100, y: -100 },
    { x: 100, y: 100 }, { x: -100, y: 100 },
  ].map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  return { TL: pts[0], TR: pts[1], BR: pts[2], BL: pts[3] };
}

describe('pointInQuad', () => {
  test('point at the center of an axis-aligned square is inside', () => {
    const sq = aabbCorners(0, 0, 200, 200);
    expect(pointInQuad(100, 100, sq)).toBe(true);
  });

  test('points outside the AABB are outside', () => {
    const sq = aabbCorners(0, 0, 200, 200);
    expect(pointInQuad(-10, 100, sq)).toBe(false);
    expect(pointInQuad(210, 100, sq)).toBe(false);
  });

  test('rotated square: center of rotation is inside', () => {
    const sq = rotatedSquare();
    expect(pointInQuad(0, 0, sq)).toBe(true);
  });

  test('rotated square: corners of the original AABB are now OUTSIDE the rotated quad', () => {
    // Pre-rotation top-left was (-100, -100). After 45° rotation that point
    // moves; the AABB of the rotated square extends to ~(-141, -141)..(141, 141)
    // but the rotated quad's vertices form a diamond. The screen point (-100, -100)
    // is outside the diamond (it's near a flat edge corner of the AABB, but the
    // diamond's corners are at the cardinal axes).
    const sq = rotatedSquare();
    expect(pointInQuad(-100, -100, sq)).toBe(false);
    expect(pointInQuad(100, -100, sq)).toBe(false);
    expect(pointInQuad(100, 100, sq)).toBe(false);
    expect(pointInQuad(-100, 100, sq)).toBe(false);
  });

  test('rotated square: points just inside the diamond vertices are inside, just outside are outside', () => {
    const sq = rotatedSquare();
    // Diamond vertices are at distance √2 * 100 from origin along cardinal axes.
    // Use a small inset so floating-point noise on the boundary doesn't matter.
    const r = Math.SQRT2 * 100;
    expect(pointInQuad(r - 0.5, 0, sq)).toBe(true);
    expect(pointInQuad(0, r - 0.5, sq)).toBe(true);
    expect(pointInQuad(r + 0.5, 0, sq)).toBe(false);
    expect(pointInQuad(0, r + 0.5, sq)).toBe(false);
  });
});

describe('isFullyInsideQuad', () => {
  test('all 4 corners inside: small square inside larger AABB-aligned parent', () => {
    const child = aabbCorners(50, 50, 100, 100);
    const parent = aabbCorners(0, 0, 200, 200);
    expect(isFullyInsideQuad(child, parent)).toBe(true);
  });

  test('one corner outside: not fully inside', () => {
    const child = aabbCorners(50, 50, 200, 100); // right edge at 250 > parent.right=200
    const parent = aabbCorners(0, 0, 200, 200);
    expect(isFullyInsideQuad(child, parent)).toBe(false);
  });

  test('user\'s scenario: child AABB sits inside the parent\'s bounding box but NOT inside the rotated quad', () => {
    // Reproduce the bug from the screenshot: small element near a corner of
    // a rotated parent. Plain AABB check returns true (because it's inside
    // the parent's AABB which extends to the diamond extents), but the
    // visual quad correctly returns false.
    const parentRotated = rotatedSquare();        // diamond, AABB ~283×283
    const childAabb = aabbCorners(80, 80, 30, 30); // sits in the AABB corner

    // Sanity: child IS inside parent's AABB.
    const parentAabb = aabbCorners(-Math.SQRT2 * 100, -Math.SQRT2 * 100, Math.SQRT2 * 200, Math.SQRT2 * 200);
    expect(isFullyInsideQuad(childAabb, parentAabb)).toBe(true);

    // Truth: child is NOT fully inside the rotated quad.
    expect(isFullyInsideQuad(childAabb, parentRotated)).toBe(false);
  });

  test('child fully inside the rotated quad', () => {
    const parentRotated = rotatedSquare();
    // A small square at the center is fully inside the rotated quad.
    const child = aabbCorners(-20, -20, 40, 40);
    expect(isFullyInsideQuad(child, parentRotated)).toBe(true);
  });

  test('cornersFromRect produces an axis-aligned quad usable with isFullyInsideQuad', () => {
    const rect = new DOMRect(50, 50, 100, 100);
    const corners = cornersFromRect(rect);
    const parent = aabbCorners(0, 0, 200, 200);
    expect(isFullyInsideQuad(corners, parent)).toBe(true);
  });
});

// ─── Exit detection symmetry ───────────────────────────────────────────────
//
// AbsoluteInFrameStrategy.onMove uses `!isFullyInsideQuad(...)` for exit so
// the boundary at which a child detaches matches the boundary at which an
// outside element would enter. These tests lock that symmetry in: the same
// configuration that returns "fully inside" for entry must return "not
// outside" for exit, and vice versa.
describe('center-based exit (asymmetric with fully-inside entry)', () => {
  // The strategy's exit predicate is intentionally asymmetric with entry:
  //   ENTRY = "fully inside" (strict, requires committal)
  //   EXIT  = "center outside" (lenient, gives wiggle room while inside)
  // This mirrors what the user expects: while the dragged element's middle
  // is over the parent, stay inside even if a corner is poking out.

  test('child center inside rotated parent: exit predicate FALSE (stays inside)', () => {
    const parent = rotatedSquare();
    // Wide AABB-aligned child whose left/right corners poke past the
    // diamond's slanted edges (|x|+|y| > 141 at the corners), but center
    // (0,0) is well inside. Strict "fully inside" returns false; center
    // check returns inside. This is the oscillation scenario.
    const child = aabbCorners(-140, -30, 280, 60);
    expect(isFullyInsideQuad(child, parent)).toBe(false);
    const cx = (child.TL.x + child.TR.x + child.BR.x + child.BL.x) / 4;
    const cy = (child.TL.y + child.TR.y + child.BR.y + child.BL.y) / 4;
    expect(pointInQuad(cx, cy, parent)).toBe(true);
  });

  test('child center outside rotated parent: exit fires', () => {
    const parent = rotatedSquare();
    // Center pushed outside the diamond.
    const child = aabbCorners(150, 150, 30, 30);
    const cx = (child.TL.x + child.TR.x + child.BR.x + child.BL.x) / 4;
    const cy = (child.TL.y + child.TR.y + child.BR.y + child.BL.y) / 4;
    expect(pointInQuad(cx, cy, parent)).toBe(false);
  });

  test('non-rotated parent: center-vs-AABB matches the original simple check', () => {
    const parent = aabbCorners(0, 0, 200, 200);
    // Child mostly inside, slightly past the right edge — center still inside.
    const child = aabbCorners(50, 50, 160, 100);
    const cx = (child.TL.x + child.TR.x + child.BR.x + child.BL.x) / 4;
    const cy = (child.TL.y + child.TR.y + child.BR.y + child.BL.y) / 4;
    expect(pointInQuad(cx, cy, parent)).toBe(true);
  });

  test('asymmetric: entry refuses where exit accepts (the dead zone the user wanted)', () => {
    const parent = rotatedSquare();
    // Wide child with center inside but corners poking out — entry
    // refuses, exit accepts. This is the wiggle-room zone that prevents
    // oscillation while dragging around inside a rotated parent.
    const child = aabbCorners(-140, -30, 280, 60);
    expect(isFullyInsideQuad(child, parent)).toBe(false); // entry: not yet
    const cx = (child.TL.x + child.TR.x + child.BR.x + child.BL.x) / 4;
    const cy = (child.TL.y + child.TR.y + child.BR.y + child.BL.y) / 4;
    expect(pointInQuad(cx, cy, parent)).toBe(true); // exit: still inside
  });
});
