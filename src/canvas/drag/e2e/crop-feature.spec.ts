// crop-feature.spec.ts — the full Crop flow: Fill popup → Image tab → Crop
// button → modal → drag a handle → Apply → the fill's backgroundImage is a NEW
// (cropped) data URL, and Cmd+Z reverts to the original.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function bgImage(editor: EditorPage): Promise<string> {
  const snap = await editor.page().evaluate(() => (window as any).__e2e.nodesSnapshot());
  return snap['pic']?.styles?.backgroundImage ?? '';
}

test('crop an image fill → replaces it with the cropped upload; Cmd+Z reverts', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('IMAGE_FILL_NODE');
  await page.waitForTimeout(300);

  const original = await bgImage(editor);
  expect(original).toContain('data:image/png');

  // Select the image node → the Fill control appears in the panel.
  await page.evaluate(() => (window as any).__e2e.select(['pic'], 'desktop'));
  await page.waitForTimeout(300);

  // Open the Fill popup: the Fill row shows the "Image" label.
  await page.getByText('Image', { exact: true }).first().click();
  await page.waitForTimeout(200);

  // Ensure the Image tab is active (it should be, since the fill IS an image),
  // then click Crop.
  const cropBtn = page.getByRole('button', { name: 'Crop' });
  await cropBtn.waitFor({ state: 'visible', timeout: 5000 });
  await cropBtn.click();

  // The crop modal loads the image.
  const stage = page.locator('[data-crop-stage]');
  await stage.waitFor({ state: 'visible', timeout: 5000 });
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error('crop stage has no box');

  // Drag the SE handle inward by ~40% so the crop becomes a partial region.
  const se = page.locator('[data-crop-handle="se"]');
  const seBox = await se.boundingBox();
  if (!seBox) throw new Error('SE handle has no box');
  const fromX = seBox.x + seBox.width / 2;
  const fromY = seBox.y + seBox.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX - stageBox.width * 0.4, fromY - stageBox.height * 0.4, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  // Apply → crop + upload + style write.
  await page.locator('[data-crop-apply]').click();

  // The fill's backgroundImage must change to a NEW data URL (local upload =
  // data URL of the cropped PNG) — different from the original.
  await expect.poll(async () => await bgImage(editor), { timeout: 8000 }).not.toBe(original);
  const cropped = await bgImage(editor);
  expect(cropped).toContain('data:image/png');
  expect(cropped).toContain('url(');

  // Let the history debounce (~300ms) commit the crop as its own step before
  // undoing (a real user isn't Cmd+Z-ing within a third of a second).
  await page.waitForTimeout(600);

  // Undo restores the original image.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => await bgImage(editor), { timeout: 5000 }).toBe(original);
});
