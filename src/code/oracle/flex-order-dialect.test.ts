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

const fo = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'FLEX_CHILD_MISSING_ORDER');

describe('flex/grid child order dialect', () => {
  it('flex row with order on every child passes', () => {
    const out = fo(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', gap: '12px' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto', order: 1 }}>B</p>
    <p data-id="c" data-name="C" style={{ position: 'relative', flex: '0 0 auto', order: 2 }}>C</p>
  </div>`));
    expect(out).toEqual([]);
  });

  it('flex row with a child missing order bounces with the full plan', () => {
    const out = fo(PAGE(`  <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', gap: '12px' }}>
    <p data-id="a" data-name="A" style={{ position: 'relative', flex: '0 0 auto', order: 0 }}>A</p>
    <p data-id="b" data-name="B" style={{ position: 'relative', flex: '0 0 auto' }}>B</p>
    <p data-id="c" data-name="C" style={{ position: 'relative', flex: '0 0 auto', order: 2 }}>C</p>
  </div>`));
    expect(out.length).toBe(1);
    expect(out[0].message).toContain("a → order: '0', b → order: '1', c → order: '2'");
  });

  it('grid container is checked too', () => {
    const out = fo(PAGE(`  <div data-id="grid" data-name="Grid" style={{ position: 'relative', display: 'grid' }}>
    <div data-id="g1" data-name="G1" style={{ position: 'relative' }}></div>
    <div data-id="g2" data-name="G2" style={{ position: 'relative' }}></div>
  </div>`));
    expect(out.length).toBe(1);
  });

  it('single flex child is exempt (nothing to reorder)', () => {
    const out = fo(PAGE(`  <div data-id="solo" data-name="Solo" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
    <p data-id="only" data-name="Only" style={{ position: 'relative' }}>X</p>
  </div>`));
    expect(out).toEqual([]);
  });

  it('absolutely-positioned children are out of flow and exempt', () => {
    const out = fo(PAGE(`  <div data-id="stage" data-name="Stage" style={{ position: 'relative', display: 'flex' }}>
    <div data-id="deco-1" data-name="Deco 1" style={{ position: 'absolute', left: '0px', top: '0px' }}></div>
    <div data-id="deco-2" data-name="Deco 2" style={{ position: 'absolute', left: '10px', top: '0px' }}></div>
    <p data-id="content" data-name="Content" style={{ position: 'relative' }}>Hi</p>
  </div>`));
    expect(out).toEqual([]); // only ONE in-flow child
  });

  it('non-flex container (block) is not checked', () => {
    const out = fo(PAGE(`  <div data-id="block" data-name="Block" style={{ position: 'relative' }}>
    <p data-id="x" data-name="X" style={{ position: 'relative' }}>X</p>
    <p data-id="y" data-name="Y" style={{ position: 'relative' }}>Y</p>
  </div>`));
    expect(out).toEqual([]);
  });

  it('per-variant order ternary counts as present (component)', () => {
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
      <motion.p layout={true} data-id="c1" data-name="C1" style={{ position: 'relative', flex: '0 0 auto', order: variant === 'v1' ? 1 : 0 }} animate={variant}>1</motion.p>
      <motion.p layout={true} data-id="c2" data-name="C2" style={{ position: 'relative', flex: '0 0 auto', order: variant === 'v1' ? 0 : 1 }} animate={variant}>2</motion.p>
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(Row);`;
    const out = checkFile(COMP, { kind: 'component' }).filter((x) => x.code === 'FLEX_CHILD_MISSING_ORDER');
    expect(out).toEqual([]);
  });

  it('inline order must be a STRING — bare number bounces, string + ternary pass', () => {
    const os = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'ORDER_MUST_BE_STRING');
    // bare numeric literal → bounce (drag-reorder reads/writes the quoted form)
    expect(os(PAGE(`  <p data-id="x" data-name="X" style={{ position: 'relative', order: 2 }}>X</p>`)).length).toBe(1);
    expect(os(PAGE(`  <p data-id="y" data-name="Y" style={{ position: 'relative', order: -1 }}>Y</p>`)).length).toBe(1);
    // quoted string → clean (this is what the generator emits)
    expect(os(PAGE(`  <p data-id="z" data-name="Z" style={{ position: 'relative', order: '2' }}>Z</p>`))).toEqual([]);
    // per-variant reorder ternary (numbers in branches) → exempt: value is an expression, not a bare literal
    expect(os(PAGE(`  <p data-id="t" data-name="T" style={{ position: 'relative', order: true ? 1 : 0 }}>T</p>`))).toEqual([]);
  });
});
