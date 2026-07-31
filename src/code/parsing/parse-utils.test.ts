// parse-utils.test.ts — the shared string-walking primitives.
//
// These scan RAW SOURCE that mixes JS and JSX, so "is this quote a string
// delimiter?" is genuinely ambiguous: an apostrophe in JSX text ("we've") looks
// exactly like an opening `'`. Treating it as one swallowed the rest of the
// scan and `findMatchingParen` returned -1 — which surfaced as a CMS-bound
// heading refusing to re-bind on paste, because `getEnclosingMapParamsForNode`
// couldn't find the end of the `.map(` call (live find 2026-07-25).

import { describe, it, expect } from 'vitest';
import { findMatchingParen } from './parse-utils';

/** Index of the paren that closes the FIRST `(` in `code`. */
function close(code: string): number {
  return findMatchingParen(code, code.indexOf('('));
}

describe('findMatchingParen', () => {
  it('matches a simple call', () => {
    const code = 'fn(a, b)';
    expect(close(code)).toBe(code.length - 1);
  });

  it('matches across nesting', () => {
    const code = 'fn(g(x), h(y))';
    expect(close(code)).toBe(code.length - 1);
  });

  it('ignores parens inside a real string literal', () => {
    const code = `fn('a) b')`;
    expect(close(code)).toBe(code.length - 1);
  });

  it('ignores parens inside a template literal spanning lines', () => {
    const code = 'fn(`a)\nb)`)';
    expect(close(code)).toBe(code.length - 1);
  });

  it('ignores parens inside a line comment', () => {
    const code = 'fn(\n  // )\n  x\n)';
    expect(close(code)).toBe(code.length - 1);
  });

  it('handles an escaped quote inside a string', () => {
    const code = `fn('it\\'s )')`;
    expect(close(code)).toBe(code.length - 1);
  });

  it('handles an escaped BACKSLASH before the real closing quote', () => {
    const code = `fn("a\\\\")`;
    expect(close(code)).toBe(code.length - 1);
  });

  // The regression: JSX text is not a string literal.
  it('does not treat an apostrophe in JSX text as a string', () => {
    const code = [
      'blog.map((item, idx) => (',
      '  <h3>',
      "    The worse advice we've ever heard about web design",
      '  </h3>',
      '))',
    ].join('\n');
    expect(close(code)).toBe(code.length - 1);
  });

  it('still treats a same-line quoted string as a string', () => {
    const code = `map((item) => { const s = 'a)b'; return s; })`;
    expect(close(code)).toBe(code.length - 1);
  });

  it('returns -1 when nothing closes it', () => {
    expect(close('fn(a, b')).toBe(-1);
  });
});
