// CMP · Interaction states, scroll variants and transitions (E2E_TEST_PLAN.md §8,
// batch C4). Tiles of an open master: `desktop` is the primary (default
// variant), every other tile is its variant name.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  CARD, PAGE, cardProject, plainCard, hoverOnlyCard, guarded, openMaster, addVariantCard, hpStrip, clickCard,
  variantConfigOf, connectionsOf, connKey, attrSource, attrCount, pollCode, stableCode, traces, tileIds,
  computedIn, textIn, shownIn, selectedOnTile, mentions, previewPage, previewStyle, hoverPreview, clickPreview,
  PREVIEW_NOISE, seed, pageWith, CARD_IMPORT, removeEffect, openEffect, openTransition, objectConsts,
} from '../../helpers/c4';
import {
  clickStable, parsesClean, variantsOf, styleTernary, elementSource, setFillHex, startTextEdit, clickAway, isTextEditing, row,
  isOverridden, labelMenu, menuTexts, closePopup, setPreviewWidth, topPopup, openingTag,
} from '../../helpers/c5';
import { TILES, canvasHeader } from '../../fixtures/test';
import { variantsConst } from '../../helpers/d4';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const RGB = { default: 'rgb(151, 207, 252)', v1: 'rgb(255, 45, 117)', hover: 'rgb(90, 169, 240)', green: 'rgb(0, 255, 0)' };

/** Select a variant tile's ROOT with a real click in its empty bottom padding. */
async function selectRoot(editor: Editor, vpId: string, rootId = 'card-root'): Promise<void> {
  await editor.page().waitForTimeout(450);
  await clickStable(editor, rootId, vpId, 0.5, 0.95);
  await expect.poll(() => editor.selection()).toEqual([rootId]);
}

/** Open the Hover/Pressed strip; returns the visible menu item labels. */
async function openStrip(editor: Editor): Promise<string[]> {
  const page = editor.page();
  await clickCard(editor, hpStrip(page));
  const items = page.locator('div[style*="z-index: 2003"] > div');
  await items.first().waitFor({ state: 'visible', timeout: 5_000 });
  return (await items.allTextContents()).map(t => t.trim());
}

async function pickState(editor: Editor, which: 'Hover' | 'Pressed'): Promise<void> {
  const page = editor.page();
  await page.locator('div[style*="z-index: 2003"] > div').filter({ hasText: new RegExp(`^${which}$`) }).click();
  await editor.settled();
}

// ─── CMP-113 ─────────────────────────────────────────────────────────

test('CMP-113 Hover from the strip adds a hover state below the source with guarded handlers that work in preview', { tag: ['@p0', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(cardProject(plainCard()));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'desktop');
  await expect(hpStrip(page)).toContainText('Hover / Pressed');
  expect(await openStrip(editor)).toEqual(['Hover', 'Pressed']);
  await pickState(editor, 'Hover');

  const code = await pollCode(editor, CARD, c => /onHoverStart/.test(c) && variantConfigOf(c).some(v => v.name === 'default-hover'));
  const cfg = variantConfigOf(code);
  const src = cfg.find(v => v.name === 'default')!;
  const hov = cfg.find(v => v.name === 'default-hover')!;
  expect(hov).toMatchObject({ label: 'Default - Hover', interactionType: 'hover', parentVariant: 'default' });
  expect(hov.y as number, 'placed below the source tile (200px tall)').toBeGreaterThanOrEqual((src.y as number) + 200);
  expect(connectionsOf(code).map(connKey)).toEqual(['default>default-hover:mouseEnter', 'default-hover>default:mouseLeave']);
  expect(attrSource(code, 'card-root', 'onHoverStart')).toBe(guarded([['default', 'default-hover']]));
  expect(attrSource(code, 'card-root', 'onHoverEnd')).toBe(guarded([['default-hover', 'default']]));
  expect(attrSource(code, 'card-root', 'animate')).toBe(`['default', variant]`);
  expect(code).toMatch(/const \[variant, setVariant\] = useState\(initialVariant\)/);
  // The state seeds the source's resolved values (it REPLACES the variant on hover).
  expect(variantsOf(code, 'card-root')!['default-hover']).toEqual({ backgroundColor: '#97cffc' });

  // The new tile renders and is the selected one.
  await expect(selectedOnTile(page, 'default-hover', 'card-root')).toBeVisible({ timeout: 10_000 });
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Give the hover its own fill, then hover an instance in preview.
  await editor.fitCamera();
  await selectRoot(editor, 'default-hover');
  await setFillHex(page, '#5aa9f0');
  await pollCode(editor, CARD, c => variantsOf(c, 'card-root')?.['default-hover']?.backgroundColor === '#5aa9f0');

  const frame = await previewPage(editor, PAGE, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.default);
  await hoverPreview(editor, frame, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.hover);
  await page.mouse.move(5, 500, { steps: 4 });
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.default);
});

// ─── CMP-114 ─────────────────────────────────────────────────────────

test('CMP-114 Pressed after Hover chains through hover; Pressed first then Hover rewires the chain; the strip then goes', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  const FRESH = 'components/Fresh.tsx';
  await editor.load(cardProject(hoverOnlyCard(), { extra: { [FRESH]: plainCard('Fresh') } }));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // A. Hover exists → the strip offers only Pressed.
  await selectRoot(editor, 'desktop');
  await expect(hpStrip(editor.page())).toContainText('Pressed');
  await expect(hpStrip(editor.page())).not.toContainText('Hover');
  expect(await openStrip(editor)).toEqual(['Pressed']);
  await pickState(editor, 'Pressed');
  const a = await pollCode(editor, CARD, c => connectionsOf(c).length === 4);
  expect(connectionsOf(a).map(connKey)).toEqual([
    'default>default-hover:mouseEnter', 'default-hover>default:mouseLeave',
    'default-hover>default-pressed:clickStart', 'default-pressed>default-hover:click',
  ]);
  expect(variantConfigOf(a).find(v => v.name === 'default-pressed')).toMatchObject({ interactionType: 'pressed', parentVariant: 'default' });
  expect(attrSource(a, 'card-root', 'onTapStart')).toBe(guarded([['default-hover', 'default-pressed']]));
  expect(attrSource(a, 'card-root', 'onTap')).toBe(guarded([['default-pressed', 'default-hover']]));
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  // Both states exist → no strip on the source.
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  await expect(addVariantCard(editor.page())).toBeVisible();
  await expect(hpStrip(editor.page())).toHaveCount(0);

  // B. A fresh master: Pressed first, then Hover.
  await openMaster(editor, FRESH);
  await selectRoot(editor, 'desktop');
  expect(await openStrip(editor)).toEqual(['Hover', 'Pressed']);
  await pickState(editor, 'Pressed');
  const b1 = await pollCode(editor, FRESH, c => connectionsOf(c).length === 2);
  expect(connectionsOf(b1).map(connKey)).toEqual(['default>default-pressed:clickStart', 'default-pressed>default:click']);
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  expect(await openStrip(editor)).toEqual(['Hover']);
  await pickState(editor, 'Hover');
  const b2 = await pollCode(editor, FRESH, c => connectionsOf(c).length === 5);
  expect(connectionsOf(b2).map(connKey).sort()).toEqual([
    'default>default-hover:mouseEnter', 'default>default-pressed:clickStart',
    'default-hover>default:mouseLeave', 'default-hover>default-pressed:clickStart',
    'default-pressed>default-hover:click',
  ].sort());
  expect(connectionsOf(b2).map(connKey), 'pressed no longer clicks straight back to the source').not.toContain('default-pressed>default:click');
  expect(parsesClean(b2)).toBe(true);
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  await expect(hpStrip(editor.page())).toHaveCount(0);
});

// ─── CMP-115 ─────────────────────────────────────────────────────────

test('CMP-115 on a Hover tile root there is no + Variant; the strip adds the missing Pressed to the source', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(hoverOnlyCard()));
  await openMaster(editor, CARD, 'default-hover');
  const before = await editor.code(CARD);

  await selectRoot(editor, 'default-hover');
  await expect(hpStrip(page)).toBeVisible();
  await expect(addVariantCard(page), 'no + Variant on an interaction state').toHaveCount(0);
  await expect(hpStrip(page)).toContainText('Pressed');
  expect(await openStrip(editor)).toEqual(['Pressed']);
  await pickState(editor, 'Pressed');

  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.interactionType === 'pressed'));
  const pressed = variantConfigOf(code).find(v => v.interactionType === 'pressed')!;
  expect(pressed.name, 'named after the SOURCE, not the hover tile').toBe('default-pressed');
  expect(pressed.parentVariant).toBe('default');
  expect(mentions(code, 'default-hover-pressed')).toBe(0);
  expect(connectionsOf(code).map(connKey)).toEqual([
    'default>default-hover:mouseEnter', 'default-hover>default:mouseLeave',
    'default-hover>default-pressed:clickStart', 'default-pressed>default-hover:click',
  ]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-116 ─────────────────────────────────────────────────────────

test('CMP-116 variant-1 gets its own hover state; an instance can only pick default or variant-1', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(hoverOnlyCard()));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // variant-1 has no states yet: its strip offers both.
  await selectRoot(editor, 'variant-1');
  expect(await openStrip(editor)).toEqual(['Hover', 'Pressed']);
  await pickState(editor, 'Hover');
  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-1-hover') && connectionsOf(c).length === 4);
  const cfg = variantConfigOf(code);
  expect(cfg.find(v => v.name === 'default-hover')).toMatchObject({ interactionType: 'hover', parentVariant: 'default' });
  expect(cfg.find(v => v.name === 'variant-1-hover')).toMatchObject({ interactionType: 'hover', parentVariant: 'variant-1', label: 'Open - Hover' });
  expect(connectionsOf(code).map(connKey)).toEqual([
    'default>default-hover:mouseEnter', 'default-hover>default:mouseLeave',
    'variant-1>variant-1-hover:mouseEnter', 'variant-1-hover>variant-1:mouseLeave',
  ]);
  expect(variantsOf(code, 'card-root')!['variant-1-hover'], 'seeded from variant-1, separate from default-hover').toEqual({ backgroundColor: '#ff2d75' });
  expect(variantsOf(code, 'card-root')!['default-hover']).toEqual({ backgroundColor: '#5aa9f0' });
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // The page instance's Variant row lists the variants only — never a state.
  await editor.openFile(PAGE);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, PAGE);
  await editor.sandbox().locator('[data-node-id="card-a"]').first().waitFor({ state: 'visible', timeout: 15_000 });
  await editor.settled();
  await editor.fitCamera();
  await page.waitForTimeout(450);
  await clickStable(editor, 'card-a', undefined, 0.5, 0.95);
  await expect.poll(() => editor.selection()).toEqual(['card-a']);
  const select = row(page, 'Variant').locator('select');
  await expect(select).toBeVisible({ timeout: 10_000 });
  const options = await select.locator('option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value));
  expect(options).toEqual(['default', 'variant-1']);
});

// ─── CMP-117 ─────────────────────────────────────────────────────────

const MENU = `'use client';

/** @name "Menu" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
  { name: 'open', label: 'Open', x: 600, y: 0 },
];

const menuRootVariants = {
  default: { backgroundColor: '#97cffc' },
  open: { backgroundColor: '#ff2d75' }
};

function Menu({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="menu-root" data-name="Menu" variants={menuRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="menu-x" data-name="Close" style={{ position: 'relative', width: '40px', height: '40px', backgroundColor: '#000000', flex: '0 0 auto', order: '0' }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Menu);
`;

test('CMP-117 a child X closing the menu works in preview despite the root click toggle (guarded handlers)', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  const MENU_PATH = 'components/Menu.tsx';
  await editor.load(seed({ [MENU_PATH]: MENU }, pageWith(`<Menu data-id="menu-a" data-name="Menu A" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import Menu from '@/components/Menu';`)));
  await openMaster(editor, MENU_PATH, 'open');

  // Setup: the root toggles default → open on click; the X closes open → default.
  await selectRoot(editor, 'desktop', 'menu-root');
  await page.evaluate(() => (window as any).__e2e.addConnection('default', 'open', 'click'));
  await editor.settled();
  await page.evaluate(() => (window as any).__e2e.select(['menu-x'], 'open'));
  await page.evaluate(() => (window as any).__e2e.addConnection('open', 'default', 'click'));
  const code = await pollCode(editor, MENU_PATH, c => connectionsOf(c).length === 2 && /data-id="menu-x"/.test(c) && (attrSource(c, 'menu-x', 'onTap') ?? '') !== '');
  // The builder writes the guarded form: no fall-through setVariant on either node.
  expect(attrSource(code, 'menu-root', 'onTap')).toBe(guarded([['default', 'open']]));
  expect(attrSource(code, 'menu-x', 'onTap')).toBe(guarded([['open', 'default']]));
  expect(code).not.toMatch(/: variant\)/);

  // Preview: open the menu with the root, then tap X.
  const frame = await previewPage(editor, PAGE, '[data-id="menu-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="menu-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.default);
  await clickPreview(editor, frame, '[data-id="menu-a"]', 0.7, 0.8);
  await expect.poll(() => previewStyle(frame, '[data-id="menu-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.v1);
  await page.waitForTimeout(450);
  await clickPreview(editor, frame, '[data-id="menu-a"] [data-id="menu-x"]');
  // Not: the X does nothing (the bubbled root tap re-setting `open`).
  await expect.poll(() => previewStyle(frame, '[data-id="menu-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.default);
});

// ─── CMP-118 ─────────────────────────────────────────────────────────

const BUTTON_TEXT = hoverOnlyCard().replace(
  `<motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>`,
  `<motion.p layout={true} data-id="card-title" data-name="Label" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{variant === 'default-hover' ? "HOVERED" : "CONTACT US"}</motion.p>`,
);

test('CMP-118 typing on the default label leaves the hover tile\'s own text alone, live and after commit', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(BUTTON_TEXT));
  await openMaster(editor, CARD, 'default-hover');
  const before = await editor.code(CARD);
  expect(await textIn(editor, 'default-hover', 'card-title')).toBe('HOVERED');

  await page.waitForTimeout(450);
  await clickStable(editor, 'card-title', 'desktop');
  await startTextEdit(editor, 'desktop', 'card-title');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('CONTACT US NOW', { delay: 30 });
  // Live: the default tile mirrors the typing, the hover tile keeps its own text.
  await expect.poll(() => textIn(editor, 'desktop', 'card-title')).toBe('CONTACT US NOW');
  expect(await isTextEditing(editor)).toBe(true);
  expect(await textIn(editor, 'default-hover', 'card-title'), 'the hover tile is not live-mirrored').toBe('HOVERED');

  await clickAway(editor);
  const code = await pollCode(editor, CARD, c => c.includes('CONTACT US NOW'));
  const title = elementSource(code, 'card-title');
  expect(title).toMatch(/variant === ['"]default-hover['"] \? ['"]HOVERED['"] : ['"]CONTACT US NOW['"]/);
  await expect.poll(() => textIn(editor, 'default-hover', 'card-title')).toBe('HOVERED');
  expect(await textIn(editor, 'desktop', 'card-title')).toBe('CONTACT US NOW');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-119 ─────────────────────────────────────────────────────────

/** The plain card with an Appear on its root, as the Animation tool writes it. */
const APPEAR_CARD = plainCard().replace(
  `initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>`,
  `initial={{ opacity: 0, y: 20 }} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          >`,
);

test('CMP-119 adding a Hover to a root with an Appear keeps a single initial; appear and hover both run in preview', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(cardProject(APPEAR_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(attrCount(before, 'card-root', 'initial'), 'seed sanity').toBe(1);

  await selectRoot(editor, 'desktop');
  await openStrip(editor);
  await pickState(editor, 'Hover');
  const code = await pollCode(editor, CARD, c => /onHoverStart/.test(c));
  // Not: a duplicate `initial` (the canvas reads the first, React the last).
  expect(attrCount(code, 'card-root', 'initial'), 'one initial attribute').toBe(1);
  expect(attrSource(code, 'card-root', 'initial'), 'the appear from-state is kept').toBe('{ opacity: 0, y: 20 }');
  expect(attrSource(code, 'card-root', 'whileInView')).toBe('{ opacity: 1, y: 0 }');
  expect(attrSource(code, 'card-root', 'animate')).toBe(`['default', variant]`);
  expect(attrSource(code, 'card-root', 'onHoverStart')).toBe(guarded([['default', 'default-hover']]));
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Give the hover state its own fill, then check both effects in preview.
  await editor.fitCamera();
  await selectRoot(editor, 'default-hover');
  await setFillHex(page, '#5aa9f0');
  await pollCode(editor, CARD, c => variantsOf(c, 'card-root')?.['default-hover']?.backgroundColor === '#5aa9f0');
  const frame = await previewPage(editor, PAGE, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'opacity'), { timeout: 15_000, message: 'the appear ran' }).toBe('1');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.default);
  await hoverPreview(editor, frame, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000, message: 'the hover ran' }).toBe(RGB.hover);
});

// ─── CMP-120 ─────────────────────────────────────────────────────────

const CONNECTED_APPEAR = `'use client';

/** @name "Card" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hovered', x: 600, y: 0 },
  { name: 'variant-2', label: 'Clicked', x: 1200, y: 0 },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' },
  'variant-2': { backgroundColor: '#00ff00' }
};

const connections = [
  { from: 'default', to: 'variant-1', trigger: 'mouseEnter' },
  { from: 'variant-1', to: 'variant-2', trigger: 'click' },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onTap={() => { const _n = variant === 'variant-1' ? 'variant-2' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={{ opacity: 0, y: 30 }} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }} animate={['default', variant]}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(Card);
`;

test('CMP-120 removing the Appear from a connected master root keeps its handlers, variant wiring and variants const', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(cardProject(CONNECTED_APPEAR));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'desktop');
  await removeEffect(page, 'Appear');
  const code = await pollCode(editor, CARD, c => !/whileInView/.test(c));
  expect(code, 'whileInView is gone').not.toMatch(/whileInView|viewport=\{\{/);
  expect(attrSource(code, 'card-root', 'onHoverStart')).toBe(guarded([['default', 'variant-1']]));
  expect(attrSource(code, 'card-root', 'onTap')).toBe(guarded([['variant-1', 'variant-2']]));
  expect(attrSource(code, 'card-root', 'initial'), 'the variant initial is restored').toBe(`['default', initialVariant]`);
  expect(attrSource(code, 'card-root', 'animate')).toBe(`['default', variant]`);
  expect(objectConsts(code), 'no <cn>Variants const deleted').toContain('cardRootVariants');
  expect(attrSource(code, 'card-root', 'variants')).toBe('cardRootVariants');
  expect(connectionsOf(code).map(connKey)).toEqual(['default>variant-1:mouseEnter', 'variant-1>variant-2:click']);
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Hover still switches the variant in preview.
  const frame = await previewPage(editor, PAGE, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.default);
  await hoverPreview(editor, frame, '[data-id="card-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.v1);
});

// ─── CMP-121 ─────────────────────────────────────────────────────────

const SCROLL_NAV = `'use client';

/** @name "Nav" */

import React from 'react';
import { motion, useScroll, useTransform, useSpring, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Mobile', x: 900, y: 0 },
];

const navBarVariants = {
  default: { backgroundColor: '#111111' },
  'variant-1': { backgroundColor: '#333333' }
};

const navLinksVariants = {
  default: { gap: '24px' },
  'variant-1': { gap: '8px' }
};

function Nav({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const { scrollYProgress: navProgress } = useScroll();
  const navSmooth = useSpring(navProgress, { duration: 0.5, bounce: 0.25 });
  const navOpacity = useTransform(navSmooth, [0, 1], [0.5, 1]);
  const navScale = useTransform(navSmooth, [0, 1], [0.5, 1]);
  return (
    <LayoutGroup>
    <motion.nav layout={true} data-id="nav" data-name="Nav" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '600px', height: '160px', padding: '20px', backgroundColor: '#ffffff', ...style, opacity: navOpacity, scale: navScale}}>
      <motion.div layout={true} data-id="nav-bar" data-name="Bar" variants={navBarVariants} style={{ position: 'relative', width: '100%', height: '40px', backgroundColor: '#111111', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="nav-links" data-name="Links" variants={navLinksVariants} style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '24px', width: '100%', height: '40px', flex: '0 0 auto', order: '1' }} />
    </motion.nav>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Nav);
`;

test('CMP-121 removing a Scroll Transform from a `nav` root keeps every nav*Variants const', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  test.fail(true, 'BUG: removing a Scroll Transform from a master root strips its `initial`/`animate` variant wiring when the variants live on its children — instances lose every variant at runtime (canvas still shows them)');
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  const NAV = 'components/Nav.tsx';
  await editor.load(seed({ [NAV]: SCROLL_NAV }, pageWith(`<Nav data-id="nav-a" data-name="Nav A" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import Nav from '@/components/Nav';`)));
  await openMaster(editor, NAV);
  const before = await editor.code(NAV);

  await selectRoot(editor, 'desktop', 'nav');
  await removeEffect(page, 'Scroll');
  const code = await pollCode(editor, NAV, c => !/useScroll\(/.test(c));
  expect(code, 'the scroll transform is gone').not.toMatch(/navProgress|navOpacity|navScale/);
  // Not: "navBarVariants is not defined".
  expect(objectConsts(code)).toEqual(expect.arrayContaining(['navBarVariants', 'navLinksVariants']));
  expect(attrSource(code, 'nav-bar', 'variants')).toBe('navBarVariants');
  expect(attrSource(code, 'nav-links', 'variants')).toBe('navLinksVariants');
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toPassOracle();

  // All tiles render, each with its own variant values.
  await expect.poll(() => computedIn(editor, 'desktop', 'nav-bar', 'background-color')).toBe('rgb(17, 17, 17)');
  await expect.poll(() => computedIn(editor, 'variant-1', 'nav-bar', 'background-color')).toBe('rgb(51, 51, 51)');
  expect(await shownIn(editor, 'variant-1', 'nav-links')).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: NAV });

  // The root keeps the variant wiring its children's variants hang off, so a
  // variant-1 instance still renders variant-1 at runtime (it did before the removal).
  const after = await editor.code(NAV);
  expect(attrSource(after, 'nav', 'animate'), 'the variant animate wiring survives').toBe(`['default', initialVariant]`);
  expect(attrSource(after, 'nav', 'initial')).toBe(`['default', initialVariant]`);
  const frame = await previewPage(editor, PAGE, '[data-id="nav-a"]');
  await expect.poll(() => previewStyle(frame, '[data-id="nav-a"] [data-id="nav-bar"]', 'background-color'), { timeout: 15_000 }).toBe('rgb(51, 51, 51)');
});

// ─── CMP-122 / CMP-123 · scroll variants on a page instance ──────────

const SV_NAV = `'use client';

/** @name "Nav" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Desktop Scrolled', x: 700, y: 0 },
  { name: 'mobile', label: 'Mobile', x: 0, y: 300 },
  { name: 'mobile-open', label: 'Mobile Open', x: 700, y: 300 },
];

const navRootVariants = {
  default: { backgroundColor: '#ffffff' },
  'variant-1': { backgroundColor: '#000000' },
  mobile: { backgroundColor: '#ff0000' },
  'mobile-open': { backgroundColor: '#00ff00' }
};

function Nav({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="nav-root" data-name="Nav" variants={navRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'row', gap: '12px', width: '100%', height: '80px', padding: '20px', backgroundColor: '#ffffff', ...style }}>
      <motion.p layout={true} data-id="nav-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#888888', margin: '0px', flex: '0 0 auto', order: '0' }}>Brand</motion.p>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Nav);
`;

/** A 3-tile page whose Nav instance carries an onScroll Scroll Variant (as the
 *  Animation tool generates it) plus `instanceAttrs`. */
function svPage(spec: string, instanceAttrs = ''): string {
  return `${canvasHeader(TILES.three)}
'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Nav from '@/components/Nav';

export default function Page() {
  const [navASv, setNavASv] = useState('default');
  const { scrollY: navASvScroll } = useScroll();
  useMotionValueEvent(navASvScroll, "change", (y) => {
    const prev = navASvScroll.getPrevious() ?? 0;
    if (y > prev) setNavASv('variant-1');
    else if (y < prev) setNavASv('default');
  });
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
      <Nav data-scroll-variant='${spec}' initialVariant={navASv} data-id="nav-a" data-name="Nav A"${instanceAttrs} style={{ position: 'relative', flex: '0 0 auto', width: '100%' }} />
      <div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '100%', height: '2000px', flex: '0 0 auto', backgroundColor: '#222222' }} />
    </div>
  );
}
`;
}

const BASE_SPEC = { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true, canvasVariant: 'default' };

const jsonAttr = (code: string, id: string, name: string) => JSON.parse(attrSource(code, id, name) ?? 'null');
/** The useMediaQuery const name for a query (`__mq0`, …). */
const mqVar = (code: string, query: string) => code.match(new RegExp(`const (__mq\\w*) = useMediaQuery\\('${query.replace(/[()]/g, '\\$&')}'\\)`))?.[1] ?? null;

test('CMP-122 a Tablet-tile Variant pick on a scroll-variant instance updates data-responsive, the spec and the resting state', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(seed({ 'components/Nav.tsx': SV_NAV }, svPage(JSON.stringify(BASE_SPEC), ` data-responsive='{"768":{"initialVariant":"mobile"}}'`)), { fit: true });
  const before = await editor.code(PAGE);

  await page.waitForTimeout(450);
  await clickStable(editor, 'nav-a', 'tablet', 0.9, 0.5);
  await expect.poll(() => editor.selection()).toEqual(['nav-a']);
  const select = row(page, 'Variant').locator('select');
  await expect(select).toHaveValue('mobile');
  await select.selectOption('mobile-open');

  const code = await pollCode(editor, PAGE, c => (jsonAttr(c, 'nav-a', 'data-responsive')?.['768']?.initialVariant) === 'mobile-open' && /useMediaQuery\(/.test(c));
  expect(jsonAttr(code, 'nav-a', 'data-responsive')['768']).toEqual({ initialVariant: 'mobile-open' });
  const spec = jsonAttr(code, 'nav-a', 'data-scroll-variant');
  expect(spec.from, 'the base resting variant is untouched').toBe('default');
  expect(spec.responsive).toEqual([{ scope: { query: '(max-width: 768px)' }, from: 'mobile-open' }]);
  const mq = mqVar(code, '(max-width: 768px)');
  expect(mq).not.toBeNull();
  expect(code, 'the generated useState rests on mobile-open at ≤768').toContain(`useState((${mq} ? 'mobile-open' : 'default'))`);
  // Purple override label with Reset Override.
  expect(await isOverridden(page, 'Variant')).toBe(true);
  await page.locator('[data-properties-panel] span[title="Variant"]').first().click();
  await expect.poll(() => menuTexts(page)).toContain('Reset Override');
  await page.keyboard.press('Escape');
  // The Tablet tile shows mobile-open.
  await expect.poll(() => editor.sandbox().locator('[data-node-id="tablet-nav-a:nav-root"]').first().evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 10_000 }).toBe(RGB.green);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Preview at 768 rests on mobile-open.
  const frame = await previewPage(editor, PAGE, '[data-id="nav-a"]');
  await setPreviewWidth(page, frame, 768);
  await expect.poll(() => previewStyle(frame, '[data-id="nav-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.green);
});

test('CMP-123 a scroll-variant spec authored [768, 375] regenerates with the 375 query outermost', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  const spec = { ...BASE_SPEC, responsive: [
    { scope: { query: '(max-width: 768px)' }, from: 'mobile', to: 'variant-1' },
    { scope: { query: '(max-width: 375px)' }, from: 'mobile-open', to: 'variant-1' },
  ] };
  await editor.load(seed({ 'components/Nav.tsx': SV_NAV }, svPage(JSON.stringify(spec))), { fit: true });

  // Any Scroll Variant edit regenerates the page code: Replay → No.
  await page.waitForTimeout(450);
  await clickStable(editor, 'nav-a', undefined, 0.9, 0.5);
  await expect.poll(() => editor.selection()).toEqual(['nav-a']);
  await openEffect(page, 'Scroll');
  const pop = page.locator('[data-tool-popup]').last();
  await pop.getByText('Replay', { exact: true }).waitFor({ timeout: 5_000 });
  await pop.getByText('No', { exact: true }).click();
  const code = await pollCode(editor, PAGE, c => /useMediaQuery\('\(max-width: 375px\)'\)/.test(c) && /"replay":false/.test(c));
  const a = mqVar(code, '(max-width: 375px)'), b = mqVar(code, '(max-width: 768px)');
  expect(a && b).toBeTruthy();
  // Narrowest first: the 375 test is the OUTERMOST ternary.
  expect(code).toContain(`useState((${a} ? 'mobile-open' : ${b} ? 'mobile' : 'default'))`);
  expect(code, 'not: the tablet test first').not.toContain(`useState((${b} ? 'mobile' : ${a}`);
  await closePopup(page);

  // Preview: 375 rests on mobile-open (green), 768 on mobile (red).
  const frame = await previewPage(editor, PAGE, '[data-id="nav-a"]');
  await setPreviewWidth(page, frame, 375);
  await expect.poll(() => previewStyle(frame, '[data-id="nav-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.green);
  await setPreviewWidth(page, frame, 768);
  await expect.poll(() => previewStyle(frame, '[data-id="nav-a"]', 'background-color'), { timeout: 15_000 }).toBe('rgb(255, 0, 0)');
});

// ─── CMP-124 ─────────────────────────────────────────────────────────

/** Styles → Transition → pick an Ease preset in the popup, then close it. */
async function setEase(editor: Editor, ease: string): Promise<void> {
  const page = editor.page();
  const pop = await openTransition(page);
  await pop.locator('select').first().selectOption(ease);
  await editor.settled();
  await closePopup(page);
}

test('CMP-124 the Transition control writes MotionConfig, a variant entry or an element prop depending on node and tile', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(cardProject(plainCard()));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // 1. Root on default → <MotionConfig transition={{…}}>.
  await selectRoot(editor, 'desktop');
  await setEase(editor, 'easeIn');
  let code = await pollCode(editor, CARD, c => /<MotionConfig transition=/.test(c));
  expect(code).toMatch(/<MotionConfig transition=\{\{\s*ease: 'easeIn'\s*\}\}>/);
  expect(attrSource(code, 'card-root', 'transition'), 'not on the root element').toBeNull();
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // 2. Root on variant-1 → inside the variant-1 entry.
  let mark = await editor.code(CARD);
  await selectRoot(editor, 'variant-1');
  await setEase(editor, 'circIn');
  code = await pollCode(editor, CARD, c => /circIn/.test(c));
  expect(variantsOf(code, 'card-root')!['variant-1']).toEqual({ backgroundColor: '#ff2d75', transition: "{ ease: 'circIn' }" });
  expect(code).not.toMatch(/<MotionConfig transition=\{\{[^}]*circIn/);
  await expect(editor).toUndoInOneStep(mark, { path: CARD });

  // 3. Child on default → transition={{…}} on the element.
  mark = await editor.code(CARD);
  await editor.page().waitForTimeout(450);
  await clickStable(editor, 'card-box', 'desktop');
  await expect.poll(() => editor.selection()).toEqual(['card-box']);
  await setEase(editor, 'backOut');
  code = await pollCode(editor, CARD, c => /backOut/.test(c));
  expect(attrSource(code, 'card-box', 'transition')).toMatch(/^\{\s*ease: 'backOut'\s*\}$/);
  expect(code, 'the root MotionConfig is untouched').toMatch(/<MotionConfig transition=\{\{\s*ease: 'easeIn'\s*\}\}>/);
  await expect(editor).toUndoInOneStep(mark, { path: CARD });

  // 4. Child on variant-1 → inside the child's own variant-1 entry.
  mark = await editor.code(CARD);
  await editor.page().waitForTimeout(450);
  await clickStable(editor, 'card-box', 'variant-1');
  await expect.poll(() => editor.selection()).toEqual(['card-box']);
  await setEase(editor, 'anticipate');
  code = await pollCode(editor, CARD, c => /anticipate/.test(c));
  expect(variantsOf(code, 'card-box')?.['variant-1']?.transition).toMatch(/^\{\s*ease: 'anticipate'\s*\}$/);
  expect(attrSource(code, 'card-box', 'transition'), 'the default element prop is untouched').toMatch(/^\{\s*ease: 'backOut'\s*\}$/);
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(mark, { path: CARD });
});

// ─── CMP-125 ─────────────────────────────────────────────────────────

/** Drag a CurvePreview control point (0 = p1, 1 = p2) toward the bezier value
 *  (vx, vy); returns the value pair the panel computes for the pixel it lands on
 *  (pointer coordinates are whole pixels, the panel rounds to 0.01). */
async function dragBezierHandle(editor: Editor, pop: import('@playwright/test').Locator, idx: 0 | 1, vx: number, vy: number): Promise<[number, number]> {
  const page = editor.page();
  const svg = pop.locator('svg:has(circle[r="6"])').first();
  const handle = svg.locator('circle[r="6"]').nth(idx);
  const hb = (await handle.boundingBox())!;
  const sb = (await svg.boundingBox())!;
  // CurvePreview geometry: W=200, H=80, PAD=HPAD=VPAD=15 → viewBox 230×110.
  const sx = 230 / sb.width, sy = 110 / sb.height;
  const valX = (px: number) => Math.round(Math.max(0, Math.min(1, ((px - sb.x) * sx - 15) / 200)) * 100) / 100;
  const valY = (py: number) => Math.round((1 - ((py - sb.y) * sy - 30) / 50) * 100) / 100;
  const tx = Math.round(sb.x + (15 + vx * 200) / sx);
  const ty = Math.round(sb.y + (30 + (1 - vy) * 50) / sy);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 4 });
  await page.mouse.up();
  await editor.settled();
  return [valX(tx), valY(ty)];
}

test('CMP-125 Instant writes duration 0; a custom curve is stored as an array and reads back as that curve', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: the Transition control writes a custom cubic-bezier as a quoted STRING (`ease: \'[0.2, 0, 0.2, 1]\'`) — formatTransitionObj quotes every non-numeric key; motion needs the bare array');
  const page = editor.page();
  await editor.load(cardProject(plainCard()));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'desktop');
  let pop = await openTransition(page);
  await pop.getByRole('button', { name: 'Instant', exact: true }).click();
  let code = await pollCode(editor, CARD, c => /<MotionConfig transition=/.test(c));
  // Instant = duration: 0, not a removal.
  expect(code).toMatch(/<MotionConfig transition=\{\{\s*duration: 0\s*\}\}>/);
  await closePopup(page);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // A custom cubic-bezier: Ease, then drag both control points.
  pop = await openTransition(page);
  await pop.getByRole('button', { name: 'Ease', exact: true }).click();
  await pollCode(editor, CARD, c => /ease: 'easeOut'/.test(c));
  await dragBezierHandle(editor, pop, 0, 0.2, 0);
  await dragBezierHandle(editor, pop, 1, 0.2, 1);
  // Pointer coordinates are whole pixels and the panel rounds to 0.01: read the
  // curve the drag produced and check it is the one aimed at (±0.03).
  code = await pollCode(editor, CARD, c => { const m = c.match(/ease: ['"]?\[([^\]]+)\]/); return !!m && Math.abs(Number(m[1].split(',')[2]) - 0.2) < 0.04; });
  const curve = code.match(/ease: ['"]?\[([^\]]+)\]/)?.[1] ?? '';
  const nums = curve.split(',').map(Number);
  [0.2, 0, 0.2, 1].forEach((want, i) => expect(Math.abs(nums[i] - want), `bezier[${i}] = ${nums[i]}`).toBeLessThan(0.04));
  expect(parsesClean(code)).toBe(true);
  await closePopup(page);

  // Reopen: the popup reads the curve back as Custom, not a preset.
  pop = await openTransition(page);
  await expect(pop.locator('select').first()).toHaveValue('custom');
  await expect(pop.getByText(curve, { exact: true })).toBeVisible();
  await closePopup(page);

  // Stored as a number array — not a quoted string motion throws on.
  expect(code, 'not a quoted string').not.toMatch(/ease: ['"]\[/);
  expect(code).toMatch(new RegExp(`<MotionConfig transition=\\{\\{[^}]*ease: \\[${curve.replace(/\./g, '\\.')}\\][^}]*\\}\\}>`));
});

// ─── CMP-126 ─────────────────────────────────────────────────────────

const MC_CARD = plainCard().replace(`import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';`, `import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';`)
  .replace(`    <LayoutGroup>\n    <motion.div`, `    <LayoutGroup><MotionConfig transition={{ duration: 0.5 }}>\n    <motion.div`)
  .replace(`    </motion.div>\n    </LayoutGroup>`, `    </motion.div>\n    </MotionConfig></LayoutGroup>`);

/** A transition VARIABLE bound on the MotionConfig (new form). */
const VAR_CARD = MC_CARD
  .replace(`'use client';\n\n/** @name "Card" */`, `'use client';\n\n/** @name "Card" */\n/** @propMeta {"motion":{"type":"transition","label":"Motion"}} */`)
  .replace(`<MotionConfig transition={{ duration: 0.5 }}>`, `<MotionConfig transition={motion}>`)
  .replace(`function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any })`,
    `function Card({ style, initialVariant = 'default', motion: motionT = { duration: 0.5 }, ...rest }: { style?: React.CSSProperties; initialVariant?: string; motion?: any; [key: string]: any })`)
  .replace(`<MotionConfig transition={motion}>`, `<MotionConfig transition={motionT}>`)
  .replace(`"motion":{"type":"transition","label":"Motion"}`, `"motionT":{"type":"transition","label":"Motion"}`)
  .replace(`motion: motionT = { duration: 0.5 }`, `motionT = { duration: 0.5 }`)
  .replace(`motion?: any;`, `motionT?: any;`);

test('CMP-126 Reset Override strips only variant-1\'s transition; the pill × on variant-1 diverges to a clean literal', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  const VAR = 'components/Vcard.tsx';
  await editor.load(cardProject(MC_CARD, { extra: { [VAR]: VAR_CARD.replace(/function Card\(/, 'function Vcard(').replace('withResponsiveProps(Card)', 'withResponsiveProps(Vcard)').replace('@name "Card"', '@name "Vcard"') } }));
  await openMaster(editor);

  // 1. variant-1 gets its own transition, then Reset Override.
  await selectRoot(editor, 'variant-1');
  await setEase(editor, 'circIn');
  let code = await pollCode(editor, CARD, c => /circIn/.test(c));
  expect(variantsOf(code, 'card-root')!['variant-1'].transition).toBe(`{ ease: 'circIn' }`);
  expect(await isOverridden(page, 'Transition'), 'purple on variant-1').toBe(true);
  const withOwn = await stableCode(editor, CARD);
  await labelMenu(page, 'Transition', 'Reset Override');
  code = await pollCode(editor, CARD, c => !/circIn/.test(c));
  expect(variantsOf(code, 'card-root')!['variant-1'], 'only variant-1\'s transition is stripped').toEqual({ backgroundColor: '#ff2d75' });
  expect(code, 'falls back to the MotionConfig, which is untouched').toMatch(/<MotionConfig transition=\{\{ duration: 0\.5 \}\}>/);
  expect(variantsOf(code, 'card-root')!.default).toEqual({ backgroundColor: '#97cffc' });
  await expect(editor).toUndoInOneStep(withOwn, { path: CARD });

  // 2. A transition variable on the MotionConfig: the pill × on variant-1.
  await openMaster(editor, VAR);
  await selectRoot(editor, 'variant-1');
  const pill = page.locator('[data-properties-panel] [title="Remove variable binding"]');
  await expect(pill).toBeVisible({ timeout: 10_000 });
  const beforePill = await editor.code(VAR);
  await pill.click();
  code = await pollCode(editor, VAR, c => /'variant-1': \{[^}]*transition/.test(c));
  expect(parsesClean(code), 'the file parses').toBe(true);
  expect(code, 'not a corrupt string literal').not.toMatch(/'\{, transition|\{\{\}'/);
  expect(variantsOf(code, 'card-root')!['variant-1'].transition, 'variant-1 diverges to a literal').toMatch(/^\{ .*duration: 0\.3.* \}$/);
  expect(code, 'the primary keeps its variable').toMatch(/<MotionConfig transition=\{motionT\}>/);
  await expect(editor).toUndoInOneStep(beforePill, { path: VAR });
});

// ─── CMP-127 ─────────────────────────────────────────────────────────

/** A master in the canonical compiled shape: MotionConfig spring, an
 *  AnimatePresence visibility gate, layout ternaries, `connections` + guarded handlers. */
const COMPILED = `'use client';

/** @name "Faq" */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
  { name: 'default-hover', label: 'Closed - Hover', x: 0, y: 420, interactionType: 'hover', parentVariant: 'default' },
];

const faqRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' },
  'default-hover': { backgroundColor: '#5aa9f0' }
};

const faqChevronVariants = {
  default: { rotate: 0 },
  'variant-1': { rotate: 180 },
  'default-hover': { rotate: 0 }
};

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
  { from: 'default-hover', to: 'variant-1', trigger: 'click' },
  { from: 'variant-1', to: 'default', trigger: 'click' },
];

function Faq({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup><MotionConfig transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}>
    <motion.div
      onTap={() => { const _n = variant === 'default-hover' ? 'variant-1' : variant === 'variant-1' ? 'default' : null; if (_n) setVariant(_n); }}
      onHoverEnd={() => { const _n = variant === 'default-hover' ? 'default' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }} layout={true} data-id="faq-root" data-name="Faq" variants={faqRootVariants} initial={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', height: 'auto', padding: variant === 'variant-1' ? '24px' : '16px', overflow: 'hidden', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.div layout={true} data-id="faq-head" data-name="Head" style={{ position: 'relative', display: 'flex', flexDirection: 'row', justifyContent: 'space-between', width: '100%', height: '40px', flex: '0 0 auto', order: '0' }}>
        <motion.p layout={true} data-id="faq-q" data-name="Question" style={{ position: 'relative', fontSize: '18px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>What is it?</motion.p>
        <motion.div layout={true} data-id="faq-chevron" data-name="Chevron" variants={faqChevronVariants} style={{ position: 'relative', width: '16px', height: '16px', backgroundColor: '#000000', flex: '0 0 auto', order: '1' }} />
      </motion.div>
      <AnimatePresence mode="popLayout">
        {variant === "variant-1" &&
          <motion.p layout={true} key="faq-a" data-id="faq-a" data-name="Answer" style={{ position: 'relative', fontSize: '14px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>A canonical master.</motion.p>
          }
      </AnimatePresence>
    </motion.div>
    </MotionConfig></LayoutGroup>);

}

export default withResponsiveProps(Faq);
`;

test('CMP-127 a master in the canonical compiled shape renders every tile, resolves its gates, hovers in preview and passes the oracle on edit', { tag: ['@p2', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  const FAQ = 'components/Faq.tsx';
  await editor.load(seed({ [FAQ]: COMPILED }, pageWith(`<Faq data-id="faq-a1" data-name="Faq A" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import Faq from '@/components/Faq';`)));
  await openMaster(editor, FAQ, 'default-hover');

  // Every variant tile renders with its own values.
  await expect.poll(() => tileIds(editor)).toEqual(['desktop', 'variant-1', 'default-hover']);
  expect(await computedIn(editor, 'desktop', 'faq-root', 'background-color')).toBe(RGB.default);
  expect(await computedIn(editor, 'variant-1', 'faq-root', 'background-color')).toBe(RGB.v1);
  expect(await computedIn(editor, 'default-hover', 'faq-root', 'background-color')).toBe(RGB.hover);
  expect(await computedIn(editor, 'variant-1', 'faq-root', 'padding-top')).toBe('24px');
  expect(await computedIn(editor, 'desktop', 'faq-root', 'padding-top')).toBe('16px');
  // The visibility gate resolves per tile.
  expect(await shownIn(editor, 'variant-1', 'faq-a')).toBe(true);
  expect(await shownIn(editor, 'desktop', 'faq-a')).toBe(false);
  expect(await shownIn(editor, 'default-hover', 'faq-a')).toBe(false);

  // A first edit passes the builder's oracle.
  const before = await editor.code(FAQ);
  await selectRoot(editor, 'desktop', 'faq-root');
  await setFillHex(page, '#00ff00');
  await pollCode(editor, FAQ, c => /#00ff00/i.test(c));
  await expect(editor).toPassOracle();
  expect(parsesClean(await editor.code(FAQ))).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: FAQ });

  // Hover works in preview.
  const frame = await previewPage(editor, PAGE, '[data-id="faq-a1"]');
  await expect.poll(() => previewStyle(frame, '[data-id="faq-a1"]', 'background-color'), { timeout: 15_000 }).toBe('rgb(0, 255, 0)');
  await hoverPreview(editor, frame, '[data-id="faq-a1"]');
  await expect.poll(() => previewStyle(frame, '[data-id="faq-a1"]', 'background-color'), { timeout: 10_000 }).toBe(RGB.hover);
});
