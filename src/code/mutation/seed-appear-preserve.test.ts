import { describe, it, expect } from 'vitest';
import {
  composeAllScrollAppearConflicts, decomposeAllScrollConflicts,
  updateMotionPropInCode, removeScrollDirectionFromCode, removeScrollAnimFromCode,
} from '@/code/generation/generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { parseJSXToNodes } from '@/code/parsing/parser';

// Mirror the mutation-queue wrapper for scroll/appear-affecting mutations.
const apply = (code: string, fn: (c: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(code)));

const NID = 'frame-mpwf1hhs-1';
// A real combined node: Transform (scale/opacity/rotate) + Speed(300) + direction
// Animation (fade out on scroll down). Three stacked effects on one element.
const COMBINED = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent, useMotionValue, animate } from 'framer-motion';
export default function Page() {
  const [frameMpwf1hhs_1Scrolled, setFrameMpwf1hhs_1Scrolled] = useState(false);
  const { scrollY: frameMpwf1hhs_1ScrollY } = useScroll();
  useMotionValueEvent(frameMpwf1hhs_1ScrollY, "change", (y) => {
    const prev = frameMpwf1hhs_1ScrollY.getPrevious() ?? 0;
    if (y > prev) setFrameMpwf1hhs_1Scrolled(true);
    else if (y < prev) setFrameMpwf1hhs_1Scrolled(false);
  });
  const { scrollY: frameMpwf1hhs_1SpeedScroll } = useScroll();
  const frameMpwf1hhs_1SpeedY = useTransform(frameMpwf1hhs_1SpeedScroll, (v) => v * (1 - 300 / 100));
  const { scrollYProgress: frameMpwf1hhs_1Progress } = useScroll();
  const frameMpwf1hhs_1Smooth = useSpring(frameMpwf1hhs_1Progress, { duration: 0.5, bounce: 0.25 });
  const frameMpwf1hhs_1Scale = useTransform(frameMpwf1hhs_1Smooth, [0, 1], [0.5, 1]);
  const frameMpwf1hhs_1Opacity = useTransform(frameMpwf1hhs_1Smooth, [0, 1], [0.5, 1]);
  const frameMpwf1hhs_1Rotate = useTransform(frameMpwf1hhs_1Smooth, [0, 1], [46, 0]);
  const frameMpwf1hhs_1AnimOpacity = useMotionValue(1);
  useEffect(() => { const _c = animate(frameMpwf1hhs_1AnimOpacity, frameMpwf1hhs_1Scrolled ? 0 : 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); }, [frameMpwf1hhs_1Scrolled]);
  const frameMpwf1hhs_1OpacityDC = useTransform([frameMpwf1hhs_1AnimOpacity, frameMpwf1hhs_1Opacity], ([a, t]) => a * t);
  return (<div data-id="root">
    <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"scale":"0.5","opacity":"0.5","rotate":"46"},"to":{"scale":"1","opacity":"1","rotate":"0"}},"speed":300,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5","bounce":"0.25"}}}' data-id="frame-mpwf1hhs-1" data-name="Frame" style={{position: 'absolute', width: '857px', height: '513px', y: frameMpwf1hhs_1SpeedY, scale: frameMpwf1hhs_1Scale, rotate: frameMpwf1hhs_1Rotate, opacity: frameMpwf1hhs_1OpacityDC}}></motion.div>
  </div>);
}`;

// seedAppear with the fix: a direction Animation → removeScrollDirection (NOT
// removeScrollAnim, which would wipe the separate Transform).
function seedAppearFixed(code: string): string {
  code = apply(code, c => removeScrollDirectionFromCode(c, NID));
  code = apply(code, c => updateMotionPropInCode(c, NID, 'initial', { opacity: '0', y: '30' }));
  code = apply(code, c => updateMotionPropInCode(c, NID, 'whileInView', { opacity: '1', y: '0' }));
  code = apply(code, c => updateMotionPropInCode(c, NID, 'viewport', { once: 'true' }));
  return code;
}

describe('switching Scroll Animation → On Appear preserves Transform + Speed', () => {
  it('keeps the transform spec and speed; adds appear, drops the animation', () => {
    const out = seedAppearFixed(COMBINED);
    expect(parseJSX(out)).not.toBeNull();
    const spec = JSON.parse(out.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.transform).toBeTruthy();
    expect(spec.transform.from).toMatchObject({ scale: '0.5', opacity: '0.5', rotate: '46' });
    expect(spec.speed).toBe(300);
    expect(spec.appear).toBeTruthy();
    expect(spec.animation).toBeFalsy();
    const box = parseJSXToNodes(out).get(NID) as any;
    expect(box.attrs?.['data-scroll-fx']).toBeTruthy();
  });

  it('REGRESSION: the old blanket removeScrollAnim would wipe the transform', () => {
    const buggy = apply(COMBINED, c => removeScrollAnimFromCode(c, NID));
    expect(buggy).not.toContain('useTransform(frameMpwf1hhs_1Smooth');  // transform bindings gone
  });
});
