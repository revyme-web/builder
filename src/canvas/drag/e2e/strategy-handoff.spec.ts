// strategy-handoff.spec.ts — the gesture outliving the strategy.
//
// Dragging a flow child over a DIFFERENT frame doesn't end the drag: the
// strategy commits an exit-to-canvas and hands the live gesture to
// CanvasDragStrategy. Anything scoped to the whole GESTURE (the hide that
// covers the dragged node's synced twins in other viewports, the dragged
// node's own follow-the-cursor liveness) must survive that swap — the old
// strategy's teardown runs mid-drag.
//
// Covers: flow-reparent--handoff-mid-drag, flow-reparent--exit-reenter-same-parent.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

// Multi-viewport specs need a wider window: at the default 1600px the
// replica tile is not hit-testable (pointer events never reach it) and
// every drag started there silently no-ops.
test.use({ viewport: { width: 1720, height: 1000 } });

test.describe('mid-drag strategy handoff', () => {
  test('the dragged node\'s twin in another viewport stays hidden across the handoff', async ({ page }) => {
    // REGRESSION (2026-08-05): the handoff called the layout strategy's
    // cleanup(), whose replica-restore un-hid the twins — so the copy in
    // the other viewport popped back at its pre-drag spot while the lifted
    // element kept following the cursor. The user saw the node twice.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('HANDOFF_TWO_VP');
    await editor.fitCamera();

    // The twin is visible before anything starts.
    await expect(await editor.nodeIn('desktop', 'chip-b')).toBeVisible();

    // Drag chip-b OUT of the tablet tile's source box and onto the
    // desktop tile's target frame — a different parent, so the handoff
    // fires mid-gesture.
    const target = await editor.nodeBoxIn('desktop', 'target-box');
    const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };

    await editor.duringDrag(
      'chip-b',
      to,
      async () => {
        // Mid-gesture, post-handoff: exactly ONE chip-b is painted — the
        // one under the cursor. The desktop twin must still be hidden.
        await expect(await editor.nodeIn('desktop', 'chip-b')).toBeHidden();
      },
      { vpId: 'tablet', steps: 24, pumpFrames: 10 },
    );

    // …and once the gesture ends, the hide is lifted again (the restore
    // is deferred to drag-end, not dropped).
    await expect(await editor.nodeIn('desktop', 'chip-b')).toBeVisible();
  });

  // OPEN QUESTION — not a claimed regression, an unresolved behaviour.
  //
  // Dragging a flow child onto a SIBLING container inside the same page
  // root never reparents it here: it drops back where it started. Traced
  // 2026-08-05 — `isOverParent` is evaluated against the top-level
  // viewport/root ancestor, not the immediate parent, so the cursor never
  // "leaves the parent" while it's still inside the page, and the
  // new-parent hit-test that performs the handoff is gated behind
  // `!isOverParent`. Tried both an empty target frame and aiming at the
  // bottom edge of an existing child inside it; neither reparents.
  //
  // Unknown whether real (non-synthetic) pointer input takes a different
  // path — the strategy does have a `cross-parent-target` branch that
  // fires in production traces. Left as fixme so the suite never claims
  // coverage it doesn't have. Resolve by watching a real drag with the
  // trace open, then either fix the product or write this test to match.
  test.fixme('dropping on a sibling container reparents into it', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('HANDOFF_TWO_VP');
    await editor.fitCamera();

    const target = await editor.nodeBoxIn('desktop', 'chip-c');
    await editor.dragNodeAsserted(
      'chip-b',
      { x: target.x + target.width / 2, y: target.y + target.height - 2 },
      { vpId: 'desktop', steps: 24, releaseDelayMs: 120 },
    );

    const code = await editor.getPageCode();
    const sourceBlock = code.slice(
      code.indexOf('data-id="source-box"'),
      code.indexOf('data-id="target-box"'),
    );
    expect(sourceBlock).toContain('data-id="chip-a"');
    expect(sourceBlock).not.toContain('data-id="chip-b"');
  });

  test('exiting the parent and coming back in one gesture still reorders', async ({ page }) => {
    // The round-trip the strategy explicitly supports: leaving the parent
    // hides the placeholders but must NOT commit an exit, so coming back
    // resumes reorder instead of dead-dropping onto the canvas.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('HANDOFF_TWO_VP');
    await editor.fitCamera();

    const chipA = await editor.nodeBoxIn('desktop', 'chip-a');
    const chipB = await editor.nodeBoxIn('desktop', 'chip-b');
    const from = { x: chipB.x + chipB.width / 2, y: chipB.y + chipB.height / 2 };
    // Out to empty canvas ABOVE the tile, then back onto chip-a's top half.
    const out = { x: chipB.x + chipB.width / 2, y: Math.max(12, chipA.y - 160) };
    const back = { x: chipA.x + chipA.width / 2, y: chipA.y + 6 };

    const mouse = page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    for (const point of [out, back]) {
      for (let i = 1; i <= 14; i++) {
        const t = i / 14;
        await mouse.move(from.x + (point.x - from.x) * t, from.y + (point.y - from.y) * t, { steps: 1 });
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      }
    }
    await page.waitForTimeout(120);
    await mouse.up();
    await page.waitForTimeout(150);

    // Back inside its original parent → a reorder, not an exit: chip-b is
    // still a child of source-box and now sorts before chip-a.
    const code = await editor.getPageCode();
    const sourceBlock = code.slice(
      code.indexOf('data-id="source-box"'),
      code.indexOf('data-id="target-box"'),
    );
    expect(sourceBlock).toContain('data-id="chip-b"');

    const orderA = await editor.getInlineStyleProp('chip-a', 'order');
    const orderB = await editor.getInlineStyleProp('chip-b', 'order');
    expect(Number(orderB)).toBeLessThan(Number(orderA));
  });
});
