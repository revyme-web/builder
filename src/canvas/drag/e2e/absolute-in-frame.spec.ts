// absolute-in-frame.spec.ts — End-to-end tests for AbsoluteInFrameStrategy.
//
// AbsoluteInFrameStrategy fires when an absolute-positioned node living
// inside a frame is dragged. Behaviors:
//   - Move within the parent (left/top updates only)
//   - Exit to canvas: cursor leaves parent → reparent to root, switch
//     to CanvasDragStrategy
//   - Sibling layout entry: cursor enters a sibling that's a layout
//     container → drop-line preview, switch to LayoutLiftedStrategy
//
// The seed `ABSOLUTE_IN_FRAME` has a hero (non-layout) with an absolute
// `abs-child` and a sibling `features` flex-row layout.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('AbsoluteInFrameStrategy', () => {
  test('drag within parent updates left/top, no reparent', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('ABSOLUTE_IN_FRAME');

    // Verify abs-child starts as a child of hero.
    let nodes = await page.evaluate(() => (window as any).__e2e.nodesSnapshot());
    expect(nodes['abs-child'].parentId).toBe('hero');
    const before = await editor.nodeBox('abs-child');
    const heroBox = await editor.nodeBox('hero');

    // Drag abs-child by +50 px right, +50 px down — staying inside hero.
    const dragBy = { dx: 50, dy: 50 };
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    const to = { x: from.x + dragBy.dx, y: from.y + dragBy.dy };
    // Confirm target is still inside hero (so no exit fires).
    expect(to.y).toBeLessThan(heroBox.y + heroBox.height);
    await editor.dragFromTo(from, to);

    // Parent stays the same; only position moved.
    nodes = await page.evaluate(() => (window as any).__e2e.nodesSnapshot());
    expect(nodes['abs-child'].parentId).toBe('hero');

    // Position moved by ~ dragBy (canvas zoom 0.5 means screen → 2× CSS).
    const after = await editor.nodeBox('abs-child');
    expect(after.x).toBeGreaterThanOrEqual(before.x + dragBy.dx - 2);
    expect(after.x).toBeLessThanOrEqual(before.x + dragBy.dx + 2);
    expect(after.y).toBeGreaterThanOrEqual(before.y + dragBy.dy - 2);
    expect(after.y).toBeLessThanOrEqual(before.y + dragBy.dy + 2);
  });

  test('exit to canvas: cursor leaves parent → reparent to root', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('ABSOLUTE_IN_FRAME');

    // Drag abs-child far to the LEFT — outside the viewport entirely
    // (cursor x < hero.x). Strategy detects "fully outside" and unparents
    // to canvas root (parentId becomes null / root, depending on the
    // commit shape).
    const before = await editor.nodeBox('abs-child');
    const heroBox = await editor.nodeBox('hero');
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    const to = { x: heroBox.x - 200, y: from.y };

    await editor.dragFromTo(from, to);

    // Code should now have abs-child as a canvas node (in canvasNodes
    // fragment), NOT inside hero.
    const code = await editor.getPageCode();
    const heroChildIds = (() => {
      const m = code.match(/data-id="hero"[\s\S]*?<\/div>/);
      return m ? (m[0].match(/data-id="([^"]+)"/g) || []).slice(1) : [];
    })();
    expect(heroChildIds).not.toContain('"data-id="abs-child"');
    // The node still exists somewhere in the file:
    expect(code).toContain('data-id="abs-child"');
  });

  test('sibling layout entry: cursor over flex sibling shows drop-line', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('ABSOLUTE_IN_FRAME');

    // Drag abs-child DOWN into the features section (a flex-row layout
    // sibling). Strategy detects layout-sibling-under-cursor and shows
    // a drop-line preview without committing the reparent.
    const features = await editor.nodeBox('features');
    const cardA = await editor.nodeBox('card-a');
    const cardB = await editor.nodeBox('card-b');
    const dropX = (cardA.x + cardA.width + cardB.x) / 2; // gap between cards
    const dropY = features.y + features.height / 2;

    const before = await editor.nodeBox('abs-child');
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      const t = i / 18;
      await page.mouse.move(from.x + (dropX - from.x) * t, from.y + (dropY - from.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    await editor.pumpDrag({ x: dropX, y: dropY }, 10);

    // Drop-line should target features at insertIndex 1 (between card-a and card-b).
    const line = editor.dropLine();
    await expect(line).toHaveAttribute('data-parent-id', 'features');
    await expect(line).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
  });
});
