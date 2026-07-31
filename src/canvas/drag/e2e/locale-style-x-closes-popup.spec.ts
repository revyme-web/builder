import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('panel pill × closes an open Localize popup', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  // Localize Fill via the menu — popup stays open (owned by the label).
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-locale-style-popup]')).toBeVisible();
  // × the pill on the ROW (properties panel) → popup must close too.
  await page.locator('[data-locale-pill="backgroundColor"] span[role="button"]').click();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-locale-style-popup]')).toHaveCount(0);
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toHaveCount(0);
});
