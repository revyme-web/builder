// DND · Grid layouts: cell swaps (order-stamped and auto-flow), drops into a
// grid, drag-outs, spans and explicit lines, rotated grids, flex↔grid moves
// (E2E_TEST_PLAN.md §2, batch D7).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { centerOn, setZoom, emptyCanvasPoint } from '../../helpers/d3';
import { canvasNodeIds, styleTernary, masterSeed, masterModule, openMaster } from '../../helpers/d6';
import { parentOutline } from '../../helpers/d1';
import {
  gridPage, grid8, cell, G8, TILES, seed, pageSrc, dropLineRead, pressNode, drop, engaged, boxesOf, boxOf, placeholderBoxes, mark, since,
  stableCode, inlineOrders, bandOrders, paintedOrder, center, wiggle, sameBox, near, prime, type Box,
} from '../../helpers/d7';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ───────────────────────────────────────────────────────────

/** The 2×4 order-stamped grid (g0..g7, order 0..7) on the primary. */
const GRID8 = gridPage(grid8());

/** The same grid with no `order` anywhere (auto-flow, DOM-swap path). */
const GRID8_AUTO = gridPage(grid8({ order: false }));

/** Two grids: fluid cells (`100%` × `100%` in auto rows of a 300px grid) and px cells. */
const SIZING = gridPage(`<div data-id="gf" data-name="FluidGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', width: '600px', height: '300px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
${['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map((id, i) => `    ${cell(id, i, { extra: `width: '100%', height: '100%'` })}`).join('\n')}
  </div>
  <div data-id="gp" data-name="PxGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', width: '600px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '1' }}>
${['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => `    ${cell(id, i, { extra: `width: '120px', height: '90px'` })}`).join('\n')}
  </div>`);

const swapsOf = (es: Array<{ c: string; data: any }>) => es.filter(e => e.c === 'grid-drag:swap').map(e => e.data.targetId as string);

// ─── DND-183 ─────────────────────────────────────────────────────────

test('DND-183 order-stamped 2×4 grid: one swap per cell entry, JSX reordered and orders re-stamped 0..7 on drop', { tag: ['@p0', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(GRID8);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const b0 = await boxesOf(editor, G8);
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'g0');
  try {
    // Lift: the placeholder holds g0's cell at g0's size; nothing reflows.
    await d.moveBy(6, 4, 4);
    await engaged(editor, 'g0', box);
    const holes = await placeholderBoxes(editor);
    expect(holes, 'one grid placeholder').toHaveLength(1);
    expect(sameBox(holes[0], b0.g0!), 'the placeholder pins g0\'s cell').toBe(true);
    const lifted = await boxesOf(editor, G8.slice(1));
    for (const id of G8.slice(1)) expect(sameBox(lifted[id], b0[id]), `${id} still at lift`).toBe(true);

    // Enter cell 2: ONE swap, and g1 visibly reflows into cell 1.
    await d.moveTo(center(b0.g1!), 12);
    await wiggle(d, 6);
    expect(swapsOf(await since(page, m, '^grid-drag:swap$'))).toEqual(['g1']);
    expect(sameBox(await boxOf(editor, 'g1'), b0.g0!), 'g1 reflowed into cell 1 mid-drag').toBe(true);
    expect(sameBox((await placeholderBoxes(editor))[0], b0.g1!), 'the placeholder moved to cell 2').toBe(true);

    // Down into cell 6: ONE more swap, g5 reflows into cell 2.
    await d.moveTo(center(b0.g5!), 12);
    await wiggle(d, 6, 'x');
    expect(swapsOf(await since(page, m, '^grid-drag:swap$'))).toEqual(['g1', 'g5']);
    expect(sameBox(await boxOf(editor, 'g5'), b0.g1!), 'g5 reflowed into cell 2 mid-drag').toBe(true);
    expect(sameBox((await placeholderBoxes(editor))[0], b0.g5!), 'the placeholder sits in cell 6').toBe(true);
  } finally {
    await drop(editor, d);
  }

  const want = ['g1', 'g5', 'g2', 'g3', 'g4', 'g0', 'g6', 'g7'];
  await expect(editor).toHaveJsxOrder('grid', want);
  await expect.poll(() => inlineOrders(editor, G8)).toEqual(Object.fromEntries(want.map((id, i) => [id, String(i)])));
  await stableCode(editor);
  await expect.poll(() => paintedOrder(editor, G8)).toEqual(want);
  expect(await placeholderBoxes(editor)).toHaveLength(0);
  expect(swapsOf(await since(page, m, '^grid-drag:swap$')), 'no extra swap at drop').toEqual(['g1', 'g5']);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-184 ─────────────────────────────────────────────────────────

/** Gap hits + swap-back + row-gap hit, at the current zoom. Returns the swaps seen. */
async function gapGesture(editor: import('../../helpers/editor').Editor, steps: number): Promise<{ swaps: string[]; gapHit: { x: number; y: number } | null; rowHit: { x: number; y: number } | null }> {
  const page = editor.page();
  const b0 = await boxesOf(editor, ['g0', 'g1', 'g4']);
  const g0 = b0.g0!, g1 = b0.g1!, g4 = b0.g4!;
  const colGap = g1.x - (g0.x + g0.width);
  const rowGap = g4.y - (g0.y + g0.height);
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'g0');
  let gapHit: { x: number; y: number } | null = null;
  let rowHit: { x: number; y: number } | null = null;
  try {
    await d.moveBy(4, 4, 3);
    await engaged(editor, 'g0', box);
    // 1. Into the COLUMN GAP on g1's side (never over g1's own box).
    const inGap = { x: g0.x + g0.width + colGap * 0.75, y: g0.y + g0.height / 2 };
    await d.moveTo(inGap, steps);
    await wiggle(d, 6);
    const hit = (await since(page, m, '^grid-drag:hover-target$')).find(e => e.data.targetId === 'g1');
    gapHit = hit ? hit.data.mouse : null;
    expect(swapsOf(await since(page, m, '^grid-drag:swap$')), 'the gap band swapped with g1').toEqual(['g1']);
    expect(sameBox(await boxOf(editor, 'g1'), g0), 'g1 painted in cell 1').toBe(true);

    // 2. Back onto g1 (now in cell 1): the swap-back swaps again.
    await d.moveTo(center(g0), steps);
    await wiggle(d, 6);
    expect(swapsOf(await since(page, m, '^grid-drag:swap$')), 'the swap-back swapped').toEqual(['g1', 'g1']);
    expect(sameBox(await boxOf(editor, 'g1'), g1), 'g1 painted back in cell 2').toBe(true);

    // 3. Down into the ROW GAP on the lower row's side: g4 swaps up.
    const m2 = await mark(page);
    const inRowGap = { x: g0.x + g0.width / 2, y: g0.y + g0.height + rowGap * 0.75 };
    await d.moveTo(inRowGap, steps);
    await wiggle(d, 6, 'x');
    const hit2 = (await since(page, m2, '^grid-drag:hover-target$')).find(e => e.data.targetId === 'g4');
    rowHit = hit2 ? hit2.data.mouse : null;
    expect(sameBox(await boxOf(editor, 'g4'), g0), 'g4 painted in cell 1').toBe(true);
  } finally {
    await drop(editor, d);
  }
  // The hits happened INSIDE the gap bands (the inflated half), not over a cell.
  expect(gapHit, 'a g1 hit was traced').not.toBeNull();
  expect(gapHit!.x).toBeGreaterThan(g0.x + g0.width);
  expect(gapHit!.x).toBeLessThan(g1.x);
  expect(rowHit, 'a g4 hit was traced').not.toBeNull();
  expect(rowHit!.y).toBeGreaterThan(g0.y + g0.height);
  expect(rowHit!.y).toBeLessThan(g4.y);
  return { swaps: swapsOf(await since(page, m, '^grid-drag:swap$')), gapHit, rowHit };
}

test('DND-184 order-stamped grid: column and row gap bands are hits and a swap-back swaps again, at 1× and 2× zoom', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(GRID8);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const want = ['g4', 'g1', 'g2', 'g3', 'g0', 'g5', 'g6', 'g7'];

  const r1 = await gapGesture(editor, 12);
  expect(r1.swaps).toEqual(['g1', 'g1', 'g4']);
  await expect(editor).toHaveJsxOrder('grid', want);
  await expect.poll(() => inlineOrders(editor, G8)).toEqual(Object.fromEntries(want.map((id, i) => [id, String(i)])));
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);

  // Again at 2× zoom (gap bands twice as wide on screen).
  const scale = await setZoom(editor, 2, { id: 'grid', cssWidth: 760 }, ['g0', 'g1', 'g4', 'g5']);
  expect(near(scale, 2, 0.15), `zoom ${scale}`).toBe(true);
  await editor.page().waitForTimeout(500);
  const r2 = await gapGesture(editor, 30);
  expect(r2.swaps).toEqual(['g1', 'g1', 'g4']);
  await expect(editor).toHaveJsxOrder('grid', want);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-188 ─────────────────────────────────────────────────────────

async function liftHolds(editor: import('../../helpers/editor').Editor, gridId: string, ids: string[], drag: string): Promise<void> {
  const before = await boxesOf(editor, [gridId, ...ids]);
  const { d, box } = await pressNode(editor, drag);
  try {
    await d.moveBy(5, 4, 4);
    await engaged(editor, drag, box);
    await wiggle(d, 6);
    const holes = await placeholderBoxes(editor);
    expect(holes, `one placeholder for ${drag}`).toHaveLength(1);
    expect(sameBox(holes[0], before[drag]!), `the placeholder pins ${drag}'s cell (${JSON.stringify(holes[0])} vs ${JSON.stringify(before[drag])})`).toBe(true);
    const now = await boxesOf(editor, [gridId, ...ids.filter(i => i !== drag)]);
    expect(sameBox(now[gridId], before[gridId]!), `${gridId} keeps its size at lift`).toBe(true);
    for (const id of ids) {
      if (id === drag) continue;
      expect(sameBox(now[id], before[id]!), `${id} unmoved at lift (rows never grow)`).toBe(true);
    }
  } finally {
    // Back over its own slot, then release: no net change.
    await d.moveTo(center(box), 6);
    await drop(editor, d);
  }
}

test('DND-188 lifting a grid cell: the placeholder pins the cell and mirrors fluid vs px sizing, rows never grow', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(SIZING);
  await centerOn(editor, ['gf', 'gp']);
  const before = await editor.code();
  // Fluid (`100%` in auto rows of a fixed-height grid) — rows stretch evenly.
  await liftHolds(editor, 'gf', ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'], 'f1');
  await stableCode(editor);
  expect(await editor.code(), 'a drop back in place writes nothing').toBe(before);
  await editor.page().waitForTimeout(450);
  // Px cells — the exact footprint.
  await liftHolds(editor, 'gp', ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'p4');
  await stableCode(editor);
  expect(await editor.code(), 'a drop back in place writes nothing').toBe(before);
});

// ─── DND-189 ─────────────────────────────────────────────────────────

test('DND-189 order-less auto-flow grid: a cell dropped on another swaps them in the JSX', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(GRID8_AUTO);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const b0 = await boxesOf(editor, G8);
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'g0');
  try {
    await d.moveBy(5, 4, 4);
    await engaged(editor, 'g0', box);
    // Straight to g2 along row 1's lower band (crossing g1's cell swaps with it first).
    await d.moveTo({ x: center(b0.g2!).x, y: b0.g2!.y + b0.g2!.height * 0.5 }, 20);
    await wiggle(d, 6);
    // Mid-drag the DOM swap paints: g2 sits in cell 2 now (placeholder in cell 3).
    expect(sameBox((await placeholderBoxes(editor))[0], b0.g2!), 'the placeholder reached cell 3').toBe(true);
  } finally {
    await drop(editor, d);
  }
  const swaps = swapsOf(await since(page, m, '^grid-drag:swap$'));
  expect(swaps, 'DOM-swap path: one swap per cell entered').toEqual(['g1', 'g2']);
  // g0 ↔ g1, then g0 ↔ g2: g1, g2, g0, …
  const want = ['g1', 'g2', 'g0', 'g3', 'g4', 'g5', 'g6', 'g7'];
  await expect(editor).toHaveJsxOrder('grid', want);
  expect(Object.values(await inlineOrders(editor, G8)).every(v => v === null), 'no `order` written on an auto-flow grid').toBe(true);
  await stableCode(editor);
  await expect.poll(() => paintedOrder(editor, G8)).toEqual(want);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-190 ─────────────────────────────────────────────────────────

test('DND-190 a grid cell picked up and dropped back in its own slot writes nothing; only the selection fade runs', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(GRID8);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const b0 = await boxesOf(editor, G8);
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'g2');
  try {
    await d.moveBy(box.width * 0.3, box.height * 0.3, 6);
    await engaged(editor, 'g2', box);
    await wiggle(d, 4);
    await d.moveTo(center(box), 6);
    await wiggle(d, 4);
  } finally {
    await drop(editor, d);
  }
  await stableCode(editor);
  expect(swapsOf(await since(page, m, '^grid-drag:swap$')), 'no swap').toEqual([]);
  expect((await since(page, m, '^grid-drag:end$')).length, 'the grid drag ran').toBe(1);
  expect((await since(page, m, '^grid-drag:reposition-signal$')).length, 'the selection fade ran').toBe(1);
  expect(await editor.code(), 'orders and JSX unchanged').toBe(before);
  const after = await boxesOf(editor, G8);
  for (const id of G8) expect(sameBox(after[id], b0[id]), `${id} back in place`).toBe(true);
});

// ─── Tiles + masters ─────────────────────────────────────────────────

const C4 = ['c0', 'c1', 'c2', 'c3'];

/** Three tiles; a 2-column order-stamped grid of four cells. */
const GRID_3VP = gridPage(`<div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gridAutoRows: '90px', gap: '16px', width: '100%', padding: '16px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
${C4.map((id, i) => `    ${cell(id, i)}`).join('\n')}
  </div>`, { tiles: TILES.three, rootExtra: `width: '100%'` });

test.describe('tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-185 3-tile page: a grid reorder on the Tablet tile writes the tablet band only, no JSX change', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(GRID_3VP, { fit: true });
    const before = await editor.code();
    expect(await paintedOrder(editor, C4, 'tablet')).toEqual(C4);
    await prime(editor, 'c0', 'tablet');
    const c0 = await editor.nodeBoxIn('tablet', 'c0');
    const c1 = await editor.nodeBoxIn('tablet', 'c1');
    const { d } = await pressNode(editor, 'c0', { vpId: 'tablet' });
    try {
      await d.moveBy(5, 4, 4);
      await engaged(editor, 'c0', c0, 'tablet');
      await d.moveTo(center(c1), 16);
      await wiggle(d, 6);
      // The swap paints on Tablet only, mid-drag.
      expect(sameBox(await boxOf(editor, 'c1', 'tablet'), c0), 'c1 reflowed into cell 1 on Tablet').toBe(true);
    } finally {
      await drop(editor, d);
    }
    await expect(editor).toHaveBandStyle(768, 'c1', 'order', '0', { important: true });
    await expect(editor).toHaveBandStyle(768, 'c0', 'order', '1', { important: true });
    await expect(editor).toHaveBandStyle(768, 'c2', 'order', '2', { important: true });
    await expect(editor).toHaveBandStyle(768, 'c3', 'order', '3', { important: true });
    await expect(editor).toHaveJsxOrder('grid', C4);
    expect(await inlineOrders(editor, C4), 'inline (Desktop) orders untouched').toEqual({ c0: '0', c1: '1', c2: '2', c3: '3' });
    expect(await bandOrders(editor, 375, C4), 'no mobile band orders').toEqual({ c0: null, c1: null, c2: null, c3: null });
    await stableCode(editor);
    await expect.poll(() => paintedOrder(editor, C4, 'tablet')).toEqual(['c1', 'c0', 'c2', 'c3']);
    expect(await paintedOrder(editor, C4, 'desktop')).toEqual(C4);
    expect(await paintedOrder(editor, C4, 'mobile')).toEqual(C4);
    await expect(editor).toUndoInOneStep(before);
  });

  test('DND-191 a grid child dragged out of the Tablet tile: cloned to the canvas, hidden on Tablet only', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: the replica grid drag-out clone is written with empty style values (gridColumn/gridRow/gridArea/zIndex/pointerEvents: \'\') — GridDragStrategy.commitExitToCanvas passes its \'\'-carrying exitStyles to buildCanvasCloneForLayoutDrop, and the add descriptor writes them verbatim (oracle EMPTY_STYLE_VALUE)');
    await editor.load(GRID_3VP, { fit: true });
    const before = await editor.code();
    await prime(editor, 'c1', 'tablet');
    const c1 = await editor.nodeBoxIn('tablet', 'c1');
    const tabletRoot = await editor.nodeBoxIn('tablet', 'root');
    const out = await emptyCanvasPoint(editor, { x: c1.x + c1.width / 2, y: tabletRoot.y + tabletRoot.height + 120 }, 50);
    const m = await mark(page);
    const { d } = await pressNode(editor, 'c1', { vpId: 'tablet' });
    try {
      await d.moveBy(5, 4, 4);
      await engaged(editor, 'c1', c1, 'tablet');
      await d.moveTo(out, 30);
      await wiggle(d, 6);
    } finally {
      await drop(editor, d);
    }
    await expect.poll(async () => canvasNodeIds(await editor.code()).length, { message: 'a canvas clone' }).toBe(1);
    const code = await stableCode(editor);
    const clone = canvasNodeIds(code)[0];
    expect(clone, 'the clone has a fresh id').not.toBe('c1');
    expect((await since(page, m, '^grid-drag:exit-to-canvas-replica-clone$')).length).toBe(1);
    // The source stays in the grid for every other tile (not: deleted everywhere).
    expect(await editor.childIds('grid'), 'c1 still in the grid').toEqual(C4);
    await expect.poll(async () => (await boxOf(editor, 'c1', 'tablet')) === null, { message: 'hidden on Tablet' }).toBe(true);
    expect(await boxOf(editor, 'c1', 'desktop'), 'Desktop keeps c1').not.toBeNull();
    expect(await boxOf(editor, 'c1', 'mobile'), 'Mobile keeps c1').not.toBeNull();
    expect(await editor.bandStyle(375, 'c1', 'display'), 'no mobile hide').toBeNull();
    await expect(editor).toUndoInOneStep(before);
    // The clone carries no empty style values (an empty value deletes, it is never written).
    const cloneLine = code.split('\n').find(l => l.includes(`data-id="${clone}"`)) ?? '';
    expect(cloneLine.match(/\w+: ''/g) ?? [], 'no empty style values on the clone').toEqual([]);
  });
});

const K6 = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
const kCell = (id: string, i: number) =>
  `<motion.div layout={true} data-id="${id}" data-name="${id.toUpperCase()}" style={{ position: 'relative', backgroundColor: '${['#ff5577', '#ffffff', '#ffcc55', '#99dd55', '#55aadd', '#cc66dd'][i]}', order: '${i}' }} />`;

/** A master: a 2-column grid of six cells; k1 is hidden on the default (Desktop) variant. */
const GRID_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '360px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="grid" data-name="Grid" style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gridAutoRows: '60px', gap: '10px', width: '100%', flex: '0 0 auto', order: '0' }}>
        ${kCell('k0', 0)}
        <AnimatePresence mode="popLayout">{initialVariant !== 'default' && (
          <motion.div layout={true} key="k1" data-id="k1" data-name="K1" exit={{ opacity: 0 }} style={{ position: 'relative', backgroundColor: '#ffffff', order: '1' }} />
        )}</AnimatePresence>
        ${K6.slice(2).map((id, i) => kCell(id, i + 2)).join('\n        ')}
      </motion.div>
    </motion.div>`));
const CARD = 'components/Card.tsx';

test.describe('master', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-186 master grid reorder on the Mobile tile: a Mobile-only ternary; default keeps the authored sequence, hidden child included', { tag: ['@p0', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
    await editor.load(GRID_MASTER);
    await openMaster(editor, CARD);
    const before = await editor.code(CARD);
    const desk0 = await paintedOrder(editor, K6, 'desktop');
    expect(desk0, 'k1 is hidden on Desktop').toEqual(['k0', 'k2', 'k3', 'k4', 'k5']);
    expect(await paintedOrder(editor, K6, 'variant-2')).toEqual(K6);
    await prime(editor, 'k3', 'variant-2');
    const k3 = await editor.nodeBoxIn('variant-2', 'k3');
    const k2 = await editor.nodeBoxIn('variant-2', 'k2');
    const { d } = await pressNode(editor, 'k3', { vpId: 'variant-2' });
    try {
      await d.moveBy(-4, 3, 4);
      await engaged(editor, 'k3', k3, 'variant-2');
      await d.moveTo(center(k2), 16);
      await wiggle(d, 6);
    } finally {
      await drop(editor, d);
    }
    const want = ['k0', 'k1', 'k3', 'k2', 'k4', 'k5'];
    await expect.poll(async () => styleTernary(await editor.code(CARD), 'k3', 'order')?.branches['variant-2'] ?? null).toBe('2');
    const code = await stableCode(editor, CARD);
    // The swapped pair carries a Mobile-only ternary; the rest stay plain.
    expect(styleTernary(code, 'k3', 'order')).toEqual({ branches: { 'variant-2': '2', default: '3' }, driver: 'initialVariant' });
    expect(styleTernary(code, 'k2', 'order')).toEqual({ branches: { 'variant-2': '3', default: '2' }, driver: 'initialVariant' });
    for (const [i, id] of want.entries()) {
      const t = styleTernary(code, id, 'order');
      expect(t, `${id} has an order`).not.toBeNull();
      const on = (v: string) => t!.branches[v] ?? t!.branches.default;
      expect(on('variant-2'), `${id} Mobile order`).toBe(String(i));
      // The default branch keeps the AUTHORED sequence — the hidden k1 holds slot 1,
      // and k5 stays 5 (not: re-ranked 5 → 1 by a hidden child sorting first).
      expect(t!.branches.default, `${id} default order`).toBe(String(K6.indexOf(id)));
      expect(on('variant-1'), `${id} Tablet order unchanged`).toBe(String(K6.indexOf(id)));
    }
    expect(await editor.childIds('grid', CARD), 'no JSX change').toEqual(K6);
    await expect.poll(() => paintedOrder(editor, K6, 'variant-2')).toEqual(want);
    expect(await paintedOrder(editor, K6, 'desktop')).toEqual(desk0);
    expect(await paintedOrder(editor, K6, 'variant-1')).toEqual(K6);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });
});

// ─── Drag-outs, spans, absolute children ─────────────────────────────

test('DND-192 a `width: 100%` grid child dragged out to the canvas keeps its measured px size; the grid loses it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(gridPage(grid8({ cellExtra: `width: '100%'` })));
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const g1 = await editor.nodeBox('g1');
  const grid = await editor.nodeBox('grid');
  const scale = grid.width / 760;
  const cssW = Math.round(g1.width / scale);
  const root = await editor.nodeBox('root');
  const out = await emptyCanvasPoint(editor, { x: g1.x + g1.width / 2, y: root.y - 120 }, 70);
  const { d } = await pressNode(editor, 'g1');
  try {
    await d.moveBy(5, -4, 4);
    await engaged(editor, 'g1', g1);
    await d.moveTo(out, 30);
    await wiggle(d, 6);
  } finally {
    await drop(editor, d);
  }
  await expect.poll(() => editor.parentOf('g1'), { message: 'g1 left the grid' }).toBeNull();
  const code = await stableCode(editor);
  expect(canvasNodeIds(code)).toEqual(['g1']);
  expect(await editor.childIds('grid')).toEqual(G8.filter(id => id !== 'g1'));
  const s = await editor.style('g1');
  expect(s.width, 'width committed as px').toMatch(/^\d+(\.\d+)?px$/);
  expect(Math.abs(parseFloat(s.width) - cssW), `width ${s.width} ≈ measured ${cssW}px (not 100% re-resolved)`).toBeLessThanOrEqual(2);
  const painted = await editor.nodeBox('g1');
  expect(near(painted.width, g1.width, 3), `painted ${painted.width} ≈ ${g1.width}`).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

/** A 4-column grid: s0 spans 2 columns, p4 is pinned to explicit lines (col 4, row 2). */
const SPAN_GRID = gridPage(`<div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: '100px', gap: '20px', width: '760px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    ${cell('s0', 0, { extra: `gridColumn: 'span 2'` })}
    ${cell('s1', 1)}
    ${cell('s2', 2)}
    ${cell('s3', 3)}
    ${cell('p4', 4, { extra: `gridColumn: '4 / 5', gridRow: '2 / 3'` })}
    ${cell('s5', 5)}
  </div>`);
const S6 = ['s0', 's1', 's2', 's3', 'p4', 's5'];

test('DND-193 reordering a `span 2` grid child keeps its span and the line-pinned child keeps its lines', { tag: ['@p1', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(SPAN_GRID);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const b0 = await boxesOf(editor, S6);
  const m = await mark(page);
  const { d } = await pressNode(editor, 's0');
  try {
    await d.moveBy(5, 4, 4);
    await engaged(editor, 's0', b0.s0!);
    await d.moveTo(center(b0.s1!), 20);
    await wiggle(d, 6);
  } finally {
    await drop(editor, d);
  }
  expect(swapsOf(await since(page, m, '^grid-drag:swap$'))).toEqual(['s1']);
  const want = ['s1', 's0', 's2', 's3', 'p4', 's5'];
  await expect(editor).toHaveJsxOrder('grid', want);
  await stableCode(editor);
  // `order` follows the committed DOM sequence.
  expect(await inlineOrders(editor, S6)).toEqual(Object.fromEntries(want.map((id, i) => [id, String(i)])));
  await expect(editor).toHaveStyle('s0', 'gridColumn', 'span 2');
  await expect(editor).toHaveStyle('p4', 'gridColumn', '4 / 5');
  await expect(editor).toHaveStyle('p4', 'gridRow', '2 / 3');
  for (const id of ['s1', 's2', 's3', 's5']) {
    await expect(editor).toHaveStyle(id, 'gridColumn', null);
    await expect(editor).toHaveStyle(id, 'gridRow', null);
  }
  // Painted: s1 in cell 1, the span child across columns 2–3, p4 still at (col 4, row 2).
  await expect.poll(async () => near((await editor.nodeBox('s1')).x, b0.s0!.x, 2)).toBe(true);
  const s0 = await editor.nodeBox('s0');
  expect(near(s0.width, b0.s0!.width, 2), 'still two columns wide').toBe(true);
  expect(sameBox(await editor.nodeBox('p4'), b0.p4!), 'p4 unmoved').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

const ABS_GRID = gridPage(`<div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: '120px', gap: '20px', width: '760px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
${G8.slice(0, 4).map((id, i) => `    ${cell(id, i)}`).join('\n')}
    <div data-id="abs" data-name="Abs" style={{ position: 'absolute', left: '40px', top: '30px', width: '90px', height: '60px', backgroundColor: '#ffffff', zIndex: '1' }}></div>
  </div>`);

test('DND-194 an absolute child of a grid drags freely inside the grid with pins written, never a cell swap', { tag: ['@p2', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(ABS_GRID);
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const grid = await editor.nodeBox('grid');
  const scale = grid.width / 760;
  const cells0 = await boxesOf(editor, G8.slice(0, 4));
  const m = await mark(page);
  const { d, box } = await pressNode(editor, 'abs');
  try {
    // Across g1's cell: a cell swap would fire here if the grid strategy owned the drag.
    await d.moveBy(120 * scale, 60 * scale, 24);
    await engaged(editor, 'abs', box);
    await wiggle(d, 6);
    expect(await placeholderBoxes(editor), 'no grid placeholder').toHaveLength(0);
  } finally {
    await drop(editor, d);
  }
  const start = await since(page, m, '^drag:start$');
  expect(start.map(e => e.data.strategy)).not.toContain('grid');
  expect(await since(page, m, '^grid-drag:'), 'never a grid drag').toEqual([]);
  await expect.poll(async () => parseFloat((await editor.style('abs')).left ?? 'NaN')).toBeGreaterThan(140);
  const s = await editor.style('abs');
  expect(Math.abs(parseFloat(s.left) - 160), `left ${s.left}`).toBeLessThanOrEqual(4);
  // The vertical pin is written to the nearer edge (dynamic pin): top, or bottom
  // in a 160px-tall grid. Snapping may pull it onto a cell edge (≤ 12px).
  const top = s.top != null ? parseFloat(s.top) : 160 - 60 - parseFloat(s.bottom);
  expect(s.top != null || s.bottom != null, `a vertical pin is written: ${JSON.stringify(s)}`).toBe(true);
  expect(Math.abs(top - 90), `effective top ${top}`).toBeLessThanOrEqual(12);
  expect(s.position).toBe('absolute');
  expect(await editor.parentOf('abs')).toBe('grid');
  expect(await editor.childIds('grid')).toEqual([...G8.slice(0, 4), 'abs']);
  expect(await inlineOrders(editor, G8.slice(0, 4))).toEqual({ g0: '0', g1: '1', g2: '2', g3: '3' });
  const cells1 = await boxesOf(editor, G8.slice(0, 4));
  for (const id of G8.slice(0, 4)) expect(sameBox(cells1[id], cells0[id]), `${id} unmoved`).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── Drops INTO a grid ───────────────────────────────────────────────

const E6 = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
/** A text cell (text never takes children, so the grid itself is the drop target). */
const tcell = (id: string, i: number, extra = '') =>
  `<p data-id="${id}" data-name="${id.toUpperCase()}" style={{ position: 'relative', margin: '0px', height: '100px', backgroundColor: '${['#ff5577', '#ff9977', '#ffcc55', '#99dd55', '#55ddaa', '#55aadd'][i % 6]}', color: '#000000', fontSize: '16px', order: '${i}'${extra ? `, ${extra}` : ''} }}>Cell ${i}</p>`;

/** A 3×2 grid of text cells with a tall top padding, an empty grid, and a canvas floater. */
const INTO_GRID = gridPage(`<div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px', width: '600px', padding: '120px 24px 24px 24px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
${E6.map((id, i) => `    ${tcell(id, i)}`).join('\n')}
  </div>
  <div data-id="egrid" data-name="EmptyGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', width: '600px', height: '180px', position: 'relative', backgroundColor: '#203020', flex: '0 0 auto', order: '1' }}></div>`, {
  canvas: `<div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-260px', top: '80px', width: '100px', height: '60px', backgroundColor: '#ff66cc' }}></div>`,
});

test('DND-187 a canvas node over a grid: left half → before, right half and column gap → after, row gap → lower row, above → 0, empty grid → 0 without a line', { tag: ['@p0', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(INTO_GRID);
  await centerOn(editor, ['floater', 'grid', 'egrid']);
  const before = await editor.code();
  const b = await boxesOf(editor, [...E6, 'grid', 'egrid']);
  const e0 = b.e0!, e1 = b.e1!, e2 = b.e2!, e3 = b.e3!;
  const colGap = e1.x - (e0.x + e0.width);
  const rowGap = e3.y - (e0.y + e0.height);
  const midY = e1.y + e1.height / 2;
  const seen: Record<string, Awaited<ReturnType<typeof dropLineRead>>> = {};
  const outlines: Record<string, string | null> = {};
  const { d, box } = await pressNode(editor, 'floater');
  const visit = async (name: string, p: { x: number; y: number }) => {
    await d.moveTo(p, 16);
    await wiggle(d, 8);
    seen[name] = await dropLineRead(page);
    outlines[name] = (await parentOutline(page))?.parentId ?? null;
  };
  try {
    await d.moveBy(10, 0, 3);
    await engaged(editor, 'floater', box);
    await visit('leftHalf', { x: e1.x + e1.width * 0.25, y: midY });
    await visit('rightHalf', { x: e1.x + e1.width * 0.75, y: midY });
    await visit('colGap', { x: e1.x + e1.width + colGap / 2, y: midY });
    await visit('rowGap', { x: e1.x + e1.width / 2, y: e1.y + e1.height + rowGap / 2 });
    await visit('above', { x: e1.x + e1.width / 2, y: b.grid!.y + (e1.y - b.grid!.y) / 2 });
    await visit('empty', center(b.egrid!));
    // Release in the column gap between e1 and e2.
    await visit('drop', { x: e1.x + e1.width + colGap / 2, y: midY });
  } finally {
    await drop(editor, d);
  }
  // Left half of e1 → BEFORE e1: a vertical line at e1's left (in the gap before it).
  expect(seen.leftHalf, 'a line over the left half').not.toBeNull();
  expect(seen.leftHalf).toMatchObject({ parentId: 'grid', insertIndex: 1, orientation: 'vertical' });
  expect(seen.leftHalf!.rect.x).toBeGreaterThanOrEqual(e0.x + e0.width - 2);
  expect(seen.leftHalf!.rect.x).toBeLessThanOrEqual(e1.x + 2);
  // Right half of e1, and the column gap → AFTER e1: the line in the e1|e2 gap.
  for (const k of ['rightHalf', 'colGap']) {
    expect(seen[k], k).toMatchObject({ parentId: 'grid', insertIndex: 2, orientation: 'vertical' });
    expect(seen[k]!.rect.x, k).toBeGreaterThanOrEqual(e1.x + e1.width - 2);
    expect(seen[k]!.rect.x, k).toBeLessThanOrEqual(e2.x + 2);
  }
  // Row gap → a horizontal line between the rows; insert at the lower row's first child.
  expect(seen.rowGap).toMatchObject({ parentId: 'grid', insertIndex: 3, orientation: 'horizontal' });
  expect(seen.rowGap!.rect.y).toBeGreaterThanOrEqual(e0.y + e0.height - 2);
  expect(seen.rowGap!.rect.y).toBeLessThanOrEqual(e3.y + 2);
  expect(near(seen.rowGap!.rect.width, b.grid!.width, 4), 'spans the grid').toBe(true);
  // Above the first row → index 0 (the line stands at the first cell's leading edge).
  expect(seen.above).toMatchObject({ parentId: 'grid', insertIndex: 0 });
  expect(near(seen.above!.rect.x, e0.x, 3), `line at e0's left (${seen.above!.rect.x} vs ${e0.x})`).toBe(true);
  // Empty grid → no line at all; the grid itself is outlined as the target.
  expect(seen.empty, 'no line over an empty grid').toBeNull();
  expect(outlines.empty).toBe('egrid');
  for (const k of ['leftHalf', 'rightHalf', 'colGap', 'rowGap', 'above']) expect(outlines[k], k).toBe('grid');

  // The drop lands after e1 (index 2): JSX insert + the grid sequence renumbered.
  await expect.poll(() => editor.parentOf('floater')).toBe('grid');
  await expect(editor).toHaveJsxOrder('grid', ['e0', 'e1', 'floater', 'e2', 'e3', 'e4', 'e5']);
  await expect.poll(() => inlineOrders(editor, [...E6, 'floater'])).toEqual({ e0: '0', e1: '1', floater: '2', e2: '3', e3: '4', e4: '5', e5: '6' });
  await stableCode(editor);
  expect((await paintedOrder(editor, ['e0', 'e1', 'floater', 'e2', 'e3', 'e4', 'e5']))).toEqual(['e0', 'e1', 'floater', 'e2', 'e3', 'e4', 'e5']);
  await expect(editor).toUndoInOneStep(before);
});

/** The same 3×2 text grid rotated 40° (transform), and a canvas floater. */
const ROTATED_GRID = gridPage(`<div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: '100px', gap: '40px', width: '600px', padding: '24px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0', transform: 'rotate(40deg)' }}>
${E6.map((id, i) => `    ${tcell(id, i)}`).join('\n')}
  </div>`, {
  rootExtra: `alignItems: 'center', justifyContent: 'center'`,
  canvas: `<div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-260px', top: '80px', width: '60px', height: '40px', backgroundColor: '#ff66cc' }}></div>`,
});

test('DND-195 a canvas node into a 40°-rotated grid\'s row gap: picked in the grid\'s local frame, the line drawn rotated with it', { tag: ['@p2', '@dnd'] }, async ({ editor, page }) => {
  await editor.load(ROTATED_GRID);
  await centerOn(editor, ['floater', 'grid']);
  const before = await editor.code();
  // The grid's layout box is 600 × (24+100+40+100+24 = 288) css px, rotated about its centre.
  const aabb = await editor.nodeBox('grid');
  const c = center(aabb);
  const th = (40 * Math.PI) / 180;
  const scale = aabb.width / (600 * Math.cos(th) + 288 * Math.sin(th));
  const toScreen = (lx: number, ly: number) => {
    const x = (lx - 300) * scale, y = (ly - 144) * scale;
    return { x: c.x + x * Math.cos(th) - y * Math.sin(th), y: c.y + x * Math.sin(th) + y * Math.cos(th) };
  };
  // Row gap (local y 24+100+20 = 144 = the centre line), under the middle column.
  const rowGapPt = toScreen(300, 144);
  let line: Awaited<ReturnType<typeof dropLineRead>> = null;
  const { d, box } = await pressNode(editor, 'floater');
  try {
    await d.moveBy(10, 0, 3);
    await engaged(editor, 'floater', box);
    await d.moveTo(rowGapPt, 30);
    await wiggle(d, 10);
    line = await dropLineRead(page);
  } finally {
    await drop(editor, d);
  }
  expect(line, 'a drop line in the row gap').not.toBeNull();
  expect(line).toMatchObject({ parentId: 'grid', insertIndex: 3 });
  // Drawn along the grid's rotated row axis (not an axis-aligned screen line).
  expect(line!.angle, 'a rotated line').not.toBeNull();
  const a = ((line!.angle! % 180) + 180) % 180;
  expect(Math.abs(a - 40), `line angle ${line!.angle}`).toBeLessThanOrEqual(2);
  // The drop: the floater lands at the lower row's first slot.
  await expect.poll(() => editor.parentOf('floater')).toBe('grid');
  await expect(editor).toHaveJsxOrder('grid', ['e0', 'e1', 'e2', 'floater', 'e3', 'e4', 'e5']);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-269 ─────────────────────────────────────────────────────────

const PC = ['pc0', 'pc1', 'pc2', 'pc3'];
const FLEX_GRID = seed(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '40px', width: '900px', minHeight: '520px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="pg" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '30px', width: '520px', padding: '24px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
${PC.map((id, i) => `    ${tcell(id, i, i === 2 ? `gridColumn: 'span 1', gridRow: 'span 1'` : '')}`).join('\n')}
  </div>
</div>`, canvas: `
  <div data-id="fcol" data-name="FlexCol" data-canvas-node="true" style={{ position: 'absolute', left: '-460px', top: '0px', display: 'flex', flexDirection: 'column', gap: '20px', width: '300px', height: '420px', padding: '20px', backgroundColor: '#203040' }}>
    <p data-id="f0" data-name="F0" style={{ position: 'relative', flex: '0 0 auto', margin: '0px', width: '200px', height: '80px', backgroundColor: '#ff66cc', color: '#000000', order: '0' }}>F0</p>
    <p data-id="f1" data-name="F1" style={{ position: 'relative', flex: '0 0 auto', margin: '0px', width: '200px', height: '80px', backgroundColor: '#66ccff', color: '#000000', order: '1' }}>F1</p>
    <p data-id="f2" data-name="F2" style={{ position: 'relative', flex: '0 0 auto', margin: '0px', width: '200px', height: '80px', backgroundColor: '#ccff66', color: '#000000', order: '2' }}>F2</p>
  </div>
  <div data-id="frow" data-name="FlexRow" data-canvas-node="true" style={{ position: 'absolute', left: '-460px', top: '480px', display: 'flex', flexDirection: 'row', gap: '30px', width: '600px', height: '160px', padding: '20px', backgroundColor: '#402030' }}>
    <p data-id="r0" data-name="R0" style={{ position: 'relative', flex: '0 0 auto', margin: '0px', width: '150px', height: '100px', backgroundColor: '#ffaa33', color: '#000000', order: '0' }}>R0</p>
    <p data-id="r1" data-name="R1" style={{ position: 'relative', flex: '0 0 auto', margin: '0px', width: '150px', height: '100px', backgroundColor: '#33ffaa', color: '#000000', order: '1' }}>R1</p>
  </div>` }));

test('DND-269 flex child → grid slot, then grid cell → flex row: each lands with its new parent\'s placement, old parents keep their sequence, one undo each', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX_GRID);
  await centerOn(editor, ['fcol', 'frow', 'pg']);
  const before = await editor.code();

  // 1. f1 (flex column child) → between pc0 and pc1 in the grid.
  {
    const pc0 = await editor.nodeBox('pc0');
    const pc1 = await editor.nodeBox('pc1');
    const target = { x: (pc0.x + pc0.width + pc1.x) / 2, y: pc0.y + pc0.height / 2 };
    const { d, box } = await pressNode(editor, 'f1');
    try {
      await d.moveBy(6, 0, 3);
      await engaged(editor, 'f1', box);
      await d.moveTo(target, 50);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('f1')).toBe('pg');
  await expect(editor).toHaveJsxOrder('pg', ['pc0', 'f1', 'pc1', 'pc2', 'pc3']);
  const afterFirst = await stableCode(editor);
  expect(await inlineOrders(editor, ['pc0', 'f1', 'pc1', 'pc2', 'pc3']), 'order set in the grid sequence').toEqual({ pc0: '0', f1: '1', pc1: '2', pc2: '3', pc3: '4' });
  const f1 = await editor.style('f1');
  // ROW-ADJUSTED: the grid entry injects no flex of its own; the child keeps the
  // `flex` it already declared (inert on a grid item), it is not cleared.
  expect(f1.flex ?? null, 'the declared flex is kept as authored, nothing injected').toBe('0 0 auto');
  expect(f1.position).toBe('relative');
  expect([f1.left ?? null, f1.top ?? null]).toEqual([null, null]);
  // ROW-ADJUSTED: the flex column keeps its remaining children's orders (the
  // exit restores them; a gap is left, the painted sequence is unchanged).
  await expect(editor).toHaveJsxOrder('fcol', ['f0', 'f2']);
  expect(await inlineOrders(editor, ['f0', 'f2'])).toEqual({ f0: '0', f2: '2' });
  expect(await paintedOrder(editor, ['f0', 'f2'])).toEqual(['f0', 'f2']);
  await expect(editor).toUndoInOneStep(before);
  await editor.page().waitForTimeout(450);

  // 2. pc2 (a grid cell with grid placement) → between r0 and r1 in the flex row.
  {
    const r0 = await editor.nodeBox('r0');
    const r1 = await editor.nodeBox('r1');
    const target = { x: (r0.x + r0.width + r1.x) / 2, y: r0.y + r0.height / 2 };
    const { d, box } = await pressNode(editor, 'pc2');
    try {
      await d.moveBy(-6, 0, 3);
      await engaged(editor, 'pc2', box);
      await d.moveTo(target, 50);
      await wiggle(d, 10);
    } finally {
      await drop(editor, d);
    }
  }
  await expect.poll(() => editor.parentOf('pc2')).toBe('frow');
  await expect(editor).toHaveJsxOrder('frow', ['r0', 'pc2', 'r1']);
  await stableCode(editor);
  const pc2 = await editor.style('pc2');
  expect(pc2.position).toBe('relative');
  expect(pc2.flex).toBe('0 0 auto');
  expect([pc2.gridColumn ?? null, pc2.gridRow ?? null, pc2.gridArea ?? null], 'no stale grid placement').toEqual([null, null, null]);
  expect(await inlineOrders(editor, ['r0', 'pc2', 'r1'])).toEqual({ r0: '0', pc2: '1', r1: '2' });
  // The grid likewise keeps its remaining orders (pc3 stays 4), sequence unchanged.
  await expect(editor).toHaveJsxOrder('pg', ['pc0', 'f1', 'pc1', 'pc3']);
  expect(await inlineOrders(editor, ['pc0', 'f1', 'pc1', 'pc3'])).toEqual({ pc0: '0', f1: '1', pc1: '2', pc3: '4' });
  expect(await paintedOrder(editor, ['pc0', 'f1', 'pc1', 'pc3'])).toEqual(['pc0', 'f1', 'pc1', 'pc3']);
  await expect(editor).toUndoInOneStep(afterFirst);
});
