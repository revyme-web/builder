import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// A minimal variant design component; `rootDims` is spliced into the ROOT
// (the element carrying the ...style spread) so each test varies only its size.
const COMP = (rootDims: string) => `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Bar" */

const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
const barVariants = { default: {} };

function Bar({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="bar" variants={barVariants} initial={initialVariant} animate={initialVariant} style={{ ${rootDims} display: 'flex', flexDirection: 'column', ...style }}>
      <motion.p data-id="t" style={{ position: 'relative', order: 0, flex: '0 0 auto' }}>Hi</motion.p>
    </motion.div>
    </MotionConfig></LayoutGroup>
  );
}

export default withResponsiveProps(Bar);`;

const rp = (dims: string) => checkFile(COMP(dims), { kind: 'component' }).filter((x) => x.code === 'COMPONENT_ROOT_PERCENT_SIZE').length;

describe('component ROOT dimensions — px or auto only (master has no parent box)', () => {
  it('width 100% bounces', () => { expect(rp("width: '100%',")).toBe(1); });
  it('height 100% bounces', () => { expect(rp("height: '100%',")).toBe(1); });
  it('width + height both percent → 2 violations', () => { expect(rp("width: '100%', height: '50%',")).toBe(2); });
  it('vw / vh bounce', () => { expect(rp("width: '50vw',")).toBe(1); });
  it('fixed px width passes', () => { expect(rp("width: '1280px',")).toBe(0); });
  it('auto passes', () => { expect(rp("width: 'auto', height: 'auto',")).toBe(0); });
  it('numeric (React = px) passes', () => { expect(rp("width: 320,")).toBe(0); });
  it('px/auto variant-size ternary passes', () => { expect(rp("width: initialVariant === 'open' ? '360px' : 'auto',")).toBe(0); });
  it('a percent inside a ternary still bounces', () => { expect(rp("width: initialVariant === 'open' ? '360px' : '100%',")).toBe(1); });
});

const ar = (dims: string) => checkFile(COMP(dims), { kind: 'component' }).filter((x) => x.code === 'COMPONENT_ROOT_ASPECT_RATIO').length;

describe('component ROOT must not lock aspectRatio (builder Dimensions panel can\'t resolve it)', () => {
  it('aspectRatio on the root bounces', () => { expect(ar("width: '440px', height: 'auto', aspectRatio: '1 / 1',")).toBe(1); });
  it("string-keyed 'aspectRatio' also bounces", () => { expect(ar("width: '440px', height: 'auto', 'aspectRatio': '4 / 3',")).toBe(1); });
  it('plain px width + px height (no aspectRatio) passes', () => { expect(ar("width: '600px', height: '600px',")).toBe(0); });
  it('px width + auto height passes', () => { expect(ar("width: '600px', height: 'auto',")).toBe(0); });
  it('aspectRatio on an INNER element (not the root) does NOT bounce', () => {
    // The ...style spread marks the ROOT; an inner element with aspectRatio is fine.
    const code = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Bar" */
const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
const barVariants = { default: {} };
function Bar({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="bar" variants={barVariants} initial={initialVariant} animate={initialVariant} style={{ width: '600px', height: '600px', position: 'relative', ...style }}>
      <motion.div data-id="thumb" style={{ position: 'relative', width: '100%', height: 'auto', aspectRatio: '1 / 1', order: 0, flex: '0 0 auto' }}></motion.div>
    </motion.div>
    </MotionConfig></LayoutGroup>
  );
}
export default withResponsiveProps(Bar);`;
    expect(checkFile(code, { kind: 'component' }).filter((x) => x.code === 'COMPONENT_ROOT_ASPECT_RATIO').length).toBe(0);
  });
});

describe('ROOT detection accepts a rest-of-style spread (editor fixed-header pattern)', () => {
  // The editor generates `const { width, height, ...__instStyle } = style` + `...__instStyle`
  // on a fixed / instance-sized root. That rest identifier IS the forwarded style, so it must
  // count as the root spread — otherwise ROOT_STYLE_SPREAD (and other root checks) false-fire.
  const FIXED_HEADER = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Header" */
const variantConfig = [{ name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true }, { name: 'mobile', label: 'Mobile', x: 1400, y: 0 }];
const rootVariants = { default: {}, mobile: {} };
function Header({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const { width: __instW, height: __instH, ...__instStyle } = style ?? {};
  return (
    <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="header-root" variants={rootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', width: initialVariant === 'mobile' ? '390px' : '1280px', height: '72px', display: 'flex', ...__instStyle }}>
      <motion.p data-id="brand" style={{ position: 'relative', order: 0, flex: '0 0 auto', color: '#ffffff' }}>Finatech</motion.p>
    </motion.div>
    </MotionConfig></LayoutGroup>
  );
}
export default withResponsiveProps(Header);`;
  it('does NOT raise ROOT_STYLE_SPREAD for a ...restOfStyle root spread', () => {
    expect(checkFile(FIXED_HEADER, { kind: 'component' }).filter((x) => x.code === 'ROOT_STYLE_SPREAD').length).toBe(0);
  });
  it('still raises ROOT_STYLE_SPREAD when NOTHING forwards style', () => {
    const noSpread = FIXED_HEADER.replace(', ...__instStyle }', ' }').replace(', ...__instStyle }}', ' }}');
    expect(checkFile(noSpread, { kind: 'component' }).filter((x) => x.code === 'ROOT_STYLE_SPREAD').length).toBe(1);
  });
});

const off = (dims: string) => checkFile(COMP(dims), { kind: 'component' }).filter((x) => x.code === 'COMPONENT_ROOT_OFFSET').length;

describe('component ROOT must not carry inset props (they leak onto instances)', () => {
  it('left on the root bounces', () => { expect(off("width: '600px', height: '434px', left: '-73px',")).toBe(1); });
  it('top on the root bounces', () => { expect(off("width: '600px', height: '434px', top: '-69px',")).toBe(1); });
  it("string-keyed 'left' also bounces", () => { expect(off("width: '600px', height: '434px', 'left': '-73px',")).toBe(1); });
  it('right / bottom bounce', () => { expect(off("width: '600px', height: '434px', right: '24px',")).toBe(1); });
  // ZERO is exempt — the leak this rule guards is the master's canvas COORDINATES
  // riding onto instances, and the spread puts the INSTANCE's own style last, so
  // it wins for anything it sets. What's left is a relative instance, where
  // `left: 0` shifts nothing. The builder writes 0/0 on a root sitting at the
  // artboard origin, so flagging it asked the user to fix a no-op — on a
  // component built entirely in the editor (user report 2026-07-26).
  it('a ZERO inset does not bounce (it cannot shift anything)', () => {
    expect(off("width: '600px', height: '434px', top: '0px', left: '0px',")).toBe(0);
    expect(off("width: '600px', height: '434px', right: '0',")).toBe(0);
  });
  it('a NON-zero inset still bounces', () => {
    expect(off("width: '600px', height: '434px', top: '-69px',")).toBe(1);
  });
  it('a root with NO inset props passes', () => { expect(off("width: '600px', height: '434px',")).toBe(0); });
  it('inset props on an INNER element (absolute child) do NOT bounce', () => {
    // The ...style spread marks the ROOT; an inner absolute child legitimately
    // uses left/top (e.g. an overlay pinned inside the card).
    const code = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Bar" */
const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
const barVariants = { default: {} };
function Bar({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="bar" variants={barVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'absolute', width: '600px', height: '600px', ...style }}>
      <motion.div data-id="overlay" style={{ position: 'absolute', left: '20px', top: '20px', width: '40px', height: '40px' }}></motion.div>
    </motion.div>
    </MotionConfig></LayoutGroup>
  );
}
export default withResponsiveProps(Bar);`;
    expect(checkFile(code, { kind: 'component' }).filter((x) => x.code === 'COMPONENT_ROOT_OFFSET').length).toBe(0);
  });
});

// FIT sizing on a master root. `min-content` is what the Size tool's FIT control
// writes, and it resolves from CONTENT, not from a parent box — so it is valid
// on a parentless artboard root. The rule's own rationale is about PARENT-relative
// units; lumping the content-relative keywords in with `%` bounced a component
// built entirely in the editor (user report 2026-07-26).
describe('COMPONENT_ROOT_PERCENT_SIZE — content-relative sizes are valid on a root', () => {
  it('accepts min/max/fit-content', () => {
    expect(rp("width: '600px', height: 'min-content',")).toBe(0);
    expect(rp("width: 'fit-content', height: '434px',")).toBe(0);
    expect(rp("width: '600px', height: 'max-content',")).toBe(0);
  });
  it('still rejects PARENT-relative units', () => {
    expect(rp("width: '100%', height: '434px',")).toBe(1);
    expect(rp("width: '600px', height: '50vh',")).toBe(1);
  });
  it('still accepts px and auto', () => {
    expect(rp("width: '600px', height: 'auto',")).toBe(0);
  });
});
