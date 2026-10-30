// DND · Replica tiles and cross-tile drags: reorder and absolute drags that
// stay on one tile (E2E_TEST_PLAN.md §2, batch D6).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  seed, pageWithCanvas, TILES, FOUR_TILES, center, gesture, boxIn, visualOrderIn, transformIn,
  bandOrders, inlineOrders, zoomOf, prime,
  quickBox,
} from '../../helpers/d6';

test.use({ viewport: TILES_VIEWPORT });
// Multi-tile gestures on a loaded machine: several drags + undo round trips per test.
test.describe.configure({ timeout: 150_000 });

// ─── Seeds ───────────────────────────────────────────────────────────

/** Desktop + Mobile, an absolute child whose mobile band already moves it. */
const REPLICA_ABS_DRAG = seed(pageWithCanvas({ tiles: TILES.two, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 375px) {
  [data-id="abs"] { left: 24px !important; top: 24px !important; }
}
\`}</style>
  <div data-id="card" data-name="Card" style={{ width: '600px', height: '400px', position: 'relative', backgroundColor: '#1a1a3a', borderRadius: '12px' }}>
    <div data-id="abs" data-name="Abs" style={{ position: 'absolute', left: '200px', top: '120px', width: '160px', height: '100px', backgroundColor: '#ffcc33', borderRadius: '8px' }}></div>
  </div>
</div>` }));

const SECTION_IDS = ['hero', 'services', 'about'];

/** Three tiles, a column of ordered sections; the tablet band carries its OWN order map. */
const SECTIONS_TABLET_ORDER = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="about"] { order: 0 !important; }
      [data-id="hero"] { order: 1 !important; }
      [data-id="services"] { order: 2 !important; }
    }
  \`}</style>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="services" data-name="Services" style={{ height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="about" data-name="About" style={{ height: '200px', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }}></div>
</div>` }));

/** Four tiles incl. a custom 600px one; plain column of sections, no orders yet. */
const SECTIONS_4VP = seed(pageWithCanvas({ tiles: FOUR_TILES, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>
  <div data-id="services" data-name="Services" style={{ height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
  <div data-id="about" data-name="About" style={{ height: '200px', backgroundColor: '#2a2a4a', flex: '0 0 auto' }}></div>
</div>` }));

/** Three tiles, absolute px and % children; the mobile band positions `abs-px` itself. */
const ABS_FANOUT_3VP = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 375px) {
  [data-id="abs-px"] { left: 10px !important; top: 10px !important; }
}
\`}</style>
  <div data-id="card" data-name="Card" style={{ width: '100%', height: '500px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="abs-px" data-name="AbsPx" style={{ position: 'absolute', left: '200px', top: '40px', width: '120px', height: '80px', backgroundColor: '#ffcc33' }}></div>
    <div data-id="abs-pct" data-name="AbsPct" style={{ position: 'absolute', left: '40%', top: '40%', width: '120px', height: '80px', backgroundColor: '#33ccff' }}></div>
  </div>
</div>` }));

/** Three tiles, two flex sections; the tablet band orders section A's children and sizes a2. */
const TWO_SECTIONS_3VP = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="a2"] { order: 0 !important; height: 60px !important; }
      [data-id="a1"] { order: 1 !important; }
    }
  \`}</style>
  <div data-id="section-a" data-name="SectionA" style={{ display: 'flex', flexDirection: 'row', gap: '16px', width: '100%', height: '160px', padding: '16px', backgroundColor: '#1a1a3a', flex: '0 0 auto', position: 'relative' }}>
    <div data-id="a1" data-name="A1" style={{ width: '120px', height: '100px', backgroundColor: '#3355ff', flex: '0 0 auto', position: 'relative' }}></div>
    <div data-id="a2" data-name="A2" style={{ width: '120px', height: '100px', backgroundColor: '#ffcc33', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
  <div data-id="section-b" data-name="SectionB" style={{ display: 'flex', flexDirection: 'row', gap: '16px', width: '100%', height: '160px', padding: '16px', backgroundColor: '#2a1a1a', flex: '0 0 auto', position: 'relative' }}>
    <div data-id="b1" data-name="B1" style={{ width: '120px', height: '100px', backgroundColor: '#33cc88', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
</div>` }));

/** Three tiles; the tablet band has an independent order map; a free canvas chip to insert. */
const INDEPENDENT_ORDER_INSERT = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="about"] { order: 0 !important; }
      [data-id="services"] { order: 1 !important; }
      [data-id="hero"] { order: 2 !important; }
      [data-id="contact"] { order: 3 !important; }
    }
  \`}</style>
  <div data-id="hero" data-name="Hero" style={{ height: '150px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="services" data-name="Services" style={{ height: '150px', backgroundColor: '#f5f5f7', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="about" data-name="About" style={{ height: '150px', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }}></div>
  <div data-id="contact" data-name="Contact" style={{ height: '150px', backgroundColor: '#4a2a2a', flex: '0 0 auto', order: '3' }}></div>
</div>`, canvas: `
  <div data-id="new-chip" data-name="NewChip" data-canvas-node="true" style={{ position: 'absolute', left: '200px', top: '-260px', width: '300px', height: '80px', backgroundColor: '#7c5cff' }}></div>
` }));

// ─── Tests ───────────────────────────────────────────────────────────

test('DND-149 absolute drag on the Mobile tile commits to the mobile band and holds', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(REPLICA_ABS_DRAG, { fit: true });
  const before = await editor.code();
  const desk0 = await editor.nodeBoxIn('desktop', 'abs');
  const mob0 = await editor.nodeBoxIn('mobile', 'abs');
  const from = { x: mob0.x + mob0.width / 2 + 4, y: mob0.y + mob0.height / 2 + 3 };
  const to = { x: from.x + 30, y: from.y + 24 };

  await prime(editor, 'abs', 'mobile');
  let midMob = mob0;
  await gesture(editor, from, [to], {
    atWaypoint: async () => {
      midMob = (await boxIn(editor, 'mobile', 'abs'))!;
      // Only the Mobile copy moves mid-drag.
      expect(Math.abs(midMob.x - mob0.x) + Math.abs(midMob.y - mob0.y)).toBeGreaterThan(10);
      const desk = (await boxIn(editor, 'desktop', 'abs'))!;
      expect(Math.abs(desk.x - desk0.x)).toBeLessThan(1);
      expect(Math.abs(desk.y - desk0.y)).toBeLessThan(1);
    },
  });

  // Source: the mobile band carries the new left/top, !important; Desktop inline untouched.
  const zoom = await zoomOf(editor, 'mobile', 375);
  const card = await editor.nodeBoxIn('mobile', 'card');
  await expect.poll(async () => (await editor.bandStyle(375, 'abs', 'left'))?.value).not.toBe('24px');
  const left = await editor.bandStyle(375, 'abs', 'left');
  const top = await editor.bandStyle(375, 'abs', 'top');
  expect(left?.important).toBe(true);
  expect(top?.important).toBe(true);
  await expect(editor).toHaveStyle('abs', 'left', '200px');
  await expect(editor).toHaveStyle('abs', 'top', '120px');

  // Canvas: the position holds after mouseup (not: snaps back until a page switch).
  await expect.poll(async () => {
    const b = (await boxIn(editor, 'mobile', 'abs'))!;
    return Math.abs(b.x - midMob.x) < 3 && Math.abs(b.y - midMob.y) < 3;
  }, { timeout: 4_000 }).toBe(true);
  await editor.page().waitForTimeout(800);
  const settled = (await boxIn(editor, 'mobile', 'abs'))!;
  expect(Math.abs(settled.x - midMob.x)).toBeLessThan(3);
  expect(Math.abs(settled.y - midMob.y)).toBeLessThan(3);
  // …and it paints where the band says.
  expect(Math.abs((settled.x - card.x) / zoom - parseFloat(left!.value))).toBeLessThan(2);
  expect(Math.abs((settled.y - card.y) / zoom - parseFloat(top!.value))).toBeLessThan(2);
  // Desktop unchanged.
  const desk1 = await editor.nodeBoxIn('desktop', 'abs');
  expect(Math.abs(desk1.x - desk0.x) + Math.abs(desk1.y - desk0.y)).toBeLessThan(1);

  await expect(editor).toUndoInOneStep(before);
});

test('DND-150 reorder on the Tablet tile writes the tablet band only, from Tablet\'s own order', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(SECTIONS_TABLET_ORDER, { fit: true });
  const before = await editor.code();
  // Tablet paints its own sequence: about, hero, services.
  expect(await visualOrderIn(editor, 'tablet', SECTION_IDS)).toEqual(['about', 'hero', 'services']);
  const svc0 = await editor.nodeBoxIn('tablet', 'services');
  const about0 = await editor.nodeBoxIn('tablet', 'about');

  await prime(editor, 'services', 'tablet');
  const from = center(svc0);
  await gesture(editor, from, [
    { x: from.x, y: from.y + 6 },
    { x: about0.x + about0.width / 2, y: about0.y + 4 },
  ], {
    atWaypoint: async (i) => {
      if (i !== 0) return;
      // The placeholder opens in services' TABLET slot (last), not its Desktop slot (middle).
      const ph = await quickBox(editor.sandbox().locator('[data-viewport="tablet"] [data-placeholder-id]'));
      expect(ph, 'a reorder placeholder on the tablet tile').not.toBeNull();
      expect(Math.abs(ph!.y - svc0.y)).toBeLessThan(4);
    },
  });

  // Source: the tablet band gets the new map, !important; JSX and Desktop inline untouched.
  await expect(editor).toHaveBandStyle(768, 'services', 'order', '0', { important: true });
  await expect(editor).toHaveBandStyle(768, 'about', 'order', '1', { important: true });
  await expect(editor).toHaveBandStyle(768, 'hero', 'order', '2', { important: true });
  await expect(editor).toHaveJsxOrder('root', SECTION_IDS);
  expect(await inlineOrders(editor, SECTION_IDS)).toEqual({ hero: '0', services: '1', about: '2' });
  expect(await bandOrders(editor, 375, SECTION_IDS)).toEqual({ hero: null, services: null, about: null });

  // Tiles: Tablet repaints; Desktop and Mobile keep the old sequence.
  await expect.poll(() => visualOrderIn(editor, 'tablet', SECTION_IDS)).toEqual(['services', 'about', 'hero']);
  expect(await visualOrderIn(editor, 'desktop', SECTION_IDS)).toEqual(SECTION_IDS);
  expect(await visualOrderIn(editor, 'mobile', SECTION_IDS)).toEqual(SECTION_IDS);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-151 Desktop absolute drag fans out live to tiles without their own position', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: after a Desktop absolute drop, the Mobile copy with its own band left/top is repainted at the primary position (onEnd fan-out patches !important on page replicas, only variant overrides are filtered)');
  await editor.load(ABS_FANOUT_3VP, { fit: true });
  const before = await editor.code();
  const zoom = await zoomOf(editor, 'tablet', 768);
  const cardW = {
    desktop: (await editor.nodeBoxIn('desktop', 'card')).width,
    tablet: (await editor.nodeBoxIn('tablet', 'card')).width,
    mobile: (await editor.nodeBoxIn('mobile', 'card')).width,
  };

  // ── px-positioned (kept inside the start third so the auto-pin stays px):
  // Tablet follows by the same translate; Mobile (its own band position) stays.
  const px0 = {
    desktop: await editor.nodeBoxIn('desktop', 'abs-px'),
    tablet: await editor.nodeBoxIn('tablet', 'abs-px'),
    mobile: await editor.nodeBoxIn('mobile', 'abs-px'),
  };
  const fromPx = { x: px0.desktop.x + px0.desktop.width / 2 + 3, y: px0.desktop.y + px0.desktop.height / 2 + 2 };
  await gesture(editor, fromPx, [{ x: fromPx.x + 80 * zoom, y: fromPx.y + 30 * zoom }], {
    atWaypoint: async () => {
      const d = (await boxIn(editor, 'desktop', 'abs-px'))!;
      const t = (await boxIn(editor, 'tablet', 'abs-px'))!;
      const m = (await boxIn(editor, 'mobile', 'abs-px'))!;
      const dx = d.x - px0.desktop.x, dy = d.y - px0.desktop.y;
      expect(Math.abs(dx)).toBeGreaterThan(10);
      expect(Math.abs((t.x - px0.tablet.x) - dx), 'tablet follows by the same px').toBeLessThan(2);
      expect(Math.abs((t.y - px0.tablet.y) - dy)).toBeLessThan(2);
      expect(Math.abs(m.x - px0.mobile.x) + Math.abs(m.y - px0.mobile.y), 'mobile keeps its own position').toBeLessThan(1);
    },
  });
  await expect.poll(async () => (await editor.style('abs-px')).left).toMatch(/^\d+px$/);
  await expect(editor).not.toHaveStyle('abs-px', 'left', '200px');
  await expect(editor).toHaveBandStyle(375, 'abs-px', 'left', '10px');
  await expect(editor).toHaveBandStyle(375, 'abs-px', 'top', '10px');
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    await expect.poll(() => transformIn(editor, vp, 'abs-px'), { message: `no leftover translate on ${vp}` }).toBe('none');
  }
  // The tile with its own band position must STAY after mouseup too. Today the
  // drop's primary fan-out (AbsoluteInFrameStrategy.onEnd) patches the final
  // left/top `!important` onto every replica copy, filtering only VARIANT
  // overrides — the mobile band's own left/top loses to the inline residue.
  const m1 = await editor.nodeBoxIn('mobile', 'abs-px');
  expect.soft(Math.abs(m1.x - px0.mobile.x) + Math.abs(m1.y - px0.mobile.y),
    'mobile (own band position) still paints at 10px/10px after mouseup').toBeLessThan(1);
  const afterPx = await editor.code();

  // ── %-positioned (kept in the middle third so the auto-pin stays %):
  // Tablet and Mobile follow scaled by their parent-width ratio.
  const pct0 = {
    desktop: await editor.nodeBoxIn('desktop', 'abs-pct'),
    tablet: await editor.nodeBoxIn('tablet', 'abs-pct'),
    mobile: await editor.nodeBoxIn('mobile', 'abs-pct'),
  };
  const fromPct = { x: pct0.desktop.x + pct0.desktop.width / 2 + 3, y: pct0.desktop.y + pct0.desktop.height / 2 + 2 };
  await gesture(editor, fromPct, [{ x: fromPct.x + 100 * zoom, y: fromPct.y - 20 * zoom }], {
    atWaypoint: async () => {
      const d = (await boxIn(editor, 'desktop', 'abs-pct'))!;
      const dx = d.x - pct0.desktop.x;
      expect(Math.abs(dx)).toBeGreaterThan(10);
      for (const vp of ['tablet', 'mobile'] as const) {
        const t = (await boxIn(editor, vp, 'abs-pct'))!;
        const expected = dx * (cardW[vp] / cardW.desktop);
        expect(Math.abs((t.x - pct0[vp].x) - expected), `${vp} follows scaled by the parent ratio`).toBeLessThan(2);
      }
    },
  });
  await expect.poll(async () => (await editor.style('abs-pct')).left).toMatch(/%$/);
  await expect(editor).not.toHaveStyle('abs-pct', 'left', '40%');
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    await expect.poll(() => transformIn(editor, vp, 'abs-pct'), { message: `no leftover translate on ${vp}` }).toBe('none');
  }
  // After the commit every tile sits where its % resolves (no drift, no stale translate).
  const pctLeft = parseFloat((await editor.style('abs-pct')).left);
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    const c = await editor.nodeBoxIn(vp, 'card');
    const b = await editor.nodeBoxIn(vp, 'abs-pct');
    expect(Math.abs((b.x - c.x) - c.width * pctLeft / 100), `${vp} paints at ${pctLeft}%`).toBeLessThan(2);
  }

  // The % drop undoes in one step to the px state; one more undo restores the seed.
  await expect(editor).toUndoInOneStep(afterPx);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(afterPx);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
});

test('DND-266 reorders on the Mobile and the custom 600px tile each write their own band', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(SECTIONS_4VP, { fit: true });
  const before = await editor.code();

  // ── Mobile: about to the top.
  await prime(editor, 'about', 'mobile');
  const mHero = await editor.nodeBoxIn('mobile', 'hero');
  await editor.dragNodeAsserted('about', { x: mHero.x + mHero.width / 2, y: mHero.y + 4 }, { vpId: 'mobile' });
  await expect(editor).toHaveBandStyle(375, 'about', 'order', '0', { important: true });
  await expect(editor).toHaveBandStyle(375, 'hero', 'order', '1', { important: true });
  await expect(editor).toHaveBandStyle(375, 'services', 'order', '2', { important: true });
  expect(await bandOrders(editor, 600, SECTION_IDS)).toEqual({ hero: null, services: null, about: null });
  expect(await bandOrders(editor, 768, SECTION_IDS)).toEqual({ hero: null, services: null, about: null });
  expect(await inlineOrders(editor, SECTION_IDS)).toEqual({ hero: null, services: null, about: null });
  await expect.poll(() => visualOrderIn(editor, 'mobile', SECTION_IDS)).toEqual(['about', 'hero', 'services']);
  for (const vp of ['desktop', 'tablet', 'custom']) expect(await visualOrderIn(editor, vp, SECTION_IDS)).toEqual(SECTION_IDS);
  const afterMobile = await editor.code();
  await expect(editor).toUndoInOneStep(before);

  // ── Custom 600px tile: hero to the bottom.
  await prime(editor, 'hero', 'custom');
  const cAbout = await editor.nodeBoxIn('custom', 'about');
  await editor.dragNodeAsserted('hero', { x: cAbout.x + cAbout.width / 2, y: cAbout.y + cAbout.height - 4 }, { vpId: 'custom' });
  await expect(editor).toHaveBandStyle(600, 'services', 'order', '0', { important: true });
  await expect(editor).toHaveBandStyle(600, 'about', 'order', '1', { important: true });
  await expect(editor).toHaveBandStyle(600, 'hero', 'order', '2', { important: true });
  // The custom band is keyed to its own width, and the mobile drop is still there.
  expect(await editor.code()).toMatch(/@media \(max-width: 600px\)/);
  await expect(editor).toHaveBandStyle(375, 'about', 'order', '0', { important: true });
  expect(await bandOrders(editor, 768, SECTION_IDS)).toEqual({ hero: null, services: null, about: null });
  await expect(editor).toHaveJsxOrder('root', SECTION_IDS);
  await expect.poll(() => visualOrderIn(editor, 'custom', SECTION_IDS)).toEqual(['services', 'about', 'hero']);
  expect(await visualOrderIn(editor, 'mobile', SECTION_IDS)).toEqual(['about', 'hero', 'services']);
  for (const vp of ['desktop', 'tablet']) expect(await visualOrderIn(editor, vp, SECTION_IDS)).toEqual(SECTION_IDS);
  await expect(editor).toUndoInOneStep(afterMobile);
});

test('DND-267 a Tablet drag of a flex child over section B stays lifted in section A (in-viewport drags never reparent)', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
  // ROW-ADJUSTED: the row expects a structural move into B. LayoutLiftedStrategy
  // keeps a flow child lifted in its SOURCE layout while the cursor is anywhere
  // inside the viewport (exit detection uses the viewport root rect, by design:
  // "over a sibling section … the dragged element should remain lifted"), so
  // releasing over B on the Tablet tile is a Tablet reorder inside A.
  await editor.load(TWO_SECTIONS_3VP, { fit: true });
  const before = await editor.code();
  const b1 = await editor.nodeBoxIn('tablet', 'b1');
  const secA = await editor.nodeBoxIn('tablet', 'section-a');

  await prime(editor, 'a2', 'tablet');
  const a2 = await editor.nodeBoxIn('tablet', 'a2');
  await gesture(editor, center(a2), [{ x: b1.x + b1.width + 30, y: b1.y + b1.height / 2 }], {
    steps: 16,
    atWaypoint: async () => {
      // Mid-drag over B: the placeholder stays inside A (no drop line into B).
      const ph = await quickBox(editor.sandbox().locator('[data-viewport="tablet"] [data-placeholder-id]'));
      expect(ph).not.toBeNull();
      expect(ph!.y >= secA.y - 1 && ph!.y + ph!.height <= secA.y + secA.height + 1).toBe(true);
    },
  });

  // Source: no structural move; the tablet band re-numbers A's children (a2 last again).
  await expect(editor).toHaveBandStyle(768, 'a1', 'order', '0', { important: true });
  await expect(editor).toHaveBandStyle(768, 'a2', 'order', '1', { important: true });
  await expect(editor).toHaveJsxOrder('section-a', ['a1', 'a2']);
  await expect(editor).toHaveJsxOrder('section-b', ['b1']);
  // a2's other Tablet override is untouched; Desktop inline gets no order.
  await expect(editor).toHaveBandStyle(768, 'a2', 'height', '60px', { important: true });
  expect(await inlineOrders(editor, ['a1', 'a2'])).toEqual({ a1: null, a2: null });
  // Tiles: every tile still paints a2 inside A.
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    await expect.poll(async () => {
      const b = await boxIn(editor, vp, 'a2');
      const sec = await boxIn(editor, vp, 'section-a');
      return !!b && !!sec && b.y >= sec.y - 1 && b.y + b.height <= sec.y + sec.height + 1;
    }, { message: `a2 paints inside section-a on ${vp}` }).toBe(true);
  }
  await expect.poll(() => visualOrderIn(editor, 'tablet', ['a1', 'a2'])).toEqual(['a1', 'a2']);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-156 a Desktop insert lands after the same predecessor in the tablet band\'s own sequence', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
  await editor.load(INDEPENDENT_ORDER_INSERT, { fit: true });
  const before = await editor.code();
  const ids = ['hero', 'services', 'about', 'contact'];
  const svc = await editor.nodeBoxIn('desktop', 'services');

  await prime(editor, 'new-chip');
  const chip = await editor.nodeBox('new-chip');
  await gesture(editor, { x: chip.x + chip.width / 2 + 5, y: chip.y + chip.height / 2 + 4 }, [
    { x: svc.x + svc.width / 2, y: svc.y + svc.height - 6 },
  ], { steps: 20 });

  // Desktop renumbered with new-chip right after services.
  await expect(editor).toHaveStyle('new-chip', 'order', '2');
  expect(await inlineOrders(editor, ids)).toEqual({ hero: '0', services: '1', about: '3', contact: '4' });
  // Tablet: after the same predecessor (services) in ITS sequence, renumbered 0..N.
  await expect(editor).toHaveBandStyle(768, 'new-chip', 'order', '2', { important: true });
  expect(await bandOrders(editor, 768, ids)).toEqual({ about: '0', services: '1', hero: '3', contact: '4' });
  // Mobile (no order map) inherits the base.
  expect(await bandOrders(editor, 375, [...ids, 'new-chip'])).toEqual({ hero: null, services: null, about: null, contact: null, 'new-chip': null });
  await expect.poll(() => visualOrderIn(editor, 'tablet', [...ids, 'new-chip'])).toEqual(['about', 'services', 'new-chip', 'hero', 'contact']);
  await expect.poll(() => visualOrderIn(editor, 'desktop', [...ids, 'new-chip'])).toEqual(['hero', 'services', 'new-chip', 'about', 'contact']);
  await expect.poll(() => visualOrderIn(editor, 'mobile', [...ids, 'new-chip'])).toEqual(['hero', 'services', 'new-chip', 'about', 'contact']);
  await expect(editor).toUndoInOneStep(before);
});
