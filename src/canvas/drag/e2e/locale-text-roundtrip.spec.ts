// Localization Phase 1 regression — the "Peintre stays in English / empty
// after page switch" report (2026-07-21).
//
// Flow: activate French → edit "Painter" → "Peintre" on canvas → switch back
// to English → the ORIGINAL text must return (the JSX is now `{t('intro')}`
// and the default text lives in messages/en.json, seeded at transform time).
// A full reload (fresh parse of the transformed JSX) must still show the
// English text — pre-fix this rendered EMPTY because the default message was
// never reliably seeded and the canvas resolution silently dropped entries.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('locale text roundtrip', () => {
  test('French edit, English restore, reload persistence', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('LOCALE_TEXT');
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(500);

    const sandbox = editor.sandbox();
    const intro = sandbox.locator('[data-viewport="desktop"] [data-id="intro"]').first();
    await expect(intro).toHaveText('Painter');

    // ── Activate French via the Localization panel ─────────────────────
    await page.locator('[data-tutorial="locale-button"]').click();
    await page.getByText('French', { exact: true }).click();
    await page.waitForTimeout(400);

    // ── Edit the text on canvas: dblclick → TipTap overlay (parent frame) ──
    const box = await intro.boundingBox();
    if (!box) throw new Error('no intro box');
    // Two spaced clicks, not mouse.dblclick — playwright fires the pair <50ms
  // apart and the controller's duplicate-event guard (timeDiff > 50) drops it.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(120);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const editorEl = sandbox.locator('[contenteditable="true"]').first();
    await expect(editorEl).toBeVisible({ timeout: 5_000 });
    // VISIBLE ≠ FOCUSED. TipTap mounts, then takes a frame to place the
    // caret; typing into that gap loses the first keystroke and the
    // select-all replacement eats the second instead ("Peintre" → "eintre",
    // reproduced ~1 run in 3). Let focus settle before driving the keyboard.
    await page.waitForTimeout(250);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type('Peintre');
    await page.keyboard.press('Escape');
    await expect(intro).toHaveText('Peintre', { timeout: 5_000 });

    // The JSX must now carry the translation call and messages seeded.
    const state = await page.evaluate(() => ({
      code: (window as any).__e2e.readFile('app/page.client.tsx'),
      en: (window as any).__e2e.readFile('messages/en.json'),
      fr: (window as any).__e2e.readFile('messages/fr.json'),
    }));
    // NOTE quote-agnostic: the babel printer emits t("intro") with DOUBLE
    // quotes — the old canvas resolution string-matched t('intro') and
    // dropped every translated message as "orphaned" (the root cause of the
    // Peintre report). The parser-based detection reads the AST instead.
    expect(state.code).toMatch(/\{t\(["']intro["']\)\}/);
    const enNs = JSON.parse(state.en ?? '{}');
    expect(enNs?.[Object.keys(enNs)[0]]?.intro).toBe('Painter');
    const frNs = JSON.parse(state.fr ?? '{}');
    expect(frNs?.[Object.keys(frNs)[0]]?.intro).toBe('Peintre');

    // ── Switch back to English: the original text must return ──────────
    await page.getByText('English', { exact: true }).first().click();
    await expect(intro).toHaveText('Painter', { timeout: 5_000 });

    // ── Full reload: fresh parse of the transformed JSX must still show
    //    the default text (pre-fix: EMPTY). ─────────────────────────────
    await page.waitForTimeout(2500); // autosave debounce → localStorage
    await page.reload();
    const introAfter = editor.sandbox().locator('[data-viewport="desktop"] [data-id="intro"]').first();
    await expect(introAfter).toHaveText('Painter', { timeout: 30_000 });
  });
});
