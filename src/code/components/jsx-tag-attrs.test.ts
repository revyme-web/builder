// jsx-tag-attrs.test.ts — every attribute spelling has one exact span, and a
// write never leaves a duplicate behind (agent set_component_prop appended a
// second copy whenever the first was an expression, 2026-10-15).

import { describe, expect, it } from 'vitest';
import { findTagAttrs, readTagAttr, scanTagAttrs, skipBalancedBraces, writeTagAttr } from './jsx-tag-attrs';
import { setInstanceProp, removeInstanceProp, setConditionalInstanceProp } from '@/editor/tools/ComponentPropsTool/instance-props';
import { setConditionalInstanceProp as setConditionalInstancePropCode, removeInstanceProp as removeInstancePropCode } from './instance-prop-overrides';
import { parseConditionalPropExpression, formatConditionalPropExpression } from './instance-conditional-prop';

describe('scanTagAttrs', () => {
  it('reads strings, expressions, bare booleans and spreads in source order', () => {
    const tag = `<Card data-id="c1" title='It "works"' items={[{ a: 1 }, { b: { c: 2 } }]}\n  featured {...rest} href={\`/x/\${item.slug}\`} />`;
    const attrs = scanTagAttrs(tag)!;
    expect(attrs.map((a) => a.name)).toEqual(['data-id', 'title', 'items', 'featured', 'href']);
    expect(attrs[1].value).toEqual({ kind: 'string', quote: "'", text: 'It "works"' });
    expect(attrs[2].value).toEqual({ kind: 'expr', source: '[{ a: 1 }, { b: { c: 2 } }]' });
    expect(attrs[3].value).toEqual({ kind: 'bare' });
    expect(attrs[4].value).toEqual({ kind: 'expr', source: '`/x/${item.slug}`' });
  });

  it('braces inside strings and template literals do not end the value', () => {
    const s = `{"a}b" + '}' + \`\${ {x: '}'}.x }\`}rest`;
    expect(s.slice(0, skipBalancedBraces(s, 0))).toBe(`{"a}b" + '}' + \`\${ {x: '}'}.x }\`}`);
  });

  it('`name` never answers for `data-name`', () => {
    const tag = '<Icon data-name="Logo" name="icon-1" />';
    expect(findTagAttrs(tag, 'name')).toHaveLength(1);
    expect(readTagAttr(tag, 'name')).toEqual({ kind: 'string', quote: '"', text: 'icon-1' });
  });

  it('an unbalanced value is unreadable (null), never guessed', () => {
    expect(scanTagAttrs('<A b={c >')).toBeNull();
  });

  it('writeTagAttr replaces in place, collapses duplicates, inserts after the tag name', () => {
    expect(writeTagAttr('<A x="1" y={2} x={3} />', 'x', 'x={4}')).toBe('<A x={4} y={2} />');
    expect(writeTagAttr('<A y={2} />', 'x', 'x="1"')).toBe('<A x="1" y={2} />');
    expect(writeTagAttr('<A x="1"\n  y={2} x={3} />', 'x', null)).toBe('<A\n  y={2} />');
    expect(writeTagAttr('<A featured y={2} />', 'featured', 'featured={false}')).toBe('<A featured={false} y={2} />');
  });

  it('readTagAttr reports the copy JSX applies (the last)', () => {
    expect(readTagAttr('<A x="1" x={2} />', 'x')).toEqual({ kind: 'expr', source: '2' });
  });
});

describe('instance prop writers never duplicate', () => {
  const page = (attrs: string) => `<div data-id="root">\n  <Hero data-id="h1" ${attrs} />\n</div>`;

  it('set over an expression value replaces it (the reported duplicate)', () => {
    const out = setInstanceProp(page('count={3} title="A"'), 'h1', 'Hero', 'count', '60', true);
    expect(out).toContain('<Hero data-id="h1" count={60} title="A" />');
    expect(out.match(/count=/g)).toHaveLength(1);
  });

  it('set over a nested-object expression replaces it whole', () => {
    const out = setInstanceProp(page('items={[{ a: { b: 1 } }]}'), 'h1', 'Hero', 'items', '[{ a: 2 }]', true);
    expect(out).toContain('items={[{ a: 2 }]}');
    expect(out).not.toContain('b: 1');
    expect(out.match(/items=/g)).toHaveLength(1);
  });

  it('set over a bare boolean replaces it', () => {
    const out = setInstanceProp(page('featured'), 'h1', 'Hero', 'featured', 'false', true);
    expect(out).toContain('featured={false}');
    expect(out.match(/featured/g)).toHaveLength(1);
  });

  it('set heals duplicates already in the source', () => {
    const out = setInstanceProp(page('layout="a" layout={b}'), 'h1', 'Hero', 'layout', 'c');
    expect(out.match(/layout=/g)).toHaveLength(1);
    expect(out).toContain('layout="c"');
  });

  it('remove takes an expression value and every duplicate', () => {
    for (const remove of [removeInstanceProp, removeInstancePropCode]) {
      const out = remove(page('items={[{ a: 1 }]} title="x" items="y"'), 'h1', 'Hero', 'items');
      expect(out).not.toContain('items');
      expect(out).toContain('title="x"');
    }
  });
});

describe('per-variant instance prop writer', () => {
  const master = (attrs: string) => `<div data-id="root">\n  <Badge data-id="b1" ${attrs} />\n</div>`;

  for (const [label, write] of [['panel', setConditionalInstanceProp], ['code layer', setConditionalInstancePropCode]] as const) {
    it(`${label}: a string with an apostrophe stays valid and round-trips`, () => {
      const out = write(master('label="Hi"'), 'b1', 'Badge', 'label', 'hover', "Let's go");
      const expr = /label=\{(.*)\} \/>/.exec(out)![1];
      expect(parseConditionalPropExpression(expr)).toEqual({ hover: "Let's go", default: 'Hi' });
    });

    it(`${label}: data-name never answers for name`, () => {
      const out = write(master('data-name="Logo" name="icon-1"'), 'b1', 'Badge', 'name', 'hover', 'icon-2');
      expect(out).toContain('data-name="Logo"');
      expect(out).toMatch(/ name=\{initialVariant === 'hover' \? 'icon-2' : 'icon-1'\}/);
    });
  }

  it('formatter escapes, parser reads back', () => {
    const expr = formatConditionalPropExpression({ v1: 'say "hi"', v2: "it's", default: 'a\\b' });
    expect(parseConditionalPropExpression(expr)).toEqual({ v1: 'say "hi"', v2: "it's", default: 'a\\b' });
  });
});
