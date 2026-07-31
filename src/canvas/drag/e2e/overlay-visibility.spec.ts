// overlay-visibility.spec.ts — an overlay whose source node is unchanged must
// stay VISIBLE when entering overlay-edit mode. Regression: entering overlay
// mode fires a same-node-model forceRender → the root subtree is patch-skipped
// → the overlay isn't rebuilt under root → the portal stale-cleanup wrongly
// reaped it, so only the ::after dim showed (live find 2026-07-24).

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function overlayState(editor: EditorPage) {
  return editor.sandbox().locator('body').evaluate(() => {
    const ov = document.querySelector('[data-node-id="ov-a"]') as HTMLElement | null;
    if (!ov) return { exists: false } as any;
    const cs = getComputedStyle(ov);
    const r = ov.getBoundingClientRect();
    return {
      exists: true,
      inPortal: !!ov.closest('[data-overlay-portal]'),
      display: cs.display,
      visibility: cs.visibility,
      zIndex: cs.zIndex,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
    };
  });
}

test('overlay on a flex child stays visible when entering overlay mode', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('OVERLAY_ON_FLEX_CHILD');
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(400);

  // Before overlay mode: portaled + hidden by the base rule.
  const before = await overlayState(editor);
  expect(before.exists).toBe(true);
  expect(before.inPortal).toBe(true);
  expect(before.display).toBe('none');

  // Enter overlay-edit mode → the overlay must become VISIBLE (not reaped).
  await page.evaluate(() => (window as any).__e2e.openOverlay('ov-a'));
  await page.waitForTimeout(600);

  const during = await overlayState(editor);
  expect(during.exists).toBe(true);          // was the bug: overlay deleted
  expect(during.inPortal).toBe(true);
  expect(during.visible).toBe(true);
  expect(during.display).toBe('block');
  expect(during.zIndex).toBe('50');

  // Stays visible across a re-render while still in overlay mode.
  await page.waitForTimeout(400);
  expect((await overlayState(editor)).visible).toBe(true);
});

test('exiting overlay mode re-hides the overlay (no lingering ghost)', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('OVERLAY_ON_FLEX_CHILD');
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(400);

  await page.evaluate(() => (window as any).__e2e.openOverlay('ov-a'));
  await page.waitForTimeout(400);
  expect((await overlayState(editor)).visible).toBe(true);

  // Exit overlay mode → the show rule is removed → the base hide rule
  // (`[data-overlay-node]{display:none}`) applies again. The fix keeps the
  // overlay in the portal, so it must be HIDDEN (not visible) — not a ghost.
  await page.evaluate(() => (window as any).__e2e.openOverlay(null));
  await page.waitForTimeout(500);

  const after = await overlayState(editor);
  expect(after.exists).toBe(true);   // still portaled (correct)
  expect(after.visible).toBe(false); // but hidden by the base rule — no ghost
  expect(after.display).toBe('none');
});
