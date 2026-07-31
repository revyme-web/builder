import { describe, it, expect } from 'vitest';
import {
  clampCropRect, fullCrop, resizeCrop, displayToNaturalCrop, isFullCrop,
} from './crop-utils';

const B = { width: 200, height: 100 };

describe('clampCropRect', () => {
  it('keeps a rect inside bounds', () => {
    expect(clampCropRect({ x: -10, y: -10, width: 50, height: 50 }, B)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
  it('pushes origin back so the far edge fits', () => {
    expect(clampCropRect({ x: 180, y: 90, width: 50, height: 50 }, B)).toEqual({ x: 150, y: 50, width: 50, height: 50 });
  });
  it('clamps oversize to bounds', () => {
    expect(clampCropRect({ x: 0, y: 0, width: 999, height: 999 }, B)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
  it('enforces a minimum size', () => {
    const r = clampCropRect({ x: 0, y: 0, width: 1, height: 1 }, B);
    expect(r.width).toBeGreaterThanOrEqual(8);
    expect(r.height).toBeGreaterThanOrEqual(8);
  });
});

describe('fullCrop', () => {
  it('is the whole image', () => {
    expect(fullCrop(B)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe('resizeCrop', () => {
  const start = { x: 50, y: 25, width: 100, height: 50 };

  it('move translates + clamps', () => {
    expect(resizeCrop(start, 'move', 20, 10, B)).toEqual({ x: 70, y: 35, width: 100, height: 50 });
    // moved past the right wall → clamped
    expect(resizeCrop(start, 'move', 999, 0, B)).toEqual({ x: 100, y: 25, width: 100, height: 50 });
  });

  it('east handle grows width, left pinned', () => {
    const r = resizeCrop(start, 'e', 30, 0, B);
    expect(r.x).toBe(50);
    expect(r.width).toBe(130);
  });

  it('west handle moves left edge, right pinned', () => {
    const r = resizeCrop(start, 'w', -20, 0, B);
    expect(r.x).toBe(30);
    expect(r.x + r.width).toBe(150); // right edge unchanged
  });

  it('south-east corner grows both, top-left pinned', () => {
    const r = resizeCrop(start, 'se', 20, 10, B);
    expect(r.x).toBe(50);
    expect(r.y).toBe(25);
    expect(r.width).toBe(120);
    expect(r.height).toBe(60);
  });

  it('north-west corner moves top-left, bottom-right pinned', () => {
    const r = resizeCrop(start, 'nw', 10, 5, B);
    expect(r.x).toBe(60);
    expect(r.y).toBe(30);
    expect(r.x + r.width).toBe(150);
    expect(r.y + r.height).toBe(75);
  });

  it('dragging an edge past the opposite edge stops (no flip)', () => {
    const r = resizeCrop(start, 'e', -999, 0, B);
    expect(r.width).toBeGreaterThanOrEqual(8);
    expect(r.x).toBe(50);
  });

  it('east edge cannot exceed the right wall', () => {
    const r = resizeCrop(start, 'e', 999, 0, B);
    expect(r.x + r.width).toBeLessThanOrEqual(200);
  });
});

describe('displayToNaturalCrop', () => {
  it('scales by the natural/display ratio', () => {
    // display 200×100, natural 800×400 → 4× scale.
    const r = displayToNaturalCrop({ x: 50, y: 25, width: 100, height: 50 }, B, { width: 800, height: 400 });
    expect(r).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });
  it('clamps inside natural bounds', () => {
    const r = displayToNaturalCrop({ x: 190, y: 95, width: 20, height: 20 }, B, { width: 200, height: 100 });
    expect(r.x + r.width).toBeLessThanOrEqual(200);
    expect(r.y + r.height).toBeLessThanOrEqual(100);
  });
  it('zero display → whole natural (defensive)', () => {
    expect(displayToNaturalCrop({ x: 0, y: 0, width: 0, height: 0 }, { width: 0, height: 0 }, { width: 300, height: 200 }))
      .toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});

describe('isFullCrop', () => {
  it('true for the whole image', () => {
    expect(isFullCrop(fullCrop(B), B)).toBe(true);
  });
  it('false for a partial crop', () => {
    expect(isFullCrop({ x: 10, y: 0, width: 100, height: 100 }, B)).toBe(false);
  });
});
