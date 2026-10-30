// CMP · The default variant and canvas expansion (E2E_TEST_PLAN.md §8,
// CMP-223…227): what a page instance paints comes from base ⊕ default entry
// ⊕ chosen variant — the same stack live renders — and a master edit
// re-expands every instance without leaking one instance's props into another.

import { test, expect, project, canvasHeader, TILE, TILES_VIEWPORT } from '../../fixtures/test';
import {
  CARD, PAGE, enterByDoubleClick, waitForActiveFile, breadcrumbSegment, paintedById, textById, panel, row, setFillHex,
  SUBMIT_SEED, BUTTON4_SEED, SYNCED_WIDTH_MASTER, CARD_MASTER, oneInstanceSeed, twentyCardsSeed, pageClient, pageRoot, inst,
} from '../../helpers/c2';
import { exitToPage } from '../../helpers/c1';
import { openPreview, typeInRow } from '../../helpers/c3';
import { variantEntry, styleTernary, stableCode } from '../../helpers/d6';

const PREVIEW_NOISE = /unique "key" prop/;
const BLUE = 'rgb(59, 130, 246)';
const GREEN = 'rgb(0, 170, 102)';
const PINK = 'rgb(255, 45, 117)';

test('CMP-223 a fill that lives only in the default entry paints on the canvas for a state-driven and a variant-1 instance, matching preview', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(SUBMIT_SEED);
  // Canvas: the default entry (blue) — not the native button grey.
  await expect.poll(() => paintedById(editor, 'submit-a:submit-root', 'background-color')).toBe(BLUE);
  expect(await paintedById(editor, 'submit-a:submit-root', 'opacity')).toBe('1');
  // default ⊕ variant-1 for the plain non-default instance.
  await expect.poll(() => paintedById(editor, 'submit-b:submit-root', 'background-color')).toBe(BLUE);
  await expect.poll(() => paintedById(editor, 'submit-b:submit-root', 'opacity')).toBe('0.6');

  const frame = await openPreview(page, '[data-id="submit-b"]');
  const live = (id: string, prop: 'backgroundColor' | 'opacity') => frame.locator(`[data-id="${id}"]`).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
  await expect.poll(() => live('submit-a', 'backgroundColor')).toBe(BLUE);
  await expect.poll(() => live('submit-b', 'backgroundColor')).toBe(BLUE);
  await expect.poll(() => live('submit-b', 'opacity')).toBe('0.6');
});

test('CMP-224 a page instance and a nested instance pinned to variant-3 both paint the variant-3 text and fill', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(BUTTON4_SEED);
  await expect.poll(() => textById(editor, 'btn-a:btn-text')).toBe('REACH OUT');
  await expect.poll(() => paintedById(editor, 'btn-a:btn-root', 'background-color')).toBe(GREEN);

  await enterByDoubleClick(editor, 'hdr-a', 'components/Header.tsx');
  await expect.poll(() => textById(editor, 'hdr-btn:btn-text')).toBe('REACH OUT');
  await expect.poll(() => paintedById(editor, 'hdr-btn:btn-root', 'background-color')).toBe(GREEN);
});

test('CMP-225 a primary edit of a value also in the default entry keeps both in sync, no default ternary, no purple override', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: a primary width edit wipes variant-1\'s own width — setConditionalStyleInCode (src/code/generation/generator-styles.ts:3741) builds its branch map from the inline ternary only, then strips `width` from EVERY variants entry, so `variant-1: { width: \'200px\' }` is dropped and the Narrow tile repaints at 360px');
  await editor.load(oneInstanceSeed('Card', 'card-a', SYNCED_WIDTH_MASTER));
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  const before = await stableCode(editor, CARD);
  const v1Before = await editor.nodeBoxIn('variant-1', 'card-root');
  const zoom = v1Before.width / 200;

  const input = row(page, 'Width').locator('input').first();
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill('360');
  await input.press('Enter');

  await expect(editor).toHaveStyle('card-root', 'width', '360px', { path: CARD });
  const code = await editor.code(CARD);
  // The default entry never disagrees with the base (mirrors it or drops it).
  expect([undefined, '360px']).toContain(variantEntry(code, 'card-root', 'default')?.width);
  // Not: a `variant === 'default' ? …` branch.
  expect(styleTernary(code, 'card-root', 'width')?.branches.default).toBe('360px');
  expect(code).not.toMatch(/===\s*'default'\s*\?/);
  // The panel shows no override accent on the primary.
  const label = panel(page).locator('span[title="Width"]').first();
  expect(await label.evaluate(el => el.classList.contains('text-[var(--accent-secondary)]'))).toBe(false);
  await expect.poll(async () => Math.round((await editor.nodeBox('card-root')).width / zoom)).toBe(360);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Variant-1 keeps its own 200px (in its entry or a ternary branch) and paints it.
  const after = await editor.code(CARD);
  const v1Width = variantEntry(after, 'card-root', 'variant-1')?.width ?? styleTernary(after, 'card-root', 'width')?.branches['variant-1'];
  expect(v1Width).toBe('200px');
  expect(Math.round((await editor.nodeBoxIn('variant-1', 'card-root')).width / zoom)).toBe(200);
});

test.describe('two tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-226 a display:none instance hides only its wrapper; an authored display:grid reaches the root', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
    const tiles = [TILE.desktop, TILE.tablet];
    const seed = project()
      .pageSource(pageClient(pageRoot(`
<style>{\`@media (max-width: 768px) { [data-id="card-a"] { display: block !important; } }\`}</style>
${inst('Card', 'card-a', '', `position: 'relative', flex: '0 0 auto', display: 'none'`)}
${inst('Card', 'card-b', '', `position: 'relative', flex: '0 0 auto', display: 'grid'`)}`), { header: canvasHeader(tiles), imports: [`import Card from '@/components/Card';`] }))
      .component('Card', CARD_MASTER)
      .build();
    await editor.load(seed, { fit: true });

    // Desktop: the wrapper is hidden; the expanded root keeps the master's flex.
    const wrapA = editor.sandbox().locator('[data-node-id="card-a"]').first();
    await expect.poll(() => wrapA.evaluate(el => getComputedStyle(el).display)).toBe('none');
    expect(await paintedById(editor, 'card-a:card-root', 'display')).toBe('flex');
    // Tablet: the band shows the wrapper and the root paints as the master's flex column.
    await expect.poll(() => paintedById(editor, 'tablet-card-a', 'display')).not.toBe('none');
    expect(await paintedById(editor, 'tablet-card-a:card-root', 'display')).toBe('flex');
    await expect(editor.sandbox().locator('[data-node-id="tablet-card-a:card-title"]')).toBeVisible();
    // The authored display reaches the root of the other instance.
    await expect.poll(() => paintedById(editor, 'card-b:card-root', 'display')).toBe('grid');
  });
});

test('CMP-227 a master edit re-expands all 20 instances; one instance\'s prop never leaks into another', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(twentyCardsSeed());
  const ids = Array.from({ length: 20 }, (_, i) => `card-${i + 1}`);
  for (const id of ids) expect(await textById(editor, `${id}:card-title`)).toBe('Old');

  await enterByDoubleClick(editor, 'card-1', CARD);
  await setFillHex(page, '#ff2d75');
  await expect(editor).toHaveStyle('card-root', 'backgroundColor', '#ff2d75', { path: CARD });
  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);
  for (const id of ids) await expect.poll(() => paintedById(editor, `${id}:card-root`, 'background-color')).toBe(PINK);

  // One instance's prop.
  const before = await editor.code(PAGE);
  await page.waitForTimeout(450);
  await editor.click('card-5');
  await expect.poll(() => editor.selection()).toEqual(['card-5']);
  await typeInRow(page, 'Title', 'Five');
  await expect.poll(() => editor.attr('card-5', 'title', PAGE)).toBe('Five');
  await expect.poll(() => textById(editor, 'card-5:card-title')).toBe('Five');
  for (const id of ids.filter(i => i !== 'card-5')) {
    expect(await editor.attr(id, 'title', PAGE)).toBeNull();
    expect(await textById(editor, `${id}:card-title`)).toBe('Old');
  }
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});
