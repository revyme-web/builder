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

// ─── Cmd+I on text whose italic lives on the ELEMENT ────────────────────────
//
// User report 2026-08-08, Figma import: a Fraunces heading landed with
// `font-style: italic` on the <p> itself. Cmd+I did nothing at all — StarterKit
// binds it to `toggleItalic`, which only knows the `italic` mark, so with no
// <em> to remove it added one, and wrapping already-slanted text in <em> is
// invisible. There is no tag for "not italic": carving an upright run out of an
// italic element needs an explicit `font-style: normal` span.

import { FontStyle, ItalicToggle, isItalicFontStyle, planItalicToggle } from './tiptap-extensions';

const fontStyleAttr = (FontStyle as any).config.addGlobalAttributes()[0]
  .attributes.fontStyle;

describe('FontStyle textStyle attribute', () => {
  it('renders and parses a font-style span', () => {
    expect(fontStyleAttr.renderHTML({ fontStyle: 'normal' })).toEqual({ style: 'font-style: normal' });
    expect(fontStyleAttr.renderHTML({ fontStyle: 'italic' })).toEqual({ style: 'font-style: italic' });
    expect(fontStyleAttr.parseHTML(elWithStyle({ fontStyle: 'italic' }))).toBe('italic');
  });

  it('renders nothing when unset, so clearing leaves no style attr behind', () => {
    expect(fontStyleAttr.renderHTML({ fontStyle: null })).toEqual({});
    expect(fontStyleAttr.parseHTML(elWithStyle({}))).toBeNull();
  });
});

describe('isItalicFontStyle', () => {
  it('treats italic and oblique as slanted, everything else upright', () => {
    expect(isItalicFontStyle('italic')).toBe(true);
    expect(isItalicFontStyle('oblique')).toBe(true);
    expect(isItalicFontStyle('oblique 14deg')).toBe(true);
    expect(isItalicFontStyle('normal')).toBe(false);
    expect(isItalicFontStyle('')).toBe(false);
    expect(isItalicFontStyle(undefined)).toBe(false);
  });
});

describe('planItalicToggle', () => {
  it('THE BUG: element italic, no marks → writes an explicit normal run', () => {
    const plan = planItalicToggle({ emActive: false, inheritedItalic: true });
    expect(plan.wasItalic).toBe(true);          // it was visibly italic…
    expect(plan.runFontStyle).toBe('normal');   // …so carve an upright run
    expect(plan.toggleEm).toBe(false);          // never <em> — that was the no-op
  });

  it('toggling that run back CLEARS the mark instead of writing italic', () => {
    // Round-trips to the original markup: no leftover `font-style: italic`
    // spans accreting inside an already-italic heading.
    const plan = planItalicToggle({ runFontStyle: 'normal', emActive: false, inheritedItalic: true });
    expect(plan.wasItalic).toBe(false);
    expect(plan.runFontStyle).toBeNull();
  });

  it('plain upright text still gets the semantic <em> (unchanged behaviour)', () => {
    const plan = planItalicToggle({ emActive: false, inheritedItalic: false });
    expect(plan.toggleEm).toBe(true);
    expect(plan.runFontStyle).toBeUndefined();
  });

  it('an <em> run un-italicizes by dropping the em, not by writing normal', () => {
    const plan = planItalicToggle({ emActive: true, inheritedItalic: false });
    expect(plan.unsetEm).toBe(true);
    expect(plan.runFontStyle).toBeNull();       // clear, don't fight the element
  });

  it('an <em> INSIDE an italic element needs both: drop em AND write normal', () => {
    // Dropping the em alone would leave the element's italic showing through,
    // so the keystroke would look like it did nothing — the original bug again.
    const plan = planItalicToggle({ emActive: true, inheritedItalic: true });
    expect(plan.unsetEm).toBe(true);
    expect(plan.runFontStyle).toBe('normal');
  });

  it('an explicit italic run over an upright element clears back to upright', () => {
    const plan = planItalicToggle({ runFontStyle: 'italic', emActive: false, inheritedItalic: false });
    expect(plan.wasItalic).toBe(true);
    expect(plan.runFontStyle).toBeNull();
  });

  it('the run mark outranks both <em> and the element', () => {
    // An explicit `normal` run inside an italic element with an em on it is
    // still upright — precedence is run → em → element, matching CSS.
    expect(planItalicToggle({ runFontStyle: 'normal', emActive: true, inheritedItalic: true }).wasItalic)
      .toBe(false);
  });

  it('every branch flips what the user sees', () => {
    for (const runFontStyle of [undefined, 'normal', 'italic']) {
      for (const emActive of [false, true]) {
        for (const inheritedItalic of [false, true]) {
          const plan = planItalicToggle({ runFontStyle, emActive, inheritedItalic });
          // Resolve the resulting effective italic the same way CSS would.
          const nextRun = plan.runFontStyle !== undefined ? plan.runFontStyle : runFontStyle;
          const nextEm = plan.toggleEm ? !emActive : plan.unsetEm ? false : emActive;
          const after = nextRun ? isItalicFontStyle(nextRun) : nextEm || inheritedItalic;
          expect(after, JSON.stringify({ runFontStyle, emActive, inheritedItalic, plan }))
            .toBe(!plan.wasItalic);
        }
      }
    }
  });
});

describe('ItalicToggle wiring', () => {
  it('outranks StarterKit so Mod-i reaches this handler', () => {
    expect((ItalicToggle as any).config.priority).toBeGreaterThan(100);
  });

  it('binds both Mod-i and Mod-I', () => {
    const keys = (ItalicToggle as any).config.addKeyboardShortcuts.call({ editor: null });
    expect(Object.keys(keys).sort()).toEqual(['Mod-I', 'Mod-i']);
  });
});
