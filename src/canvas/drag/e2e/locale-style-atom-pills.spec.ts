import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('Localize opacity: injected base, slider control, pill on row', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Opacity', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  // Convert-on-open injected the CSS-initial base (opacity: 1) as :lang(fr).
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*opacity:\s*1/i);
  // Set row renders the slider + input pair.
  await expect(page.locator('[data-locale-condition] input[type="range"], [data-locale-condition] [class*="slider"], [data-locale-condition] input').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // The Opacity row now shows the blue Locale pill.
  await expect(page.locator('[data-locale-pill="opacity"]')).toBeVisible({ timeout: 5000 });
});
