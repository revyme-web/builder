// variant-perf.test.ts — auto perf-isolation for components whose variants
// animate LAYOUT or PAINT-HEAVY props. The class this guards: an
// auto-cycling component tweening left/top janked an entire 700-node live
// page (per-frame reflow + page-wide Layerize/Commit); contain+willChange
// on the root confines the damage to the component's own layer.

import { describe, it, expect } from 'vitest';
import { variantsAnimateHeavyProps, ensureRootPerfIsolation, isHeavyAnimatedProp, hasPerfIsolationPair } from './variant-perf';

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

describe('variantsAnimateHeavyProps — the default entry never counts', () => {
  // Live find 2026-10-20: a Header whose link variants were default-only
  // `{ left: '0px', top: '0px' }` got `contain: 'layout paint'` + willChange,
  // which clipped its fixed dropdown at the header's 112px bottom edge.
  it('a default-only heavy entry does not tween → no isolation', () => {
    expect(variantsAnimateHeavyProps(`const linkNavBlogVariants = {\n  default: { left: '0px', top: '0px' },\n};`)).toBe(false);
  });
  it('a quoted default key is skipped too', () => {
    expect(variantsAnimateHeavyProps(`const aVariants = { 'default': { width: '10px' }, hover: { opacity: 0.5 } };`)).toBe(false);
  });
  it('a heavy prop in any non-default entry still triggers', () => {
    expect(variantsAnimateHeavyProps(`const aVariants = { default: { left: '0px' }, 'mobile-open': { left: '20px' } };`)).toBe(true);
  });
  it('commas and colons inside values never split an entry', () => {
    expect(variantsAnimateHeavyProps(`const aVariants = {\n  default: { boxShadow: '0 0 4px rgba(0,0,0,0.2)', transition: { ease: [0.4, 0, 0.2, 1] } },\n  hover: { backgroundColor: 'rgba(0, 0, 0, 0.1)', backgroundImage: 'url("a:b,c")' },\n};`)).toBe(true);
    expect(variantsAnimateHeavyProps(`const aVariants = {\n  default: { boxShadow: '0 0 4px rgba(0,0,0,0.2)' },\n  hover: { backgroundColor: 'rgba(0, 0, 0, 0.1)', x: 4 },\n};`)).toBe(false);
  });
  it('the reported Header heals: the isolation pair comes off the root', () => {
    const header = `
const frameVariants = { default: { rotate: 0 }, 'mobile': { rotate: 0 } };
const linkNavBlogVariants = {
  default: { left: '0px', top: '0px' },
};
function H() {
  return <motion.div data-id="frame" variants={frameVariants} style={{ contain: 'layout paint', willChange: 'transform',  display: 'flex', overflow: 'hidden' }} />;
}
`;
    const out = ensureRootPerfIsolation(header);
    expect(out).not.toContain('contain:');
    expect(out).not.toContain('willChange');
    expect(out).toContain("display: 'flex', overflow: 'hidden'");
  });
});

describe('variantsAnimateHeavyProps', () => {
  it('detects layout props (left/top) in variant objects', () => {
    expect(variantsAnimateHeavyProps(HEAVY)).toBe(true);
  });
  it('composite/paint-light props do not trigger', () => {
    expect(variantsAnimateHeavyProps(LIGHT)).toBe(false);
  });
  it('paint-heavy props trigger', () => {
    expect(variantsAnimateHeavyProps("const vVariants = { default: { boxShadow: 'none' }, hover: { boxShadow: '0 0 4px red' } };")).toBe(true);
    expect(variantsAnimateHeavyProps("const vVariants = { default: { filter: 'none' }, hover: { filter: 'blur(10px)' } };")).toBe(true);
  });
});

describe('ensureRootPerfIsolation', () => {
  it('stamps contain + willChange on the root when variants are heavy (overflow unset = visible → layout only)', () => {
    const out = ensureRootPerfIsolation(HEAVY);
    expect(out).toContain("contain: 'layout', willChange: 'transform',");
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
    expect(promoted).toContain("contain: 'layout', willChange");
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

// ─── Root-only + overflow-aware mode (user report 2026-10-19) ───────────────
// A "Dropdown" master: hover handlers on the root (their `=>` stopped the old
// `[^>]*` regex, so it stamped the first CHILD), root overflow visible, and the
// pair already scattered over root / Frame / Text — reprinted across lines on
// two of them, inline on the third. The Frame's copy clipped an icon whose
// caps hang past its box, and Overflow: Visible on that Frame did nothing.
const DROPDOWN = `
const divVariants = {
  default: { paddingTop: '23.5px', backgroundColor: '#ffffff' },
  'default-hover': { paddingTop: '23.5px', backgroundColor: '#ffffff' },
};
const frameVariants = {
  default: { overflow: 'hidden' },
};
function NuZaTa({ style, initialVariant = 'default', ...rest }) {
  const [variant, setVariant] = useState(initialVariant);
  return <LayoutGroup>
    <motion.div onHoverEnd={() => {
      const _n = variant === 'default-hover' ? 'default' : null;
      if (_n) setVariant(_n);
    }} layout={true} data-id="root-1" {...rest} data-mroot="root-1" variants={divVariants} style={{
      contain: 'layout paint',
      willChange: 'transform',
      display: 'flex',
      overflow: 'visible',
      position: 'absolute',
      ...style
    }} animate={['default', variant]}>
    <motion.div layout={true} data-id="frame-1" variants={frameVariants} data-name="Frame" style={{ contain: 'layout paint', willChange: 'transform',
        display: 'flex',
        overflow: 'hidden'
      }}>
      <motion.svg data-id="svg-1" viewBox="0 0 22.94 12.74" style={{ width: '11px', height: '5px', overflow: 'visible' }} />
    </motion.div><motion.p layout={true} data-id="text-1" data-name="Text" style={{
        contain: 'layout paint',
        willChange: 'transform',
        fontSize: '1.2rem'
      }}>{content}</motion.p>
  </motion.div>
  </LayoutGroup>;
}
`;

describe('ensureRootPerfIsolation — root only, mode follows the root overflow', () => {
  it('strips the stray pairs from children (inline AND reprinted) and leaves them otherwise intact', () => {
    const out = ensureRootPerfIsolation(DROPDOWN);
    const frameTag = out.slice(out.indexOf('data-id="frame-1"'), out.indexOf('data-id="svg-1"'));
    const textTag = out.slice(out.indexOf('data-id="text-1"'), out.indexOf('{content}'));
    expect(frameTag).not.toContain('contain');
    expect(frameTag).not.toContain('willChange');
    expect(frameTag).toContain("style={{ display: 'flex',");
    expect(textTag).not.toContain('contain');
    expect(textTag).toContain("fontSize: '1.2rem'");
  });

  it('a root with overflow VISIBLE keeps layout containment only — nothing hanging outside gets clipped', () => {
    const out = ensureRootPerfIsolation(DROPDOWN);
    const rootTag = out.slice(out.indexOf('<motion.div onHoverEnd'), out.indexOf('data-id="frame-1"'));
    expect(rootTag).toContain("contain: 'layout', willChange: 'transform',");
    expect(rootTag).not.toContain('layout paint');
    expect(out.match(/contain:/g)).toHaveLength(1);
  });

  it('is idempotent on the healed file', () => {
    const once = ensureRootPerfIsolation(DROPDOWN);
    expect(ensureRootPerfIsolation(once)).toBe(once);
  });

  it('injects on the ROOT even when its handlers contain `=>` (never the first child)', () => {
    const fresh = DROPDOWN.replace(/contain: 'layout paint',\s*willChange: 'transform',\s*/g, '');
    const out = ensureRootPerfIsolation(fresh);
    const rootTag = out.slice(out.indexOf('<motion.div onHoverEnd'), out.indexOf('data-id="frame-1"'));
    expect(rootTag).toContain("contain: 'layout'");
    expect(out.match(/contain:/g)).toHaveLength(1);
  });

  it('a root that already clips gets paint containment too, and flips back when it turns visible', () => {
    const hidden = DROPDOWN.replace("overflow: 'visible',\n      position", "overflow: 'hidden',\n      position");
    const clipped = ensureRootPerfIsolation(hidden);
    // Already the right mode on the root → its (reprinted) form is left as is.
    expect(clipped).toMatch(/onHoverEnd[\s\S]*style=\{\{\s*contain: 'layout paint',\s*willChange: 'transform',[\s\S]*data-id="frame-1"/);
    expect(clipped.match(/contain:/g)).toHaveLength(1);
    const reopened = ensureRootPerfIsolation(clipped.replace("overflow: 'hidden',\n      position", "overflow: 'visible',\n      position"));
    expect(reopened).toContain("contain: 'layout', willChange: 'transform',");
    expect(reopened).not.toContain('layout paint');
  });

  it('a variant state that makes the root visible rules out paint containment', () => {
    const code = `
const rootVariants = {
  default: { width: '100px', overflow: 'hidden' },
  open: { width: '300px', overflow: 'visible' },
};
function C() {
  return <motion.div data-id="root" variants={rootVariants} style={{ overflow: 'hidden', width: '100px' }} />;
}
`;
    expect(ensureRootPerfIsolation(code)).toContain("contain: 'layout', willChange");
  });

  it('a hand-authored contain on a child is not ours and stays', () => {
    const code = DROPDOWN.replace("style={{ contain: 'layout paint', willChange: 'transform',", "style={{ contain: 'paint',");
    expect(code).toContain("style={{ contain: 'paint',");
    const out = ensureRootPerfIsolation(code);
    expect(out).toContain("style={{ contain: 'paint',");
  });

  it('hasPerfIsolationPair spots the pair in either form', () => {
    expect(hasPerfIsolationPair(DROPDOWN)).toBe(true);
    expect(hasPerfIsolationPair("style={{ contain: 'layout', willChange: 'transform', x: 1 }}")).toBe(true);
    expect(hasPerfIsolationPair("style={{ contain: 'paint', x: 1 }}")).toBe(false);
  });
});

describe('isHeavyAnimatedProp', () => {
  it('classifies the sets correctly', () => {
    for (const p of ['left', 'top', 'width', 'height', 'paddingTop', 'gap', 'fontSize']) expect(isHeavyAnimatedProp(p)).toBe(true);
    for (const p of ['filter', 'backdropFilter', 'boxShadow', 'backgroundImage', 'clipPath']) expect(isHeavyAnimatedProp(p)).toBe(true);
    for (const p of ['x', 'y', 'scale', 'rotate', 'opacity', 'color', 'backgroundColor', 'borderColor', 'borderRadius']) expect(isHeavyAnimatedProp(p)).toBe(false);
  });
});
