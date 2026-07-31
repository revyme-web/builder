// transform-utils.test.ts — coverage for translate-stripping logic.

import { describe, test, expect } from 'vitest';
import { stripTranslateFunctions, parseTranslateOffset } from './transform-utils';

describe('stripTranslateFunctions', () => {
  test('empty / none → empty', () => {
    expect(stripTranslateFunctions('')).toBe('');
    expect(stripTranslateFunctions('none')).toBe('');
  });

  test('removes plain translate()', () => {
    expect(stripTranslateFunctions('translate(-50%, -50%)')).toBe('');
    expect(stripTranslateFunctions('translate(10px)')).toBe('');
    expect(stripTranslateFunctions('translate(10px, 20px)')).toBe('');
  });

  test('removes translateX / translateY', () => {
    expect(stripTranslateFunctions('translateX(10px)')).toBe('');
    expect(stripTranslateFunctions('translateY(-50%)')).toBe('');
  });

  test('removes translate3d', () => {
    expect(stripTranslateFunctions('translate3d(10px, 20px, 0)')).toBe('');
  });

  test('preserves rotate / scale / skew', () => {
    expect(stripTranslateFunctions('rotate(45deg)')).toBe('rotate(45deg)');
    expect(stripTranslateFunctions('scale(1.5)')).toBe('scale(1.5)');
    expect(stripTranslateFunctions('skewX(10deg)')).toBe('skewX(10deg)');
  });

  test('strips translate, keeps rotate', () => {
    expect(stripTranslateFunctions('translate(-50%, -50%) rotate(45deg)')).toBe('rotate(45deg)');
    expect(stripTranslateFunctions('rotate(45deg) translate(10px, 20px)')).toBe('rotate(45deg)');
  });

  test('strips multiple translates, keeps multiple others', () => {
    expect(stripTranslateFunctions('translate(10px) rotate(45deg) translateX(20px) scale(2)'))
      .toBe('rotate(45deg) scale(2)');
  });

  test('preserves matrix / perspective', () => {
    expect(stripTranslateFunctions('matrix(1, 0, 0, 1, 10, 20)')).toBe('matrix(1, 0, 0, 1, 10, 20)');
    expect(stripTranslateFunctions('perspective(500px)')).toBe('perspective(500px)');
  });
});

describe('parseTranslateOffset', () => {
  test('empty / none → (0, 0)', () => {
    expect(parseTranslateOffset('', 100, 100)).toEqual({ x: 0, y: 0 });
    expect(parseTranslateOffset('none', 100, 100)).toEqual({ x: 0, y: 0 });
  });

  test('translate(-50%, -50%) on 400×200 → (-200, -100)', () => {
    expect(parseTranslateOffset('translate(-50%, -50%)', 400, 200)).toEqual({ x: -200, y: -100 });
  });

  test('translate(10px, 20px) → (10, 20) regardless of element size', () => {
    expect(parseTranslateOffset('translate(10px, 20px)', 1, 1)).toEqual({ x: 10, y: 20 });
    expect(parseTranslateOffset('translate(10px, 20px)', 9999, 9999)).toEqual({ x: 10, y: 20 });
  });

  test('translate(-50%, 20px) mixed → percent uses width, px stays as-is', () => {
    expect(parseTranslateOffset('translate(-50%, 20px)', 400, 200)).toEqual({ x: -200, y: 20 });
  });

  test('translate(10px) single arg → x only, y=0', () => {
    expect(parseTranslateOffset('translate(10px)', 100, 100)).toEqual({ x: 10, y: 0 });
  });

  test('translateX / translateY single axis', () => {
    expect(parseTranslateOffset('translateX(-50%)', 200, 100)).toEqual({ x: -100, y: 0 });
    expect(parseTranslateOffset('translateY(25%)', 200, 100)).toEqual({ x: 0, y: 25 });
  });

  test('translate3d(X, Y, Z) — only X+Y count', () => {
    expect(parseTranslateOffset('translate3d(10px, 20px, 5px)', 100, 100)).toEqual({ x: 10, y: 20 });
    expect(parseTranslateOffset('translate3d(-50%, -50%, 0)', 400, 200)).toEqual({ x: -200, y: -100 });
  });

  test('mixed with rotate / scale — only translate parts count', () => {
    expect(parseTranslateOffset('rotate(45deg) translate(-50%, -50%)', 400, 200))
      .toEqual({ x: -200, y: -100 });
    expect(parseTranslateOffset('scale(1.5) translateX(10px)', 100, 100))
      .toEqual({ x: 10, y: 0 });
  });

  test('multiple translates compound', () => {
    expect(parseTranslateOffset('translate(10px, 20px) translateX(5px) translateY(-10px)', 100, 100))
      .toEqual({ x: 15, y: 10 });
  });

  test('no translate at all → (0, 0)', () => {
    expect(parseTranslateOffset('rotate(45deg)', 100, 100)).toEqual({ x: 0, y: 0 });
    expect(parseTranslateOffset('scale(2)', 100, 100)).toEqual({ x: 0, y: 0 });
  });
});
