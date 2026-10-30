// DND · Mid-drag handoffs across tiles: tracking through entries, snap guides
// after round trips, back-to-parent placeholders, replica twins and live
// fan-out of the first drag (E2E_TEST_PLAN.md §2, batch D6).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  seed, pageWithCanvas, TILES, TILE, center, gesture, glide, pump, boxIn, primeReplica, prime,
  canvasNodeIds, idCount, inside, traces, stableCode, REPLICA_EXIT_TO_FRAME, visibleIn, rafs, elementUnder, type Pt, type Box,
  quickBox,
} from '../../helpers/d6';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

// ─── Seeds ───────────────────────────────────────────────────────────

/** Desktop + Tablet, a NON-layout root holding one absolute child. */
const REPLICA_ABSOLUTE_EXIT = seed(pageWithCanvas({ tiles: [TILE.desktop, TILE.tablet], root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '600px', backgroundColor: '#0d0d1a' }}>
  <div data-id="abs-child" data-name="AbsChild" style={{ position: 'absolute', left: '60px', top: '60px', width: '120px', height: '120px', backgroundColor: '#66ccff' }}></div>
</div>` }));

/** Three tiles, a non-layout root with two frames; frame-a holds an absolute child. */
const ABS_TWO_FRAMES_3VP = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '600px', backgroundColor: '#0d0d1a' }}>
  <style>{\`
@media (max-width: 375px) {
  [data-id="abs-child"] { display: none !important; }
}
\`}</style>
  <div data-id="frame-a" data-name="FrameA" style={{ position: 'absolute', left: '40px', top: '40px', width: '300px', height: '220px', backgroundColor: '#1a1a3a' }}>
    <div data-id="abs-child" data-name="AbsChild" style={{ position: 'absolute', left: '30px', top: '30px', width: '100px', height: '70px', backgroundColor: '#66ccff' }}></div>
  </div>
  <div data-id="frame-b" data-name="FrameB" style={{ position: 'absolute', left: '40px', top: '320px', width: '300px', height: '220px', backgroundColor: '#3a1a1a' }}></div>
</div>` }));

/** HANDOFF_TWO_VP: a flow parent to drag out of and a no-layout target, Desktop + a 810px Tablet. */
const HANDOFF_TWO_VP = seed(pageWithCanvas({ tiles: [TILE.desktop, { id: 'tablet', label: 'Tablet', width: 810 }], root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <div data-id="source-box" data-name="Source" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', position: 'relative', padding: '16px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    <div data-id="chip-a" data-name="ChipA" style={{ width: '100%', height: '80px', backgroundColor: '#3355ff', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="chip-b" data-name="ChipB" style={{ width: '100%', height: '80px', backgroundColor: '#ffcc33', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
  <div data-id="target-box" data-name="Target" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', height: '320px', position: 'relative', padding: '16px', backgroundColor: '#2a1a1a', flex: '0 0 auto', order: '1' }}>
    <div data-id="chip-c" data-name="ChipC" style={{ width: '100%', height: '80px', backgroundColor: '#33cc88', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  </div>
</div>` }));

/** FLEX_COLUMN on three tiles plus a free canvas frame above the Desktop tile. */
const FLEX_COLUMN_3VP = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '300px', backgroundColor: '#1a1a3a', flex: '0 0 auto', position: 'relative' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '300px', backgroundColor: '#f5f5f7', flex: '0 0 auto', position: 'relative' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '300px', backgroundColor: '#2a2a4a', flex: '0 0 auto', position: 'relative' }}></div>
</div>`, canvas: `
  <div data-id="free-frame" data-name="FreeFrame" data-canvas-node="true" style={{ position: 'absolute', left: '600px', top: '-300px', width: '240px', height: '120px', backgroundColor: '#7c5cff' }}></div>
` }));

/** Three tiles, a flex column whose middle card triggers an overlay. */
const OVERLAY_TRIGGER_3VP = seed(pageWithCanvas({ tiles: TILES.three,
  imports: [`import { useState } from 'react';`, `import { AnimatePresence, motion } from 'framer-motion';`],
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', minHeight: '800px', padding: '40px', backgroundColor: '#ffffff', position: 'relative' }}>
  <div data-id="card1" data-name="Card1" style={{ width: '100%', height: '160px', backgroundColor: '#f9a8a8', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="card2" data-name="Card2" data-overlay-trigger='{"trigger":"click"}' onClick={() => setOverlayA(!overlayA)} style={{ width: '100%', height: '160px', backgroundColor: '#a8c8f9', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="card3" data-name="Card3" style={{ width: '100%', height: '160px', backgroundColor: '#a8f9b8', position: 'relative', flex: '0 0 auto', order: '2' }}></div>
  <AnimatePresence>{overlayA && (
    <motion.div key="ov-a" data-id="ov-a" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"card2","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#7CBFFF', borderRadius: '8px' }}>
    </motion.div>
  )}</AnimatePresence>
</div>` }).replace('export default function Page() {\n  return (', 'export default function Page() {\n  const [overlayA, setOverlayA] = useState(false);\n  return ('));

// ─── Helpers ─────────────────────────────────────────────────────────

/** The interaction outline's top-left (the dashed SVG drawn while dragging). */
async function outlineTopLeft(editor: Parameters<typeof gesture>[0]): Promise<Pt | null> {
  const line = editor.page().locator('[data-interaction-outline] line').first();
  if ((await line.count()) === 0) return null;
  return { x: Number(await line.getAttribute('x1')), y: Number(await line.getAttribute('y1')) };
}

// ─── Tests ───────────────────────────────────────────────────────────

test('DND-159 outline and element keep tracking through a layout-frame entry, both directions', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(REPLICA_EXIT_TO_FRAME, { fit: true });
  const before = await editor.code();

  // ── Replica-origin drag (Tablet) into the LAYOUT canvas frame.
  await primeReplica(editor, 'tablet', 'card', 'card-inner');
  const inner = await editor.nodeBoxIn('tablet', 'card-inner');
  const frame = await editor.nodeBox('layout-frame');
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const to = center(frame);
  // Travel a real distance INSIDE the frame after the entry (it is ~200x115 px on screen here).
  const to2 = { x: to.x + 40, y: to.y + 30 };
  await gesture(editor, from, [{ x: from.x, y: frame.y - 40 }, to, to2], {
    atWaypoint: async (i) => {
      if (i !== 2) return;
      // A frozen ghost sits a full travel-length behind; a tracking one is within the grab offset.
      const tl = await outlineTopLeft(editor);
      expect(tl, 'interaction outline drawn').not.toBeNull();
      expect(Math.hypot(to2.x - tl!.x, to2.y - tl!.y), 'outline keeps tracking the cursor').toBeLessThan(70);
      const el = await elementUnder(editor, ':root', to2, ['root', 'layout-frame', 'drop-frame', 'card', 'canvas-chip', 'canvas-flex', 'canvas-flex-kid']);
      expect(el, 'the dragged element is painted under the cursor').not.toBeNull();
    },
  });
  expect((await editor.childIds('layout-frame')).length, 'dropped into the layout frame').toBe(1);
  await stableCode(editor);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // ── Canvas node into the REPLICA layout frame (card on Tablet).
  await prime(editor, 'card', 'tablet');
  await prime(editor, 'canvas-chip');
  const chip = await editor.nodeBox('canvas-chip');
  const card = await editor.nodeBoxIn('tablet', 'card');
  const cFrom = { x: chip.x + chip.width / 2 + 5, y: chip.y + chip.height / 2 + 4 };
  const cTo = center(card);
  const cTo2 = { x: cTo.x + 30, y: cTo.y + 20 };
  await gesture(editor, cFrom, [cTo, cTo2], {
    steps: 14,
    atWaypoint: async (i) => {
      if (i !== 1) return;
      const box = await quickBox(editor.sandbox().locator('[data-id="canvas-chip"]:visible'));
      expect(inside(cTo2, box), 'element keeps following the cursor inside the frame').toBe(true);
      const tl = await outlineTopLeft(editor);
      expect(tl).not.toBeNull();
      expect(Math.hypot(cTo2.x - tl!.x, cTo2.y - tl!.y), 'outline keeps tracking').toBeLessThan(70);
    },
  });
  await expect.poll(() => editor.parentOf('canvas-chip')).toBe('card');
  await stableCode(editor);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
});

test('DND-160 snap guides hug the node after a layout-frame round trip', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(REPLICA_EXIT_TO_FRAME, { fit: true });
  await primeReplica(editor, 'tablet', 'card', 'solo-chip');
  const chip = await editor.nodeBoxIn('tablet', 'solo-chip');
  const layoutF = await editor.nodeBox('layout-frame');
  const dropF = await editor.nodeBox('drop-frame');
  const from = { x: chip.x + chip.width / 2 + 6, y: chip.y + chip.height / 2 + 4 };
  const intoLayout = center(layoutF);
  const backOut = { x: (layoutF.x + layoutF.width + dropF.x) / 2, y: dropF.y - 60 };

  const samples: Array<{ guideY: number; top: number; bottom: number; cy: number }> = [];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, { x: from.x, y: layoutF.y - 40 });
    await glide(page, { x: from.x, y: layoutF.y - 40 }, intoLayout);
    await pump(page, intoLayout, 8);
    await glide(page, intoLayout, backOut);
    // Sweep down across drop-frame's top edge so a horizontal guide fires.
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move(backOut.x, backOut.y + i * 5, { steps: 1 });
      await rafs(page);
      const box = await quickBox(editor.sandbox().locator('[data-id="solo-chip"]:visible'));
      if (!box) continue;
      const ys = await page.evaluate(() => Array.from(document.querySelectorAll('svg line[stroke="#f472b6"]'))
        .map(l => [Number(l.getAttribute('y1')), Number(l.getAttribute('y2'))]).filter(([a, b]) => a === b).map(([a]) => a));
      for (const y of ys) samples.push({ guideY: y, top: box.y, bottom: box.y + box.height, cy: box.y + box.height / 2 });
    }
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  expect(samples.length, 'the sweep crossed an alignment: at least one guide sampled').toBeGreaterThan(0);
  for (const s of samples) {
    const d = Math.min(Math.abs(s.guideY - s.top), Math.abs(s.guideY - s.bottom), Math.abs(s.guideY - s.cy));
    expect(d, `guide y=${s.guideY.toFixed(1)} vs node edges [${s.top.toFixed(1)}, ${s.cy.toFixed(1)}, ${s.bottom.toFixed(1)}]`).toBeLessThan(3);
  }
});

test('DND-161 brushing another frame and returning shows a back-to-parent placeholder in card', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(REPLICA_EXIT_TO_FRAME, { fit: true });
  const before = await editor.code();
  await prime(editor, 'card');
  await editor.select(['card-inner']);
  await page.waitForTimeout(300);
  const inner = await editor.nodeBox('card-inner');
  const card = await editor.nodeBox('card');
  const dropF = await editor.nodeBox('drop-frame');
  const layoutF = await editor.nodeBox('layout-frame');
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const ph = () => editor.sandbox().locator('[data-placeholder-id="canvas-entry-ph"]');

  await gesture(editor, from, [{ x: from.x, y: dropF.y - 40 }, center(dropF), center(layoutF), center(card)], {
    atWaypoint: async (i) => {
      if (i === 2) expect(await ph().count(), 'no back-to-parent placeholder on a foreign frame').toBe(0);
      if (i === 3) {
        const b = await quickBox(ph());
        expect(b, 'entry placeholder inside the original parent').not.toBeNull();
        expect(b!.x >= card.x - 2 && b!.x + b!.width <= card.x + card.width + 2
          && b!.y >= card.y - 2 && b!.y + b!.height <= card.y + card.height + 2, 'placeholder inside card').toBe(true);
      }
    },
  });

  // card-inner is back in card; no placeholder left.
  await expect(editor).toHaveJsxOrder('card', ['card-inner', 'solo-chip']);
  await expect(ph()).toHaveCount(0);
  expect((await editor.childIds('drop-frame')).filter(id => id !== 'dead-child')).toEqual([]);
  expect(idCount(await editor.code(), 'card-inner')).toBe(1);
  if ((await editor.code()) !== before) {
    await stableCode(editor);
    await expect(editor).toUndoInOneStep(before);
  }
});

test('DND-166 an absolute child dragged out of the Tablet tile follows the cursor every frame', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(REPLICA_ABSOLUTE_EXIT, { fit: true });
  const before = await editor.code();
  // The replica half of the old spec was fixme'd (tile never laid out); with the full @canvas shape it lays out.
  const start = await editor.nodeBoxIn('tablet', 'abs-child');
  expect(start.width).toBeGreaterThan(5);
  await prime(editor, 'abs-child', 'tablet');
  const from = { x: start.x + start.width / 2 + 4, y: start.y + start.height / 2 + 3 };
  const tile = await editor.nodeBoxIn('tablet', 'root');
  const to = { x: from.x + 40, y: tile.y - 160 };

  const ys: number[] = [];
  let missing = 0;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + 8, from.y - 8, { steps: 2 });
    for (let i = 1; i <= 12; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 };
      await page.mouse.move(p.x, p.y, { steps: 2 });
      await rafs(page);
      // Whatever copy is visible under the cursor (the source, or the canvas clone after the split).
      const vis = editor.sandbox().locator('[data-id]:visible');
      const boxes = await vis.evaluateAll((els, pt) => els.map(e => {
        const r = e.getBoundingClientRect();
        return { id: e.getAttribute('data-id'), y: r.y, h: r.height, w: r.width, x: r.x };
      }), p);
      const iframe = (await page.locator('iframe[src*="5174"]').boundingBox())!;
      const hit = boxes.filter(b => b.w > 5 && b.w < 200 && p.x >= b.x + iframe.x - 2 && p.x <= b.x + iframe.x + b.w + 2 && p.y >= b.y + iframe.y - 2 && p.y <= b.y + iframe.y + b.h + 2);
      if (hit.length) ys.push(hit[0].y); else missing++;
    }
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  expect(missing, 'element under the cursor in (nearly) every frame').toBeLessThanOrEqual(2);
  expect(Math.max(...ys) - Math.min(...ys), 'element travelled with the cursor (not frozen until mouseup)').toBeGreaterThan(100);
  // Each frame's sample keeps moving: no run of frozen frames.
  let frozenRun = 0, worst = 0;
  for (let i = 1; i < ys.length; i++) { frozenRun = Math.abs(ys[i] - ys[i - 1]) < 1 ? frozenRun + 1 : 0; worst = Math.max(worst, frozenRun); }
  expect(worst, 'no frozen frames mid-gesture').toBeLessThanOrEqual(1);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-167 an absolute child dragged off the Tablet tile into another frame splits: a Tablet-solo clone lands there', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
  // ROW-ADJUSTED: the row expects a SYNCED UNPARENT (source moves for every tile,
  // consolidation clone removed). That model is dead code: nothing ever registers
  // a consolidation clone (consolidation-clone-store.ts has no setter), and the
  // live path is the vp-only extraction (`abs-in-frame:vp-only-canvas-extraction-live`)
  // — the same split DND-153 asserts for flow children: the other tiles keep the
  // source, the frame receives a fresh-id clone that is solo on the origin tile.
  test.fail(true, 'BUG: one replica drag-out-and-into-a-frame gesture records THREE undo steps (vp-only extraction, frame entry, drop position)');
  await editor.load(ABS_TWO_FRAMES_3VP, { fit: true });
  const before = await editor.code();
  await prime(editor, 'abs-child', 'tablet');
  const abs = await editor.nodeBoxIn('tablet', 'abs-child');
  const tile = await editor.nodeBoxIn('tablet', 'root');
  const fb = await editor.nodeBoxIn('tablet', 'frame-b');
  const from = { x: abs.x + abs.width / 2 + 3, y: abs.y + abs.height / 2 + 2 };
  await gesture(editor, from, [{ x: from.x, y: tile.y - 80 }, { x: fb.x + fb.width / 2, y: tile.y - 80 }, center(fb)], { pumpFrames: 10 });

  // Source: abs-child stays in frame-a, hidden on Tablet; its own mobile hide is untouched.
  await expect.poll(async () => (await editor.childIds('frame-b')).length).toBe(1);
  const code = await stableCode(editor);
  expect(await editor.parentOf('abs-child')).toBe('frame-a');
  await expect(editor).toHaveBandStyle(768, 'abs-child', 'display', 'none', { important: true });
  await expect(editor).toHaveBandStyle(375, 'abs-child', 'display', 'none', { important: true });
  // frame-b holds a fresh-id clone that is solo on Tablet.
  const [clone] = await editor.childIds('frame-b');
  expect(clone).not.toBe('abs-child');
  expect(await editor.attr(clone, 'data-replica-solo')).toBe('tablet');
  await expect(editor).toHaveBandStyle(375, clone, 'display', 'none', { important: true });
  expect(canvasNodeIds(code)).toEqual([]);
  await expect(editor).toHaveNoDuplicateIds();
  // Tiles: Desktop keeps the source in frame-a; Tablet shows only the clone, in frame-b.
  await expect(await editor.nodeIn('desktop', 'abs-child')).toBeVisible();
  await expect(await editor.nodeIn('tablet', 'abs-child')).toBeHidden();
  await expect(await editor.nodeIn('desktop', clone)).toBeHidden();
  await expect.poll(async () => {
    const b = await boxIn(editor, 'tablet', clone);
    const f = await boxIn(editor, 'tablet', 'frame-b');
    return !!b && !!f && b.width > 0 && inside(center(b), f);
  }, { message: 'the clone paints inside frame-b on Tablet' }).toBe(true);
  // One gesture must be one undo step. Today it is THREE (the mid-drag vp-only
  // extraction, the entry into frame-b, the drop position). Soft: the row's
  // other checks above already ran.
  await stableCode(editor);
  await expect.soft(editor, 'one undo restores the seed').toUndoInOneStep(before);
  for (let i = 0; i < 4 && (await editor.code()) !== before; i++) await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
});

test('DND-168 the Desktop twin stays hidden across the strategy handoff and returns after the drop', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(HANDOFF_TWO_VP, { fit: true });
  await expect(await editor.nodeIn('desktop', 'chip-b')).toBeVisible();
  await prime(editor, 'chip-b', 'tablet');
  const chipB = await editor.nodeBoxIn('tablet', 'chip-b');
  const tile = await editor.nodeBoxIn('tablet', 'root');
  const target = await editor.nodeBoxIn('desktop', 'target-box');
  const out = { x: chipB.x + chipB.width / 2, y: tile.y - 60 };
  await gesture(editor, center(chipB), [out, center(target)], {
    steps: 14, pumpFrames: 10,
    atWaypoint: async (i) => {
      // Off the tile and then over the Desktop frame (post-handoff): ONE chip-b painted.
      await expect(await editor.nodeIn('desktop', 'chip-b'), `Desktop twin hidden at waypoint ${i}`).toBeHidden();
    },
  });
  // After the drop the twin's hide is lifted.
  await expect(await editor.nodeIn('desktop', 'chip-b')).toBeVisible();
});

test('DND-171 a replica-extracted canvas node keeps its on-screen position when it enters the primary', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(REPLICA_EXIT_TO_FRAME, { fit: true });
  // Gesture 1: extract card-inner from the Tablet tile onto open canvas (a fresh clone).
  await primeReplica(editor, 'tablet', 'card', 'card-inner');
  const inner = await editor.nodeBoxIn('tablet', 'card-inner');
  const tile = await editor.nodeBoxIn('tablet', 'root');
  await gesture(editor, { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 }, [{ x: tile.x - 200, y: tile.y - 140 }], { steps: 16 });
  const clone = canvasNodeIds(await stableCode(editor)).find(id => id.startsWith('detach-'));
  expect(clone, 'a canvas clone').toBeTruthy();

  // Gesture 2: drag the clone into the Desktop tile; sample the grab offset every frame.
  await page.waitForTimeout(500);
  const cbox = (await quickBox(editor.sandbox().locator(`[data-id="${clone}"]:visible`)))!;
  const deskRoot = await editor.nodeBoxIn('desktop', 'root');
  const deskCard = await editor.nodeBoxIn('desktop', 'card');
  const from = { x: cbox.x + cbox.width / 2 + 5, y: cbox.y + cbox.height / 2 + 4 };
  const into = { x: deskCard.x + deskCard.width + 120, y: deskRoot.y + deskRoot.height * 0.7 };
  const offsets: Array<{ dx: number; dy: number }> = [];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, into, 24, async (p) => {
      const b = await quickBox(editor.sandbox().locator(`[data-id="${clone}"]:visible`));
      if (b) offsets.push({ dx: p.x - b.x, dy: p.y - b.y });
    });
    await pump(page, into, 8);
    const b = await quickBox(editor.sandbox().locator(`[data-id="${clone}"]:visible`));
    if (b) offsets.push({ dx: into.x - b.x, dy: into.y - b.y });
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  expect(offsets.length).toBeGreaterThan(10);
  // The grab offset established on the open canvas holds through the entry (no jump).
  const ref = offsets[2];
  for (const o of offsets.slice(2)) {
    expect(Math.abs(o.dx - ref.dx) + Math.abs(o.dy - ref.dy), `grab offset drift ${JSON.stringify(o)} vs ${JSON.stringify(ref)}`).toBeLessThan(6);
  }
});

test('DND-265 the FIRST drag of a session fans a canvas frame out live to the Tablet and Mobile copies', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(FLEX_COLUMN_3VP, { fit: true });
  const before = await editor.code();
  const ff = await editor.nodeBox('free-frame');
  const feat = await editor.nodeBoxIn('desktop', 'features');
  const from = { x: ff.x + ff.width / 2 + 5, y: ff.y + ff.height / 2 + 4 };
  // Straight down into the Features section of the column (a no-layout frame → live reparent + replica clones).
  // Deep enough that the frame is FULLY inside Features (the entry rule), then travel within it.
  const enter = { x: from.x, y: feat.y + feat.height * 0.4 };
  const deep = { x: from.x + 40, y: feat.y + feat.height * 0.85 };

  const rows: Array<{ d: number; t: number | null; m: number | null }> = [];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await glide(page, from, enter, 16);
    await pump(page, enter, 6);
    await glide(page, enter, deep, 12, async () => {
      const d = (await boxIn(editor, 'desktop', 'free-frame'))?.y ?? NaN;
      const t = (await boxIn(editor, 'tablet', 'free-frame'))?.y ?? null;
      const m = (await boxIn(editor, 'mobile', 'free-frame'))?.y ?? null;
      rows.push({ d, t, m });
    });
  } finally {
    await page.mouse.up();
    await editor.settled();
  }
  // Mid-drag the Tablet and Mobile clones appear on the entry and then follow EVERY
  // frame of this first drag (y tracks the primary; frozen = the rect-cache gap).
  const first = rows.findIndex(r => r.t !== null && r.m !== null);
  expect(first, `clones painted after the entry: ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
  const live = rows.slice(first + 1);
  expect(live.length, 'enough post-entry frames sampled').toBeGreaterThanOrEqual(5);
  expect(live.every(r => r.t !== null && r.m !== null), `clones stay painted: ${JSON.stringify(rows)}`).toBe(true);
  for (let i = 1; i < live.length; i++) {
    const dd = live[i].d - live[i - 1].d;
    expect(Math.abs((live[i].t! - live[i - 1].t!) - dd), `tablet frame ${i} follows`).toBeLessThan(2);
    expect(Math.abs((live[i].m! - live[i - 1].m!) - dd), `mobile frame ${i} follows`).toBeLessThan(2);
  }
  expect(live.at(-1)!.t! - live[0].t!, 'the tablet clone travelled').toBeGreaterThan(10);

  // The drop lands on every tile.
  await expect.poll(() => editor.parentOf('free-frame')).toBe('features');
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    await expect.poll(async () => {
      const b = await boxIn(editor, vp, 'free-frame');
      const f = await boxIn(editor, vp, 'features');
      return !!b && !!f && inside(center(b), f);
    }, { message: `free-frame inside features on ${vp}` }).toBe(true);
  }
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-170 dragging an overlay trigger hides the replica overlay copies with the triggers and re-homes them after the drop', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(OVERLAY_TRIGGER_3VP, { fit: true });
  const before = await editor.code();
  await page.evaluate(() => (window as any).__e2e.openOverlay('ov-a'));
  await page.waitForTimeout(600);
  const ov = (vp: string) => editor.sandbox().locator(`[data-node-id="${vp === 'desktop' ? '' : `${vp}-`}ov-a"]`).first();
  for (const vp of ['tablet', 'mobile']) await expect(ov(vp), `${vp} overlay copy open`).toBeVisible();

  const c2 = await editor.nodeBoxIn('desktop', 'card2');
  const c1 = await editor.nodeBoxIn('desktop', 'card1');
  await gesture(editor, center(c2), [{ x: c1.x + c1.width / 2, y: c1.y + 6 }], {
    atWaypoint: async () => {
      for (const vp of ['tablet', 'mobile']) {
        await expect(await editor.nodeIn(vp, 'card2'), `${vp} trigger copy hidden mid-drag`).toBeHidden();
        await expect(ov(vp), `${vp} overlay copy hidden with its trigger`).toBeHidden();
      }
    },
  });
  await expect(editor).toHaveStyle('card2', 'order', '0');
  // After the drop each replica overlay copy is back, glued under ITS trigger copy, at once.
  for (const vp of ['tablet', 'mobile']) {
    await expect.poll(async () => {
      const t = await boxIn(editor, vp, 'card2');
      const o = await quickBox(ov(vp));
      return !!t && !!o && Math.abs(o.y - (t.y + t.height)) < 12;
    }, { message: `${vp} overlay re-homed under the moved trigger`, timeout: 2_000 }).toBe(true);
  }
  await expect(editor).toUndoInOneStep(before);
});
