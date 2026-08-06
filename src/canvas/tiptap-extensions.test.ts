// tiptap-extensions.test.ts — glyph-paint channel OWNERSHIP between the
// gradient and fill-color textStyle marks.
//
// The fill channel (`-webkit-text-fill-color`) belongs to TextFillColorMark
// ALONE. GradientTextMark used to bake `-webkit-text-fill-color: transparent`
// into its rendered style string; the next edit session's TextFillColorMark
// parseHTML read that back as a `textFillColor: 'transparent'` attr — a zombie
// mark that survived gradient removal and out-painted every solid pick
// ("switched to solid and all text became transparent", 2026-08-07). A
// gradient run's glyph transparency is carried by the `color: 'transparent'`
// textStyle attr applied alongside the gradient (initial fill = currentColor).

import { describe, it, expect } from 'vitest';
import { GradientTextMark, TextFillColorMark } from './tiptap-extensions';

const gradientAttr = (GradientTextMark as any).config.addGlobalAttributes()[0]
  .attributes.backgroundGradient;
const fillAttr = (TextFillColorMark as any).config.addGlobalAttributes()[0]
  .attributes.textFillColor;

const GRADIENT = 'linear-gradient(rgb(44, 17, 17) 0%, rgb(255, 255, 255) 100%)';

/** Minimal element stub — parseHTML only reads `el.style.<prop>`. */
const elWithStyle = (style: Record<string, string>) => ({ style }) as any;

describe('GradientTextMark renderHTML — no fill-channel claim', () => {
  it('emits the gradient + clips but NEVER -webkit-text-fill-color', () => {
    const out = gradientAttr.renderHTML({ backgroundGradient: GRADIENT });
    expect(out.style).toContain(`background: ${GRADIENT}`);
    expect(out.style).toContain('-webkit-background-clip: text');
    expect(out.style).toContain('background-clip: text');
    expect(out.style).not.toContain('text-fill-color');
  });

  it('renders nothing without a gradient', () => {
    expect(gradientAttr.renderHTML({ backgroundGradient: null })).toEqual({});
  });

  it('parses a background-clip:text gradient span', () => {
    const el = elWithStyle({
      background: `${GRADIENT} text`, webkitBackgroundClip: 'text', backgroundClip: 'text',
    });
    expect(gradientAttr.parseHTML(el)).toBe(`${GRADIENT} text`);
  });

  it('does not parse a plain (non-clipped) background as a gradient mark', () => {
    const el = elWithStyle({ background: GRADIENT, backgroundClip: '' });
    expect(gradientAttr.parseHTML(el)).toBe(null);
  });
});

describe('TextFillColorMark parseHTML — transparent fills are the gradient dialect, not a value', () => {
  it('parses an opaque fill (a legit solid-in-gradient run)', () => {
    expect(fillAttr.parseHTML(elWithStyle({ webkitTextFillColor: 'rgb(233, 103, 103)' })))
      .toBe('rgb(233, 103, 103)');
  });

  it('parses `transparent` to null (legacy gradient spans self-heal on edit)', () => {
    expect(fillAttr.parseHTML(elWithStyle({ webkitTextFillColor: 'transparent' }))).toBe(null);
  });

  it('parses zero-alpha rgba/hsla to null', () => {
    expect(fillAttr.parseHTML(elWithStyle({ webkitTextFillColor: 'rgba(0, 0, 0, 0)' }))).toBe(null);
    expect(fillAttr.parseHTML(elWithStyle({ webkitTextFillColor: 'hsla(0, 0%, 0%, 0)' }))).toBe(null);
  });

  it('parses a missing fill to null', () => {
    expect(fillAttr.parseHTML(elWithStyle({}))).toBe(null);
  });

  it('renderHTML emits the fill only when set', () => {
    expect(fillAttr.renderHTML({ textFillColor: 'rgb(233, 103, 103)' }))
      .toEqual({ style: '-webkit-text-fill-color: rgb(233, 103, 103)' });
    expect(fillAttr.renderHTML({ textFillColor: null })).toEqual({});
  });
});
