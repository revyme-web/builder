// CMP · Per-variant writes that must keep the master's code sound: self-closing
// motionify, module-scope canvas nodes, per-variant variables, CSS-initial
// default seeds, root perf isolation and overlays in an isolated root
// (E2E_TEST_PLAN.md §8, batch C5). Tiles: `desktop` = primary/default variant.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  masterSeed, masterModule, openMaster, clickIn, panel, row, label, topPopup, closePopup, setFillHex, openFill,
  stableCode, pollCode, variantEntry, variantsOf, variantsIdent, openingTag, tagOf, parsesClean, computedIn, boxIn,
  resizeBy, menuTexts, openPreview, setPreviewWidth, showFile, astOf, walk, CONFIG_2V,
  PAGE_HEADER, PREVIEW_NOISE, PREVIEW_MASTER_KEY_NOISE,
} from '../../helpers/c5';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const CARD = 'components/Card.tsx';
const PAGE = 'app/page.client.tsx';

const pageWith = (jsx: string, imports = `import Card from '@/components/Card';`, rootStyle = `display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px'`) => `${PAGE_HEADER}
'use client';
${imports}
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ ${rootStyle}, width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a' }}>
      ${jsx}
    </div>
  );
}
`;

// ─── CMP-146 · self-closing div inside a same-tag parent ─────────────

const IMG = 'https://images.unsplash.com/photo-1545897398-2aba891843b6?w=200';
const AVATAR_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', width: '300px', height: '220px', backgroundColor: '#111827', ...style }}>
      <div data-id="avatar-wrap" data-name="AvatarWrap" style={{ position: 'relative', display: 'flex', gap: '8px', width: '100%', height: '100px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <div data-id="avatar" data-name="Avatar" style={{ position: 'relative', width: '80px', height: '80px', backgroundImage: 'url(${IMG})', backgroundSize: 'cover', backgroundPosition: 'center', flex: '0 0 auto' }} />
        <div data-id="avatar-side" data-name="Side" style={{ position: 'relative', width: '40px', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto' }}></div>
      </div>
    </motion.div>`));

test('CMP-146 an image-fill change on a self-closing div makes only it a motion.div; the same-tag parent keeps its </div>', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(AVATAR_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await clickIn(editor, 'variant-1', 'avatar');
  expect(await editor.selection()).toEqual(['avatar']);
  await row(page, 'Fill').locator('button:not(:has(span[title]))').first().click();
  const pop = topPopup(page);
  await pop.locator('div:has(> span[title="Size"]) select').first().selectOption('contain');
  await closePopup(page);

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'avatar', 'variant-1')?.backgroundSize === 'contain');
  expect(parsesClean(code), 'the file parses').toBe(true);
  expect(tagOf(code, 'avatar')).toBe('motion.div');
  expect(variantEntry(code, 'avatar', 'variant-1')?.backgroundSize).toBe('contain');
  expect(variantEntry(code, 'avatar', 'default')?.backgroundSize).toBe('cover');
  // Only the avatar was motionified: the parent and the sibling stay plain divs.
  expect(tagOf(code, 'avatar-wrap')).toBe('div');
  expect(tagOf(code, 'avatar-side')).toBe('div');
  expect(code.match(/<\/motion\.div>/g)?.length, 'only the root closes as motion.div').toBe(1);
  expect(openingTag(code, 'avatar')).toMatch(/\/>$/);
  await expect.poll(() => computedIn(editor, 'variant-1', 'avatar', 'background-size')).toBe('contain');
  expect(await computedIn(editor, 'desktop', 'avatar', 'background-size')).toBe('cover');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-147 · module-scope canvas node on a master ──────────────────

const CANVAS_NODE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '300px', height: '200px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="card-chip" data-name="Chip" style={{ position: 'absolute', left: '20px', top: '20px', width: '60px', height: '60px', backgroundColor: '#ff2d75' }} />
    </motion.div>`, {
  post: `
const canvasNodes = (<>
  <div data-id="loose" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '320px', width: '160px', height: '90px', backgroundColor: '#7c5cff' }}></div>
</>);
`,
}));

test('CMP-147 a free canvas node on a master takes plain inline styles while a variant tile is active', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(CANVAS_NODE_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // Make variant-1 the active tile, then pick the free canvas node.
  await clickIn(editor, 'variant-1', 'card-chip');
  expect(await editor.selection()).toEqual(['card-chip']);
  const loose = editor.sandbox().locator('[data-id="loose"]:not([data-viewport] [data-id])').first();
  const lb = (await loose.boundingBox())!;
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await editor.settled();
  expect(await editor.selection()).toEqual(['loose']);

  // Fill.
  await setFillHex(page, '#00ff00');
  let code = await pollCode(editor, CARD, c => /data-id="loose"[^>]*#00ff00/i.test(c));
  expect((await editor.style('loose', CARD)).backgroundColor?.toLowerCase()).toBe('#00ff00');
  expect(openingTag(code, 'loose')).not.toMatch(/initialVariant|variants=|initial=|animate=/);
  expect(variantsOf(code, 'loose')).toBeNull();
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Resize with the right-edge handle: the new width commits and stays.
  const afterFill = await stableCode(editor, CARD);
  const w0 = (await loose.boundingBox())!.width;
  await resizeBy(editor, { edge: 'right' }, 50, 0);
  code = await pollCode(editor, CARD, c => (parseFloat((/data-id="loose"[^>]*width: '([\d.]+)px'/.exec(c) ?? [])[1] ?? '160')) > 165);
  const w = parseFloat((await editor.style('loose', CARD)).width);
  expect(w, 'the resize committed').toBeGreaterThan(165);
  expect(openingTag(code, 'loose')).not.toMatch(/initialVariant/);
  expect(parsesClean(code)).toBe(true);
  await page.waitForTimeout(600);
  // Not: the resize reverting.
  expect(parseFloat((await editor.style('loose', CARD)).width)).toBe(w);
  expect((await loose.boundingBox())!.width).toBeGreaterThan(w0 + 20);
  // No blocked-write message.
  expect((await page.evaluate(() => (window as any).__e2e.traceEntries('error|validate|blocked') ?? []))
    .map((t: any) => JSON.stringify(t.data)).join('\n')).not.toMatch(/undefined identifier: initialVariant/);
  await expect(editor).toUndoInOneStep(afterFill, { path: CARD });
});

// ─── CMP-148 · per-variant variable binding ──────────────────────────

const VAR_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', width: '300px', height: '200px', backgroundColor: colorA, ...style }}>
      <motion.div layout={true} data-id="chip" data-name="Chip" style={{ position: 'relative', width: '60px', height: '30px', backgroundColor: colorB, flex: '0 0 auto' }} />
    </motion.div>`, {
  head: `'use client';

/** @name "Card" */
/** @propMeta {"colorA":{"type":"color","label":"Color A"},"colorB":{"type":"color","label":"Color B"}} */

import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`,
  pre: `const cardRootVariants = {
  default: { opacity: 1 },
  'variant-1': { opacity: 1 },
};`,
  sig: `{ style, initialVariant = 'default', colorA = '#ff0000', colorB = '#0000ff', ...rest }: { style?: React.CSSProperties; initialVariant?: string; colorA?: string; colorB?: string; [key: string]: any }`,
}), {}, pageWith(`<Card data-id="card-a" data-name="Card" initialVariant="default" style={{ position: 'relative', flex: '0 0 auto' }} />
      <Card data-id="card-b" data-name="Card" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto' }} />`));

/** Is the `const <name>` declared inside the component function (not at module scope)? */
function constInsideFunction(code: string, name: string): boolean {
  const ast = astOf(code);
  let inside = false;
  walk(ast, (n) => {
    if (n.type !== 'FunctionDeclaration' || n.id?.name !== 'Card') return;
    walk(n.body, (m) => { if (m.type === 'VariableDeclarator' && m.id?.name === name) inside = true; });
  });
  return inside;
}

test('CMP-148 binding colorB on variant-1 writes it into the variant entry and seeds the default with colorA', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(VAR_MASTER);
  await openMaster(editor);

  await clickIn(editor, 'variant-1', 'card-root', 0.5, 0.95);
  expect(await editor.selection()).toEqual(['card-root']);
  // The variant inherits Color A: detach it on this variant, then bind Color B.
  await label(page, 'Fill').click();
  await page.getByText('Remove Variable', { exact: true }).click();
  const detached = await pollCode(editor, CARD, c => variantEntry(c, 'card-root', 'variant-1')?.backgroundColor != null);
  const before = await stableCode(editor, CARD);
  expect(variantEntry(detached, 'card-root', 'variant-1')?.backgroundColor).toBe('#ff0000');
  await label(page, 'Fill').click();
  await page.getByText('Set Variable', { exact: true }).hover();
  await page.getByText('Color B', { exact: true }).last().click();

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'card-root', 'variant-1')?.backgroundColor === 'colorB');
  expect(variantEntry(code, 'card-root', 'variant-1')?.backgroundColor).toBe('colorB');
  // The default entry reads colorA (not a CSS initial).
  expect(variantEntry(code, 'card-root', 'default')?.backgroundColor).toBe('colorA');
  expect(code).not.toMatch(/backgroundColor:\s*'rgba\(0, 0, 0, 0\)'/);
  expect(variantsIdent(code, 'card-root')).toBe('cardRootVariants');
  expect(constInsideFunction(code, 'cardRootVariants'), 'the variants object moved inside the component').toBe(true);
  expect(parsesClean(code)).toBe(true);
  await expect.poll(() => computedIn(editor, 'variant-1', 'card-root', 'background-color')).toBe('rgb(0, 0, 255)');
  expect(await computedIn(editor, 'desktop', 'card-root', 'background-color')).toBe('rgb(255, 0, 0)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Preview: the default instance shows Color A, the variant-1 instance Color B.
  await showFile(editor, PAGE);
  const frame = await openPreview(page, '[data-id="card-b"]');
  await expect.poll(() => frame.locator('[data-id="card-a"]').first().evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 15_000 }).toBe('rgb(255, 0, 0)');
  await expect.poll(() => frame.locator('[data-id="card-b"]').first().evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 15_000 }).toBe('rgb(0, 0, 255)');
});

// ─── CMP-149 · CSS-initial default seeds ─────────────────────────────

const V4_CONFIG = `const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-4', label: 'Mobile', x: 600, y: 0 },
];`;
const INITIALS_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '12px', padding: '20px', width: '480px', height: '120px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="frame" data-name="Frame" variants={frameVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '80px', height: '60px', backgroundColor: '#ff2d75' }} />
      <motion.div layout={true} data-id="side" data-name="Side" variants={sideVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '80px', height: '60px', backgroundColor: '#33cc88', flex: '0 0 auto' }} />
    </motion.div>`, {
  config: V4_CONFIG,
  pre: `const frameVariants = {
  default: {},
  'variant-4': { flex: '1 0 0px', pointerEvents: 'none', display: 'flex', color: '#ff0000' },
};
const sideVariants = {
  default: {},
  'variant-4': { opacity: 0.5 },
};`,
}), {}, pageWith(`<Card data-id="card-r" data-name="Card" initialVariant="default" data-responsive='{"375":{"initialVariant":"variant-4"},"_bp":[1440,375]}' style={{ position: 'relative', flex: '0 0 auto' }} />`));

test('CMP-149 any edit heals a sparse default entry with CSS initials; desktop is clean after a 1440→375→1440 crossing', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(INITIALS_MASTER);
  await openMaster(editor, CARD, 'variant-4');
  const before = await editor.code(CARD);

  // Edit anything (the root Fill on the primary).
  await clickIn(editor, 'desktop', 'card-root', 0.97, 0.5);
  expect(await editor.selection()).toEqual(['card-root']);
  await setFillHex(page, '#222244');
  const code = await pollCode(editor, CARD, c => variantEntry(c, 'frame', 'default')?.flex != null);
  const def = variantEntry(code, 'frame', 'default')!;
  expect(def.flex).toBe('0 1 auto');
  expect(def.pointerEvents).toBe('auto');
  // Never display or inherited text props.
  expect(def.display).toBeUndefined();
  expect(def.color).toBeUndefined();
  expect(variantEntry(code, 'side', 'default')?.opacity).toBe('1');
  expect(variantEntry(code, 'frame', 'variant-4')).toMatchObject({ flex: '1 0 0px', pointerEvents: 'none' });
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Preview the page across the breakpoint and back.
  await showFile(editor, PAGE);
  const frame = await openPreview(page, '[data-id="card-r"]');
  const f = frame.locator('[data-id="frame"]').first();
  await setPreviewWidth(page, frame, 1440);
  await expect.poll(() => f.evaluate(el => getComputedStyle(el).flexGrow)).toBe('0');
  await setPreviewWidth(page, frame, 375);
  await expect.poll(() => f.evaluate(el => getComputedStyle(el).pointerEvents), { timeout: 10_000 }).toBe('none');
  expect(await f.evaluate(el => getComputedStyle(el).flexGrow)).toBe('1');
  await setPreviewWidth(page, frame, 1440);
  // Not: sticky variant residue on desktop.
  await expect.poll(() => f.evaluate(el => getComputedStyle(el).pointerEvents), { timeout: 10_000 }).toBe('auto');
  await expect.poll(() => f.evaluate(el => `${getComputedStyle(el).flexGrow} ${getComputedStyle(el).flexShrink} ${getComputedStyle(el).flexBasis}`)).toBe('0 1 auto');
});

// ─── CMP-150 · root perf isolation ───────────────────────────────────

const PERF_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '300px', height: '200px', overflow: 'visible', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="knob" data-name="Knob" variants={knobVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '20px', top: '20px', width: '60px', height: '60px', backgroundColor: '#ff2d75' }} />
      <motion.div data-id="stray" data-name="Stray" style={{ contain: 'layout paint', willChange: 'transform', position: 'absolute', left: '120px', top: '20px', width: '60px', height: '60px', backgroundColor: '#33cc88' }} />
      <motion.div data-id="hang" data-name="Hang" style={{ position: 'absolute', left: '-40px', top: '120px', width: '80px', height: '40px', backgroundColor: '#ffcc33' }} />
    </motion.div>`, {
  pre: `const knobVariants = {
  default: { left: '20px', width: '60px' },
  'variant-1': { left: '200px', width: '80px' },
};`,
}), {
  'components/Badge.tsx': masterModule(`
    <motion.div layout={true} data-id="badge-root" data-name="Badge" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '200px', height: '120px', overflow: 'hidden', backgroundColor: '#222244', ...style }}>
      <motion.div data-id="badge-dot" data-name="Dot" variants={badgeDotVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '10px', top: '10px', width: '40px', height: '40px', backgroundColor: '#ff8800' }} />
    </motion.div>`, {
    name: 'Badge',
    pre: `const badgeDotVariants = {
  default: { backgroundColor: '#ff8800' },
  'variant-1': { backgroundColor: '#3355ff' },
};`,
  }),
});

test('CMP-150 heavy variant tweens isolate the ROOT (layout, or layout paint when it clips); children never carry the pair', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(PERF_MASTER);

  // Load heal: the stray pair comes off the child; the visible root gets layout-only containment.
  let code = await editor.code(CARD);
  expect((await editor.style('card-root', CARD)).contain).toBe('layout');
  expect((await editor.style('card-root', CARD)).willChange).toBe('transform');
  expect((await editor.style('stray', CARD)).contain, 'children never carry the pair').toBeUndefined();
  expect((await editor.style('stray', CARD)).willChange).toBeUndefined();
  expect((await editor.style('knob', CARD)).contain).toBeUndefined();

  // Nothing hanging outside the visible root is clipped.
  await openMaster(editor);
  const root = (await boxIn(editor, 'desktop', 'card-root'))!;
  const hang = (await boxIn(editor, 'desktop', 'hang'))!;
  expect(hang.x).toBeLessThan(root.x);
  const hit = await (await editor.nodeIn('desktop', 'hang')).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const p = { x: r.x + 4, y: r.y + r.height / 2 };
    return document.elementFromPoint(p.x, p.y)?.getAttribute('data-id') ?? null;
  });
  expect(hit, 'the part of Hang outside the root still paints').toBe('hang');
  expect(await computedIn(editor, 'desktop', 'card-root', 'contain')).toBe('layout');

  // A heavy-variant write on the clipping Badge root isolates it with paint containment.
  code = await editor.code('components/Badge.tsx');
  expect((await editor.style('badge-root', 'components/Badge.tsx')).contain).toBeUndefined();
  await openMaster(editor, 'components/Badge.tsx');
  await clickIn(editor, 'variant-1', 'badge-dot');
  expect(await editor.selection()).toEqual(['badge-dot']);
  // The pin block's first field is Top (after the position-type select); top is a heavy prop too.
  const left = panel(page).locator('select:has(option[value="sticky"])').first().locator('xpath=following::input[1]');
  await expect(left).toHaveValue('10');
  await left.click();
  await left.press('ControlOrMeta+a');
  await left.fill('40');
  await left.press('Enter');
  code = await pollCode(editor, 'components/Badge.tsx', c => /contain:\s*'layout paint'/.test(c));
  expect((await editor.style('badge-root', 'components/Badge.tsx')).contain).toBe('layout paint');
  expect((await editor.style('badge-root', 'components/Badge.tsx')).willChange).toBe('transform');
  expect((await editor.style('badge-dot', 'components/Badge.tsx')).contain).toBeUndefined();
  expect(parsesClean(code)).toBe(true);
});

// ─── CMP-151 · a dropdown in a perf-isolated Header ──────────────────

const HEADER_MASTER = masterSeed('Header', masterModule(`
    <motion.div layout={true} data-id="hdr" data-name="Header" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-variant={initialVariant} style={{ contain: 'layout paint', willChange: 'transform', position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', padding: '16px', width: '600px', height: '80px', overflow: 'hidden', backgroundColor: '#111827', ...style }}>
      <style>{\`
    [data-variant="default"] [data-overlay] { outline: 3px solid rgb(255, 0, 0); }
    [data-variant]:hover [data-overlay] { outline-offset: 7px; }
  \`}</style>
      <motion.div layout={true} data-id="menu-btn" data-name="Menu" style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '0' }} />
      <motion.div data-id="slider" data-name="Slider" variants={sliderVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '400px', top: '20px', width: '40px', height: '40px', backgroundColor: '#33cc88' }} />
    </motion.div>`, {
  name: 'Header',
  pre: `const sliderVariants = {
  default: { left: '400px' },
  'variant-1': { left: '500px' },
};`,
}), {}, pageWith(`<Header data-id="hdr-inst" data-name="Header" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import Header from '@/components/Header';`));

test('CMP-151 a dropdown in a perf-isolated Header paints in the top layer in preview, unclipped, with ancestor selectors intact', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  const HDR = 'components/Header.tsx';
  editor.allowErrors(PREVIEW_NOISE);
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(HEADER_MASTER);
  await openMaster(editor, HDR);
  expect((await editor.style('hdr', HDR)).contain, 'the root is perf-isolated').toBe('layout paint');

  // Setup: the builder's own dropdown on the menu button.
  await clickIn(editor, 'desktop', 'menu-btn');
  expect(await editor.selection()).toEqual(['menu-btn']);
  await panel(page).locator('button[title="Add dropdown"]').click();
  const code = await pollCode(editor, HDR, c => /data-overlay='/.test(c) && /showPopover/.test(c));
  const ovId = /data-id="(overlay-[^"]+)"[^>]*data-overlay=/.exec(code)?.[1] ?? 'overlay-menu-btn-1';
  await stableCode(editor, HDR);

  // Preview the page and open the dropdown.
  await showFile(editor, PAGE);
  const frame = await openPreview(page, '[data-id="menu-btn"]');
  await frame.locator('[data-id="menu-btn"]').first().click();
  const ov = frame.locator(`[data-id="${ovId}"]`).first();
  await ov.waitFor({ state: 'attached', timeout: 10_000 });
  // In the top layer (Popover API), not clipped by the isolated header box.
  await expect.poll(() => ov.evaluate(el => el.matches(':popover-open')), { timeout: 10_000 }).toBe(true);
  const facts = await ov.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hdr = el.closest('[data-variant]')!.getBoundingClientRect();
    const p = { x: r.x + r.width / 2, y: r.y + r.height - 6 };
    const hit = document.elementFromPoint(p.x, p.y);
    return { top: r.top, bottom: r.bottom, hdrBottom: hdr.bottom, hitIsOverlay: !!hit && (hit === el || el.contains(hit)), outline: getComputedStyle(el).outlineColor };
  });
  expect(facts.bottom, 'the dropdown hangs below the header box').toBeGreaterThan(facts.hdrBottom + 20);
  expect(facts.hitIsOverlay, 'the part below the header paints (not clipped)').toBe(true);
  // Ancestor selectors still reach it (it stays in the DOM under the root).
  expect(facts.outline, '[data-variant] selector').toBe('rgb(255, 0, 0)');
  const ob = (await ov.boundingBox())!;
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await expect.poll(() => ov.evaluate(el => getComputedStyle(el).outlineOffset), { message: 'ancestor :hover selector' }).toBe('7px');
});
