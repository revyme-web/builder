// Dragging a flex child OUT of the TABLET replica onto the canvas must hide
// it ONLY on tablet — desktop and mobile keep showing it — and Cmd+Z must
// bring the tablet copy back.
//
// Repro of the "hid on mobile too" report: the tablet band was emitted as
// `@media (max-width: 768px) and (min-width: 375px)` — an INCLUSIVE lower
// bound that also matched the mobile tile at exactly 375px, so the tablet's
// `display: none !important` leaked onto mobile (which has no band of its
// own to win it back). Bands now emit `min-width: 375.02px` (exclusive in
// practice, still catches fractional phone widths).
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

// 3 tiles side by side: at the default 1280×720 window the tablet tile lands
// under the right properties panel and pointer events never reach the canvas.
test.use({ viewport: { width: 1720, height: 1000 } });

test.describe('replica drag-out (3 viewports)', () => {
  test('tablet drag-out hides tablet only; undo restores the tablet copy', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('LOCALE_3VP');
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(600);

    const sandbox = editor.sandbox();
    const tabletInner = sandbox.locator('[data-viewport="tablet"] [data-id="card-inner"]').first();
    const mobileInner = sandbox.locator('[data-viewport="mobile"] [data-id="card-inner"]').first();
    const desktopInner = sandbox.locator('[data-viewport="desktop"] [data-id="card-inner"]').first();

    const tabletBox = await tabletInner.boundingBox();
    const tabletVp = await sandbox.locator('[data-viewport="tablet"]').first().boundingBox();
    if (!tabletBox || !tabletVp) throw new Error('tablet boxes missing');

    // Drag the tablet card-inner to empty canvas below the tablet tile.
    const from = { x: tabletBox.x + tabletBox.width / 2, y: tabletBox.y + tabletBox.height / 2 };
    const to = { x: tabletVp.x + tabletVp.width / 2, y: tabletVp.y + tabletVp.height + 80 };
    await editor.dragFromTo(from, to, { steps: 16 });
    await page.waitForTimeout(400);

    // Tablet copy hidden, desktop AND mobile still visible.
    await expect(tabletInner).toBeHidden();
    await expect(desktopInner).toBeVisible();
    await expect(mobileInner).toBeVisible();

    // The hide landed in the TABLET band only, with the exclusive lower bound.
    const code = await editor.getPageCode();
    const tabletBand = code.match(/@media \(max-width: 768px\) and \(min-width: 375\.02px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(tabletBand).toMatch(/\[data-id="card-inner"\][^}]*display:\s*none/);
    const mobileBand = code.match(/@media \(max-width: 375px\)[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(mobileBand).not.toMatch(/\[data-id="card-inner"\][^}]*display:\s*none/);

    // Undo: the tablet copy must reappear IN THE DOM (not only after a page
    // switch) and the canvas clone must be gone.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(800);

    await expect(tabletInner).toBeVisible();
    await expect(mobileInner).toBeVisible();
    const undone = await editor.getPageCode();
    expect(undone).not.toMatch(/\[data-id="card-inner"\][^}]*display:\s*none/);
  });
});
