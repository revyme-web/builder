// DND · Templated pages (page + LayoutClient with `layout::` header/footer) and
// the template file itself (E2E_TEST_PLAN.md §2, batch D7).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { parentOutline } from '../../helpers/d1';
import {
  templatedSeed, openTemplated, layoutClient, section, TPL_PAGE, TPL_LAYOUT, TILES, pressNode, drop, engaged,
  boxesOf, boxOf, mark, since, stableCode, inlineOrders, bandOrders, center, wiggle, dropLineRead, paintedOrder,
  placeholderBoxes, domCount, idCount, type Box,
} from '../../helpers/d7';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 180_000 });

const SECTIONS = ['hero', 's2', 's3'];
const CHROME = ['layout::hdr', 'layout::ftr'];
const MERGED = ['layout::hdr', ...SECTIONS, 'layout::ftr'];

const sectionsJsx = (orders = true) => `
  ${section('hero', 'Hero', '#3355ff', orders ? "order: '0'" : '')}
  ${section('s2', 'Section Two', '#33aa55', orders ? "order: '1'" : '')}
  ${section('s3', 'Section Three', '#aa3355', orders ? "order: '2'" : '')}`;

/** Three tiles; a templated page with three order-stamped sections. */
const TEMPLATED_3VP = templatedSeed(sectionsJsx(), { tiles: TILES.three });

async function loadTemplated(editor: import('../../helpers/editor').Editor, seed = TEMPLATED_3VP): Promise<void> {
  await editor.load(seed);
  await openTemplated(editor);
  await editor.fitCamera();
  await editor.settled();
}

/** Header first and footer last, painted, on a tile. */
async function chromeBrackets(editor: import('../../helpers/editor').Editor, vpId: string, ids = MERGED): Promise<boolean> {
  const order = await paintedOrder(editor, ids, vpId);
  return order[0] === 'layout::hdr' && order[order.length - 1] === 'layout::ftr';
}

// ─── DND-196 ─────────────────────────────────────────────────────────

test('DND-196 templated page, primary: a section dragged above another reorders the page JSX and clears every order; chrome stays first/last', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the templated-root reorder clears every section `order` (by design), which leaves the page root failing the builder\'s own oracle (FLEX_CHILD_MISSING_ORDER on root) — builder and oracle disagree');
  await loadTemplated(editor);
  const before = await editor.code(TPL_PAGE);
  const tplBefore = await editor.code(TPL_LAYOUT);
  expect(await paintedOrder(editor, MERGED, 'desktop')).toEqual(MERGED);
  const hero = await editor.nodeBoxIn('desktop', 'hero');
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 's3', { vpId: 'desktop' });
  const atLift: string[][] = [];
  try {
    await d.moveBy(0, -4, 3);
    await engaged(editor, 's3', box, 'desktop');
    // At lift the chrome holds: header first, footer last (not: reversed / jumping).
    atLift.push(await paintedOrder(editor, ['layout::hdr', 'hero', 's2', 'layout::ftr'], 'desktop'));
    await d.moveTo({ x: hero.x + hero.width / 2, y: hero.y + hero.height * 0.15 }, 16);
    await wiggle(d, 8, 'x');
    atLift.push(await paintedOrder(editor, ['layout::hdr', 'hero', 's2', 'layout::ftr'], 'desktop'));
    expect(await placeholderBoxes(editor, 'desktop'), 'one placeholder').toHaveLength(1);
  } finally {
    await drop(editor, d);
  }
  for (const o of atLift) expect(o, 'chrome first/last mid-drag').toEqual(['layout::hdr', 'hero', 's2', 'layout::ftr']);

  // Source: the PAGE file's JSX is reordered, every CSS order cleared; the template untouched.
  await expect(editor).toHaveJsxOrder('root', ['s3', 'hero', 's2'], { path: TPL_PAGE });
  await expect.poll(() => inlineOrders(editor, SECTIONS, TPL_PAGE)).toEqual({ hero: null, s2: null, s3: null });
  const code = await stableCode(editor, TPL_PAGE);
  expect(code).not.toContain('layout::');
  expect(await editor.code(TPL_LAYOUT)).toBe(tplBefore);
  for (const id of SECTIONS) expect(idCount(code, id), `${id} once in source`).toBe(1);
  // Canvas: header first, footer last, no duplicate section on any tile.
  const want = ['layout::hdr', 's3', 'hero', 's2', 'layout::ftr'];
  for (const vp of ['desktop', 'tablet', 'mobile']) {
    await expect.poll(() => paintedOrder(editor, MERGED, vp), { message: vp }).toEqual(want);
  }
  for (const id of SECTIONS) expect(await domCount(editor, id), `${id}: one copy per tile`).toBe(3);
  expect((await since(page, m, '^drag:start$')).map(e => e.data.strategy)).toEqual(['layout-lifted']);
  await expect(editor).toUndoInOneStep(before, { path: TPL_PAGE });
  // The page the builder just wrote passes the builder's own oracle.
  await expect(editor).toPassOracle();
});

// ─── DND-197 ─────────────────────────────────────────────────────────

test('DND-197 templated page, Tablet tile: a section reorder writes tablet-band orders with layout:: brackets; Desktop and Mobile unchanged, holds after re-render', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
  await loadTemplated(editor);
  const before = await editor.code(TPL_PAGE);
  const tplBefore = await editor.code(TPL_LAYOUT);
  await prime(editor, 's3', 'tablet');
  const s2 = await editor.nodeBoxIn('tablet', 's2');
  const { d, box } = await pressNode(editor, 's3', { vpId: 'tablet' });
  try {
    await d.moveBy(0, -4, 3);
    await engaged(editor, 's3', box, 'tablet');
    await d.moveTo({ x: s2.x + s2.width / 2, y: s2.y + s2.height * 0.15 }, 16);
    await wiggle(d, 8, 'x');
  } finally {
    await drop(editor, d);
  }
  // Page sections get a per-viewport order in the tablet band…
  await expect(editor).toHaveBandStyle(768, 'hero', 'order', '0', { path: TPL_PAGE });
  await expect(editor).toHaveBandStyle(768, 's3', 'order', '1', { path: TPL_PAGE });
  await expect(editor).toHaveBandStyle(768, 's2', 'order', '2', { path: TPL_PAGE });
  // …and the template chrome is bracketed: header very low, footer very high.
  const hdr = await editor.bandStyle(768, 'layout::hdr', 'order', TPL_PAGE);
  const ftr = await editor.bandStyle(768, 'layout::ftr', 'order', TPL_PAGE);
  expect(hdr && Number(hdr.value), `header bracket ${JSON.stringify(hdr)}`).toBeLessThanOrEqual(-1000);
  expect(ftr && Number(ftr.value), `footer bracket ${JSON.stringify(ftr)}`).toBeGreaterThanOrEqual(1000);
  // Desktop inline orders, JSX and the mobile band untouched; the template file too.
  await expect(editor).toHaveJsxOrder('root', SECTIONS, { path: TPL_PAGE });
  expect(await inlineOrders(editor, SECTIONS, TPL_PAGE)).toEqual({ hero: '0', s2: '1', s3: '2' });
  expect(await bandOrders(editor, 375, [...SECTIONS, ...CHROME], TPL_PAGE)).toEqual({ hero: null, s2: null, s3: null, 'layout::hdr': null, 'layout::ftr': null });
  expect(await editor.code(TPL_LAYOUT)).toBe(tplBefore);
  await stableCode(editor, TPL_PAGE);
  const want = ['layout::hdr', 'hero', 's3', 's2', 'layout::ftr'];
  await expect.poll(() => paintedOrder(editor, MERGED, 'tablet')).toEqual(want);
  expect(await paintedOrder(editor, MERGED, 'desktop'), 'Desktop unchanged (not: synced)').toEqual(MERGED);
  expect(await paintedOrder(editor, MERGED, 'mobile'), 'Mobile unchanged (not: synced)').toEqual(MERGED);
  await expect(editor).toUndoInOneStep(before, { path: TPL_PAGE });

  // Holds after a full re-render (switch away and back).
  await editor.openFile('app/page.client.tsx');
  await editor.sandbox().locator('[data-node-id="home-root"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await openTemplated(editor);
  await editor.fitCamera();
  await expect.poll(() => paintedOrder(editor, MERGED, 'tablet')).toEqual(want);
  expect(await paintedOrder(editor, MERGED, 'desktop')).toEqual(MERGED);
  expect(await paintedOrder(editor, MERGED, 'mobile')).toEqual(MERGED);
});

// ─── DND-198 ─────────────────────────────────────────────────────────

const LAYOUT_WITH_STYLE = layoutClient({
  tiles: TILES.three,
  hdrOrder: '0',
  ftrOrder: '2',
  style: `<style>{\`
      [data-id="hdr"] { box-shadow: 0 1px 0 rgba(0,0,0,0.2); }
    \`}</style>`,
});
const TEMPLATE_FILE_SEED = templatedSeed(sectionsJsx(false), { tiles: TILES.three, layout: LAYOUT_WITH_STYLE });

test('DND-198 template file: the footer dragged above the {children} slot is a JSX reorder with every order cleared; the slot gets no order', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the template-file reorder clears every `order` (by design), which leaves the LayoutClient root failing the builder\'s own oracle (FLEX_CHILD_MISSING_ORDER on root) — builder and oracle disagree');
  await editor.load(TEMPLATE_FILE_SEED);
  await openTemplated(editor, TPL_LAYOUT, 'hdr');
  await editor.fitCamera();
  await editor.settled();
  const before = await editor.code(TPL_LAYOUT);
  const pageBefore = await editor.code(TPL_PAGE);
  const slotSel = '[data-node-id="children-slot"]';
  const slot = await editor.sandbox().locator(slotSel).first().boundingBox();
  expect(slot, 'the {children} slot paints on the primary').not.toBeNull();
  expect(await paintedOrder(editor, ['hdr', 'children-slot', 'ftr'])).toEqual(['hdr', 'children-slot', 'ftr']);
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'ftr', { vpId: 'desktop' });
  try {
    await d.moveBy(0, -4, 3);
    await engaged(editor, 'ftr', box, 'desktop');
    await d.moveTo({ x: slot!.x + slot!.width / 2, y: slot!.y + Math.min(slot!.height * 0.15, 12) }, 20);
    await wiggle(d, 8, 'x');
  } finally {
    await drop(editor, d);
  }
  // JSX: header, footer, {children}; every order cleared; the <style> stays first and isn't a slot.
  const code = await stableCode(editor, TPL_LAYOUT);
  await expect(editor).toHaveJsxOrder('root', ['hdr', 'ftr'], { path: TPL_LAYOUT });
  expect(code.indexOf('data-id="ftr"'), 'footer before {children}').toBeLessThan(code.indexOf('{children}'));
  expect(code.indexOf('<style>'), '<style> still leads').toBeLessThan(code.indexOf('data-id="hdr"'));
  expect(await inlineOrders(editor, ['hdr', 'ftr'], TPL_LAYOUT)).toEqual({ hdr: null, ftr: null });
  expect(code, 'the slot never receives an order').not.toMatch(/children-slot/);
  expect(await editor.code(TPL_PAGE), 'the page is untouched').toBe(pageBefore);
  // The primary repaints in the new sequence (not: snap-back).
  await expect.poll(() => paintedOrder(editor, ['hdr', 'children-slot', 'ftr'])).toEqual(['hdr', 'ftr', 'children-slot']);
  expect((await since(page, m, '^drag:start$')).map(e => e.data.strategy)).toEqual(['layout-lifted']);
  await expect(editor).toUndoInOneStep(before, { path: TPL_LAYOUT });
  await expect(editor).toPassOracle();
});

// ─── DND-199 ─────────────────────────────────────────────────────────

/** The tablet band carries a chrome `order` an old build wrote: the footer paints between hero and s2. */
const STALE_CHROME = templatedSeed(`
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="layout::ftr"] { order: 1 !important; }
    }
  \`}</style>${sectionsJsx()}`, { tiles: TILES.three });

test('DND-199 a stale chrome order in the tablet band is healed by a Tablet reorder: the footer goes back to the bottom', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
  await loadTemplated(editor, STALE_CHROME);
  const before = await editor.code(TPL_PAGE);
  // Precondition: the stale section-space entry sits in the page source. (The
  // canvas render already drops chrome `order` declarations from page CSS, so
  // the footer paints last even before the heal.)
  expect(await editor.bandStyle(768, 'layout::ftr', 'order', TPL_PAGE)).toEqual({ value: '1', important: true });
  expect(await chromeBrackets(editor, 'tablet')).toBe(true);
  await prime(editor, 's3', 'tablet');
  const s2 = await editor.nodeBoxIn('tablet', 's2');
  const { d, box } = await pressNode(editor, 's3', { vpId: 'tablet' });
  try {
    await d.moveBy(0, -4, 3);
    await engaged(editor, 's3', box, 'tablet');
    await d.moveTo({ x: s2.x + s2.width / 2, y: s2.y + s2.height * 0.15 }, 16);
    await wiggle(d, 8, 'x');
  } finally {
    await drop(editor, d);
  }
  await expect(editor).toHaveBandStyle(768, 's3', 'order', '1', { path: TPL_PAGE });
  const code = await stableCode(editor, TPL_PAGE);
  // The stale section-space entry is gone (not: `layout::ftr { order: 1 }` kept).
  // ROW-ADJUSTED: the chrome is not left without an order — the replica reorder
  // writes its ±100000 brackets (DND-197), which replace the stale value.
  const ftr = await editor.bandStyle(768, 'layout::ftr', 'order', TPL_PAGE);
  const hdr = await editor.bandStyle(768, 'layout::hdr', 'order', TPL_PAGE);
  expect(ftr?.value ?? null, 'no section-space order on the footer').not.toBe('1');
  expect(Number(ftr?.value), `footer bracket ${JSON.stringify(ftr)}`).toBeGreaterThanOrEqual(1000);
  expect(Number(hdr?.value), `header bracket ${JSON.stringify(hdr)}`).toBeLessThanOrEqual(-1000);
  expect(code.match(/\[data-id="layout::ftr"\]\s*\{\s*order:\s*1\s*!important/g) ?? []).toEqual([]);
  await expect.poll(() => paintedOrder(editor, MERGED, 'tablet')).toEqual(['layout::hdr', 'hero', 's3', 's2', 'layout::ftr']);
  expect(await paintedOrder(editor, MERGED, 'desktop')).toEqual(MERGED);
  await expect(editor).toUndoInOneStep(before, { path: TPL_PAGE });
});

// ─── DND-200 ─────────────────────────────────────────────────────────

/** Sections hidden on Tablet: the tablet tile's root holds only the template chrome. */
const CHROME_ONLY_TABLET = templatedSeed(`
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="hero"] { display: none !important; }
      [data-id="s2"] { display: none !important; }
      [data-id="s3"] { display: none !important; }
    }
  \`}</style>${sectionsJsx()}`, {
  tiles: TILES.three,
  canvas: `<div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '200px', top: '-260px', width: '120px', height: '60px', backgroundColor: '#ff66cc' }}></div>`,
});

test('DND-200 a templated Tablet tile with only header and footer reads as empty: no phantom lines between the locked chrome', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor, page }) => {
  await loadTemplated(editor, CHROME_ONLY_TABLET);
  const before = await editor.code(TPL_PAGE);
  const tHdr = await editor.nodeBoxIn('tablet', 'layout::hdr');
  const tFtr = await editor.nodeBoxIn('tablet', 'layout::ftr');
  const dHero = await editor.nodeBoxIn('desktop', 'hero');
  const dS2 = await editor.nodeBoxIn('desktop', 's2');
  const tRoot = await editor.nodeBoxIn('tablet', 'root');
  let desktopLine: Awaited<ReturnType<typeof dropLineRead>> = null;
  const tabletLines: Array<Awaited<ReturnType<typeof dropLineRead>>> = [];
  let tabletOutline: string | null = null;
  const { d, box } = await pressNode(editor, 'floater');
  try {
    await d.moveBy(8, 8, 3);
    await engaged(editor, 'floater', box);
    // Positive control: on Desktop the same drag draws a line between sections.
    await d.moveTo({ x: dHero.x + dHero.width / 2, y: (dHero.y + dHero.height + dS2.y) / 2 }, 30);
    await wiggle(d, 8);
    desktopLine = await dropLineRead(page);
    // Tablet: between the header and the footer, and over each of them.
    for (const p of [
      { x: tRoot.x + tRoot.width / 2, y: (tHdr.y + tHdr.height + tFtr.y) / 2 },
      { x: tRoot.x + tRoot.width / 2, y: tHdr.y + tHdr.height + 4 },
      { x: tRoot.x + tRoot.width / 2, y: tFtr.y - 4 },
    ]) {
      await d.moveTo(p, 24);
      await wiggle(d, 8);
      tabletLines.push(await dropLineRead(page));
      tabletOutline = tabletOutline ?? (await parentOutline(page))?.parentId ?? null;
    }
    // Back off the page so nothing is dropped.
    await d.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 30);
    await wiggle(d, 6);
  } finally {
    await drop(editor, d);
  }
  expect(desktopLine, 'Desktop shows a line between sections').toMatchObject({ parentId: 'root', insertIndex: 1 });
  expect(tabletLines, 'no phantom lines on the chrome-only Tablet tile').toEqual([null, null, null]);
  expect(tabletOutline, 'the tablet root is offered as an empty layout target').toBe('root');
  await stableCode(editor, TPL_PAGE);
  expect(await editor.parentOf('floater', TPL_PAGE), 'nothing dropped').toBeNull();
});

// ─── DND-201 ─────────────────────────────────────────────────────────

/** A templated page whose root also holds a fixed (modal) video overlay. Sections
 *  carry no `order`: a primary templated reorder clears them anyway (DND-196),
 *  so the oracle's FLEX_CHILD_MISSING_ORDER is part of the post-load baseline. */
const WITH_FIXED_OVERLAY = templatedSeed(`${sectionsJsx(false)}
  <AnimatePresence>{videoOpen && (
    <motion.div key="video-ov" data-id="video-ov" data-name="Video Overlay" data-overlay='{"type":"fixed","triggerId":"hero","side":"bottom","align":"center","offsetX":0,"offsetY":0}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed', left: '0px', top: '0px', width: '100%', height: '100%', zIndex: '100', backgroundColor: 'rgba(0, 0, 0, 0.6)' }}>
      <video data-id="video-ov-vid" data-name="Video" src="" muted loop style={{ position: 'relative', width: '640px', height: '360px', backgroundColor: '#000000' }} />
    </motion.div>
  )}</AnimatePresence>`, {
  tiles: TILES.three,
  imports: ["import { useState } from 'react';", "import { motion, AnimatePresence } from 'framer-motion';"],
  hooks: ['const [videoOpen, setVideoOpen] = useState(false);'],
});

test('DND-201 templated page with a fixed video overlay in root: sections reorder around it, the overlay keeps its slot, no duplicate', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
  await loadTemplated(editor, WITH_FIXED_OVERLAY);
  const before = await editor.code(TPL_PAGE);
  const hero = await editor.nodeBoxIn('desktop', 'hero');
  const { d, box } = await pressNode(editor, 's3', { vpId: 'desktop' });
  try {
    await d.moveBy(0, -4, 3);
    await engaged(editor, 's3', box, 'desktop');
    await d.moveTo({ x: hero.x + hero.width / 2, y: hero.y + hero.height * 0.15 }, 16);
    await wiggle(d, 8, 'x');
  } finally {
    await drop(editor, d);
  }
  await expect(editor).toHaveJsxOrder('root', ['s3', 'hero', 's2', 'video-ov'], { path: TPL_PAGE });
  const code = await stableCode(editor, TPL_PAGE);
  for (const id of [...SECTIONS, 'video-ov', 'video-ov-vid']) expect(idCount(code, id), `${id} once`).toBe(1);
  expect(code, 'the overlay keeps its open-state gate').toMatch(/\{videoOpen && \(?\s*<motion\.div key="video-ov"/);
  await expect.poll(() => paintedOrder(editor, MERGED, 'desktop')).toEqual(['layout::hdr', 's3', 'hero', 's2', 'layout::ftr']);
  for (const id of SECTIONS) expect(await domCount(editor, id), `${id}: one copy per tile`).toBe(3);
  await expect(editor).toUndoInOneStep(before, { path: TPL_PAGE });
});

/** Click a node on a tile (starts the tile's rect stream), then wait out the dblclick window. */
async function prime(editor: import('../../helpers/editor').Editor, id: string, vpId: string): Promise<void> {
  const b = await editor.nodeBoxIn(vpId, id);
  await editor.page().mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await editor.settled();
  await editor.page().waitForTimeout(650);
}
