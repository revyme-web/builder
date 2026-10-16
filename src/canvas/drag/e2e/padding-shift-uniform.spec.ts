// padding-shift-uniform.spec.ts — Shift + drag a padding handle sets ALL FOUR
// sides to the dragged value (user request 2026-10-16), written like the
// panel's all-sides field: a single `padding` shorthand. Without Shift the drag
// stays on its own axis.

import { test, expect, type Page } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function dragHandle(page: Page, side: string, dy: number, shift: boolean) {
  const h = page.locator(`[data-padding-handle="${side}"]`);
  await expect(h).toBeVisible();
  const b = (await h.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + (dy * i) / 8);
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(400);
}

const padding = (editor: EditorPage) => editor.node('box').evaluate((el) => {
  const cs = getComputedStyle(el);
  return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
});
const boxTag = async (editor: EditorPage) => {
  const code = await editor.getPageCode();
  return code.slice(code.indexOf('data-id="box"'), code.indexOf('data-id="inner"'));
};

test('Shift + drag: every side takes the dragged value, as one shorthand', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('PADDED_HUG_FRAME');
  await page.evaluate(() => (window as any).__e2e.select(['box']));
  await dragHandle(page, 'bottom', 24, true);

  const [t, r, b, l] = await padding(editor);
  expect(t).toBeGreaterThan(10);           // the vertical axis grew…
  expect([r, b, l]).toEqual([t, t, t]);    // …and every side matches it (left/right were 30)
  const tag = await boxTag(editor);
  expect(tag).toContain(`padding: '${t}px'`);
  expect(tag).not.toMatch(/padding(Top|Right|Bottom|Left)/);
});

test('without Shift the drag stays on its axis', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('PADDED_HUG_FRAME');
  await page.evaluate(() => (window as any).__e2e.select(['box']));
  await dragHandle(page, 'bottom', 24, false);

  const [t, r, b, l] = await padding(editor);
  expect(t).toBeGreaterThan(10);
  expect(b).toBe(t);
  expect([r, l]).toEqual([30, 30]);
});

test('releasing Shift mid-drag puts the other axis back', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('PADDED_HUG_FRAME');
  await page.evaluate(() => (window as any).__e2e.select(['box']));
  const h = page.locator('[data-padding-handle="bottom"]');
  const bb = (await h.boundingBox())!;
  const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  for (let i = 1; i <= 4; i++) await page.mouse.move(x, y + 3 * i);
  const mid = await padding(editor);
  expect(mid[1]).toBe(mid[0]);              // uniform while held
  await page.keyboard.up('Shift');
  for (let i = 5; i <= 8; i++) await page.mouse.move(x, y + 3 * i);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const [t, r, b, l] = await padding(editor);
  expect(b).toBe(t);
  expect([r, l]).toEqual([30, 30]);
});
