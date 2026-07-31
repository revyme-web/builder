// motion-transform-reset-vs-set.test.ts — a write that CLEARS the CSS transform
// string while SETTING a motion prop in the SAME batch must keep the motion prop.
//
// Inside a design component a transform is stored as INDEPENDENT MOTION PROPS
// (`rotate: 90`), never as a CSS `transform` string — a raw string collides with
// motion's `layout` FLIP projection. Both `updateNodeInCode` and
// `updateVariantStyleInCode` therefore intercept an incoming `transform` on a
// motion element: a value is CONVERTED to motion props, and `''`/`'none'` is a
// RESET that also clears `rotate`.
//
// The bug (user report 2026-07-25, "Paste Style shows but the transform never
// pastes"): the reset branch spread the caller's map FIRST and appended
// `rotate: ''` AFTER, so it clobbered an explicitly-provided value. That's
// exactly the payload shape Paste Style sends onto a design-component element —
// clear the stale CSS form, write the motion form — so pasting a ROTATION was a
// silent no-op. (A scale/skew paste survived, which is why it looked
// property-specific.)

import { describe, it, expect } from 'vitest';
import { updateNodeInCode } from './generator-crud';
import { updateVariantStyleInCode } from './generator-styles';

const COMPONENT_CODE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
function Card({ style, initialVariant = 'default' }) {
  return (
    <motion.div data-id="root" style={{ ...style }}>
      <motion.p data-id="target" style={{ width: '20px' }}>Send</motion.p>
    </motion.div>
  );
}
export default Card;
`;

const PAGE_CODE = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ width: '100%' }}>
      <p data-id="target" style={{ width: '20px' }}>Send</p>
    </div>
  );
}
`;

/** The exact payload `buildPastePayload` produces for a motion target: clear the
 *  CSS string, write the motion props, blank every untouched one. */
const PASTE_ROTATE_90 = {
  transform: '', x: '', y: '', z: '', translateX: '', translateY: '', translateZ: '',
  scale: '', scaleX: '', scaleY: '', rotate: '90', rotateX: '', rotateY: '', rotateZ: '',
  skewX: '', skewY: '', transformPerspective: '',
};

const targetLine = (code: string) => code.split('\n').find((l) => l.includes('data-id="target"')) ?? '';

describe('updateNodeInCode — transform reset vs. explicit motion prop', () => {
  it('keeps an EXPLICIT rotate written alongside `transform: ""` (the paste payload)', () => {
    const out = updateNodeInCode(COMPONENT_CODE, 'target', PASTE_ROTATE_90);
    expect(targetLine(out)).toContain("rotate: '90'");
  });

  it('minimal shape: { transform: "", rotate: "90" } keeps the rotation', () => {
    const out = updateNodeInCode(COMPONENT_CODE, 'target', { transform: '', rotate: '90' });
    expect(targetLine(out)).toContain("rotate: '90'");
  });

  it('a genuine RESET (transform: "" with no motion prop) still clears the rotation', () => {
    const rotated = updateNodeInCode(COMPONENT_CODE, 'target', { rotate: '90' });
    expect(targetLine(rotated)).toContain("rotate: '90'");
    const reset = updateNodeInCode(rotated, 'target', { transform: '' });
    expect(targetLine(reset)).not.toContain("rotate: '90'");
  });

  it('a CSS transform VALUE still converts to motion props (unchanged behaviour)', () => {
    const out = updateNodeInCode(COMPONENT_CODE, 'target', { transform: 'rotate(90deg)' });
    expect(targetLine(out)).toContain("rotate: '90'");
    expect(targetLine(out)).not.toContain('transform:');
  });

  it('a PLAIN page element keeps the CSS transform string (no conversion)', () => {
    const out = updateNodeInCode(PAGE_CODE, 'target', { transform: 'rotate(90deg)', rotate: '' });
    expect(targetLine(out)).toContain('rotate(90deg)');
  });
});

describe('updateVariantStyleInCode — transform reset vs. explicit motion prop', () => {
  it('writes the rotation into the variant entry (paste onto a variant tile)', () => {
    const out = updateVariantStyleInCode(COMPONENT_CODE, 'target', 'variant-1', PASTE_ROTATE_90);
    // The variant entry carries the pasted value…
    expect(out).toMatch(/'variant-1':\s*\{[^}]*rotate:\s*90/);
    // …and the default entry gets the neutral animate-back value, so switching
    // back to `default` tweens the rotation out instead of sticking.
    expect(out).toMatch(/default:\s*\{[^}]*rotate:\s*0/);
  });

  it('a genuine RESET on a variant still clears the rotation', () => {
    const rotated = updateVariantStyleInCode(COMPONENT_CODE, 'target', 'variant-1', { rotate: '90' });
    expect(rotated).toMatch(/'variant-1':\s*\{[^}]*rotate:\s*90/);
    const reset = updateVariantStyleInCode(rotated, 'target', 'variant-1', { transform: '' });
    expect(reset).not.toMatch(/'variant-1':\s*\{[^}]*rotate:\s*90/);
  });
});
