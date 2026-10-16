// padding-axis-control.spec.ts — the Padding control's X / Y step (user
// request 2026-10-16): matched pairs open on X / Y; an X edit writes left +
// right in one go; the corners button steps on to all four sides.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ deviceScaleFactor: 2 });

test('Padding: X / Y inputs, then four sides', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('PADDED_HUG_FRAME');   // padding: 10px 30px
  await page.evaluate(() => (window as any).__e2e.select(['box']));

  const row = page.locator('[data-spacing-axis="x"]').first().locator('xpath=ancestor::div[contains(@class,"w-full")][2]');
  const x = page.locator('[data-spacing-axis="x"]').first();
  const y = page.locator('[data-spacing-axis="y"]').first();
  await expect(x).toHaveValue('30');
  await expect(y).toHaveValue('10');
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: '/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/d950fdb8-58fc-4cc7-9467-f9ec195712a3/scratchpad/padding-axis.png' });

  await x.click();
  await x.fill('44');
  await x.press('Enter');
  await page.waitForTimeout(400);
  const pad = await editor.node('box').evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
  });
  expect(pad).toEqual([10, 44, 10, 44]);

  // Corners button → all four sides. (Handles, not locators: the row locator
  // is anchored on the X input, which this click removes.)
  const corners = (await row.locator('[data-spacing-mode]').elementHandle())!;
  const rowEl = (await row.elementHandle())!;
  expect(await corners.getAttribute('data-spacing-mode')).toBe('axis');
  await corners.click();
  await expect.poll(() => corners.getAttribute('data-spacing-mode')).toBe('individual');
  await expect(page.locator('[data-spacing-axis]')).toHaveCount(0);
  await rowEl.screenshot({ path: '/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/d950fdb8-58fc-4cc7-9467-f9ec195712a3/scratchpad/padding-four.png' });
});
