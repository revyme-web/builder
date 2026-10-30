// CMP · Editing inside a design-component master (E2E_TEST_PLAN.md §8,
// CMP-050…057, 060, 061, 063, 064, 066): hide/unhide, the primary delete
// guard, merged padding, Overlay borders on live, tile drags (variantConfig,
// never left/top), rotation through a tile drag, the entry fit, the purple
// accent, variant delete + redo, copy/paste of bound text, and the isolated
// preview of a master.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  C2_SEED, CARD, PAGE, cardSeed, enterByDoubleClick, dblclickNode, breadcrumb, breadcrumbSegment, waitForActiveFile,
  stableBox, canvasArea, centredIn, within, panel, setFillHex, paintedById, textById, layerHeaderLit,
  oneInstanceSeed, NAV_HAMBURGER_MASTER, PADDED_MASTER, OVERLAY_BORDER_MASTER, LINK_EFFECT_MASTER, ROTATED_MASTER,
  WIDE_MASTER, TALL_MASTER, I18N_FILES, angleOf, clickAt, row,
} from '../../helpers/c2';
import { exitToPage } from '../../helpers/c1';
import { openPreview } from '../../helpers/c3';
import { gesture, glide, center, quickBox, variantEntry, variantConfigOf, selectionBorderAt, stableCode } from '../../helpers/d6';
import { selectionOverlay, cssColor } from '../../helpers/d1';
import { COMPONENT_MASTER } from '../../../src/canvas/drag/e2e/fixtures/seeds';

const PREVIEW_NOISE = /unique "key" prop/;

/** Setup only: open a master file (its own entry is covered by CMP-039/044). */
async function openMasterFile(editor: import('../../helpers/editor').Editor, path: string) {
  await editor.openFile(path);
  await waitForActiveFile(editor, path);
  await editor.fitCamera();
  await editor.settled();
}

/** The Styles "Hide" row's Yes/No button. */
function hideButton(page: import('@playwright/test').Page, label: 'Yes' | 'No') {
  return page.locator('[data-tool-row]', { has: page.getByText('Hide', { exact: true }) }).first()
    .locator('[data-tool-row-value] button', { hasText: label });
}

test('CMP-050 Hide → Yes on a master child hides it at once (AnimatePresence gate); the Layers eye does the same', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: on a one-variant master Hide/the eye write the gate `{false && <…/>}` (variant-visibility-gen.ts:123 returns a BooleanLiteral when every variant is hidden), which the builder\'s own oracle rejects as CONDITIONAL_RENDER_UNSUPPORTED (conditional-render-dialect.ts isVariantTest accepts only `variant`/`initialVariant` comparisons)');
  await editor.load(COMPONENT_MASTER);
  await openMasterFile(editor, CARD);
  await expect(editor.node('card-badge')).toBeVisible();
  const before = await editor.code(CARD);

  await clickAt(editor, 'card-badge');
  await expect.poll(() => editor.selection()).toEqual(['card-badge']);
  await hideButton(page, 'Yes').click();
  // Source: the badge rides an AnimatePresence render gate.
  await expect.poll(() => editor.code(CARD)).toContain('AnimatePresence');
  expect(await editor.code(CARD)).toMatch(/<AnimatePresence[^>]*>\s*\{[^{}]*&&\s*\(?\s*<motion\.div[^>]*data-id="card-badge"/);
  // Canvas: hidden immediately, no page switch.
  await expect(editor.node('card-badge')).toBeHidden({ timeout: 3_000 });
  expect(await editor.activeFile()).toBe(CARD);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // The Layers eye on another child does the same.
  const beforeEye = await editor.code(CARD);
  const rowEl = page.locator('[data-layer-id="desktop:card-body"]');
  await rowEl.hover();
  await rowEl.locator('button[title="Hide layer"]').click();
  await expect.poll(() => editor.code(CARD)).toMatch(/<AnimatePresence[^>]*>\s*\{[^{}]*&&\s*\(?\s*<motion\.p[^>]*data-id="card-body"/);
  await expect(editor.node('card-body')).toBeHidden({ timeout: 3_000 });
  expect(await editor.activeFile()).toBe(CARD);
  await expect(editor).toUndoInOneStep(beforeEye, { path: CARD });
  // What the builder wrote must pass its own oracle.
  await expect(editor).toPassOracle();
});

test.describe('three-variant master', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-051 Hide → No on the primary unhides the gated hamburger and keeps display:flex (3 stacked bars on every variant)', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(oneInstanceSeed('Nav', 'nav-a', NAV_HAMBURGER_MASTER));
    await openMasterFile(editor, 'components/Nav.tsx');
    const before = await stableCode(editor, 'components/Nav.tsx');
    // Hidden on the primary (gate), shown on Tablet/Mobile.
    expect(await quickBox(editor.sandbox().locator('[data-node-id="hamburger"]'))).toBeNull();

    // Select it on the primary through its Layers row (no canvas box there).
    await page.locator('[data-layer-id="desktop:hamburger"]').click();
    await expect.poll(() => editor.selection()).toEqual(['hamburger']);
    await hideButton(page, 'No').click();

    const nav = 'components/Nav.tsx';
    await expect.poll(async () => /initialVariant !== 'default' &&/.test(await editor.code(nav))).toBe(false);
    const code = await editor.code(nav);
    expect((await editor.source(nav)).byId.get('hamburger')?.style.display).toBe('flex');
    expect(variantEntry(code, 'hamburger', 'default')?.display).toBe('flex');
    // Every tile paints the hamburger as a flex column of 3 stacked bars.
    for (const vp of ['desktop', 'variant-1', 'variant-2']) {
      const ham = await editor.nodeIn(vp, 'hamburger');
      await expect(ham).toBeVisible();
      expect(await ham.evaluate(el => getComputedStyle(el).display)).toBe('flex');
      expect(await ham.evaluate(el => getComputedStyle(el).flexDirection)).toBe('column');
      const ys: number[] = [];
      for (const bar of ['bar-1', 'bar-2', 'bar-3']) ys.push((await (await editor.nodeIn(vp, bar)).boundingBox())!.y);
      // Not: the bars collapse onto one line.
      expect(ys[1]).toBeGreaterThan(ys[0] + 1);
      expect(ys[2]).toBeGreaterThan(ys[1] + 1);
    }
    await expect(editor).toUndoInOneStep(before, { path: nav });
  });
});

test('CMP-052 Delete on the primary variant root is refused with a toast; the file is unchanged', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  const before = await stableCode(editor, CARD);
  await editor.blur();
  await page.keyboard.press('Delete');
  await expect(page.getByText('Primary variants are not deletable. To delete the component, use the Library panel.')).toBeVisible();
  await editor.settled();
  expect(await editor.code(CARD)).toBe(before);
  expect(await editor.exists('card-root', CARD)).toBe(true);
  expect(variantConfigOf(await editor.code(CARD)).map(v => v.name)).toEqual(['default', 'variant-1']);
});

test('CMP-053 inline paddingTop 80 + a default entry with the padding shorthand: master tile, instance and preview all paint 80px', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the page instance paints padding-top 0 while the master tile and live show 80px — expandComponent bakes the default entry with an object spread (src/code/parsing/project-parser.ts:917 `{ ...overriddenStyles, ...literalEntries(defaultEntry) }`), so `padding` lands after the inline `paddingTop`; the Renderer uses mergeStyleLayers (shorthand first) for master tiles');
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(oneInstanceSeed('Card', 'card-a', PADDED_MASTER));
  // Master tile.
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => paintedById(editor, 'card-root', 'padding-top')).toBe('80px');
  await exitToPage(editor);
  // Preview (live).
  const frame = await openPreview(page, '[data-id="card-a"]');
  await expect.poll(() => frame.locator('[data-id="card-a"]').first().evaluate(el => getComputedStyle(el).paddingTop)).toBe('80px');
  // Page instance on the canvas. Not: 0 on the canvas while live shows 80.
  await page.keyboard.press('Escape');
  await expect.poll(() => paintedById(editor, 'card-a:card-root', 'padding-top'), { timeout: 5_000 }).toBe('80px');
});

test('CMP-054 an Overlay-border master root keeps its border on the duplicated instance, on canvas and in preview', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(oneInstanceSeed('Card', 'card-a', OVERLAY_BORDER_MASTER));
  const afterBorder = (nodeId: string) => editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first()
    .evaluate(el => getComputedStyle(el, '::after').borderTopWidth).catch(() => '');
  // Master tile.
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => afterBorder('card-root')).toBe('3px');
  expect(await editor.code(CARD)).toContain('data-mroot="card-root"');
  await exitToPage(editor);

  const before = await editor.code(PAGE);
  await clickAt(editor, 'card-a', 0.9, 0.85);
  await expect.poll(() => editor.selection()).toEqual(['card-a']);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => ((await editor.code(PAGE)).match(/<Card\b/g) ?? []).length).toBe(2);
  const ids = [...(await editor.code(PAGE)).matchAll(/<Card data-id="([^"]+)"/g)].map(m => m[1]);
  expect(ids).toHaveLength(2);
  for (const id of ids) await expect.poll(() => afterBorder(`${id}:card-root`)).toBe('3px');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  const frame = await openPreview(page, `[data-id="${ids[1]}"]`);
  for (const id of ids) {
    await expect.poll(() => frame.locator(`[data-id="${id}"]`).first().evaluate(el => getComputedStyle(el, '::after').borderTopWidth)).toBe('3px');
    expect(await frame.locator(`[data-id="${id}"]`).first().getAttribute('data-mroot')).toBe('card-root');
  }
});

test('CMP-055 dragging the default tile of a MotionLink + effect master moves variantConfig, never the root\'s left/top or the live instance', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  const PROMO = 'components/Promo.tsx';
  await editor.load(oneInstanceSeed('Promo', 'promo-a', LINK_EFFECT_MASTER));
  await enterByDoubleClick(editor, 'promo-a', PROMO);
  const before = await stableCode(editor, PROMO);
  const r = await stableBox(editor, 'promo-root');
  const from = { x: r.x + r.width * 0.75, y: r.y + r.height * 0.2 };
  await clickAt(editor, 'promo-root', 0.75, 0.2);
  await page.waitForTimeout(650);
  expect(await editor.selection()).toEqual(['promo-root']);
  await gesture(editor, from, [{ x: from.x + 80, y: from.y + 50 }], {
    atWaypoint: async () => {
      const now = (await quickBox(editor.sandbox().locator('[data-node-id="promo-root"]')))!;
      expect(Math.abs(now.x - r.x) + Math.abs(now.y - r.y), 'the tile follows').toBeGreaterThan(20);
    },
  });
  await expect.poll(async () => variantConfigOf(await editor.code(PROMO)).find(v => v.name === 'default')?.x).not.toBe('0');
  const cfg = variantConfigOf(await editor.code(PROMO)).find(v => v.name === 'default')!;
  expect(Number(cfg.x)).toBeGreaterThan(0);
  expect(Number(cfg.y)).toBeGreaterThan(0);
  const rootStyle = (await editor.source(PROMO)).byId.get('promo-root')!.style;
  expect(rootStyle.left).toBeUndefined();
  expect(rootStyle.top).toBeUndefined();
  await expect(editor).toUndoInOneStep(before, { path: PROMO });

  await exitToPage(editor);
  const frame = await openPreview(page, '[data-id="promo-a"]');
  const live = frame.locator('[data-id="promo-a"]').first();
  const facts = await live.evaluate(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const parent = (el.parentElement as HTMLElement).getBoundingClientRect();
    return { left: cs.left, top: cs.top, dx: r.x - parent.x, dy: r.y - parent.y };
  });
  // In flow at the page root's 40px padding — not shifted by the tile offset.
  expect(facts.dx).toBeCloseTo(40, 0);
  expect(facts.dy).toBeCloseTo(40, 0);
  expect(['auto', '0px']).toContain(facts.left);
});

test.describe('variant tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-056 dragging the variant-1 tile root 120px right moves its variantConfig x by 120; no left/top; selection stays on variant-1', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(C2_SEED);
    await enterByDoubleClick(editor, 'card-a', CARD);
    await editor.fitCamera();
    const before = await stableCode(editor, CARD);
    const r = await stableBox(editor, 'card-root', 'variant-1');
    const zoom = r.width / 300;
    // Select it on its own bottom padding, clear of the handles.
    const from = { x: r.x + r.width * 0.3, y: r.y + r.height - 8 * zoom };
    await page.waitForTimeout(450);
    await page.mouse.click(from.x, from.y);
    await page.waitForTimeout(650);
    expect(await editor.selection()).toEqual(['card-root']);
    await gesture(editor, from, [{ x: from.x + 120 * zoom, y: from.y }]);

    await expect.poll(async () => variantConfigOf(await editor.code(CARD)).find(v => v.name === 'variant-1')?.x).not.toBe('500');
    const v1 = variantConfigOf(await editor.code(CARD)).find(v => v.name === 'variant-1')!;
    expect(Math.abs(Number(v1.x) - 620)).toBeLessThanOrEqual(2);
    expect(Number.isInteger(Number(v1.x))).toBe(true);
    expect(Math.abs(Number(v1.y))).toBeLessThanOrEqual(2);
    expect(variantConfigOf(await editor.code(CARD)).find(v => v.name === 'default')).toMatchObject({ x: '0', y: '0' });
    const rootStyle = (await editor.source(CARD)).byId.get('card-root')!.style;
    expect(rootStyle.left).toBeUndefined();
    expect(rootStyle.top).toBeUndefined();
    expect(variantEntry(await editor.code(CARD), 'card-root', 'variant-1')?.left).toBeUndefined();
    // Not: the selection jumps to the primary on mouse-up.
    expect(await editor.selection()).toEqual(['card-root']);
    const moved = await stableBox(editor, 'card-root', 'variant-1');
    await expect.poll(() => selectionBorderAt(editor, moved)).toBe(true);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });

  test('CMP-057 a rotated master root keeps its rotation through primary and variant tile drags', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(oneInstanceSeed('Card', 'card-a', ROTATED_MASTER));
    await enterByDoubleClick(editor, 'card-a', CARD);
    await editor.fitCamera();
    expect(await angleOf(editor, 'card-root')).toBeCloseTo(14.4, 0);
    expect(await angleOf(editor, 'variant-1-card-root')).toBeCloseTo(30, 0);

    // Primary tile: grab the root's centre (its only child sits top-left).
    const d = await stableBox(editor, 'card-root');
    const from = center(d);
    await page.waitForTimeout(450);
    await page.mouse.click(from.x, from.y);
    await page.waitForTimeout(650);
    expect(await editor.selection()).toEqual(['card-root']);
    await gesture(editor, from, [{ x: from.x + 100, y: from.y }], {
      atWaypoint: async () => {
        expect(await angleOf(editor, 'card-root'), 'the primary tile keeps its own rotation mid-drag').toBeCloseTo(14.4, 0);
        expect(await angleOf(editor, 'variant-1-card-root')).toBeCloseTo(30, 0);
      },
    });
    await expect.poll(async () => variantConfigOf(await editor.code(CARD)).find(v => v.name === 'default')?.x).not.toBe('0');
    let code = await editor.code(CARD);
    expect(variantEntry(code, 'card-root', 'default')?.rotate).toBe('14.4');
    expect(variantEntry(code, 'card-root', 'variant-1')?.rotate).toBe('30');
    await expect.poll(() => angleOf(editor, 'card-root')).toBeCloseTo(14.4, 0);

    // Variant-1 tile.
    const v = await stableBox(editor, 'card-root', 'variant-1');
    const vFrom = center(v);
    await page.waitForTimeout(450);
    await page.mouse.click(vFrom.x, vFrom.y);
    await page.waitForTimeout(650);
    await gesture(editor, vFrom, [{ x: vFrom.x + 60, y: vFrom.y + 40 }], {
      atWaypoint: async () => {
        expect(await angleOf(editor, 'variant-1-card-root'), 'variant-1 keeps its own rotation mid-drag').toBeCloseTo(30, 0);
      },
    });
    await expect.poll(async () => variantConfigOf(await editor.code(CARD)).find(v => v.name === 'variant-1')?.x).not.toBe('600');
    code = await editor.code(CARD);
    expect(variantEntry(code, 'card-root', 'default')?.rotate).toBe('14.4');
    expect(variantEntry(code, 'card-root', 'variant-1')?.rotate).toBe('30');
    // Not: an empty transform commit wiped the rotation.
    expect((await editor.source(CARD)).byId.get('card-root')!.style.transform).toBeUndefined();
    await expect.poll(() => angleOf(editor, 'variant-1-card-root')).toBeCloseTo(30, 0);
    expect(await angleOf(editor, 'card-root')).toBeCloseTo(14.4, 0);
  });
});

test('CMP-060 entering a 1280px auto-height master fits the root tile, not the avatar, with no zoom twitch', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(oneInstanceSeed('Wide', 'wide-a', WIDE_MASTER));
  await page.waitForTimeout(450);
  await dblclickNode(editor, 'wide-a', { at: [0.5, 0.8] });
  await waitForActiveFile(editor, 'components/Wide.tsx', 15_000);
  // Sample the root box every frame from the first visible paint on.
  const samples = await page.evaluate(async () => {
    const f = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
    const start = performance.now();
    while (f && getComputedStyle(f).opacity === '0' && performance.now() - start < 3000) await new Promise(r => requestAnimationFrame(r));
    return null;
  }).then(async () => {
    const out: Array<{ x: number; width: number }> = [];
    for (let i = 0; i < 10; i++) {
      const b = await quickBox(editor.sandbox().locator('[data-node-id="wide-root"]'));
      if (b) out.push({ x: Math.round(b.x), width: Math.round(b.width) });
      await page.waitForTimeout(80);
    }
    return out;
  });
  const area = await canvasArea(page);
  const root = await stableBox(editor, 'wide-root');
  // The whole root tile is in view and centred; it fills a good part of the width.
  expect(within(root, area, 2)).toBe(true);
  expect(centredIn(root, area, 0.15)).toBe(true);
  expect(root.width).toBeGreaterThan(area.width * 0.5);
  // Not zoomed into the 70×70 avatar.
  const avatar = await stableBox(editor, 'wide-avatar');
  expect(avatar.width).toBeLessThan(area.width * 0.2);
  // No twitch: every sample after the first paint already had the final framing.
  expect(samples.length).toBeGreaterThan(3);
  for (const s of samples) {
    expect(Math.abs(s.width - Math.round(root.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(s.x - Math.round(root.x))).toBeLessThanOrEqual(2);
  }
});

test('CMP-061 selection and name labels are purple inside a master and blue again on the page', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(cardSeed({ canvasNodes: `  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '100px', width: '160px', height: '120px', backgroundColor: '#ff66cc' }} />` }));
  const purple = await cssColor(page, 'var(--accent-secondary)');
  const blue = await cssColor(page, 'var(--selection)');
  expect(purple).not.toBe(blue);

  await enterByDoubleClick(editor, 'card-a', CARD);
  // The variant root is selected on entry: its name label is purple.
  await expect.poll(() => page.locator('[data-canvas-node-label="desktop:card-root"]').evaluate(el => getComputedStyle(el).color)).toBe(purple);
  await clickAt(editor, 'card-badge');
  await expect.poll(() => editor.selection()).toEqual(['card-badge']);
  await expect.poll(async () => (await selectionOverlay(page))?.stroke ?? null).toBe(purple);

  await exitToPage(editor);
  await editor.fitCamera();
  await clickAt(editor, 'floater');
  await expect.poll(() => editor.selection()).toEqual(['floater']);
  await expect.poll(async () => (await selectionOverlay(page))?.stroke ?? null).toBe(blue);
  await expect.poll(() => page.locator('[data-canvas-node-label="desktop:floater"]').evaluate(el => getComputedStyle(el).color)).toBe(blue);
  // No stuck purple overlay left from the master.
  const purpleLines = await page.evaluate((p) => Array.from(document.querySelectorAll('svg line, svg rect, svg polygon'))
    .filter(el => getComputedStyle(el).stroke === p && (el as SVGGraphicsElement).getBoundingClientRect().width > 0).length, purple);
  expect(purpleLines).toBe(0);
});

test('CMP-063 delete a variant tile, undo, redo: no stray selection box, and the next fill goes to the primary', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await editor.fitCamera();
  const before = await stableCode(editor, CARD);
  const v1 = await stableBox(editor, 'card-root', 'variant-1');
  await page.waitForTimeout(450);
  await page.mouse.click(v1.x + v1.width * 0.5, v1.y + v1.height - 6);
  await editor.settled();
  expect(await editor.selection()).toEqual(['card-root']);
  await editor.blur();
  await page.keyboard.press('Delete');
  await expect.poll(async () => variantConfigOf(await editor.code(CARD)).map(v => v.name)).toEqual(['default']);
  const deleted = await editor.code(CARD);

  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
  await editor.redo();
  await expect.poll(() => editor.code(CARD)).toBe(deleted);
  await editor.settled();
  await page.waitForTimeout(300);
  // No selection box left painted over the now-empty canvas where the tile was.
  expect(await quickBox(await editor.nodeIn('variant-1', 'card-root'))).toBeNull();
  expect(await selectionBorderAt(editor, v1, 6)).toBe(false);

  // The next fill write lands on the surviving primary.
  if ((await editor.selection()).length === 0) await clickAt(editor, 'card-root', 0.9, 0.9);
  await setFillHex(page, '#22aa55');
  await expect(editor).toHaveStyle('card-root', 'backgroundColor', '#22aa55', { path: CARD });
  const after = await editor.code(CARD);
  expect(after).not.toContain("'variant-1'");
  expect(after).not.toMatch(/variant-1/);
  await expect.poll(() => paintedById(editor, 'card-root', 'background-color')).toBe('rgb(34, 170, 85)');
});

test('CMP-064 copy/paste inside a master: a variant root does not paste; a bound text keeps {title}; on a page it bakes the literal', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await editor.fitCamera();
  const start = await stableCode(editor, CARD);

  // A variant root is not copyable.
  const v1 = await stableBox(editor, 'card-root', 'variant-1');
  await page.waitForTimeout(450);
  await page.mouse.click(v1.x + v1.width * 0.5, v1.y + v1.height - 6);
  await editor.settled();
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(200);
  await page.keyboard.press('ControlOrMeta+v');
  await editor.settled();
  await page.waitForTimeout(400);
  expect(await editor.code(CARD)).toBe(start);

  // A bound text pasted in the same master keeps its binding.
  await clickAt(editor, 'card-title');
  await expect.poll(() => editor.selection()).toEqual(['card-title']);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(200);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => ((await editor.code(CARD)).match(/>\s*\{title\}\s*</g) ?? []).length).toBe(2);
  await expect(editor).toUndoInOneStep(start, { path: CARD });

  // …pasted into a page it bakes the literal default.
  await exitToPage(editor);
  const pageBefore = await editor.code(PAGE);
  await clickAt(editor, 'marker');
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await editor.code(PAGE)).length).toBeGreaterThan(pageBefore.length);
  const pageCode = await editor.code(PAGE);
  expect(pageCode).not.toContain('{title}');
  expect(pageCode).toMatch(/>\s*Old\s*</);
  await expect(editor).toUndoInOneStep(pageBefore, { path: PAGE });
});

test('CMP-066 preview of an active 4000px-tall master: isolated, centred, scrollable to its top, no provider error', { tag: ['@p2', '@cmp', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(oneInstanceSeed('Tall', 'tall-a', TALL_MASTER, { files: I18N_FILES }));
  await enterByDoubleClick(editor, 'tall-a', 'components/Tall.tsx', { at: [0.5, 0.02] });
  const frame = await openPreview(page, '[data-id="tall-top"]');
  const root = frame.locator('[data-mroot="tall-root"], [data-id="tall-root"]').first();
  await expect(frame.getByText('Top of tall')).toBeAttached();
  const facts = await root.evaluate((el) => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { position: cs.position, ml: cs.marginLeft, mr: cs.marginRight, x: r.x, w: r.width, top: r.top, vw: document.documentElement.clientWidth };
  });
  expect(facts.position).not.toBe('absolute');
  // Centred with auto margins.
  expect(Math.abs(parseFloat(facts.ml) - parseFloat(facts.mr))).toBeLessThanOrEqual(1);
  expect(Math.abs(facts.x + facts.w / 2 - facts.vw / 2)).toBeLessThanOrEqual(2);
  // Scrolled to the top, the tall variant's top edge is reachable (not cut off above).
  expect(facts.top).toBeGreaterThanOrEqual(0);
  const top = await frame.locator('[data-id="tall-top"]').first().evaluate(el => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
});
