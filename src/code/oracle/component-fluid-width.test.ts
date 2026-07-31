import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const COMP = (rootStyle: string, body: string) => `'use client';

/** @name "Hdr" */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'D', x: 0, y: 0, isPrimary: true }, { name: 'mobile', label: 'M', x: 1400, y: 0 }];

function Hdr({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div layout={true} data-id="root" data-name="Root" style={{ position: 'absolute', ${rootStyle}, height: '76px', overflow: 'hidden', ...style }} animate={['default', variant]}>
${body}
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(Hdr);`;

const fw = (code: string) => checkFile(code, { kind: 'component' }).filter((x) => x.code === 'COMPONENT_CHILD_FIXED_WIDTH');

describe('component fluid-width dialect', () => {
  it('child width ternary MIRRORING the root bounces toward width 100%', () => {
    const code = COMP(
      "width: variant === 'mobile' ? '390px' : '1280px'",
      `      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'absolute', left: '0px', top: '0px', width: variant === 'mobile' ? '390px' : '1280px', height: '76px', display: 'flex' }} animate={['default', variant]}>
        <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
        <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
      </motion.div>`);
    const out = fw(code);
    expect(out.length).toBe(1);
    expect(out[0].elementId).toBe('row');
    expect(out[0].message).toContain("width: '100%'");
  });

  it("child set ⊆ root set (single mobile-width panel) bounces", () => {
    const code = COMP(
      "width: variant === 'mobile' ? '390px' : '1280px'",
      `      <div data-id="panel" data-name="Panel" style={{ position: 'absolute', left: '0px', top: '76px', width: '390px', height: '300px' }}></div>`);
    expect(fw(code).map(x => x.elementId)).toContain('panel');
  });

  it("child width 100% passes (already fluid)", () => {
    const code = COMP(
      "width: variant === 'mobile' ? '390px' : '1280px'",
      `      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'absolute', left: '0px', top: '0px', width: '100%', height: '76px', display: 'flex' }} animate={['default', variant]}>
        <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
        <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
      </motion.div>`);
    expect(fw(code)).toEqual([]);
  });

  it("a genuinely-narrow fixed child (not an artboard width) passes", () => {
    const code = COMP(
      "width: '1280px'",
      `      <div data-id="card" data-name="Card" style={{ position: 'relative', width: '400px', height: '200px' }}></div>`);
    expect(fw(code)).toEqual([]);
  });

  it("max-content / auto children pass", () => {
    const code = COMP(
      "width: '1280px'",
      `      <p data-id="t" data-name="T" style={{ position: 'relative', width: 'max-content', height: 'auto' }}>Hi</p>
      <p data-id="t2" data-name="T2" style={{ position: 'relative', width: 'auto', height: 'auto' }}>Yo</p>`);
    expect(fw(code)).toEqual([]);
  });

  it("the root itself is never flagged", () => {
    const code = COMP("width: '1280px'", `      <p data-id="x" data-name="X" style={{ position: 'relative', width: 'max-content', height: 'auto' }}>X</p>`);
    expect(fw(code).map(x => x.elementId)).not.toContain('root');
  });
});
