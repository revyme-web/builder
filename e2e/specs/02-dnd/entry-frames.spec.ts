// DND · Entry into frames, layouts and viewport roots (E2E_TEST_PLAN.md §2, batch D3).

import { test, expect } from '../../fixtures/test';
import { DragSession, dropLine, parentOutline, overlayFrame, type OverlayFrame } from '../../helpers/d1';
import {
  GAP, ENTRY, EMPTY_FLEX, INSTANCE_ROW, INSTANCE_OVERLAY, NESTED_FRAMES, TRANSLATED_IMAGE, TRANSFORMED_TARGETS,
  CARD_IN_SLOT, TWO_CARDS, ROOTS, BACKDROP,
  setZoom, moveMutations, centerOn, domParent, paintedCount, startSampler, stopSampler, maxJump, isCanvasNode, stableCode,
  traceMark, tracesSince, center, inside, contains,
} from '../../helpers/d3';
import { openMaster } from '../../helpers/d6';

// Gesture-heavy tests on a loaded machine.
test.describe.configure({ timeout: 150_000 });

const gapPoint = async (editor: { nodeBox(id: string): Promise<{ x: number; y: number; width: number; height: number }> }, a: string, b: string, fx = 0.5) => {
  const A = await editor.nodeBox(a);
  const B = await editor.nodeBox(b);
  return { x: A.x + A.width * fx, y: (A.y + A.height + B.y) / 2 };
};

test('DND-063 canvas floater dropped in the gap between two sections joins root as a flow child', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(GAP);
  const page = editor.page();
  const before = await editor.code();
  const to = await gapPoint(editor, 'hero', 'features');

  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    await s.moveTo(to, 20);
    await s.pump(8);
    // The drop line sits in the gap, between hero and features (index 1 of root).
    const line = await dropLine(page);
    expect(line).toMatchObject({ parentId: 'root', insertIndex: 1, orientation: 'horizontal' });
    const hero = await editor.nodeBox('hero');
    const features = await editor.nodeBox('features');
    const lineY = line!.rect.y + line!.rect.height / 2;
    expect(lineY).toBeGreaterThan(hero.y + hero.height - 2);
    expect(lineY).toBeLessThan(features.y + 2);
  } finally {
    await s.release();
    await editor.settled();
  }

  // Source: a flow child of root at index 1, no canvas-node marker, no insets.
  await expect(editor).toHaveJsxOrder('root', ['hero', 'floater', 'features', 'how']);
  const src = await editor.source();
  const f = src.byId.get('floater')!;
  expect(f.attrs['data-canvas-node']).toBeUndefined();
  expect(f.style.position).toBe('relative');
  expect(f.style.flex).toBe('0 0 auto');
  for (const inset of ['left', 'top', 'right', 'bottom']) expect(f.style[inset], `inset ${inset} cleared`).toBeUndefined();
  await expect(editor).toHaveNoDuplicateIds();
  // Canvas: painted between hero and features, inside the viewport root.
  const fb = await editor.nodeBox('floater');
  expect(fb.y).toBeGreaterThan((await editor.nodeBox('hero')).y);
  expect(fb.y + fb.height).toBeLessThanOrEqual((await editor.nodeBox('features')).y + 1);
  expect(await domParent(editor, 'floater')).toBe('root');
  await expect(editor).toUndoInOneStep(before);
});

test('DND-064 chip enters the big no-layout canvas frame live, no jump, one element, absolute parent-local position', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ENTRY);
  const page = editor.page();
  const before = await editor.code();
  const chip = await editor.nodeBox('chip');
  const frameBox = await editor.nodeBox('big-frame');
  const from = center(chip);
  // Off every centre/edge line of the frame, so no snap pulls the drop.
  const to = { x: frameBox.x + frameBox.width * 0.37, y: frameBox.y + frameBox.height * 0.43 };
  const since = await traceMark(page);

  await startSampler(editor, 'chip');
  const s = await DragSession.press(page, from);
  try {
    await s.moveTo(to, 24);
    await s.pump(10);
    // Live reparent: the painted chip now sits inside big-frame in the DOM.
    expect(await domParent(editor, 'chip')).toBe('big-frame');
    expect(inside(to, await editor.nodeBox('chip'))).toBe(true);
  } finally {
    await s.release();
    await editor.settled();
  }
  const samples = await stopSampler(editor);
  expect(samples.length).toBeGreaterThan(10);
  // No per-frame jump bigger than a few cursor steps, never two chips painted.
  const step = Math.hypot(to.x - from.x, to.y - from.y) / 24;
  expect(maxJump(samples).d, 'largest per-frame jump').toBeLessThan(Math.max(30, step * 2.5));
  expect(samples.filter(x => x.n > 1).length, 'frames with two chips painted').toBe(0);
  // The entry happened mid-drag (before release), not at mouseup.
  const entry = await tracesSince(page, since, '^canvas-drag:entry-reparent-posted$');
  expect(entry.length).toBeGreaterThan(0);

  // Source: a child of big-frame, absolute, parent-local left/top.
  await expect.poll(() => editor.parentOf('chip')).toBe('big-frame');
  const st = await editor.style('chip');
  expect(st.position).toBe('absolute');
  expect(await isCanvasNode(editor, 'chip')).toBe(false);
  const landed = await editor.nodeBox('chip');
  const fb = await editor.nodeBox('big-frame');
  const scale = fb.width / 320;
  // Parent-local insets (a centre-pinned axis is written as a % of the frame).
  const px = (v: string, base: number) => (v.endsWith('%') ? (parseFloat(v) * base) / 100 : parseFloat(v));
  expect(Math.abs(px(st.left, 320) - (landed.x - fb.x) / scale)).toBeLessThan(2);
  expect(Math.abs(px(st.top, 240) - (landed.y - fb.y) / scale)).toBeLessThan(2);
  // Lands under the cursor (an edge snap may hold it a few px off the exact grab point).
  expect(inside(to, landed, 0)).toBe(true);
  expect(Math.abs(landed.x + landed.width / 2 - to.x)).toBeLessThan(10);
  expect(Math.abs(landed.y + landed.height / 2 - to.y)).toBeLessThan(10);
  await expect(editor).toHaveNoDuplicateIds();
  await expect(editor).toUndoInOneStep(before);
});

test('DND-065 a canvas node only partly over a no-layout frame never enters; fully inside it does', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ENTRY);
  const page = editor.page();
  const frameBox = await editor.nodeBox('big-frame');
  const chip = await editor.nodeBox('chip');
  // Cursor just inside the frame's left edge with a centre grab: half the chip
  // hangs outside (more than any snap can pull back in).
  const partial = { x: frameBox.x + 3, y: frameBox.y + frameBox.height / 2 };

  const frames: OverlayFrame[] = [];
  const s = await DragSession.press(page, center(chip));
  try {
    // Two fast hops (above the snap breakout speed), so no edge snap drags it fully inside.
    await s.moveTo(partial, 2, async () => { frames.push(await overlayFrame(page)); });
    await s.pump(10, { onFrame: async () => { frames.push(await overlayFrame(page)); } });
    expect(inside(partial, await editor.nodeBox('big-frame'))).toBe(true);
    expect(await domParent(editor, 'chip')).not.toBe('big-frame');
  } finally {
    await s.release();
    await editor.settled();
  }
  // No highlight and no line on the frame or anything behind it, ever.
  expect(frames.filter(f => f.outline || f.line), 'frames showing a target').toEqual([]);
  // Still a canvas node, moved where it was released.
  expect(await isCanvasNode(editor, 'chip')).toBe(true);
  expect(await editor.parentOf('chip')).toBeNull();
  const after = await editor.nodeBox('chip');
  expect(Math.abs(after.x + after.width / 2 - partial.x)).toBeLessThan(6);

  // Fully inside: it enters.
  const before2 = await editor.code();
  const fb = await editor.nodeBox('big-frame');
  const s2 = await DragSession.press(page, center(await editor.nodeBox('chip')));
  try {
    await s2.moveTo(center(fb), 16);
    await s2.pump(10);
    expect(await parentOutline(page)).toMatchObject({ parentId: 'big-frame' });
  } finally {
    await s2.release();
    await editor.settled();
  }
  await expect.poll(() => editor.parentOf('chip')).toBe('big-frame');
  await expect(editor).toUndoInOneStep(before2);
});

test('DND-068 off-centre grab into a layout child keeps the original grab offset through the entry', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(GAP);
  const page = editor.page();
  const before = await editor.code();
  const box = await editor.nodeBox('floater');
  const grab = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.2 };
  const offset = { x: grab.x - box.x, y: grab.y - box.y };
  const hero = await editor.nodeBox('hero');
  const to = center(hero);

  let entered = false;
  let maxErr = 0;
  const s = await DragSession.press(page, grab);
  try {
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const at = { x: grab.x + (to.x - grab.x) * t, y: grab.y + (to.y - grab.y) * t };
      await s.moveTo(at, 1);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
      const now = await editor.nodeBox('floater').catch(() => null);
      if (!now) continue;
      if ((await domParent(editor, 'floater')) === 'hero') entered = true;
      const err = Math.max(Math.abs(now.x - (at.x - offset.x)), Math.abs(now.y - (at.y - offset.y)));
      if (i > 3) maxErr = Math.max(maxErr, err);
    }
    await s.pump(6);
  } finally {
    await s.release();
    await editor.settled();
  }
  expect(entered, 'the floater live-entered hero mid-drag').toBe(true);
  // Re-centring would jump by |grab offset − half size| ≈ 21px at this zoom.
  expect(maxErr, 'max distance from pointer − original grab offset').toBeLessThan(8);
  // Lands with the same offset under the pointer, as a child of hero.
  await expect.poll(() => editor.parentOf('floater')).toBe('hero');
  const landed = await editor.nodeBox('floater');
  expect(Math.abs(landed.x - (to.x - offset.x))).toBeLessThan(8);
  expect(Math.abs(landed.y - (to.y - offset.y))).toBeLessThan(8);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-071 layout hover is a cancellable preview: the line goes on leave and a release elsewhere never reparents', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(GAP);
  const page = editor.page();
  const floater = await editor.nodeBox('floater');
  const to = await gapPoint(editor, 'hero', 'features');
  const root = await editor.nodeBox('root');
  const away = { x: root.x - 160, y: floater.y + floater.height + 120 };

  const s = await DragSession.press(page, center(floater));
  try {
    await s.moveTo(to, 20);
    await s.pump(8);
    expect(await dropLine(page)).toMatchObject({ parentId: 'root', insertIndex: 1 });
    await s.moveTo(away, 16);
    await s.pump(6);
    expect(await dropLine(page), 'line gone after leaving the flex frame').toBeNull();
    expect(await parentOutline(page)).toBeNull();
  } finally {
    await s.release();
    await editor.settled();
  }
  // Still a canvas node, at the release point; root's children untouched.
  await expect(editor).toHaveJsxOrder('root', ['hero', 'features', 'how']);
  expect(await isCanvasNode(editor, 'floater')).toBe(true);
  const landed = await editor.nodeBox('floater');
  expect(inside(away, landed)).toBe(true);
  expect(await domParent(editor, 'floater')).not.toBe('root');
});

test('DND-073 a canvas node over an EMPTY flex frame: empty affordance + outline only, then index 0 as a flow child', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(EMPTY_FLEX);
  const page = editor.page();
  const before = await editor.code();
  const empty = await editor.nodeBox('empty');
  const to = { x: empty.x + empty.width * 0.4, y: empty.y + empty.height / 2 };
  const since = await traceMark(page);

  const frames: OverlayFrame[] = [];
  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    await s.moveTo(to, 20);
    await s.pump(10, { onFrame: async () => { frames.push(await overlayFrame(page)); } });
    expect(await dropLine(page)).toBeNull();
    expect(await parentOutline(page)).toMatchObject({ parentId: 'empty', source: 'drag' });
    const marks = await tracesSince(page, since, '^drop-line:empty-layout-drop$');
    expect(marks.at(-1)?.data).toMatchObject({ parentId: 'empty' });
  } finally {
    await s.release();
    await editor.settled();
  }
  // While over the empty frame: no pin lines, no snap guides, no line.
  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f.snapGuides, 'snap guides over an empty layout').toBe(0);
    expect(f.pinMarks, 'pin lines over an empty layout').toBeLessThanOrEqual(0);
    expect(f.line).toBeNull();
  }
  // Source: first (only) child of the empty frame, a flow child.
  await expect(editor).toHaveJsxOrder('empty', ['floater']);
  const st = await editor.style('floater');
  expect(st.position).toBe('relative');
  expect(st.left).toBeUndefined();
  expect(st.top).toBeUndefined();
  expect(await isCanvasNode(editor, 'floater')).toBe(false);
  expect(contains(await editor.nodeBox('empty'), await editor.nodeBox('floater'))).toBe(true);
  await expect(editor).toUndoInOneStep(before);
  void stableCode; void paintedCount;
});

// ─── Instances, zoom, transformed targets ──────────────────────────────

test('DND-066 over a flex row of component instances the line goes BETWEEN instances, never inside one', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(INSTANCE_ROW);
  const page = editor.page();
  const before = await editor.code();
  const master = await editor.code('components/Card.tsx');
  const c1 = await editor.nodeBox('card-1');
  const c3 = await editor.nodeBox('card-3');
  const lines: Array<{ parentId: string | null; insertIndex: number | null }> = [];
  const outlines: Array<string | null> = [];
  const rec = async () => {
    const f = await overlayFrame(page);
    if (f.line) lines.push(f.line);
    if (f.outline) outlines.push(f.outline.parentId);
  };

  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    // Into card-1's inner child (the instance expansion), then sweep across all three.
    await s.moveTo({ x: c1.x + c1.width * 0.5, y: c1.y + c1.height * 0.3 }, 20, rec);
    await s.pump(8, { onFrame: rec });
    expect(await dropLine(page)).toMatchObject({ parentId: 'inst-row' });
    await s.moveTo({ x: c3.x + c3.width * 0.5, y: c3.y + c3.height * 0.7 }, 24, rec);
    await s.pump(8, { onFrame: rec });
    // Settle on card-2's right half: the slot between card-2 and card-3.
    const c2 = await editor.nodeBox('card-2');
    await s.moveTo({ x: c2.x + c2.width * 0.8, y: c2.y + c2.height * 0.5 }, 12, rec);
    await s.pump(8, { onFrame: rec });
    expect(await dropLine(page)).toMatchObject({ parentId: 'inst-row', insertIndex: 2, orientation: 'vertical' });
  } finally {
    await s.release();
    await editor.settled();
  }
  // Every line/outline shown targeted the row, never an instance or its internals.
  expect(lines.length).toBeGreaterThan(0);
  expect([...new Set(lines.map(l => l.parentId))]).toEqual(['inst-row']);
  for (const o of outlines) expect(o, 'outline target').toBe('inst-row');

  // Source: inserted into the row between card-2 and card-3; instances stay childless.
  await expect(editor).toHaveJsxOrder('inst-row', ['card-1', 'card-2', 'floater', 'card-3']);
  const src = await editor.source();
  for (const id of ['card-1', 'card-2', 'card-3']) expect(src.byId.get(id)?.childIds, `${id} children`).toEqual([]);
  expect(await editor.code('components/Card.tsx'), 'the master is untouched').toBe(master);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-067 zoom 0.5 then 2.0: entry into nested frames has no reparent drift and one move per crossing', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED_FRAMES, { fit: true });
  const page = editor.page();
  const before = await editor.code();

  for (const zoom of [0.5, 2.0]) {
    const scale = await setZoom(editor, zoom, { id: 'root', cssWidth: 600 }, ['chip', 'outer']);
    expect(Math.abs(scale - zoom)).toBeLessThan(0.02);
    const chip = await editor.nodeBox('chip');
    const outer = await editor.nodeBox('outer');
    const inner = await editor.nodeBox('inner');
    const grab = { x: chip.x + chip.width * 0.3, y: chip.y + chip.height * 0.6 };
    const off = { x: grab.x - chip.x, y: grab.y - chip.y };
    // Park points: inside outer but clear of inner, then inside inner; off every edge/centre line.
    const inOuter = { x: outer.x + outer.width * 0.83, y: outer.y + outer.height * 0.86 };
    const inInner = { x: inner.x + inner.width * 0.61, y: inner.y + inner.height * 0.37 };
    const since = await traceMark(page);

    // Per-frame (painted − cursor) offsets while parked over each target.
    const drift: Array<{ parent: string | null; ex: number; ey: number }> = [];
    const sample = (at: { x: number; y: number }) => async () => {
      const b = await editor.nodeBox('chip');
      drift.push({ parent: await domParent(editor, 'chip'), ex: b.x - (at.x - off.x), ey: b.y - (at.y - off.y) });
    };
    const s = await DragSession.press(page, grab);
    try {
      await s.moveTo({ x: grab.x + 8, y: grab.y - 8 }, 4);
      await s.moveTo(inOuter, 2);
      await s.pump(10, { axis: 'x', onFrame: sample(inOuter) });
      await s.moveTo(inInner, 2);
      await s.pump(12, { axis: 'x', onFrame: sample(inInner) });
    } finally {
      await s.release();
      await editor.settled();
    }
    // Both reparents happened while parked, and neither moved the chip relative to the cursor.
    const parents = drift.map(d => d.parent);
    expect(parents, `zoom ${zoom}: entered outer then inner`).toContain('outer');
    expect(parents.at(-1)).toBe('inner');
    for (let i = 1; i < drift.length; i++) {
      if (drift[i].parent === drift[i - 1].parent) continue;
      // The pump wiggles ±1px on x, so compare against the wiggle-free y and a 1px x band.
      const dx = Math.abs(drift[i].ex - drift[i - 1].ex);
      const dy = Math.abs(drift[i].ey - drift[i - 1].ey);
      expect(dy, `zoom ${zoom}: y drift entering ${drift[i].parent}`).toBeLessThan(1);
      expect(dx, `zoom ${zoom}: x drift entering ${drift[i].parent}`).toBeLessThan(2);
    }
    // Exactly one move per crossing (canvas → outer, outer → inner): no exit/enter oscillation.
    expect((await moveMutations(page, since, 'chip')).length, `zoom ${zoom}: move mutations`).toBe(2);
    await expect.poll(() => editor.parentOf('chip')).toBe('inner');
    const landed = await editor.nodeBox('chip');
    expect(Math.abs(landed.x - (inInner.x - off.x))).toBeLessThan(2.5);
    expect(Math.abs(landed.y - (inInner.y - off.y))).toBeLessThan(1.5);
    await editor.undo();
    await expect.poll(() => editor.code()).toBe(before);
  }
});

test('DND-069 a canvas node dragged into a translate(-50%,-50%) image child lands at the cursor', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TRANSLATED_IMAGE);
  const page = editor.page();
  const before = await editor.code();
  const start = await editor.nodeBox('cn-pink');
  const img = await editor.nodeBox('img-1');
  const grab = center(start);
  const target = { x: img.x + img.width * 0.37, y: img.y + img.height * 0.41 };
  await startSampler(editor, 'cn-pink');
  const s = await DragSession.press(page, grab);
  try {
    // 36 small steps, like a human drag.
    for (let i = 1; i <= 36; i++) {
      await s.moveTo({ x: grab.x + ((target.x - grab.x) * i) / 36, y: grab.y + ((target.y - grab.y) * i) / 36 }, 1);
      await page.waitForTimeout(30);
    }
    await s.pump(6, { axis: 'x' });
  } finally {
    await s.release();
    await editor.settled();
  }
  const samples = await stopSampler(editor);
  // No (W/2, H/2) jump on entry: the largest per-frame move stays near one cursor step.
  const step = Math.hypot(target.x - grab.x, target.y - grab.y) / 36;
  expect(maxJump(samples).d).toBeLessThan(step * 2.5 + 4);
  // Source: a child of the image frame, not a canvas node.
  await expect.poll(() => editor.parentOf('cn-pink')).toBe('img-1');
  expect(await isCanvasNode(editor, 'cn-pink')).toBe(false);
  const after = await editor.nodeBox('cn-pink');
  expect(Math.abs(after.x + after.width / 2 - target.x)).toBeLessThan(6);
  expect(Math.abs(after.y + after.height / 2 - target.y)).toBeLessThan(6);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-070 entry into a 25°-rotated frame lands at the cursor; a 2×-scaled node keeps its visible size', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  test.fail(true, 'BUG: a transform: scale(2) canvas node entering a no-layout frame jumps left by (AABB − box)/2 = 25 CSS px at the entry (cssLeft from computeEntryParentLocalPosition); y is right');
  await editor.load(TRANSFORMED_TARGETS, { fit: true });
  const page = editor.page();
  const before = await editor.code();

  // (a) chip → rotated frame.
  await centerOn(editor, ['chip', 'tilted']);
  const tilted = await editor.nodeBox('tilted');
  const to = center(tilted);
  const s = await DragSession.press(page, center(await editor.nodeBox('chip')));
  try {
    await s.moveTo(to, 24);
    await s.pump(10, { axis: 'x' });
    expect(await domParent(editor, 'chip')).toBe('tilted');
  } finally {
    await s.release();
    await editor.settled();
  }
  await expect.poll(() => editor.parentOf('chip')).toBe('tilted');
  const landed = await editor.nodeBox('chip');
  expect(Math.abs(landed.x + landed.width / 2 - to.x), 'x at cursor').toBeLessThan(6);
  expect(Math.abs(landed.y + landed.height / 2 - to.y), 'y at cursor').toBeLessThan(6);
  await expect(editor).toUndoInOneStep(before);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // (b) 2×-scaled node → plain frame: same painted size after entry.
  await centerOn(editor, ['scaled', 'plain']);
  const sizeBefore = await editor.nodeBox('scaled');
  const plain = await editor.nodeBox('plain');
  const to2 = { x: plain.x + plain.width * 0.41, y: plain.y + plain.height * 0.37 };
  const s2 = await DragSession.press(page, center(sizeBefore));
  try {
    await s2.moveTo(to2, 24);
    await s2.pump(10, { axis: 'x' });
  } finally {
    await s2.release();
    await editor.settled();
  }
  await expect.poll(() => editor.parentOf('scaled')).toBe('plain');
  const st = await editor.style('scaled');
  expect(st.width, 'CSS width unchanged (not the doubled AABB)').toBe('50px');
  expect(st.height).toBe('50px');
  expect(st.transform ?? '').toContain('scale(2)');
  const sizeAfter = await editor.nodeBox('scaled');
  expect(Math.abs(sizeAfter.width - sizeBefore.width)).toBeLessThan(2);
  expect(Math.abs(sizeAfter.height - sizeBefore.height)).toBeLessThan(2);
  // …and it lands at the cursor too (grabbed at its centre).
  expect(Math.abs(sizeAfter.y + sizeAfter.height / 2 - to2.y), 'scaled node y at cursor').toBeLessThan(6);
  expect(Math.abs(sizeAfter.x + sizeAfter.width / 2 - to2.x), 'scaled node x at cursor').toBeLessThan(6);
});

test('DND-072 a small chip enters a static no-layout card in a flex slot; an oversized one falls through to the flex line', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CARD_IN_SLOT);
  const page = editor.page();
  const before = await editor.code();
  const card = await editor.nodeBox('card');
  const over = { x: card.x + card.width * 0.6, y: card.y + card.height * 0.5 };

  // Oversized: the card can't hold it → the outer flex row's line.
  const sh = await DragSession.press(page, center(await editor.nodeBox('huge')));
  try {
    await sh.moveTo(over, 24);
    await sh.pump(10, { axis: 'x' });
    expect(await dropLine(page)).toMatchObject({ parentId: 'slots' });
    expect((await parentOutline(page))?.parentId ?? null).not.toBe('card');
    expect(await domParent(editor, 'huge')).not.toBe('card');
  } finally {
    await sh.release();
    await editor.settled();
  }
  await expect.poll(() => editor.parentOf('huge')).toBe('slots');
  expect(await editor.parentOf('huge')).not.toBe('card');
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // Small: enters the card, cursor-anchored; the static card is promoted to relative.
  const small = await editor.nodeBox('small');
  const grab = center(small);
  const s = await DragSession.press(page, grab);
  try {
    await s.moveTo(over, 24);
    await s.pump(10, { axis: 'x' });
    expect(await domParent(editor, 'small')).toBe('card');
  } finally {
    await s.release();
    await editor.settled();
  }
  await expect.poll(() => editor.parentOf('small')).toBe('card');
  await expect(editor).toHaveStyle('card', 'position', 'relative');
  expect((await editor.style('small')).position).toBe('absolute');
  const landed = await editor.nodeBox('small');
  expect(Math.abs(landed.x + landed.width / 2 - over.x)).toBeLessThan(6);
  expect(Math.abs(landed.y + landed.height / 2 - over.y)).toBeLessThan(6);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-074 moving from card A into card B resets the grace at once: no stale line on A, commits into B', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TWO_CARDS);
  const page = editor.page();
  const before = await editor.code();
  const intoA = await gapPoint(editor, 'a1', 'a2');
  const intoB = await gapPoint(editor, 'b1', 'b2');

  const seen: Array<{ parentId: string | null } | null> = [];
  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    await s.moveTo(intoA, 20);
    await s.pump(8, { axis: 'x' });
    expect(await dropLine(page)).toMatchObject({ parentId: 'card-a', insertIndex: 1 });
    // One hop straight into B: from the very first frame there, A's line is gone.
    await s.moveTo(intoB, 1);
    seen.push((await overlayFrame(page)).line);
    await s.pump(8, { axis: 'x', onFrame: async () => { seen.push((await overlayFrame(page)).line); } });
    expect(await dropLine(page)).toMatchObject({ parentId: 'card-b', insertIndex: 1 });
  } finally {
    await s.release();
    await editor.settled();
  }
  for (const l of seen) expect(l?.parentId ?? null, 'a line on card A after leaving it').not.toBe('card-a');
  expect(seen[0]?.parentId ?? null, 'B confirmed only after its own grace').toBeNull();
  await expect(editor).toHaveJsxOrder('card-b', ['b1', 'floater', 'b2']);
  await expect(editor).toHaveJsxOrder('card-a', ['a1', 'a2']);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-075 viewport roots: flex by cursor-over with a line, no-layout starter only fully inside, no-layout master likewise', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // ROW-ADJUSTED (master part): the row says "a master root always" accepts. A
  // master's root is the variant tile itself (data-viewport on the master's own
  // root, no `root` node), so a NO-layout master root uses the no-layout rule:
  // half outside never enters, fully inside does.
  await editor.load(ROOTS);
  const page = editor.page();

  // (a) flex page root: the cursor in root's empty area below its last child.
  const before = await editor.code();
  const root = await editor.nodeBox('root');
  const feat = await editor.nodeBox('features');
  const below = { x: root.x + root.width * 0.3, y: (feat.y + feat.height + root.y + root.height) / 2 };
  const s = await DragSession.press(page, center(await editor.nodeBox('chip')));
  try {
    await s.moveTo(below, 20);
    await s.pump(8, { axis: 'x' });
    expect(await dropLine(page)).toMatchObject({ parentId: 'root', insertIndex: 2 });
  } finally {
    await s.release();
    await editor.settled();
  }
  await expect(editor).toHaveJsxOrder('root', ['hero', 'features', 'chip']);
  expect(await isCanvasNode(editor, 'chip')).toBe(false);
  await expect(editor).toUndoInOneStep(before);

  // (b)/(c) no-layout roots: half outside → nothing; fully inside → absolute child.
  const noLayout = async (path: string, rootId: string, chipId: string) => {
    const r = await editor.nodeBox(rootId);
    const edge = { x: r.x + 3, y: r.y + Math.min(r.height * 0.4, 200) };
    const frames: OverlayFrame[] = [];
    const s1 = await DragSession.press(page, center(await editor.nodeBox(chipId)));
    try {
      await s1.moveTo(edge, 2);
      await s1.pump(10, { axis: 'y', onFrame: async () => { frames.push(await overlayFrame(page)); } });
      expect(await domParent(editor, chipId), `${rootId}: half outside never enters`).not.toBe(rootId);
    } finally {
      await s1.release();
      await editor.settled();
    }
    expect(frames.filter(f => f.outline || f.line), `${rootId}: no target shown`).toEqual([]);
    expect(await isCanvasNode(editor, chipId, path)).toBe(true);
    const before2 = await editor.code(path);
    const in2 = { x: r.x + r.width * 0.55, y: r.y + Math.min(r.height * 0.45, 260) };
    const s2 = await DragSession.press(page, center(await editor.nodeBox(chipId)));
    try {
      await s2.moveTo(in2, 20);
      await s2.pump(10, { axis: 'x' });
      expect(await parentOutline(page)).toMatchObject({ parentId: rootId });
    } finally {
      await s2.release();
      await editor.settled();
    }
    await expect.poll(() => editor.parentOf(chipId, path)).toBe(rootId);
    expect((await editor.style(chipId, path)).position).toBe('absolute');
    await expect(editor).toUndoInOneStep(before2, { path });
  };
  await editor.openFile('app/starter/page.client.tsx');
  await page.waitForFunction(() => (window as any).__e2e.activeFile() === 'app/starter/page.client.tsx');
  await editor.sandbox().locator('[data-id="s-chip"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  await editor.settled();
  await editor.fitCamera();
  await noLayout('app/starter/page.client.tsx', 'root', 's-chip');

  await openMaster(editor, 'components/Tile.tsx');
  await noLayout('components/Tile.tsx', 'tile-root', 'm-chip');
});

test('DND-076 an absolute overlay instance is see-through: the section behind takes the drop, never its internals', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  test.fail(true, "BUG: over an absolute overlay instance the drop goes to the INSTANCE's layout parent (root, line at index 0), not the section behind — hitIsOverComponentInstance reads the expansion root's own position (unset) and blocks");
  await editor.load(INSTANCE_OVERLAY);
  const page = editor.page();
  const before = await editor.code();
  const master = await editor.code('components/Card.tsx');
  const aura = await editor.nodeBox('aura');
  const s1 = await editor.nodeBox('s1');
  // Over the instance's inner children AND the gap between s1 and s2 behind it.
  const s2 = await editor.nodeBox('s2');
  const over = { x: (s1.x + s1.width + s2.x) / 2, y: Math.max(aura.y + aura.height * 0.3, s1.y + 10) };
  expect(inside(over, aura), 'cursor is over the overlay instance').toBe(true);
  const targets = new Set<string | null>();
  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    await s.moveTo(over, 24, async () => {
      const f = await overlayFrame(page);
      if (f.line) targets.add(f.line.parentId);
      if (f.outline) targets.add(f.outline.parentId);
    });
    await s.pump(8, { axis: 'x', onFrame: async () => {
      const f = await overlayFrame(page);
      if (f.line) targets.add(f.line.parentId);
      if (f.outline) targets.add(f.outline.parentId);
    } });
    expect(await dropLine(page)).toMatchObject({ parentId: 'sec', insertIndex: 1 });
  } finally {
    await s.release();
    await editor.settled();
  }
  for (const t of targets) expect(['sec', 'root'], `target ${t}`).toContain(t);
  await expect(editor).toHaveJsxOrder('sec', ['s1', 'floater', 's2', 's3']);
  expect((await editor.source()).byId.get('aura')?.childIds).toEqual([]);
  expect(await editor.code('components/Card.tsx')).toBe(master);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-077 over a full-bleed backdrop, the higher-z section on top takes the drop (paint order)', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(BACKDROP);
  const page = editor.page();
  const before = await editor.code();
  const l1 = await editor.nodeBox('logo-1');
  const l2 = await editor.nodeBox('logo-2');
  const over = { x: (l1.x + l1.width + l2.x) / 2, y: l1.y + l1.height * 0.5 };
  const targets = new Set<string | null>();
  const rec = async () => {
    const f = await overlayFrame(page);
    if (f.line) targets.add(f.line.parentId);
    if (f.outline) targets.add(f.outline.parentId);
  };
  const s = await DragSession.press(page, center(await editor.nodeBox('floater')));
  try {
    await s.moveTo(over, 24);
    await s.pump(8, { axis: 'x', onFrame: rec });
    expect(await dropLine(page)).toMatchObject({ parentId: 'logos', insertIndex: 1 });
    expect(await domParent(editor, 'floater')).not.toBe('noise');
  } finally {
    await s.release();
    await editor.settled();
  }
  expect(targets.has('noise'), 'the backdrop never became the target').toBe(false);
  expect(targets.has('backdrop')).toBe(false);
  await expect(editor).toHaveJsxOrder('logos', ['logo-1', 'floater', 'logo-2']);
  expect(await editor.childIds('noise')).toEqual([]);
  await expect(editor).toUndoInOneStep(before);
});
