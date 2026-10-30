// CMP · Variants on breakpoints (E2E_TEST_PLAN.md §8, CMP-215…222).
//
// A page instance picks a variant PER BREAKPOINT through its `data-responsive`
// JSON (`{"768":{"initialVariant":"mobile"},"_bp":[1440,768,375]}`). The
// canvas resolves it per tile at render time (no media queries — design
// instances are expanded statically); live, `withResponsiveProps` reads the
// window width. These tests pin both sides and the seams between them: the
// write on a replica tile, live resizes, the first paint, bucketing at widths
// that are not a breakpoint, a tile-width drag and a ladder re-key.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  c7Seed, c7Page, root, inst, imp, master, PAGE, TILE, TILES, SERVER_WRAPPER,
  variantMaster, BLUE, PINK, GREEN, rgb, bgIn,
  clickIn, propRow, panel, sizeInput, cssSize, cssSizeOfNode, computedIn, tagOf, responsiveOf,
  pollCode, stableCode, traces, stableBoxIn,
  openPreview, setPreviewWidth, previewBox, selectTileRoot, vpWidthInput, clickAddBreakpoint,
} from '../../helpers/c7';
import { canvasHeader, type Tile } from '../../fixtures/project';
import { PREVIEW_MASTER_KEY_NOISE } from '../../helpers/c5';

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: TILES_VIEWPORT });

const bp = (code: string, id: string) => responsiveOf(code, id);

// ─── CMP-215 ─────────────────────────────────────────────────────────

const MOBILE_CARD = variantMaster('Card', 'card-root', [
  { name: 'default', label: 'Default', bg: BLUE },
  { name: 'mobile', label: 'Mobile', bg: PINK },
]);

test('CMP-215 Variant → "Mobile" on the Tablet tile writes a 768 entry; only Tablet paints it, accent + Reset Override, live at 768', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(inst('Card', 'card-a')), { tiles: TILES.three, imports: [imp('Card')] }), { Card: MOBILE_CARD }), { fit: true });
  const before = await editor.code(PAGE);
  await clickIn(editor, 'tablet', 'card-a');
  expect(await editor.selection()).toEqual(['card-a']);
  await propRow(page, 'Variant').locator('select').selectOption({ label: 'Mobile' });

  // Source: a per-breakpoint entry with the ladder, the base untouched.
  const code = await pollCode(editor, PAGE, c => !!bp(c, 'card-a')?.['768']);
  const json = bp(code, 'card-a')!;
  expect(json['768']).toEqual({ initialVariant: 'mobile' });
  expect([...json._bp].sort((a: number, b: number) => b - a)).toEqual([1440, 768, 375]);
  expect(json['375']).toBeUndefined();
  expect(tagOf(code, 'card-a')).not.toMatch(/initialVariant="mobile"/);

  // Tiles: only Tablet paints the Mobile variant.
  await expect.poll(() => bgIn(editor, 'tablet', 'card-a:card-root')).toBe(rgb(PINK));
  expect(await bgIn(editor, 'desktop', 'card-a:card-root')).toBe(rgb(BLUE));
  expect(await bgIn(editor, 'mobile', 'card-a:card-root')).toBe(rgb(BLUE));

  // The row is accented and offers Reset Override.
  await expect(panel(page).getByText('Variant', { exact: true }).first()).toHaveClass(/accent/);
  await panel(page).getByText('Variant', { exact: true }).first().click();
  await expect(page.getByText('Reset Override', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Live: the preview at 768 shows the Mobile variant, 1440 the base.
  const frame = await openPreview(editor, '[data-id="card-a"]');
  await setPreviewWidth(page, frame, 768);
  await expect.poll(() => frame.locator('[data-id="card-a"]').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(rgb(PINK));
  await setPreviewWidth(page, frame, 1440);
  await expect.poll(() => frame.locator('[data-id="card-a"]').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(rgb(BLUE));
});

// ─── CMP-216 ─────────────────────────────────────────────────────────

const FOOTER = variantMaster('Footer', 'footer-root', [
  { name: 'default', label: 'Desktop', bg: BLUE },
  { name: 'variant-1', label: 'Tablet', bg: PINK },
  { name: 'variant-2', label: 'Phone', bg: GREEN },
], {
  rootStyle: `display: 'flex', flexDirection: 'row', gap: '16px', width: '100%', padding: '24px'`,
  children: ['Home', 'Work', 'Contact'].map((t, i) => `<motion.p layout={true} data-id="footer-link-${i}" data-name="${t}" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '${i}' }}>${t}</motion.p>`).join('\n'),
});
const FOOTER_RESPONSIVE = `data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}'`;
const FOOTER_SEED = c7Seed(c7Page(root(inst('Footer', 'footer', `position: 'relative', width: '100%', flex: '0 0 auto'`, FOOTER_RESPONSIVE)),
  { tiles: TILES.three, imports: [imp('Footer')] }), { Footer: FOOTER });

test('CMP-216 live resizes 1440→700→375→1440 follow the buckets without remounting; canvas tiles ignore the editor window', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(FOOTER_SEED, { fit: true });
  const tiles = async () => [await bgIn(editor, 'desktop', 'footer:footer-root'), await bgIn(editor, 'tablet', 'footer:footer-root'), await bgIn(editor, 'mobile', 'footer:footer-root')];
  const expected = [rgb(BLUE), rgb(PINK), rgb(GREEN)];
  await expect.poll(tiles).toEqual(expected);

  // The editor window narrows: each tile still renders at its own width.
  await page.setViewportSize({ width: 1100, height: 900 });
  await editor.settled();
  await page.waitForTimeout(400);
  expect(await tiles()).toEqual(expected);
  expect((await cssSize(editor, 'tablet', 'root'))!.w).toBe(768);
  await page.setViewportSize(TILES_VIEWPORT);
  await editor.settled();

  const frame = await openPreview(editor, '[data-id="footer-link-2"]');
  const footer = frame.locator('[data-id="footer"]').first();
  const fill = () => footer.evaluate(el => getComputedStyle(el).backgroundColor);
  await setPreviewWidth(page, frame, 1440);
  await expect.poll(fill).toBe(rgb(BLUE));
  // Tag the live element before each crossing: a remount replaces it.
  const tag = () => frame.locator('[data-id="footer"]').first().evaluate(el => { (el as any).__c7 = 'mounted'; });
  const same = () => frame.locator('[data-id="footer"]').first().evaluate(el => (el as any).__c7 === 'mounted');

  const kept: Record<number, boolean> = {};
  for (const [w, colour] of [[700, PINK], [375, GREEN], [1440, BLUE]] as const) {
    await tag();
    await setPreviewWidth(page, frame, w);
    await expect.poll(fill, `variant at ${w}px`).toBe(rgb(colour));
    kept[w] = await same();
  }
  // Nothing stranded: every child has a real box at the end.
  for (let i = 0; i < 3; i++) {
    const b = (await previewBox(frame, `footer-link-${i}`))!;
    expect(b.w, `footer-link-${i} width`).toBeGreaterThan(0);
    expect(b.h, `footer-link-${i} height`).toBeGreaterThan(0);
  }
  // Without remounting: the element tagged at 1440 is the one still painting after each crossing.
  test.fail(true, 'BUG: every live breakpoint crossing REMOUNTS the instance — withResponsiveProps renders the matched variant copy as `<span key={c.variant}>` (runtime variant-ssr-copies, 0.0.28+), so a new bucket swaps the whole subtree (state reset, entrance animations replay) — the remount the 0.0.15 always-mounted MotionConfig fix had removed');
  expect(kept, 'the same live element survives every crossing').toEqual({ 700: true, 375: true, 1440: true });
});

// ─── CMP-217 ─────────────────────────────────────────────────────────

test('CMP-217 the first paint at 375 already shows the mobile variant (CSS-picked copies); after mount one copy remains', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  // Record, inside the preview document, what the FIRST render put in the DOM
  // (MutationObserver callbacks run before the browser paints).
  await page.addInitScript(() => {
    if (location.port !== '5175') return;
    const w = window as any;
    w.__c7First = null;
    const obs = new MutationObserver(() => {
      if (w.__c7First) return;
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-id="footer"]'));
      if (!els.length) return;
      const copies = Array.from(document.querySelectorAll<HTMLElement>('[class^="rv-v"]'));
      const shown = els.filter(e => e.getBoundingClientRect().width > 0 || getComputedStyle(e).display !== 'none')
        .filter(e => { let p: HTMLElement | null = e; while (p) { if (getComputedStyle(p).display === 'none') return false; p = p.parentElement; } return true; });
      w.__c7First = {
        total: els.length,
        copies: copies.length,
        picker: !!document.querySelector('style[data-rv-copies]'),
        shownFills: shown.map(e => getComputedStyle(e).backgroundColor),
      };
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  await editor.load(FOOTER_SEED, { fit: true });
  // Selecting on the Mobile tile makes the preview OPEN at 375 (its first render).
  await clickIn(editor, 'mobile', 'footer', { fy: 0.5 });
  const frame = await openPreview(editor, '[data-id="footer-link-2"]');
  expect(await frame.locator('body').evaluate(() => window.innerWidth)).toBe(375);

  const first = await frame.locator('body').evaluate(() => (window as any).__c7First);
  expect(first, 'the observer saw the first render').not.toBeNull();
  // Every variant was rendered as a copy, a stylesheet picked by width …
  expect(first.copies).toBe(3);
  expect(first.picker).toBe(true);
  // … and the only copy showing on that first paint is the phone variant — no desktop flash.
  expect(first.shownFills).toEqual([rgb(GREEN)]);

  // After mount: one copy, the phone one, the picker gone.
  await expect.poll(() => frame.locator('[data-id="footer"]').count()).toBe(1);
  await expect.poll(() => frame.locator('[data-id="footer"]').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(rgb(GREEN));
  expect(await frame.locator('style[data-rv-copies]').count()).toBe(0);
  expect(await frame.locator('[class^="rv-v"]').count()).toBe(0);
});

// ─── CMP-218 ─────────────────────────────────────────────────────────

const ROW_MASTER = master('Row', `
<motion.div layout={true} data-id="row-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Row" style={{ display: 'flex', flexDirection: initialVariant === 'variant-2' ? 'column' : 'row', gap: '12px', width: '300px', height: initialVariant === 'variant-2' ? '293px' : '117px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
  <motion.p layout={true} data-id="row-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Service</motion.p>
</motion.div>`, {
  config: `const variantConfig = [
  { name: 'default', label: 'Wide', x: 0, y: 0, isPrimary: true },
  { name: 'variant-2', label: 'Stacked', x: 600, y: 0 },
];`,
});

test('CMP-218 per-tile variant with a variant height sizes the instance wrapper 293/117; a later Mobile switch updates live', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(`
${inst('Row', 'row-a', `position: 'relative', flex: '0 0 auto', order: '0'`, `data-responsive='{"768":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}'`)}
${inst('Row', 'row-b', `position: 'relative', flex: '0 0 auto', order: '1'`)}`), { tiles: TILES.three, imports: [imp('Row')] }), { Row: ROW_MASTER }), { fit: true });
  // Variant-resolved wrapper height per tile — not the base 117px squished on Tablet.
  await expect.poll(async () => (await cssSize(editor, 'tablet', 'row-a'))?.h).toBe(293);
  expect((await cssSize(editor, 'desktop', 'row-a'))?.h).toBe(117);
  expect((await cssSize(editor, 'mobile', 'row-a'))?.h).toBe(117);
  // The next row starts below the tall one (no overlap).
  const a = await stableBoxIn(editor, 'tablet', 'row-a');
  const b = await stableBoxIn(editor, 'tablet', 'row-b');
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);

  // Later: variant-2 on Mobile too — the wrapper follows without a reload.
  const before = await editor.code(PAGE);
  await clickIn(editor, 'mobile', 'row-a');
  expect(await editor.selection()).toEqual(['row-a']);
  await propRow(page, 'Variant').locator('select').selectOption({ label: 'Stacked' });
  const code = await pollCode(editor, PAGE, c => !!bp(c, 'row-a')?.['375']);
  expect(bp(code, 'row-a')!['375']).toEqual({ initialVariant: 'variant-2' });
  expect(bp(code, 'row-a')!['768']).toEqual({ initialVariant: 'variant-2' });
  await expect.poll(async () => (await cssSize(editor, 'mobile', 'row-a'))?.h).toBe(293);
  expect((await cssSize(editor, 'tablet', 'row-a'))?.h).toBe(293);
  expect((await cssSize(editor, 'desktop', 'row-a'))?.h).toBe(117);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

// ─── CMP-219 ─────────────────────────────────────────────────────────

const NAV3 = variantMaster('Nav', 'nav-root', [
  { name: 'default', label: 'Desktop', bg: BLUE },
  { name: 'variant-1', label: 'Tablet', bg: PINK },
  { name: 'variant-2', label: 'Phone', bg: GREEN },
], { rootStyle: `display: 'flex', flexDirection: 'row', width: '100%', height: '64px', padding: '0px 24px'` });
const BADGE3 = variantMaster('Badge', 'badge-root', [
  { name: 'default', label: 'Base', bg: BLUE },
  { name: 'variant-1', label: 'Narrow', bg: PINK },
  { name: 'variant-2', label: 'Wide', bg: GREEN },
]);
const LAYOUT_SERVER = `import LayoutClient from './LayoutClient';

export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;
const TEMPLATE_CLIENT = `'use client';

${canvasHeader(TILES.three)}

import React from 'react';
import Nav from '@/components/Nav';

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Nav data-id="tpl-nav" data-name="Template Nav" data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' style={{ position: 'relative', width: '100%', flex: '0 0 auto', order: '0' }} />
      {children}
    </div>
  );
}
`;
const WORK = 'app/(site)/work/page.client.tsx';
const WORK_TILES: Tile[] = [
  { id: 'desktop', label: 'Desktop', width: 1277 },
  { id: 'wide', label: 'Wide', width: 1409 },
  { id: 'tablet', label: 'Tablet', width: 796 },
  { id: 'custom', label: 'Custom', width: 585 },
];

test('CMP-219 template chrome keyed 768/375 shows the 768 variant on a 585 tile; a wider replica never leaks its variant into the primary', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(c7Seed(c7Page(root(`<div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '200px', height: '100px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>`)), { Nav: NAV3, Badge: BADGE3 }, {
    'app/(site)/layout.tsx': LAYOUT_SERVER,
    'app/(site)/LayoutClient.tsx': TEMPLATE_CLIENT,
    'app/(site)/work/page.tsx': SERVER_WRAPPER,
    [WORK]: c7Page(`<div data-id="work-root" data-name="Work" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px', width: '100%', minHeight: '600px', backgroundColor: '#0d0d1a' }}>
  ${inst('Badge', 'pg-badge', `position: 'relative', flex: '0 0 auto', order: '0'`, `data-responsive='{"796":{"initialVariant":"variant-1"},"1409":{"initialVariant":"variant-2"},"_bp":[1277,1409,796,585]}'`)}
</div>`, { tiles: WORK_TILES, imports: [imp('Badge')] }),
  }));
  // Setup: open the templated page and frame its four tiles.
  await editor.openFile(WORK);
  await expect.poll(() => editor.activeFile()).toBe(WORK);
  await editor.sandbox().locator('[data-node-id^="custom-"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();

  // Template chrome: smallest breakpoint ≥ 585 is 768 → its variant; 796 and up → base.
  const navFill = (vp: string) => editor.sandbox().locator(`[data-node-id="${vp === 'desktop' ? '' : vp + '-'}layout::tpl-nav:nav-root"]`).first()
    .evaluate(el => getComputedStyle(el).backgroundColor).catch(() => '');
  await expect.poll(() => navFill('custom')).toBe(rgb(PINK));
  expect(await navFill('desktop')).toBe(rgb(BLUE));
  expect(await navFill('tablet')).toBe(rgb(BLUE));
  expect(await navFill('wide')).toBe(rgb(BLUE));

  // Page instance with a replica WIDER than the primary: the primary shows the base.
  await expect.poll(() => bgIn(editor, 'wide', 'pg-badge:badge-root')).toBe(rgb(GREEN));
  expect(await bgIn(editor, 'desktop', 'pg-badge:badge-root'), 'primary 1277 = base, not the 1409 variant').toBe(rgb(BLUE));
  expect(await bgIn(editor, 'tablet', 'pg-badge:badge-root')).toBe(rgb(PINK));
  expect(await bgIn(editor, 'custom', 'pg-badge:badge-root'), '585 is its own bucket, no override').toBe(rgb(BLUE));
});

// ─── CMP-220 ─────────────────────────────────────────────────────────

const CARD3 = variantMaster('Card', 'card-root', [
  { name: 'default', label: 'Default', bg: BLUE },
  { name: 'variant-1', label: 'Tablet', bg: PINK },
  { name: 'variant-2', label: 'Phone', bg: GREEN },
]);
/** A 600px tile added after the overrides were written: it is not in the
 *  instance's `_bp`, so it shows the 768 bucket's variant until it grows past 768. */
const DRAG_TILES: Tile[] = [TILE.desktop, TILE.tablet, { id: 'custom', label: 'Custom', width: 600 }];

test('CMP-220 dragging a tile width across 768 flips the 768-keyed instance variant live, before mouse-up; the commit writes the config width', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(inst('Card', 'card-a', `position: 'relative', flex: '0 0 auto'`, `data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768]}'`)),
    { tiles: DRAG_TILES, imports: [imp('Card')] }), { Card: CARD3 }), { fit: true });
  const before = await editor.code(PAGE);
  const fillOn = (vp: string) => bgIn(editor, vp, 'card-a:card-root');
  await expect.poll(() => fillOn('custom')).toBe(rgb(PINK)); // 600 → the 768 bucket
  expect(await fillOn('tablet')).toBe(rgb(PINK));
  expect(await fillOn('desktop')).toBe(rgb(BLUE));

  // Select the Custom tile's viewport root (its header label) and drag its right edge.
  await selectTileRoot(editor, 'custom');
  expect(await editor.selection()).toEqual(['root']);
  const tile = await stableBoxIn(editor, 'custom', 'root');
  const scale = tile.width / 600;
  const edge = page.locator('[data-resize-edge="right"]').first();
  await edge.waitFor({ state: 'attached' });
  await page.waitForTimeout(650);
  const eb = (await edge.boundingBox())!;
  const from = { x: eb.x + eb.width / 2, y: eb.y + eb.height * 0.3 };
  const dx = Math.round(220 * scale); // ≈ +220 canvas px → ~820
  const since = (await traces(editor, 'resize:viewport-band-crossing-rerender')).length;
  let midFill = '';
  let midWidth = 0;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(from.x + (dx * i) / 24, from.y);
      await page.waitForTimeout(30);
    }
    // Mid-drag, past 768: read what the tile paints with the button still down.
    midWidth = (await cssSize(editor, 'custom', 'root'))!.w;
    const deadline = Date.now() + 2_000;
    do { midFill = await fillOn('custom'); } while (midFill !== rgb(BLUE) && Date.now() < deadline);
  } finally {
    await page.mouse.up();
  }
  await editor.settled();
  expect(midWidth).toBeGreaterThan(768);
  expect((await traces(editor, 'resize:viewport-band-crossing-rerender')).length, 'a band-crossing re-render ran').toBeGreaterThan(since);

  // Commit: @canvas holds the width the tile was dropped at, and the tile paints at it.
  const code = await stableCode(editor, PAGE);
  const width = JSON.parse(code.match(/@canvas\s*(\{[\s\S]*?\})\s*\*\//)![1]).viewports.find((v: any) => v.id === 'custom').width;
  expect(width).toBeGreaterThan(768);
  expect(Math.abs(width - midWidth)).toBeLessThanOrEqual(1);
  expect((await cssSize(editor, 'custom', 'root'))!.w).toBe(width);
  expect(bp(code, 'card-a')!['768']).toEqual({ initialVariant: 'variant-1' });
  await expect.poll(() => fillOn('custom')).toBe(rgb(BLUE));
  expect(await fillOn('tablet')).toBe(rgb(PINK));
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // The flip happened LIVE, with the button down — not only on mouse-up.
  test.fail(true, "BUG: the tile-drag band-crossing re-render runs (trace resize:viewport-band-crossing-rerender at the live width) but the sandbox renderer still resolves the instance variant at the tile's CONFIG width (renderer:resolve-variant vpWidth 600 while the tile is 821 wide) — the variant only flips on mouse-up");
  expect(midFill, 'variant painted mid-drag past 768').toBe(rgb(BLUE));
});

// ─── CMP-221 ─────────────────────────────────────────────────────────

test('CMP-221 re-keying the ladder (tablet 768 → 800, add 1024) keeps every per-tile override; _bp is never empty', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c7Seed(c7Page(root(inst('Card', 'card-a', `position: 'relative', flex: '0 0 auto'`, `data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}'`)),
    { tiles: TILES.three, imports: [imp('Card')] }), { Card: CARD3 }), { fit: true });
  const look = async () => Object.fromEntries(await Promise.all(['desktop', 'tablet', 'mobile'].map(async vp => [vp, await bgIn(editor, vp, 'card-a:card-root')])));
  await expect.poll(look).toEqual({ desktop: rgb(BLUE), tablet: rgb(PINK), mobile: rgb(GREEN) });
  const before = await editor.code(PAGE);

  // Move tablet's breakpoint: the viewport Width field on the Tablet root.
  await selectTileRoot(editor, 'tablet');
  expect(await editor.selection()).toEqual(['root']);
  const w = vpWidthInput(page);
  await expect(w).toHaveValue(/^768/);
  await w.click();
  await w.press('ControlOrMeta+a');
  await w.fill('800');
  await w.press('Enter');
  let code = await pollCode(editor, PAGE, c => !!bp(c, 'card-a')?.['800']);
  let json = bp(code, 'card-a')!;
  expect(json['800']).toEqual({ initialVariant: 'variant-1' });
  expect(json['375']).toEqual({ initialVariant: 'variant-2' });
  expect(json['768']).toBeUndefined();
  expect(json._bp.length).toBeGreaterThan(0);
  expect(json._bp).toContain(800);
  await expect.poll(look).toEqual({ desktop: rgb(BLUE), tablet: rgb(PINK), mobile: rgb(GREEN) });
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Add a 1024 breakpoint from the tile header's "+" menu.
  await page.keyboard.press('Escape');
  await editor.blur();
  const beforeAdd = await stableCode(editor, PAGE);
  await clickAddBreakpoint(editor, 'desktop');
  await page.getByText('iPad Pro 12.9"', { exact: true }).first().click();
  code = await pollCode(editor, PAGE, c => /"width":\s*1024/.test(c));
  await editor.settled();
  code = await stableCode(editor, PAGE);
  json = bp(code, 'card-a')!;
  expect(json._bp.length, '_bp is never written empty').toBeGreaterThan(0);
  expect([...json._bp].sort((a: number, b: number) => b - a)).toEqual([1440, 1024, 800, 375]);
  expect(json['800']).toEqual({ initialVariant: 'variant-1' });
  expect(json['375']).toEqual({ initialVariant: 'variant-2' });
  expect(code).not.toMatch(/"_bp":\[\]/);
  // Every tile looks as before; the new 1024 tile shows the base.
  await expect.poll(look).toEqual({ desktop: rgb(BLUE), tablet: rgb(PINK), mobile: rgb(GREEN) });
  const added = JSON.parse(code.match(/@canvas\s*(\{[\s\S]*?\})\s*\*\//)![1]).viewports.find((v: any) => v.width === 1024).id;
  await editor.fitCamera();
  await expect.poll(() => bgIn(editor, added, 'card-a:card-root')).toBe(rgb(BLUE));
  await expect(editor).toUndoInOneStep(beforeAdd, { path: PAGE });
});

// ─── CMP-222 ─────────────────────────────────────────────────────────

const PILL_BTN = master('Button', `
<motion.div layout={true} data-id="btn-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 24px', backgroundColor: '#ff2d75', borderRadius: '999px', ...style }}>
  <motion.p layout={true} data-id="btn-label" data-name="Label" style={{ position: 'relative', fontSize: '16px', lineHeight: '20px', color: '#ffffff', margin: '0px', flex: '0 0 auto' }}>Get started</motion.p>
</motion.div>`);

const APPEAR_PAGE = `${canvasHeader(TILES.three)}
'use client';
import React, { useEffect, useRef } from 'react';
import { useInView, useMotionValue, useTransform, animate } from 'framer-motion';
import Button from '@/components/Button';

export default function Page() {
  const btnRef = useRef(null);
  const btnInView = useInView(btnRef, { once: true });
  const btnAppear = useMotionValue(0);
  useEffect(() => { if (btnInView) { const _c = animate(btnAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [btnInView]);
  const btnYA = useTransform(btnAppear, [0, 1], [30, 0]);
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
      <style>{\`
    @media (max-width: 375px) {
      [data-id="btn"] { width: 100% !important; }
    }
  \`}</style>
      <Button data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"30"},"once":true,"transition":{"type":"spring","duration":"0.5","bounce":"0.25"}}}' ref={btnRef} data-id="btn" data-name="Button" style={{ position: 'relative', flex: '0 0 auto', order: '0', opacity: btnAppear, y: btnYA }} />
    </div>
  );
}
`;

test('CMP-222 an Appear (MotionValue) instance with a Mobile Width 100% fills its container live at 375 like the canvas; unchanged at 1440', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_MASTER_KEY_NOISE);
  await editor.load(c7Seed(APPEAR_PAGE, { Button: PILL_BTN }), { fit: true });
  // Canvas: Mobile fills (375 − 2×40 padding), Desktop hugs the pill.
  await expect.poll(async () => (await cssSize(editor, 'mobile', 'btn'))?.w).toBe(295);
  const pillW = (await cssSize(editor, 'desktop', 'btn'))!.w;
  expect(pillW).toBeLessThan(250);

  const frame = await openPreview(editor, '[data-id="btn"]');
  await setPreviewWidth(page, frame, 375);
  // Both runtime boxes (the animated-style wrapper and the root) carry the data-id.
  await expect.poll(() => frame.locator('[data-id="btn"]').count()).toBe(2);
  // The OUTER box fills its container at 375 — not pill-sized while the canvas shows full width.
  await expect.poll(async () => (await previewBox(frame, 'btn', 0))?.w).toBe(295);
  expect((await previewBox(frame, 'btn', 1))!.w).toBe(295);
  await setPreviewWidth(page, frame, 1440);
  await expect.poll(async () => Math.abs(((await previewBox(frame, 'btn', 0))?.w ?? 0) - pillW)).toBeLessThan(1);
  expect(await frame.locator('[data-id="btn"]').count()).toBe(2);
});
