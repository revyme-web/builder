// svg-drop-shapes.test.ts — dropped SVGs decompose tight and per-shape.
//
// Regression pair (2026-08-12, insert-panel icon drops):
//   1. "Invisible margin": icon packs pad their glyphs (a burger paints
//      36×24 inside a 48×48 viewBox). The decompose kept the padded target
//      box, so every dropped icon carried empty space until the first
//      shape-edit commit shrink-wrapped it. The decompose now rebases to
//      the painted bbox and reports it via `box` for the wrapper styles.
//   2. Merged subpaths: packs fold whole glyphs into ONE <path> with N
//      `M…Z` subpaths — the shape editor works one geometry per wrapper,
//      so disjoint subpaths must become separate nested group children.
//      Holes/counters (donut) have overlapping bboxes and stay merged.

import { describe, it, expect } from 'vitest';
import { decomposeSvgDropToShapes } from './svg-drop-shapes';

describe('decomposeSvgDropToShapes', () => {
  it('splits a merged-subpath burger into 3 group children and shrink-wraps', () => {
    // Bars at y 6-8 / 11-13 / 16-18, x 3..21 (source units). Target 48×48 →
    // scale ×2 → painted box 36×24 at offset (6, 12).
    const dec = decomposeSvgDropToShapes(
      '<svg viewBox="0 0 24 24"><path fill="#ABABAB" d="M3 6L21 6L21 8L3 8ZM3 11L21 11L21 13L3 13ZM3 16L21 16L21 18L3 18Z"/></svg>',
      'svg-t1', 'Outline Menu', 48, 48,
    );
    expect(dec).not.toBeNull();
    expect(dec!.box).toEqual({ w: 36, h: 24 });
    expect(dec!.attrs.viewBox).toBe('0 0 36 24');
    expect(dec!.children.length).toBe(3);
    // Nested group children at their own bboxes, geometry rebased to the
    // tight wrapper: bars land at y 0 / 10 / 20, each 36×4.
    const ys = dec!.children.map(c => c.attrs!.y);
    expect(ys).toEqual(['0', '10', '20']);
    for (const c of dec!.children) {
      expect(c.tag).toBe('svg');
      expect(c.attrs!.width).toBe('36');
      expect(c.attrs!.height).toBe('4');
      expect(c.attrs!.viewBox).toBe('0 0 36 4');
      expect(c.children![0].tag).toBe('path');
    }
    expect(dec!.children.map(c => c.id)).toEqual(['svg-t1-s0', 'svg-t1-s1', 'svg-t1-s2']);
  });

  it('keeps a donut merged — overlapping subpath bboxes are a hole, not glyphs', () => {
    const dec = decomposeSvgDropToShapes(
      '<svg viewBox="0 0 24 24"><path fill="#000" fill-rule="evenodd" d="M2 2L22 2L22 22L2 22ZM8 8L16 8L16 16L8 16Z"/></svg>',
      'svg-t2', 'Donut', 48, 48,
    );
    expect(dec).not.toBeNull();
    expect(dec!.children.length).toBe(1);
    expect(dec!.children[0].id).toBe('svg-t2-g0'); // single-shape convention
    // Still shrink-wrapped: painted 20×20 source ×2 = 40×40.
    expect(dec!.box).toEqual({ w: 40, h: 40 });
  });

  it('shrink-wraps a padded single shape and rebases its geometry to 0,0', () => {
    const dec = decomposeSvgDropToShapes(
      '<svg viewBox="0 0 24 24"><path fill="#111" d="M6 12L18 12L18 18L6 18Z"/></svg>',
      'svg-t3', 'Box', 48, 48,
    );
    expect(dec).not.toBeNull();
    expect(dec!.box).toEqual({ w: 24, h: 12 });
    expect(dec!.attrs.viewBox).toBe('0 0 24 12');
    // Geometry starts at 0,0 — no offset baked in.
    expect(dec!.children[0].attrs!.d.startsWith('M 0 0')).toBe(true);
  });

  it('separate <path> elements still decompose into a group (pre-existing path)', () => {
    const dec = decomposeSvgDropToShapes(
      '<svg viewBox="0 0 24 24"><path fill="#111" d="M3 6L21 6L21 8L3 8Z"/><path fill="#111" d="M3 16L21 16L21 18L3 18Z"/></svg>',
      'svg-t4', 'Two Bars', 48, 48,
    );
    expect(dec).not.toBeNull();
    expect(dec!.children.length).toBe(2);
    expect(dec!.box).toEqual({ w: 36, h: 24 });
  });
});
