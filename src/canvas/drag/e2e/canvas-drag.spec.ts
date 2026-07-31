// canvas-drag.spec.ts — End-to-end tests for CanvasDragStrategy.
//
// CanvasDragStrategy handles dragging a top-level canvas node (a frame
// living outside any viewport, with `data-canvas-node`). Scenarios:
//   - Move within the canvas (no parent change, just position update)
//   - Drag into a viewport's layout parent → drop-line + insert at index
//   - Drag into a non-layout frame → live reparent + absolute pos
//   - Edge-magnet: cursor near boundary between two touching siblings
//     promotes drop target to the parent
//   - Hover-flash regression: parent-highlight must NOT briefly fire
//     during the entry-grace window when target is a layout container
//     with children
//
// Runs against the current dev server (npm run dev) — playwright config
// reuses an existing server when one is already up.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('CanvasDragStrategy', () => {
  test('drag canvas node into a layout viewport (drop in gap)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CANVAS_NODE_WITH_GAP');

    // The seeded gap is 60px between hero and features. Drop the
    // floater into the middle of that gap so the cursor is inside
    // `root` directly (NOT inside any child) — the deepest layout
    // hit is the viewport root, no magnet needed.
    const heroBox = await editor.nodeBox('hero');
    const featuresBox = await editor.nodeBox('features');
    const dropY = (heroBox.y + heroBox.height + featuresBox.y) / 2;
    const dropX = heroBox.x + heroBox.width / 2;

    await editor.dragNodeFromTo('floater', { x: dropX, y: dropY });

    // The floater should now be a layout child of root, between hero
    // and features in visual order.
    const visual = await editor.getRootChildrenVisualOrder();
    expect(visual).toEqual(['hero', 'floater', 'features', 'how']);
  });

  test('edge-magnet promotes when cursor sits near a touching sibling boundary', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CANVAS_NODE_SMALL');

    // FLEX_COLUMN-style: hero / features / how all touch (gap=0).
    // Aim cursor 8px below hero's top edge: still inside hero, AND
    // the dragged floater's full rect fits inside hero (so the
    // hit-test's `fullyInside` check passes — without that, hit-test
    // suppresses entry and the magnet never gets a chance).
    //
    // Magnet then sees: cursor's distStart from hero.top = 8px (inside
    // edgePx=12), parent of hero = root, root is flex column → promote
    // to root, drop-line at insertIndex 0 (before hero in visual order).
    const heroBox = await editor.nodeBox('hero');
    const floaterBox = await editor.nodeBox('floater');
    const dropX = heroBox.x + heroBox.width / 2;
    // Cursor must satisfy two constraints simultaneously:
    //   - Floater (20×20) fully inside hero on the layout axis →
    //     cursor.y >= hero.top + floater.height / 2
    //   - Within edgePx (12) of hero's top edge → cursor.y <= hero.top + 12
    // cursor.y = hero.top + 10 satisfies both (10 in [floater_h/2=10, edgePx=12]).
    const dropY = heroBox.y + floaterBox.height / 2;

    const from = await editor.nodeCenter('floater');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      const t = i / 18;
      await page.mouse.move(from.x + (dropX - from.x) * t, from.y + (dropY - from.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
    // Pump extra wiggle frames so the entry-hysteresis grace counter
    // ticks past ENTRY_GRACE_FRAMES (5) and the strategy confirms
    // entry → drop-line shows.
    await editor.pumpDrag({ x: dropX, y: dropY }, 25);

    const line = editor.dropLine();
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-parent-id', 'root');
    await expect(line).toHaveAttribute('data-insert-index', '0');

    await page.mouse.up();
  });

  test('no parent-highlight flash on ROOT during entry-grace when magnet promotes', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CANVAS_NODE_SMALL');

    // Reproduce the user-reported flash: cursor sweeps into hero's top
    // edge zone, magnet promotes to root, drop-line confirms after the
    // grace window. During the grace, the highlight must NOT briefly
    // fire for ROOT — that's the visual stutter the recent fix kills.
    //
    // Note: the flash is specifically about ROOT (the would-be
    // drop-line parent). A legitimate parent-highlight on a SECTION
    // during a non-layout drop is a different code path and doesn't
    // count as a flash.
    const heroBox = await editor.nodeBox('hero');
    const floaterBox = await editor.nodeBox('floater');
    const dropX = heroBox.x + heroBox.width / 2;
    const dropY = heroBox.y + floaterBox.height / 2;
    const from = await editor.nodeCenter('floater');

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();

    let sawRootHighlight = false;
    const checkOverlays = async () => {
      const state = await page.evaluate(() => ({
        highlightParent: document.querySelector('[data-parent-highlight]')?.getAttribute('data-parent-id') ?? null,
        highlightSource: document.querySelector('[data-parent-highlight]')?.getAttribute('data-source') ?? null,
        hasDropLine: !!document.querySelector('[data-drop-line-indicator]'),
      }));
      // Flash bug: drag-source highlight on root WITHOUT a drop-line
      // already showing for root.
      if (state.highlightSource === 'drag' && state.highlightParent === 'root' && !state.hasDropLine) {
        sawRootHighlight = true;
      }
    };

    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      await page.mouse.move(from.x + (dropX - from.x) * t, from.y + (dropY - from.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      await checkOverlays();
    }
    // Continue pumping while in the magnet zone — this is the window
    // where the flash would have appeared.
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(dropX + (i % 2), dropY + ((i + 1) % 2), { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      await checkOverlays();
    }

    await page.mouse.up();
    expect(sawRootHighlight).toBe(false);
  });
});
