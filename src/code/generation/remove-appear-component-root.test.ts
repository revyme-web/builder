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

// Removing an Appear must not delete the node's VARIANT CONNECTION handlers.
// `robustClearScrollFx` strips onTap/onHoverStart/… because a scroll-fx effect
// can emit those itself — but the connection graph writes the SAME prop names,
// and clearing the Appear took the interactions with it: the component stopped
// responding to hover/click while `const connections = [...]` still listed them
// (user report 2026-08-09, reproduced from the exported SuDaFe master).
describe('remove Appear keeps variant connection handlers', () => {
  const CONNECTED = `'use client';
const client11Variants = {
  default: { backgroundColor: '#ffffff' },
  'variant-1': { backgroundColor: '#ac5353' }
};
const connections = [
  { from: 'default', to: 'variant-1', trigger: 'mouseEnter' },
  { from: 'variant-1', to: 'variant-2', trigger: 'click' }
];
function SuDaFe({ style, initialVariant = 'default', ...rest }) {
  const [variant, setVariant] = useState(initialVariant);
  return <LayoutGroup>
    <motion.div
      onTap={() => { const _n = variant === 'variant-1' ? 'variant-2' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }}
      layout={true} data-id="client-11" variants={client11Variants} {...rest} data-name="Client" initial={{
      opacity: 0,
      y: 18
    }} whileInView={{
      opacity: 1,
      y: 0
    }} viewport={{ once: true }} transition={{ type: 'spring', delay: 0.35 }} style={{
      position: 'absolute',
      backgroundColor: '#ffffff'
    }} animate={['default', variant]}></motion.div>
  </LayoutGroup>;
}`;
  const out = setScrollFxInCode(CONNECTED, 'client-11', null);

  it('keeps both connection handlers intact', () => {
    expect(out).toContain('onTap={');
    expect(out).toContain('onHoverStart={');
    expect(out).toContain('setVariant(_n)');
  });

  it('still removes the appear props', () => {
    expect(out).not.toContain('whileInView');
    expect(out).not.toContain('viewport=');
    expect(out).not.toMatch(/initial=\{\{/);
  });

  it('restores the variant initial and keeps the variant animate list', () => {
    expect(out).toContain("initial={['default', initialVariant]}");
    expect(out).toContain("animate={['default', variant]}");
  });

  it('stays parseable', () => {
    expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
  });
});

// The carve-out is keyed on `setVariant`, so a scroll-fx handler that drives a
// motion value is still cleared — otherwise removing a hover effect would leave
// a handler referencing consts the same pass just deleted.
describe('remove Appear still clears scroll-fx gesture handlers', () => {
  const FX = `function Page() {
  const n1Y = useMotionValue(0);
  return <motion.div data-id="n1" onHoverStart={() => { n1Y.set(10); }} initial={{
    opacity: 0
  }} whileInView={{ opacity: 1 }} viewport={{ once: true }} style={{ position: 'relative' }}></motion.div>;
}`;
  const out = setScrollFxInCode(FX, 'n1', null);

  it('removes the motion-value handler', () => {
    expect(out).not.toContain('onHoverStart');
  });
});
