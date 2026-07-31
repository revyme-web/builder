// data-scroll-fx decompose/compose must survive a babel REFORMAT (an AST-path mutation
// like updateStyles runs `generate` on the whole page, turning the single-line hooks
// multi-line). Removing one stacked effect on a reformatted node must not orphan
// another's vars.
import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import { decomposeAllScrollConflicts, composeAllScrollAppearConflicts, updateScrollDirectionAnimInCode, updateScrollAnimInCode, removeScrollAnimFromCode } from './generator-motion';
import { syncImports, validateGeneratedCode } from '@/code/mutation/mutation-queue';
const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default);
const applyScroll = (c: string, fn: (x: string) => string) => composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(c)));
const reformat = (c: string) => generate(parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }), { retainLines: false, concise: false }, c).code;
const BASE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"><motion.div data-id="frame-x" style={{ position: 'absolute' }}></motion.div></div>);
}`;
describe('data-scroll-fx survives reformat', () => {
  it('Animation+Transform → reformat → remove Transform validates (Animation intact)', () => {
    let code = applyScroll(BASE, c => updateScrollDirectionAnimInCode(c, { nodeId: 'frame-x', toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } }));
    code = applyScroll(code, c => updateScrollAnimInCode(c, { nodeId: 'frame-x', trigger: 'onScroll', stops: [{ progress: 0, props: { opacity: '0.5' } }, { progress: 1, props: { opacity: '1' } }], transition: { type: 'spring', duration: '0.5' } } as any));
    const removed = applyScroll(reformat(code), c => removeScrollAnimFromCode(c, 'frame-x'));
    expect(validateGeneratedCode(syncImports(removed))).toBeNull();
  });
});
