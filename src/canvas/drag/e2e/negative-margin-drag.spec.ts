// negative-margin-drag.spec.ts — a reorder must not flatten overlaps.
//
// Elements pulled over their neighbours with a negative margin (overlapping
// pills, stacked avatars, ticker rows) are laid out by that margin alone.
// The lift snapshots the dragged node's box styles and writes them back on
// drop; if that restore only knows the `margin` SHORTHAND, restoring it as
// '' also clears a `marginLeft` longhand — and the canvas silently loses
// the overlap while the source, and therefore the published site, keeps it.
// Editor and reality disagree until the next full re-render.
//
// Covers: flow-reorder--negative-margin-overlap.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

/** Painted margin-left of a node inside the canvas iframe. */
async function paintedMarginLeft(editor: EditorPage, dataId: string): Promise<string> {
  return editor
    .sandbox()
    .locator(`[data-id="${dataId}"]`)
    .first()
    .evaluate((el) => getComputedStyle(el as HTMLElement).marginLeft);
}

test.describe('negative margins survive a flow drag', () => {
  test('dragging a negative-margin child keeps its margin painted after drop', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('NEGATIVE_MARGIN_ROW');

    expect(await paintedMarginLeft(editor, 'pill-c')).toBe('-70px');

    // Reorder pill-c one slot to the left (drop on pill-b's left half).
    const pillB = await editor.nodeBox('pill-b');
    await editor.dragNodeAsserted('pill-c', {
      x: pillB.x + pillB.width * 0.25,
      y: pillB.y + pillB.height / 2,
    }, { steps: 16, releaseDelayMs: 120 });

    // The margin is still PAINTED on the canvas — not just still in source.
    // (Source is checked below; the regression was canvas-only, which is
    // exactly the kind of divergence a code-only assertion would miss.)
    expect(await paintedMarginLeft(editor, 'pill-c')).toBe('-70px');
    // The sibling that never moved keeps its overlap too.
    expect(await paintedMarginLeft(editor, 'pill-b')).toBe('-70px');

    const code = await editor.getPageCode();
    expect(code).toContain("marginLeft: '-70px'");
  });

  test('the lifted node tracks the cursor exactly — no margin-sized jump at drag start', async ({ page }) => {
    // The lift takes the node out of flow (position:absolute at its PAINTED
    // position). A margin still applies to an absolutely-positioned box, so
    // leaving it on double-counts it: the node jumps by the margin the
    // instant the drag starts and stays offset from the cursor for the whole
    // gesture. What the user grabs must be what moves.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('NEGATIVE_MARGIN_ROW');

    const before = await editor.nodeBox('pill-c');
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    const DX = 40;
    const DY = 30;

    const mouse = page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    for (let i = 1; i <= 10; i++) {
      await mouse.move(from.x + (DX * i) / 10, from.y + (DY * i) / 10, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    const during = await editor.nodeBox('pill-c');
    await mouse.up();
    await page.waitForTimeout(120);

    // The node moved by the cursor delta — not by delta ± the 70px margin.
    // Tolerance covers canvas zoom rounding, not a whole margin.
    expect(during.x - before.x).toBeCloseTo(DX, -1);
    expect(during.y - before.y).toBeCloseTo(DY, -1);
  });

  test('a drag that ends where it started still keeps the margin', async ({ page }) => {
    // The no-op drop is the harshest case: nothing reorders, so every
    // visible difference comes purely from lift/restore bookkeeping.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('NEGATIVE_MARGIN_ROW');

    const pillC = await editor.nodeBox('pill-c');
    await editor.dragNodeAsserted('pill-c', {
      x: pillC.x + pillC.width / 2 + 12,
      y: pillC.y + pillC.height / 2 + 8,
    }, { steps: 10, releaseDelayMs: 120 });

    expect(await paintedMarginLeft(editor, 'pill-c')).toBe('-70px');
  });
});
