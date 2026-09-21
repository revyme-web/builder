// Reset Override on the Transform row must clear the WHOLE visual transform
// family from the variant entry, not just the rotation.
//
// The controls all register under `transform`, but a variant entry stores them
// as motion props. The translation from `transform: ''` was written for
// `rotate` alone, so a variant that also carried a skew reset its rotation to
// match the primary and stayed skewed (user report 2026-09-20).

import { describe, it, expect } from 'vitest';
import { updateVariantStyleInCode } from './generator-styles';

const COMP = (entry: string) => `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'One', x: 900, y: 0 },
];
const badgeVariants = {
  default: { rotate: -190.3 },
  'variant-1': ${entry},
};
function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
    <motion.div data-id="card-root" data-name="Card" style={{ position: 'absolute', width: '400px', height: '300px', ...style }}>
      <motion.div data-id="badge" data-name="Badge" variants={badgeVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'relative', width: '40px', height: '40px' }}></motion.div>
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(Card);
`;

/** The body of the variant-1 entry after the write. */
const entryOf = (code: string) => {
  const m = code.match(/'variant-1':\s*\{([^}]*)\}/);
  return m ? m[1] : null;
};

describe('Reset Override on transform', () => {
  it('clears the skew as well as the rotation', () => {
    const out = updateVariantStyleInCode(COMP(`{ rotate: 141.9, skewX: 46 }`), 'badge', 'variant-1', { transform: '' });
    const body = entryOf(out);
    expect(body).not.toMatch(/skewX/);
    expect(body).not.toMatch(/rotate/);
  });

  it('clears every visual transform prop the panel can write', () => {
    const full = `{ rotate: 30, rotateX: 5, rotateY: 6, skewX: 46, skewY: 7, scale: 2, scaleX: 3, scaleY: 4, transformPerspective: 300 }`;
    const body = entryOf(updateVariantStyleInCode(COMP(full), 'badge', 'variant-1', { transform: '' }));
    for (const prop of ['rotate', 'rotateX', 'rotateY', 'skewX', 'skewY', 'scale', 'scaleX', 'scaleY', 'transformPerspective']) {
      expect(body, prop).not.toMatch(new RegExp(`\\b${prop}\\s*:`));
    }
  });

  // `x`/`y` are the POSITION channel — a pin's centering lives there, so a
  // transform reset must not touch them or the element moves.
  it('leaves the translate channel alone', () => {
    const body = entryOf(updateVariantStyleInCode(COMP(`{ rotate: 30, x: -20, y: 40 }`), 'badge', 'variant-1', { transform: '' }));
    expect(body).toMatch(/\bx\s*:/);
    expect(body).toMatch(/\by\s*:/);
    expect(body).not.toMatch(/rotate/);
  });

  it('leaves unrelated properties alone', () => {
    const body = entryOf(updateVariantStyleInCode(COMP(`{ rotate: 30, skewX: 46, backgroundColor: '#fff' }`), 'badge', 'variant-1', { transform: '' }));
    expect(body).toMatch(/backgroundColor/);
    expect(body).not.toMatch(/skewX/);
  });

  it('does not clobber an explicit value passed alongside the reset', () => {
    const body = entryOf(updateVariantStyleInCode(COMP(`{ rotate: 30, skewX: 46 }`), 'badge', 'variant-1', { transform: '', skewX: '12' }));
    expect(body).toMatch(/skewX/);
    expect(body).not.toMatch(/rotate/);
  });
});
