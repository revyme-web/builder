// src/code/parsing/element-scanner.test.ts
//
// Tests for the shared element scanner — covers the same edge cases as both
// the verify-effect and n1-scenarios scanners, plus parity assertions that
// prove the shared scanner produces identical output to both originals.

import { describe, it, expect } from 'vitest';
import { scanElements, elementRole, elementText, isFilled, descendantsOf } from './element-scanner';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const PAGE_FILLED = `
'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
      <div data-id="testimonials" data-name="Testimonials" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '24px', padding: '80px 40px' }}>
        <h2 data-id="testimonials-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', fontWeight: '700' }}>What people say</h2>
        <div data-id="testimonial-1" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '360px', padding: '24px' }}>
          <p data-id="testimonial-1-quote" data-name="Quote" style={{ position: 'relative', fontSize: '16px' }}>Revyme replaced three tools for us.</p>
          <p data-id="testimonial-1-author" data-name="Author" style={{ position: 'relative', fontSize: '14px', fontWeight: '600' }}>Alice Chen</p>
        </div>
        <div data-id="testimonial-2" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '2', width: '360px', padding: '24px' }}>
          <p data-id="testimonial-2-quote" data-name="Quote" style={{ position: 'relative', fontSize: '16px' }}>Shipping sites in hours, not weeks.</p>
          <p data-id="testimonial-2-author" data-name="Author" style={{ position: 'relative', fontSize: '14px', fontWeight: '600' }}>Marcus Reid</p>
        </div>
      </div>
    </div>
  );
}`;

const PAGE_WITH_COMMENT = `
<div data-id="root" data-name="Page">
  <!-- This is a comment -->
  <div data-id="hero" data-name="Hero">
    <p data-id="hero-title" data-name="Title">Hello</p>
  </div>
</div>`;

const PAGE_SELF_CLOSING = `
<div data-id="root" data-name="Page">
  <img data-id="logo" data-name="Logo" src="/logo.png" />
  <br data-id="break" data-name="Break" />
  <div data-id="content" data-name="Content">
    <p data-id="text" data-name="Text">Hi</p>
  </div>
</div>`;

const PAGE_QUOTED_BRACES = `
<div data-id="root" data-name="Page" style={{ padding: '24px', margin: '0 auto' }}>
  <div data-id="card" data-name="Card" data-loop='{"repeat": 3, "type": "items"}'>
    <p data-id="card-text" data-name="Text">Content</p>
  </div>
</div>`;

const PAGE_EXPRESSION_BRACES = `
<div data-id="root" data-name="Page">
  {open && <div data-id="modal" data-name="Modal"><p data-id="modal-text" data-name="Text">Open</p></div>}
  <div data-id="hero" data-name="Hero"><p data-id="hero-title" data-name="Title">Title</p></div>
</div>`;

/** Known limitation: data-id={variable} is an expression, not a string literal.
 *  The regex scanner cannot extract it — this is documented. */
const PAGE_DATA_ID_VARIABLE = `
<div data-id="root" data-name="Page">
  <div data-id={dynamicId} data-name="Dynamic"><p>Content</p></div>
  <div data-id="static" data-name="Static"><p data-id="static-text" data-name="Text">Hi</p></div>
</div>`;

const PAGE_MEMBER_EXPRESSION = `
<div data-id="root" data-name="Page">
  <motion.div data-id="animated" data-name="Animated" whileInView={{ opacity: 1 }}>
    <p data-id="animated-text" data-name="Text">Fade in</p>
  </motion.div>
</div>`;

const PAGE_EMPTY_LEAF = `
<div data-id="root" data-name="Page">
  <div data-id="section" data-name="Section">
    <p data-id="filled" data-name="Text">Has content</p>
    <p data-id="empty" data-name="Text"></p>
  </div>
</div>`;

const PAGE_DECORATION = `
<div data-id="root" data-name="Page">
  <div data-id="testimonials" data-name="Testimonials">
    <div data-id="testimonial-1" data-name="Card">
      <p data-id="testimonial-1-quote" data-name="Quote">Great tool.</p>
    </div>
    <div data-id="testimonials-spacer" data-name="Spacer"></div>
    <div data-id="decoration-1" data-name="Decoration">✦</div>
  </div>
</div>`;

// ─── Scanner behavior ──────────────────────────────────────────────────────

describe('scanElements', () => {
  it('finds sections, cards, and leaves with correct roles', () => {
    const els = scanElements(PAGE_FILLED);
    const roles = els.map(elementRole);
    expect(roles).toContain('testimonials testimonials');
    expect(roles).toContain('testimonial-1 card');
    expect(roles).toContain('testimonial-1-quote quote');
    expect(roles).toContain('testimonial-1-author author');
    expect(roles).toContain('testimonial-2 card');
  });

  it('skips HTML comments', () => {
    const els = scanElements(PAGE_WITH_COMMENT);
    const roles = els.map(elementRole);
    expect(roles).toContain('hero hero');
    expect(roles).toContain('hero-title title');
    // The comment is not an element
    expect(els.find((e) => e.tag === 'comment')).toBeUndefined();
  });

  it('handles self-closing tags', () => {
    const els = scanElements(PAGE_SELF_CLOSING);
    const roles = els.map(elementRole);
    expect(roles).toContain('logo logo');
    expect(roles).toContain('break break');
    expect(roles).toContain('content content');
    expect(roles).toContain('text text');
    // Self-closing tags have empty text
    const logo = els.find((e) => e.id === 'logo');
    expect(logo!.text).toBe('');
  });

  it('handles quoted braces in attributes (style objects, data-loop JSON)', () => {
    const els = scanElements(PAGE_QUOTED_BRACES);
    const roles = els.map(elementRole);
    expect(roles).toContain('root page');
    expect(roles).toContain('card card');
    expect(roles).toContain('card-text text');
    // The style object { padding: '24px' } does not confuse the scanner
    expect(els.length).toBe(3);
  });

  it('handles {expression} brace nesting in attributes', () => {
    const els = scanElements(PAGE_EXPRESSION_BRACES);
    const roles = els.map(elementRole);
    expect(roles).toContain('modal modal');
    expect(roles).toContain('modal-text text');
    expect(roles).toContain('hero hero');
    expect(roles).toContain('hero-title title');
  });

  it('documents data-id={variable} as a known limitation (not extracted)', () => {
    const els = scanElements(PAGE_DATA_ID_VARIABLE);
    // The dynamic data-id is NOT extracted (regex limitation)
    const dynamic = els.find((e) => e.id === 'dynamicId');
    expect(dynamic).toBeUndefined();
    // Static data-ids still work
    expect(els.find((e) => e.id === 'static')).toBeDefined();
    expect(els.find((e) => e.id === 'static-text')).toBeDefined();
  });

  it('handles member expressions like motion.div', () => {
    const els = scanElements(PAGE_MEMBER_EXPRESSION);
    const roles = els.map(elementRole);
    expect(roles).toContain('animated animated');
    expect(roles).toContain('animated-text text');
    const animated = els.find((e) => e.id === 'animated');
    expect(animated!.tag).toBe('motion.div');
  });

  it('distinguishes filled vs empty leaves', () => {
    const els = scanElements(PAGE_EMPTY_LEAF);
    const filled = els.find((e) => e.id === 'filled');
    const empty = els.find((e) => e.id === 'empty');
    expect(isFilled(filled!)).toBe(true);
    expect(isFilled(empty!)).toBe(false);
  });

  it('decorative elements are scanned (not excluded — caller decides)', () => {
    const els = scanElements(PAGE_DECORATION);
    expect(els.find((e) => e.id === 'testimonials-spacer')).toBeDefined();
    expect(els.find((e) => e.id === 'decoration-1')).toBeDefined();
    expect(isFilled(els.find((e) => e.id === 'decoration-1')!)).toBe(true);
    expect(isFilled(els.find((e) => e.id === 'testimonials-spacer')!)).toBe(false);
  });
});

// ─── elementText / isFilled ────────────────────────────────────────────────

describe('elementText / isFilled', () => {
  it('strips descendant tags and collapses whitespace', () => {
    const code = '<div data-id="a" data-name="A"><span> Hello </span> <b>World</b></div>';
    const els = scanElements(code);
    const el = els.find((e) => e.id === 'a');
    expect(elementText(el!)).toBe('Hello World');
    expect(isFilled(el!)).toBe(true);
  });

  it('empty text returns false for isFilled', () => {
    const code = '<div data-id="a" data-name="A"></div>';
    const els = scanElements(code);
    expect(isFilled(els[0])).toBe(false);
  });

  it('whitespace-only text returns false for isFilled', () => {
    const code = '<div data-id="a" data-name="A">   </div>';
    const els = scanElements(code);
    expect(isFilled(els[0])).toBe(false);
  });
});

// ─── elementRole ───────────────────────────────────────────────────────────

describe('elementRole', () => {
  it('lowercases and joins data-id and data-name', () => {
    const code = '<div data-id="Hero-Title" data-name="Title">Hi</div>';
    const els = scanElements(code);
    expect(elementRole(els[0])).toBe('hero-title title');
  });

  it('handles null id/name gracefully', () => {
    const code = '<div>Plain</div>';
    const els = scanElements(code);
    expect(elementRole(els[0])).toBe(' ');
  });
});

// ─── descendantsOf ─────────────────────────────────────────────────────────

describe('descendantsOf', () => {
  it('returns elements fully contained within the parent', () => {
    const els = scanElements(PAGE_FILLED);
    const section = els.find((e) => e.id === 'testimonials')!;
    const desc = descendantsOf(els, section);
    expect(desc.map((e) => e.id)).toContain('testimonial-1');
    expect(desc.map((e) => e.id)).toContain('testimonial-2');
    expect(desc.map((e) => e.id)).toContain('testimonial-1-quote');
    // The section itself is excluded
    expect(desc.find((e) => e.id === 'testimonials')).toBeUndefined();
  });

  it('returns empty for a leaf element', () => {
    const els = scanElements(PAGE_FILLED);
    const leaf = els.find((e) => e.id === 'testimonial-1-quote')!;
    const desc = descendantsOf(els, leaf);
    expect(desc).toEqual([]);
  });
});

// ─── Parity with original scanners ─────────────────────────────────────────
//
// These tests prove the shared scanner produces identical output to both
// the verify-effect.ts scanner and the n1-scenarios.ts scanner.

describe('parity with original scanners', () => {
  // Inline copies of the original scanElements (character-for-character identical)
  // to prove the shared scanner matches them exactly.

  function originalScanElements(code: string): Array<{ tag: string; id: string | null; name: string | null; text: string; start: number; end: number }> {
    const out: Array<{ tag: string; id: string | null; name: string | null; text: string; start: number; end: number }> = [];
    const stack: Array<{ tag: string; id: string | null; name: string | null; tagStart: number; textStart: number }> = [];
    const len = code.length;
    let i = 0;
    while (i < len) {
      const lt = code.indexOf('<', i);
      if (lt === -1) break;
      if (code.startsWith('<!--', lt)) {
        const close = code.indexOf('-->', lt + 4);
        if (close === -1) break;
        i = close + 3;
        continue;
      }
      const slice = code.slice(lt);
      const closeMatch = /<\/([a-zA-Z][\w.:-]*)\s*>/.exec(slice);
      if (closeMatch && closeMatch.index === 0) {
        const top = stack.pop();
        if (top && top.tag === closeMatch[1]) {
          out.push({
            tag: top.tag,
            id: top.id,
            name: top.name,
            text: code.slice(top.textStart, lt),
            start: top.tagStart,
            end: lt + closeMatch[0].length,
          });
        }
        i = lt + closeMatch[0].length;
        continue;
      }
      const openMatch = /<([a-zA-Z][\w.:-]*)\b/.exec(slice);
      if (openMatch && openMatch.index === 0) {
        let j = lt + openMatch[0].length;
        let quote: string | null = null;
        let brace = 0;
        while (j < len) {
          const ch = code[j];
          if (quote !== null) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
          } else if (ch === '{') {
            brace++;
          } else if (ch === '}') {
            brace--;
          } else if (ch === '>' && brace === 0) {
            break;
          }
          j++;
        }
        if (j >= len) break;
        const tagStr = code.slice(lt + 1, j);
        const id = /data-id="([^"]+)"/.exec(tagStr)?.[1] ?? null;
        const name = /data-name="([^"]+)"/.exec(tagStr)?.[1] ?? null;
        if (/\/\s*$/.test(tagStr)) {
          out.push({ tag: openMatch[1], id, name, text: '', start: lt, end: j + 1 });
        } else {
          stack.push({ tag: openMatch[1], id, name, tagStart: lt, textStart: j + 1 });
        }
        i = j + 1;
        continue;
      }
      i = lt + 1;
    }
    return out;
  }

  const fixtures = [
    { name: 'PAGE_FILLED', code: PAGE_FILLED },
    { name: 'PAGE_WITH_COMMENT', code: PAGE_WITH_COMMENT },
    { name: 'PAGE_SELF_CLOSING', code: PAGE_SELF_CLOSING },
    { name: 'PAGE_QUOTED_BRACES', code: PAGE_QUOTED_BRACES },
    { name: 'PAGE_EXPRESSION_BRACES', code: PAGE_EXPRESSION_BRACES },
    { name: 'PAGE_DATA_ID_VARIABLE', code: PAGE_DATA_ID_VARIABLE },
    { name: 'PAGE_MEMBER_EXPRESSION', code: PAGE_MEMBER_EXPRESSION },
    { name: 'PAGE_EMPTY_LEAF', code: PAGE_EMPTY_LEAF },
    { name: 'PAGE_DECORATION', code: PAGE_DECORATION },
  ];

  for (const fx of fixtures) {
    it(`shared scanner matches original on ${fx.name}`, () => {
      const shared = scanElements(fx.code);
      const original = originalScanElements(fx.code);
      expect(shared).toEqual(original);
    });
  }
});
