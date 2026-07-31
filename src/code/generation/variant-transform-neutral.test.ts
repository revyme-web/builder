// variant-transform-neutral.test.ts — a transform animated on SOME variants must
// get a NEUTRAL entry on the others.
//
// framer-motion keeps the LAST animated transform when it switches to a variant
// whose entry doesn't mention that prop, so the element sticks mid-state: rotate
// a card on variant-1, switch to variant-2, and it stays rotated. The generator
// already seeded the `default` entry (the animate-BACK target); every other
// declared variant had the same hole. A component built entirely in the editor
// carried three of them and bounced VARIANT_OBJECT_MISSING_ENTRY (user report
// 2026-07-26) — the builder failing its own oracle.

import { describe, it, expect } from 'vitest';
import { updateVariantStyleInCode } from './generator-styles';

const COMP = (variants: string) => `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'One', x: 900, y: 0 },
  { name: 'variant-2', label: 'Two', x: 1800, y: 0 },
];
${variants}
function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
    <motion.div data-id="card-root" data-name="Card" style={{ position: 'absolute', width: '400px', height: '300px', ...style }}>
      <motion.div data-id="badge" data-name="Badge" variants={badgeVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '40px', height: '40px' }}></motion.div>
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(Card);
`;

const entry = (code: string, name: string) => {
  const m = code.match(new RegExp(`'?${name}'?\\s*:\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};

describe('transform neutrals across every variant', () => {
  it('seeds the neutral into variants that do not set the prop', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };`),
      'badge', 'variant-1', { rotate: '45' });
    expect(entry(out, 'variant-1')).toMatch(/rotate:\s*45/);
    // …the ones that would otherwise inherit the last animated rotation:
    expect(entry(out, 'variant-2')).toMatch(/rotate:\s*0/);
    expect(entry(out, 'default')).toMatch(/rotate:\s*0/);
  });

  it('uses 1 for scale, 0 for the rest', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };`),
      'badge', 'variant-1', { scale: '1.4', skewX: '10' });
    expect(entry(out, 'variant-2')).toMatch(/scale:\s*1/);
    expect(entry(out, 'variant-2')).toMatch(/skewX:\s*0/);
  });

  it('NEVER overwrites a value a variant already states', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {}, 'variant-2': { rotate: 90 } };`),
      'badge', 'variant-1', { rotate: '45' });
    expect(entry(out, 'variant-2')).toMatch(/rotate:\s*90/);
    expect(entry(out, 'variant-2')).not.toMatch(/rotate:\s*0/);
  });

  // The regression this nearly caused: the canvas merges `default` UNDER each
  // variant, so a variant stating nothing renders default's value. Seeding a
  // blind neutral there would silently un-rotate it. Seed the REST value.
  it('seeds the DEFAULT value, not a neutral, when default states one', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: { rotate: 45 }, 'variant-1': {}, 'variant-2': {} };`),
      'badge', 'variant-1', { rotate: '90' });
    expect(entry(out, 'variant-2')).toMatch(/rotate:\s*45/);   // unchanged rendering
    expect(entry(out, 'variant-1')).toMatch(/rotate:\s*90/);
  });

  it('falls back to the neutral only when nothing states a rest value', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };`),
      'badge', 'variant-1', { rotate: '45' });
    expect(entry(out, 'variant-2')).toMatch(/rotate:\s*0/);
  });

  it('leaves non-transform props alone (they inherit from default by design)', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };`),
      'badge', 'variant-1', { backgroundColor: '#ff0000' });
    expect(entry(out, 'variant-2') ?? '').not.toMatch(/backgroundColor/);
  });

  // A MISSING entry is the same bug as a missing prop — motion still keeps the
  // last animated transform when it switches to that variant. So the entry gets
  // created, holding the REST value (visually a no-op, but motion now has a
  // target). Leaving the object "clean" would leave the element stuck instead.
  it('CREATES an entry for a variant that has none', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: {}, 'variant-1': {} };`),
      'badge', 'variant-1', { rotate: '45' });
    expect(out).toMatch(/'variant-2'\s*:\s*\{[^}]*rotate:\s*0/);
  });

  it('the created entry carries the DEFAULT value, not a neutral', () => {
    const out = updateVariantStyleInCode(
      COMP(`const badgeVariants = { default: { rotate: 45 }, 'variant-1': {} };`),
      'badge', 'variant-1', { rotate: '90' });
    expect(out).toMatch(/'variant-2'\s*:\s*\{[^}]*rotate:\s*45/);
  });
});
