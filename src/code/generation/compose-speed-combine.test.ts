import { describe, it, expect } from 'vitest';
import {
  composeScrollAppearInCode, decomposeScrollAppearInCode, hasAppearTransformConflict,
} from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

const NID = 'frame-mpwfg3rv-1';

// Appear (opacity + y) + Transform (x, opacity) + Speed (y parallax).
const APPEAR_TRANSFORM_SPEED = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: frameMpwfg3rv_1Progress } = useScroll();
  const frameMpwfg3rv_1Smooth = useSpring(frameMpwfg3rv_1Progress, { duration: 0.5, bounce: 0.25 });
  const frameMpwfg3rv_1Opacity = useTransform(frameMpwfg3rv_1Smooth, [0, 1], [0.5, 1]);
  const frameMpwfg3rv_1X = useTransform(frameMpwfg3rv_1Smooth, [0, 1], [0, 348]);
  const { scrollY: frameMpwfg3rv_1SpeedScroll } = useScroll();
  const frameMpwfg3rv_1SpeedY = useTransform(frameMpwfg3rv_1SpeedScroll, (v) => v * (1 - 1010 / 100));
  return (<div data-id="root">
    <motion.div data-id="frame-mpwfg3rv-1" data-name="Frame"
      initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
      style={{position: 'absolute', x: frameMpwfg3rv_1X, opacity: frameMpwfg3rv_1Opacity, y: frameMpwfg3rv_1SpeedY}}></motion.div>
  </div>);
}`;

// Appear (opacity + y) + Speed (y parallax) ONLY — no scrubbed transform.
const APPEAR_SPEED_ONLY = `'use client';
import React from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const { scrollY: frameMpwfg3rv_1SpeedScroll } = useScroll();
  const frameMpwfg3rv_1SpeedY = useTransform(frameMpwfg3rv_1SpeedScroll, (v) => v * (1 - 1010 / 100));
  return (<div data-id="root">
    <motion.div data-id="frame-mpwfg3rv-1" data-name="Frame"
      initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
      style={{position: 'absolute', opacity: 1, y: frameMpwfg3rv_1SpeedY}}></motion.div>
  </div>);
}`;

describe('Appear + Speed parallax combine on the y axis', () => {
  it('opacity multiplies, y ADDS (entrance offset + parallax), Speed not orphaned', () => {
    const out = composeScrollAppearInCode(APPEAR_TRANSFORM_SPEED, NID);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/frameMpwfg3rv_1OpacityC = useTransform\(\[frameMpwfg3rv_1Appear, frameMpwfg3rv_1Opacity\], \(\[a, t\]\) => a \* t\)/);
    expect(out).toMatch(/frameMpwfg3rv_1YA = useTransform\(frameMpwfg3rv_1Appear, \[0, 1\], \[30, 0\]\)/);
    expect(out).toMatch(/frameMpwfg3rv_1YAC = useTransform\(\[frameMpwfg3rv_1YA, frameMpwfg3rv_1SpeedY\], \(\[a, b\]\) => a \+ b\)/);
    expect(out).toMatch(/y: frameMpwfg3rv_1YAC/);
    // SpeedY referenced at least twice (declaration + inside the combine).
    expect((out.match(/frameMpwfg3rv_1SpeedY/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('round-trips: decompose restores y: SpeedY + initial.y=30', () => {
    const back = decomposeScrollAppearInCode(composeScrollAppearInCode(APPEAR_TRANSFORM_SPEED, NID), NID);
    expect(parseJSX(back)).not.toBeNull();
    expect(back).toMatch(/y: frameMpwfg3rv_1SpeedY/);
    expect(back).toMatch(/initial=\{\{[^}]*y: 30/);
    expect(back).not.toContain('YAC');
    expect(back).not.toContain('= useMotionValue(');
  });

  it('Appear + Speed with NO transform is still a conflict and composes', () => {
    expect(hasAppearTransformConflict(APPEAR_SPEED_ONLY, NID)).toBe(true);
    const out = composeScrollAppearInCode(APPEAR_SPEED_ONLY, NID);
    expect(parseJSX(out)).not.toBeNull();
    // y folds the parallax in; the bare whileInView/style fight is gone.
    expect(out).toMatch(/frameMpwfg3rv_1YAC = useTransform\(\[frameMpwfg3rv_1YA, frameMpwfg3rv_1SpeedY\], \(\[a, b\]\) => a \+ b\)/);
    expect(out).toMatch(/y: frameMpwfg3rv_1YAC/);
    expect(out).not.toContain('whileInView=');
    // round-trip
    const back = decomposeScrollAppearInCode(out, NID);
    expect(back).toMatch(/y: frameMpwfg3rv_1SpeedY/);
    expect(back).toMatch(/whileInView=\{\{[^}]*y: 0/);
  });

  it('plain appear-only (no sibling binding) has no conflict — stays declarative', () => {
    const APPEAR_ONLY = APPEAR_SPEED_ONLY
      .replace(/const \{ scrollY[^\n]*\n/, '')
      .replace(/const frameMpwfg3rv_1SpeedY[^\n]*\n/, '')
      .replace('y: frameMpwfg3rv_1SpeedY', "y: '0px'");
    // No scroll motion value shares a prop → nothing to compose; whileInView
    // works fine on its own, so the code is left untouched.
    expect(hasAppearTransformConflict(APPEAR_ONLY, NID)).toBe(false);
    const out = composeScrollAppearInCode(APPEAR_ONLY, NID);
    expect(out).toBe(APPEAR_ONLY);
    expect(out).toContain('whileInView=');
    expect(out).not.toContain('YAC');
  });
});
