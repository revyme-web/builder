// DND · Exit, reparent and mid-drag handoff (E2E_TEST_PLAN.md §2, batch D3).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { DragSession, dropLine, parentOutline, overlayFrame, placeholders } from '../../helpers/d1';
import {
  FLEX_COLUMN, ABSOLUTE_IN_FRAME, SIBLING_FRAMES, TWO_SECTIONS, HANDOFF_TWO_VP, HANDOFF_NO_LAYOUT, FLOW_AND_CANVAS_FRAME,
  TEXT_IN_CENTERED_COLUMN, SIZES, ROTATED_CHILD, DOUBLE_ROTATE, INSET_CHILDREN, NESTED_3, FRAME_IN_FLEX, CLIPPED,
  CONTAINER_CHILD, ENTRY,
  domParent, paintedCount, isCanvasNode, stableCode, emptyCanvasPoint, paintedAngle, handleCounts, centerOn, panBy,
  startSampler, stopSampler, maxJump, traceMark, tracesSince, moveMutations, sandboxFrame, center, inside, contains,
  type Pt,
} from '../../helpers/d3';

// Gesture-heavy tests on a loaded machine.
test.describe.configure({ timeout: 150_000 });

const px = (v: string | undefined) => parseFloat(v ?? 'NaN');

/** Press on `id` (at fractions of its box), glide through `points`, pumping at each. */
async function dragThrough(
  editor: import('../../helpers/editor').Editor, id: string, points: Pt[],
  opts: { fx?: number; fy?: number; stepPx?: number; pump?: number; at?: (i: number, p: Pt) => Promise<void>; vpId?: string } = {},
): Promise<{ grab: Pt; start: { x: number; y: number; width: number; height: number } }> {
  const page = editor.page();
  // Two presses within 400ms read as a double-click (drill-in): space drags out.
  await page.waitForTimeout(450);
  const start = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  const grab = { x: start.x + start.width * (opts.fx ?? 0.5), y: start.y + start.height * (opts.fy ?? 0.5) };
  const s = await DragSession.press(page, grab);
  try {
    for (let i = 0; i < points.length; i++) {
      // Human-speed steps (a few px per frame): reparents read the element's
      // rect one frame late, so big synthetic hops would add a step of lag.
      const dist = Math.hypot(points[i].x - s.cur.x, points[i].y - s.cur.y);
      await s.moveTo(points[i], Math.max(6, Math.ceil(dist / (opts.stepPx ?? 6))));
      await s.pump(opts.pump ?? 8, { axis: 'x' });
      if (opts.at) await opts.at(i, points[i]);
    }
  } finally {
    await s.release();
    await editor.settled();
  }
  return { grab, start };
}

// ─── Exit to canvas ─────────────────────────────────────────────────────

test('DND-078 a flex-column section dragged onto empty canvas becomes a canvas node with flow props stripped', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX_COLUMN);
  const page = editor.page();
  const root = await editor.nodeBox('root');
  // Make room left of the viewport, then find empty canvas there.
  await panBy(editor, { x: root.x, y: root.y }, { x: 760, y: root.y });
  const before = await editor.code();
  const f0 = await editor.nodeBox('features');
  const drop = await emptyCanvasPoint(editor, { x: 520, y: f0.y + f0.height / 2 }, 50);
  const { grab, start } = await dragThrough(editor, 'features', [drop]);

  // Source: a top-level canvas node, absolute px at the drop point.
  await expect.poll(() => isCanvasNode(editor, 'features')).toBe(true);
  const st = await editor.style('features');
  expect(st.position).toBe('absolute');
  // ROW-ADJUSTED: `flex` is NORMALISED to '0 0 auto' (what a canvas root needs,
  // and what it needs again when dragged back into a flex parent), not removed.
  expect(st.flex, 'flex normalised from 1 0 0px').toBe('0 0 auto');
  for (const p of ['order', 'alignSelf', 'gridColumn', 'gridRow']) expect(st[p], `${p} removed`).toBeUndefined();
  expect(st.left).toMatch(/^-?\d+(\.\d+)?px$/);
  expect(st.top).toMatch(/^-?\d+(\.\d+)?px$/);
  // Remaining sections renumbered 0, 1.
  await expect(editor).toHaveJsxOrder('root', ['hero', 'how']);
  await expect(editor).toHaveStyle('hero', 'order', '0');
  await expect(editor).toHaveStyle('how', 'order', '1');
  // Canvas: painted where it was released (grab offset kept), outside the viewport.
  const landed = await editor.nodeBox('features');
  // (an edge snap may hold it a few px off the exact grab point)
  expect(Math.abs(landed.x - (drop.x - (grab.x - start.x)))).toBeLessThan(10);
  expect(Math.abs(landed.y - (drop.y - (grab.y - start.y)))).toBeLessThan(10);
  expect(await domParent(editor, 'features')).toBeNull();
  await expect(editor).toHaveNoDuplicateIds();
  await expect(editor).toUndoInOneStep(before);
});

test('DND-079 the absolute child dragged out of hero onto canvas: canvas root, translate stripped, rotation kept, size locked, data-pinned cleared', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x, y: root.y }, { x: 760, y: root.y });
  const before = await editor.code();
  const a0 = await editor.nodeBox('abs-child');
  const drop = await emptyCanvasPoint(editor, { x: 520, y: a0.y + a0.height / 2 }, 60);
  const angle0 = (await paintedAngle(editor, 'abs-child')).angle;
  await dragThrough(editor, 'abs-child', [drop]);

  await expect.poll(() => isCanvasNode(editor, 'abs-child')).toBe(true);
  const src = (await editor.source()).byId.get('abs-child')!;
  expect(src.attrs['data-pinned'] ?? null, 'data-pinned cleared').toBeNull();
  expect(src.style.transform ?? '').not.toMatch(/translate/);
  expect(src.style.transform ?? '').toMatch(/rotate\(15deg\)/);
  expect(src.style.width).toBe('120px');
  expect(src.style.height).toBe('120px');
  expect(Math.abs((await paintedAngle(editor, 'abs-child')).angle - angle0)).toBeLessThan(0.5);
  expect(await editor.childIds('hero')).toEqual([]);
  // Painted around the drop point.
  expect(inside(drop, await editor.nodeBox('abs-child'))).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-081 a flex child of section A dragged over flex section B of the same viewport stays lifted in A', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  // ROW-ADJUSTED: the row expects a line in B and a move into B. LayoutLifted
  // keeps a flow child lifted in its SOURCE layout while the cursor is anywhere
  // inside the viewport hierarchy ("over an ancestor, over a sibling section,
  // etc." — LayoutLiftedStrategy exit detection uses the top-level viewport
  // rect); only a cursor that leaves the viewport can pick a new parent. So
  // over B: no line in B, the placeholder stays in A, and the drop is a
  // reorder inside A.
  await editor.load(TWO_SECTIONS);
  const page = editor.page();
  const before = await editor.code();
  const b1 = await editor.nodeBox('b1');
  const b2 = await editor.nodeBox('b2');
  const slot = { x: (b1.x + b1.width + b2.x) / 2, y: b1.y + b1.height / 2 };
  await dragThrough(editor, 'a2', [slot], {
    at: async () => {
      const line = await dropLine(page);
      expect(line?.parentId ?? null, 'no line in section B').not.toBe('sec-b');
      expect((await parentOutline(page))?.parentId ?? null).not.toBe('sec-b');
      expect((await placeholders(editor)).length, 'the hole stays in A').toBeGreaterThan(0);
    },
  });
  await expect(editor).toHaveJsxOrder('sec-b', ['b1', 'b2']);
  expect(await editor.parentOf('a2')).toBe('sec-a');
  expect((await editor.style('a2')).position).toBe('relative');
  expect(await isCanvasNode(editor, 'a2')).toBe(false);
  // B's children untouched (no order renumbering there).
  expect((await editor.source()).byId.get('b1')?.style.order).toBe('0');
  expect((await editor.source()).byId.get('b2')?.style.order).toBe('1');
  void before;
});

test('DND-085 a bare auto/auto <p> dragged out below the viewport lands max-content, height auto, on one line', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TEXT_IN_CENTERED_COLUMN);
  const before = await editor.code();
  const label = await editor.nodeBox('label');
  const vp = await editor.nodeBox('root');
  const to = { x: vp.x + Math.min(vp.width * 0.4, 300), y: vp.y + vp.height + 120 };
  await dragThrough(editor, 'label', [to]);
  await expect.poll(() => isCanvasNode(editor, 'label')).toBe(true);
  await expect(editor).toHaveStyle('label', 'width', 'max-content');
  await expect(editor).toHaveStyle('label', 'height', 'auto');
  // Not a measured px width, and not plain auto.
  const after = await editor.nodeBox('label');
  expect(after.y).toBeGreaterThan(vp.y + vp.height);
  expect(after.height, 'painted on one line').toBeLessThan(label.height * 1.5);
  expect(Math.abs(after.width - label.width)).toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-086 drag-out sizes: fixed text keeps px + auto height, 100% and stretch become measured px, Fit keeps its keywords', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(SIZES);
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x, y: root.y }, { x: 1000, y: root.y });
  // The viewport root paints at the tile width (1440).
  const scale = (await editor.nodeBox('root')).width / 1440;
  const before = await editor.code();
  const expectWidth: Record<string, (w: string, measured: number) => void> = {
    // Fixed width stays px.
    't-fixed': (w) => expect(w).toBe('300px'),
    // 100% and stretch become the measured px.
    'f-full': (w, m) => { expect(w).toMatch(/px$/); expect(Math.abs(px(w) - m)).toBeLessThan(2); },
    'f-stretch': (w, m) => { expect(w).toMatch(/px$/); expect(Math.abs(px(w) - m)).toBeLessThan(2); },
    // Fit keywords kept.
    'f-fit': (w) => expect(w).toBe('min-content'),
  };
  for (const id of Object.keys(expectWidth)) {
    const b = await editor.nodeBox(id);
    const measured = b.width / scale;
    // Grab near the left edge so the dropped node extends right of the drop, away from the viewport.
    const drop = await emptyCanvasPoint(editor, { x: 420, y: b.y + b.height / 2 }, 40);
    await dragThrough(editor, id, [drop], { fx: 0.04, fy: 0.5 });
    await expect.poll(() => isCanvasNode(editor, id), `${id} on the canvas`).toBe(true);
    const st = await editor.style(id);
    expectWidth[id](st.width, measured);
    if (id === 't-fixed') expect(st.height ?? 'auto', 'fixed text: auto height, never a measured px').toBe('auto');
    if (id === 'f-fit') expect(st.height).toBe('min-content');
    // Painted at the size it had in the column.
    expect(Math.abs((await editor.nodeBox(id)).width / scale - measured), `${id} painted width`).toBeLessThan(2);
    await expect(editor).toUndoInOneStep(before);
    await editor.undo();
    await expect.poll(() => editor.code()).toBe(before);
  }
});

test('DND-087 a rotate(-15deg) absolute child dragged out of its frame keeps its rotation and centre', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROTATED_CHILD);
  const page = editor.page();
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x, y: root.y }, { x: 800, y: root.y });
  const before = await editor.code();
  const b = await editor.nodeBox('spin-1');
  const drop = await emptyCanvasPoint(editor, { x: 520, y: b.y + b.height / 2 }, 90);
  let midCentre: Pt | null = null;
  await dragThrough(editor, 'spin-1', [drop], {
    stepPx: 3,
    at: async () => { midCentre = center(await editor.nodeBox('spin-1')); },
  });
  await expect.poll(() => isCanvasNode(editor, 'spin-1')).toBe(true);
  expect((await editor.style('spin-1')).transform).toContain('rotate(-15deg)');
  expect(Math.abs((await paintedAngle(editor, 'spin-1')).angle - -15)).toBeLessThan(0.5);
  // Centre-stable: the drop paints where the drag showed it.
  const after = center(await editor.nodeBox('spin-1'));
  expect(Math.abs(after.x - midCentre!.x)).toBeLessThan(3);
  expect(Math.abs(after.y - midCentre!.y)).toBeLessThan(3);
  // …which is under the cursor (grabbed at its centre; two exits, ≤ a step of lag each).
  expect(Math.abs(after.x - drop.x)).toBeLessThan(8);
  expect(Math.abs(after.y - drop.y)).toBeLessThan(8);
  await expect(editor).toUndoInOneStep(before);
  void page;
});

test('DND-088 a node with both a motion rotate and transform: rotate keeps ONE rotation channel when dragged out', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(DOUBLE_ROTATE);
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x, y: root.y }, { x: 860, y: root.y });
  const before = await editor.code();
  const b = await editor.nodeBox('spin');
  const drop = await emptyCanvasPoint(editor, { x: 560, y: b.y + b.height / 2 }, 80);
  await dragThrough(editor, 'spin', [drop]);
  await expect.poll(() => isCanvasNode(editor, 'spin')).toBe(true);
  const st = await editor.style('spin');
  expect(st.rotate, 'the motion rotate channel is dropped').toBeUndefined();
  expect(st.transform).toMatch(/rotate\(-190\.3deg\)/);
  // Painted ONCE: −190.3° ≡ 169.7°, not the doubled −380.6° ≡ −20.6°.
  const a = await paintedAngle(editor, 'spin');
  expect(Math.abs(a.angle - 169.7), `painted angle ${a.angle}`).toBeLessThan(0.5);
  // The column's other children keep their order.
  await expect(editor).toHaveJsxOrder('root', ['first', 'last']);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-089 inset-sized children dragged out get explicit size; a rotated full-inset keeps its CSS size', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(INSET_CHILDREN);
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x + root.width, y: root.y }, { x: 1100, y: root.y + 40 });
  const before = await editor.code();
  // (a) right/bottom-sized child → canvas.
  const i0 = await editor.nodeBox('inset');
  const drop1 = await emptyCanvasPoint(editor, { x: 1150, y: i0.y + i0.height + 150 }, 80);
  await dragThrough(editor, 'inset', [drop1], { fx: 0.3, fy: 0.3 });
  await expect.poll(() => isCanvasNode(editor, 'inset')).toBe(true);
  let st = await editor.style('inset');
  expect(st.width).toBe('360px');
  expect(st.height).toBe('260px');
  expect(st.right).toBeUndefined();
  expect(st.bottom).toBeUndefined();
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // (b) rotated full-inset → canvas: CSS size 300×200, not the √2 AABB.
  const f0 = await editor.nodeBox('full');
  const drop2 = await emptyCanvasPoint(editor, { x: 1150, y: f0.y + f0.height + 200 }, 120);
  await dragThrough(editor, 'full', [drop2]);
  await expect.poll(() => isCanvasNode(editor, 'full')).toBe(true);
  st = await editor.style('full');
  expect(st.width).toBe('300px');
  expect(st.height).toBe('200px');
  expect(st.right).toBeUndefined();
  expect(st.bottom).toBeUndefined();
  expect(st.transform).toContain('rotate(45deg)');
  const f1 = await editor.nodeBox('full');
  expect(Math.abs(f1.width - f0.width), 'painted AABB unchanged').toBeLessThan(3);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-092 the absolute child dropped into a flex row becomes a flow child with flex 0 0 auto; into a grid, no flex', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  const before = await editor.code();
  const a = await editor.nodeBox('card-a');
  const bb = await editor.nodeBox('card-b');
  const slot = { x: (a.x + a.width + bb.x) / 2, y: a.y + a.height / 2 };
  await dragThrough(editor, 'abs-child', [slot], {
    at: async () => { expect(await dropLine(page)).toMatchObject({ parentId: 'features', insertIndex: 1 }); },
  });
  await expect(editor).toHaveJsxOrder('features', ['card-a', 'abs-child', 'card-b']);
  let st = await editor.style('abs-child');
  expect(st.position).toBe('relative');
  for (const p of ['left', 'top', 'right', 'bottom']) expect(st[p], `${p} removed`).toBeUndefined();
  expect(st.flex).toBe('0 0 auto');
  await expect(editor).toUndoInOneStep(before);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // Grid target: flow child, no flex.
  const g1 = await editor.nodeBox('g1');
  const g2 = await editor.nodeBox('g2');
  const gslot = { x: (g1.x + g1.width + g2.x) / 2, y: g1.y + g1.height / 2 };
  await dragThrough(editor, 'abs-child', [gslot]);
  await expect.poll(() => editor.parentOf('abs-child')).toBe('gridsec');
  st = await editor.style('abs-child');
  expect(st.position).toBe('relative');
  expect(st.flex, 'no flex on a grid child').toBeUndefined();
  for (const p of ['left', 'top']) expect(st[p]).toBeUndefined();
  await expect(editor).toUndoInOneStep(before);
});

// ─── Reparent between frames ────────────────────────────────────────────

test('DND-080 an absolute child enters sibling frame B live; near B\'s edge only the cursor leaving B exits', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(SIBLING_FRAMES);
  const page = editor.page();
  const before = await editor.code();
  const fb = await editor.nodeBox('frame-b');
  const inB = { x: fb.x + fb.width * 0.57, y: fb.y + fb.height * 0.46 };
  // Cursor just inside B's left edge: the chip hangs half outside B.
  const nearEdge = { x: fb.x + 6, y: fb.y + fb.height * 0.46 };
  const parents: Array<string | null> = [];
  const { grab, start } = await dragThrough(editor, 'chip', [inB, nearEdge], {
    stepPx: 3,
    at: async (i) => {
      parents.push(await domParent(editor, 'chip'));
      if (i === 1) {
        // Wiggle at the edge: still in B, never bounced back into A.
        const s = new DragSession(page, nearEdge);
        for (let k = 0; k < 6; k++) {
          await s.moveTo({ x: nearEdge.x + (k % 2 ? 3 : -2), y: nearEdge.y + (k % 3) }, 1);
          parents.push(await domParent(editor, 'chip'));
        }
        await s.moveTo(nearEdge, 1);
      }
    },
  });
  expect(parents[0], 'live reparent into B while fully inside').toBe('frame-b');
  expect(parents.filter(p => p !== 'frame-b'), 'left B while the cursor was still inside it').toEqual([]);
  await expect.poll(() => editor.parentOf('chip')).toBe('frame-b');
  expect(await editor.childIds('frame-a')).toEqual([]);
  // Lands at the cursor with the original grab offset (no drag-delta offset).
  const landed = await editor.nodeBox('chip');
  // (Tolerance: snapping plus ≤ one slow step of reparent lag per hop — DND-093 pins the lag.)
  expect(Math.abs(landed.x - (nearEdge.x - (grab.x - start.x)))).toBeLessThan(10);
  expect(Math.abs(landed.y - (nearEdge.y - (grab.y - start.y)))).toBeLessThan(10);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-090 an absolute child three no-layout levels deep exits one level per fully-out hop', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED_3, { fit: true });
  await centerOn(editor, ['l1']);
  const page = editor.page();
  const before = await editor.code();
  const l1 = await editor.nodeBox('l1');
  const l2 = await editor.nodeBox('l2');
  const l3 = await editor.nodeBox('l3');
  const chip = await editor.nodeBox('nchip');
  // Fully out of l3 (below it) but inside l2; then fully out of l2 (right of it) but inside l1.
  const inL2 = { x: l3.x + l3.width * 0.5, y: l3.y + l3.height + (l2.y + l2.height - l3.y - l3.height) / 2 };
  const inL1 = { x: l2.x + l2.width + (l1.x + l1.width - l2.x - l2.width) / 2, y: l2.y + l2.height * 0.6 };
  expect(chip.height / 2).toBeLessThan((l2.y + l2.height - l3.y - l3.height) / 2);
  const hops: Array<string | null> = [];
  let lastBox: { x: number; y: number; width: number; height: number } | null = null;
  await dragThrough(editor, 'nchip', [inL2, inL1], {
    stepPx: 3,
    at: async () => {
      hops.push(await domParent(editor, 'nchip'));
      lastBox = await editor.nodeBox('nchip');
    },
  });
  expect(hops, 'one level up per hop, live').toEqual(['l2', 'l1']);
  await expect.poll(() => editor.parentOf('nchip')).toBe('l1');
  // Mouseup: no jump, and no stale inset from l3 reintroduced.
  const after = await editor.nodeBox('nchip');
  expect(Math.abs(after.x - lastBox!.x)).toBeLessThan(2);
  expect(Math.abs(after.y - lastBox!.y)).toBeLessThan(2);
  const st = await editor.style('nchip');
  expect(st.right ?? null, 'stale right inset').not.toBe('110px');
  expect(st.bottom ?? null, 'stale bottom inset').not.toBe('90px');
  // Whatever pins it carries now describe where it paints inside l1.
  const scale = l1.width / 900;
  const l1b = await editor.nodeBox('l1');
  if (st.left) expect(Math.abs(px(st.left) - (after.x - l1b.x) / scale)).toBeLessThan(2);
  if (st.right) expect(Math.abs(px(st.right) - (l1b.x + l1b.width - after.x - after.width) / scale)).toBeLessThan(2);
  if (st.top) expect(Math.abs(px(st.top) - (after.y - l1b.y) / scale)).toBeLessThan(2);
  if (st.bottom) expect(Math.abs(px(st.bottom) - (l1b.y + l1b.height - after.y - after.height) / scale)).toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
  void page;
});

test('DND-091 an absolute child of a flex-slot frame exits over the flex section: canvas strategy, line in the section', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FRAME_IN_FLEX);
  const page = editor.page();
  const before = await editor.code();
  const c1 = await editor.nodeBox('c1');
  const c2 = await editor.nodeBox('c2');
  const slot = { x: (c1.x + c1.width + c2.x) / 2, y: c1.y + c1.height * 0.5 };
  const since = await traceMark(page);
  await dragThrough(editor, 'abs', [slot], {
    stepPx: 4,
    at: async () => {
      expect(await dropLine(page)).toMatchObject({ parentId: 'sec', insertIndex: 2 });
      expect(await domParent(editor, 'abs'), 'never live-reparented as absolute into the section').not.toBe('sec');
    },
  });
  const switches = await tracesSince(page, since, '^drag:strategy-switch$');
  expect(switches.map(s => `${s.data?.from}>${s.data?.to}`)).toContain('absolute-in-frame>canvas');
  await expect(editor).toHaveJsxOrder('sec', ['holder', 'c1', 'abs', 'c2']);
  const st = await editor.style('abs');
  expect(st.position).toBe('relative');
  expect(st.left).toBeUndefined();
  expect(st.top).toBeUndefined();
  expect(st.flex).toBe('0 0 auto');
  await expect(editor).toUndoInOneStep(before);
});

test('DND-093 canvas → frame → out → another frame in one gesture: no teleport by the pre-exit delta', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  test.fail(true, 'BUG: the mid-drag EXIT from a frame anchors on the rect-cache rect one frame late, so the node keeps a permanent offset of one pointer step (≈10px at a brisk 10px/frame drag) from the cursor for the rest of the gesture and the drop');
  await editor.load(ENTRY);
  const page = editor.page();
  const before = await editor.code();
  const big = await editor.nodeBox('big-frame');
  const fb = await editor.nodeBox('frame-b');
  const chip = await editor.nodeBox('chip');
  const grab = center(chip);
  const inBig = { x: big.x + big.width * 0.41, y: big.y + big.height * 0.47 };
  const outside = { x: (big.x + fb.x + fb.width) / 2, y: big.y + big.height + chip.height * 1.5 };
  const inB = { x: fb.x + fb.width * 0.43, y: fb.y + fb.height * 0.53 };
  const parents: Array<string | null> = [];
  // Per-frame distance of the chip's centre (grabbed at its centre) from the cursor.
  const travel: Array<{ leg: number; parent: string | null; err: number }> = [];
  await page.waitForTimeout(450);
  const s = await DragSession.press(page, grab);
  try {
    const legs = [inBig, outside, inB];
    for (let leg = 0; leg < legs.length; leg++) {
      const target = legs[leg];
      // ~10px per frame: a brisk but ordinary hand speed.
      const from = s.cur;
      const n = Math.max(6, Math.ceil(Math.hypot(target.x - from.x, target.y - from.y) / 10));
      for (let i = 1; i <= n; i++) {
        const at = { x: from.x + (target.x - from.x) * i / n, y: from.y + (target.y - from.y) * i / n };
        await s.moveTo(at, 1);
        const b = await editor.nodeBox('chip');
        travel.push({ leg, parent: await domParent(editor, 'chip'), err: Math.hypot(b.x + b.width / 2 - at.x, b.y + b.height / 2 - at.y) });
      }
      await s.pump(8, { axis: 'x' });
      parents.push(await domParent(editor, 'chip'));
    }
  } finally {
    await s.release();
    await editor.settled();
  }
  expect(parents).toEqual(['big-frame', null, 'frame-b']);
  await expect.poll(() => editor.parentOf('chip')).toBe('frame-b');
  // No teleport by the pre-exit delta: the drop lands near the cursor.
  const landed = center(await editor.nodeBox('chip'));
  expect(Math.hypot(landed.x - inB.x, landed.y - inB.y), 'teleported away from the cursor').toBeLessThan(14);
  await expect(editor).toUndoInOneStep(before);
  // After the exit, the chip travels over empty canvas still under the cursor:
  // the median offset there (snap holds come and go) is the persistent one.
  const afterExit = travel.filter(t => t.leg === 1 && t.parent === null).slice(2).map(t => t.err).sort((a, b) => a - b);
  expect(afterExit.length).toBeGreaterThan(4);
  expect(afterExit[Math.floor(afterExit.length / 2)], 'median cursor offset after the exit').toBeLessThan(3);
});

test('DND-094 an absolute child of an overflow:hidden frame stays visible all the way out and into another frame', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CLIPPED, { fit: true });
  await centerOn(editor, ['clip', 'dest']);
  const page = editor.page();
  const before = await editor.code();
  const clip = await editor.nodeBox('clip');
  const dest = await editor.nodeBox('dest');
  const out = { x: clip.x + clip.width + 120, y: (clip.y + clip.height + dest.y) / 2 };
  const inDest = { x: dest.x + dest.width * 0.4, y: dest.y + dest.height * 0.55 };
  const hidden: string[] = [];
  const visibleCheck = async (where: string) => {
    const b = await editor.nodeBox('cchip');
    const c = center(b);
    const topId = await sandboxFrame(page).evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id') ?? null, c);
    if (topId !== 'cchip' && !inside(c, clip, -2)) hidden.push(`${where}: ${topId}`);
  };
  const { grab, start } = await dragThrough(editor, 'cchip', [out, inDest], {
    stepPx: 4,
    at: async (i) => {
      await visibleCheck(`waypoint ${i}`);
      if (i === 0) expect(await domParent(editor, 'cchip'), 're-homed out of the clipping parent').not.toBe('clip');
    },
  });
  expect(hidden, 'frames where the chip was clipped away').toEqual([]);
  await expect.poll(() => editor.parentOf('cchip')).toBe('dest');
  // Lands where released (snap holds and a slow step of reparent lag aside — DND-093 pins the lag).
  const landed = await editor.nodeBox('cchip');
  expect(Math.abs(landed.x - (inDest.x - (grab.x - start.x)))).toBeLessThan(14);
  expect(Math.abs(landed.y - (inDest.y - (grab.y - start.y)))).toBeLessThan(14);
  await expect(editor).toUndoInOneStep(before);
});

test('DND-095 a selected flex-child container dropped on the canvas: the overlay fades in, no grip/gap handles flash', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(CONTAINER_CHILD);
  const page = editor.page();
  const root = await editor.nodeBox('root');
  await panBy(editor, { x: root.x, y: root.y }, { x: 900, y: root.y });
  const box = await editor.nodeBox('box');
  // Select it with a real click on its padding (not a child).
  await page.mouse.click(box.x + 6, box.y + box.height / 2);
  await editor.settled();
  expect(await editor.selection()).toEqual(['box']);
  await page.waitForTimeout(450);
  // While it is a flex child, the reorder grip shows.
  expect((await handleCounts(page)).grip).toBeGreaterThan(0);
  const drop = await emptyCanvasPoint(editor, { x: 520, y: box.y + box.height / 2 }, 80);
  const s = await DragSession.press(page, { x: box.x + 6, y: box.y + box.height / 2 });
  const after: Array<{ grip: number; gap: number; opacity: number | null }> = [];
  try {
    const n = Math.ceil(Math.hypot(drop.x - s.cur.x, drop.y - s.cur.y) / 6);
    await s.moveTo(drop, n);
    await s.pump(6, { axis: 'x' });
  } finally {
    await s.release();
  }
  for (let i = 0; i < 40; i++) {
    after.push(await handleCounts(page));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await editor.settled();
  await expect.poll(() => isCanvasNode(editor, 'box')).toBe(true);
  // Every handle lives inside the selection fade, so "visible" = mounted while
  // the fade is (mostly) opaque. A stale grip may sit under a faded overlay for
  // a frame or two (that is how the fix hides it); it must never SHOW.
  const shown = (f: { opacity: number | null }) => (f.opacity ?? 0) > 0.5;
  expect(after.filter(f => f.grip > 0 && shown(f)).length, 'frames with a visible reorder grip after the drop').toBe(0);
  // Gap handles never flash: once visible they stay (a canvas flex container keeps its own).
  const firstGap = after.findIndex(f => f.gap > 0 && shown(f));
  if (firstGap >= 0) expect(after.slice(firstGap).every(f => f.gap > 0), 'gap handles shown then gone').toBe(true);
  // The selection overlay fades back in.
  const ops = after.map(f => f.opacity).filter((o): o is number => o != null);
  expect(Math.min(...ops), 'overlay starts faded').toBeLessThan(0.9);
  expect(ops.at(-1)).toBeGreaterThan(0.95);
});

// ─── Mid-drag handoff (two tiles) ───────────────────────────────────────

test.describe('handoff', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-082 out of the parent and back in, one gesture: still a reorder, no premature exit', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(HANDOFF_TWO_VP, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const chipA = await editor.nodeBoxIn('desktop', 'chip-a');
    const chipB = await editor.nodeBoxIn('desktop', 'chip-b');
    const root = await editor.nodeBoxIn('desktop', 'root');
    const out = { x: chipB.x + chipB.width / 2, y: Math.max(40, root.y - 60) };
    const back = { x: chipA.x + chipA.width / 2, y: chipA.y + 6 };
    const since = await traceMark(page);
    let offParent = false;
    await page.waitForTimeout(450);
    const s = await DragSession.press(page, center(chipB));
    try {
      await s.moveTo(out, 16);
      await s.pump(6, { axis: 'x' });
      offParent = (await placeholders(editor)).length === 0;
      await s.moveTo(back, 16);
      await s.pump(6, { axis: 'x' });
    } finally {
      await s.release();
      await editor.settled();
    }
    expect(offParent, 'placeholders hidden while off the parent').toBe(true);
    // No exit was committed at any point.
    expect(await tracesSince(page, since, '^exit-commit:commit$')).toEqual([]);
    expect(await moveMutations(page, since, 'chip-b')).toEqual([]);
    expect(await editor.parentOf('chip-b')).toBe('source-box');
    expect(await isCanvasNode(editor, 'chip-b')).toBe(false);
    const src = await editor.source();
    expect(Number(src.byId.get('chip-b')!.style.order)).toBeLessThan(Number(src.byId.get('chip-a')!.style.order));
    await expect(editor).toUndoInOneStep(before);
  });

  test('DND-083 a flow child released on the sibling no-layout container (same viewport): the product keeps it in its parent', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
    // ROW-ADJUSTED (product decision recorded): the row asks for a reparent into
    // the sibling container. LayoutLifted keeps a flow child lifted in its source
    // layout while the cursor stays inside the viewport (exit detection uses the
    // top-level viewport rect; see LayoutLiftedStrategy "Exit detection uses the
    // TOP-LEVEL VIEWPORT ANCESTOR rect"), so the release is a reorder in its own
    // parent. What must hold either way: one element, no twin, nothing lost.
    await editor.load(HANDOFF_NO_LAYOUT, { fit: true });
    const page = editor.page();
    const target = await editor.nodeBoxIn('desktop', 'target-box');
    const to = { x: target.x + target.width * 0.4, y: target.y + target.height * 0.5 };
    const since = await traceMark(page);
    await page.waitForTimeout(450);
    const s = await DragSession.press(page, center(await editor.nodeBoxIn('desktop', 'chip-b')));
    try {
      await s.moveTo(to, 24);
      await s.pump(8, { axis: 'x' });
      // Mid-drag: the twin on the other tile stays hidden; one copy follows the cursor.
      await expect(await editor.nodeIn('tablet', 'chip-b')).toBeHidden();
      expect(await paintedCount(editor, 'chip-b')).toBe(1);
    } finally {
      await s.release();
      await editor.settled();
    }
    const code = await stableCode(editor);
    expect(await editor.parentOf('chip-b')).toBe('source-box');
    expect(await editor.childIds('target-box')).toEqual([]);
    expect((code.match(/data-id="chip-b"/g) ?? []).length, 'one chip-b in the source').toBe(1);
    expect(await tracesSince(page, since, '^exit-commit:commit$')).toEqual([]);
    // Both tiles paint exactly one chip-b, inside source-box.
    await expect(await editor.nodeIn('desktop', 'chip-b')).toBeVisible();
    await expect(await editor.nodeIn('tablet', 'chip-b')).toBeVisible();
    expect(await paintedCount(editor, 'chip-b')).toBe(2);
    await expect(editor).toHaveNoDuplicateIds();
  });

  test('DND-084 a flow child over a no-layout frame outside its viewport: exit commits, canvas strategy continues, lands inside', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
    await editor.load(FLOW_AND_CANVAS_FRAME, { fit: true });
    await centerOn(editor, ['drop-frame', 'root']);
    const page = editor.page();
    const before = await editor.code();
    const frame = await editor.nodeBox('drop-frame');
    const to = { x: frame.x + frame.width * 0.45, y: frame.y + frame.height * 0.5 };
    const since = await traceMark(page);
    let midSwitched = false;
    await startSampler(editor, 'item-b');
    const { grab, start } = await dragThrough(editor, 'item-b', [to], {
      stepPx: 4,
      at: async () => {
        // Mid-gesture: the exit was committed and the canvas strategy took over…
        const exitCommits = await tracesSince(page, since, '^exit-commit:commit$|^layout-lifted:exit-to-canvas-on-new-parent$');
        midSwitched = exitCommits.length > 0;
        expect((await tracesSince(page, since, '^drag:strategy-switch$')).map(t => `${t.data?.from}>${t.data?.to}`)).toContain('layout-lifted>canvas');
        // …and it already entered the frame (canvas entry → absolute-in-frame).
        expect(await domParent(editor, 'item-b')).toBe('drop-frame');
      },
    });
    const samples = await stopSampler(editor);
    expect(midSwitched, 'exit committed before the release').toBe(true);
    // No teleport at the handoff: dx/dy and the prefix were re-based.
    expect(maxJump(samples).d).toBeLessThan(20);
    expect(samples.filter(x => x.n > 1).length, 'frames with a duplicate painted').toBe(0);
    await expect.poll(() => editor.parentOf('item-b')).toBe('drop-frame');
    expect((await editor.code()).match(/data-id="item-b"/g)?.length).toBe(1);
    expect(await paintedCount(editor, 'item-b')).toBe(1);
    const landed = await editor.nodeBox('item-b');
    expect(contains(await editor.nodeBox('drop-frame'), landed)).toBe(true);
    expect(Math.abs(landed.x - (to.x - (grab.x - start.x)))).toBeLessThan(12);
    expect(Math.abs(landed.y - (to.y - (grab.y - start.y)))).toBeLessThan(12);
    await expect(editor).toUndoInOneStep(before);
  });
});
