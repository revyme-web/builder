import { describe, test, expect } from 'vitest';
import { getResizeCursor, getRotateCursor } from './cursor-utils';

// ─── getResizeCursor ────────────────────────────────────────────────────────

describe('getResizeCursor', () => {
  test('unrotated top/bottom returns ns-resize', () => {
    expect(getResizeCursor('top', 0)).toBe('ns-resize');
    expect(getResizeCursor('bottom', 0)).toBe('ns-resize');
  });

  test('unrotated left/right returns ew-resize', () => {
    expect(getResizeCursor('left', 0)).toBe('ew-resize');
    expect(getResizeCursor('right', 0)).toBe('ew-resize');
  });

  test('unrotated topLeft/bottomRight returns nwse-resize', () => {
    expect(getResizeCursor('topLeft', 0)).toBe('nwse-resize');
    expect(getResizeCursor('bottomRight', 0)).toBe('nwse-resize');
  });

  test('unrotated topRight/bottomLeft returns nesw-resize', () => {
    expect(getResizeCursor('topRight', 0)).toBe('nesw-resize');
    expect(getResizeCursor('bottomLeft', 0)).toBe('nesw-resize');
  });

  test('small rotation < 5deg still returns standard cursor', () => {
    expect(getResizeCursor('top', 3)).toBe('ns-resize');
    expect(getResizeCursor('right', -4)).toBe('ew-resize');
  });

  test('rotation >= 5deg returns SVG data URI cursor', () => {
    const cursor = getResizeCursor('top', 45);
    expect(cursor).toContain('url("data:image/svg+xml,');
    expect(cursor).toContain('12 12, auto');
  });

  test('rotated cursor contains the rotation transform', () => {
    const cursor = getResizeCursor('right', 30);
    // totalRotation = 30 + 0 (RESIZE_BASE_ROTATION[right]=0) = 30
    expect(cursor).toContain('rotate(30 12 12)');   // rotate about the 24x24 centre
  });

  test('different directions produce different rotations', () => {
    const topCursor = getResizeCursor('top', 10);
    const rightCursor = getResizeCursor('right', 10);
    // top has base 90, right has base 0 — different SVGs
    expect(topCursor).not.toBe(rightCursor);
  });
});

// ─── getRotateCursor ────────────────────────────────────────────────────────

describe('getRotateCursor', () => {
  test('default corner (TR) at 0 rotation returns SVG cursor', () => {
    const cursor = getRotateCursor('TR', 0);
    expect(cursor).toContain('url("data:image/svg+xml,');
    expect(cursor).toContain('12 12, auto');
  });

  test('contains the correct total rotation', () => {
    // TR base = -45, element rotation = 30, total = -15
    const cursor = getRotateCursor('TR', 30);
    expect(cursor).toContain('rotate(-15');
  });

  test('TL corner', () => {
    // TL base = -135, element rotation = 0, total = -135
    const cursor = getRotateCursor('TL', 0);
    expect(cursor).toContain('rotate(-135');
  });

  test('BR corner', () => {
    // BR base = 45, element rotation = 0, total = 45
    const cursor = getRotateCursor('BR', 0);
    expect(cursor).toContain('rotate(45');
  });

  test('BL corner', () => {
    // BL base = 135, element rotation = 0, total = 135
    const cursor = getRotateCursor('BL', 0);
    expect(cursor).toContain('rotate(135');
  });

  test('unknown corner uses -45 as default base', () => {
    // Unknown corner, base = -45, rotation = 0, total = -45
    const cursor = getRotateCursor('XX', 0);
    expect(cursor).toContain('rotate(-45');
  });

  test('default parameters work', () => {
    const cursor = getRotateCursor();
    expect(cursor).toContain('url("data:image/svg+xml,');
  });
});
