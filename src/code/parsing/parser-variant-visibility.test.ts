// parser-variant-visibility.test.ts — Round-trip the AnimatePresence +
// conditional render pattern into CanvasNode.hiddenOnVariants.

import { describe, expect, it } from 'vitest';
import { parseJSXToNodes } from './parser';

const wrap = (jsx: string) => `
const variantConfig = [
  { name: 'default', isPrimary: true },
  { name: 'variant-1' },
  { name: 'variant-2' },
];
function Comp() {
  return <motion.div data-id="root">
    ${jsx}
  </motion.div>;
}
`;

describe('parser hiddenOnVariants — AnimatePresence + conditional', () => {
  it('parses `variant !== "X"` as hidden on X', () => {
    const code = wrap(`
      <AnimatePresence mode="popLayout">
        {variant !== 'variant-1' && <motion.div data-id="child" key="child" />}
      </AnimatePresence>
    `);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    expect(child).toBeDefined();
    expect(Array.from(child!.hiddenOnVariants ?? [])).toEqual(['variant-1']);
  });

  it('parses `variant !== A && variant !== B` chains', () => {
    const code = wrap(`
      <AnimatePresence mode="popLayout">
        {variant !== 'variant-1' && variant !== 'variant-2' && <motion.div data-id="child" key="child" />}
      </AnimatePresence>
    `);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    const hidden = Array.from(child!.hiddenOnVariants ?? []).sort();
    expect(hidden).toEqual(['variant-1', 'variant-2']);
  });

  it('parses `variant === "X"` as hidden on every other variant', () => {
    const code = wrap(`
      <AnimatePresence mode="popLayout">
        {variant === 'variant-1' && <motion.div data-id="child" key="child" />}
      </AnimatePresence>
    `);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    const hidden = Array.from(child!.hiddenOnVariants ?? []).sort();
    expect(hidden).toEqual(['default', 'variant-2']);
  });

  it('legacy fallback: variants[X].display = "none" still produces hiddenOnVariants', () => {
    const code = `
const variantConfig = [
  { name: 'default', isPrimary: true },
  { name: 'variant-1' },
];
const childVariants = {
  default: {},
  'variant-1': { display: 'none' },
};
function Comp() {
  return <motion.div data-id="root">
    <motion.div data-id="child" variants={childVariants} />
  </motion.div>;
}
    `;
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    expect(Array.from(child!.hiddenOnVariants ?? [])).toEqual(['variant-1']);
  });

  it('hiddenOnVariants is undefined when no hide pattern present', () => {
    const code = wrap(`<motion.div data-id="child" />`);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    expect(child!.hiddenOnVariants).toBeUndefined();
  });

  it('parses `false && <element/>` as hidden on EVERY variant (drag-out form)', () => {
    // Generator emits `{false && <element/>}` when hiddenVariants ===
    // allVariants (e.g. when the user drags the element OUT to canvas;
    // it should disappear from JSX entirely). Without this case the
    // parser leaves `hiddenOnVariants` undefined and the Renderer paints
    // the element on every variant tile — visible regression bug.
    const code = wrap(`
      <AnimatePresence mode="popLayout">
        {false && <motion.div data-id="child" key="child" />}
      </AnimatePresence>
    `);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child');
    expect(child).toBeDefined();
    const hidden = Array.from(child!.hiddenOnVariants ?? []).sort();
    expect(hidden).toEqual(['default', 'variant-1', 'variant-2']);
  });

  it('user-reported case: created element on variant-1 with initialVariant condition', () => {
    // Exact source structure from the user's debug-code.jsx after creating
    // a frame on variant-1. The element should be hidden on default.
    const code = `
const variantConfig = [
  { name: 'default', isPrimary: true },
  { name: 'variant-1' },
];
function HuPoJi({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-mpo2dr6f-1">
    <AnimatePresence mode="popLayout">{initialVariant !== "default" && <motion.div layout={true} data-id="frame-mpo2dz3s-3" data-name="Frame" style={{
          position: 'absolute',
          width: '419px',
          height: '276px',
          backgroundColor: '#ffdfba'
        }} key="frame-mpo2dz3s-3" data-replica-solo="variant-1"></motion.div>}</AnimatePresence>
    </motion.div>
  </LayoutGroup>;
}
    `;
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('frame-mpo2dz3s-3');
    expect(child).toBeDefined();
    expect(Array.from(child!.hiddenOnVariants ?? [])).toEqual(['default']);
  });
});
