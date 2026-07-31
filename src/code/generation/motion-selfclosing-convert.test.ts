import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { updateMotionPropInCode } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

// A container whose descendants include SELF-CLOSING <div/> (logo dots) — the exact
// shape that broke "add Appear to the hero". The self-closing children over-counted
// the tag-balance depth, so the matching closer was never found (closeIdx = -1) and
// the rename left <motion.div data-id="hero"> … </div> → "Expected corresponding JSX
// closing tag for <motion.div>" → validation bounced the whole edit.
const PAGE = `import React from 'react';
export default function Page() {
  return <div data-id="root" style={{ display: 'flex' }}>
    <div data-id="hero" data-name="Hero" style={{ display: 'flex' }}>
      <div data-id="dots" style={{ display: 'flex' }}>
        <div data-id="d0" style={{ width: '5px' }} />
        <div data-id="d1" style={{ width: '5px' }} />
        <div data-id="d2" style={{ width: '5px' }} />
      </div>
      <p data-id="label" style={{ margin: 0 }}>Hi</p>
    </div>
  </div>;
}`;

// hero already contains a motion.div child (the real page does after page-wide appear) —
// converting hero must ignore the bare <div/<div patterns inside <motion.div>…</motion.div>.
const PAGE_MOTION_CHILD = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" style={{ display: 'flex' }}>
    <div data-id="hero" data-name="Hero" style={{ display: 'flex' }}>
      <motion.div data-id="dots" style={{ display: 'flex' }}>
        <div data-id="d0" style={{ width: '5px' }} />
        <div data-id="d1" style={{ width: '5px' }} />
      </motion.div>
      <p data-id="label" style={{ margin: 0 }}>Hi</p>
    </div>
  </div>;
}`;

describe('updateMotionPropInCode — self-closing / motion descendants', () => {
  it('converts a container with self-closing <div/> children to a BALANCED motion.div', () => {
    const out = updateMotionPropInCode(PAGE, 'hero', 'initial', { opacity: '0', y: '24' });
    expect(out).toContain('<motion.div data-id="hero"');   // opener converted
    expect(out).toContain('</motion.div>');                // matching closer converted (the bug)
    expect(parseJSX(out)).not.toBeNull();                  // whole file parses
    expect(out).toContain("<div data-id=\"d0\" style={{ width: '5px' }} />"); // children untouched
    expect(out).toMatch(/initial=\{\{[^}]*opacity/);       // prop landed
  });

  it('nested motion.div children do not desync the tag balance', () => {
    const out = updateMotionPropInCode(PAGE_MOTION_CHILD, 'hero', 'initial', { opacity: '0' });
    expect(out).toContain('<motion.div data-id="hero"');
    expect(parseJSX(out)).not.toBeNull();
    // the inner motion.div (dots) is left exactly as-is — still its own balanced pair
    expect(out).toContain('<motion.div data-id="dots"');
    expect((out.match(/<\/motion\.div>/g) || []).length).toBe(2); // hero + dots
  });
});
