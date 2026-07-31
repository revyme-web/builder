// Preview must render the generated /fr locale route — repro of the "blank
// page when switching locale in preview" report. Two independent bugs:
//   1. preview router only routed page.client.tsx files (locale wrappers are
//      plain page.tsx → /fr had no route);
//   2. PreviewOverlay only pushed project files on the FIRST preview:ready —
//      an in-iframe navigation (the switcher's location.assign) reloads the
//      iframe, whose fresh instance waited for files forever → blank body.
// Fixtures are minimal inline equivalents of providers-gen/locale-route-ops
// output (the generators have their own unit tests; this spec's subject is
// the preview ROUTER + the files RE-HANDSHAKE). NOTE: no page.reload() —
// __e2e.writeFile state does not survive a reload in this harness.
import { test, expect } from '@playwright/test';

const PROVIDERS = `'use client';
/** @revyme-providers v2 (spec-inline minimal) */
import { usePathname } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en.json';
import frMessages from '@/messages/fr.json';
const messagesByLocale = { en: enMessages, fr: frMessages };
const DEFAULT_LOCALE = 'en';
function localeFromPath(p) {
  const seg = (p || '/').split('/')[1];
  return seg && seg !== DEFAULT_LOCALE && messagesByLocale[seg] ? seg : null;
}
export function Providers({ children }) {
  const routeLocale = localeFromPath(usePathname());
  const locale = routeLocale ?? DEFAULT_LOCALE;
  return (
    <NextIntlClientProvider locale={locale} messages={messagesByLocale[locale]}>
      <div lang={locale} style={{ display: 'contents' }}>{children}</div>
    </NextIntlClientProvider>
  );
}
`;

const WRAPPER = `/** @revyme-locale-route fr — spec-inline minimal wrapper */
export { default } from '@/app/page';
`;

test('preview renders /fr wrapper route with French text', async ({ page }) => {
  await page.addInitScript(() => { window.localStorage.setItem('revyme-onboarding-completed', 'true'); });
  await page.goto('/noauth');
  await page.frameLocator('iframe[src*="5174"]').locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(({ providers, wrapper }) => {
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
    e2e.writeFile('i18n/config.json', JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }] }));
    e2e.writeFile('messages/en.json', JSON.stringify({ home: { intro: 'Painter' } }));
    e2e.writeFile('messages/fr.json', JSON.stringify({ home: { intro: 'Peintre' } }));
    e2e.writeFile('app/providers.tsx', providers);
    e2e.writeFile('app/fr/page.tsx', wrapper);
  }, { providers: PROVIDERS, wrapper: WRAPPER });
  await page.waitForTimeout(500);

  const errs: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
  page.on('pageerror', e => errs.push('PAGEERR ' + String(e).slice(0, 400)));

  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator('body').filter({ hasText: 'Painter' }).waitFor({ timeout: 15000 }).catch(() => {});
  const home = await frame.locator('body').innerText().catch(() => 'FRAME-ERR');
  expect(home).toContain('Painter');

  // Navigate the preview iframe to /fr (what the switcher's location.assign
  // does — a full in-iframe reload, exercising the files re-handshake).
  await page.evaluate(() => {
    const ifr = Array.from(document.querySelectorAll('iframe')).find(f => (f as HTMLIFrameElement).src.includes('5175')) as HTMLIFrameElement;
    const u = new URL(ifr.src);
    u.pathname = '/fr';
    ifr.src = u.href;
  });
  await frame.locator('body').filter({ hasText: 'Peintre' }).waitFor({ timeout: 15000 }).catch(() => {});
  const fr = await frame.locator('body').innerText().catch(() => 'FRAME-ERR');
  expect(fr).toContain('Peintre');
  expect(errs.filter(e => e.includes('NextIntlClientProvider'))).toHaveLength(0);
});
