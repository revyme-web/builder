// Custom TipTap extensions for inline text styling

import { Extension } from '@tiptap/react';
import '@tiptap/extension-text-style';

// Swap Enter/Shift+Enter: Enter creates <br> (hard break), Shift+Enter creates new <p> paragraph
export const EnterHardBreak = Extension.create({
  name: 'enterHardBreak',

  addKeyboardShortcuts() {
    return {
      // Enter → insert hard break (<br>)
      'Enter': ({ editor }) => {
        editor.commands.setHardBreak();
        return true;
      },
      // Shift+Enter → create new paragraph (<p>)
      'Shift-Enter': ({ editor }) => {
        editor.commands.splitBlock();
        return true;
      },
    };
  },
});

// FontSize extension — adds fontSize mark
export const FontSize = Extension.create({
  name: 'fontSize',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => el.style.fontSize || null,
          renderHTML: (attrs) => {
            if (!attrs.fontSize) return {};
            return { style: `font-size: ${attrs.fontSize}` };
          },
        },
      },
    }];
  },
});

// FontWeight extension
export const FontWeight = Extension.create({
  name: 'fontWeight',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontWeight: {
          default: null,
          parseHTML: (el) => el.style.fontWeight || null,
          renderHTML: (attrs) => {
            if (!attrs.fontWeight) return {};
            return { style: `font-weight: ${attrs.fontWeight}` };
          },
        },
      },
    }];
  },
});

// LetterSpacing extension
export const LetterSpacing = Extension.create({
  name: 'letterSpacing',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        letterSpacing: {
          default: null,
          parseHTML: (el) => el.style.letterSpacing || null,
          renderHTML: (attrs) => {
            if (!attrs.letterSpacing) return {};
            return { style: `letter-spacing: ${attrs.letterSpacing}` };
          },
        },
      },
    }];
  },
});

// LineHeight extension — paragraph-level attribute (applied to <p>, not <span>)
export const LineHeight = Extension.create({
  name: 'lineHeight',

  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.style.lineHeight || null,
          renderHTML: (attrs) => {
            if (!attrs.lineHeight) return {};
            return { style: `line-height: ${attrs.lineHeight}` };
          },
        },
      },
    }];
  },
});

// TextDecoration extension — paragraph-level attribute
export const TextDecoration = Extension.create({
  name: 'textDecorationExt',

  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        textDecoration: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textDecoration || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textDecoration) return {};
            return { style: `text-decoration: ${attrs.textDecoration}` };
          },
        },
      },
    }];
  },
});

// TextTransform extension — paragraph-level attribute
export const TextTransform = Extension.create({
  name: 'textTransformExt',

  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        textTransform: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textTransform || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textTransform) return {};
            return { style: `text-transform: ${attrs.textTransform}` };
          },
        },
      },
    }];
  },
});

// ─── Per-portion text decoration marks (textStyle) ──────────────────────────

export const TextDecorationMark = Extension.create({
  name: 'textDecorationMark',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        textDecorationLine: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textDecorationLine || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textDecorationLine) return {};
            return { style: `text-decoration-line: ${attrs.textDecorationLine}` };
          },
        },
        textDecorationColor: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textDecorationColor || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textDecorationColor) return {};
            return { style: `text-decoration-color: ${attrs.textDecorationColor}` };
          },
        },
        textDecorationStyle: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textDecorationStyle || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textDecorationStyle) return {};
            return { style: `text-decoration-style: ${attrs.textDecorationStyle}` };
          },
        },
        textDecorationThickness: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textDecorationThickness || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textDecorationThickness) return {};
            return { style: `text-decoration-thickness: ${attrs.textDecorationThickness}` };
          },
        },
        textUnderlineOffset: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textUnderlineOffset || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textUnderlineOffset) return {};
            return { style: `text-underline-offset: ${attrs.textUnderlineOffset}` };
          },
        },
      },
    }];
  },
});

// ─── Per-portion text stroke mark (textStyle) ───────────────────────────────

// ─── Per-portion gradient text mark (textStyle) ──────────────────────────────
// Enables mixed solid + gradient text within the same element.
// Stores gradient CSS in the textStyle <span> mark:
//   <span style="background: linear-gradient(...); -webkit-background-clip: text;
//                -webkit-text-fill-color: transparent; background-clip: text;">gradient text</span>

export const GradientTextMark = Extension.create({
  name: 'gradientTextMark',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        backgroundGradient: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            // Only treat as gradient mark if background-clip is 'text'
            const bg = el.style.background || el.style.backgroundImage || '';
            const clip = (el.style as any).webkitBackgroundClip || el.style.backgroundClip || '';
            if (bg.includes('gradient') && clip === 'text') return bg;
            return null;
          },
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.backgroundGradient) return {};
            // NO `-webkit-text-fill-color: transparent` here — the fill channel
            // is owned by TextFillColorMark alone. Baking it into this style
            // string round-tripped: the next edit session's TextFillColorMark
            // parseHTML read it back as a `textFillColor: 'transparent'` mark
            // that OUTLIVED the gradient — clear the gradient, pick any solid,
            // and the zombie transparent fill kept out-painting it ("switched
            // to solid and all text became transparent", 2026-08-07). Glyph
            // transparency for a gradient run is carried by the
            // `color: 'transparent'` attr applied alongside the gradient
            // (initial -webkit-text-fill-color = currentColor).
            return {
              style: `background: ${attrs.backgroundGradient}; -webkit-background-clip: text; background-clip: text`,
            };
          },
        },
      },
    }];
  },
});

// ─── Per-portion text-fill-color mark (textStyle) ────────────────────────────
// A SOLID run inside GRADIENT text. Node-level gradient text sets
// `-webkit-text-fill-color: transparent`, which INHERITS into every span —
// and fill-color (not `color`) is what paints glyphs, so a plain color mark
// applied to a selection inside gradient text was invisible ("select a
// portion of the gradient text and apply solid — it doesn't let me",
// 2026-08-06). This mark carries the fill-color on the span so the run
// out-paints the inherited transparent. Only ever set ALONGSIDE a color mark
// in a gradient context (TextColorControl) — plain solid text never gets it,
// so the whole-node flatten stays simple.
export const TextFillColorMark = Extension.create({
  name: 'textFillColorMark',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        textFillColor: {
          default: null,
          // A TRANSPARENT fill is never a user solid-run value — it's the
          // gradient dialect's artifact (node-level gradient text, or legacy
          // spans where GradientTextMark used to bake the declaration into its
          // rendered style). Parsing it as a real attr created a zombie mark
          // that survived gradient removal and out-painted every solid pick;
          // parse it to null so existing content self-heals on the next edit.
          parseHTML: (el: HTMLElement) => {
            const v = (el.style as any).webkitTextFillColor || '';
            if (!v) return null;
            const s = v.trim().toLowerCase();
            if (s === 'transparent' || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(s)) return null;
            return v;
          },
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.textFillColor) return {};
            return { style: `-webkit-text-fill-color: ${attrs.textFillColor}` };
          },
        },
      },
    }];
  },
});

// ─── Per-portion text stroke mark (textStyle) ───────────────────────────────

export const TextStrokeMark = Extension.create({
  name: 'textStrokeMark',

  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        webkitTextStroke: {
          default: null,
          parseHTML: (el: HTMLElement) => (el.style as any).webkitTextStroke || null,
          renderHTML: (attrs: Record<string, any>) => {
            if (!attrs.webkitTextStroke) return {};
            return { style: `-webkit-text-stroke: ${attrs.webkitTextStroke}` };
          },
        },
      },
    }];
  },
});
