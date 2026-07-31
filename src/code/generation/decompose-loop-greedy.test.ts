import { describe, it, expect } from 'vitest';
import { decomposeLoopInCode, composeAllScrollAppearConflicts, decomposeAllScrollConflicts } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// A combined node whose DIRECTION useEffect sits BEFORE the LOOP useEffect, with the
// OpacityDC decl between them — the over-greedy loop regex used to delete all three.
const COMBINED = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent, useMotionValue, animate, useInView } from 'framer-motion';
export default function Page() {
  const [boxScrolled, setBoxScrolled] = useState(false);
  const { scrollY: boxScrollY } = useScroll();
  useMotionValueEvent(boxScrollY, "change", (y) => {});
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxAnimOpacity = useMotionValue(1);
  useEffect(() => { const _c = animate(boxAnimOpacity, boxScrolled ? 0 : 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); }, [boxScrolled]);
  const boxOpacityDC = useTransform([boxAnimOpacity, boxOpacity], ([a, t]) => a * t);
  const boxRef = useRef(null);
  const boxLoopInView = useInView(boxRef);
  const boxLoopRotate = useMotionValue(0);
  useEffect(() => { if (boxLoopInView) { const _c = animate(boxLoopRotate, 360, { duration: 2, repeat: Infinity, ease: 'linear' }); return () => _c.stop(); } }, [boxLoopInView]);
  return (<div data-id="root">
    <motion.div data-scroll-fx='{"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"}},"loop":{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity"}}}' ref={boxRef} data-id="box" style={{position:'absolute', opacity: boxOpacityDC, rotate: boxLoopRotate}}></motion.div>
  </div>);
}`;

describe('loop decompose must not eat the preceding direction useEffect', () => {
  it('decomposeLoop removes ONLY the loop useEffect (direction + OpacityDC survive)', () => {
    const out = decomposeLoopInCode(COMBINED, 'box');
    expect(out).toMatch(/const boxOpacityDC = useTransform/);            // OpacityDC decl survives
    expect(out).toMatch(/animate\(boxAnimOpacity, boxScrolled/);         // direction useEffect survives
    expect(out).not.toMatch(/animate\(boxLoopRotate/);                   // loop useEffect gone
    expect(out).toMatch(/data-loop='/);                                  // loop carrier restored
  });

  it('full decompose restores opacity to the transform var (no orphaned OpacityDC)', () => {
    const dec = decomposeAllScrollConflicts(COMBINED);
    expect(parseJSX(dec)).not.toBeNull();
    expect(dec).toMatch(/opacity:\s*boxOpacity\b/);
    expect(dec).not.toMatch(/opacity:\s*boxOpacityDC/);
    // recompose is clean + stable
    const re = composeAllScrollAppearConflicts(dec);
    expect(parseJSX(re)).not.toBeNull();
    expect(re).toMatch(/const boxOpacityDC = useTransform/);
    expect(re).toMatch(/opacity:\s*boxOpacityDC/);
  });
});
