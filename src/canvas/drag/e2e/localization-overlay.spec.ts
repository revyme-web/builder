// Localization view (rewritten overlay): CMS-style full-workspace layout,
// page sections with source→target rows, live commit, URL param mirror.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('localization overlay lists pages and commits translations', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_TEXT');
  await page.locator('[data-tutorial="locale-button"]').click();
  await page.getByText('Manage Translations').click();

  // (The portal wrapper is zero-size — assert on the fixed panes inside.)
  await expect(page.locator('[data-localization-section]').first()).toBeVisible();
  expect(page.url()).toContain('localization=fr');
  const row = page.locator('[data-localization-row="app/page.client.tsx:intro"]');
  await expect(row).toBeVisible();
  await expect(row.getByText('Painter')).toBeVisible();

  // Translate via the row → messages/fr.json + JSX transform.
  const ta = row.locator('textarea');
  await ta.fill('Peintre');
  await ta.press('Enter');
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => ({
    code: (window as any).__e2e.readFile('app/page.client.tsx'),
    fr: (window as any).__e2e.readFile('messages/fr.json'),
  }));
  expect(state.code).toMatch(/\{t\(["']intro["']\)\}/);
  const frNs = JSON.parse(state.fr ?? '{}');
  expect(frNs?.[Object.keys(frNs)[0]]?.intro).toBe('Peintre');

  // Bottom toolbar hidden while the overlay is open.
  await expect(page.locator('[data-tutorial="shape-tool"]')).toHaveCount(0);

  // Close via Escape → URL param cleared.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-localization-overlay]')).toHaveCount(0);
  expect(page.url()).not.toContain('localization=');
});
