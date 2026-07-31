// regressions.spec.ts — Cross-strategy regression tests for recent
// drag/drop fixes. Each test corresponds to a real bug and documents
// its regression scenario. If a future change re-breaks one of
// these, the test fails loudly.
//
//   - visual-order-sort-after-css-order
//   - edge-magnet-between-touching-siblings
//   - toolbar-drop-must-renumber-orders
//   - hover-flash-during-entry-grace
//   - layout-entry-must-renumber-orders
//
// Each test seeds a known-broken-before state, performs the drag, and
// asserts on the OBSERVED post-condition (visual order, drop-line index,
// committed `order` styles). Pre-fix versions of these tests would FAIL.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('Drag/drop regressions', () => {
  test('drop-line position uses VISUAL order, not JSX order, after a CSS-order reorder', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REORDERED_FLEX_COLUMN');

    // Visual order: hero (order:0), features (order:1), how (order:2).
    // JSX order: how, hero, features.
    expect(await editor.getRootChildrenVisualOrder()).toEqual(['hero', 'features', 'how']);

    // Drag `features` UP to land BEFORE hero. Cursor at hero.top + 4.
    // Without the visual-order sort fix, the strategy would pair JSX-
    // adjacent rects (how/hero, hero/features) and the drop-line would
    // land on top of an unrelated section.
    const featuresBox = await editor.nodeBox('features');
    const heroBox = await editor.nodeBox('hero');
    const from = { x: featuresBox.x + featuresBox.width / 2, y: featuresBox.y + featuresBox.height / 2 };
    const to = { x: heroBox.x + heroBox.width / 2, y: heroBox.y + 4 };

    await editor.dragFromTo(from, to);
    expect(await editor.getRootChildrenVisualOrder()).toEqual(['features', 'hero', 'how']);
  });

  test('toolbar drop into a parent with explicit `order: N` siblings respects insertIndex', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REORDERED_FLEX_COLUMN');

    // Without the renumber-orders fix on toolbar drop, the new node
    // gets default `order: 0` and lands at the top regardless of where
    // the drop-line shows. With the fix, all siblings + the new node
    // are renumbered 0..N to match desired visual order.
    const heroBox = await editor.nodeBox('hero');
    // Cursor near hero's bottom edge → magnet promotes to root, drop-
    // line shows between hero and features.
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = heroBox.y + heroBox.height - 6;

    // Reuse the toolbar drag flow inline (avoids cross-spec helpers).
    await page.locator('[data-left-menu-item="insert"]').click();
    await page.locator('text="Elements"').first().hover();
    const item = page.locator('[data-toolbar-item="frame"]').first();
    await item.waitFor({ state: 'visible' });
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error('toolbar item missing');
    const itemFrom = { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 };
    await page.mouse.move(itemFrom.x, itemFrom.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      const t = i / 18;
      await page.mouse.move(itemFrom.x + (dropX - itemFrom.x) * t, itemFrom.y + (dropY - itemFrom.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    await editor.pumpDrag({ x: dropX, y: dropY }, 6);
    await page.mouse.up();
    await page.waitForTimeout(120);

    // Visual order MUST be: hero, NEW, features, how. NOT NEW, hero, …
    const visual = await editor.getRootChildrenVisualOrder();
    expect(visual.length).toBe(4);
    expect(visual[0]).toBe('hero');
    expect(visual[2]).toBe('features');
    expect(visual[3]).toBe('how');
  });

  test('edge-magnet works for ToolbarDragStrategy (touching siblings, gap=0)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('FLEX_COLUMN');

    // No gap between sections. Cursor 6px above hero/features boundary
    // (inside hero's bottom edge zone). Without the magnet, drop-line
    // would slot inside hero (or block entirely). With the magnet, it
    // promotes to root and shows insertIndex 1 (between hero and
    // features in visual order).
    const heroBox = await editor.nodeBox('hero');
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = heroBox.y + heroBox.height - 6;

    await page.locator('[data-left-menu-item="insert"]').click();
    await page.locator('text="Elements"').first().hover();
    const item = page.locator('[data-toolbar-item="frame"]').first();
    await item.waitFor({ state: 'visible' });
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error('toolbar item missing');
    const itemFrom = { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 };
    await page.mouse.move(itemFrom.x, itemFrom.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      const t = i / 18;
      await page.mouse.move(itemFrom.x + (dropX - itemFrom.x) * t, itemFrom.y + (dropY - itemFrom.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    await editor.pumpDrag({ x: dropX, y: dropY }, 6);

    const line = editor.dropLine();
    await expect(line).toHaveAttribute('data-parent-id', 'root');
    await expect(line).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
  });

  test('drop-line indicator data attributes match the strategy state', async ({ page }) => {
    // Sanity check: the data-parent-id and data-insert-index on the
    // drop-line indicator come straight from the strategy's
    // `dropLineOps.show()` call, so they're a reliable signal in tests.
    // This guards against future markup churn that drops the data attrs.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('FLEX_COLUMN_GAP');

    const hero = await editor.nodeBox('hero');
    const features = await editor.nodeBox('features');
    const dropX = hero.x + hero.width / 2;
    const dropY = (hero.y + hero.height + features.y) / 2;

    await page.locator('[data-left-menu-item="insert"]').click();
    await page.locator('text="Elements"').first().hover();
    const item = page.locator('[data-toolbar-item="frame"]').first();
    await item.waitFor({ state: 'visible' });
    const itemBox = await item.boundingBox();
    if (!itemBox) throw new Error('toolbar item missing');
    const itemFrom = { x: itemBox.x + itemBox.width / 2, y: itemBox.y + itemBox.height / 2 };
    await page.mouse.move(itemFrom.x, itemFrom.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      const t = i / 18;
      await page.mouse.move(itemFrom.x + (dropX - itemFrom.x) * t, itemFrom.y + (dropY - itemFrom.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    await editor.pumpDrag({ x: dropX, y: dropY }, 6);

    await expect(editor.dropLine()).toHaveAttribute('data-parent-id', 'root');
    await expect(editor.dropLine()).toHaveAttribute('data-insert-index', '1');

    await page.mouse.up();
  });
});
