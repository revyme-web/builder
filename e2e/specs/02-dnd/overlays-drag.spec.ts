// DND · Overlays: dragging relative overlays (offset from the trigger, per
// replica / per variant), snapping to the trigger, fixed modals, and triggers
// that move, reparent or live on the canvas (E2E_TEST_PLAN.md §2, batch D7).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { centerOn, emptyCanvasPoint, CARD_MASTER } from '../../helpers/d3';
import { parses } from '../../helpers/d5';
import { FIXED_OVERLAY } from '../../helpers/d5';
import { masterSeed, openMaster } from '../../helpers/d6';
import {
  seed, pageSrc, TILES, pressNode, drop, engaged, boxOf, mark, since, stableCode, overlayConfig, openOverlay,
  wiggle, snapGuides, center, near, prime, idCount, domCount, PAGE_SERVER_WRAPPER, type Box,
} from '../../helpers/d7';

test.describe.configure({ timeout: 180_000 });

const OV_IMPORTS = ["import { useState } from 'react';", "import { AnimatePresence, motion } from 'framer-motion';"];

/** OVERLAY_ON_FLEX_CHILD in the builder dialect (`<id>Open` state): a flex-row
 *  root of three cards, card2 the trigger, `ov-a` a relative overlay under it
 *  (root's last child). */
function flexChildOverlay(opts: { offsetY?: number; gap?: number } = {}) {
  return seed(pageSrc({
    imports: OV_IMPORTS,
    hooks: ['const [ovAOpen, setOvAOpen] = useState(false);'],
    root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '${opts.gap ?? 20}px', alignItems: 'flex-start', width: '1440px', minHeight: '600px', padding: '60px', backgroundColor: '#ffffff' }}>
  <div data-id="card1" data-name="Card1" style={{ position: 'relative', flex: '0 0 auto', width: '400px', height: '220px', backgroundColor: '#f9a8a8', order: '0' }}></div>
  <div data-id="card2" data-name="Card2" data-overlay-trigger='{"targetId":"ov-a","trigger":"click","dismiss":"outside"}' onClick={() => setOvAOpen(!ovAOpen)} style={{ position: 'relative', flex: '0 0 auto', width: '400px', height: '220px', backgroundColor: '#a8c8f9', order: '1' }}></div>
  <div data-id="card3" data-name="Card3" style={{ position: 'relative', flex: '0 0 auto', width: '400px', height: '220px', backgroundColor: '#a8f9b8', order: '2' }}></div>
  <AnimatePresence>{ovAOpen && (
    <motion.div key="ov-a" data-id="ov-a" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"card2","side":"bottom","align":"center","offsetX":0,"offsetY":${opts.offsetY ?? 8}}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#7CBFFF' }}>
    </motion.div>
  )}</AnimatePresence>
</div>`,
  }));
}

const close = (a: Box | null, b: Box | null, tol = 1.5) =>
  !!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.width, b.width, tol) && near(a.height, b.height, tol);

// ─── DND-202 ─────────────────────────────────────────────────────────

test('DND-202 relative overlay on the primary: follows live, commits trigger-relative offsets, no mouseup jump on the first drag, clamped to the viewport', { tag: ['@p0', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(flexChildOverlay());
  await centerOn(editor, ['root']);
  await openOverlay(editor, 'ov-a');
  const before = await editor.code();
  const ov0 = (await boxOf(editor, 'ov-a'))!;
  const trig = (await boxOf(editor, 'card2'))!;
  const scale = trig.width / 400;
  const m = await mark(page);

  // 1. The FIRST drag: 80 × 60 screen px.
  let live: Box | null = null;
  const frames: Array<Box | null> = [];
  {
    const { d, box } = await pressNode(editor, 'ov-a');
    try {
      await d.moveBy(80, 60, 14, async () => { frames.push(await boxOf(editor, 'ov-a')); });
      await engaged(editor, 'ov-a', box);
      await wiggle(d, 4);
      live = await boxOf(editor, 'ov-a');
    } finally {
      await drop(editor, d);
    }
  }
  expect((await since(page, m, '^drag:start$')).map(e => e.data.strategy)).toEqual(['overlay']);
  // Live follow: every frame moved with the cursor (monotonic, never stuck at the start).
  expect(frames.filter(f => f && f.x > ov0.x + 1).length, 'the overlay followed live').toBeGreaterThanOrEqual(10);
  expect(near(live!.x - ov0.x, 80, 2) && near(live!.y - ov0.y, 60, 2), `live delta ${live!.x - ov0.x}, ${live!.y - ov0.y}`).toBe(true);
  // Commit: offsets relative to the trigger = effective start (0, 8) + the drag delta.
  await expect.poll(async () => (await overlayConfig(editor, 'ov-a'))?.offsetX).not.toBe(0);
  await stableCode(editor);
  const cfg = (await overlayConfig(editor, 'ov-a'))!;
  expect(cfg).toMatchObject({ type: 'relative', triggerId: 'card2', side: 'bottom', align: 'center' });
  expect(Math.abs(cfg.offsetX - 80 / scale), `offsetX ${cfg.offsetX} ≈ ${80 / scale}`).toBeLessThanOrEqual(2);
  expect(Math.abs(cfg.offsetY - (8 + 60 / scale)), `offsetY ${cfg.offsetY} ≈ ${8 + 60 / scale}`).toBeLessThanOrEqual(2);
  expect(cfg.responsive ?? null, 'no per-viewport override from a primary drag').toBeNull();
  // No mouseup jump: the committed render paints exactly where the live drag left it.
  expect(close(await boxOf(editor, 'ov-a'), live), 'live box == committed box').toBe(true);
  await expect(editor).toUndoInOneStep(before);

  // 2. Far past the viewport's right edge: the overlay stays inside the viewport.
  const root = (await boxOf(editor, 'root'))!;
  let far: Box | null = null;
  {
    const { d } = await pressNode(editor, 'ov-a');
    try {
      await d.moveBy(700, 0, 60);
      await wiggle(d, 4);
      far = await boxOf(editor, 'ov-a');
    } finally {
      await drop(editor, d);
    }
  }
  expect(far!.x + far!.width, 'clamped live inside the viewport').toBeLessThanOrEqual(root.x + root.width + 1);
  expect(far!.x - ov0.x, 'it did travel').toBeGreaterThan(200);
  await stableCode(editor);
  const after = (await boxOf(editor, 'ov-a'))!;
  expect(after.x + after.width, 'clamped after the commit').toBeLessThanOrEqual(root.x + root.width + 1);
  expect(close(after, far), 'no jump on the second drag either').toBe(true);
});

// ─── DND-203 / DND-204 ───────────────────────────────────────────────

/** Three tiles; Tablet owns its overlay offset (40, 40), Mobile has none. */
const TABLET_OWNS_OFFSET = seed(pageSrc({
  tiles: TILES.three,
  imports: OV_IMPORTS,
  hooks: ['const [menuOpen, setMenuOpen] = useState(false);'],
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '100%', minHeight: '700px', padding: '40px', backgroundColor: '#0d0d1a' }}>
  <div data-id="trig" data-name="Trigger" data-overlay-trigger='{"targetId":"menu","trigger":"click","dismiss":"outside"}' onClick={() => setMenuOpen(!menuOpen)} style={{ position: 'relative', flex: '0 0 auto', width: '200px', height: '80px', backgroundColor: '#663399', order: '0' }}></div>
  <AnimatePresence>{menuOpen && (
    <motion.div key="menu" data-id="menu" data-name="Menu" data-overlay='{"type":"relative","triggerId":"trig","side":"bottom","align":"center","offsetX":0,"offsetY":8,"responsive":{"768":{"offsetX":40,"offsetY":40}},"responsiveBp":[1440,768,375]}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '160px', height: '80px', backgroundColor: '#ffcc33' }}>
    </motion.div>
  )}</AnimatePresence>
</div>`,
}));

const VPS = ['desktop', 'tablet', 'mobile'] as const;
async function menuBoxes(editor: import('../../helpers/editor').Editor): Promise<Record<string, Box | null>> {
  const out: Record<string, Box | null> = {};
  for (const vp of VPS) out[vp] = await boxOf(editor, 'menu', vp);
  return out;
}

test.describe('tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-203 Desktop overlay drag: Desktop and override-free tiles move live from their own trigger; the Tablet override stays put', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_OWNS_OFFSET, { fit: true });
    await openOverlay(editor, 'menu');
    for (const vp of VPS) await expect.poll(async () => !!(await boxOf(editor, 'menu', vp)), { message: `${vp} copy open` }).toBe(true);
    const before = await editor.code();
    const b0 = await menuBoxes(editor);
    const scale = (await boxOf(editor, 'trig', 'desktop'))!.width / 200;
    const mid: Array<Record<string, Box | null>> = [];
    {
      const { d, box } = await pressNode(editor, 'menu', { vpId: 'desktop' });
      try {
        await d.moveBy(30, 40, 10, async () => { mid.push(await menuBoxes(editor)); });
        await engaged(editor, 'menu', box, 'desktop');
        await wiggle(d, 4);
        mid.push(await menuBoxes(editor));
      } finally {
        await drop(editor, d);
      }
    }
    const last = mid[mid.length - 1];
    // Desktop and Mobile (no override) moved by the drag delta, each under its own trigger.
    for (const vp of ['desktop', 'mobile']) {
      expect(near(last[vp]!.x - b0[vp]!.x, 30, 2) && near(last[vp]!.y - b0[vp]!.y, 40, 2), `${vp} moved live (${last[vp]!.x - b0[vp]!.x}, ${last[vp]!.y - b0[vp]!.y})`).toBe(true);
    }
    // Tablet owns its offset: never moved, on any frame (not: synced, then snapped back).
    for (const f of mid) expect(close(f.tablet, b0.tablet), 'tablet stays put mid-drag').toBe(true);
    await stableCode(editor);
    const cfg = (await overlayConfig(editor, 'menu'))!;
    expect(Math.abs(cfg.offsetX - 30 / scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(cfg.offsetY - (8 + 40 / scale))).toBeLessThanOrEqual(2);
    expect(cfg.responsive?.['768'], 'tablet override untouched').toEqual({ offsetX: 40, offsetY: 40 });
    expect(cfg.responsive?.['375'] ?? null, 'no mobile override written').toBeNull();
    const after = await menuBoxes(editor);
    expect(close(after.tablet, b0.tablet), 'tablet unchanged after the commit').toBe(true);
    for (const vp of ['desktop', 'mobile']) expect(close(after[vp], last[vp], 2), `${vp} committed where it was dropped`).toBe(true);
    await expect(editor).toUndoInOneStep(before);
  });

  test('DND-204 Tablet overlay drag commits responsive[768] offsets only; Desktop unchanged', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_OWNS_OFFSET, { fit: true });
    await openOverlay(editor, 'menu');
    await expect.poll(async () => !!(await boxOf(editor, 'menu', 'tablet'))).toBe(true);
    const before = await editor.code();
    const b0 = await menuBoxes(editor);
    const scale = (await boxOf(editor, 'trig', 'tablet'))!.width / 200;
    await prime(editor, 'menu', 'tablet');
    const mid: Array<Record<string, Box | null>> = [];
    {
      const { d, box } = await pressNode(editor, 'menu', { vpId: 'tablet' });
      try {
        // −50 px: lands well clear of the trigger's snap lines (offsets ±20 and 0).
        await d.moveBy(-50, 30, 12, async () => { mid.push(await menuBoxes(editor)); });
        await engaged(editor, 'menu', box, 'tablet');
        await wiggle(d, 4);
        mid.push(await menuBoxes(editor));
      } finally {
        await drop(editor, d);
      }
    }
    const last = mid[mid.length - 1];
    expect(near(last.tablet!.x - b0.tablet!.x, -50, 2) && near(last.tablet!.y - b0.tablet!.y, 30, 2), `tablet moved live (${last.tablet!.x - b0.tablet!.x}, ${last.tablet!.y - b0.tablet!.y})`).toBe(true);
    for (const f of mid) {
      expect(close(f.desktop, b0.desktop), 'desktop never moves').toBe(true);
      expect(close(f.mobile, b0.mobile), 'mobile never moves').toBe(true);
    }
    await stableCode(editor);
    const cfg = (await overlayConfig(editor, 'menu'))!;
    expect([cfg.offsetX, cfg.offsetY], 'base offsets unchanged').toEqual([0, 8]);
    const t = cfg.responsive?.['768'];
    expect(Math.abs(t.offsetX - (40 - 50 / scale)), `tablet offsetX ${t.offsetX}`).toBeLessThanOrEqual(2);
    expect(Math.abs(t.offsetY - (40 + 30 / scale)), `tablet offsetY ${t.offsetY}`).toBeLessThanOrEqual(2);
    expect(cfg.responsive?.['1440'] ?? null).toBeNull();
    expect(cfg.responsive?.['375'] ?? null).toBeNull();
    const after = await menuBoxes(editor);
    expect(close(after.desktop, b0.desktop) && close(after.mobile, b0.mobile), 'Desktop and Mobile unchanged').toBe(true);
    expect(close(after.tablet, last.tablet, 2), 'tablet committed where it was dropped').toBe(true);
    await expect(editor).toUndoInOneStep(before);
  });
});

// ─── DND-205 ─────────────────────────────────────────────────────────

const CARD = 'components/Card.tsx';
const OVERLAY_MASTER = `'use client';

/** @name "Card" */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [ovOpen, setOvOpen] = useState(false);
  return (
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: 'auto', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-trig" data-name="Trigger" data-overlay-trigger='{"targetId":"ov-1","trigger":"click","dismiss":"outside"}' onClick={() => setOvOpen(!ovOpen)} style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#663399', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="card-body" data-name="Body" style={{ position: 'relative', width: '100%', height: '160px', backgroundColor: '#225588', flex: '0 0 auto', order: '1' }} />
      <AnimatePresence>{ovOpen && (
        <motion.div key="ov-1" data-id="ov-1" data-name="Menu" data-overlay='{"type":"relative","triggerId":"card-trig","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ffcc33' }}>
          <p data-id="ov-1-text" data-name="Menu Text" style={{ position: 'relative', color: '#000000', margin: '0px' }}>Menu</p>
        </motion.div>
      )}</AnimatePresence>
    </motion.div>
  );
}

export default withResponsiveProps(Card);
`;

test.describe('master', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-205 a variant tile\'s overlay dragged past the tile edge moves live, unclamped, and commits responsiveVariant[name]', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
    await editor.load(masterSeed('Card', OVERLAY_MASTER));
    await openMaster(editor, CARD);
    await openOverlay(editor, 'ov-1', 'variant-1');
    const before = await editor.code(CARD);
    const tile = (await boxOf(editor, 'card-root', 'variant-1'))!;
    const trig = (await boxOf(editor, 'card-trig', 'variant-1'))!;
    const scale = trig.width / 120;
    const def0 = await boxOf(editor, 'ov-1', 'desktop');
    const ov0 = (await boxOf(editor, 'ov-1', 'variant-1'))!;
    // Positioned from the VARIANT root: centred under the variant's trigger.
    expect(near(center(ov0).x, center(trig).x, 2), 'origin = the variant root').toBe(true);
    await prime(editor, 'ov-1', 'variant-1', 0.5, 0.8);
    const dx = Math.round(tile.x + tile.width - ov0.x + 60);
    const frames: Array<Box | null> = [];
    let live: Box | null = null;
    {
      const { d, box } = await pressNode(editor, 'ov-1', { vpId: 'variant-1', fy: 0.8 });
      try {
        await d.moveBy(dx, 20, 40, async () => { frames.push(await boxOf(editor, 'ov-1', 'variant-1')); });
        await engaged(editor, 'ov-1', box, 'variant-1');
        await wiggle(d, 4);
        live = await boxOf(editor, 'ov-1', 'variant-1');
      } finally {
        await drop(editor, d);
      }
    }
    // Live (not: stale until mouseup) and past the tile's right edge (not clamped to it).
    expect(frames.filter(f => f && f.x > ov0.x + 1).length, 'moved live').toBeGreaterThanOrEqual(30);
    expect(live!.x, 'past the tile edge').toBeGreaterThan(tile.x + tile.width);
    expect(near(live!.x - ov0.x, dx, 3), `followed the full delta (${live!.x - ov0.x} vs ${dx})`).toBe(true);
    await stableCode(editor, CARD);
    const cfg = (await overlayConfig(editor, 'ov-1', CARD))!;
    expect([cfg.offsetX, cfg.offsetY], 'base offsets unchanged').toEqual([0, 8]);
    const v = cfg.responsiveVariant?.['variant-1'];
    expect(v, 'per-variant override written').toBeTruthy();
    expect(Math.abs(v.offsetX - dx / scale), `variant offsetX ${v.offsetX}`).toBeLessThanOrEqual(2);
    expect(Math.abs(v.offsetY - (8 + 20 / scale)), `variant offsetY ${v.offsetY}`).toBeLessThanOrEqual(2);
    expect(cfg.responsive ?? null, 'no page-width override').toBeNull();
    expect(close(await boxOf(editor, 'ov-1', 'desktop'), def0), 'the default tile is unchanged').toBe(true);
    expect(close(await boxOf(editor, 'ov-1', 'variant-1'), live, 2), 'no mouseup jump').toBe(true);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });
});

// ─── DND-206 ─────────────────────────────────────────────────────────

test('DND-206 an overlay snaps only to its trigger\'s edges and centre; the snapped offset is what commits', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  // offsetY 40: well clear of the trigger's bottom edge, so only the x snap is in play.
  await editor.load(flexChildOverlay({ offsetY: 40, gap: 60 }));
  await centerOn(editor, ['root']);
  await openOverlay(editor, 'ov-a');
  const before = await editor.code();
  const trig = (await boxOf(editor, 'card2'))!;
  const card1 = (await boxOf(editor, 'card1'))!;
  const ov0 = (await boxOf(editor, 'ov-a'))!;
  const s = trig.width / 400;
  // Left edges 3 css px apart (inside the snap threshold) → snapped flush to the trigger.
  const nearTrigLeft = trig.x + 3 * s - ov0.x;
  // Left edge 3 css px right of card1's right edge — 57 css px from the trigger's edge.
  const nearCard1 = card1.x + card1.width + 3 * s - ov0.x;
  let snapped: Box | null = null, snappedGuides: Array<{ vertical: boolean; at: number }> = [];
  let byCard1: Box | null = null, card1Guides: Array<{ vertical: boolean; at: number }> = [];
  {
    const { d, box } = await pressNode(editor, 'ov-a');
    try {
      await d.moveBy(nearTrigLeft, 0, 12);
      await engaged(editor, 'ov-a', box);
      await wiggle(d, 4, 'y');
      snapped = await boxOf(editor, 'ov-a');
      snappedGuides = await snapGuides(page);
      // Quickly on to card1's edge (fast enough to break the snap's stickiness).
      await d.moveBy(nearCard1 - nearTrigLeft, 0, 3);
      await wiggle(d, 6, 'y');
      byCard1 = await boxOf(editor, 'ov-a');
      card1Guides = await snapGuides(page);
      // And back beside the trigger's left edge, then release there.
      await d.moveBy(nearTrigLeft - nearCard1, 0, 3);
      await wiggle(d, 6, 'y');
    } finally {
      await drop(editor, d);
    }
  }
  expect(near(snapped!.x, trig.x, 1), `snapped flush to the trigger's left (${snapped!.x} vs ${trig.x})`).toBe(true);
  expect(snappedGuides.some(g => g.vertical && near(g.at, trig.x, 1.5)), 'a guide at the trigger edge').toBe(true);
  // Near card1 (another node): no snap, no guide there.
  expect(near(byCard1!.x, card1.x + card1.width + 3 * s, 1.5), `free beside card1 (${byCard1!.x} vs ${card1.x + card1.width + 3 * s})`).toBe(true);
  expect(card1Guides.some(g => g.vertical && near(g.at, card1.x + card1.width, 1.5)), 'no guide at card1\'s edge').toBe(false);
  // The SNAPPED offset commits: left edges flush ⇒ offsetX = (200 − 400) / 2 = −100.
  await stableCode(editor);
  const cfg = (await overlayConfig(editor, 'ov-a'))!;
  expect(cfg.offsetX).toBe(-100);
  expect(cfg.offsetY).toBe(40);
  expect(near((await boxOf(editor, 'ov-a'))!.x, trig.x, 1), 'painted flush after the commit').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-207 ─────────────────────────────────────────────────────────

test('DND-207 a fixed (modal) overlay never starts a drag; no offset or position is written', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(FIXED_OVERLAY);
  await openOverlay(editor, 'ov');
  await centerOn(editor, ['root']);
  const before = await editor.code();
  const ov0 = (await boxOf(editor, 'ov'))!;
  const cfg0 = await overlayConfig(editor, 'ov');
  await prime(editor, 'ov', undefined, 0.5, 0.3);
  expect(await editor.selection()).toEqual(['ov']);
  const m = await mark(page);
  const { d } = await pressNode(editor, 'ov', { fx: 0.5, fy: 0.3 });
  let mid: Box | null = null;
  try {
    await d.moveBy(80, 50, 12);
    await wiggle(d, 4);
    mid = await boxOf(editor, 'ov');
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  expect((await since(page, m, '^drag:blocked-fixed-overlay$')).length, 'the drag is refused').toBeGreaterThan(0);
  expect(await since(page, m, '^drag:start$'), 'no drag started').toEqual([]);
  expect(close(mid, ov0), 'nothing moved mid-gesture').toBe(true);
  expect(close(await boxOf(editor, 'ov'), ov0), 'nothing moved').toBe(true);
  expect(await overlayConfig(editor, 'ov'), 'no offset written').toEqual(cfg0);
  expect(await editor.code(), 'source untouched').toBe(before);
});

// ─── DND-208 ─────────────────────────────────────────────────────────

/** Three tiles; an absolute trigger in frame A, an empty frame B, an open overlay under the trigger. */
const TRIGGER_IN_FRAME = seed(pageSrc({
  tiles: TILES.three,
  imports: OV_IMPORTS,
  hooks: ['const [ovOpen, setOvOpen] = useState(false);'],
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '40px', width: '100%', minHeight: '700px', padding: '20px', backgroundColor: '#0d0d1a' }}>
  <div data-id="fa" data-name="FrameA" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '220px', backgroundColor: '#1a1a3a', order: '0' }}>
    <div data-id="trig" data-name="Trigger" data-overlay-trigger='{"targetId":"ov","trigger":"click","dismiss":"outside"}' onClick={() => setOvOpen(!ovOpen)} style={{ position: 'absolute', left: '20px', top: '20px', width: '120px', height: '50px', backgroundColor: '#663399' }}></div>
  </div>
  <div data-id="fb" data-name="FrameB" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '220px', backgroundColor: '#2a1a1a', order: '1' }}></div>
  <AnimatePresence>{ovOpen && (
    <motion.div key="ov" data-id="ov" data-name="Menu" data-overlay='{"type":"relative","triggerId":"trig","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '150px', height: '60px', backgroundColor: '#ffcc33' }}>
    </motion.div>
  )}</AnimatePresence>
</div>`,
}));

/** On every tile: the overlay sits flush under its own trigger copy (align start, gap below). */
async function glued(editor: import('../../helpers/editor').Editor, label: string): Promise<void> {
  for (const vp of VPS) {
    const t = await boxOf(editor, 'trig', vp);
    const o = await boxOf(editor, 'ov', vp);
    expect(t, `${label}: ${vp} trigger painted`).not.toBeNull();
    expect(o, `${label}: ${vp} overlay painted (not: hidden)`).not.toBeNull();
    expect(Math.abs(o!.x - t!.x), `${label}: ${vp} overlay x under the trigger (${o!.x} vs ${t!.x})`).toBeLessThanOrEqual(2);
    const gap = o!.y - (t!.y + t!.height);
    expect(gap, `${label}: ${vp} overlay just below the trigger (gap ${gap})`).toBeGreaterThanOrEqual(0);
    expect(gap, `${label}: ${vp} overlay just below the trigger (gap ${gap}; not: teleported)`).toBeLessThanOrEqual(12);
  }
}

test.describe('trigger moves', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-208 an open overlay follows its dragged trigger live on every tile, and is re-homed with it after a reparent', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(TRIGGER_IN_FRAME, { fit: true });
    await openOverlay(editor, 'ov');
    await glued(editor, 'start');
    const before = await editor.code();
    const t0 = (await boxOf(editor, 'trig', 'desktop'))!;
    const m = await mark(page);
    // 1. Drag the trigger inside frame A.
    {
      const { d, box } = await pressNode(editor, 'trig', { vpId: 'desktop' });
      try {
        await d.moveBy(30, 20, 8);
        await engaged(editor, 'trig', box, 'desktop');
        await wiggle(d, 4);
        expect((await boxOf(editor, 'trig', 'desktop'))!.x - t0.x, 'the trigger moved').toBeGreaterThan(20);
        await glued(editor, 'mid-drag in A');
      } finally {
        await drop(editor, d);
      }
    }
    await stableCode(editor);
    await glued(editor, 'after the move');
    await expect(editor).toUndoInOneStep(before);
    await page.waitForTimeout(450);

    // 2. Reparent it into frame B.
    const fb = await editor.nodeBoxIn('desktop', 'fb');
    {
      const { d, box } = await pressNode(editor, 'trig', { vpId: 'desktop' });
      try {
        await d.moveBy(6, 6, 3);
        await engaged(editor, 'trig', box, 'desktop');
        await d.moveTo({ x: fb.x + 60, y: fb.y + 40 }, 30);
        await wiggle(d, 8);
        await glued(editor, 'mid-drag over B');
      } finally {
        await drop(editor, d);
      }
    }
    await expect.poll(() => editor.parentOf('trig')).toBe('fb');
    await stableCode(editor);
    await glued(editor, 'after the reparent');
    expect((await since(page, m, '^overlay-follow:begin$')).length, 'the overlay followed each drag').toBeGreaterThanOrEqual(2);
    expect(idCount(await editor.code(), 'ov'), 'one overlay').toBe(1);
  });
});

// ─── DND-209 ─────────────────────────────────────────────────────────

/** A canvas-node trigger with its canvas overlay (the extracted dialect), and a frame in the page. */
const CANVAS_TRIGGER = seed(pageSrc({
  imports: OV_IMPORTS,
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '40px', width: '1200px', minHeight: '600px', padding: '60px', backgroundColor: '#0d0d1a' }}>
  <div data-id="box" data-name="Box" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '320px', backgroundColor: '#1a1a3a', order: '0' }}></div>
</div>`,
  canvas: `
  <div data-id="ctrig" data-name="Trigger" data-canvas-node="true" data-overlay-trigger='{"targetId":"cov","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '-420px', top: '60px', width: '160px', height: '60px', backgroundColor: '#663399' }}></div>
  <motion.div key="cov" data-id="cov" data-name="Menu" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"ctrig","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', left: '-420px', top: '128px', width: '200px', height: '80px', backgroundColor: '#ffcc33' }}>
  </motion.div>`,
}));

const gateOf = (code: string) => code.match(/\{\s*covOpen\s*&&\s*\(?\s*<motion\.div[^>]*data-id="cov"/g) ?? [];
const stateDecls = (code: string) => code.match(/const\s*\[\s*covOpen\s*,\s*setCovOpen\s*\]\s*=\s*useState\(false\)/g) ?? [];

test('DND-209 a canvas trigger with an overlay dragged into a frame and back out: re-homed by rehydrate, always exactly one overlay', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(CANVAS_TRIGGER);
  await centerOn(editor, ['ctrig', 'box']);
  const before = await editor.code();
  const bx = await editor.nodeBox('box');
  const home = center(await editor.nodeBox('ctrig'));
  const inBox = { x: bx.x + bx.width / 2, y: bx.y + bx.height / 2 };

  // 1. Into the frame and back out in ONE gesture: still one canvas overlay, no ghost.
  {
    const { d, box } = await pressNode(editor, 'ctrig');
    try {
      await d.moveTo(inBox, 40);
      await engaged(editor, 'ctrig', box);
      await wiggle(d, 10);
      await d.moveTo(home, 40);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  let code = await stableCode(editor);
  expect(idCount(code, 'cov'), 'one overlay in source').toBe(1);
  expect(gateOf(code), 'no runtime gate while the trigger is on the canvas').toEqual([]);
  expect(await editor.parentOf('ctrig')).toBeNull();
  expect(await domCount(editor, 'cov'), 'one overlay element (not: a ghost copy)').toBe(1);
  await page.waitForTimeout(450);

  // 2. Into the frame and released: rehydrated into the page — one overlay, `{covOpen && …}` intact.
  const beforeIn = code;
  const m = await mark(page);
  {
    const { d, box } = await pressNode(editor, 'ctrig');
    try {
      await d.moveTo(inBox, 40);
      await engaged(editor, 'ctrig', box);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('ctrig')).toBe('box');
  code = await stableCode(editor);
  expect(idCount(code, 'cov'), 'one overlay in source').toBe(1);
  expect(gateOf(code), 'the overlay sits behind its open-state gate').toHaveLength(1);
  expect(stateDecls(code), 'one open-state useState').toHaveLength(1);
  expect(code).toMatch(/data-id="ctrig"[^>]*onClick=\{\(\) => setCovOpen\(!covOpen\)\}/);
  expect(code.slice(code.indexOf('const canvasNodes')), 'nothing left on the canvas fragment').not.toContain('data-id="cov"');
  const re = await since(page, m, '^overlay-gen:rehydrate:done$');
  expect(re.map(e => e.data.overlayId), 'rehydrated exactly once').toEqual(['cov']);
  expect(await domCount(editor, 'cov'), 'one overlay element').toBeLessThanOrEqual(1);
  await expect(editor).toUndoInOneStep(beforeIn);
  await page.waitForTimeout(450);

  // 3. Back out to the canvas: extracted again, still exactly one overlay.
  {
    const { d, box } = await pressNode(editor, 'ctrig');
    try {
      // (A slow first nudge stays stuck on the frame's centre snap — go straight out.)
      await d.moveTo(home, 40);
      await engaged(editor, 'ctrig', box);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('ctrig')).toBeNull();
  code = await stableCode(editor);
  expect(idCount(code, 'cov'), 'one overlay in source').toBe(1);
  expect(gateOf(code)).toEqual([]);
  expect(stateDecls(code), 'the runtime state left with it').toEqual([]);
  expect(await domCount(editor, 'cov')).toBe(1);
  expect(before).toContain('data-id="cov"');
});

// ─── DND-210 ─────────────────────────────────────────────────────────

const TAJIVI = CARD_MASTER.replace(/Card/g, 'TaJiVi');
/** A component-instance trigger (`<TaJiVi … />`, self-closing) on the canvas, with its canvas overlay. */
const INSTANCE_TRIGGER = seed(pageSrc({
  imports: [...OV_IMPORTS, "import TaJiVi from '@/components/TaJiVi';"],
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '40px', width: '1200px', minHeight: '600px', padding: '60px', backgroundColor: '#0d0d1a' }}>
  <div data-id="box" data-name="Box" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '320px', backgroundColor: '#1a1a3a', order: '0' }}></div>
</div>`,
  canvas: `
  <TaJiVi data-id="inst" data-name="TaJiVi" data-canvas-node="true" data-overlay-trigger='{"targetId":"cov","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '-420px', top: '60px' }} />
  <motion.div key="cov" data-id="cov" data-name="Menu" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"inst","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', left: '-420px', top: '308px', width: '200px', height: '80px', backgroundColor: '#ffcc33' }}>
  </motion.div>`,
}), { 'components/TaJiVi.tsx': TAJIVI });

test('DND-210 a component-instance canvas trigger dragged into the page: onClick spliced before />, the JSX parses and the page renders', { tag: ['@p1', '@dnd', '@cmp'] }, async ({ editor }) => {
  await editor.load(INSTANCE_TRIGGER);
  await centerOn(editor, ['inst', 'box']);
  const before = await editor.code();
  const bx = await editor.nodeBox('box');
  {
    const { d, box } = await pressNode(editor, 'inst');
    try {
      await d.moveTo({ x: bx.x + bx.width / 2, y: bx.y + bx.height / 2 }, 40);
      await engaged(editor, 'inst', box);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('inst')).toBe('box');
  const code = await stableCode(editor);
  const tag = code.slice(code.lastIndexOf('<TaJiVi', code.indexOf('data-id="inst"')), code.indexOf('/>', code.indexOf('data-id="inst"')) + 2);
  expect(tag, 'onClick spliced right before the self-closing />').toMatch(/onClick=\{\(\) => setCovOpen\(!covOpen\)\}\s*\/>$/);
  expect(tag, 'not: the handler between / and >').not.toMatch(/\/\s*onClick/);
  expect(parses(code), 'the page parses').toBe(true);
  expect(gateOf(code)).toHaveLength(1);
  // The page renders (not: blank on drag-in): root, the frame and the instance paint.
  for (const id of ['root', 'box', 'inst']) await expect.poll(async () => !!(await boxOf(editor, id)), { message: `${id} paints` }).toBe(true);
  const inst = (await boxOf(editor, 'inst'))!;
  const boxNow = (await boxOf(editor, 'box'))!;
  expect(inst.x >= boxNow.x - 1 && inst.y >= boxNow.y - 1, 'the instance sits inside the frame').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-211 ─────────────────────────────────────────────────────────

const ABOUT = 'app/about/page.client.tsx';
const TRIGGER_TO_CANVAS = (() => {
  const s = seed(pageSrc({
    imports: OV_IMPORTS,
    hooks: ['const [ovAOpen, setOvAOpen] = useState(false);'],
    root: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '20px', alignItems: 'flex-start', width: '1200px', minHeight: '500px', padding: '60px', backgroundColor: '#ffffff' }}>
  <div data-id="card1" data-name="Card1" style={{ position: 'relative', flex: '0 0 auto', width: '300px', height: '200px', backgroundColor: '#f9a8a8', order: '0' }}></div>
  <div data-id="card2" data-name="Card2" data-overlay-trigger='{"targetId":"ov-a","trigger":"click","dismiss":"outside"}' onClick={() => setOvAOpen(!ovAOpen)} style={{ position: 'relative', flex: '0 0 auto', width: '300px', height: '200px', backgroundColor: '#a8c8f9', order: '1' }}></div>
  <AnimatePresence>{ovAOpen && (
    <motion.div key="ov-a" data-id="ov-a" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"card2","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#7CBFFF' }}>
    </motion.div>
  )}</AnimatePresence>
</div>`,
  }));
  s.files['app/about/page.tsx'] = PAGE_SERVER_WRAPPER;
  s.files[ABOUT] = pageSrc({ root: `<div data-id="about-root" data-name="About" style={{ width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }} />` });
  return s;
})();

test('DND-211 trigger dragged out to the canvas, then its overlay dragged: free follow without snap, offset committed, still on its trigger after a re-render', { tag: ['@p2', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(TRIGGER_TO_CANVAS);
  await centerOn(editor, ['root']);
  await openOverlay(editor, 'ov-a');
  const root = await editor.nodeBox('root');
  const out = await emptyCanvasPoint(editor, { x: root.x + root.width / 2, y: root.y + root.height + 150 }, 80);
  // 1. The trigger out to the canvas: the overlay goes with it as a canvas overlay.
  {
    const { d, box } = await pressNode(editor, 'card2');
    try {
      await d.moveBy(0, 6, 3);
      await engaged(editor, 'card2', box);
      await d.moveTo(out, 40);
      await wiggle(d, 8);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('card2')).toBeNull();
  const afterOut = await stableCode(editor);
  expect(afterOut.slice(afterOut.indexOf('const canvasNodes')), 'the overlay is a canvas node now').toContain('data-id="ov-a"');
  expect(afterOut, 'its runtime gate is gone').not.toMatch(/\{\s*ovAOpen\s*&&/);
  await expect.poll(async () => !!(await boxOf(editor, 'ov-a')), { message: 'the canvas overlay paints' }).toBe(true);
  const trig = (await boxOf(editor, 'card2'))!;
  const ov0 = (await boxOf(editor, 'ov-a'))!;
  const s = trig.width / 300;
  await page.waitForTimeout(450);

  // 2. Drag the canvas overlay: its left edge to 3 css px right of the trigger's
  //    left edge — a viewport overlay would snap flush there; a canvas one follows freely.
  const dx = trig.x + 3 * s - ov0.x;
  const m = await mark(page);
  const guides: number[] = [];
  let live: Box | null = null;
  {
    const { d, box } = await pressNode(editor, 'ov-a');
    try {
      await d.moveBy(dx, 30, 12, async () => { guides.push((await snapGuides(page)).length); });
      await engaged(editor, 'ov-a', box);
      await wiggle(d, 4);
      live = await boxOf(editor, 'ov-a');
    } finally {
      await drop(editor, d);
    }
  }
  expect((await since(page, m, '^drag:start$')).map(e => e.data.strategy)).toEqual(['overlay']);
  expect(near(live!.x, trig.x + 3 * s, 1.5), `free follow, no snap (${live!.x} vs ${trig.x + 3 * s})`).toBe(true);
  expect(guides.every(g => g === 0), 'no snap guides').toBe(true);
  await stableCode(editor);
  const cfg = (await overlayConfig(editor, 'ov-a'))!;
  expect(Math.abs(cfg.offsetX - dx / s), `offsetX ${cfg.offsetX} ≈ ${dx / s}`).toBeLessThanOrEqual(2);
  expect(Math.abs(cfg.offsetY - (8 + 30 / s)), `offsetY ${cfg.offsetY}`).toBeLessThanOrEqual(2);
  expect(close(await boxOf(editor, 'ov-a'), live, 2), 'committed where dropped').toBe(true);
  await expect(editor).toUndoInOneStep(afterOut);

  // 3. A full re-render (away and back): the overlay is still placed on its canvas trigger.
  const rel = { x: live!.x - trig.x, y: live!.y - trig.y };
  await editor.openFile(ABOUT);
  await editor.sandbox().locator('[data-node-id="about-root"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.openFile('app/page.client.tsx');
  await editor.sandbox().locator('[data-node-id="root"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
  await openOverlay(editor, 'ov-a');
  await expect.poll(async () => {
    const t = await boxOf(editor, 'card2'); const o = await boxOf(editor, 'ov-a');
    return !!t && !!o && near(o.x - t.x, rel.x, 2) && near(o.y - t.y, rel.y, 2);
  }, { message: 'the overlay keeps its offset from the canvas trigger' }).toBe(true);
});
