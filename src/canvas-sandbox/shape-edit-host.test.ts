/**
 * Tests for shape-edit-host's pure viewBox→screen affine solver.
 *
 * Regression context: double-clicking an SVG shape that lives INSIDE an SVG
 * group (a nested `<svg>` positioned by x/y/width/height ATTRIBUTES) rendered
 * the anchor-edit circles wildly offset from the painted shape. The wrapper
 * CTM builder had no nested-in-group path — its fallback read the nested
 * SVG's inline CSS `style.left/top/width/height`, which a group child does
 * not have, so the overlay landed at the canvas origin. `solveViewBoxAffine`
 * is the shared closed-form solver both the getBoxQuads path and the new
 * nested-in-group path feed corners into.
 */
import { describe, it, expect } from 'vitest';
import { solveViewBoxAffine, nestedSvgScreenRect, firstSvgShapeChild } from './shape-edit-host';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgWith(...childTags: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const tag of childTags) svg.appendChild(document.createElementNS(SVG_NS, tag));
  return svg as SVGSVGElement;
}

/** Apply an [a,b,c,d,e,f] affine tuple to a point — same as DOMMatrix would
 *  (jsdom has no DOMMatrix, and the production code feeds the tuple straight
 *  into `new DOMMatrix(coeffs)`). */
function apply(
  coeffs: [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = coeffs;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

describe('solveViewBoxAffine', () => {
  it('maps a viewBox to an axis-aligned screen rect (nested-in-group case)', () => {
    // A group child whose screen border box is at (200, 300), size 100×80,
    // with its own viewBox "0 0 50 40".
    const coeffs = solveViewBoxAffine(
      { x: 200, y: 300 },          // TL  ← (vbX, vbY)
      { x: 300, y: 300 },          // TR  ← (vbX + vbW, vbY)
      { x: 200, y: 380 },          // BL  ← (vbX, vbY + vbH)
      { x: 0, y: 0, width: 50, height: 40 },
    );
    expect(coeffs).not.toBeNull();
    // viewBox origin → screen TL
    expect(apply(coeffs!, 0, 0)).toMatchObject({ x: 200, y: 300 });
    // viewBox far corner → screen BR
    expect(apply(coeffs!, 50, 40)).toMatchObject({ x: 300, y: 380 });
    // viewBox center → screen center
    expect(apply(coeffs!, 25, 20)).toMatchObject({ x: 250, y: 340 });
  });

  it('honours a non-zero viewBox origin', () => {
    const coeffs = solveViewBoxAffine(
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 10, y: 110 },
      { x: -20, y: -30, width: 100, height: 100 },
    );
    expect(coeffs).not.toBeNull();
    expect(apply(coeffs!, -20, -30)).toMatchObject({ x: 10, y: 10 });
    expect(apply(coeffs!, 80, 70)).toMatchObject({ x: 110, y: 110 });
  });

  it('returns null for a degenerate (zero-area) basis', () => {
    expect(
      solveViewBoxAffine(
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0, width: 100, height: 100 },
      ),
    ).toBeNull();
  });

  it('returns null when the viewBox has no area', () => {
    expect(
      solveViewBoxAffine(
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
        { x: 0, y: 0, width: 0, height: 0 },
      ),
    ).toBeNull();
  });
});

describe('nestedSvgScreenRect', () => {
  it('subtracts the parent viewBox ORIGIN (non-zero / negative origin)', () => {
    // A group whose viewBox is "0 -74 893 626" — refit/normalize can leave
    // a non-zero origin. A child at x=538 y=120 must land at parent.top +
    // (120 - (-74)) = parent.top + 194, NOT parent.top + 120.
    const r = nestedSvgScreenRect(
      { left: 100, top: 200, width: 893, height: 626 },
      { x: 0, y: -74, width: 893, height: 626 },
      { x: 538, y: 120, width: 247, height: 220 },
    );
    expect(r).toEqual({ left: 638, top: 394, width: 247, height: 220 });
  });

  it('is unchanged for a zero-origin parent viewBox (regression)', () => {
    const r = nestedSvgScreenRect(
      { left: 0, top: 0, width: 1738, height: 979 },
      { x: 0, y: 0, width: 1738, height: 979 },
      { x: 956, y: 0, width: 782, height: 664 },
    );
    expect(r).toEqual({ left: 956, top: 0, width: 782, height: 664 });
  });

  it('scales child attrs by the parent viewBox→screen ratio', () => {
    // Parent screen box 400×300, viewBox 200×150 → 2× scale, origin (10,20).
    const r = nestedSvgScreenRect(
      { left: 0, top: 0, width: 400, height: 300 },
      { x: 10, y: 20, width: 200, height: 150 },
      { x: 30, y: 40, width: 50, height: 60 },
    );
    expect(r).toEqual({ left: 40, top: 40, width: 100, height: 120 });
  });
});

describe('firstSvgShapeChild', () => {
  it('returns the first geometry-shape child', () => {
    const svg = svgWith('path', 'polygon');
    expect(firstSvgShapeChild(svg)?.tagName.toLowerCase()).toBe('path');
  });

  it('skips non-geometry children (<defs>, <g>, nested <svg>)', () => {
    const svg = svgWith('defs', 'g', 'svg', 'polygon');
    expect(firstSvgShapeChild(svg)?.tagName.toLowerCase()).toBe('polygon');
  });

  it('returns null when there is no geometry child', () => {
    expect(firstSvgShapeChild(svgWith('defs', 'g'))).toBeNull();
    expect(firstSvgShapeChild(svgWith())).toBeNull();
  });
});
