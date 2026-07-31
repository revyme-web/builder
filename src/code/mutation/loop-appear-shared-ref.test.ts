import { describe, it, expect } from 'vitest';
import { composeAllScrollAppearConflicts, decomposeAllScrollConflicts, updateMotionPropInCode, removeScrollDirectionFromCode } from '@/code/generation/generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// Mirror the mutation-queue wrapper.
const apply = (code: string, fn: (c: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(code)));
const NID = 'box';

// Direction Scroll Animation + Transform + Loop. The loop's off-screen gate creates
// `boxRef`; converting the direction → Appear must REUSE that ref, not redeclare it.
const SEP = `'use client';
import React, { useState } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent } from 'framer-motion';
export default function Page() {
  const [boxScrolled, setBoxScrolled] = useState(false);
  const { scrollY: boxScrollY } = useScroll();
  useMotionValueEvent(boxScrollY, "change", (y) => { const prev = boxScrollY.getPrevious() ?? 0; if (y > prev) setBoxScrolled(true); else if (y < prev) setBoxScrolled(false); });
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" data-loop='{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity"}}'
      animate={boxScrolled ? { opacity: 0 } : { opacity: 1 }} transition={{ duration: 0.5 }}
      style={{position:'absolute', opacity: boxOpacity, scale: boxScale}}></motion.div>
  </div>);
}`;

describe('Appear + Loop share one ref (no "already declared")', () => {
  it('converting direction→Appear with a Loop present keeps exactly ONE boxRef', () => {
    const combined = composeAllScrollAppearConflicts(SEP);
    expect(combined).toMatch(/const boxRef = useRef\(null\)/);   // loop created it for its gate
    let code = combined;
    code = apply(code, c => removeScrollDirectionFromCode(c, NID));
    code = apply(code, c => updateMotionPropInCode(c, NID, 'initial', { opacity: '0', y: '30' }));
    code = apply(code, c => updateMotionPropInCode(c, NID, 'whileInView', { opacity: '1', y: '0' }));
    code = apply(code, c => updateMotionPropInCode(c, NID, 'viewport', { once: 'true' }));
    expect((code.match(/const boxRef = useRef\(null\)/g) || []).length).toBe(1);  // not 2
    expect(parseJSX(code)).not.toBeNull();
    expect(code).toMatch(/boxAppear = useMotionValue\(0\)/);
    expect(code).toMatch(/boxLoopRotate = useMotionValue\(0\)/);
    const spec = JSON.parse(code.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.appear).toBeTruthy();
    expect(spec.loop).toBeTruthy();
  });
});
