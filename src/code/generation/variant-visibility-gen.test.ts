// variant-visibility-gen.test.ts — Tests for setVariantVisibilityInCode.

import { describe, expect, it } from 'vitest';
import { setVariantVisibilityInCode } from './variant-visibility-gen';

const COMPONENT_SHELL = (childJsx: string) => `
import { motion, AnimatePresence } from 'framer-motion';
function Comp() {
  return <motion.div data-id="root">
    ${childJsx}
  </motion.div>;
}
export default Comp;
`;

describe('setVariantVisibilityInCode', () => {
  it('wraps a plain element with AnimatePresence + conditional when hiding on one variant', () => {
    const code = COMPONENT_SHELL(`<motion.div data-id="child-1" />`);
    const out = setVariantVisibilityInCode(code, 'child-1', ['variant-1'], ['default', 'variant-1', 'variant-2']);
    expect(out).toContain('<AnimatePresence mode="popLayout">');
    // Hidden in 1 of 3 → negative chain `variant !== 'variant-1'`
    expect(out).toMatch(/initialVariant\s*!==\s*['"]variant-1['"]/);
    expect(out).toContain('data-id="child-1"');
    expect(out).toContain('key="child-1"');
    // No default exit — instant unmount matches the reference's UX (siblings
    // smoothly FLIP into the gap via `layout`).
  });

  it('uses positive chain `variant === X` when only one variant shows the element', () => {
    const code = COMPONENT_SHELL(`<motion.div data-id="child-1" />`);
    // Hidden on default + variant-2 (visible only on variant-1).
    const out = setVariantVisibilityInCode(code, 'child-1', ['default', 'variant-2'], ['default', 'variant-1', 'variant-2']);
    // visibleVariants = ['variant-1'] (1 entry) < hiddenVariants (2) → positive
    expect(out).toMatch(/initialVariant\s*===\s*['"]variant-1['"]/);
    expect(out).not.toMatch(/initialVariant\s*!==/);
  });

  it('unwraps back to plain inline render when hiddenVariants becomes empty', () => {
    const wrapped = COMPONENT_SHELL(`
      <AnimatePresence mode="popLayout">
        {variant !== 'variant-1' && <motion.div data-id="child-1" key="child-1" exit={{ opacity: 0 }} />}
      </AnimatePresence>
    `);
    const out = setVariantVisibilityInCode(wrapped, 'child-1', [], ['default', 'variant-1', 'variant-2']);
    // AnimatePresence may still appear in the import line — check only JSX.
    expect(out).not.toContain('<AnimatePresence');
    expect(out).toContain('data-id="child-1"');
  });

  it('updates an existing wrapper\'s condition when hiddenVariants changes', () => {
    const wrapped = COMPONENT_SHELL(`
      <AnimatePresence mode="popLayout">
        {variant !== 'variant-1' && <motion.div data-id="child-1" key="child-1" exit={{ opacity: 0 }} />}
      </AnimatePresence>
    `);
    // Going from hidden on ['variant-1'] to hidden on ['variant-1', 'variant-2']
    // in a 5-variant world: hidden=2, visible=3 → negative chain still wins.
    const out = setVariantVisibilityInCode(
      wrapped, 'child-1',
      ['variant-1', 'variant-2'],
      ['default', 'variant-1', 'variant-2', 'variant-3', 'variant-4'],
    );
    expect(out).toMatch(/initialVariant\s*!==\s*['"]variant-1['"]/);
    expect(out).toMatch(/initialVariant\s*!==\s*['"]variant-2['"]/);
    // Only ONE wrapper, not two (re-used the existing one).
    expect(out.match(/<AnimatePresence/g)?.length).toBe(1);
  });

  it('uses `variant` (state) when component has useState scaffold', () => {
    const code = `
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
function Comp({ initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <motion.div data-id="root">
    <motion.div data-id="child-1" />
  </motion.div>;
}
    `;
    const out = setVariantVisibilityInCode(code, 'child-1', ['variant-1'], ['default', 'variant-1']);
    expect(out).toMatch(/\bvariant\b\s*!==\s*['"]variant-1['"]/);
    // Should NOT use initialVariant when variant state is present.
    expect(out).not.toMatch(/initialVariant\s*!==/);
  });

  it('emits `false && <element>` when ALL variants are hidden (visible nowhere)', () => {
    // Reproduces the drag-out-from-variant bug where the strategy commits
    // `hiddenVariants = allVariants` (element should disappear from JSX
    // entirely). Previously emitted `true && <element>` which made the
    // element render on EVERY variant instead of NONE.
    const code = COMPONENT_SHELL(`<motion.div data-id="child-1" />`);
    const out = setVariantVisibilityInCode(
      code, 'child-1',
      ['default', 'variant-1'],
      ['default', 'variant-1'],
    );
    expect(out).toContain('{false &&');
    expect(out).not.toContain('{true &&');
  });

  it('preserves existing key + exit props on the target element', () => {
    const code = COMPONENT_SHELL(`<motion.div data-id="child-1" key="custom-key" exit={{ x: -50 }} />`);
    const out = setVariantVisibilityInCode(code, 'child-1', ['variant-1'], ['default', 'variant-1']);
    expect(out).toContain('key="custom-key"');
    expect(out).toContain('x: -50');
  });
});
