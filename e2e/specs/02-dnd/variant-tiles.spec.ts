// DND · Component masters and variant tiles: root-tile drags, per-variant
// positions, order ternaries, drag-outs and drag-ins on variant tiles
// (E2E_TEST_PLAN.md §2, batch D6). Tiles: `desktop` (default), `variant-1`, `variant-2`.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  masterSeed, masterModule, openMaster, center, gesture, glide, pump, boxIn, prime, traces, stableCode,
  variantEntry, styleTernary, variantConfigOf, canvasNodeIds, idCount, inside, selectionBorderAt, quickBox, visualOrderIn,
  transformIn, rafs, MASTER_HEAD, MASTER_3V_CONFIG, seed, pageWithCanvas, TILES, zoomOf, type Pt,
} from '../../helpers/d6';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const CARD = 'components/Card.tsx';
const CHIPS = ['chip-1', 'chip-2', 'chip-3'];

// ─── Seeds ───────────────────────────────────────────────────────────

const chip = (n: number, color: string, extra = '') =>
  `<motion.div layout={true} data-id="chip-${n}" data-name="Chip${n}"${extra} style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '${color}', flex: '0 0 auto' }} />`;

/** Root (flex column) → row of three chips, a no-layout stage with an absolute
 *  child, and a variant-2-only element; chip-2 is purple on variant-2. */
const MASTER_BASE = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '60px', flex: '0 0 auto' }}>
        ${chip(1, '#ff2d75')}
        ${chip(2, '#33cc88', ` variants={chip2Variants} initial={['default', initialVariant]} animate={['default', initialVariant]}`)}
        ${chip(3, '#3355ff')}
      </motion.div>
      <motion.div layout={true} data-id="stage" data-name="Stage" style={{ position: 'relative', width: '100%', height: '160px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="abs" data-name="Abs" style={{ position: 'absolute', left: '20px', top: '20px', width: '60px', height: '40px', backgroundColor: '#ffcc33' }} />
      </motion.div>
      <AnimatePresence mode="popLayout">{initialVariant === 'variant-2' && (
        <motion.div layout={true} key="v2-only" data-id="v2-only" data-name="V2Only" exit={{ opacity: 0 }} style={{ position: 'relative', width: '120px', height: '30px', backgroundColor: '#ff8800', flex: '0 0 auto' }} />
      )}</AnimatePresence>
    </motion.div>`, {
  pre: `const chip2Variants = {
  default: { backgroundColor: '#33cc88' },
  'variant-2': { backgroundColor: '#aa22ff' },
};`,
}) + `
const canvasNodes = (<>
  <div data-id="loose" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '480px', top: '-260px', width: '90px', height: '50px', backgroundColor: '#7c5cff' }}></div>
</>);
`);

/** Tablet (variant-1) has its OWN chip order (3,2,1) as ternaries; Desktop and Mobile run 1,2,3. */
const MASTER_TABLET_ORDER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '60px', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="chip-1" data-name="Chip1" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: initialVariant === 'variant-1' ? 2 : 0 }} />
        <motion.div layout={true} data-id="chip-2" data-name="Chip2" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#33cc88', flex: '0 0 auto', order: initialVariant === 'variant-1' ? 1 : 1 }} />
        <motion.div layout={true} data-id="chip-3" data-name="Chip3" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#3355ff', flex: '0 0 auto', order: initialVariant === 'variant-1' ? 0 : 2 }} />
      </motion.div>
    </motion.div>`));

/** A frame that is a flex ROW only on variant-1 (layout in ternaries), block elsewhere. */
const MASTER_FLEX_ON_V1 = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="flexy" data-name="Flexy" style={{ position: 'relative', display: initialVariant === 'variant-1' ? 'flex' : 'block', flexDirection: 'row', gap: '10px', width: '100%', height: '140px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="k1" data-name="K1" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
        <motion.div layout={true} data-id="k2" data-name="K2" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#33cc88', flex: '0 0 auto' }} />
      </motion.div>
    </motion.div>`));

/** A connection-driven master (`variant` state): a frame whose child carries a degenerate order ternary. */
const MASTER_VARIANT_STATE = masterSeed('Card', `${MASTER_HEAD.replace("import React from 'react';", "import React, { useState, useEffect } from 'react';")}
${MASTER_3V_CONFIG}

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', variant]} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="outer" data-name="Outer" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '80px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="inner-k" data-name="InnerK" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: variant === 'variant-1' ? 1 : 1 }} />
      </motion.div>
      <motion.div layout={true} data-id="filler" data-name="Filler" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#333333', flex: '0 0 auto' }} />
    </motion.div>
  );
}

export default withResponsiveProps(Card);
`);

/** An svg GROUP whose second child has its own x/y delta on variant-1. */
const MASTER_SVG_GROUP = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} style={{ position: 'relative', width: '320px', height: '220px', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.svg data-id="grp" data-name="Group" viewBox="0 0 250 64" preserveAspectRatio="none" style={{ position: 'absolute', left: '30px', top: '60px', width: '250px', height: '64px', overflow: 'visible' }}>
        <motion.svg data-id="grp-s0" data-name="LetterA" x="0" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s0-g0" d="M0 0 H70 V64 H0 Z" fill="#3b82f6" /></motion.svg>
        <motion.svg data-id="grp-s1" data-name="LetterB" variants={grpS1Variants} initial={['default', initialVariant]} animate={['default', initialVariant]} x="90" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s1-g0" d="M0 0 H70 V64 H0 Z" fill="#ef4444" /></motion.svg>
      </motion.svg>
    </motion.div>`, {
  pre: `const grpS1Variants = {
  default: { x: 0, y: 0 },
  'variant-1': { x: 40, y: 30 },
};`,
}));

const BADGE_MASTER = masterModule(`
    <motion.div layout={true} data-id="badge-root" data-name="Badge" initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', display: 'flex', width: '80px', height: '30px', backgroundColor: '#ffcc33', ...style }}>
      <motion.p layout={true} data-id="badge-text" data-name="Text" style={{ fontSize: '12px', color: '#000000', position: 'relative' }}>New</motion.p>
    </motion.div>`, { name: 'Badge', config: `const variantConfig = [{ name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true }];` });

/** A master holding an INSTANCE of another design component, with an inline ternary on it. */
const MASTER_WITH_INSTANCE = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} style={{ position: 'relative', width: '320px', height: '220px', padding: '20px', backgroundColor: '#000000', ...style }}>
      <Badge data-id="badge-inst" data-name="Badge" style={{ position: 'absolute', left: '30px', top: '30px', width: '80px', height: '30px', opacity: initialVariant === 'variant-1' ? 0.5 : 1 }} />
    </motion.div>`).replace("import { withResponsiveProps } from '@revyme/runtime';", "import { withResponsiveProps } from '@revyme/runtime';\nimport Badge from '@/components/Badge';"),
{ 'components/Badge.tsx': BADGE_MASTER });

/** DND-157 page half: an absolute node rotated ONLY in the tablet band. */
const ROTATED_ON_TABLET = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '700px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 768px) and (min-width: 375.02px) {
  [data-id="rot"] { transform: rotate(30deg) !important; }
}
\`}</style>
  <div data-id="card" data-name="Card" style={{ width: '100%', height: '500px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="rot" data-name="Rot" style={{ position: 'absolute', left: '60px', top: '40px', width: '120px', height: '80px', backgroundColor: '#ffcc33' }}></div>
  </div>
</div>` }));

/** DND-157 master half: a child rotated through the `rotate` CHANNEL on variant-1. */
const MASTER_ROTATE_CHANNEL = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} style={{ position: 'relative', width: '320px', height: '220px', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="spin" data-name="Spin" variants={spinVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '40px', width: '80px', height: '50px', backgroundColor: '#ffcc33' }} />
    </motion.div>`, {
  pre: `const spinVariants = {
  default: { rotate: 0 },
  'variant-1': { rotate: 30 },
};`,
}));

// ─── Helpers ─────────────────────────────────────────────────────────

/** Rotation angle (deg) of an element's computed transform, 0 when none. */
async function angleIn(editor: Parameters<typeof prime>[0], vpId: string, id: string): Promise<number> {
  const t = await transformIn(editor, vpId, id);
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  return Math.round(Math.atan2(b, a) * 180 / Math.PI);
}

// ─── Tests ───────────────────────────────────────────────────────────

test('DND-172 dragging the variant-1 root tile moves its variantConfig slot, not the default tile', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const r = await editor.nodeBoxIn('variant-1', 'card-root');
  const d0 = await editor.nodeBoxIn('desktop', 'card-root');
  // Select and grab the root on its own bottom padding (not a child, clear of the
  // corner/edge-midpoint resize handles).
  const from = { x: r.x + r.width * 0.3, y: r.y + r.height - 7 };
  await editor.page().mouse.click(from.x, from.y);
  await editor.page().waitForTimeout(650);
  expect(await editor.selection()).toEqual(['card-root']);
  await gesture(editor, from, [{ x: from.x + 60, y: from.y + 40 }], {
    atWaypoint: async () => {
      const v1 = (await boxIn(editor, 'variant-1', 'card-root'))!;
      expect(Math.abs(v1.x - r.x) + Math.abs(v1.y - r.y), 'the variant-1 tile follows').toBeGreaterThan(20);
      const d = (await boxIn(editor, 'desktop', 'card-root'))!;
      expect(Math.abs(d.x - d0.x) + Math.abs(d.y - d0.y), 'the default tile does not move').toBeLessThan(1);
    },
  });

  // Source: variantConfig x/y updated; no inline left/top on the root.
  await expect.poll(async () => variantConfigOf(await editor.code(CARD)).find(v => v.name === 'variant-1')?.x).not.toBe('450');
  const cfg = variantConfigOf(await editor.code(CARD));
  expect(Number(cfg.find(v => v.name === 'variant-1')!.x)).toBeGreaterThan(450);
  expect(Number(cfg.find(v => v.name === 'variant-1')!.y)).toBeGreaterThan(0);
  expect(cfg.find(v => v.name === 'default')).toMatchObject({ x: '0', y: '0' });
  const rootStyle = (await editor.source(CARD)).byId.get('card-root')!.style;
  expect(rootStyle.left).toBeUndefined();
  expect(rootStyle.top).toBeUndefined();
  // Selection stays on variant-1 (not: jumped to the primary).
  expect(await editor.selection()).toEqual(['card-root']);
  expect((await traces(editor, 'drag:canvas-drop-reset-viewport')).length).toBe(0);
  const v1 = await editor.nodeBoxIn('variant-1', 'card-root');
  await expect.poll(() => selectionBorderAt(editor, v1), { message: 'overlay on the variant-1 root' }).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-173 an absolute child dragged twice on variant-1 writes the variant-1 entry and lands at the release point', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const d0 = await editor.nodeBoxIn('desktop', 'abs');
  await prime(editor, 'abs', 'variant-1');

  // ── Drag 1.
  let a = await editor.nodeBoxIn('variant-1', 'abs');
  let from = { x: a.x + a.width / 2 + 2, y: a.y + a.height / 2 + 2 };
  await gesture(editor, from, [{ x: from.x + 30, y: from.y + 20 }]);
  await expect.poll(async () => variantEntry(await editor.code(CARD), 'abs', 'variant-1')?.left ?? null).not.toBeNull();
  const e1 = variantEntry(await editor.code(CARD), 'abs', 'variant-1')!;
  expect(e1.top).toBeTruthy();
  // Base inline position untouched: only the variant-1 entry moved.
  expect((await editor.source(CARD)).byId.get('abs')!.style).toMatchObject({ left: '20px', top: '20px' });
  const d1 = await editor.nodeBoxIn('desktop', 'abs');
  expect(Math.abs(d1.x - d0.x) + Math.abs(d1.y - d0.y), 'default tile unchanged').toBeLessThan(1);
  const afterFirst = await stableCode(editor, CARD);

  // ── Drag 2 starts from the PAINTED position and lands where released.
  a = await editor.nodeBoxIn('variant-1', 'abs');
  from = { x: a.x + a.width / 2 + 2, y: a.y + a.height / 2 + 2 };
  let firstMove: { x: number; y: number } | null = null;
  const page = editor.page();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, { x: from.x + 20, y: from.y + 12 }, 10, async (_p, i) => {
      if (i === 3 && !firstMove) firstMove = await quickBox(await editor.nodeIn('variant-1', 'abs'));
    });
    await pump(page, { x: from.x + 20, y: from.y + 12 }, 6);
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  // No jump on the first frames (not: offset by the base value).
  expect(firstMove).not.toBeNull();
  expect(Math.abs(firstMove!.x - a.x) + Math.abs(firstMove!.y - a.y), 'first frames stay near the start').toBeLessThan(14);
  const a2 = await editor.nodeBoxIn('variant-1', 'abs');
  expect(Math.abs((a2.x - a.x) - 20), 'lands at the release point (x)').toBeLessThan(3);
  expect(Math.abs((a2.y - a.y) - 12), 'lands at the release point (y)').toBeLessThan(3);
  expect(variantEntry(await editor.code(CARD), 'abs', 'variant-1')).not.toEqual(e1);
  expect((await editor.source(CARD)).byId.get('abs')!.style).toMatchObject({ left: '20px', top: '20px' });
  await expect(editor).toUndoInOneStep(afterFirst, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(afterFirst);
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
});

test('DND-174 a Desktop reorder changes only the default branch; Tablet keeps its own arrangement', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_TABLET_ORDER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(await visualOrderIn(editor, 'variant-1', CHIPS)).toEqual(['chip-3', 'chip-2', 'chip-1']);
  const d1 = await editor.nodeBoxIn('desktop', 'chip-1');
  const d3 = await editor.nodeBoxIn('desktop', 'chip-3');
  await gesture(editor, center(d1), [{ x: d3.x + d3.width - 3, y: d3.y + d3.height / 2 }]);

  // Source: every chip still carries a ternary whose variant-1 branch is unchanged.
  await expect.poll(async () => styleTernary(await editor.code(CARD), 'chip-1', 'order')?.branches.default).toBe('2');
  const code = await editor.code(CARD);
  const t = Object.fromEntries(CHIPS.map(id => [id, styleTernary(code, id, 'order')!.branches]));
  expect(t['chip-1']).toMatchObject({ 'variant-1': '2', default: '2' });
  expect(t['chip-2']).toMatchObject({ 'variant-1': '1', default: '0' });
  expect(t['chip-3']).toMatchObject({ 'variant-1': '0', default: '1' });
  // No base `order` and no variants.default.order written.
  for (const id of CHIPS) expect(variantEntry(code, id, 'default')?.order).toBeUndefined();
  // Tiles: Desktop and Mobile follow the new default; Tablet keeps 3,2,1 (not: follows Desktop).
  await expect.poll(() => visualOrderIn(editor, 'desktop', CHIPS)).toEqual(['chip-2', 'chip-3', 'chip-1']);
  expect(await visualOrderIn(editor, 'variant-1', CHIPS)).toEqual(['chip-3', 'chip-2', 'chip-1']);
  expect(await visualOrderIn(editor, 'variant-2', CHIPS)).toEqual(['chip-2', 'chip-3', 'chip-1']);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-175 a reorder on the Mobile (variant-2) tile scopes order ternaries to variant-2', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  // ROW-ADJUSTED: the row expects the `default` branch to PIN the primary's sequence
  // (0,1,2). The canvas-drag path reads the primary's order from the model/computed
  // style (order-commit.ts priority 2/3), which is 0 for unordered flow children, so
  // every default branch is 0 — the primary keeps its sequence through DOM order
  // (a variant-tile reorder makes no structural JSX move), and a later primary
  // reorder materialises variant-2's branches (checked below).
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  await prime(editor, 'chip-3', 'variant-2');
  const c3 = await editor.nodeBoxIn('variant-2', 'chip-3');
  const c1 = await editor.nodeBoxIn('variant-2', 'chip-1');
  await gesture(editor, center(c3), [{ x: c1.x + 3, y: c1.y + c1.height / 2 }]);

  // Source: ternaries keyed on variant-2; chip-3's `order: 0` is written (routed, not skipped).
  await expect.poll(async () => styleTernary(await editor.code(CARD), 'chip-1', 'order')?.branches['variant-2']).toBe('1');
  const code = await editor.code(CARD);
  expect(styleTernary(code, 'chip-1', 'order')).toEqual({ branches: { 'variant-2': '1', default: '0' }, driver: 'initialVariant' });
  expect(styleTernary(code, 'chip-2', 'order')).toEqual({ branches: { 'variant-2': '2', default: '0' }, driver: 'initialVariant' });
  expect(styleTernary(code, 'chip-3', 'order')?.branches.default).toBe('0');
  expect(styleTernary(code, 'chip-3', 'order')?.branches['variant-1']).toBeUndefined();
  for (const id of CHIPS) expect(variantEntry(code, id, 'variant-2')?.order).toBeUndefined();
  await expect(editor).toHaveJsxOrder('row', CHIPS, { path: CARD });
  // Tiles: only variant-2 repaints.
  await expect.poll(() => visualOrderIn(editor, 'variant-2', CHIPS)).toEqual(['chip-3', 'chip-1', 'chip-2']);
  expect(await visualOrderIn(editor, 'desktop', CHIPS)).toEqual(CHIPS);
  expect(await visualOrderIn(editor, 'variant-1', CHIPS)).toEqual(CHIPS);
  const afterV2 = await stableCode(editor, CARD);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // A later Desktop reorder keeps variant-2's arrangement (its branches get pinned).
  const d1 = await editor.nodeBoxIn('desktop', 'chip-1');
  const d3 = await editor.nodeBoxIn('desktop', 'chip-3');
  await gesture(editor, center(d1), [{ x: d3.x + d3.width - 3, y: d3.y + d3.height / 2 }]);
  await expect.poll(() => visualOrderIn(editor, 'desktop', CHIPS)).toEqual(['chip-2', 'chip-3', 'chip-1']);
  expect(await visualOrderIn(editor, 'variant-2', CHIPS)).toEqual(['chip-3', 'chip-1', 'chip-2']);
  await stableCode(editor, CARD);
  await expect(editor).toUndoInOneStep(afterV2, { path: CARD });
});

test('DND-176 variant-2 drag-outs: a shared child splits into a baked clone; a variant-2-only child moves out', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  // ROW-ADJUSTED (as DND-152): mid-drag the lifted variant-2 copy follows the cursor;
  // the fresh-id clone is created at the drop, where it was released.
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // ── chip-2 (shown on every variant, purple on variant-2).
  await prime(editor, 'chip-2', 'variant-2');
  const c = await editor.nodeBoxIn('variant-2', 'chip-2');
  const root = await editor.nodeBoxIn('variant-2', 'card-root');
  const out = { x: c.x + c.width / 2, y: root.y + root.height + 80 };
  await gesture(editor, center(c), [out], {
    atWaypoint: async () => {
      expect(inside(out, await quickBox(await editor.nodeIn('variant-2', 'chip-2'))), 'the dragged copy follows the cursor').toBe(true);
    },
  });
  await expect.poll(async () => canvasNodeIds(await editor.code(CARD)).length).toBe(2);
  let code = await stableCode(editor, CARD);
  const clone = canvasNodeIds(code).find(id => id !== 'loose')!;
  expect(clone).not.toBe('chip-2');
  // Variant styles baked into the clone.
  expect((await editor.source(CARD)).byId.get(clone)!.style.backgroundColor).toBe('#aa22ff');
  expect(inside(out, await quickBox(editor.sandbox().locator(`[data-id="${clone}"]:visible`))), 'the clone lands at the release point').toBe(true);
  // The source is hidden on variant-2 only (not: deleted everywhere; not: a ghost left on the variant root).
  expect(await editor.childIds('row', CARD)).toEqual(CHIPS);
  expect(code).toMatch(/initialVariant !== ["']variant-2["'] && <motion\.div[^>]*data-id="chip-2"/);
  await expect(await editor.nodeIn('variant-2', 'chip-2')).toBeHidden();
  await expect(await editor.nodeIn('desktop', 'chip-2')).toBeVisible();
  await expect(await editor.nodeIn('variant-1', 'chip-2')).toBeVisible();
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // ── v2-only (rendered on variant-2 only): it moves out — no copy left in the master tree.
  await prime(editor, 'v2-only', 'variant-2');
  const v = await editor.nodeBoxIn('variant-2', 'v2-only');
  const root2 = await editor.nodeBoxIn('variant-2', 'card-root');
  await gesture(editor, center(v), [{ x: v.x + v.width / 2, y: root2.y + root2.height + 90 }]);
  await expect.poll(async () => (await editor.parentOf('v2-only', CARD))).toBeNull();
  code = await stableCode(editor, CARD);
  expect(canvasNodeIds(code)).toContain('v2-only');
  expect(idCount(code, 'v2-only')).toBe(1);
  expect(await editor.childIds('card-root', CARD)).not.toContain('v2-only');
  await expect(editor.sandbox().locator('[data-id="v2-only"]:visible')).toHaveCount(1);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-177 a primary absolute drag writes inline + variants.default together; variant tiles follow live', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const a = await editor.nodeBoxIn('desktop', 'abs');
  const v1 = await editor.nodeBoxIn('variant-1', 'abs');
  const v2 = await editor.nodeBoxIn('variant-2', 'abs');
  const from = { x: a.x + a.width / 2 + 2, y: a.y + a.height / 2 + 2 };
  await gesture(editor, from, [{ x: from.x + 30, y: from.y + 20 }], {
    atWaypoint: async () => {
      const d = (await boxIn(editor, 'desktop', 'abs'))!;
      const dx = d.x - a.x, dy = d.y - a.y;
      expect(Math.abs(dx)).toBeGreaterThan(10);
      for (const [vp, b0] of [['variant-1', v1], ['variant-2', v2]] as const) {
        const b = (await boxIn(editor, vp, 'abs'))!;
        expect(Math.abs((b.x - b0.x) - dx), `${vp} follows live`).toBeLessThan(2);
        expect(Math.abs((b.y - b0.y) - dy)).toBeLessThan(2);
      }
    },
  });
  await expect.poll(async () => (await editor.source(CARD)).byId.get('abs')!.style.left).not.toBe('20px');
  const code = await stableCode(editor, CARD);
  const inline = (await editor.source(CARD)).byId.get('abs')!.style;
  const def = variantEntry(code, 'abs', 'default');
  expect(def, 'a variants.default entry').not.toBeNull();
  expect(def!.left).toBe(inline.left);
  expect(def!.top).toBe(inline.top);
  expect(variantEntry(code, 'abs', 'variant-1')).toBeNull();
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-178 children of a frame that is flex only on variant-1 reorder on that tile', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_FLEX_ON_V1);
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(await visualOrderIn(editor, 'variant-1', ['k1', 'k2'])).toEqual(['k1', 'k2']);
  await prime(editor, 'k2', 'variant-1');
  const k1 = await editor.nodeBoxIn('variant-1', 'k1');
  const k2 = await editor.nodeBoxIn('variant-1', 'k2');
  await gesture(editor, center(k2), [{ x: k1.x + 3, y: k1.y + k1.height / 2 }], {
    atWaypoint: async () => {
      // Layout participants: a reorder placeholder opens in flexy on that tile.
      expect(await editor.sandbox().locator('[data-viewport="variant-1"] [data-placeholder-id]').count(), 'reorder placeholder on variant-1').toBeGreaterThan(0);
    },
  });
  // Effective order on variant-1 (a branch equal to the default collapses to a literal).
  const orderOn = (code: string, id: string, v: string) => { const t = styleTernary(code, id, 'order'); return t ? (t.branches[v] ?? t.branches.default) : null; };
  await expect.poll(async () => orderOn(await editor.code(CARD), 'k1', 'variant-1')).toBe('1');
  expect(orderOn(await editor.code(CARD), 'k2', 'variant-1')).toBe('0');
  expect(styleTernary(await editor.code(CARD), 'k1', 'order')?.driver).toBe('initialVariant');
  await expect.poll(() => visualOrderIn(editor, 'variant-1', ['k1', 'k2'])).toEqual(['k2', 'k1']);
  await expect(editor).toHaveJsxOrder('flexy', ['k1', 'k2'], { path: CARD });
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-179 a canvas node dropped into the variant-1 tile is hidden on the other variants via visibility', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: Escape does not cancel an element drag (the release commits), the variant-2 copy is painted VISIBLE mid-drag, and the drop leaves a conditional child without layout (oracle ANIMATEPRESENCE_CHILD_LAYOUT)');
  await editor.load(MASTER_BASE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const stage = await editor.nodeBoxIn('variant-1', 'stage');
  const into = center(stage);
  const rootBg = () => editor.sandbox().locator('[data-node-id="variant-1-card-root"]').first().evaluate(el => getComputedStyle(el).backgroundColor);
  const bg0 = await rootBg();
  const otherCopiesHidden = async (label: string) => {
    for (const vp of ['desktop', 'variant-2']) {
      const copy = await editor.nodeIn(vp, 'loose');
      if ((await copy.count()) === 0) continue;
      expect.soft(await copy.isVisible(), `${vp} copy painted hidden ${label}`).toBe(false);
    }
  };

  // ── Gesture 1: enter variant-1, then CANCEL with Escape.
  await prime(editor, 'loose');
  const loose = await editor.nodeBox('loose');
  const from = { x: loose.x + loose.width / 2 + 3, y: loose.y + loose.height / 2 + 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, into, 14);
    await pump(page, into, 8);
    await otherCopiesHidden('mid-drag');
    expect(await rootBg(), 'variant-1 never darkened').toBe(bg0);
    await page.keyboard.press('Escape');
    await rafs(page, 4);
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  // Cancelling undoes the paint and writes nothing. (Today Escape is not wired for
  // element drags — DragCoordinator.cancel() has no key binding — so the release
  // commits the drop; restore the seed and carry on with the drop half.)
  await stableCode(editor, CARD);
  expect.soft(await editor.code(CARD), 'Escape cancelled the gesture: nothing written').toBe(before);
  for (let i = 0; i < 3 && (await editor.code(CARD)) !== before; i++) await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
  await expect(editor.sandbox().locator('[data-id="loose"]:visible')).toHaveCount(1);
  expect(await editor.parentOf('loose', CARD)).toBeNull();

  // ── Gesture 2: drop it into variant-1's stage.
  await prime(editor, 'loose');
  const l2 = await editor.nodeBox('loose');
  await gesture(editor, { x: l2.x + l2.width / 2 + 3, y: l2.y + l2.height / 2 + 2 }, [into], {
    atWaypoint: async () => {
      await otherCopiesHidden('mid-drag (2)');
      expect(await rootBg()).toBe(bg0);
    },
  });
  await expect.poll(() => editor.parentOf('loose', CARD)).toBe('stage');
  const code = await stableCode(editor, CARD);
  // setVariantVisibility: an AnimatePresence conditional, solo on variant-1 — no inline display:none.
  expect(code).toMatch(/initialVariant === ["']variant-1["'] && <[\w.]+[^>]*data-id="loose"/);
  expect((await editor.source(CARD)).byId.get('loose')!.style.display).toBeUndefined();
  await expect(await editor.nodeIn('variant-1', 'loose')).toBeVisible();
  await expect(await editor.nodeIn('desktop', 'loose')).toBeHidden();
  await expect(await editor.nodeIn('variant-2', 'loose')).toBeHidden();
  expect.soft(await editor.newOracleViolations(), 'the builder\'s own oracle accepts the drop').toEqual([]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
});

test('DND-180 dragging a master frame out flattens descendant variant ternaries', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: the flattened descendant order lands as a bare number (`order: 1`) — oracle ORDER_MUST_BE_STRING; the reorder engine can't read it");
  await editor.load(MASTER_VARIANT_STATE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const outer = await editor.nodeBoxIn('desktop', 'outer');
  const root = await editor.nodeBoxIn('desktop', 'card-root');
  await editor.page().mouse.click(outer.x + outer.width * 0.7, outer.y + outer.height * 0.3);
  await editor.page().waitForTimeout(650);
  expect(await editor.selection()).toEqual(['outer']);
  // Grab outer's own empty area (right of its child, clear of the resize handles).
  const from = { x: outer.x + outer.width * 0.7, y: outer.y + outer.height * 0.3 };
  await gesture(editor, from, [{ x: from.x, y: root.y + root.height + 120 }]);

  const code = await stableCode(editor, CARD);
  const moved = canvasNodeIds(code);
  expect(moved.length, 'the frame (or its clone) is on the canvas').toBe(1);
  // The descendant's ternary is flattened to its default branch at module scope.
  const canvasSeg = code.slice(code.indexOf('const canvasNodes'));
  expect(canvasSeg).not.toMatch(/\bvariant\s*===/);
  const kid = (await editor.source(CARD)).nodes.find(n => n.parentId === moved[0]);
  expect(kid, 'the child travelled with the frame').toBeTruthy();
  expect(kid!.style.order).toBe('1');
  // …as the QUOTED string the reorder engine reads (not a bare number).
  expect.soft(canvasSeg, 'flattened order is a quoted string').toMatch(new RegExp(`data-id="${kid!.id}"[^>]*order: '1'`));
  // No "References undefined identifier: variant" validation block.
  const blocked = (await traces(editor, 'validation|rollback|blocked')).filter(e => JSON.stringify(e.data ?? '').includes('undefined identifier'));
  expect(blocked).toEqual([]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-181 a group child with a variant-1 x/y delta drags from its painted position and commits the variant values', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(MASTER_SVG_GROUP);
  await openMaster(editor);
  const before = await editor.code(CARD);
  // Setup: group isolation (the double-click drill-down) on the variant-1 tile.
  await prime(editor, 'grp', 'variant-1');
  await page.evaluate(() => (window as any).__e2e.isolateGroupChild('grp', 'grp-s1'));
  await editor.select(['grp-s1'], 'variant-1');
  await page.waitForTimeout(300);
  const s1 = await editor.nodeBoxIn('variant-1', 'grp-s1');
  const s1d = await editor.nodeBoxIn('desktop', 'grp-s1');
  const zoom = (await editor.nodeBoxIn('variant-1', 'grp')).width / 250;
  // The variant-1 copy paints at base + its delta (40, 30).
  expect(Math.abs((s1.x - (await editor.nodeBoxIn('variant-1', 'grp')).x) - (90 + 40) * zoom)).toBeLessThan(3);

  const from = { x: s1.x + s1.width / 2 + 2, y: s1.y + s1.height / 2 + 2 };
  const to = { x: from.x + 24, y: from.y + 18 };
  const samples: Array<{ dx: number; dy: number; px: number; py: number }> = [];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, to, 12, async (p) => {
      const b = await quickBox(await editor.nodeIn('variant-1', 'grp-s1'));
      if (b) samples.push({ dx: b.x - s1.x, dy: b.y - s1.y, px: p.x - from.x, py: p.y - from.y });
    });
    await pump(page, to, 6);
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  // No jump: every frame's offset equals the cursor's travel (grab point held).
  expect(samples.length).toBeGreaterThan(6);
  for (const s of samples.slice(2)) {
    expect(Math.abs(s.dx - s.px) + Math.abs(s.dy - s.py), `frame offset ${JSON.stringify(s)}`).toBeLessThan(5);
  }
  // Commit: the variant-1 entry carries the new delta; base attrs and the default entry stay.
  await expect.poll(async () => variantEntry(await editor.code(CARD), 'grp-s1', 'variant-1')?.x).not.toBe('40');
  const code = await stableCode(editor, CARD);
  const e1 = variantEntry(code, 'grp-s1', 'variant-1')!;
  expect(Number(e1.x)).toBeGreaterThan(40);
  expect(Number(e1.y)).toBeGreaterThan(30);
  expect(variantEntry(code, 'grp-s1', 'default')).toMatchObject({ x: '0', y: '0' });
  expect((await editor.source(CARD)).byId.get('grp-s1')!.attrs).toMatchObject({ x: '90', y: '0' });
  const s1d2 = await editor.nodeBoxIn('desktop', 'grp-s1');
  expect(Math.abs(s1d2.x - s1d.x) + Math.abs(s1d2.y - s1d.y), 'default tile copy unchanged').toBeLessThan(1);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-182 a primary drag of an instance child emits only the variant-style write', { tag: ['@p2', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_WITH_INSTANCE);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const b = await editor.nodeBoxIn('desktop', 'badge-inst');
  await prime(editor, 'badge-inst');
  const from = { x: b.x + b.width / 2 + 2, y: b.y + b.height / 2 + 2 };
  const mark = (await traces(editor, 'queueMutation')).length;
  await gesture(editor, from, [{ x: from.x + 40, y: from.y + 30 }]);
  const code = await stableCode(editor, CARD);
  const queued = (await traces(editor, 'queueMutation')).slice(mark).map(e => e.data).filter((d: any) => d?.nodeId === 'badge-inst');
  expect(queued.map((d: any) => d.type), 'mutations queued for the instance').toContain('updateVariantStyle');
  expect(queued.map((d: any) => d.type), 'no plain style write').not.toContain('updateStyles');
  // Its inline ternary survives (not clobbered by a plain style write).
  expect(styleTernary(code, 'badge-inst', 'opacity')).toEqual({ branches: { 'variant-1': '0.5', default: '1' }, driver: 'initialVariant' });
  expect(code).not.toBe(before);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

test('DND-157 a Desktop drag keeps a Tablet-only band rotation and a variant-1 rotate channel', { tag: ['@p1', '@dnd', '@tiles', '@cmp'] }, async ({ editor }) => {
  test.fail(true, "BUG: a primary drag of a master child paints `transform: rotate(0deg) !important` on the variant-1 copy mid-drag — its rotate-channel rotation is lost until mouseup");
  const SEED = { format: 'revyme-v1' as const, files: { ...ROTATED_ON_TABLET.files, [CARD]: MASTER_ROTATE_CHANNEL.files[CARD] } };

  // ── Page: rotated only in the tablet band.
  await editor.load(SEED, { fit: true });
  const before = await editor.code();
  const zoom = await zoomOf(editor, 'tablet', 768);
  expect(await angleIn(editor, 'tablet', 'rot')).toBe(30);
  const d = await editor.nodeBoxIn('desktop', 'rot');
  const t0 = await editor.nodeBoxIn('tablet', 'rot');
  const from = { x: d.x + d.width / 2 + 2, y: d.y + d.height / 2 + 2 };
  await gesture(editor, from, [{ x: from.x + 60 * zoom, y: from.y + 30 * zoom }], {
    atWaypoint: async () => {
      expect(await angleIn(editor, 'tablet', 'rot'), 'tablet keeps its rotation through the live fan-out').toBe(30);
      expect(await angleIn(editor, 'desktop', 'rot')).toBe(0);
      const t = (await boxIn(editor, 'tablet', 'rot'))!;
      expect(Math.abs(t.x - t0.x), 'and still follows the drag').toBeGreaterThan(5);
    },
  });
  await expect(editor).not.toHaveStyle('rot', 'left', '60px');
  await expect(editor).toHaveBandStyle(768, 'rot', 'transform', 'rotate(30deg)', { important: true });
  await expect.poll(() => angleIn(editor, 'tablet', 'rot'), { message: 'rotation survives the commit (no bare translate)' }).toBe(30);
  const tSettled = await editor.nodeBoxIn('tablet', 'rot');
  await editor.page().waitForTimeout(600);
  expect(await angleIn(editor, 'tablet', 'rot')).toBe(30);
  const tLater = await editor.nodeBoxIn('tablet', 'rot');
  expect(Math.abs(tLater.x - tSettled.x) + Math.abs(tLater.y - tSettled.y), 'no snap back after mouseup').toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // ── Master: variant-1 rotates `spin` through the motion `rotate` channel.
  await openMaster(editor);
  const mBefore = await editor.code(CARD);
  expect(await angleIn(editor, 'variant-1', 'spin')).toBe(30);
  const s = await editor.nodeBoxIn('desktop', 'spin');
  const v0 = await editor.nodeBoxIn('variant-1', 'spin');
  const sFrom = { x: s.x + s.width / 2 + 2, y: s.y + s.height / 2 + 2 };
  await gesture(editor, sFrom, [{ x: sFrom.x + 25, y: sFrom.y + 15 }], {
    atWaypoint: async () => {
      expect.soft(await angleIn(editor, 'variant-1', 'spin'), 'variant-1 keeps its rotate channel mid-drag').toBe(30);
      const v = (await boxIn(editor, 'variant-1', 'spin'))!;
      expect(Math.abs(center(v).x - center(v0).x), 'variant-1 follows the primary live').toBeGreaterThan(5);
    },
  });
  await expect.poll(async () => (await editor.source(CARD)).byId.get('spin')!.style.left).not.toBe('40px');
  expect(variantEntry(await editor.code(CARD), 'spin', 'variant-1')?.rotate).toBe('30');
  await expect.poll(() => angleIn(editor, 'variant-1', 'spin'), { message: 'variant-1 still rotated after the commit' }).toBe(30);
  await editor.page().waitForTimeout(600);
  expect(await angleIn(editor, 'variant-1', 'spin')).toBe(30);
  await expect(editor).toUndoInOneStep(mBefore, { path: CARD });
});
