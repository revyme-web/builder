// text-anim-parser.test.ts — Tests for parsing data-text-anim attributes from JSX code.

import { describe, it, expect } from 'vitest';
import { parseTextAnimCalls, getTextAnimForNode } from './text-anim-parser';

const CODE_WITH_ANIM = `
<motion.h1 data-id="hero" data-text-anim='{"animationType":"character","opacity":0,"y":20,"delay":0.05}' initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.3 }} variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}>
  <motion.span variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>H</motion.span>
  <motion.span variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>i</motion.span>
</motion.h1>
`;

const CODE_NO_ANIM = `
<h1 data-id="hero" style={{ fontSize: '48px' }}>Hello World</h1>
`;

const CODE_MULTIPLE = `
<div data-id="root">
  <motion.h1 data-id="title" data-text-anim='{"animationType":"word","opacity":0}' initial="hidden" whileInView="visible" viewport={{ once: true }} variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.1 } } }}>
    <motion.span>Hello</motion.span>
  </motion.h1>
  <motion.p data-id="desc" data-text-anim='{"animationType":"character","blur":5}' initial="hidden" whileInView="visible" viewport={{ once: true }} variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}>
    <motion.span>A</motion.span>
  </motion.p>
</div>
`;

describe('parseTextAnimCalls', () => {
  it('parses single text animation', () => {
    const calls = parseTextAnimCalls(CODE_WITH_ANIM);
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe('hero');
    expect(calls[0].config.animationType).toBe('character');
    expect(calls[0].config.opacity).toBe(0);
    expect(calls[0].config.y).toBe(20);
    expect(calls[0].config.delay).toBe(0.05);
  });

  it('returns empty for code without text animations', () => {
    const calls = parseTextAnimCalls(CODE_NO_ANIM);
    expect(calls).toHaveLength(0);
  });

  it('parses multiple text animations', () => {
    const calls = parseTextAnimCalls(CODE_MULTIPLE);
    expect(calls).toHaveLength(2);
    expect(calls[0].nodeId).toBe('title');
    expect(calls[0].config.animationType).toBe('word');
    expect(calls[1].nodeId).toBe('desc');
    expect(calls[1].config.animationType).toBe('character');
    expect(calls[1].config.blur).toBe(5);
  });

  it('handles malformed JSON gracefully', () => {
    const code = `<motion.h1 data-id="bad" data-text-anim='not json' initial="hidden">X</motion.h1>`;
    const calls = parseTextAnimCalls(code);
    expect(calls).toHaveLength(0);
  });
});

describe('getTextAnimForNode', () => {
  it('finds animation for specific node', () => {
    const calls = parseTextAnimCalls(CODE_MULTIPLE);
    const result = getTextAnimForNode(calls, 'desc');
    expect(result).not.toBeNull();
    expect(result!.config.animationType).toBe('character');
  });

  it('returns null for node without animation', () => {
    const calls = parseTextAnimCalls(CODE_WITH_ANIM);
    const result = getTextAnimForNode(calls, 'nonexistent');
    expect(result).toBeNull();
  });
});

// Canvas fold of an animated text node — line breaks must survive the
// span-collapse (the "multi-line animated text renders as ONE line on the
// canvas after reload" find, 2026-07-23). The fold strips motion.span
// wrappers but keeps <br> (Renderer sets text content via innerHTML).
import { parseJSXToNodes } from './parser';

describe('text-anim canvas fold preserves line breaks', () => {
  it('folds spans to plain text with <br> intact', () => {
    const code = `export default function Page(){
  return <div data-id="root">
    <motion.p data-id="t1" data-name="Text" data-text-anim='{"animationType":"word"}' style={{ fontSize: '46px' }}><motion.span style={{ display: "inline-block" }}>Science-backed</motion.span><br /><motion.span style={{ display: "inline-block" }}>AI</motion.span> <motion.span style={{ display: "inline-block" }}>Cosmetologist</motion.span><br /><motion.span style={{ display: "inline-block" }}>you</motion.span> <motion.span style={{ display: "inline-block" }}>can</motion.span> <motion.span style={{ display: "inline-block" }}>trust</motion.span></motion.p>
  </div>;
}`;
    const nodes = parseJSXToNodes(code);
    const t = nodes.get('t1');
    expect(t?.textContent).toBe('Science-backed<br>AI Cosmetologist<br>you can trust');
  });
});
