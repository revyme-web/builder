// toolbar-drag.spec.ts — End-to-end tests for ToolbarDragStrategy.
//
// Toolbar drag is what fires when the user drags from the Insert /
// Library / Icon panels onto the canvas. Unlike CanvasDragStrategy, it
// uses `findDeepestFrameAtPoint` (point-only hit-test, no fully-inside
// check) and has no entry-grace hysteresis — the drop-line / parent-
// highlight updates synchronously every move event.
//
// Scenarios covered:
//   - Drop into a flex layout parent (drop-line appears + node inserts
//     at the right index)
//   - Edge-magnet between two touching siblings (cursor near boundary)
//   - Insert respects `order` styles when parent has explicit reorder
//     metadata (renumber pass)

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function openInsertAndDrag(
  editor: EditorPage,
  opts: { categoryLabel: string; itemId: string },
  to: { x: number; y: number },
) {
  // 1. Click the Insert toggle in the LeftMenu — opens the primary
  //    panel listing categories (Elements, Creative, …).
  await editor.page().locator('[data-left-menu-item="insert"]').click();
  // 2. Hover the requested category. The secondary panel is portal'd
  //    into <body> on hover, so it doesn't appear inside the primary
  //    panel's DOM tree.
  await editor.page().locator(`text="${opts.categoryLabel}"`).first().hover();
  // 3. Wait for the toolbar item to render inside the secondary panel.
  const item = editor.page().locator(`[data-toolbar-item="${opts.itemId}"]`).first();
  await item.waitFor({ state: 'visible' });
  const box = await item.boundingBox();
  if (!box) throw new Error(`toolbar item ${opts.itemId} has no boundingBox`);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // ToolbarDragStrategy fires from pointerdown without a threshold —
  // a single down + move sequence is enough. Still emit several
  // intermediate moves so RAF can settle each frame.
  await editor.page().mouse.move(from.x, from.y);
  await editor.page().mouse.down();
  for (let i = 1; i <= 18; i++) {
    const t = i / 18;
    await editor.page().mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
    await editor.page().evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  // Strategy doesn't have grace, but pumping a few extra frames lets
  // the drop-line settle on its final target so a follow-up assertion
  // can read it before mouseup.
  await editor.pumpDrag(to, 4);
}

test.describe('ToolbarDragStrategy', () => {
  test('drop-line appears and drop inserts at the right index when dropping in a gap', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('FLEX_COLUMN_GAP');

    const heroBox = await editor.nodeBox('hero');
    const featuresBox = await editor.nodeBox('features');
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = (heroBox.y + heroBox.height + featuresBox.y) / 2;

    await openInsertAndDrag(editor, { categoryLabel: 'Elements', itemId: 'frame' }, { x: dropX, y: dropY });

    // Drop-line should be on root, between hero (idx 0) and features (idx 1).
    const line = editor.dropLine();
    await expect(line).toHaveAttribute('data-parent-id', 'root');
    await expect(line).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
    // After mouseup, JSX children of root should have the new frame
    // between hero and features in visual order.
    const visual = await editor.getRootChildrenVisualOrder();
    expect(visual.length).toBe(4);
    expect(visual[0]).toBe('hero');
    expect(visual[2]).toBe('features');
    expect(visual[3]).toBe('how');
  });

  test('edge-magnet promotes when dropping near a touching-sibling boundary', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('FLEX_COLUMN');

    // FLEX_COLUMN: hero / features / how all touch (gap=0). Cursor near
    // hero's bottom edge → magnet promotes to root, drop-line shows
    // between hero and features.
    const heroBox = await editor.nodeBox('hero');
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = heroBox.y + heroBox.height - 6; // 6px above hero/features boundary

    await openInsertAndDrag(editor, { categoryLabel: 'Elements', itemId: 'frame' }, { x: dropX, y: dropY });

    const line = editor.dropLine();
    await expect(line).toHaveAttribute('data-parent-id', 'root');
    await expect(line).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
    const visual = await editor.getRootChildrenVisualOrder();
    expect(visual[0]).toBe('hero');
    expect(visual[2]).toBe('features');
  });

  test('drop into a parent with explicit order:N siblings renumbers correctly', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REORDERED_FLEX_COLUMN');

    // Visual order in REORDERED_FLEX_COLUMN: hero (order:0), features
    // (order:1), how (order:2). JSX order: how, hero, features.
    // Drop in the gap (none — touching), via magnet near hero's bottom
    // edge. Without the renumber-orders fix, the new node would land
    // visually at the top (default order:0).
    const heroBox = await editor.nodeBox('hero');
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = heroBox.y + heroBox.height - 6;

    await openInsertAndDrag(editor, { categoryLabel: 'Elements', itemId: 'frame' }, { x: dropX, y: dropY });

    // Drop-line between hero (visual 0) and features (visual 1).
    const line = editor.dropLine();
    await expect(line).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
    // Visual order must be: hero, NEW, features, how — NOT NEW, hero,
    // features, how (which would happen without the renumber).
    //
    // Poll: the ordered-parent drop commits in TWO flushes (addNode, then the
    // order-renumber styles ~30ms later) and the render that materializes the
    // new element in the sandbox DOM follows the second flush — reading the
    // DOM synchronously after mouseup races it (~110ms total). The poll also
    // guards the actual regression this spec caught (2026-07-24): the second
    // flush's markCanvasUpdate ate the structural render entirely, so the
    // node NEVER appeared — no amount of waiting made length reach 4.
    await expect.poll(async () => (await editor.getRootChildrenVisualOrder()).length, { timeout: 5_000 }).toBe(4);
    const visual = await editor.getRootChildrenVisualOrder();
    expect(visual[0]).toBe('hero');
    expect(visual[2]).toBe('features');
    expect(visual[3]).toBe('how');
  });
});
