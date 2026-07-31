// Resize-handle visibility must follow the REPLICA-effective size.
//
// Repro of the mobile testimonial-card report: base styles carry a fixed
// height (300px here, 729px on the reported card) while the mobile @media
// band overrides `height: auto !important`. The overlay used to read the
// BASE height → vertical circles showed on a box the user cannot resize
// (dragging them would fight the !important override). resolveOverlaySize
// now folds the @media band for the replica's width in, so:
//   · desktop (both axes fixed)  → 4 corner circles
//   · mobile  (height → auto)    → left/right circles ONLY, no top/bottom
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

/** Handle-direction attributes currently in the parent frame, sorted. */
async function handleDirs(page: import('@playwright/test').Page, attr: string): Promise<string[]> {
  return page
    .locator(`[${attr}]`)
    .evaluateAll((els, a) => els.map(el => el.getAttribute(a as string) ?? '').sort(), attr);
}

test.describe('replica resize-handle visibility', () => {
  test('mobile height-auto override hides the vertical handles', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REPLICA_AUTO_HEIGHT');

    const sandbox = editor.sandbox();
    const desktopCard = sandbox.locator('[data-viewport="desktop"] [data-id="card"]').first();
    const mobileCard = sandbox.locator('[data-viewport="mobile"] [data-id="card"]').first();
    await expect(desktopCard).toBeAttached();
    await expect(mobileCard).toBeAttached();

    // Fit BOTH tiles into the camera — the mobile replica boots off-screen
    // (default camera frames the primary) and an off-camera tile is culled,
    // which would leave the overlay without rects to draw handles from.
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(600);

    // Click the card's TOP PADDING strip (24px padding; the inner child
    // starts below it) so the hit-test resolves to the card, not the child.
    // Clicks — not __e2e.select — because only the real click path primes
    // the bridge corner/rect stream for a replica tile.
    const dBox = await desktopCard.boundingBox();
    if (!dBox) throw new Error('desktop card has no boundingBox');
    await page.mouse.click(dBox.x + dBox.width / 2, dBox.y + 8);
    await expect
      .poll(() => page.evaluate(() => (window as any).__e2e.selection()), { timeout: 5_000 })
      .toEqual(['card']);

    // ── Desktop: width AND height fixed px → 4 corner circles ──────────
    await expect
      .poll(() => handleDirs(page, 'data-resize-dir'), { timeout: 5_000 })
      .toEqual(['bottomLeft', 'bottomRight', 'topLeft', 'topRight']);

    // ── Mobile replica: height overridden to auto → horizontal only ────
    // Programmatic select (same atoms the click path writes) — at 36% zoom
    // the replica's padding strip is ~8px tall, too flaky to click reliably.
    await page.evaluate(() => (window as any).__e2e.select(['card'], 'mobile'));
    await expect
      .poll(() => handleDirs(page, 'data-resize-dir'), { timeout: 5_000 })
      .toEqual(['left', 'right']);

    // No vertical edge hit-areas either — the invisible top/bottom grab
    // strips must go away with the circles.
    expect(await handleDirs(page, 'data-resize-edge')).toEqual(['left', 'right']);
  });
});
