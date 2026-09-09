// lock-from-replica-row.spec.ts — the Layers padlock is a WHOLE-NODE property.
//
// Reported 2026-09-09: pressing lock on a REPLICA row did nothing. The toggle
// went through the viewport-routed style writer, so the write landed in that
// tile's @media band — while both readers (the padlock icon and the canvas
// hit-test) only ever look at the node's BASE `pointerEvents`. The click
// flipped no icon and locked nothing.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1600, height: 950 } });

test('locking from a replica row locks the node everywhere and shows as locked', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_AUTO_HEIGHT');
  await editor.fitCamera();

  // Interact with the MOBILE replica first — that is what routed the write
  // into the mobile band before.
  await editor.primeNode('card', 'mobile');
  await editor.select(['card-inner'], 'mobile');
  await page.waitForTimeout(500);

  await page.locator('[data-tutorial="layers-button"]').click();
  await page.waitForTimeout(500);
  const row = page.locator('[data-layer-id$="card-inner"]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.hover();
  const padlock = row.locator('[title="Lock layer"]');
  await expect(padlock).toBeVisible({ timeout: 5_000 });
  await padlock.click();
  await page.waitForTimeout(900);

  // 1. The icon flipped — the row now offers "Unlock".
  await expect(row.locator('[title="Unlock layer"]')).toBeVisible({ timeout: 5_000 });

  // 2. The write is on the BASE inline style, not the mobile band.
  expect(await editor.getInlineStyleProp('card-inner', 'pointerEvents')).toBe('none');
  expect(await editor.getBandStyleProp(375, 'card-inner', 'pointer-events')).toBeNull();

  // 3. It is really locked on the canvas: clicking it on the PRIMARY selects
  //    something else (the hit-test skips locked nodes), never the node itself.
  await page.evaluate(() => (window as any).__e2e.select([]));
  const box = await editor.nodeBoxIn('desktop', 'card-inner');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const selection: string[] = await page.evaluate(() => (window as any).__e2e.selection?.() ?? []);
  expect(selection).not.toContain('card-inner');

  // 4. Unlocking from the same row clears it on the base again.
  await row.hover();
  await row.locator('[title="Unlock layer"]').click();
  await page.waitForTimeout(900);
  expect(await editor.getInlineStyleProp('card-inner', 'pointerEvents')).toBeNull();
});
