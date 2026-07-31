import { describe, it, expect } from 'vitest';
import {
  composeAllScrollAppearConflicts, decomposeAllScrollConflicts,
  composeGestureInCode, decomposeGestureInCode, hasGestureTransformConflict,
} from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// Appear (opacity+y) + Transform (scale, opacity) + Speed (y) + Hover (scale 1.05).
const FULL = `'use client';
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
      whileHover={{ scale: 1.05 }}
      style={{position:'absolute', scale: boxScale, opacity: boxOpacity, y: boxSpeedY}}></motion.div>
  </div>);
}`;

// Hover ONLY + Transform (scale) — no appear/speed. Still a conflict.
const HOVER_TRANSFORM = `'use client';
import React from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const boxScale = useTransform(useScroll().scrollYProgress, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" whileHover={{ scale: 1.1 }} style={{position:'absolute', scale: boxScale}}></motion.div>
  </div>);
}`;

describe('Hover / Tap × scroll compose (blend gestures with scroll motion values)', () => {
  it('folds hover scale into the scroll scale (multiply) with handlers + spec', () => {
    const combined = composeAllScrollAppearConflicts(FULL);
    expect(parseJSX(combined)).not.toBeNull();
    expect(combined).toMatch(/boxHovScale = useMotionValue\(1\)/);
    expect(combined).toMatch(/boxScaleHovC = useTransform\(\[boxScale, boxHovScale\], \(\[s, h\]\) => s \* h\)/);
    expect(combined).toMatch(/onHoverStart=\{\(\) => \{ animate\(boxHovScale, 1\.05/);
    expect(combined).toMatch(/onHoverEnd=\{\(\) => \{ animate\(boxHovScale, 1,/);
    expect(combined).toMatch(/scale: boxScaleHovC/);
    expect(combined).not.toMatch(/whileHover=/);  // only prop was scale → fully folded
    // appear + speed still compose alongside (opacity multiply, y additive).
    expect(combined).toMatch(/boxOpacityC = useTransform\(\[boxAppear, boxOpacity\]/);
    expect(combined).toMatch(/boxYAC = useTransform\(\[boxYA, boxSpeedY\]/);
    const spec = JSON.parse(combined.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.hover.props.scale).toBe('1.05');
  });

  it('round-trips: decompose restores whileHover + style scale: boxScale, no leftovers', () => {
    const back = decomposeAllScrollConflicts(composeAllScrollAppearConflicts(FULL));
    expect(parseJSX(back)).not.toBeNull();
    expect(back).toMatch(/whileHover=\{\{[^}]*scale: 1\.05/);
    expect(back).toMatch(/scale: boxScale\b/);
    expect(back).not.toContain('boxHovScale');
    expect(back).not.toContain('onHoverStart');
    expect(back).not.toContain('ScaleHovC');
  });

  it('Hover + Transform with no appear/speed still composes', () => {
    expect(hasGestureTransformConflict(HOVER_TRANSFORM, 'box')).toBe(true);
    const out = composeGestureInCode(HOVER_TRANSFORM, 'box', 'hover');
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/scale: boxScaleHovC/);
    expect(out).toMatch(/onHoverStart=/);
    const back = decomposeGestureInCode(out, 'box', 'hover');
    expect(back).toMatch(/whileHover=\{\{[^}]*scale: 1\.1/);
    expect(back).toMatch(/scale: boxScale\b/);
  });

  it('tap composes with onTapStart + onTap/onTapCancel handlers', () => {
    const tapCode = HOVER_TRANSFORM.replace('whileHover={{ scale: 1.1 }}', 'whileTap={{ scale: 0.95 }}');
    expect(hasGestureTransformConflict(tapCode, 'box')).toBe(true);
    const out = composeGestureInCode(tapCode, 'box', 'tap');
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/boxTapScale = useMotionValue\(1\)/);
    expect(out).toMatch(/onTapStart=\{\(\) => \{ animate\(boxTapScale, 0\.95/);
    expect(out).toMatch(/onTap=\{\(\) => \{ animate\(boxTapScale, 1,/);
    expect(out).toMatch(/onTapCancel=\{\(\) => \{ animate\(boxTapScale, 1,/);
    expect(decomposeGestureInCode(out, 'box', 'tap')).toMatch(/whileTap=\{\{[^}]*scale: 0\.95/);
  });

  it('keeps NON-conflicting gesture props declarative (partial fold)', () => {
    // hover sets scale (conflicts with scroll) AND backgroundColor (no scroll binding).
    const mixed = HOVER_TRANSFORM.replace(
      'whileHover={{ scale: 1.1 }}',
      "whileHover={{ scale: 1.1, backgroundColor: 'red' }}");
    const out = composeGestureInCode(mixed, 'box', 'hover');
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/scale: boxScaleHovC/);                 // scale folded
    expect(out).toMatch(/whileHover=\{\{ backgroundColor: 'red' \}\}/); // bg kept declarative
    expect(out).toMatch(/animate\(boxHovScale, 1\.1/);
  });
});

describe('Hover + Tap folding the SAME prop (nested gesture chain)', () => {
  const SAME = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
      style={{position:'absolute', scale: boxScale}}></motion.div>
  </div>);
}`;
  it('composes a clean nested chain (tap over hover over transform)', () => {
    const c = composeAllScrollAppearConflicts(SAME);
    expect(parseJSX(c)).not.toBeNull();
    expect(c).toMatch(/boxScaleHovC = useTransform\(\[boxScale, boxHovScale\]/);
    expect(c).toMatch(/boxScaleTapC = useTransform\(\[boxScaleHovC, boxTapScale\]/);
    expect(c).toMatch(/scale: boxScaleTapC/);
  });
  it('REGRESSION: decompose (tap before hover) round-trips with NO self-ref', () => {
    const d = decomposeAllScrollConflicts(composeAllScrollAppearConflicts(SAME));
    expect(d).toMatch(/scale: boxScale\b/);
    expect(d).not.toContain('ScaleHovC');
    const re = composeAllScrollAppearConflicts(d);
    expect(parseJSX(re)).not.toBeNull();
    // the bug: boxScaleHovC = useTransform([boxScaleHovC, …]) → undefined.get crash
    expect(re).not.toMatch(/boxScaleHovC = useTransform\(\[boxScaleHovC/);
    expect(re).toMatch(/boxScaleHovC = useTransform\(\[boxScale, boxHovScale\]/);
  });
});

// REGRESSION (live failure 2026-06-10): a quote-stripped CSS keyword in style is
// NOT a motion variable. backgroundColor: 'transparent' + whileHover on the same
// prop must NOT compose — the old shape-only check folded the keyword into a
// useTransform as a bare identifier (dangling ref → whole mutation flush blocked,
// breaking unrelated transition edits anywhere on the page).
const KEYWORD_STYLE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root">
    <motion.button data-id="nav-cta"
      whileHover={{ backgroundColor: '#ffffff', color: '#000000' }}
      style={{backgroundColor: 'transparent', color: '#ffffff'}}>Talk</motion.button>
  </div>);
}`;

describe('CSS keywords in style are not motion variables', () => {
  it('does not detect a conflict for backgroundColor: transparent', () => {
    expect(hasGestureTransformConflict(KEYWORD_STYLE, 'nav-cta')).toBe(false);
  });

  it('compose leaves the gesture declarative and never emits a dangling identifier', () => {
    const out = composeAllScrollAppearConflicts(KEYWORD_STYLE);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).not.toContain('useTransform([transparent');
    expect(out).toMatch(/whileHover=\{\{ backgroundColor: '#ffffff'/);
  });
});
