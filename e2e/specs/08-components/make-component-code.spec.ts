// CMP · Make Component carries the code the subtree depends on (E2E_TEST_PLAN.md
// §8, CMP-018, 022, 025, 034, 035): page <style> rules, variants consts,
// imports, Link → MotionLink, and glide stripped — so the master compiles on
// canvas and preview with nothing left undefined.

import { test, expect } from '../../fixtures/test';
import {
  STYLE_RULES_PAGE, VARIANT_CONSTS_PAGE, IMPORTS_PAGE, LINK_PAGE, GLIDE_PAGE,
  makeComponentViaMenu, exitToPage, allowMasterEntryNoise, allowPreviewNoise,
  parses, count, hasDefaultImport, openPreview,
} from '../../helpers/c1';

const PAGE = 'app/page.client.tsx';
const CARD_CORNER: [number, number] = [0.04, 0.03];

test.beforeEach(async ({ editor }) => {
  test.slow();
  allowMasterEntryNoise(editor);
  allowPreviewNoise(editor);
});

/** A pseudo-element / state style on a node inside the canvas iframe or the preview. */
const afterBorder = (el: Element) => getComputedStyle(el, '::after').borderTopWidth;

test('CMP-018 the subtree\'s Overlay border (::after) and :hover rules move into the master\'s <style>', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(STYLE_RULES_PAGE);
  const before = await editor.code(PAGE);
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });
  const master = await editor.code(made.file);
  const pageCode = await editor.code(PAGE);

  // Both rules (ids preserved) in ONE <style> block of the master…
  expect(master).toContain('[data-id="card-img"]::after');
  expect(master).toContain('border-color: #384bf6');
  expect(master).toContain('[data-id="card-title"]:hover');
  expect(count(master, /<style>/)).toBe(1);
  expect(await parses(master)).toBe(true);
  // …and gone from the page, which keeps the rule of the node that stayed.
  expect(pageCode).not.toContain('[data-id="card-img"]');
  expect(pageCode).not.toContain('[data-id="card-title"]');
  expect(pageCode).toContain('[data-id="cta-row"]::after');

  // The border paints on the master tile…
  await expect.poll(() => editor.node('card-img').evaluate(afterBorder)).toBe('4px');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // …on the page instance…
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  const instImg = editor.sandbox().locator('[data-id="card:card-img"]').first();
  await expect.poll(() => instImg.evaluate(afterBorder)).toBe('4px');
  // …and in the preview, hover included.
  const frame = await openPreview(page, 'Pro plan');
  await expect.poll(() => frame.locator('[data-id="card-img"]').first().evaluate(afterBorder)).toBe('4px');
  const title = frame.locator('[data-id="card-title"]').first();
  await title.hover();
  await expect.poll(() => title.evaluate(el => getComputedStyle(el).opacity)).toBe('0.5');
});

test('CMP-022 a variants const moves with the subtree; a const still used on the page stays there too', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(VARIANT_CONSTS_PAGE);
  const before = await editor.code(PAGE);
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });
  const master = await editor.code(made.file);
  const pageCode = await editor.code(PAGE);

  // Both consts the subtree references are declared in the master, once.
  expect(count(master, /const titleVariants = \{/)).toBe(1);
  expect(count(master, /const sharedVariants = \{/)).toBe(1);
  expect(master).toContain('variants={titleVariants}');
  expect(master).toContain('variants={sharedVariants}');
  // Only-used-by-the-subtree → removed from the page; still used → kept.
  expect(pageCode).not.toContain('titleVariants');
  expect(count(pageCode, /const sharedVariants = \{/)).toBe(1);
  expect(pageCode).toContain('variants={sharedVariants}');
  expect(await parses(master)).toBe(true);
  expect(await parses(pageCode)).toBe(true);
  await expect(editor.node('card-title')).toHaveText('Pro plan');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Not: `ReferenceError: titleVariants is not defined` on the live page (the
  // error guard fails the test on any uncaught error / console.error).
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  const frame = await openPreview(page, 'Pro plan');
  await expect(frame.getByText('Everything in Basic, plus more.')).toBeVisible();
  await expect(frame.getByText('Find an advisor')).toBeVisible();
});

test('CMP-025 imports follow the subtree: a component, a CMS collection, and MotionLink exactly once', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(IMPORTS_PAGE);
  const made = await makeComponentViaMenu(editor, 'bundle', 'Bundle', { at: [0.97, 0.02] });
  const master = await editor.code(made.file);

  expect(hasDefaultImport(master, 'Badge')).toBe(true);
  expect(master).toMatch(/^import team from '@\/cms\/team\.json';$/m);
  expect(count(master, /from 'next\/link'/)).toBe(1);
  expect(count(master, /const MotionLink = motion\.create\(Link\);/)).toBe(1);
  expect(master).toContain('team.map((item, idx)');
  expect(await parses(master)).toBe(true);
  // The page no longer needs the component import it gave away.
  expect(hasDefaultImport(await editor.code(PAGE), 'Badge')).toBe(false);

  // The master renders: the nested instance and every collection row (not empty).
  for (const name of ['Alice Johnson', 'Bob Smith', 'Carol Davis']) {
    await expect(editor.sandbox().getByText(name, { exact: true }).first()).toBeVisible();
  }
  await expect(editor.sandbox().getByText('New', { exact: true }).first()).toBeVisible();

  // Not: `MotionLink is not defined` on live.
  await exitToPage(editor);
  const frame = await openPreview(page, 'About us');
  await expect(frame.getByText('Carol Davis', { exact: true })).toBeVisible();
  await expect(frame.getByText('New', { exact: true })).toBeVisible();
});

test('CMP-034 a next/link child becomes a MotionLink in the master and still navigates', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(LINK_PAGE);
  const before = await editor.code(PAGE);
  const made = await makeComponentViaMenu(editor, 'nav', 'Nav', { at: [0.97, 0.5] });
  const master = await editor.code(made.file);

  expect(master).toMatch(/<MotionLink layout=\{true\} href="\/about" data-id="nav-about"/);
  expect(master).not.toMatch(/<Link[\s>]/);
  expect(count(master, /^import Link from 'next\/link';$/m)).toBe(1);
  expect(count(master, /const MotionLink = motion\.create\(Link\);/)).toBe(1);
  expect(await parses(master)).toBe(true);
  await expect(editor.node('nav-about')).toHaveText('About us');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  const frame = await openPreview(page, 'About us');
  await frame.getByText('About us', { exact: true }).click();
  await expect(frame.getByText('About Us', { exact: true })).toBeVisible({ timeout: 20_000 });
});

test('CMP-035 glide on the frame and on a descendant is stripped from the master; children kept', { tag: ['@p2', '@cmp'] }, async ({ editor }) => {
  await editor.load(GLIDE_PAGE);
  const before = await editor.code(PAGE);
  const made = await makeComponentViaMenu(editor, 'glide-box', 'Glide Box', { at: [0.9, 0.5] });
  const master = await editor.code(made.file);

  expect(master).not.toContain('data-glide');
  expect(master).not.toContain('data-glide-item');
  // Only the master template's own LayoutGroup — no glide-shim group nested inside.
  expect(count(master, /<LayoutGroup>/)).toBe(1);
  expect(await editor.childIds('glide-box', made.file)).toEqual(['glide-inner', 'glide-side']);
  expect(await editor.childIds('glide-inner', made.file)).toEqual(['glide-leaf']);
  // One FLIP layer per element: no element carries a second layout/transition pair.
  expect(master).not.toMatch(/layout=\{true\}[^>]*\slayout[\s>]/);
  expect(master).not.toMatch(/transition=\{\{ type: 'spring', duration: 0\.5/);
  expect(await parses(master)).toBe(true);
  for (const id of ['glide-inner', 'glide-leaf', 'glide-side']) await expect(editor.node(id)).toBeVisible();
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});
