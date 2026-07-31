// Convert-on-open: clicking Localize applies immediately (pill without tweaks).
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('Localize converts instantly', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_AUTO_HEIGHT');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  // No tweak — the rule is already written and the pill already shows.
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*background-color/i);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });
});
