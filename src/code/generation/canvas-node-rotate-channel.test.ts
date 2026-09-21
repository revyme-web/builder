// A node dragged out of a design component must end up with its rotation in
// exactly ONE channel.
//
// The exit fold copies `variants.default.rotate` into the inline `rotate`
// property (the canvas-node rotation channel). But the drag commit may already
// have folded the same motion props into a CSS `transform` string, and the
// canvas applies BOTH — so -190.3° was applied twice as -380.6° (≈ -20.6°).
// That ~180° flip made a flex column's children look reordered on drag-out
// (user report 2026-09-20: "the moment i drag it out they SWITCH order").

import { describe, it, expect } from 'vitest';
import { moveNodeInCode } from './generator-crud';

const SRC = (style: string) => `'use client';
import React, { useState } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'One', x: 900, y: 0 },
];
const boxVariants = { default: { rotate: -190.3 }, 'variant-1': { rotate: 20 } };
function DaBiZa({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  return (
    <LayoutGroup>
    <motion.div data-id="root" data-mroot="root" data-name="Frame" style={{ position: 'absolute', width: '800px', height: '400px', ...style }}>
      <motion.div data-id="box" data-name="Box" variants={boxVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{${style}}} key="box"></motion.div>
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(DaBiZa);
const canvasNodes = <>
  </>;
`;

/** The dragged-out element's inline style, as it lands in canvasNodes. */
const outStyle = (code: string) => {
  const i = code.indexOf('canvasNodes');
  const seg = code.slice(i);
  const m = seg.match(/data-id="box"[\s\S]*?style=\{\{([\s\S]*?)\}\}/);
  return m ? m[1] : '';
};

const move = (style: string) => moveNodeInCode(SRC(style), 'box', null, undefined, undefined, true);

describe('canvas-node rotation channel', () => {
  it('folds the variant rotation in when there is no transform', () => {
    const style = ` position: 'absolute', width: '100px', height: '100px' `;
    const s = outStyle(move(style));
    expect(s).toMatch(/rotate:\s*["']-190\.3["']/);
  });

  // The reported bug.
  it('does NOT add `rotate` when `transform` already carries one', () => {
    const style = ` position: 'absolute', width: '100px', height: '100px', transform: 'rotate(-190.3deg) skewX(0deg)' `;
    const s = outStyle(move(style));
    expect(s).toMatch(/transform:/);
    expect(s, 'the angle would be applied twice').not.toMatch(/rotate:\s*["']/);
  });

  it('still folds when `transform` has no rotation of its own', () => {
    const style = ` position: 'absolute', width: '100px', height: '100px', transform: 'translateX(-50%)' `;
    const s = outStyle(move(style));
    expect(s).toMatch(/rotate:\s*["']-190\.3["']/);
  });
});
