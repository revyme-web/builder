// Variant-entry key matching must be LEFT-ANCHORED (live find 2026-09-05).
// Unanchored, `y\s*:` matched the tail of `displa|y: 'none'` / `opacit|y:`
// and `x\s*:` the tail of `transformBo|x:`, so writing `{ y: '-50%' }` into an
// entry rewrote it to `display: '-50%'` — the hamburger bar's default entry
// in a real project. These pin the anchor and the heal for already-poisoned
// entries.
import { describe, it, expect } from 'vitest';
import { updateVariantStyleInCode } from './generator-styles';

const COMP = (defaultEntry: string) => `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 400, y: 0 },
];
const barVariants = {
  default: ${defaultEntry},
  'variant-1': { display: 'unset', rotate: -47.2 },
};
function Comp({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" data-name="Frame" style={{ position: 'relative', width: '200px', height: '200px', ...style }}>
      <motion.svg layout={true} data-id="bar" variants={barVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} viewBox="0 0 25 4" style={{ position: 'absolute', width: '26px', height: '4px', left: '50%', top: '50%', display: 'none', transformBox: 'border-box', transformOrigin: '50% 50%' }}>
        <motion.rect data-id="bar-g0" width="100%" height="100%" fill="#000" />
      </motion.svg>
    </motion.div>
  </LayoutGroup>);
}
export default Comp;`;

const entryOf = (code: string, name: string): string => {
  const m = code.match(new RegExp(`${name === 'default' ? 'default' : `'${name}'`}:\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};

describe('variant entry key anchoring', () => {
  it('writing x/y does NOT rewrite display / opacity / transformBox', () => {
    const before = COMP(`{ display: 'none', opacity: 1, transformBox: 'border-box', transformOrigin: '50% 50%', rotate: 9 }`);
    const after = updateVariantStyleInCode(before, 'bar', 'default', { x: '-50%', y: '-50%' });
    const d = entryOf(after, 'default');
    expect(d).toContain("display: 'none'");
    expect(d).toContain('opacity: 1');
    expect(d).toContain("transformBox: 'border-box'");
    expect(d).toContain("x: '-50%'");
    expect(d).toContain("y: '-50%'");
    expect(after).not.toContain("display: '-50%'");
    expect(after).not.toContain("transformBox: '-50%'");
  });

  it('REPLACES an existing x/y instead of appending duplicates', () => {
    const before = COMP(`{ display: 'none', x: '-50%', y: '-50%', rotate: 9 }`);
    const after = updateVariantStyleInCode(before, 'bar', 'default', { y: '-40%' });
    const d = entryOf(after, 'default');
    expect((d.match(/\by:/g) ?? []).length).toBe(1);
    expect(d).toContain("y: '-40%'");
    expect(d).toContain("display: 'none'");
  });

  it('HEALS a poisoned entry: `display: \'-50%\'` is dropped on the next write', () => {
    const before = COMP(`{ display: '-50%', left: '49.9938%', top: '52.1266%', transformBox: 'border-box', transformOrigin: '50% 50%', rotate: 9 }`);
    const after = updateVariantStyleInCode(before, 'bar', 'default', { rotate: '146.8' });
    const d = entryOf(after, 'default');
    expect(d).not.toContain("display: '-50%'");
    expect(d).toContain('rotate: 146.8');
    expect(d).toContain("transformBox: 'border-box'");
    // the OTHER entry is untouched
    expect(entryOf(after, 'variant-1')).toContain("display: 'unset'");
  });

  it('a quoted custom-property key still matches (anchor must not break --vars)', () => {
    const before = COMP(`{ '--ring': '1px', display: 'none' }`);
    const after = updateVariantStyleInCode(before, 'bar', 'default', { '--ring': '2px' });
    const d = entryOf(after, 'default');
    expect(d).toContain("'--ring': '2px'");
    expect((d.match(/--ring/g) ?? []).length).toBe(1);
  });
});
