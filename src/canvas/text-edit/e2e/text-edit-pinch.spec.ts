// Pinch-to-zoom while editing text zooms the CANVAS, not the browser page.
//
// Text edit flips the canvas iframe to `pointer-events: auto` (clicks must
// reach ProseMirror), so a pinch over the text lands INSIDE the iframe — where
// nothing handled it, and the browser zoomed the whole editor page (user report
// 2026-10-06). A pinch is a ctrl-wheel; the sandbox now forwards every wheel to
// the parent's camera (canvas-sandbox/wheel-forward.ts).
import { test, expect } from '@playwright/test';
import { EditorPage } from '../../drag/e2e/helpers/editor-page';

test.describe('text edit — pinch zoom', () => {
  test('ctrl-wheel over the edited text zooms the canvas and keeps the edit open', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('LOCALE_TEXT');
    await editor.fitCamera();

    const sandbox = editor.sandbox();
    const intro = sandbox.locator('[data-viewport="desktop"] [data-id="intro"]').first();
    await expect(intro).toHaveText('Painter');
    const before = await intro.boundingBox();
    if (!before) throw new Error('no intro box');
    const cx = before.x + before.width / 2;
    const cy = before.y + before.height / 2;

    // Enter text edit — two spaced clicks (playwright's dblclick pair is <50ms
    // apart and the controller's duplicate-event guard drops it). The pair is
    // occasionally swallowed right after boot, so retry it; entering edit mode
    // is the precondition here, not what is under test.
    const editable = sandbox.locator('[contenteditable="true"]').first();
    for (let attempt = 0; attempt < 3 && !(await editable.isVisible()); attempt++) {
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(120);
      await page.mouse.click(cx, cy);
      await editable.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
      if (!(await editable.isVisible())) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    }
    await expect(editable).toBeVisible();
    await page.waitForTimeout(250);
    // The precondition of the bug: the iframe now takes pointer events.
    expect(await page.locator('iframe[data-canvas-iframe]').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');

    const dprBefore = await page.evaluate(() => window.devicePixelRatio);

    // Pinch = wheel with ctrl held, over the text being edited.
    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(400);

    const after = await intro.boundingBox();
    if (!after) throw new Error('no intro box after pinch');
    // The CANVAS zoomed in under the fingers…
    expect(after.width).toBeGreaterThan(before.width * 1.05);
    // …the browser page did not…
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(dprBefore);
    // …and the text edit is still open.
    await expect(sandbox.locator('[contenteditable="true"]').first()).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
