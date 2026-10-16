// gradient-rotate-zones.spec.ts — the linear gradient's canvas handles follow
// the FRAME's transform, and rotating happens in zones just beyond the
// outermost stops (user request 2026-10-16). The seed frame is rotated 90°: the
// old screen-space overlay drew a 180deg gradient top → bottom on screen, while
// the paint ran right → left.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('rotated frame: the gradient line turns with it, and a zone rotates it', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('ROTATED_FLEX_FRAME');
  await page.evaluate(() => (window as any).__e2e.select(['spinframe']));
  await page.locator('div.justify-between', { has: page.getByText('Fill', { exact: true }) })
    .locator('button', { hasText: /7d7d7d/i }).click();
  await page.locator('[data-tool-popup]').last().getByRole('button', { name: 'Gradient', exact: true }).click();

  const overlay = page.locator('svg[data-gradient-overlay]');
  await expect(overlay).toBeVisible();
  // No visible endpoint dots any more.
  await expect(overlay.locator('circle[fill="#ff6b6b"]')).toHaveCount(0);

  const line = await overlay.locator('line').first().evaluate((l) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a))));
  const [x1, y1, x2, y2] = line;
  expect(Math.abs(y1 - y2)).toBeLessThan(2);   // horizontal on screen
  expect(x1).toBeGreaterThan(x2);              // 0% on the right: local top = screen right

  const zones = overlay.locator('[data-gradient-rotate-zone]');
  await expect(zones).toHaveCount(2);
  const after = await zones.nth(1).evaluate((z) => ({ x: Number(z.getAttribute('cx')), y: Number(z.getAttribute('cy')) }));
  expect(after.x).toBeLessThan(x2);            // just beyond the LAST stop, outside the line
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/d950fdb8-58fc-4cc7-9467-f9ec195712a3/scratchpad/gradient-zones.png' });

  // Quarter turn clockwise around the centre: from the left end to above it.
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  await page.mouse.move(after.x, after.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const a = Math.PI + (Math.PI / 2) * (i / 8);   // 180° → 270° (screen, y down)
    await page.mouse.move(cx + Math.cos(a) * 80, cy + Math.sin(a) * 80);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const code = await editor.getPageCode();
  const tag = code.slice(code.indexOf('data-id="spinframe"'), code.indexOf('data-id="chip"'));
  expect(tag).toMatch(/linear-gradient\(270deg, #000000 0%, #ffffff 100%\)/);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/d950fdb8-58fc-4cc7-9467-f9ec195712a3/scratchpad/gradient-zones-rotated.png' });
});
