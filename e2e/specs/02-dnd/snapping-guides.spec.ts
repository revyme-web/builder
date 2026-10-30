// DND · Snapping, ruler guides, Alt distance and drag modifiers
// (E2E_TEST_PLAN.md §2, batch D4, DND-121..129).
//
// Canvas-space coordinates: the desktop tile sits at x=800 (via @canvas
// positions) so the free canvas left of it holds the canvas nodes and the ruler
// guides at x=200 / y=300. Canvas-node `left/top` and guide positions share
// that space; screen deltas are converted with the painted scale.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  seed, pageSrc, CanvasDrag, holdKey, pressMidDrag, measureOverlay, scaleOf, boxSettled,
  pinch, presetDirectSelection, traceMark, tracesSince, frames, snapGuideLines, panNodeTo, type Pt, type Box,
} from '../../helpers/d4';

test.describe.configure({ timeout: 180_000 });

const AT_800 = { desktop: { x: 800, y: 0 } };
const EMPTY_ROOT = `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}></div>`;
const GUIDES = `/** @rulerGuides [
  { "id": "g-v", "type": "vertical", "position": 200 },
  { "id": "g-h", "type": "horizontal", "position": 300 }
] */`;

/** One free canvas node, guides at x=200 / y=300. */
const GUIDED = seed(pageSrc({
  header: GUIDES, positions: AT_800, root: EMPTY_ROOT,
  canvas: `<div data-id="cn" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '40px', top: '420px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
}));

/** The same node without guides (axis lock must not be confused with a snap). */
const LOOSE = seed(pageSrc({
  positions: AT_800, root: EMPTY_ROOT,
  canvas: `<div data-id="cn" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '40px', top: '420px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
}));

/** Canvas-node frames with children (Cmd promote / bypass, multi-select). */
const FRAMES = seed(pageSrc({
  positions: AT_800, root: EMPTY_ROOT,
  canvas: `
  <div data-id="fa" data-name="Frame A" data-canvas-node="true" style={{ position: 'absolute', left: '-200px', top: '100px', width: '300px', height: '240px', backgroundColor: '#222244' }}>
    <div data-id="fa-b" data-name="Child B" style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '60px', backgroundColor: '#ff2d75' }}></div>
    <div data-id="fa-g" data-name="Group G" style={{ position: 'absolute', left: '40px', top: '120px', width: '220px', height: '100px', backgroundColor: '#333366' }}>
      <div data-id="fa-d" data-name="Deep D" style={{ position: 'absolute', left: '20px', top: '20px', width: '80px', height: '50px', backgroundColor: '#33cc88' }}></div>
    </div>
  </div>
  <div data-id="fb" data-name="Frame B" data-canvas-node="true" style={{ position: 'absolute', left: '200px', top: '100px', width: '300px', height: '240px', backgroundColor: '#224422' }}>
    <div data-id="fb-c" data-name="Child C" style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '60px', backgroundColor: '#ffcc33' }}></div>
  </div>`,
}));

/** A measuring stage: N at (40,30) 100×60 in a 400×300 parent, Q level with N,
 *  R diagonal from N. */
const MEASURE = seed(pageSrc({
  positions: AT_800, root: EMPTY_ROOT,
  canvas: `
  <div data-id="p" data-name="Parent" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '400px', height: '300px', backgroundColor: '#222244' }}>
    <div data-id="n" data-name="N" style={{ position: 'absolute', left: '40px', top: '30px', width: '100px', height: '60px', backgroundColor: '#ff2d75' }}></div>
    <div data-id="q" data-name="Q" style={{ position: 'absolute', left: '240px', top: '30px', width: '100px', height: '60px', backgroundColor: '#33cc88' }}></div>
    <div data-id="r" data-name="R" style={{ position: 'absolute', left: '260px', top: '200px', width: '100px', height: '60px', backgroundColor: '#3355ff' }}></div>
  </div>`,
}));

const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const px = (v: string | undefined) => Number(String(v).replace('px', ''));

/** Drag a canvas node so its CSS left/top move by (dx, dy) canvas px, slowly
 *  enough that the snap engine is not broken out by velocity. */
async function dragBy(editor: Editor, id: string, dx: number, dy: number, s: number, opts: { from?: Pt } = {}): Promise<void> {
  const page = editor.page();
  const b = await editor.nodeBox(id);
  const from = opts.from ?? center(b);
  const d = await CanvasDrag.press(page, from);
  try {
    await d.moveBy(6 * Math.sign(dx || 1), 0, 3);
    const total = { x: dx * s, y: dy * s };
    await d.moveTo({ x: from.x + total.x, y: from.y + total.y }, 24);
    await d.hold(8);
  } finally {
    await d.release();
    await page.waitForTimeout(80);
    await editor.settled();
  }
}

// ─── DND-121 ──────────────────────────────────────────────────────────

test('DND-121 Shift locks a canvas-node drag to its dominant axis past 5px, pressed before or mid-drag', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LOOSE, { fit: true });
  const page = editor.page();
  // Zoom to the node (Shift+2) so 5 canvas px is many screen px.
  await editor.click('cn');
  await page.keyboard.press('Shift+2');
  const b0 = await boxSettled(editor, 'cn');
  const s = b0.width / 120;
  expect(s, 'zoomed in far enough to resolve the 5px threshold').toBeGreaterThan(1.5);
  await page.keyboard.press('Escape');
  await editor.settled();
  expect(await editor.selection()).toEqual([]);
  const before = await editor.code();
  const start = await editor.style('cn');
  const c = center(b0);

  // ── Shift held BEFORE the press: the shift-click still starts a drag.
  let under: Box, locked: Box, stillLocked: Box;
  await page.keyboard.down('Shift');
  const d = await CanvasDrag.press(page, c);
  try {
    // Under 5 canvas px on both axes: no lock yet, both coordinates follow.
    await d.moveTo({ x: c.x + 4 * s, y: c.y + 3 * s }, 4);
    await d.hold(3);
    under = await editor.nodeBox('cn');
    // Past 5px, X dominant: locked to X — the Y offset is dropped.
    await d.moveTo({ x: c.x + 60 * s, y: c.y + 20 * s }, 16);
    await d.hold(3);
    locked = await editor.nodeBox('cn');
    await d.moveTo({ x: c.x + 90 * s, y: c.y + 45 * s }, 12);
    await d.hold(3);
    stillLocked = await editor.nodeBox('cn');
  } finally {
    await d.release();
    await page.keyboard.up('Shift');
    await editor.settled();
  }
  expect(Math.abs((under.x - b0.x) - 4 * s), 'x follows under 5px').toBeLessThan(1.5);
  expect(Math.abs((under.y - b0.y) - 3 * s), 'y follows under 5px').toBeLessThan(1.5);
  expect(Math.abs(locked.y - b0.y), 'y pinned once locked').toBeLessThan(1);
  expect(Math.abs(stillLocked.y - b0.y), 'only one coordinate changes while locked').toBeLessThan(1);
  expect(stillLocked.x).toBeGreaterThan(locked.x + 10 * s);
  // Committed: left moved by ~90, top unchanged.
  await expect.poll(async () => Math.round(px((await editor.style('cn')).left) - px(start.left))).toBe(90);
  expect((await editor.style('cn')).top).toBe(start.top);
  await expect(editor).toUndoInOneStep(before);

  // ── Shift pressed MID-drag, then released: locks, then unlocks on the next move.
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
  const b1 = await boxSettled(editor, 'cn');
  const c1 = center(b1);
  let free: Box, midLocked: Box, unlocked: Box;
  const d2 = await CanvasDrag.press(page, c1);
  try {
    await d2.moveTo({ x: c1.x + 30 * s, y: c1.y + 20 * s }, 12);
    await d2.hold(3);
    free = await editor.nodeBox('cn');
    await pressMidDrag(d2, 'Shift', true);
    await d2.moveTo({ x: c1.x + 60 * s, y: c1.y + 25 * s }, 10);
    await d2.hold(3);
    midLocked = await editor.nodeBox('cn');
    await pressMidDrag(d2, 'Shift', false);
    await d2.moveTo({ x: c1.x + 62 * s, y: c1.y + 26 * s }, 2);
    await d2.hold(3);
    unlocked = await editor.nodeBox('cn');
  } finally {
    await d2.release();
    await page.keyboard.up('Shift').catch(() => {});
    await editor.settled();
  }
  expect(Math.abs((free.y - b1.y) - 20 * s), 'free drag follows y').toBeLessThan(1.5);
  expect(Math.abs(midLocked.y - b1.y), 'Shift mid-drag locks to X').toBeLessThan(1);
  expect(Math.abs((unlocked.y - b1.y) - 26 * s), 'releasing Shift unlocks on the next move').toBeLessThan(1.5);
  await expect.poll(async () => Math.round(px((await editor.style('cn')).top) - px(start.top))).toBe(26);
  expect(Math.round(px((await editor.style('cn')).left) - px(start.left))).toBe(62);
});

// ─── DND-122 ──────────────────────────────────────────────────────────

test('DND-122 Direct selection ON: Cmd+press on a child grabs and drags its parent frame', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FRAMES, { fit: true });
  const page = editor.page();
  const s = await scaleOf(editor, 'fa', 300);
  const before = await editor.code();
  const a0 = await editor.style('fa');
  const b0 = await editor.style('fa-b');
  const mark = await traceMark(page);

  const from = center(await editor.nodeBox('fa-b'));
  await holdKey(page, 'Meta', async () => {
    await dragBy(editor, 'fa-b', 0, 60, s, { from });
  });
  // A is selected and dragged …
  expect(await editor.selection()).toEqual(['fa']);
  await expect.poll(async () => Math.abs(px((await editor.style('fa')).top) - px(a0.top) - 60)).toBeLessThanOrEqual(2);
  expect((await editor.style('fa')).left).toBe(a0.left);
  // … B untouched.
  expect(await editor.style('fa-b')).toEqual(b0);
  const promoted = await tracesSince(page, mark, 'canvas:direct-selection-promote-parent');
  expect(promoted.pop()?.data).toMatchObject({ from: 'fa-b', to: 'fa' });
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-123 ──────────────────────────────────────────────────────────

test('DND-123 Direct selection OFF: Cmd+press bypasses the active-container redirect and drags the deep child', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await presetDirectSelection(editor.page(), false);
  await editor.load(FRAMES, { fit: true });
  const page = editor.page();
  const s = await scaleOf(editor, 'fa', 300);
  // Control: a plain click on the deep child selects the top-level frame (OFF mode).
  await editor.click('fa-d');
  expect(await editor.selection()).toEqual(['fa']);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450); // keep the next press out of the double-click window
  await editor.settled();
  const before = await editor.code();
  const a0 = await editor.style('fa');
  const g0 = await editor.style('fa-g');
  const d0 = await editor.style('fa-d');

  const dBox0 = await editor.nodeBox('fa-d');
  await holdKey(page, 'Meta', async () => {
    await dragBy(editor, 'fa-d', 30, 20, s);
  });
  // The deep child itself is selected and dragged (its pins were rewritten, it moved right/down).
  expect(await editor.selection()).toEqual(['fa-d']);
  await expect.poll(async () => JSON.stringify(await editor.style('fa-d'))).not.toBe(JSON.stringify(d0));
  expect(await editor.parentOf('fa-d')).toBe('fa-g');
  await expect.poll(async () => (await editor.nodeBox('fa-d')).x - dBox0.x).toBeGreaterThan(20 * s);
  expect(await editor.style('fa')).toEqual(a0);
  expect(await editor.style('fa-g')).toEqual(g0);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-124 ──────────────────────────────────────────────────────────

test('DND-124 Alt with a node selected draws pink px gaps to the parent\'s four edges; releasing Alt clears them', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(MEASURE, { fit: true });
  const page = editor.page();
  await editor.click('n');
  expect(await editor.selection()).toEqual(['n']);
  expect((await measureOverlay(page)).labels).toEqual([]);

  await page.keyboard.down('Alt');
  try {
    await expect.poll(async () => (await measureOverlay(page)).labels.slice().sort()).toEqual(['210', '260', '30', '40']);
    const m = await measureOverlay(page);
    expect(m.lines).toBeGreaterThanOrEqual(4);
    expect(m.lineColor).toBe('rgba(255, 124, 221, 0.8)');
    expect(m.labelColor).toBe('rgb(255, 124, 221)');
  } finally {
    await page.keyboard.up('Alt');
  }
  await expect.poll(async () => { const m = await measureOverlay(page); return m.labels.length + m.lines; }).toBe(0);
});

// ─── DND-125 ──────────────────────────────────────────────────────────

test('DND-125 Alt + hover measures to the hovered node (dashed elbow when diagonal) in the same pink in every theme', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(MEASURE, { fit: true });
  const page = editor.page();
  await editor.click('n');

  const pictures = async () => {
    const out: Record<string, Awaited<ReturnType<typeof measureOverlay>>> = {};
    await page.keyboard.down('Alt');
    try {
      await page.mouse.move(...Object.values(center(await editor.nodeBox('q'))) as [number, number]);
      await expect.poll(async () => (await measureOverlay(page)).labels).toEqual(['100']);
      out.aligned = await measureOverlay(page);
      await page.mouse.move(...Object.values(center(await editor.nodeBox('r'))) as [number, number]);
      await expect.poll(async () => (await measureOverlay(page)).dashed).toBeGreaterThan(0);
      out.diagonal = await measureOverlay(page);
      // Empty canvas (outside every node): back to the parent gaps.
      const p = await editor.nodeBox('p');
      await page.mouse.move(p.x - 40, p.y + p.height / 2);
      await expect.poll(async () => (await measureOverlay(page)).labels.slice().sort()).toEqual(['210', '260', '30', '40']);
      out.parent = await measureOverlay(page);
    } finally {
      await page.keyboard.up('Alt');
    }
    return out;
  };

  const first = await pictures();
  expect(first.aligned.dashed).toBe(0);
  // ROW-ADJUSTED: a diagonal pair is separated on BOTH axes and draws TWO
  // measurements (horizontal + vertical gap), each reaching the target with a
  // dashed elbow — documented in measure-geometry.ts ("yields TWO measurements").
  expect(first.diagonal.labels.slice().sort()).toEqual(['110', '120']);
  expect(first.diagonal.dashed).toBeGreaterThanOrEqual(1);

  // Flip the editor mode (bottom toolbar) and the builder theme (logo menu → Theme).
  const chrome = () => page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }));
  const chrome0 = await chrome();
  await page.locator('[data-tutorial="theme-tool"]').click();
  await expect.poll(async () => (await chrome()).dark).toBe(!chrome0.dark);
  const chrome1 = await chrome();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByText('Theme', { exact: true }).hover();
  await page.getByText('Ocean', { exact: true }).click();
  await expect.poll(async () => (await chrome()).accent).not.toBe(chrome1.accent);
  await page.keyboard.press('Escape').catch(() => {});
  await editor.click('n');
  const second = await pictures();

  for (const pic of [first, second]) {
    for (const k of ['aligned', 'diagonal', 'parent'] as const) {
      expect(pic[k].lineColor, `${k} line colour`).toBe('rgba(255, 124, 221, 0.8)');
      expect(pic[k].labelColor, `${k} label colour`).toBe('rgb(255, 124, 221)');
    }
  }
  expect(second.aligned.labels).toEqual(first.aligned.labels);
  expect(second.diagonal.labels).toEqual(first.diagonal.labels);
});

// ─── DND-126 ──────────────────────────────────────────────────────────

test('DND-126 ruler guides: left, right and centre snap to the vertical guide, top to the horizontal one; not beyond 5 screen px', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(GUIDED, { fit: true });
  const page = editor.page();
  const s = await scaleOf(editor, 'cn', 120);
  const before = await editor.code();
  const left = async () => px((await editor.style('cn')).left);
  const top = async () => px((await editor.style('cn')).top);
  // 2 screen px short of each target: inside the 5-screen-px threshold.
  const near = 2 / s;

  // Left edge → x=200.
  await dragBy(editor, 'cn', 200 - (await left()) - near, 0, s);
  await expect.poll(left).toBe(200);
  // Right edge → x=200 (left = 80).
  await dragBy(editor, 'cn', 80 - (await left()) + near, 0, s);
  await expect.poll(left).toBe(80);
  // Centre → x=200 (left = 140).
  await dragBy(editor, 'cn', 140 - (await left()) - near, 0, s);
  await expect.poll(left).toBe(140);
  // Top edge → y=300.
  await dragBy(editor, 'cn', 0, 300 - (await top()) + near, s);
  await expect.poll(top).toBe(300);

  // Beyond 5 screen px (9 screen px short of the left-edge snap): no snap.
  const far = 9 / s;
  const target = 200 - far;
  let guidesAtEnd: Array<{ vertical: boolean; at: number }> = [];
  {
    const b = await editor.nodeBox('cn');
    const from = center(b);
    const d = await CanvasDrag.press(page, from);
    try {
      await d.moveBy(6, 0, 3);
      await d.moveTo({ x: from.x + (target - (await left())) * s, y: from.y }, 24);
      await d.hold(8);
      guidesAtEnd = await snapGuideLines(page);
    } finally {
      await d.release();
      await editor.settled();
    }
  }
  await expect.poll(async () => Math.abs((await left()) - target)).toBeLessThan(2);
  expect(await left()).not.toBe(200);
  // No vertical snap line (the node's top still sits on the y=300 guide, so a
  // horizontal one may show).
  expect(guidesAtEnd.filter(g => g.vertical), 'no vertical pink snap line').toEqual([]);
  expect(await editor.code()).not.toBe(before);
});

// ─── DND-127 ──────────────────────────────────────────────────────────

test('DND-127 two frames multi-selected: Cmd+press on a child of one drags only that child', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  // Direct selection OFF: with it ON, Cmd PROMOTES the press to the parent
  // (DND-122), which is the selected frame itself.
  await presetDirectSelection(editor.page(), false);
  await editor.load(FRAMES, { fit: true });
  const page = editor.page();
  const s = await scaleOf(editor, 'fa', 300);
  // Multi-select A and B with real clicks.
  await editor.click('fa', { modifiers: [] });
  await page.waitForTimeout(450);
  await editor.click('fb', { modifiers: ['Shift'] });
  await expect.poll(() => editor.selection().then(x => x.slice().sort())).toEqual(['fa', 'fb']);
  await page.waitForTimeout(450);
  const before = await editor.code();
  const a0 = await editor.style('fa');
  const fb0 = await editor.style('fb');
  const b0 = await editor.style('fa-b');
  const mark = await traceMark(page);

  const bBox0 = await editor.nodeBox('fa-b');
  await holdKey(page, 'Meta', async () => {
    await dragBy(editor, 'fa-b', 30, 30, s);
  });
  // Only the child moved.
  await expect.poll(async () => JSON.stringify(await editor.style('fa-b'))).not.toBe(JSON.stringify(b0));
  await expect.poll(async () => (await editor.nodeBox('fa-b')).x - bBox0.x).toBeGreaterThan(20 * s);
  expect(await editor.parentOf('fa-b')).toBe('fa');
  // Not redirected to the selected ancestor: the frames did not move.
  expect(await editor.style('fa')).toEqual(a0);
  expect(await editor.style('fb')).toEqual(fb0);
  expect(await tracesSince(page, mark, 'canvas:multi-select-redirect-to-ancestor')).toEqual([]);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-128 ──────────────────────────────────────────────────────────

test('DND-128 Cmd held through a drag changes neither snapping nor the strategy (no no-snap modifier today)', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(GUIDED, { fit: true });
  const page = editor.page();
  const s = await scaleOf(editor, 'cn', 120);
  const left = async () => px((await editor.style('cn')).left);
  const near = 2 / s;
  const before = await editor.code();

  // Plain drag to just short of the guide: snaps.
  let mark = await traceMark(page);
  await dragBy(editor, 'cn', 200 - (await left()) - near, 0, s);
  await expect.poll(left).toBe(200);
  const plain = (await tracesSince(page, mark, '^drag:start$')).pop()?.data;
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
  await page.waitForTimeout(450);

  // Same drag with Cmd held throughout: identical snap and strategy.
  mark = await traceMark(page);
  await holdKey(page, 'Meta', async () => {
    await dragBy(editor, 'cn', 200 - (await left()) - near, 0, s);
  });
  await expect.poll(left).toBe(200);
  const withCmd = (await tracesSince(page, mark, '^drag:start$')).pop()?.data;
  expect(withCmd?.modifiers?.ctrl, 'Cmd is captured as the ctrl modifier').toBe(true);
  expect(plain?.modifiers?.ctrl).toBeFalsy();
  expect(withCmd?.strategy).toBe(plain?.strategy);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-129 ──────────────────────────────────────────────────────────

test('DND-129 Alt held through a 100%→400% zoom: labels stay CSS px and follow the zoom live', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(MEASURE, { fit: true });
  const page = editor.page();
  await editor.click('n');
  await page.keyboard.press('Shift+3'); // Zoom 100%
  await boxSettled(editor, 'n');
  expect(Math.abs((await scaleOf(editor, 'n', 100)) - 1)).toBeLessThan(0.02);
  // Two-finger scroll the stage to the middle of the screen.
  const vp = page.viewportSize()!;
  await panNodeTo(editor, 'n', { x: vp.width / 2 - 80, y: vp.height / 2 });
  await boxSettled(editor, 'n');
  const anchor = center(await editor.nodeBox('n'));
  await page.mouse.move(anchor.x, anchor.y);

  await page.keyboard.down('Alt');
  try {
    await expect.poll(async () => (await measureOverlay(page)).labels.slice().sort()).toEqual(['210', '260', '30', '40']);
    const leftGap = async () => page.evaluate(() => {
      // Screen length of the longest horizontal pink line = the right gap (260 CSS px).
      let best = 0;
      for (const l of document.querySelectorAll('body svg line')) {
        if (!(l.getAttribute('stroke') ?? '').includes('255, 124, 221') || l.getAttribute('stroke-dasharray')) continue;
        const y1 = Number(l.getAttribute('y1')), y2 = Number(l.getAttribute('y2'));
        if (Math.abs(y1 - y2) > 0.5) continue;
        best = Math.max(best, Math.abs(Number(l.getAttribute('x2')) - Number(l.getAttribute('x1'))));
      }
      return best;
    });
    const at100 = await leftGap();
    expect(Math.abs(at100 - 260)).toBeLessThan(3);
    // Pinch-zoom in (ctrl-wheel with no Control keydown) without releasing Alt.
    const zoomUntil = async (target: number) => {
      for (let i = 0; i < 40 && (await scaleOf(editor, 'n', 100)) < target; i++) {
        await pinch(page, anchor, -60, 1);
        await frames(page, 2);
      }
    };
    const picture = async () => ({ labels: (await measureOverlay(page)).labels.slice().sort(), line: await leftGap(), scale: await scaleOf(editor, 'n', 100) });
    // Mid-zoom (~2×, Alt still down): the overlay redraws with CSS px numbers
    // and lines at the NEW scale — not the pre-zoom picture.
    await zoomUntil(2);
    await expect.poll(async () => {
      const p = await picture();
      return p.labels.join('|') === '210|260|30|40' && Math.abs(p.line - 260 * p.scale) < 260 * p.scale * 0.08;
    }, { timeout: 5_000 }).toBe(true);
    const mid = await picture();
    expect(mid.scale).toBeGreaterThan(1.8);
    expect(mid.line).toBeGreaterThan(at100 * 1.7);
    // On to ~400%.
    await zoomUntil(3.95);
    await expect.poll(() => scaleOf(editor, 'n', 100)).toBeGreaterThan(3.5);
    await boxSettled(editor, 'n');
    const sc = await scaleOf(editor, 'n', 100);
    // Labels are CSS px (screen distance ÷ zoom) …
    await expect.poll(async () => (await measureOverlay(page)).labels.slice().sort()).toEqual(['210', '260', '30', '40']);
    // … while the lines themselves follow the zoom (not pre-zoom geometry).
    await expect.poll(async () => Math.abs((await leftGap()) - 260 * sc)).toBeLessThan(260 * sc * 0.08);
  } finally {
    await page.keyboard.up('Alt');
  }
});
