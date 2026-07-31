import { describe, it, expect } from 'vitest';
import { composeAllScrollAppearConflicts } from './generator-motion';
import { removeNodeInCode } from './generator-crud';
import { parseJSX } from '@/code/parsing/ast-utils';

// Appear + Transform + Speed + Loop(rotate) + Hover(scale) — the full stack.
const SEP = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const { scrollY: boxSpeedScroll } = useScroll();
  const boxSpeedY = useTransform(boxSpeedScroll, (v) => v * (1 - 600 / 100));
  return (<div data-id="root">
    <motion.div data-id="box" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
      whileHover={{ scale: 1.05 }} animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
      style={{position:'absolute', scale: boxScale, opacity: boxOpacity, y: boxSpeedY}}></motion.div>
    <div data-id="sibling" style={{position:'absolute'}}></div>
  </div>);
}`;

// Body = everything after the import lines (syncImports prunes unused imports on
// flush, so the import line legitimately still names useMotionValue/etc).
const bodyOf = (code: string) => code.split('\n').filter(l => !/^\s*import /.test(l)).join('\n');

describe('deleting an animated node cleans up all motion artifacts', () => {
  it('a fully-combined node leaves no dangling hooks in the body', () => {
    const combined = composeAllScrollAppearConflicts(SEP);
    const after = removeNodeInCode(combined, 'box');
    expect(parseJSX(after)).not.toBeNull();
    const body = bodyOf(after);
    expect(body).not.toMatch(/\bbox[A-Z]\w*/);       // boxScale/boxAppear/boxLoopRotate/boxHovScale/…
    expect(body).not.toContain('useMotionValue');
    expect(body).not.toContain('useEffect(');
    expect(body).not.toContain('useInView');
    expect(body).not.toContain('animate(');
    expect(after).not.toContain('data-id="box"');
    expect(after).toContain('data-id="sibling"');     // sibling + structure intact
    expect(after).toContain('data-id="root"');
  });

  it('deleting one of two combined nodes leaves the OTHER intact', () => {
    const TWO = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const { scrollYProgress: otherProgress } = useScroll();
  const otherSmooth = useSpring(otherProgress, { duration: 0.5, bounce: 0.25 });
  const otherScale = useTransform(otherSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" whileHover={{ scale: 1.05 }} style={{position:'absolute', scale: boxScale}}></motion.div>
    <motion.div data-id="other" whileHover={{ scale: 1.1 }} style={{position:'absolute', scale: otherScale}}></motion.div>
  </div>);
}`;
    const combined = composeAllScrollAppearConflicts(TWO);
    const after = removeNodeInCode(combined, 'box');
    expect(parseJSX(after)).not.toBeNull();
    expect(after).not.toContain('data-id="box"');
    expect(bodyOf(after)).not.toMatch(/\bbox[A-Z]\w*/);   // box artifacts gone
    // other node + ALL its artifacts survive
    expect(after).toContain('data-id="other"');
    expect(after).toContain('otherScaleHovC');           // its composed hover still intact
  });
});
