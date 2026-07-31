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

    // New geometry: vertices extend to (300, 300) — 100 units past the
    // right and bottom edges of the original viewBox.
    await reshapeAndExit(
      page,
      'my-svg',
      '<path d="M 100 0 L 300 300 L 0 200 Z" fill="#3b82f6" />',
    );

    const after = await readSvgState(page, 'my-svg');
    // Wrapper grew on the right + bottom.
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);
    expect(parseFloat(after!.styles.height || '0')).toBeGreaterThan(200);
    // Position UNCHANGED — bbox.x / bbox.y stayed at 0,0 so no shift.
    expect(parseFloat(after!.styles.left || '0')).toBeCloseTo(500, 0);
    expect(parseFloat(after!.styles.top || '0')).toBeCloseTo(300, 0);
    // viewBox covers the painted shape (origin still ~0,0).
    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeCloseTo(0, 0);
    expect(vbY).toBeCloseTo(0, 0);
    expect(vbW).toBeGreaterThan(200);
    expect(vbH).toBeGreaterThan(200);
  });

  test('left/top extension: wrapper grows AND moves up-left, painted shape stays put', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // New geometry: top vertex moved up-left to (-50, -30). Painted bbox
    // becomes {-50, -30, 250, 230}. Wrapper should:
    //   • grow:    width 200→250, height 200→230
    //   • move:    left 500→450 (-50 px), top 300→270 (-30 px)
    //   • viewBox: "-50 -30 250 230"
    await reshapeAndExit(
      page,
      'my-svg',
      '<path d="M -50 -30 L 200 200 L 0 200 Z" fill="#3b82f6" />',
    );

    const after = await readSvgState(page, 'my-svg');

    // Width/height grew.
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);
    expect(parseFloat(after!.styles.height || '0')).toBeGreaterThan(200);
    // Position SHIFTED — moved up + left so the painted shape stays
    // visually where it was. This is the case the user reported as
    // broken before the imperative-first patch.
    expect(parseFloat(after!.styles.left || '0')).toBeLessThan(500);
    expect(parseFloat(after!.styles.top || '0')).toBeLessThan(300);

    // viewBox origin should be negative (the painted bbox starts at
    // negative user-space coords).
    const [vbX, vbY] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeLessThan(0);
    expect(vbY).toBeLessThan(0);
  });

  test('left/top exact values: wrapper offset matches bbox extension', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Top-left extension by exactly 50 units left, 30 units up. Bbox
    // becomes {-50, -30, 250, 230}. With scaleX = scaleY = 1:
    //   newLeft = 500 + (-50 - 0) * 1 = 450
    //   newTop  = 300 + (-30 - 0) * 1 = 270
    //   newW    = 250, newH = 230
    await reshapeAndExit(
      page,
      'my-svg',
      '<path d="M -50 -30 L 200 200 L 0 200 Z" fill="#3b82f6" />',
    );

    const after = await readSvgState(page, 'my-svg');
    expect(parseFloat(after!.styles.width || '0')).toBeCloseTo(250, 0);
    expect(parseFloat(after!.styles.height || '0')).toBeCloseTo(230, 0);
    expect(parseFloat(after!.styles.left || '0')).toBeCloseTo(450, 0);
    expect(parseFloat(after!.styles.top || '0')).toBeCloseTo(270, 0);

    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeCloseTo(-50, 0);
    expect(vbY).toBeCloseTo(-30, 0);
    expect(vbW).toBeCloseTo(250, 0);
    expect(vbH).toBeCloseTo(230, 0);
  });

  test('all-directions extension: wrapper covers full painted geometry', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Reshape so the path extends in EVERY direction beyond the original
    // viewBox. Bbox → {-40, -25, 290, 260}.
    await reshapeAndExit(
      page,
      'my-svg',
      '<path d="M -40 -25 L 250 -10 L 200 235 L -20 200 Z" fill="#3b82f6" />',
    );

    const after = await readSvgState(page, 'my-svg');
    // Grew on every axis.
    expect(parseFloat(after!.styles.width || '0')).toBeCloseTo(290, 0);
    expect(parseFloat(after!.styles.height || '0')).toBeCloseTo(260, 0);
    // Position shifted to align with the new bbox top-left.
    expect(parseFloat(after!.styles.left || '0')).toBeCloseTo(460, 0);
    expect(parseFloat(after!.styles.top || '0')).toBeCloseTo(275, 0);

    const [vbX, vbY, vbW, vbH] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeCloseTo(-40, 0);
    expect(vbY).toBeCloseTo(-25, 0);
    expect(vbW).toBeCloseTo(290, 0);
    expect(vbH).toBeCloseTo(260, 0);
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

  test('mimics real drag flow: imperative iframe write + delayed source commit (left/top)', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    const before = await readSvgState(page, 'my-svg');
    expect(before?.styles.left).toBe('500px');
    expect(before?.styles.top).toBe('300px');
    expect(before?.styles.width).toBe('200px');
    expect(before?.styles.height).toBe('200px');

    // Enter shape edit mode.
    await page.evaluate(() => (window as any).__e2e.setShapeEditing('my-svg'));
    await page.waitForTimeout(300);

    // Mid-drag: library calls `setSvgContent` repeatedly, which hits
    // `bridge.setInnerHTML` (iframe DOM only — NO source mutation).
    // We mimic that with `__e2e.dragSetSvgInner`. This is the path the
    // synthetic `replaceSvgInner` test bypasses, so a separate case.
    const newInner = '<path d="M 100 0 L 200 200 L -50 200 Z" fill="#3b82f6" />';
    await page.evaluate((jsx) => (window as any).__e2e.dragSetSvgInner('my-svg', jsx), newInner);
    await page.waitForTimeout(100);

    // Pointerup commit: queues `replaceSvgInner` to write the new path
    // into source. Does NOT touch wrapper bounds. The iframe and source
    // are now consistent on the path itself, but wrapper bounds in
    // `node.styles` and `node.attrs.viewBox` still reflect the pre-drag
    // state — exactly the moment when the unmount-time normalization
    // has to do its work.
    await page.evaluate((jsx) => (window as any).__e2e.replaceSvgInner('my-svg', jsx), newInner);
    await page.waitForTimeout(150);

    // Exit shape edit mode → cleanup → normalize.
    await page.evaluate(() => (window as any).__e2e.setShapeEditing(null));
    await page.waitForTimeout(600);

    const after = await readSvgState(page, 'my-svg');
    // Wrapper grew + moved up/left to encompass the painted bbox.
    expect(parseFloat(after!.styles.left || '0')).toBeLessThan(500);
    expect(parseFloat(after!.styles.width || '0')).toBeGreaterThan(200);

    // viewBox origin matches bbox left edge (negative).
    const [vbX] = (after!.attrs.viewBox || '').split(/\s+/).map(Number);
    expect(vbX).toBeLessThan(0);
  });

  test('painted shape stays visually in place after left/top extension', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('SHAPE_EDIT_TRIANGLE');

    // Capture the painted geometry's position BEFORE reshape (the
    // polygon is the original geometry — its on-screen rect is the same
    // as the wrapper's).
    const beforeBox = await editor.nodeBox('my-svg');

    // Reshape extending up-left.
    await reshapeAndExit(
      page,
      'my-svg',
      '<path d="M -50 -30 L 200 200 L 0 200 Z" fill="#3b82f6" />',
    );

    // The wrapper's bounding rect should now START at a SMALLER x/y
    // than before (it shifted up-left to encompass the painted bbox).
    // The painted bbox's top-left should match where (-50, -30) used to
    // render, which is `before.x - 50 * 0.5` (canvas zoom 0.5) and
    // `before.y - 30 * 0.5`. That is the new wrapper's top-left (which
    // corresponds to the new viewBox origin).
    const afterBox = await editor.nodeBox('my-svg');
    expect(afterBox.x).toBeLessThan(beforeBox.x);
    expect(afterBox.y).toBeLessThan(beforeBox.y);
    expect(afterBox.width).toBeGreaterThan(beforeBox.width);
    expect(afterBox.height).toBeGreaterThan(beforeBox.height);
  });
});
