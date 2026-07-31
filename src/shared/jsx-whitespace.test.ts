import { describe, test, expect } from 'vitest';
import { cleanJsxText } from './jsx-whitespace';

describe('cleanJsxText — React/Babel JSX whitespace', () => {
  test('preserves a same-line trailing space (the Time - bug)', () => {
    expect(cleanJsxText('Time - ')).toBe('Time - ');
  });

  test('preserves a same-line leading space', () => {
    expect(cleanJsxText('  hi')).toBe('  hi');
    expect(cleanJsxText(' - x')).toBe(' - x');
  });

  test('strips newline-adjacent indentation (old pretty-printed source → same as .trim())', () => {
    expect(cleanJsxText('\n      Time - \n    ')).toBe('Time -');
    expect(cleanJsxText('\n      Hello\n    ')).toBe('Hello');
  });

  test('joins wrapped lines with a single space', () => {
    expect(cleanJsxText('\n   a\n   b\n')).toBe('a b');
  });

  test('whitespace-only newline-wrapped node collapses to empty (indentation between elements)', () => {
    expect(cleanJsxText('\n    ')).toBe('');
    expect(cleanJsxText('\n\n')).toBe('');
  });

  test('a single meaningful inline space is preserved', () => {
    expect(cleanJsxText(' ')).toBe(' ');
  });

  test('interior spaces are untouched', () => {
    expect(cleanJsxText('a   b')).toBe('a   b');
  });
});
