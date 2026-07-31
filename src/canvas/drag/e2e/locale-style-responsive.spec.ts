// Responsive locale styles: localize on desktop → pill shows on every
// artboard; × on the MOBILE replica removes it for that artboard only
// (banded base-bake + --locale-off marker), the desktop keeps its pill,
// and setting a value again on the replica re-enables it band-scoped.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('locale pill is per-replica removable and re-settable', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_AUTO_HEIGHT');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);

  // Localize the card's color on the PRIMARY: menu → Localize → set French.
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  const fillLabel = page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first();
  await fillLabel.click();
  await page.getByText('Localize', { exact: true }).click();
  await page.locator('[data-locale-condition] button').first().click();
  const hexInput = page.locator('[data-tool-popup] input').first();
  await hexInput.fill('FF0044');
  await hexInput.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });

  // Switch to the MOBILE replica → pill still shows (inherited) → × it.
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'mobile'));
  const pill = page.locator('[data-locale-pill="backgroundColor"]');
  await expect(pill).toBeVisible({ timeout: 5000 });
  await pill.locator('span[role="button"]').click();
  await page.waitForTimeout(600);

  // Replica: pill gone; banded removal marker written; desktop keeps it.
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toHaveCount(0);
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toContain('--locale-off-background-color');
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*background-color:\s*#FF0044/i);

  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await expect(page.locator('[data-locale-pill="backgroundColor"]')).toBeVisible({ timeout: 5000 });
});
