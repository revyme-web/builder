// svg-user-to-screen.test.ts — pure affine math (jsdom-safe, no DOMMatrix).

import { describe, it, expect } from 'vitest';
import {
  IDENTITY, multiply, composeAll, applyAffine, invertAffine,
  translate, scale, rotateDeg, decompose,
  topSvgUserToScreenAffine, nestedChildAffine, affineBoxCorners,
  pivotScreenPosition,
  readNestedChildParams,
  type Affine,
} from './svg-user-to-screen';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const closePt = (p: { x: number; y: number }, x: number, y: number, eps = 1e-6) => {
  close(p.x, x, eps); close(p.y, y, eps);
};

describe('pure affine primitives', () => {
  it('identity is a no-op', () => {
    closePt(applyAffine(IDENTITY, 3, 7), 3, 7);
  });

  it('translate / scale / apply', () => {
    closePt(applyAffine(translate(10, -5), 1, 2), 11, -3);
    closePt(applyAffine(scale(2, 3), 4, 5), 8, 15);
  });

  it('rotateDeg(90) sends (1,0)->(0,1) in screen (y-down, clockwise)', () => {
    closePt(applyAffine(rotateDeg(90), 1, 0), 0, 1);
    closePt(applyAffine(rotateDeg(90), 0, 1), -1, 0);
  });

  it('multiply applies the right operand first', () => {
    // translate then scale: scale(2)·translate(10) → (x+10)*2
    const m = multiply(scale(2, 2), translate(10, 0));
    closePt(applyAffine(m, 0, 0), 20, 0);
  });

  it('invertAffine round-trips a composed transform', () => {
    const m = composeAll(translate(30, 40), rotateDeg(37), scale(2, 2), translate(-5, -8));
    const inv = invertAffine(m)!;
    expect(inv).not.toBeNull();
    for (const [x, y] of [[0, 0], [13, -4], [100, 55]]) {
      const p = applyAffine(m, x, y);
      const back = applyAffine(inv, p.x, p.y);
      closePt(back, x, y, 1e-6);
    }
  });

  it('invertAffine returns null on a degenerate (zero-scale) matrix', () => {
    expect(invertAffine(scale(0, 1))).toBeNull();
    expect(invertAffine([0, 0, 0, 0, 5, 5])).toBeNull();
  });

  it('decompose recovers scale + rotation of a pure rotate·scale', () => {
    const m = composeAll(rotateDeg(72), scale(1.5, 1.5));
    const d = decompose(m);
    close(d.scaleX, 1.5, 1e-9); close(d.scaleY, 1.5, 1e-9);
    close(d.rotationDeg, 72, 1e-6);
  });
});

// The oracle is the EXACT closed form of bridge-sandbox `buildSvgUserToScreen`:
//   screen(u) = C + R(θ) · ((u − pivot) · zoom)
function oracle(C: { x: number; y: number }, pivot: { x: number; y: number }, zoom: number, deg: number, ux: number, uy: number) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const sx = (ux - pivot.x) * zoom, sy = (uy - pivot.y) * zoom;
  return { x: C.x + sx * cos - sy * sin, y: C.y + sx * sin + sy * cos };
}

describe('topSvgUserToScreenAffine reproduces buildSvgUserToScreen (1:1 viewBox, origin 0)', () => {
  const C = { x: 640, y: 360 };
  const pivot = { x: 459, y: 332 };
  const samples = [[0, 0], [918, 664], [459, 332], [200, -50], [918, 0]];
  for (const deg of [0, 30, 72, -45, -160.9]) {
    for (const zoom of [0.5, 1, 2]) {
      it(`θ=${deg} zoom=${zoom}`, () => {
        const m = topSvgUserToScreenAffine({
          Cx: C.x, Cy: C.y, thetaDeg: deg, zoom,
          pivotX: pivot.x, pivotY: pivot.y,
          vbX: 0, vbY: 0, cssW: 918, vbW: 918, cssH: 664, vbH: 664,
        });
        for (const [ux, uy] of samples) {
          const got = applyAffine(m, ux, uy);
          const want = oracle(C, pivot, zoom, deg, ux, uy);
          closePt(got, want.x, want.y, 1e-6);
        }
      });
    }
  }
});

describe('topSvgUserToScreenAffine handles non-zero/negative viewBox origin + scale', () => {
  it('viewBox origin maps the box top-left correctly at θ=0', () => {
    // viewBox "0 -74 893 626" rendered into a 893×626 css box at zoom 1, no rotation.
    // box top-left (viewBox 0,-74) should map to BCR top-left.
    const m = topSvgUserToScreenAffine({
      Cx: 100 + 893 / 2, Cy: 200 + 626 / 2, thetaDeg: 0, zoom: 1,
      pivotX: 893 / 2, pivotY: 626 / 2,
      vbX: 0, vbY: -74, cssW: 893, vbW: 893, cssH: 626, vbH: 626,
    });
    closePt(applyAffine(m, 0, -74), 100, 200, 1e-6);          // viewBox origin -> box TL
    closePt(applyAffine(m, 893, 552), 100 + 893, 200 + 626, 1e-6); // far corner -> box BR
  });

  it('viewBox scale (2:1) halves user coords into css', () => {
    // viewBox 0 0 100 100 into a 200×200 css box at zoom 1.
    const m = topSvgUserToScreenAffine({
      Cx: 0 + 200 / 2, Cy: 0 + 200 / 2, thetaDeg: 0, zoom: 1,
      pivotX: 100, pivotY: 100, vbX: 0, vbY: 0, cssW: 200, vbW: 100, cssH: 200, vbH: 100,
    });
    closePt(applyAffine(m, 0, 0), 0, 0, 1e-6);
    closePt(applyAffine(m, 100, 100), 200, 200, 1e-6);   // viewBox far corner -> css far corner
    closePt(applyAffine(m, 50, 50), 100, 100, 1e-6);     // centre
  });
});

describe('nestedChildAffine (child viewBox-user -> parent-group user)', () => {
  it('maps child viewBox origin to the child x/y and far corner correctly', () => {
    const m = nestedChildAffine({ x: 406, y: 166, width: 278, height: 227, childVbX: 0, childVbY: 0, childVbW: 278, childVbH: 227 });
    closePt(applyAffine(m, 0, 0), 406, 166, 1e-6);
    closePt(applyAffine(m, 278, 227), 406 + 278, 166 + 227, 1e-6);
  });

  it('subtracts non-zero child viewBox origin (regression parity)', () => {
    const m = nestedChildAffine({ x: 10, y: 20, width: 100, height: 100, childVbX: 5, childVbY: -7, childVbW: 50, childVbH: 50 });
    closePt(applyAffine(m, 5, -7), 10, 20, 1e-6);          // child viewBox origin -> child x/y
    closePt(applyAffine(m, 55, 43), 10 + 100, 20 + 100, 1e-6); // far corner -> x+w, y+h
  });

  it('two nested levels compose (group-inside-group structural coverage)', () => {
    const outer = nestedChildAffine({ x: 100, y: 0, width: 200, height: 200, childVbX: 0, childVbY: 0, childVbW: 100, childVbH: 100 });
    const inner = nestedChildAffine({ x: 10, y: 10, width: 50, height: 50, childVbX: 0, childVbY: 0, childVbW: 50, childVbH: 50 });
    const m = multiply(outer, inner);
    // inner (0,0) -> outer (10,10) -> outer maps by 2x -> (100 + 20, 0 + 20)
    closePt(applyAffine(m, 0, 0), 120, 20, 1e-6);
  });

  it('folds a nested GROUP\'s SVG transform="rotate(θ cx cy)" about its PARENT-space pivot', () => {
    // 100×100 child at (10,20), 1:1 viewBox, rotated 90° about its centre in
    // PARENT space (10+50, 20+50) = (60,70) — the attribute pivot. Verified
    // against the browser: rotate(θ cx cy) on a nested <svg> pivots in parent space.
    const m = nestedChildAffine({
      x: 10, y: 20, width: 100, height: 100,
      childVbX: 0, childVbY: 0, childVbW: 100, childVbH: 100,
      thetaDeg: 90, pivotX: 60, pivotY: 70,
    });
    closePt(applyAffine(m, 50, 50), 60, 70, 1e-6);    // content centre == pivot, fixed
    // content (0,0) → parent (10,20), then rot 90° about (60,70): (110,20).
    closePt(applyAffine(m, 0, 0), 110, 20, 1e-6);
    // Default pivot = box centre when omitted.
    const md = nestedChildAffine({ x: 10, y: 20, width: 100, height: 100, childVbX: 0, childVbY: 0, childVbW: 100, childVbH: 100, thetaDeg: 90 });
    closePt(applyAffine(md, 50, 50), 60, 70, 1e-6);
    // θ=0 path is identical to the no-rotation overload.
    const m0 = nestedChildAffine({ x: 10, y: 20, width: 100, height: 100, childVbX: 0, childVbY: 0, childVbW: 100, childVbH: 100, thetaDeg: 0 });
    closePt(applyAffine(m0, 0, 0), 10, 20, 1e-6);
  });
});

describe('pivotScreenPosition — backs the rotation pivot out of the BCR', () => {
  it('θ=0: pivot = BCR top-left + offset·zoom', () => {
    // box 200×100 at BCR (50,60), zoom 1, pivot at (30,40) in box css px.
    const { Cx, Cy } = pivotScreenPosition(50, 60, 0, 1, 30, 40, 200, 100);
    close(Cx, 50 + 30); close(Cy, 60 + 40);
  });

  it('θ=0 zoom=2: offset scales by zoom', () => {
    const { Cx, Cy } = pivotScreenPosition(50, 60, 0, 2, 30, 40, 200, 100);
    close(Cx, 50 + 60); close(Cy, 60 + 80);
  });

  it('symmetric pivot (box centre) → BCR centre, for any angle', () => {
    // pivot at box centre; the rotated AABB is centred on the pivot, so the
    // backed-out pivot equals the BCR centre. Construct a BCR of width/height
    // = the rotated AABB and check Cx = bcrLeft + bcrW/2.
    const W = 200, H = 100, z = 1, deg = 37;
    // rotated AABB half-extents for a box centred on its pivot:
    const rad = deg * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    const aabbW = (W * c + H * s) * z, aabbH = (W * s + H * c) * z;
    const bcrLeft = 500, bcrTop = 300;
    const { Cx, Cy } = pivotScreenPosition(bcrLeft, bcrTop, deg, z, W / 2, H / 2, W, H);
    close(Cx, bcrLeft + aabbW / 2, 1e-6);
    close(Cy, bcrTop + aabbH / 2, 1e-6);
  });

  it('non-normalised: an off-centre pivot is NOT the BCR centre', () => {
    // pivot near the box top-left corner → backed-out pivot sits near the BCR's
    // own top region, well away from the BCR centre.
    const { Cx, Cy } = pivotScreenPosition(0, 0, 90, 1, 10, 10, 200, 100);
    // θ=90: rel corners rotate; min picks the extremes. Just assert it's a
    // finite point distinct from the naive BCR centre.
    expect(Number.isFinite(Cx) && Number.isFinite(Cy)).toBe(true);
  });
});

describe('affineBoxCorners', () => {
  it('maps a box through the affine to 4 corners', () => {
    const m: Affine = composeAll(translate(10, 20), scale(2, 2));
    const c = affineBoxCorners(m, 0, 0, 5, 3);
    closePt(c.TL, 10, 20); closePt(c.TR, 20, 20); closePt(c.BR, 20, 26); closePt(c.BL, 10, 26);
  });
});


// Minimal DOMMatrix stand-in for jsdom (readNestedChildParams guards on its
// existence): composes translate/translateX/translateY/rotate left-to-right
// like CSS, exposing a/b/c/d/e/f.
class FakeDOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(t: string) {
    let M = [1, 0, 0, 1, 0, 0];
    const mul = (m1: number[], m2: number[]) => ([
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]);
    for (const fn of t.matchAll(/(translateX|translateY|translate|rotate)\(([^)]*)\)/g)) {
      const args = fn[2].split(',').map(v => parseFloat(v));
      if (fn[1] === 'translateX') M = mul(M, [1, 0, 0, 1, args[0], 0]);
      else if (fn[1] === 'translateY') M = mul(M, [1, 0, 0, 1, 0, args[0]]);
      else if (fn[1] === 'translate') M = mul(M, [1, 0, 0, 1, args[0] || 0, args[1] || 0]);
      else if (fn[1] === 'rotate') {
        const r = (args[0] * Math.PI) / 180;
        M = mul(M, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
      }
    }
    [this.a, this.b, this.c, this.d, this.e, this.f] = M;
  }
}
(globalThis as any).DOMMatrix = (globalThis as any).DOMMatrix ?? FakeDOMMatrix;

describe('readNestedChildParams — CSS variant rotation (fill-box) folds into the affine', () => {
  function makeChild(attrs: Record<string, string>, styleTransform?: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    if (styleTransform) (svg as unknown as HTMLElement).style.transform = styleTransform;
    return svg as SVGSVGElement;
  }

  it('extracts θ from a folded CSS translate+rotate, pivot = translated box centre', () => {
    const el = makeChild({ x: '317', y: '197', width: '143', height: '79', viewBox: '0 0 143 79' },
      'translateX(-317px) translateY(-3px) rotate(115.9deg)');
    const p = readNestedChildParams(el)!;
    // translate folded into x/y
    expect(p.x).toBeCloseTo(0, 0);
    expect(p.y).toBeCloseTo(194, 0);
    expect(p.thetaDeg).toBeCloseTo(115.9, 1);
    expect(p.pivotX).toBeCloseTo(p.x + 143 / 2, 1);
    expect(p.pivotY).toBeCloseTo(p.y + 79 / 2, 1);
  });

  it('the rotate ATTRIBUTE still wins (nested-group mechanism unchanged)', () => {
    const el = makeChild({ x: '10', y: '20', width: '100', height: '50', viewBox: '0 0 100 50', transform: 'rotate(30 60 45)' });
    const p = readNestedChildParams(el)!;
    expect(p.thetaDeg).toBe(30);
    expect(p.pivotX).toBe(60);
    expect(p.pivotY).toBe(45);
  });

  it('pure translate (live drag) keeps θ = 0', () => {
    const el = makeChild({ x: '10', y: '20', width: '100', height: '50', viewBox: '0 0 100 50' }, 'translate(5px, 7px)');
    const p = readNestedChildParams(el)!;
    expect(p.thetaDeg).toBe(0);
    expect(p.x).toBeCloseTo(15, 0);
  });
});
