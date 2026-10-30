// DND · Multi-selection drags (E2E_TEST_PLAN.md §2, batch D5, DND-130..137,
// DND-268): a Shift-built selection drags as one; descendants filter out; a
// press on a child of a selected ancestor drags the group; a group over a
// layout gets ONE drop line; per-node frame entries; rotated parents; fixed
// overlays; a replica-band reorder of two flex children.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { centerOn } from '../../helpers/d3';
import { dropLine } from '../../helpers/d1';
import { visualOrderIn } from '../../helpers/d6';
import {
  MULTI_FLEX, MULTI_FRAMES, NESTED_ABS, ROTATED_PARENTS, FIXED_OVERLAY, TILES_CHIPS,
  pressNode, drop, engaged, clickNode, stableCode, mark, since, near, inlineOrdersOf,
} from '../../helpers/d5';

test.describe.configure({ timeout: 180_000 });

const px = (v: string | undefined) => parseFloat(v ?? 'NaN');

// ─── DND-130 ──────────────────────────────────────────────────────────

test('DND-130 two Shift-selected canvas nodes dragged by 120px move by the same delta, each committing its own left/top', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(MULTI_FLEX);
  const page = editor.page();
  await centerOn(editor, ['cn-a', 'cn-b']);
  await clickNode(editor, 'cn-a');
  await clickNode(editor, 'cn-b', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['cn-a', 'cn-b']);
  const before = await editor.code();
  const a0 = await editor.style('cn-a'), b0 = await editor.style('cn-b');
  const ba0 = await editor.nodeBox('cn-a'), bb0 = await editor.nodeBox('cn-b');
  const scale = ba0.width / 100;
  const m = await mark(page);

  const { d } = await pressNode(editor, 'cn-a');
  try {
    await d.moveBy(120, 0, 24);
    await engaged(editor, 'cn-a', ba0);
    await d.hold(4);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  const start = (await since(page, m, '^drag:start$'))[0];
  expect(start?.data?.nodes?.map((n: any) => n.id).sort(), 'one drag carries both').toEqual(['cn-a', 'cn-b']);

  const a1 = await editor.style('cn-a'), b1 = await editor.style('cn-b');
  const dA = px(a1.left) - px(a0.left), dB = px(b1.left) - px(b0.left);
  expect(near(dA, 120 / scale, 4), `cn-a moved ${dA} css px (want ≈${120 / scale})`).toBe(true);
  expect(dB, 'both by the same delta').toBe(dA);
  expect([a1.top, b1.top], 'no vertical drift').toEqual([a0.top, b0.top]);
  // Relative offset unchanged, in the source and on screen.
  expect(px(b1.left) - px(a1.left)).toBe(px(b0.left) - px(a0.left));
  const ba1 = await editor.nodeBox('cn-a'), bb1 = await editor.nodeBox('cn-b');
  expect(near(bb1.x - ba1.x, bb0.x - ba0.x, 1.5) && near(bb1.y - ba1.y, bb0.y - ba0.y, 1.5), 'painted offset kept').toBe(true);
  expect(await editor.attr('cn-a', 'data-canvas-node')).toBe('true');
  expect(await editor.attr('cn-b', 'data-canvas-node')).toBe('true');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-131 ──────────────────────────────────────────────────────────

test('DND-131 two selected canvas nodes over a flex container: one drop line at the cursor slot, then both land there as consecutive flow children', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(MULTI_FLEX);
  const page = editor.page();
  await centerOn(editor, ['cn-a', 'how']);
  await clickNode(editor, 'cn-a');
  await clickNode(editor, 'cn-b', { shift: true });
  const before = await editor.code();
  const a0 = await editor.nodeBox('cn-a');
  const { d } = await pressNode(editor, 'cn-a');
  try {
    // Into the 80px gap between features and how: the root itself (a flex
    // column) is under the cursor there, so the GROUP targets the layout.
    const f = await editor.nodeBox('features');
    const how = await editor.nodeBox('how');
    await d.moveTo({ x: how.x + 300, y: (f.y + f.height + how.y) / 2 }, 30);
    await engaged(editor, 'cn-a', a0);
    await d.hold(10);
    const line = await dropLine(page);
    expect(line, 'a drop line shows').not.toBeNull();
    expect([line!.parentId, line!.insertIndex], 'one line, at the slot between features and how').toEqual(['root', 2]);
    expect(await page.locator('[data-drop-line-indicator]').count(), 'exactly one line').toBe(1);
    // No per-node live reparent while the group line is up: both are still canvas nodes.
    expect(await editor.parentOf('cn-a')).toBeNull();
    expect(await editor.parentOf('cn-b')).toBeNull();
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  const kids = await editor.childIds('root');
  const ia = kids.indexOf('cn-a'), ib = kids.indexOf('cn-b');
  expect(ia >= 0 && ib >= 0, `both in root: ${kids.join(',')}`).toBe(true);
  expect(await editor.attr('cn-a', 'data-canvas-node')).toBeNull();
  expect(await editor.attr('cn-b', 'data-canvas-node')).toBeNull();
  for (const id of ['cn-a', 'cn-b']) {
    const st = await editor.style(id);
    expect([st.position, st.left ?? null, st.top ?? null], `${id} is a flow child`).toEqual(['relative', null, null]);
  }
  // Consecutive, between features and how, on screen.
  const seen = await visualOrderIn(editor, 'desktop', ['hero', 'features', 'cn-a', 'cn-b', 'how']);
  expect(seen.slice(0, 2)).toEqual(['hero', 'features']);
  expect(seen.slice(2, 4).sort()).toEqual(['cn-a', 'cn-b']);
  expect(seen[4]).toBe('how');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-132 ──────────────────────────────────────────────────────────

test('DND-132 a parent and its child both selected: dragging the parent moves the child once, with it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED_ABS);
  const page = editor.page();
  await centerOn(editor, ['pf', 'gf', 'nc']);
  await clickNode(editor, 'pf', { fx: 0.8, fy: 0.8 });
  await clickNode(editor, 'pk', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['pf', 'pk']);
  const before = await editor.code();
  const k0 = await editor.style('pk');
  const pb0 = await editor.nodeBox('pf'), kb0 = await editor.nodeBox('pk');
  const m = await mark(page);
  const { d } = await pressNode(editor, 'pf', { fx: 0.8, fy: 0.8 });
  try {
    await d.moveBy(60, 30, 12);
    await engaged(editor, 'pf', pb0);
    await d.hold(4);
    // Mid-drag the child rides with the parent (not twice the delta).
    const pb = await editor.nodeBox('pf'), kb = await editor.nodeBox('pk');
    expect(near(kb.x - kb0.x, pb.x - pb0.x, 1.5) && near(kb.y - kb0.y, pb.y - pb0.y, 1.5), 'child tracks the parent mid-drag').toBe(true);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  const filtered = await since(page, m, '^dragcoord:filter-descendants$');
  expect(filtered.map(e => e.data.dropped), 'the child is filtered out of the drag set').toEqual([['pk']]);
  expect((await since(page, m, '^drag:start$'))[0].data.nodes.map((n: any) => n.id)).toEqual(['pf']);
  // Source: the parent moved, the child kept its parent-local offsets.
  expect(await editor.style('pk')).toEqual(k0);
  expect(await editor.parentOf('pk')).toBe('pf');
  const pb1 = await editor.nodeBox('pf'), kb1 = await editor.nodeBox('pk');
  expect(pb1.x - pb0.x).toBeGreaterThan(40);
  expect(near(kb1.x - kb0.x, pb1.x - pb0.x, 1.5) && near(kb1.y - kb0.y, pb1.y - pb0.y, 1.5), 'child painted once-moved').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-133 ──────────────────────────────────────────────────────────

test('DND-133 frame F multi-selected with G: pressing F\'s child drags the group; a plain click on that child selects it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED_ABS);
  const page = editor.page();
  await centerOn(editor, ['pf', 'gf', 'nc']);
  await clickNode(editor, 'pf', { fx: 0.8, fy: 0.8 });
  await clickNode(editor, 'gf', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['gf', 'pf']);
  const before = await editor.code();
  const k0 = await editor.style('pk');
  const f0 = await editor.style('pf'), g0 = await editor.style('gf');
  const gb0 = await editor.nodeBox('gf'), kb0 = await editor.nodeBox('pk');
  const m = await mark(page);
  const { d } = await pressNode(editor, 'pk');
  try {
    await d.moveBy(60, 30, 12);
    await engaged(editor, 'pk', kb0);
    await d.hold(4);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  expect((await since(page, m, '^canvas:multi-select-redirect-to-ancestor$')).map(e => [e.data.from, e.data.to])).toEqual([['pk', 'pf']]);
  expect((await since(page, m, '^drag:start$'))[0].data.nodes.map((n: any) => n.id).sort(), 'the group drags').toEqual(['gf', 'pf']);
  // Both frames moved, the pressed child kept its local offsets.
  expect(await editor.style('pf')).not.toEqual(f0);
  expect(await editor.style('gf')).not.toEqual(g0);
  expect(await editor.style('pk')).toEqual(k0);
  expect((await editor.nodeBox('gf')).x - gb0.x).toBeGreaterThan(40);
  expect((await editor.selection()).sort(), 'selection stays the group after the drag').toEqual(['gf', 'pf']);
  await expect(editor).toUndoInOneStep(before);

  // A press-release on the child without moving selects the child.
  await page.waitForTimeout(450);
  const code1 = await editor.code();
  await clickNode(editor, 'pk');
  expect(await editor.selection()).toEqual(['pk']);
  expect(await editor.code(), 'a click writes nothing').toBe(code1);
});

// ─── DND-134 ──────────────────────────────────────────────────────────

test('DND-134 two selected canvas nodes dragged into two different no-layout frames: each enters its own, no flapping, no @media residue', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(MULTI_FRAMES);
  const page = editor.page();
  await centerOn(editor, ['cn-a', 'fb']);
  await clickNode(editor, 'cn-a');
  await clickNode(editor, 'cn-b', { shift: true });
  const before = await editor.code();
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'cn-a');
  try {
    const fa = await editor.nodeBox('fa');
    await d.moveTo({ x: box.x + box.width / 2, y: fa.y + fa.height * 0.4 }, 40);
    await engaged(editor, 'cn-a', box);
    // Sit inside for ~1s worth of frames: an enter/exit loop would show here.
    for (let i = 0; i < 40; i++) await d.moveBy(i % 2 ? 1 : -1, i % 2 ? 1 : 0, 1);
    await d.moveBy(0, 16, 8);
  } finally {
    await drop(editor, d);
  }
  const code = await stableCode(editor);
  const entries = await since(page, m, '^transform-reparent:entry$');
  const exits = await since(page, m, '^transform-reparent:exit$');
  const commits = await since(page, m, '^exit-commit:commit$');
  const entered = (id: string) => entries.filter(e => e.data.nodeId === id).map(e => e.data.parentId);
  expect(entered('cn-a'), 'cn-a enters fa once').toEqual(['fa']);
  expect(entered('cn-b'), 'cn-b enters fb once').toEqual(['fb']);
  expect(exits.length + commits.length, 'no exit / re-entry flapping').toBe(0);
  expect(await editor.parentOf('cn-a')).toBe('fa');
  expect(await editor.parentOf('cn-b')).toBe('fb');
  for (const id of ['cn-a', 'cn-b']) {
    expect(await editor.attr(id, 'data-canvas-node')).toBeNull();
    expect((await editor.style(id)).position).toBe('absolute');
  }
  expect(code.includes('@media'), 'no @media residue').toBe(false);
  // Painted inside their frames.
  const inside = (o: { x: number; y: number; width: number; height: number }, i: { x: number; y: number; width: number; height: number }) =>
    i.x >= o.x - 1 && i.y >= o.y - 1 && i.x + i.width <= o.x + o.width + 1 && i.y + i.height <= o.y + o.height + 1;
  expect(inside(await editor.nodeBox('fa'), await editor.nodeBox('cn-a'))).toBe(true);
  expect(inside(await editor.nodeBox('fb'), await editor.nodeBox('cn-b'))).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-135 ──────────────────────────────────────────────────────────

test('DND-135 A and B selected, press on unselected C and drag: only C drags and becomes the selection', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED_ABS);
  const page = editor.page();
  await centerOn(editor, ['pf', 'gf', 'nc']);
  await clickNode(editor, 'na');
  await clickNode(editor, 'nb', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['na', 'nb']);
  const before = await editor.code();
  const a0 = await editor.style('na'), b0 = await editor.style('nb'), c0 = await editor.style('nc');
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'nc');
  try {
    await d.moveBy(60, 30, 12);
    await engaged(editor, 'nc', box);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  expect((await since(page, m, '^drag:start$'))[0].data.nodes.map((n: any) => n.id)).toEqual(['nc']);
  expect(await editor.selection()).toEqual(['nc']);
  expect(await editor.style('na')).toEqual(a0);
  expect(await editor.style('nb')).toEqual(b0);
  expect(await editor.style('nc')).not.toEqual(c0);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-136 ──────────────────────────────────────────────────────────

test('DND-136 a selection under two parents, one rotated 90°: dragging straight up moves both up on screen', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: AbsoluteInFrameStrategy.onMove projects the screen delta through ONE parent (this.parentId = the first dragged node\'s parent) and applies that local delta to every node, so the node under the other parent moves sideways ("drag up goes left")');
  await editor.load(ROTATED_PARENTS);
  const page = editor.page();
  await centerOn(editor, ['p1', 'p2']);
  await clickNode(editor, 'ka');
  await clickNode(editor, 'kb', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['ka', 'kb']);
  const before = await editor.code();
  const a0 = await editor.nodeBox('ka'), b0 = await editor.nodeBox('kb');
  const { d } = await pressNode(editor, 'ka');
  try {
    await d.moveBy(0, -60, 15);
    await d.hold(4);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  const a1 = await editor.nodeBox('ka'), b1 = await editor.nodeBox('kb');
  for (const [id, s, e] of [['ka', a0, a1], ['kb', b0, b1]] as const) {
    expect(near(e.y - s.y, -60, 6), `${id} moved up on screen (dy ${e.y - s.y})`).toBe(true);
    expect(near(e.x - s.x, 0, 6), `${id} did not move sideways (dx ${e.x - s.x})`).toBe(true);
  }
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-137 ──────────────────────────────────────────────────────────

test('DND-137 a fixed-overlay-only selection never starts a drag; a mixed selection with a frame drags', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: in a mixed selection the fixed overlay is dragged along from its canvas-painted 0/0 (initializeDrag reads computed left/top), so its authored left/top 600px/100px are overwritten with the bare drag delta');
  await editor.load(FIXED_OVERLAY);
  const page = editor.page();
  await page.evaluate(() => (window as any).__e2e.openOverlay('ov')); // setup: show the overlay on the canvas
  await editor.settled();
  await expect.poll(async () => (await editor.sandbox().locator('[data-id="ov"]').count()) > 0).toBe(true);
  await centerOn(editor, ['cframe', 'box']);
  const before = await editor.code();
  const ov0 = await editor.style('ov');
  const ovBox0 = await editor.nodeBox('ov');

  // 1. Only the fixed overlay selected: press + move never starts a drag.
  await clickNode(editor, 'ov', { fx: 0.5, fy: 0.3 });
  expect(await editor.selection()).toEqual(['ov']);
  let m = await mark(page);
  const r0 = await pressNode(editor, 'ov', { fx: 0.5, fy: 0.3 });
  try { await r0.d.moveBy(60, 30, 12); } finally { await drop(editor, r0.d); }
  expect((await since(page, m, '^drag:blocked-fixed-overlay$')).length).toBeGreaterThan(0);
  expect(await since(page, m, '^drag:start$'), 'no drag started').toEqual([]);
  expect(await editor.code(), 'nothing written').toBe(before);
  const ovBox1 = await editor.nodeBox('ov');
  expect(near(ovBox1.x, ovBox0.x, 1) && near(ovBox1.y, ovBox0.y, 1)).toBe(true);

  // 2. Overlay + a canvas frame: the selection drags.
  await clickNode(editor, 'cframe', { shift: true });
  expect((await editor.selection()).sort()).toEqual(['cframe', 'ov']);
  const cf0 = await editor.style('cframe');
  m = await mark(page);
  const r = await pressNode(editor, 'cframe');
  try {
    await r.d.moveBy(60, 30, 12);
    await engaged(editor, 'cframe', r.box);
  } finally {
    await drop(editor, r.d);
  }
  await stableCode(editor);
  expect((await since(page, m, '^drag:start$')).length, 'the mixed selection drags').toBe(1);
  const cf1 = await editor.style('cframe');
  const dl = px(cf1.left) - px(cf0.left), dt = px(cf1.top) - px(cf0.top);
  expect(dl).toBeGreaterThan(40);
  // The overlay is either left alone or carried by the SAME delta from its authored spot.
  const ov1 = await editor.style('ov');
  const untouched = ov1.left === ov0.left && ov1.top === ov0.top;
  const carried = near(px(ov1.left) - px(ov0.left), dl, 2) && near(px(ov1.top) - px(ov0.top), dt, 2);
  expect(untouched || carried, `overlay left/top ${ov0.left},${ov0.top} → ${ov1.left},${ov1.top} (frame moved ${dl},${dt})`).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-268 ──────────────────────────────────────────────────────────

test.describe('on tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-268 Tablet: two Shift-selected flex children dragged below a third get adjacent Tablet band orders; JSX, Desktop and Mobile unchanged', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TILES_CHIPS, { fit: true });
    const page = editor.page();
    const ids = ['c1', 'c2', 'c3'];
    await clickNode(editor, 'c1', { vpId: 'tablet' });
    await clickNode(editor, 'c2', { vpId: 'tablet', shift: true });
    expect((await editor.selection()).sort()).toEqual(['c1', 'c2']);
    const before = await editor.code();
    const inline0 = await inlineOrdersOf(editor, ids);
    const m = await mark(page);
    const { d, box } = await pressNode(editor, 'c1', { vpId: 'tablet' });
    try {
      const c3 = await editor.nodeBoxIn('tablet', 'c3');
      await d.moveTo({ x: c3.x + c3.width / 2 + 3, y: c3.y + c3.height * 0.9 }, 30);
      await engaged(editor, 'c1', box, 'tablet');
      await d.hold(10);
    } finally {
      await drop(editor, d);
    }
    await stableCode(editor);
    expect((await since(page, m, '^drag:start$'))[0].data.nodes.map((n: any) => n.id).sort(), 'both drag').toEqual(['c1', 'c2']);
    // Tablet band: c3, then the pair in their original relative order.
    await expect(editor).toHaveBandStyle(768, 'c3', 'order', '0', { important: true });
    await expect(editor).toHaveBandStyle(768, 'c1', 'order', '1', { important: true });
    await expect(editor).toHaveBandStyle(768, 'c2', 'order', '2', { important: true });
    // JSX, Desktop (inline) and Mobile untouched.
    await expect(editor).toHaveJsxOrder('root', ids);
    expect(await inlineOrdersOf(editor, ids)).toEqual(inline0);
    for (const id of ids) expect(await editor.bandStyle(375, id, 'order'), `no mobile order for ${id}`).toBeNull();
    expect(await visualOrderIn(editor, 'tablet', ids)).toEqual(['c3', 'c1', 'c2']);
    expect(await visualOrderIn(editor, 'desktop', ids)).toEqual(ids);
    expect(await visualOrderIn(editor, 'mobile', ids)).toEqual(ids);
    await expect(editor).toUndoInOneStep(before);
  });
});
