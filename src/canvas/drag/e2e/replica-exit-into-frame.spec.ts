// Reported 2026-08-26: drag a layout child out of the TABLET/MOBILE replica,
// across open canvas, and into a NO-LAYOUT canvas frame — one continuous
// gesture. Nothing reparented: no highlight while over the frame, and on
// mouseup the node stayed a floating canvas node. From the PRIMARY it worked.
//
// Root cause: after the mid-drag LayoutLifted→Canvas handoff, entry detection
// read the dragged element's rect back from the bridge rect cache under the
// node model's viewport. Post-handoff the cache holds one entry per viewport
// that ever painted the node, and all but the origin's are PRE-DRAG rects —
// hidden copies keep their last emitted rect, so the lookup was either
// unmeasurable (bail) or stale (never "fully inside" the frame). The dragged
// element's rect is now the strategy's own per-frame write, which cannot be
// stale — see canvasRectToScreen in drag/helpers/coords.ts.
//
// Harness notes, learned the hard way:
//  - primeNode(click) followed immediately by mouse.down at the same point is
//    a DOUBLE-CLICK — it planted a text node inside the pressed frame. Prime
//    the PARENT, select the child via the __e2e hook, and wait out the
//    dblclick window before pressing.
//  - [data-parent-highlight] exists in the DOM even when hidden — assert
//    toBeVisible, never count().
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1720, height: 1000 } });

async function runGesture(editor: EditorPage, vpId: 'desktop' | 'tablet' | 'mobile', dragId = 'card-inner') {
  const page = editor.page();
  await editor.fitCamera();

  // Real click starts the tile's rect stream; hook-select picks the child
  // without click-selection ambiguity; the wait breaks the dblclick window.
  await editor.primeNode('card', vpId);
  await editor.select([dragId], vpId);
  await page.waitForTimeout(600);

  const inner = await editor.nodeBoxIn(vpId, dragId);
  const frame = await editor.nodeBox('drop-frame');
  // Off-center press so the press point differs from the prime click.
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const to = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  // Stage 1 — straight down out of the tile onto open canvas (LayoutLifted
  // lifts, goes off-parent). Stage 2 — across into the frame (mid-drag exit
  // commit + handoff to CanvasDragStrategy on the way, then entry).
  const mid = { x: from.x, y: frame.y - 40 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (const [a, b] of [[from, mid], [mid, to]] as const) {
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  }
  // Entry hysteresis (3 frames) needs real pointermoves at the target.
  await editor.pumpDrag(to, 8);

  // The mid-drag affordance IS part of the report: hovering the no-layout
  // frame must light it up as the drop target before mouseup.
  await expect(page.locator('[data-parent-highlight]')).toBeVisible();

  // NO ENTRY JUMP (second report, 2026-08-26): after the live reparent the
  // element must still sit under the cursor, not teleport and recalibrate at
  // mouseup. Three distinct causes produced exactly that jump, all caught by
  // this one assertion:
  //   - entry commit anchored on the dragged node's (stale) cache rect;
  //   - entry commit projected MODEL canvas coords while the element was
  //     still parked in its origin tile (constant offset until mouseup);
  //   - replica-origin: only the hidden model-prefix copy was re-homed, and
  //     the collapse's re-prefix then matched the drag-start hide stylesheet.
  // Scoped to the frame — the dragged element is a DESCENDANT of drop-frame
  // after the live reparent, and an unscoped [data-id] match can land on a
  // hidden tile copy. `:visible` because a stylesheet hide leaves no box.
  // Any visible child — a replica-origin gesture continues on a FRESH-ID
  // CLONE after the mid-drag split, so matching `card-inner` would miss it.
  const inFrame = () => editor.sandbox()
    .locator('[data-id="drop-frame"] > [data-id]:visible:not([data-id="dead-child"])')
    .first().boundingBox();
  const assertUnderCursor = (box: { x: number; y: number; width: number; height: number } | null, at: { x: number; y: number }, label: string) => {
    expect(box, `dragged element has a visible box inside the frame (${label})`).not.toBeNull();
    const pad = 2; // snap can hold the element a hair off the raw cursor
    expect(
      at.x >= box!.x - pad && at.x <= box!.x + box!.width + pad
      && at.y >= box!.y - pad && at.y <= box!.y + box!.height + pad,
      `cursor (${at.x},${at.y}) escaped the element box ${label} `
      + `[${Math.round(box!.x)},${Math.round(box!.y)} ${Math.round(box!.width)}x${Math.round(box!.height)}]`,
    ).toBe(true);
  };
  assertUnderCursor(await inFrame(), to, 'after entry');

  // KEEPS FOLLOWING (third report, 2026-08-26): the ±1px pump above cannot
  // tell a tracking element from a FROZEN one. After the reparent the write
  // routing must follow the ENTERED viewport — the interacting viewport was
  // still the origin replica, so every post-entry patch went to a prefixed
  // element the entry collapse had removed, and the element hung mid-air
  // until mouseup. Travel a real distance inside the frame and re-assert.
  const to2 = { x: to.x + 40, y: to.y + 30 };
  for (let i = 1; i <= 6; i++) {
    await mouse.move(to.x + ((to2.x - to.x) * i) / 6, to.y + ((to2.y - to.y) * i) / 6, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  assertUnderCursor(await inFrame(), to2, 'after post-entry travel');

  await mouse.up();
  await page.waitForTimeout(400);
}

for (const vpId of ['tablet', 'mobile'] as const) {
  test(`THE BUG: ${vpId}-origin drag reparents into the canvas frame`, async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
    await runGesture(editor, vpId);

    // A replica drag-out is a SPLIT, not a move (fourth report, 2026-08-26 —
    // "it deletes all the counterparts"): the other breakpoints still render
    // card-inner, so the source must STAY inside card, hidden ONLY on the
    // origin viewport via its band; the frame receives a fresh-id CLONE so
    // the original's @media rules don't follow it. Same rule the plain
    // drop-on-canvas path (replica-dragout-3vp.spec) already enforces.
    const code = await editor.getPageCode();
    const frameChildren = childIdsOf(code, 'drop-frame').filter((id) => id !== 'dead-child');
    expect(frameChildren.length, `drop-frame children — code was:\n${code}`).toBe(1);
    expect(frameChildren[0], 'frame receives a CLONE, not the source').not.toBe('card-inner');
    expect(childIdsOf(code, 'card'), 'counterparts keep the source inside card')
      .toContain('card-inner');
    const bandWidth = vpId === 'tablet' ? 768 : 375;
    const band = code.slice(code.indexOf(`@media (max-width: ${bandWidth}px)`));
    expect(
      /\[data-id="card-inner"\][^}]*display:\s*none/.test(band.slice(0, band.indexOf('@media', 10) === -1 ? undefined : band.indexOf('@media', 10))),
      `origin band (${bandWidth}px) hides the source — code was:\n${code}`,
    ).toBe(true);
  });
}

test('SOLO replica → canvas → no-layout frame: inserted VISIBLE', async ({ page }) => {
  // `solo-chip` is hidden-by-default (inline display:'none') and un-hidden
  // only by the tablet band — a manual hide-everywhere-else, no
  // data-replica-solo attr. Dragging it out is a MOVE that used to carry the
  // inline hide with it: inside a canvas frame no band can ever flip it back,
  // so the insert landed correct and invisible (sixth report, 2026-08-26).
  // runGesture's mid-drag `:visible`-in-frame assertions ARE the symptom
  // check; the code assertions pin the committed shape.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await runGesture(editor, 'tablet', 'solo-chip');

  const code = await editor.getPageCode();
  const kids = childIdsOf(code, 'drop-frame').filter((id) => id !== 'dead-child');
  expect(kids, 'solo moves — same id, no clone').toEqual(['solo-chip']);
  expect((code.match(/data-id="solo-chip"/g) ?? []).length).toBe(1);
  const frameSeg = code.slice(code.indexOf('data-id="drop-frame"'));
  expect(tagOf(frameSeg, 'solo-chip'), 'inline hide cleared on the moved node')
    .not.toMatch(/display:\s*'none'/);
  expect(code, 'the origin un-hide band is gone with it')
    .not.toMatch(/\[data-id="solo-chip"\][^}]*display/);
});

test('SOLO replica drag-out to open canvas: moved, selected, viewport reset', async ({ page }) => {
  // `solo-chip` renders ONLY on the tablet replica (hidden-by-default + band
  // un-hide). Dragging it out is a plain MOVE — no counterparts to protect —
  // and the drop landed correctly, but nothing after it worked (fifth report,
  // 2026-08-26): the interacting viewport stayed `tablet`, so Layers expanded
  // the tablet section (the node is a canvas node now — no highlight) and the
  // overlay polled `tablet-solo-chip`, which no longer exists. The
  // coordinator's canvas-drop detection read the STALE atom node map; only
  // the imperative cache knows about a mid-gesture exit.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await editor.fitCamera();

  await editor.primeNode('card', 'tablet');
  await editor.select(['solo-chip'], 'tablet');
  await page.waitForTimeout(600);

  const chip = await editor.nodeBoxIn('tablet', 'solo-chip');
  const tile = await (await editor.nodeIn('tablet', 'root')).boundingBox();
  const from = { x: chip.x + chip.width / 2 + 6, y: chip.y + chip.height / 2 + 4 };
  // Straight up, out of the tile's top edge onto open canvas — no frames up
  // there, so the drop is the plain solo exit at mouseup.
  const to = { x: from.x, y: (tile?.y ?? chip.y) - 110 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await editor.pumpDrag(to, 6);
  await mouse.up();
  await page.waitForTimeout(400);

  const code = await editor.getPageCode();
  // Solo semantics: the SOURCE moves — one id, no clone, out of card and into
  // the canvasNodes fragment, with the hide-by-default display cleared.
  expect(childIdsOf(code, 'card')).not.toContain('solo-chip');
  expect((code.match(/data-id="solo-chip"/g) ?? []).length, 'one copy — moved, not cloned').toBe(1);
  const canvasSeg = code.slice(code.indexOf('const canvasNodes'));
  expect(canvasSeg).toContain('data-id="solo-chip"');
  expect(tagOf(canvasSeg, 'solo-chip')).not.toMatch(/display:\s*'none'/);

  // The drop is only DONE when the editor follows it: selection sticks to the
  // moved node and the interacting viewport resets to primary (Layers
  // highlight, overlay rect, and style-write routing all read from that pair).
  expect(await page.evaluate(() => (window as any).__e2e.selection())).toEqual(['solo-chip']);
  const resets = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('canvas-drop-reset-viewport') ?? []).length);
  expect(resets, 'interacting viewport reset to primary on the canvas drop').toBeGreaterThan(0);
});

test('interaction outline keeps tracking through a LAYOUT-frame entry', async ({ page }) => {
  // Replica → canvas → canvas frame WITH layout (seventh report, 2026-08-26):
  // the moment the drag entered the flex frame, the blue interaction outline
  // froze at the entry spot — a ghost that only cleared on mouseup — while
  // the element itself kept following the cursor. No-layout frames were fine.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await editor.fitCamera();

  await editor.primeNode('card', 'tablet');
  await editor.select(['card-inner'], 'tablet');
  await page.waitForTimeout(600);

  const inner = await editor.nodeBoxIn('tablet', 'card-inner');
  const frame = await editor.nodeBox('layout-frame');
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const to = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const mid = { x: from.x, y: frame.y - 40 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (const [a, b] of [[from, mid], [mid, to]] as const) {
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  }
  await editor.pumpDrag(to, 8);

  // Travel a real distance INSIDE the frame after entry, then the outline's
  // top-left must still be near the cursor (grab offset ≈50px + snap slack).
  // A frozen ghost sits a full travel-length behind.
  const to2 = { x: to.x + 80, y: to.y + 60 };
  for (let i = 1; i <= 8; i++) {
    await mouse.move(to.x + ((to2.x - to.x) * i) / 8, to.y + ((to2.y - to.y) * i) / 8, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  const line = page.locator('[data-interaction-outline] line').first();
  await expect(line).toBeAttached();
  const x1 = Number(await line.getAttribute('x1'));
  const y1 = Number(await line.getAttribute('y1'));
  const dist = Math.hypot(to2.x - x1, to2.y - y1);
  expect(dist, `outline TL (${x1},${y1}) vs cursor (${to2.x},${to2.y}) — frozen ghost`)
    .toBeLessThan(70);

  await mouse.up();
  await page.waitForTimeout(300);
});

test('snap guides hug the node after a layout-frame round trip', async ({ page }) => {
  // Replica → canvas → INTO the layout frame → back OUT to canvas, one
  // gesture (eighth report, 2026-08-26): the pink guides then painted far
  // off the node's edges. `liftCorners` captured at the canvas handoff came
  // from the cornersCache — the hidden origin copy's PRE-DRAG quad — so the
  // snap engine aligned a phantom rect a constant offset from the visible
  // element. Sweep the cursor across a known alignment line after the round
  // trip and assert every horizontal guide sits on one of the node's edges.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await editor.fitCamera();

  await editor.primeNode('card', 'tablet');
  await editor.select(['solo-chip'], 'tablet');
  await page.waitForTimeout(600);

  const chip = await editor.nodeBoxIn('tablet', 'solo-chip');
  const layoutF = await editor.nodeBox('layout-frame');
  const dropF = await editor.nodeBox('drop-frame');
  const from = { x: chip.x + chip.width / 2 + 6, y: chip.y + chip.height / 2 + 4 };
  const intoLayout = { x: layoutF.x + layoutF.width / 2, y: layoutF.y + layoutF.height / 2 };
  // Back out: between the two frames, above drop-frame's top edge.
  const backOut = { x: (layoutF.x + layoutF.width + dropF.x) / 2, y: dropF.y - 60 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (const [a, b] of [
    [from, { x: from.x, y: layoutF.y - 40 }],
    [{ x: from.x, y: layoutF.y - 40 }, intoLayout],
    [intoLayout, backOut],
  ] as const) {
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  }

  // Sweep DOWN across drop-frame's top-edge alignment so a horizontal guide
  // fires; sample every guide the sweep produces alongside the node's box.
  const samples: Array<{ guideY: number; top: number; bottom: number; cy: number }> = [];
  for (let i = 0; i <= 24; i++) {
    await mouse.move(backOut.x, backOut.y + i * 5, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    const box = await editor.sandbox().locator('[data-id="solo-chip"]:visible').first()
      .boundingBox().catch(() => null);
    if (!box) continue;
    const lines = page.locator('svg line[stroke="#f472b6"]');
    const n = await lines.count();
    for (let li = 0; li < n; li++) {
      const l = lines.nth(li);
      const [y1, y2] = [Number(await l.getAttribute('y1')), Number(await l.getAttribute('y2'))];
      if (y1 !== y2) continue; // vertical guide — this sweep asserts horizontals
      samples.push({ guideY: y1, top: box.y, bottom: box.y + box.height, cy: box.y + box.height / 2 });
    }
  }
  expect(samples.length, 'the sweep crossed an alignment — at least one guide sampled')
    .toBeGreaterThan(0);
  for (const s of samples) {
    const d = Math.min(Math.abs(s.guideY - s.top), Math.abs(s.guideY - s.bottom), Math.abs(s.guideY - s.cy));
    expect(d, `guide y=${s.guideY.toFixed(1)} vs node edges [${s.top.toFixed(1)}, ${s.cy.toFixed(1)}, ${s.bottom.toFixed(1)}]`)
      .toBeLessThan(8);
  }

  await mouse.up();
  await page.waitForTimeout(300);
});

test('canvas node → REPLICA layout frame: outline and element keep tracking', async ({ page }) => {
  // The MIRROR of the layout-entry freeze (tenth report, 2026-08-26): after
  // routing was flipped to the ENTERED viewport at entry confirmation, a
  // canvas node dragged into a REPLICA's layout frame had its writes routed
  // to `tablet-<id>` — an element that doesn't exist (layout entries never
  // live-reparent; the canvas node keeps painting under ''). Element, corner
  // emits, and the interaction outline froze at the entry spot. Layout
  // entries now keep routing on the element's OWN prefix.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await editor.fitCamera();

  await editor.primeNode('card', 'tablet'); // start the tablet tile's rect stream
  await editor.select(['canvas-chip']);
  await page.waitForTimeout(600);

  const chip = await editor.nodeBox('canvas-chip');
  const card = await editor.nodeBoxIn('tablet', 'card');
  const from = { x: chip.x + chip.width / 2 + 5, y: chip.y + chip.height / 2 + 4 };
  const to = { x: card.x + card.width / 2, y: card.y + card.height / 2 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await editor.pumpDrag(to, 8);

  // Travel INSIDE the frame after entry, then both the element and the
  // outline must still be at the cursor — a freeze leaves them at the
  // entry spot, a travel-length behind.
  const to2 = { x: to.x + 40, y: to.y + 45 };
  for (let i = 1; i <= 8; i++) {
    await mouse.move(to.x + ((to2.x - to.x) * i) / 8, to.y + ((to2.y - to.y) * i) / 8, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  const box = await editor.sandbox().locator('[data-id="canvas-chip"]:visible').first().boundingBox();
  expect(box, 'dragged element visible').not.toBeNull();
  const pad = 2;
  expect(
    to2.x >= box!.x - pad && to2.x <= box!.x + box!.width + pad
    && to2.y >= box!.y - pad && to2.y <= box!.y + box!.height + pad,
    `cursor (${to2.x},${to2.y}) escaped the element box `
    + `[${Math.round(box!.x)},${Math.round(box!.y)} ${Math.round(box!.width)}x${Math.round(box!.height)}] — frozen element`,
  ).toBe(true);
  const line = page.locator('[data-interaction-outline] line').first();
  await expect(line).toBeAttached();
  const x1 = Number(await line.getAttribute('x1'));
  const y1 = Number(await line.getAttribute('y1'));
  expect(Math.hypot(to2.x - x1, to2.y - y1),
    `outline TL (${x1},${y1}) vs cursor (${to2.x},${to2.y}) — frozen outline`).toBeLessThan(70);

  await mouse.up();
  await page.waitForTimeout(400);
});

test('back-to-parent placeholder survives brushing another frame mid-drag', async ({ page }) => {
  // Ninth report, 2026-08-26: drag a layout child out to canvas and STRAIGHT
  // back → LayoutLifted shows its reorder placeholder. But brush any other
  // frame on the way (the mid-drag exit commits + hands off to
  // CanvasDragStrategy) and the return showed only a thin outline — the
  // original parent is EMPTY now, and the empty-layout affordance had no
  // spacer. The canvas strategy's empty-layout entry now creates the same
  // placeholder, so "back to parent" reads identically all gesture long.
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await editor.fitCamera();

  await editor.primeNode('card');
  await editor.select(['card-inner']);
  await page.waitForTimeout(600);

  const inner = await editor.nodeBox('card-inner');
  const card = await editor.nodeBox('card');
  const dropF = await editor.nodeBox('drop-frame');
  const layoutF = await editor.nodeBox('layout-frame');
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const overFrame = { x: dropF.x + dropF.width / 2, y: dropF.y + dropF.height / 2 };
  const overForeignLayout = { x: layoutF.x + layoutF.width / 2, y: layoutF.y + layoutF.height / 2 };
  const backToCard = { x: card.x + card.width / 2, y: card.y + card.height / 2 };

  const drive = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
    }
  };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  await drive(from, { x: from.x, y: dropF.y - 40 }); // out of the tile, off-parent
  await drive({ x: from.x, y: dropF.y - 40 }, overFrame); // brush a frame → exit + handoff
  await drive(overFrame, overForeignLayout); // hover a FOREIGN empty layout frame

  // Provenance gate (follow-up report): a foreign empty layout frame gets the
  // plain inside-affordance, NEVER the back-to-parent placeholder.
  await editor.pumpDrag(overForeignLayout, 8);
  expect(
    await editor.sandbox().locator('[data-placeholder-id="canvas-entry-ph"]').count(),
    'no placeholder on a frame the gesture did not start from',
  ).toBe(0);

  await drive(overForeignLayout, backToCard); // return to the original parent
  await editor.pumpDrag(backToCard, 8);

  // The back-to-parent affordance: a real placeholder INSIDE card.
  const ph = await editor.sandbox()
    .locator('[data-placeholder-id="canvas-entry-ph"]').first().boundingBox();
  expect(ph, 'entry placeholder present in the original parent').not.toBeNull();
  expect(
    ph!.x >= card.x - 2 && ph!.x + ph!.width <= card.x + card.width + 2
    && ph!.y >= card.y - 2 && ph!.y + ph!.height <= card.y + card.height + 2,
    `placeholder [${Math.round(ph!.x)},${Math.round(ph!.y)} ${Math.round(ph!.width)}x${Math.round(ph!.height)}] inside card [${Math.round(card.x)},${Math.round(card.y)} ${Math.round(card.width)}x${Math.round(card.height)}]`,
  ).toBe(true);

  await mouse.up();
  await page.waitForTimeout(400);

  // Mouseup re-inserts into the original parent, and the placeholder is gone.
  const code = await editor.getPageCode();
  expect(childIdsOf(code, 'card')).toContain('card-inner');
  expect(await editor.sandbox().locator('[data-placeholder-id="canvas-entry-ph"]').count()).toBe(0);
});

test('control: the same gesture from the primary keeps working', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('REPLICA_EXIT_TO_FRAME');
  await runGesture(editor, 'desktop');

  const code = await editor.getPageCode();
  expect(childIdsOf(code, 'drop-frame').filter((id) => id !== 'dead-child').length).toBe(1);
});

/** The full opening tag of the element carrying `data-id` in a code slice. */
function tagOf(code: string, dataId: string): string {
  const idx = code.indexOf(`data-id="${dataId}"`);
  if (idx === -1) return '';
  const start = code.lastIndexOf('<', idx);
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

/** Direct-child data-ids of an element — local copy of the helper's parser
 *  (it is module-private there and scoped to root). */
function childIdsOf(code: string, parentDataId: string): string[] {
  const ids: string[] = [];
  const open = new RegExp(`<\\w+[^>]*data-id="${parentDataId}"[^>]*>`).exec(code);
  if (!open || open[0].endsWith('/>')) return ids;
  let depth = 1;
  let i = open.index + open[0].length;
  while (i < code.length && depth > 0) {
    if (code[i] !== '<') { i++; continue; }
    const close = code.indexOf('>', i);
    if (close === -1) break;
    const tag = code.slice(i, close + 1);
    if (tag.startsWith('</')) depth--;
    else {
      if (depth === 1) {
        const m = /data-id="([^"]+)"/.exec(tag);
        if (m) ids.push(m[1]);
      }
      if (!tag.endsWith('/>')) depth++;
    }
    i = close + 1;
  }
  return ids;
}
