// strip-positional-tiles.test.ts — a flow child must not keep a replica's inset.
//
// User report 2026-08-08: sizing a container to `auto` injects a layout on it
// and converts its absolute children to `position: relative`. That conversion
// cleared the PRIMARY tile's `left`/`top` only. The tablet and mobile bands
// still carried `left: 69.5px !important`, which shifts a relative box exactly
// as it shifts an absolute one — so both replicas rendered offset, and because
// the panel hides inset controls for a flow child there was no way to undo it.

import { describe, it, expect, beforeEach } from 'vitest';
import { stripPositionalContainerStyles, stripPositionalVariantStyles } from './generator-styles';
import { syncViewportWidths } from '../stores/viewport-store';
import { parseJSX } from '../parsing/ast-utils';

/** The reported page, reduced: one child, insets banded on both replicas. */
const PAGE = `'use client';

export default function Page() {
  return (
    <div data-id="root">
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="p-msjdasrf-5"] { width: 459px !important; left: 69.5034642635161px !important; top: 0px !important; height: min-content !important; }
      [data-id="other"] { left: 10px !important; }
    }
    @media (max-width: 375px) {
      [data-id="p-msjdasrf-5"] { width: 318px !important; left: 12.5px !important; top: 0px !important; }
    }
  \`}</style>
      <div data-id="wrap" style={{ display: 'flex' }}>
        <p data-id="p-msjdasrf-5" style={{ position: 'relative' }}>Ready to scale</p>
        <p data-id="other" style={{ position: 'absolute' }}>x</p>
      </div>
    </div>
  );
}
`;

describe('stripPositionalContainerStyles — page @media bands', () => {
  beforeEach(() => {
    syncViewportWidths([
      { id: 'desktop', width: 1440, isPrimary: true },
      { id: 'tablet', width: 768, isPrimary: false },
      { id: 'mobile', width: 375, isPrimary: false },
    ] as never);
  });

  it('removes left/top from EVERY band for the converted child', () => {
    const out = stripPositionalContainerStyles(PAGE, 'p-msjdasrf-5');
    expect(out).not.toContain('left: 69.5034642635161px');
    expect(out).not.toContain('left: 12.5px');
    expect(out).not.toMatch(/\[data-id="p-msjdasrf-5"\][^}]*top:/);
  });

  it('keeps the per-viewport values that still mean something in flow', () => {
    // The whole point of a replica override — width and height survive.
    const out = stripPositionalContainerStyles(PAGE, 'p-msjdasrf-5');
    expect(out).toContain('width: 459px !important');
    expect(out).toContain('width: 318px !important');
    expect(out).toContain('height: min-content !important');
  });

  it('leaves other nodes in the same band alone', () => {
    const out = stripPositionalContainerStyles(PAGE, 'p-msjdasrf-5');
    expect(out).toContain('[data-id="other"] { left: 10px !important; }');
  });

  it('drops a rule that held nothing BUT insets, and the band with it', () => {
    const only = PAGE.replace(
      '[data-id="p-msjdasrf-5"] { width: 318px !important; left: 12.5px !important; top: 0px !important; }',
      '[data-id="p-msjdasrf-5"] { left: 12.5px !important; top: 0px !important; }',
    );
    const out = stripPositionalContainerStyles(only, 'p-msjdasrf-5');
    expect(out).not.toContain('@media (max-width: 375px)');
  });

  it('narrows a banded transform instead of dropping it', () => {
    // A translate offsets a flow child; a rotate is still perfectly valid.
    const src = PAGE.replace(
      '[data-id="p-msjdasrf-5"] { width: 318px !important; left: 12.5px !important; top: 0px !important; }',
      '[data-id="p-msjdasrf-5"] { transform: translate(-50%, -50%) rotate(4deg) !important; }',
    );
    const out = stripPositionalContainerStyles(src, 'p-msjdasrf-5');
    expect(out).toContain('transform: rotate(4deg) !important');
    expect(out).not.toContain('translate(-50%, -50%)');
  });

  it('returns the code untouched when there is nothing positional to remove', () => {
    const clean = PAGE.replace(/left: [\d.]+px !important; top: 0px !important; ?/g, '');
    expect(stripPositionalContainerStyles(clean, 'p-msjdasrf-5')).toBe(clean);
  });

  it('the result still parses', () => {
    expect(parseJSX(stripPositionalContainerStyles(PAGE, 'p-msjdasrf-5'))).toBeTruthy();
  });
});

// ─── Component files: replicas are variant artboards, not @media bands ──────
const COMPONENT = `'use client';

const variantConfig = [
  { name: 'default', label: 'Btn', x: 0, y: 0, isPrimary: true },
  { name: 'variant-2', label: 'Wide', x: 400, y: 0 },
];

const labelVariants = {
  default: { left: '0px', top: '0px', width: '100px' },
  'variant-2': { left: '40px', top: '12px', width: '220px', rotate: '4' },
};

function Btn({ style, initialVariant = 'default', ...rest }) {
  return (
    <motion.div data-id="root-1" style={{ ...style }}>
      <motion.p data-id="label" variants={labelVariants} animate={['default', initialVariant]} style={{ position: 'relative' }}>Hi</motion.p>
    </motion.div>
  );
}
export default withResponsiveProps(Btn);
`;

describe('stripPositionalVariantStyles — component variant entries', () => {
  it('removes the insets from every variant, primary included', () => {
    const out = stripPositionalVariantStyles(COMPONENT, 'label');
    expect(out).not.toContain("left: '40px'");
    expect(out).not.toContain("top: '12px'");
    expect(out).not.toContain("left: '0px'");
  });

  it('keeps per-variant sizing and the motion channels', () => {
    const out = stripPositionalVariantStyles(COMPONENT, 'label');
    expect(out).toContain("width: '220px'");
    expect(out).toContain("width: '100px'");
    // `rotate` is an animation the user authored — never collateral.
    expect(out).toContain("rotate: '4'");
  });

  it('leaves a node with no variants object alone', () => {
    expect(stripPositionalVariantStyles(COMPONENT, 'root-1')).toBe(COMPONENT);
  });

  it('is a no-op when no variant carries an inset', () => {
    const clean = COMPONENT
      .replace("left: '0px', top: '0px', ", '')
      .replace("left: '40px', top: '12px', ", '');
    expect(stripPositionalVariantStyles(clean, 'label')).toBe(clean);
  });

  it('the result still parses', () => {
    expect(parseJSX(stripPositionalVariantStyles(COMPONENT, 'label'))).toBeTruthy();
  });

  it('does not confuse a CSS-selector data-id for the JSX one', () => {
    // The style-block trap: `[data-id="label"]` precedes the JSX occurrence.
    const withBlock = COMPONENT.replace(
      '<motion.div data-id="root-1"',
      '<style>{`[data-id="label"] { left: 5px; }`}</style><motion.div data-id="root-1"',
    );
    const out = stripPositionalVariantStyles(withBlock, 'label');
    expect(out).not.toContain("left: '40px'");
  });
});
