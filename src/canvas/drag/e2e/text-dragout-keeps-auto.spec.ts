// text-dragout-keeps-auto.spec.ts — an auto-size text dragged out of a layout
// parent onto the canvas stays auto (user report 2026-10-16).
//
// The bug: the drop committed the MEASURED box (`width: 95px; height: 19px`)
// for a `<p>` that had no size of its own, and rounding 95.19 down wrapped its
// last letter. Plain `auto` is no fix either: canvas nodes are absolute
// children of a 0px-wide content root, so an `auto` text right of x≈0
// shrink-to-fits against nothing and breaks after every word. The drop lands
// BELOW the viewport (positive canvas x) to prove the committed width holds
// one line there.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('auto-size text dragged out of a centred column stays auto, on one line', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('TEXT_IN_CENTERED_COLUMN');

  const before = await editor.nodeBox('label');
  const vp = await editor.nodeBox('root');
  const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  // Below the viewport, still within its horizontal span → positive canvas x.
  const to = { x: vp.x + Math.min(vp.width * 0.4, 300), y: vp.y + vp.height + 120 };
  await editor.dragFromTo(from, to);

  const code = await editor.getPageCode();
  expect(code).toMatch(/data-id="label"[\s\S]*?data-canvas-node="true"|data-canvas-node="true"[^>]*data-id="label"/);
  expect(await editor.getInlineStyleProp('label', 'width')).toBe('max-content');
  expect(await editor.getInlineStyleProp('label', 'height')).toBe('auto');

  // Painted on ONE line at its natural width (zoom-independent ratios).
  const after = await editor.nodeBox('label');
  expect(after.y).toBeGreaterThan(vp.y + vp.height);   // it really left the viewport
  expect(after.height).toBeLessThan(before.height * 1.5);
  expect(Math.abs(after.width - before.width)).toBeLessThan(2);
});
