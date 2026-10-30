// CMP · Instance sizing and canvas–live parity (E2E_TEST_PLAN.md §8, CMP-197…214).
//
// A page instance paints on the canvas as TWO boxes — the wrapper (the tag's
// data-id, carrying the instance's layout/size) and the expanded master root
// (`<inst>:<root>`, filling it) — while live it is ONE element, the master
// root with the instance style spread last. Every test here checks that the
// two models agree: what the builder wrote, what the tiles paint, and (for
// the parity rows) what the preview on :5175 paints.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  c7Seed, c7Page, root, inst, imp, PAGE, ABOUT, TILES, SERVER_WRAPPER,
  TECARD, CARD240, CARD_2V, LINK_PILL, BUTTON_PILL, HUG_PILL, SHADOW_CARD, BOX, panelMaster, CHIP, NAV_X, PROMOTED,
  FAQ_ITEM, ABS_TILE, POP_HEADER, NAV_BAR, libraryRow, traces, panel,
  clickIn, sizeSelect, sizeInput, cssSize, stableCode, pollCode, cssSizeOfNode, computedIn, tagOf, stableBoxIn, quickBox,
  openPreview, setPreviewWidth, previewBox, pixelAt, near,
} from '../../helpers/c7';
import { gesture, prime } from '../../helpers/d6';
import { dblclickAt, SIGNUP_MASTER } from '../../helpers/c2';
import { isTextEditing, PREVIEW_MASTER_KEY_NOISE } from '../../helpers/c5';
import { SEEDS } from '../../../src/canvas/drag/e2e/fixtures/seeds';


test.describe.configure({ timeout: 180_000 });

const styleKeys = (tag: string) => {
  const m = tag.match(/style=\{\{([\s\S]*?)\}\}/);
  return m ? m[1] : '';
};

// ─── CMP-197 ─────────────────────────────────────────────────────────

const TECARD_SEED = c7Seed(c7Page(root(
  inst('TeCard', 'card-1', `position: 'relative', width: '546px', height: '354px', flex: '0 0 auto'`),
  { style: `position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: '40px'` },
), { imports: [imp('TeCard')] }), { TeCard: TECARD });

test('CMP-197 W then H → auto on an instance resolves to the master base 300×200 without a page switch', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(TECARD_SEED);
  expect(await cssSize(editor, 'desktop', 'card-1')).toEqual({ w: 546, h: 354 });
  await clickIn(editor, 'desktop', 'card-1');
  expect(await editor.selection()).toEqual(['card-1']);

  await sizeSelect(page, 'Width').selectOption('auto');
  await expect(editor).toHaveStyle('card-1', 'width', null, { path: PAGE });
  const mid = await stableCode(editor, PAGE);
  await sizeSelect(page, 'Height').selectOption('auto');
  await expect(editor).toHaveStyle('card-1', 'height', null, { path: PAGE });

  // Source: the tag carries neither dim (absence = the master's own size).
  const tag = tagOf(await editor.code(PAGE), 'card-1');
  expect(styleKeys(tag)).not.toMatch(/\bwidth\s*:/);
  expect(styleKeys(tag)).not.toMatch(/\bheight\s*:/);
  expect(tag).not.toContain('data-size-hug');

  // Canvas: the wrapper adopts the master base, in place (no page switch).
  await expect.poll(() => cssSize(editor, 'desktop', 'card-1')).toEqual({ w: 300, h: 200 });
  // Not: collapsed to the text's size.
  const root = await cssSizeOfNode(editor, 'card-1:tec-root');
  expect(root!.h).toBeGreaterThan(150);
  expect(root!.w).toBeGreaterThan(250);
  await expect(sizeSelect(page, 'Width')).toHaveValue('auto');
  await expect(sizeSelect(page, 'Height')).toHaveValue('auto');

  await expect(editor).toUndoInOneStep(mid, { path: PAGE });
});

// ─── CMP-198 / CMP-202: Card (240×160) instances on three tiles ──────

function cardsSeed(ids: string[], width = '400px') {
  return c7Seed(c7Page(root(ids.map(id => inst('Card', id, `position: 'relative', width: '${width}', flex: '0 0 auto'`)).join('\n')),
    { tiles: TILES.three, imports: [imp('Card')] }), { Card: CARD240 });
}

test.describe('three tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-198 Width → auto on the Tablet tile writes a band auto + the hug marker; only Tablet hugs, live too', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    test.fail(true, "BUG: Width → auto on the Tablet tile never hugs the master's 240px — the canvas tile keeps the instance's 400px (live patch), and after a reload the tile AND the preview at 768 collapse to the label's 111px: the band `width: auto !important` also matches the inner root (same data-id) whose merged width is the instance's 400px / the runtime's 100% fill, not the master's own width");
    await editor.load(cardsSeed(['card-a']), { fit: true });
    const before = await editor.code(PAGE);
    await clickIn(editor, 'tablet', 'card-a');
    await sizeSelect(page, 'Width').selectOption('auto');

    // Source: a band auto for the instance (NOT '' → the override removed),
    // the primary px untouched, and the runtime-wrapper marker on the tag.
    await expect(editor).toHaveBandStyle(768, 'card-a', 'width', 'auto', { path: PAGE });
    await expect(editor).toHaveStyle('card-a', 'width', '400px', { path: PAGE });
    const code = await editor.code(PAGE);
    expect(tagOf(code, 'card-a')).toMatch(/data-size-hug="width"/);
    expect(await editor.bandStyle(375, 'card-a', 'width', PAGE)).toBeNull();

    // Tiles: Tablet adopts the master root's 240px; Desktop and Mobile keep 400px.
    await expect.poll(async () => (await cssSize(editor, 'tablet', 'card-a'))?.w).toBe(240);
    expect((await cssSize(editor, 'desktop', 'card-a'))?.w).toBe(400);
    expect((await cssSize(editor, 'mobile', 'card-a'))?.w).toBe(400);
    await expect(sizeSelect(page, 'Width')).toHaveValue('auto');

    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // Live: the preview at 768 hugs the master (the data-size-hug wrapper), 1440 keeps 400px.
    const frame = await openPreview(editor, '[data-id="card-a"]');
    await setPreviewWidth(page, frame, 768);
    await expect.poll(async () => (await previewBox(frame, 'card-a'))?.w).toBe(240);
    await setPreviewWidth(page, frame, 1440);
    await expect.poll(async () => (await previewBox(frame, 'card-a'))?.w).toBe(400);
  });

  test('CMP-202 Width → Auto on three selected instances hugs all of them; on Tablet every tag gets the marker + band', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    const ids = ['card-a', 'card-b', 'card-c'];
    await editor.load(cardsSeed(ids), { fit: true });
    const before = await editor.code(PAGE);

    // Primary: select all three with real clicks.
    await clickIn(editor, 'desktop', 'card-a');
    await clickIn(editor, 'desktop', 'card-b', { shift: true });
    await clickIn(editor, 'desktop', 'card-c', { shift: true });
    expect((await editor.selection()).sort()).toEqual(ids);
    await sizeSelect(page, 'Width').selectOption('auto');
    for (const id of ids) await expect(editor).toHaveStyle(id, 'width', null, { path: PAGE });
    for (const id of ids) await expect.poll(async () => (await cssSize(editor, 'desktop', id))?.w, `${id} hugs the master`).toBe(240);
    // Not: only the first instance hugging.
    expect(ids.filter(id => /width:\s*'400px'/.test(tagOf(before, id))).length).toBe(3);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    await editor.undo();
    await expect.poll(() => editor.code(PAGE)).toBe(before);

    // Tablet: same three, on the replica tile.
    await page.keyboard.press('Escape');
    await clickIn(editor, 'tablet', 'card-a');
    await clickIn(editor, 'tablet', 'card-b', { shift: true });
    await clickIn(editor, 'tablet', 'card-c', { shift: true });
    expect((await editor.selection()).sort()).toEqual(ids);
    await sizeSelect(page, 'Width').selectOption('auto');
    for (const id of ids) await expect(editor).toHaveBandStyle(768, id, 'width', 'auto', { path: PAGE });
    const code = await editor.code(PAGE);
    for (const id of ids) {
      expect(tagOf(code, id), `${id} carries the hug marker`).toMatch(/data-size-hug="width"/);
      expect(tagOf(code, id)).toMatch(/width:\s*'400px'/);
    }
    // (What the Tablet tile paints for a band auto is CMP-198's.) The band never leaks to the primary.
    for (const id of ids) expect((await cssSize(editor, 'desktop', id))?.w).toBe(400);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });
});

// ─── CMP-201 ─────────────────────────────────────────────────────────

test('CMP-201 dragging the right resize handle of a px-width / auto-height instance writes only width', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(inst('Card', 'card-a', `position: 'relative', width: '400px', flex: '0 0 auto'`)), { imports: [imp('Card')] }), { Card: CARD240 }));
  const before = await editor.code(PAGE);
  await clickIn(editor, 'desktop', 'card-a');
  await expect(sizeSelect(page, 'Height')).toHaveValue('auto');

  // A hug height leaves only the horizontal circles.
  await expect(page.locator('[data-resize-dir="right"]')).toHaveCount(1);
  await expect(page.locator('[data-resize-dir="bottomRight"]')).toHaveCount(0);
  const handle = page.locator('[data-resize-edge="right"]').first();
  await page.waitForTimeout(650);
  const hb = (await handle.boundingBox())!;
  const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height * 0.3 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const units: string[] = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + 6 * i, from.y);
    await page.waitForTimeout(30);
    if (i % 4 === 0) units.push(await sizeSelect(page, 'Height').inputValue());
  }
  units.push(await sizeSelect(page, 'Height').inputValue());
  await page.mouse.up();
  await editor.settled();

  expect(units.every(u => u === 'auto'), `Height unit mid-gesture: ${units.join(',')}`).toBe(true);
  await expect(editor).not.toHaveStyle('card-a', 'width', '400px', { path: PAGE });
  const w = parseFloat((await editor.style('card-a', PAGE)).width);
  expect(w).toBeGreaterThan(420);
  // Only width is written: no height key appears on the tag.
  expect(styleKeys(tagOf(await editor.code(PAGE), 'card-a'))).not.toMatch(/\bheight\s*:/);
  await expect(sizeSelect(page, 'Height')).toHaveValue('auto');
  expect((await cssSize(editor, 'desktop', 'card-a'))?.h).toBe(160);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

// ─── CMP-203 ─────────────────────────────────────────────────────────

const PILLS_SEED = c7Seed(c7Page(root(`
<div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '16px', padding: '0px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
  ${inst('LinkPill', 'pill-a')}
  ${inst('ButtonPill', 'btn-a')}
</div>`), { imports: [imp('LinkPill'), imp('ButtonPill')] }), { LinkPill: LINK_PILL, ButtonPill: BUTTON_PILL });

test('CMP-203 an <a> / <button> pill root measures its 36px border box on canvas like live; authored inline-flex kept', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(PILLS_SEED);
  const pill = await cssSize(editor, 'desktop', 'pill-a');
  const pillRoot = await cssSizeOfNode(editor, 'pill-a:lp-root');
  const row = await cssSize(editor, 'desktop', 'row');
  // The wrapper measures the root's border box (12 + 12 + 12px line), not one line-height.
  expect(pillRoot!.h).toBe(36);
  expect(pill!.h).toBe(36);
  expect(Math.abs(pill!.w - pillRoot!.w)).toBeLessThanOrEqual(1);
  // Not: a 17px wrapper around a 36px pill, the row too short for it.
  expect(pill!.h).toBeGreaterThan(20);
  expect(row!.h).toBeGreaterThanOrEqual(36);
  // Nothing overflows the row.
  const rowBox = await stableBoxIn(editor, 'desktop', 'row');
  for (const n of ['pill-a:lp-root', 'btn-a:bp-root']) {
    const b = (await editor.sandbox().locator(`[data-node-id="${n}"]`).first().boundingBox())!;
    expect(b.y + b.height, `${n} inside the row`).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  }
  // The <button> root keeps its authored inline-flex (no blockify).
  expect(await editor.sandbox().locator('[data-node-id="btn-a:bp-root"]').first().evaluate(el => getComputedStyle(el).display)).toBe('inline-flex');
  const btnRoot = await cssSizeOfNode(editor, 'btn-a:bp-root');
  expect(btnRoot!.h).toBe(36);
  expect((await cssSize(editor, 'desktop', 'btn-a'))!.h).toBeGreaterThanOrEqual(36);

  // Live parity: the preview paints the same 36px pill in a row that holds it.
  const frame = await openPreview(editor, '[data-id="pill-a"]');
  await expect.poll(async () => (await previewBox(frame, 'pill-a'))?.h).toBe(36);
  const live = (await previewBox(frame, 'pill-a'))!;
  expect(Math.abs(live.w - pill!.w)).toBeLessThanOrEqual(2);
});

// ─── CMP-204 ─────────────────────────────────────────────────────────

test('CMP-204 a hug master root opened on its own artboard renders at its max-content width, as on the page', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(c7Seed(c7Page(root(`
<div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '16px', flex: '0 0 auto' }}>
  ${inst('HugPill', 'hug-a')}
</div>`), { imports: [imp('HugPill')] }), { HugPill: HUG_PILL }));
  const onPage = (await cssSize(editor, 'desktop', 'hug-a'))!;
  const labelOnPage = (await cssSizeOfNode(editor, 'hug-a:hp-label'))!;
  expect(labelOnPage.h).toBe(20); // one line
  expect(onPage.w).toBeGreaterThan(133);

  // Setup: open the master (the tiles become its artboards).
  await editor.openFile('components/HugPill.tsx');
  await expect.poll(() => editor.activeFile()).toBe('components/HugPill.tsx');
  await editor.sandbox().locator('[data-node-id="hp-root"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await editor.settled();
  await expect.poll(async () => (await cssSizeOfNode(editor, 'hp-root'))?.w).toBe(onPage.w);
  const label = (await cssSizeOfNode(editor, 'hp-label'))!;
  expect(label.h, 'the label stays on one line').toBe(20);
  expect(label.w).toBe(labelOnPage.w);
  // Not: a 133px artboard wrapping the label.
  expect((await cssSizeOfNode(editor, 'hp-root'))!.h).toBe(44);
});

// ─── CMP-205 ─────────────────────────────────────────────────────────

test('CMP-205 a clipping master root keeps its box-shadow outside the instance on canvas, like the preview', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(`
<div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '60px', padding: '40px', backgroundColor: '#ffffff', flex: '0 0 auto' }}>
  ${inst('ShadowCard', 'shadow-a')}
</div>`), { imports: [imp('ShadowCard')] }), { ShadowCard: SHADOW_CARD }));
  const wrap = await editor.nodeIn('desktop', 'shadow-a');
  const facts = await wrap.evaluate(el => {
    const cs = getComputedStyle(el);
    return { overflow: cs.overflow, minW: cs.minWidth, minH: cs.minHeight };
  });
  // The wrapper never clips; it carries the root's min-size effect (min 0) instead.
  expect(facts.overflow).toBe('visible');
  expect(facts.minW).toBe('0px');
  expect(facts.minH).toBe('0px');
  // The root still clips its own children and carries the shadow.
  expect(await computedIn(editor, 'desktop', 'shadow-a:sc-root', 'overflow')).toBe('hidden');

  // Paint: 6 canvas px right of the instance is the red shadow ring, not the white row.
  const b = await stableBoxIn(editor, 'desktop', 'shadow-a');
  const scale = b.width / 200;
  const px = await pixelAt(page, b.x + b.width + 6 * scale, b.y + b.height / 2);
  expect(near(px, '#ff0000'), `canvas pixel outside the instance: ${px}`).toBe(true);
  const outside = await pixelAt(page, b.x + b.width + 30 * scale, b.y + b.height / 2);
  expect(near(outside, '#ffffff'), `canvas pixel past the ring: ${outside}`).toBe(true);

  // Live: the same ring outside the same box.
  const frame = await openPreview(editor, '[data-id="shadow-a"]');
  await expect.poll(async () => (await previewBox(frame, 'shadow-a'))?.w).toBe(200);
  const lb = (await frame.locator('[data-id="shadow-a"]').first().boundingBox())!;
  const lpx = await pixelAt(page, lb.x + lb.width + 6 * (lb.width / 200), lb.y + lb.height / 2);
  expect(near(lpx, '#ff0000'), `preview pixel outside the instance: ${lpx}`).toBe(true);
});

// ─── CMP-199 ─────────────────────────────────────────────────────────

const PANEL = 'components/Panel.tsx';
const BOX_FILE = 'components/Box.tsx';
const blank = c7Page(root(`<div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '200px', height: '100px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>`));

async function openMaster(editor: Parameters<typeof clickIn>[0], path: string, waitNode: string): Promise<void> {
  await editor.openFile(path);
  await expect.poll(() => editor.activeFile()).toBe(path);
  await editor.sandbox().locator(`[data-node-id$="${waitNode}"]`).first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}

test('CMP-199 Height → auto on variant-1 of a nested instance writes an auto branch + marker, bakes and tracks the nested master', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(blank, { Box: BOX, Panel: panelMaster() }));
  await openMaster(editor, PANEL, 'variant-1-box-inst');
  const before = await editor.code(PANEL);
  await clickIn(editor, 'variant-1', 'box-inst');
  expect(await editor.selection()).toEqual(['box-inst']);
  await sizeSelect(page, 'Height').selectOption('auto');

  // Source: an 'auto' branch in the ordinary style ternary + the runtime marker.
  const code = await pollCode(editor, PANEL, c => /data-size-hug="height"/.test(tagOf(c, 'box-inst')));
  const tag = tagOf(code, 'box-inst');
  expect(tag).toMatch(/height:\s*(initialVariant|variant)\s*===\s*'variant-1'\s*\?\s*'auto'\s*:\s*'419px'/);
  expect(tag).toMatch(/data-size-hug="height"/);
  expect(tag).not.toMatch(/\sheight=\{/);

  // Canvas: variant-1 bakes auto to the nested master's 120px; default keeps 419px.
  await expect.poll(async () => (await cssSize(editor, 'variant-1', 'box-inst'))?.h).toBe(120);
  expect((await cssSize(editor, 'desktop', 'box-inst'))?.h).toBe(419);
  // The Size tool shows Auto, and the hug axis has no resize circles.
  await expect(sizeSelect(page, 'Height')).toHaveValue('auto');
  await expect(page.locator('[data-resize-dir="right"]')).toHaveCount(1);
  for (const dir of ['top', 'bottom', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight']) {
    await expect(page.locator(`[data-resize-dir="${dir}"]`), `no ${dir} circle`).toHaveCount(0);
  }
  await expect(page.locator('[data-resize-edge="top"], [data-resize-edge="bottom"]')).toHaveCount(0);
  await expect(editor).toUndoInOneStep(before, { path: PANEL });

  // The nested master's root height changes → the baked hug tracks it.
  await openMaster(editor, BOX_FILE, 'box-root');
  await clickIn(editor, 'desktop', 'box-root');
  const h = sizeInput(page, 'Height');
  await h.click();
  await h.press('ControlOrMeta+a');
  await h.fill('150');
  await h.press('Enter');
  await expect(editor).toHaveStyle('box-root', 'height', '150px', { path: BOX_FILE });
  await openMaster(editor, PANEL, 'variant-1-box-inst');
  await expect.poll(async () => (await cssSize(editor, 'variant-1', 'box-inst'))?.h).toBe(150);
  expect((await cssSize(editor, 'desktop', 'box-inst'))?.h).toBe(419);
});

// ─── CMP-200 ─────────────────────────────────────────────────────────

test("CMP-200 a nested instance's '' else-branch height shows the master's own height live, matching the canvas", { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(c7Seed(c7Page(root(inst('Nav', 'nav-a')), { imports: [imp('Nav')] }), { Chip: CHIP, Nav: NAV_X }));
  // Canvas: the '' branch is no value — the Chip master's own 48px.
  await expect.poll(async () => (await cssSizeOfNode(editor, 'nav-a:nav-chip'))?.h).toBe(48);
  const canvasW = (await cssSizeOfNode(editor, 'nav-a:nav-chip'))!.w;

  // Live: the same 48px on the primary, before any hover.
  const frame = await openPreview(editor, '[data-id="nav-chip"]');
  const first = await previewBox(frame, 'nav-chip');
  expect(first, 'the nested chip renders').not.toBeNull();
  expect(first!.h, 'not collapsed until hover').toBe(48);
  expect(first!.w).toBe(canvasW);
  await expect.poll(async () => (await previewBox(frame, 'nav-chip'))?.h).toBe(48);
});

// ─── CMP-207 ─────────────────────────────────────────────────────────

test.describe('three tiles: canvas instance into a replica', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-207 a canvas instance dropped into the Tablet root is hidden inline, restored to the root display on Tablet only', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
    await editor.load(SEEDS.INSTANCE_CANVAS_3VP, { fit: true });
    const before = await editor.code(PAGE);
    await prime(editor, 'card-inst');
    const box = await editor.nodeBox('card-inst');
    const rootB = await editor.nodeBoxIn('tablet', 'root');
    const hero = await editor.nodeBoxIn('tablet', 'hero');
    const from = { x: box.x + box.width / 2 + 6, y: box.y + box.height / 2 + 4 };
    const to = { x: rootB.x + rootB.width / 2, y: hero.y + hero.height + (rootB.y + rootB.height - hero.y - hero.height) * 0.4 };
    const gap = { x: rootB.x - 16, y: to.y };
    let engaged = false;
    await gesture(editor, from, [{ x: gap.x, y: from.y }, gap, to], {
      steps: 14,
      atWaypoint: async (i) => {
        if (i !== 0) return;
        const now = await quickBox(editor.sandbox().locator('[data-id="card-inst"]'));
        engaged = !now || Math.abs(now.x - box.x) > 4 || Math.abs(now.y - box.y) > 4;
      },
    });
    expect(engaged, 'the drag picked the instance up').toBe(true);
    await expect.poll(() => editor.parentOf('card-inst', PAGE)).toBe('root');

    // Source: inline hide on the tag, the Tablet band restores the master ROOT display.
    await expect(editor).toHaveStyle('card-inst', 'display', 'none', { path: PAGE });
    await expect(editor).toHaveBandStyle(768, 'card-inst', 'display', 'flex', { path: PAGE });
    await expect(editor).toHaveBandStyle(375, 'card-inst', 'display', 'none', { path: PAGE });
    const code = await editor.code(PAGE);
    expect(code, 'no band at the primary width').not.toContain('max-width: 1440px');
    expect(tagOf(code, 'card-inst')).not.toContain('data-canvas-node');

    // Tiles: visible on Tablet only.
    await expect.poll(() => computedIn(editor, 'tablet', 'card-inst', 'display')).toBe('flex');
    expect(await computedIn(editor, 'desktop', 'card-inst', 'display')).toBe('none');
    expect(await computedIn(editor, 'mobile', 'card-inst', 'display')).toBe('none');
    const inner = await cssSizeOfNode(editor, 'tablet-card-inst:card-root');
    expect(inner!.h).toBeGreaterThan(20);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    // Back to the seed (the inline display:'none' recipe trips the oracle, see DND-155).
    await editor.undo();
    await expect.poll(() => editor.code(PAGE)).toBe(before);
  });
});

// ─── CMP-210 ─────────────────────────────────────────────────────────

test('CMP-210 double-clicking the padding of a whitespace-only frame around an instance opens no text editor', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(
    `<div data-id="wrap" data-name="Wrap" style={{ position: 'relative', display: 'flex', padding: '40px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}> ${inst('Card', 'card-a')} </div>`,
  ), { imports: [imp('Card')] }), { Card: CARD_2V }));
  const before = await editor.code(PAGE);
  const wrap = await stableBoxIn(editor, 'desktop', 'wrap');
  const scale = wrap.width / (240 + 80);
  const p = { x: wrap.x + 12 * scale, y: wrap.y + 12 * scale };
  await page.waitForTimeout(450);
  await dblclickAt(page, p);
  await page.waitForTimeout(1200);
  await editor.settled();

  expect(await isTextEditing(editor), 'no text editor on the frame').toBe(false);
  await page.keyboard.press('Escape');
  await editor.settled();
  const code = await editor.code(PAGE);
  expect(code).toBe(before);
  expect(tagOf(code, 'card-a')).toMatch(/^<Card\b/);
  // The instance keeps rendering its master — not text rows of its variant labels.
  expect(await cssSize(editor, 'desktop', 'card-a')).toEqual({ w: 240, h: 160 });
  const wrapText = await (await editor.nodeIn('desktop', 'wrap')).innerText();
  expect(wrapText).toContain('Card title');
  expect(wrapText).not.toMatch(/Default|Hover/);
});

// ─── CMP-211 ─────────────────────────────────────────────────────────

test('CMP-211 a pasted design instance is a childless tag on a page with no MotionLink const', { tag: ['@p1', '@cmp'] }, async ({ editor, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The About root is a plain block: a paste into an ORDERED flex column omits
  // `order` on the new child (FLEX_CHILD_MISSING_ORDER) — not this row's subject.
  await editor.load(c7Seed(c7Page(root(inst('LinkPill', 'pill-a')), { imports: [imp('LinkPill')] }), { LinkPill: LINK_PILL }, {
    'app/about/page.tsx': SERVER_WRAPPER,
    [ABOUT]: c7Page(root(`<div data-id="about-box" data-name="Box" style={{ position: 'relative', width: '300px', height: '80px', backgroundColor: '#1a1a3a' }}></div>`,
      { id: 'about-root', style: `position: 'relative', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a', padding: '40px'` })),
  }));
  expect(await editor.code(ABOUT)).not.toContain('MotionLink');
  await clickIn(editor, 'desktop', 'pill-a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(300);

  await editor.openFile(ABOUT); // setup: switch page
  await expect.poll(() => editor.activeFile()).toBe(ABOUT);
  await editor.sandbox().locator('[data-id="about-box"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await editor.settled();
  await editor.fitCamera();
  const before = await editor.code(ABOUT);
  await clickIn(editor, 'desktop', 'about-box');
  expect(await editor.selection()).toEqual(['about-box']);
  await page.keyboard.press('ControlOrMeta+v');

  const code = await pollCode(editor, ABOUT, c => /<LinkPill\b/.test(c));
  const opens = code.match(/<LinkPill\b/g) ?? [];
  expect(opens.length, 'one pasted instance tag').toBe(1);
  // Childless: nothing between the tag and its close — no master internals pasted as real children.
  const el = code.match(/<LinkPill\b[\s\S]*?(\/>|<\/LinkPill>)/)![0];
  const inner = el.endsWith('</LinkPill>') ? el.slice(el.indexOf('>', el.lastIndexOf('}}')) + 1, -'</LinkPill>'.length) : '';
  expect(inner.trim(), 'no children inside the pasted instance').toBe('');
  expect(code).not.toContain('MotionLink');
  expect(code).not.toContain('lp-root');
  expect(code).toMatch(/import LinkPill from '@\/components\/LinkPill'/);
  const id = el.match(/data-id="([^"]+)"/)![1];
  // Content comes from the master: the pasted instance paints its label, once.
  await expect.poll(async () => (await (await editor.nodeIn('desktop', id)).innerText().catch(() => '')).trim()).toBe('Get started');
  expect(await editor.sandbox().locator(`[data-node-id^="${id}:"]`).count()).toBeGreaterThan(0);
  await expect(editor).toUndoInOneStep(before, { path: ABOUT });
});

// ─── CMP-212 ─────────────────────────────────────────────────────────

test('CMP-212 a dim write migrates the legacy prop dialect to the style ternary in the same write; a re-run is a no-op', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  test.fail(true, "BUG: a px dim write on a nested instance inside a master never migrates the legacy prop dialect — replica-context routes width/height (CONDITIONAL_LAYOUT_PROPS) through `setConditionalStyle`, which skips the migrateInstanceDimPropToStyle pre-pass of updateStyles/updateVariantStyle, so `height={initialVariant === 'v1' ? undefined : '419px'}` survives next to a new `height: '41px'` style key (only the auto press migrates)");
  await editor.load(c7Seed(blank, {
    Box: BOX,
    Panel: panelMaster({ second: 'v1', boxAttrs: `height={initialVariant === 'v1' ? undefined : '419px'}`, boxStyle: `position: 'relative', width: '200px', height: '100%', flex: '0 0 auto'` }),
  }));
  await openMaster(editor, PANEL, 'v1-box-inst');
  const before = await stableCode(editor, PANEL);
  expect(tagOf(before, 'box-inst')).toMatch(/\sheight=\{/);

  // The dim write: Height unit % → px on the primary tile.
  await clickIn(editor, 'desktop', 'box-inst');
  await sizeSelect(page, 'Height').selectOption('px');
  const code = await pollCode(editor, PANEL, c => c !== before);
  const tag = tagOf(code, 'box-inst');
  // One write: the attr is gone and the style carries the ternary (legacy undefined → 'auto').
  expect(tag).not.toMatch(/\sheight=\{/);
  expect(tag).toMatch(/height:\s*initialVariant\s*===\s*'v1'\s*\?\s*'auto'\s*:\s*'\d+px'/);
  expect(tag).not.toMatch(/height:\s*'100%'/);
  expect(tag).toMatch(/data-size-hug="height"/);
  await expect(editor).toPassOracle();
  await expect.poll(async () => (await cssSize(editor, 'v1', 'box-inst'))?.h).toBe(120);
  await expect(editor).toUndoInOneStep(before, { path: PANEL });

  // Re-running the write (the same px value typed again) is a byte no-op.
  const migrated = await stableCode(editor, PANEL);
  const px = tag.match(/'(\d+)px'/)![1];
  const h = sizeInput(page, 'Height');
  await h.click();
  await h.press('ControlOrMeta+a');
  await h.fill(px);
  await h.press('Enter');
  await editor.settled();
  await page.waitForTimeout(600);
  expect(await editor.code(PANEL)).toBe(migrated);
});

// ─── CMP-213 ─────────────────────────────────────────────────────────

test('CMP-213 a zoom settle re-rasters a self-promoted instance root; a pure pan leaves it alone', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(inst('Neon', 'neon-a')), { imports: [imp('Neon')] }), { Neon: PROMOTED }));
  const node = 'neon-a:neon-root';
  await editor.sandbox().locator(`[data-node-id="${node}"]`).first().waitFor({ state: 'attached' });
  const frame = page.frames().find(f => f.url().includes('5174'))!;
  const watch = () => frame.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    const w = window as unknown as { __wc: string[]; __wcObs?: MutationObserver };
    w.__wcObs?.disconnect();
    w.__wc = [];
    w.__wcObs = new MutationObserver(() => { w.__wc.push(el.style.willChange); });
    w.__wcObs.observe(el, { attributes: true, attributeFilter: ['style'] });
  }, node);
  const seen = () => frame.evaluate(() => (window as unknown as { __wc: string[] }).__wc.slice());
  expect(await editor.sandbox().locator(`[data-node-id="${node}"]`).first().evaluate(el => (el as HTMLElement).style.willChange)).toBe('transform');
  await page.waitForTimeout(600);

  // Zoom: released to auto, then promoted again.
  await watch();
  const canvas = (await page.locator('iframe[src*="5174"]').first().boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+=');
  await expect.poll(async () => (await seen()).includes('auto'), { timeout: 5_000 }).toBe(true);
  await expect.poll(async () => (await seen()).at(-1)).toBe('transform');

  // A pan (no zoom change) never releases it.
  await page.waitForTimeout(800);
  await watch();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(1000);
  expect(await seen()).not.toContain('auto');
  expect(await editor.sandbox().locator(`[data-node-id="${node}"]`).first().evaluate(el => (el as HTMLElement).style.willChange)).toBe('transform');
});

// ─── CMP-214 ─────────────────────────────────────────────────────────

const SCOPED_STYLE = `<style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="inst"] { width: 300px !important; }
      [data-id="inst:card-title"] { font-size: 14px !important; }
      [data-id="inst-11"] { width: 320px !important; }
      [data-id="inst-11:card-title"] { font-size: 12px !important; }
    }
    [data-id="inst:card-root"]:hover { background-color: #ff2d75; }
    [data-id="inst-11:card-root"]:hover { background-color: #00ff88; }
  \`}</style>`;

test.describe('three tiles: scoped CSS', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test("CMP-214 deleting an instance removes its own and its children's scoped rules, not a sibling's with a longer id", { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(c7Seed(c7Page(root(`${SCOPED_STYLE}
${inst('Card', 'inst', `position: 'relative', width: '400px', flex: '0 0 auto'`)}
${inst('Card', 'inst-11', `position: 'relative', width: '400px', flex: '0 0 auto'`)}`), { tiles: TILES.three, imports: [imp('Card')] }), { Card: CARD240 }), { fit: true });
    const before = await editor.code(PAGE);
    await clickIn(editor, 'desktop', 'inst');
    expect(await editor.selection()).toEqual(['inst']);
    await page.keyboard.press('Delete');
    await expect.poll(() => editor.exists('inst', PAGE)).toBe(false);

    const code = await stableCode(editor, PAGE);
    expect(code).not.toContain('[data-id="inst"]');
    expect(code).not.toContain('[data-id="inst:');
    expect(code).toContain('[data-id="inst-11"] { width: 320px !important; }');
    expect(code).toContain('[data-id="inst-11:card-title"] { font-size: 12px !important; }');
    expect(code).toContain('[data-id="inst-11:card-root"]:hover { background-color: #00ff88; }');
    expect(await editor.exists('inst-11', PAGE)).toBe(true);
    // The survivor still paints its own tablet rule.
    expect((await cssSize(editor, 'tablet', 'inst-11'))?.w).toBe(320);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });
});

// ─── CMP-206 ─────────────────────────────────────────────────────────

/** Drag a Library row to a screen point with real pointer events (press on
 *  the row, glide, pump), proving mid-gesture that the toolbar drag engaged. */
async function dragLibraryRow(editor: Parameters<typeof clickIn>[0], name: string, to: { x: number; y: number }): Promise<void> {
  const page = editor.page();
  const row = await libraryRow(page, name);
  const rb = (await row.boundingBox())!;
  const from = { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 };
  const raf = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  const startCount = (await traces(editor, 'toolbar-drag:move')).length;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * i / 20, from.y + (to.y - from.y) * i / 20);
      await raf();
    }
    for (let i = 0; i < 8; i++) { await page.mouse.move(to.x + (i % 2), to.y + ((i + 1) % 2)); await raf(); }
    await page.mouse.move(to.x, to.y);
    await raf();
    expect((await traces(editor, 'toolbar-drag:move')).length, 'the library drag engaged').toBeGreaterThan(startCount);
  } finally {
    await page.mouse.up();
  }
  await editor.settled();
}

test('CMP-206 a Library drop seeds the master root size (760px/auto, relative, flex none); a hug drop on the canvas lands centred', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(`<div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '200px', height: '100px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>`)), { FAQItem: FAQ_ITEM, HugPill: HUG_PILL }));
  // Onto the page root (a flex column).
  const pageRoot = await editor.nodeBox('root');
  await dragLibraryRow(editor, 'FAQItem', { x: pageRoot.x + pageRoot.width / 2, y: pageRoot.y + pageRoot.height * 0.6 });
  let code = await pollCode(editor, PAGE, c => /<FAQItem\b/.test(c));
  const faqId = code.match(/<FAQItem\b[^>]*?data-id="([^"]+)"/)![1];
  const faq = await editor.style(faqId, PAGE);
  expect(faq.position).toBe('relative');
  expect(faq.width).toBe('760px');
  expect(faq.height).toBe('auto');
  expect(faq.flex).toBe('0 0 auto');
  expect(await editor.parentOf(faqId, PAGE)).toBe('root');
  // Not: a forced 300×200 box.
  expect(await cssSize(editor, 'desktop', faqId)).toMatchObject({ w: 760 });
  expect((await cssSize(editor, 'desktop', faqId))!.h).not.toBe(200);

  // A hug (auto/auto) master onto EMPTY canvas: no dims written, re-centred under the cursor.
  const before = await stableCode(editor, PAGE);
  const drop = { x: 1100, y: 130 };
  await dragLibraryRow(editor, 'HugPill', drop);
  code = await pollCode(editor, PAGE, c => /<HugPill\b/.test(c));
  const hugId = code.match(/<HugPill\b[^>]*?data-id="([^"]+)"/)![1];
  const hug = await editor.style(hugId, PAGE);
  expect(tagOf(code, hugId)).toContain('data-canvas-node');
  expect(hug.position).toBe('absolute');
  expect(hug.width).toBeUndefined();
  expect(hug.height).toBeUndefined();
  await expect.poll(async () => {
    const b = await quickBox(editor.sandbox().locator(`[data-id="${hugId}"]`));
    return b ? Math.hypot(b.x + b.width / 2 - drop.x, b.y + b.height / 2 - drop.y) : 999;
  }, { message: 'the hug drop is centred on the cursor' }).toBeLessThan(4);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // The hug instance paints at its master's natural size: the one-line label fits inside the pill.
  test.fail(true, "BUG: a hug design instance dropped on the bare canvas paints at its MIN-content width — the absolute wrapper shrink-to-fits against the 0-wide canvas root (89px pill) while its one-line label is 177px and spills out; on the page / artboard the same master hugs its max-content (CMP-204)");
  const label = (await cssSizeOfNode(editor, `${hugId}:hp-label`))!;
  const pill = (await cssSizeOfNode(editor, `${hugId}:hp-root`))!;
  expect(label.h).toBe(20);
  expect(pill.w).toBeGreaterThanOrEqual(label.w + 36);
});

// ─── CMP-208 ─────────────────────────────────────────────────────────

test('CMP-208 live: absolute-root instances without a position sit in flow; a popLayout SignUp re-bases inside its wrapper', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(c7Seed(c7Page(root(`
<div data-id="tiles" data-name="Tiles" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '20px', flex: '0 0 auto', order: '0' }}>
  <Tile data-id="t-1" data-name="Tile" style={{ flex: '0 0 auto', order: '0' }} />
  <Tile data-id="t-2" data-name="Tile" style={{ flex: '0 0 auto', order: '1' }} />
  <Tile data-id="t-3" data-name="Tile" style={{ flex: '0 0 auto', order: '2' }} />
</div>
${inst('PopHeader', 'hdr', `position: 'relative', flex: '0 0 auto', order: '1'`)}`), { imports: [imp('Tile'), imp('PopHeader')] }), { Tile: ABS_TILE, SignUp: SIGNUP_MASTER, PopHeader: POP_HEADER }));
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  // Canvas: side by side.
  const c = await Promise.all(['t-1', 't-2', 't-3'].map(id => stableBoxIn(editor, 'desktop', id)));
  expect(c[1].x).toBeGreaterThan(c[0].x + c[0].width - 1);

  const frame = await openPreview(editor, '[data-id="t-3"]');
  const live = await Promise.all(['t-1', 't-2', 't-3'].map(id => previewBox(frame, id)));
  for (const b of live) {
    expect(b, 'every tile renders').not.toBeNull();
    expect(b!.position, 'the runtime injects relative').toBe('relative');
    expect(b!.w).toBe(120);
    expect(b!.h).toBe(80);
  }
  // In flow, side by side: same row, each 20px after the previous one.
  expect(Math.abs(live[1]!.y - live[0]!.y)).toBeLessThan(1);
  expect(Math.abs(live[2]!.y - live[0]!.y)).toBeLessThan(1);
  expect(live[1]!.x - live[0]!.x).toBeCloseTo(140, 0);
  expect(live[2]!.x - live[1]!.x).toBeCloseTo(140, 0);

  // The SignUp inside popLayout: its inner root is re-based relative and paints inside the header.
  const header = (await previewBox(frame, 'hdr'))!;
  const signups = frame.locator('[data-id="ph-signup"]');
  await expect.poll(() => signups.count()).toBeGreaterThan(0);
  const boxes = await signups.evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, position: getComputedStyle(el).position, mroot: el.getAttribute('data-mroot'), tag: el.tagName };
  }));
  const inner = boxes.find(b => b.tag === 'A') ?? boxes[boxes.length - 1];
  expect(inner.position, 'the inner root is re-based relative').toBe('relative');
  expect(inner.w).toBeGreaterThan(20);
  expect(inner.h).toBeGreaterThan(20);
  expect(inner.x).toBeGreaterThanOrEqual(header.x);
  expect(inner.x + inner.w).toBeLessThanOrEqual(header.x + header.w + 1);
  expect(inner.y).toBeGreaterThanOrEqual(header.y - 1);
  expect(inner.y + inner.h).toBeLessThanOrEqual(header.y + header.h + 1);
  await expect(frame.getByText('Sign Up', { exact: true }).first()).toBeVisible();
});

// ─── CMP-209 ─────────────────────────────────────────────────────────

const NAV_PAGE = (pos: string) => c7Page(root(`
${inst('NavBar', 'nav', `position: '${pos}', top: '0px', left: '0px', width: '100%', flex: '0 0 auto', order: '0'`)}
${inst('Card', 'card-a', `position: 'relative', flex: '0 0 auto', order: '1'`)}
<Link data-id="to-other" data-name="Link" href="/other" style={{ position: 'relative', fontSize: '20px', color: '#ffffff', flex: '0 0 auto', order: '2' }}>Go to other</Link>`), { imports: [`import Link from 'next/link';`, imp('NavBar'), imp('Card')] });

test('CMP-209 Position → Fixed then Sticky on an instance gives its master root the layoutScroll/layout pair; no slide on navigation', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(NAV_PAGE('relative').replace(`top: '0px', left: '0px', `, ''), { NavBar: NAV_BAR, Card: CARD240 }, {
    'app/other/page.tsx': SERVER_WRAPPER,
    'app/other/page.client.tsx': c7Page(root(`${inst('NavBar', 'nav-o', `position: 'fixed', top: '0px', left: '0px', width: '100%', flex: '0 0 auto', order: '0'`)}
<p data-id="other-text" data-name="Text" style={{ position: 'relative', marginTop: '120px', fontSize: '20px', color: '#ffffff', flex: '0 0 auto', order: '1' }}>Other page</p>`, { id: 'other-root' }), { imports: [imp('NavBar')] }),
  }));
  const NAV = 'components/NavBar.tsx';
  const CARD = 'components/Card.tsx';
  const before = await editor.code(PAGE);
  const navBefore = await editor.code(NAV);
  const cardBefore = await editor.code(CARD);
  await clickIn(editor, 'desktop', 'nav', { fx: 0.8 });
  expect(await editor.selection()).toEqual(['nav']);
  const type = panel(page).locator('select:has(option[value="sticky"])').first();
  await type.selectOption('fixed');

  await expect(editor).toHaveStyle('nav', 'position', 'fixed', { path: PAGE });
  const CHECK = "(style as any)?.position === 'fixed' || (style as any)?.position === 'sticky'";
  const nav = await pollCode(editor, NAV, c => c.includes('layoutScroll'));
  const rootTag = tagOf(nav, 'nb-root');
  expect(rootTag).toContain(`layoutScroll={(${CHECK})}`);
  expect(rootTag).toContain(`layout={(${CHECK}) ? "size" : true}`);
  expect(rootTag.match(/\slayout=/g)?.length, 'one layout attr').toBe(1);
  // Relative masters untouched.
  expect(await editor.code(CARD)).toBe(cardBefore);
  // One undo restores the page AND the master.
  const afterFixedPage = await editor.code(PAGE);
  const afterFixedNav = await editor.code(NAV);
  await editor.undo();
  await expect.poll(() => editor.code(PAGE)).toBe(before);
  expect(await editor.code(NAV)).toBe(navBefore);
  await editor.redo();
  await expect.poll(() => editor.code(PAGE)).toBe(afterFixedPage);
  expect(await editor.code(NAV)).toBe(afterFixedNav);

  // Sticky keeps the same single pair (idempotent).
  await type.selectOption('sticky');
  await expect(editor).toHaveStyle('nav', 'position', 'sticky', { path: PAGE });
  await editor.settled();
  const sticky = tagOf(await editor.code(NAV), 'nb-root');
  expect(sticky.match(/layoutScroll=/g)?.length).toBe(1);
  expect(sticky).toContain(`layout={(${CHECK}) ? "size" : true}`);
  expect(await editor.code(CARD)).toBe(cardBefore);

  // Live: navigate to a page whose header is fixed — it never animates in.
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  const frame = await openPreview(editor, '[data-id="to-other"]');
  await frame.locator('[data-id="to-other"]').first().click();
  const samples: Array<{ y: number; t: string }> = [];
  await frame.locator('[data-id="other-text"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  for (let i = 0; i < 20; i++) {
    const s = await frame.locator('[data-id="nav-o"]').first().evaluate(el => ({ y: el.getBoundingClientRect().y, t: getComputedStyle(el).transform }));
    samples.push(s);
    await page.waitForTimeout(30);
  }
  expect(samples.every(s => Math.abs(s.y) < 1), `header top over time: ${samples.map(s => s.y.toFixed(1)).join(',')}`).toBe(true);
  expect(samples.every(s => s.t === 'none'), `header transform over time: ${[...new Set(samples.map(s => s.t))].join(' | ')}`).toBe(true);
});
