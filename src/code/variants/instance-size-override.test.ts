import { describe, it, expect } from 'vitest';
import { ensureInstanceSizeOverride, hasInstanceSizeOverride } from './instance-size-override';
import { parseJSXToNodes } from '@/code/parsing/parser';

const VARIANT_COMPONENT = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Header" */

const variantConfig = [
  { name: 'default', label: 'Header', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 600, y: 0 },
];

const frameMprca0ki5Variants = {
  default: { display: 'flex', width: '1440px', height: '136px' },
  'variant-1': { display: 'flex', width: '586px' },
};

function NeZaFi({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = React.useState(initialVariant);
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="frame-mprca0ki-5" variants={frameMprca0ki5Variants} data-name="Frame" animate={variant} initial={initialVariant} style={{ position: 'absolute', width: '1440px', height: '136px', ...style }}>
        <motion.span layout={true} data-id="label-1" variants={labelVariants} initial={initialVariant}>Hi</motion.span>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(NeZaFi);
`;

describe('instance-size-override', () => {
  it('wires the root variants through __applyInstanceSize and strips width/height from style', () => {
    const out = ensureInstanceSizeOverride(VARIANT_COMPONENT);
    expect(hasInstanceSizeOverride(out)).toBe(true);

    // Module-level helper injected (no import).
    expect(out).toContain('function __applyInstanceSize(variants, w, h)');
    expect(out).not.toMatch(/import[^\n]*__applyInstanceSize/);

    // Destructure pulls width/height out of style.
    expect(out).toContain("const { width: __instW, height: __instH, ...__instStyle } = style ?? {};");

    // Root variants resolved through the helper; root style spreads the rest.
    expect(out).toContain('variants={__applyInstanceSize(frameMprca0ki5Variants, __instW, __instH)}');
    expect(out).toContain('...__instStyle');

    // animate stays a string label (child variant propagation preserved).
    expect(out).toContain('animate={variant}');

    // The nested child's variants are NOT rewired (only the root).
    expect(out).toContain('variants={labelVariants}');
  });

  it('is idempotent', () => {
    const once = ensureInstanceSizeOverride(VARIANT_COMPONENT);
    const twice = ensureInstanceSizeOverride(once);
    expect(twice).toBe(once);
  });

  it('returns input unchanged when the root has no variants (instance ...style already wins)', () => {
    const noVariants = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

function Plain({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="root" style={{ position: 'absolute', width: '300px', ...style }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Plain);
`;
    expect(ensureInstanceSizeOverride(noVariants)).toBe(noVariants);
  });

  it('the parser still resolves the root variant styles after wrapping (canvas renders variants)', () => {
    // Regression: wrapping `variants={X}` → `variants={__applyInstanceSize(X, …)}`
    // must NOT hide the variant object from the parser, or the canvas falls back
    // to rendering every variant like the default.
    const wrapped = ensureInstanceSizeOverride(VARIANT_COMPONENT);
    const nodes = parseJSXToNodes(wrapped);
    const root = nodes.get('frame-mprca0ki-5');
    expect(root).toBeDefined();
    expect(root!.motionVariantsRef).toBe('frameMprca0ki5Variants');
    expect(root!.motionVariants).not.toBeNull();
    expect(root!.motionVariants!['default']).toMatchObject({ width: '1440px', height: '136px' });
    expect(root!.motionVariants!['variant-1']).toMatchObject({ width: '586px' });
  });

  it('the merged variants override width/height on EVERY entry at runtime', () => {
    // Sanity-check the injected helper's semantics by evaluating it.
    const helper = (variants: any, w: any, h: any) => {
      if (w === undefined && h === undefined) return variants;
      const out: any = {};
      for (const k in variants) {
        out[k] = { ...variants[k], ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
      }
      return out;
    };
    const variants = { default: { width: '1440px', height: '136px' }, 'variant-1': { width: '586px' } };

    // Instance sets width 80% → both variants become 80% wide, heights untouched.
    const r = helper(variants, '80%', undefined);
    expect(r.default).toEqual({ width: '80%', height: '136px' });
    expect(r['variant-1']).toEqual({ width: '80%' });

    // No override → identity (zero behavior change).
    expect(helper(variants, undefined, undefined)).toBe(variants);
  });
});
