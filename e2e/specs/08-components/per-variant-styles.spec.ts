// CMP · Per-variant styles: fill, size, padding, borders, radius, rotate
// (E2E_TEST_PLAN.md §8, batch C5). Tiles of an open master: `desktop` is the
// primary (default variant), every other tile is its variant name.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  masterSeed, masterModule, openMaster, clickIn, panel, row, label, isOverridden, topPopup, closePopup,
  setFillHex, openFill, stableCode, pollCode, variantEntry, variantsOf, styleTernary, openingTag, tagOf,
  parsesClean, computedIn, boxIn, resizeBy, typeInRow, rafs, CONFIG_2V, MASTER_HEAD,
  afterIn, angleIn, rotateByHandle, setBorderWidth, labelMenu,
  PAGE_HEADER, PREVIEW_NOISE, PREVIEW_MASTER_KEY_NOISE,
} from '../../helpers/c5';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const CARD = 'components/Card.tsx';
const PAGE = 'app/page.client.tsx';

const pageWith = (jsx: string, imports = `import Card from '@/components/Card';`) => `${PAGE_HEADER}
'use client';
${imports}
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
      ${jsx}
    </div>
  );
}
`;

// ─── Seeds ───────────────────────────────────────────────────────────

/** A blue card root without a variants object; the page holds a variant-1 instance. */
const FILL_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#0000ff', ...style }}>
      <motion.p layout={true} data-id="card-body" data-name="Body" style={{ fontSize: '16px', color: '#cccccc' }}>Tracking expenses</motion.p>
    </motion.div>`), {}, pageWith(`<Card data-id="card-v1" data-name="Card" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto' }} />`));

test('CMP-128 a Fill set on the variant-1 root lands in its variants entry and seeds the default', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(FILL_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // Select the root on the variant-1 tile (its bottom padding, clear of the child).
  await clickIn(editor, 'variant-1', 'card-root', 0.5, 0.95);
  expect(await editor.selection()).toEqual(['card-root']);
  await setFillHex(page, '#ff0000');

  // Source: the variant-1 entry owns the colour; the default entry carries the
  // base colour so the instance can animate back.
  const code = await pollCode(editor, CARD, c => variantEntry(c, 'card-root', 'variant-1')?.backgroundColor != null);
  expect(variantEntry(code, 'card-root', 'variant-1')).toEqual({ backgroundColor: '#ff0000' });
  expect(variantEntry(code, 'card-root', 'default')).toEqual({ backgroundColor: '#0000ff' });
  expect((await editor.style('card-root', CARD)).backgroundColor, 'the base style is untouched').toBe('#0000ff');

  // Tiles: variant-1 paints red, default stays blue.
  await expect.poll(() => computedIn(editor, 'variant-1', 'card-root', 'background-color')).toBe('rgb(255, 0, 0)');
  expect(await computedIn(editor, 'desktop', 'card-root', 'background-color')).toBe('rgb(0, 0, 255)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // The page instance with initialVariant="variant-1" paints red on the canvas…
  await editor.openFile(PAGE);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, PAGE);
  await editor.settled();
  // The expanded instance root renders as `<instanceId>:<childId>`.
  await expect.poll(() => editor.sandbox().locator('[data-node-id="card-v1:card-root"]').first()
    .evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 10_000 }).toBe('rgb(255, 0, 0)');

  // …and in the preview.
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  const inst = frame.locator('[data-id="card-v1"]').first();
  await inst.waitFor({ state: 'attached', timeout: 45_000 });
  await expect.poll(() => inst.evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 15_000 }).toBe('rgb(255, 0, 0)');
});

// ─── CMP-129 · MotionLink root with a hover state ────────────────────

const SIGNUP = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(Link);

/** @name "Sign Up Button" */

const variantConfig = [
  { name: 'default', label: 'Start free trial', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Start free trial - Hover', x: 0, y: 140, interactionType: 'hover', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function SignUp({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <MotionLink
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} layout={true} key="signup" data-id="link-signup" {...rest} data-name="Start free trial" href="/" style={{ display: 'flex', flexDirection: 'row', gap: '10px', padding: '16px 24px', position: 'relative', backgroundColor: '#111111', width: 'max-content', height: 'min-content', overflow: 'hidden', ...style}} initial={['default', initialVariant]} animate={['default', variant]}>
      <motion.p layout={true} data-id="text-signup" data-name="Label" style={{ position: 'relative', fontSize: '16px', color: '#ffffff' }}>Start free trial</motion.p>
    </MotionLink>
    </LayoutGroup>
  );
}

export default withResponsiveProps(SignUp);
`;
const SIGNUP_SEED = masterSeed('SignUp', SIGNUP, {}, pageWith(`<SignUp data-id="signup-inst" data-name="Start free trial" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import SignUp from '@/components/SignUp';`));

test('CMP-129 a hover Fill on a MotionLink root goes into its variants object with the rgba intact', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  const SIGN = 'components/SignUp.tsx';
  editor.allowErrors(PREVIEW_NOISE);
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(SIGNUP_SEED);
  await openMaster(editor, SIGN, 'default-hover');
  const before = await editor.code(SIGN);

  await clickIn(editor, 'default-hover', 'link-signup', 0.5, 0.12);
  expect(await editor.selection()).toEqual(['link-signup']);
  await setFillHex(page, '#57C357', { alpha: 45 });

  const code = await pollCode(editor, SIGN, c => /rgba\(87, 195, 87, 0\.45\)/.test(c));
  expect(parsesClean(code), 'the file still parses').toBe(true);
  // Written into the MotionLink's variants object, not an inline ternary.
  expect(tagOf(code, 'link-signup')).toBe('MotionLink');
  expect(variantEntry(code, 'link-signup', 'default-hover')?.backgroundColor).toBe('rgba(87, 195, 87, 0.45)');
  expect(styleTernary(code, 'link-signup', 'backgroundColor')?.raw, 'no inline ternary').toBe("'#111111'");
  // Not: the comma-naive writer's shredded tail.
  expect(code).not.toMatch(/'rgba\(87, 195, 87, 0\.45\)'\s*:\s*''\s*,\s*\d/);
  expect(code.match(/rgba\(87, 195, 87, 0\.45\)/g)).toHaveLength(1);
  await expect.poll(() => computedIn(editor, 'default-hover', 'link-signup', 'background-color')).toBe('rgba(87, 195, 87, 0.45)');
  expect(await computedIn(editor, 'desktop', 'link-signup', 'background-color')).toBe('rgb(17, 17, 17)');
  await expect(editor).toUndoInOneStep(before, { path: SIGN });

  // Preview: hovering the instance shows the colour.
  await editor.openFile(PAGE);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, PAGE);
  await editor.settled();
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  const link = frame.locator('[data-id="signup-inst"]').first();
  await link.waitFor({ state: 'visible', timeout: 45_000 });
  expect(await link.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(17, 17, 17)');
  await link.hover();
  await expect.poll(() => link.evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 10_000 }).toBe('rgba(87, 195, 87, 0.45)');
});

// ─── CMP-130 · per-variant size ──────────────────────────────────────

const SIZE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '300px', height: '200px', backgroundColor: '#222244', ...style }}>
      <motion.svg data-id="icon" data-name="Icon" viewBox="0 0 40 40" preserveAspectRatio="none" initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '20px', top: '20px', width: '80px', height: '80px', overflow: 'visible' }}><path data-id="icon-g0" d="M0 0 H40 V40 H0 Z" fill="#ff2d75" /></motion.svg>
    </motion.div>`));

test('CMP-130 a variant-1 resize writes an inline size ternary (a motion.svg wrapper writes its variants object)', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: the per-variant svg-wrapper size the builder deliberately writes into the variants object (generator-styles svgSizeKeys) is rejected by its own oracle (LAYOUT_PROP_IN_VARIANT_OBJECT has no svg exemption)');
  const page = editor.page();
  await editor.load(SIZE_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const d0 = await editor.nodeBoxIn('desktop', 'card-root');

  // Handle: drag the right edge of the variant-1 root.
  await clickIn(editor, 'variant-1', 'card-root', 0.8, 0.9);
  expect(await editor.selection()).toEqual(['card-root']);
  await resizeBy(editor, { edge: 'right' }, 40, 0);
  let code = await pollCode(editor, CARD, c => styleTernary(c, 'card-root', 'width')?.driver != null);
  let w = styleTernary(code, 'card-root', 'width')!;
  expect(w.driver).toBe('initialVariant');
  expect(w.branches.default).toBe('300px');
  expect(parseFloat(w.branches['variant-1'])).toBeGreaterThan(300);
  expect(variantEntry(code, 'card-root', 'variant-1')?.width, 'not in a variants object').toBeUndefined();
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Size tool: W 400.
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
  await clickIn(editor, 'variant-1', 'card-root', 0.8, 0.9);
  await typeInRow(page, 'Width', '400');
  code = await pollCode(editor, CARD, c => styleTernary(c, 'card-root', 'width')?.branches['variant-1'] === '400px');
  w = styleTernary(code, 'card-root', 'width')!;
  expect(w.raw).toBe(`initialVariant === 'variant-1' ? '400px' : '300px'`);
  await expect.poll(async () => (await boxIn(editor, 'variant-1', 'card-root'))!.width / (await boxIn(editor, 'desktop', 'card-root'))!.width).toBeCloseTo(400 / 300, 1);
  const d1 = await editor.nodeBoxIn('desktop', 'card-root');
  expect(Math.abs(d1.width - d0.width), 'the default tile keeps its width').toBeLessThan(1);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // A motion.svg wrapper: per-variant size goes into its variants object.
  await clickIn(editor, 'variant-1', 'icon');
  expect(await editor.selection()).toEqual(['icon']);
  // A vector's Dimensions row is "Size" (W × H).
  await typeInRow(page, 'Size', '120');
  code = await pollCode(editor, CARD, c => variantEntry(c, 'icon', 'variant-1')?.width != null);
  expect(variantEntry(code, 'icon', 'variant-1')?.width).toMatch(/^120(px)?$/);
  expect(styleTernary(code, 'icon', 'width')?.raw, 'no inline ternary on the svg').toBe(`'80px'`);
  expect(parsesClean(code)).toBe(true);
  // The builder must pass its own oracle.
  await expect(editor).toPassOracle();
});

// ─── CMP-134 / 135 · per-variant padding ─────────────────────────────

const FOOTER_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="footer" data-name="Footer" variants={footerVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '10px', width: '360px', height: 'min-content', paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="footer-bar" data-name="Bar" style={{ position: 'relative', width: '100%', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
    </motion.div>`, {
  pre: `const footerVariants = {
  default: { paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px' },
  'variant-1': { paddingTop: '32px', paddingRight: '16px', paddingBottom: '32px', paddingLeft: '16px' },
};`,
}));

test('CMP-134 a variant-1 padding-bottom edit writes only that longhand; the default gains no shorthand', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(FOOTER_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const bar0 = await editor.nodeBoxIn('desktop', 'footer-bar');
  const root0 = await editor.nodeBoxIn('desktop', 'footer');

  await clickIn(editor, 'variant-1', 'footer', 0.5, 0.97);
  expect(await editor.selection()).toEqual(['footer']);
  const pad = row(page, 'Padding');
  // 32/16/32/16 reads as X/Y; switch to individual sides and set Bottom.
  await pad.locator('button[title="Individual sides"]').click();
  const bottom = pad.locator('input').nth(3);
  await bottom.click();
  await bottom.fill('42');
  await bottom.press('Enter');

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'footer', 'variant-1')?.paddingBottom === '42px');
  expect(variantEntry(code, 'footer', 'variant-1')).toEqual({ paddingTop: '32px', paddingRight: '16px', paddingBottom: '42px', paddingLeft: '16px' });
  const def = variantEntry(code, 'footer', 'default')!;
  expect(def.padding, 'no padding shorthand in the default entry').toBeUndefined();
  expect(def).toEqual({ paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px' });
  expect((await editor.style('footer', CARD)).padding).toBeUndefined();

  // Tiles: the primary keeps 90/0/80/0; variant-1 paints the new bottom.
  await expect.poll(() => computedIn(editor, 'variant-1', 'footer', 'padding-bottom')).toBe('42px');
  expect(await computedIn(editor, 'variant-1', 'footer', 'padding-top')).toBe('32px');
  expect(await computedIn(editor, 'desktop', 'footer', 'padding-top')).toBe('90px');
  expect(await computedIn(editor, 'desktop', 'footer', 'padding-bottom')).toBe('80px');
  // Not: every tile collapsing.
  const bar1 = await editor.nodeBoxIn('desktop', 'footer-bar');
  const root1 = await editor.nodeBoxIn('desktop', 'footer');
  expect(Math.abs(bar1.y - bar0.y)).toBeLessThan(1);
  expect(Math.abs(root1.height - root0.height)).toBeLessThan(1);

  // The Padding label shows the override and offers Reset Override.
  await expect.poll(() => isOverridden(page, 'Padding')).toBe(true);
  await label(page, 'Padding').click();
  await expect(page.getByText('Reset Override', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

const PAD_SHORTHAND_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="box" data-name="Box" variants={boxVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '320px', height: 'min-content', padding: '50px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="box-bar" data-name="Bar" style={{ position: 'relative', width: '100%', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
    </motion.div>`, {
  pre: `const boxVariants = {
  default: { padding: '50px' },
  'variant-1': { paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px' },
};`,
}));

test('CMP-135 a primary padding edit and scrub keep the default shorthand; variant-1 stays 16px', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: the panel live scrub (ControlProvider.updateStyleLive → variantOwnsKey) mirrors the `padding` shorthand onto a variant tile that owns paddingTop/Right/Bottom/Left — variant-1 paints the primary value mid-drag');
  const page = editor.page();
  await editor.load(PAD_SHORTHAND_MASTER);
  await openMaster(editor);

  await clickIn(editor, 'desktop', 'box', 0.5, 0.97);
  expect(await editor.selection()).toEqual(['box']);
  const input = row(page, 'Padding').locator('input').first();
  await expect(input).toHaveValue('50');
  expect(await computedIn(editor, 'desktop', 'box', 'padding-top')).toBe('50px');

  // Typed edit.
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill('70');
  await input.press('Enter');
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'box', 'default')?.padding === '70px');
  expect(variantEntry(code, 'box', 'default'), 'no longhand seeds in the default').toEqual({ padding: '70px' });
  await expect.poll(() => computedIn(editor, 'desktop', 'box', 'padding-top')).toBe('70px');
  expect(await computedIn(editor, 'variant-1', 'box', 'padding-top')).toBe('16px');

  // Scrub: press the up chevron (+1) and drag up 46px → 117.
  const before = await stableCode(editor, CARD);
  await input.hover();
  const up = row(page, 'Padding').locator('input').first().locator('xpath=following-sibling::div[1]//button[1]');
  const ub = (await up.boundingBox())!;
  await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.mouse.down();
  const midPrimary: number[] = [];
  const midV1 = new Set<string>();
  for (let i = 1; i <= 46; i++) {
    await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2 - i);
    if (i % 8 === 0) {
      await rafs(page, 2);
      midPrimary.push(parseFloat(await computedIn(editor, 'desktop', 'box', 'padding-top')));
      midV1.add(await computedIn(editor, 'variant-1', 'box', 'padding-top'));
    }
  }
  await rafs(page, 2);
  expect(await computedIn(editor, 'desktop', 'box', 'padding-top'), 'the primary shows the scrubbed value live').toBe('117px');
  await page.mouse.up();
  await editor.settled();

  code = await pollCode(editor, CARD, c => variantEntry(c, 'box', 'default')?.padding === '117px');
  expect(variantEntry(code, 'box', 'default')).toEqual({ padding: '117px' });
  expect(variantEntry(code, 'box', 'variant-1')).toEqual({ paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px' });
  await expect(input).toHaveValue('117');
  expect(await computedIn(editor, 'desktop', 'box', 'padding-top')).toBe('117px');
  expect(await computedIn(editor, 'variant-1', 'box', 'padding-top')).toBe('16px');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Mid-scrub: the primary never painted 0, and variant-1 (which owns all four
  // longhands) was never flattened to the primary's shorthand.
  expect(Math.min(...midPrimary)).toBeGreaterThan(60);
  expect([...midV1], 'variant-1 padding during the scrub').toEqual(['16px']);
});

// ─── CMP-136 · live fan-out skips tiles that own the key ─────────────

const FANOUT_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="box" data-name="Box" variants={boxVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '300px', height: '200px', backgroundColor: 'rgb(0, 0, 255)', ...style }}>
      <motion.div layout={true} data-id="box-chip" data-name="Chip" style={{ position: 'absolute', left: '20px', top: '20px', width: '40px', height: '40px', backgroundColor: '#ffffff' }} />
    </motion.div>`, {
  pre: `const boxVariants = {
  default: {},
  'variant-1': { backgroundColor: 'rgb(255, 0, 0)' },
};`,
}));

test('CMP-136 dragging the Fill picker on the default tile leaves the variant-1 tile red', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(FANOUT_MASTER);
  await openMaster(editor);
  expect(await computedIn(editor, 'variant-1', 'box', 'background-color')).toBe('rgb(255, 0, 0)');

  await clickIn(editor, 'desktop', 'box', 0.7, 0.8);
  expect(await editor.selection()).toEqual(['box']);
  const pop = await openFill(page);
  // The saturation/value pad is the first colour square in the picker.
  const pad = pop.locator('div[style*="background-color: rgb(0, 0, 255)"]').first();
  const pb = (await pad.boundingBox())!;
  await page.mouse.move(pb.x + pb.width * 0.9, pb.y + pb.height * 0.1);
  await page.mouse.down();
  const seen = new Set<string>();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(pb.x + pb.width * (0.9 - i * 0.05), pb.y + pb.height * (0.1 + i * 0.04));
    await rafs(page, 2);
    seen.add(await computedIn(editor, 'desktop', 'box', 'background-color'));
    expect(await computedIn(editor, 'variant-1', 'box', 'background-color'), `variant-1 mid-drag (step ${i})`).toBe('rgb(255, 0, 0)');
  }
  await page.mouse.up();
  await editor.settled();
  expect([...seen].some(c => c !== 'rgb(0, 0, 255)'), 'the default tile follows the drag live').toBe(true);
  await closePopup(page);
  await stableCode(editor, CARD);
  expect(await computedIn(editor, 'variant-1', 'box', 'background-color')).toBe('rgb(255, 0, 0)');
  expect(variantEntry(await editor.code(CARD), 'box', 'variant-1')).toEqual({ backgroundColor: 'rgb(255, 0, 0)' });
});

// ─── CMP-143 · Fill × on a variant writes an explicit clear ──────────

test('CMP-143 Fill × on the variant-1 tile writes an explicit transparent fill; default stays blue', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(FILL_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await clickIn(editor, 'variant-1', 'card-root', 0.5, 0.95);
  expect(await editor.selection()).toEqual(['card-root']);
  await row(page, 'Fill').getByText('×', { exact: true }).click();

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'card-root', 'variant-1')?.backgroundColor != null);
  const v1 = variantEntry(code, 'card-root', 'variant-1')!;
  expect(v1.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(v1.backgroundImage ?? 'none').toBe('none');
  expect(variantEntry(code, 'card-root', 'default')?.backgroundColor ?? (await editor.style('card-root', CARD)).backgroundColor).toBe('#0000ff');
  await expect(row(page, 'Fill').getByText('Add', { exact: true })).toBeVisible();
  await expect.poll(() => computedIn(editor, 'variant-1', 'card-root', 'background-color')).toBe('rgba(0, 0, 0, 0)');
  expect(await computedIn(editor, 'desktop', 'card-root', 'background-color')).toBe('rgb(0, 0, 255)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-141 · rotate back to exactly 0 on a variant ─────────────────

const ROTATE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '260px', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="spin" data-name="Spin" variants={spinVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '80px', width: '100px', height: '100px', backgroundColor: '#ffcc33' }}>
        <motion.div data-id="spin-mark" data-name="Mark" style={{ position: 'absolute', left: '0px', top: '0px', width: '30px', height: '30px', backgroundColor: '#ff2d75' }} />
      </motion.div>
      <motion.svg data-id="spin-v" data-name="SpinVector" viewBox="0 0 60 60" preserveAspectRatio="none" variants={spinVVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '200px', top: '100px', width: '60px', height: '60px', overflow: 'visible' }}><path data-id="spin-v-g0" d="M0 0 H60 V60 H0 Z" fill="#33cc88" /></motion.svg>
    </motion.div>`, {
  pre: `const spinVariants = {
  default: { rotate: 90 },
  'variant-1': {},
};
const spinVVariants = {
  default: { rotate: 90 },
  'variant-1': {},
};`,
}));

test('CMP-141 rotating a variant-1 child back to 0 writes an explicit rotate: 0 (handle, Rotate field, Transform popup)', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(ROTATE_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(await angleIn(editor, 'variant-1', 'spin')).toBe(90);
  expect(await angleIn(editor, 'variant-1', 'spin-v')).toBe(90);

  const expectZero = async (id: string, how: string) => {
    const code = await pollCode(editor, CARD, c => variantEntry(c, id, 'variant-1')?.rotate != null);
    expect(variantEntry(code, id, 'variant-1')?.rotate, `${how}: explicit rotate 0 on variant-1 (not an empty entry)`).toBe('0');
    expect(variantEntry(code, id, 'default')?.rotate, `${how}: default keeps 90`).toBe('90');
    await expect.poll(() => angleIn(editor, 'variant-1', id), { message: `${how}: tile unrotated` }).toBe(0);
    expect(await angleIn(editor, 'desktop', id)).toBe(90);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
    await editor.undo();
    await expect.poll(() => editor.code(CARD)).toBe(before);
  };

  // 1. The rotate handle (Shift = 15° snap) back by 90°.
  await clickIn(editor, 'variant-1', 'spin', 0.7, 0.7);
  expect(await editor.selection()).toEqual(['spin']);
  await rotateByHandle(editor, -90);
  await expectZero('spin', 'handle');

  // 2. The Styles Rotate field (a standalone Rotate row exists on vectors).
  await clickIn(editor, 'variant-1', 'spin-v');
  expect(await editor.selection()).toEqual(['spin-v']);
  await expect(row(page, 'Rotate').locator('input').first()).toHaveValue('90');
  await typeInRow(page, 'Rotate', '0');
  await expectZero('spin-v', 'Rotate field');

  // 3. The Transform popup's Rotate field.
  await clickIn(editor, 'variant-1', 'spin', 0.7, 0.7);
  await row(page, 'Transform').locator('button[type="button"]').first().click();
  const pop = topPopup(page);
  const rot = pop.locator('div:has(> span[title="Rotate"]) input, div:has(> button span[title="Rotate"]) input').first();
  await rot.click();
  await rot.press('ControlOrMeta+a');
  await rot.fill('0');
  await rot.press('Enter');
  await closePopup(page);
  await expectZero('spin', 'Transform popup');
});

// ─── CMP-142 · svg wrapper rotate + align on a variant ───────────────

const ALIGN_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '260px', backgroundColor: '#111827', ...style }}>
      <motion.svg data-id="logo" data-name="Logo" viewBox="0 0 80 40" preserveAspectRatio="none" initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '30px', top: '30px', width: '120px', height: '60px', overflow: 'visible' }}><path data-id="logo-g0" d="M0 0 H80 V40 H0 Z" fill="#3b82f6" /></motion.svg>
      <motion.div data-id="dot" data-name="Dot" variants={dotVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '50%', top: '160px', width: '60px', height: '60px', backgroundColor: '#ff2d75' }} />
    </motion.div>`, {
  config: CONFIG_3V_LOCAL(),
  pre: `const dotVariants = {
  default: { x: '-50%' },
  'variant-2': { backgroundColor: '#33cc88' },
};`,
}));

function CONFIG_3V_LOCAL(): string {
  return `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 450, y: 0 },
  { name: 'variant-2', label: 'Variant 2', x: 900, y: 0 },
];`;
}

test('CMP-142 variant-1: an svg wrapper rotates in its entry around its centre; align writes x, clearing never seeds a raw -50%', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(ALIGN_MASTER);
  await openMaster(editor);

  // (a) Rotate the top-level svg wrapper with the handle.
  const b0 = (await boxIn(editor, 'variant-1', 'logo'))!;
  await clickIn(editor, 'variant-1', 'logo', 0.6, 0.6);
  expect(await editor.selection()).toEqual(['logo']);
  await rotateByHandle(editor, 30);
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'logo', 'variant-1')?.rotate != null);
  expect(Number(variantEntry(code, 'logo', 'variant-1')?.rotate)).toBe(30);
  expect(variantEntry(code, 'logo', 'default')?.rotate ?? '0').toBe('0');
  await expect.poll(() => angleIn(editor, 'variant-1', 'logo')).toBe(30);
  expect(await angleIn(editor, 'desktop', 'logo')).toBe(0);
  // Around the right pivot: the box centre stays put (no left shift).
  const b1 = (await boxIn(editor, 'variant-1', 'logo'))!;
  expect(Math.abs((b1.x + b1.width / 2) - (b0.x + b0.width / 2)), 'centre x').toBeLessThan(3);
  expect(Math.abs((b1.y + b1.height / 2) - (b0.y + b0.height / 2)), 'centre y').toBeLessThan(3);
  expect(parsesClean(code)).toBe(true);

  // (b) Clear the dot's centring on variant-1 (Align Left), then re-centre it.
  await clickIn(editor, 'variant-1', 'dot');
  expect(await editor.selection()).toEqual(['dot']);
  const beforeAlign = await stableCode(editor, CARD);
  await panel(page).locator('button[title="Align Left"]').click();
  code = await pollCode(editor, CARD, c => c !== beforeAlign);
  expect(parsesClean(code), 'clearing x/y keeps the file parseable').toBe(true);
  // Never a raw (unquoted) -50% seeded into variant-2.
  expect(code).not.toMatch(/x:\s*-50%/);
  const v2 = variantEntry(code, 'dot', 'variant-2')!;
  expect(v2.backgroundColor).toBe('#33cc88');
  if (v2.x != null) expect(code).toMatch(/'variant-2':\s*\{[^}]*x:\s*'-50%'/);
  expect(variantEntry(code, 'dot', 'default')?.x, 'the default keeps its centring').toBe('-50%');

  await panel(page).locator('button[title="Center Horizontally"]').click();
  code = await pollCode(editor, CARD, c => variantEntry(c, 'dot', 'variant-1')?.x === '-50%');
  const v1 = variantEntry(code, 'dot', 'variant-1')!;
  expect(v1.x).toBe('-50%');
  expect(v1.translateX).toBeUndefined();
  expect(code).not.toMatch(/translateX/);
  expect(parsesClean(code)).toBe(true);
  // The dot paints centred on variant-1.
  const root = (await boxIn(editor, 'variant-1', 'card-root'))!;
  await expect.poll(async () => {
    const d = (await boxIn(editor, 'variant-1', 'dot'))!;
    return Math.abs(Math.round((d.x + d.width / 2) - (root.x + root.width / 2)));
  }).toBeLessThanOrEqual(1);
});

// ─── CMP-144 / 145 · per-variant overlay borders ─────────────────────

const STATE_HEAD = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;
const STATE_HOOKS = `  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
`;
const HOVER_CONFIG = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 260, interactionType: 'hover', parentVariant: 'default' },
  { name: 'variant-1', label: 'Variant 1', x: 420, y: 0 },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];`;
const HOVER_HANDLERS = `onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}`;

/** A button whose base has a LITERAL (pre-vars) overlay border. */
const LITERAL_BORDER_MASTER = masterSeed('Card', masterModule(`
    <motion.div ${HOVER_HANDLERS} layout={true} data-id="btn" data-name="Button" initial={['default', initialVariant]} animate={['default', variant]} {...rest} style={{ position: 'relative', display: 'flex', width: '240px', height: '80px', backgroundColor: '#eeeeee', ...style }}>
      <style>{\`
    [data-id="btn"]::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-width: 2px;
  border-style: solid;
  border-color: #0000ff;
    }
  \`}</style>
      <motion.p layout={true} data-id="btn-label" data-name="Label" style={{ fontSize: '16px', color: '#111111', position: 'relative' }}>Hello</motion.p>
    </motion.div>`, { config: HOVER_CONFIG, head: STATE_HEAD, hooks: STATE_HOOKS }));

test('CMP-144 a border added on the Hover tile is its own override; the base border is kept and a later base edit leaves it', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: the builder's own var-backed overlay border (inline '--rvb-bw/bs/bc' on the root) is rejected by its oracle — STYLE_PROP_NO_CONTROL flags every `--` style key, and the Border panel does read/remove these");
  const page = editor.page();
  await editor.load(LITERAL_BORDER_MASTER);
  await openMaster(editor, CARD, 'default-hover');
  const before = await editor.code(CARD);
  expect(await afterIn(editor, 'default-hover', 'btn', 'border-top-width')).toBe('2px');

  await clickIn(editor, 'default-hover', 'btn', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['btn']);
  await setBorderWidth(page, 6);

  // Source: the hover entry states its own border; the base border is kept.
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'btn', 'default-hover')?.['--rvb-bw'] === '6px');
  expect(variantEntry(code, 'btn', 'default-hover')).toMatchObject({ '--rvb-bw': '6px', '--rvb-bs': 'solid', '--rvb-bc': '#0000ff' });
  expect((await editor.style('btn', CARD))['--rvb-bw'], 'the base keeps its 2px').toBe('2px');
  expect(variantEntry(code, 'btn', 'default')?.['--rvb-bw']).toBe('2px');
  expect(code).toMatch(/\[data-id="btn"\]::after\s*\{[^}]*border-width: var\(--rvb-bw\)/);
  await expect.poll(() => afterIn(editor, 'default-hover', 'btn', 'border-top-width')).toBe('6px');
  expect(await afterIn(editor, 'desktop', 'btn', 'border-top-width')).toBe('2px');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // A later base edit (primary width 3) never clobbers the hover's border.
  await clickIn(editor, 'desktop', 'btn', 0.9, 0.9);
  await setBorderWidth(page, 3);
  code = await pollCode(editor, CARD, c => (parseSourceStyle(c, 'btn')['--rvb-bw'] ?? '') === '3px');
  expect(variantEntry(code, 'btn', 'default-hover')?.['--rvb-bw']).toBe('6px');
  await expect.poll(() => afterIn(editor, 'desktop', 'btn', 'border-top-width')).toBe('3px');
  expect(await afterIn(editor, 'default-hover', 'btn', 'border-top-width')).toBe('6px');
  // The builder's oracle accepts the file.
  await expect(editor).toPassOracle();
});

function parseSourceStyle(code: string, id: string): Record<string, string> {
  const tag = openingTag(code, id);
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/'(--[\w-]+)':\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

/** Var-backed borders: the primary 2px blue, the hover 4px red, variant-1 has
 *  no entry; `chip` keeps a LITERAL per-variant overlay on variant-1. */
const VAR_BORDER_MASTER = masterSeed('Card', masterModule(`
    <motion.div ${HOVER_HANDLERS} layout={true} data-id="btn" data-name="Button" variants={btnVariants} initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-variant={variant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', width: '240px', height: '120px', backgroundColor: '#eeeeee', '--rvb-bw': '2px', '--rvb-bs': 'solid', '--rvb-bc': '#0000ff', ...style }}>
      <style>{\`
    [data-id="btn"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border-width: var(--rvb-bw);
  border-style: var(--rvb-bs);
  border-color: var(--rvb-bc);
    }
    [data-variant="variant-1"] [data-id="chip"]::after, [data-id="chip"][data-variant="variant-1"]::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-width: 5px;
  border-style: solid;
  border-color: #ff8800;
    }
  \`}</style>
      <motion.p layout={true} data-id="btn-label" data-name="Label" style={{ fontSize: '16px', color: '#111111', position: 'relative' }}>Hello</motion.p>
      <motion.div layout={true} data-id="chip" data-name="Chip" style={{ position: 'relative', width: '60px', height: '30px', backgroundColor: '#cccccc', flex: '0 0 auto' }} />
    </motion.div>`, {
  config: HOVER_CONFIG, head: STATE_HEAD, hooks: STATE_HOOKS,
  pre: `const btnVariants = {
  default: { '--rvb-bw': '2px', '--rvb-bs': 'solid', '--rvb-bc': '#0000ff' },
  'default-hover': { '--rvb-bw': '4px', '--rvb-bs': 'solid', '--rvb-bc': '#ff0000' },
};`,
}));

test('CMP-145 overlay-border ×: primary zeroes itself, hover inherits none, a variant × is a zero-width override that Reset undoes', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(VAR_BORDER_MASTER);
  await openMaster(editor, CARD, 'default-hover');
  const width = (vp: string) => afterIn(editor, vp, 'btn', 'border-top-width');
  expect(await width('desktop')).toBe('2px');
  expect(await width('default-hover')).toBe('4px');
  expect(await width('variant-1')).toBe('2px');

  // (1) × on variant-1 (no entry) while the primary has a border → zero-width override, purple label.
  await clickIn(editor, 'variant-1', 'btn', 0.95, 0.95);
  expect(await editor.selection()).toEqual(['btn']);
  await row(page, 'Border').getByText('×', { exact: true }).click();
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'btn', 'variant-1')?.['--rvb-bw'] != null);
  expect(parseFloat(variantEntry(code, 'btn', 'variant-1')!['--rvb-bw'])).toBe(0);
  await expect.poll(() => width('variant-1')).toBe('0px');
  expect(await width('desktop')).toBe('2px');
  await expect.poll(() => isOverridden(page, 'Border')).toBe(true);
  // Reset Override brings the primary's border back.
  await labelMenu(page, 'Border', 'Reset Override');
  code = await pollCode(editor, CARD, c => variantEntry(c, 'btn', 'variant-1')?.['--rvb-bw'] == null);
  expect(variantEntry(code, 'btn', 'variant-1')?.['--rvb-bw']).toBeUndefined();
  await expect.poll(() => width('variant-1')).toBe('2px');

  // (2) × on the primary → the primary zeroes, the hover keeps its own border.
  await clickIn(editor, 'desktop', 'btn', 0.95, 0.95);
  await row(page, 'Border').getByText('×', { exact: true }).click();
  code = await pollCode(editor, CARD, c => parseFloat(parseSourceStyle(c, 'btn')['--rvb-bw'] ?? '1') === 0);
  expect(parseFloat(parseSourceStyle(code, 'btn')['--rvb-bw'])).toBe(0);
  expect(variantEntry(code, 'btn', 'default-hover')?.['--rvb-bw']).toBe('4px');
  expect(code, 'the shared ::after rule is kept').toMatch(/\[data-id="btn"\]::after\s*\{[^}]*var\(--rvb-bw\)/);
  await expect.poll(() => width('desktop')).toBe('0px');
  expect(await width('default-hover')).toBe('4px');

  // (3) × on the hover → it inherits the primary's none.
  await clickIn(editor, 'default-hover', 'btn', 0.95, 0.95);
  await row(page, 'Border').getByText('×', { exact: true }).click();
  code = await pollCode(editor, CARD, c => variantEntry(c, 'btn', 'default-hover')?.['--rvb-bw'] !== '4px');
  const hoverW = variantEntry(code, 'btn', 'default-hover')?.['--rvb-bw'];
  expect(hoverW == null || parseFloat(hoverW) === 0, `hover width now ${hoverW}`).toBe(true);
  await expect.poll(async () => parseFloat((await width('default-hover')) || '0')).toBe(0);
  await expect(row(page, 'Border').getByText('Add', { exact: true })).toBeVisible();

  // (4) A literal per-variant overlay (chip on variant-1) is removable with ×.
  expect(await afterIn(editor, 'variant-1', 'chip', 'border-top-width')).toBe('5px');
  await clickIn(editor, 'variant-1', 'chip');
  expect(await editor.selection()).toEqual(['chip']);
  await row(page, 'Border').getByText('×', { exact: true }).click();
  code = await pollCode(editor, CARD, c => !c.includes('[data-variant="variant-1"] [data-id="chip"]::after'));
  expect(code).not.toContain('[data-variant="variant-1"] [data-id="chip"]::after');
  await expect.poll(async () => parseFloat((await afterIn(editor, 'variant-1', 'chip', 'border-top-width')) || '0')).toBe(0);
  expect(parsesClean(code)).toBe(true);
});

// ─── CMP-159 · radius typed verbatim on a variant ────────────────────

const PILL_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '320px', height: '160px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="pill" data-name="Pill" variants={pillVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '200px', height: '65px', borderRadius: '12px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
    </motion.div>`, {
  pre: `const pillVariants = {
  default: { backgroundColor: '#ff2d75' },
  'variant-1': { backgroundColor: '#3355ff' },
};`,
}));

test('CMP-159 a radius typed on variant-1 is committed verbatim into its variants entry (no capsule clamp)', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(PILL_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await clickIn(editor, 'variant-1', 'pill');
  expect(await editor.selection()).toEqual(['pill']);
  await typeInRow(page, 'Radius', '95');
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'pill', 'variant-1')?.borderRadius != null);
  expect(variantEntry(code, 'pill', 'variant-1')?.borderRadius).toBe('95px');
  expect(code).not.toMatch(/borderRadius:\s*'32(\.5)?px'/);
  expect(variantEntry(code, 'pill', 'default')?.borderRadius ?? (await editor.style('pill', CARD)).borderRadius).toBe('12px');
  await expect(row(page, 'Radius').locator('input').first()).toHaveValue('95');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // One chevron step up → 96, still verbatim.
  const input = row(page, 'Radius').locator('input').first();
  await input.hover();
  await input.locator('xpath=following-sibling::div[1]//button[1]').click();
  code = await pollCode(editor, CARD, c => variantEntry(c, 'pill', 'variant-1')?.borderRadius === '96px');
  expect(variantEntry(code, 'pill', 'variant-1')?.borderRadius).toBe('96px');
  await expect.poll(() => computedIn(editor, 'variant-1', 'pill', 'border-top-left-radius')).toBe('96px');
  expect(await computedIn(editor, 'desktop', 'pill', 'border-top-left-radius')).toBe('12px');
});

// ─── CMP-160 · svg shape default entry vs attribute ──────────────────

/** The state a variant-1 recolour leaves (captured from the builder): the
 *  path became motion.path with a variants object whose default entry was
 *  seeded with the then-current blue. (Seeded rather than produced live: the
 *  builder's own recolour trips its oracle — DEFAULT_VALUE_NOT_IN_BASE reads
 *  the svg `fill` attribute as missing from the inline style.) */
const SHAPE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '200px', backgroundColor: '#f5f5f7', ...style }}>
      <motion.svg data-id="shape" data-name="Shape" viewBox="0 0 100 100" preserveAspectRatio="none" initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '100px', overflow: 'visible' }}><motion.path data-id="shape-g0" variants={shapeG0Variants} initial={['default', initialVariant]} animate={['default', initialVariant]} d="M0 0 H100 V100 H0 Z" fill="#0000ff" /></motion.svg>
    </motion.div>`, {
  pre: `const shapeG0Variants = {
  default: { fill: '#0000ff' },
  'variant-1': { fill: '#ff0000' },
};`,
}));

test('CMP-160 recolouring an svg shape on the primary updates its seeded default entry, so the primary paints it', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(SHAPE_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(await computedIn(editor, 'variant-1', 'shape-g0', 'fill')).toBe('rgb(255, 0, 0)');

  await clickIn(editor, 'desktop', 'shape');
  expect(await editor.selection()).toEqual(['shape']);
  await expect(row(page, 'Fill')).toContainText('#0000FF');
  await setFillHex(page, '#000000');

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'shape-g0', 'default')?.fill?.toLowerCase() === '#000000');
  expect(variantEntry(code, 'shape-g0', 'default')?.fill?.toLowerCase(), 'the default entry follows the attribute').toBe('#000000');
  expect(openingTag(code, 'shape-g0')).toMatch(/fill="#000000"/i);
  expect(variantEntry(code, 'shape-g0', 'variant-1')?.fill?.toLowerCase()).toBe('#ff0000');
  // The primary paints what the panel says (not: blue paint while Fill says black).
  await expect.poll(() => computedIn(editor, 'desktop', 'shape-g0', 'fill')).toBe('rgb(0, 0, 0)');
  await expect(row(page, 'Fill')).toContainText('#000000');
  expect(await computedIn(editor, 'variant-1', 'shape-g0', 'fill')).toBe('rgb(255, 0, 0)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});
