// icon-viewbox.test.ts — icons must drop 1:1 (viewBox units == CSS pixels).
//
// `buildIconDragItem` drops at 48×48 but passed the source viewBox through
// (iconify ships `0 0 24 24`), so every inserted icon arrived at 2× and bounced
// SHAPE_WRAPPER_NOT_1TO1 — 30 on one live page, 20 of them the same 32-vs-24
// pair (user report 2026-07-26). Shapes are built 1:1 because every gesture
// (resize, shape edit, per-variant geometry) does its math in pixels against the
// wrapper's box.

import { describe, it, expect } from 'vitest';
import { normalizeIconGeometry } from './icon-viewbox';

describe('normalizeIconGeometry', () => {
  it('scales a path from the source viewBox to the drop size', () => {
    const out = normalizeIconGeometry('0 0 24 24', '<path d="M0 0 L12 12" />', 48)!;
    expect(out.viewBox).toBe('0 0 48 48');
    expect(out.inner).toContain('24');          // 12 → 24 at 2×
    expect(out.inner).not.toContain('L12 12');
  });

  it('scales primitive shape attributes', () => {
    const out = normalizeIconGeometry('0 0 10 10', '<rect x="1" y="2" width="4" height="6" />', 20)!;
    expect(out.inner).toBe('<rect x="2" y="4" width="8" height="12" />');
  });

  it('scales a polygon point list', () => {
    const out = normalizeIconGeometry('0 0 10 10', '<polygon points="0,0 5,10" />', 20)!;
    expect(out.inner).toBe('<polygon points="0,0 10,20" />');
  });

  it('scales circle radius + stroke width under a uniform scale', () => {
    const out = normalizeIconGeometry('0 0 12 12', '<circle cx="6" cy="6" r="3" stroke-width="1.5" />', 24)!;
    expect(out.inner).toContain('cx="12"');
    expect(out.inner).toContain('r="6"');
    expect(out.inner).toContain('stroke-width="3"');
  });

  it('leaves an already-1:1 icon alone', () => {
    expect(normalizeIconGeometry('0 0 48 48', '<path d="M0 0" />', 48)).toBeNull();
  });

  // The bail-outs — a distorted icon is far worse than one lingering violation.
  it('BAILS on markup whose coordinate space it cannot safely rescale', () => {
    for (const inner of [
      '<g transform="translate(2 2)"><path d="M0 0"/></g>',
      '<defs><linearGradient id="a"/></defs><path d="M0 0" fill="url(#a)"/>',
      '<mask id="m"><path d="M0 0"/></mask><path d="M1 1" mask="url(#m)"/>',
      '<use href="#x"/>',
    ]) {
      expect(normalizeIconGeometry('0 0 24 24', inner, 48)).toBeNull();
    }
  });

  it('BAILS on a non-uniform scale when a single radius is present', () => {
    // `r` has no axis, so it cannot follow sx ≠ sy without deforming the circle.
    expect(normalizeIconGeometry('0 0 10 20', '<circle r="3" />', 40)).toBeNull();
    // …but the same non-uniform scale is fine when nothing uses `r`.
    expect(normalizeIconGeometry('0 0 10 20', '<rect width="10" height="20" />', 40)).not.toBeNull();
  });

  it('BAILS on an offset viewBox origin (needs a translate first)', () => {
    expect(normalizeIconGeometry('2 2 24 24', '<path d="M0 0" />', 48)).toBeNull();
  });

  it('leaves percentage values alone (already relative)', () => {
    const out = normalizeIconGeometry('0 0 10 10', '<rect width="100%" height="5" />', 20)!;
    expect(out.inner).toContain('width="100%"');
    expect(out.inner).toContain('height="10"');
  });

  it('returns null on unusable input', () => {
    expect(normalizeIconGeometry(undefined, '<path/>', 48)).toBeNull();
    expect(normalizeIconGeometry('0 0 0 0', '<path/>', 48)).toBeNull();
    expect(normalizeIconGeometry('0 0 24 24', '', 48)).toBeNull();
    expect(normalizeIconGeometry('0 0 24 24', '<path/>', 0)).toBeNull();
  });
});
