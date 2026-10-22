// preset-refs-gen.test.ts — detaching a preset before it is deleted. Deleting
// used to leave `var(--color-surface)` in every element that used it: the fill
// field showed the raw `var(--color…)` text and the element lost its colour
// (user report 2026-10-21). Now each reference becomes the token's own value.
import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import { replaceVarRefsInText, bakePresetRefsInSource, presetRefRewriteMode } from './preset-refs-gen';

const parses = (src: string) => {
  expect(() => parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
};

describe('replaceVarRefsInText', () => {
  test('replaces the whole var() — fallback with nested parens included', () => {
    expect(replaceVarRefsInText('var(--color-surface)', 'color-surface', '#ffffff')).toBe('#ffffff');
    expect(replaceVarRefsInText('0 1px 2px var( --color-surface, rgba(0, 0, 0, 0.5))', 'color-surface', '#fff'))
      .toBe('0 1px 2px #fff');
    expect(replaceVarRefsInText('linear-gradient(var(--color-surface), var(--color-brand))', 'color-surface', '#fff'))
      .toBe('linear-gradient(#fff, var(--color-brand))');
  });

  test('never touches a longer namesake', () => {
    expect(replaceVarRefsInText('var(--color-surface-dark)', 'color-surface', '#fff')).toBe('var(--color-surface-dark)');
  });

  test('an unbalanced reference is left as written', () => {
    expect(replaceVarRefsInText('var(--color-surface', 'color-surface', '#fff')).toBe('var(--color-surface');
  });
});

describe('bakePresetRefsInSource — TS/JSX', () => {
  const PAGE = `export default function Page() {
  return <div data-id="root" style={{ backgroundColor: 'var(--color-surface)', borderColor: "var(--color-surface-dark)" }}>
    <p data-id="t" style={{ fontFamily: 'var(--typo-heading-font)' }} title="var(--typo-heading-font)">Hi</p>
    <style>{\`[data-id="t"] { color: var(--color-surface); }\`}</style>
  </div>;
}
`;

  test('a colour reference becomes the raw value', () => {
    const out = bakePresetRefsInSource(PAGE, 'app/page.client.tsx', 'color-surface', '#ffffff');
    expect(out).toContain("backgroundColor: '#ffffff'");
    expect(out).toContain('borderColor: "var(--color-surface-dark)"');
    expect(out).toContain('[data-id="t"] { color: #ffffff; }');
    parses(out);
  });

  test('a value with quotes is re-quoted, so the file still parses', () => {
    const font = "'Inter', sans-serif";
    const out = bakePresetRefsInSource(PAGE, 'app/page.client.tsx', 'typo-heading-font', font);
    expect(out).toContain(`fontFamily: "'Inter', sans-serif"`);
    // JSX attribute strings have no escapes — the value goes in an expression container
    expect(out).toContain(`title="'Inter', sans-serif"`);
    parses(out);
  });

  test('a value carrying the attribute quote becomes an expression container', () => {
    const src = `const A = () => <p data-id="a" title="var(--x)" />;\n`;
    const out = bakePresetRefsInSource(src, 'components/A.tsx', 'x', 'say "hi"');
    expect(out).toContain('title={"say \\"hi\\""}');
    parses(out);
  });

  test('a value with both quotes is escaped', () => {
    const src = `const s = { a: 'var(--x)' };\n`;
    const out = bakePresetRefsInSource(src, 'app/a.ts', 'x', `"A" 'B'`);
    expect(out).toBe(`const s = { a: '"A" \\'B\\'' };\n`);
    parses(out);
  });

  test('an unparseable file falls back to text only for a quote-free value', () => {
    const broken = `const s = { a: 'var(--x)' ;`;
    expect(bakePresetRefsInSource(broken, 'app/a.tsx', 'x', '#fff')).toBe(`const s = { a: '#fff' ;`);
    expect(bakePresetRefsInSource(broken, 'app/a.tsx', 'x', "'Inter'")).toBe(broken);
  });
});

describe('bakePresetRefsInSource — CSS, data, skipped files', () => {
  test('CSS: another token referencing it gets the value', () => {
    const css = ':root {\n  --color-surface: #ffffff;\n  --color-card: var(--color-surface);\n}\n';
    expect(bakePresetRefsInSource(css, 'app/globals.css', 'color-surface', '#ffffff'))
      .toBe(':root {\n  --color-surface: #ffffff;\n  --color-card: #ffffff;\n}\n');
  });

  test('JSON: only var() references, value JSON-escaped', () => {
    const json = '{"tint":"var(--typo-heading-font)","body":"--typo-heading-font is nice"}';
    expect(bakePresetRefsInSource(json, 'cms/posts.json', 'typo-heading-font', '"Inter", sans-serif'))
      .toBe('{"tint":"\\"Inter\\", sans-serif","body":"--typo-heading-font is nice"}');
  });

  test('editor state and translated copy are never rewritten', () => {
    expect(presetRefRewriteMode('_meta/comments.json')).toBeNull();
    expect(presetRefRewriteMode('messages/fr.json')).toBeNull();
    const s = '[{"text":"var(--color-surface)"}]';
    expect(bakePresetRefsInSource(s, '_meta/comments.json', 'color-surface', '#fff')).toBe(s);
  });
});
