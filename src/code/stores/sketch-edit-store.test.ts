// sketch-edit-store.test.ts — Regression tests for shared sketch helpers.
//
// `readSvgAttr` is the kebab-or-camel attribute reader that
// sketch-live-sync, autoFitSketchOnExit, and the orchestrator all
// depend on. It exists because Babel JSX round-trips occasionally
// flip hyphenated attribute names to camelCase (we observed
// `data-points` ↔ `dataPoints`), and any consumer that only checks
// one form silently misses the other and ends up with "old strokes
// detached from the brush controls".
//
// Tests below pin the canonical behaviour so future refactors don't
// regress that resilience.

import { describe, test, expect } from 'vitest';
import { readSvgAttr, pointsToAttr, pointsFromAttr } from './sketch-edit-store';

describe('readSvgAttr', () => {
  test('reads kebab key directly when present', () => {
    expect(readSvgAttr({ 'data-points': 'abc' }, 'data-points')).toBe('abc');
  });

  test('falls back to camelCase form when kebab is missing', () => {
    expect(readSvgAttr({ dataPoints: 'abc' }, 'data-points')).toBe('abc');
    expect(readSvgAttr({ strokeWidth: '50' }, 'stroke-width')).toBe('50');
  });

  test('prefers kebab form when both are present', () => {
    expect(readSvgAttr({ 'data-points': 'kebab', dataPoints: 'camel' }, 'data-points')).toBe('kebab');
  });

  test('returns undefined when neither form is present', () => {
    expect(readSvgAttr({ fill: 'red' }, 'data-points')).toBeUndefined();
  });

  test('returns undefined for missing attrs map', () => {
    expect(readSvgAttr(undefined, 'data-points')).toBeUndefined();
  });

  test('handles single-word attrs (no hyphen) without a fallback lookup', () => {
    expect(readSvgAttr({ fill: 'red' }, 'fill')).toBe('red');
  });

  test('handles multi-segment kebab attrs (data-foo-bar)', () => {
    expect(readSvgAttr({ dataFooBar: 'x' }, 'data-foo-bar')).toBe('x');
  });
});

describe('pointsToAttr / pointsFromAttr round-trip', () => {
  test('round-trips a simple point list', () => {
    const points = [[1.5, 2.3, 0.5], [4.7, 5.1, 0.7]];
    const serialized = pointsToAttr(points);
    expect(serialized).toBe('1.50,2.30,0.50 4.70,5.10,0.70');
    const parsed = pointsFromAttr(serialized);
    expect(parsed).toEqual([[1.5, 2.3, 0.5], [4.7, 5.1, 0.7]]);
  });

  test('rounds to two decimal places (compactness vs precision tradeoff)', () => {
    const points = [[1.234567, 2.987654, 0.5]];
    expect(pointsToAttr(points)).toBe('1.23,2.99,0.50');
  });

  test('defaults missing pressure to 0.5', () => {
    // pointsFromAttr handles missing pressure component
    expect(pointsFromAttr('1,2')).toEqual([[1, 2, 0.5]]);
  });

  test('returns empty array for null/undefined/empty input', () => {
    expect(pointsFromAttr(null)).toEqual([]);
    expect(pointsFromAttr(undefined)).toEqual([]);
    expect(pointsFromAttr('')).toEqual([]);
  });

  test('handles whitespace variations (tabs, newlines, multiple spaces)', () => {
    expect(pointsFromAttr('1,1,0.5\t2,2,0.5\n3,3,0.5  4,4,0.5')).toEqual([
      [1, 1, 0.5],
      [2, 2, 0.5],
      [3, 3, 0.5],
      [4, 4, 0.5],
    ]);
  });

  test('coerces NaN values to 0 / 0.5 (defensive against malformed source)', () => {
    expect(pointsFromAttr('not,a,number')).toEqual([[0, 0, 0.5]]);
  });
});
