import { describe, it, expect } from 'vitest';
import {
  composeAllScrollAppearConflicts, decomposeAllScrollConflicts, updateMotionPropInCode,
} from '@/code/generation/generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// Mirror the mutation-queue wrapper for scroll/appear-affecting mutations.
const apply = (code: string, fn: (c: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(code)));

const NID = 'box';
// Separate Appear (opacity + y) + Transform (opacity) — composes to a combined node.
const SEPARATE = `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
    <motion.div data-id="box" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }} style={{position:'absolute', opacity: boxOpacity}}></motion.div>
  </div>);
}`;

describe('editing the Appear transition on a combined node', () => {
  it('lands the new spring in the animate() call AND the data-scroll-fx spec', () => {
    const combined = composeAllScrollAppearConflicts(SEPARATE);
    // The combined form keeps the appear spring inside animate(), not on the tag.
    expect(combined).toMatch(/animate\(boxAppear, 1, \{ type: 'spring', duration: 0\.5, bounce: 0\.25 \}\)/);
    expect(combined).not.toMatch(/transition=\{\{/);  // no tag transition to edit directly

    // User bumps duration 0.5 -> 0.8, bounce 0.25 -> 0.5 (the wrapper handles it).
    const edited = apply(combined, c =>
      updateMotionPropInCode(c, NID, 'transition', { type: 'spring', duration: '0.8', bounce: '0.5' }));

    expect(parseJSX(edited)).not.toBeNull();
    // animate() spring is updated, numbers UNQUOTED (framer-motion needs numbers).
    expect(edited).toMatch(/animate\(boxAppear, 1, \{ type: 'spring', duration: 0\.8, bounce: 0\.5 \}\)/);
    // spec reflects the edit so the popup re-opens with the right values.
    const spec = JSON.parse(edited.match(/data-scroll-fx='([^']*)'/)![1]);
    expect(spec.appear.transition).toMatchObject({ duration: '0.8', bounce: '0.5' });
    // transform still intact.
    expect(spec.transform.from.opacity).toBe('0.5');
  });
});
