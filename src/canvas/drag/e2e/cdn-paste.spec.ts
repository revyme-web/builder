// cdn-paste.spec.ts — E2E debug for pasting a CDN component URL.
//
// Loads `/builder/noauth` (auth bypass), pastes a CDN URL into the
// clipboard, fires Ctrl+V on the canvas, and captures EVERYTHING:
//   - All console messages from the parent page AND every iframe
//   - All network requests (URL, status, response headers if interesting)
//   - DOM state of the canvas iframe (data-code-component attrs, child counts)
//   - Final outcome: did the component render, or render empty?
//
// Run headed so you can watch what happens:
//   npx playwright test cdn-paste.spec.ts --headed
//
// Or check the trace afterwards:
//   npx playwright test cdn-paste.spec.ts --trace on
//   npx playwright show-trace test-results/.../trace.zip

import { test, expect, type Frame } from '@playwright/test';

const COMPONENT_URL = 'https://assets.revyme.app/components/NuZoKa@5964bc7e3ea3dbad.js';
const NESTED_COMPONENT_URL_FRAGMENT = 'CeMaXi@'; // nested child the bundle imports

test('paste CDN URL into /builder/noauth and see what happens', async ({ page, context, browserName }) => {
  // ─── Capture EVERYTHING ───────────────────────────────────────────────
  const consoleEvents: Array<{ src: string; type: string; text: string; loc?: string }> = [];
  const networkRequests: Array<{ url: string; status?: number; method: string; resourceType: string }> = [];
  const pageErrors: Array<{ message: string; stack?: string }> = [];

  // Top page console
  page.on('console', (msg) => {
    consoleEvents.push({
      src: 'top',
      type: msg.type(),
      text: msg.text(),
      loc: `${msg.location().url}:${msg.location().lineNumber}`,
    });
  });

  // Console from every iframe (sandbox at :5174, preview at :5175, etc)
  page.on('frameattached', (frame) => {
    const url = frame.url();
    // We can't directly listen to iframe console, but we can inject a
    // bridge that proxies iframe console.log → top window via postMessage.
    // Cleaner approach: Playwright's `page.on('console')` already catches
    // ALL frames in the page tree. We just tag events by their frame URL.
    consoleEvents.push({ src: 'frameattached', type: 'info', text: `frame attached: ${url}` });
  });

  // Errors thrown in the page (uncaught exceptions, unhandled rejections)
  page.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
  });

  // All network requests
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

  // Grant clipboard permissions so we can write the URL programmatically.
  // chromium permission name; firefox doesn't need explicit grant.
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }

  // ─── Navigate ─────────────────────────────────────────────────────────
  await page.goto('/builder/noauth');

  // Wait for editor to mount — look for the LeftHeader (top-of-canvas chrome
  // that appears once <App /> renders past ProjectLoader's `Loading…`).
  await page.waitForSelector('text=File', { timeout: 30_000 });

  console.log('\n─── editor mounted ───');

  // Wait for the canvas sandbox iframe to appear and be navigated.
  // Cross-origin iframe (5174 vs 3333) means we can't touch contentDocument
  // from `page.evaluate` — use Playwright's frame API instead.
  const sandboxFrame = page.frames().find(f => f.url().includes('5174'))
    ?? await new Promise<Frame>((resolve) => {
      page.on('framenavigated', (f) => {
        if (f.url().includes('5174')) resolve(f as any);
      });
    });

  // Wait for sandbox to have its DOM ready
  await sandboxFrame.waitForSelector('#sandbox-root', { timeout: 15_000 });

  console.log('─── sandbox iframe loaded ───');

  // Verify the importmap is in the sandbox iframe (via Playwright frame API,
  // which crosses origins safely)
  const importmap = await sandboxFrame.evaluate(() => {
    const script = document.querySelector('script[type="importmap"]');
    return script?.textContent ?? null;
  });
  console.log('Importmap in sandbox:', importmap ? 'YES' : 'NO');
  if (importmap) console.log(importmap.slice(0, 400));

  // ─── Paste the URL ───────────────────────────────────────────────────
  // Click on the parent's body to focus the page (the iframe captures
  // pointer events but the keyboard shortcut is registered on parent
  // window — focus needs to be on parent for Ctrl+V).
  await page.locator('body').click({ position: { x: 200, y: 200 }, force: true });

  // Write to clipboard then Ctrl+V — this triggers the parent's
  // shortcut handler (registered in shortcuts.ts).
  await page.evaluate((url) => navigator.clipboard.writeText(url), COMPONENT_URL);
  await page.keyboard.press('Control+V');

  console.log('─── pasted URL: ' + COMPONENT_URL + ' ───');

  // Give the paste pipeline time to run: parser flush → render → mountCodeComponent
  // → dynamic import → React mount. ~3 seconds is generous.
  await page.waitForTimeout(3000);

  // ─── Inspect outcome ─────────────────────────────────────────────────
  // What's in the iframe DOM? Use sandbox frame API for cross-origin.
  const iframeReport = await sandboxFrame.evaluate(() => {
    const codeComponents = Array.from(document.querySelectorAll('[data-code-component]')).map(el => ({
      id: el.getAttribute('data-id'),
      file: el.getAttribute('data-code-component-file'),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
      childCount: el.children.length,
      innerHTML: el.innerHTML.slice(0, 200),
    }));

    const canvasComponents = Array.from(document.querySelectorAll('[data-canvas-node][data-id^="component-"]')).map(el => ({
      id: el.getAttribute('data-id'),
      hasCodeComponentAttr: el.hasAttribute('data-code-component'),
      file: el.getAttribute('data-code-component-file'),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
      childCount: el.children.length,
    }));

    // Also check ALL data-id elements to see what's actually rendered
    const allWithDataId = Array.from(document.querySelectorAll('[data-id]')).slice(0, 20).map(el => ({
      id: el.getAttribute('data-id'),
      tag: el.tagName.toLowerCase(),
      isCodeComponent: el.hasAttribute('data-code-component'),
      isCanvasNode: el.hasAttribute('data-canvas-node'),
    }));

    return { codeComponents, canvasComponents, allWithDataId };
  });

  console.log('\n─── iframe DOM report ───');
  console.log(JSON.stringify(iframeReport, null, 2));

  // ─── Inspect projectFS — what does the page actually look like after paste? ──
  const pageCode = await page.evaluate(() => {
    return (window as any).__e2e?.readFile('app/page.client.tsx') ?? '<no __e2e>';
  });
  console.log('\n─── page TSX after paste ───');
  console.log(pageCode);

  // ─── Inspect parsed nodes from the editor parent's atom ──────────
  const nodesSnapshot = await page.evaluate(() => {
    return (window as any).__e2e?.nodesSnapshot() ?? null;
  });
  console.log('\n─── parsed nodes (from canvas atom) ───');
  console.log(JSON.stringify(nodesSnapshot, null, 2));

  // Sandbox console — Playwright's page-level listener catches frame
  // console messages too, but only when the frame's console fires AFTER
  // the listener is attached. We've been listening since before the page
  // loaded, so we should have everything.
  console.log('\n─── all console messages (interesting) ───');
  for (const e of consoleEvents) {
    if (e.type === 'error' || e.type === 'warning' || (e.text && (
      e.text.includes('cdn') || e.text.includes('paste') ||
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

  console.log('\n─── network: cdn / runtime-bridge / esm.sh / assets.revyme.app ───');
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

  // Sanity: at minimum we expect the bundle URL to have been requested.
  const bundleRequested = networkRequests.some(r => r.url === COMPONENT_URL);
  const nestedRequested = networkRequests.some(r => r.url.includes(NESTED_COMPONENT_URL_FRAGMENT));
  const bridgeRequested = networkRequests.some(r => r.url.includes('runtime-bridge'));

  console.log('\n─── summary ───');
  console.log('Bundle URL requested:', bundleRequested);
  console.log('Nested URL requested:', nestedRequested);
  console.log('Bridge file requested:', bridgeRequested);
  console.log('Page errors:', pageErrors.length);

  // Don't fail — we want the test to always print everything regardless.
  expect(true).toBe(true);
});
