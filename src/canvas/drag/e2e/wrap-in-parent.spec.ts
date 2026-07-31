// wrap-in-parent.spec.ts — Create Layout / Create Frame (wrap the selection in a
// new parent) must NOT move the child visually. Regression: wrapping a centered
// absolute SVG (`left: 68.5417%` + `translate(-50%,-50%)`) flew ~900px off
// because the parseFloat bbox read the % as px (live find 2026-07-24). The fix
// has the wrapper inherit the child's exact positioning verbatim.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function starRect(editor: EditorPage) {
  const box = await editor.sandbox().locator('[data-id="star"]').first().boundingBox();
  if (!box) throw new Error('star has no boundingBox');
  return box;
}

test.describe('wrap in parent keeps the child visually put', () => {
  test('Create Layout (Shift+A) on a centered absolute SVG does not move it', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CENTERED_ABS_SVG');
    await page.keyboard.press('Shift+Digit1'); // zoom-to-fit
    await page.waitForTimeout(400);

    const before = await starRect(editor);
    await page.evaluate(() => (window as any).__e2e.select(['star'], 'desktop'));
    await page.waitForTimeout(150);
    await page.keyboard.press('Shift+KeyA'); // Create Layout
    await page.waitForTimeout(600);

    const after = await starRect(editor);
    // Same screen position within a couple px (rounding).
    expect(Math.abs(after.x - before.x)).toBeLessThan(3);
    expect(Math.abs(after.y - before.y)).toBeLessThan(3);
    expect(Math.abs(after.width - before.width)).toBeLessThan(3);
    expect(Math.abs(after.height - before.height)).toBeLessThan(3);

    // And the star is now nested under a NEW wrapper (not still a direct child of hero).
    const parentTag = await editor.sandbox().locator('[data-id="star"]').first().evaluate((el) => {
      const p = el.parentElement;
      return p?.getAttribute('data-id') ?? null;
    });
    expect(parentTag).not.toBe('hero');
    expect(parentTag).not.toBeNull();
  });

  test('Create Frame (Shift+Alt+A) on a centered absolute SVG does not move it', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CENTERED_ABS_SVG');
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(400);

    const before = await starRect(editor);
    await page.evaluate(() => (window as any).__e2e.select(['star'], 'desktop'));
    await page.waitForTimeout(150);
    await page.keyboard.press('Shift+Alt+KeyA'); // Create Frame
    await page.waitForTimeout(600);

    const after = await starRect(editor);
    expect(Math.abs(after.x - before.x)).toBeLessThan(3);
    expect(Math.abs(after.y - before.y)).toBeLessThan(3);
  });
});
