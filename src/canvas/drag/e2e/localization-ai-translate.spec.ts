// AI Translate in the Localization view: estimate quote → confirm → batch
// translate → rows written through the messages pipeline. The AI service is
// MOCKED (route interception) — the real endpoint lives in ai-generator
// (/api/translate[/estimate]) with the freeform-turn credit pattern.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('AI Translate estimates, confirms and fills missing translations', async ({ page }) => {
  await page.route('**/api/translate/estimate', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { success: true, credits: 3, itemCount: body.items.length } });
  });
  await page.route('**/api/translate', async route => {
    const body = route.request().postDataJSON();
    const translations: Record<string, string> = {};
    for (const it of body.items) translations[it.key] = `FR:${it.text}`;
    await route.fulfill({ json: { success: true, translations, usage: { model: 'mock', inputTokens: 1, outputTokens: 1, costUsd: 0.01 } } });
  });

  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_TEXT');
  await page.locator('[data-tutorial="locale-button"]').click();
  await page.getByText('Manage Translations').click();
  await expect(page.locator('[data-localization-section]').first()).toBeVisible();

  const btn = page.locator('[data-ai-translate]');
  await expect(btn).toBeEnabled();
  await btn.click();
  const confirm = page.locator('[data-ai-translate-confirm]');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText('~3 credits')).toBeVisible();

  await page.locator('[data-ai-translate-run]').click();
  await page.waitForTimeout(800);

  // The intro row now holds the mock translation, persisted to messages/fr.
  const row = page.locator('[data-localization-row="app/page.client.tsx:intro"]');
  await expect(row.locator('textarea')).toHaveValue('FR:Painter');
  const fr = await page.evaluate(() => (window as any).__e2e.readFile('messages/fr.json'));
  const frNs = JSON.parse(fr ?? '{}');
  expect(frNs?.[Object.keys(frNs)[0]]?.intro).toBe('FR:Painter');
});
