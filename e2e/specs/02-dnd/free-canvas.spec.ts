// DND · Free canvas nodes and root sections (E2E_TEST_PLAN.md §2, batch D2,
// DND-052..062): the CanvasDragStrategy — canvas-node moves, snapping between
// canvas nodes (edges, centres, equal spacing, same size, rotated corners,
// breakout speed), a root section dragged out to the canvas, rotation through
// both channels, post-drop hit-testing and culling, and the drag-time paint
// promotions.
//
// Canvas coordinates: the Desktop tile sits at canvas (0, 0); canvas nodes
// live left of it (negative x) or above it, so no drag below crosses a tile
// unless the row asks for it.

import { test, expect, TILES } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  seed, pageSrc, dragBy, press, release, clickNode, guides, mark, since, lastStrategy, sampleRects,
  center, near, px, unitOf, boxSettled, quickBox, fitTo, spacingBands, paintedCorners, hoverOutline, masterSeed, masterModule, openMaster, variantEntry, canvasNodeIds,
  type Box, type Pt,
} from '../../helpers/d2';
import { glide } from '../../helpers/d6';

test.describe.configure({ timeout: 180_000 });

const EMPTY_ROOT = `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}></div>`;

/** Frame `ids` together (Fit Selection) and return the painted scale off
 *  the first one, a node of known CSS width. */
async function fitScale(editor: Editor, ids: string[], cssWidth: number): Promise<number> {
  await fitTo(editor, ids);
  const b = await boxSettled(editor, ids[0]);
  return b.width / cssWidth;
}

// ─── DND-052 ──────────────────────────────────────────────────────────

const LOOSE = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `  <div data-id="cn" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '-400px', width: '160px', height: '100px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-052 a free canvas node dragged 200px right: canvasNodes left/top px, still a canvas node, lands under the cursor with its grab offset', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(LOOSE);
  const page = editor.page();
  const s = await fitScale(editor, ['cn', 'root'], 160);
  const before = await editor.code();
  const b0 = await editor.nodeBox('cn');
  // Grab off-centre so a lost grab offset would show.
  const grab = { x: b0.width * 0.25, y: b0.height * 0.3 };
  const from = { x: b0.x + grab.x, y: b0.y + grab.y };
  const to = { x: from.x + 200 * s, y: from.y };
  const m = await mark(page);
  const d = await press(page, from);
  let samples: Array<Box | null> = [];
  try {
    await glide(page, from, to, 30);
    d.cur = to;
    await d.hold(8);
    // Record the painted box on every frame from just before the release.
    const read = await sampleRects(editor, '[data-id="cn"]', 14);
    await d.release();
    samples = await read();
  } finally {
    await release(editor, d);
  }
  expect(await lastStrategy(page, m)).toBe('canvas');
  // Every frame around and after mouse-up paints the box at release − grab
  // offset (not: a one-frame snap back to the lift position).
  const want = { x: to.x - grab.x, y: to.y - grab.y };
  const off = samples.filter(b => !b || !near(b.x, want.x, 2) || !near(b.y, want.y, 2));
  expect(off, `frames off the release point (want ${JSON.stringify(want)}): ${JSON.stringify(off)}`).toEqual([]);
  // Source: still a canvas node, px position moved by 200.
  await expect.poll(async () => Math.abs(px((await editor.style('cn')).left) + 100)).toBeLessThanOrEqual(1);
  const st = await editor.style('cn');
  expect(st.top).toBe('-400px');
  expect(unitOf(st.left)).toBe('px');
  expect(await editor.attr('cn', 'data-canvas-node')).toBe('true');
  expect(await editor.parentOf('cn')).toBeNull();
  expect(canvasNodeIds(await editor.code())).toEqual(['cn']);
  const b1 = await editor.nodeBox('cn');
  expect(near(b1.x, want.x, 1.5) && near(b1.y, want.y, 1.5)).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-053 ──────────────────────────────────────────────────────────

/** Two canvas frames left of a two-tile page; an overlay (open by default)
 *  inside the page whose top/bottom edges sit at canvas y 250 / 350. */
const PAIR = seed(pageSrc({
  tiles: TILES.two,
  imports: [`import { useState } from 'react';`, `import { AnimatePresence, motion } from 'framer-motion';`],
  hooks: [`const [menuOpen, setMenuOpen] = useState(true);`],
  root: `
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
      <div data-id="trigger" data-name="Trigger" data-overlay-trigger='{"trigger":"click"}' onClick={() => setMenuOpen(!menuOpen)} style={{ position: 'absolute', left: '600px', top: '170px', width: '200px', height: '72px', backgroundColor: '#a8c8f9' }}></div>
      <AnimatePresence>{menuOpen && (
        <motion.div key="menu" data-id="menu" data-name="Menu" data-overlay='{"type":"relative","triggerId":"trigger","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#1a1a3a' }}></motion.div>
      )}</AnimatePresence>
    </div>`,
  canvas: `
  <div data-id="fa" data-name="A" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '100px', width: '300px', height: '120px', backgroundColor: '#3355ff' }}></div>
  <div data-id="fb" data-name="B" data-canvas-node="true" style={{ position: 'absolute', left: '-450px', top: '400px', width: '100px', height: '100px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-053 two canvas frames: guides at the other\'s edges and centre, committed left equals the guide; no self-snap, overlays are not targets', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(PAIR);
  const page = editor.page();
  // A (300 wide) and B (100 wide): every alignment on the way is 50 CSS px
  // from the next, wider than the sticky snap zone at this zoom.
  const s = await fitScale(editor, ['fa', 'fb', 'trigger'], 300);
  expect(10 / s, 'sticky snap zone narrower than the 50px between alignments').toBeLessThan(40);
  // The overlay paints on the canvas only while it is being edited (setup).
  await page.evaluate(() => (window as any).__e2e.openOverlay('menu'));
  await editor.settled();
  await expect.poll(() => quickBox(editor.node('menu'))).not.toBeNull();
  const menu = (await quickBox(editor.node('menu')))!;
  await page.waitForTimeout(450);
  const a = await editor.nodeBox('fa');
  const b0 = await editor.nodeBox('fb');
  const before = await editor.code();
  const seen: Array<{ vertical: boolean; at: number }> = [];
  let selfSnap = false;
  let overlaySnap = false;
  const watch = async () => {
    const gs = await guides(page);
    seen.push(...gs);
    if (gs.some(g => g.vertical && (near(g.at, b0.x, 1) || near(g.at, b0.x + b0.width, 1) || near(g.at, b0.x + b0.width / 2, 1)))) selfSnap = true;
    if (gs.some(g => !g.vertical && (near(g.at, menu.y, 1) || near(g.at, menu.y + menu.height, 1) || near(g.at, menu.y + menu.height / 2, 1)))) overlaySnap = true;
  };

  const from = center(b0);
  const d = await press(page, from);
  try {
    // Lift: a few px only — B must not snap to its own resting edges.
    await d.moveTo({ x: from.x - 4 * s, y: from.y - 3 * s }, 4, watch);
    // Down onto the overlay's band: B's top 2 px under the overlay top (y 250 vs 252)…
    await d.moveTo({ x: from.x - 4 * s, y: from.y - 148 * s }, 30, watch);
    await d.hold(6);
    await watch();
    // …then left past A's right edge, centre and left edge (slowly), ending 2 px right of A's left.
    await d.moveTo({ x: from.x - 448 * s, y: from.y - 148 * s }, 110, watch);
    await d.hold(8);
    await watch();
  } finally {
    await release(editor, d);
  }
  const hit = (at: number) => seen.some(g => g.vertical && near(g.at, at, 1.5));
  expect(hit(a.x + a.width), 'guide at A\'s right edge').toBe(true);
  expect(hit(a.x + a.width / 2), 'guide at A\'s centre').toBe(true);
  expect(hit(a.x), 'guide at A\'s left edge').toBe(true);
  expect(selfSnap, 'no guide at B\'s own resting edges at lift').toBe(false);
  expect(overlaySnap, 'no guide at the open overlay\'s edges').toBe(false);
  // Committed: left exactly on A's left edge; top NOT pulled to the overlay's 250.
  await expect.poll(async () => (await editor.style('fb')).left).toBe('-900px');
  expect(px((await editor.style('fb')).top)).toBeCloseTo(252, -0.5);
  expect((await editor.style('fb')).top).not.toBe('250px');
  expect(await editor.attr('fb', 'data-canvas-node')).toBe('true');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-054 ──────────────────────────────────────────────────────────

/** A flex-column page with ordered sections, the tile at canvas (0, 0) and an
 *  anchor node far left so a fit leaves empty canvas left of the page. */
const SECTIONS = seed(pageSrc({
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }}></div>
</div>`,
  canvas: `  <div data-id="anchor" data-name="Anchor" data-canvas-node="true" style={{ position: 'absolute', left: '-1500px', top: '0px', width: '40px', height: '40px', backgroundColor: '#444444' }}></div>`,
}));

test('DND-054 a root section dragged out of the page onto empty canvas becomes a canvas node at the drop point; the rest renumber', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(SECTIONS);
  const page = editor.page();
  const s = await fitScale(editor, ['anchor', 'hero', 'how'], 40);
  const root = await editor.nodeBox('root');
  const before = await editor.code();
  const f0 = await editor.nodeBox('features');
  const grab = { x: f0.width * 0.3, y: f0.height * 0.5 };
  const from = { x: f0.x + grab.x, y: f0.y + grab.y };
  // Empty canvas left of the tile: canvas (−700, 350).
  const to = { x: root.x - 700 * s, y: root.y + 350 * s };
  const m = await mark(page);
  const d = await press(page, from);
  try {
    await glide(page, from, { x: from.x - 30, y: from.y }, 8);
    await glide(page, { x: from.x - 30, y: from.y }, to, 40);
    d.cur = to;
    await d.hold(10);
  } finally {
    await release(editor, d);
  }
  const strategies = (await since(page, m, '^drag:start$')).map(e => e.data.strategy);
  expect(strategies[0]).toBe('layout-lifted');
  await expect.poll(() => editor.attr('features', 'data-canvas-node')).toBe('true');
  expect(await editor.parentOf('features')).toBeNull();
  expect(canvasNodeIds(await editor.code())).toContain('features');
  const st = await editor.style('features');
  expect(st.position).toBe('absolute');
  expect(unitOf(st.left)).toBe('px');
  expect(unitOf(st.top)).toBe('px');
  // At the drop point: canvas (−700, 350) minus the grab offset.
  expect(Math.abs(px(st.left) - (-700 - grab.x / s))).toBeLessThan(3);
  expect(Math.abs(px(st.top) - (350 - grab.y / s))).toBeLessThan(3);
  expect(st.order, 'a canvas node carries no flex order').toBeUndefined();
  // The remaining sections renumbered 0..1 in their painted order.
  await expect(editor).toHaveJsxOrder('root', ['hero', 'how']);
  await expect(editor).toHaveStyle('hero', 'order', '0');
  await expect(editor).toHaveStyle('how', 'order', '1');
  const fb = await editor.nodeBox('features');
  expect(near(fb.x, to.x - grab.x, 2) && near(fb.y, to.y - grab.y, 2), 'painted under the release point').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-055 ──────────────────────────────────────────────────────────

const SPIN = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `  <div data-id="cn-spin" data-name="CanvasSpin" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '80px', width: '180px', height: '140px', backgroundColor: '#baffc9', transform: 'rotate(20deg)' }}></div>`,
}));

test('DND-055 a rotated canvas node keeps rotate(20deg) through the drop, the grab offset measured from its visual centre', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(SPIN);
  const page = editor.page();
  const s = await fitScale(editor, ['cn-spin', 'root'], 180 * Math.cos(Math.PI / 9) + 140 * Math.sin(Math.PI / 9));
  const before = await editor.code();
  const b0 = await editor.nodeBox('cn-spin');
  const c0 = center(b0);
  // Press off the visual centre.
  const from = { x: c0.x + 25, y: c0.y - 15 };
  const to = { x: from.x + 80 * s, y: from.y + 60 * s };
  let mid: Box | null = null;
  const d = await press(page, from);
  try {
    await glide(page, from, to, 24, async (_p, i) => { if (i === 12) mid = await editor.nodeBox('cn-spin'); });
    d.cur = to;
    await d.hold(6);
  } finally {
    await release(editor, d);
  }
  // Mid-drag the AABB keeps the rotated size (not: flattened).
  expect(near(mid!.width, b0.width, 2) && near(mid!.height, b0.height, 2), 'rotated mid-drag').toBe(true);
  await expect.poll(async () => (await editor.style('cn-spin')).left).not.toBe('-500px');
  expect((await editor.style('cn-spin')).transform, 'rotation survives the commit').toBe('rotate(20deg)');
  const b1 = await editor.nodeBox('cn-spin');
  expect(near(b1.width, b0.width, 1.5) && near(b1.height, b0.height, 1.5), 'still rotated after the drop').toBe(true);
  // The visual centre moved exactly by the mouse delta (grab offset kept).
  const c1 = center(b1);
  expect(Math.abs((c1.x - c0.x) - (to.x - from.x))).toBeLessThan(2);
  expect(Math.abs((c1.y - c0.y) - (to.y - from.y))).toBeLessThan(2);
  expect(Math.abs(px((await editor.style('cn-spin')).left) - (-500 + 80))).toBeLessThanOrEqual(1);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-056 ──────────────────────────────────────────────────────────

const CARD = 'components/Card.tsx';
/** Master root rotated through the motion `rotate` channel (inline + its
 *  default variant entry), no `transform` string anywhere; plus a page
 *  canvas node rotated the same way. */
const ROTATE_CHANNEL = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '200px', height: '120px', backgroundColor: '#ffcc33', rotate: '14.4', ...style }}>
    </motion.div>`, {
  config: `const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];`,
  pre: `const cardVariants = {
  default: { rotate: 14.4 },
};`,
}));

test('DND-056 a master root rotated by a motion rotate prop: the drop writes no transform and both rotate channels survive', { tag: ['@p1', '@dnd', '@cmp'] }, async ({ editor }) => {
  await editor.load(ROTATE_CHANNEL);
  const page = editor.page();
  await openMaster(editor, CARD);
  const before = await editor.code(CARD);
  const rootStyle0 = (await editor.source(CARD)).byId.get('card-root')!.style;
  expect(rootStyle0.transform).toBeUndefined();
  const angle = async () => (await editor.node('card-root').evaluate(el => {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    const mm = new DOMMatrix(t);
    return Math.round(Math.atan2(mm.b, mm.a) * 180 / Math.PI * 10) / 10;
  }));
  expect(await angle()).toBeCloseTo(14.4, 0);
  const b0 = await editor.nodeBox('card-root');
  const from = center(b0);
  let midAngle = 0;
  const m = await mark(page);
  const d = await press(page, from);
  try {
    await glide(page, from, { x: from.x + 90, y: from.y + 50 }, 20, async (_p, i) => { if (i === 14) midAngle = await angle(); });
    d.cur = { x: from.x + 90, y: from.y + 50 };
    await d.hold(6);
  } finally {
    await release(editor, d);
  }
  expect(await lastStrategy(page, m)).toBe('canvas');
  expect(midAngle, 'rotated during the drag').toBeCloseTo(14.4, 0);
  // The card moved: variantConfig x/y rewritten.
  await expect.poll(async () => /name: 'default'[^}]*x: (\d+)/.exec(await editor.code(CARD))?.[1]).not.toBe('0');
  const code = await editor.code(CARD);
  const style1 = (await editor.source(CARD)).byId.get('card-root')!.style;
  // No transform key written for a node that had none; rotate survives inline and in the entry.
  expect(style1.transform, 'no transform key').toBeUndefined();
  expect(style1.rotate).toBe('14.4');
  expect(variantEntry(code, 'card-root', 'default')).toMatchObject({ rotate: '14.4' });
  expect(await angle(), 'still painted rotated after the drop').toBeCloseTo(14.4, 0);
  const b1 = await editor.nodeBox('card-root');
  expect(Math.abs((b1.x - b0.x) - 90)).toBeLessThan(3);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── DND-057 ──────────────────────────────────────────────────────────

/** A row of three frames with equal 60px gaps and different widths (100,
 *  140, 120); D is 120 wide — the same width as C only. */
const ROW = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `
  <div data-id="ra" data-name="A" data-canvas-node="true" style={{ position: 'absolute', left: '-1200px', top: '-500px', width: '100px', height: '80px', backgroundColor: '#3355ff' }}></div>
  <div data-id="rb" data-name="B" data-canvas-node="true" style={{ position: 'absolute', left: '-1040px', top: '-500px', width: '140px', height: '80px', backgroundColor: '#33cc88' }}></div>
  <div data-id="rc" data-name="C" data-canvas-node="true" style={{ position: 'absolute', left: '-840px', top: '-500px', width: '120px', height: '80px', backgroundColor: '#ffcc33' }}></div>
  <div data-id="rd" data-name="D" data-canvas-node="true" style={{ position: 'absolute', left: '-1000px', top: '-250px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-057 equal-spacing band extends a 3-frame pattern; a same-width match draws 3 guides; unequal gaps or widths draw none', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROW);
  const page = editor.page();
  const s = await fitScale(editor, ['ra', 'rb', 'rc', 'rd'], 100);
  const B = await editor.nodeBox('rb');
  const C = await editor.nodeBox('rc');
  const before = await editor.code();
  const d0 = await editor.nodeBox('rd');
  const from = center(d0);
  // Cursor for D's CSS top-left at (x, y).
  const at = (x: number, y: number): Pt => ({ x: from.x + (x + 1000) * s, y: from.y + (y + 250) * s });
  const vGuides = async () => (await guides(page)).filter(g => g.vertical).map(g => g.at);
  const reads: Record<string, { v: number[]; bands: number; labels: string[] }> = {};
  const read = async (k: string) => { const b = await spacingBands(page); reads[k] = { v: await vGuides(), bands: b.bands.length, labels: b.labels }; };

  const d = await press(page, from);
  try {
    // Below B, left edges aligned: B is 140 wide → ONE guide, no band.
    await d.moveTo(at(-1040, -330), 30);
    await d.hold(8);
    await read('belowB');
    // Below C, left edges aligned: C has D's width → THREE guides (left, centre, right).
    await d.moveTo(at(-840, -330), 30);
    await d.hold(8);
    await read('belowC');
    // In the row, 90px right of C: the gap differs → no band.
    await d.moveTo(at(-630, -500), 30);
    await d.hold(8);
    await read('gap90');
    // 62px right of C: within the threshold of the 60px pattern → band, snaps to 60.
    await d.moveTo(at(-662, -500), 16);
    await d.hold(10);
    await read('gap60');
  } finally {
    await release(editor, d);
  }
  const near1 = (vs: number[], x: number) => vs.some(v => near(v, x, 1.5));
  expect(reads.belowB.v.length, `below B: ${JSON.stringify(reads.belowB)}`).toBe(1);
  expect(near1(reads.belowB.v, B.x)).toBe(true);
  expect(reads.belowB.bands, 'no band below B').toBe(0);
  expect(reads.belowC.v.length, `below C: ${JSON.stringify(reads.belowC)}`).toBe(3);
  for (const x of [C.x, C.x + C.width / 2, C.x + C.width]) expect(near1(reads.belowC.v, x), `guide at ${x}`).toBe(true);
  expect(reads.gap90.bands, `90px gap: ${JSON.stringify(reads.gap90)}`).toBe(0);
  expect(reads.gap60.bands, `60px gap: ${JSON.stringify(reads.gap60)}`).toBeGreaterThanOrEqual(2);
  expect(reads.gap60.labels).toContain('60px');
  // Committed where the pattern puts it: 60px right of C.
  await expect.poll(async () => (await editor.style('rd')).left).toBe('-660px');
  expect((await editor.style('rd')).top).toBe('-500px');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-058 ──────────────────────────────────────────────────────────

/** S is plain; R is rotated 30°, so its leftmost VISIBLE corner sits ~12 CSS
 *  px left of its (invisible) CSS box edge. */
const CORNER = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `
  <div data-id="sq" data-name="S" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '-300px', width: '200px', height: '200px', backgroundColor: '#3355ff' }}></div>
  <div data-id="rt" data-name="R" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '-260px', width: '120px', height: '80px', backgroundColor: '#ff66cc', transform: 'rotate(30deg)' }}></div>`,
}));

test('DND-058 a rotated canvas node snaps by its visible corner, not its invisible box edge', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CORNER);
  const page = editor.page();
  const s = await fitScale(editor, ['sq', 'rt'], 200);
  const S = await editor.nodeBox('sq');
  const before = await editor.code();
  const c0 = await paintedCorners(editor, 'rt', s);
  const leftCorner0 = Math.min(c0.TL.x, c0.TR.x, c0.BR.x, c0.BL.x);
  // Bring the visible left corner to 2 CSS px right of S's right edge.
  const dx = ((S.x + S.width) - leftCorner0) / s + 2;
  let gs: Array<{ vertical: boolean; at: number }> = [];
  await dragBy(editor, 'rt', dx, 0, s, { steps: 40, during: async () => { gs = await guides(page); } });
  expect(gs.some(g => g.vertical && near(g.at, S.x + S.width, 1.5)), `guide on S's right edge: ${JSON.stringify(gs)}`).toBe(true);
  // Painted: the leftmost visible corner sits on S's right edge…
  const c1 = await paintedCorners(editor, 'rt', s);
  const leftCorner1 = Math.min(c1.TL.x, c1.TR.x, c1.BR.x, c1.BL.x);
  expect(Math.abs(leftCorner1 - (S.x + S.width)), `visible corner at ${leftCorner1}, S right ${S.x + S.width}`).toBeLessThan(1.5);
  // …so the CSS box edge does NOT (not: snapped by the invisible AABB/box edge).
  const cssLeft = px((await editor.style('rt')).left);
  expect(Math.abs(cssLeft - (-700)), `css left ${cssLeft}`).toBeGreaterThan(8);
  // CSS left = visible corner + (rotated half-extent − half-width) = −700 + (71.96 − 60).
  expect(Math.abs(cssLeft - (-700 + (60 * Math.cos(Math.PI / 6) + 40 * Math.sin(Math.PI / 6)) - 60))).toBeLessThanOrEqual(1);
  expect((await editor.style('rt')).transform).toBe('rotate(30deg)');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-059 ──────────────────────────────────────────────────────────

const FLEXY = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `
  <div data-id="fx" data-name="Flexy" data-canvas-node="true" style={{ position: 'absolute', left: '-600px', top: '100px', width: '320px', height: '160px', display: 'flex', flexDirection: 'row', gap: '20px', padding: '20px', backgroundColor: '#222244' }}>
    <div data-id="k1" data-name="K1" style={{ position: 'relative', width: '90px', height: '110px', backgroundColor: '#ff2d75', flex: '0 0 auto' }}></div>
    <div data-id="k2" data-name="K2" style={{ position: 'relative', width: '90px', height: '110px', backgroundColor: '#33cc88', flex: '0 0 auto' }}></div>
  </div>`,
}));

test('DND-059 a flex canvas frame dropped: its children hover and select straight away', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEXY);
  const page = editor.page();
  const s = await fitScale(editor, ['fx', 'root'], 320);
  const before = await editor.code();
  const f0 = await editor.nodeBox('fx');
  // Grab the frame's own padding (top band), clear of the children.
  const from = { x: f0.x + f0.width * 0.5, y: f0.y + 8 * s };
  const to = { x: from.x + 150 * s, y: from.y + 40 * s };
  const d = await press(page, from);
  try {
    await glide(page, from, to, 24);
    d.cur = to;
    await d.hold(6);
  } finally {
    await d.release();
  }
  // Immediately — no camera move, no settle — hover the child where it now paints.
  const k2 = { x: f0.x + (20 + 90 + 20 + 45 + 150) * s, y: f0.y + (20 + 55 + 40) * s };
  // The mouse keeps moving over the child (a real hover); the camera does not.
  let wiggle = 0;
  await page.mouse.move(k2.x, k2.y);
  await expect.poll(async () => {
    wiggle++;
    await page.mouse.move(k2.x + (wiggle % 2), k2.y + (wiggle % 2));
    const h = await hoverOutline(page);
    const b = await editor.nodeBox('k2');
    return !!h && near(h.x, b.x, 2) && near(h.y, b.y, 2) && near(h.width, b.width, 2);
  }, { timeout: 2_000, message: 'hover outline on the moved child' }).toBe(true);
  await page.mouse.click(k2.x + 1, k2.y + 1);
  await expect.poll(() => editor.selection(), { timeout: 2_000 }).toEqual(['k2']);
  // The drop itself committed (sanity).
  await expect.poll(async () => px((await editor.style('fx')).left)).toBeCloseTo(-450, -0.5);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-060 ──────────────────────────────────────────────────────────

const INTO_FRAME = seed(pageSrc({
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="box" data-name="Box" style={{ position: 'absolute', left: '200px', top: '150px', width: '500px', height: '360px', backgroundColor: '#1a1a3a' }}></div>
</div>`,
  canvas: `  <div data-id="cn" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '250px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-060 a canvas node re-nested into a frame survives its tile being panned off-screen and back (no stale data-culled)', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(INTO_FRAME);
  const page = editor.page();
  const s = await fitScale(editor, ['cn', 'box'], 120);
  const box = await editor.nodeBox('box');
  const before = await editor.code();
  const c0 = await editor.nodeBox('cn');
  const from = center(c0);
  const to = center(box);
  const d = await press(page, from);
  try {
    await glide(page, from, to, 36);
    d.cur = to;
    await d.hold(12);
  } finally {
    await release(editor, d);
  }
  await expect.poll(() => editor.parentOf('cn')).toBe('box');
  expect(await editor.attr('cn', 'data-canvas-node')).toBeNull();
  // Culling marks the whole tile (its viewport element and root); check the
  // node and every ancestor up to the tile.
  const culled = () => editor.node('cn').evaluate(el => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.getAttribute('data-culled')) return e.getAttribute('data-id') ?? e.tagName;
      if (e.hasAttribute('data-viewport')) break;
    }
    return null;
  });

  // Pan the tile far off-screen (two-finger scroll) and back.
  const mid = { x: 820, y: 520 };
  await page.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(900, 0); await page.waitForTimeout(60); }
  await editor.settled();
  // Off-screen the tile IS culled (proves the pan went far enough).
  await expect.poll(culled, { timeout: 3_000, message: 'tile culled while off-screen' }).not.toBeNull();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(-900, 0); await page.waitForTimeout(60); }
  await editor.settled();
  await page.waitForTimeout(300);
  // Visible and hittable again, without a page switch.
  await expect.poll(culled, { timeout: 3_000, message: 'no stale data-culled' }).toBeNull();
  const b = await editor.nodeBox('cn');
  expect(b.width / s).toBeCloseTo(120, -0.5);
  expect(await editor.node('cn').evaluate(el => getComputedStyle(el).display)).not.toBe('none');
  await clickNode(editor, 'cn');
  await expect.poll(() => editor.selection()).toEqual(['cn']);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-061 ──────────────────────────────────────────────────────────

const BREAKOUT = seed(pageSrc({
  root: EMPTY_ROOT,
  canvas: `
  <div data-id="tgt" data-name="Target" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '100px', width: '200px', height: '200px', backgroundColor: '#3355ff' }}></div>
  <div data-id="mv" data-name="Mover" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '400px', width: '100px', height: '60px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-061 snap breakout: a fast flick breaks a snap; once snapped, breaking free needs 1.5x the breakout speed', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(BREAKOUT);
  const page = editor.page();
  await fitScale(editor, ['tgt', 'mv'], 200);
  const before = await editor.code();
  const T = (await editor.nodeBox('tgt'));
  const edge = T.x + T.width;                      // snap target: Target's right edge (screen x)
  const m0 = await editor.nodeBox('mv');
  const from = center(m0);
  const grab = from.x - m0.x;
  const y = from.y;
  const X = (offset: number) => edge + grab + offset;  // cursor x that puts the mover's RAW left at edge + offset
  const snapped = async () => (await guides(page)).some(g => g.vertical && near(g.at, edge, 1.5));
  const step = async (d: Awaited<ReturnType<typeof press>>, offset: number) => { await d.moveTo({ x: X(offset), y }, 1); return snapped(); };

  const d = await press(page, from);
  const log: string[] = [];
  try {
    // Approach slowly (2 px/frame) from +30 and settle exactly on the edge.
    await d.moveTo({ x: X(30), y }, 30);
    for (let o = 28; o >= 0; o -= 2) await step(d, o);
    await d.hold(4);
    expect(await snapped(), 'snapped after a slow approach').toBe(true);

    // 1 · Snapped: wiggle at 9 px/frame (above the 8 px breakout, below 12) — stays snapped.
    for (const o of [9, 0, 9, 0, 9, 0]) if (!(await step(d, o))) log.push(`lost the snap at 9px/frame (offset ${o})`);

    // 2 · A 14 px/frame flick breaks it, and coming straight back at 14 px/frame doesn't re-snap…
    expect(await step(d, 14), 'a 14px flick breaks the snap').toBe(false);
    expect(await step(d, 0), 'back on the edge at 14px/frame: still free').toBe(false);
    // …until the mouse slows down.
    await d.hold(3);
    expect(await snapped(), 'holding still re-snaps').toBe(true);

    // 3 · Unsnapped, 9 px/frame is already fast enough to pass the edge without a snap.
    await d.moveTo({ x: X(60), y }, 4);          // break away fast
    await d.moveTo({ x: X(-27), y }, 7);         // cross back fast (13px/frame)
    await d.hold(3);
    expect(await snapped(), 'away from the edge').toBe(false);
    for (const o of [-18, -9, 0]) if (await step(d, o)) log.push(`snapped while unsnapped at 9px/frame (offset ${o})`);
    await d.hold(3);
    expect(await snapped(), 'slowing down on the edge snaps').toBe(true);
  } finally {
    await release(editor, d);
  }
  expect(log, log.join('; ')).toEqual([]);
  // The drop happened on the snapped edge.
  await expect.poll(async () => (await editor.style('mv')).left).toBe('-500px');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-062 ──────────────────────────────────────────────────────────

const GLASS = seed(pageSrc({
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundImage: 'linear-gradient(135deg, #ff2d75, #3355ff)' }}>
  <div data-id="glass" data-name="Glass" style={{ position: 'absolute', left: '100px', top: '100px', width: '600px', height: '300px', backgroundColor: 'rgba(255, 255, 255, 0.2)', backdropFilter: 'blur(8px)' }}></div>
</div>`,
  canvas: `  <div data-id="cn" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '160px', height: '100px', backgroundColor: '#ff66cc' }}></div>`,
}));

test('DND-062 a canvas drag promotes will-change and kills backdrop-filter only for the gesture', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(GLASS);
  const page = editor.page();
  const s = await fitScale(editor, ['cn', 'glass'], 160);
  const backdrop = () => editor.node('glass').evaluate(el => getComputedStyle(el).getPropertyValue('backdrop-filter'));
  const willChange = () => editor.node('cn').evaluate(el => (el as HTMLElement).style.willChange);
  expect(await backdrop()).toBe('blur(8px)');
  const before = await editor.code();
  let mid = { willChange: '', backdrop: '' };
  await dragBy(editor, 'cn', 0, -150, s, { during: async () => { mid = { willChange: await willChange(), backdrop: await backdrop() }; } });
  expect(mid.willChange, 'promoted to its own layer during the drag').toBe('transform');
  expect(mid.backdrop, 'backdrop blur killed canvas-wide during the gesture').toBe('none');
  // After the drop: both lifted.
  await expect.poll(willChange).toBe('');
  await expect.poll(backdrop).toBe('blur(8px)');
  expect(await editor.code()).not.toContain('willChange');
  await expect.poll(async () => Math.abs(px((await editor.style('cn')).top) + 50)).toBeLessThanOrEqual(1);
  await expect(editor).toUndoInOneStep(before);
});
