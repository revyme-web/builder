// transform-reparent.test.ts — Pure-math tests for the canvas-dnd-ported
// entry/exit position helpers. The full functions read through the bridge
// for parent screen rect + computed styles; we mock those reads so the
// actual math is what gets exercised.

import { describe, test, expect, vi, beforeEach } from 'vitest';

// jsdom doesn't ship DOMMatrix / DOMPoint. The math we test is identical
// to what the runtime DOM API provides; this is a tiny 2D-affine implementation
// good enough for the compose-and-invert path the helper uses.
class StubDOMPoint {
  constructor(public x: number, public y: number, public z = 0, public w = 1) {}
  matrixTransform(m: StubDOMMatrix) {
    return new StubDOMPoint(
      m.a * this.x + m.c * this.y + m.e,
      m.b * this.x + m.d * this.y + m.f,
    );
  }
}
class StubDOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(transform?: string | number[]) {
    if (!transform) return;
    // Array form (real DOMMatrix accepts [a,b,c,d,e,f]) — used by the
    // linear-part extraction in convertScreenToParentLocal.
    if (Array.isArray(transform)) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = transform;
      return;
    }
    // Parse the limited cases our tests use: 'none', 'rotate(<deg>deg)',
    // 'matrix(a,b,c,d,e,f)'.
    if (transform === 'none') return;
    const rotMatch = transform.match(/^rotate\((-?\d+(?:\.\d+)?)deg\)$/);
    if (rotMatch) {
      const r = (parseFloat(rotMatch[1]) * Math.PI) / 180;
      this.a = Math.cos(r); this.b = Math.sin(r);
      this.c = -Math.sin(r); this.d = Math.cos(r);
      return;
    }
    const matMatch = transform.match(/^matrix\(([^)]+)\)$/);
    if (matMatch) {
      const v = matMatch[1].split(',').map((s) => parseFloat(s.trim()));
      [this.a, this.b, this.c, this.d, this.e, this.f] = v as any;
    }
  }
  translateSelf(tx: number, ty: number) {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }
  scaleSelf(sx: number, sy: number) {
    this.a *= sx; this.b *= sx;
    this.c *= sy; this.d *= sy;
    return this;
  }
  multiplySelf(o: StubDOMMatrix) {
    const a = this.a * o.a + this.c * o.b;
    const b = this.b * o.a + this.d * o.b;
    const c = this.a * o.c + this.c * o.d;
    const d = this.b * o.c + this.d * o.d;
    const e = this.a * o.e + this.c * o.f + this.e;
    const f = this.b * o.e + this.d * o.f + this.f;
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    return this;
  }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    const inv = new StubDOMMatrix();
    inv.a =  this.d / det; inv.b = -this.b / det;
    inv.c = -this.c / det; inv.d =  this.a / det;
    inv.e = (this.c * this.f - this.d * this.e) / det;
    inv.f = (this.b * this.e - this.a * this.f) / det;
    return inv;
  }
  transformPoint(p: StubDOMPoint) {
    return p.matrixTransform(this);
  }
}
vi.stubGlobal('DOMMatrix', StubDOMMatrix);
vi.stubGlobal('DOMPoint', StubDOMPoint);

vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(),
  findNodeComputedStyle: vi.fn(),
  findNodeComputedStyles: vi.fn(),
  getViewportPrefix: vi.fn(() => ''),
}));

vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: vi.fn(() => ({})),
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

// Keep the pure quad helpers real; only `getScreenCornersById` reads the
// bridge, so stub it (defaults to null → entry math uses the AABB centre).
vi.mock('@/canvas/resize/geometry-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/canvas/resize/geometry-utils')>();
  return { ...actual, getScreenCornersById: vi.fn(() => null) };
});

import * as nodeOps from '@/canvas/node-ops';
import * as geom from '@/canvas/resize/geometry-utils';
import {
  computeExitCanvasPosition,
  computeEntryParentLocalPosition,
  convertScreenToParentLocal,
} from './transform-reparent';

const findNodeRect = nodeOps.findNodeRect as ReturnType<typeof vi.fn>;
const findNodeComputedStyles = nodeOps.findNodeComputedStyles as ReturnType<typeof vi.fn>;
const getScreenCornersById = geom.getScreenCornersById as ReturnType<typeof vi.fn>;

beforeEach(() => {
  findNodeRect.mockReset();
  findNodeComputedStyles.mockReset();
  getScreenCornersById.mockReset();
  getScreenCornersById.mockReturnValue(null);
});

const transform = (x = 0, y = 0, scale = 1) => ({ x, y, scale });
const noOffset = { x: 0, y: 0 };

describe('computeExitCanvasPosition', () => {
  test('non-transformed element: canvas position == AABB top-left', () => {
    // 100×50 element at screen (200, 150), canvas not panned/zoomed.
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 200, top: 150, width: 100, height: 50 },
      transform(),
      noOffset,
      100, // liftWidth == AABB width → no center offset
      50,
    );
    expect(result.canvasLeft).toBe(200);
    expect(result.canvasTop).toBe(150);
  });

  test('rotated element: layout-box origin shifts inward to keep visual center', () => {
    // 100×100 element rotated 45° → AABB ≈ 141.4×141.4. The CSS layout box
    // stays 100×100, but its TL must sit ~20.7px inward from the AABB TL
    // so the centers coincide.
    const aabbW = Math.SQRT2 * 100;
    const aabbH = Math.SQRT2 * 100;
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 0, top: 0, width: aabbW, height: aabbH },
      transform(),
      noOffset,
      100,
      100,
    );
    expect(result.canvasLeft).toBeCloseTo((aabbW - 100) / 2, 6);
    expect(result.canvasTop).toBeCloseTo((aabbH - 100) / 2, 6);
  });

  test('scaled element: AABB is 2x → layout-box origin shifts by half-CSS-width', () => {
    // 100×100 element with scale(2) → AABB 200×200. Layout box stays 100×100.
    // Center of AABB at (100, 100). Layout-box TL should be (50, 50) for
    // center to coincide with AABB center.
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 0, top: 0, width: 200, height: 200 },
      transform(),
      noOffset,
      100,
      100,
    );
    expect(result.canvasLeft).toBe(50);
    expect(result.canvasTop).toBe(50);
  });

  test('canvas zoom: divides screen rect by scale to reach CSS coords', () => {
    // 100×100 CSS element at canvas-origin, canvas zoomed 2x → screen rect
    // 200×200 at (0, 0). Result should be canvas-space (0, 0).
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 0, top: 0, width: 200, height: 200 },
      transform(0, 0, 2),
      noOffset,
      100,
      100,
    );
    expect(result.canvasLeft).toBe(0);
    expect(result.canvasTop).toBe(0);
  });

  test('canvas pan: subtracts pan offset', () => {
    // Canvas panned (50, 30), 100×100 element drawn so its AABB sits at
    // screen (50, 30). In canvas-space that's (0, 0).
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 50, top: 30, width: 100, height: 100 },
      transform(50, 30, 1),
      noOffset,
      100,
      100,
    );
    expect(result.canvasLeft).toBe(0);
    expect(result.canvasTop).toBe(0);
  });

  test('iframe offset: subtracted alongside canvas pan', () => {
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 100, top: 80, width: 100, height: 100 },
      transform(50, 30, 1),
      { x: 30, y: 20 },
      100,
      100,
    );
    // 100 - 30 (iframe) - 50 (pan) = 20
    expect(result.canvasLeft).toBe(20);
    expect(result.canvasTop).toBe(30);
  });

  test('perspective element: anchors on the painted quad diagonal crossing, NOT the AABB centre', () => {
    // Perspective trapezoid: narrow top (x 140..180), wide bottom (x 100..220).
    // AABB = x[100,220] y[100,240] → AABB centre (160, 170).
    // Diagonal crossing of TL→BR and TR→BL = (160, 135) — above the AABB
    // centre because the trapezoid is top-pinched. Anchoring on the AABB
    // centre would commit the node ~35px too low → the "jump down on
    // unparent" the user reported.
    getScreenCornersById.mockReturnValue({
      TL: { x: 140, y: 100 }, TR: { x: 180, y: 100 },
      BR: { x: 220, y: 240 }, BL: { x: 100, y: 240 },
    });
    const result = computeExitCanvasPosition(
      'child', 'desktop',
      { left: 100, top: 100, width: 120, height: 140 },
      transform(),
      noOffset,
      100, 100,
    );
    // Anchor (160,135) → CSS TL = (160-50, 135-50) = (110, 85).
    // The AABB-centre path would have given top = 170-50 = 120.
    expect(result.canvasLeft).toBe(110);
    expect(result.canvasTop).toBe(85);
  });
});

describe('computeEntryParentLocalPosition', () => {
  test('non-transformed parent + element: simple AABB-relative math', () => {
    findNodeRect.mockReturnValue({ left: 100, top: 100, width: 400, height: 400 });
    findNodeComputedStyles
      .mockReturnValueOnce({
        // parent
        width: '400', height: '400',
        paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
        transform: 'none',
      })
      .mockReturnValueOnce({
        // child
        width: '50', height: '50',
      });

    // Child AABB at screen (200, 200) — center at (225, 225). Parent at
    // (100, 100). Expected parent-local CSS TL: (125 - 25, 125 - 25) = (100, 100).
    const result = computeEntryParentLocalPosition(
      'child', 'parent',
      { left: 200, top: 200, width: 50, height: 50 },
      'desktop', 1,
    );
    expect(result?.parentRelLeft).toBe(100);
    expect(result?.parentRelTop).toBe(100);
    expect(result?.cssWidth).toBe(50);
    expect(result?.cssHeight).toBe(50);
  });

  test('scaled child: cssWidth from computed style, NOT from AABB', () => {
    findNodeRect.mockReturnValue({ left: 0, top: 0, width: 400, height: 400 });
    findNodeComputedStyles
      .mockReturnValueOnce({
        width: '400', height: '400',
        paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
        transform: 'none',
      })
      .mockReturnValueOnce({
        width: '100', height: '100', // CSS layout box — half the AABB
      });

    // Child AABB 200×200 (scale(2) on a 100×100 box) at screen (100, 100) →
    // AABB center at (200, 200). Parent local center: (200, 200).
    // CSS TL should be (200 - 50, 200 - 50) = (150, 150) — NOT (200 - 100, 200 - 100).
    const result = computeEntryParentLocalPosition(
      'child', 'parent',
      { left: 100, top: 100, width: 200, height: 200 },
      'desktop', 1,
    );
    expect(result?.parentRelLeft).toBe(150);
    expect(result?.parentRelTop).toBe(150);
    expect(result?.cssWidth).toBe(100);
    expect(result?.cssHeight).toBe(100);
  });

  test('returns null when parent rect cannot be resolved', () => {
    findNodeRect.mockReturnValue(null);
    // Even though computed styles fall back, no parent rect = no math possible.
    findNodeComputedStyles.mockReturnValue({
      width: '50', height: '50',
    });
    const result = computeEntryParentLocalPosition(
      'child', 'gone',
      { left: 0, top: 0, width: 50, height: 50 },
      'desktop', 1,
    );
    expect(result).toBeNull();
  });

  test('perspective child: anchors on the painted quad diagonal crossing, NOT the AABB centre', () => {
    findNodeRect.mockReturnValue({ left: 0, top: 0, width: 400, height: 400 });
    findNodeComputedStyles
      .mockReturnValueOnce({
        width: '400', height: '400',
        paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
        transform: 'none',
      })
      .mockReturnValueOnce({ width: '100', height: '100' });

    // Perspective trapezoid: narrow top (x 140..180), wide bottom (x 100..220).
    // AABB = x[100,220] y[100,240] → AABB centre (160, 170).
    // Diagonal crossing of TL→BR and TR→BL = (160, 135) — well above the
    // AABB centre because the trapezoid is "pinched" at the top.
    getScreenCornersById.mockReturnValue({
      TL: { x: 140, y: 100 }, TR: { x: 180, y: 100 },
      BR: { x: 220, y: 240 }, BL: { x: 100, y: 240 },
    });

    const result = computeEntryParentLocalPosition(
      'child', 'parent',
      { left: 100, top: 100, width: 120, height: 140 },
      'desktop', 1,
    );
    // Anchor (160,135) → CSS TL = (160-50, 135-50) = (110, 85).
    // The AABB-centre path would have given top = 170-50 = 120.
    expect(result?.parentRelLeft).toBe(110);
    expect(result?.parentRelTop).toBe(85);
  });

  test('parent padding: subtracted from local position', () => {
    findNodeRect.mockReturnValue({ left: 0, top: 0, width: 420, height: 420 });
    findNodeComputedStyles
      .mockReturnValueOnce({
        width: '400', height: '400', // content-box
        paddingLeft: '10', paddingTop: '10', paddingRight: '10', paddingBottom: '10',
        transform: 'none',
      })
      .mockReturnValueOnce({
        width: '50', height: '50',
      });

    // Child AABB at screen (60, 60), 50×50 → center (85, 85). Parent local
    // box-center is at parent screen center (210, 210). Local-frame TL of
    // padding-box is at (-padL, -padT) from local content TL once padding
    // is subtracted.
    // Forward maps padding-box TL (0, 0) → screen (0, 0) when:
    //   bcrCx - boxW/2 = 210 - 210 = 0  ✓
    // So inverse(85, 85) = (85, 85), then subtract padding (10, 10) = (75, 75).
    // CSS TL = (75 - 25, 75 - 25) = (50, 50).
    const result = computeEntryParentLocalPosition(
      'child', 'parent',
      { left: 60, top: 60, width: 50, height: 50 },
      'desktop', 1,
    );
    expect(result?.parentRelLeft).toBe(50);
    expect(result?.parentRelTop).toBe(50);
  });
});

describe('convertScreenToParentLocal — rotated parent', () => {
  test('rotated parent: maps screen point onto parent\'s local axes', () => {
    // 200×200 parent rotated 90° CW. After rotation, the parent's local
    // X axis runs along screen +Y, local Y axis runs along screen -X.
    // We don't have direct DOMMatrix matrix-string mocks here, so we use
    // a rotate(90deg) string and verify the projection direction.
    findNodeRect.mockReturnValue({ left: -100, top: 100, width: 200, height: 200 });
    findNodeComputedStyles.mockReturnValue({
      width: '200', height: '200',
      paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
      transform: 'rotate(90deg)',
    });

    // Parent BCR center at (0, 200). A screen point at (0, 200) is the center
    // → local (100, 100).
    const center = convertScreenToParentLocal(0, 200, 'parent', 'desktop', 1);
    expect(center?.x).toBeCloseTo(100, 6);
    expect(center?.y).toBeCloseTo(100, 6);
  });
});

// ─── Centered-translate parent (translate(-50%,-50%)) — entry double-shift ──
//
// A parent positioned `left/top: 50%` + `translate(-50%, -50%)` (the
// centered-image pattern): its computed matrix carries the translation
// (e.g. matrix(1,0,0,1,-680,-380.5)), but the BCR the anchor math uses is
// ALREADY post-translate. Composing the FULL matrix applied the translation
// twice → a canvas node dropped into it landed off by exactly (W/2, H/2)
// (user report 2026-07-30: cssLeft 720 / cssTop 715 instead of ~40 / ~335).
// The forward matrix must use only the LINEAR part.
describe('convertScreenToParentLocal — centered-translate parent', () => {
  test('translate(-50%,-50%) parent maps screen points relative to the VISUAL box', () => {
    // Visual rect: full-bleed 1360×761 at screen (0, 0); the matrix holds the
    // -50%,-50% translation baked to px.
    findNodeRect.mockReturnValue({ left: 0, top: 0, width: 1360, height: 761 });
    findNodeComputedStyles.mockReturnValue({
      width: '1360', height: '761',
      paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
      transform: 'matrix(1, 0, 0, 1, -680, -380.5)',
    });
    const local = convertScreenToParentLocal(100, 100, 'img', 'desktop', 1);
    expect(local).not.toBeNull();
    expect(local!.x).toBeCloseTo(100, 3);
    expect(local!.y).toBeCloseTo(100, 3);
  });

  test('rotated parent is unchanged by the linear-part extraction', () => {
    // 200×100 parent rotated 90° about its centre: visual AABB is 100×200
    // centred at (150, 150). Screen point at the visual centre must map to
    // the CSS-box centre (100, 50).
    findNodeRect.mockReturnValue({ left: 100, top: 50, width: 100, height: 200 });
    findNodeComputedStyles.mockReturnValue({
      width: '200', height: '100',
      paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
      transform: 'rotate(90deg)',
    });
    const local = convertScreenToParentLocal(150, 150, 'rot', 'desktop', 1);
    expect(local!.x).toBeCloseTo(100, 3);
    expect(local!.y).toBeCloseTo(50, 3);
  });

  test('entry into a centered-translate parent lands the child at the cursor spot', () => {
    // The exact trace shape: parent Image 1360×761 (visual at 0,0), child AABB
    // 210×118 at screen (615, 364), zoom 1. Expected: child centre anchored →
    // parentRel ≈ (615, 364) + half-AABB − half-CSS. Child css == AABB here.
    findNodeRect.mockReturnValue({ left: 0, top: 0, width: 1360, height: 761 });
    findNodeComputedStyles.mockImplementation((id: string) => (
      id === 'img'
        ? {
            width: '1360', height: '761',
            paddingLeft: '0', paddingTop: '0', paddingRight: '0', paddingBottom: '0',
            transform: 'matrix(1, 0, 0, 1, -680, -380.5)',
          }
        : { width: '210', height: '118' }
    ));
    const r = computeEntryParentLocalPosition(
      'child', 'img',
      { left: 615, top: 364, width: 210, height: 118 },
      'desktop', 1,
    );
    expect(r).not.toBeNull();
    expect(r!.parentRelLeft).toBe(615);
    expect(r!.parentRelTop).toBe(364);
  });
});
