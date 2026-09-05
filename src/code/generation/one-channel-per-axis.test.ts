// ONE CHANNEL PER AXIS (2026-09-05). A motion.* element may centre via motion
// shorthands (`x/y: '-50%'`) OR a CSS translate string; the Renderer folds
// string THEN shorthands, so both together double the shift. Writing `x`/`y`
// must evict that axis's translate from any string already on the element —
// inline base (updateNodeInCode) and variant entry (updateVariantStyleInCode).
import { describe, it, expect } from 'vitest';
import { updateNodeInCode } from './generator-crud';
import { updateVariantStyleInCode } from './generator-styles';

const COMP = (style: string, defaultEntry: string) => `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 400, y: 0 },
];
const barVariants = {
  default: ${defaultEntry},
  'variant-1': { rotate: -47.2 },
};
function Comp({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" data-name="Frame" style={{ position: 'relative', width: '200px', height: '200px', ...style }}>
      <motion.svg layout={true} data-id="bar" variants={barVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} viewBox="0 0 25 4" style={{ ${style} }}>
        <motion.rect data-id="bar-g0" width="100%" height="100%" fill="#000" />
      </motion.svg>
    </motion.div>
  </LayoutGroup>);
}
export default Comp;`;

const styleOf = (code: string) => code.match(/data-id="bar"[\s\S]*?style=\{\{([\s\S]*?)\}\}/)![1];
const entryOf = (code: string) => code.match(/default:\s*\{([^}]*)\}/)![1];

describe('inline base (updateNodeInCode)', () => {
  it('writing x evicts translateX from the base string, keeps translateY + rotate shorthand', () => {
    const code = COMP(`position: 'absolute', left: "50%", top: '17%', x: '-50%', y: '-50%', rotate: '146.8', transform: "translateX(-50%) translateY(-50%)"`, `{ rotate: 146.8 }`);
    const out = updateNodeInCode(code, 'bar', { x: '-50%' });
    const st = styleOf(out);
    expect(st).not.toContain('translateX(-50%)');
    expect(st).toContain("transform: 'translateY(-50%)'");
    expect(st).toContain("rotate: '146.8'");
    expect(st).toContain("x: '-50%'");
  });
  it('the exact live shape: x beside transform:"translateX(-50%)" → transform key removed', () => {
    const code = COMP(`position: 'absolute', left: "50%", x: '-50%', y: '-50%', transform: "translateX(-50%)"`, `{ rotate: 9 }`);
    const out = updateNodeInCode(code, 'bar', { x: '-50%', left: '50%' });
    const st = styleOf(out);
    expect(st).not.toMatch(/transform\s*:/);
    expect(st).toContain("x: '-50%'");
    expect(st).toContain("y: '-50%'");
  });
  it('a plain (non-motion) page element is untouched by the eviction', () => {
    const page = `export default function Page() { return <div data-id="root"><div data-id="b" style={{ position: 'absolute', x: '-50%', transform: 'translateX(-50%)' }}></div></div>; }`;
    const out = updateNodeInCode(page, 'b', { x: '-40%' });
    expect(out).toContain("transform: 'translateX(-50%)'");
  });
});

describe('variant entry (updateVariantStyleInCode)', () => {
  it('writing x to default evicts translateX from the entry string, rotate intact', () => {
    const code = COMP(`position: 'absolute', x: '-50%', y: '-50%'`, `{ rotate: 146.8, transform: 'translateX(-50%)' }`);
    const out = updateVariantStyleInCode(code, 'bar', 'default', { x: '-50%', left: '50%' });
    const e = entryOf(out);
    expect(e).not.toContain('translateX');
    expect(e).not.toMatch(/transform\s*:/);
    expect(e).toContain('rotate: 146.8');
    expect(e).toContain("x: '-50%'");
  });
  it('keeps the other axis of a 2-arg translate in the entry', () => {
    const code = COMP(`position: 'absolute', x: '-50%'`, `{ transform: 'translate(-50%, -50%)', rotate: 9 }`);
    const out = updateVariantStyleInCode(code, 'bar', 'default', { x: '-50%' });
    const e = entryOf(out);
    expect(e).toContain("transform: 'translateY(-50%)'");
    expect(e).toContain('rotate: 9');
  });
});
