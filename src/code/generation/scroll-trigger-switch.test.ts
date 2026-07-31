// Switching a Scroll TRANSFORM's trigger must NOT remove a node's separate Scroll
// ANIMATION (direction) effect. The editor used to fire removeScrollDirection on a
// sectionInView switch regardless of mode, nuking the stacked Animation's
// AnimOpacity/Scrolled and leaving the composed binding dangling. Transform is always
// scrubbed (updateScrollAnim handles the switch itself), so no manual cleanup is needed.
import { describe, it, expect } from 'vitest';
import { decomposeAllScrollConflicts, composeAllScrollAppearConflicts, updateScrollDirectionAnimInCode, updateScrollAnimInCode } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { syncImports, validateGeneratedCode } from '@/code/mutation/mutation-queue';

const applyScroll = (code: string, fn: (c: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(code)));

const BASE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root">
    <div data-id="sec" id="sec1" style={{ position: 'absolute', height: '500px' }}></div>
    <motion.div data-id="frame-x" style={{ position: 'absolute', width: '171px' }}></motion.div>
  </div>);
}`;

describe('Scroll Transform trigger switch keeps stacked Animation', () => {
  it('onScroll → sectionInView preserves the Animation effect + validates', () => {
    let code = applyScroll(BASE, c => updateScrollDirectionAnimInCode(c, { nodeId: 'frame-x', toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } }));
    code = applyScroll(code, c => updateScrollAnimInCode(c, { nodeId: 'frame-x', trigger: 'onScroll', stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '2' } }], transition: { type: 'spring', duration: '0.5' } } as any));
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    code = applyScroll(code, c => updateScrollAnimInCode(c, { nodeId: 'frame-x', trigger: 'sectionInView', sectionId: 'sec1', stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '2' } }], transition: { type: 'spring', duration: '0.5' } } as any));
    expect(parseJSX(code)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    expect(code).toMatch(/frameXScrolled|frameXAnimOpacity/);
  });
});
