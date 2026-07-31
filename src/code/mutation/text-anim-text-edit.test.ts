// text-anim-text-edit.test.ts — editing the TEXT of a node that carries a text
// animation (data-text-anim split spans).
//
// The reported bug (approach-title, "DESIGN. BUILD. DEPLOY."): a TipTap commit
// on a text-anim node routed through the GENERIC child writers between the
// remove-anim/re-add-anim bracket:
//   1. multi-paragraph commits (`<p>A</p><p>B</p>`) were written as real `<p>`
//      JSX children, and addTextAnimInCode's re-split — which treats its input
//      as literal characters — baked the tags in as text (`&lt;p&gt;` spans →
//      the live site rendered `<P>DESIGN.</P>` as visible text);
//   2. tag-free commits (single paragraph — the controller strips the wrapper)
//      fell into updateNodeTextInCode, which PRESERVES element children — the
//      stale `<p>`/`<br />` elements survived every edit and the re-split baked
//      the OLD text back in front of whatever the user typed.
// Fix: mutation-queue text-anim branches now fold the commit to plain
// multi-line text (htmlToPlainTextLines) and FULL-replace the children
// (replaceNodeTextContent); addTextAnimInCode folds whatever it finds to plain
// text (jsxInnerToPlainText) so paragraph children can never split literally.

import { describe, test, expect, beforeEach } from 'vitest';
import { initMutationQueue, queueMutation, flushNow } from './mutation-queue';
import { addTextAnimInCode, removeTextAnimFromCode, jsxInnerToPlainText, nodeHasTextAnim, readTextAnimConfig } from '../generation/text-anim-gen';
import { replaceNodeTextContent, htmlToPlainTextLines, removeNodeInCode } from '../generation/generator-crud';
import { parseJSX } from '../parsing/ast-utils';
import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';

const PAGE = `'use client';
import React, { useRef, useEffect } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px', height: 'auto' }}>
      <p data-id="title" style={{ position: 'relative', fontSize: '80px' }}>DESIGN.<br />BUILD.<br />DEPLOY.</p>
    </div>
  );
}`;

const SCROLL_CFG: TextAnimConfig = {
  animationType: 'character', delay: 0.05, opacity: 0, y: 163,
  transition: { type: 'spring', stiffness: 300, damping: 68 }, trigger: 'scroll',
} as TextAnimConfig;

const VIEW_CFG: TextAnimConfig = {
  animationType: 'character', delay: 0.05, opacity: 0, y: 40,
} as TextAnimConfig;

/** The node's collapsed plain text — what the letters actually spell. */
function spelledText(code: string): string {
  const collapsed = removeTextAnimFromCode(code, 'title');
  const m = collapsed.match(/<p data-id="title"[^>]*>([\s\S]*?)<\/p>/);
  return m ? jsxInnerToPlainText(m[1]) : '';
}

describe.each([
  ['scroll trigger (per-unit useTransform hooks)', SCROLL_CFG],
  ['view trigger (self-contained spans)', VIEW_CFG],
])('text edit on a text-anim node — %s', (_label, cfg) => {
  let flushed: string;
  const initial = addTextAnimInCode(PAGE, 'title', cfg);

  beforeEach(() => {
    flushed = '';
    initMutationQueue(initial, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('fixture sanity: split spans spell the original text, no escaped tags', () => {
    expect(initial).toContain('data-text-anim=');
    expect(spelledText(initial)).toBe('DESIGN.\nBUILD.\nDEPLOY.');
    expect(initial).not.toContain('&lt;');
  });

  test('multi-paragraph TipTap commit fully replaces the text (no literal <p>, no stale text)', () => {
    queueMutation({ type: 'updateChildrenHTML', nodeId: 'title', html: '<p>NEW LINE</p><p>TWO</p>' } as any);
    flushNow();

    expect(flushed).not.toBe('');
    expect(parseJSX(flushed)).not.toBeNull();
    expect(spelledText(flushed)).toBe('NEW LINE\nTWO');
    // The old bug's signatures: escaped tag chars in spans / old text surviving.
    expect(flushed).not.toContain('&lt;p&gt;');
    expect(flushed).not.toContain('DESIGN');
    // Paragraph boundary became a real line break in the split output.
    expect(flushed.match(/<br \/>/g)?.length).toBeGreaterThanOrEqual(1);
  });

  test('tag-free single-word commit overrides — old text must not reappear in front', () => {
    // The controller strips the <p> wrapper off single-paragraph commits, so
    // the html arrives tag-free — the shape that used to APPEND after the
    // collapsed children instead of replacing them.
    queueMutation({ type: 'updateChildrenHTML', nodeId: 'title', html: 'newword' } as any);
    flushNow();

    expect(spelledText(flushed)).toBe('newword');
    expect(flushed).not.toContain('DESIGN');
    expect(flushed).not.toContain('BUILD');
  });

  test('updateText (Content field / AI) with newlines fully replaces too', () => {
    queueMutation({ type: 'updateText', nodeId: 'title', text: 'ONE\nTWO' } as any);
    flushNow();

    expect(spelledText(flushed)).toBe('ONE\nTWO');
    expect(flushed).not.toContain('DEPLOY');
  });

  test('a damaged node (tags baked in as letters) heals on the next TipTap commit', () => {
    // Reconstruct the reported broken state: letters literally spelling
    // '<p>DESIGN.</p><p>BUILD.</p>newword' (entity-escaped spans).
    let damaged = removeTextAnimFromCode(initial, 'title');
    damaged = replaceNodeTextContent(damaged, 'title', '<p>DESIGN.</p><p>BUILD.</p>newword');
    damaged = addTextAnimInCode(damaged, 'title', cfg);
    expect(damaged).toContain('&lt;');   // the damage shape is representable

    initMutationQueue(damaged, (code) => { flushed = code; }, () => {}, () => {});
    // On re-edit the canvas innerHTML parsed those literal tags into REAL
    // paragraphs, so TipTap commits them back as paragraph HTML.
    queueMutation({ type: 'updateChildrenHTML', nodeId: 'title', html: '<p>DESIGN.</p><p>BUILD.</p><p>DEPLOY.</p>' } as any);
    flushNow();

    expect(spelledText(flushed)).toBe('DESIGN.\nBUILD.\nDEPLOY.');
    expect(flushed).not.toContain('&lt;');
    expect(flushed).not.toContain('newword');
  });
});

describe('scroll mode emits no body hooks', () => {
  // Scroll used to inject useRef + useEffect(querySelector) + useScroll + N×useTransform
  // into the page body, regenerated on every text edit. `<RevymeSplitText>` owns its own
  // ref, so none of that exists — a text edit is now just a text edit.
  test('a scroll-mode text edit rewrites the text and injects nothing', () => {
    const initial = addTextAnimInCode(PAGE, 'title', SCROLL_CFG);
    // the fixture's own import line mentions useTransform — assert on generated HOOKS
    expect(initial).not.toMatch(/const titleTe\d/);
    expect(initial).not.toContain('querySelector');

    let flushed = '';
    initMutationQueue(initial, (code) => { flushed = code; }, () => {}, () => {});
    queueMutation({ type: 'updateChildrenHTML', nodeId: 'title', html: '<p>HI</p><p>YO</p>' } as any);
    flushNow();

    expect(spelledText(flushed)).toBe('HI\nYO');
    expect(flushed).not.toMatch(/const titleTe\d/);
    expect(flushed).toContain('<RevymeSplitText');
  });
});

describe('deleting a PARENT strips descendant animation hooks', () => {
  // Live find 2026-07-12: deleting the approach SECTION left approach-title's
  // 40 Te useTransform hooks + TeRef/TeSP dangling — removeNodeInCode only
  // stripped hooks for the deleted id itself, not animated descendants.
  const SECTION = `'use client';
import React, { useRef, useEffect } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px', height: 'auto' }}>
      <div data-id="approach-section" style={{ position: 'relative', width: '100%', height: 'auto' }}>
        <p data-id="title" style={{ position: 'relative', fontSize: '80px' }}>DESIGN.<br />BUILD.</p>
      </div>
      <div data-id="other" style={{ position: 'relative', width: '100%', height: '10px' }}></div>
    </div>
  );
}`;

  test('On-Scroll text-anim child hooks are swept with the section', () => {
    // LEGACY form — hand-built, because the generator no longer emits body hooks. Pages
    // written before the runtime move still carry these, so the delete sweep must survive.
    const withAnim = SECTION.replace('</div>\n      <div data-id="other"', `</div>
      <div data-id="other"`).replace('export default function Page() {', `export default function Page() {
  const titleTeRef = useRef(null);
  useEffect(() => { titleTeRef.current = document.querySelector("[data-id='title']") || document.body; }, []);
  const { scrollYProgress: titleTeSP } = useScroll({ target: titleTeRef, offset: ["start 0.9", "start 0.35"] });
  const titleTe0Opacity = useTransform(titleTeSP, [0, 0.4], [0, 1]);`)
      .replace('<p data-id="title"', '<p data-id="title" data-text-anim=\'{"animationType":"character","trigger":"scroll"}\'');
    expect(withAnim).toMatch(/const titleTe0Opacity = useTransform\(/);   // fixture sanity
    const removed = removeNodeInCode(withAnim, 'approach-section');
    expect(parseJSX(removed)).not.toBeNull();
    expect(removed).not.toContain('data-id="approach-section"');
    expect(removed).not.toMatch(/titleTe/);          // no Te hooks, ref, or SP left
    expect(removed).toContain('data-id="other"');    // siblings untouched
  });

  test('deleting the node itself still sweeps (regression guard)', () => {
    const withAnim = addTextAnimInCode(SECTION, 'title', SCROLL_CFG);
    const removed = removeNodeInCode(withAnim, 'title');
    expect(removed).not.toMatch(/titleTe/);
    expect(parseJSX(removed)).not.toBeNull();
  });
});

describe('helper units', () => {
  test('htmlToPlainTextLines: paragraphs, brs, entities', () => {
    expect(htmlToPlainTextLines('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(htmlToPlainTextLines('a<br>b<br/>c')).toBe('a\nb\nc');
    expect(htmlToPlainTextLines('plain')).toBe('plain');
    expect(htmlToPlainTextLines('<p>&lt;x&gt; &amp; y</p>')).toBe('<x> & y');
  });

  test('jsxInnerToPlainText: paragraph children, brs, spans, entities, literal form', () => {
    expect(jsxInnerToPlainText('<p>A</p><p>B</p>')).toBe('A\nB');
    expect(jsxInnerToPlainText('A<br />B')).toBe('A\nB');
    expect(jsxInnerToPlainText('{"line1\\nline2"}')).toBe('line1\nline2');
    expect(jsxInnerToPlainText('<span style={{ color: "red" }}>styled</span> plain')).toBe('styled plain');
    // Entities decode AFTER tag strip — user-typed literal '<p>' stays text.
    expect(jsxInnerToPlainText('&lt;p&gt;hi')).toBe('<p>hi');
    // Source-formatting whitespace collapses; only real break markers make lines.
    expect(jsxInnerToPlainText('  A\n      B  ')).toBe('A B');
    expect(jsxInnerToPlainText('A{" "}B')).toBe('A B');
  });

  test('replaceNodeTextContent: wipes element children, emits <br /> lines, escapes unsafe chars', () => {
    const code = `export default function P() {
  return (<div data-id="root"><p data-id="t"><p>OLD</p>tail</p></div>);
}`;
    const out = replaceNodeTextContent(code, 't', 'one\ntwo {x} <y>');
    expect(out).not.toContain('OLD');
    expect(out).not.toContain('tail');
    expect(out).toContain('one');
    expect(out).toContain('<br />');
    expect(out).toContain('&#123;x&#125;');
    expect(out).toContain('&lt;y&gt;');
    expect(parseJSX(out)).not.toBeNull();
  });

  test('nodeHasTextAnim + readTextAnimConfig survive attr order and arrow-fn handlers', () => {
    const code = `export default function P() {
  return (<p onClick={() => go('x')} data-text-anim='{"animationType":"word"}' data-id="t">hi</p>);
}`;
    expect(nodeHasTextAnim(code, 't')).toBe(true);
    expect(readTextAnimConfig(code, 't')?.animationType).toBe('word');
    expect(nodeHasTextAnim(code.replace(/ data-text-anim='[^']*'/, ''), 't')).toBe(false);
  });
});
