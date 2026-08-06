import { describe, it, expect } from 'vitest';
import { healSparseVariantDefaults } from './generator-styles';
import { parseJSX } from '@/code/parsing/ast-utils';

/** Component-file fixture in the generated dialect: module-scope variant
 *  consts + a master root whose children wire them with `variants={Name}`. */
const file = (objects: string, jsx: string) => `'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';

${objects}

export default function CePaNu() {
  const [variant, setVariant] = useState('default');
  const initialVariant = 'default';
  return (
    <motion.div data-id="root-1" initial={['default', initialVariant]} animate={['default', variant]} style={{ display: 'flex' }}>
${jsx}
    </motion.div>
  );
}
`;

describe('healSparseVariantDefaults', () => {
  it('seeds the CSS initial into an empty default when the base states nothing (the CePaNu sticky-flex shape)', () => {
    const code = file(
      `const frameMshm9l6m2Variants = {
  default: {},
  'variant-4': { flex: '1 0 0px' },
  'variant-6': { flex: '1 0 0px' },
};`,
      `      <motion.div data-id="frame-mshm-9l6m2" variants={frameMshm9l6m2Variants} style={{ display: 'flex', alignItems: 'center' }} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*flex: '0 1 auto',\s*\}/);
    // Variant entries themselves are untouched.
    expect(healed).toContain(`'variant-4': { flex: '1 0 0px' }`);
    expect(() => parseJSX(healed)).not.toThrow();
  });

  it('seeds from the inline style base when the tag carries one', () => {
    const code = file(
      `const boxVariants = {
  default: {},
  'variant-2': { backgroundColor: 'rgb(9, 9, 9)' },
};`,
      `      <motion.div data-id="box-1" variants={boxVariants} style={{ backgroundColor: 'rgb(1, 2, 3)', width: '100px' }} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*backgroundColor: 'rgb\(1, 2, 3\)',\s*\}/);
  });

  it('is brace-aware: entries carrying transition objects heal, and transition/its inner keys never seed', () => {
    const code = file(
      `const navVariants = {
  default: {},
  'variant-4': { flex: '1 0 0px', transition: { duration: 0.3, ease: [0.2, 0, 0, 1] } },
};`,
      `      <motion.div data-id="nav-1" variants={navVariants} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*flex: '0 1 auto',\s*\}/);
    expect(healed).not.toMatch(/default:[^}]*transition/);
    expect(healed).not.toMatch(/default:[^}]*duration/);
    expect(healed).not.toMatch(/default:[^}]*ease/);
    expect(() => parseJSX(healed)).not.toThrow();
  });

  it('appends at the TOP level of a default that itself carries a transition object', () => {
    const code = file(
      `const menuVariants = {
  default: { transition: { duration: 0.5 } },
  'variant-3': { pointerEvents: 'none' },
};`,
      `      <motion.div data-id="menu-1" variants={menuVariants} />`,
    );
    const healed = healSparseVariantDefaults(code);
    // pointerEvents lands as a sibling of transition, not inside it.
    expect(healed).toMatch(/default:\s*\{\s*transition:\s*\{\s*duration: 0\.5\s*\},\s*pointerEvents: 'auto',\s*\}/);
    expect(() => parseJSX(healed)).not.toThrow();
  });

  it('seeds pointerEvents + inset residue (the unclickable-buttons / jump class)', () => {
    const code = file(
      `const wrapVariants = {
  default: {},
  'variant-5': { pointerEvents: 'none', left: '0px', top: '0px' },
};`,
      `      <motion.div data-id="wrap-1" variants={wrapVariants} style={{ left: '24px', display: 'flex' }} />`,
    );
    const healed = healSparseVariantDefaults(code);
    // left has an inline base → seeded from it; top/pointerEvents fall to CSS initials.
    expect(healed).toContain(`pointerEvents: 'auto',`);
    expect(healed).toContain(`left: '24px',`);
    expect(healed).toContain(`top: 'auto',`);
  });

  it('seeds motion transforms as unquoted numerics', () => {
    const code = file(
      `const slideVariants = {
  default: {},
  'variant-2': { x: 100, scale: 1.2 },
};`,
      `      <motion.div data-id="slide-1" variants={slideVariants} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*x: 0, scale: 1,\s*\}/);
  });

  it('seeds flex-container initials but never display (UA-per-tag, not seedable)', () => {
    // The CePaNu logo-frame shape: variants center a child via display:flex +
    // alignment, base states none of it inline.
    const code = file(
      `const logoVariants = {
  default: {},
  'variant-4': { display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
};`,
      `      <motion.div data-id="logo-1" variants={logoVariants} style={{ position: 'relative', width: '120px' }} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toContain(`alignItems: 'normal',`);
    expect(healed).toContain(`justifyContent: 'normal',`);
    expect(healed).toContain(`flexDirection: 'row',`);
    expect(healed).not.toMatch(/default:[^}]*display/);
  });

  it('never seeds inherited text props without an inline base (would sever inheritance)', () => {
    const code = file(
      `const textVariants = {
  default: {},
  'variant-2': { color: 'red', flex: '1 0 0px' },
};`,
      `      <motion.p data-id="text-1" variants={textVariants} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*flex: '0 1 auto',\s*\}/);
    expect(healed).not.toMatch(/default:[^}]*color/);
  });

  it('never seeds the SVG geometry channel (d)', () => {
    const code = file(
      `const pathVariants = {
  default: {},
  'variant-2': { d: 'M0,0 L5,5 Z', fill: '#000000' },
};`,
      `      <motion.path data-id="path-1" variants={pathVariants} fill="#3b82f6" />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).not.toMatch(/default:[^}]*d:/);
    // fill still seeds from the tag ATTR (presentation channel).
    expect(healed).toMatch(/default:\s*\{\s*fill: '#3b82f6',\s*\}/);
  });

  it('is idempotent and leaves healthy objects byte-identical', () => {
    const sparse = file(
      `const aVariants = {
  default: {},
  'variant-4': { flex: '1 0 0px' },
};`,
      `      <motion.div data-id="a-1" variants={aVariants} />`,
    );
    const once = healSparseVariantDefaults(sparse);
    expect(healSparseVariantDefaults(once)).toBe(once);

    const healthy = file(
      `const bVariants = {
  default: { flex: '0 1 auto' },
  'variant-4': { flex: '1 0 0px' },
};`,
      `      <motion.div data-id="b-1" variants={bVariants} />`,
    );
    expect(healSparseVariantDefaults(healthy)).toBe(healthy);
  });

  it('heals every corrupted object in the file in one pass', () => {
    const code = file(
      `const oneVariants = {
  default: {},
  'variant-4': { flex: '1 0 0px' },
};
const twoVariants = {
  default: {},
  'variant-6': { pointerEvents: 'none' },
};`,
      `      <motion.div data-id="one-1" variants={oneVariants} />
      <motion.div data-id="two-1" variants={twoVariants} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/oneVariants = \{\s*default:\s*\{\s*flex: '0 1 auto',\s*\}/);
    expect(healed).toMatch(/twoVariants = \{\s*default:\s*\{\s*pointerEvents: 'auto',\s*\}/);
    expect(() => parseJSX(healed)).not.toThrow();
  });

  it('heals the __applyInstanceSize-wrapped wiring form too', () => {
    const code = file(
      `const instVariants = {
  default: {},
  'variant-2': { opacity: '0.5' },
};`,
      `      <motion.div data-id="inst-1" variants={__applyInstanceSize(instVariants, __instSize)} />`,
    );
    const healed = healSparseVariantDefaults(code);
    expect(healed).toMatch(/default:\s*\{\s*opacity: '1',\s*\}/);
  });

  it('ignores unwired consts and files without variants', () => {
    const noWire = file(
      `const orphanVariants = {
  default: {},
  'variant-4': { flex: '1 0 0px' },
};`,
      `      <div data-id="plain-1" />`,
    );
    expect(healSparseVariantDefaults(noWire)).toBe(noWire);

    const plain = file('', `      <div data-id="plain-1" />`);
    expect(healSparseVariantDefaults(plain)).toBe(plain);
  });

  it('skips objects whose shape it does not recognise instead of guessing', () => {
    const code = file(
      `const spreadVariants = {
  ...baseVariants,
  default: {},
  'variant-4': { flex: '1 0 0px' },
};`,
      `      <motion.div data-id="spread-1" variants={spreadVariants} />`,
    );
    expect(healSparseVariantDefaults(code)).toBe(code);
  });
});
