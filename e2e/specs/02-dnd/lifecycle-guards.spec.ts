// DND · Lifecycle, guards and modes (E2E_TEST_PLAN.md §2).
//
// What decides whether a press becomes a drag at all (the 3px threshold,
// viewer mode, translation mode, layer locks), which strategy takes it, and
// what the gesture does to the rest of the editor while it runs (auto-pan,
// Escape, the Position panel).

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  page8, seed8, pageModule8, center, near, gesture, Gesture, stableCode, mark, since, frames, quickBox,
  setViewerRole, pickLocale, type Box, type Pt,
} from '../../helpers/d8';
import { centerOn, panBy } from '../../helpers/d3';
import { placeholders } from '../../helpers/d1';
import { openLayers, revealRow } from '../../helpers/d4';
import { hoverOutline } from '../../helpers/d2';
import { isTextEditing } from '../../helpers/c5';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ────────────────────────────────────────────────────────────

const FLEX3 = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#2a2a4a' }}></div>
</div>`);

/** One node of every drag shape: overlay, grid child, flex child, absolute child, canvas node. */
const SHAPES = seed8(pageModule8({
  imports: ["import { useState } from 'react';", "import { AnimatePresence, motion } from 'framer-motion';"],
  hooks: ['const [menuOpen, setMenuOpen] = useState(true);'],
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', backgroundColor: '#0d0d1a' }}>
  <div data-id="grid" data-name="Grid" style={{ position: 'relative', flex: '0 0 auto', display: 'grid', gridTemplateColumns: '200px 200px', gap: '10px', width: '420px', backgroundColor: '#202040' }}>
    <div data-id="g1" data-name="G1" style={{ position: 'relative', height: '80px', backgroundColor: '#ff5577' }}></div>
    <div data-id="g2" data-name="G2" style={{ position: 'relative', height: '80px', backgroundColor: '#55aaff' }}></div>
  </div>
  <div data-id="flexrow" data-name="Row" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '10px', width: '420px', height: '100px', backgroundColor: '#203020' }}>
    <div data-id="f1" data-name="F1" style={{ position: 'relative', flex: '0 0 auto', width: '120px', height: '80px', backgroundColor: '#ffcc33' }}></div>
    <div data-id="f2" data-name="F2" style={{ position: 'relative', flex: '0 0 auto', width: '120px', height: '80px', backgroundColor: '#33ffcc' }}></div>
  </div>
  <div data-id="frame" data-name="Frame" style={{ position: 'relative', flex: '0 0 auto', width: '420px', height: '200px', backgroundColor: '#302030' }}>
    <div data-id="ab" data-name="Ab" style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '80px', backgroundColor: '#cc66ff' }}></div>
  </div>
  <div data-id="trigger" data-name="Trigger" data-overlay-trigger='{"trigger":"click"}' onClick={() => setMenuOpen(!menuOpen)} style={{ position: 'relative', flex: '0 0 auto', width: '200px', height: '60px', backgroundColor: '#a8c8f9' }}></div>
  <AnimatePresence>{menuOpen && (
    <motion.div key="menu" data-id="menu" data-name="Menu" data-overlay='{"type":"relative","triggerId":"trigger","side":"right","align":"start","offsetX":16,"offsetY":0}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#1a1a3a' }}></motion.div>
  )}</AnimatePresence>
</div>`,
  canvas: `<div data-id="cv" data-name="Cv" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '120px', height: '120px', backgroundColor: '#ff66cc' }}></div>`,
}));

/** French configured; two texts and a frame. */
function localeSeed() {
  const s = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '600px', position: 'relative', backgroundColor: '#0d0d1a', padding: '60px', gap: '16px' }}>
  <p data-id="intro" data-name="Intro" style={{ position: 'relative', flex: '0 0 auto', color: '#ffffff', fontSize: '32px' }}>Painter</p>
  <p data-id="tagline" data-name="Tagline" style={{ position: 'relative', flex: '0 0 auto', color: '#9999aa', fontSize: '18px' }}>Visual Artist</p>
  <div data-id="tile" data-name="Tile" style={{ position: 'relative', flex: '0 0 auto', width: '200px', height: '120px', backgroundColor: '#334466' }}></div>
</div>`);
  s.files['i18n/config.json'] = JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }] }, null, 2);
  s.files['messages/en.json'] = '{}';
  s.files['messages/fr.json'] = '{}';
  return s;
}
const LOCALE = localeSeed();

/** A card holding a node to lock and a frame (to lock) with a child. */
const LOCKS = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="card" data-name="Card" style={{ position: 'absolute', left: '300px', top: '150px', width: '600px', height: '400px', backgroundColor: '#202040' }}>
    <div data-id="lockme" data-name="LockMe" style={{ position: 'absolute', left: '40px', top: '40px', width: '160px', height: '120px', backgroundColor: '#ff5577' }}></div>
    <div data-id="kidframe" data-name="KidFrame" style={{ position: 'absolute', left: '300px', top: '120px', width: '240px', height: '200px', backgroundColor: '#336699' }}>
      <div data-id="kid" data-name="Kid" style={{ position: 'absolute', left: '40px', top: '40px', width: '120px', height: '100px', backgroundColor: '#ffcc33' }}></div>
    </div>
  </div>
</div>`);

/** A canvas node beside the page (auto-pan bait). */
const AUTOPAN = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}></div>`, {
  canvas: `<div data-id="cv" data-name="Cv" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '100px', width: '120px', height: '120px', backgroundColor: '#ff66cc' }}></div>`,
});

/** A frame with an absolute child, for the Position panel. */
const PANEL = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="frame" data-name="Frame" style={{ position: 'absolute', left: '200px', top: '100px', width: '800px', height: '500px', backgroundColor: '#202040' }}>
    <div data-id="pc" data-name="Pc" style={{ position: 'absolute', left: '100px', top: '80px', width: '120px', height: '80px', backgroundColor: '#66ccff' }}></div>
  </div>
</div>`);

// ─── Helpers ──────────────────────────────────────────────────────────

/** The camera, read from the app's own transform manager. */
async function camera(editor: Editor): Promise<{ x: number; y: number; scale: number }> {
  return editor.page().evaluate(async () => {
    const url = '/src/canvas/transform/index.ts';
    const m = await import(/* @vite-ignore */ url);
    const t = m.transformManager.getTransform();
    return { x: t.x, y: t.y, scale: t.scale };
  });
}

/** The Position panel's T/L/R/B fields (DOM order: top, left, right, bottom). */
async function pinFields(editor: Editor): Promise<{ top: number; left: number; right: number; bottom: number } | null> {
  const page = editor.page();
  const grid = page.locator('div.grid.grid-cols-3.grid-rows-3');
  if (!(await grid.count())) return null;
  const vals = await page.locator('div.flex.flex-col.w-full').filter({ has: grid }).last().locator('input').evaluateAll(els => els.map(e => Number((e as HTMLInputElement).value)));
  if (vals.length < 4) return null;
  return { top: vals[0], left: vals[1], right: vals[2], bottom: vals[3] };
}

async function paintedBox(editor: Editor, id: string): Promise<Box | null> {
  return quickBox(editor.sandbox().locator(`[data-id="${id}"]`));
}

/** Pick an Edit → Preferences entry through the real menu. */
async function pickPreference(editor: Editor, label: string): Promise<void> {
  const page = editor.page();
  await page.getByLabel('Open menu').click();
  await page.getByText('Edit', { exact: true }).first().hover();
  await page.getByText('Preferences', { exact: true }).first().hover();
  await page.getByText(label, { exact: true }).first().click();
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

// ─── DND-240 ──────────────────────────────────────────────────────────

test('DND-240 press, move 2px, release stays a click', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features']);
  const page = editor.page();
  const before = await editor.code();
  const f = await editor.nodeBox('features');
  const m = await mark(page);
  await gesture(editor, center(f), async (g) => {
    // Never 3px from the press on either axis (the threshold is |d| >= 3).
    await g.moveBy(2, 0, 2);
    await g.moveBy(0, 2, 2);
    await g.moveBy(-1, 0, 1);
  });
  expect(await since(page, m, '^drag:pending$'), 'the press armed a pending drag').not.toHaveLength(0);
  expect(await since(page, m, '^drag:start$'), 'never crossed the 3px threshold').toEqual([]);
  expect(await placeholders(editor)).toHaveLength(0);
  expect(await editor.code()).toBe(before);
  expect(await editor.selection()).toEqual(['features']);
  // The next click behaves normally.
  await page.waitForTimeout(450);
  const hero = await editor.nodeBox('hero');
  await page.mouse.click(center(hero).x, center(hero).y);
  await editor.settled();
  expect(await editor.selection()).toEqual(['hero']);
  expect(await editor.code()).toBe(before);
});

// ─── DND-241 ──────────────────────────────────────────────────────────

test('DND-241 strategy order: overlay → grid → layout → absolute-in-frame → canvas', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(SHAPES);
  const page = editor.page();
  await centerOn(editor, ['grid', 'frame', 'cv']);
  await page.waitForTimeout(400);

  // The overlay goes last: a press outside an open overlay leaves overlay-edit mode.
  const cases: Array<[string, string]> = [['g1', 'grid'], ['f1', 'layout-lifted'], ['ab', 'absolute-in-frame'], ['cv', 'canvas'], ['menu', 'overlay']];
  const seen: string[] = [];
  for (const [id, want] of cases) {
    if (id === 'menu') {
      // The overlay paints on the canvas while it is being edited (setup).
      await page.evaluate(() => (window as any).__e2e.openOverlay('menu'));
      await editor.settled();
      await expect.poll(async () => ((await paintedBox(editor, 'menu'))?.width ?? 0) > 0).toBe(true);
      await page.waitForTimeout(400);
    }
    const before = await editor.code();
    const b0 = (await paintedBox(editor, id))!;
    const m = await mark(page);
    let holes = -1;
    let moved = false;
    await gesture(editor, center(b0), async (g) => {
      await g.moveBy(24, 18, 10);
      await g.pump(4, 'x');
      const b = await paintedBox(editor, id);
      moved = !!b && (Math.abs(b.x - b0.x) > 8 || Math.abs(b.y - b0.y) > 8);
      holes = (await placeholders(editor)).length;
      await g.moveTo(center(b0), 10);
      await g.hold(3);
    });
    const starts = await since(page, m, '^drag:start$');
    expect(starts.map(s => s.data?.nodes?.[0]?.id), `${id} was the dragged node`).toEqual([id]);
    seen.push(starts[0]?.data?.strategy);
    expect(starts[0]?.data?.strategy, `${id} → ${want}`).toBe(want);
    // Behaviour matches the strategy: it follows the cursor, and only the
    // flow strategies (grid auto-flow, layout) leave a placeholder hole.
    expect(moved, `${id} followed the cursor`).toBe(true);
    expect(holes, `${id} placeholder holes`).toBe(want === 'layout-lifted' || want === 'grid' ? 1 : 0);
    await stableCode(editor);
    if ((await editor.code()) !== before) {
      await editor.undo();
      await expect.poll(() => editor.code()).toBe(before);
    }
    await page.waitForTimeout(450);
  }
  expect(seen).toEqual(['grid', 'layout-lifted', 'absolute-in-frame', 'canvas', 'overlay']);
});

// ─── DND-242 ──────────────────────────────────────────────────────────

test('DND-242 viewer mode (viewer role, or an agent run on the branch): selection works, no drag starts', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features']);
  const page = editor.page();
  const before = await editor.code();

  const tryDrag = async (id: string) => {
    const b = await editor.nodeBox(id);
    const m = await mark(page);
    await gesture(editor, center(b), async (g) => {
      await g.moveBy(0, 120, 16);
      await g.pump(6, 'x');
      expect(await placeholders(editor), 'no lift').toHaveLength(0);
      const now = await editor.nodeBox(id);
      expect(near(now.y, b.y, 1), 'the node never moved').toBe(true);
    });
    expect(await since(page, m, '^drag:pending-blocked-viewer$'), 'the press was refused as a drag').not.toHaveLength(0);
    expect(await since(page, m, '^drag:start$')).toEqual([]);
    expect(await editor.selection(), 'selection still works').toEqual([id]);
    expect(await editor.code()).toBe(before);
    await page.waitForTimeout(450);
  };

  // Viewer role.
  await setViewerRole(page, true);
  await tryDrag('features');
  await setViewerRole(page, false);

  // An agent run holding the active branch (the same module-level lock the run lifecycle sets).
  await page.evaluate(async () => {
    const lock = await import(/* @vite-ignore */ '/src/code/stores/agent-run-lock-store.ts' as string);
    const fs = await import(/* @vite-ignore */ '/src/code/project/project-fs.ts' as string);
    (window as any).__d8Branch = fs.projectFS.getActiveBranchId();
    lock.lockBranch((window as any).__d8Branch);
  });
  try {
    await tryDrag('hero');
  } finally {
    await page.evaluate(async () => {
      const lock = await import(/* @vite-ignore */ '/src/code/stores/agent-run-lock-store.ts' as string);
      lock.unlockBranch((window as any).__d8Branch);
    });
  }
  // Editable again: the same gesture now drags.
  const m = await mark(page);
  const f = await editor.nodeBox('features');
  await gesture(editor, center(f), async (g) => { await g.moveBy(0, 12, 6); await g.hold(2); await g.moveBy(0, -12, 6); });
  expect(await since(page, m, '^drag:start$')).toHaveLength(1);
});

// ─── DND-243 ──────────────────────────────────────────────────────────

test('DND-243 translation mode: drags die at the threshold, the double-click still reaches text editing', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LOCALE);
  await centerOn(editor, ['intro', 'tile']);
  const page = editor.page();
  await pickLocale(page, 'French');
  await expect(page.locator('[data-translation-pill]')).toBeVisible();
  const before = await editor.code();
  for (const id of ['tile', 'intro']) {
    const b = await editor.nodeBox(id);
    const m = await mark(page);
    await gesture(editor, center(b), async (g) => {
      await g.moveBy(0, 60, 12);
      await g.pump(4, 'x');
      expect(near((await editor.nodeBox(id)).y, b.y, 1), `${id} never moved`).toBe(true);
    });
    expect(await since(page, m, '^drag:threshold-blocked-translation-mode$'), `${id} blocked at the threshold`).not.toHaveLength(0);
    expect(await since(page, m, '^drag:start$')).toEqual([]);
    await page.waitForTimeout(450);
  }
  expect(await editor.code()).toBe(before);
  // The drag guard leaves the double-click alone: it reaches the text-edit
  // funnel, which (since 2026-09-07) refuses INLINE editing in translation
  // mode and leaves the text to the translation panel's per-locale fields.
  const t = await editor.nodeBox('tagline');
  const m2 = await mark(page);
  await page.mouse.click(center(t).x, center(t).y);
  await page.waitForTimeout(120);
  await page.mouse.click(center(t).x, center(t).y);
  await expect.poll(async () => (await since(page, m2, '^canvas:text-edit-from-dblclick')).length, { timeout: 8_000 }).toBeGreaterThan(0);
  expect((await since(page, m2, '^text-edit:blocked-translation-mode$')).map(e => e.data?.nodeId)).toContain('tagline');
  expect(await editor.selection()).toEqual(['tagline']);
  await expect(page.locator('[data-translation-panel]')).toBeVisible();
  await expect(page.locator('[data-locale-field="English"] textarea').first()).toHaveValue('Visual Artist');
  await expect(page.locator('[data-locale-field="French"] textarea').first()).toBeVisible();
  expect(await isTextEditing(editor)).toBe(false);
  expect(await editor.code()).toBe(before);
});

// ─── DND-244 ──────────────────────────────────────────────────────────

test('DND-244 a padlocked node and a locked frame\'s child are invisible to the pointer: the press goes to what lies under', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LOCKS);
  await centerOn(editor, ['card']);
  const page = editor.page();
  await openLayers(page);
  // Lock both through the layers padlock (real UI).
  for (const id of ['lockme', 'kidframe']) {
    const row = await revealRow(editor, id);
    await row.hover();
    await row.locator('button[title="Lock layer"]').click();
    await expect(editor).toHaveStyle(id, 'pointerEvents', 'none');
    await page.waitForTimeout(300);
  }
  await page.mouse.move(5, 500);
  await page.waitForTimeout(450);
  const before = await editor.code();
  const card0 = await editor.nodeBox('card');

  for (const id of ['lockme', 'kid']) {
    const b = await editor.nodeBox(id);
    // Not hoverable: the hover outline (if any) is the card's, never the locked node's.
    await page.mouse.move(center(b).x, center(b).y);
    await page.waitForTimeout(300);
    await page.mouse.move(center(b).x + 1, center(b).y + 1);
    await page.waitForTimeout(300);
    const hov = await hoverOutline(page);
    if (hov) expect(near(hov.width, b.width, 3) && near(hov.height, b.height, 3), `${id} is not hoverable`).toBe(false);
    // Not selectable: a click selects the card under it.
    await page.mouse.click(center(b).x, center(b).y);
    await editor.settled();
    expect(await editor.selection(), `click on ${id}`).toEqual(['card']);
    await page.waitForTimeout(450);
  }

  // Not draggable: the press drags the card under them, the locked nodes ride along.
  const lm = await editor.nodeBox('lockme');
  const m = await mark(page);
  await gesture(editor, center(lm), async (g) => {
    await g.moveBy(40, 30, 12);
    await g.hold(3);
  });
  const starts = await since(page, m, '^drag:start$');
  expect(starts.map(s => s.data?.nodes?.[0]?.id)).toEqual(['card']);
  await stableCode(editor);
  expect(await editor.style('lockme')).toMatchObject({ left: '40px', top: '40px' });
  expect(await editor.style('kid')).toMatchObject({ left: '40px', top: '40px' });
  expect(await editor.parentOf('lockme')).toBe('card');
  expect(await editor.parentOf('kid')).toBe('kidframe');
  const card = await editor.nodeBox('card');
  expect(card.x - card0.x).toBeGreaterThan(20);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-245 ──────────────────────────────────────────────────────────

test('DND-245 auto-pan: the canvas pans under a held drag at the edge, faster deeper in, at the preferred speed, and stops on return', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // The editor's canvas viewport spans the whole window and the side panels
  // FLOAT over it, while AutoPan.computeAutoPanDelta still measures overshoot
  // past the container edge with the panel widths (308 / 260) as the ramp
  // depth — "cursor over a panel during drag → max speed" (constants.ts).
  // Over the layers panel the overshoot is negative: no pan at all; it only
  // pans once the pointer leaves the browser window.
  test.fail(true, 'BUG: dragging over a side panel never auto-pans — the canvas container spans the window under the floating panels, so the pan only starts past the window edge');
  // A drag that moves the node every frame trips ToolInput's burst detector (see DND-247).
  editor.allowErrors(/tool-input:prop-sync-loop/);
  await editor.load(AUTOPAN);
  await centerOn(editor, ['cv']);
  const page = editor.page();
  const win = page.viewportSize()!;

  /** Mean camera pan per frame while the cursor sits at `p` (20 frames). */
  const panRate = async (g: Gesture, p: Pt): Promise<number> => {
    await g.moveTo(p, 8);
    await frames(page, 4);
    const a = await camera(editor);
    await frames(page, 20);
    const b = await camera(editor);
    return Math.hypot(b.x - a.x, b.y - a.y) / 20;
  };
  const underCursor = async (p: Pt) => {
    const b = (await paintedBox(editor, 'cv'))!;
    return p.x >= b.x - 2 && p.x <= b.x + b.width + 2 && p.y >= b.y - 2 && p.y <= b.y + b.height + 2;
  };

  const run = async () => {
    const cv = (await paintedBox(editor, 'cv'))!;
    const rates: Record<string, number> = {};
    await gesture(editor, center(cv), async (g) => {
      const y = center(cv).y;
      rates.mid = await panRate(g, { x: 800, y });
      // Past the left window edge: a shallow then a full-depth overshoot.
      rates.shallow = await panRate(g, { x: -60, y });
      expect(await underCursor(g.cur), 'the node stays under the cursor while the canvas pans').toBe(true);
      rates.deep = await panRate(g, { x: -320, y });
      expect(await underCursor(g.cur), 'still under the cursor at full speed').toBe(true);
      // Back on the canvas: the pan stops.
      rates.back = await panRate(g, { x: 800, y });
      // Over the layers panel (inside the window).
      rates.panel = await panRate(g, { x: 60, y });
      await g.moveTo({ x: 800, y }, 8);
    });
    await page.waitForTimeout(450);
    return rates;
  };

  // Mid (default): 0.4 → 3.2 px/frame ramp.
  const mid = await run();
  expect(mid.mid, 'no pan in the middle of the canvas').toBe(0);
  expect(mid.shallow).toBeGreaterThan(0.4);
  expect(mid.deep).toBeGreaterThan(mid.shallow * 2);
  expect(near(mid.deep, 3.2, 0.25), `full-depth speed ${mid.deep}`).toBe(true);
  expect(mid.back, 'stops on leaving the zone').toBe(0);

  // The preference scales the ramp: High ≈ 2×, Low ≈ ½.
  await pickPreference(editor, 'High');
  expect(await page.evaluate(() => localStorage.getItem('revyme:prefs:autoPanSpeed'))).toBe('"high"');
  const high = await run();
  expect(near(high.deep, 6.5, 0.4), `high speed ${high.deep}`).toBe(true);
  await pickPreference(editor, 'Low');
  const low = await run();
  expect(near(low.deep, 1.5, 0.2), `low speed ${low.deep}`).toBe(true);
  expect(low.back).toBe(0);

  // Over a side panel the canvas pans (at speed, the panel being the edge zone).
  expect(mid.panel, 'pans while the cursor is over the layers panel').toBeGreaterThan(0.4);
});

// ─── DND-246 ──────────────────────────────────────────────────────────

test('DND-246 Escape mid-drag runs Select Parent and does not cancel; the release commits once', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features', 'how']);
  const page = editor.page();
  const before = await editor.code();
  const f = await editor.nodeBox('features');
  const how = await editor.nodeBox('how');
  const m = await mark(page);
  let selDuring: string[] = [];
  await gesture(editor, center(f), async (g) => {
    await g.moveTo({ x: center(f).x, y: how.y + how.height * 0.8 }, 20);
    await g.pump(6, 'x');
    await page.keyboard.press('Escape');
    await frames(page, 4);
    selDuring = await editor.selection();
    // Still lifted: Escape does not cancel an element drag.
    expect(await placeholders(editor), 'the drag is still live').toHaveLength(1);
    await g.pump(4, 'x');
  });
  expect(selDuring, 'Escape ran Select Parent').toEqual(['root']);
  expect(await since(page, m, '^drag:start$')).toHaveLength(1);
  // Committed once: one reorder, no stranded clone or placeholder.
  await expect(editor).toHaveStyle('features', 'order', '2');
  await expect(editor).toHaveStyle('how', 'order', '1');
  expect(await placeholders(editor)).toHaveLength(0);
  expect(await editor.sandbox().locator('[data-id="features"]').count()).toBe(1);
  expect(await since(page, m, '^commitDragUpdates$')).toHaveLength(1);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-247 ──────────────────────────────────────────────────────────

test('DND-247 Position inputs stay still while the camera pans and follow the node live during its drag', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  // ToolInput's prop→state "sync loop" burst detector (ToolInput.tsx ~100)
  // assumes committed values change per code write, never per frame: more
  // than 60 syncs in a second trips it — trace.error (console.error) and the
  // field STOPS syncing for the rest of that second. A live drag feeds the
  // Position fields every pointer move, so a sustained drag from a 120Hz
  // pointer (2 moves per frame here) trips it and the numbers freeze mid-drag.
  await editor.load(PANEL);
  await centerOn(editor, ['frame']);
  const page = editor.page();
  const pc = await editor.nodeBox('pc');
  await page.mouse.click(center(pc).x, center(pc).y);
  await editor.settled();
  expect(await editor.selection()).toEqual(['pc']);
  await expect.poll(() => pinFields(editor)).toMatchObject({ left: 100, top: 80 });
  const before = await editor.code();

  // Pan (two-finger scroll): the node moves on screen, its numbers do not.
  const panned: Array<{ left: number; top: number } | null> = [];
  await page.mouse.move(700, 500);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(-15, -10);
    await frames(page, 2);
    const p = await pinFields(editor);
    panned.push(p && { left: p.left, top: p.top });
  }
  await page.waitForTimeout(300);
  const pc2 = await editor.nodeBox('pc');
  expect(Math.abs(pc2.x - pc.x), 'the camera really panned').toBeGreaterThan(40);
  for (const p of panned) expect(p).toEqual({ left: 100, top: 80 });
  expect(await editor.code()).toBe(before);

  // Drag: the fields follow live, then settle on the committed numbers.
  const scale = pc2.width / 120;
  const seen: number[] = [];
  await page.waitForTimeout(450);
  await gesture(editor, center(pc2), async (g) => {
    await g.moveBy(80 * scale, 40 * scale, 16, async (_, i) => {
      if (i % 2 === 0) { const p = await pinFields(editor); if (p) seen.push(p.left); }
    });
    await g.hold(3);
    const p = await pinFields(editor);
    expect(p && Math.abs(p.left - 180) <= 3 && Math.abs(p.top - 120) <= 3, `live at the end of the move: ${JSON.stringify(p)}`).toBe(true);
  });
  const distinct = new Set(seen.map(v => Math.round(v)));
  expect(distinct.size, `live values ${seen.join(',')}`).toBeGreaterThan(4);
  expect(seen[seen.length - 1]).toBeGreaterThan(seen[0]);
  await stableCode(editor);
  const st = await editor.style('pc');
  await expect.poll(async () => (await pinFields(editor))?.left).toBe(parseFloat(st.left));

});

// Split out of DND-247: timing-dependent, so it can't be pinned in a shared E2E run.
test('DND-247b a sustained live drag never trips the prop-sync-loop alarm', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  // BUG (verified 2026-10-28, batch D8): ToolInput's prop→state burst detector
  // (src/editor/controls/ToolInput.tsx ~98-122) assumes values change per code
  // write, never per frame. More than 60 syncs in a second logs
  // `[tool-input:prop-sync-loop]` and stops the field syncing for the rest of
  // that second — a live drag feeds the Position fields every pointer move.
  // It trips only when the editor actually renders ≥~60 syncs/s: on one worker
  // it fired 3/3, under a 4-worker suite on a loaded Mac 1/3. A deterministic
  // check belongs in a unit test of the detector; this body is the repro.
  test.fixme(true, 'BUG: sustained live drag trips ToolInput prop-sync-loop (timing-dependent — needs a unit test of the detector)');
  await editor.load(PANEL);
  await centerOn(editor, ['frame']);
  const page = editor.page();
  const pc = await editor.nodeBox('pc');
  await page.mouse.click(center(pc).x, center(pc).y);
  await editor.settled();
  const scale = pc.width / 120;
  const pc3 = await editor.nodeBox('pc');
  const late: number[] = [];
  await page.waitForTimeout(450);
  const errsBefore = editor.errors.length;
  await gesture(editor, center(pc3), async (g) => {
    // Four moves per frame (a 240Hz pointer): the detector counts syncs per
    // SECOND, so the stream must stay above 60/s even when a loaded machine
    // drops to ~20 frames/s — two moves per frame only tripped it some runs.
    for (let i = 0; i < 45; i++) {
      for (let k = 1; k <= 4; k++) await page.mouse.move(g.cur.x + 4 * i + k, g.cur.y);
      await frames(page, 1);
    }
    g.cur = { x: g.cur.x + 180, y: g.cur.y };
    await g.hold(3);
    for (let i = 0; i < 3; i++) { const p = await pinFields(editor); if (p) late.push(p.left); await page.waitForTimeout(100); }
    const box = (await paintedBox(editor, 'pc'))!;
    const frameBox = (await editor.nodeBox('frame'));
    const liveLeft = (box.x - frameBox.x) / scale;
    expect(Math.abs(late[late.length - 1] - liveLeft), `inputs ${late.join(',')} vs painted ${liveLeft.toFixed(1)}`).toBeLessThanOrEqual(3);
  });
  expect(editor.errors.slice(errsBefore).filter(e => /prop-sync-loop/.test(e)), 'no false sync-loop alarm during a long drag').toEqual([]);
  await stableCode(editor);
});
