// CMP · Make Component placement and sizing (E2E_TEST_PLAN.md §8, CMP-004,
// 005, 011..015, 019): the instance keeps the node's slot in its parent, the
// master root gets an artboard size, and nothing jumps on canvas or preview.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  MAKE_COMPONENT_PAGE, MAKE_COMPONENT_BODY, makeComponentPage, makeComponentViaMenu, exitToPage,
  allowMasterEntryNoise, elementFacts, parses, openPreview, previewFacts, boxOrNull,
  allowPreviewNoise,
} from '../../helpers/c1';

const PAGE = 'app/page.client.tsx';

test.beforeEach(async ({ editor }) => {
  // A loaded machine: every row boots the editor and enters a master at least once.
  test.slow();
  allowMasterEntryNoise(editor);
  allowPreviewNoise(editor);
});

/** A node's box in CANVAS px, relative to the page root (camera-independent). */
async function canvasBox(editor: Editor, id: string) {
  const root = await editor.nodeBox('root');
  const b = await editor.nodeBox(id);
  const s = root.width / 1440;
  return { x: (b.x - root.x) / s, y: (b.y - root.y) / s, width: b.width / s, height: b.height / s };
}

function expectBoxClose(a: { x: number; y: number; width: number; height: number }, b: typeof a, tol = 1, what = '') {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - b[k]), `${what} ${k}: ${a[k].toFixed(1)} vs ${b[k].toFixed(1)}`).toBeLessThanOrEqual(tol);
  }
}

const PLACEMENT_PAGE = makeComponentPage({
  body: MAKE_COMPONENT_BODY
    .replace(
      `<div data-id="cell-b"`,
      `<div data-id="cell-c" data-name="Cell C" style={{ position: 'relative', order: '2', gridColumn: '1 / span 2', height: '60px', backgroundColor: '#6a4a8a' }} />
        <div data-id="cell-b"`,
    )
    .replace(
      `<p data-id="label"`,
      `<div data-id="abs" data-name="Abs" style={{ position: 'absolute', left: '900px', top: '80px', zIndex: '1', width: '200px', height: '120px', backgroundColor: '#228866' }} />
      <p data-id="label"`,
    ),
});

test('CMP-004 an absolute node, an ordered sibling and a grid-placed cell keep their placement as instances', { tag: ['@p0', '@cmp'] }, async ({ editor }) => {
  await editor.load(PLACEMENT_PAGE);
  const cases: Array<{ id: string; at: [number, number]; keys: Record<string, string> }> = [
    { id: 'abs', at: [0.5, 0.5], keys: { position: 'absolute', left: '900px', top: '80px', zIndex: '1', width: '200px', height: '120px' } },
    { id: 'cell-c', at: [0.5, 0.5], keys: { position: 'relative', order: '2', gridColumn: '1 / span 2', height: '60px' } },
    { id: 'grid', at: [0.5, 0.2], keys: { position: 'relative', flex: '0 0 auto', order: '2', width: '800px' } },
  ];
  for (const c of cases) {
    const box = await canvasBox(editor, c.id);
    const made = await makeComponentViaMenu(editor, c.id, `C ${c.id}`, { at: c.at });
    const inst = await elementFacts(await editor.code(PAGE), c.id);
    expect(inst?.tag).toBe(made.tag);
    // Placement keys ride the instance tag verbatim.
    expect(await editor.style(c.id, PAGE)).toMatchObject(c.keys);
    await exitToPage(editor);
    // Not: the instance jumped into natural flow.
    await expect.poll(async () => { try { expectBoxClose(await canvasBox(editor, c.id), box, 1, c.id); return true; } catch { return false; } }).toBe(true);
    await editor.page().waitForTimeout(450);
  }
  expect(await parses(await editor.code(PAGE))).toBe(true);
});

test('CMP-005 a bare text node is wrapped in a frame first; the frame becomes the master root', { tag: ['@p0', '@cmp'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);
  const textBox = await canvasBox(editor, 'label');

  const made = await makeComponentViaMenu(editor, 'label', 'Label');
  const master = await editor.code(made.file);
  // The master root is a FRAME holding the text (keeps it in flow).
  const rootId = /data-mroot="([^"]+)"/.exec(master)?.[1];
  expect(rootId).toMatch(/^frame-/);
  expect(await editor.childIds(rootId!, made.file)).toEqual(['label']);
  expect((await editor.style('label', made.file)).position).toBe('relative');
  await expect(editor.node('label')).toHaveText('Bare label');

  // The instance is the frame's id, positioned and carrying the text's placement.
  const page = await editor.code(PAGE);
  expect((await elementFacts(page, rootId!))?.tag).toBe(made.tag);
  expect(await editor.exists('label', PAGE)).toBe(false);
  // Not: an instance with no style that collapses.
  expect(await editor.style(rootId!, PAGE)).toMatchObject({ position: 'relative', order: '4', flex: '0 0 auto', marginTop: '8px' });
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Not: the text disappears from the page.
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  const onPage = editor.sandbox().locator(`[data-id="${rootId}:label"]`).first();
  await expect(onPage).toHaveText('Bare label');
  const b = await onPage.boundingBox();
  expect(b!.height).toBeGreaterThan(0);
  expect(Math.abs((await canvasBox(editor, rootId!)).y - textBox.y)).toBeLessThanOrEqual(1);
});

test('CMP-011 a hug pill stays hug: no frozen root size, no width:100% on the instance, label on one line', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const pillBox = await canvasBox(editor, 'pill');
  const labelH = (await canvasBox(editor, 'pill-label')).height;

  // Aim at the pill's own padding (the label is the deeper hit in its middle).
  const made = await makeComponentViaMenu(editor, 'pill', 'Advisor Pill', { at: [0.04, 0.5] });
  const root = await editor.style('pill', made.file);
  expect(root.width).toBeUndefined();
  expect(root.height).toBeUndefined();
  const inst = await editor.style('pill', PAGE);
  expect(inst.width).toBeUndefined();
  expect(inst).toMatchObject({ position: 'relative', flex: '0 0 auto', order: '0' });

  // One line on the master artboard…
  const masterLabel = await editor.nodeBox('pill-label');
  const masterRoot = await editor.nodeBox('pill');
  expect(masterLabel.height / (masterRoot.width / pillBox.width)).toBeLessThan(labelH * 1.3);
  // …on the page tile…
  await exitToPage(editor);
  expectBoxClose(await canvasBox(editor, 'pill'), pillBox, 1, 'pill');
  // …and in the preview.
  const frame = await openPreview(page, 'Find an advisor');
  const p = await previewFacts(frame, 'pill-label');
  expect(p.height).toBeLessThan(parseFloat(p.fontSize) * 1.6);
  const pill = await previewFacts(frame, 'pill');
  expect(Math.abs(pill.width - pillBox.width)).toBeLessThanOrEqual(2);
});

test('CMP-012 grid cells: a no-width cell gets width:100% on the instance; a 100%×100% cell keeps both', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const aBox = await canvasBox(editor, 'cell-a');
  const bBox = await canvasBox(editor, 'cell-b');

  const a = await makeComponentViaMenu(editor, 'cell-a', 'Cell A');
  // No width key: the master root freezes the measured px, the instance stretches.
  expect((await editor.style('cell-a', a.file)).width).toMatch(/^\d+px$/);
  expect(Math.abs(parseFloat((await editor.style('cell-a', a.file)).width) - aBox.width)).toBeLessThanOrEqual(1);
  expect(await editor.style('cell-a', PAGE)).toMatchObject({ width: '100%', height: '100px', position: 'relative', order: '0' });
  await exitToPage(editor);
  await editor.page().waitForTimeout(450);

  const b = await makeComponentViaMenu(editor, 'cell-b', 'Cell B');
  const masterB = await editor.style('cell-b', b.file);
  expect(masterB.width).toMatch(/^\d+px$/);
  expect(masterB.height).toBe('120px');
  expect(await editor.style('cell-b', PAGE)).toMatchObject({ width: '100%', height: '100%' });
  await exitToPage(editor);

  // Both still fill their cells. Not: an auto×auto instance hugging the frozen size.
  expectBoxClose(await canvasBox(editor, 'cell-a'), aBox, 1, 'cell-a');
  expectBoxClose(await canvasBox(editor, 'cell-b'), bBox, 1, 'cell-b');
});

const TALL_PAGE = makeComponentPage({
  body: MAKE_COMPONENT_BODY.replace(
    `<p data-id="label"`,
    `<div data-id="tall" data-name="Tall" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'column', width: 'fit-content', height: '178px', padding: '10px', backgroundColor: '#aa7733' }}>
        <p data-id="tall-text" data-name="Tall Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#ffffff', margin: '0px' }}>Tall</p>
      </div>
      <p data-id="label"`,
  ),
});

test('CMP-013 a px height rides the instance, so a later master edit does not resize it', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(TALL_PAGE);
  const box = await canvasBox(editor, 'tall');

  const made = await makeComponentViaMenu(editor, 'tall', 'Tall', { at: [0.9, 0.9] });
  const inst = await editor.style('tall', PAGE);
  expect(inst.height).toBe('178px');
  // Fit sizes never ride the instance.
  expect(inst.width).toBeUndefined();

  // In the master: Height → 300 in the Dimensions panel.
  expect(await editor.selection()).toEqual(['tall']);
  const panel = page.locator('[data-tutorial="right-toolbar"]').first();
  const heightRow = panel.locator('div.flex.items-center.justify-between', { has: page.locator('span[title="Height"]') }).first();
  const input = heightRow.locator('input').first();
  await input.click();
  await input.fill('300');
  await input.press('Enter');
  await expect(editor).toHaveStyle('tall', 'height', '300px', { path: made.file });

  // Back on the page the instance is still 178px tall.
  await exitToPage(editor);
  expect((await editor.style('tall', PAGE)).height).toBe('178px');
  await expect.poll(async () => Math.round((await canvasBox(editor, 'tall')).height)).toBe(178);
  expectBoxClose(await canvasBox(editor, 'tall'), box, 1, 'tall');
});

const POSITION_PAGE = makeComponentPage({
  body: MAKE_COMPONENT_BODY.replace(
    `<p data-id="label"`,
    `<div data-id="nopos" data-name="No Pos" style={{ flex: '0 0 auto', order: '5', width: '240px', height: '60px', backgroundColor: '#3388aa' }} />
      <div data-id="sticky" data-name="Sticky" style={{ position: 'sticky', top: '0px', flex: '0 0 auto', order: '6', width: '240px', height: '60px', backgroundColor: '#aa3388' }} />
      <p data-id="label"`,
  ),
});

test('CMP-014 no position key → the instance gets position:relative; sticky stays sticky; copies flow on preview', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(POSITION_PAGE);

  const a = await makeComponentViaMenu(editor, 'nopos', 'No Pos');
  expect((await editor.style('nopos', PAGE)).position).toBe('relative');
  // The master root itself is the absolute tile — which must not leak to the page.
  expect((await editor.style('nopos', a.file)).position).toBe('absolute');
  await exitToPage(editor);
  await editor.page().waitForTimeout(450);

  await makeComponentViaMenu(editor, 'sticky', 'Sticky');
  expect(await editor.style('sticky', PAGE)).toMatchObject({ position: 'sticky', top: '0px' });
  await exitToPage(editor);

  // A second copy of the instance (Ctrl+D) — both must flow on the live page.
  await editor.click('nopos');
  expect(await editor.selection()).toEqual(['nopos']);
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await editor.code(PAGE)).match(new RegExp(`<${a.tag}\\b`, 'g'))?.length ?? 0).toBe(2);

  const frame = await openPreview(page, 'Bare label');
  await expect(frame.locator('[data-mroot="nopos"]')).toHaveCount(2);
  const boxes = await frame.locator('[data-mroot="nopos"]').evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { y: r.y, h: r.height, position: getComputedStyle(e).position };
  }));
  // Not: the master's absolute leaks through ...style and the copies stack.
  for (const b of boxes) expect(b.position).toBe('relative');
  expect(Math.abs(boxes[1].y - boxes[0].y)).toBeGreaterThanOrEqual(boxes[0].h);
  expect((await previewFacts(frame, 'sticky')).position).toBe('sticky');
});

test('CMP-015 a fill child keeps flex:1 0 0px on the instance; the master root gets px + flex 0 0 auto', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the fill instance is also handed width:\'100%\' — a flex-row child with siblings, which the oracle rejects (FLEX_ROW_CHILD_FULL_WIDTH)');
  await editor.load(MAKE_COMPONENT_PAGE);
  const box = await canvasBox(editor, 'fill');

  const made = await makeComponentViaMenu(editor, 'fill', 'Fill');
  const root = await editor.style('fill', made.file);
  expect(root.flex).toBe('0 0 auto');
  expect(Math.abs(parseFloat(root.width) - box.width)).toBeLessThanOrEqual(1);
  // Not: the master artboard collapses to 0px wide.
  expect((await editor.nodeBox('fill')).width).toBeGreaterThan(10);
  expect((await editor.style('fill', PAGE)).flex).toBe('1 0 0px');

  await exitToPage(editor);
  expectBoxClose(await canvasBox(editor, 'fill'), box, 1, 'fill');
  const frame = await openPreview(page, 'Bare label');
  const fixed = await previewFacts(frame, 'fixed');
  const fill = await previewFacts(frame, 'fill');
  // The fill still takes the rest of the 800px row (minus the 200px sibling and the 20px gap).
  expect(Math.abs(fill.width - (800 - 200 - 20))).toBeLessThanOrEqual(1);
  expect(Math.abs(fill.x - (fixed.x + fixed.width + 20))).toBeLessThanOrEqual(1);

  // The instance carries no width the oracle rejects in a row.
  expect((await editor.style('fill', PAGE)).width).toBeUndefined();
  await expect(editor).toPassOracle();
});

test('CMP-019 a free canvas node: the master root drops the canvas placement, the instance keeps it', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);
  const box = await canvasBox(editor, 'floater');

  const made = await makeComponentViaMenu(editor, 'floater', 'Floater');
  const root = await elementFacts(await editor.code(made.file), 'floater');
  expect(root?.attrs).not.toContain('data-canvas-node');
  const rootStyle = await editor.style('floater', made.file);
  expect(rootStyle.left).toBeUndefined();
  expect(rootStyle.top).toBeUndefined();
  // The master renders its variant on the master canvas.
  await expect(editor.node('floater')).toBeVisible();
  expect((await editor.nodeBox('floater')).width).toBeGreaterThan(10);

  // The instance stays a canvas node at the same place.
  const page = await editor.code(PAGE);
  const canvasBlock = page.slice(page.indexOf('const canvasNodes'));
  expect(canvasBlock).toContain(`<${made.tag} data-id="floater"`);
  expect(await editor.style('floater', PAGE)).toMatchObject({ position: 'absolute', left: '-400px', top: '100px' });
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  await expect.poll(async () => (await boxOrNull(editor, 'floater')) !== null).toBe(true);
  expectBoxClose(await canvasBox(editor, 'floater'), box, 1, 'floater');
});
