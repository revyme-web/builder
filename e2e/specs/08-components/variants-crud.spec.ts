// CMP · Variants: add, duplicate, delete, rename (E2E_TEST_PLAN.md §8, batch C4).
// Tiles of an open master: `desktop` is the primary (default variant), every
// other tile is its variant name (`variant-1`, `default-hover`, …).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  CARD, PAGE, ABOUT, MASTER_STATES, STATES_CARD, cardProject, openMaster, addVariantCard, hpStrip, clickCard,
  pageWith, CARD_IMPORT, previewPage, previewStyle, hoverPreview, PREVIEW_NOISE,
  variantConfigOf, connectionsOf, connKey, attrSource, pollCode, stableCode, traces, tileIds,
  computedIn, textIn, countIn, shownIn, selectedOnTile, mentions, objectConsts,
} from '../../helpers/c4';
import { clickStable, parsesClean, variantsOf, styleTernary, openingTag, setFillHex, angleIn, elementSource } from '../../helpers/c5';
import { variantsConst, conditionalAround, revealRow } from '../../helpers/d4';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

/** Select a variant tile's ROOT with a real click in its empty bottom padding. */
async function selectRoot(editor: import('../../helpers/editor').Editor, vpId: string, rootId = 'card-root'): Promise<void> {
  await editor.page().waitForTimeout(450); // out of any earlier click's double-click window
  await clickStable(editor, rootId, vpId, 0.5, 0.95);
  await expect.poll(() => editor.selection()).toEqual([rootId]);
}

const RGB = { default: 'rgb(151, 207, 252)', v1: 'rgb(255, 45, 117)', hover: 'rgb(90, 169, 240)' };

// ─── CMP-101 ─────────────────────────────────────────────────────────

test('CMP-101 + Variant on the default root adds a sparse variant-N tile at the card and selects it', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(MASTER_STATES);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'desktop');
  const card = addVariantCard(page);
  await card.waitFor({ state: 'visible' });
  // The card's canvas position, measured against the default root (canvas 0,0).
  const root0 = await editor.nodeBoxIn('desktop', 'card-root');
  const scale = root0.width / 300;
  await page.waitForTimeout(300);
  const cb = (await card.boundingBox())!;
  const expectX = (cb.x - root0.x) / scale;
  const expectY = (cb.y - root0.y) / scale;
  await clickCard(editor, card);

  // Source: one new entry, first free number from the count (4 entries → variant-4), label = root name.
  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-4'));
  const cfg = variantConfigOf(code);
  expect(cfg.map(v => v.name)).toEqual(['default', 'variant-1', 'default-hover', 'default-pressed', 'variant-4']);
  const v4 = cfg.find(v => v.name === 'variant-4')!;
  expect(v4.label).toBe('Card');
  expect(v4.interactionType, 'a plain variant, not a state').toBeUndefined();
  expect(Math.abs((v4.x as number) - expectX), `x ${v4.x} vs card ${expectX}`).toBeLessThan(6);
  expect(Math.abs((v4.y as number) - expectY), `y ${v4.y} vs card ${expectY}`).toBeLessThan(6);
  // Sparse: no variants object, ternary, gate or handler names the new variant.
  expect(variantsOf(code, 'card-root')!['variant-4'], 'root variants object stays sparse').toBeUndefined();
  expect(variantsOf(code, 'card-badge')!['variant-4'], 'badge variants object stays sparse').toBeUndefined();
  expect(mentions(code, 'variant-4'), 'only the variantConfig row names variant-4').toBe(1);
  expect(connectionsOf(code).map(connKey)).toEqual(connectionsOf(before).map(connKey));

  // Tiles: the new tile appears, is the selected one, and looks like default.
  await expect(editor.sandbox().locator('[data-viewport="variant-4"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(selectedOnTile(page, 'variant-4', 'card-root')).toBeVisible({ timeout: 10_000 });
  expect(await editor.selection()).toEqual(['card-root']);
  await expect.poll(() => computedIn(editor, 'variant-4', 'card-root', 'background-color')).toBe(RGB.default);
  expect(await textIn(editor, 'variant-4', 'card-title')).toBe('Resting copy');
  expect(await textIn(editor, 'variant-4', 'card-desc')).toBe('Description');
  expect(await computedIn(editor, 'variant-4', 'card-bar', 'width')).toBe('120px');
  expect(await shownIn(editor, 'variant-4', 'card-badge'), 'the badge shows like on default').toBe(true);

  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-102 ─────────────────────────────────────────────────────────

test('CMP-102 + Variant on the variant-1 root copies its branches, binding and hidden child', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MASTER_STATES);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'variant-1');
  await clickCard(editor, addVariantCard(editor.page()));

  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-4'));
  expect(variantConfigOf(code).find(v => v.name === 'variant-4')?.label, 'label = the root name').toBe('Card');
  expect(parsesClean(code)).toBe(true);
  // Variants object: variant-1's entry (nested transition included) is cloned.
  expect(variantsOf(code, 'card-root')!['variant-4']).toEqual({ backgroundColor: '#ff2d75', transition: "{ ease: 'easeIn' }" });
  // One new branch per ternary with variant-1's value — prefix and quote style kept.
  const title = elementSource(code, 'card-title');
  expect(title).toContain(`variant === "variant-4" ? "Open copy" : variant === "variant-1" ? "Open copy" : "Resting copy"`);
  const desc = elementSource(code, 'card-desc');
  expect(desc, 'the content binding is copied').toContain(`variant === 'variant-4' ? content : variant === 'variant-1' ? content : "Description"`);
  expect(styleTernary(code, 'card-bar', 'width')!.branches).toEqual({ 'variant-4': '200px', 'variant-1': '200px', 'default-pressed': '150px', default: '120px' });
  expect(styleTernary(code, 'card-bar', 'order')!.branches).toEqual({ 'variant-4': '4', 'variant-1': '4', default: '2' });
  // The child hidden on variant-1 is hidden on the copy too.
  const gate = conditionalAround(code, 'card-badge') ?? '';
  expect(gate).toMatch(/variant !== ["']variant-1["']/);
  expect(gate).toMatch(/variant !== ["']variant-4["']/);

  // Tile: the copy paints variant-1, not the default fallback.
  await expect(editor.sandbox().locator('[data-viewport="variant-4"]')).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => computedIn(editor, 'variant-4', 'card-root', 'background-color')).toBe(RGB.v1);
  expect(await textIn(editor, 'variant-4', 'card-title')).toBe('Open copy');
  expect(await textIn(editor, 'variant-4', 'card-desc')).toBe('Bound copy');
  expect(await computedIn(editor, 'variant-4', 'card-bar', 'width')).toBe('200px');
  expect(await shownIn(editor, 'variant-4', 'card-badge'), 'the hidden child stays hidden').toBe(false);
  // Not: falling back to default values.
  expect(await textIn(editor, 'variant-4', 'card-title')).not.toBe('Resting copy');

  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-103 ─────────────────────────────────────────────────────────

// The numeric per-variant `order` ternary is left out here: collapsing it on
// delete is pinned on its own (CMP-109, a known bug).
const DELETE_CARD = STATES_CARD.replace(`order: variant === 'variant-1' ? 4 : 2`, `order: '2'`);

test('CMP-103 Delete on the variant-1 root removes its whole footprint and keeps the master rendering', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(cardProject(DELETE_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'variant-1');
  await editor.page().keyboard.press('Delete');

  const code = await pollCode(editor, CARD, c => !variantConfigOf(c).some(v => v.name === 'variant-1'));
  expect(parsesClean(code), 'the file still parses').toBe(true);
  // Config, quoted keys (nested transition included), connections, handlers, branches, gate: all gone.
  expect(variantConfigOf(code).map(v => v.name)).toEqual(['default', 'default-hover', 'default-pressed']);
  expect(mentions(code, 'variant-1'), 'nothing names variant-1 any more').toBe(0);
  expect(variantsOf(code, 'card-root')).toEqual({
    default: { backgroundColor: '#97cffc' }, 'default-hover': { backgroundColor: '#5aa9f0' }, 'default-pressed': { backgroundColor: '#3b82f6' },
  });
  expect(connectionsOf(code).map(connKey)).toEqual([
    'default>default-hover:mouseEnter', 'default-hover>default:mouseLeave', 'default-hover>default-pressed:clickStart', 'default-pressed>default-hover:click',
  ]);
  expect(attrSource(code, 'card-toggle', 'onTap'), 'the toggle handler is gone').toBeNull();
  expect(elementSource(code, 'card-title')).toContain('"Resting copy"');
  expect(elementSource(code, 'card-title')).not.toContain('Open copy');
  expect(styleTernary(code, 'card-bar', 'width')!.branches).toEqual({ 'default-pressed': '150px', default: '120px' });
  expect(conditionalAround(code, 'card-badge'), 'the visibility gate is unwrapped').toBeNull();
  // The motion element openings survive the string surgery.
  expect(openingTag(code, 'card-root')).toMatch(/^<motion\.div[\s\S]*layout=\{true\}/);
  expect(openingTag(code, 'card-toggle')).toMatch(/^<motion\.div[\s\S]*layout=\{true\}/);
  expect(attrSource(code, 'card-root', 'animate')).toBe(`['default', variant]`);

  // Canvas: variant-1's tile is gone, default still renders (not a blank canvas).
  await expect.poll(() => tileIds(editor)).toEqual(['desktop', 'default-hover', 'default-pressed']);
  await expect.poll(async () => (await editor.nodeBoxIn('desktop', 'card-root')).height).toBeGreaterThan(100);
  expect(await textIn(editor, 'desktop', 'card-title')).toBe('Resting copy');
  expect(await shownIn(editor, 'desktop', 'card-badge')).toBe(true);

  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-104 ─────────────────────────────────────────────────────────

/** A master whose hover handler carries a transition `connections` has no edge for. */
const DRIFT_CARD = STATES_CARD.replace(
  `onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }}`,
  `onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : variant === 'variant-1' ? 'default-hover' : null; if (_n) setVariant(_n); }}`,
);

test('CMP-104 a variant added from a hover source gets no hover transition; drifted handlers heal on the next edit', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  // The home page also holds an instance pinned to the variant this test creates.
  const home = pageWith(`<Card data-id="card-a" data-name="Card A" style={{ position: 'relative', flex: '0 0 auto' }} />
      <Card data-id="card-v4" data-name="Card V4" initialVariant="variant-4" style={{ position: 'relative', flex: '0 0 auto' }} />`, CARD_IMPORT);
  await editor.load(cardProject(STATES_CARD, { home, extra: { 'components/Drift.tsx': DRIFT_CARD.replace(/function Card\(/, 'function Drift(').replace('withResponsiveProps(Card)', 'withResponsiveProps(Drift)').replace('@name "Card"', '@name "Drift"') } }));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // 1. + Variant from the default root (which owns the hover/pressed connections).
  await selectRoot(editor, 'desktop');
  await clickCard(editor, addVariantCard(page));
  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-4'));
  expect(connectionsOf(code).map(connKey), 'no connection is added for the new variant').toEqual(connectionsOf(before).map(connKey));
  for (const h of ['onHoverStart', 'onHoverEnd', 'onTap', 'onTapStart']) {
    expect(attrSource(code, 'card-root', h) ?? '', `${h} has no branch for variant-4`).not.toContain('variant-4');
  }
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Not: a stateless variant that still hovers in preview (the default instance does).
  const frame = await previewPage(editor, PAGE, '[data-id="card-v4"]');
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 15_000 }).toBe(RGB.default);
  await hoverPreview(editor, frame, '[data-id="card-a"]', 0.5, 0.9);
  await expect.poll(() => previewStyle(frame, '[data-id="card-a"]', 'background-color'), { timeout: 10_000, message: 'control: default hovers' }).toBe(RGB.hover);
  await hoverPreview(editor, frame, '[data-id="card-v4"]', 0.5, 0.9);
  await page.waitForTimeout(800);
  expect(await previewStyle(frame, '[data-id="card-v4"]', 'background-color'), 'variant-4 does not hover').toBe(RGB.default);
  await page.keyboard.press('Escape');

  // 2. A seeded drifted pair (variant-1 → default-hover with no connection) is
  //    regenerated away by the next unrelated edit.
  const DRIFT = 'components/Drift.tsx';
  await openMaster(editor, DRIFT);
  const drifted = await editor.code(DRIFT);
  expect(attrSource(drifted, 'card-root', 'onHoverStart')).toContain(`variant === 'variant-1' ? 'default-hover'`);
  await selectRoot(editor, 'desktop');
  await setFillHex(page, '#00ff00');
  const healed = await pollCode(editor, DRIFT, c => /#00ff00/i.test(c));
  expect(healed).toMatch(/#00ff00/i);
  expect(attrSource(healed, 'card-root', 'onHoverStart'), 'the unbacked transition is gone').toBe(
    `() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }`);
  // Every handler transition is backed by a connection.
  expect(connectionsOf(healed).map(connKey)).toEqual(connectionsOf(drifted).map(connKey));
});

// ─── CMP-105 ─────────────────────────────────────────────────────────

const NESTED_TRANSITION_CARD = STATES_CARD
  .replace(STATES_CARD.slice(STATES_CARD.indexOf('const variantConfig'), STATES_CARD.indexOf('];', STATES_CARD.indexOf('const variantConfig')) + 2), `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];`)
  .replace(`default: { backgroundColor: '#97cffc' },`, `default: { backgroundColor: '#97cffc', transition: { duration: 0.3 } },`)
  .replace(`  'default-hover': { backgroundColor: '#5aa9f0' },\n  'default-pressed': { backgroundColor: '#3b82f6' }\n`, '')
  .replace(`,\n  'default-hover': { backgroundColor: '#000000' },\n  'default-pressed': { backgroundColor: '#000000' }\n`, '\n')
  .replace(/const connections = \[[\s\S]*?\];/, `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'card-toggle' },
  { from: 'variant-1', to: 'default', trigger: 'click', sourceNode: 'card-toggle' },
];`)
  .replace(/\n\s*onTap=\{\(\) => \{ const _n = variant === 'default-pressed'[^\n]*\n\s*onTapStart=[^\n]*\n\s*onHoverEnd=[^\n]*\n\s*onHoverStart=\{[^\n]*?\}\}/, '')
  .replace(`width: variant === 'variant-1' ? '200px' : variant === 'default-pressed' ? '150px' : '120px'`, `width: variant === 'variant-1' ? '200px' : '120px'`);

test('CMP-105 cloning entries with a nested transition stays brace-balanced and every page still renders', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(NESTED_TRANSITION_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(parsesClean(before), 'seed sanity').toBe(true);

  // + Variant from variant-1 (entry: `transition: { ease: 'easeIn' }`).
  await selectRoot(editor, 'variant-1');
  await clickCard(editor, addVariantCard(page));
  const code = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-2'));
  expect(parsesClean(code), 'the clone is brace-balanced').toBe(true);
  expect(code).toMatch(/'variant-2': \{ backgroundColor: '#ff2d75', transition: \{ ease: 'easeIn' \} \}/);
  expect(variantsConst(code, 'cardRootVariants')!['variant-2']).toEqual({ backgroundColor: '#ff2d75', transition: "{ ease: 'easeIn' }" });
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // + Hover from the default root (entry: `transition: { duration: 0.3 }`).
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  const beforeHover = await editor.code(CARD);
  await clickCard(editor, hpStrip(page));
  await page.locator('div').filter({ hasText: /^Hover$/ }).last().click();
  const hovered = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'default-hover') && /onHoverStart/.test(c));
  expect(parsesClean(hovered)).toBe(true);
  expect(variantsConst(hovered, 'cardRootVariants')!['default-hover']).toEqual({ backgroundColor: '#97cffc', transition: '{ duration: 0.3 }' });

  // Every page importing the master still renders its instances.
  for (const [path, inst] of [[PAGE, 'card-a'], [ABOUT, 'card-c']] as const) {
    await editor.openFile(path);
    await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
    await editor.settled();
    await expect.poll(async () => (await editor.sandbox().locator(`[data-node-id="${inst}:card-root"]`).first().boundingBox())?.height ?? 0,
      { timeout: 15_000 }).toBeGreaterThan(100);
  }
  await editor.openFile(CARD);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, CARD);
  await editor.settled();
  await expect(editor).toUndoInOneStep(beforeHover, { path: CARD });
});

// ─── CMP-106 ─────────────────────────────────────────────────────────

const STALE_CARD = `'use client';

/** @name "Logo" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-3', label: 'Three', x: 400, y: 0 },
  { name: 'variant-4', label: 'Four', x: 800, y: 0 },
  { name: 'variant-5', label: 'Green', x: 1200, y: 0 },
];

const logoDotVariants = {
  default: { backgroundColor: '#000000' },
  'variant-5': { backgroundColor: '#22c55e' },
  'variant-6': { backgroundColor: '#000000' }
};

function Logo({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="logo-root" data-name="Logo" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'row', gap: '8px', width: '200px', height: '120px', padding: '24px', backgroundColor: '#ffffff', ...style }}>
      <motion.div layout={true} data-id="logo-dot" data-name="Dot" variants={logoDotVariants} style={{ position: 'relative', width: '24px', height: '24px', borderRadius: '12px', backgroundColor: '#000000', flex: '0 0 auto', order: '0' }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Logo);
`;

test('CMP-106 a new variant-6 inherits its source, not a stale variant-6 entry left behind', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const LOGO = 'components/Logo.tsx';
  await editor.load(cardProject(STATES_CARD, { extra: { [LOGO]: STALE_CARD } }));
  await openMaster(editor, LOGO, 'variant-5');
  const before = await editor.code(LOGO);

  await selectRoot(editor, 'variant-5', 'logo-root');
  await clickCard(editor, addVariantCard(editor.page()));

  const code = await pollCode(editor, LOGO, c => variantConfigOf(c).some(v => v.name === 'variant-6'));
  expect(variantConfigOf(code).map(v => v.name)).toEqual(['default', 'variant-3', 'variant-4', 'variant-5', 'variant-6']);
  expect(variantsConst(code, 'logoDotVariants')!['variant-6'], 'the SOURCE value (green), not the stale black').toEqual({ backgroundColor: '#22c55e' });
  expect((code.match(/['"]variant-6['"]\s*:/g) ?? []).length, 'no duplicate key').toBe(1);
  expect(parsesClean(code)).toBe(true);

  await expect(editor.sandbox().locator('[data-viewport="variant-6"]')).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => computedIn(editor, 'variant-6', 'logo-dot', 'background-color')).toBe('rgb(34, 197, 94)');
  await expect(editor).toUndoInOneStep(before, { path: LOGO });
});

// ─── CMP-107 ─────────────────────────────────────────────────────────

const BURGER_NAV = `'use client';

/** @name "Nav" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
  { name: 'open', label: 'Open', x: 500, y: 0 },
];

const navVariants = {
  default: { backgroundColor: '#ffffff' },
  open: { backgroundColor: '#eeeeee' }
};

const burgerVariants = {
  default: { rotate: 0 },
  open: { rotate: 45 }
};

function Nav({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="nav-root" data-name="Nav" variants={navVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '240px', height: '160px', padding: '40px', backgroundColor: '#ffffff', ...style }}>
      <motion.div layout={true} data-id="nav-burger" data-name="Burger" variants={burgerVariants} style={{ position: 'relative', width: '48px', height: '6px', backgroundColor: '#000000', flex: '0 0 auto', order: '0' }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Nav);
`;

test('CMP-107 a variant added from default seeds the burger rotate rest and leaves paint-only objects sparse', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const NAV = 'components/Nav.tsx';
  await editor.load(cardProject(STATES_CARD, { extra: { [NAV]: BURGER_NAV } }));
  await openMaster(editor, NAV, 'open');
  const before = await editor.code(NAV);

  await selectRoot(editor, 'desktop', 'nav-root');
  await clickCard(editor, addVariantCard(editor.page()));

  const code = await pollCode(editor, NAV, c => variantConfigOf(c).some(v => v.name === 'variant-2'));
  expect(variantsConst(code, 'burgerVariants')!['variant-2'], 'transform rest seeded from what default renders').toEqual({ rotate: '0' });
  expect(variantsConst(code, 'navVariants')!['variant-2'], 'paint-only object stays sparse').toBeUndefined();
  expect(parsesClean(code)).toBe(true);

  // Not: the burger stays an X on the new variant.
  await expect(editor.sandbox().locator('[data-viewport="variant-2"]')).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => angleIn(editor, 'variant-2', 'nav-burger')).toBe(0);
  expect(await angleIn(editor, 'open', 'nav-burger')).toBe(45);
  await expect(editor).toUndoInOneStep(before, { path: NAV });
});

// ─── CMP-108 ─────────────────────────────────────────────────────────

const TARGET_CARD = `'use client';

/** @name "Card" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' }
};

const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'card-toggle' },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.div
      onTap={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-toggle" data-name="Toggle" style={{ position: 'relative', width: '60px', height: '24px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '0' }} />
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>Title</motion.p>
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(Card);
`;

test('CMP-108 deleting the only connection target tears down the variant state and later edits still land', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(TARGET_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'variant-1');
  await page.keyboard.press('Delete');
  const code = await pollCode(editor, CARD, c => !variantConfigOf(c).some(v => v.name === 'variant-1'));
  expect(parsesClean(code)).toBe(true);
  expect(code, 'no connections const').not.toMatch(/const connections/);
  expect(code, 'the sync effect is gone').not.toMatch(/useEffect\(/);
  expect(code, 'the state hook is gone').not.toMatch(/useState\(/);
  expect(code, 'nothing calls setVariant (no "setVariant is not defined")').not.toMatch(/setVariant/);
  expect(attrSource(code, 'card-toggle', 'onTap'), 'the click handler is gone').toBeNull();
  expect(attrSource(code, 'card-root', 'animate'), 'wiring falls back to initialVariant').toBe(`['default', initialVariant]`);
  await expect.poll(() => tileIds(editor)).toEqual(['desktop']);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Undo + redo left the variant deleted; the next unrelated edit is accepted.
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  await setFillHex(page, '#00ff00');
  const edited = await pollCode(editor, CARD, c => /#00ff00/i.test(c));
  expect(edited, 'the edit landed').toMatch(/#00ff00/i);
  await expect.poll(() => computedIn(editor, 'desktop', 'card-root', 'background-color')).toBe('rgb(0, 255, 0)');
});

// ─── CMP-109 ─────────────────────────────────────────────────────────

const GATED_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <AnimatePresence mode="popLayout">
        {initialVariant !== 'variant-1' &&
          <motion.div layout={true} key="node-a" data-id="node-a" data-name="A" style={{ position: 'relative', width: '80px', height: '20px', backgroundColor: '#000000', flex: '0 0 auto', order: '0' }} exit={{ opacity: 0 }} />
        }
      </AnimatePresence>
      <AnimatePresence mode="popLayout">
        {initialVariant === 'variant-1' &&
          <motion.div layout={true} key="node-b" data-id="node-b" data-name="B" style={{ position: 'relative', width: '80px', height: '20px', backgroundColor: '#ff0000', flex: '0 0 auto', order: '1' }} exit={{ opacity: 0 }} />
        }
      </AnimatePresence>
      <motion.div layout={true} data-id="node-c" data-name="C" style={{ position: 'relative', width: '80px', height: '20px', backgroundColor: '#00aa00', flex: '0 0 auto', order: initialVariant === 'variant-1' ? 0 : 2 }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

test('CMP-109 deleting variant-1 ungates, hides and collapses its footprint; recreating variant-1 resurrects nothing', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: deleting a variant collapses a numeric per-variant order ternary to a bare `order: 2`, which the builder\'s own oracle rejects (ORDER_MUST_BE_STRING)');
  const page = editor.page();
  await editor.load(cardProject(GATED_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);

  await selectRoot(editor, 'variant-1');
  await page.keyboard.press('Delete');
  const deleted = await pollCode(editor, CARD, c => !variantConfigOf(c).some(v => v.name === 'variant-1'));
  expect(parsesClean(deleted)).toBe(true);
  expect(mentions(deleted, 'variant-1'), 'no dead reference to variant-1').toBe(0);
  expect(conditionalAround(deleted, 'node-a'), 'A is ungated').toBeNull();
  expect(conditionalAround(deleted, 'node-b'), 'B is hidden everywhere, not deleted').toBe('false');
  expect(styleTernary(deleted, 'node-c', 'order')!.branches, 'order collapses to its fallback').toEqual({ default: '2' });
  await expect.poll(() => shownIn(editor, 'desktop', 'node-a')).toBe(true);
  expect(await shownIn(editor, 'desktop', 'node-b')).toBe(false);
  // B is still in Layers.
  await expect(await revealRow(editor, 'node-b', 'desktop')).toBeAttached();
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // + Variant recreates `variant-1`: A shows on it, the old order is not resurrected.
  await editor.fitCamera();
  await selectRoot(editor, 'desktop');
  await clickCard(editor, addVariantCard(page));
  const recreated = await pollCode(editor, CARD, c => variantConfigOf(c).some(v => v.name === 'variant-1'));
  expect(mentions(recreated, 'variant-1'), 'only the config row names variant-1').toBe(1);
  expect(styleTernary(recreated, 'node-c', 'order')!.branches).toEqual({ default: '2' });
  await expect.poll(() => shownIn(editor, 'variant-1', 'node-a')).toBe(true);
  expect(await shownIn(editor, 'variant-1', 'node-b')).toBe(false);
  // The collapsed order is a QUOTED string (the reorder engine's form).
  expect(styleTernary(deleted, 'node-c', 'order')!.raw).toBe(`'2'`);
});

// ─── CMP-110 ─────────────────────────────────────────────────────────

const HOVER_PERF_CARD = `'use client';

/** @name "Card" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 360, interactionType: 'hover', parentVariant: 'default' },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc', boxShadow: '0px 0px 0px rgba(0, 0, 0, 0)' },
  'default-hover': { backgroundColor: '#5aa9f0', boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.4)' }
};

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onHoverEnd={() => { const _n = variant === 'default-hover' ? 'default' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} {...rest} style={{ contain: 'layout', willChange: 'transform', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(Card);
`;

test('CMP-110 deleting the hover state removes its keys, connections, handlers, state scaffolding and perf pair', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(cardProject(HOVER_PERF_CARD));
  await openMaster(editor, CARD, 'default-hover');
  const before = await editor.code(CARD);

  await selectRoot(editor, 'default-hover');
  await editor.page().keyboard.press('Delete');
  const code = await pollCode(editor, CARD, c => !variantConfigOf(c).some(v => v.name === 'default-hover'));
  expect(parsesClean(code)).toBe(true);
  expect(mentions(code, 'default-hover'), 'the quoted key and every reference are gone').toBe(0);
  expect(code).not.toMatch(/const connections/);
  expect(attrSource(code, 'card-root', 'onHoverStart')).toBeNull();
  expect(attrSource(code, 'card-root', 'onHoverEnd')).toBeNull();
  expect(code, 'no connections left → the variant state scaffolding goes').not.toMatch(/useState\(|useEffect\(|setVariant/);
  expect(attrSource(code, 'card-root', 'animate')).toBe(`['default', initialVariant]`);
  expect(code, 'no heavy animated prop remains → the perf isolation pair is swept').not.toMatch(/contain:\s*'layout'|willChange:\s*'transform'/);
  await expect.poll(() => tileIds(editor)).toEqual(['desktop']);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-111 ─────────────────────────────────────────────────────────

test('CMP-111 renaming a variant from its canvas label and its Layers header changes the label only', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(STATES_CARD.replace(`label: 'Open'`, `label: 'Variant 1'`)));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // 1. Double-click the canvas name label above the variant-1 tile → "Open" → Enter.
  const label = page.locator('[data-canvas-node-label="variant-1:card-root"]');
  await expect(label).toHaveText('Variant 1');
  const lb = (await label.boundingBox())!;
  await page.waitForTimeout(450);
  await page.mouse.dblclick(lb.x + 30, lb.y + lb.height / 2);
  const input = label.locator('input');
  await expect(input).toBeVisible();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially('Open');
  await input.press('Enter');
  let code = await pollCode(editor, CARD, c => variantConfigOf(c).find(v => v.name === 'variant-1')?.label === 'Open' && /data-id="card-root"[^>]*data-name="Open"/.test(c));
  expect(variantConfigOf(code).map(v => [v.name, v.label])).toEqual([
    ['default', 'Default'], ['variant-1', 'Open'], ['default-hover', 'Default - Hover'], ['default-pressed', 'Default - Pressed'],
  ]);
  expect(attrSource(code, 'card-root', 'data-name')).toBe('Open');
  // The internal name is untouched everywhere.
  expect(mentions(code, 'variant-1')).toBe(mentions(before, 'variant-1'));
  await expect(label).toHaveText('Open');
  await expect(page.locator('[data-layer-id="__vp_variant-1"]')).toContainText('Open');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // 2. Rename from the Layers variant header (two clicks on the row).
  const header = page.locator('[data-layer-id="__vp_variant-1"]');
  const renameHeader = async (text: string) => {
    await page.waitForTimeout(450);
    const hb = (await header.boundingBox())!;
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForTimeout(120);
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    const inp = header.locator('input');
    await expect(inp).toBeVisible();
    await page.waitForTimeout(250); // the row re-renders once after the rename starts
    await inp.fill(text);
    await inp.press('Enter');
    await editor.settled();
  };
  const beforeLayers = await editor.code(CARD);
  await renameHeader('Opened');
  code = await pollCode(editor, CARD, c => variantConfigOf(c).find(v => v.name === 'variant-1')?.label === 'Opened');
  expect(variantConfigOf(code).find(v => v.name === 'variant-1')?.label).toBe('Opened');
  expect(mentions(code, 'variant-1')).toBe(mentions(before, 'variant-1'));
  await expect(header).toContainText('Opened');
  await expect(label).toHaveText('Opened');
  await expect(editor).toUndoInOneStep(beforeLayers, { path: CARD });

  // 3. Whitespace and the unchanged label write nothing.
  const settledCode = await editor.code(CARD);
  await renameHeader('   ');
  await page.waitForTimeout(400);
  expect(await editor.code(CARD), 'whitespace writes nothing').toBe(settledCode);
  await renameHeader('Opened');
  await page.waitForTimeout(400);
  expect(await editor.code(CARD), 'the same label writes nothing').toBe(settledCode);
});

// ─── CMP-112 ─────────────────────────────────────────────────────────

/** Parseable, but its default entry holds `};` inside a string: the variants
 *  object matcher stops there, so a clone into it would not parse. */
const EVIL_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'One', x: 600, y: 0 },
];

const cardRootVariants = {
  'variant-1': { backgroundColor: '#ff2d75' },
  default: { backgroundColor: '#97cffc', fontFamily: 'a};b' },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

/** Already unparseable: the variants const lost its own closing `};`. */
const BROKEN_CARD = EVIL_CARD.replace(`  default: { backgroundColor: '#97cffc', fontFamily: 'a};b' },\n};`, `  default: { backgroundColor: '#97cffc' },\n`);

test('CMP-112 + Variant refuses a write that would not parse, and does not lock out an already-broken master', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(/Failed to parse JSX/);
  editor.allowErrors(/variant-ops:addVariant/);
  editor.allowErrors(/modify-file/);
  const BROKEN = 'components/Broken.tsx';
  await editor.load(cardProject(EVIL_CARD, { extra: { [BROKEN]: BROKEN_CARD.replace(/Card/g, 'Broken') } }));
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(parsesClean(before), 'seed sanity: the input parses').toBe(true);

  // 1. Parseable input whose result would not parse: file unchanged, no phantom tile.
  await selectRoot(editor, 'variant-1');
  await clickCard(editor, addVariantCard(page));
  await expect.poll(async () => (await traces(editor, 'variant-ops:addVariant-parse-revert|modify-file:parse-gate')).length, { timeout: 8_000 }).toBeGreaterThan(0);
  await editor.settled();
  expect(await editor.code(CARD), 'the file is unchanged').toBe(before);
  expect(await tileIds(editor), 'no phantom variant tile').toEqual(['desktop', 'variant-1']);
  await expect(editor.sandbox().locator('[data-viewport="variant-2"]')).toHaveCount(0);

  // 2. Already-unparseable master: nothing renders (no tile, no root to select),
  //    so the card is unreachable — run the same op the card runs, through the
  //    editor's own module, and check it is NOT blocked, only traced.
  await openMaster(editor, BROKEN, '');
  expect(await tileIds(editor), 'an unparseable master renders no tile').toEqual([]);
  await page.evaluate(async (path) => {
    const ops = await import('/src/code/variants/variant-ops.ts' as string);
    ops.addVariant(path, 'variant-2', { x: 1200, y: 0 }, 'Two', 'variant-1');
  }, BROKEN);
  const broken = await pollCode(editor, BROKEN, c => /name: 'variant-2'/.test(c));
  expect(broken, 'the write goes through (no lock-out)').toMatch(/name: 'variant-2'/);
  expect((await traces(editor, 'variant-ops:addVariant-preexisting-invalid')).length, 'and is traced').toBeGreaterThan(0);
});
