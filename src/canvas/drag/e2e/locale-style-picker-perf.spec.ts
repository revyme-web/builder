import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('picker drag in Localize popup commits ONCE, not per frame', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'tablet'));
  await page.waitForTimeout(400);
  await page.locator('[data-properties-panel]').getByText('Fill', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.locator('[data-locale-condition] button').first().click();
  await page.waitForTimeout(400);
  // Drag across the saturation square (many pointer moves).
  const square = page.locator('[data-tool-popup] canvas, [data-tool-popup] [class*="saturation"], [data-tool-popup] div').filter({ hasNot: page.locator('input') }).first();
  const before = await page.evaluate(() => ((window as any).__e2e.traceEntries?.('locale-style-popup:write') ?? []).length);
  const box = (await page.locator('[data-tool-popup]').boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 60 + i * 5, box.y + 120 + i, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ((window as any).__e2e.traceEntries?.('locale-style-popup:write') ?? []).length);
  console.log('WRITES-DURING-DRAG', after - before);
  expect(after - before).toBeLessThanOrEqual(2);
});
