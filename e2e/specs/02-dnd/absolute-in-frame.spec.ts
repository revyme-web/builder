// DND · Absolute drag inside a frame (E2E_TEST_PLAN.md §2, batch D2,
// DND-033..051): the AbsoluteInFrameStrategy — the dynamic pin rule, locked
// (`data-pinned`) pins, snapping, exit predicates, axis lock, pin lines, SVG
// shapes and groups, icon-set masters, overflow guards and the Position panel.
//
// Geometry: most seeds put a 600×400 `frame` at (80, 80) in a NON-layout root
// (so an exit walks up to the root only once the child is fully outside) and
// zoom the camera onto it (Fit Selection), so one CSS px is >1 screen px and
// the 5-screen-px snap threshold is ~3.6 CSS px.

import { test, expect, TILE, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  seed, pageSrc, zoomOnto, pinchTo, dragBy, press, release, clickNode, boxSettled, GLYPHS_ICON_SET, GLYPHS_PATH, guides, pinLines, mark, since, lastStrategy,
  pollPins, pinsMatch, unitOf, localBox, center, near, px, type Box, type Pt, type PinWant,
} from '../../helpers/d2';
import { glide, prime, primeReplica, quickBox, variantEntry, masterModule, masterSeed, openMaster } from '../../helpers/d6';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ────────────────────────────────────────────────────────────

/** A 600×400 (or w×h) frame at (80, 80) in a non-layout root. */
const framePage = (children: string, opts: { w?: number; h?: number; header?: string; frameExtra?: string } = {}) => seed(pageSrc({
  header: opts.header,
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a', padding: '80px' }}>
  <div data-id="frame" data-name="Frame" style={{ position: 'relative', width: '${opts.w ?? 600}px', height: '${opts.h ?? 400}px', backgroundColor: '#1a1a3a'${opts.frameExtra ?? ''} }}>
${children}
  </div>
</div>`,
}));

const CHIP = `    <div data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '40px', top: '40px', width: '60px', height: '40px', backgroundColor: '#66ccff' }}></div>`;

/** The old ABSOLUTE_IN_FRAME shape: hero (no layout) with an absolute child, plus a flex sibling. */
const HERO = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '400px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="abs-child" data-name="AbsChild" style={{ position: 'absolute', left: '40px', top: '40px', width: '120px', height: '120px', backgroundColor: '#66ccff' }}></div>
  </div>
  <div data-id="features" data-name="Features" style={{ display: 'flex', flexDirection: 'row', gap: '20px', height: '300px', padding: '20px', position: 'relative', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}>
    <div data-id="card-a" data-name="CardA" style={{ flex: '1 1 0', position: 'relative', backgroundColor: '#ffffff' }}></div>
    <div data-id="card-b" data-name="CardB" style={{ flex: '1 1 0', position: 'relative', backgroundColor: '#ffffff' }}></div>
  </div>
</div>` }));

const parentId = async (editor: Editor, id: string): Promise<string | null> =>
  editor.page().evaluate((i) => (window as any).__e2e.nodesSnapshot()[i]?.parentId ?? null, id);

/** Assert the source insets of `id` reach `want` (poll), with a readable failure. */
async function expectPins(editor: Editor, id: string, want: PinWant, label: string, tol: { pxTol?: number; pctTol?: number } = {}): Promise<Record<string, string | null>> {
  const have = await pollPins(editor, id, want, tol);
  expect(pinsMatch(have, want, tol.pxTol, tol.pctTol), `${label}: insets of ${id} ${JSON.stringify(have)} vs wanted ${JSON.stringify(want)}`).toBe(true);
  return have;
}

// ─── DND-033 ──────────────────────────────────────────────────────────

test('DND-033 absolute child dragged within hero: left/top px updated, no reparent', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(HERO);
  const page = editor.page();
  const s = await zoomOnto(editor, 'hero', 1440);
  const before = await editor.code();
  const box0 = await editor.nodeBox('abs-child');
  const m = await mark(page);

  // +40 / +20 keeps the child's centre (140, 120) in the top-left third of
  // the 1440×400 hero → the pin rule picks left/top in px.
  await dragBy(editor, 'abs-child', 40, 20, s);

  expect(await lastStrategy(page, m)).toBe('absolute-in-frame');
  await expectPins(editor, 'abs-child', { left: '80px', top: '60px', right: null, bottom: null }, 'top-left band');
  expect(unitOf((await editor.style('abs-child')).left)).toBe('px');
  // Not reparented: same parent in the source and in the node map.
  expect(await editor.parentOf('abs-child')).toBe('hero');
  expect(await parentId(editor, 'abs-child')).toBe('hero');
  await expect(editor).toHaveJsxOrder('root', ['hero', 'features']);
  expect(await since(page, m, '^abs-in-frame:(exit-begin|grandparent-reparent-begin)$')).toEqual([]);
  // Painted where the source says.
  const box1 = await editor.nodeBox('abs-child');
  expect(Math.abs((box1.x - box0.x) - 40 * s)).toBeLessThan(2);
  expect(Math.abs((box1.y - box0.y) - 20 * s)).toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-034 ──────────────────────────────────────────────────────────

test('DND-034 dynamic pin rule: each band of a 600×400 frame picks its own inset units', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(CHIP));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame', 600);
  // The chip (60×40) starts at (40, 40). Each drop moves it from where it is.
  const drop = (dx: number, dy: number, during?: () => Promise<void>) => dragBy(editor, 'chip', dx, dy, s, { during });
  const painted = () => localBox(editor, 'chip', 'frame', s);

  // Top-left (centre 100, 60): left/top px.
  await drop(30, 10);
  await expectPins(editor, 'chip', { left: '70px', top: '50px', right: null, bottom: null }, 'top-left');

  // Top-centre (centre 350, 60): left in %, top px.
  await drop(250, 0);
  await expectPins(editor, 'chip', { left: `${(320 / 600) * 100}%`, top: '50px', right: null, bottom: null }, 'top-centre');

  // Centre (centre 350, 190): left and top in %.
  await drop(0, 120);
  await expectPins(editor, 'chip', { left: `${(320 / 600) * 100}%`, top: `${(170 / 400) * 100}%`, right: null, bottom: null }, 'centre');
  {
    const b = await painted();
    expect(near(b.x, 320, 1.5) && near(b.y, 170, 1.5), `centre drop painted at ${JSON.stringify(b)}`).toBe(true);
  }

  // Bottom-left (centre 100, 330): left px, bottom px (frame parents pin the bottom third).
  await drop(-250, 140);
  await expectPins(editor, 'chip', { left: '70px', bottom: '50px', top: null, right: null }, 'bottom-left');

  // Bottom-right without a snap (centre 500, 330): left stays px.
  await drop(400, 0);
  await expectPins(editor, 'chip', { left: '470px', bottom: '50px', top: null, right: null }, 'bottom-right, not snapped');
  {
    const b = await painted();
    expect(near(b.x, 470, 1.5) && near(b.y + b.height, 350, 1.5), `bottom-right painted at ${JSON.stringify(b)}`).toBe(true);
  }

  // Bottom-right snapped to the right edge (2 CSS px short): right px.
  const before = await editor.code();
  const frameBox = await editor.nodeBox('frame');
  let rightGuide = false;
  await drop(68, 0, async () => {
    rightGuide = (await guides(page)).some(g => g.vertical && near(g.at, frameBox.x + frameBox.width, 1.5));
  });
  expect(rightGuide, 'the snap line sits on the frame\'s right edge while snapped').toBe(true);
  await expectPins(editor, 'chip', { right: '0px', bottom: '50px', left: null, top: null }, 'bottom-right, snapped');
  {
    const b = await painted();
    expect(near(b.x + b.width, 600, 1.5), `snapped chip right edge at ${b.x + b.width}`).toBe(true);
  }
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-035 ──────────────────────────────────────────────────────────

const PINNED = `
    <div data-id="rp" data-name="RightPinned" data-pinned="true" style={{ position: 'absolute', right: '600px', top: '40px', width: '120px', height: '80px', backgroundColor: '#ff6688' }}></div>
    <div data-id="bp" data-name="BottomPinned" data-pinned="true" style={{ position: 'absolute', left: '480px', bottom: '380px', width: '120px', height: '80px', backgroundColor: '#66ccff' }}></div>
    <div data-id="fi" data-name="FullInset" data-pinned="true" style={{ position: 'absolute', left: '80px', right: '600px', top: '300px', bottom: '120px', width: 'auto', height: 'auto', backgroundColor: '#33cc88' }}></div>
    <div data-id="pp" data-name="PercentPinned" data-pinned="true" style={{ position: 'absolute', left: '60%', top: '60%', width: '120px', height: '80px', backgroundColor: '#ffcc33' }}></div>`;

test('DND-035 data-pinned children keep their pin type: right, bottom, full inset, percent', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(PINNED, { w: 800, h: 500 }));
  const s = await zoomOnto(editor, 'frame', 800);
  const W = 800, H = 500;

  /** Drag +30/+25 and return the CSS distance the node actually moved (snap included). */
  const move = async (id: string): Promise<{ dx: number; dy: number }> => {
    const a = await localBox(editor, id, 'frame', s);
    await dragBy(editor, id, 30, 25, s);
    await editor.settled();
    const b = await localBox(editor, id, 'frame', s);
    const d = { dx: b.x - a.x, dy: b.y - a.y };
    expect(Math.abs(d.dx - 30) < 6 && Math.abs(d.dy - 25) < 6, `${id} followed the cursor: moved ${JSON.stringify(d)}`).toBe(true);
    return d;
  };

  // Right-pinned: only `right` is rewritten (no left appears).
  let d = await move('rp');
  await expectPins(editor, 'rp', { right: `${600 - d.dx}px`, top: `${40 + d.dy}px`, left: null, bottom: null }, 'right-pinned', { pxTol: 1.5 });
  // Bottom-pinned: only `bottom` on Y.
  d = await move('bp');
  await expectPins(editor, 'bp', { left: `${480 + d.dx}px`, bottom: `${380 - d.dy}px`, top: null, right: null }, 'bottom-pinned', { pxTol: 1.5 });
  // Full inset: both opposite insets shift, the size stays auto.
  d = await move('fi');
  await expectPins(editor, 'fi', { left: `${80 + d.dx}px`, right: `${600 - d.dx}px`, top: `${300 + d.dy}px`, bottom: `${120 - d.dy}px` }, 'full inset', { pxTol: 1.5 });
  expect((await editor.style('fi')).width).toBe('auto');
  // Percent: stays percent on both axes.
  const before = await editor.code();
  d = await move('pp');
  await expectPins(editor, 'pp', { left: `${((480 + d.dx) / W) * 100}%`, top: `${((300 + d.dy) / H) * 100}%`, right: null, bottom: null }, 'percent-pinned', { pctTol: 0.3 });

  for (const id of ['rp', 'bp', 'fi', 'pp']) {
    expect(await editor.attr(id, 'data-pinned'), `${id} keeps data-pinned`).toBe('true');
    expect(await editor.parentOf(id)).toBe('frame');
  }
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-036 ──────────────────────────────────────────────────────────

/** Frame at canvas (80, 80); a vertical ruler guide at canvas x = 230 (frame-local 150). */
const SNAP_GUIDES = `/** @rulerGuides [
  { "id": "g-v", "type": "vertical", "position": 230 }
] */`;
const SNAP_KIDS = `
    <div data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '40px', top: '40px', width: '60px', height: '40px', backgroundColor: '#66ccff' }}></div>
    <div data-id="sib" data-name="Sibling" style={{ position: 'absolute', left: '400px', top: '260px', width: '100px', height: '60px', backgroundColor: '#ff6688' }}></div>
    <div data-id="ctr" data-name="Centred" style={{ position: 'absolute', left: '50%', top: '25%', width: '80px', height: '40px', transform: 'translate(-50%, -50%)', backgroundColor: '#ffcc33' }}></div>`;

test('DND-036 snap guides: sibling edges and centre, the parent\'s own edges and centre, ruler guides, translated element by its visible edge', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(SNAP_KIDS, { header: SNAP_GUIDES }));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame', 600);
  const f = await editor.nodeBox('frame');
  const sib = await editor.nodeBox('sib');
  const X = (local: number) => f.x + local * s;
  const Y = (local: number) => f.y + local * s;

  /** Drag `id` by (dx, dy) CSS, return the guides showing at the end of the move. */
  const snapDrop = async (id: string, dx: number, dy: number) => {
    let seen: Array<{ vertical: boolean; at: number }> = [];
    await dragBy(editor, id, dx, dy, s, { steps: 40, during: async () => { seen = await guides(page); } });
    return seen;
  };
  const hasV = (gs: Array<{ vertical: boolean; at: number }>, at: number) => gs.some(g => g.vertical && near(g.at, at, 1.5));
  const hasH = (gs: Array<{ vertical: boolean; at: number }>, at: number) => gs.some(g => !g.vertical && near(g.at, at, 1.5));

  // 1 · chip's left edge to the sibling's left edge (2 px short): x = 400.
  let gs = await snapDrop('chip', 358, 0);
  expect(hasV(gs, sib.x), `guide at the sibling's left edge, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'chip', { left: '400px', top: '40px' }, 'sibling edge', { pxTol: 0.01 });

  // 2 · chip's centre to the parent's centre (2 px off): left 270 = 45%.
  gs = await snapDrop('chip', -128, 0);
  expect(hasV(gs, X(300)), `guide at the frame's centre, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'chip', { left: '45%', top: '40px' }, 'parent centre', { pctTol: 0.01 });

  // 3 · bottom-right corner onto the parent's right and bottom edges.
  gs = await snapDrop('chip', 268, 318);
  expect(hasV(gs, X(600)) && hasH(gs, Y(400)), `guides at the frame's right + bottom edges, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'chip', { right: '0px', bottom: '0px', left: null, top: null }, 'parent edges', { pxTol: 0.01 });

  // 4 · chip's centre to the sibling's centre on Y (2 px off): top 270 → bottom 90.
  gs = await snapDrop('chip', 0, -88);
  expect(hasH(gs, sib.y + sib.height / 2), `guide at the sibling's centre, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'chip', { bottom: '90px', top: null }, 'sibling centre', { pxTol: 0.01 });

  // 5 · chip's left edge to the ruler guide at frame-local 150 (2 px off).
  const chipNow = await localBox(editor, 'chip', 'frame', s);
  gs = await snapDrop('chip', 152 - chipNow.x, -200);
  expect(hasV(gs, X(150)), `guide on the ruler guide, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'chip', { left: '150px' }, 'ruler guide', { pxTol: 0.01 });

  // 6 · the translate(-50%,-50%) element snaps by its VISIBLE left edge: its
  // painted left lands on the sibling's left, so its CSS left is 400 + 40.
  const before = await editor.code();
  const ctr0 = await localBox(editor, 'ctr', 'frame', s);
  gs = await snapDrop('ctr', 398 - ctr0.x, 0);
  expect(hasV(gs, sib.x), `guide at the sibling's left edge for the centred element, got ${JSON.stringify(gs)}`).toBe(true);
  await expectPins(editor, 'ctr', { left: '440px' }, 'translated element', { pxTol: 0.01 });
  expect((await editor.style('ctr')).transform).toBe('translate(-50%, -50%)');
  const ctr1 = await editor.nodeBox('ctr');
  expect(near(ctr1.x, (await editor.nodeBox('sib')).x, 1)).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-037 ──────────────────────────────────────────────────────────

/** A clipped canvas frame whose group sits 30 px past its left edge, with a
 *  rotated child bleeding further out. The frame has no parent, so its
 *  children exit straight to the canvas ("not fully inside" predicate). */
const BLEED = seed(pageSrc({
  positions: { desktop: { x: 0, y: 0 } },
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}></div>`,
  canvas: `
  <div data-id="clip" data-name="Clip" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '100px', width: '500px', height: '360px', overflow: 'hidden', backgroundColor: '#1a1a3a' }}>
    <div data-id="grp" data-name="Group" style={{ position: 'absolute', left: '-30px', top: '120px', width: '220px', height: '120px', backgroundColor: '#334466' }}>
      <div data-id="grp-rot" data-name="Rotated" style={{ position: 'absolute', left: '-24px', top: '20px', width: '90px', height: '60px', backgroundColor: '#ff66cc', transform: 'rotate(25deg)' }}></div>
    </div>
  </div>`,
}));

test('DND-037 a group already bleeding past its clipped frame stays parented on a short drag and exits only once the cursor leaves', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(BLEED);
  const page = editor.page();
  const s = await zoomOnto(editor, 'clip', 500);
  const clip = await editor.nodeBox('clip');
  const grp = await editor.nodeBox('grp');
  // Press on the group's own fill, clear of the rotated child.
  const from = { x: grp.x + grp.width * 0.8, y: grp.y + grp.height * 0.5 };

  // ── Gesture 1: a short drag inside the frame, held well past 84 ms.
  const before1 = await editor.code();
  let m = await mark(page);
  let d = await press(page, from);
  try {
    await d.moveTo({ x: from.x + 20 * s, y: from.y + 10 * s }, 12);
    await d.hold(20);
    expect(await since(page, m, '^abs-in-frame:exit-begin$'), 'no exit during the short drag').toEqual([]);
    expect(await parentId(editor, 'grp')).toBe('clip');
  } finally {
    await release(editor, d);
  }
  expect(await lastStrategy(page, m)).toBe('absolute-in-frame');
  expect(await editor.parentOf('grp')).toBe('clip');
  expect(await editor.attr('grp', 'data-canvas-node')).toBeNull();
  await expectPins(editor, 'grp', { left: '-10px' }, 'short drag', { pxTol: 1.5 });
  await expect(editor).toUndoInOneStep(before1);

  // ── Gesture 2: drag on toward the left; the exit fires only once the
  // CURSOR is outside the frame, never while it is still over it.
  const before2 = await editor.code();
  m = await mark(page);
  const g2 = await editor.nodeBox('grp');
  const from2 = { x: g2.x + g2.width * 0.8, y: g2.y + g2.height * 0.5 };
  let exitAt: Pt | null = null;
  let lastInside: Pt | null = null;
  d = await press(page, from2);
  try {
    const target = { x: clip.x - 60 * s, y: from2.y };
    await glide(page, from2, target, 50, async (p) => {
      if (exitAt) return;
      if ((await since(page, m, '^abs-in-frame:exit-begin$')).length) exitAt = p;
      else lastInside = p;
    });
    d.cur = target;
    await d.hold(10);
  } finally {
    await release(editor, d);
  }
  expect(exitAt, 'the drag did exit the frame').not.toBeNull();
  // The group's box was outside the frame from the first frame (it bled 30 px
  // at rest); the exit waited for the CURSOR to cross the frame's left edge.
  expect(exitAt!.x, `exit fired with the cursor at x=${exitAt!.x}, frame left edge ${clip.x}`).toBeLessThan(clip.x + 1);
  expect(lastInside!.x).toBeLessThan(from2.x - 100 * s);
  expect(await editor.attr('grp', 'data-canvas-node')).toBe('true');
  expect(await editor.parentOf('grp')).toBeNull();
  expect(await editor.exists('grp-rot')).toBe(true);
  await expect(editor).toUndoInOneStep(before2);
});

// ─── DND-038 ──────────────────────────────────────────────────────────

const ROOT_CHILD = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="badge" data-name="Badge" style={{ position: 'absolute', left: '100px', top: '100px', width: '120px', height: '60px', backgroundColor: '#66ccff' }}></div>
</div>` }));

test('DND-038 absolute child of the viewport root always pins top in px, never bottom or %', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROOT_CHILD, { fit: true });
  const s = (await editor.nodeBox('root')).width / 1440;
  const root = await editor.nodeBox('root');
  expect(root.y + 760 * s, 'the whole drag stays on screen').toBeLessThan(editor.page().viewportSize()!.height - 20);
  // Middle third of the page: a frame parent would write top in %.
  await dragBy(editor, 'badge', 0, 300, s);
  await expectPins(editor, 'badge', { left: '100px', top: '400px', bottom: null, right: null }, 'middle of the page');
  // Bottom third: a frame parent would pin the bottom.
  const before = await editor.code();
  await dragBy(editor, 'badge', 0, 330, s);
  const have = await expectPins(editor, 'badge', { left: '100px', top: '730px', bottom: null, right: null }, 'low on the page');
  expect(unitOf(have.top)).toBe('px');
  expect(await editor.parentOf('badge')).toBe('root');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-039 / DND-040 (multi-tile) ───────────────────────────────────

/** `inset` is a 200×120 box at (40, 40) on the base; the tablet band pins it
 *  on all four sides instead. */
const TABLET_INSET = seed(pageSrc({
  tiles: [TILE.desktop, TILE.tablet],
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '700px', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 768px) {
  [data-id="inset"] { left: 40px !important; right: 40px !important; top: 40px !important; bottom: 40px !important; width: auto !important; height: auto !important; }
}
\`}</style>
  <div data-id="frame" data-name="Frame" style={{ position: 'relative', width: '600px', height: '400px', backgroundColor: '#1a1a3a' }}>
    <div data-id="inset" data-name="Inset" data-pinned="true" style={{ position: 'absolute', left: '40px', top: '40px', width: '200px', height: '120px', backgroundColor: '#66ccff' }}></div>
  </div>
</div>`,
}));

const CARD = 'components/Card.tsx';
/** variant-1 unpins right/bottom and centres the pinned child with a
 *  translate(-50%, -50%); the default tile pins it on all four sides. */
const MASTER_CENTRED = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '320px', height: '220px', backgroundColor: '#000000', ...style }}>
      <motion.div data-id="pin" data-name="Pin" data-pinned="true" variants={pinVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '40px', right: '200px', bottom: '130px', backgroundColor: '#ffcc33' }} />
    </motion.div>`, {
  pre: `const pinVariants = {
  default: { left: '40px', top: '40px', right: '200px', bottom: '130px' },
  'variant-1': { left: '50%', top: '50%', right: 'auto', bottom: 'auto', width: '80px', height: '50px', transform: 'translate(-50%, -50%)' },
};`,
}));

test.describe('tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-039 a pinned child full-inset only in the tablet band drags on the Tablet tile: band insets move, base untouched', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_INSET, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const base0 = await editor.style('inset');
    // Zoom onto the Tablet frame: the inset box sits centred in it, so at fit
    // zoom the centre snap (sticky 10 screen px) would swallow a 30 px move.
    const s = await zoomOnto(editor, 'frame', 600, { vpId: 'tablet' });
    await primeReplica(editor, 'tablet', 'frame', 'inset');
    const deskF0 = await localBox(editor, 'inset', 'frame', s, 'desktop');
    const a = await editor.nodeBoxIn('tablet', 'inset');
    // Full inset on the tablet: 520×320 at (40, 40).
    expect(near(a.width / s, 520, 2) && near(a.height / s, 320, 2), `tablet paints the band's inset box, got ${a.width / s}×${a.height / s}`).toBe(true);
    const m = await mark(page);
    await dragBy(editor, 'inset', 30, 20, s, { vpId: 'tablet', from: { x: a.x + a.width / 2 + 2, y: a.y + a.height / 2 + 2 } });
    expect(await lastStrategy(page, m)).toBe('absolute-in-frame');

    const moved = await localBox(editor, 'inset', 'frame', s, 'tablet');
    const dx = moved.x - 40, dy = moved.y - 40;
    expect(Math.abs(dx - 30) < 6 && Math.abs(dy - 20) < 6, `followed the cursor: ${dx}, ${dy}`).toBe(true);
    // Band: both opposite insets shifted (not: misread as a single corner, right: -dx).
    for (const [prop, want] of [['left', 40 + dx], ['right', 40 - dx], ['top', 40 + dy], ['bottom', 40 - dy]] as const) {
      await expect.poll(async () => {
        const d = await editor.bandStyle(768, 'inset', prop);
        return d ? Math.abs(parseFloat(d.value) - want) <= 1.5 && d.value.endsWith('px') : false;
      }, { message: `tablet band ${prop} ≈ ${want}px` }).toBe(true);
    }
    expect(parseFloat((await editor.bandStyle(768, 'inset', 'right'))!.value)).toBeGreaterThan(0);
    // Base untouched; Desktop still paints the base box where it was.
    expect(await editor.style('inset')).toEqual(base0);
    const deskF1 = await localBox(editor, 'inset', 'frame', s, 'desktop');
    expect(near(deskF1.x, 40, 1) && near(deskF1.y, 40, 1) && near(deskF1.width, 200, 1), `desktop copy ${JSON.stringify(deskF1)}`).toBe(true);
    expect(deskF1).toEqual(deskF0);
    expect(await editor.attr('inset', 'data-pinned')).toBe('true');
    await expect(editor).toUndoInOneStep(before);
  });

  test('DND-040 master child centred and unpinned R/B on variant-1 only: a variant-1 drag commits only that variant\'s pins, no lift jump', { tag: ['@p1', '@dnd', '@cmp', '@tiles'] }, async ({ editor }) => {
    await editor.load(MASTER_CENTRED);
    await openMaster(editor, CARD);
    const page = editor.page();
    const code0 = await editor.code(CARD);
    const def0 = variantEntry(code0, 'pin', 'default');
    const inline0 = (await editor.source(CARD)).byId.get('pin')!.style;
    // Zoom onto the variant-1 card: the child rests on the card's centre, so
    // the sticky centre snap must be smaller than the 10 px lift probe.
    const s = await zoomOnto(editor, 'card-root', 320, { vpId: 'variant-1' });
    const root = await editor.nodeBoxIn('variant-1', 'card-root');
    const a = await editor.nodeBoxIn('variant-1', 'pin');
    // variant-1 paints the 80×50 box centred in the 320×220 card.
    expect(near(a.x + a.width / 2, root.x + root.width / 2, 2) && near(a.y + a.height / 2, root.y + root.height / 2, 2), 'centred on variant-1').toBe(true);
    await prime(editor, 'pin', 'variant-1');
    const from = { x: a.x + a.width / 2 + 2, y: a.y + a.height / 2 + 2 };

    let early: Box | null = null;
    let d = await press(page, from);
    try {
      // Lift: a 10 px move must move the box 10 px (not by half its size).
      await glide(page, from, { x: from.x + 10 * s, y: from.y }, 6, async (_p, i) => {
        if (i === 6) early = await quickBox(await editor.nodeIn('variant-1', 'pin'));
      });
      await glide(page, { x: from.x + 10 * s, y: from.y }, { x: from.x + 30 * s, y: from.y + 20 * s }, 14);
      d.cur = { x: from.x + 30 * s, y: from.y + 20 * s };
      await d.hold(8);
    } finally {
      await release(editor, d);
    }
    expect(early).not.toBeNull();
    expect(Math.abs((early!.x - a.x) - 10 * s), `lift moved ${(early!.x - a.x) / s} CSS px for a 10 px move`).toBeLessThan(3 * s);
    expect(Math.abs(early!.y - a.y)).toBeLessThan(3 * s);

    const code1 = await editor.code(CARD);
    await expect.poll(async () => variantEntry(await editor.code(CARD), 'pin', 'variant-1')?.left).not.toBe('50%');
    const v1 = variantEntry(await editor.code(CARD), 'pin', 'variant-1')!;
    const b = await editor.nodeBoxIn('variant-1', 'pin');
    const dx = (b.x - a.x) / s, dy = (b.y - a.y) / s;
    expect(Math.abs(dx - 30) < 6 && Math.abs(dy - 20) < 6, `variant-1 child followed: ${dx}, ${dy}`).toBe(true);
    // Only variant-1's own pins were committed, still in %.
    expect(unitOf(v1.left)).toBe('%');
    expect(unitOf(v1.top)).toBe('%');
    expect(Math.abs(parseFloat(v1.left) - (50 + (dx / 320) * 100))).toBeLessThan(0.6);
    expect(Math.abs(parseFloat(v1.top) - (50 + (dy / 220) * 100))).toBeLessThan(0.6);
    // Not: all four sides re-committed in px.
    expect(v1.right ?? 'auto').toBe('auto');
    expect(v1.bottom ?? 'auto').toBe('auto');
    expect(v1.transform).toBe('translate(-50%, -50%)');
    // The default entry's pins and the inline base are untouched. (The write
    // seeds the keys variant-1 animates — width/height — into `default` as
    // their CSS initials, `auto`, so a pass back to default resets them on
    // live: generator-styles readBaseValues. Not a pin, and paints the same.)
    const def1 = variantEntry(code1, 'pin', 'default')!;
    for (const side of ['left', 'top', 'right', 'bottom']) expect(def1[side], `default ${side}`).toBe(def0![side]);
    for (const k of Object.keys(def1).filter(k => !(k in def0!))) expect(def1[k], `seeded default ${k}`).toBe('auto');
    expect((await editor.source(CARD)).byId.get('pin')!.style).toEqual(inline0);
    await expect(editor).toUndoInOneStep(code0, { path: CARD });
  });
});

// ─── DND-041 ──────────────────────────────────────────────────────────

test('DND-041 Shift locks an absolute child to X past 5px; releasing Shift frees Y on the next move', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(CHIP));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame', 600);
  const before = await editor.code();
  const b0 = await editor.nodeBox('chip');
  const c = center(b0);
  let under: Box, locked: Box, stillLocked: Box, unlocked: Box;
  await page.keyboard.down('Shift');
  const d = await press(page, c);
  try {
    // Under 5 CSS px: no lock yet, both coordinates follow.
    await d.moveTo({ x: c.x + 4 * s, y: c.y + 3 * s }, 4);
    await d.hold(3);
    under = await editor.nodeBox('chip');
    // Past 5 px with X dominant: locked to X.
    await d.moveTo({ x: c.x + 60 * s, y: c.y + 20 * s }, 16);
    await d.hold(3);
    locked = await editor.nodeBox('chip');
    await d.moveTo({ x: c.x + 90 * s, y: c.y + 40 * s }, 10);
    await d.hold(3);
    stillLocked = await editor.nodeBox('chip');
    // Release Shift: the next move frees Y.
    await page.keyboard.up('Shift');
    await d.moveTo({ x: c.x + 92 * s, y: c.y + 46 * s }, 2);
    await d.hold(3);
    unlocked = await editor.nodeBox('chip');
  } finally {
    await page.keyboard.up('Shift').catch(() => {});
    await release(editor, d);
  }
  expect(Math.abs((under.x - b0.x) - 4 * s), 'x follows under 5px').toBeLessThan(1.5);
  expect(Math.abs((under.y - b0.y) - 3 * s), 'y follows under 5px').toBeLessThan(1.5);
  expect(Math.abs(locked.y - b0.y), 'y pinned once locked').toBeLessThan(1);
  expect(Math.abs(stillLocked.y - b0.y), 'only X changes while locked').toBeLessThan(1);
  expect(stillLocked.x - locked.x).toBeGreaterThan(25 * s);
  expect(Math.abs((unlocked.y - b0.y) - 46 * s), 'releasing Shift frees Y on the next move').toBeLessThan(1.5);
  await expectPins(editor, 'chip', { left: '132px', top: '86px', right: null, bottom: null }, 'committed after the unlock');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-042 ──────────────────────────────────────────────────────────

test('DND-042 pin lines and badges track a dynamic-pin drag live across band switches without crashing', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(CHIP));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame', 600);
  await clickNode(editor, 'chip');
  expect(await editor.selection()).toEqual(['chip']);
  await expect.poll(async () => (await pinLines(page)).lines).toBe(2);
  const f = await editor.nodeBox('frame');

  /** Pin line directions from the drawn geometry, checked against the chip's live box. */
  const read = async () => {
    const chip = await editor.nodeBox('chip');
    const lines = await page.evaluate(() => [...document.querySelectorAll('svg[data-pin-constraint-lines] line')].map(l => ({
      x1: Number(l.getAttribute('x1')), y1: Number(l.getAttribute('y1')), x2: Number(l.getAttribute('x2')), y2: Number(l.getAttribute('y2')),
    })));
    const sides: string[] = [];
    let attached = true;
    for (const l of lines) {
      if (near(l.y1, l.y2, 0.5)) {
        // Horizontal: left pin runs frame-left → chip-left; right pin chip-right → frame-right.
        if (near(Math.min(l.x1, l.x2), f.x, 2)) { sides.push('left'); attached &&= near(Math.max(l.x1, l.x2), chip.x, 3); }
        else { sides.push('right'); attached &&= near(Math.min(l.x1, l.x2), chip.x + chip.width, 3); }
      } else {
        if (near(Math.min(l.y1, l.y2), f.y, 2)) { sides.push('top'); attached &&= near(Math.max(l.y1, l.y2), chip.y, 3); }
        else { sides.push('bottom'); attached &&= near(Math.min(l.y1, l.y2), chip.y + chip.height, 3); }
      }
    }
    return { sides: sides.sort().join(','), attached, n: lines.length };
  };
  /** Active pin badges (T/L/R/B buttons) in the Position panel. */
  const badges = async () => (await page.locator('div.grid.grid-cols-3.grid-rows-3 button').evaluateAll(els => els
    .filter(e => /^[TLRB]$/.test((e.textContent ?? '').trim()) && e.className.includes('bg-[var(--accent)]'))
    .map(e => (e.textContent ?? '').trim()))).sort().join(',');
  const badgeSets = new Set<string>();

  const seen = new Set<string>();
  let detached = 0;
  let frames = 0;
  const before = await editor.code();
  // Top-left → bottom-left (crossing into the middle and bottom thirds) → back up.
  await dragBy(editor, 'chip', 0, 300, s, {
    steps: 40,
    onFrame: async () => {
      const r = await read();
      frames++;
      if (r.n > 0) seen.add(r.sides);
      if (r.n > 0 && !r.attached) detached++;
      badgeSets.add(await badges());
    },
    during: async (d) => {
      await d.moveTo({ x: d.cur.x, y: d.cur.y - 250 * s }, 30, async () => {
        const r = await read();
        frames++;
        if (r.n > 0) seen.add(r.sides);
        if (r.n > 0 && !r.attached) detached++;
        badgeSets.add(await badges());
      });
      await d.hold(4);
    },
  });
  // Left+top at the start, left+bottom in the bottom third.
  expect([...seen], `pin-side sets seen while dragging: ${[...seen]}`).toEqual(expect.arrayContaining(['left,top', 'bottom,left']));
  expect(detached, `frames where a pin line was not attached to the chip (of ${frames})`).toBeLessThanOrEqual(2);
  // The Position panel's pin badges flip live too (top-left: L+T; bottom third: B+L).
  expect([...badgeSets], `badge sets seen: ${[...badgeSets].join(' | ')}`).toEqual(expect.arrayContaining(['L,T', 'B,L']));
  // The app is alive: still selected, lines drawn for the final pins, a click still works.
  await expect.poll(async () => (await pinLines(page)).lines).toBe(2);
  expect(await editor.selection()).toEqual(['chip']);
  await expectPins(editor, 'chip', { left: '40px', top: '90px' }, 'final drop', { pxTol: 2 });
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-043 / DND-044 ────────────────────────────────────────────────

const STAR = (style: string) => `    <svg data-id="star" data-name="Star" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" style={{ ${style}, width: '80px', height: '80px', display: 'block' }}><path data-id="star-path" d="M11 0 L13 9 L22 11 L13 13 L11 22 L9 13 L0 11 L9 9 Z" fill="#A9FF55" /></svg>`;

test('DND-043 an SVG shape in a frame keeps the canonical model: left/top px only in the middle and the bottom', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(STAR(`position: 'absolute', left: '40px', top: '40px'`)));
  const s = await zoomOnto(editor, 'frame', 600);
  // Middle of the frame (a div would write left/top in %).
  await dragBy(editor, 'star', 220, 120, s);
  await expectPins(editor, 'star', { left: '260px', top: '160px', right: null, bottom: null }, 'middle', { pxTol: 2 });
  // Bottom third (a div would pin the bottom).
  const before = await editor.code();
  await dragBy(editor, 'star', 150, 150, s);
  await expectPins(editor, 'star', { left: '410px', top: '310px', right: null, bottom: null }, 'bottom', { pxTol: 2 });
  const st = await editor.style('star');
  expect(st.transform, 'no centring translate').toBeUndefined();
  for (const side of ['left', 'top'] as const) expect(unitOf(st[side])).toBe('px');
  expect(await editor.parentOf('star')).toBe('frame');
  await expect(editor).toUndoInOneStep(before);
});

test('DND-044 a static top-level SVG in a frame is re-baselined at its painted spot and commits position absolute', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // Static: the stale inline left/top (300, 200) are ignored; it paints at the frame's padding (50, 50).
  await editor.load(framePage(STAR(`position: 'static', left: '300px', top: '200px'`), { frameExtra: `, padding: '50px'` }));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame');
  const before = await editor.code();
  const a = await localBox(editor, 'star', 'frame', s);
  expect(near(a.x, 50, 1.5) && near(a.y, 50, 1.5), `static star paints at the padding, got ${JSON.stringify(a)}`).toBe(true);
  let early: Box | null = null;
  const b0 = await editor.nodeBox('star');
  await dragBy(editor, 'star', 40, 0, s, {
    steps: 20,
    onFrame: async () => { if (!early) early = await localBox(editor, 'star', 'frame', s); },
  });
  // No lift jump to the stale inline position.
  expect(early).not.toBeNull();
  expect(near(early!.y, 50, 2) && early!.x < 60, `first drag frame at ${JSON.stringify(early)}`).toBe(true);
  const st = await pollPins(editor, 'star', { left: '90px', top: '50px' }, { pxTol: 1.5 });
  expect(pinsMatch(st, { left: '90px', top: '50px', right: null, bottom: null }, 1.5), `committed ${JSON.stringify(st)}`).toBe(true);
  await expect(editor).toHaveStyle('star', 'position', 'absolute');
  const b1 = await editor.nodeBox('star');
  expect(Math.abs((b1.x - b0.x) - 40 * s)).toBeLessThan(2);
  expect(Math.abs(b1.y - b0.y)).toBeLessThan(2);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-045 ──────────────────────────────────────────────────────────

const LETTERS = seed(pageSrc({
  root: `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}></div>`,
  canvas: `  <svg data-id="grp" data-name="Group" data-canvas-node="true" viewBox="0 0 250 64" preserveAspectRatio="none" style={{ position: "absolute", left: "-400px", top: "150px", width: "250px", height: "64px", overflow: "visible" }}><svg data-id="grp-s0" data-name="LetterA" x="0" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s0-g0" d="M0 0 H70 V64 H0 Z" fill="#3b82f6" /></svg><svg data-id="grp-s1" data-name="LetterB" x="90" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s1-g0" d="M0 0 H70 V64 H0 Z" fill="#ef4444" /></svg><svg data-id="grp-s2" data-name="LetterC" x="180" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s2-g0" d="M0 0 H70 V64 H0 Z" fill="#22c55e" /></svg></svg>`,
}));

interface Wrapper { viewBox: string; left: number; top: number; x: number; y: number }

async function sourceWrapper(editor: Editor): Promise<Wrapper> {
  const src = await editor.source();
  const g = src.byId.get('grp')!;
  const c = src.byId.get('grp-s1')!;
  return { viewBox: g.attrs.viewBox, left: px(g.style.left), top: px(g.style.top), x: Number(c.attrs.x), y: Number(c.attrs.y) };
}
async function domWrapper(editor: Editor): Promise<Wrapper> {
  return editor.node('grp').evaluate((el) => {
    const c = el.querySelector('[data-id="grp-s1"]')!;
    return {
      viewBox: el.getAttribute('viewBox') ?? '',
      left: parseFloat((el as unknown as HTMLElement).style.left), top: parseFloat((el as unknown as HTMLElement).style.top),
      x: parseFloat(c.getAttribute('x') ?? 'NaN'), y: parseFloat(c.getAttribute('y') ?? 'NaN'),
    };
  });
}
function sameWrapper(dom: Wrapper, src: Wrapper, label: string): void {
  expect(dom.viewBox, `${label}: viewBox`).toBe(src.viewBox);
  for (const k of ['left', 'top', 'x', 'y'] as const) expect(Math.abs(dom[k] - src[k]), `${label}: ${k} dom=${dom[k]} src=${src[k]}`).toBeLessThanOrEqual(1);
}

test('DND-045 a letter of an SVG group dragged twice: x/y attrs, no snap, group refits, DOM equals source, the second drag tracks the mouse', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LETTERS, { fit: true });
  const page = editor.page();
  await expect(editor.node('grp')).toBeVisible();
  sameWrapper(await domWrapper(editor), await sourceWrapper(editor), 'fresh load');

  const dragLetter = async (dx: number, dy: number) => {
    // Setup: group isolation (the double-click drill-in state).
    await page.evaluate(() => (window as any).__e2e.isolateGroupChild('grp', 'grp-s1'));
    await editor.settled();
    const b = await editor.nodeBox('grp-s1');
    const from = center(b);
    let mid: Pt | null = null;
    let snaps = 0;
    const d = await press(page, from);
    try {
      await glide(page, from, { x: from.x + dx, y: from.y + dy }, 20, async (_p, i) => {
        if ((await guides(page)).length) snaps++;
        if (i === 12) mid = center(await editor.nodeBox('grp-s1'));
      });
      d.cur = { x: from.x + dx, y: from.y + dy };
      await d.hold(4);
    } finally {
      await release(editor, d);
    }
    return { from, mid: mid!, snaps, startBox: b };
  };

  // ── Drag 1: up-right, so the refit rewrites the box and re-bases siblings.
  const before1 = await editor.code();
  const r1 = await dragLetter(90, -55);
  expect(r1.snaps, 'group children never snap').toBe(0);
  await expect.poll(async () => (await sourceWrapper(editor)).viewBox).not.toBe('0 0 250 64');
  await editor.settled();
  sameWrapper(await domWrapper(editor), await sourceWrapper(editor), 'after drag 1');
  // Written as x/y ATTRIBUTES on the letter, no CSS position.
  const s1 = (await editor.source()).byId.get('grp-s1')!;
  expect(s1.attrs.x).toBeDefined();
  expect(s1.style.left).toBeUndefined();
  expect(await editor.parentOf('grp-s1')).toBe('grp');
  expect(before1).not.toBe(await editor.code());

  // ── Drag 2: tracks the mouse from the first ticks (not: offset by a stale refit).
  const before2 = await editor.code();
  const r2 = await dragLetter(-120, 70);
  expect(r2.snaps).toBe(0);
  const progress = 12 / 20;
  expect(Math.abs(r2.mid.x - (r2.from.x - 120 * progress)), `drag 2 mid x ${r2.mid.x}`).toBeLessThanOrEqual(6);
  expect(Math.abs(r2.mid.y - (r2.from.y + 70 * progress)), `drag 2 mid y ${r2.mid.y}`).toBeLessThanOrEqual(6);
  await editor.settled();
  sameWrapper(await domWrapper(editor), await sourceWrapper(editor), 'after drag 2');
  const post = await editor.nodeBox('grp-s1');
  expect(Math.abs((post.x - r2.startBox.x) + 120)).toBeLessThanOrEqual(6);
  expect(Math.abs((post.y - r2.startBox.y) - 70)).toBeLessThanOrEqual(6);
  await expect(editor).toUndoInOneStep(before2);
});

// ─── DND-046 ──────────────────────────────────────────────────────────

/** The middle letter is rotated 20° about its own centre through its
 *  `transform` attribute (the shape RotateManager writes for group children). */
const ROTATED_LETTER = seed(pageSrc({
  root: `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}></div>`,
  canvas: `  <svg data-id="grp" data-name="Group" data-canvas-node="true" viewBox="0 0 250 64" preserveAspectRatio="none" style={{ position: "absolute", left: "-400px", top: "150px", width: "250px", height: "64px", overflow: "visible" }}><svg data-id="grp-s0" data-name="LetterA" x="0" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s0-g0" d="M0 0 H70 V64 H0 Z" fill="#3b82f6" /></svg><svg data-id="grp-s1" data-name="LetterB" x="90" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible" transform="rotate(20 125 32)"><path data-id="grp-s1-g0" d="M0 0 H70 V64 H0 Z" fill="#ef4444" /></svg><svg data-id="grp-s2" data-name="LetterC" x="180" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s2-g0" d="M0 0 H70 V64 H0 Z" fill="#22c55e" /></svg></svg>`,
}));

const ROT_RE = /^rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/;

test('DND-046 a rotated SVG group child keeps its rotation mid-drag and on commit, its pivot moving with it', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROTATED_LETTER, { fit: true });
  const page = editor.page();
  const s = (await editor.nodeBox('grp-s0')).width / 70;
  const rotatedSize = (b: Box) => b.width / s > 76 && b.height / s > 70; // AABB of a 70×64 box at 20° ≈ 87.7×83.9
  const a = await editor.nodeBox('grp-s1');
  expect(rotatedSize(a), `painted rotated at rest: ${a.width / s}×${a.height / s}`).toBe(true);
  const before = await editor.code();

  await page.evaluate(() => (window as any).__e2e.isolateGroupChild('grp', 'grp-s1'));
  await editor.settled();
  const from = center(a);
  const mids: Array<{ box: Box; attr: string; x: number; y: number }> = [];
  const d = await press(page, from);
  try {
    await glide(page, from, { x: from.x + 60, y: from.y + 30 }, 16, async (_p, i) => {
      if (i % 4 !== 0) return;
      const dom = await editor.node('grp-s1').evaluate(el => ({ attr: el.getAttribute('transform') ?? '', x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')) }));
      mids.push({ box: await editor.nodeBox('grp-s1'), ...dom });
    });
    d.cur = { x: from.x + 60, y: from.y + 30 };
    await d.hold(4);
  } finally {
    await release(editor, d);
  }
  // Mid-drag: still rotated (not: flattened by a CSS translate), pivot = the child's centre.
  for (const m of mids) {
    expect(rotatedSize(m.box), `mid-drag painted ${m.box.width / s}×${m.box.height / s}`).toBe(true);
    const r = ROT_RE.exec(m.attr);
    expect(r, `mid-drag transform attr "${m.attr}"`).not.toBeNull();
    expect(Number(r![1])).toBeCloseTo(20, 1);
    expect(Math.abs(Number(r![2]) - (m.x + 35)), `pivot x follows (${m.attr}, x=${m.x})`).toBeLessThan(1.5);
    expect(Math.abs(Number(r![3]) - (m.y + 32)), `pivot y follows (${m.attr}, y=${m.y})`).toBeLessThan(1.5);
  }
  expect(mids.length).toBeGreaterThan(2);
  expect(mids[mids.length - 1].x - mids[0].x, 'the child moved during the drag').toBeGreaterThan(10);

  // Committed: rotation kept, pivot at the child's (possibly re-based) centre.
  await expect.poll(async () => (await editor.code()) !== before).toBe(true);
  await editor.settled();
  const c = (await editor.source()).byId.get('grp-s1')!;
  const r = ROT_RE.exec(c.attrs.transform ?? '');
  expect(r, `committed transform "${c.attrs.transform}"`).not.toBeNull();
  expect(Number(r![1])).toBeCloseTo(20, 1);
  expect(Math.abs(Number(r![2]) - (Number(c.attrs.x) + Number(c.attrs.width) / 2))).toBeLessThan(1.5);
  expect(Math.abs(Number(r![3]) - (Number(c.attrs.y) + Number(c.attrs.height) / 2))).toBeLessThan(1.5);
  const b = await editor.nodeBox('grp-s1');
  expect(rotatedSize(b), 'still painted rotated after the drop').toBe(true);
  expect(Math.abs((b.x + b.width / 2) - (from.x + 60)), 'centre landed under the release (x)').toBeLessThan(6);
  expect(Math.abs((b.y + b.height / 2) - (from.y + 30)), 'centre landed under the release (y)').toBeLessThan(6);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-047 ──────────────────────────────────────────────────────────

const ICONS = seed(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}></div>` }), { [GLYPHS_PATH]: GLYPHS_ICON_SET });

test('DND-047 icon-set master: a card drag writes iconConfig px and never exits; a shape exits to the canvas, then enters the sibling card in px', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ICONS);
  const page = editor.page();
  await editor.openFile(GLYPHS_PATH);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, GLYPHS_PATH);
  await editor.settled();
  await editor.fitCamera();
  await boxSettled(editor, 'icon-1');
  const s = (await editor.nodeBox('icon-1')).width / 240;
  const cfg = async () => {
    const m = /const iconConfig = (\[[\s\S]*?\]);/.exec(await editor.code(GLYPHS_PATH))![1];
    return m;
  };
  const entry = async (name: string) => {
    const m = new RegExp(`\\{ name: '${name}'[^}]*\\}`).exec(await cfg())![0];
    return { x: /x: ([^,]+)/.exec(m)![1], y: /y: ([^,]+)/.exec(m)![1] };
  };

  // ── 1 · Card drag: press on the card's own fill (clear of its shape).
  let m = await mark(page);
  const card = await editor.nodeBox('icon-1');
  const cardStyle0 = await editor.style('icon-1', GLYPHS_PATH);
  await dragBy(editor, 'icon-1', 40, 60, s, { from: { x: card.x + card.width * 0.85, y: card.y + card.height * 0.85 } });
  expect(await lastStrategy(page, m)).toBe('absolute-in-frame');
  await expect.poll(() => entry('icon-1')).toEqual({ x: '40', y: '60' });
  expect(await cfg(), 'no percent anchor reaches iconConfig').not.toContain('%');
  expect(await editor.style('icon-1', GLYPHS_PATH), 'the card JSX carries no position').toEqual(cardStyle0);
  expect(await editor.parentOf('icon-1', GLYPHS_PATH)).toBe('root');
  expect(await since(page, m, '^abs-in-frame:(exit-begin|grandparent-reparent-begin)$'), 'the card never exits').toEqual([]);

  // ── 2 · A shape dragged down out of its card becomes a canvas node.
  m = await mark(page);
  await dragBy(editor, 'shape-a', 0, 200, s, { steps: 36 });
  await expect.poll(() => editor.attr('shape-a', 'data-canvas-node', GLYPHS_PATH)).toBe('true');
  expect(await editor.parentOf('shape-a', GLYPHS_PATH)).toBeNull();
  expect((await editor.childIds('icon-1', GLYPHS_PATH))).not.toContain('shape-a');
  expect(await since(page, m, '^abs-in-frame:exit-begin$')).not.toEqual([]);

  // ── 3 · …then into the sibling card: a child of icon-2 at px insets (dynamic pins off).
  const before = await editor.code(GLYPHS_PATH);
  const sa = await editor.nodeBox('shape-a');
  const c2 = await editor.nodeBox('icon-2');
  // Aim the shape's centre at the card's centre (the middle band, where a page would write %).
  const tgt = center(c2);
  await dragBy(editor, 'shape-a', (tgt.x - (sa.x + sa.width / 2)) / s, (tgt.y - (sa.y + sa.height / 2)) / s, s, { steps: 40, hold: 12 });
  await expect.poll(() => editor.parentOf('shape-a', GLYPHS_PATH)).toBe('icon-2');
  expect(await editor.attr('shape-a', 'data-canvas-node', GLYPHS_PATH)).toBeNull();
  const st = await editor.style('shape-a', GLYPHS_PATH);
  expect(unitOf(st.left), `left ${st.left}`).toBe('px');
  expect(unitOf(st.top), `top ${st.top}`).toBe('px');
  expect(st.right).toBeUndefined();
  expect(st.bottom).toBeUndefined();
  expect(Math.abs(px(st.left) - 80)).toBeLessThan(4);
  expect(Math.abs(px(st.top) - 80)).toBeLessThan(4);
  await expect(editor).toUndoInOneStep(before, { path: GLYPHS_PATH });
});

// ─── DND-048 ──────────────────────────────────────────────────────────

const OVERFLOW = `
    <div data-id="wide" data-name="Wide" style={{ position: 'absolute', left: '-50px', top: '20px', width: '700px', height: '100px', backgroundColor: '#66ccff' }}></div>
    <div data-id="low" data-name="Low" style={{ position: 'absolute', left: '450px', top: '340px', width: '100px', height: '100px', backgroundColor: '#ff6688' }}></div>`;

test('DND-048 overflow guards: a child wider than its frame, or overflowing its bottom, keeps left/top px whatever the band', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(OVERFLOW));
  const s = await zoomOnto(editor, 'frame', 600);
  // Wider than the frame, centre lands in the middle third: still left px.
  const fb = await editor.nodeBox('frame');
  await dragBy(editor, 'wide', 30, 0, s, { from: { x: fb.x + 300 * s, y: fb.y + 70 * s } });
  await expectPins(editor, 'wide', { left: '-20px', top: '20px', right: null, bottom: null }, 'wider than the frame');
  // Bottom edge past the frame's bottom, centre in the bottom third: top px, never a negative bottom.
  const before = await editor.code();
  await dragBy(editor, 'low', -20, 6, s);
  const have = await expectPins(editor, 'low', { left: '430px', top: '346px', right: null, bottom: null }, 'overflowing the bottom');
  expect(unitOf(have.top)).toBe('px');
  for (const id of ['wide', 'low']) {
    const st = await editor.style(id);
    for (const side of ['right', 'bottom'] as const) expect(st[side], `${id} ${side}`).toBeUndefined();
    expect(await editor.parentOf(id)).toBe('frame');
  }
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-049 ──────────────────────────────────────────────────────────

const PANEL_KIDS = `
    <div data-id="pc" data-name="Pc" data-pinned="true" style={{ position: 'absolute', left: '100px', top: '80px', width: '120px', height: '80px', backgroundColor: '#66ccff' }}></div>
    <div data-id="rot" data-name="Rot" data-pinned="true" style={{ position: 'absolute', left: '300px', top: '200px', width: '120px', height: '80px', backgroundColor: '#ff6688', transform: 'rotate(30deg)' }}></div>`;

/** The Position panel's T/L/R/B fields (in that DOM order: top, left, right, bottom). */
async function pinFields(editor: Editor): Promise<{ top: number; left: number; right: number; bottom: number } | null> {
  const page = editor.page();
  const grid = page.locator('div.grid.grid-cols-3.grid-rows-3');
  if (!(await grid.count())) return null;
  const vals = await page.locator('div.flex.flex-col.w-full').filter({ has: grid }).last().locator('input').evaluateAll(els => els.map(e => Number((e as HTMLInputElement).value)));
  if (vals.length < 4) return null;
  return { top: vals[0], left: vals[1], right: vals[2], bottom: vals[3] };
}

test('DND-049 Position fields show live layout-box values during a drag (rotated too) and settle on the committed numbers', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(framePage(PANEL_KIDS));
  const page = editor.page();
  const s = await zoomOnto(editor, 'frame', 600);

  let before = '';
  for (const [id, L0, T0] of [['pc', 100, 80], ['rot', 300, 200]] as const) {
    await clickNode(editor, id);
    before = await editor.code();
    await expect.poll(() => pinFields(editor)).toMatchObject({ left: L0, top: T0 });
    const samples: Array<{ f: { top: number; left: number; right: number; bottom: number } | null; box: Box }> = [];
    await dragBy(editor, id, 40, 30, s, {
      steps: 24,
      onFrame: async () => { samples.push({ f: await pinFields(editor), box: await localBox(editor, id, 'frame', s) }); },
    });
    // Mid-drag: the fields follow the LAYOUT box (left/top as CSS would place
    // it), not the painted AABB — for the rotated node they differ by ~12px.
    const live = samples.filter(x => x.f);
    expect(live.length).toBeGreaterThan(10);
    let lagging = 0;
    for (const x of live.slice(4)) {
      const layoutLeft = id === 'rot' ? x.box.x + (x.box.width - 120) / 2 : x.box.x;
      if (Math.abs(x.f!.left - layoutLeft) > 2) lagging++;
    }
    expect(lagging, `frames where L disagreed with the layout box (of ${live.length - 4})`).toBeLessThanOrEqual(3);
    // Never the painted AABB numbers for the rotated one.
    if (id === 'rot') {
      const aabbLike = live.filter(x => Math.abs(x.f!.left - Math.round(x.box.x)) <= 1 && Math.abs(x.box.x - (x.box.x + (x.box.width - 120) / 2)) > 3);
      expect(aabbLike.length, 'frames showing the rotated AABB left').toBeLessThanOrEqual(1);
    }
    // Settles on the committed numbers, and stays there (no jump back on mouseup).
    const st = await pollPins(editor, id, { left: `${L0 + 40}px`, top: `${T0 + 30}px` }, { pxTol: 1.5 });
    const settled: number[] = [];
    for (let i = 0; i < 8; i++) { const f = await pinFields(editor); settled.push(f?.left ?? NaN); await page.waitForTimeout(60); }
    expect(settled.every(v => Math.abs(v - px(st.left)) <= 1), `L after mouseup: ${settled.join(',')} vs source ${st.left}`).toBe(true);
    expect(Math.abs((await pinFields(editor))!.top - px(st.top))).toBeLessThanOrEqual(1);
  }
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-050 ──────────────────────────────────────────────────────────

/** A canvas frame (no parent → its children exit straight to the canvas with
 *  the "any corner outside" predicate), the chip 4 px from its left edge. */
const EDGE = seed(pageSrc({
  root: `<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}></div>`,
  canvas: `
  <div data-id="box" data-name="Box" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '100px', width: '160px', height: '120px', backgroundColor: '#1a1a3a' }}>
    <div data-id="edge" data-name="Edge" style={{ position: 'absolute', left: '4px', top: '45px', width: '40px', height: '30px', backgroundColor: '#66ccff' }}></div>
  </div>`,
}));

test('DND-050 entry grace: 2px out in the first frames does not exit; afterwards the first frame with a corner outside does', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(EDGE);
  const page = editor.page();
  await zoomOnto(editor, 'box', 160);
  // ≥400%: the 5-screen-px snap threshold is then ~1 CSS px, so 2 px out
  // isn't pulled back onto the frame's left edge by the snap.
  const s = await pinchTo(editor, 'box', 4);
  expect(s).toBeGreaterThan(3.9);
  const box = await editor.nodeBox('box');
  const edgeLeft = async () => ((await editor.nodeBox('edge')).x - box.x) / s;
  let m = 0;
  const exits = async () => (await since(page, m, '^abs-in-frame:exit-begin$')).length;
  const step = async (d: Awaited<ReturnType<typeof press>>, x: number, y: number) => d.moveTo({ x, y }, 1);

  // ── Gesture 1: out within the first frame, back in before the grace ends,
  // then out again — the exit lands on the first frame with a corner outside.
  let b0 = await editor.nodeBox('edge');
  let from = { x: b0.x + b0.width * 0.7, y: b0.y + b0.height / 2 };
  m = await mark(page);
  let d = await press(page, from);
  let exitFrame = -1;
  try {
    await step(d, from.x - 6 * s, from.y);                       // lift: left 4 → −2
    for (let i = 0; i < 4; i++) await step(d, from.x - 6 * s, from.y + (i % 2));
    expect(await edgeLeft(), 'poking 2 px out').toBeLessThan(-1);
    expect(await exits(), 'no exit inside the grace window').toBe(0);
    expect(await parentId(editor, 'edge')).toBe('box');
    for (let i = 0; i < 14; i++) await step(d, from.x - 2 * s, from.y + (i % 2)); // back inside past the grace
    expect(await exits()).toBe(0);
    for (let i = 0; i < 6 && exitFrame < 0; i++) {
      await step(d, from.x - 7 * s - i, from.y);
      if (await exits()) exitFrame = i;
    }
    await d.hold(4);
  } finally {
    await release(editor, d);
  }
  // Frame 0 is the first one outside; the exit reads the rect the bridge
  // synced on the previous frame, so it may land one frame later.
  expect(exitFrame, 'frame index (after going out) the exit fired on').toBeGreaterThanOrEqual(0);
  expect(exitFrame).toBeLessThanOrEqual(1);
  await expect.poll(() => editor.attr('edge', 'data-canvas-node')).toBe('true');
  expect(await editor.parentOf('edge')).toBeNull();

  // ── Gesture 2 (ROW-ADJUSTED): pushed out during the grace and HELD out. The
  // exit predicate samples "already overflowing" on its first frame after the
  // grace — the element is out then, so it is treated like a pre-overflowing
  // one (DND-037) and exits once the CURSOR leaves the frame, not on that frame.
  await editor.undo();
  await expect.poll(() => editor.parentOf('edge')).toBe('box');
  await editor.settled();
  b0 = await editor.nodeBox('edge');
  from = { x: b0.x + b0.width * 0.7, y: b0.y + b0.height / 2 };
  const before2 = await editor.code();
  m = await mark(page);
  d = await press(page, from);
  let exitedWithCursorAt: number | null = null;
  try {
    await step(d, from.x - 6 * s, from.y);
    for (let i = 0; i < 24; i++) await step(d, from.x - 6 * s - (i % 2), from.y);
    expect(await edgeLeft()).toBeLessThan(-1);
    expect(await exits(), 'held out with the cursor inside: still parented').toBe(0);
    expect(await parentId(editor, 'edge')).toBe('box');
    // Now take the cursor out of the frame's left edge.
    for (let i = 1; i <= 80 && exitedWithCursorAt === null; i++) {
      const x = from.x - 6 * s - i * 3;
      await step(d, x, from.y);
      if (await exits()) exitedWithCursorAt = x;
    }
    await d.hold(4);
  } finally {
    await release(editor, d);
  }
  expect(exitedWithCursorAt, 'exited once the cursor left').not.toBeNull();
  // …and not before: the cursor was past the frame's left edge (one frame of
  // rect-sync latency allowed).
  expect(exitedWithCursorAt!).toBeLessThan(box.x + 4);
  await expect.poll(() => editor.attr('edge', 'data-canvas-node')).toBe('true');
  await expect(editor).toUndoInOneStep(before2);
});

// ─── DND-051 ──────────────────────────────────────────────────────────

/** A small slot in a flex row with a rotated child whose AABB pokes past the slot. */
const SLOT = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '80px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="slot" data-name="Slot" style={{ position: 'relative', width: '240px', height: '180px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="tilted" data-name="Tilted" style={{ position: 'absolute', left: '70px', top: '60px', width: '100px', height: '60px', backgroundColor: '#ffcc33', transform: 'rotate(30deg)' }}></div>
  </div>
  <div data-id="other" data-name="Other" style={{ position: 'relative', width: '240px', height: '180px', backgroundColor: '#2a2a4a', flex: '0 0 auto' }}></div>
</div>` }));

test('DND-051 a rotated child in a small flex slot: the exit is cursor-based, the AABB poking past the slot never bounces it', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(SLOT);
  const page = editor.page();
  const s = await zoomOnto(editor, 'slot', 240);
  const slot = await editor.nodeBox('slot');
  const before = await editor.code();
  const m = await mark(page);
  let parents = new Set<string | null>();
  let poked = 0;
  // +70: the tilted box's AABB (≈117 px wide) pokes ~8 px past the slot's right edge.
  await dragBy(editor, 'tilted', 70, 0, s, {
    steps: 30,
    onFrame: async () => {
      parents.add(await parentId(editor, 'tilted'));
      const b = await editor.nodeBox('tilted');
      if (b.x + b.width > slot.x + slot.width + 1) poked++;
    },
    during: async (d) => {
      // Wiggle along the slot's right edge with the AABB poking out.
      for (let i = 0; i < 12; i++) {
        await d.moveTo({ x: d.cur.x + (i % 2 ? -3 : 3), y: d.cur.y + (i % 3) - 1 }, 1);
        parents.add(await parentId(editor, 'tilted'));
        const b = await editor.nodeBox('tilted');
        if (b.x + b.width > slot.x + slot.width + 1) poked++;
      }
    },
  });
  expect(poked, 'the rotated AABB did poke past the slot').toBeGreaterThan(3);
  expect([...parents], 'parent through every frame').toEqual(['slot']);
  expect(await since(page, m, '^abs-in-frame:(exit-begin|grandparent-reparent-begin)$'), 'no exit while the cursor stayed in the slot').toEqual([]);
  expect((await since(page, m, '^drag:start$')).map(e => e.data.strategy)).toEqual(['absolute-in-frame']);
  expect(await editor.parentOf('tilted')).toBe('slot');
  expect((await editor.style('tilted')).transform).toBe('rotate(30deg)');
  const st = await editor.style('tilted');
  expect(px(st.left)).toBeGreaterThan(100);
  await expect(editor).toUndoInOneStep(before);
});
