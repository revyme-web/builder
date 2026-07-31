// frame-encapsulation.spec.ts — drawing a frame OVER existing nodes must make
// EVERY fully-covered node a child, including AUTO-sized text. Regression: the
// encapsulation read inline width/height and skipped `width: auto` text
// (parseFloat('auto')=0), so a drawn frame captured a px box but not the text
// sitting right next to it (live find 2026-07-24). The fix falls back to the
// live canvas rect for auto/non-px-sized candidates.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function parentOf(editor: EditorPage, id: string): Promise<string | null> {
  return editor.sandbox().locator(`[data-id="${id}"]`).first().evaluate((el) => {
    const p = (el.parentElement as HTMLElement | null);
    return p?.getAttribute('data-id') ?? null;
  });
}

test('draw a frame over an auto-text + a px box → BOTH become children', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('ENCAPSULATE_MIXED');
  await page.keyboard.press('Shift+Digit1'); // zoom-to-fit
  await page.waitForTimeout(400);

  // Both start as direct children of hero.
  expect(await parentOf(editor, 'cap')).toBe('hero');
  expect(await parentOf(editor, 'box')).toBe('hero');

  // Draw a frame that fully covers BOTH (they're stacked in the top-left of hero).
  const capBox = await editor.nodeBox('cap');
  const boxBox = await editor.nodeBox('box');
  const minX = Math.min(capBox.x, boxBox.x) - 20;
  const minY = Math.min(capBox.y, boxBox.y) - 20;
  const maxX = Math.max(capBox.x + capBox.width, boxBox.x + boxBox.width) + 20;
  const maxY = Math.max(capBox.y + capBox.height, boxBox.y + boxBox.height) + 20;

  await page.keyboard.press('f');
  await editor.dragFromTo({ x: minX, y: minY }, { x: maxX, y: maxY });
  await page.waitForTimeout(700);

  // Both must now be nested under the SAME new frame (not hero, not different).
  const capParent = await parentOf(editor, 'cap');
  const boxParent = await parentOf(editor, 'box');
  expect(capParent).not.toBe('hero');   // the text WAS the bug — must be captured now
  expect(boxParent).not.toBe('hero');
  expect(capParent).not.toBeNull();
  expect(capParent).toBe(boxParent);    // same wrapper frame
});

// Canvas-node counterpart: two CANVAS nodes (auto text + px box). The auto text
// went through the live-rect fallback, which passed vpId '' — but
// getViewportPrefix('') yields the bogus prefix '-', so findNodeRect missed and
// the canvas text was NEVER captured (live find 2026-07-24). Canvas rects are
// keyed under the primary '' prefix (vpId 'desktop').
test('draw a frame over a CANVAS auto-text + a canvas px box → BOTH become children', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('ENCAPSULATE_CANVAS_MIXED');
  await page.keyboard.press('Shift+Digit1'); // zoom-to-fit (canvas nodes sit off-viewport)
  await page.waitForTimeout(600);

  const capBox = await editor.sandbox().locator('[data-id="cap"]').first().boundingBox();
  const boxBox = await editor.sandbox().locator('[data-id="box"]').first().boundingBox();
  if (!capBox || !boxBox) throw new Error('canvas nodes not visible');

  const minX = Math.min(capBox.x, boxBox.x) - 25;
  const minY = Math.min(capBox.y, boxBox.y) - 25;
  const maxX = Math.max(capBox.x + capBox.width, boxBox.x + boxBox.width) + 25;
  const maxY = Math.max(capBox.y + capBox.height, boxBox.y + boxBox.height) + 25;

  await page.keyboard.press('f');
  await editor.dragFromTo({ x: minX, y: minY }, { x: maxX, y: maxY });
  await page.waitForTimeout(700);

  const capParent = await parentOf(editor, 'cap');
  const boxParent = await parentOf(editor, 'box');
  expect(capParent).not.toBeNull();      // the canvas text was the bug
  expect(boxParent).not.toBeNull();
  expect(capParent).toBe(boxParent);     // same new canvas frame
});
