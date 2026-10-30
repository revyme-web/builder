// DND · Zoom extremes (E2E_TEST_PLAN.md §2).
//
// At 800% one mouse pixel is an eighth of a CSS pixel; at 10% it is ten.
// Thresholds that are defined in SCREEN px (click-vs-drag 3px, snap 5px) must
// stay screen px, and everything committed (positions, pin bands) must be CSS.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import { page8, center, near, gesture, Gesture, stableCode, mark, since, frames, quickBox, type Box, type Pt } from '../../helpers/d8';
import { centerOn, setZoom } from '../../helpers/d3';
import { pinchTo } from '../../helpers/d2';
import { snapGuideLines } from '../../helpers/d4';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ────────────────────────────────────────────────────────────

/** A 400×300 frame: `a` spans to the frame's right edge, `b` sits 6px short of it. */
const SNAP_PAIR = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="box" data-name="Box" style={{ position: 'absolute', left: '400px', top: '200px', width: '400px', height: '300px', backgroundColor: '#202040' }}>
    <div data-id="a" data-name="A" style={{ position: 'absolute', left: '300px', top: '40px', width: '100px', height: '40px', backgroundColor: '#66ccff' }}></div>
    <div data-id="b" data-name="B" style={{ position: 'absolute', left: '354px', top: '150px', width: '40px', height: '40px', backgroundColor: '#ffcc66' }}></div>
  </div>
</div>`);

/** A 3000px frame with a 1000px-wide child and an equally wide sibling
 *  (snap bait): their edges and centres sit 50 screen px apart at 10%. */
const BIG_FRAME = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '4000px', minHeight: '2400px', backgroundColor: '#0d0d1a' }}>
  <div data-id="field" data-name="Field" style={{ position: 'absolute', left: '200px', top: '200px', width: '3000px', height: '1800px', backgroundColor: '#202040' }}>
    <div data-id="mover" data-name="Mover" style={{ position: 'absolute', left: '200px', top: '200px', width: '1000px', height: '200px', backgroundColor: '#ff66cc' }}></div>
    <div data-id="bait" data-name="Bait" style={{ position: 'absolute', left: '1300px', top: '1100px', width: '1000px', height: '200px', backgroundColor: '#66ffcc' }}></div>
  </div>
</div>`);

/** A 400×400 frame holding one 40×40 child (3×3 pin bands of 133px). */
const BANDS = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="frame" data-name="Frame" style={{ position: 'absolute', left: '500px', top: '150px', width: '400px', height: '400px', backgroundColor: '#202040' }}>
    <div data-id="dot" data-name="Dot" style={{ position: 'absolute', left: '20px', top: '20px', width: '40px', height: '40px', backgroundColor: '#ffcc33' }}></div>
  </div>
</div>`);

// ─── Helpers ──────────────────────────────────────────────────────────

/** Live (DOM) inline left/right/top/bottom of the painted copy of `id`. */
async function liveInsets(editor: Editor, id: string): Promise<{ left: string; right: string; top: string; bottom: string }> {
  return editor.sandbox().locator(`[data-id="${id}"]`).first().evaluate((el) => {
    const s = (el as HTMLElement).style;
    return { left: s.left, right: s.right, top: s.top, bottom: s.bottom };
  });
}

async function paintedBox(editor: Editor, id: string): Promise<Box> {
  return (await quickBox(editor.sandbox().locator(`[data-id="${id}"]`)))!;
}

const pxOf = (v: string | undefined, size: number): number =>
  !v ? NaN : v.trim().endsWith('%') ? parseFloat(v) / 100 * size : parseFloat(v);

// ─── DND-237 ──────────────────────────────────────────────────────────

test('DND-237 at 800% a snapped drag holds exactly under sub-pixel sweeps, and its right pin never flips', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(SNAP_PAIR);
  await centerOn(editor, ['b']);
  const page = editor.page();
  const before = await editor.code();
  const scale = await pinchTo(editor, 'b', 8);
  expect(scale, 'zoomed to at least 800%').toBeGreaterThanOrEqual(8);
  await page.waitForTimeout(450);
  const b0 = await editor.nodeBox('b');
  // b's right edge is 6 CSS px short of a's right edge (= the frame's right edge).
  const from = center(b0);
  const m = await mark(page);
  const xs: number[] = [];
  const insets: Array<{ left: string; right: string }> = [];
  let guidesWhileSnapped = 0;
  await gesture(editor, from, async (g) => {
    // 6 CSS px − ¼ px → inside the 5-screen-px snap zone of the right edge.
    await g.moveBy(5.75 * scale, 0, 12);
    await g.pump(4, 'y');
    // Sub-pixel sweep: one screen px = 1/8 CSS px, ±2 screen px around the spot.
    const base = g.cur;
    for (const dx of [1, 2, 1, 0, -1, -2, -1, 0, 1, 2, 1, 0]) {
      await page.mouse.move(base.x + dx, base.y);
      await frames(page, 1);
      xs.push((await paintedBox(editor, 'b')).x);
      const li = await liveInsets(editor, 'b');
      insets.push({ left: li.left, right: li.right });
      if ((await snapGuideLines(page)).some(l => l.vertical)) guidesWhileSnapped++;
    }
    g.cur = base;
  });
  expect((await since(page, m, '^drag:start$')).map(t => t.data?.strategy)).toEqual(['absolute-in-frame']);
  expect(guidesWhileSnapped, 'the right-edge guide shows while sweeping').toBeGreaterThan(6);
  // Exactly still: no ±1px sawtooth while the cursor wanders an eighth of a pixel at a time.
  const spread = Math.max(...xs) - Math.min(...xs);
  expect(spread, `painted x across the sweep: ${xs.map(x => x.toFixed(2)).join(', ')}`).toBeLessThan(0.5);
  // The dynamic pin never flips L/R while snapped (one side, one value).
  expect(new Set(insets.map(i => `${i.left}|${i.right}`)).size, JSON.stringify(insets)).toBe(1);
  // Committed: pinned to the right edge at 0.
  await stableCode(editor);
  const st = await editor.style('b');
  expect(st.right).toBe('0px');
  expect(st.left ?? null).toBeNull();
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-238 ──────────────────────────────────────────────────────────

test('DND-238 at 10%: 2 screen px is a click, 40 screen px moves 400 CSS px, snapping engages within 5 screen px', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(BIG_FRAME);
  const page = editor.page();
  await centerOn(editor, ['field']);
  const scale = await setZoom(editor, 0.1, { id: 'field', cssWidth: 3000 }, ['field']);
  expect(near(scale, 0.1, 0.005), `zoom ${scale}`).toBe(true);
  await page.waitForTimeout(450);
  const code0 = await editor.code();

  // 1 · press, 2 screen px, release: still a click.
  const mv = await editor.nodeBox('mover');
  let m = await mark(page);
  await gesture(editor, center(mv), async (g) => { await g.moveBy(2, 0, 2); await g.moveBy(0, 2, 2); });
  expect(await since(page, m, '^drag:start$'), 'no drag below 3 screen px').toEqual([]);
  expect(await editor.code()).toBe(code0);
  expect(await editor.selection()).toEqual(['mover']);
  await page.waitForTimeout(450);

  // 2 · 40 screen px = 400 CSS px.
  const before = await editor.code();
  m = await mark(page);
  await gesture(editor, center(mv), async (g) => { await g.moveBy(40, 0, 10); await g.hold(3); });
  expect((await since(page, m, '^drag:start$')).length).toBe(1);
  await stableCode(editor);
  expect(pxOf((await editor.style('mover')).left, 3000)).toBeCloseTo(200 + 40 / scale, -1);
  expect(Math.abs(pxOf((await editor.style('mover')).left, 3000) - 600)).toBeLessThan(15);
  await expect(editor).toUndoInOneStep(before);
  await page.waitForTimeout(450);

  // 3 · snapping is a SCREEN distance: the bait's left edge 7 screen px
  //     away does not pull, 4 screen px away does.
  const beforeSnap = await editor.code();
  const at = await editor.nodeBox('mover');
  const bait = await editor.nodeBox('bait');
  // Align the mover's left edge 7 screen px short of the bait's left edge,
  // straight above it (vertical alignment guide only).
  await gesture(editor, center(at), async (g) => {
    await g.moveTo({ x: center(at).x + (bait.x - 7 - at.x), y: center(at).y }, 12);
    await g.hold(4);
    expect((await snapGuideLines(page)).filter(l => l.vertical && near(l.at, bait.x, 1.5)), 'no snap 7 screen px away').toEqual([]);
    expect(near((await paintedBox(editor, 'mover')).x, bait.x - 7, 1.5)).toBe(true);
    await g.moveTo({ x: center(at).x + (bait.x - 4 - at.x), y: center(at).y }, 6);
    await g.hold(4);
    expect((await snapGuideLines(page)).filter(l => l.vertical && near(l.at, bait.x, 1.5)).length, 'snap guide at 4 screen px').toBeGreaterThan(0);
    expect(near((await paintedBox(editor, 'mover')).x, bait.x, 1), 'pulled onto the bait edge').toBe(true);
  });
  await stableCode(editor);
  // Exactly the bait's edge (the middle band commits it as a percent of 3000).
  expect(pxOf((await editor.style('mover')).left, 3000)).toBeCloseTo(1300, 1);
  await expect(editor).toUndoInOneStep(beforeSnap);
});

// ─── DND-239 ──────────────────────────────────────────────────────────

/** Drag `dot` so its CSS centre lands at `target` (frame-local CSS px). */
async function dragDotTo(editor: Editor, target: Pt, scale: number): Promise<void> {
  const page = editor.page();
  const frame = await editor.nodeBox('frame');
  const dot = await editor.nodeBox('dot');
  const from = center(dot);
  const to = { x: frame.x + target.x * scale, y: frame.y + target.y * scale };
  await gesture(editor, from, async (g) => {
    await g.moveTo(to, 16);
    await g.hold(4);
  });
  await stableCode(editor);
  await page.waitForTimeout(450);
}

test('DND-239 pin bands are CSS px at 50% and 200%: the committed pin side matches the band the child sits in', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(BANDS);
  await centerOn(editor, ['frame']);
  for (const zoom of [0.5, 2]) {
    const scale = await setZoom(editor, zoom, { id: 'frame', cssWidth: 400 }, ['frame']);
    expect(near(scale, zoom, 0.02), `zoom ${scale}`).toBe(true);
    await editor.page().waitForTimeout(450);
    const before = await editor.code();

    // Start band (centre at 70,70 → both axes in the first third): px insets from the start.
    await dragDotTo(editor, { x: 72, y: 76 }, scale);
    let st = await editor.style('dot');
    expect(st.left, `start band: ${JSON.stringify(st)}`).toMatch(/px$/);
    expect(st.top).toMatch(/px$/);
    expect(st.right ?? null).toBeNull();
    expect(st.bottom ?? null).toBeNull();
    expect(Math.abs(parseFloat(st.left) - 52)).toBeLessThanOrEqual(6);
    expect(Math.abs(parseFloat(st.top) - 56)).toBeLessThanOrEqual(6);

    // Middle band (centre ≈ 180,175): percent insets (the child floats with the frame).
    await dragDotTo(editor, { x: 178, y: 172 }, scale);
    st = await editor.style('dot');
    expect(st.left, `middle band: ${JSON.stringify(st)}`).toMatch(/%$/);
    expect(st.top).toMatch(/%$/);
    expect(Math.abs(pxOf(st.left, 400) - 158)).toBeLessThanOrEqual(6);
    expect(Math.abs(pxOf(st.top, 400) - 152)).toBeLessThanOrEqual(6);

    const beforeEnd = await editor.code();
    // End band (centre ≈ 330,335): x keeps a left px (no right-edge snap),
    // y pins to the bottom in px.
    await dragDotTo(editor, { x: 328, y: 334 }, scale);
    st = await editor.style('dot');
    expect(st.left, `end band: ${JSON.stringify(st)}`).toMatch(/px$/);
    expect(st.right ?? null).toBeNull();
    expect(st.bottom).toMatch(/px$/);
    expect(st.top ?? null).toBeNull();
    expect(Math.abs(parseFloat(st.left) - 308)).toBeLessThanOrEqual(6);
    expect(Math.abs(parseFloat(st.bottom) - (400 - 354))).toBeLessThanOrEqual(6);
    // Painted where the band says: the bottom pin holds it 46px off the frame's bottom.
    const frame = await editor.nodeBox('frame');
    const dot = await editor.nodeBox('dot');
    expect(Math.abs((frame.y + frame.height) - (dot.y + dot.height) - parseFloat(st.bottom) * scale)).toBeLessThan(2);
    expect(before).not.toBe(beforeEnd);
    await expect(editor).toUndoInOneStep(beforeEnd);
    await editor.page().waitForTimeout(450);
  }
});
