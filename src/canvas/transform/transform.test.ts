import { describe, it, expect } from 'vitest';
import { MIN_SCALE, MAX_SCALE, ZOOM_STEP, ZOOM_WHEEL_SENSITIVITY } from './constants';

// Test constants and zoom math (pure functions, no DOM needed)

describe('transform constants', () => {
  it('has reasonable zoom limits', () => {
    expect(MIN_SCALE).toBeGreaterThan(0);
    expect(MIN_SCALE).toBeLessThan(0.1);
    expect(MAX_SCALE).toBeGreaterThan(10);
  });

  it('has reasonable zoom step', () => {
    expect(ZOOM_STEP).toBeGreaterThan(0);
    expect(ZOOM_STEP).toBeLessThanOrEqual(0.2);
  });

  it('has zoom wheel sensitivity', () => {
    expect(ZOOM_WHEEL_SENSITIVITY).toBeGreaterThan(0);
    expect(ZOOM_WHEEL_SENSITIVITY).toBeLessThan(0.01);
  });
});

describe('zoom math (proportional intensity)', () => {
  // The zoom formula: scaleDelta = -deltaY * ZOOM_WHEEL_SENSITIVITY * currentScale
  // This makes zoom proportional to current level

  it('zooms slower at low zoom levels', () => {
    const deltaY = -100; // scroll up = zoom in
    const deltaAtScale01 = -deltaY * ZOOM_WHEEL_SENSITIVITY * 0.1;
    const deltaAtScale10 = -deltaY * ZOOM_WHEEL_SENSITIVITY * 1.0;
    expect(deltaAtScale01).toBeLessThan(deltaAtScale10);
    expect(deltaAtScale10 / deltaAtScale01).toBeCloseTo(10);
  });

  it('zooms faster at high zoom levels', () => {
    const deltaY = -100;
    const deltaAtScale10 = -deltaY * ZOOM_WHEEL_SENSITIVITY * 1.0;
    const deltaAtScale20 = -deltaY * ZOOM_WHEEL_SENSITIVITY * 2.0;
    expect(deltaAtScale20).toBeGreaterThan(deltaAtScale10);
  });
});

describe('anchor point math', () => {
  // When zooming at an anchor point, the canvas point under the anchor stays fixed
  function computeZoom(
    current: { x: number; y: number; scale: number },
    newScale: number,
    anchorX: number,
    anchorY: number,
  ) {
    const canvasX = (anchorX - current.x) / current.scale;
    const canvasY = (anchorY - current.y) / current.scale;
    return {
      x: anchorX - canvasX * newScale,
      y: anchorY - canvasY * newScale,
      scale: newScale,
    };
  }

  it('keeps anchor point fixed after zoom in', () => {
    const t = { x: 100, y: 100, scale: 1 };
    const anchor = { x: 500, y: 400 };

    // Canvas point under anchor before zoom
    const canvasBefore = { x: (anchor.x - t.x) / t.scale, y: (anchor.y - t.y) / t.scale };

    const zoomed = computeZoom(t, 2, anchor.x, anchor.y);

    // Canvas point under anchor after zoom
    const canvasAfter = { x: (anchor.x - zoomed.x) / zoomed.scale, y: (anchor.y - zoomed.y) / zoomed.scale };

    expect(Math.abs(canvasBefore.x - canvasAfter.x)).toBeLessThan(0.001);
    expect(Math.abs(canvasBefore.y - canvasAfter.y)).toBeLessThan(0.001);
  });

  it('keeps anchor point fixed after zoom out', () => {
    const t = { x: 200, y: 150, scale: 2 };
    const anchor = { x: 600, y: 300 };

    const canvasBefore = { x: (anchor.x - t.x) / t.scale, y: (anchor.y - t.y) / t.scale };
    const zoomed = computeZoom(t, 0.5, anchor.x, anchor.y);
    const canvasAfter = { x: (anchor.x - zoomed.x) / zoomed.scale, y: (anchor.y - zoomed.y) / zoomed.scale };

    expect(Math.abs(canvasBefore.x - canvasAfter.x)).toBeLessThan(0.001);
    expect(Math.abs(canvasBefore.y - canvasAfter.y)).toBeLessThan(0.001);
  });
});
