import { describe, it, expect } from 'vitest';
import { toKebab, toCamel, parseStyleString, htmlToJSX, jsxStyleToHTML, splitStyleProps, parseVarRef, resolvePresetColor, resolveSpacingSides, healSpacingShorthand } from './css-utils';

describe('toKebab', () => {
  it('converts camelCase to kebab-case', () => {
    expect(toKebab('fontSize')).toBe('font-size');
    expect(toKebab('backgroundColor')).toBe('background-color');
    expect(toKebab('borderTopLeftRadius')).toBe('border-top-left-radius');
  });

  it('handles already kebab or lowercase', () => {
    expect(toKebab('color')).toBe('color');
    expect(toKebab('display')).toBe('display');
  });
});

describe('toCamel', () => {
  it('converts kebab-case to camelCase', () => {
    expect(toCamel('font-size')).toBe('fontSize');
    expect(toCamel('background-color')).toBe('backgroundColor');
    expect(toCamel('border-top-left-radius')).toBe('borderTopLeftRadius');
  });

  it('handles already camelCase or plain', () => {
    expect(toCamel('color')).toBe('color');
    expect(toCamel('display')).toBe('display');
  });
});

describe('parseStyleString', () => {
  it('parses CSS style string into Record', () => {
    const result = parseStyleString('width: 100px; color: red');
    expect(result).toEqual({ width: '100px', color: 'red' });
  });

  it('handles trailing semicolons and whitespace', () => {
    const result = parseStyleString('  font-size: 14px ;  color: #333 ;  ');
    expect(result).toEqual({ 'font-size': '14px', color: '#333' });
  });

  it('handles empty string', () => {
    expect(parseStyleString('')).toEqual({});
  });

  it('handles values with colons (like URLs)', () => {
    const result = parseStyleString('background: url(https://example.com)');
    expect(result).toEqual({ background: 'url(https://example.com)' });
  });
});

describe('htmlToJSX', () => {
  it('converts br tags to self-closing', () => {
    expect(htmlToJSX('hello<br>world')).toBe('hello<br />world');
    expect(htmlToJSX('hello<br/>world')).toBe('hello<br />world');
  });

  it('converts inline styles to JSX object notation', () => {
    const html = '<span style="font-size: 14px; color: red">text</span>';
    const result = htmlToJSX(html);
    expect(result).toContain("fontSize: '14px'");
    expect(result).toContain("color: 'red'");
    expect(result).toContain('style={{');
  });

  it('handles multiple spans', () => {
    const html = '<span style="color: red">a</span><span style="font-weight: bold">b</span>';
    const result = htmlToJSX(html);
    expect(result).toContain("color: 'red'");
    expect(result).toContain("fontWeight: 'bold'");
  });

  it('converts style when data-id comes before style attribute', () => {
    // Bug: regex only matched style when it was the first attribute
    const html = '<span data-id="hero-title-span" style="color: #7b2cbf">Organic</span>';
    const result = htmlToJSX(html);
    expect(result).toContain("color: '#7b2cbf'");
    expect(result).toContain('style={{');
    expect(result).not.toContain('style="');
  });

  it('preserves non-style attributes when converting style', () => {
    const html = '<span data-id="foo" style="font-size: 14px; color: red">text</span>';
    const result = htmlToJSX(html);
    expect(result).toContain('data-id="foo"');
    expect(result).toContain("fontSize: '14px'");
    expect(result).toContain('style={{');
  });
});

describe('jsxStyleToHTML', () => {
  it('converts simple JSX style to HTML', () => {
    const jsx = `<span style={{fontSize: '14px', color: 'red'}}>text</span>`;
    const result = jsxStyleToHTML(jsx);
    expect(result).toContain('style="font-size: 14px; color: red"');
  });

  it('preserves rgb() values with commas inside parentheses', () => {
    const jsx = `<span style={{WebkitTextStroke: '3px rgb(0, 0, 0)'}}>text</span>`;
    const result = jsxStyleToHTML(jsx);
    expect(result).toContain('-webkit-text-stroke: 3px rgb(0, 0, 0)');
  });

  it('preserves rgba() values', () => {
    const jsx = `<span style={{color: 'rgba(255, 0, 0, 0.5)'}}>text</span>`;
    const result = jsxStyleToHTML(jsx);
    expect(result).toContain('color: rgba(255, 0, 0, 0.5)');
  });

  it('handles multiple properties', () => {
    const jsx = `<span style={{fontSize: '20px', fontWeight: '700', color: '#111'}}>text</span>`;
    const result = jsxStyleToHTML(jsx);
    expect(result).toContain('font-size: 20px');
    expect(result).toContain('font-weight: 700');
    expect(result).toContain('color: #111');
  });

  it('handles vendor prefixes', () => {
    const jsx = `<span style={{WebkitTextStroke: '1px #ff0000'}}>text</span>`;
    const result = jsxStyleToHTML(jsx);
    expect(result).toContain('-webkit-text-stroke: 1px #ff0000');
  });

  it('passes through text without style attributes', () => {
    expect(jsxStyleToHTML('hello world')).toBe('hello world');
    expect(jsxStyleToHTML('<span>text</span>')).toBe('<span>text</span>');
  });
});

describe('htmlToJSX — quote-safe style values (text-wipe regression)', () => {
  // A font family with a quoted family name MUST NOT be wrapped in single quotes,
  // or the resulting JSX is invalid, parseJSX returns null silently, and the whole
  // text gets wiped on commit. See generator-crud updateNodeChildrenFromHTML.
  it('single-quoted font family → double-quoted JSX value (valid)', () => {
    const out = htmlToJSX(`<span style="font-family: 'Playfair Display', serif">x</span>`);
    expect(out).toContain(`fontFamily: "'Playfair Display', serif"`);
    // The output must be a syntactically valid attribute (no `''…'` nesting).
    expect(out).not.toContain(`''Playfair`);
  });

  it('plain font family → single-quoted (unchanged)', () => {
    const out = htmlToJSX(`<span style="font-family: Playfair Display, serif">x</span>`);
    expect(out).toContain(`fontFamily: 'Playfair Display, serif'`);
  });

  it('decodes &quot; entities in the value', () => {
    const out = htmlToJSX(`<span style="font-family: &quot;Playfair Display&quot;, serif">x</span>`);
    expect(out).toContain(`fontFamily: '"Playfair Display", serif'`);
  });
});

describe('jsxStyleToHTML — quoted values escape for the style attribute (canvas font)', () => {
  it('escapes double quotes so a quoted font family survives on the canvas', () => {
    const jsx = `<span style={{fontFamily: '"Playfair Display", serif'}}>x</span>`;
    const html = jsxStyleToHTML(jsx);
    expect(html).toContain('style="font-family: &quot;Playfair Display&quot;, serif"');
    expect(html).not.toMatch(/style="font-family: "Playfair/); // no early attribute close
  });

  it('round-trips JSX → HTML → JSX for a quoted font family', () => {
    const jsx = `<span style={{fontFamily: '"Playfair Display", serif'}}>x</span>`;
    expect(htmlToJSX(jsxStyleToHTML(jsx))).toContain(`fontFamily: '"Playfair Display", serif'`);
  });

  it('leaves unquoted values untouched', () => {
    const html = jsxStyleToHTML(`<span style={{fontFamily: 'Inter, sans-serif', color: 'red'}}>x</span>`);
    expect(html).toContain('font-family: Inter, sans-serif');
    expect(html).toContain('color: red');
  });
});

describe('splitStyleProps — custom separator', () => {
  it('defaults to comma splitting', () => {
    expect(splitStyleProps("a: '1px', b: 'rgb(0, 0, 0)'")).toEqual(["a: '1px'", "b: 'rgb(0, 0, 0)'"]);
  });

  it('splits on top-level spaces (border tokenize)', () => {
    expect(splitStyleProps('3px solid rgba(255, 0, 0, 0.5)', ' ')).toEqual(['3px', 'solid', 'rgba(255, 0, 0, 0.5)']);
  });

  it('splits on semicolons outside parentheses (declaration lists)', () => {
    expect(splitStyleProps('background: linear-gradient(red, blue); padding: 2px', ';'))
      .toEqual(['background: linear-gradient(red, blue)', 'padding: 2px']);
  });

  it('keeps empty mid-list segments (callers filter as needed)', () => {
    expect(splitStyleProps('a,,b')).toEqual(['a', '', 'b']);
  });
});

describe('parseVarRef', () => {
  it('extracts the token name from a var() reference', () => {
    expect(parseVarRef('var(--color-primary)')).toBe('color-primary');
  });

  it('extracts the first reference from a composite value', () => {
    expect(parseVarRef('1px solid var(--brand)')).toBe('brand');
  });

  it('returns null when there is no var() reference', () => {
    expect(parseVarRef('#ff0000')).toBeNull();
    expect(parseVarRef('')).toBeNull();
  });
});

describe('resolvePresetColor', () => {
  const tokens = [
    { name: 'brand', value: '#123456', category: 'color' },
    { name: 'color-accent', value: 'rgba(1, 2, 3, 0.5)', category: 'color' },
  ] as never[];

  it('resolves an exact var() reference to the token value', () => {
    expect(resolvePresetColor('var(--brand)', tokens)).toBe('#123456');
    expect(resolvePresetColor('var( --color-accent )', tokens)).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('returns the original string for unknown tokens', () => {
    expect(resolvePresetColor('var(--missing)', tokens)).toBe('var(--missing)');
  });

  it('returns non-var values unchanged (including composites)', () => {
    expect(resolvePresetColor('#fff', tokens)).toBe('#fff');
    expect(resolvePresetColor('1px solid var(--brand)', tokens)).toBe('1px solid var(--brand)');
    expect(resolvePresetColor('', tokens)).toBe('');
  });
});

describe('splitStyleProps — bracket awareness', () => {
  it('does not split inside a cubic-bezier array', () => {
    const parts = splitStyleProps("duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0");
    expect(parts).toEqual(['duration: 0.9', 'ease: [0.16, 1, 0.3, 1]', 'delay: 0']);
  });
  it('does not split inside grid line names', () => {
    const parts = splitStyleProps("gridTemplateColumns: '[full-start] 1fr [full-end]', gap: '8px'");
    expect(parts).toEqual(["gridTemplateColumns: '[full-start] 1fr [full-end]'", "gap: '8px'"]);
  });
});

// Order-aware spacing resolution + write-side heal — a legacy import mixes
// longhands with a TRAILING shorthand in one object; React resolves style
// objects in key order, so the shorthand wins and longhand-preferring
// readers lie (the CTA padding-undo report).
describe('resolveSpacingSides', () => {
  it('trailing shorthand out-ranks earlier longhands (React key order)', () => {
    const sides = resolveSpacingSides(
      { paddingBottom: '134px', paddingTop: '134px', padding: '34px' },
      'padding',
    );
    expect(sides).toEqual(['34px', '34px', '34px', '34px']);
  });

  it('longhands AFTER the shorthand override their side', () => {
    const sides = resolveSpacingSides(
      { padding: '34px', paddingTop: '134px' },
      'padding',
    );
    expect(sides).toEqual(['134px', '34px', '34px', '34px']);
  });

  it('pure longhands pass through; missing sides stay empty', () => {
    expect(resolveSpacingSides({ paddingTop: '10px' }, 'padding'))
      .toEqual(['10px', '', '', '']);
  });

  it('works for margin too', () => {
    expect(resolveSpacingSides({ margin: '8px 16px' }, 'margin'))
      .toEqual(['8px', '16px', '8px', '16px']);
  });
});

describe('healSpacingShorthand', () => {
  const mixed = { paddingBottom: '134px', paddingTop: '134px', padding: '34px' };

  it('folds the shorthand into unwritten sides and deletes it', () => {
    const extra = healSpacingShorthand(
      { paddingTop: '200px', paddingBottom: '200px' }, mixed, 'padding',
    );
    expect(extra).toEqual({ padding: '', paddingRight: '34px', paddingLeft: '34px' });
  });

  it('no-op when the source has no shorthand', () => {
    expect(healSpacingShorthand({ paddingTop: '10px' }, { paddingTop: '5px' }, 'padding')).toBeNull();
  });

  it('no-op when the write handles the shorthand itself', () => {
    expect(healSpacingShorthand({ padding: '', paddingTop: '10px' }, mixed, 'padding')).toBeNull();
  });

  it('no-op when the write touches no spacing longhand', () => {
    expect(healSpacingShorthand({ width: '100px' }, mixed, 'padding')).toBeNull();
  });
});

// ─── normalizeTransparent — the builder must satisfy its own oracle ─────────
//
// A page that had only ever been edited in the BUILDER still failed the
// builder's own submit gate with 14 × TRANSPARENT_COLOR (user report
// 2026-07-26): `canvas/commands.ts`'s wrap commands authored
// `backgroundColor: 'transparent'`, which the ColorPicker cannot represent (it
// shows as an empty, uneditable fill) and the oracle rejects. Two writers of one
// file format must not disagree about what is valid.
import { normalizeTransparent, TRANSPARENT_FILL } from './css-utils';

describe('normalizeTransparent', () => {
  it('swaps the banned keyword on any property', () => {
    expect(normalizeTransparent({ backgroundColor: 'transparent' })).toEqual({ backgroundColor: TRANSPARENT_FILL });
    expect(normalizeTransparent({ color: 'transparent', borderColor: 'transparent' }))
      .toEqual({ color: TRANSPARENT_FILL, borderColor: TRANSPARENT_FILL });
  });

  it('uses the spelling the oracle asks for', () => {
    expect(TRANSPARENT_FILL).toBe('rgba(0, 0, 0, 0)');
  });

  it('returns the SAME object when there is nothing to change (hot path)', () => {
    // Every style write in the editor funnels through this — an allocation per
    // drag frame would be pure waste.
    const styles = { left: '10px', top: '20px' };
    expect(normalizeTransparent(styles)).toBe(styles);
  });

  it('does not mutate the caller when it does change something', () => {
    const styles = { backgroundColor: 'transparent', left: '10px' };
    const out = normalizeTransparent(styles);
    expect(styles.backgroundColor).toBe('transparent');
    expect(out.backgroundColor).toBe(TRANSPARENT_FILL);
    expect(out.left).toBe('10px');
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeTransparent({ backgroundColor: '  transparent ' })).toEqual({ backgroundColor: TRANSPARENT_FILL });
  });

  it('leaves gradients and other values alone', () => {
    // `transparent` as a GRADIENT STOP is a different construct — the oracle
    // flags standalone colour values, and rewriting stops would change output.
    const styles = {
      backgroundImage: 'linear-gradient(transparent, #000)',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      color: '#fff',
    };
    expect(normalizeTransparent(styles)).toBe(styles);
  });

  it('leaves an already-normalised value untouched', () => {
    const styles = { backgroundColor: TRANSPARENT_FILL };
    expect(normalizeTransparent(styles)).toBe(styles);
  });
});

// ─── healInertOffsets — phantom pins from zero offsets ─────────────────────
//
// `left/top/right/bottom` only place an element when position is absolute/
// fixed/sticky. On a relative node a ZERO offset is dead CSS — but the Position
// tool's pin detector matches /^-?[\d.]+px$/, so '0px' shows as a PIN that isn't
// doing anything, and the first drag rewrites it. An AI/template-authored page
// carried 39 (user report 2026-07-26).
import { healInertOffsets } from './css-utils';

describe('healInertOffsets', () => {
  it('clears zero offsets on a relative node (the reported shape)', () => {
    expect(healInertOffsets({ top: '0px', left: '0px', position: 'relative', width: '32px' }))
      .toEqual({ top: '', left: '' });
  });

  it('treats a position-less node as static and heals it too', () => {
    expect(healInertOffsets({ left: '0px' })).toEqual({ left: '' });
  });

  it('leaves absolute / fixed / sticky nodes ALONE — there the offsets place it', () => {
    for (const position of ['absolute', 'fixed', 'sticky']) {
      expect(healInertOffsets({ top: '0px', left: '0px', position })).toBeNull();
    }
  });

  it('never deletes a NON-zero offset, even though it is equally inert', () => {
    // It encodes something a person typed; the oracle asks the author to decide
    // (make it absolute, or remove it) rather than silently discarding it.
    expect(healInertOffsets({ left: '24px', position: 'relative' })).toBeNull();
    // …and a mixed node only loses the zero one.
    expect(healInertOffsets({ left: '24px', top: '0px', position: 'relative' })).toEqual({ top: '' });
  });

  it('handles all four edges and the bare `0` spelling', () => {
    expect(healInertOffsets({ left: '0', top: '0px', right: '0', bottom: '0px', position: 'relative' }))
      .toEqual({ left: '', top: '', right: '', bottom: '' });
  });

  it('returns null when there is nothing to heal', () => {
    expect(healInertOffsets({ position: 'relative', width: '10px' })).toBeNull();
    expect(healInertOffsets({})).toBeNull();
    expect(healInertOffsets(undefined)).toBeNull();
  });
});

// ─── coerceCssNumberToPx — angle props (numeric rotate, 2026-07-31) ─────────
import { coerceCssNumberToPx } from './css-utils';

describe('coerceCssNumberToPx — angle props', () => {
  it('bare-number rotate becomes degrees (valid CSS on plain elements, still motion-compatible)', () => {
    expect(coerceCssNumberToPx('rotate', '180')).toBe('180deg');
    expect(coerceCssNumberToPx('rotate', '-180')).toBe('-180deg');
    expect(coerceCssNumberToPx('rotate', '22.5')).toBe('22.5deg');
  });
  it('united / non-numeric rotate values pass through', () => {
    expect(coerceCssNumberToPx('rotate', '90deg')).toBe('90deg');
    expect(coerceCssNumberToPx('rotate', 'none')).toBe('none');
  });
  it('px and unitless behavior unchanged', () => {
    expect(coerceCssNumberToPx('gap', '61')).toBe('61px');
    expect(coerceCssNumberToPx('opacity', '0.5')).toBe('0.5');
    expect(coerceCssNumberToPx('scale', '2')).toBe('2');
  });
});
