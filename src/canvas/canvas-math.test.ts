import { describe, it, expect } from 'vitest';
import {
  screenToCanvas, canvasToScreen, getCanvasDelta,
  isInsideRect, rectsOverlap, getBoundingRect,
} from './canvas-math';

describe('screenToCanvas', () => {
  it('converts screen coords to canvas space', () => {
    const result = screenToCanvas(500, 300, { x: 100, y: 50, scale: 2 }, { left: 0, top: 0 } as DOMRect);
    expect(result.x).toBe(200); // (500 - 0 - 100) / 2
    expect(result.y).toBe(125); // (300 - 0 - 50) / 2
  });

  it('handles zoom = 1', () => {
    const result = screenToCanvas(200, 150, { x: 0, y: 0, scale: 1 }, { left: 0, top: 0 } as DOMRect);
    expect(result.x).toBe(200);
    expect(result.y).toBe(150);
  });
});

describe('canvasToScreen', () => {
  it('converts canvas coords to screen space', () => {
    const result = canvasToScreen(200, 125, { x: 100, y: 50, scale: 2 }, { left: 0, top: 0 } as DOMRect);
    expect(result.x).toBe(500);
    expect(result.y).toBe(300);
  });

  it('is inverse of screenToCanvas', () => {
    const t = { x: 50, y: 30, scale: 1.5 };
    const rect = { left: 10, top: 20 } as DOMRect;
    const canvas = screenToCanvas(400, 300, t, rect);
    const screen = canvasToScreen(canvas.x, canvas.y, t, rect);
    expect(Math.abs(screen.x - 400)).toBeLessThan(0.001);
    expect(Math.abs(screen.y - 300)).toBeLessThan(0.001);
  });
});

describe('getCanvasDelta', () => {
  it('divides screen delta by scale', () => {
    expect(getCanvasDelta(100, 50, 2)).toEqual({ x: 50, y: 25 });
  });

  it('handles scale = 1', () => {
    expect(getCanvasDelta(30, 20, 1)).toEqual({ x: 30, y: 20 });
  });
});

describe('isInsideRect', () => {
  const rect = { left: 10, top: 10, width: 100, height: 50 };

  it('returns true for point inside', () => {
    expect(isInsideRect({ x: 50, y: 30 }, rect)).toBe(true);
  });

  it('returns true for point on edge', () => {
    expect(isInsideRect({ x: 10, y: 10 }, rect)).toBe(true);
  });

  it('returns false for point outside', () => {
    expect(isInsideRect({ x: 5, y: 30 }, rect)).toBe(false);
  });
});

describe('rectsOverlap', () => {
  it('returns true for overlapping rects', () => {
    expect(rectsOverlap(
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 50, top: 50, width: 100, height: 100 },
    )).toBe(true);
  });

  it('returns false for non-overlapping rects', () => {
    expect(rectsOverlap(
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 100, top: 100, width: 50, height: 50 },
    )).toBe(false);
  });
});

describe('getBoundingRect', () => {
  it('returns combined bounds', () => {
    const result = getBoundingRect([
      { left: 10, top: 20, width: 30, height: 40 },
      { left: 50, top: 10, width: 20, height: 60 },
    ]);
    expect(result.left).toBe(10);
    expect(result.top).toBe(10);
    expect(result.width).toBe(60); // 70 - 10
    expect(result.height).toBe(60); // 70 - 10
  });

  it('returns zero rect for empty array', () => {
    expect(getBoundingRect([])).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

