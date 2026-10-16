// fill-gradient-undo.spec.ts — Image → Gradient → Cmd+Z must put the IMAGE
// back on the canvas and in the popup (user report 2026-10-16: the Fill row
// said Image, but the canvas kept the gradient and the popup stayed on the
// Gradient tab). Cause: every canvas render — the undo's restore render
// included — was skipped while the gradient editor was open, and the popup
// only re-detected its tab on a selection change.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('Fill: Image → Gradient → undo restores the image on canvas and in the popup', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('IMAGE_FILL_NODE');
  await page.evaluate(() => (window as any).__e2e.select(['pic']));
  await page.locator('div.justify-between', { has: page.getByText('Fill', { exact: true }) })
    .locator('button').filter({ hasText: /Image/ }).click();
  const popup = page.locator('[data-tool-popup]').last();
  await popup.getByRole('button', { name: 'Gradient', exact: true }).click();

  const paint = () => editor.node('pic').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, size: cs.backgroundSize };
  });
  await expect.poll(async () => (await paint()).image).toContain('linear-gradient');
  await expect(page.locator('svg[data-gradient-overlay]')).toHaveCount(1);

  await page.keyboard.press('Meta+z');

  // Canvas: the image is back, with its sizing.
  await expect.poll(async () => (await paint()).image).toContain('url(');
  expect((await paint()).size).toBe('cover');
  // Popup: off the Gradient tab (its Linear/Radial/Conic row is gone), and the
  // gradient overlay with it.
  await expect(popup.getByRole('button', { name: 'Linear', exact: true })).toHaveCount(0);
  await expect(page.locator('svg[data-gradient-overlay]')).toHaveCount(0);
});
