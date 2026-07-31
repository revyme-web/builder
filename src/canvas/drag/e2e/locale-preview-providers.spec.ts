// Preview must render t() pages inside the layout's Providers — the bare
// createEmptyProject layout used to crash every localized page (preview AND
// live build) with a missing NextIntlClientProvider context.
import { test, expect } from '@playwright/test';
test('preview renders a t() page inside providers', async ({ page }) => {
  await page.addInitScript(() => { window.localStorage.setItem('revyme-onboarding-completed', 'true'); });
  await page.goto('/noauth');
  await page.frameLocator('iframe[src*="5174"]').locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const e2e = (window as any).__e2e;
    e2e.writeFile('app/page.client.tsx', `'use client';
/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */
import { useTranslations } from 'next-intl';
export default function Page() {
  const t = useTranslations('home');
  return (<div data-id="root" style={{ width: '100%', minHeight: '400px', position: 'relative', background: '#111' }}>
    <p data-id="intro" style={{ position: 'relative', color: '#fff' }}>{t('intro')}</p>
  </div>);
}
`);
    e2e.writeFile('messages/en.json', JSON.stringify({ home: { intro: 'Painter' } }));
  });
  await page.waitForTimeout(500);
  const errs: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errs.push('PAGEERR ' + String(e).slice(0, 300)));
  // Open the preview overlay.
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await page.waitForTimeout(5000);
  const body = await frame.locator('body').innerText().catch(() => 'FRAME-ERR');
  // The layout's Providers supply the next-intl context — the page renders
  // its translated copy, no "NextIntlClientProvider was not found" crash.
  expect(body).toContain('Painter');
  expect(errs.filter(e => e.includes('NextIntlClientProvider'))).toHaveLength(0);
});
