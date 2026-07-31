// pin-constraint-lines.spec.ts — the dashed pin constraint lines shown from a
// selected absolute element's pinned edges to its parent's edges.
//
// Regression (live find 2026-07-24): a hero section whose ANCESTOR carried a
// benign `transform: translate/scale` (glow wrapper / parallax / GPU hint) hid
// the pin lines entirely. The old gate suppressed on ANY transform; it now
// suppresses only for genuine ROTATION/SKEW (which actually breaks the
// axis-aligned line math). A plain translate/scale keeps the pinned edges
// axis-aligned, so the lines must still render.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('PinConstraintLines transform gate', () => {
  test('benign translate/scale ancestor STILL shows pin lines', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('ABSOLUTE_IN_TRANSFORMED_FRAME');
    // Zoom-to-fit so the tiles/caches are populated + on-camera.
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(400);

    // Select the pinned child inside the translate/scale hero.
    await page.evaluate(() => (window as any).__e2e.select(['pinned-child'], 'desktop'));

    // Lines must appear (left + top pins → the dashed overlay renders).
    const lines = page.locator('[data-pin-constraint-lines]');
    await expect(lines).toBeVisible({ timeout: 5_000 });
    // The overlay carries one <line> per pinned edge — left + top here.
    await expect.poll(async () => lines.locator('line').count()).toBeGreaterThanOrEqual(2);
  });

  test('rotated ancestor SUPPRESSES pin lines (axis-aligned math invalid)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('ABSOLUTE_IN_TRANSFORMED_FRAME');
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(400);

    // Select the pinned child inside the rotate(15deg) hero.
    await page.evaluate(() => (window as any).__e2e.select(['pinned-child-rot'], 'desktop'));
    await page.waitForTimeout(300);

    // The overlay must be hidden — either unmounted or display:none.
    const lines = page.locator('[data-pin-constraint-lines]');
    await expect(lines).toBeHidden({ timeout: 5_000 });
  });
});
