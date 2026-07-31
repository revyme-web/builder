import { describe, it, expect } from 'vitest';
import {
  composeAllScrollAppearConflicts, decomposeAllScrollConflicts,
  composeLoopInCode, hasLoopConflict,
} from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

const LOOP = (extra: string) => `'{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity","ease":"linear"}${extra}}'`;

// Appear + Transform + Loop(rotate via data-loop) + Hover(rotate). Loop & hover share rotate.
const FULL = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
      whileHover={{ rotate: -73 }} data-loop=${LOOP('')}
      style={{position:'absolute', scale: boxScale, opacity: boxOpacity}}></motion.div>
  </div>);
}`;

// Loop ONLY — data-loop isn't a real Motion attr, so even a lone loop must compose.
const LOOP_ONLY = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root">
    <motion.div data-id="box" data-loop=${LOOP('')} style={{position:'absolute'}}></motion.div>
  </div>);
}`;

describe('Loop (data-loop carrier) × everything', () => {
  it('loop becomes a gated motion value; hover folds into loop rotate; appear stays repeat-free', () => {
    const out = composeAllScrollAppearConflicts(FULL);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/boxLoopRotate = useMotionValue\(0\)/);
    expect(out).toMatch(/const boxLoopInView = useInView\(boxRef\)/);  // reuses appear ref, Pause default
    expect(out).toMatch(/useEffect\(\(\) => \{ if \(boxLoopInView\) \{ const _c = animate\(boxLoopRotate, 360, \{ duration: 2, repeat: Infinity, ease: 'linear' \}\); return \(\) => _c\.stop\(\); \} \}, \[boxLoopInView\]\)/);
    // appear reveal never inherits the loop's repeat (separate carriers now)
    expect(out).not.toMatch(/animate\(boxAppear, 1, \{[^}]*repeat/);
    // hover rotate folds ADDITIVELY into the loop rotate
    expect(out).toMatch(/boxRotateHovC = useTransform\(\[boxLoopRotate, boxHovRotate\], \(\[s, h\]\) => s \+ h\)/);
    expect(out).toMatch(/rotate: boxRotateHovC/);
    expect(out).not.toContain('data-loop=');   // carrier consumed
    const spec = JSON.parse(out.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.loop.props.rotate).toBe('360');
    expect(spec.loop.transition.repeat).toBe('Infinity');
  });

  it('round-trips: data-loop restored, recompose stable', () => {
    const back = decomposeAllScrollConflicts(composeAllScrollAppearConflicts(FULL));
    expect(parseJSX(back)).not.toBeNull();
    expect(back).toMatch(/data-loop='[^']*"rotate":"360"/);
    expect(back).toMatch(/whileHover=\{\{[^}]*rotate: -73/);
    expect(back).not.toContain('boxLoopRotate');
    const re = composeAllScrollAppearConflicts(back);
    expect(parseJSX(re)).not.toBeNull();
    expect(re).toMatch(/boxRotateHovC = useTransform\(\[boxLoopRotate, boxHovRotate\]/);
  });

  it('a loop ALONE now composes (data-loop must become imperative to render)', () => {
    expect(hasLoopConflict(LOOP_ONLY, 'box')).toBe(true);
    const out = composeAllScrollAppearConflicts(LOOP_ONLY);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/boxLoopRotate = useMotionValue\(0\)/);
    expect(out).toMatch(/rotate: boxLoopRotate/);
    expect(out).not.toContain('data-loop=');
  });

  it('loop + transform (no appear) composes; creates its own ref + gate', () => {
    const loopTransform = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" data-loop=${LOOP('')} style={{position:'absolute', scale: boxScale}}></motion.div>
  </div>);
}`;
    expect(hasLoopConflict(loopTransform, 'box')).toBe(true);
    const out = composeLoopInCode(loopTransform, 'box');
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/rotate: boxLoopRotate/);   // no other effect on rotate → bound directly
    expect(out).toMatch(/const boxRef = useRef\(null\)/);
    expect(out).toMatch(/ref=\{boxRef\}/);
    expect(out).toMatch(/const boxLoopInView = useInView\(boxRef\)/);
  });

  it('Off Screen Play runs the loop ungated and round-trips offscreen:"play"', () => {
    const playLoop = FULL.replace(LOOP(''), LOOP(',"offscreen":"play"'));
    const out = composeAllScrollAppearConflicts(playLoop);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/useEffect\(\(\) => \{ const _c = animate\(boxLoopRotate, 360,[\s\S]*?\}, \[\]\)/);
    expect(out).not.toContain('boxLoopInView');
    const back = decomposeAllScrollConflicts(out);
    expect(back).toMatch(/data-loop='[^']*"offscreen":"play"/);
  });

  it('direction Scroll Animation + Loop COEXIST (no animate collision)', () => {
    const dirLoop = `'use client';
import React, { useState } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent } from 'framer-motion';
export default function Page() {
  const [boxScrolled, setBoxScrolled] = useState(false);
  const { scrollY: boxScrollY } = useScroll();
  useMotionValueEvent(boxScrollY, "change", (y) => { const prev = boxScrollY.getPrevious() ?? 0; if (y > prev) setBoxScrolled(true); else if (y < prev) setBoxScrolled(false); });
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" data-loop=${LOOP('')}
      animate={boxScrolled ? { opacity: 0 } : { opacity: 1 }} transition={{ duration: 0.5 }}
      style={{position:'absolute', opacity: boxOpacity}}></motion.div>
  </div>);
}`;
    const out = composeAllScrollAppearConflicts(dirLoop);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/animate\(boxLoopRotate, 360/);     // loop imperative
    expect(out).toMatch(/rotate: boxLoopRotate/);
    const spec = JSON.parse(out.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.loop).toBeTruthy();
    expect(spec.animation).toBeTruthy();                    // direction ALSO present
    const back = decomposeAllScrollConflicts(out);
    expect(back).toMatch(/data-loop='[^']*"rotate":"360"/);
    expect(back).toMatch(/animate=\{boxScrolled \?/);       // direction restored, no collision
  });
});
