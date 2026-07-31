import { describe, test, expect } from 'vitest';
import { collectFontFamilies, resolveVarRefs, extractFamilyName } from './font-preload';

describe('resolveVarRefs', () => {
  const tokens = new Map([
    ['typo-mario-display-font', "'Anton', sans-serif"],
    ['font-alias', 'var(--typo-mario-display-font)'],
    ['loop-a', 'var(--loop-b)'],
    ['loop-b', 'var(--loop-a)'],
  ]);

  test('resolves a direct token ref', () => {
    expect(resolveVarRefs('var(--typo-mario-display-font)', tokens)).toBe("'Anton', sans-serif");
  });

  test('resolves chained refs', () => {
    expect(resolveVarRefs('var(--font-alias)', tokens)).toBe("'Anton', sans-serif");
  });

  test('uses the var() fallback when the token is unknown', () => {
    expect(resolveVarRefs("var(--missing, 'Syne')", tokens)).toBe("'Syne'");
  });

  test('depth-caps cyclic tokens instead of looping', () => {
    expect(() => resolveVarRefs('var(--loop-a)', tokens)).not.toThrow();
  });

  test('passes through values without var()', () => {
    expect(resolveVarRefs("'Inter', sans-serif", tokens)).toBe("'Inter', sans-serif");
  });
});

describe('extractFamilyName', () => {
  test('extracts the first quoted family', () => {
    expect(extractFamilyName("'Cormorant Garamond', serif")).toBe('Cormorant Garamond');
  });

  test('rejects numeric junk (e.g. a --font-size token value)', () => {
    expect(extractFamilyName('16px')).toBeNull();
  });

  test('rejects unresolved var() leftovers', () => {
    expect(extractFamilyName('var(--typo-x-font)')).toBeNull();
  });

  test('rejects generic hyphenated stacks', () => {
    expect(extractFamilyName('sans-serif')).toBeNull();
  });

  test('rejects CSS-wide keywords', () => {
    expect(extractFamilyName('inherit')).toBeNull();
  });
});

describe('collectFontFamilies', () => {
  test('finds preset font tokens in globals.css', () => {
    const families = collectFontFamilies({
      'app/globals.css': `:root {\n  --typo-mario-display-font: 'Anton', sans-serif;\n  --typo-mario-display-size: 56px;\n}`,
    });
    expect(families).toEqual(new Set(['Anton']));
  });

  test('ignores non-font tokens even when font-prefixed (--font-size-*)', () => {
    const families = collectFontFamilies({
      'app/globals.css': ':root { --font-size-base: 16px; --typo-body-weight: 400; }',
    });
    expect(families.size).toBe(0);
  });

  test('resolves var() refs in inline JSX fontFamily against the token map', () => {
    const families = collectFontFamilies({
      'app/globals.css': ":root { --typo-heading-font: 'Syne', sans-serif; }",
      'app/page.tsx': `<h1 data-id="t" style={{ fontFamily: 'var(--typo-heading-font)' }}>Hi</h1>`,
    });
    expect(families).toEqual(new Set(['Syne']));
  });

  test('finds plain inline JSX fontFamily values', () => {
    const families = collectFontFamilies({
      'app/page.tsx': `<p data-id="p" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>x</p>`,
    });
    expect(families).toEqual(new Set(['Space Grotesk']));
  });

  test('finds font-family declarations inside <style> CSS', () => {
    const families = collectFontFamilies({
      'app/page.tsx': `<style>{\`[data-id="hero"] { font-family: 'Playfair Display', serif !important; }\`}</style>`,
    });
    expect(families).toEqual(new Set(['Playfair Display']));
  });

  test('scans components and layout files too, dedupes across files', () => {
    const families = collectFontFamilies({
      'components/Hero.tsx': `style={{ fontFamily: 'Anton' }}`,
      'app/LayoutClient.tsx': `style={{ fontFamily: "Anton" }}`,
    });
    expect(families).toEqual(new Set(['Anton']));
  });

  test('skips non-scannable files', () => {
    const families = collectFontFamilies({
      'cms/posts.json': '{ "fontFamily": "NotAFont" }',
    });
    expect(families.size).toBe(0);
  });
});
