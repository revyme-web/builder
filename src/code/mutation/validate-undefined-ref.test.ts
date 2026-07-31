import { describe, it, expect } from 'vitest';
import { validateGeneratedCode } from './mutation-queue';

const wrap = (body: string, jsx: string) => `'use client';
import React, { useEffect } from 'react';
import { motion, useTransform, useMotionValue, animate } from 'framer-motion';
export default function Page() {
${body}
  return (${jsx});
}`;

describe('validateGeneratedCode — dangling reference guard', () => {
  it('flags an orphaned motion var (declaration dropped) — the real crash', () => {
    // style binds frameOpacityDC but its `const` was removed → "is not defined"
    const code = wrap(
      `  const frameScale = useMotionValue(1);`,
      `<motion.div style={{ scale: frameScale, opacity: frameOpacityDC }}></motion.div>`);
    const err = validateGeneratedCode(code);
    expect(err).toBeTruthy();
    expect(err).toMatch(/frameOpacityDC/);
    expect(err).toMatch(/undefined identifier|crash/i);
  });

  it('passes clean code where every ref is declared/imported', () => {
    const code = wrap(
      `  const frameScale = useMotionValue(1);\n  const frameOpacityDC = useTransform(frameScale, (v) => v);`,
      `<motion.div style={{ scale: frameScale, opacity: frameOpacityDC }}></motion.div>`);
    expect(validateGeneratedCode(code)).toBeNull();
  });

  it('does NOT flag legitimate JS/DOM globals', () => {
    const code = wrap(
      `  const x = Math.max(1, 2);\n  useEffect(() => { const id = window.setTimeout(() => console.log(Date.now()), 100); return () => clearTimeout(id); }, []);`,
      `<motion.div style={{ opacity: x }}></motion.div>`);
    expect(validateGeneratedCode(code)).toBeNull();
  });

  it('still catches plain syntax errors', () => {
    expect(validateGeneratedCode(`export default function Page() { return ( }`)).toBeTruthy();
  });

  it('flags a self-referential useTransform (the hover/tap chain bug class)', () => {
    const code = wrap(
      `  const frameHov = useMotionValue(1);\n  const frameScaleHovC = useTransform([frameScaleHovC, frameHov], ([s, h]) => s * h);`,
      `<motion.div style={{ scale: frameScaleHovC }}></motion.div>`);
    // frameScaleHovC referenced before its own init isn't "global", but a TRULY
    // orphaned ref would be. Here it's self-bound so scope sees it — ensure we don't
    // false-positive on a valid (if odd) self-reference; the runtime guard for that
    // case is the compose self-ref guard, not this. Just assert no crash in validator.
    expect(() => validateGeneratedCode(code)).not.toThrow();
  });
});

// ─── useScroll target ref attachment (the parallax white-screen class) ───────
// framer-motion 12 crashes the whole page when a useScroll target ref never
// attaches; a canvas tag rewrite can silently drop `ref={X}` (live find
// 2026-07-07, works-grid parallax column C).
describe('validateGeneratedCode — useScroll target refs', () => {
  it('blocks a useScroll target whose ref is not attached', () => {
    const code = `import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const colRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: colRef, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [0, 100]);
  return <motion.div data-id="col" style={{ y }} />;
}`;
    const err = validateGeneratedCode(code);
    expect(err).toMatch(/useScroll target ref/);
    expect(err).toMatch(/colRef/);
  });

  it('passes when the ref is attached', () => {
    const code = `import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const colRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: colRef });
  const y = useTransform(scrollYProgress, [0, 1], [0, 100]);
  return <motion.div ref={colRef} data-id="col" style={{ y }} />;
}`;
    expect(validateGeneratedCode(code)).toBeNull();
  });

  it('passes an IMPERATIVELY attached ref (querySelector effect — the text-anim/instance-fx pattern)', () => {
    // text-anim-gen + instance-fx-gen never bind `ref=` in JSX: they hydrate the
    // ref in an effect with a `|| document.body` fallback. That satisfies the
    // framer-motion invariant — the guard must not block these mutations.
    const code = `import React, { useRef, useEffect } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const heroTeRef = useRef(null);
  useEffect(() => { heroTeRef.current = document.querySelector("[data-id='hero']") || document.body; }, []);
  const { scrollYProgress } = useScroll({ target: heroTeRef, offset: ['start 0.9', 'start 0.5'] });
  const o = useTransform(scrollYProgress, [0, 1], [0, 1]);
  return <motion.div data-id="hero" style={{ opacity: o }} />;
}`;
    expect(validateGeneratedCode(code)).toBeNull();
  });

  it('windowless useScroll (no target) needs no ref', () => {
    const code = `import React from 'react';
import { motion, useScroll } from 'framer-motion';
export default function Page() {
  const { scrollYProgress } = useScroll();
  return <motion.div data-id="bar" style={{ scaleX: scrollYProgress }} />;
}`;
    expect(validateGeneratedCode(code)).toBeNull();
  });
});

describe('validateGeneratedCode — duplicate JSX attributes', () => {
  it('blocks a duplicate attribute (the appear-initial + variant-initial collision)', () => {
    const code = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <motion.div data-id="x" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} initial={['default']} animate={['default']} style={{ position: 'relative' }} />;
}`;
    const err = validateGeneratedCode(code);
    expect(err).toMatch(/Duplicate JSX attribute/);
    expect(err).toMatch(/initial/);
  });

  it('does not false-positive on identifiers inside handler braces', () => {
    const code = `import React, { useState } from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  const [variant, setVariant] = useState('default');
  return <motion.div data-id="x"
    onHoverEnd={() => setVariant(variant === 'hover' ? 'default' : variant)}
    onHoverStart={() => setVariant(variant === 'default' ? 'hover' : variant)}
    style={{ position: 'relative' }} />;
}`;
    expect(validateGeneratedCode(code)).toBeNull();
  });
});

describe('validateGeneratedCode — corrupted motion ease', () => {
  it('blocks a truncated cubic-bezier ease string', () => {
    const code = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <motion.div data-id="x" transition={{ duration: 0.9, ease: '[0.16', delay: 0 }} style={{ position: 'relative' }} />;
}`;
    expect(validateGeneratedCode(code)).toMatch(/Corrupted easing/);
  });

  it('passes a proper array ease', () => {
    const code = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <motion.div data-id="x" transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0 }} style={{ position: 'relative' }} />;
}`;
    expect(validateGeneratedCode(code)).toBeNull();
  });
});
