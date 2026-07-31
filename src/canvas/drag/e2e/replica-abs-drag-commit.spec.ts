// Dragging an absolute node ON A MOBILE REPLICA must keep the dragged
// position in the DOM after mouseup.
//
// Repro of the "reverts until I switch pages" report: the drop commit wrote
// the new left/top into the replica's @media band, but the commit-time live
// patch (CanvasDragOrchestrator's updateContainerStyle branch) applied the
// values WITHOUT `important` — overwriting the drag's own !important patch —
// while the position-only render skip left the OLD band CSS injected. The
// stale `!important` @container rule then beat the non-important inline and
// the element snapped back to its pre-drag position on mouseup, only
// correcting after a page switch forced a full CSS rebuild.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('replica absolute drag commit', () => {
  test('mouseup keeps the dragged position on the mobile replica', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REPLICA_ABS_DRAG');
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(600);

    const sandbox = editor.sandbox();
    const mobileAbs = sandbox.locator('[data-viewport="mobile"] [data-id="abs"]').first();
    const before = await mobileAbs.boundingBox();
    if (!before) throw new Error('no mobile abs box');

    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await editor.dragFromTo(from, { x: from.x + 25, y: from.y + 20 }, { steps: 14 });
    await page.waitForTimeout(150);
    const atMouseup = await mobileAbs.boundingBox();
    if (!atMouseup) throw new Error('no mouseup box');

    // The element must have MOVED (drag registered)…
    expect(Math.abs(atMouseup.x - before.x) + Math.abs(atMouseup.y - before.y)).toBeGreaterThan(10);

    // …and must STAY there after the commit + deferred fan-out settle.
    await page.waitForTimeout(1200);
    const settled = await mobileAbs.boundingBox();
    if (!settled) throw new Error('no settled box');
    expect(Math.abs(settled.x - atMouseup.x)).toBeLessThan(2);
    expect(Math.abs(settled.y - atMouseup.y)).toBeLessThan(2);

    // The commit landed in the mobile @media band (not the base styles).
    const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
    const band = code?.match(/@media \(max-width: 375px\)[^{]*\{[\s\S]*?\n\s*\}/)?.[0] ?? '';
    expect(band).toMatch(/\[data-id="abs"\][^}]*top:\s*[^;]+!important/);
  });
});
