import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// One inner frame whose style/attrs are spliced in; "root" is pre-existing so
// "x" is the new node under test (the rule is new-node-only).
const PAGE = (style: string, attr = '') => `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="x" data-name="X"${attr} style={{ ${style} }}></div>
  </div>;
}`;

const pads = (code: string, existing: Set<string> = new Set(['root'])) =>
  checkFile(code, { kind: 'page', existingDataIds: existing }).filter((x) => x.code === 'PADDING_NEEDS_LAYOUT').length;

describe('PADDING_NEEDS_LAYOUT — a padded frame must declare a flex/grid layout', () => {
  it('padding with no display bounces', () => {
    expect(pads(PAGE("position: 'relative', width: '100%', height: 'auto', padding: '14px'"))).toBe(1);
  });

  it('padding + display:flex passes', () => {
    expect(pads(PAGE("position: 'relative', width: '100%', height: 'auto', padding: '14px', display: 'flex', flexDirection: 'column'"))).toBe(0);
  });

  it('padding + display:grid passes', () => {
    expect(pads(PAGE("position: 'relative', padding: '14px', display: 'grid'"))).toBe(0);
  });

  it('padding + display:block (static, non-layout) bounces', () => {
    expect(pads(PAGE("position: 'relative', padding: '14px', display: 'block'"))).toBe(1);
  });

  it('zero padding is not flagged', () => {
    expect(pads(PAGE("position: 'relative', padding: '0px'"))).toBe(0);
    expect(pads(PAGE("position: 'relative', padding: '0'"))).toBe(0);
  });

  it('paddingTop alone (non-zero) with no layout bounces', () => {
    expect(pads(PAGE("position: 'relative', paddingTop: '20px'"))).toBe(1);
  });

  it('a PRE-EXISTING node is NOT flagged (only new nodes)', () => {
    expect(pads(PAGE("position: 'relative', padding: '14px'"), new Set(['root', 'x']))).toBe(0);
  });

  it('with NO existingDataIds the rule stays silent', () => {
    expect(checkFile(PAGE("position: 'relative', padding: '14px'"), { kind: 'page' })
      .filter((x) => x.code === 'PADDING_NEEDS_LAYOUT').length).toBe(0);
  });

  it('a ...style spread passthrough/instance node is excluded', () => {
    expect(pads(PAGE("position: 'relative', padding: '14px', ...style"))).toBe(0);
  });

  it('a dynamic (ternary) display is not flagged — cannot statically confirm', () => {
    const code = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="x" data-name="X" style={{ position: 'relative', padding: '14px', display: variant === 'a' ? 'flex' : 'block' }}></div>
  </div>;
}`;
    expect(pads(code)).toBe(0);
  });

  it('a non-div (Link) with padding is not flagged — frames only', () => {
    const code = `'use client';
import React from 'react';
import Link from 'next/link';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <Link data-id="x" data-name="CTA" href="#" style={{ padding: '16px 34px' }}>Go</Link>
  </div>;
}`;
    expect(pads(code)).toBe(0);
  });

  it('a canvas-workspace node (data-canvas-node) is excluded', () => {
    expect(pads(PAGE("position: 'relative', padding: '14px'", ' data-canvas-node="true"'))).toBe(0);
  });

  it('also fires inside component files', () => {
    const comp = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Card" */
function Card({ style }) {
  return (
    <motion.div data-id="card" data-name="Card" style={{ position: 'relative', width: '300px', ...style }}>
      <motion.div data-id="pad" data-name="Pad" style={{ position: 'relative', padding: '24px' }}></motion.div>
    </motion.div>
  );
}
export default withResponsiveProps(Card);`;
    expect(checkFile(comp, { kind: 'component', existingDataIds: new Set(['card']) })
      .filter((x) => x.code === 'PADDING_NEEDS_LAYOUT').length).toBe(1);
  });
});
