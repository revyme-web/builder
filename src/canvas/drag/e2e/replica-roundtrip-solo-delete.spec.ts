// Reported 2026-08-31: drag a CANVAS node into a replica tile and back out to
// open canvas in ONE gesture. The entry solos the node on that replica
// (hide-in-others + data-replica-solo) — correct. But the exit took the
// VP-ONLY EXTRACTION path (revert + hide + canvas clone) instead of the
// solo DIRECT-MOVE: the pending-replica-extraction registration guard reads
// the GESTURE-START frozen nodes map, where the node was still a visible
// canvas node, so the solo skip never fired. Every in/out cycle within one
// gesture stacked another hidden viewport duplicate. Split into two gestures
// (mouseup in the replica, new drag out) it worked — the fresh registration
// then saw the solo state and skipped.
//
// Fix under test: the exit's FRESH isReplicaOnly verdict overrides a stale
// registration (AbsoluteInFrameStrategy), and canvas clones never inherit
// data-replica-solo / data-pinned (clone-descriptor).
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1720, height: 1000 } });

/** Drag canvas-chip into the TABLET tile, then back to open canvas. */
async function cycleThroughTablet(editor: EditorPage, cycles: number) {
  const page = editor.page();
  await editor.fitCamera();

  await editor.primeNode('canvas-chip');
  await editor.select(['canvas-chip']);
  await page.waitForTimeout(600);

  const chip = await editor.nodeBox('canvas-chip');
  const tablet = await editor.nodeBoxIn('tablet', 'root');
  const from = { x: chip.x + chip.width / 2 + 6, y: chip.y + chip.height / 2 + 4 };
  // Inside the tablet tile, upper-middle area (root is the whole tile).
  const inside = { x: tablet.x + tablet.width / 2, y: tablet.y + tablet.height * 0.3 };
  // Open canvas, well left of the tablet tile and clear of every frame.
  const outside = { x: tablet.x - 260, y: tablet.y - 160 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();

  const glide = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  };

  let cur = from;
  for (let c = 0; c < cycles; c++) {
    await glide(cur, inside);
    await editor.pumpDrag(inside, 10); // entry hysteresis
    await glide(inside, outside);
    await editor.pumpDrag(outside, 10); // exit hysteresis
    cur = outside;
  }
  await mouse.up();
  await page.waitForTimeout(900); // commit + flush + reparse
}

test.describe('same-gesture canvas → replica → canvas round trip', () => {
  test('one cycle: node returns to canvas with zero viewport residue', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
    await cycleThroughTablet(editor, 1);

    const code = await editor.getPageCode();
    const occurrences = (code.match(/data-id="canvas-chip"/g) || []).length;
    expect(occurrences, 'exactly one canvas-chip in the source').toBe(1);
    expect(code, 'no solo contract may survive on a canvas node').not.toContain('data-replica-solo');
    // No per-viewport visibility band may reference the chip.
    const band = await editor.getMediaBand(768);
    if (band) expect(band).not.toContain('canvas-chip');
  });

  test('two cycles in one gesture: still exactly one node (no hidden duplicates)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
    await cycleThroughTablet(editor, 2);

    const code = await editor.getPageCode();
    const occurrences = (code.match(/data-id="canvas-chip"/g) || []).length;
    expect(occurrences, 'in/out cycling must not stack duplicates').toBe(1);
    expect(code).not.toContain('data-replica-solo');
    // The chip must be a free canvas node again — visible on the workspace.
    await expect(editor.node('canvas-chip')).toBeVisible();
  });
});
