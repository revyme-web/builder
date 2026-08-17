// viewport-width-rewrite.spec.ts — changing a viewport's breakpoint width
// (via the SizeTool Width input; the tile drag shares the same
// applyViewportWidthChange path) must re-key every width-keyed artifact:
// @media bands (incl. neighbour floors), animation gates, @canvas widths —
// in the active file AND, for templated pages, in the route group's
// LayoutClient (user report 2026-08-17: the template chrome lost its
// responsive overrides after typing a new mobile width).

import { test, expect } from '@playwright/test';

/** Rule text inside the band whose head contains `headPart`. */
function bandContent(code: string, headPart: string): string {
  for (const m of code.matchAll(/(@media[^{]*)\{([\s\S]*?)\n    \}/g)) {
    if (m[1].includes(headPart)) return m[2];
  }
  return '';
}


const PAGE = `
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{
      display: 'flex', flexDirection: 'column', gap: '0px',
      width: '100%', minHeight: '900px',
      background: '#ffffff',
    }}>
      <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="hero"] { background-color: rgb(0, 128, 0) !important; padding: 24px !important; }
    }
    @media (max-width: 375px) {
      [data-id="hero"] { background-color: rgb(255, 0, 0) !important; padding: 16px !important; }
    }
  \`}</style>
      <div data-id="hero" data-name="Hero" style={{
        height: '300px', background: 'rgb(0, 0, 255)',
      }}></div>
      <div data-id="hero-vh" data-name="HeroVh" style={{
        height: '50vh', background: 'rgb(20, 20, 20)',
      }}></div>
    </div>
  );
}
`;

const SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

test('typing a viewport width re-buckets @media overrides like drag does', async ({ page }) => {
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, {
    format: 'revyme-v1',
    files: { 'app/page.tsx': SERVER_WRAPPER, 'app/page.client.tsx': PAGE },
  });
  await page.goto('/');
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await sandbox.locator('[data-viewport="mobile"]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));

  // Select the MOBILE viewport root programmatically (tile may be culled offscreen).
  await page.evaluate(() => (window as any).__e2e.select(['root'], 'mobile'));
  await page.waitForTimeout(300);

  // Find the input currently displaying 375 (the breakpoint). If the tile
  // click didn't select the root, fall back to the parent-frame tile label.
  const findInput375 = async () => {
    for (const c of await page.locator('input').all()) {
      if ((await c.inputValue().catch(() => '')) === '375') return c;
    }
    return null;
  };
  let target = await findInput375();
  if (!target) {
    console.log('E2E-REPORT tile-click inputs:', JSON.stringify(
      await Promise.all((await page.locator('input').all()).map(c => c.inputValue().catch(() => '?')))));
    await page.getByText('Mobile', { exact: true }).first().click();
    await page.waitForTimeout(300);
    target = await findInput375();
  }
  expect(target, 'panel input showing 375 (viewport width row)').toBeTruthy();

  await target!.click({ clickCount: 3 });
  await target!.fill('400');
  await target!.press('Enter');
  await page.waitForTimeout(800);

  const after1 = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  await page.waitForTimeout(1500);
  const after2 = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));

  const heads = (c: string) => [...c.matchAll(/@media[^{]*(?=\{)/g)].map(m => m[0].trim());
  const canvasWidths = (c: string) => [...c.matchAll(/"width":\s*(\d+)/g)].map(m => m[1]);
  console.log('E2E-REPORT after-commit media:', JSON.stringify(heads(after1)));
  console.log('E2E-REPORT after-commit @canvas:', JSON.stringify(canvasWidths(after1)));
  console.log('E2E-REPORT settled media:', JSON.stringify(heads(after2)));
  console.log('E2E-REPORT settled @canvas:', JSON.stringify(canvasWidths(after2)));
  console.log('E2E-REPORT settled file identical to commit:', after1 === after2);

  // What SHOULD hold (drag parity): mobile band re-keyed 375→400, tablet floor 400.02.
  expect(heads(after2)).toContain('@media (max-width: 400px)');
  expect(heads(after2).some(h => h.includes('min-width: 400.02px'))).toBe(true);
  expect(canvasWidths(after2)).toContain('400');
  // CONTENT: pure rename — the mobile band keeps ITS rules, no tablet copy.
  expect(bandContent(after2, '(max-width: 400px)')).toContain('rgb(255, 0, 0)');
  expect(bandContent(after2, '(max-width: 400px)')).not.toContain('rgb(0, 128, 0)');
  expect(bandContent(after2, 'min-width: 400.02px')).toContain('rgb(0, 128, 0)');
});

// ── Scenario 2: TEMPLATED page — the LayoutClient must move with the page ──

const LAYOUT_CLIENT = `
'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1600, "y": 0 }, "mobile": { "x": 2528, "y": 0 } }
} */

import React, { useState, useEffect } from 'react';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  const __mq0 = useMediaQuery('(max-width: 375px)');
  void __mq0;
  return <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%', minHeight: '100vh' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="chrome"] { padding: 24px !important; }
    }
    @media (max-width: 375px) {
      [data-id="chrome"] { padding: 16px !important; }
    }
  \`}</style>
    <nav data-id="chrome" data-name="Chrome" style={{ height: '60px', background: '#eee' }}></nav>
      {children}
    </div>;
}
`;

const LAYOUT_SERVER = `import LayoutClient from './LayoutClient';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;

test('templated page: typing a width leaves the LayoutClient untouched', async ({ page }) => {
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, {
    format: 'revyme-v1',
    files: {
      'app/(Main)/layout.tsx': LAYOUT_SERVER,
      'app/(Main)/LayoutClient.tsx': LAYOUT_CLIENT,
      'app/(Main)/page.tsx': SERVER_WRAPPER.replace("'./page.client'", "'./page.client'"),
      'app/(Main)/page.client.tsx': PAGE,
    },
  });
  await page.goto('/');
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));

  await page.evaluate(() => (window as any).__e2e.openFile('app/(Main)/page.client.tsx'));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__e2e.select(['root'], 'mobile'));
  await page.waitForTimeout(300);

  let target = null as any;
  for (const c of await page.locator('input').all()) {
    if ((await c.inputValue().catch(() => '')) === '375') { target = c; break; }
  }
  expect(target, 'panel input showing 375').toBeTruthy();
  await target.click({ clickCount: 3 });
  await target.fill('400');
  await target.press('Enter');
  await page.waitForTimeout(1200);

  const pageCode = await page.evaluate(() => (window as any).__e2e.readFile('app/(Main)/page.client.tsx'));
  const layoutCode = await page.evaluate(() => (window as any).__e2e.readFile('app/(Main)/LayoutClient.tsx'));
  const heads = (c: string) => [...c.matchAll(/@media[^{]*(?=\{)/g)].map(m => m[0].trim());
  console.log('E2E-REPORT tpl page media:', JSON.stringify(heads(pageCode)));
  console.log('E2E-REPORT tpl layout media:', JSON.stringify(heads(layoutCode)));

  // Page re-keyed, with its rules intact…
  expect(heads(pageCode)).toContain('@media (max-width: 400px)');
  expect(bandContent(pageCode, '(max-width: 400px)')).toContain('rgb(255, 0, 0)');
  expect(bandContent(pageCode, '(max-width: 400px)')).not.toContain('rgb(0, 128, 0)');
  // …and the template is COMPLETELY untouched — a page resize must never
  // rewrite the template's own viewports, bands or gates ("it increases the
  // width of the template, the template should be completely intact",
  // 2026-08-18). Its bands key off the template's own breakpoints by design.
  expect(layoutCode).toBe(LAYOUT_CLIENT);
});

test('SECOND width change in a session keeps overrides (523 then 524)', async ({ page }) => {
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, {
    format: 'revyme-v1',
    files: { 'app/page.tsx': SERVER_WRAPPER, 'app/page.client.tsx': PAGE },
  });
  await page.goto('/');
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await sandbox.locator('[data-viewport="mobile"]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  await page.evaluate(() => (window as any).__e2e.select(['root'], 'mobile'));
  await page.waitForTimeout(300);

  const findInput = async (val: string) => {
    for (const c of await page.locator('input').all()) {
      if ((await c.inputValue().catch(() => '')) === val) return c;
    }
    return null;
  };

  // Change 1: 375 → 523 (typed).
  let target = await findInput('375');
  expect(target, 'input showing 375').toBeTruthy();
  await target!.click({ clickCount: 3 });
  await target!.fill('523');
  await target!.press('Enter');
  await page.waitForTimeout(1000);
  const mid = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const heads = (c: string) => [...c.matchAll(/@media[^{]*(?=\{)/g)].map(m => m[0].trim());
  console.log('E2E-REPORT step1 media:', JSON.stringify(heads(mid)));

  // Change 2: 523 → 524 — same selection, same session.
  target = await findInput('523');
  console.log('E2E-REPORT input-after-step1:', target ? '523 shown' : 'NOT FOUND');
  expect(target, 'input showing 523 after first change').toBeTruthy();
  await target!.click({ clickCount: 3 });
  await target!.fill('524');
  await target!.press('Enter');
  await page.waitForTimeout(1200);

  const done = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  console.log('E2E-REPORT step2 media:', JSON.stringify(heads(done)));
  console.log('E2E-REPORT step2 @canvas:', JSON.stringify([...done.matchAll(/"width":\s*(\d+)/g)].map(m => m[1])));

  expect(heads(done)).toContain('@media (max-width: 524px)');
  expect(heads(done).some(h => h.includes('min-width: 524.02px'))).toBe(true);
  expect(bandContent(done, '(max-width: 524px)')).toContain('rgb(255, 0, 0)');
  expect(bandContent(done, '(max-width: 524px)')).not.toContain('rgb(0, 128, 0)');
});

test('chevron hold-scrub commits ONCE and keeps overrides', async ({ page }) => {
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, {
    format: 'revyme-v1',
    files: { 'app/page.tsx': SERVER_WRAPPER, 'app/page.client.tsx': PAGE },
  });
  await page.goto('/');
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await sandbox.locator('[data-viewport="mobile"]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  await page.evaluate(() => (window as any).__e2e.select(['root'], 'mobile'));
  await page.waitForTimeout(300);

  let input = null as any;
  for (const c of await page.locator('input').all()) {
    if ((await c.inputValue().catch(() => '')) === '375') { input = c; break; }
  }
  expect(input, 'input showing 375').toBeTruthy();

  const vhHeight = async () => {
    const style = await sandbox.locator('[data-viewport="mobile"] [data-id="hero-vh"]').first().getAttribute('style');
    const m = /height:\s*([\d.]+)px/.exec(style ?? '');
    return m ? parseFloat(m[1]) : null;
  };
  const vhBefore = await vhHeight();

  // Hover the row so the chevrons render, then press-and-HOLD the up chevron
  // (fires the initial +1, then the 200ms hold-repeat at 50ms per tick).
  await input.hover();
  const up = input.locator('xpath=..').locator('button').first();
  await up.waitFor({ state: 'visible' });
  const b = await up.boundingBox();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  // vh recalculates LIVE mid-hold — not only on release ("hero jumps on
  // mouseup", 2026-08-18).
  const vhMid = await vhHeight();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const finalVal = Number(await input.inputValue());
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const heads = [...code.matchAll(/@media[^{]*(?=\{)/g)].map((m: RegExpMatchArray) => m[0].trim());
  const canvasWidths = [...code.matchAll(/"width":\s*(\d+)/g)].map((m: RegExpMatchArray) => m[1]);
  console.log('E2E-REPORT chevron final input:', finalVal);
  console.log('E2E-REPORT chevron media:', JSON.stringify(heads));
  console.log('E2E-REPORT chevron @canvas:', JSON.stringify(canvasWidths));

  expect(finalVal).toBeGreaterThan(375); // the hold actually scrubbed
  // Bands must be keyed by the FINAL width — no intermediate stranding.
  expect(heads).toContain(`@media (max-width: ${finalVal}px)`);
  expect(heads.some((h: string) => h.includes(`min-width: ${finalVal}.02px`))).toBe(true);
  expect(canvasWidths).toContain(String(finalVal));
  expect(bandContent(code, `(max-width: ${finalVal}px)`)).toContain('rgb(255, 0, 0)');
  expect(bandContent(code, `(max-width: ${finalVal}px)`)).not.toContain('rgb(0, 128, 0)');

  // vh live recalc: changed DURING the hold, and settled at the exact
  // simulated-viewport value for the final width (50vh, phone ratio 2.16
  // → 1.08 × width) so the commit render has nothing to jump to.
  console.log('E2E-REPORT vh before/mid:', vhBefore, vhMid);
  expect(vhMid).not.toBeNull();
  expect(vhMid).not.toBe(vhBefore);
  const vhAfter = await vhHeight();
  expect(vhAfter).not.toBeNull();
  expect(Math.abs(vhAfter! - 1.08 * finalVal)).toBeLessThan(1.5);
});

test('DRIFTED widths: page mobile 298 → 500 re-keys the page; template untouched', async ({ page }) => {
  // Page and template widths can legitimately differ — the page rewrite must
  // handle its own drifted band (orphan claim) while never touching the
  // template file.
  const driftedPage = PAGE
    .replace('"id": "mobile", "label": "Mobile", "width": 375', '"id": "mobile", "label": "Mobile", "width": 298')
    .replace('@media (max-width: 375px)', '@media (max-width: 298px)')
    .replace('(min-width: 375.02px)', '(min-width: 298.02px)');
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, {
    format: 'revyme-v1',
    files: {
      'app/(Main)/layout.tsx': LAYOUT_SERVER,
      'app/(Main)/LayoutClient.tsx': LAYOUT_CLIENT,   // mobile still 375 here
      'app/(Main)/page.tsx': SERVER_WRAPPER,
      'app/(Main)/page.client.tsx': driftedPage,
    },
  });
  await page.goto('/');
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  await page.evaluate(() => (window as any).__e2e.openFile('app/(Main)/page.client.tsx'));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__e2e.select(['root'], 'mobile'));
  await page.waitForTimeout(300);

  let target = null as any;
  for (const c of await page.locator('input').all()) {
    if ((await c.inputValue().catch(() => '')) === '298') { target = c; break; }
  }
  expect(target, 'input showing 298').toBeTruthy();
  await target.click({ clickCount: 3 });
  await target.fill('500');
  await target.press('Enter');
  await page.waitForTimeout(1200);

  const pageCode = await page.evaluate(() => (window as any).__e2e.readFile('app/(Main)/page.client.tsx'));
  const layoutCode = await page.evaluate(() => (window as any).__e2e.readFile('app/(Main)/LayoutClient.tsx'));
  const heads = (c: string) => [...c.matchAll(/@media[^{]*(?=\{)/g)].map(m => m[0].trim());
  console.log('E2E-REPORT drift page media:', JSON.stringify(heads(pageCode)));
  console.log('E2E-REPORT drift layout media:', JSON.stringify(heads(layoutCode)));
  console.log('E2E-REPORT drift layout gate:', JSON.stringify([...layoutCode.matchAll(/useMediaQuery\('([^']*)'\)/g)].map(m => m[1])));

  // Page: 298-keyed band → 500, rules intact (the 2026-08-17 destruction
  // regression: never a flattened tablet copy).
  expect(heads(pageCode)).toContain('@media (max-width: 500px)');
  expect(bandContent(pageCode, '(max-width: 500px)')).toContain('rgb(255, 0, 0)');
  expect(bandContent(pageCode, '(max-width: 500px)')).not.toContain('rgb(0, 128, 0)');
  // Template untouched, drift or not.
  expect(layoutCode).toBe(LAYOUT_CLIENT);
});
