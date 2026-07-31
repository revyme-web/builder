// Removing the Appear effect (whileInView/viewport/transition + object `initial`)
// from a COMPONENT-MASTER root must not touch the component's variant wiring.
// The bug: robustClearScrollFx's const sweep keyed on `<cn>[A-Z]` also matched
// `<cn>Variants` (the framer-motion variants object) and deleted it, leaving
// `variants={…<cn>Variants…}` referencing an undefined identifier — the oracle
// blocked the remove with "References undefined identifier: frameMr2ed4ynBVariants".
// It also stripped `animate`/`initial` (the variant list wiring, not appear props).

import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { setScrollFxInCode } from './generator-motion';

const COMPONENT_ROOT = `'use client';
const frameMr2ed4ynBVariants = {
  default: { backgroundColor: 'rgba(0, 0, 0, 0.8)', display: 'flex' }
};
function RoTaWe({ style, initialVariant = 'default', ...rest }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-mr2ed4yn-b" variants={frameMr2ed4ynBVariants} initial={{
      opacity: 0,
      y: 714
    }} animate={['default', initialVariant]} {...rest} data-name="Frame" style={{
      position: 'absolute',
      width: '1440px',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      display: "flex"
    }} whileInView={{
      opacity: 1,
      y: 0
    }} viewport={{
      once: true
    }} transition={{ type: 'spring', stiffness: 300, damping: 55, mass: 1, delay: 0 }}></motion.div>
  </LayoutGroup>;
}`;

describe('remove Appear from a component-master root', () => {
  const out = setScrollFxInCode(COMPONENT_ROOT, 'frame-mr2ed4yn-b', null);

  it('PRESERVES the component variants const (no undefined reference)', () => {
    expect(out).toContain('const frameMr2ed4ynBVariants =');
    // JSX still references it AND the const exists → no dangling identifier.
    expect(out).toContain('variants={frameMr2ed4ynBVariants}');
  });

  it('keeps the variant `animate` list and restores the variant `initial`', () => {
    expect(out).toContain("animate={['default', initialVariant]}");
    expect(out).toContain("initial={['default', initialVariant]}");
    // The appear object-form initial is gone.
    expect(out).not.toMatch(/initial=\{\{\s*opacity/);
  });

  it('strips the appear-only props (whileInView / viewport / spring transition)', () => {
    expect(out).not.toContain('whileInView');
    expect(out).not.toContain('viewport=');
    expect(out).not.toMatch(/transition=\{\{\s*type:\s*'spring'/);
  });

  it('produces code that parses (would not crash at runtime)', () => {
    expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
  });

  it('does not duplicate the initial attr', () => {
    expect((out.match(/\binitial=/g) ?? []).length).toBe(1);
  });
});

describe('remove Appear from a plain (non-variant) node still fully clears', () => {
  const PLAIN = `function Page() {
  return <motion.div data-id="n1" initial={{
    opacity: 0,
    y: 40
  }} whileInView={{
    opacity: 1,
    y: 0
  }} viewport={{ once: true }} transition={{ duration: 0.5 }} style={{ position: 'relative' }}></motion.div>;
}`;
  const out = setScrollFxInCode(PLAIN, 'n1', null);

  it('removes initial + whileInView + viewport (no variant wiring to preserve)', () => {
    expect(out).not.toContain('whileInView');
    expect(out).not.toContain('viewport=');
    expect(out).not.toMatch(/initial=/);
    expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
  });
});
