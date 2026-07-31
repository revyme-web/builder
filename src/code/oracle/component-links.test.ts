import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const COMP = (opts: { link: string; setup?: boolean }) => `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
${opts.setup === false ? '' : "import Link from 'next/link';"}
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Bar" */
${opts.setup === false ? '' : 'const MotionLink = motion.create(Link);'}
const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
const barVariants = { default: {} };

function Bar({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="bar" variants={barVariants} initial={initialVariant} animate={initialVariant} style={{ width: '320px', display: 'flex', flexDirection: 'column', ...style }}>
      ${opts.link}
    </motion.div>
  </MotionConfig></LayoutGroup>);
}

export default withResponsiveProps(Bar);`;

const codes = (opts: { link: string; setup?: boolean }) => checkFile(COMP(opts), { kind: 'component' }).map((x) => x.code);
const L = (tag: string) => `<${tag} data-id="l" data-name="a" href="/journal" layout style={{ position: 'relative', order: 0, flex: '0 0 auto' }}>Go</${tag}>`;

describe('design-component links — must be MotionLink', () => {
  it('<motion.a href> bounces COMPONENT_LINK_NOT_MOTIONLINK', () => {
    expect(codes({ link: L('motion.a') })).toContain('COMPONENT_LINK_NOT_MOTIONLINK');
  });
  it('plain <a href> bounces', () => {
    expect(codes({ link: L('a') })).toContain('COMPONENT_LINK_NOT_MOTIONLINK');
  });
  it('plain <Link href> bounces (no animation)', () => {
    expect(codes({ link: L('Link') })).toContain('COMPONENT_LINK_NOT_MOTIONLINK');
  });
  it('<MotionLink href> with setup passes clean', () => {
    const cs = codes({ link: L('MotionLink') });
    expect(cs).not.toContain('COMPONENT_LINK_NOT_MOTIONLINK');
    expect(cs).not.toContain('MOTIONLINK_SETUP_MISSING');
  });
  it('<MotionLink href> WITHOUT import/create bounces MOTIONLINK_SETUP_MISSING', () => {
    expect(codes({ link: L('MotionLink'), setup: false })).toContain('MOTIONLINK_SETUP_MISSING');
  });
  it('a component with no links is unaffected', () => {
    const cs = codes({ link: '<motion.p data-id="t" style={{ position: \'relative\', order: 0, flex: \'0 0 auto\' }}>Hi</motion.p>' });
    expect(cs).not.toContain('COMPONENT_LINK_NOT_MOTIONLINK');
    expect(cs).not.toContain('MOTIONLINK_SETUP_MISSING');
  });
});
