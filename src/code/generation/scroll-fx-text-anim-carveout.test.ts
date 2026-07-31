// scroll-fx-text-anim-carveout.test.ts — removing a node's SCROLL TRANSFORM
// must never strip the data-text-anim system's per-letter hooks (`<cn>TeSP`,
// `<cn>Te<N>Opacity/Y`, `<cn>TeRef`) that share the node's `<cn>` prefix.
// Live repro (2026-07-13): a title with BOTH effects — removeScrollFx swept
// every `approachTitle[A-Z]…` const, the letter spans kept referencing them,
// and the gate blocked with 96 undefined identifiers.
import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { setScrollFxInCode, clearNodeScrollFx } from './generator-motion-scroll-fx';

/** Node with a scroll TRANSFORM (opacity/skew via <cn>Ref) AND a character
 *  text-anim whose TeSP useScroll SHARES the same ref (the hand-edited form
 *  the live page carries). */
const SHARED_REF = `'use client';
import React, { useRef } from 'react';
import { motion, useScroll, useSpring, useTransform } from 'framer-motion';

export default function Page() {
  const approachTitleRef = useRef(null);
  const {
    scrollYProgress: approachTitleSP
  } = useScroll({
    target: approachTitleRef,
    offset: ["start 0.9", "end 0.1"]
  });
  const approachTitleSmooth = useSpring(approachTitleSP, { stiffness: 120, damping: 30 });
  const approachTitleOpacity = useTransform(approachTitleSmooth, [0, 1], [1, 0]);
  const approachTitleSkewX = useTransform(approachTitleSmooth, [0, 1], [0, 56]);
  const {
    scrollYProgress: approachTitleTeSP
  } = useScroll({
    target: approachTitleRef,
    offset: ["start 0.9", "start 0.35"]
  });
  const approachTitleTe0Opacity = useTransform(approachTitleTeSP, [0, 0.4], [0, 1]);
  const approachTitleTe0Y = useTransform(approachTitleTeSP, [0, 0.4], [163, 0]);
  const approachTitleTe1Opacity = useTransform(approachTitleTeSP, [0.013, 0.413], [0, 1]);
  const approachTitleTe1Y = useTransform(approachTitleTeSP, [0.013, 0.413], [163, 0]);
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <motion.p ref={approachTitleRef} data-id="approach-title" data-name="Title" style={{
      position: 'relative',
      margin: '0px',
      opacity: approachTitleOpacity,
      skewX: approachTitleSkewX,
      color: '#ffffff'
    }} data-text-anim='{"animationType":"character","trigger":"scroll"}'><span style={{ whiteSpace: "nowrap" }}><motion.span style={{ display: "inline-block", opacity: approachTitleTe0Opacity, y: approachTitleTe0Y }}>H</motion.span><motion.span style={{ display: "inline-block", opacity: approachTitleTe1Opacity, y: approachTitleTe1Y }}>i</motion.span></span></motion.p>
  </div>;
}`;

/** Generated form: text-anim owns its own querySelector'd <cn>TeRef. */
const OWN_TE_REF = SHARED_REF
  .replace(`const {
    scrollYProgress: approachTitleTeSP
  } = useScroll({
    target: approachTitleRef,
    offset: ["start 0.9", "start 0.35"]
  });`,
  `const approachTitleTeRef = useRef(null);
  useEffect(() => { approachTitleTeRef.current = document.querySelector("[data-id='approach-title']") || document.body; }, []);
  const {
    scrollYProgress: approachTitleTeSP
  } = useScroll({
    target: approachTitleTeRef,
    offset: ["start 0.9", "start 0.35"]
  });`)
  .replace("import React, { useRef } from 'react';", "import React, { useRef, useEffect } from 'react';");

function undefinedIdents(code: string): string[] {
  const declared = new Set([...code.matchAll(/(?:const|let|var|function)\s+\{?\s*(?:scrollYProgress:\s*)?(\w+)/g)].map(m => m[1]));
  const out = new Set<string>();
  for (const m of code.matchAll(/approachTitle\w+/g)) {
    if (!declared.has(m[0]) && !code.includes(`const ${m[0]}`) && !code.includes(`: ${m[0]}\n`) && !new RegExp(`scrollYProgress:\\s*${m[0]}`).test(code)) out.add(m[0]);
  }
  return [...out];
}

describe('scroll-fx removal with a character text-anim on the same node', () => {
  test('shared-ref form: Te hooks AND the shared ref survive; transform hooks go', () => {
    const out = setScrollFxInCode(SHARED_REF, 'approach-title', null);
    // text-anim machinery intact
    expect(out).toContain('approachTitleTeSP');
    expect(out).toContain('approachTitleTe0Opacity');
    expect(out).toContain('approachTitleTe1Y');
    expect(out).toContain('const approachTitleRef = useRef(null);');
    expect(out).toContain('ref={approachTitleRef}');
    expect(out).toContain('data-text-anim');
    // scroll transform machinery gone
    expect(out).not.toContain('approachTitleSmooth');
    expect(out).not.toContain('approachTitleOpacity,');
    expect(out).not.toContain('approachTitleSkewX');
    expect(out).not.toMatch(/opacity:\s*approachTitleOpacity/);
    // nothing dangles
    expect(undefinedIdents(out)).toEqual([]);
  });

  test('own-TeRef form: text-anim untouched, scroll-fx ref fully removed', () => {
    const out = setScrollFxInCode(OWN_TE_REF, 'approach-title', null);
    expect(out).toContain('approachTitleTeRef');
    expect(out).toContain('approachTitleTeSP');
    expect(out).toContain('approachTitleTe1Opacity');
    // the transform's own ref is no longer needed by anyone → removed
    expect(out).not.toContain('const approachTitleRef = useRef(null);');
    expect(out).not.toContain('ref={approachTitleRef}');
    expect(out).not.toContain('approachTitleSmooth');
    expect(undefinedIdents(out)).toEqual([]);
  });

  test('legacy clearNodeScrollFx path: same carve-out', () => {
    const out = clearNodeScrollFx(SHARED_REF, 'approach-title');
    expect(out).toContain('approachTitleTe0Opacity');
    expect(out).toContain('approachTitleTeSP');
    expect(out).toContain('const approachTitleRef = useRef(null);');
    expect(out).not.toContain('approachTitleSmooth');
  });
});
