// locale-rtl-text-only.spec.ts — a right-to-left language flips the TEXT, never
// the layout (user report 2026-10-16: adding Arabic mirrored the whole site —
// the nav row reversed, an untranslated label jumped right).
//
//   • Canvas: the content root gets `lang`, no `dir`; rows keep their order;
//     Arabic reads right to left inside its own box.
//   • Preview / live (the REAL generated app/providers.tsx — the editor builds
//     it from i18n/config.json at load): the same, no `dir` anywhere.
// The seed's Arabic carries a legacy `direction: 'rtl'`; it must be ignored.

import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

/** Left edges of the nav row's children, and where the two text lines'
 *  glyphs sit inside their own boxes. */
async function measure(frame: FrameLocator) {
  return frame.locator('body').evaluate(() => {
    const el = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;
    const glyphs = (id: string) => {
      const r = document.createRange();
      r.selectNodeContents(el(id));
      const g = r.getBoundingClientRect();
      const b = el(id).getBoundingClientRect();
      return { fromLeft: Math.round(g.left - b.left), fromRight: Math.round(b.right - g.right) };
    };
    const left = (id: string) => el(id).getBoundingClientRect().left;
    return {
      row: { logo: left('logo'), link: left('link'), contact: left('contact') },
      arabic: glyphs('arabic'),
      english: glyphs('english'),
      anyDir: document.querySelectorAll('[dir]').length,
    };
  });
}

async function activateArabic(page: Page) {
  await page.locator('[data-tutorial="locale-button"]').click();
  await page.getByText('Arabic', { exact: true }).click();
  await page.waitForTimeout(400);
}

function expectTextOnly(m: Awaited<ReturnType<typeof measure>>) {
  expect(m.anyDir).toBe(0);
  expect(m.row.logo).toBeLessThan(m.row.link);
  expect(m.row.link).toBeLessThan(m.row.contact);
  expect(m.arabic.fromRight).toBeLessThan(m.arabic.fromLeft);   // starts at the right of its box
  expect(m.english.fromLeft).toBeLessThan(m.english.fromRight);  // untranslated English stays left
}

test.describe('RTL language: text flips, layout never does', () => {
  test('canvas in Arabic', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('RTL_TEXT');
    await activateArabic(page);

    await expect(editor.sandbox().locator('[data-content-root]').first()).toHaveAttribute('lang', 'ar');
    expectTextOnly(await measure(editor.sandbox()));
  });

  test('preview in Arabic (generated providers)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('RTL_TEXT');
    const providers = await page.evaluate(() => (window as any).__e2e.readFile('app/providers.tsx') as string);
    expect(providers).toContain('@revyme-providers v4');
    await activateArabic(page);

    await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
    const frame = page.frameLocator('iframe[src*="5175"]');
    await frame.locator('[data-id="arabic"]').waitFor({ timeout: 20_000 });
    await expect(frame.locator('div[lang="ar"] > style')).toHaveCount(1);   // the text rule, server-rendered
    expectTextOnly(await measure(frame));
  });
});
