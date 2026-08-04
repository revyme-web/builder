// replica-exit-freeze.spec.ts — the element must FOLLOW THE CURSOR while an
// absolute node is dragged out of a REPLICA tile onto the canvas.
//
// User-reported freeze (2026-08-03): dragging an absolute child out of a
// replica to the canvas left it stale and unmoving for the whole gesture, only
// snapping into place on mouseup. The same drag from the PRIMARY tile was
// smooth.
//
// Every existing exit assertion checks state AFTER mouseup, which is exactly
// the window where this bug is invisible — the committed result was always
// correct. So this spec samples the element's on-screen box BETWEEN drag
// frames and asserts it actually moves mid-gesture.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SEEDS } from './fixtures/seeds';

// The shared EditorPage helper navigates to '/', which only serves the editor
// when Vite runs at base '/'. Against the normal dev stack (base '/builder/')
// that redirects to auth and the canvas never mounts. `/builder/noauth` is the
// documented dev escape hatch, and it exposes the `__e2e.writeFile/openFile`
// seeding pair for exactly this purpose (ProjectLoader.tsx).
async function gotoSeeded(page: Page, seed: keyof typeof SEEDS): Promise<void> {
  // Without this the onboarding spotlight mounts and swallows every pointer
  // event on the canvas (same reason the shared helper sets it).
  await page.addInitScript(() => {
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  });
  await page.goto('/builder/noauth');
  await page.waitForFunction(() => !!(window as any).__e2e, null, { timeout: 60_000 });
  const files = (SEEDS[seed] as { files: Record<string, string> }).files;
  await page.evaluate((f) => {
    // Seed a FRESH route: `app/page.client.tsx` is already the active file, so
    // rewriting it fires no activeFilePath change and the canvas never
    // re-parses — the seed would silently render as the empty default project.
    for (const [path, code] of Object.entries(f)) {
      (window as any).__e2e.writeFile(path.replace('app/', 'app/repro/'), code);
    }
    (window as any).__e2e.openFile('app/repro/page.client.tsx');
  }, files);
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
}

/** Screen box of the node inside the canvas iframe, or null when it isn't in
 *  the DOM — which IS the freeze: there is simply nothing to measure.
 *
 *  Must go through frameLocator: the canvas iframe is served from a different
 *  port (5174), so `contentDocument` from the top frame is cross-origin null. */
async function tileBox(page: Page, vpPrefix: string, dataId: string) {
  const sandbox = page.frameLocator('iframe[src*="5174"]');
  // Replica tiles reuse the SAME data-id as the primary — they're told apart by
  // their [data-viewport] ancestor, not by an id prefix.
  const sel = vpPrefix
    ? `[data-viewport="${vpPrefix}"] [data-id="${dataId}"]`
    : `[data-id="${dataId}"]`;
  const loc = sandbox.locator(sel).first();
  if ((await loc.count()) === 0) return null;
  return await loc.boundingBox();
}

test.describe('replica → canvas exit stays live during the drag', () => {
  // REPRODUCTION CONDITION (learned the hard way, 2026-08-04): the freeze only
  // occurs when the project contains a `components/` or `icons/` folder. That is
  // the branch where `deriveAndCacheNodes` re-read projectFS instead of the code
  // it was handed (store.ts) — and projectFS is deliberately stale mid-gesture.
  // A single-file seed can NEVER reproduce it. `/builder/noauth` calls
  // `syncBuiltInCodeComponents`, so the components folder is present here.
  //
  // FIXME: the REPLICA half is not runnable yet — the second viewport tile in
  // REPLICA_ABSOLUTE_EXIT renders into the DOM but never gets laid out
  // (boundingBox is null), so there is nothing to grab. The seed needs the tile
  // positions / canvas fit sorted out before this can drive a real replica
  // drag. The PRIMARY test below runs and passes, and the harness plumbing
  // (noauth seeding on a fresh route + onboarding flag) is proven by it.
  test.fixme('absolute child follows the cursor while exiting from a REPLICA', async ({ page }) => {
    await gotoSeeded(page, 'REPLICA_ABSOLUTE_EXIT');

    // Grab the child as rendered in the TABLET tile — the replica.
    const start = await tileBox(page, 'tablet', 'abs-child');
    expect(start, 'abs-child must render in the tablet replica').not.toBeNull();

    const from = { x: start!.x + start!.width / 2, y: start!.y + start!.height / 2 };
    // Straight up and out of the tile — forces the exit-to-canvas branch.
    const to = { x: from.x + 40, y: from.y - 420 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Past the drag threshold first, so the strategy is live before we sample.
    await page.mouse.move(from.x + 8, from.y - 8, { steps: 2 });

    const samples: Array<{ x: number; y: number } | null> = [];
    const STEPS = 10;
    for (let i = 1; i <= STEPS; i++) {
      const x = from.x + ((to.x - from.x) * i) / STEPS;
      const y = from.y + ((to.y - from.y) * i) / STEPS;
      await page.mouse.move(x, y, { steps: 2 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      // After the exit the node is a canvas node (no viewport prefix), so look
      // it up unprefixed; tileBox falls back to the bare id.
      const b = await tileBox(page, '', 'abs-child');
      samples.push(b ? { x: b.x, y: b.y } : null);
    }
    await page.mouse.up();

    const found = samples.filter(Boolean) as Array<{ x: number; y: number }>;
    // 1. The element must EXIST for most of the gesture. All-null was the bug:
    //    the clone's DOM node never mounted until the queue flushed at mouseup.
    expect(found.length, `element missing from the DOM in ${STEPS - found.length}/${STEPS} drag frames`)
      .toBeGreaterThanOrEqual(STEPS - 3);

    // 2. It must MOVE. A frozen element reports the same box every frame even
    //    though the cursor travelled ~420px.
    const ys = found.map(s => s.y);
    const travelled = Math.max(...ys) - Math.min(...ys);
    expect(travelled, `element only moved ${travelled.toFixed(1)}px while the cursor moved 420px`)
      .toBeGreaterThan(100);
  });

  test('same drag from the PRIMARY tile (control — was always smooth)', async ({ page }) => {
    await gotoSeeded(page, 'REPLICA_ABSOLUTE_EXIT');

    const start = await tileBox(page, '', 'abs-child');
    expect(start).not.toBeNull();
    const from = { x: start!.x + start!.width / 2, y: start!.y + start!.height / 2 };
    const to = { x: from.x + 40, y: from.y - 420 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y - 8, { steps: 2 });

    const ys: number[] = [];
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
        { steps: 2 },
      );
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      const b = await tileBox(page, '', 'abs-child');
      if (b) ys.push(b.y);
    }
    await page.mouse.up();

    expect(ys.length).toBeGreaterThanOrEqual(7);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
  });
});
