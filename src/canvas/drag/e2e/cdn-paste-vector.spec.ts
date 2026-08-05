// cdn-paste-vector.spec.ts — E2E debug for pasting a CDN VECTOR URL.
//
// Same flow as cdn-paste.spec.ts but with a `/vectors/` URL — the
// vector pipeline should:
//   1. Detect the URL prefix and tag the inserted instance with
//      `name="icon-1"` (so the icon-set component renders a single
//      icon, not its master grid view).
//   2. Add the URL `import` line to the active page.
//   3. Mount the bundle inside the sandbox iframe and render an icon.
//
// Run headed:
//   npx playwright test cdn-paste-vector.spec.ts --headed

import { test, expect, type Frame } from '@playwright/test';

const VECTOR_URL = 'https://assets.revyme.app/vectors/ViLiTi@81babf14ba7dc7ca.js';

test('paste CDN vector URL into /builder/noauth and see what happens', async ({ page, context, browserName }) => {
  // MANUAL DIAGNOSTIC, not a regression test: this drives /builder/noauth
  // (cloud-mode routing) and fetches a live bundle from assets.revyme.app,
  // so it fails in the default local run for environmental reasons that say
  // nothing about the product. Kept runnable on demand:
  //   E2E_CDN=1 npx playwright test cdn-paste --headed
  test.skip(!process.env.E2E_CDN, 'manual CDN diagnostic — set E2E_CDN=1 to run');

  // ─── Capture EVERYTHING ───────────────────────────────────────────────
  const consoleEvents: Array<{ src: string; type: string; text: string; loc?: string }> = [];
  const networkRequests: Array<{ url: string; status?: number; method: string; resourceType: string }> = [];
  const pageErrors: Array<{ message: string; stack?: string }> = [];

  page.on('console', (msg) => {
    consoleEvents.push({
      src: 'top',
      type: msg.type(),
      text: msg.text(),
      loc: `${msg.location().url}:${msg.location().lineNumber}`,
    });
  });

  page.on('frameattached', (frame) => {
    consoleEvents.push({ src: 'frameattached', type: 'info', text: `frame attached: ${frame.url()}` });
  });

  page.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
  });

  page.on('request', (req) => {
    networkRequests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
    });
  });

  page.on('response', (res) => {
    const entry = networkRequests.find(r => r.url === res.url() && r.status === undefined);
    if (entry) entry.status = res.status();
  });

  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }

  await page.goto('/builder/noauth');
  await page.waitForSelector('text=File', { timeout: 30_000 });

  console.log('\n─── editor mounted ───');

  const sandboxFrame = page.frames().find(f => f.url().includes('5174'))
    ?? await new Promise<Frame>((resolve) => {
      page.on('framenavigated', (f) => {
        if (f.url().includes('5174')) resolve(f as any);
      });
    });

  await sandboxFrame.waitForSelector('#sandbox-root', { timeout: 15_000 });
  console.log('─── sandbox iframe loaded ───');

  // ─── Paste the URL ───────────────────────────────────────────────────
  await page.locator('body').click({ position: { x: 200, y: 200 }, force: true });
  await page.evaluate((url) => navigator.clipboard.writeText(url), VECTOR_URL);
  await page.keyboard.press('Control+V');

  console.log('─── pasted URL: ' + VECTOR_URL + ' ───');

  // Give the paste pipeline time to run.
  await page.waitForTimeout(3000);

  // ─── Inspect outcome ─────────────────────────────────────────────────
  const iframeReport = await sandboxFrame.evaluate(() => {
    const codeComponents = Array.from(document.querySelectorAll('[data-code-component]')).map(el => ({
      id: el.getAttribute('data-id'),
      file: el.getAttribute('data-code-component-file'),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
      childCount: el.children.length,
      innerHTML: el.innerHTML.slice(0, 300),
      // The crucial vector-specific check: was `name="icon-1"`
      // forwarded as an attribute on the wrapper? (the editor copies
      // node.attrs to wrapper data-attrs at render time.)
      nameAttr: el.getAttribute('name'),
    }));

    const allWithDataId = Array.from(document.querySelectorAll('[data-id]')).slice(0, 30).map(el => ({
      id: el.getAttribute('data-id'),
      tag: el.tagName.toLowerCase(),
      isCodeComponent: el.hasAttribute('data-code-component'),
      isCanvasNode: el.hasAttribute('data-canvas-node'),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
    }));

    return { codeComponents, allWithDataId };
  });

  console.log('\n─── iframe DOM report ───');
  console.log(JSON.stringify(iframeReport, null, 2));

  // ─── Inspect projectFS — what does the page actually look like after paste? ──
  const pageCode = await page.evaluate(() => {
    return (window as any).__e2e?.readFile('app/page.client.tsx') ?? '<no __e2e>';
  });
  console.log('\n─── page TSX after paste ───');
  console.log(pageCode);

  const nodesSnapshot = await page.evaluate(() => {
    return (window as any).__e2e?.nodesSnapshot() ?? null;
  });
  console.log('\n─── parsed nodes (from canvas atom) ───');
  console.log(JSON.stringify(nodesSnapshot, null, 2));

  console.log('\n─── all console messages (interesting) ───');
  for (const e of consoleEvents) {
    if (e.type === 'error' || e.type === 'warning' || (e.text && (
      e.text.includes('cdn') || e.text.includes('paste') || e.text.includes('vector') ||
      e.text.includes('parseProjectFile') || e.text.includes('component') ||
      e.text.includes('runtime-bridge') || e.text.includes('TypeError') ||
      e.text.includes('SyntaxError') || e.text.includes('Failed')
    ))) {
      console.log(`[${e.type}] ${e.text}${e.loc ? ' @ ' + e.loc : ''}`);
    }
  }

  console.log('\n─── page errors ───');
  for (const err of pageErrors) {
    console.log(err.message);
    if (err.stack) console.log(err.stack);
  }

  console.log('\n─── network: vectors / runtime-bridge / esm.sh / assets.revyme.app ───');
  for (const r of networkRequests) {
    if (
      r.url.includes('assets.revyme.app') ||
      r.url.includes('runtime-bridge') ||
      r.url.includes('esm.sh') ||
      r.url.includes('/api/components/')
    ) {
      console.log(`${r.method} ${r.status ?? '?'} ${r.url}`);
    }
  }

  const bundleRequested = networkRequests.some(r => r.url === VECTOR_URL);
  const importLineAdded = pageCode.includes(VECTOR_URL);
  const tagInPage = /<ViLiTi\b/.test(pageCode);
  const nameAttrInPage = /name="icon-1"/.test(pageCode);

  console.log('\n─── summary ───');
  console.log('Bundle URL requested:', bundleRequested);
  console.log('Import line added to page:', importLineAdded);
  console.log('JSX tag in page:', tagInPage);
  console.log('name="icon-1" in JSX:', nameAttrInPage);
  console.log('Page errors:', pageErrors.length);

  expect(true).toBe(true);
});
