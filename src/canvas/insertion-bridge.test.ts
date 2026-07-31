// insertion-bridge.test.ts — default sizing for library/programmatic instance
// drops. A DESIGN component inherits its master ROOT's primary-variant
// width/height; icon sets stay square; local vectors keep a placeholder.

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));

import { buildInstanceClipboardNode } from './insertion-bridge';
import { getComponentRootSize } from '@/code/components/component-registry';
import { projectFS } from '@/code/project/project-fs';

const FAQ_MASTER = `'use client';
/** @name "FAQ Item" */
import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function FAQItem({ style }) {
  return <LayoutGroup><MotionConfig transition={{}}>
    <motion.div data-id="faq-root" data-name="FAQ Item" style={{ position: 'absolute', width: '760px', height: 'auto', display: 'flex', ...style }}>
      <motion.p data-id="faq-q" data-name="Question" style={{ width: '100px', height: '20px' }}>Q</motion.p>
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(FAQItem);`;

describe('getComponentRootSize', () => {
  test('reads the master root width/height (primary variant base style)', () => {
    expect(getComponentRootSize(FAQ_MASTER)).toEqual({ width: '760px', height: 'auto' });
  });

  test('ignores transparent wrappers (LayoutGroup/MotionConfig) — uses the first data-id element', () => {
    // The root is faq-root, not the first <motion.p> child.
    expect(getComponentRootSize(FAQ_MASTER).width).toBe('760px');
  });

  test('returns {} when no data-id element exists', () => {
    expect(getComponentRootSize('function X(){ return <div style={{ width: "10px" }} />; }')).toEqual({});
  });

  test('handles a percentage width', () => {
    const code = `function X(){ return <div data-id="r" style={{ width: '100%', height: '64px' }} />; }`;
    expect(getComponentRootSize(code)).toEqual({ width: '100%', height: '64px' });
  });

  // A variant-size ternary resolves to the PRIMARY variant: primary is the
  // ternary's final fallback (the generator only lists non-primary variants as
  // conditions), so a Header-style root → the desktop/default 1280×72.
  test('resolves a variant-size ternary to the primary (default) — fallback branch', () => {
    const code = `const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'mobile' }];
function X(){ return <div data-id="r" style={{
  width: variant === 'mobile' ? '390px' : variant === 'mobile-open' ? '390px' : '1280px',
  height: variant === 'mobile-open' ? 'auto' : '72px'
}} />; }`;
    expect(getComponentRootSize(code)).toEqual({ width: '1280px', height: '72px' });
  });

  test('resolves a ternary when the primary IS an explicit condition', () => {
    const code = `const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'big' }];
function X(){ return <div data-id="r" style={{ width: variant === 'big' ? '900px' : variant === 'default' ? '500px' : '300px' }} />; }`;
    expect(getComponentRootSize(code)).toEqual({ width: '500px' });
  });
});

describe('buildInstanceClipboardNode — default sizing', () => {
  beforeEach(() => {
    projectFS.writeFile('components/FAQItem.tsx', FAQ_MASTER);
  });

  test('a DESIGN component inherits the master root size (760px / auto)', () => {
    const [n] = buildInstanceClipboardNode('components/FAQItem.tsx', 'FAQItem');
    expect(n.styles.width).toBe('760px');
    expect(n.styles.height).toBe('auto');
    expect(n.styles.position).toBe('relative');
    expect(n.styles.flex).toBe('0 0 auto');
    expect(n.componentFile).toBe('components/FAQItem.tsx');
  });

  test('a DESIGN component with no readable master falls back to no explicit size', () => {
    const [n] = buildInstanceClipboardNode('components/Missing.tsx', 'Missing');
    expect(n.styles.width).toBeUndefined();
    expect(n.styles.height).toBeUndefined();
  });

  test('a DESIGN component with variant-ternary root dims inherits the primary (Header → 1280×72)', () => {
    const HEADER = `'use client';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'mobile' }];
function Header({ style }) {
  return <motion.div data-id="header-root" data-name="Header" style={{
    position: 'absolute',
    width: variant === 'mobile' ? '390px' : variant === 'mobile-open' ? '390px' : '1280px',
    height: variant === 'mobile-open' ? 'auto' : '72px',
    ...style
  }}>x</motion.div>;
}
export default Header;`;
    projectFS.writeFile('components/Header.tsx', HEADER);
    const [n] = buildInstanceClipboardNode('components/Header.tsx', 'Header');
    expect(n.styles.width).toBe('1280px');
    expect(n.styles.height).toBe('72px');
  });

  test('an ICON set stays square (240×240) + name="icon-1"', () => {
    const [n] = buildInstanceClipboardNode('icons/CePaDa.tsx', 'CePaDa');
    expect(n.styles.width).toBe('240px');
    expect(n.styles.height).toBe('240px');
    expect(n.attrs?.name).toBe('icon-1');
  });

  test('a local VECTOR keeps a placeholder box (300×120)', () => {
    const [n] = buildInstanceClipboardNode('vectors/Triangle.tsx', 'Triangle');
    expect(n.styles.width).toBe('300px');
    expect(n.styles.height).toBe('120px');
  });
});
