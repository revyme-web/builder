// duplicate-pinned.spec.ts — Cmd+D / paste on a data-pinned absolute-in-frame
// node must keep the copy in the SAME parent at the SAME position. Regression:
// a `paste-pinned-to-canvas` rule diverted pinned nodes to the canvas, so the
// duplicate flew out of the hero (live find 2026-07-24, rule removed).

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('Cmd+D on a pinned absolute-in-frame node duplicates INTO the same parent', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('PINNED_ABS_IN_FRAME');
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(400);

  // hero starts with exactly one child: the pinned node.
  const heroChildrenBefore = await page.evaluate(() => {
    const s = (window as any).__e2e.nodesSnapshot();
    return s['hero']?.children ?? [];
  });
  expect(heroChildrenBefore).toEqual(['pinned']);

  await page.evaluate(() => (window as any).__e2e.select(['pinned'], 'desktop'));
  await page.waitForTimeout(150);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d');
  await page.waitForTimeout(600);

  const snap = await page.evaluate(() => (window as any).__e2e.nodesSnapshot());
  const heroChildren: string[] = snap['hero']?.children ?? [];

  // hero must now have TWO children — the original + the duplicate — NOT one
  // (which would mean the duplicate escaped to the canvas).
  expect(heroChildren.length).toBe(2);
  expect(heroChildren).toContain('pinned');

  // The duplicate is absolute at the same left/top as the source (in place).
  const dupId = heroChildren.find((id) => id !== 'pinned')!;
  const dup = snap[dupId];
  expect(dup.parentId).toBe('hero');
  expect(dup.styles?.position).toBe('absolute');
  expect(dup.styles?.left).toBe('80px');
  expect(dup.styles?.top).toBe('80px');
  // And it did NOT become a canvas node.
  expect(dup.isCanvasNode).toBeFalsy();
});
