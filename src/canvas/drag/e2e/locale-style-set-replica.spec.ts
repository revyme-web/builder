// Popup Set on a REPLICA scopes to that replica's band only: ranged head,
// descending insertion, global (desktop) rule untouched.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('popup Set on replica scopes to band', async ({ page }) => {
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
  // Mobile replica: open the popup from the pill, change Set via the picker.
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'tablet'));
  const pill = page.locator('[data-locale-pill="backgroundColor"]');
  await expect(pill).toBeVisible({ timeout: 5000 });
  await pill.click();
  await page.waitForTimeout(400);
  await page.locator('[data-locale-condition] button').first().click();
  const hexInput = page.locator('[data-tool-popup] input').first();
  await hexInput.fill('00FF00');
  await hexInput.press('Enter');
  await page.waitForTimeout(700);
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  // Band-scoped, RANGED (tablet-only: excludes mobile), inserted BEFORE the
  // smaller band (descending order so mobile wins boundary ties), and the
  // GLOBAL rule keeps the desktop value untouched.
  expect(code).toMatch(/@media \(max-width: 768px\) and \(min-width: 375\.02px\)\s*\{[\s\S]*?:lang\(fr\) \[data-id="card"\] \{ background-color: #00ff00/i);
  const idx768 = code.indexOf('max-width: 768px');
  const idx375 = code.indexOf('max-width: 375px');
  expect(idx768).toBeGreaterThan(-1);
  expect(idx768).toBeLessThan(idx375);
  const topLevel = code.slice(code.lastIndexOf('}\n    :lang'));
  expect(code).toMatch(/\n\s*:lang\(fr\) \[data-id="card"\] \{ background-color: #1a1a3a/i);
});
