// DND · Flow reorder in flex row, column and wrap (E2E_TEST_PLAN.md §2).

import { test, expect, project } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  DragSession, drag, assertEngaged, dropLine, placeholders, painted, visualOrder, orders, selectionOverlay,
  frame, traceMark, tracesSince, type Box,
  loadSeed, survivesReloads,
} from '../../helpers/d1';

// The shared dev server runs on a loaded machine: give each gesture-heavy test room.
test.describe.configure({ timeout: 180_000 });

const FLEX_COLUMN = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '300px', background: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '300px', background: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '300px', background: '#2a2a4a' }}></div>
</div>`).build();

const FLEX_COLUMN_GAP = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', background: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', background: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '200px', background: '#2a2a4a' }}></div>
</div>`).build();

const FLEX_ROW = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'row', gap: '0px', width: '1440px', minHeight: '500px', background: '#0d0d1a' }}>
  <div data-id="col-a" data-name="ColA" style={{ width: '480px', height: '500px', background: '#1a3a1a' }}></div>
  <div data-id="col-b" data-name="ColB" style={{ width: '480px', height: '500px', background: '#3a1a1a' }}></div>
  <div data-id="col-c" data-name="ColC" style={{ width: '480px', height: '500px', background: '#1a1a3a' }}></div>
</div>`).build();

// JSX order how, hero, features; painted order hero, features, how.
const REORDERED_FLEX_COLUMN = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <div data-id="how" data-name="HowItWorks" style={{ height: '300px', background: '#2a2a4a', order: '2' }}></div>
  <div data-id="hero" data-name="Hero" style={{ height: '300px', background: '#1a1a3a', order: '0' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '300px', background: '#f5f5f7', order: '1' }}></div>
</div>`).build();

// A zero-size invisible flow sibling (Figma-import shape) and a bordered footer.
const GHOST_SIBLING_COLUMN = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '1300px', background: '#0d0d1a' }}>
  <div data-id="nav" data-name="Nav" style={{ height: '200px', background: '#1a1a3a', order: '0' }}></div>
  <div data-id="ghost" data-name="EmptyFrame" style={{ width: 'auto', height: 'auto', order: '1' }}></div>
  <div data-id="hero" data-name="Hero" style={{ height: '300px', background: '#f5f5f7', order: '2' }}></div>
  <div data-id="footer" data-name="Footer" style={{ height: '300px', background: '#ffffff', border: '0', order: '3' }}></div>
  <div data-id="cta" data-name="CTA" style={{ height: '300px', background: '#3a1a1a', order: '4' }}></div>
</div>`).build();

const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;

test('DND-001 reorder a flex column child above the first one', { tag: ['@p0', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_COLUMN);
  const before = await editor.code();
  const featuresStart = await editor.nodeBox('features');

  await editor.duringDrag('features', await editor.at('hero', 0.5, 0.05), async () => {
    // The lifted node leaves a hole: a placeholder of its size holds the slot,
    // so the siblings don't collapse into it mid-drag.
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    expect(near(holes[0].height, featuresStart.height, 2)).toBe(true);
    const how = await editor.nodeBox('how');
    expect(how.y).toBeGreaterThanOrEqual(featuresStart.y + featuresStart.height - 2);
  });

  // Reorder writes `order`, never moves the JSX.
  await expect(editor).toHaveJsxOrder('root', ['hero', 'features', 'how']);
  await expect(editor).toHaveStyle('features', 'order', '0');
  await expect(editor).toHaveStyle('hero', 'order', '1');
  await expect(editor).toHaveStyle('how', 'order', '2');
  expect(await editor.getRootChildrenVisualOrder()).toEqual(['features', 'hero', 'how']);
  expect(await placeholders(editor)).toHaveLength(0);
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-002 row reorder: drop on the left half of the first column', { tag: ['@p0', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_ROW);
  const before = await editor.code();
  const root = await editor.nodeBox('root');
  const colC = await editor.nodeBox('col-c');

  await editor.duringDrag('col-c', await editor.at('col-a', 0.25, 0.5), async () => {
    // Same-parent flow reorder: the placeholder IS the indicator (no drop line).
    // It holds slot 0, before col-a, at the row's leading edge.
    expect(await dropLine(editor.page())).toBeNull();
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    expect(near(holes[0].x, root.x, 3)).toBe(true);
    expect(near(holes[0].width, colC.width, 2)).toBe(true);
    const colA = await editor.nodeBox('col-a');
    expect(near(colA.x, holes[0].x + holes[0].width, 3)).toBe(true);
  }, { steps: 24 });

  await expect(editor).toHaveStyle('col-c', 'order', '0');
  await expect(editor).toHaveStyle('col-a', 'order', '1');
  await expect(editor).toHaveStyle('col-b', 'order', '2');
  await expect(editor).toHaveJsxOrder('root', ['col-a', 'col-b', 'col-c']);
  expect(await visualOrder(editor, 'root')).toEqual(['col-c', 'col-a', 'col-b']);
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-003 reorder uses visual order on a CSS-ordered column, twice', { tag: ['@p0', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, REORDERED_FLEX_COLUMN);
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'features', 'how']);

  // 1st reorder: how above hero. The slot follows the PAINTED order: the
  // hole opens at the top of the column, not at how's JSX slot (first).
  const root = await editor.nodeBox('root');
  await editor.duringDrag('how', await editor.at('hero', 0.5, 0.05), async () => {
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    expect(near(holes[0].y, root.y, 3)).toBe(true);
    expect(near((await editor.nodeBox('hero')).y, holes[0].y + holes[0].height, 3)).toBe(true);
  });
  await expect(editor).toHaveStyle('how', 'order', '0');
  await expect(editor).toHaveStyle('hero', 'order', '1');
  await expect(editor).toHaveStyle('features', 'order', '2');
  expect(await visualOrder(editor, 'root')).toEqual(['how', 'hero', 'features']);
  await expect(editor).toHaveJsxOrder('root', ['how', 'hero', 'features']);

  // 2nd reorder: features into hero's upper half = slot 1 (between how and
  // hero). The hole must hold slot 1 (not one slot off, not the JSX slot)
  // and the drop must land exactly there.
  const before2 = await editor.code();
  const how = await editor.nodeBox('how');
  const hero = await editor.nodeBox('hero');
  await editor.duringDrag('features', { x: hero.x + hero.width / 2, y: hero.y + hero.height * 0.3 }, async () => {
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    expect(near(holes[0].y, how.y + how.height, 3)).toBe(true);
    expect(near((await editor.nodeBox('hero')).y, holes[0].y + holes[0].height, 3)).toBe(true);
    expect(near((await editor.nodeBox('how')).y, how.y, 1)).toBe(true);
  });
  await expect(editor).toHaveStyle('how', 'order', '0');
  await expect(editor).toHaveStyle('features', 'order', '1');
  await expect(editor).toHaveStyle('hero', 'order', '2');
  expect(await visualOrder(editor, 'root')).toEqual(['how', 'features', 'hero']);
  await expect(editor).toUndoInOneStep(before2);
}));

test('DND-004 lift keeps siblings still and commits sequential orders', { tag: ['@p0', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_COLUMN);
  const hero0 = await editor.nodeBox('hero');
  const how0 = await editor.nodeBox('how');

  await drag(editor, 'features', async (s, start) => {
    // Lift: a short move engages the drag but crosses no boundary.
    await s.moveTo({ x: s.start.x + 10, y: s.start.y + 10 }, 6);
    await s.pump(6, { axis: 'x' });
    await assertEngaged(editor, 'features', start);
    // Siblings did not shift at lift: the spaced ranks (0/10/20) are imperative only.
    const hero1 = await editor.nodeBox('hero');
    const how1 = await editor.nodeBox('how');
    expect(near(hero1.y, hero0.y, 1) && near(how1.y, how0.y, 1)).toBe(true);
    expect((await editor.code()).match(/order: '\d+'/g) ?? []).toEqual([]);
    // Past one boundary (into hero's upper half)…
    const holeOffset = async (y: number) => Math.abs(((await placeholders(editor))[0]?.y ?? 1e9) - y);
    await s.moveTo({ x: s.start.x, y: hero0.y + hero0.height * 0.2 }, 12);
    await s.pump(6, { axis: 'x' });
    await expect.poll(() => holeOffset(hero0.y)).toBeLessThan(3);
    // …and back to the start slot.
    await s.moveTo({ x: s.start.x, y: s.start.y }, 12);
    await s.pump(6, { axis: 'x' });
    await expect.poll(() => holeOffset(hero0.y + hero0.height)).toBeLessThan(3);
  });

  // Same sequence; whatever got committed is sequential 0..N, never spaced.
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'features', 'how']);
  const written = (await editor.code()).match(/\border: '(\d+)'/g) ?? [];
  for (const w of written) expect(Number(w.match(/\d+/)![0])).toBeLessThanOrEqual(2);
  const o = await orders(editor, ['hero', 'features', 'how']);
  if (written.length) expect(o).toEqual({ hero: 0, features: 1, how: 2 });
}));

test('DND-005 drag into a 40px gap: the hole opens in that gap, commits at index 1', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_COLUMN_GAP);
  const before = await editor.code();
  const page = editor.page();
  const hero = await editor.nodeBox('hero');
  const features = await editor.nodeBox('features');
  const gapMid = (hero.y + hero.height + features.y) / 2;
  const since = await traceMark(page);

  await editor.duringDrag('how', { x: hero.x + hero.width / 2, y: gapMid }, async () => {
    // Same-parent reorder shows the placeholder, not a drop line.
    expect(await dropLine(page)).toBeNull();
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    // The hole sits in the slot index 1 names, one 40px gap after hero and
    // one before features; the gap itself is kept on both sides.
    const h = await editor.nodeBox('hero');
    const f = await editor.nodeBox('features');
    expect(near(holes[0].y - (h.y + h.height), f.y - (holes[0].y + holes[0].height), 2)).toBe(true);
    expect(holes[0].y).toBeGreaterThan(h.y + h.height + 2);
    // The strategy's own index agrees with the painted slot.
    const reorders = await tracesSince(page, since, '^layout-lifted:reorder$');
    expect(reorders.at(-1)?.data?.newIndex).toBe(1);
  }, { steps: 20 });

  await expect(editor).toHaveStyle('hero', 'order', '0');
  await expect(editor).toHaveStyle('how', 'order', '1');
  await expect(editor).toHaveStyle('features', 'order', '2');
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'how', 'features']);
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-006 end-drop past a zero-size ghost sibling keeps the bordered footer intact', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, GHOST_SIBLING_COLUMN);
  const before = await editor.code();
  const painted4 = async () => (await visualOrder(editor, 'root')).filter(id => id !== 'ghost');
  expect(await painted4()).toEqual(['nav', 'hero', 'footer', 'cta']);

  await editor.dragNodeAsserted('footer', await editor.at('cta', 0.5, 0.95), { steps: 16, releaseDelayMs: 100 });

  // Not reverted to the start slot: footer is last.
  await expect.poll(painted4).toEqual(['nav', 'hero', 'cta', 'footer']);
  const s = await editor.style('footer');
  // `order` is its own key and the bare `border` value is untouched.
  expect(s.border).toBe('0');
  const o = await orders(editor, ['nav', 'hero', 'cta', 'footer']);
  expect(o.footer).toBeGreaterThan(o.cta);
  expect(o.cta).toBeGreaterThan(o.hero);
  // Exactly the two keys — no `order` value spliced into `border` or vice versa.
  expect(Object.keys(s).filter(k => /order/i.test(k)).sort()).toEqual(['border', 'order']);
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-007 release over its own placeholder is a no-op, overlay fades in at the slot', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_COLUMN);
  const start = await editor.nodeBox('features');
  const boxes0 = { hero: await editor.nodeBox('hero'), how: await editor.nodeBox('how') };
  const page = editor.page();

  const samples: Array<{ opacity: number; rect: Box | null }> = [];
  await drag(editor, 'features', async (s) => {
    await s.moveTo({ x: s.start.x + 30, y: s.start.y + 30 }, 10);
    await s.pump(6, { axis: 'x' });
    await assertEngaged(editor, 'features', start);
    await s.release();
    // Sample the selection overlay every frame after the drop.
    for (let i = 0; i < 40; i++) {
      const o = await selectionOverlay(page);
      if (o) samples.push(o);
      await frame(page);
    }
  });

  // Canvas unchanged.
  const end = await editor.nodeBox('features');
  expect(near(end.x, start.x, 1) && near(end.y, start.y, 1)).toBe(true);
  expect(near((await editor.nodeBox('hero')).y, boxes0.hero.y, 1)).toBe(true);
  expect(near((await editor.nodeBox('how')).y, boxes0.how.y, 1)).toBe(true);
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'features', 'how']);
  const o = await orders(editor, ['hero', 'features', 'how']);
  if (!Number.isNaN(o.features)) expect(o).toEqual({ hero: 0, features: 1, how: 2 });

  // The overlay comes back at the slot; a visible frame never sits at the lifted spot.
  expect(samples.length).toBeGreaterThan(0);
  const visible = samples.filter(sm => sm.opacity > 0.05 && sm.rect);
  expect(visible.length).toBeGreaterThan(0);
  for (const v of visible) {
    expect(near(v.rect!.x, start.x, 3) && near(v.rect!.y, start.y, 3)).toBe(true);
  }
  expect(await editor.selection()).toEqual(['features']);
}));

// ─── Wrap, grip, lift fidelity ──────────────────────────────────────────

const chips = Array.from({ length: 8 }, (_, i) => `    <div data-id="chip-${i + 1}" data-name="Chip${i + 1}" style={{ width: '200px', height: '120px', background: '#${(0x334455 + i * 0x101010).toString(16)}', flex: '0 0 auto' }}></div>`).join('\n');
const FLEX_WRAP = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <div data-id="chips" data-name="Chips" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '20px', width: '860px', background: '#202030', flex: '0 0 auto' }}>
${chips}
  </div>
</div>`).build();

test('DND-008 flex-wrap: a chip from line 2 lands in the middle of line 1', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  // The 2D hit picks the sibling with the NEAREST CENTRE even while the cursor
  // is still over the dragged chip's own hole: with chips wider than the line
  // pitch that is the chip directly ABOVE on line 1, so the hole jumps to
  // line 1 and back on alternate frames the moment the drag lifts
  // (trace: layout-lifted:reorder-check newIndex 2 ↔ 5 at the start spot).
  test.fail(true, 'BUG: flex-wrap lift reshuffles: cursor over its own hole picks the nearest-centre chip on the line above (LayoutLiftedStrategy.calculateReorderIndex 2D branch)');
  await loadSeed(editor, FLEX_WRAP);
  const before = await editor.code();
  const ids = Array.from({ length: 8 }, (_, i) => `chip-${i + 1}`);
  const start: Record<string, Box> = {};
  for (const id of ids) start[id] = await editor.nodeBox(id);
  // Two lines of four.
  expect(near(start['chip-5'].y, start['chip-1'].y + start['chip-1'].height, 20)).toBe(true);

  await drag(editor, 'chip-6', async (s, box) => {
    await s.moveTo({ x: s.start.x + 6, y: s.start.y + 6 }, 4);
    await s.pump(6, { axis: 'y' });
    await assertEngaged(editor, 'chip-6', box);
    // No reshuffle at lift: every other chip is still where it was.
    for (const id of ids.filter(i => i !== 'chip-6')) {
      const b = await editor.nodeBox(id);
      expect(near(b.x, start[id].x, 1) && near(b.y, start[id].y, 1), `${id} moved at lift`).toBe(true);
    }
    // Cursor onto chip-2's right half (moving right): the 2D hit picks LINE 1.
    const c2 = start['chip-2'];
    await s.moveTo({ x: c2.x + c2.width * 0.75, y: c2.y + c2.height / 2 }, 16);
    await s.pump(8, { axis: 'y' });
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    // The hole opened on line 1, right after chip-2.
    expect(near(holes[0].y, start['chip-1'].y, 3)).toBe(true);
    expect(holes[0].x).toBeGreaterThan(c2.x + c2.width - 2);
  });

  const want = ['chip-1', 'chip-2', 'chip-6', 'chip-3', 'chip-4', 'chip-5', 'chip-7', 'chip-8'];
  for (const [i, id] of want.entries()) await expect(editor).toHaveStyle(id, 'order', String(i));
  expect(await visualOrder(editor, 'chips')).toEqual(want);
  await expect(editor).toHaveJsxOrder('chips', ids);
  await expect(editor).toUndoInOneStep(before);
}));

const GRIP = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '60px', width: '1440px', minHeight: '1000px', padding: '80px', background: '#0d0d1a' }}>
  <div data-id="stack" data-name="Stack" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '600px', padding: '20px', background: '#202030', flex: '0 0 auto' }}>
    <div data-id="s-1" data-name="S1" style={{ width: '100%', height: '100px', background: '#3355ff', flex: '0 0 auto' }}></div>
    <div data-id="s-2" data-name="S2" style={{ width: '100%', height: '100px', background: '#ffcc33', flex: '0 0 auto' }}></div>
    <div data-id="s-3" data-name="S3" style={{ width: '100%', height: '100px', background: '#33cc88', flex: '0 0 auto' }}></div>
  </div>
  <div data-id="row" data-name="Row" style={{ display: 'flex', flexDirection: 'row', gap: '16px', width: '760px', padding: '20px', background: '#302020', flex: '0 0 auto' }}>
    <div data-id="r-1" data-name="R1" style={{ width: '200px', height: '120px', background: '#ff5577', flex: '0 0 auto' }}></div>
    <div data-id="r-2" data-name="R2" style={{ width: '200px', height: '120px', background: '#55ffaa', flex: '0 0 auto' }}></div>
    <div data-id="r-3" data-name="R3" style={{ width: '200px', height: '120px', background: '#aa55ff', flex: '0 0 auto' }}></div>
  </div>
</div>`).build();

/** The grip handle (no accessible name: a 24px accent circle with cursor:grab)
 *  — left of a column child, below a row child, 32px out. */
async function gripAt(editor: Editor, expected: { x: number; y: number }) {
  const grip = editor.page().locator('[data-selection-fade] div[style*="cursor: grab"]');
  await expect(grip).toHaveCount(1);
  const b = (await grip.boundingBox())!;
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  expect(near(c.x, expected.x, 3) && near(c.y, expected.y, 3), `grip at ${JSON.stringify(c)}, expected ${JSON.stringify(expected)}`).toBe(true);
  return c;
}

test('DND-009 grip drag is axis-locked and clamped inside the parent', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, GRIP);
  const page = editor.page();

  // Column child: grip on the left, motion locked to Y.
  await editor.click('s-2');
  await page.waitForTimeout(400);
  const s2 = await editor.nodeBox('s-2');
  const stack = await editor.nodeBox('stack');
  const g1 = await gripAt(editor, { x: s2.x - 32, y: s2.y + s2.height / 2 });
  let since = await traceMark(page);
  let s = await DragSession.press(page, g1);
  try {
    // Far past the parent's top-left corner, out onto the canvas.
    await s.moveTo({ x: stack.x - 250, y: stack.y - 220 }, 20);
    await s.pump(8, { axis: 'x' });
    const lifted = await editor.nodeBox('s-2');
    expect(near(lifted.x, s2.x, 2), 'x stays locked').toBe(true);
    expect(lifted.y).toBeGreaterThanOrEqual(stack.y - 2);
    expect(lifted.y + lifted.height).toBeLessThanOrEqual(stack.y + stack.height + 2);
    expect(await placeholders(editor)).toHaveLength(1);
  } finally {
    await s.release();
  }
  await editor.settled();
  let t = await tracesSince(page, since, '^(drag:start|drag:strategy-switch|layout-lifted:exit-parent)$');
  expect(t.find(e => e.c === 'drag:start')?.data?.strategy).toBe('layout-lifted');
  expect(t.filter(e => e.c !== 'drag:start')).toEqual([]);
  await expect(editor).toHaveStyle('s-2', 'order', '0');
  await expect(editor).toHaveStyle('s-1', 'order', '1');
  await expect(editor).toHaveStyle('s-3', 'order', '2');
  expect(await editor.parentOf('s-2')).toBe('stack');
  expect(await editor.style('s-2')).not.toHaveProperty('left');

  // Row child: grip below, motion locked to X.
  await page.waitForTimeout(400);
  await editor.click('r-1');
  await page.waitForTimeout(400);
  const before = await editor.code();
  const r1 = await editor.nodeBox('r-1');
  const row = await editor.nodeBox('row');
  const g2 = await gripAt(editor, { x: r1.x + r1.width / 2, y: r1.y + r1.height + 32 });
  since = await traceMark(page);
  s = await DragSession.press(page, g2);
  try {
    await s.moveTo({ x: row.x + row.width + 300, y: row.y + row.height + 200 }, 20);
    await s.pump(8, { axis: 'y' });
    const lifted = await editor.nodeBox('r-1');
    expect(near(lifted.y, r1.y, 2), 'y stays locked').toBe(true);
    expect(lifted.x + lifted.width).toBeLessThanOrEqual(row.x + row.width + 2);
  } finally {
    await s.release();
  }
  await editor.settled();
  t = await tracesSince(page, since, '^(drag:start|drag:strategy-switch|layout-lifted:exit-parent)$');
  expect(t.find(e => e.c === 'drag:start')?.data?.strategy).toBe('layout-lifted');
  expect(t.filter(e => e.c !== 'drag:start')).toEqual([]);
  await expect(editor).toHaveStyle('r-2', 'order', '0');
  await expect(editor).toHaveStyle('r-3', 'order', '1');
  await expect(editor).toHaveStyle('r-1', 'order', '2');
  expect(await visualOrder(editor, 'row')).toEqual(['r-2', 'r-3', 'r-1']);
  await expect(editor).toUndoInOneStep(before);
}));

const PERCENT_ICONS = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '80px', background: '#0d0d1a' }}>
  <div data-id="icons" data-name="Icons" style={{ display: 'flex', flexDirection: 'row', gap: '24px', padding: '24px', width: '600px', background: '#202030', flex: '0 0 auto' }}>
    <div data-id="icon-a" data-name="IconA" style={{ width: '96px', height: '96px', maxWidth: '100%', background: '#ff5577', borderRadius: '12px', flex: '0 0 auto' }}></div>
    <div data-id="icon-b" data-name="IconB" style={{ width: '96px', height: '96px', maxWidth: '100%', background: '#55ffaa', borderRadius: '12px', flex: '0 0 auto' }}></div>
    <div data-id="icon-c" data-name="IconC" style={{ width: '96px', height: '96px', maxWidth: '100%', background: '#aa55ff', borderRadius: '12px', flex: '0 0 auto' }}></div>
  </div>
</div>`).build();

test('DND-010 percent max-width icon stays visible while lifted, restored on drop', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, PERCENT_ICONS);
  const before = await editor.code();
  const a0 = await editor.nodeBox('icon-a');

  await editor.duringDrag('icon-a', await editor.at('icon-c', 0.8, 0.5), async () => {
    // Lifted copy at its painted size, not collapsed to 0 by `max-width: 100%`
    // resolving against a zero-size containing block.
    const lifted = await editor.nodeBox('icon-a');
    expect(near(lifted.width, a0.width, 2) && near(lifted.height, a0.height, 2)).toBe(true);
    await expect(editor.node('icon-a')).toBeVisible();
  }, { steps: 16 });

  await expect(editor).toHaveStyle('icon-a', 'order', '2');
  expect(await visualOrder(editor, 'icons')).toEqual(['icon-b', 'icon-c', 'icon-a']);
  // Constraint restored: in source, and painted again.
  expect((await editor.style('icon-a')).maxWidth).toBe('100%');
  expect(await painted(editor, 'icon-a', 'maxWidth')).toBe('100%');
  const a1 = await editor.nodeBox('icon-a');
  expect(near(a1.width, a0.width, 1)).toBe(true);
  await expect(editor).toUndoInOneStep(before);
}));

// A design component whose ROOT height is a variant ternary placed AFTER the
// instance-style spread: the renderer resolves it inline (418px) and the
// node model has no `height` entry for it.
const PROMO_MASTER = `'use client';

/** @name "Promo" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'compact', label: 'Compact', x: 600, y: 0 },
];

function Promo({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const { width: __instW, height: __instH, ...__instStyle } = style ?? {};
  return <LayoutGroup>
    <motion.div layout={true} data-id="promo-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Promo" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '400px', padding: '24px', backgroundColor: '#97cffc', borderRadius: '12px', ...__instStyle, height: initialVariant === 'compact' ? '245px' : '418px' }}>
      <motion.p layout={true} data-id="promo-text" data-name="Text" style={{ fontSize: '24px', color: '#000000', position: 'relative' }}>Promo</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Promo);
`;
const INSTANCE_IN_FLEX = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '1440px', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ width: '100%', height: '200px', background: '#1a1a3a', position: 'relative', flex: '0 0 auto' }}></div>
  <Promo data-id="promo" data-name="Promo" style={{ position: 'relative', flex: '0 0 auto' }} />
  <div data-id="after" data-name="After" style={{ width: '100%', height: '120px', background: '#2a2a4a', position: 'relative', flex: '0 0 auto' }}></div>
</div>`, { imports: [`import Promo from '@/components/Promo';`] }).component('Promo', PROMO_MASTER).build();

test('DND-011 instance with a variant-ternary root height keeps its painted height across drags', { tag: ['@p1', '@dnd', '@cmp'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, INSTANCE_IN_FLEX);
  const master0 = await editor.code('components/Promo.tsx');
  const h0 = (await editor.nodeBox('promo')).height;
  expect(await painted(editor, 'promo', 'height')).toBe('418px');

  // Layout-drag the instance above hero.
  await editor.dragNodeAsserted('promo', await editor.at('hero', 0.5, 0.1), { steps: 16 });
  await expect(editor).toHaveStyle('promo', 'order', '0');
  await expect.poll(() => painted(editor, 'promo', 'height')).toBe('418px');
  expect(near((await editor.nodeBox('promo')).height, h0, 1)).toBe(true);

  // An unrelated drag afterwards: its commit render must not stale-clear the
  // restored height (the 418 → 245px collapse that only a page switch healed).
  await editor.settled();
  await editor.page().waitForTimeout(300);
  const before = await editor.code();
  await editor.dragNodeAsserted('after', await editor.at('hero', 0.5, 0.1), { steps: 16 });
  await expect(editor).toHaveStyle('after', 'order', '1');
  await editor.settled();
  await expect.poll(() => painted(editor, 'promo', 'height')).toBe('418px');
  expect(near((await editor.nodeBox('promo')).height, h0, 1)).toBe(true);
  expect(await visualOrder(editor, 'root')).toEqual(['promo', 'after', 'hero']);
  // The master is untouched and no height leaked onto the instance.
  expect(await editor.code('components/Promo.tsx')).toBe(master0);
  expect(await editor.style('promo')).not.toHaveProperty('height');
  await expect(editor).toUndoInOneStep(before);
}));

const CANVAS_NODE_WITH_GAP = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '60px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', background: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', background: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '200px', background: '#2a2a4a' }}></div>
</div>`).build();
CANVAS_NODE_WITH_GAP.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '120px', height: '120px', background: '#ff66cc' }}></div>
</>);
`;

test('DND-012 a node just dropped into a flex parent re-drags as a layout child', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, CANVAS_NODE_WITH_GAP);
  const page = editor.page();
  const hero = await editor.nodeBox('hero');
  const features = await editor.nodeBox('features');
  await editor.dragNodeAsserted('floater', { x: hero.x + hero.width / 2, y: (hero.y + hero.height + features.y) / 2 }, { steps: 18 });
  await expect.poll(() => editor.parentOf('floater')).toBe('root');
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'floater', 'features', 'how']);

  // Immediately again: above hero.
  const before = await editor.code();
  const since = await traceMark(page);
  await editor.duringDrag('floater', await editor.at('hero', 0.5, 0.1), async () => {
    expect(await placeholders(editor)).toHaveLength(1);
  }, { steps: 14 });
  const starts = await tracesSince(page, since, '^drag:start$');
  expect(starts.map(e => e.data.strategy)).toEqual(['layout-lifted']);

  await expect(editor).toHaveStyle('floater', 'order', '0');
  await expect(editor).toHaveStyle('hero', 'order', '1');
  const s = await editor.style('floater');
  // Not the absolute path: no canvas inset pinned on a flow child.
  expect(s.position ?? 'relative').toBe('relative');
  expect(s).not.toHaveProperty('left');
  expect(s).not.toHaveProperty('top');
  expect(await editor.parentOf('floater')).toBe('root');
  await expect(editor.node('floater')).toBeVisible();
  expect(await visualOrder(editor, 'root')).toEqual(['floater', 'hero', 'features', 'how']);
  await expect(editor).toUndoInOneStep(before);
}));

const OVERLAY_PAGE = project().pageSource(`/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
export default function Page() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '1440px', minHeight: '900px', padding: '60px', background: '#ffffff' }}>
      <div data-id="trigger" data-name="Trigger" data-overlay-trigger='{"trigger":"click"}' onClick={() => setMenuOpen(!menuOpen)} style={{ width: '240px', height: '80px', background: '#a8c8f9', borderRadius: '8px', flex: '0 0 auto' }}></div>
      <div data-id="body" data-name="Body" style={{ width: '100%', height: '400px', background: '#f0f0f0', flex: '0 0 auto' }}></div>
      <AnimatePresence>{menuOpen && (
        <motion.div key="menu" data-id="menu" data-name="Menu" data-overlay='{"type":"relative","triggerId":"trigger","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '360px', height: '260px', backgroundColor: '#1a1a3a', borderRadius: '8px' }}>
          <p data-id="menu-title" data-name="Title" style={{ position: 'absolute', left: '24px', top: '24px', margin: '0px', fontSize: '28px', color: '#ffffff' }}>Menu title</p>
          <p data-id="menu-body" data-name="Text" style={{ position: 'absolute', left: '24px', top: '120px', margin: '0px', fontSize: '18px', color: '#cccccc' }}>Menu body text</p>
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
`).build();

test('DND-013 overlay just given a flex Layout reorders its text child, no left/top', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, OVERLAY_PAGE);
  const page = editor.page();
  // Setup: overlay edit mode with the overlay selected, then the real
  // "Add Layout" button in the Layout section.
  await page.evaluate(() => (window as any).__e2e.openOverlay('menu'));
  await expect(await editor.nodeIn('desktop', 'menu-title')).toBeVisible();
  await editor.select(['menu']);
  await editor.settled();
  const addLayout = page.getByTitle('Add Layout');
  await expect(addLayout).toBeVisible();
  await page.waitForTimeout(500); // the panel re-mounts once after the selection lands
  await addLayout.click();
  await expect(editor).toHaveStyle('menu', 'display', 'flex');
  await editor.settled();
  const dir = (await editor.style('menu')).flexDirection ?? 'row';
  await expect(editor).toHaveStyle('menu-body', 'left', null);
  const before = await editor.code();
  const since = await traceMark(page);

  // Drag the second text before the first, along the new flex axis.
  const target = dir === 'column' ? await editor.at('menu-title', 0.5, 0.1) : await editor.at('menu-title', 0.1, 0.5);
  await editor.duringDrag('menu-body', target, async () => {
    // Authored flex wins over the stale computed `block`: the lifted
    // reorder (placeholder), not the absolute in-frame drag.
    expect(await placeholders(editor)).toHaveLength(1);
  }, { steps: 14 });

  const starts = await tracesSince(page, since, '^drag:start$');
  expect(starts.map(e => e.data.strategy)).toEqual(['layout-lifted']);
  await expect(editor).toHaveStyle('menu-body', 'order', '0');
  await expect(editor).toHaveStyle('menu-title', 'order', '1');
  const s = await editor.style('menu-body');
  expect(s).not.toHaveProperty('left');
  expect(s).not.toHaveProperty('top');
  expect(s.position).not.toBe('absolute');
  expect(await visualOrder(editor, 'menu')).toEqual(['menu-body', 'menu-title']);
  await expect(editor).toUndoInOneStep(before);
}));

// The viewport and its root are 900px tall; four 300px sections overflow
// below the fold (the imported-page shape).
const FIXED_HEIGHT_ROOT = project().pageSource(`/** @canvas { "viewports": [{"id":"desktop","width":1440,"height":900}] } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', height: '900px', background: '#0d0d1a' }}>
      <div data-id="s1" data-name="S1" style={{ height: '300px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
      <div data-id="s2" data-name="S2" style={{ height: '300px', background: '#f5f5f7', flex: '0 0 auto' }}></div>
      <div data-id="s3" data-name="S3" style={{ height: '300px', background: '#2a2a4a', flex: '0 0 auto' }}></div>
      <div data-id="s4" data-name="S4" style={{ height: '300px', background: '#4a2a2a', flex: '0 0 auto' }}></div>
    </div>
  );
}
`).build();

test('DND-014 a section below a fixed-height root reorders to the top', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  // The content-bounds union skips the DRAGGED node (so a section can leave
  // the page) but never adds its placeholder back: when the dragged section
  // is the only one below the root's fixed height, the very first move is
  // "off the page" → exit-parent → exit-to-canvas-on-new-parent (s3) →
  // canvas strategy, and the drop rewrites it as a JSX move with
  // `position: relative` + `width: 1440px` baked on.
  test.fail(true, 'BUG: last section below a fixed-height root exits to canvas at lift (getViewportScreenRect excludes the dragged node and never unions its placeholder)');
  await loadSeed(editor, FIXED_HEIGHT_ROOT);
  const page = editor.page();
  const root = await editor.nodeBox('root');
  const s4 = await editor.nodeBox('s4');
  expect(s4.y).toBeGreaterThanOrEqual(root.y + root.height - 2); // entirely below the fold
  const before = await editor.code();
  const since = await traceMark(page);

  await editor.duringDrag('s4', await editor.at('s1', 0.5, 0.1), async () => {
    // The placeholder stays: still over the page (content union), no exit.
    expect(await placeholders(editor)).toHaveLength(1);
  }, { steps: 20 });

  const t = await tracesSince(page, since, '^(drag:start|drag:strategy-switch|layout-lifted:exit-parent)$');
  expect(t.map(e => e.c)).toEqual(['drag:start']);
  expect(t[0].data.strategy).toBe('layout-lifted');
  await expect(editor).toHaveStyle('s4', 'order', '0');
  await expect(editor).toHaveStyle('s1', 'order', '1');
  await expect(editor).toHaveStyle('s3', 'order', '3');
  await expect(editor).toHaveJsxOrder('root', ['s1', 's2', 's3', 's4']);
  const s4Style = await editor.style('s4');
  expect(s4Style).not.toHaveProperty('width');
  expect(s4Style).not.toHaveProperty('position');
  expect(await editor.attr('s4', 'data-canvas-node')).toBeNull();
  expect(await visualOrder(editor, 'root')).toEqual(['s4', 's1', 's2', 's3']);
  await expect(editor).toUndoInOneStep(before);
}));

// Root sections + a HIDDEN overlay child of root (display:none outside
// overlay mode, so its cached rect is a zero-size sliver at the origin).
const ROOT_WITH_HIDDEN_OVERLAY = project().pageSource(`/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */
'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
export default function Page() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
      <div data-id="sec-a" data-name="A" data-overlay-trigger='{"trigger":"click"}' onClick={() => setMenuOpen(!menuOpen)} style={{ height: '300px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
      <div data-id="sec-b" data-name="B" style={{ height: '300px', background: '#f5f5f7', flex: '0 0 auto' }}></div>
      <div data-id="sec-c" data-name="C" style={{ height: '300px', background: '#2a2a4a', flex: '0 0 auto' }}></div>
      <AnimatePresence>{menuOpen && (
        <motion.div key="menu" data-id="menu" data-name="Menu" data-overlay='{"type":"relative","triggerId":"sec-a","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '360px', height: '260px', backgroundColor: '#7CBFFF' }}>
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
`).build();

test('DND-015 a root section exits to canvas off the right edge and off the left edge', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, ROOT_WITH_HIDDEN_OVERLAY);
  const page = editor.page();
  const root = await editor.nodeBox('root');
  const b = await editor.nodeBox('sec-b');
  const before = await editor.code();

  for (const side of ['right', 'left'] as const) {
    const since = await traceMark(page);
    const x = side === 'right' ? root.x + root.width + 160 : root.x - 160;
    expect(x).toBeGreaterThan(20);
    await drag(editor, 'sec-b', async (s, start) => {
      await s.moveTo({ x, y: b.y + b.height / 2 }, 24);
      await s.pump(8);
      await assertEngaged(editor, 'sec-b', start);
      // Off the page on this side: exit fired, the hole is gone.
      await expect.poll(async () => (await tracesSince(page, since, '^layout-lifted:exit-parent$')).length, { message: `exit off the ${side}` }).toBeGreaterThan(0);
      expect(await placeholders(editor)).toHaveLength(0);
    });
    // Dropped on the canvas: a canvas node, out of root.
    await expect.poll(() => editor.attr('sec-b', 'data-canvas-node'), { message: side }).toBe('true');
    expect(await editor.childIds('root')).not.toContain('sec-b');
    const cx = (await editor.nodeBox('sec-b')).x + (await editor.nodeBox('sec-b')).width / 2;
    expect(side === 'right' ? cx > root.x + root.width : cx < root.x).toBe(true);
    await expect(editor).toUndoInOneStep(before);
    await editor.undo();
    await expect.poll(() => editor.code()).toBe(before);
  }
}));

const STYLE_LED_ROOT = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <style>{\`
@media (max-width: 768px) {
  [data-id="intro"] { padding: 4px !important; }
}
\`}</style>
  <div data-id="intro" data-name="Intro" style={{ height: '200px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
  <div data-id="capabilities" data-name="Capabilities" style={{ height: '200px', background: '#f5f5f7', flex: '0 0 auto' }}></div>
  <div data-id="pricing" data-name="Pricing" style={{ height: '200px', background: '#2a2a4a', flex: '0 0 auto' }}></div>
</div>`).build();
STYLE_LED_ROOT.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="extra" data-name="Extra" data-canvas-node="true" style={{ position: 'absolute', left: '-420px', top: '120px', width: '300px', height: '120px', background: '#ff66cc' }}></div>
</>);
`;

test('DND-016 a leading <style> child never counts as a slot', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, STYLE_LED_ROOT);
  const page = editor.page();
  const before = await editor.code();
  const cap = await editor.nodeBox('capabilities');
  const pricing = await editor.nodeBox('pricing');
  const dropAt = { x: cap.x + cap.width / 2, y: (cap.y + cap.height + pricing.y) / 2 };

  await editor.duringDrag('extra', dropAt, async () => {
    // Line below Capabilities = index 2 in painted-slot space.
    const line = await dropLine(page);
    expect(line).toMatchObject({ parentId: 'root', insertIndex: 2, orientation: 'horizontal' });
    const c = await editor.nodeBox('capabilities');
    expect(line!.rect.y).toBeGreaterThanOrEqual(c.y + c.height - 2);
  }, { steps: 20, pumpFrames: 12 });

  // Landed where the line showed: after capabilities, not above it.
  await expect(editor).toHaveJsxOrder('root', ['intro', 'capabilities', 'extra', 'pricing']);
  expect(await visualOrder(editor, 'root')).toEqual(['intro', 'capabilities', 'extra', 'pricing']);
  const code = await editor.code();
  // The <style> block is still the root's first child.
  expect(code.indexOf('<style>')).toBeLessThan(code.indexOf('data-id="intro"'));
  expect(code.indexOf('<style>')).toBeGreaterThan(code.indexOf('data-id="root"'));
  await expect(editor).toUndoInOneStep(before);
}));

// ─── Margins, out-of-flow siblings, nesting, multi-select ───────────────

// Overlapping pills pulled left by a negative margin LONGHAND (`marginLeft`).
const NEGATIVE_MARGIN_ROW = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '700px', background: '#0d0d1a', padding: '40px' }}>
  <div data-id="strip" data-name="Strip" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', width: '100%', height: '400px', position: 'relative', background: '#a8d4ff', flex: '0 0 auto', order: '0' }}>
    <div data-id="pill-a" data-name="PillA" style={{ width: '200px', height: '400px', background: '#ffe0c2', borderRadius: '218px', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="pill-b" data-name="PillB" style={{ width: '200px', height: '400px', background: '#8a5a1e', borderRadius: '218px', position: 'relative', flex: '0 0 auto', marginLeft: '-70px', order: '1' }}></div>
    <div data-id="pill-c" data-name="PillC" style={{ width: '200px', height: '400px', background: '#323543', borderRadius: '218px', position: 'relative', flex: '0 0 auto', marginLeft: '-70px', order: '2' }}></div>
    <div data-id="pill-d" data-name="PillD" style={{ width: '200px', height: '400px', background: '#ffb3bd', borderRadius: '218px', position: 'relative', flex: '0 0 auto', order: '3' }}></div>
  </div>
</div>`).build();

test('DND-017 negative-margin pills: no jump at lift, margins kept on reorder and in-place drop', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, NEGATIVE_MARGIN_ROW);
  expect(await painted(editor, 'pill-c', 'marginLeft')).toBe('-70px');

  // In-place drop first (pure lift/restore bookkeeping).
  await drag(editor, 'pill-b', async (s, start) => {
    await s.moveTo({ x: s.start.x + 12, y: s.start.y + 8 }, 8);
    await s.pump(4, { axis: 'y' });
    await assertEngaged(editor, 'pill-b', start);
  });
  expect(await painted(editor, 'pill-b', 'marginLeft')).toBe('-70px');
  expect(await painted(editor, 'pill-c', 'marginLeft')).toBe('-70px');
  expect((await editor.style('pill-b')).marginLeft).toBe('-70px');
  expect(await visualOrder(editor, 'strip')).toEqual(['pill-a', 'pill-b', 'pill-c', 'pill-d']);
  await editor.page().waitForTimeout(300);

  // Reorder pill-c one slot left (onto the part of pill-b no other pill covers).
  const before = await editor.code();
  const c0 = await editor.nodeBox('pill-c');
  const pillB = await editor.nodeBox('pill-b');
  await drag(editor, 'pill-c', async (s) => {
    // Lift: the node moves by exactly the cursor delta — no margin-sized jump.
    await s.moveTo({ x: s.start.x - 30, y: s.start.y + 20 }, 10);
    const lifted = await editor.nodeBox('pill-c');
    expect(Math.abs((lifted.x - c0.x) - -30)).toBeLessThan(6);
    expect(Math.abs((lifted.y - c0.y) - 20)).toBeLessThan(6);
    await s.moveTo({ x: pillB.x + pillB.width * 0.5, y: pillB.y + pillB.height / 2 }, 10);
    await s.pump(6, { axis: 'y' });
  });

  await expect(editor).toHaveStyle('pill-c', 'order', '1');
  await expect(editor).toHaveStyle('pill-b', 'order', '2');
  expect(await visualOrder(editor, 'strip')).toEqual(['pill-a', 'pill-c', 'pill-b', 'pill-d']);
  // Margin longhand still painted on the moved AND the unmoved pill, and in source.
  expect(await painted(editor, 'pill-c', 'marginLeft')).toBe('-70px');
  expect(await painted(editor, 'pill-b', 'marginLeft')).toBe('-70px');
  expect((await editor.style('pill-c')).marginLeft).toBe('-70px');
  expect((await editor.style('pill-b')).marginLeft).toBe('-70px');
  expect(await editor.style('pill-c')).not.toHaveProperty('margin');
  await expect(editor).toUndoInOneStep(before);
}));

// A flex section holding one flow child, an ABSOLUTE hero and an absolute
// top bar, plus a canvas-node header to drop above the flow child.
const FLEX_WITH_ABSOLUTE_HERO = project().page(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '900px', background: '#0d0d1a', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <div data-id="wrap" data-name="Wrap" style={{ display: 'flex', flexDirection: 'column', width: '100%', position: 'relative', flex: '0 0 auto', paddingTop: '48px' }}>
    <div data-id="body" data-name="Body" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#0a0a0a', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="hero" data-name="Hero" style={{ position: 'absolute', left: '0px', top: '0px', width: '70%', height: '200px', backgroundColor: '#ff3366' }}></div>
    <div data-id="bar" data-name="Bar" style={{ position: 'absolute', left: '0px', top: '0px', width: '70%', height: '60px', backgroundColor: '#3366ff' }}></div>
  </div>
</div>`, { tiles: [{ id: 'desktop', label: 'Desktop', width: 900 }] }).build();
FLEX_WITH_ABSOLUTE_HERO.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="hdr" data-name="Header" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '100px', width: '300px', height: '80px', backgroundColor: '#22cc88' }}></div>
</>);
`;

/** Which node paints on top at a point over the hero that the flow body also covers. */
async function topmostOverHero(editor: Editor): Promise<string | null> {
  return editor.sandbox().locator('[data-id="wrap"]').first().evaluate((wrap) => {
    const q = (id: string) => wrap.querySelector(`[data-id="${id}"]`) as HTMLElement;
    const hr = q('hero').getBoundingClientRect();
    const br = q('body').getBoundingClientRect();
    const el = wrap.ownerDocument.elementFromPoint(hr.left + hr.width / 2, Math.min(hr.bottom - 4, br.top + 30)) as HTMLElement | null;
    return el?.closest('[data-id="hero"]') ? 'hero' : (el?.getAttribute('data-id') ?? null);
  });
}

test('DND-018 dropping above a flow child layers the absolute siblings above it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FLEX_WITH_ABSOLUTE_HERO);
  const page = editor.page();
  expect(await topmostOverHero(editor)).toBe('hero');
  const before = await editor.code();
  const body = await editor.nodeBox('body');

  // The body's top edge, right of the overlays (edge magnet → wrap, index 0).
  await editor.duringDrag('hdr', { x: body.x + body.width * 0.9, y: body.y + 3 }, async () => {
    expect(await dropLine(page)).toMatchObject({ parentId: 'wrap', insertIndex: 0 });
  }, { steps: 20 });

  await expect.poll(() => editor.parentOf('hdr')).toBe('wrap');
  await expect(editor).toHaveStyle('hdr', 'order', '0');
  await expect(editor).toHaveStyle('body', 'order', '1');
  // Out-of-flow siblings after a positively ordered flow sibling get z-index 1…
  await expect(editor).toHaveStyle('hero', 'zIndex', '1');
  await expect(editor).toHaveStyle('bar', 'zIndex', '1');
  // …and still paint above it (not: the pinned hero vanished under the section).
  await expect.poll(() => topmostOverHero(editor)).toBe('hero');
  await expect(editor).toUndoInOneStep(before);
}));

// A page an older build renumbered: flow siblings already carry order ≥ 1
// and the absolute overlays after them have no z-index (one has its own).
const RENUMBERED_BY_OLD_BUILD = project().page(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '900px', background: '#0d0d1a', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
  <div data-id="wrap" data-name="Wrap" style={{ display: 'flex', flexDirection: 'column', width: '100%', position: 'relative', flex: '0 0 auto', paddingTop: '48px' }}>
    <div data-id="hdr" data-name="Header" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#22cc88', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="body" data-name="Body" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#0a0a0a', flex: '0 0 auto', order: '1' }}></div>
    <div data-id="hero" data-name="Hero" style={{ position: 'absolute', left: '0px', top: '0px', width: '70%', height: '300px', backgroundColor: '#ff3366' }}></div>
    <div data-id="badge" data-name="Badge" style={{ position: 'absolute', right: '0px', top: '0px', width: '20%', height: '300px', backgroundColor: '#3366ff', zIndex: '5' }}></div>
  </div>
</div>`, { tiles: [{ id: 'desktop', label: 'Desktop', width: 900 }] }).build();

test('DND-019 load heal layers out-of-flow siblings of a renumbered page', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, RENUMBERED_BY_OLD_BUILD);
  // Healed on load: z-index 1 stamped on the hero; the authored 5 is respected.
  await expect(editor).toHaveStyle('hero', 'zIndex', '1');
  await expect(editor).toHaveStyle('badge', 'zIndex', '5');
  expect((await editor.style('body')).order).toBe('1');
  expect(await painted(editor, 'hero', 'zIndex')).toBe('1');
  // The hero paints above the ordered flow section.
  expect(await topmostOverHero(editor)).toBe('hero');
}));

const box = (id: string, bg: string) => `<div data-id="${id}" data-name="${id}" style={{ width: '100%', height: '80px', background: '${bg}', flex: '0 0 auto' }}></div>`;
const col = (id: string, kids: string) => `<div data-id="${id}" data-name="${id}" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '440px', background: '#303040', flex: '0 0 auto' }}>${kids}</div>`;
const row = (id: string, kids: string) => `<div data-id="${id}" data-name="${id}" style={{ display: 'flex', flexDirection: 'row', gap: '20px', padding: '20px', width: '100%', background: '#252535', flex: '0 0 auto' }}>${kids}</div>`;
// column (outer) > row > column, rows touching (gap 0) with 20px padding.
const NESTED_STACKS = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <div data-id="outer" data-name="Outer" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '940px', background: '#202030', flex: '0 0 auto' }}>
    ${row('row-1', col('col-1a', box('a1', '#ff5577') + box('a2', '#ff9977')) + col('col-1b', box('b1', '#55ffaa') + box('b2', '#99ffaa')))}
    ${row('row-2', col('col-2a', box('c1', '#5577ff') + box('c2', '#7799ff')) + col('col-2b', box('d1', '#aa55ff') + box('d2', '#cc99ff')))}
  </div>
</div>`).build();
NESTED_STACKS.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-260px', top: '120px', width: '30px', height: '20px', background: '#ffcc33' }}></div>
</>);
`;

test('DND-020 nested stacks: the edge magnet promotes to the outer column', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, NESTED_STACKS);
  const page = editor.page();
  const r1 = await editor.nodeBox('row-1');
  const boundary = { x: r1.x + r1.width * 0.97, y: r1.y + r1.height - 6 }; // row-1's bottom padding, 6px from the edge

  // A DEEP layout child stays in its own stack while the cursor is on the
  // page (its ancestors are the hierarchy the drag may re-enter, never new
  // parents): at the row boundary it just reorders inside col-1a.
  await drag(editor, 'a1', async (s, start) => {
    await s.moveTo(boundary, 20);
    await s.pump(8, { axis: 'x' });
    await assertEngaged(editor, 'a1', start);
    expect(await dropLine(page)).toBeNull();
    expect(await placeholders(editor)).toHaveLength(1);
  });
  await expect(editor).toHaveStyle('a2', 'order', '0');
  await expect(editor).toHaveStyle('a1', 'order', '1');
  expect(await editor.parentOf('a1')).toBe('col-1a');
  await page.waitForTimeout(300);

  // A node entering from the canvas: near row-1's inner bottom edge the
  // magnet promotes row-1 → outer, the line sits between the rows.
  const before = await editor.code();
  const since = await traceMark(page);
  await editor.duringDrag('chip', boundary, async () => {
    expect(await dropLine(page)).toMatchObject({ parentId: 'outer', insertIndex: 1, orientation: 'horizontal' });
  }, { steps: 24, pumpFrames: 12 });
  const magnets = await tracesSince(page, since, '^reparent-utils:applyLayoutEdgeMagnet$');
  expect(magnets.some(m => m.data.fromId === 'row-1' && m.data.toParentId === 'outer')).toBe(true);

  await expect.poll(() => editor.parentOf('chip')).toBe('outer');
  expect(await visualOrder(editor, 'outer')).toEqual(['row-1', 'chip', 'row-2']);
  // The inner stacks keep their own sequences.
  expect(await editor.childIds('row-1')).toEqual(['col-1a', 'col-1b']);
  expect(await visualOrder(editor, 'col-1a')).toEqual(['a2', 'a1']);
  await expect(editor).toUndoInOneStep(before);
}));

const FIVE = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <div data-id="list" data-name="List" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '600px', padding: '12px', background: '#202030', flex: '0 0 auto' }}>
    ${['a', 'b', 'c', 'd', 'e'].map((id, i) => `<div data-id="${id}" data-name="${id.toUpperCase()}" style={{ width: '100%', height: '90px', background: '#${['ff5577', '55ffaa', '5577ff', 'ffcc33', 'aa55ff'][i]}', flex: '0 0 auto' }}></div>`).join('\n    ')}
  </div>
</div>`).build();

test('DND-021 multi-selected siblings land together below the last child', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, FIVE);
  await editor.click('a');
  await editor.page().waitForTimeout(350);
  await editor.click('c', { modifiers: ['Shift'] });
  expect((await editor.selection()).sort()).toEqual(['a', 'c']);
  await editor.page().waitForTimeout(350);
  const before = await editor.code();

  await editor.dragNodeAsserted('a', await editor.at('e', 0.5, 0.92), { steps: 20, releaseDelayMs: 100 });

  // Both consecutive at the line, in their original relative order.
  const want = ['b', 'd', 'e', 'a', 'c'];
  for (const [i, id] of want.entries()) await expect(editor).toHaveStyle(id, 'order', String(i));
  expect(await visualOrder(editor, 'list')).toEqual(want);
  await expect(editor).toHaveJsxOrder('list', ['a', 'b', 'c', 'd', 'e']);
  await expect(editor).toUndoInOneStep(before);
}));

const BLOCK_FLOW = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '60px', background: '#0d0d1a' }}>
  <div data-id="blockbox" data-name="Block" style={{ width: '700px', padding: '20px', background: '#202030', position: 'relative', flex: '0 0 auto' }}>
    <div data-id="p1" data-name="P1" style={{ width: '100%', height: '80px', background: '#ff5577' }}></div>
    <div data-id="p2" data-name="P2" style={{ width: '100%', height: '80px', background: '#55ffaa' }}></div>
    <div data-id="p3" data-name="P3" style={{ width: '100%', height: '80px', background: '#5577ff' }}></div>
    <div data-id="rel" data-name="Rel" style={{ width: '50%', height: '80px', background: '#ffcc33', position: 'relative' }}></div>
  </div>
</div>`).build();

test('DND-022 block-flow parent: static children reorder, a relative child drags in-frame', { tag: ['@p2', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  // A static child's COMPUTED position is 'static', which fails
  // LayoutLiftedStrategy.canHandle's block-flow `!position` test, so the
  // drag goes to absolute-in-frame and writes left/top onto a static node;
  // the relative child keeps `position: relative` with left/top pins. Both
  // are offsets the builder's own oracle rejects (POSITION_OFFSET_REQUIRES_ABSOLUTE).
  test.fail(true, 'BUG: block-flow static child is never reordered (absolute-in-frame writes left/top on static/relative nodes; oracle POSITION_OFFSET_REQUIRES_ABSOLUTE)');
  await loadSeed(editor, BLOCK_FLOW);
  const page = editor.page();

  // Static child: a reorder (placeholder), painted first afterwards, no offsets.
  let since = await traceMark(page);
  await editor.duringDrag('p3', await editor.at('p1', 0.5, 0.08), async () => {
    expect(await placeholders(editor)).toHaveLength(1);
  }, { steps: 16 });
  expect((await tracesSince(page, since, '^drag:start$'))[0]?.data?.strategy).toBe('layout-lifted');
  await expect.poll(() => visualOrder(editor, 'blockbox')).toEqual(['p3', 'p1', 'p2', 'rel']);
  expect(await editor.style('p3')).not.toHaveProperty('left');
  expect(await editor.style('p3')).not.toHaveProperty('top');
  await page.waitForTimeout(300);

  // Relative child: not a reorder candidate — dragged in-frame, pins written.
  since = await traceMark(page);
  await editor.duringDrag('rel', { x: (await editor.nodeBox('rel')).x + 200, y: (await editor.nodeBox('rel')).y - 60 }, async () => {
    expect(await placeholders(editor)).toHaveLength(0);
    expect(await dropLine(page)).toBeNull();
  }, { steps: 16 });
  expect((await tracesSince(page, since, '^drag:start$'))[0]?.data?.strategy).toBe('absolute-in-frame');
  const rel = await editor.style('rel');
  expect(rel.left).toBeTruthy();
  expect(rel.top).toBeTruthy();
  expect(rel.position).toBe('absolute');
  await expect(editor).toPassOracle();
}));

test('DND-023 sweeping across overlapping pills moves the slot monotonically', { tag: ['@p2', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, NEGATIVE_MARGIN_ROW);
  const page = editor.page();
  const a0 = await editor.nodeBox('pill-a');
  const d = await editor.nodeBox('pill-d');
  const since = await traceMark(page);
  let firstHole: { x: number } | null = null;

  await drag(editor, 'pill-a', async (s) => {
    await s.moveTo({ x: s.start.x + 4, y: s.start.y }, 2);
    await s.pump(4, { axis: 'y' });
    // No placeholder jump at lift: the hole opens exactly at pill-a's slot.
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    firstHole = holes[0];
    expect(Math.abs(holes[0].x - a0.x)).toBeLessThan(3);
    // Slow sweep right across b, c and d, 1 frame per ~5px.
    const steps = Math.round((d.x + d.width * 0.8 - s.cur.x) / 5);
    await s.moveTo({ x: d.x + d.width * 0.8, y: s.start.y }, steps);
    await s.pump(4, { axis: 'y' });
  });
  expect(firstHole).not.toBeNull();

  // Insert index follows flow order: never steps back, never oscillates.
  const seq = (await tracesSince(page, since, '^layout-lifted:reorder-check$')).map(e => e.data.newIndex as number);
  expect(seq.length).toBeGreaterThan(10);
  for (let i = 1; i < seq.length; i++) expect(seq[i], `index went ${seq[i - 1]} → ${seq[i]} at tick ${i}: ${seq.join(',')}`).toBeGreaterThanOrEqual(seq[i - 1]);
  expect(seq.at(-1)).toBe(3);
  await expect(editor).toHaveStyle('pill-a', 'order', '3');
  expect(await visualOrder(editor, 'strip')).toEqual(['pill-b', 'pill-c', 'pill-d', 'pill-a']);
}));

const PADDED_COLUMN = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <div data-id="panel" data-name="Panel" style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px', width: '700px', background: '#202030', flex: '0 0 auto' }}>
    <div data-id="i1" data-name="I1" style={{ width: '100%', height: '100px', background: '#ff5577', flex: '0 0 auto' }}></div>
    <div data-id="i2" data-name="I2" style={{ width: '100%', height: '100px', background: '#55ffaa', flex: '0 0 auto' }}></div>
    <div data-id="i3" data-name="I3" style={{ width: '100%', height: '100px', background: '#5577ff', flex: '0 0 auto' }}></div>
  </div>
</div>`).build();

test('DND-024 padded column: the slot before the first child sits inside the padding box', { tag: ['@p2', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, PADDED_COLUMN);
  const before = await editor.code();
  const panel = await editor.nodeBox('panel');
  const i1 = await editor.nodeBox('i1');
  const pad = i1.y - panel.y; // 40px at the current zoom

  await editor.duringDrag('i3', await editor.at('i1', 0.5, 0.1), async () => {
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    // Inside the padding box, before the first child — not over the padding.
    expect(Math.abs(holes[0].y - (panel.y + pad))).toBeLessThan(3);
    expect(Math.abs(holes[0].x - i1.x)).toBeLessThan(3);
  }, { steps: 18 });

  await expect(editor).toHaveStyle('i3', 'order', '0');
  await expect(editor).toHaveStyle('i1', 'order', '1');
  await expect(editor).toHaveStyle('i2', 'order', '2');
  expect(await visualOrder(editor, 'panel')).toEqual(['i3', 'i1', 'i2']);
  await expect(editor).toHaveStyle('panel', 'padding', '40px');
  await expect(editor).toHaveStyle('panel', 'gap', '24px');
  const i3 = await editor.nodeBox('i3');
  expect(Math.abs(i3.y - (panel.y + pad))).toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
}));
