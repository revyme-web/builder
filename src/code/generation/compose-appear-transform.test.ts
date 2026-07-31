import { describe, it, expect } from 'vitest';
import { composeScrollAppearInCode, hasAppearTransformConflict } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// The user's exact shape: appear (opacity+y) + scroll transform (opacity+scale).
const PAGE = `'use client';
import React, { useState } from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="box" style={{position: 'absolute', opacity: boxOpacity, scale: boxScale}}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          ></motion.div>
    </div>
  );
}`;

describe('composeScrollAppearInCode (Appear × Transform multiply)', () => {
  it('detects the conflict', () => {
    expect(hasAppearTransformConflict(PAGE, 'box')).toBe(true);
  });
  const out = composeScrollAppearInCode(PAGE, 'box');
  it('valid JSX', () => { expect(parseJSX(out)).not.toBeNull(); });
  it('adds a single-element imperative animate() reveal (no wrapper)', () => {
    expect(out).toContain('const boxRef = useRef(null);');
    expect(out).toContain('const boxInView = useInView(boxRef, { once: true });');
    expect(out).toContain('const boxAppear = useMotionValue(0);');
    expect(out).toContain("useEffect(() => { if (boxInView) { const _c = animate(boxAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [boxInView]);");
    // single element — no wrapping motion.div added
    expect((out.match(/<motion\.div/g) || []).length).toBe(1);
  });
  it('shared prop (opacity) = appear × transform (array multiply)', () => {
    expect(out).toContain('const boxOpacityC = useTransform([boxAppear, boxOpacity], ([a, t]) => a * t);');
    expect(out).toMatch(/opacity:\s*boxOpacityC/);
  });
  it('appear-only prop (y) mapped from reveal [30, 0]', () => {
    expect(out).toContain('const boxYA = useTransform(boxAppear, [0, 1], [30, 0]);');
    expect(out).toMatch(/y:\s*boxYA/);
  });
  it('transform-only prop (scale) keeps its transform var', () => {
    expect(out).toMatch(/scale:\s*boxScale/);
  });
  it('removes the declarative appear props + attaches ref', () => {
    expect(out).not.toContain('whileInView=');
    expect(out).not.toContain('initial={{');
    expect(out).not.toContain('viewport={{');
    expect(out).toMatch(/ref=\{boxRef\}/);
  });
});

import { composeAllScrollAppearConflicts } from './generator-motion';
describe('composeAllScrollAppearConflicts (preview-compile pass)', () => {
  it('composes every conflict + adds useInView/useRef imports', () => {
    const out = composeAllScrollAppearConflicts(PAGE);
    expect(out).toContain('useInView(boxRef');
    expect(out).toContain('boxOpacityC');
    expect(out).toMatch(/import\s*\{[^}]*\buseInView\b[^}]*\}\s*from 'framer-motion'/);
    expect(out).toMatch(/import\s*\{[^}]*\buseMotionValue\b[^}]*\}\s*from 'framer-motion'/);
    expect(out).toMatch(/import\s*\{[^}]*\banimate\b[^}]*\}\s*from 'framer-motion'/);
    expect(out).toMatch(/import React,\s*\{[^}]*\buseRef\b[^}]*\}\s*from 'react'/);
    expect(out).toMatch(/import React,\s*\{[^}]*\buseEffect\b[^}]*\}\s*from 'react'/);
    expect(parseJSX(out)).not.toBeNull();
  });
  it('is a no-op when there is no conflict', () => {
    const noConflict = `import { motion } from 'framer-motion';
export default function P(){ return (<div data-id="a"><motion.div data-id="b" style={{opacity:1}}></motion.div></div>); }`;
    expect(composeAllScrollAppearConflicts(noConflict)).toBe(noConflict);
  });
});

import { hasDirectionTransformConflict } from './generator-motion';
describe('Direction Scroll Animation × Scroll Transform (the glitch case)', () => {
  const SRC = `'use client';
import React, { useState } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const [boxScrolled, setBoxScrolled] = useState(false);
  const { scrollY: boxScrollY } = useScroll();
  useMotionValueEvent(boxScrollY, "change", (y) => { const prev = boxScrollY.getPrevious() ?? 0; if (y > prev) setBoxScrolled(true); else if (y < prev) setBoxScrolled(false); });
  const { scrollY: boxSpeedScroll } = useScroll();
  const boxSpeedY = useTransform(boxSpeedScroll, (v) => v * (1 - 150 / 100));
  return (<div data-id="root" style={{position:'relative'}}>
    <motion.div data-id="box" style={{position: 'absolute', opacity: boxOpacity, scale: boxScale, y: boxSpeedY}}
      animate={boxScrolled ? { opacity: 0 } : { opacity: 1 }}
      transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }}></motion.div>
  </div>);
}`;
  it('detects the opacity conflict (animate vs style)', () => {
    expect(hasDirectionTransformConflict(SRC, 'box')).toBe(true);
  });
  const out = composeAllScrollAppearConflicts(SRC);
  it('composes opacity = animOpacity × transform, single element', () => {
    expect(out).toContain('const boxAnimOpacity = useMotionValue(1);');
    expect(out).toContain('animate(boxAnimOpacity, boxScrolled ? 0 : 1');
    expect(out).toContain('const boxOpacityDC = useTransform([boxAnimOpacity, boxOpacity], ([a, t]) => a * t);');
    expect(out).toMatch(/opacity:\s*boxOpacityDC/);
    expect((out.match(/<motion\.div/g) || []).length).toBe(1);
  });
  it('strips the conflicting animate/transition props but keeps the direction driver', () => {
    expect(out).not.toContain('animate=');
    expect(out).toContain('useMotionValueEvent');   // scroll-direction driver retained
    expect(out).toContain('setBoxScrolled');
  });
  it('keeps the non-conflicting transform (scale) and speed (y)', () => {
    expect(out).toMatch(/scale:\s*boxScale/);
    expect(out).toMatch(/y:\s*boxSpeedY/);
  });
  it('valid JSX + adds animate/useMotionValue/useEffect imports', () => {
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/import\s*\{[^}]*\banimate\b[^}]*\}\s*from 'framer-motion'/);
    expect(out).toMatch(/import React,\s*\{[^}]*\buseEffect\b[^}]*\}\s*from 'react'/);
  });
});

import { decomposeScrollDirectionTransformInCode } from './generator-motion';
import { parseScrollDirection, parseScrollHooks as _psh, getScrollDataForNode as _gsd } from '@/code/parsing/scroll-parser';
describe('direction×transform compose ⇄ decompose round-trip', () => {
  const SEP = `'use client';
import React, { useState } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const [boxScrolled, setBoxScrolled] = useState(false);
  const { scrollY: boxScrollY } = useScroll();
  useMotionValueEvent(boxScrollY, "change", (y) => { const prev = boxScrollY.getPrevious() ?? 0; if (y > prev) setBoxScrolled(true); else if (y < prev) setBoxScrolled(false); });
  return (<div data-id="root" style={{position:'relative'}}>
    <motion.div data-id="box" style={{position: 'absolute', opacity: boxOpacity, scale: boxScale}}
      animate={boxScrolled ? { opacity: 0 } : { opacity: 1 }}
      transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }}></motion.div>
  </div>);
}`;
  const combined = composeAllScrollAppearConflicts(SEP);
  const back = decomposeScrollDirectionTransformInCode(combined, 'box');
  it('decompose restores the editable separate form', () => {
    expect(parseJSX(back)).not.toBeNull();
    expect(back).toContain('animate={boxScrolled ? { opacity: 0 } : { opacity: 1 }}');
    expect(back).toMatch(/opacity:\s*boxOpacity\b/);
    expect(back).not.toContain('boxAnimOpacity');
    expect(back).not.toContain('boxOpacityDC');
  });
  it('decomposed form is re-detected (rows would show + be editable)', () => {
    expect(parseScrollDirection(back, 'box')).not.toBeNull();
    expect(_gsd(_psh(back), 'box').bindings.length).toBeGreaterThan(0);
  });
});

import { decomposeAllScrollConflicts } from './generator-motion';
describe('appear×transform compose ⇄ decompose round-trip', () => {
  const SEP = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root" style={{position:'relative'}}>
    <motion.div data-id="box" style={{position: 'absolute', opacity: boxOpacity, scale: boxScale}}
      initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}></motion.div>
  </div>);
}`;
  const back = decomposeAllScrollConflicts(composeAllScrollAppearConflicts(SEP));
  it('restores initial/whileInView/viewport + transform binding', () => {
    expect(parseJSX(back)).not.toBeNull();
    expect(back).toContain('initial={{ opacity: 0, y: 30 }}');
    expect(back).toContain('whileInView={{ opacity: 1, y: 0 }}');
    expect(back).toContain('viewport={{ once: true }}');
    expect(back).toMatch(/opacity:\s*boxOpacity\b/);
    expect(back).not.toContain('boxAppear');
    expect(back).not.toContain('boxOpacityC');
    expect(back).not.toContain('boxYA');
  });
});
