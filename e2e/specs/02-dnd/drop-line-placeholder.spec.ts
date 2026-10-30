// DND · Drop line, placeholder and parent highlight (E2E_TEST_PLAN.md §2).

import { test, expect, project, TILE, TILES_VIEWPORT } from '../../fixtures/test';
import {
  drag, assertEngaged, dropLine, parentOutline, placeholders, selectionOverlay, cssColor,
  overlayFrame, traceMark, tracesSince, visualOrder, type OverlayFrame,
  loadSeed, survivesReloads,
} from '../../helpers/d1';

// The shared dev server runs on a loaded machine: give each gesture-heavy test room.
test.describe.configure({ timeout: 180_000 });

/** A non-layout tray holding an absolute chip (+ a peer to snap to), a flex
 *  list with children (60px gaps) and an EMPTY flex frame. */
const TARGETS = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '1000px', padding: '60px', background: '#0d0d1a' }}>
  <div data-id="tray" data-name="Tray" style={{ position: 'relative', width: '600px', height: '240px', background: '#303040', flex: '0 0 auto' }}>
    <div data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '40px', top: '40px', width: '60px', height: '40px', background: '#ffcc33' }}></div>
    <div data-id="peer" data-name="Peer" style={{ position: 'absolute', left: '300px', top: '150px', width: '60px', height: '40px', background: '#33ccff' }}></div>
  </div>
  <div data-id="list" data-name="List" style={{ display: 'flex', flexDirection: 'column', gap: '60px', padding: '20px', width: '600px', background: '#202030', flex: '0 0 auto' }}>
    <div data-id="l1" data-name="L1" style={{ width: '100%', height: '80px', background: '#ff5577', flex: '0 0 auto' }}></div>
    <div data-id="l2" data-name="L2" style={{ width: '100%', height: '80px', background: '#55ffaa', flex: '0 0 auto' }}></div>
  </div>
  <div data-id="empty" data-name="Empty" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '600px', height: '200px', background: '#203020', flex: '0 0 auto' }}></div>
</div>`).build();

/** Touching sections (gap 0) and a small canvas-node floater. */
const CANVAS_NODE_SMALL = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '300px', background: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '300px', background: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '300px', background: '#2a2a4a' }}></div>
</div>`).build();
CANVAS_NODE_SMALL.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-240px', top: '-100px', width: '40px', height: '40px', background: '#ff66cc' }}></div>
</>);
`;

const gapBetween = async (editor: { nodeBox(id: string): Promise<{ x: number; y: number; width: number; height: number }> }, a: string, b: string) => {
  const A = await editor.nodeBox(a);
  const B = await editor.nodeBox(b);
  return { x: A.x + A.width * 0.3, y: (A.y + A.height + B.y) / 2 };
};

test('DND-025 line + target outline over children; outline + empty affordance over an empty frame', { tag: ['@p0', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, TARGETS);
  const page = editor.page();
  const before = await editor.code();
  const overList = await gapBetween(editor, 'l1', 'l2');
  const empty = await editor.nodeBox('empty');
  const since = await traceMark(page);
  const frames: OverlayFrame[] = [];
  const rec = async () => { frames.push(await overlayFrame(page)); };

  await drag(editor, 'chip', async (s, start) => {
    await s.moveTo(overList, 24, rec);
    await s.pump(8, { onFrame: rec });
    await assertEngaged(editor, 'chip', start);
    // Over children: the drop line AND the target's outline, together.
    expect(await dropLine(page)).toMatchObject({ parentId: 'list', insertIndex: 1, orientation: 'horizontal' });
    expect(await parentOutline(page)).toMatchObject({ parentId: 'list', source: 'drag' });

    // Over the EMPTY flex frame: outline + empty-drop affordance, no line.
    await s.moveTo({ x: empty.x + empty.width * 0.4, y: empty.y + empty.height / 2 }, 16);
    await s.pump(8);
    expect(await dropLine(page)).toBeNull();
    expect(await parentOutline(page)).toMatchObject({ parentId: 'empty', source: 'drag' });
    const marks = await tracesSince(page, since, '^drop-line:empty-layout-drop$');
    expect(marks.at(-1)?.data).toMatchObject({ parentId: 'empty' });
  });

  // Every frame that showed a line outlined that SAME container — never the
  // tray the chip came from.
  const withLine = frames.filter(f => f.line);
  expect(withLine.length).toBeGreaterThan(0);
  for (const f of withLine) expect(f.outline).toEqual({ parentId: f.line!.parentId, source: 'drag' });

  // The drop lands inside the empty frame as a flow child.
  await expect.poll(() => editor.parentOf('chip')).toBe('empty');
  const s = await editor.style('chip');
  expect(s.position).toBe('relative');
  expect(s).not.toHaveProperty('left');
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-026 edge magnet between touching sections, no root flash during entry grace', { tag: ['@p1', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, CANVAS_NODE_SMALL);
  const page = editor.page();
  const before = await editor.code();
  const hero = await editor.nodeBox('hero');
  const fl = await editor.nodeBox('floater');
  // Floater fully inside hero, cursor ~11px above the hero/features boundary.
  const at = { x: hero.x + hero.width / 2, y: hero.y + hero.height - fl.height / 2 - 0.3 };
  const since = await traceMark(page);
  let flash = 0;
  const watch = async () => {
    const f = await overlayFrame(page);
    if (f.outline?.source === 'drag' && f.outline.parentId === 'root' && !f.line) flash++;
  };

  await drag(editor, 'floater', async (s) => {
    // Come in from the canvas LEFT of the page, then slide along the boundary
    // zone (crossing hero's interior first would enter hero itself).
    const root = await editor.nodeBox('root');
    await s.moveTo({ x: root.x - 60, y: at.y }, 12);
    await s.moveTo(at, 24, watch);
    await s.pump(20, { axis: 'x', onFrame: watch });
    expect(await dropLine(page)).toMatchObject({ parentId: 'root', insertIndex: 1, orientation: 'horizontal' });
    const line = (await dropLine(page))!;
    expect(Math.abs(line.rect.y + line.rect.height / 2 - (hero.y + hero.height))).toBeLessThan(3);
  });

  expect(flash, 'root outline flashed without a line during the entry grace').toBe(0);
  const magnet = await tracesSince(page, since, '^reparent-utils:applyLayoutEdgeMagnet$');
  expect(magnet.some(m => m.data.fromId === 'hero' && m.data.toParentId === 'root')).toBe(true);
  await expect.poll(() => editor.parentOf('floater')).toBe('root');
  expect(await visualOrder(editor, 'root')).toEqual(['hero', 'floater', 'features', 'how']);
  await expect(editor).toUndoInOneStep(before);
}));

test.describe('replica tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  // `frame`: every child hidden on Tablet. `stack`: b hidden on Tablet.
  const HIDDEN_ON_TABLET = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '100%', minHeight: '900px', padding: '40px', background: '#0d0d1a' }}>
  <style>{\`
@media (max-width: 768px) {
  [data-id="h1"] { display: none !important; }
  [data-id="h2"] { display: none !important; }
  [data-id="b"] { display: none !important; }
}
\`}</style>
  <div data-id="frame" data-name="Frame" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '100%', height: '300px', background: '#202030', flex: '0 0 auto' }}>
    <div data-id="h1" data-name="H1" style={{ width: '100%', height: '60px', background: '#ff5577', flex: '0 0 auto' }}></div>
    <div data-id="h2" data-name="H2" style={{ width: '100%', height: '60px', background: '#55ffaa', flex: '0 0 auto' }}></div>
  </div>
  <div data-id="stack" data-name="Stack" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '100%', background: '#302020', flex: '0 0 auto' }}>
    <div data-id="a" data-name="A" style={{ width: '100%', height: '80px', background: '#5577ff', flex: '0 0 auto' }}></div>
    <div data-id="b" data-name="B" style={{ width: '100%', height: '80px', background: '#ffcc33', flex: '0 0 auto' }}></div>
    <div data-id="c" data-name="C" style={{ width: '100%', height: '80px', background: '#aa55ff', flex: '0 0 auto' }}></div>
  </div>
</div>`, { tiles: [TILE.desktop, TILE.tablet] }).build();
  HIDDEN_ON_TABLET.files['app/page.client.tsx'] += `const canvasNodes = (<>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '200px', top: '1100px', width: '60px', height: '40px', background: '#ffcc33' }}></div>
</>);
`;

  test('DND-027 a frame whose children are all hidden on Tablet offers one inside drop', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => survivesReloads(editor, async () => {
    await loadSeed(editor, HIDDEN_ON_TABLET, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const onTablet = await editor.nodeBoxIn('tablet', 'frame');
    const onDesktop = await editor.nodeBoxIn('desktop', 'frame');
    const frames: OverlayFrame[] = [];
    let since = 0;

    await drag(editor, 'chip', async (s) => {
      since = await traceMark(page);
      await s.moveTo({ x: onTablet.x + onTablet.width / 2, y: onTablet.y + onTablet.height / 2 }, 24);
      await s.pump(10, { onFrame: async () => { frames.push(await overlayFrame(page)); } });
      // Tablet: a single "inside" affordance — no before/after lines between invisible boxes.
      expect(frames.filter(f => f.line)).toEqual([]);
      expect(await parentOutline(page)).toMatchObject({ parentId: 'frame', source: 'drag' });
      const marks = await tracesSince(page, since, '^drop-line:(empty-layout-drop|show)$');
      expect(marks.filter(m => m.c === 'drop-line:empty-layout-drop').at(-1)?.data).toMatchObject({ parentId: 'frame', vpId: 'tablet' });
      expect(marks.filter(m => m.c === 'drop-line:show' && m.data.parentId === 'frame' && m.data.vpId === 'tablet')).toEqual([]);

      // Desktop: the same frame's children are painted, so lines show.
      await s.moveTo({ x: onDesktop.x + onDesktop.width / 2, y: onDesktop.y + onDesktop.height / 2 }, 24);
      await s.pump(10);
      expect(await dropLine(page)).toMatchObject({ parentId: 'frame', orientation: 'horizontal' });
      // Back to where it came from: no commit.
      await s.moveTo(s.start, 24);
      await s.pump(4);
    });
    expect(await editor.code()).toBe(before);
  }));

  test('DND-028 a child hidden on Tablet is never a reorder anchor and keeps its slot', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => survivesReloads(editor, async () => {
    await loadSeed(editor, HIDDEN_ON_TABLET, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const a = await editor.nodeBoxIn('tablet', 'a');
    // A replica drag needs the tile primed by a real click first; wait out
    // the double-click window before pressing again.
    await editor.primeNode('c', 'tablet');
    await page.waitForTimeout(600);
    const since = await traceMark(page);

    // c (below the hidden b's slot) to the top, crossing b's slot.
    await drag(editor, 'c', async (s, start) => {
      await s.moveTo({ x: a.x + a.width / 2, y: a.y + 4 }, 20);
      await s.pump(8, { axis: 'x' });
      await assertEngaged(editor, 'c', start, 'tablet');
      const holes = await placeholders(editor);
      expect(holes).toHaveLength(1);
      expect(Math.abs(holes[0].y - a.y)).toBeLessThan(3);
    }, { vpId: 'tablet' });

    // The hidden child was never a sibling the slot could anchor to.
    const coords = await tracesSince(page, since, '^layout-lifted:reorder-coords$');
    expect(coords.length).toBeGreaterThan(0);
    for (const c of coords) expect((c.data.siblings as Array<{ id: string }>).map(x => x.id)).toEqual(['a']);
    // Tablet band: c first; the hidden b keeps its authored place after a (not slot 0) and stays hidden.
    await expect(editor).toHaveBandStyle(768, 'c', 'order', '0', { important: true });
    await expect(editor).toHaveBandStyle(768, 'a', 'order', '1', { important: true });
    await expect(editor).toHaveBandStyle(768, 'b', 'order', '2', { important: true });
    await expect(editor).toHaveBandStyle(768, 'b', 'display', 'none', { important: true });
    // Primary untouched.
    for (const id of ['a', 'b', 'c']) await expect(editor).toHaveStyle(id, 'order', null);
    expect(await visualOrder(editor, 'stack', { vpId: 'tablet' })).toEqual(['c', 'a']);
    expect(await visualOrder(editor, 'stack', { vpId: 'desktop' })).toEqual(['a', 'b', 'c']);
    await expect(editor).toUndoInOneStep(before);
  }));

  test('DND-032 viewport headers hide during an element drag and come back after', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => survivesReloads(editor, async () => {
    await loadSeed(editor, HIDDEN_ON_TABLET, { fit: true });
    const headers = editor.page().locator('[data-viewport-header]');
    await expect(headers).toHaveCount(2);
    await expect(headers.first()).toBeVisible();
    await expect(headers.last()).toBeVisible();

    await editor.duringDrag('a', await editor.at('c', 0.5, 0.9, 'desktop'), async () => {
      await expect(headers.first()).toBeHidden();
      await expect(headers.last()).toBeHidden();
    }, { steps: 16 });

    await expect(headers.first()).toBeVisible();
    await expect(headers.last()).toBeVisible();
  }));
});

test('DND-029 a cross-axis edge never promotes: the deep frame stays the candidate', { tag: ['@p2', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, CANVAS_NODE_SMALL);
  const page = editor.page();
  const before = await editor.code();
  const hero = await editor.nodeBox('hero');
  const fl = await editor.nodeBox('floater');
  // ~11px inside hero's LEFT edge (the cross axis of the root column), mid-height,
  // with the floater fully inside hero.
  const at = { x: hero.x + fl.width / 2 + 0.3, y: hero.y + hero.height / 2 };
  const frames: OverlayFrame[] = [];
  let since = 0;

  await drag(editor, 'floater', async (s) => {
    await s.moveTo({ x: at.x, y: hero.y - 40 }, 12);
    await s.moveTo(at, 12);
    since = await traceMark(page);
    await s.pump(12, { axis: 'y', onFrame: async () => { frames.push(await overlayFrame(page)); } });
  });

  // At the cross-axis edge: no magnet, hero stays the target.
  expect(await tracesSince(page, since, '^reparent-utils:applyLayoutEdgeMagnet$')).toEqual([]);
  const best = (await tracesSince(page, since, '^canvas-drag:entry-best-candidate$')).map(e => e.data.bestFrameId);
  expect(best).not.toContain('root');
  expect(frames.filter(f => f.line?.parentId === 'root')).toEqual([]);
  expect(frames.some(f => f.outline?.parentId === 'hero')).toBe(true);
  // Dropped there: inside hero, not promoted into the root column.
  await expect.poll(() => editor.parentOf('floater')).toBe('hero');
  expect(await editor.childIds('root')).toEqual(['hero', 'features', 'how']);
  await expect(editor).toUndoInOneStep(before);
}));

test('DND-030 an active drop line suppresses snap guides, pin lines and the selection outline', { tag: ['@p2', '@dnd'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, TARGETS);
  const page = editor.page();
  const peer = await editor.nodeBox('peer');
  const chip = await editor.nodeBox('chip');
  const overList = await gapBetween(editor, 'l1', 'l2');
  const frames: OverlayFrame[] = [];
  const rec = async () => { frames.push(await overlayFrame(page)); };

  await drag(editor, 'chip', async (s) => {
    // Inside the tray, aligned with the peer: snap guides + pin lines show.
    await s.moveTo({ x: s.start.x + 40, y: s.start.y + (peer.y - chip.y) }, 12, rec);
    await s.pump(4, { onFrame: rec });
    expect(frames.some(f => f.snapGuides > 0)).toBe(true);
    expect(frames.some(f => f.pinMarks > 0)).toBe(true);
    // Into the flex list's gap: a layout drop target.
    await s.moveTo(overList, 24, rec);
    await s.pump(8, { onFrame: rec });
    expect(await dropLine(page)).toMatchObject({ parentId: 'list' });
    await s.moveTo(s.start, 24);
    await s.pump(4);
  });

  const withLine = frames.filter(f => f.line);
  expect(withLine.length).toBeGreaterThan(0);
  for (const f of withLine) {
    expect(f.snapGuides).toBe(0);
    expect(f.pinMarks).toBeLessThanOrEqual(0);
    // Only the drop target's own outline — never the selection-derived one.
    expect(f.outline).toEqual({ parentId: f.line!.parentId, source: 'drag' });
  }
  // Grace: a layout target with children never shows its outline without the line.
  for (const f of frames) {
    if (f.outline?.source === 'drag' && (f.outline.parentId === 'list' || f.outline.parentId === 'root')) {
      expect(f.line?.parentId).toBe(f.outline.parentId);
    }
  }
}));

// A design-component master: a non-layout tray with an absolute chip and a
// flex list with children, inside a flex root.
const PANEL_MASTER = `'use client';

/** @name "Panel" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Panel', x: 0, y: 0, isPrimary: true }];

function Panel({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="panel-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Panel" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '24px', width: '700px', padding: '24px', backgroundColor: '#1a1a3a', ...style }}>
      <motion.div layout={true} data-id="tray" data-name="Tray" style={{ position: 'relative', width: '100%', height: '200px', backgroundColor: '#303040', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '40px', top: '40px', width: '60px', height: '40px', backgroundColor: '#ffcc33' }} />
      </motion.div>
      <motion.div layout={true} data-id="list" data-name="List" style={{ display: 'flex', flexDirection: 'column', gap: '60px', padding: '20px', width: '100%', backgroundColor: '#202030', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="l1" data-name="L1" style={{ width: '100%', height: '80px', backgroundColor: '#ff5577', flex: '0 0 auto' }} />
        <motion.div layout={true} data-id="l2" data-name="L2" style={{ width: '100%', height: '80px', backgroundColor: '#55ffaa', flex: '0 0 auto' }} />
      </motion.div>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Panel);
`;
const WITH_MASTER = project().page(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', background: '#0d0d1a' }}></div>`)
  .component('Panel', PANEL_MASTER).build();

test('DND-031 inside a component master the drop-target outline is the component colour', { tag: ['@p2', '@dnd', '@cmp'] }, async ({ editor }) => survivesReloads(editor, async () => {
  await loadSeed(editor, WITH_MASTER);
  const page = editor.page();
  await editor.openFile('components/Panel.tsx');
  await editor.waitForCanvas();
  await expect(editor.node('chip')).toBeVisible();
  await editor.settled();

  // Selection colour on this file (a real click on the chip).
  await editor.click('chip');
  await expect.poll(async () => (await selectionOverlay(page))?.stroke ?? null).not.toBeNull();
  const selectionStroke = (await selectionOverlay(page))!.stroke;
  const purple = await cssColor(page, 'var(--accent-secondary)');
  const blue = await cssColor(page, 'var(--selection)');
  expect(selectionStroke).toBe(purple);
  expect(purple).not.toBe(blue);
  await page.waitForTimeout(400);

  const overList = await gapBetween(editor, 'l1', 'l2');
  await drag(editor, 'chip', async (s) => {
    await s.moveTo(overList, 24);
    await s.pump(8);
    expect(await dropLine(page)).toMatchObject({ parentId: 'list' });
    const outline = await parentOutline(page);
    expect(outline).toMatchObject({ parentId: 'list', source: 'drag' });
    // Same purple as selection (and hover) on a master — not the page blue.
    expect(outline!.stroke).toBe(selectionStroke);
    await s.moveTo(s.start, 24);
    await s.pump(4);
  });
}));
