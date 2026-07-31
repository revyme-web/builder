// Translation mode (localization overhaul Phases 2/3):
// with a non-default locale active, the right panel is ONLY per-locale text
// fields for translatable content (empty state otherwise), edit handles are
// hidden, and input placeholders are localizable per locale.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('translation mode', () => {
  test('panel swap, empty state, placeholder localization, Done pill', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('LOCALE_TEXT');
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(500);

    // ── Activate French ────────────────────────────────────────────────
    await page.locator('[data-tutorial="locale-button"]').click();
    await page.getByText('French', { exact: true }).click();
    await page.waitForTimeout(400);

    // ── Text node: panel becomes per-locale text areas ─────────────────
    await page.evaluate(() => (window as any).__e2e.select(['intro']));
    await expect(page.locator('[data-translation-panel]')).toBeVisible();
    await expect(page.locator('[data-locale-field="English"] textarea')).toHaveValue('Painter');
    const frField = page.locator('[data-locale-field="French"] textarea');
    await expect(frField).toBeVisible();
    // No style tools anywhere in the panel.
    await expect(page.locator('[data-translation-panel]').getByText('Dimensions')).toHaveCount(0);

    // Resize handles hidden in translation mode (selection border only).
    expect(await page.locator('[data-resize-dir]').count()).toBe(0);

    // ── Translate via the panel: canvas updates + storage lands ────────
    await frField.fill('Peintre');
    await frField.press('Enter');
    await page.waitForTimeout(600);
    const intro = editor.sandbox().locator('[data-viewport="desktop"] [data-id="intro"]').first();
    await expect(intro).toHaveText('Peintre');
    const state = await page.evaluate(() => ({
      code: (window as any).__e2e.readFile('app/page.client.tsx'),
      fr: (window as any).__e2e.readFile('messages/fr.json'),
    }));
    expect(state.code).toMatch(/\{t\(["']intro["']\)\}/);
    const frNs = JSON.parse(state.fr ?? '{}');
    expect(frNs?.[Object.keys(frNs)[0]]?.intro).toBe('Peintre');

    // ── Non-text node: empty state ─────────────────────────────────────
    await page.evaluate(() => (window as any).__e2e.select(['root']));
    await expect(page.locator('[data-translation-empty]')).toBeVisible();

    // ── Input placeholder: per-locale fields, French write transforms ──
    await page.evaluate(() => (window as any).__e2e.select(['email-input']));
    const phFr = page.locator('[data-locale-field="French"] textarea').last();
    await expect(page.locator('[data-locale-field="English"] textarea').last()).toHaveValue('jane@example.com');
    await phFr.fill('jeanne@exemple.fr');
    await phFr.press('Enter');
    await page.waitForTimeout(600);
    const state2 = await page.evaluate(() => ({
      code: (window as any).__e2e.readFile('app/page.client.tsx'),
      fr: (window as any).__e2e.readFile('messages/fr.json'),
    }));
    expect(state2.code).toMatch(/placeholder=\{t\(["']email-input__attr_placeholder["']\)\}/);
    const frNs2 = JSON.parse(state2.fr ?? '{}');
    expect(frNs2?.[Object.keys(frNs2)[0]]?.['email-input__attr_placeholder']).toBe('jeanne@exemple.fr');

    // ── Done pill returns to the default locale + normal panel ─────────
    const pill = page.locator('[data-translation-pill]');
    await expect(pill).toBeVisible();
    await pill.getByText('Done').click();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-translation-panel]')).toHaveCount(0);
    await expect(intro).toHaveText('Painter');
  });
});
