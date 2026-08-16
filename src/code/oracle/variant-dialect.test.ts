import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

/** A correct two-variant component (mirrors the freeform seed's worked example). */
const component = (variantsObj: string, extraAttrs = '') => `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Card" */

const variantConfig = [
{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
{ name: 'expanded', label: 'Expanded', x: 600, y: 0 }];

const cardVariants = ${variantsObj};

const connections = [
{ from: 'default', to: 'expanded', trigger: 'click', sourceNode: 'card' },
{ from: 'expanded', to: 'default', trigger: 'click', sourceNode: 'card' }];

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div onTap={() => setVariant(variant === 'default' ? 'expanded' : variant === 'expanded' ? 'default' : variant)} data-id="card" data-name="Card" layout variants={cardVariants} ${extraAttrs}initial={initialVariant} animate={variant} style={{ display: 'flex', flexDirection: 'column', padding: '24px', backgroundColor: '#0f172a', width: variant === 'expanded' ? '420px' : '320px', ...style }}>
      <motion.p data-id="label" data-name="Label" layout style={{ position: 'relative', flex: '0 0 auto', color: '#ffffff' }}>Hello</motion.p>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

/** Adds a petal child carrying its own variants object — `defaultEntry` is the
 *  petal's default entry source; `inlineExtra` appends to its inline style. */
const petalComponent = (defaultEntry: string, inlineExtra = '') => component(`{
  default: { backgroundColor: '#0f172a' },
  'expanded': { backgroundColor: '#1e293b' },
}`).replace(
  'const connections =',
  `const petalVariants = { default: ${defaultEntry}, 'expanded': { x: -65, scale: 1, rotate: -15, opacity: 1 } };\nconst connections =`,
).replace(
  '<motion.p data-id="label"',
  `<motion.div data-id="petal" data-name="Petal" layout variants={petalVariants} initial={initialVariant} animate={variant} style={{ position: 'absolute', left: '145px', top: '145px', width: '100px', height: '100px', backgroundColor: '#ffb3ba', opacity: 0${inlineExtra} }} />\n      <motion.p data-id="label"`,
);

describe('variant dialect (design components)', () => {
  it('accepts the correct dialect (full coverage, layout in ternaries) with zero violations', () => {
    const code = component(`{
  default: { backgroundColor: '#0f172a', scale: 1 },
  'expanded': { backgroundColor: '#1e293b', scale: 1.02 },
}`);
    expect(checkFile(code, { kind: 'component' })).toEqual([]);
  });

  it('bounces layout props inside variants objects (the FLIP catastrophe)', () => {
    const code = component(`{
  default: { backgroundColor: '#0f172a', width: '320px' },
  'expanded': { backgroundColor: '#1e293b', width: '420px', flexDirection: 'row' },
}`);
    const vs = checkFile(code, { kind: 'component' });
    const hits = vs.filter((x) => x.code === 'LAYOUT_PROP_IN_VARIANT_OBJECT');
    expect(hits.length).toBe(3); // width ×2 + flexDirection
    expect(hits[0].message).toContain('inline style ternary');
  });

  it('bounces variants objects missing an entry for a variant', () => {
    const code = component(`{
  default: { backgroundColor: '#0f172a', rotate: 0 },
}`);
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('VARIANT_OBJECT_MISSING_ENTRY');
  });

  it("bounces duplicate default keys (default: AND 'default':)", () => {
    const code = component(`{
  default: { backgroundColor: '#0f172a' },
  'default': { backgroundColor: '#111111' },
  'expanded': { backgroundColor: '#1e293b' },
}`);
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('DUP_DEFAULT_KEY');
  });

  // ── VARIANT_VISIBILITY_CONDITION — an AnimatePresence show/hide condition must
  //    be an INLINE variant comparison the canvas can statically resolve; a boolean
  //    VARIABLE (const isExpanded = …) parses to null → the child shows on EVERY
  //    variant (the live "nav links visible on every variant" regression).
  const visibilityComponent = (cond: string, pre = '') => `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Card" */

const variantConfig = [
{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
{ name: 'expanded', label: 'Expanded', x: 600, y: 0 }];

const connections = [
{ from: 'default', to: 'expanded', trigger: 'click', sourceNode: 'card' },
{ from: 'expanded', to: 'default', trigger: 'click', sourceNode: 'card' }];

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  ${pre}
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div onTap={() => setVariant(variant === 'default' ? 'expanded' : variant === 'expanded' ? 'default' : variant)} data-id="card" data-name="Card" layout animate={variant} style={{ display: 'flex', flexDirection: 'column', padding: '24px', backgroundColor: '#0f172a', width: variant === 'expanded' ? '420px' : '320px', ...style }}>
      <AnimatePresence mode="popLayout">{${cond} && <motion.div data-id="badge" data-name="Badge" key="badge" layout style={{ position: 'absolute', width: '40px', height: '40px', backgroundColor: '#ffffff' }} />}</AnimatePresence>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

  it('bounces a boolean-variable AnimatePresence visibility condition (canvas shows it on every variant)', () => {
    const code = visibilityComponent('isExpanded', "const isExpanded = variant === 'expanded';");
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('VARIANT_VISIBILITY_CONDITION');
  });

  it('accepts inline variant comparisons (single, ||, and !== &&) for visibility', () => {
    expect(codes(checkFile(visibilityComponent("variant === 'expanded'"), { kind: 'component' }))).not.toContain('VARIANT_VISIBILITY_CONDITION');
    expect(codes(checkFile(visibilityComponent("variant === 'default' || variant === 'expanded'"), { kind: 'component' }))).not.toContain('VARIANT_VISIBILITY_CONDITION');
    expect(codes(checkFile(visibilityComponent("variant !== 'default' && variant !== 'expanded'"), { kind: 'component' }))).not.toContain('VARIANT_VISIBILITY_CONDITION');
  });

  it('does NOT flag an overlay AnimatePresence gated on a useState boolean (data-overlay child)', () => {
    const code = visibilityComponent('menuOpen', 'const [menuOpen, setMenuOpen] = useState(false);')
      .replace('data-id="badge" data-name="Badge"', `data-id="ov-1" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"card","side":"bottom","align":"start","offsetX":0,"offsetY":8}'`);
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('VARIANT_VISIBILITY_CONDITION');
  });

  it('bounces default-entry values missing from the inline style (the bloom-menu hidden-cards case) — transforms exempt', () => {
    // opacity/left/top live ONLY in the default entry → panel-blind; scale is
    // a motion transform and legitimately entry-only.
    const code = component(`{
  default: { backgroundColor: '#0f172a' },
  'expanded': { backgroundColor: '#1e293b' },
}`).replace(
      'const connections =',
      `const petalVariants = { default: { left: '250px', top: '230px', opacity: 0, scale: 0 }, 'expanded': { left: '410px', top: '230px', opacity: 1, scale: 1 } };\nconst connections =`,
    ).replace(
      '<motion.p data-id="label"',
      `<motion.div data-id="petal" data-name="Petal" layout variants={petalVariants} initial={initialVariant} animate={variant} style={{ position: 'absolute', width: '100px', height: '140px', backgroundColor: '#ffb3ba' }} />\n      <motion.p data-id="label"`,
    );
    const vs = checkFile(code, { kind: 'component' });
    const hit = vs.find((x) => x.code === 'DEFAULT_VALUE_NOT_IN_BASE');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('left');
    expect(hit!.message).toContain('opacity');
    expect(hit!.message).not.toContain('scale,'); // transforms exempt
  });

  it('flags a non-neutral default scale with no inline mirror (FlowerPetalCard live find 2026-06-10)', () => {
    const vs = checkFile(petalComponent('{ x: 0, scale: 0.2, rotate: 0, opacity: 0 }'), { kind: 'component' });
    const hit = vs.find((x) => x.code === 'DEFAULT_TRANSFORM_NOT_IN_BASE');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('scale: 0.2');
    expect(hit!.message).toContain('INLINE');
  });

  it('stays silent when the default scale is mirrored inline', () => {
    const vs = checkFile(petalComponent('{ x: 0, scale: 0.2, rotate: 0, opacity: 0 }', ', scale: 0.2'), { kind: 'component' });
    expect(codes(vs)).not.toContain('DEFAULT_TRANSFORM_NOT_IN_BASE');
  });

  it('stays silent for neutral default transforms (the canonical reset shape)', () => {
    const vs = checkFile(petalComponent('{ x: 0, scale: 1, rotate: 0, opacity: 0 }'), { kind: 'component' });
    expect(codes(vs)).not.toContain('DEFAULT_TRANSFORM_NOT_IN_BASE');
  });

  it('flags a non-neutral default x — rest position is left/top, never a transform', () => {
    const vs = checkFile(petalComponent('{ x: 40, scale: 1, rotate: 0, opacity: 0 }'), { kind: 'component' });
    const hit = vs.find((x) => x.code === 'DEFAULT_TRANSFORM_NOT_IN_BASE');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('left/top');
  });

  it('ignores object consts that are not referenced as variants={…}', () => {
    // a config object with a width key is NOT a variants object
    const code = component(`{
  default: { backgroundColor: '#0f172a' },
  'expanded': { backgroundColor: '#1e293b' },
}`).replace(
      'const connections =',
      `const sizeConfig = { small: { width: '100px' }, large: { width: '200px' } };\nconst connections =`,
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('LAYOUT_PROP_IN_VARIANT_OBJECT');
  });
});

// ─── Variant-reveal smoothness (the header open/close distortion class) ──────
// A per-variant reveal must carry the full smooth-shape machinery: popLayout
// on the wrapper, layout + enter/exit on the gated child, and a column-shell
// root (height auto + layout) when the revealed content is in-flow.

describe('variant reveal smoothness rules', () => {
  const nav = (rootStyle: string, gate: string) => `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Nav" */

const variantConfig = [
{ name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
{ name: 'mobile-open', label: 'Open', x: 0, y: 300 }];

const connections = [
{ from: 'default', to: 'mobile-open', trigger: 'click', sourceNode: 'nav-burger' },
{ from: 'mobile-open', to: 'default', trigger: 'click', sourceNode: 'nav-burger' }];

function Nav({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <motion.div data-id="nav-root" data-name="Nav" ${rootStyle.includes('LAYOUTLESS') ? '' : 'layout={true} '}initial={['default', initialVariant]} animate={['default', variant]} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'absolute', left: '0px', top: '0px', width: '800px', ${rootStyle.replace('LAYOUTLESS', '').trim()} ...style }}>
      <motion.div layout={true} data-id="nav-bar" data-name="Bar" onTap={() => setVariant(variant === 'default' ? 'mobile-open' : variant === 'mobile-open' ? 'default' : variant)} style={{ display: 'flex', width: '100%', height: '64px', position: 'relative', flex: '0 0 auto', order: '0' }}></motion.div>
      ${gate}
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Nav);
`;
  const GOOD_PANEL = `<AnimatePresence mode="popLayout">{variant === 'mobile-open' && <motion.div layout={true} key="panel" data-id="nav-panel" data-name="Panel" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '100%', height: 'min-content' }}></motion.div>}</AnimatePresence>`;

  it('the canonical column-shell reveal passes all four rules', () => {
    const cs = codes(checkFile(nav("height: 'auto',", GOOD_PANEL), { kind: 'component' }));
    for (const c of ['ANIMATEPRESENCE_CHILD_LAYOUT', 'ANIMATEPRESENCE_POPLAYOUT_MODE', 'VARIANT_REVEAL_ROOT_SHELL']) {
      expect(cs).not.toContain(c);
    }
  });

  it('flags a gated child without layout', () => {
    const bad = GOOD_PANEL.replace('layout={true} key="panel"', 'key="panel"');
    expect(codes(checkFile(nav("height: 'auto',", bad), { kind: 'component' }))).toContain('ANIMATEPRESENCE_CHILD_LAYOUT');
  });

  it('flags AnimatePresence without popLayout mode', () => {
    const bad = GOOD_PANEL.replace('<AnimatePresence mode="popLayout">', '<AnimatePresence>');
    expect(codes(checkFile(nav("height: 'auto',", bad), { kind: 'component' }))).toContain('ANIMATEPRESENCE_POPLAYOUT_MODE');
  });

  it('flags a fixed-height root when a variant reveals in-flow content', () => {
    const vs = checkFile(nav("height: '64px',", GOOD_PANEL), { kind: 'component' });
    const hit = vs.find((x) => x.code === 'VARIANT_REVEAL_ROOT_SHELL');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('64px');
  });

  it('flags a root without layout when a variant reveals in-flow content', () => {
    expect(codes(checkFile(nav("height: 'auto', LAYOUTLESS", GOOD_PANEL), { kind: 'component' }))).toContain('VARIANT_REVEAL_ROOT_SHELL');
  });

  it('an ABSOLUTE overlay-style reveal does not demand the column shell', () => {
    const absPanel = GOOD_PANEL.replace("position: 'relative'", "position: 'absolute'");
    expect(codes(checkFile(nav("height: '64px',", absPanel), { kind: 'component' }))).not.toContain('VARIANT_REVEAL_ROOT_SHELL');
  });
});

describe('border radius grandfathering (PROJECTION_STYLE_PROPS, 2026-08-16)', () => {
  it('radius in a variants object stays dialect-LEGAL — writers route new radius to style ternaries, but the wild files must not start bouncing', () => {
    const code = component(`{
  default: { backgroundColor: '#0f172a', borderRadius: '100px' },
  'expanded': { backgroundColor: '#1e293b', borderRadius: '24px' },
}`);
    const vs = checkFile(code, { kind: 'component' });
    expect(vs.filter((x) => x.code === 'LAYOUT_PROP_IN_VARIANT_OBJECT')).toEqual([]);
  });
});
