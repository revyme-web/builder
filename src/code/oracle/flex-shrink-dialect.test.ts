import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const PAGE = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
${body}
</div>
  );
}`;

const sh = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'FLEX_CHILD_SHRINKS');

describe('flex child shrink dialect', () => {
  it('children with flex 0 0 auto pass', () => {
    const out = sh(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
  </div>`));
    expect(out).toEqual([]);
  });

  it('a child missing flex bounces (CSS default shrink 1)', () => {
    const out = sh(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', order: 1 }}>B</p>
  </div>`));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('b');
    expect(out[0].message).toContain("flex: '0 0 auto'");
  });

  it("flex: '0 1 auto' (explicit shrink) bounces", () => {
    const out = sh(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 1 auto', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
  </div>`));
    expect(out.map(x => x.message).join()).toContain('a');
    expect(out.length).toBe(1);
  });

  it("flexShrink: 0 passes; flexShrink: 1 bounces", () => {
    const ok = sh(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flexShrink: 0, order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flexShrink: 0, order: 1 }}>B</p>
  </div>`));
    expect(ok).toEqual([]);
    const bad = sh(PAGE(`  <div data-id="col" data-name="Col" style={{ position: 'relative', display: 'flex' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flexShrink: 1, order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
  </div>`));
    expect(bad.length).toBe(1);
  });

  it("Fill child flex: '1 0 0px' passes (shrink 0)", () => {
    const out = sh(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '1 0 0px', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
  </div>`));
    expect(out).toEqual([]);
  });

  it("GRID children are NOT checked (flex-shrink does not apply)", () => {
    const out = sh(PAGE(`  <div data-id="grid" data-name="Grid" style={{ position: 'relative', display: 'grid' }}>
    <div data-id="g1" data-name="G1" style={{ position: 'relative', order: 0 }}></div>
    <div data-id="g2" data-name="G2" style={{ position: 'relative', order: 1 }}></div>
  </div>`));
    expect(out).toEqual([]);
  });

  it("absolutely-positioned children are exempt", () => {
    const out = sh(PAGE(`  <div data-id="stage" data-name="Stage" style={{ position: 'relative', display: 'flex' }}>
    <div data-id="d1" data-name="D1" style={{ position: 'absolute', left: '0px', top: '0px' }}></div>
    <p data-id="content" data-name="Content" style={{ position: 'relative' }}>Hi</p>
  </div>`));
    expect(out).toEqual([]); // only 1 in-flow child
  });

  it("ternary flex is indeterminate ⇒ skipped (component)", () => {
    const COMP = `'use client';

/** @name "Row" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'v1', label: 'B', x: 520, y: 0 }];
function Row({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div layout={true} data-id="row-root" data-name="Row" style={{ position: 'absolute', width: '400px', height: '80px', display: 'flex', overflow: 'hidden', ...style }} animate={variant}>
      <motion.p layout={true} data-id="c1" data-name="C1" style={{ position: 'relative', flex: variant === 'v1' ? '1 0 0px' : '0 0 auto', order: 0 }} animate={variant}>1</motion.p>
      <motion.p layout={true} data-id="c2" data-name="C2" style={{ position: 'relative', flex: '0 0 auto', order: 1 }} animate={variant}>2</motion.p>
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(Row);`;
    const out = checkFile(COMP, { kind: 'component' }).filter((x) => x.code === 'FLEX_CHILD_SHRINKS');
    expect(out).toEqual([]);
  });
});
