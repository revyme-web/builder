// slug-page-cms-binding.spec.ts — CMS-bound text on a `[slug]` DETAIL page.
//
// A detail page has no `.map()`: the `@cmsPage` annotation puts the whole body
// in scope of one `item`, so every CMS resolver that walks ancestors for a
// `collectionList` finds nothing. Two bugs came out of that (2026-09-09):
//   1. double-click fell through to inline text edit, and the exit commit
//      rewrote `{item.overview}` into a string literal — the binding vanished
//      even when the user typed nothing;
//   2. pressing × on the Content pill injected an EMPTY string, so the text
//      disappeared from the canvas instead of being detached to its own words.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1500, height: 950 } });

test('double-click on bound text opens the CMS editor on that item + field, and never edits in place', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('CMS_SLUG_PAGE');
  await editor.fitCamera();

  const box = await editor.nodeBox('overview');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(150);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(900);

  // The CMS overlay is open on the previewed item, with the clicked field
  // focused — the item pane shows this collection's fields.
  await expect(page.getByText('Case study', { exact: false }).first()).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('MERIDIAN ARCHITECTS', { exact: false }).first()).toBeVisible({ timeout: 8_000 });

  // The binding survived: no inline text edit ran, so the JSX still reads
  // `{item.overview}`.
  const code = await editor.readFile('app/page.client.tsx');
  expect(code).toContain('{item.overview}');
});

test('unbinding the Content field injects the resolved text, not an empty string', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('CMS_SLUG_PAGE');
  await editor.fitCamera();
  await page.evaluate(() => (window as any).__e2e.select(['overview']));
  await page.waitForTimeout(700);

  const panel = page.locator('[data-properties-panel]');
  const unbind = panel.locator('[title="Unbind from CMS field"]').first();
  await expect(unbind).toBeVisible({ timeout: 8_000 });
  await unbind.click();
  await page.waitForTimeout(1000);

  const code = await editor.readFile('app/page.client.tsx');
  // Detached to VALUE: the words that were on screen, as direct text.
  expect(code).toContain('A forty-person practice known for civic buildings.');
  expect(code).not.toContain('{item.overview}');
  // And the node still paints them on the canvas (not an empty box).
  const painted = await editor.sandbox().locator('[data-id="overview"]').first().innerText();
  expect(painted.trim()).toBe('A forty-person practice known for civic buildings.');
  // The other binding is untouched.
  expect(code).toContain('{item.title}');
});


test('duplicating a bound node on its own slug page keeps the binding, not a Missing pill', async ({ page }) => {
  // Copy dormantizes the binding into `data-cms-orphan` and paste rehydrates it
  // against the iterator in scope. On a detail page there is no `.map()`, so
  // rehydration bailed and the duplicate stayed dormant — the Content row read
  // "Missing" even though the very same `item` was in scope.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('CMS_SLUG_PAGE');
  await editor.fitCamera();
  await page.evaluate(() => (window as any).__e2e.select(['overview']));
  await page.waitForTimeout(600);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d');
  await page.waitForTimeout(1200);

  const code = await editor.readFile('app/page.client.tsx');
  // Both the original and the copy are bound to the field.
  expect(code.match(/\{item\.overview\}/g)?.length).toBe(2);
  expect(code).not.toContain('data-cms-orphan');

  // The panel shows a real binding for the (newly selected) copy, not Missing.
  const panel = page.locator('[data-properties-panel]');
  await expect(panel.locator('[title="Unbind from CMS field"]').first()).toBeVisible({ timeout: 8_000 });
  await expect(panel.getByText('Missing', { exact: true })).toHaveCount(0);
});


test('dragging a bound node out to the canvas keeps its text and reads as bound, not Missing', async ({ page }) => {
  // The canvas nodes live at MODULE scope, where the page's `item` is not
  // declared, so the JSX cannot keep a live `{item.field}` — it is stashed and
  // re-attaches on the way back in. What used to go wrong: the stash wrote the
  // humanized FIELD NAME over the text, so a heading read "Overview" (the user
  // saw "Untitled"), and the panel claimed the binding was Missing even though
  // the field belongs to this very page's collection.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('CMS_SLUG_PAGE');
  await editor.fitCamera();
  await editor.primeNode('overview');
  await editor.select(['overview']);
  await page.waitForTimeout(500);

  const box = await editor.nodeBox('overview');
  const root = await editor.nodeBox('root');
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Straight out to open canvas, well clear of the page.
  const to = { x: root.x - 320, y: root.y + 160 };
  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await editor.pumpDrag(to, 6);
  await mouse.up();
  await page.waitForTimeout(1200);

  const code = await editor.readFile('app/page.client.tsx');
  expect(code, 'it really left the page body for the canvas').toContain('data-canvas-node="true"');
  // The text it was SHOWING survives — never the humanized field name.
  expect(code).toContain('A forty-person practice known for civic buildings.');
  expect(code).not.toMatch(/>\s*Overview\s*</);
  // The remembered binding is stashed (module scope cannot hold `{item…}`)…
  expect(code).toContain('data-cms-orphan="__text:overview"');
  // …and the panel names the field instead of claiming it is missing.
  const panel = page.locator('[data-properties-panel]');
  await expect(panel.getByText('Overview', { exact: true }).first()).toBeVisible({ timeout: 8_000 });
  await expect(panel.getByText('Missing', { exact: true })).toHaveCount(0);

});
