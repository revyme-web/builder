import { describe, test, expect } from 'vitest';
import { parseHoverRules } from './hover-parser';

// ─── parseHoverRules ───────────────────────────────────────────────────

describe('parseHoverRules', () => {
  test('parses single :hover rule', () => {
    const css = `[data-id="btn-1"]:hover { background-color: #ff0 !important; }`;
    const result = parseHoverRules(css);
    expect(result.size).toBe(1);
    expect(result.get('btn-1')).toEqual({ backgroundColor: '#ff0' });
  });

  test('parses multiple :hover rules for different nodes', () => {
    const css = `
      [data-id="btn-1"]:hover { opacity: 0.8 !important; }
      [data-id="card-2"]:hover { transform: scale(1.05) !important; box-shadow: 0 4px 12px rgba(0,0,0,0.2) !important; }
    `;
    const result = parseHoverRules(css);
    expect(result.size).toBe(2);
    expect(result.get('btn-1')).toEqual({ opacity: '0.8' });
    expect(result.get('card-2')).toEqual({
      transform: 'scale(1.05)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    });
  });

  test('strips !important from values', () => {
    const css = `[data-id="x"]:hover { color: red !important; font-size: 16px !important; }`;
    const result = parseHoverRules(css);
    expect(result.get('x')).toEqual({ color: 'red', fontSize: '16px' });
  });

  test('returns empty map for no CSS', () => {
    expect(parseHoverRules('')).toEqual(new Map());
  });

  test('returns empty map for CSS with no :hover rules', () => {
    const css = `[data-id="btn-1"] { background: red !important; }`;
    const result = parseHoverRules(css);
    expect(result.size).toBe(0);
  });

  test('converts kebab-case to camelCase', () => {
    const css = `[data-id="el"]:hover { background-color: blue !important; border-top-left-radius: 8px !important; z-index: 10 !important; }`;
    const result = parseHoverRules(css);
    expect(result.get('el')).toEqual({
      backgroundColor: 'blue',
      borderTopLeftRadius: '8px',
      zIndex: '10',
    });
  });

  test('ignores non-data-id :hover rules', () => {
    const css = `
      .my-class:hover { color: red; }
      #my-id:hover { color: blue; }
      div:hover { color: green; }
      [data-id="valid"]:hover { opacity: 0.5 !important; }
    `;
    const result = parseHoverRules(css);
    expect(result.size).toBe(1);
    expect(result.get('valid')).toEqual({ opacity: '0.5' });
  });
});
