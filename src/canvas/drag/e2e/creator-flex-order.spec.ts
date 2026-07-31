// creator-flex-order.spec.ts — drawing a frame into a flex parent must insert
// it at the DRAWN flow position, even when siblings carry explicit `order` CSS.
// Regression: a naive insert gave the new node the default `order:0`, so it
// jumped mid-stack instead of landing where it was drawn (live find 2026-07-24).

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

// Rendered top-Y of a canvas node (parent-frame coords).
async function topY(editor: EditorPage, id: string): Promise<number> {
  const box = await editor.sandbox().locator(`[data-id="${id}"]`).first().boundingBox();
  if (!box) throw new Error(`${id} has no box`);
  return box.y;
}

test('draw a frame below the visually-last flex child → it renders LAST (order-aware)', async ({ page }) => {
  const editor = new EditorPage(page);
  // FLEX_COL_ORDERED: DOM a,b,c but order 2/0/1 → visual top-to-bottom b, c, a.
  await editor.gotoWithSeed('FLEX_COL_ORDERED');
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(500);

  const aBox = await editor.nodeBox('a'); // visually LAST (order 2)
  const cx = aBox.x + aBox.width / 2;
  const y0 = aBox.y + aBox.height + 40; // clearly BELOW the visually-last child

  await page.keyboard.press('f');
  await editor.dragFromTo({ x: cx - 150, y: y0 }, { x: cx + 150, y: y0 + 120 });
  await page.waitForTimeout(700);

  // Find the new frame id (the 4th root descendant).
  const code = await editor.getPageCode();
  const ids = (code.match(/data-id="([^"]+)"/g) ?? []).map(s => s.slice(9, -1));
  const newId = ids.find(id => id.startsWith('frame-'))!;
  expect(newId).toBeTruthy();

  // Rendered vertical order must be b, c, a, NEW — the new frame is BELOW `a`
  // (the previously-last), NOT mid-stack.
  const [yB, yC, yA, yNew] = await Promise.all([
    topY(editor, 'b'), topY(editor, 'c'), topY(editor, 'a'), topY(editor, newId),
  ]);
  expect(yB).toBeLessThan(yC);
  expect(yC).toBeLessThan(yA);
  expect(yA).toBeLessThan(yNew);   // the fix — new frame is visually LAST
});

test('draw a frame between two ordered children lands between them visually', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('FLEX_COL_ORDERED'); // visual: b(top), c(mid), a(bottom)
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(500);

  // Draw a small frame whose CENTER sits in b's lower half (below b's midpoint,
  // above the b/c boundary) → unambiguously inserts BETWEEN b and c. gap:0 makes
  // the exact boundary ambiguous, so aim clearly inside b's lower region.
  const bBox = await editor.nodeBox('b');
  const cx = bBox.x + bBox.width / 2;
  const yCenter = bBox.y + bBox.height * 0.75; // lower half of b
  const half = Math.min(18, bBox.height * 0.2);

  await page.keyboard.press('f');
  await editor.dragFromTo({ x: cx - 100, y: yCenter - half }, { x: cx + 100, y: yCenter + half });
  await page.waitForTimeout(700);

  const code = await editor.getPageCode();
  const ids = (code.match(/data-id="([^"]+)"/g) ?? []).map(s => s.slice(9, -1));
  const newId = ids.find(id => id.startsWith('frame-'))!;

  const [yB, yNew, yC, yA] = await Promise.all([
    topY(editor, 'b'), topY(editor, newId), topY(editor, 'c'), topY(editor, 'a'),
  ]);
  // Visual order must be b, NEW, c, a.
  expect(yB).toBeLessThan(yNew);
  expect(yNew).toBeLessThan(yC);
  expect(yC).toBeLessThan(yA);
});
