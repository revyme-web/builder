// CMP · Entering and leaving a design-component master (E2E_TEST_PLAN.md §8,
// CMP-039…049, 058, 059, 062, 065): double-click / Library / Edit Component
// entry, the breadcrumb trail, camera stash and restore, navigation history,
// and master edits reaching every instance.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  C2_SEED, CARD, PAGE, ABOUT, cardSeed, enterByDoubleClick, dblclickNode, breadcrumb, breadcrumbSegment,
  waitForActiveFile, waitEntryPainted, stableBox, canvasArea, centredIn, within, sameBox, zoomAndPan,
  layerHeaderLit, layersTabActive, panel, setFillHex, editBoundTextDefault, paintedById, textById,
  collectConsoleErrors, HOOKS_ORDER, traces, TOOLS_SEED, CMS_DETAIL_SEED, DETAIL, palette, paletteSearch, paletteResults, stubIconify, leftPanel, HEADER_LOGO_SEED, SIGNUP_SEED, THREE_KINDS_SEED, stubCdn, BADGE_MASTER, libraryRow,
} from '../../helpers/c2';
import { NESTED_MASTERS } from '../../helpers/c3';
import { INSTANCE_VARIANT_OVERRIDE_3VP } from '../../../src/canvas/drag/e2e/fixtures/seeds';
import { selectionBorderAt } from '../../helpers/d6';
import { makeComponentViaMenu, exitToPage, MAKE_COMPONENT_PAGE } from '../../helpers/c1';
import { openPreview } from '../../helpers/c3';
import { quickBox } from '../../helpers/d6';

const PINK = 'rgb(255, 45, 117)';
const PREVIEW_NOISE = /unique "key" prop/;

test('CMP-039 double-click an instance enters its master: Layers, lit variant header, root selected, default tile fitted', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  // Start from the Pages tab so the switch to Layers is observable.
  await page.locator('[data-tutorial="left-panel"]').getByText('Pages', { exact: true }).first().click();
  await expect(page.locator('[data-layer-id="__vp_desktop"]')).toHaveCount(0);
  await enterByDoubleClick(editor, 'card-a', CARD);

  expect(await editor.activeFile()).toBe(CARD);
  expect(await breadcrumb(page)).toEqual(['Home', 'Card']);
  // Left panel on the Layers tab, the default variant header lit.
  await expect(page.locator('[data-layer-id="__vp_desktop"]')).toBeVisible();
  await expect.poll(() => layerHeaderLit(page, 'desktop')).toBe(true);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);

  // Camera fits the DEFAULT tile only: centred, the Hover tile left out.
  const area = await canvasArea(page);
  const def = await stableBox(editor, 'card-root');
  expect(centredIn(def, area)).toBe(true);
  expect(def.width).toBeGreaterThan(area.width * 0.25);
  const hover = await quickBox(await editor.nodeIn('variant-1', 'card-root'));
  expect(hover === null || !within(hover, area)).toBe(true);

  // Interacting viewport = the primary: no purple Min/Max override rows.
  await expect(panel(page)).toContainText('Width');
  await expect(panel(page)).not.toContainText('Min Width');
  await expect(panel(page)).not.toContainText('Max Width');
  const widthLabel = panel(page).locator('span[title="Width"]').first();
  // (`group-hover:text-[var(--accent-secondary)]` is the hover tint, not an override.)
  expect(await widthLabel.evaluate(el => el.classList.contains('text-[var(--accent-secondary)]'))).toBe(false);
});

test('CMP-039b entering a master logs no React hooks-order error', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the Make Component entry into the new master logs React\'s hooks-order error for ControlLabel (src/editor/controls/ControlLabel.tsx returns early on `plain`/`hideLabel` before useControl()/useAtomValue); double-click, Library and Edit Component entries are clean');
  editor.allowErrors(/order of Hooks/);
  editor.allowErrors(/Expected static flag was missing/);
  await editor.load(MAKE_COMPONENT_PAGE);
  const errors = collectConsoleErrors(page);
  // Entry 1: Make Component lands inside the new master.
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: [0.05, 0.05] });
  await page.waitForTimeout(800);
  // Entry 2: back to the page, double-click the new instance.
  await exitToPage(editor);
  await enterByDoubleClick(editor, 'card', made.file);
  await page.waitForTimeout(800);
  expect(errors.filter(e => HOOKS_ORDER.test(e) || /order of Hooks/.test(e))).toEqual([]);
});

test('CMP-040 leaving through the Home crumb restores the exact pre-entry pan/zoom; a reload lands on the page', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  // Zoom and pan the page with real wheel input.
  const start = await stableBox(editor, 'marker');
  await zoomAndPan(page, { zoomSteps: 3, panX: 80, panY: 120 });
  const before = await stableBox(editor, 'marker');
  expect(sameBox(before, start, 2)).toBe(false);

  await enterByDoubleClick(editor, 'card-a', CARD);
  expect(new URL(page.url()).searchParams.get('page')).toBe('component:Card');
  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);
  await expect.poll(async () => sameBox(await stableBox(editor, 'marker'), before, 0.5), { timeout: 5_000 }).toBe(true);
  // The URL names the page again (Home is the bare URL), never the master.
  expect(new URL(page.url()).searchParams.get('page')).toBeNull();

  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  expect(await editor.activeFile()).toBe(PAGE);
  expect(await breadcrumb(page)).toEqual([]);
  await expect(editor.node('marker')).toBeVisible();
});

test('CMP-041 a master edit (root fill + Title) repaints every instance on both pages and in preview', { tag: ['@p0', '@cmp', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(cardSeed({ bAttrs: '' }));
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);

  await setFillHex(page, '#ff2d75');
  await expect(editor).toHaveStyle('card-root', 'backgroundColor', '#ff2d75', { path: CARD });
  const beforeTitle = await editor.code(CARD);
  await editBoundTextDefault(editor, 'card-title', 'New');
  await expect.poll(() => editor.code(CARD)).toMatch(/title = ["']New["']/);
  await expect(editor).toUndoInOneStep(beforeTitle, { path: CARD });
  // The master tile itself repaints.
  await expect.poll(() => textById(editor, 'card-title')).toBe('New');

  // Back on page A: both instances repainted without a reload.
  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);
  for (const id of ['card-a', 'card-b']) {
    await expect.poll(() => paintedById(editor, `${id}:card-root`, 'background-color')).toBe(PINK);
    await expect.poll(() => textById(editor, `${id}:card-title`)).toBe('New');
  }
  // The page source is untouched: the edit lives in the master only.
  expect(await editor.code(PAGE)).not.toContain('#ff2d75');

  // Page B through the Pages tab.
  await page.locator('[data-tutorial="left-panel"]').getByText('Pages', { exact: true }).first().click();
  await page.locator('[data-tutorial="left-panel"]').getByText('/about', { exact: true }).first().click();
  await waitForActiveFile(editor, ABOUT);
  await expect.poll(() => paintedById(editor, 'card-c:card-root', 'background-color')).toBe(PINK);
  await expect.poll(() => textById(editor, 'card-c:card-title')).toBe('New');

  // Preview.
  const frame = await openPreview(page, '[data-id="card-c"]');
  const live = frame.locator('[data-id="card-c"]').first();
  await expect.poll(() => live.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(PINK);
  await expect(live.locator('[data-id="card-title"]').first()).toHaveText('New');
});

test('CMP-046 navigation is its own history step: undo walks back into the master, redo returns', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  // An unrelated earlier edit on the page: delete the marker with the real key.
  await editor.click('marker');
  await page.keyboard.press('Delete');
  await expect.poll(async () => editor.exists('marker', PAGE)).toBe(false);
  const pageAfterDelete = await editor.code(PAGE);

  await enterByDoubleClick(editor, 'card-a', CARD);
  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);

  await editor.undo();
  await waitForActiveFile(editor, CARD);
  await expect.poll(() => breadcrumb(page)).toEqual(['Home', 'Card']);
  // The delete is NOT undone by that step.
  expect(await editor.code(PAGE)).toBe(pageAfterDelete);

  await editor.redo();
  await waitForActiveFile(editor, PAGE);
  await expect.poll(() => breadcrumb(page)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(pageAfterDelete);
});

test('CMP-049 a master edit reaches instances without an override; an overridden title keeps its value', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await setFillHex(page, '#ff2d75');
  await editBoundTextDefault(editor, 'card-title', 'New');
  await expect.poll(() => editor.code(CARD)).toMatch(/title = ["']New["']/);
  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);

  await expect.poll(() => textById(editor, 'card-a:card-title')).toBe('New');
  await expect.poll(() => textById(editor, 'card-b:card-title')).toBe('Custom');
  // The fill is not an instance override: both repaint.
  for (const id of ['card-a', 'card-b']) await expect.poll(() => paintedById(editor, `${id}:card-root`, 'background-color')).toBe(PINK);
  expect(await editor.attr('card-b', 'title', PAGE)).toBe('Custom');
});

test('CMP-058 double-clicking the master root inside its own master does not navigate or blank the canvas', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  const crumbs = await breadcrumb(page);
  const code = await editor.code(CARD);

  await page.waitForTimeout(450);
  // A point on the root's own padding (no child under it).
  await dblclickNode(editor, 'card-root', { at: [0.92, 0.92] });
  // Sample the iframe opacity for ~1.2s: never left at 0.
  const opacities = await page.evaluate(async () => {
    const out: string[] = [];
    const f = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
    for (let i = 0; i < 12; i++) {
      out.push(f ? getComputedStyle(f).opacity : '1');
      await new Promise(r => setTimeout(r, 100));
    }
    return out;
  });
  expect(opacities.filter(o => o === '0')).toEqual([]);
  expect(await editor.activeFile()).toBe(CARD);
  expect(await breadcrumb(page)).toEqual(crumbs);
  expect(await editor.selection()).toEqual(['card-root']);
  expect(await editor.code(CARD)).toBe(code);
});

test('CMP-059 the Layers variant header is lit on every double-click entry', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(C2_SEED);
  await enterByDoubleClick(editor, 'card-a', CARD);
  await expect.poll(() => layerHeaderLit(page, 'desktop')).toBe(true);
  await exitToPage(editor);
  await enterByDoubleClick(editor, 'card-b', CARD);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  await expect.poll(() => layerHeaderLit(page, 'desktop'), { timeout: 5_000 }).toBe(true);
});

test.describe('multi-tile entries', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-042 the clicked tile picks the variant: Tablet (data-responsive 768→variant-1) opens on variant-1, Desktop on default', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(INSTANCE_VARIANT_OVERRIDE_3VP, { fit: true });
    await enterByDoubleClick(editor, 'card-inst', CARD, { vpId: 'tablet' });
    const area = await canvasArea(page);
    // Focused on the variant-1 tile, not the primary.
    const v1 = await stableBox(editor, 'card-root', 'variant-1');
    expect(centredIn(v1, area)).toBe(true);
    const def = await quickBox(editor.sandbox().locator('[data-node-id="card-root"]'));
    expect(def === null || !centredIn(def, area)).toBe(true);
    expect(await selectionBorderAt(editor, v1)).toBe(true);

    await exitToPage(editor);
    await enterByDoubleClick(editor, 'card-inst', CARD, { vpId: 'desktop' });
    const d = await stableBox(editor, 'card-root');
    expect(centredIn(d, await canvasArea(page))).toBe(true);
    const v1b = await quickBox(await editor.nodeIn('variant-1', 'card-root'));
    expect(v1b === null || !centredIn(v1b, await canvasArea(page))).toBe(true);
  });
});

test('CMP-043 a nested instance on the parent\'s variant-1 tile opens its own master on variant-1', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(HEADER_LOGO_SEED);
  await enterByDoubleClick(editor, 'header-a', 'components/Header.tsx');
  // Fit both Header variants (Shift+1) so the Dark tile is on screen.
  await editor.fitCamera();
  await enterByDoubleClick(editor, 'header-logo', 'components/Logo.tsx', { vpId: 'variant-1' });

  expect(await breadcrumb(page)).toEqual(['Home', 'Header', 'Logo']);
  const v1 = await stableBox(editor, 'logo-root', 'variant-1');
  expect(centredIn(v1, await canvasArea(page))).toBe(true);
  const def = await quickBox(editor.sandbox().locator('[data-node-id="logo-root"]'));
  expect(def === null || !centredIn(def, await canvasArea(page))).toBe(true);
});

test('CMP-044 Library entry: Layers tab, a re-entry restores the saved pan/zoom, the trail never chains', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(cardSeed({ extra: { 'components/Badge.tsx': BADGE_MASTER } }));
  await (await libraryRow(page, 'Card')).click();
  await waitForActiveFile(editor, CARD);
  await waitEntryPainted(editor);
  expect(await layersTabActive(page)).toBe(true);
  await expect(page.locator('[data-layer-id="__vp_desktop"]')).toBeVisible();
  expect(await breadcrumb(page)).toEqual(['Home', 'Card']);
  const fitted = await stableBox(editor, 'card-root');

  // Pan/zoom inside the master with real wheel input.
  await zoomAndPan(page, { zoomSteps: 2, zoomDelta: 80, panX: -60, panY: 90 });
  const moved = await stableBox(editor, 'card-root');
  expect(sameBox(moved, fitted, 2)).toBe(false);

  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);
  await (await libraryRow(page, 'Card')).click();
  await waitForActiveFile(editor, CARD);
  await waitEntryPainted(editor);
  // The saved camera, not a fresh fit.
  await expect.poll(async () => sameBox(await stableBox(editor, 'card-root'), moved, 1)).toBe(true);
  expect(await breadcrumb(page)).toEqual(['Home', 'Card']);

  // From inside Card, a Library click on Badge does not chain Card in.
  await (await libraryRow(page, 'Badge')).click();
  await waitForActiveFile(editor, 'components/Badge.tsx');
  await expect.poll(() => breadcrumb(page)).toEqual(['Home', 'Badge']);
});

test('CMP-045 Edit Component enters like a double-click; a code component reads Edit Code; double-clicks on code / CDN instances only reveal the Component tool', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  // The CDN bundle is not served here (only the panel/navigation is under
  // test); the stubbed closed-source 403 logs a resource error.
  editor.allowErrors(/assets\.revyme\.app|StubPill@|Failed to fetch|dynamically imported module|net::ERR|status of 403/i);
  await stubCdn(page);
  await editor.load(THREE_KINDS_SEED);
  const overlay = page.locator('div[class*="z-[10000]"]', { has: page.getByRole('button', { name: 'Save' }) });
  const unlink = page.getByText(/Unlink Instance/);

  // Design instance → "Edit Component" = the double-click entry.
  await editor.click('card-a');
  const editBtn = panel(page).getByRole('button', { name: 'Edit Component', exact: true });
  await expect(editBtn).toBeVisible();
  await editBtn.click();
  await waitForActiveFile(editor, CARD);
  await waitEntryPainted(editor);
  expect(await breadcrumb(page)).toEqual(['Home', 'Card']);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  expect(await layersTabActive(page)).toBe(true);
  expect(centredIn(await stableBox(editor, 'card-root'), await canvasArea(page))).toBe(true);
  await exitToPage(editor);

  // Code component instance: double-click stays on the page and flashes the tool.
  await page.waitForTimeout(450);
  await dblclickNode(editor, 'counter-a');
  const flash = panel(page).locator('div[class*="border-[var(--accent-secondary"]');
  await expect(flash.first()).toBeAttached({ timeout: 3_000 });
  await editor.settled();
  expect(await editor.activeFile()).toBe(PAGE);
  await expect(overlay).toHaveCount(0);
  // …and its button reads "Edit Code" and opens the code editor overlay.
  const codeBtn = panel(page).getByRole('button', { name: 'Edit Code', exact: true });
  await expect(codeBtn).toBeVisible();
  await codeBtn.click();
  await expect(overlay).toBeVisible();
  expect(await editor.activeFile()).toBe(PAGE);
  await overlay.getByRole('button', { name: 'Back' }).click();
  await expect(overlay).toHaveCount(0);

  // CDN-linked instance: a double-click opens no unlink modal.
  await page.waitForTimeout(450);
  await dblclickNode(editor, 'cdn-a');
  // The double-click registered as one (it takes the reveal-tool path)…
  await expect.poll(async () => (await traces(page, 'canvas:dblclick-cdn-component')).length).toBeGreaterThan(0);
  await editor.settled();
  await page.waitForTimeout(500);
  // …and opens no unlink modal.
  await expect(unlink).toHaveCount(0);
  expect(await editor.activeFile()).toBe(PAGE);
});

test('CMP-047 Header › Button › back to Header: undo/redo never grows the trail', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(NESTED_MASTERS);
  await enterByDoubleClick(editor, 'header-a', 'components/Header.tsx');
  await enterByDoubleClick(editor, 'header-btn', 'components/Button.tsx');
  expect(await breadcrumb(page)).toEqual(['Home', 'Header', 'Button']);
  await breadcrumbSegment(page, 'Header').click();
  await waitForActiveFile(editor, 'components/Header.tsx');
  expect(await breadcrumb(page)).toEqual(['Home', 'Header']);

  const files = new Set(await editor.listFiles());
  const legal = (c: string[]) => {
    const names = c.slice(1);
    return new Set(names).size === names.length && names.every(n => files.has(`components/${n}.tsx`));
  };
  for (let i = 0; i < 3; i++) {
    await editor.undo();
    await waitForActiveFile(editor, 'components/Button.tsx');
    const u = await breadcrumb(page);
    expect(u).toEqual(['Home', 'Header', 'Button']);
    expect(legal(u)).toBe(true);
    await editor.redo();
    await waitForActiveFile(editor, 'components/Header.tsx');
    const r = await breadcrumb(page);
    expect(r).toEqual(['Home', 'Header']);
    expect(legal(r)).toBe(true);
  }
});

test('CMP-048 MotionLink-root master: the root shows the full panel, a bad id keeps the shell, the variant header selects the root', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(SIGNUP_SEED);
  // Setup: open the master (its entry is covered by CMP-039/044).
  await editor.openFile('components/SignUp.tsx');
  await waitForActiveFile(editor, 'components/SignUp.tsx');
  await editor.fitCamera();
  await editor.settled();

  // A real click on the root's own padding (its label child covers the centre).
  const p = await editor.at('link-signup', 0.04, 0.5);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => editor.selection()).toEqual(['link-signup']);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('Navigation');

  // The unresolvable `root` fallback id (no real input produces it on demand).
  await editor.select(['root']);
  await editor.settled();
  await expect(panel(page)).toBeVisible();

  await editor.select([]);
  await page.locator('[data-tutorial="layers-button"]').click().catch(() => {});
  const header = page.locator('[data-layer-id="__vp_desktop"]');
  await header.click({ timeout: 10_000 });
  await expect.poll(() => editor.selection()).toEqual(['link-signup']);
  await expect(panel(page)).toContainText('Navigation');
});

test('CMP-062 a master entered from a CMS [slug] page: Collection › Item › master; the origin crumb returns to the origin page and the Pages tab', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(CMS_DETAIL_SEED);
  const left = page.locator('[data-tutorial="left-panel"]');
  await left.getByText('Pages', { exact: true }).first().click();
  await left.getByText('/[slug]', { exact: true }).first().click();
  await waitForActiveFile(editor, DETAIL);
  await enterByDoubleClick(editor, 'card-d', CARD);

  // [origin page] › [Collection] › [Item] › master.
  expect(await breadcrumb(page)).toEqual(['Home', 'Case Study', 'MERIDIAN ARCHITECTS', 'Card']);
  expect(await layersTabActive(page)).toBe(true);
  await expect(page.locator('[data-layer-id="__vp_desktop"]')).toBeVisible();

  await breadcrumbSegment(page, 'Home').click();
  await waitForActiveFile(editor, PAGE);
  // …on the Pages tab: the page list, not the layer tree.
  await expect(leftPanel(page).getByText('/case-study', { exact: true })).toBeVisible();
  await expect(page.locator('[data-layer-id="__vp_desktop"]')).toHaveCount(0);
  expect(await breadcrumb(page)).toEqual([]);
});

test('CMP-065 Cmd+K on a page lists the instance (Component), never the master internals; inside the master its nodes are searchable', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await stubIconify(page);
  await editor.load(TOOLS_SEED);

  await paletteSearch(page, 'tools');
  expect((await paletteResults(page)).filter(r => r.category === 'Layers')).toEqual([]);

  await paletteSearch(page, 'header');
  const layers = (await paletteResults(page)).filter(r => r.category === 'Layers');
  expect(layers).toEqual([{ category: 'Layers', name: 'Header', sub: 'Component' }]);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect.poll(() => editor.selection()).toEqual(['header-a']);
  await expect.poll(async () => centredIn(await stableBox(editor, 'header-a'), await canvasArea(page), 0.15)).toBe(true);

  // Inside the master the Tools node is listed and selectable.
  await enterByDoubleClick(editor, 'header-a', 'components/Header.tsx');
  await paletteSearch(page, 'tools');
  const inMaster = (await paletteResults(page)).filter(r => r.category === 'Layers');
  expect(inMaster.length).toBeGreaterThan(0);
  expect(inMaster.every(r => r.name === 'Tools')).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => editor.selection()).toEqual(['header-tools']);
});
