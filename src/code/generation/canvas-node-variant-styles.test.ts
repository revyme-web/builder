// Dragging a node out of a design component moves its JSX into module-scope
// `canvasNodes`, where `variant` (a useState local) does not exist. The style
// flatten was keyed to ONE node id, so a dragged SUBTREE left its children's
// `variant === 'v' ? … : …` styles behind and the pre-flush validator blocked
// the whole drag: "References undefined identifier: variant — would crash at
// runtime" (user report 2026-09-20).

import { describe, it, expect } from 'vitest';
import { flattenCanvasNodeVariantStylesInCode } from './generator-crud';

const WRAP = (body: string) => `'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';

function DaBiZa({ initialVariant = 'default' }: { initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.div data-id="root" style={{ position: 'absolute' }} />;
}
export default DaBiZa;
const canvasNodes = <>
${body}
</>;
`;

describe('flattenCanvasNodeVariantStylesInCode', () => {
  it('flattens a nested 3-way ternary to its default branch', () => {
    const out = flattenCanvasNodeVariantStylesInCode(WRAP(
      `<motion.div data-id="a" style={{ height: variant === 'variant-1' ? '272px' : variant === 'variant-2' ? '218px' : '356px' }} />`,
    ));
    expect(out).toContain("'356px'");
    expect(out).not.toMatch(/variant ===/);
  });

  // The actual failure: the CHILD is what kept the reference.
  it('flattens a DESCENDANT, not just the dragged node', () => {
    const out = flattenCanvasNodeVariantStylesInCode(WRAP(
      `<motion.div data-id="parent" style={{ width: '10px' }}>
         <motion.div data-id="child" style={{ order: variant === 'variant-1' ? 1 : 2 }} />
       </motion.div>`,
    ));
    expect(out).not.toMatch(/variant ===/);
    expect(out).toMatch(/order:\s*2/);
  });

  it('drops a property whose default branch is empty', () => {
    const out = flattenCanvasNodeVariantStylesInCode(WRAP(
      `<motion.div data-id="a" style={{ display: initialVariant === 'variant-2' ? 'none' : '' }} />`,
    ));
    expect(out).not.toMatch(/display/);
    expect(out).not.toMatch(/initialVariant ===/);
  });

  it('leaves an unrelated ternary alone', () => {
    const src = WRAP(`<motion.div data-id="a" style={{ color: isDark ? 'white' : 'black' }} />`);
    expect(flattenCanvasNodeVariantStylesInCode(src)).toBe(src);
  });

  it('never touches styles INSIDE the component function', () => {
    const src = `'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';
function C({ initialVariant = 'default' }: { initialVariant?: string }) {
  const [variant] = useState(initialVariant);
  return <motion.div data-id="inside" style={{ order: variant === 'variant-1' ? 1 : 2 }} />;
}
export default C;
const canvasNodes = <>
  <motion.div data-id="out" style={{ width: '5px' }} />
</>;
`;
    expect(flattenCanvasNodeVariantStylesInCode(src)).toContain("variant === 'variant-1' ? 1 : 2");
  });

  it('is a no-op with no canvasNodes and is idempotent', () => {
    expect(flattenCanvasNodeVariantStylesInCode('const x = 1;')).toBe('const x = 1;');
    const once = flattenCanvasNodeVariantStylesInCode(WRAP(
      `<motion.div data-id="a" style={{ order: variant === 'v' ? 1 : 2 }} />`,
    ));
    expect(flattenCanvasNodeVariantStylesInCode(once)).toBe(once);
  });
});
