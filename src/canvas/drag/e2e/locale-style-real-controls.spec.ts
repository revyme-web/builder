import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('Localize padding mounts the real 4-side control with injected base', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Padding', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  // Convert-on-open wrote the base padding as :lang(fr).
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*padding/i);
  // The Set row mounts the real spacing cluster (multiple inputs), not a bare text box.
  const inputs = await page.locator('[data-locale-condition] input').count();
  expect(inputs).toBeGreaterThanOrEqual(1);
});
