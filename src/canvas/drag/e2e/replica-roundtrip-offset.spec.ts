// replica-roundtrip-offset.spec.ts — measures the reported OFFSET JUMP when a
// node is extracted from a replica tile onto the canvas and then dragged back
// into the primary in a SEPARATE gesture.
//
// Seeded from the user's REAL project (debug_output/project), because the bug
// needs conditions a synthetic seed doesn't have: two viewports that actually
// lay out, and a `components/` folder (the branch where the node cache was
// re-read from a stale projectFS).
//
// The committed numbers in every trace so far are self-consistent, so this
// measures what the traces can't: the element's SCREEN position across the
// handoff. If entry preserves position, the deltas below are ~0.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const PROJECT_ROOT = join(process.cwd(), 'debug_output', 'project');

function collectFiles(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.(tsx?|json|css)$/.test(name)) {
      out[relative(PROJECT_ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  }
  return out;
}

async function seedRealProject(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  });
  await page.goto('/builder/noauth');
  await page.waitForFunction(() => !!(window as any).__e2e, null, { timeout: 60_000 });
  const files = collectFiles(PROJECT_ROOT);
  await page.evaluate((f) => {
    for (const [path, code] of Object.entries(f)) (window as any).__e2e.writeFile(path, code);
    // Re-open via a DIFFERENT file first: page.client.tsx is already active, so
    // re-selecting it fires no change and the canvas never re-parses the seed.
    (window as any).__e2e.openFile('app/not-found.tsx');
    (window as any).__e2e.openFile('app/page.client.tsx');
  }, files);
  await page.frameLocator('iframe[src*="5174"]')
    .locator('[data-viewport]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(2500);
}

/** Screen box of a node, optionally scoped to one viewport tile. */
async function box(page: Page, dataId: string, vp?: string) {
  const sb = page.frameLocator('iframe[src*="5174"]');
  if (vp) {
    const loc = sb.locator(`[data-viewport="${vp}"] [data-id="${dataId}"]`).first();
    if ((await loc.count()) === 0) return null;
    return await loc.boundingBox();
  }
  // A canvas node's id ALSO renders inside every viewport tile, so `.first()`
  // silently measured a stationary tile copy while the canvas one moved. Pick
  // the element that is not inside any [data-viewport], and return its rect in
  // TOP-FRAME coords (iframe rect + inner rect) so it lines up with mouse coords.
  const iframeBox = await page.locator('iframe[src*="5174"]').first().boundingBox();
  const inner = await sb.locator(`[data-id="${dataId}"]`).evaluateAll((els) => {
    const el = els.find(e => !e.closest('[data-viewport]'));
    if (!el) return null;
    const r = (el as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!inner || !iframeBox) return null;
  return { x: inner.x + iframeBox.x, y: inner.y + iframeBox.y, width: inner.width, height: inner.height };
}

// Wider than the default 1600: at 1600 the tablet tile lands UNDER the 260px
// properties panel, so pointer events hit the panel and nothing selects.
test.use({ viewport: { width: 2400, height: 1200 } });

// FIXME — harness is NOT yet faithful for this scenario. Seeding the real
// project works (both tiles lay out, extraction fires, selection resolves), but
// the canvas node measures as completely STATIONARY through gesture 2: the
// per-frame cursor→element drift is a constant 58.2px, exactly the cursor step.
// In the user's real trace the same gesture writes left 652→650→648… per frame,
// so the app does track. Synthetic pointer events are therefore not engaging
// CanvasDragStrategy the way a real drag does. Do not trust this number as
// evidence about the product until that gap is closed.
test.fixme('canvas node entering the primary keeps its on-screen position', async ({ page }) => {
  await seedRealProject(page);

  const vps = await page.frameLocator('iframe[src*="5174"]')
    .locator('[data-viewport]').evaluateAll(els => els.map(e => e.getAttribute('data-viewport')));
  console.log('viewports:', JSON.stringify(vps));

  // Node visible in the tablet replica in the saved project state.
  const NODE = 'detach-mseebdqk-2';
  const tabletBox = await box(page, NODE, 'tablet');
  console.log('node in tablet replica:', JSON.stringify(tabletBox));
  expect(tabletBox, 'node must render in the tablet replica').not.toBeNull();

  // ── Gesture 1: drag it out of the tablet tile onto empty canvas ──
  const idsBefore = new Set(await page.frameLocator('iframe[src*="5174"]')
    .locator('[data-id]').evaluateAll(els => els.map(e => e.getAttribute('data-id')!)));
  const from = { x: tabletBox!.x + tabletBox!.width / 2, y: tabletBox!.y + tabletBox!.height / 2 };
  // DOWN into empty canvas below the tiles — dragging up ran off-screen and the
  // pointer clamped, so the node never left its parent.
  const out = { x: from.x - 40, y: 900 };
  // Select first — a drag on an UNSELECTED node starts a marquee, not a move.
  await page.mouse.click(from.x, from.y);
  await page.waitForTimeout(400);
  console.log('selection:', JSON.stringify(await page.evaluate(() => (window as any).__e2e.selection())));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((out.x - from.x) * i) / 12, from.y + ((out.y - from.y) * i) / 12, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await page.mouse.up();
  await page.waitForTimeout(600);

  // The extracted clone is the node now sitting outside any viewport tile.
  const idsAfter = await page.frameLocator('iframe[src*="5174"]')
    .locator('[data-id]').evaluateAll(els => els.map(e => e.getAttribute('data-id')!));
  const cloneId = idsAfter.find(id => !idsBefore.has(id)) ?? null;
  console.log('extracted clone id:', cloneId);
  expect(cloneId, 'extraction should have produced a canvas node').toBeTruthy();

  // ── Gesture 2 (SEPARATE): drag the canvas node into the primary ──
  const before = await box(page, cloneId!);
  console.log('clone on canvas:', JSON.stringify(before));
  expect(before).not.toBeNull();

  const g2from = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
  await page.mouse.click(g2from.x, g2from.y);
  await page.waitForTimeout(400);
  console.log('selection before gesture 2:', JSON.stringify(await page.evaluate(() => (window as any).__e2e.selection())));
  await page.mouse.move(g2from.x, g2from.y);
  await page.mouse.down();

  // Walk toward the primary tile, sampling the element vs the cursor each frame.
  const desktopTile = await page.frameLocator('iframe[src*="5174"]')
    .locator('[data-viewport="desktop"]').first().boundingBox();
  const target = { x: desktopTile!.x + desktopTile!.width / 2, y: desktopTile!.y + 120 };

  const drift: number[] = [];
  let prevOffset: { dx: number; dy: number } | null = null;
  for (let i = 1; i <= 16; i++) {
    const mx = g2from.x + ((target.x - g2from.x) * i) / 16;
    const my = g2from.y + ((target.y - g2from.y) * i) / 16;
    await page.mouse.move(mx, my, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    const b = await box(page, cloneId!);
    if (!b) continue;
    // Offset between cursor and element origin — should stay CONSTANT for the
    // whole gesture. A jump is this offset changing between two frames.
    const off = { dx: mx - b.x, dy: my - b.y };
    if (prevOffset) {
      drift.push(Math.hypot(off.dx - prevOffset.dx, off.dy - prevOffset.dy));
    }
    prevOffset = off;
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const worst = Math.max(...drift);
  console.log('per-frame cursor→element offset drift:', drift.map(d => d.toFixed(1)).join(' '));
  console.log('WORST single-frame drift:', worst.toFixed(1), 'px');

  // Grab-point must not move relative to the element. Snapping can shift it by
  // a snap threshold; anything beyond that is the reported jump.
  expect(worst, `element shifted ${worst.toFixed(1)}px relative to the cursor in one frame`)
    .toBeLessThan(40);
});
