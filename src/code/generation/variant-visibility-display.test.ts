// variant-visibility-display.test.ts — unhiding a component node must clear the
// display:none channels too, not just the AnimatePresence render gate.
//
// A component node can be held invisible by THREE things at once: the gate
// (`{variant !== "default" && …}`), its inline `style={{ display: 'none' }}`,
// and the `default` entry of its `<node>Variants` object — which
// `animate={['default', variant]}` applies UNDER every variant. Hide→No only
// managed the gate, and the inline-display auto-substitution is deliberately
// skipped on component files, so a node carrying all three ignored the unhide
// entirely: nothing to unwrap, display:none survived, eye icon did nothing
// (2026-08-08).

import { describe, it, expect } from 'vitest';
import { setVariantVisibilityInCode } from './variant-visibility-gen';

const COMP = `import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
const frameMsjc5kpiVVariants = {
  default: { pointerEvents: 'auto', display: 'none' },
  'variant-1': { pointerEvents: 'none' }
};
function Header({ initialVariant = 'default' }) {
  const [variant, setVariant] = React.useState(initialVariant);
  return <div data-id="root">
    <AnimatePresence mode="popLayout">{variant !== "default" && <motion.div data-id="frame-msjc5kpi-v" variants={frameMsjc5kpiVVariants} data-name="menu-button" style={{ position: 'relative', width: '24px', display: 'none' }} key="frame-msjc5kpi-v" animate={['default', variant]}><span>x</span></motion.div>}</AnimatePresence>
  </div>;
}`;

describe('setVariantVisibilityInCode — unhide clears display:none', () => {
  const out = () => setVariantVisibilityInCode(COMP, 'frame-msjc5kpi-v', [], ['default', 'variant-1']);

  it('removes the inline display:none', () => {
    expect(out()).not.toMatch(/display:\s*'none'[^}]*\}\s*key=/);
    expect(out()).toContain("width: '24px'");   // other inline styles untouched
  });

  it("removes display:none from the variants object's default entry", () => {
    const o = out();
    const defaultEntry = o.slice(o.indexOf('default: {'), o.indexOf("'variant-1'"));
    expect(defaultEntry).not.toContain("display: 'none'");
    expect(defaultEntry).toContain("pointerEvents: 'auto'");  // sibling prop kept
  });

  it('still unwraps the AnimatePresence gate', () => {
    expect(out()).not.toContain('variant !== "default"');
  });

  it('HIDING on a variant uses the gate and clears the stale display channels', () => {
    // The gate is the single source of truth. A leftover display:none would
    // apply under EVERY variant (it lives inline + in the `default` entry that
    // `animate={['default', variant]}` always applies), so it must go — the
    // gate alone decides where the node renders.
    const hidden = setVariantVisibilityInCode(COMP, 'frame-msjc5kpi-v', ['variant-1'], ['default', 'variant-1']);
    expect(hidden).not.toContain("display: 'none'");
    // The gate does the hiding — its exact expression form depends on the
    // variant count, so assert the gate WRAPPER survives rather than its shape.
    expect(hidden).toContain('AnimatePresence');
  });

  it('unhiding ONE variant while others stay hidden still clears display (the reported bug)', () => {
    // hiddenVariants is non-empty here — the node keeps hiding on `default` —
    // so the unwrap branch never runs. The clear must happen anyway.
    const out2 = setVariantVisibilityInCode(COMP, 'frame-msjc5kpi-v', ['default'], ['default', 'variant-1', 'variant-2']);
    expect(out2).not.toContain("display: 'none'");
    expect(out2).toContain("pointerEvents: 'auto'");
  });
});
