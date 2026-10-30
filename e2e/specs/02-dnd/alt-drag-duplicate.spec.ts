// DND · Alt-drag duplicate (E2E_TEST_PLAN.md §2, batch D5, DND-138..148):
// the ghost committed live on Alt keydown (DragCoordinator.applyAltDuplicateState),
// removed on Alt release, kept on mouseup; flow duplicates as real siblings,
// replica/variant duplicates solo on their tile with the tile's values baked in.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import { ABSOLUTE_IN_FRAME, centerOn } from '../../helpers/d3';
import { pressMidDrag, type CanvasDrag } from '../../helpers/d4';
import { placeholders } from '../../helpers/d1';
import { prime, visualOrderIn, displayIn, boxIn } from '../../helpers/d6';
import { openMaster, variantEntry, prime as primeAt } from '../../helpers/c5';
import {
  FLEX_COLUMN, GRID_8, TABLET_ABS, BORDERED, TABLET_INSTANCE, CLONE_MASTER,
  pressNode, drop, engaged, dupIds, stableCode, pollFor, boxOf, inlineOrdersOf, mark, since, near, center, parses,
  type Box,
} from '../../helpers/d5';

test.describe.configure({ timeout: 180_000 });

const CARD = 'components/Card.tsx';

/** Alt down mid-drag, then wait until the ghost is in the source. */
async function altOn(editor: Editor, d: CanvasDrag, want = 1, path?: string): Promise<string[]> {
  await pressMidDrag(d, 'Alt', true);
  return pollFor(editor.page(), async () => dupIds(await editor.code(path)), ids => ids.length === want, 3_000);
}

async function altOff(editor: Editor, d: CanvasDrag, want = 0): Promise<string[]> {
  await pressMidDrag(d, 'Alt', false);
  return pollFor(editor.page(), async () => dupIds(await editor.code()), ids => ids.length === want, 3_000);
}

const sameBox = (a: Box | null, b: Box, tol = 2) => !!a && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.width, b.width, tol) && near(a.height, b.height, tol);

/** Put the source back to the seed (the replica-solo duplicate's inline
 *  `display: 'none'` trips DISPLAY_TOGGLE_VISIBILITY, reported under DND-155). */
async function backToSeed(editor: Editor, before: string, path?: string): Promise<void> {
  await editor.undo();
  await expect.poll(() => editor.code(path)).toBe(before);
}

// ─── DND-138 ──────────────────────────────────────────────────────────

test('DND-138 Alt pressed mid-drag: duplicate at the drag-start spot at once, original lands at the drop, one undo removes both', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  await centerOn(editor, ['abs-child']);
  const before = await editor.code();
  const style0 = await editor.style('abs-child');
  const { d, box: b0 } = await pressNode(editor, 'abs-child');
  let dup = '';
  try {
    await d.moveBy(60, 6, 12);
    await engaged(editor, 'abs-child', b0);
    // The moment Alt goes down — no further pointer move — the copy is in the
    // source at the original left/top and paints exactly where the drag began.
    const ids = await altOn(editor, d);
    expect(ids, 'one duplicate on Alt keydown').toHaveLength(1);
    dup = ids[0];
    expect(await editor.parentOf(dup)).toBe('hero');
    const ds = await editor.style(dup);
    expect([ds.left, ds.top]).toEqual([style0.left, style0.top]);
    await expect.poll(() => boxOf(editor, dup).then(b => sameBox(b, b0)), { message: 'duplicate painted at the start box', timeout: 3_000 }).toBe(true);
    await d.moveBy(40, 4, 8);
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt');
  }
  await stableCode(editor);

  // Kept on mouseup (Alt still held): the copy stays put, the original moved.
  expect(dupIds(await editor.code())).toEqual([dup]);
  const ds = await editor.style(dup);
  expect([ds.left, ds.top]).toEqual([style0.left, style0.top]);
  const s1 = await editor.style('abs-child');
  expect(s1.left, 'the original commits its new left').not.toBe(style0.left);
  const b1 = (await editor.nodeBox('abs-child'));
  expect(b1.x - b0.x, 'the original paints at the drop').toBeGreaterThan(80);
  expect(sameBox(await boxOf(editor, dup), b0), 'the duplicate still paints at the start').toBe(true);
  // One undo removes both the duplicate and the move.
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-139 ──────────────────────────────────────────────────────────

test('DND-139 Alt released before mouseup: the duplicate is removed, only the move commits', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  await centerOn(editor, ['abs-child']);
  const before = await editor.code();
  const style0 = await editor.style('abs-child');
  const { d, box: b0 } = await pressNode(editor, 'abs-child');
  try {
    await d.moveBy(60, 6, 12);
    await engaged(editor, 'abs-child', b0);
    const ids = await altOn(editor, d);
    expect(ids).toHaveLength(1);
    await expect.poll(() => boxOf(editor, ids[0]).then(b => !!b), { timeout: 3_000 }).toBe(true);
    // Alt up with the button still down: the ghost leaves the source and the canvas.
    expect(await altOff(editor, d), 'duplicate removed on Alt release').toEqual([]);
    await expect.poll(() => boxOf(editor, ids[0]), { timeout: 3_000 }).toBeNull();
    await d.moveBy(40, 4, 8);
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt').catch(() => {});
  }
  const code = await stableCode(editor);
  expect(dupIds(code), 'no duplicate committed').toEqual([]);
  await expect(editor).toHaveJsxOrder('hero', ['abs-child']);
  expect((await editor.style('abs-child')).left).not.toBe(style0.left);
  expect((await editor.nodeBox('abs-child')).x - b0.x).toBeGreaterThan(80);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-140 ──────────────────────────────────────────────────────────

test('DND-140 flex column Alt-drag: the duplicate is a real sibling at the original slot, orders stay sequential, the marker is cleared', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX_COLUMN);
  const page = editor.page();
  await centerOn(editor, ['hero', 'features', 'how']);
  const before = await editor.code();
  const { d, box: f0 } = await pressNode(editor, 'features');
  let dup = '';
  try {
    await d.moveBy(0, 30, 6);
    await engaged(editor, 'features', f0);
    const ids = await altOn(editor, d);
    expect(ids).toHaveLength(1);
    dup = ids[0];
    // A real flex sibling inserted at features' source index, flagged while live.
    await expect(editor).toHaveJsxOrder('root', ['hero', dup, 'features', 'how']);
    expect(await editor.attr(dup, 'data-alt-duplicate')).toBe('true');
    await expect.poll(() => boxOf(editor, dup).then(b => sameBox(b, f0, 3)), { message: 'duplicate holds the original slot', timeout: 3_000 }).toBe(true);
    expect(await placeholders(editor), 'one placeholder hole').toHaveLength(1);
    // The placeholder moves around the duplicate: below how.
    const how = await editor.nodeBox('how');
    await d.moveTo({ x: how.x + how.width / 2, y: how.y + how.height * 0.85 }, 12);
    await d.hold(8);
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    const howNow = await editor.nodeBox('how');
    expect(near(holes[0].y, howNow.y + howNow.height, 3), `hole after how (${holes[0].y} vs ${howNow.y + howNow.height})`).toBe(true);
    expect(sameBox(await boxOf(editor, dup), f0, 3), 'the duplicate never moved').toBe(true);
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt');
  }
  await stableCode(editor);

  await expect(editor).toHaveJsxOrder('root', ['hero', dup, 'features', 'how']);
  const ord = await inlineOrdersOf(editor, ['hero', dup, 'features', 'how']);
  expect(ord).toEqual({ hero: '0', [dup]: '1', how: '2', features: '3' });
  expect(Object.values(ord).every(v => Number(v) < 10), 'never a spaced rank like 40').toBe(true);
  expect(await editor.attr(dup, 'data-alt-duplicate'), 'marker cleared after drop').toBeNull();
  expect(await visualOrderIn(editor, 'desktop', ['hero', dup, 'features', 'how'])).toEqual(['hero', dup, 'how', 'features']);
  expect(await placeholders(editor)).toHaveLength(0);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-141 ──────────────────────────────────────────────────────────

test('DND-141 Alt held before the press: the duplicate shows on the first drag frame', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  await centerOn(editor, ['abs-child']);
  const before = await editor.code();
  const b0 = await editor.nodeBox('abs-child');
  const from = center(b0);
  const m = await mark(page);
  await page.mouse.move(from.x, from.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  let dup = '';
  try {
    // Creep past the threshold one 2px step at a time; stop on the frame the drag starts.
    let started = false;
    for (let i = 1; i <= 12 && !started; i++) {
      await page.mouse.move(from.x + 2 * i, from.y);
      started = (await since(page, m, '^drag:start$')).length > 0;
    }
    expect(started, 'the drag started').toBe(true);
    // Already there on that first frame: reconciled from the pointer's altKey,
    // not from a keydown (there was none after the press).
    const ids = dupIds(await editor.code());
    expect(ids, 'duplicate in the source on the first drag frame').toHaveLength(1);
    dup = ids[0];
    const seq = (await since(page, m, '^drag:(start|move-result|alt-duplicate-ghost-show)$')).map(e => e.c);
    expect(seq.indexOf('drag:alt-duplicate-ghost-show'), `ghost before any move result: ${seq.slice(0, 4).join(',')}`).toBe(1);
    await expect.poll(() => boxOf(editor, dup).then(b => sameBox(b, b0)), { timeout: 3_000 }).toBe(true);
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + 24 + 8 * i, from.y + 1);
  } finally {
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await editor.settled();
  }
  await stableCode(editor);
  expect(dupIds(await editor.code())).toEqual([dup]);
  expect(sameBox(await boxOf(editor, dup), b0)).toBe(true);
  expect((await editor.nodeBox('abs-child')).x - b0.x).toBeGreaterThan(60);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-142 ──────────────────────────────────────────────────────────

test('DND-142 Alt toggled on and off three times, ending on: exactly one duplicate', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  await centerOn(editor, ['abs-child']);
  const before = await editor.code();
  const { d, box: b0 } = await pressNode(editor, 'abs-child');
  const counts: number[] = [];
  try {
    await d.moveBy(30, 4, 8);
    await engaged(editor, 'abs-child', b0);
    for (let i = 0; i < 3; i++) {
      counts.push((await altOn(editor, d, 1)).length);
      await d.moveBy(12, 0, 3);
      if (i < 2) {
        counts.push((await altOff(editor, d, 0)).length);
        await d.moveBy(12, 0, 3);
      }
    }
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt');
  }
  expect(counts, 'one ghost while Alt is down, none while up').toEqual([1, 0, 1, 0, 1]);
  const code = await stableCode(editor);
  const ids = dupIds(code);
  expect(ids, 'no stacked copies').toHaveLength(1);
  expect(await editor.childIds('hero')).toEqual(['abs-child', ids[0]]);
  expect(sameBox(await boxOf(editor, ids[0]), b0)).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-143 ──────────────────────────────────────────────────────────

test('DND-143 order-stamped grid Alt-drag: the duplicate stays at the grab slot, the original lands where released', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: GridDragStrategy has no getAltDuplicateInsertSpec, so a grid duplicate takes the ABSOLUTE branch — appended last with left/top 0px (oracle POSITION_OFFSET_REQUIRES_ABSOLUTE) and the order commit shifts the cells: the duplicate paints one cell off and the original lands after the release slot');
  await editor.load(GRID_8);
  const page = editor.page();
  await centerOn(editor, ['grid']);
  const before = await editor.code();
  const cells = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
  const { d, box: g10 } = await pressNode(editor, 'g1');
  let dup = '';
  try {
    await d.moveBy(10, 10, 4);
    await engaged(editor, 'g1', g10);
    dup = (await altOn(editor, d))[0];
    const g6 = await editor.nodeBox('g6');
    await d.moveTo(center(g6), 14);
    await d.hold(10);
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt');
  }
  await stableCode(editor);
  const all = [...cells, dup];
  const order = await visualOrderIn(editor, 'desktop', all);
  // Grab slot = index 1; the release slot was g6's = index 6.
  expect(order.indexOf(dup), `duplicate at the grab slot: ${order.join(',')}`).toBe(1);
  expect(order.indexOf('g1'), `original at the release slot: ${order.join(',')}`).toBe(6);
  const ds = await editor.style(dup);
  expect([ds.left ?? null, ds.top ?? null], 'a grid cell carries no offsets').toEqual([null, null]);
  const ord = Object.values(await inlineOrdersOf(editor, all));
  expect(new Set(ord).size, `distinct orders: ${ord.join(',')}`).toBe(ord.length);
  await expect(editor).toUndoInOneStep(before);
});

// ─── Tiles ────────────────────────────────────────────────────────────

test.describe('on tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-144 Alt-drag on the Tablet tile: the duplicate exists on Tablet only, re-shown with its original display', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_ABS, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    // Prime and press on the chip's body: its centre is the dot, its edges are
    // resize handles at this zoom.
    await primeAt(editor, 'chip', 'tablet', 0.25, 0.5);
    expect(await editor.selection()).toEqual(['chip']);
    const { d, box: c0 } = await pressNode(editor, 'chip', { vpId: 'tablet', fx: 0.25, fy: 0.5 });
    let dup = '';
    try {
      await d.moveBy(8, 8, 4);
      await engaged(editor, 'chip', c0, 'tablet');
      // The chip and its dot are cloned together (chip clone first in source).
      dup = (await altOn(editor, d, 2))[0];
      expect(dup).toBeTruthy();
      await d.moveBy(10, 8, 5);
    } finally {
      await drop(editor, d);
      await page.keyboard.up('Alt');
    }
    await stableCode(editor);
    const ids = dupIds(await editor.code());
    expect(ids).toHaveLength(2);
    expect(await editor.parentOf(dup)).toBe('stage');
    const dotDup = ids.find(id => id !== dup)!;
    expect(await editor.parentOf(dotDup), 'the dot is cloned inside the chip clone').toBe(dup);
    // Source: hidden at base, re-shown on Tablet with the ORIGINAL display, hidden on Mobile.
    expect((await editor.style(dup)).display).toBe('none');
    await expect(editor).toHaveBandStyle(768, dup, 'display', 'flex', { important: true });
    await expect(editor).toHaveBandStyle(375, dup, 'display', 'none', { important: true });
    // Tiles: painted on Tablet only.
    await expect.poll(() => displayIn(editor, 'tablet', dup)).toBe('flex');
    expect(await boxIn(editor, 'tablet', dup)).not.toBeNull();
    expect(await displayIn(editor, 'desktop', dup)).toBe('none');
    expect(await displayIn(editor, 'mobile', dup)).toBe('none');
    // The original keeps its base position on the other tiles.
    expect((await editor.style('chip')).left).toBe('30px');
    await expect(editor).toUndoInOneStep(before);
    await backToSeed(editor, before);
  });

  test('DND-145 Alt-drag a 100%-wide button on variant-2: the duplicate bakes the painted variant-2 values and stays 100% wide', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(CLONE_MASTER);
    await openMaster(editor, CARD, 'variant-2');
    const page = editor.page();
    const before = await editor.code(CARD);
    await prime(editor, 'btn', 'variant-2');
    const { d, box: b0 } = await pressNode(editor, 'btn', { vpId: 'variant-2' });
    let dup = '';
    try {
      await d.moveBy(0, 8, 4);
      await engaged(editor, 'btn', b0, 'variant-2');
      dup = (await altOn(editor, d, 1, CARD))[0];
      expect(dup, 'a duplicate on Alt').toBeTruthy();
      await d.moveBy(0, b0.height * 1.2, 8);
      await d.hold(6);
    } finally {
      await drop(editor, d);
      await page.keyboard.up('Alt');
    }
    const code = await stableCode(editor, CARD);
    expect(dupIds(code)).toEqual([dup]);
    expect(parses(code)).toBe(true);
    // Baked: a flat 100% base width (not the primary's empty/auto), 20px type.
    const st = await editor.style(dup, CARD);
    expect(st.width, 'base width baked from the tile').toBe('100%');
    const entry = variantEntry(code, dup, 'variant-2') ?? {};
    expect(st.fontSize === '20px' || entry.fontSize === '20px', `variant-2 fontSize baked (${st.fontSize}/${entry.fontSize})`).toBe(true);
    // Painted: as wide as the original on variant-2; absent from the other variants.
    await expect.poll(async () => {
      const a = await boxIn(editor, 'variant-2', 'btn');
      const b = await boxIn(editor, 'variant-2', dup);
      return !!a && !!b && Math.abs(a.width - b.width) < 2;
    }, { message: 'the duplicate paints full width on variant-2' }).toBe(true);
    for (const vp of ['desktop', 'variant-1']) {
      const disp = await displayIn(editor, vp, dup);
      expect(disp === '' || disp === 'none', `hidden on ${vp} (${disp})`).toBe(true);
    }
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });

  test('DND-148 Alt-drag an instance with a flex master root on Tablet: the duplicate\'s Tablet band restores flex, never unset', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_INSTANCE, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    await prime(editor, 'pill', 'tablet');
    expect(await editor.selection()).toEqual(['pill']);
    const { d, box: p0 } = await pressNode(editor, 'pill', { vpId: 'tablet', fx: 0.85, fy: 0.5 });
    let dup = '';
    try {
      await d.moveBy(8, 8, 4);
      await engaged(editor, 'pill', p0, 'tablet');
      dup = (await altOn(editor, d))[0];
      expect(dup).toBeTruthy();
      await d.moveBy(8, 6, 4);
    } finally {
      await drop(editor, d);
      await page.keyboard.up('Alt');
    }
    await stableCode(editor);
    expect(dupIds(await editor.code())).toEqual([dup]);
    expect(await editor.parentOf(dup)).toBe('stage');
    expect((await editor.style(dup)).display).toBe('none');
    const tablet = await editor.bandStyle(768, dup, 'display');
    expect(tablet, 'tablet band restores the master root display').toEqual({ value: 'flex', important: true });
    expect(tablet?.value).not.toBe('unset');
    await expect(editor).toHaveBandStyle(375, dup, 'display', 'none', { important: true });
    await expect.poll(() => boxIn(editor, 'tablet', dup).then(b => !!b && b.width > 0), { message: 'painted on Tablet' }).toBe(true);
    expect(await boxIn(editor, 'desktop', dup)).toBeNull();
    expect(await boxIn(editor, 'mobile', dup)).toBeNull();
    await expect(editor).toUndoInOneStep(before);
    await backToSeed(editor, before);
  });
});

// ─── DND-146 ──────────────────────────────────────────────────────────

/** The `::after` rule body for `id` in the file's style block (null when none). */
function afterRule(code: string, id: string): string | null {
  const esc = id.replace(/[-]/g, '\\-');
  const m = new RegExp(`\\[data-id="${esc}"\\]::after\\s*\\{([^}]*)\\}`).exec(code);
  return m ? m[1] : null;
}

async function afterBorder(editor: Editor, id: string): Promise<{ width: string; color: string }> {
  return editor.sandbox().locator(`[data-id="${id}"]`).first().evaluate((el) => {
    const cs = getComputedStyle(el, '::after');
    return { width: cs.borderTopWidth, color: cs.borderTopColor };
  });
}

test('DND-146 Alt-drag a frame whose subtree has ::after borders: every clone gets its own border rule and shows it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(BORDERED);
  const page = editor.page();
  await centerOn(editor, ['card']);
  const before = await editor.code();
  const { d, box: c0 } = await pressNode(editor, 'card', { fx: 0.85, fy: 0.85 });
  try {
    await d.moveBy(20, 10, 6);
    await engaged(editor, 'card', c0);
    expect(await altOn(editor, d, 2), 'card + kid cloned').toHaveLength(2);
    await d.moveBy(160, 0, 12);
  } finally {
    await drop(editor, d);
    await page.keyboard.up('Alt');
  }
  const code = await stableCode(editor);
  const dups = dupIds(code);
  expect(dups).toHaveLength(2);
  const src = await editor.source();
  const dupCard = dups.find(id => src.byId.get(id)?.parentId === 'root')!;
  const dupKid = dups.find(id => src.byId.get(id)?.parentId === dupCard)!;
  expect(dupCard && dupKid, 'clone tree card > kid').toBeTruthy();
  // Source: each clone carries its own copy of its source's rule.
  const cardRule = afterRule(code, dupCard);
  const kidRule = afterRule(code, dupKid);
  expect(cardRule, 'card clone has a rule').toContain('border-width: 6px');
  expect(cardRule).toContain('border-color: #ff0000');
  expect(kidRule, 'kid clone has a rule').toContain('border-width: 4px');
  expect(kidRule).toContain('border-color: #00ff00');
  // The originals keep theirs.
  expect(afterRule(code, 'card')).toContain('6px');
  expect(afterRule(code, 'card-kid')).toContain('4px');
  // Canvas: the duplicate shows its borders.
  await expect.poll(() => afterBorder(editor, dupCard)).toEqual({ width: '6px', color: 'rgb(255, 0, 0)' });
  await expect.poll(() => afterBorder(editor, dupKid)).toEqual({ width: '4px', color: 'rgb(0, 255, 0)' });
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-147 ──────────────────────────────────────────────────────────

test('DND-147 three Alt-drags in a row: each duplicate renders when made and after its drop', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_FRAME);
  const page = editor.page();
  await centerOn(editor, ['hero']);
  const made: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const { d, box: b0 } = await pressNode(editor, 'abs-child');
    try {
      await d.moveBy(40, 4, 8);
      await engaged(editor, 'abs-child', b0);
      const ids = await altOn(editor, d, i);
      expect(ids, `drag ${i}: ${i} duplicates`).toHaveLength(i);
      const fresh = ids.find(id => !made.includes(id))!;
      made.push(fresh);
      // Painted the moment it is made (not on some later render).
      await expect.poll(() => boxOf(editor, fresh).then(b => sameBox(b, b0)), { message: `drag ${i}: duplicate painted at once`, timeout: 2_000 }).toBe(true);
      await d.moveBy(40, 0, 8);
    } finally {
      await drop(editor, d);
      await page.keyboard.up('Alt');
    }
    await stableCode(editor);
    for (const id of made) {
      await expect.poll(() => boxOf(editor, id).then(b => !!b), { message: `after drop ${i}: ${id} painted`, timeout: 2_000 }).toBe(true);
    }
    await page.waitForTimeout(450);
  }
  expect(dupIds(await editor.code())).toHaveLength(3);
  await expect(editor).toHaveNoDuplicateIds();
});
