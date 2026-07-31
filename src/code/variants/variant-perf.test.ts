// variant-perf.test.ts — auto perf-isolation for components whose variants
// animate LAYOUT or PAINT-HEAVY props. The class this guards: an
// auto-cycling component tweening left/top janked an entire 700-node live
// page (per-frame reflow + page-wide Layerize/Commit); contain+willChange
// on the root confines the damage to the component's own layer.

import { describe, it, expect } from 'vitest';
import { variantsAnimateHeavyProps, ensureRootPerfIsolation, isHeavyAnimatedProp } from './variant-perf';

const HEAVY = `
const pillVariants = {
  default: { left: '8px', top: '58px' },
  'variant-1': { left: '171px', top: '56px' },
};
function C() {
  return <motion.div data-id="root" style={{ position: 'absolute', width: '512px', height: '368px' }} animate={['default']} />;
}
`;

const LIGHT = `
const cardVariants = {
  default: { backgroundColor: '#fff', x: 0 },
  'hover': { backgroundColor: '#eee', x: 10, opacity: 0.9 },
};
function C() {
  return <motion.div data-id="root" style={{ position: 'absolute', width: '512px' }} />;
}
`;

describe('variantsAnimateHeavyProps', () => {
  it('detects layout props (left/top) in variant objects', () => {
    expect(variantsAnimateHeavyProps(HEAVY)).toBe(true);
  });
  it('composite/paint-light props do not trigger', () => {
    expect(variantsAnimateHeavyProps(LIGHT)).toBe(false);
  });
  it('paint-heavy props trigger', () => {
    expect(variantsAnimateHeavyProps("const vVariants = { default: { boxShadow: '0 0 4px red' } };")).toBe(true);
    expect(variantsAnimateHeavyProps("const vVariants = { default: { filter: 'blur(10px)' } };")).toBe(true);
  });
});

describe('ensureRootPerfIsolation', () => {
  it('stamps contain + willChange on the root when variants are heavy', () => {
    const out = ensureRootPerfIsolation(HEAVY);
    expect(out).toContain("contain: 'layout paint', willChange: 'transform',");
    // injected at the START of the root's style object
    expect(out.indexOf('contain:')).toBeLessThan(out.indexOf("position: 'absolute'"));
  });
  it('is idempotent', () => {
    const once = ensureRootPerfIsolation(HEAVY);
    expect(ensureRootPerfIsolation(once)).toBe(once);
  });
  it('leaves light components untouched', () => {
    expect(ensureRootPerfIsolation(LIGHT)).toBe(LIGHT);
  });
});

describe('ensureRootPerfIsolation — REMOVAL', () => {
  const LIGHT_WITH_OUR_SNIPPET = `
const cardVariants = {
  default: { backgroundColor: '#fff' },
  'hover': { backgroundColor: '#eee' },
};
function C() {
  return <motion.div data-id="root" style={{ contain: 'layout paint', willChange: 'transform', position: 'absolute', width: '512px' }} />;
}
`;
  const LIGHT_WITH_MANUAL_CONTAIN = `
const cardVariants = {
  default: { backgroundColor: '#fff' },
  'hover': { backgroundColor: '#eee' },
};
function C() {
  return <motion.div data-id="root" style={{ contain: 'paint', position: 'absolute', width: '512px' }} />;
}
`;

  it('removes OUR pair when no heavy props remain (stale promotion costs GPU memory)', () => {
    const out = ensureRootPerfIsolation(LIGHT_WITH_OUR_SNIPPET);
    expect(out).not.toContain('contain:');
    expect(out).not.toContain('willChange');
    expect(out).toContain("position: 'absolute', width: '512px'");
  });

  it('full round-trip: inject on heavy, strip when the heavy prop is edited away', () => {
    const heavy = `
const pillVariants = {
  default: { left: '8px' },
  'variant-1': { left: '171px' },
};
function C() {
  return <motion.div data-id="root" style={{ position: 'absolute', width: '512px' }} />;
}
`;
    const promoted = ensureRootPerfIsolation(heavy);
    expect(promoted).toContain("contain: 'layout paint'");
    // user re-authors the variants to composite-safe x
    const retuned = promoted.replace("default: { left: '8px' }", 'default: { x: 0 }')
                            .replace("'variant-1': { left: '171px' }", "'variant-1': { x: 163 }");
    const demoted = ensureRootPerfIsolation(retuned);
    expect(demoted).not.toContain('contain:');
    expect(demoted).not.toContain('willChange');
  });

  it('NEVER touches a hand-authored contain in a different form', () => {
    expect(ensureRootPerfIsolation(LIGHT_WITH_MANUAL_CONTAIN)).toBe(LIGHT_WITH_MANUAL_CONTAIN);
  });

  it('removal is idempotent', () => {
    const once = ensureRootPerfIsolation(LIGHT_WITH_OUR_SNIPPET);
    expect(ensureRootPerfIsolation(once)).toBe(once);
  });
});

describe('isHeavyAnimatedProp', () => {
  it('classifies the sets correctly', () => {
    for (const p of ['left', 'top', 'width', 'height', 'paddingTop', 'gap', 'fontSize']) expect(isHeavyAnimatedProp(p)).toBe(true);
    for (const p of ['filter', 'backdropFilter', 'boxShadow', 'backgroundImage', 'clipPath']) expect(isHeavyAnimatedProp(p)).toBe(true);
    for (const p of ['x', 'y', 'scale', 'rotate', 'opacity', 'color', 'backgroundColor', 'borderColor', 'borderRadius']) expect(isHeavyAnimatedProp(p)).toBe(false);
  });
});
