import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  stripInlineSpanProperty,
  stripInlineSpanStyleInCode,
  getInlineSpanPropertyState,
  TEXT_MARK_SPAN_PROPS,
} from './generator-crud';

const parsesOk = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

// The literal inner content a rich-text node stores as `node.textContent` — three
// per-portion colored runs, exactly the shape the user creates by selecting text
// in edit mode and coloring it.
const THREE_COLORED_SPANS =
  `<span style={{ color: 'rgb(48, 57, 94)' }}>Guidance that grow</span>` +
  `<span style={{ color: 'rgb(133, 143, 183)' }}>s with every chap</span>` +
  `<span style={{ color: 'rgb(48, 57, 94)' }}>ter.</span>`;

describe('stripInlineSpanProperty — flatten per-span text marks', () => {
  it('strips `color` from three colored spans and unwraps them (all text kept)', () => {
    const out = stripInlineSpanProperty(THREE_COLORED_SPANS, 'color');
    // No span / no inline color survives — the runs become bare text.
    expect(out).not.toContain('color');
    expect(out).not.toContain('<span');
    // All the original text is preserved, in order.
    expect(out.replace(/\s+/g, ' ')).toContain('Guidance that grow');
    expect(out).toContain('s with every chap');
    expect(out).toContain('ter.');
    // The fragment must round-trip as valid JSX inside a parent.
    parsesOk(`const X = <p>${out}</p>;`);
  });

  it('keeps a span (and its other formatting) when only ONE of several props is stripped', () => {
    const frag = `<span style={{ color: 'red', fontWeight: 700 }}>Bold red</span>`;
    const out = stripInlineSpanProperty(frag, 'color');
    expect(out).toContain('<span'); // span survives — style object not empty
    expect(out).toContain('fontWeight'); // unrelated formatting preserved
    expect(out).not.toContain('color'); // the one stripped prop is gone
    parsesOk(`const X = <p>${out}</p>;`);
  });

  it('strips fontFamily and leaves a plain bare text run', () => {
    const frag = `<span style={{ fontFamily: 'Georgia' }}>Serif</span> and <span style={{ fontFamily: 'Arial' }}>sans</span>`;
    const out = stripInlineSpanProperty(frag, 'fontFamily');
    expect(out).not.toContain('fontFamily');
    expect(out).not.toContain('<span');
    expect(out).toContain('Serif');
    expect(out).toContain('and');
    expect(out).toContain('sans');
  });

  it('handles motion.span the same as span', () => {
    const frag = `<motion.span style={{ color: 'rgb(1, 2, 3)' }}>Hi</motion.span>`;
    const out = stripInlineSpanProperty(frag, 'color');
    expect(out).not.toContain('color');
    expect(out).not.toContain('motion.span');
    expect(out).toContain('Hi');
  });

  it('strips a WebKit-prefixed mark (kebab-aware key match)', () => {
    const frag = `<span style={{ WebkitTextFillColor: 'red', fontWeight: 600 }}>X</span>`;
    const out = stripInlineSpanProperty(frag, 'WebkitTextFillColor');
    expect(out).not.toContain('WebkitTextFillColor');
    expect(out).toContain('fontWeight'); // other mark preserved
    expect(out).toContain('<span'); // not unwrapped (still has fontWeight)
  });

  it('does NOT touch a different property than the one requested', () => {
    const frag = `<span style={{ color: 'red' }}>X</span>`;
    const out = stripInlineSpanProperty(frag, 'fontWeight');
    // fontWeight isn't present → nothing removed → span (and color) survive.
    expect(out).toContain('color');
    expect(out).toContain('<span');
  });

  it('returns the fragment unchanged for empty / whitespace input', () => {
    expect(stripInlineSpanProperty('', 'color')).toBe('');
    expect(stripInlineSpanProperty('   ', 'color')).toBe('   ');
  });

  it('lists color and the common text marks as flattenable', () => {
    expect(TEXT_MARK_SPAN_PROPS.has('color')).toBe(true);
    expect(TEXT_MARK_SPAN_PROPS.has('fontWeight')).toBe(true);
    expect(TEXT_MARK_SPAN_PROPS.has('fontFamily')).toBe(true);
    // Paragraph props are NOT span-overridable → excluded.
    expect(TEXT_MARK_SPAN_PROPS.has('textAlign')).toBe(false);
    expect(TEXT_MARK_SPAN_PROPS.has('lineHeight')).toBe(false);
  });
});

describe('stripInlineSpanStyleInCode — in-code path on a node by data-id', () => {
  const PAGE = `import React from 'react';
export default function Page() {
  return <div data-id="root">
    <p data-id="story-headline" style={{ fontSize: '40px', color: '#d57272' }}>` +
    `<span style={{ color: 'rgb(48, 57, 94)' }}>Guidance that grow</span>` +
    `<span style={{ color: 'rgb(133, 143, 183)' }}>s with every chap</span>` +
    `<span style={{ color: 'rgb(48, 57, 94)' }}>ter.</span>` +
    `</p>
  </div>;
}`;

  it('removes every inner-span color so the node `<p>` color is no longer overridden', () => {
    const out = stripInlineSpanStyleInCode(PAGE, 'story-headline', 'color');
    // The `<p>`'s own color stays (its style object is untouched).
    expect(out).toContain("color: '#d57272'");
    // No inner span color remains, and the bare spans unwrapped to text.
    expect(out).not.toContain('rgb(48, 57, 94)');
    expect(out).not.toContain('rgb(133, 143, 183)');
    expect(out).not.toContain('<span');
    expect(out).toContain('Guidance that grow');
    expect(out).toContain('ter.');
    parsesOk(out);
  });

  it('leaves the code unchanged for a missing node id', () => {
    expect(stripInlineSpanStyleInCode(PAGE, 'nope', 'color')).toBe(PAGE);
  });

  it('does not touch a plain (non-rich) text node — no spans to strip', () => {
    const PLAIN = `import React from 'react';
export default function Page() {
  return <p data-id="t" style={{ color: 'blue' }}>Just text</p>;
}`;
    const out = stripInlineSpanStyleInCode(PLAIN, 't', 'color');
    expect(out).toContain('Just text');
    expect(out).toContain("color: 'blue'"); // node style preserved
    parsesOk(out);
  });
});

describe('getInlineSpanPropertyState — MIXED read on a rich-text node', () => {
  const A = 'rgb(48, 57, 94)';
  const B = 'rgb(133, 143, 183)';

  it('3 spans with 2 distinct colors + bare base text → isMixed with mixedValues', () => {
    const frag =
      `Lead ` +
      `<span style={{ color: '${A}' }}>one</span>` +
      `<span style={{ color: '${B}' }}>two</span>` +
      `<span style={{ color: '${A}' }}>three</span>`;
    const state = getInlineSpanPropertyState(frag, 'color', '#2F4020');
    expect(state.isMixed).toBe(true);
    expect(state.value).toBe('');
    // The base (painted on the leading bare "Lead ") and both span colors.
    expect(state.mixedValues).toEqual(['#2F4020', A, B]);
  });

  it('all spans the same color, no bare text → NOT mixed, value = that color', () => {
    const frag =
      `<span style={{ color: '${A}' }}>one</span>` +
      `<span style={{ color: '${A}' }}>two</span>`;
    const state = getInlineSpanPropertyState(frag, 'color', '#2F4020');
    expect(state.isMixed).toBe(false);
    expect(state.value).toBe(A); // NOT the never-painted base color
  });

  it('a single span covering all text → value = span color, NOT mixed', () => {
    const frag = `<span style={{ color: '${A}' }}>the whole headline</span>`;
    const state = getInlineSpanPropertyState(frag, 'color', '#2F4020');
    expect(state.isMixed).toBe(false);
    expect(state.value).toBe(A);
  });

  it('no spans (plain text) → baseValue, not mixed', () => {
    const state = getInlineSpanPropertyState('just plain text', 'color', '#2F4020');
    expect(state.isMixed).toBe(false);
    expect(state.value).toBe('#2F4020');
  });

  it('does NOT count the base color when every char is inside a prop-setting span', () => {
    // Two spans of the SAME color, fully covering the text → the base color is
    // never painted, so it must not create a phantom mix.
    const frag =
      `<span style={{ color: '${A}' }}>foo</span>` +
      `<span style={{ color: '${A}' }}>bar</span>`;
    const state = getInlineSpanPropertyState(frag, 'color', '#FF0000');
    expect(state.isMixed).toBe(false);
    expect(state.value).toBe(A);
  });

  it('a span LACKING the prop inherits the base → base + other span = mixed', () => {
    const frag =
      `<span style={{ fontWeight: 700 }}>bold uncolored</span>` +
      `<span style={{ color: '${A}' }}>colored</span>`;
    const state = getInlineSpanPropertyState(frag, 'color', '#2F4020');
    expect(state.isMixed).toBe(true);
    // The bold span paints the inherited base; the second span paints A.
    expect(state.mixedValues).toEqual(['#2F4020', A]);
  });

  it('reads fontWeight numeric span values', () => {
    const frag =
      `<span style={{ fontWeight: 400 }}>thin</span>` +
      `<span style={{ fontWeight: 700 }}>bold</span>`;
    const state = getInlineSpanPropertyState(frag, 'fontWeight', '500');
    expect(state.isMixed).toBe(true);
    expect(state.mixedValues).toEqual(['400', '700']);
  });

  it('empty fragment → baseValue, not mixed', () => {
    const state = getInlineSpanPropertyState('', 'color', '#123456');
    expect(state.isMixed).toBe(false);
    expect(state.value).toBe('#123456');
  });
});
