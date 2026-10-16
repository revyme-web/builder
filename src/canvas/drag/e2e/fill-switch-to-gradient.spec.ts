// fill-switch-to-gradient.spec.ts — switching the Fill popup to Gradient must
// PAINT the gradient it shows (user report 2026-10-16: the frame went fully
// transparent until a stop or the stop's picker was touched, because the tab
// switch cleared the old fill and the editor's black→white default was
// display-only). The seed's `spinframe` is filled with a backgroundColor.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('Fill: Color → Gradient paints the default gradient straight away', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('ROTATED_FLEX_FRAME');
  await page.evaluate(() => (window as any).__e2e.select(['spinframe']));

  const fillRow = page.locator('div.justify-between', { has: page.getByText('Fill', { exact: true }) })
    .locator('button', { hasText: /7d7d7d/i });
  await fillRow.click();
  const popup = page.locator('[data-tool-popup]').last();
  await popup.getByRole('button', { name: 'Gradient', exact: true }).click();
  await page.waitForTimeout(400);

  // Source: the gradient landed (the generator double-quotes it), the old
  // colour is gone.
  const code = await editor.getPageCode();
  const tag = code.slice(code.indexOf('data-id="spinframe"'), code.indexOf('data-id="chip"'));
  expect(tag).toMatch(/backgroundImage: ["']linear-gradient\(180deg, #000000 0%, #ffffff 100%\)["']/);
  expect(tag).not.toContain('backgroundColor');

  // Canvas: actually painted, not transparent.
  const paint = await editor.node('spinframe').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, color: cs.backgroundColor };
  });
  expect(paint.image).toContain('linear-gradient');
});
