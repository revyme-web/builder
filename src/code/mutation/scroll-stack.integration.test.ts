import { describe, it, expect } from 'vitest';
import {
  composeAllScrollAppearConflicts,
  decomposeAllScrollConflicts,
  updateMotionPropInCode,
  removeMotionPropFromCode,
} from '@/code/generation/generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// Mirror the mutation-queue wrapper: decompose → apply → recompose.
const apply = (code: string, fn: (c: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(code)));

// Transform-only (scrubbed From→To). No appear driver yet.
const TRANSFORM_ONLY = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root" style={{position:'relative'}}>
    <motion.div data-id="box" style={{position: 'absolute', opacity: boxOpacity}}></motion.div>
  </div>);
}`;

describe('scroll effect stacking (mutation-queue wrapper)', () => {
  it('adding Appear after a Transform auto-combines into one element + data-scroll-fx', () => {
    // Appear is written as three updateMotionProp mutations, each wrapped.
    let code = TRANSFORM_ONLY;
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'initial', { opacity: '0', y: '30' }));
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'whileInView', { opacity: '1', y: '0' }));
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'viewport', { once: 'true' }));

    // Combined: one element, native motion-value compose, no fighting props.
    expect(code).toContain('useMotionValue');
    expect(code).not.toContain('whileInView=');
    expect(code).toContain("data-scroll-fx='");
    // The spec records BOTH effects so the panel shows both rows.
    const spec = JSON.parse(code.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.appear).toBeTruthy();
    expect(spec.appear.initial).toMatchObject({ opacity: '0', y: '30' });
    expect(spec.appear.once).toBe(true);
    expect(spec.transform).toBeTruthy();
    expect(spec.transform.from).toMatchObject({ opacity: '0.5' });
    expect(parseJSX(code)).not.toBeNull();
  });

  it('removing Appear from a combined node round-trips back to Transform-only', () => {
    let code = TRANSFORM_ONLY;
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'initial', { opacity: '0', y: '30' }));
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'whileInView', { opacity: '1', y: '0' }));
    code = apply(code, c => updateMotionPropInCode(c, 'box', 'viewport', { once: 'true' }));
    expect(code).toContain("data-scroll-fx='");

    // Remove the appear driver — decompose restores it, removal strips it,
    // recompose finds no conflict → back to plain transform, attr gone.
    code = apply(code, c => removeMotionPropFromCode(c, 'box', 'whileInView'));
    code = apply(code, c => removeMotionPropFromCode(c, 'box', 'initial'));
    code = apply(code, c => removeMotionPropFromCode(c, 'box', 'viewport'));

    expect(code).not.toContain('data-scroll-fx');
    // Body is back to the separate form — no compose machinery. (The now-unused
    // useMotionValue/useInView/animate IMPORT tokens are stripped by syncImports
    // during the real flush; we assert on the body markers here.)
    expect(code).not.toContain('= useMotionValue(');
    expect(code).not.toContain('whileInView={');  // appear fully removed
    expect(code).toContain('useTransform');        // transform still there
    expect(code).toContain('opacity: boxOpacity'); // transform binding restored
    expect(parseJSX(code)).not.toBeNull();
  });
});
