// Localize convert flow (Phase 4): control menu → Localize →
// Variable pill + When/Set with the property's REAL control → :lang() rule
// written → the control's value area shows the blue Locale pill.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('Localize popup writes :lang rule and control shows the Locale pill', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_TEXT');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);

  // Select the intro text node (default mode) and open the Color label menu.
  await page.evaluate(() => (window as any).__e2e.select(['intro']));
  await page.waitForTimeout(400);
  const colorLabel = page.locator('[data-properties-panel]').getByText('Color', { exact: true }).first();
  await colorLabel.click();
  await page.getByText('Localize', { exact: true }).click();

  // The convert popup: Variable pill, Convert, When select, Set control.
  await expect(page.locator('[data-locale-style-popup]')).toBeVisible();
  await expect(page.locator('[data-locale-variable-pill]')).toBeVisible();
  const whenSelect = page.locator('[data-locale-condition] select').first();
  await expect(whenSelect).toBeVisible();

  // Set a French color via the REAL ColorInput: click the swatch → the
  // color picker slides in within the ToolPopup → type a hex.
  await page.locator('[data-locale-condition] button').first().click();
  await page.waitForTimeout(400);
  const hexInput = page.locator('[data-tool-popup] input').first();
  await expect(hexInput).toBeVisible();
  await hexInput.fill('FF0044');
  await hexInput.press('Enter');
  await page.waitForTimeout(600);

  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="intro"\][^{]*\{[^}]*color:\s*#FF0044\s*!important/i);

  // Close the popup → the control now shows the blue Locale pill.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-locale-pill="color"]')).toBeVisible({ timeout: 5000 });
});
