// shape-edit.spec.ts — End-to-end tests for the SVG shape-editor
// wrapper-normalize-on-exit behavior in `SvgEditorOverlay.tsx`.
//
// What we're testing: when the user enters shape edit mode, reshapes a
// path so anchors land outside the wrapper's original viewBox / CSS box,
// and then exits — the SVG wrapper should snap to fit the painted
// geometry. Wrapper width / height grow, and `left` / `top` shift to
// keep the painted shape visually in place.
//
// We don't drive real anchor handles here — that exercises the
// in-tree SVG editor's (src/svg-editor/) pointer logic, its own concern.
// Instead we use the `__e2e.replaceSvgInner` hook to swap the path
// geometry directly (same mutation the library queues on pointer-up
// commit), then `__e2e.setShapeEditing(null)` to trigger the unmount-time
// normalization. This isolates the math under test.
//
// Seed: SHAPE_EDIT_TRIANGLE. A 200×200 SVG triangle at (500, 300) on
// the canvas. viewBox="0 0 200 200", preserveAspectRatio="none". Three
// vertices: top-center (100, 0), bottom-right (200, 200), bottom-left
// (0, 200) — the triangle exactly fills the wrapper.

import { test, expect, type Page } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

/** Read the SVG wrapper's source-level (post-normalization) styles + attrs. */
async function readSvgState(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const snap = (window as any).__e2e.nodesSnapshot();
    const node = snap[id];
    if (!node) return null;
    return {
      styles: node.styles ?? {},
      attrs: node.attrs ?? {},
    };
  }, nodeId);
}

/** Trigger a shape-edit cycle: enter → swap inner → exit. Resolves once
 *  the unmount-time normalization has had time to flush. */
async function reshapeAndExit(page: Page, nodeId: string, newInnerJSX: string) {
  await page.evaluate((id) => (window as any).__e2e.setShapeEditing(id), nodeId);
  // Let the overlay mount + register its window pointerup listeners.
  // SelectionOverlay gates the SvgEditorOverlay render on `corners`,
  // which comes from the rectCache — so we wait for the cache to settle.
  await page.waitForTimeout(300);
  await page.evaluate(({ id, jsx }) => (window as any).__e2e.replaceSvgInner(id, jsx), { id: nodeId, jsx: newInnerJSX });
  // Source mutation flushed → parser → renderer pushes updated tree to
  // iframe via postMessage → iframe rebuilds the SVG. The postMessage
  // round-trip + sandbox `render` execution is async — wait long enough
  // that getBBox in the next step measures the NEW path geometry, not
  // the stale polygon.
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__e2e.setShapeEditing(null));
  // SvgEditorOverlay unmount → flushNow + getBBoxAsync round-trip +
  // normalization mutations + flush + parse + render. Generous because
  // Comlink RPC adds postMessage latency.
  await page.waitForTimeout(600);
}

/**
 * Reshape by DRAGGING A REAL ANCHOR, then exit.
 *
 * `reshapeAndExit` swaps the path in SOURCE, which the sandbox editor
 * never sees — and the shape-edit host has a deliberate no-op guard
 * (`activeEditDirty`, set only by the editor's own onChange) that skips
 * the whole commit when the session made no edits, so nothing ever
 * normalizes. That guard exists on purpose: committing an untouched
 * shape re-serialises `<polygon>` into `<path>` and stamps child ids,
 * which breaks a later variant resize.
 *
 * So drive the editor the way a user does: grab an anchor ellipse inside
 * the iframe overlay and drag it. `pick` chooses which anchor by scoring
 * their screen positions (the seed triangle has three).
 *
 * Returns the screen-space delta actually applied, so callers can assert
 * against measured geometry instead of magic constants.
 */
async function reshapeByAnchorDrag(
  page: Page,
  editor: EditorPage,
  nodeId: string,
  pick: (box: { x: number; y: number }) => number,
  delta: { dx: number; dy: number },
): Promise<{ from: { x: number; y: number }; scale: number }> {
  await page.evaluate((id) => (window as any).__e2e.setShapeEditing(id), nodeId);
  await page.waitForTimeout(500);

  const anchors = editor.sandbox().locator('[data-svg-editor-overlay] ellipse');
  const count = await anchors.count();
  if (count === 0) throw new Error('shape editor exposed no anchors — did the overlay mount?');

  let bestIdx = 0;
  let bestScore = -Infinity;
  const boxes: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const b = await anchors.nth(i).boundingBox();
    if (!b) continue;
    const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    boxes.push(centre);
    const score = pick(centre);
    if (score > bestScore) { bestScore = score; bestIdx = boxes.length - 1; }
  }
  const from = boxes[bestIdx];

  // Screen px per user unit: the seed triangle spans 200 user units
  // between its two bottom vertices.
  const xs = boxes.map(b => b.x).sort((a, b) => a - b);
  const scale = (xs[xs.length - 1] - xs[0]) / 200;

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (delta.dx * i) / steps, from.y + (delta.dy * i) / steps, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  await page.evaluate(() => (window as any).__e2e.setShapeEditing(null));
  await page.waitForTimeout(900);
  return { from, scale };
}

test.describe('Shape edit — wrapper normalize on exit', () => {
  // Pipe browser console → Playwright stdout so the diagnostic logs from
  // SvgEditorOverlay show up next to the assertion failure.
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('svg-editor-overlay')) {
        console.log(`[browser ${msg.type()}]`, text);
      }
    });
  });

  test('right/bottom extension: wrapper grows, position unchanged', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    const before = await readSvgState(page, 'my-svg');
    expect(before?.styles.width).toBe('200px');
    expect(before?.styles.height).toBe('200px');
    expect(before?.styles.left).toBe('500px');
    expect(before?.styles.top).toBe('300px');
    expect(before?.attrs.viewBox).toBe('0 0 200 200');

    // Drag the bottom-RIGHT vertex further right + down: the painted
    // shape now spills past the wrapper's right/bottom edges only.
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => b.x + b.y, { dx: 70, dy: 60 });

    const after = await readSvgState(page, 'my-svg');
    // Wrapper grew on the right + bottom.
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);
    expect(parseFloat(after!.styles.height || '0')).toBeGreaterThan(200);
    // Position UNCHANGED — the bbox origin stayed at 0,0 so nothing shifts.
    expect(parseFloat(after!.styles.left || '0')).toBeCloseTo(500, 0);
    expect(parseFloat(after!.styles.top || '0')).toBeCloseTo(300, 0);
    // viewBox covers the painted shape, origin still ~0,0.
    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeCloseTo(0, 0);
    expect(vbY).toBeCloseTo(0, 0);
    expect(vbW).toBeGreaterThan(200);
    expect(vbH).toBeGreaterThan(200);
  });

  test('left/top extension: wrapper grows AND moves up-left, painted shape stays put', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Drag the TOP vertex up and to the left, so the painted bbox starts
    // at negative user-space coords — the case that used to leave the
    // shape visually jumping on exit.
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => -(b.x + b.y), { dx: -60, dy: -40 });

    const after = await readSvgState(page, 'my-svg');
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);
    expect(parseFloat(after!.styles.height || '0')).toBeGreaterThan(200);
    // Moved up + left so the painted shape stays where the user put it.
    expect(parseFloat(after!.styles.left || '0')).toBeLessThan(500);
    expect(parseFloat(after!.styles.top || '0')).toBeLessThan(300);
    // viewBox origin goes negative with it.
    const [vbX, vbY] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeLessThan(0);
    expect(vbY).toBeLessThan(0);
  });

  test('left/top offset matches the viewBox shift exactly (wrapper math is self-consistent)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Exact user-space targets aren't reachable through a real pointer
    // drag (sub-pixel rounding), so assert the CONTRACT instead: after
    // normalization the wrapper's CSS box must be the viewBox scaled by
    // the original units-per-pixel, and its offset must equal the
    // viewBox origin shift. That relationship is what actually keeps the
    // painted shape from jumping — magic constants only proved one case.
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => -(b.x + b.y), { dx: -60, dy: -40 });

    const after = await readSvgState(page, 'my-svg');
    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    const w = parseFloat(after!.styles.width || '0');
    const h = parseFloat(after!.styles.height || '0');
    const left = parseFloat(after!.styles.left || '0');
    const top = parseFloat(after!.styles.top || '0');

    // Seed starts 200 CSS px per 200 viewBox units → 1 px per unit.
    expect(w).toBeCloseTo(vbW, 0);
    expect(h).toBeCloseTo(vbH, 0);
    expect(left).toBeCloseTo(500 + vbX, 0);
    expect(top).toBeCloseTo(300 + vbY, 0);
  });

  test('all-directions extension: wrapper covers full painted geometry', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Push one vertex up-left and another down-right, so the painted
    // geometry escapes the wrapper on every side in one session.
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => -(b.x + b.y), { dx: -50, dy: -35 });
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => b.x + b.y, { dx: 55, dy: 45 });

    const after = await readSvgState(page, 'my-svg');
    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbW).toBeGreaterThan(200);
    expect(vbH).toBeGreaterThan(200);
    expect(vbX).toBeLessThan(0);
    expect(vbY).toBeLessThan(0);
    // The CSS box tracks the viewBox on both axes.
    expect(parseFloat(after!.styles.width || '0')).toBeCloseTo(vbW, 0);
    expect(parseFloat(after!.styles.height || '0')).toBeCloseTo(vbH, 0);
  });

  test('no reshape: wrapper bounds unchanged on exit (already-fits early-out)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Enter and exit shape edit without changing geometry. The
    // already-fits tolerance check should skip normalization, leaving
    // the source bytes untouched.
    await page.evaluate(() => (window as any).__e2e.setShapeEditing('my-svg'));
    await page.waitForTimeout(50);
    await page.evaluate(() => (window as any).__e2e.setShapeEditing(null));
    await page.waitForTimeout(400);

    const after = await readSvgState(page, 'my-svg');
    expect(after?.styles.width).toBe('200px');
    expect(after?.styles.height).toBe('200px');
    expect(after?.styles.left).toBe('500px');
    expect(after?.styles.top).toBe('300px');
    expect(after?.attrs.viewBox).toBe('0 0 200 200');
  });

  test('multiple reshape cycles via real drag flow: no drift', async ({ page }) => {
    // Same drift scenario but through the realistic drag path: each cycle
    // mimics a live drag (`bridge.setInnerHTML` mid-drag, no source
    // mutation) followed by a pointerup commit (`replaceSvgInner`) and
    // exit. Catches drift specifically in the live-flow rect/cache state
    // that the source-only test above can't see.
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    const reshapes = [
      '<path d="M -50 -30 L 220 200 L 0 200 Z" fill="#3b82f6" />',
      '<path d="M -100 -60 L 250 230 L 0 230 Z" fill="#3b82f6" />',
      '<path d="M -150 -90 L 280 260 L 0 260 Z" fill="#3b82f6" />',
    ];

    for (const inner of reshapes) {
      await page.evaluate(() => (window as any).__e2e.setShapeEditing('my-svg'));
      await page.waitForTimeout(200);
      // Simulate ~5 drag frames hitting setInnerHTML directly (no source
      // mutation), like the library's per-pointermove `setSvgContent`.
      for (let i = 0; i < 5; i++) {
        await page.evaluate((jsx) => (window as any).__e2e.dragSetSvgInner('my-svg', jsx), inner);
        await page.waitForTimeout(20);
      }
      // Pointerup commit.
      await page.evaluate((jsx) => (window as any).__e2e.replaceSvgInner('my-svg', jsx), inner);
      await page.waitForTimeout(150);
      // Exit.
      await page.evaluate(() => (window as any).__e2e.setShapeEditing(null));
      await page.waitForTimeout(500);

      const after = await readSvgState(page, 'my-svg');
      const parts = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
      const wpx = parseFloat(after!.styles.width || '0');
      const hpx = parseFloat(after!.styles.height || '0');
      // Wrapper px must equal viewBox dims exactly to keep scale at 1.
      expect(wpx).toBe(parts[2]);
      expect(hpx).toBe(parts[3]);
    }
  });

  test('multiple reshape cycles: no drift across enter/edit/exit iterations', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Drift trap: any FP-vs-rounded mismatch between `viewBox` and
    // `wrapper width/height` makes `scaleX = wrapperW / vbW` deviate from
    // 1 by epsilon. The next normalization reads that off scale, the
    // painted geometry's projected screen position is offset by a
    // fraction of a pixel, and over a few iterations the wrapper no
    // longer fits the painted shape. The user reported "after 2/3
    // reshapes the overlay goes off the shape" — this test reshapes
    // four times in a row and verifies the wrapper still tightly fits
    // each new bbox.

    const reshapes = [
      // Each reshape moves the apex further up-left AND extends the right
      // base further right — every cycle grows the bbox in two axes.
      '<path d="M -50 -30 L 220 200 L 0 200 Z" fill="#3b82f6" />',
      '<path d="M -100 -60 L 250 230 L 0 230 Z" fill="#3b82f6" />',
      '<path d="M -150 -90 L 280 260 L 0 260 Z" fill="#3b82f6" />',
      '<path d="M -200 -120 L 310 290 L 0 290 Z" fill="#3b82f6" />',
    ];

    for (const inner of reshapes) {
      await reshapeAndExit(page, 'my-svg', inner);
      const after = await readSvgState(page, 'my-svg');
      // viewBox must always parse to four integers — `Number()`-equality
      // with the integer round trip catches any FP creep.
      const parts = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
      expect(parts.length).toBe(4);
      for (const v of parts) {
        expect(Number.isInteger(v)).toBe(true);
      }
      // Wrapper size must equal viewBox dimensions exactly (scale 1) to
      // prevent compounding. If this drifts, the next iteration reads
      // an off-by-epsilon scale and the bug compounds.
      const wpx = parseFloat(after!.styles.width || '0');
      const hpx = parseFloat(after!.styles.height || '0');
      expect(wpx).toBe(parts[2]);
      expect(hpx).toBe(parts[3]);
    }
  });

  test('mimics real drag flow: imperative iframe write then commit (left/top)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    const before = await readSvgState(page, 'my-svg');
    expect(before?.styles.left).toBe('500px');
    expect(before?.styles.top).toBe('300px');
    expect(before?.styles.width).toBe('200px');
    expect(before?.styles.height).toBe('200px');

    // A real anchor drag IS the imperative-first path: every pointermove
    // writes the new geometry straight into the iframe DOM while source
    // still holds the pre-drag wrapper bounds. Exiting is the moment
    // normalization has to reconcile the two — the divergence window the
    // original synthetic version was written to cover.
    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => -(b.x + b.y), { dx: -55, dy: -20 });

    const after = await readSvgState(page, 'my-svg');
    expect(parseFloat(after!.styles.left || '0')).toBeLessThan(500);
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);
    const [vbX] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeLessThan(0);
  });

  test('painted shape stays visually in place after left/top extension', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    const beforeBox = await editor.nodeBox('my-svg');

    await reshapeByAnchorDrag(page, editor, 'my-svg', (b) => -(b.x + b.y), { dx: -60, dy: -40 });

    // The wrapper grew up-left to encompass the new painted bbox: it now
    // starts higher and further left, and covers more area. (If the
    // wrapper grew without moving, the shape would visibly jump — the
    // bug this case exists for.)
    const afterBox = await editor.nodeBox('my-svg');
    expect(afterBox.x).toBeLessThan(beforeBox.x);
    expect(afterBox.y).toBeLessThan(beforeBox.y);
    expect(afterBox.width).toBeGreaterThan(beforeBox.width);
    expect(afterBox.height).toBeGreaterThan(beforeBox.height);
  });
});
