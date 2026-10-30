// DND · Collaboration drag lock (E2E_TEST_PLAN.md §2).
//
// LOCAL mode never mounts the socket provider (CLOUD_ENABLED is a build-time
// flag), so there is no room to stub. These rows drive the app's own collab
// modules instead: a collaborator's lock goes in through collab-locks'
// `setRemoteLock` (what the `interacting` handler calls), a collaborator's
// file write through the exact ProjectFS / queue calls the provider's
// `applyRemoteContent` makes, and this tab's own lock is read from the
// local-interaction feed the provider forwards to the room.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  page8, center, near, gesture, Gesture, stableCode, mark, since, frames, quickBox,
  remoteLock, clearRemoteLocks, localLock, recordLocalLock, localLockLog, remoteWrite, dragFlag, type Pt,
} from '../../helpers/d8';
import { centerOn } from '../../helpers/d3';
import { placeholders } from '../../helpers/d1';
import { resizeBy, rotateByHandle } from '../../helpers/c5';

test.describe.configure({ timeout: 180_000 });

const PAGE = 'app/page.client.tsx';

const FLEX3 = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#2a2a4a' }}></div>
</div>`);

/** Two absolute boxes in a frame. */
const BOXES = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="x" data-name="X" style={{ position: 'absolute', left: '300px', top: '200px', width: '240px', height: '160px', backgroundColor: '#ff5577' }}></div>
  <div data-id="y" data-name="Y" style={{ position: 'absolute', left: '700px', top: '200px', width: '240px', height: '160px', backgroundColor: '#55aaff' }}></div>
</div>`);

const toast = (editor: Editor, name: string) => editor.page().getByText(`${name} is editing this element right now`);

/** Press on `id` and drag it 60px down; returns whether a drag started. */
async function tryDrag(editor: Editor, id: string, dy = 60): Promise<boolean> {
  const page = editor.page();
  const b = await editor.nodeBox(id);
  const m = await mark(page);
  await gesture(editor, center(b), async (g) => {
    await g.moveBy(0, dy, 12);
    await g.hold(3);
  });
  await page.waitForTimeout(450);
  return (await since(page, m, '^drag:start$')).length > 0;
}

// ─── DND-248 ──────────────────────────────────────────────────────────

test('DND-248 a node a collaborator holds never starts a drag; a toast names them', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features']);
  const page = editor.page();
  await remoteLock(page, { nodeIds: ['features'], name: 'Ana', page: PAGE });
  const before = await editor.code();
  const f = await editor.nodeBox('features');
  const how = await editor.nodeBox('how');
  const m = await mark(page);
  await gesture(editor, center(f), async (g) => {
    await g.moveTo({ x: center(f).x, y: how.y + how.height * 0.8 }, 20);
    await g.pump(6, 'x');
    expect(await placeholders(editor), 'never lifted').toHaveLength(0);
    expect(near((await editor.nodeBox('features')).y, f.y, 1), 'never moved').toBe(true);
    expect(await dragFlag(page)).toBe(false);
  });
  const blocked = await since(page, m, '^collab:blocked-by-lock$');
  expect(blocked.length).toBeGreaterThan(0);
  expect(blocked[0].data).toMatchObject({ action: 'drag', nodeIds: ['features'], holder: 'e2e-remote-user' });
  expect(await since(page, m, '^drag:start$')).toEqual([]);
  await expect(toast(editor, 'Ana')).toBeVisible();
  expect(await editor.code()).toBe(before);
  expect(await localLock(page), 'this tab never claimed the node').toEqual([]);
  await clearRemoteLocks(page);
});

// ─── DND-249 ──────────────────────────────────────────────────────────

test('DND-249 a local drag holds its own lock from drag start, through the whole gesture, and releases it after its commit', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features', 'how']);
  const page = editor.page();
  await recordLocalLock(page);
  const before = await editor.code();
  const f = await editor.nodeBox('features');
  const how = await editor.nodeBox('how');
  let startT = 0;
  const held: string[][] = [];
  await gesture(editor, center(f), async (g) => {
    await g.moveBy(0, 12, 6);
    startT = await page.evaluate(() => performance.now());
    expect(await localLock(page), 'announced at drag start').toEqual(['features']);
    // Hold the gesture past one heartbeat period (2.5s): the lock stays put.
    await g.moveTo({ x: center(f).x, y: how.y + how.height * 0.8 }, 20);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      await g.pump(2, 'x');
      held.push(await localLock(page));
    }
  });
  const upT = await page.evaluate(() => performance.now());
  expect(held.every(h => h.length === 1 && h[0] === 'features'), JSON.stringify(held)).toBe(true);
  // Released once the gesture ended — after its own commit reached ProjectFS.
  await expect.poll(() => localLock(page)).toEqual([]);
  await expect(editor).toHaveStyle('features', 'order', '2');
  const log = await localLockLog(page);
  expect(log.map(e => e.ids), 'one claim, one release').toEqual([['features'], []]);
  expect(log[0].t).toBeLessThanOrEqual(startT + 1);
  expect(upT - log[0].t, 'held for the whole >3s gesture').toBeGreaterThan(2_500);
  const commit = (await since(page, 0, '^commitDragUpdates$')).pop();
  expect(commit, 'the drag committed').toBeTruthy();
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-250 ──────────────────────────────────────────────────────────

test('DND-250 a silent lock expires after 8s, another page\'s lock never blocks, and two tabs hold independent locks', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(BOXES);
  await centerOn(editor, ['x', 'y']);
  const page = editor.page();

  // 1 · heartbeats stopped 6s ago: still live, then dead past the 8s TTL.
  await remoteLock(page, { nodeIds: ['x'], name: 'Ana', page: PAGE, ageMs: 6_000 });
  expect(await tryDrag(editor, 'x'), 'held (6s since the last heartbeat)').toBe(false);
  await page.waitForTimeout(2_600);
  let before = await editor.code();
  expect(await tryDrag(editor, 'x'), 'free once the lock went silent for 8s').toBe(true);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
  await page.waitForTimeout(450);
  await clearRemoteLocks(page);

  // 2 · a lock on ANOTHER page never blocks this one.
  await remoteLock(page, { nodeIds: ['x'], name: 'Ana', page: 'app/about/page.client.tsx' });
  before = await editor.code();
  expect(await tryDrag(editor, 'x'), 'another page\'s lock is ignored here').toBe(true);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
  await page.waitForTimeout(450);
  await clearRemoteLocks(page);

  // 3 · one person, two tabs (two sockets): each tab's lock is its own.
  await remoteLock(page, { socketId: 'tab-a', userId: 'ana', name: 'Ana', nodeIds: ['x'], page: PAGE });
  await remoteLock(page, { socketId: 'tab-b', userId: 'ana', name: 'Ana', nodeIds: ['y'], page: PAGE });
  expect(await tryDrag(editor, 'x')).toBe(false);
  expect(await tryDrag(editor, 'y')).toBe(false);
  // Tab A releases (empty `interacting`): only X frees up.
  await remoteLock(page, { socketId: 'tab-a', userId: 'ana', name: 'Ana', nodeIds: [], page: PAGE });
  expect(await tryDrag(editor, 'y'), 'tab B still holds Y').toBe(false);
  before = await editor.code();
  expect(await tryDrag(editor, 'x'), 'tab A released X').toBe(true);
  await stableCode(editor);
  await expect(editor).toUndoInOneStep(before);
  await clearRemoteLocks(page);
});

// ─── DND-251 ──────────────────────────────────────────────────────────

test('DND-251 a collaborator\'s write during a live drag is adopted by the drag\'s stashed flush, not reverted', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features', 'how']);
  const page = editor.page();
  const f = await editor.nodeBox('features');
  const how = await editor.nodeBox('how');
  const m = await mark(page);
  let heroMid = '';
  await gesture(editor, center(f), async (g) => {
    await g.moveTo({ x: center(f).x, y: how.y + how.height * 0.8 }, 20);
    await g.pump(6, 'x');
    // Ana recolours the hero while the drag is live.
    await remoteWrite(page, PAGE, { from: "height: '300px', backgroundColor: '#1a1a3a'", to: "height: '300px', backgroundColor: '#aa2233'" });
    await frames(page, 6);
    await g.pump(4, 'x');
    heroMid = await editor.sandbox().locator('[data-id="hero"]').first().evaluate(el => getComputedStyle(el).backgroundColor);
    // The gesture survives: still lifted, still under the cursor.
    expect(await placeholders(editor)).toHaveLength(1);
  });
  expect(await since(page, m, '^mutation-queue:external-write-refresh-stash$'), 'the stash adopted the write').toHaveLength(1);
  expect(heroMid, 'no repaint mid-gesture').toBe('rgb(26, 26, 58)');
  const repaints = await page.evaluate(() => (window as any).__d8RemoteRepaints);
  expect(repaints, 'one render, after the gesture').toEqual({ count: 1, midGesture: 0 });
  // Both changes survive the gesture end: the drop AND the collaborator's colour.
  const code = await stableCode(editor);
  await expect(editor).toHaveStyle('features', 'order', '2');
  await expect(editor).toHaveStyle('how', 'order', '1');
  expect((await editor.style('hero')).backgroundColor, 'not reverted at gesture end').toBe('#aa2233');
  expect(code).not.toContain("'#1a1a3a'");
  // One render then: the canvas shows both.
  await expect.poll(() => editor.sandbox().locator('[data-id="hero"]').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(170, 34, 51)');
  const order = await page.evaluate(() => ['hero', 'features', 'how']);
  const ys: Array<[string, number]> = [];
  for (const id of order) ys.push([id, (await editor.nodeBox(id)).y]);
  expect(ys.sort((a, b) => a[1] - b[1]).map(e => e[0])).toEqual(['hero', 'how', 'features']);
});

// ─── DND-252 ──────────────────────────────────────────────────────────

test('DND-252 a held node refuses delete, arrow nudge, resize and rotate with the same toast', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(BOXES);
  await centerOn(editor, ['x']);
  const page = editor.page();
  const x = await editor.nodeBox('x');
  await page.mouse.click(center(x).x, center(x).y);
  await editor.settled();
  expect(await editor.selection()).toEqual(['x']);
  await remoteLock(page, { nodeIds: ['x'], name: 'Ana', page: PAGE });
  const before = await editor.code();
  const m = await mark(page);
  await page.waitForTimeout(450);

  await editor.blur();
  await page.keyboard.press('Delete');
  await editor.settled();
  expect(await editor.exists('x'), 'delete refused').toBe(true);
  // (The Delete shortcut clears the selection even when the delete is refused.)
  await page.mouse.click(center(x).x, center(x).y);
  await editor.settled();
  expect(await editor.selection()).toEqual(['x']);
  await page.waitForTimeout(450);
  await page.keyboard.press('ArrowRight');
  await editor.settled();
  await resizeBy(editor, { dir: 'bottomRight' }, 40, 30);
  await rotateByHandle(editor, 30);

  const actions = (await since(page, m, '^collab:blocked-by-lock$')).map(t => t.data?.action);
  for (const a of ['delete', 'nudge', 'resize', 'rotate']) expect(actions, `${a} refused`).toContain(a);
  await expect(toast(editor, 'Ana')).toBeVisible();
  // Nothing was written, the node is still there and unrotated.
  expect(await editor.code()).toBe(before);
  expect(await editor.exists('x')).toBe(true);
  const after = await editor.nodeBox('x');
  expect(near(after.x, x.x, 1) && near(after.width, x.width, 1) && near(after.height, x.height, 1)).toBe(true);
  await clearRemoteLocks(page);
});

// ─── DND-253 ──────────────────────────────────────────────────────────

test('DND-253 a local drag that ends without a pointerup still releases its lock', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(BOXES);
  await centerOn(editor, ['x']);
  const page = editor.page();
  await recordLocalLock(page);
  const x = await editor.nodeBox('x');
  const g = await Gesture.press(page, center(x));
  let released = false;
  try {
    await g.moveBy(60, 20, 12);
    expect(await dragFlag(page)).toBe(true);
    expect(await localLock(page)).toEqual(['x']);
    const m = await mark(page);
    // A second (re-entrant) press lands while the left button is still
    // down: the coordinator cancels the live drag — its flag drops with no
    // pointerup for the gesture.
    await page.mouse.down({ button: 'right' });
    await frames(page, 3);
    expect(await dragFlag(page), 'the drag flag dropped').toBe(false);
    expect(await since(page, m, '^canvas:mouseup$'), 'no pointerup yet').toEqual([]);
    expect(await localLock(page), 'the lock ended with the flag').toEqual([]);
    const log = await localLockLog(page);
    expect(log.map(e => e.ids)).toEqual([['x'], []]);
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('Escape');
  } finally {
    if (!released) { released = true; await g.release(); }
  }
  await editor.settled();
  expect(await localLock(page)).toEqual([]);
});
