import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// Minimal variant component. `rootW` = the root width expression; `extra` = a child.
const COMP = (rootW: string, extra: string) => `import React, { useState } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Bar" */

const variantConfig = [
{ name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
{ name: 'mobile', label: 'Mobile', x: 1400, y: 0 }];
const barVariants = { default: {}, mobile: {} };

function Bar({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  return (<LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="bar" layout variants={barVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{ display: 'flex', flexDirection: 'column', width: ${rootW}, ...style }}>
      ${extra}
    </motion.div>
  </MotionConfig></LayoutGroup>);
}

export default withResponsiveProps(Bar);`;

const TXT = "<motion.p data-id='t' layout style={{ position: 'relative', order: 0, flex: '0 0 auto' }}>Hi</motion.p>";
const tp = (rootW: string, extra: string = TXT) => checkFile(COMP(rootW, extra), { kind: 'component' }).filter((x) => x.code === 'VARIANT_TERNARY_TESTS_PRIMARY').length;
const el = (motionProps: string) => `<motion.p data-id='x' layout ${motionProps} style={{ position: 'relative', order: 0, flex: '0 0 auto' }}>Hi</motion.p>`;
const ap = (motionProps: string) => checkFile(COMP("'1280px'", el(motionProps)), { kind: 'component' }).filter((x) => x.code === 'MOTION_APPEAR_STUCK_HIDDEN').length;

describe('variant ternary must not test the primary variant', () => {
  it("width: variant === 'default' ? … bounces (default is primary → consequent dead)", () => {
    expect(tp("variant === 'default' ? '1280px' : '390px'")).toBe(1);
  });
  it('conditioning on non-primary (else = primary value) passes', () => {
    expect(tp("variant === 'mobile' ? '390px' : '1280px'")).toBe(0);
  });
  it('a conditional RENDER {variant === \'default\' && …} is NOT flagged', () => {
    expect(tp("'1280px'", "{variant === 'default' && " + TXT + "}")).toBe(0);
  });
});

describe('appear animation must not stay hidden on the live site', () => {
  it("initial opacity 0 + variant-list animate bounces", () => {
    expect(ap("initial={{ opacity: 0 }} animate={['default', variant]}")).toBe(1);
  });
  it('initial opacity 0 + NO animate bounces', () => {
    expect(ap("initial={{ opacity: 0 }}")).toBe(1);
  });
  it('initial opacity 0 + animate opacity 1 passes', () => {
    expect(ap("initial={{ opacity: 0 }} animate={{ opacity: 1 }}")).toBe(0);
  });
  it('initial opacity 0 + whileInView opacity 1 passes', () => {
    expect(ap("initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}")).toBe(0);
  });
  it('no initial opacity → not flagged', () => {
    expect(ap("animate={{ opacity: 1 }}")).toBe(0);
  });
});
