import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('popup Variable × on replica removes only that replica', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  // Tablet: open the popup from the pill, × the Variable pill inside it.
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'tablet'));
  const pill = page.locator('[data-locale-pill="backgroundColor"]');
  await expect(pill).toBeVisible({ timeout: 5000 });
  await pill.click();
  await page.waitForTimeout(400);
  await page.locator('[data-locale-variable-pill] span[role="button"]').click();
  await page.waitForTimeout(700);
  // Popup closed, tablet pill gone (removed), band marker written, global intact.
  await expect(page.locator('[data-locale-style-popup]')).toHaveCount(0);
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toHaveCount(0);
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toContain('--locale-off-background-color');
  expect(code).toMatch(/\n\s*:lang\(fr\) \[data-id="card"\] \{ background-color: #1a1a3a/i);
  // Desktop keeps its pill.
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });
});
