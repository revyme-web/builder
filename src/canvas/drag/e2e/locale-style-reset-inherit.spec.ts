// Reset Override on a replica must clear ONLY that replica's locale band
// (re-inheriting the base localization) — the regular band writers used to
// re-serialize the whole <style> and EAT every :lang rule in the file.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('reset override on replica re-inherits, desktop untouched', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_AUTO_HEIGHT');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  // Localize Fill on desktop (auto-converts with base).
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  // Mobile: × the pill (band removal).
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'mobile'));
  const pill = page.locator('[data-locale-pill="backgroundColor"]');
  await expect(pill).toBeVisible({ timeout: 5000 });
  await pill.locator('span[role="button"]').click();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toHaveCount(0);
  // Reset Override on the Fill label (mobile interacting).
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Reset Override', { exact: true }).click();
  await page.waitForTimeout(800);
  const codeAfter = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  // Pill must be BACK on mobile (re-inherited) AND desktop unchanged.
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });
  expect(codeAfter).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*background-color/i);
});
