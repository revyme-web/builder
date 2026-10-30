// Batch D8 helpers: drag & drop in CMS collection lists (ghost rows, slug
// pages), in transformed / clipped / scrolled / hidden / RTL contexts, at zoom
// extremes, under the lifecycle guards (threshold, viewer mode, translation
// mode, layer locks, auto-pan, Escape), under the collaboration drag lock, and
// through the commit pipeline (undo, duplicate ids, cycles, reloads, big pages).
// E2E_TEST_PLAN.md §2.
//
// What the shared Editor lacks for these rows:
//   - page modules in the builder's own shape ('use client' FIRST, then the
//     `@canvas` header, extra annotations such as `@cmsPage`, module consts,
//     hooks, `canvasNodes`);
//   - sandbox reads of a collection list's ghost rows (`data-collection-ghost`);
//   - module-state toggles the product reads imperatively (viewer role) via
//     the app's own module instance (Vite serves one module per URL);
//   - camera reads (the content transform) and a cursor-at-element sampler.

import type { Locator, Page } from '@playwright/test';
import type { Editor } from './editor';
import { canvasHeader, TILE, TILES, type Tile, type ProjectData } from '../fixtures/project';
import { parseSource } from './code';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export { TILE, TILES };

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const near = (a: number, b: number, tol = 3): boolean => Math.abs(a - b) <= tol;
export const frame = (page: Page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
export async function frames(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame(page);
}

// ─── Seed builders ────────────────────────────────────────────────────

const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A whole page.client.tsx in the builder's order: the directive, the
 *  `@canvas` header (+ optional annotations), imports, module consts, the
 *  component (optional hooks / signature), then `canvasNodes`. */
export function pageModule8(opts: {
  root: string;
  tiles?: Tile[];
  imports?: string[];
  pre?: string;
  hooks?: string[];
  canvas?: string;
  header?: string;
  signature?: string;
}): string {
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const hooks = (opts.hooks ?? []).map(h => `  ${h}\n`).join('');
  const canvas = opts.canvas ? `\nconst canvasNodes = (<>\n${opts.canvas.trim()}\n</>);\n` : '';
  return `'use client';

${canvasHeader(opts.tiles ?? TILES.one)}
${opts.header ? `${opts.header}\n` : ''}${imports}${opts.pre ? `\n${opts.pre.trim()}\n` : ''}
export default function Page(${opts.signature ?? ''}) {
${hooks}  return (
${opts.root.trim()}
  );
}
${canvas}`;
}

export function seed8(page: string, extra: Record<string, string> = {}, route = 'app/'): ProjectData {
  return { format: 'revyme-v1', files: { [`${route}page.tsx`]: PAGE_SERVER_WRAPPER, [`${route}page.client.tsx`]: page, ...extra } };
}

/** One-tile page seed (root JSX + optional canvasNodes fragment). */
export function page8(root: string, opts: Omit<Parameters<typeof pageModule8>[0], 'root'> & { extra?: Record<string, string> } = {}): ProjectData {
  const { extra, ...rest } = opts;
  return seed8(pageModule8({ root, ...rest }), extra ?? {});
}

// ─── CMS data ─────────────────────────────────────────────────────────

export const TEAM_SCHEMA = JSON.stringify({ name: 'Team Members', slug: 'team', fields: [
  { id: 'name', name: 'Name', type: 'text', required: true },
  { id: 'role', name: 'Role', type: 'text' },
] });
export const TEAM_DATA = JSON.stringify([
  { _id: 'alice', _slug: 'alice', _status: 'published', name: 'Alice Johnson', role: 'CEO' },
  { _id: 'bob', _slug: 'bob', _status: 'published', name: 'Bob Smith', role: 'CTO' },
  { _id: 'carol', _slug: 'carol', _status: 'published', name: 'Carol Davis', role: 'Design Lead' },
]);
export const TEAM_FILES: Record<string, string> = { 'cms/team.schema.json': TEAM_SCHEMA, 'cms/team.json': TEAM_DATA };
export const TEAM_IMPORT = "import team from '@/cms/team.json';";

/** A design component used inside collection rows (a flex column, 2 children). */
export const BADGE_MASTER = `'use client';

/** @name "Badge" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true }];

function Badge({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="badge-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Badge" style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '160px', height: '64px', padding: '8px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="badge-top" data-name="Top" style={{ position: 'relative', width: '100%', height: '20px', backgroundColor: '#1d4ed8', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="badge-bottom" data-name="Bottom" style={{ position: 'relative', width: '100%', height: '20px', backgroundColor: '#0f766e', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Badge);
`;
export const BADGE_IMPORT = "import Badge from '@/components/Badge';";

// ─── Sandbox reads ────────────────────────────────────────────────────

export interface GhostRow { nodeId: string | null; ghost: boolean; display: string; visibility: string; x: number; y: number; w: number; h: number; left: string; top: string }

/** The DOM children of a collection list on a tile: template + ghost rows. */
export async function listRows(editor: Editor, listId: string, vpId = 'desktop'): Promise<GhostRow[]> {
  const list = await editor.nodeIn(vpId, listId);
  if ((await list.count()) === 0) return [];
  const off = await iframeOffset(editor);
  return list.evaluate((el, o) => (Array.from(el.children) as HTMLElement[])
    .filter(k => k.hasAttribute('data-id') || k.hasAttribute('data-collection-ghost'))
    .map(k => {
      const r = k.getBoundingClientRect();
      const cs = getComputedStyle(k);
      return {
        nodeId: k.getAttribute('data-node-id'), ghost: k.hasAttribute('data-collection-ghost'),
        display: cs.display, visibility: cs.visibility,
        x: r.x + o.x, y: r.y + o.y, w: r.width, h: r.height, left: k.style.left, top: k.style.top,
      };
    }), off);
}

/** Every copy of a node id (template + ghost copies) on one tile, page
 *  coords. `vpId: '*'` searches the whole sandbox (a lifted element sits on
 *  the content root, outside its tile, for the gesture). */
export async function copiesOf(editor: Editor, id: string, vpId = 'desktop'): Promise<Array<{ nodeId: string; ghost: boolean; visibility: string; display: string; box: Box; text: string }>> {
  const off = await iframeOffset(editor);
  const vp = vpId === '*' ? editor.sandbox().locator('body') : editor.sandbox().locator(`[data-viewport="${vpId}"]`).first();
  if ((await vp.count()) === 0) return [];
  return vp.evaluate((root, [i, o]) => {
    const els = [...root.querySelectorAll(`[data-id="${i}"]`)] as HTMLElement[];
    return els.map(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        nodeId: el.getAttribute('data-node-id') ?? '', ghost: !!el.closest('[data-collection-ghost]'),
        visibility: cs.visibility, display: cs.display,
        box: { x: r.x + (o as Pt).x, y: r.y + (o as Pt).y, width: r.width, height: r.height },
        text: (el.textContent ?? '').trim(),
      };
    });
  }, [id, off] as const);
}

export async function iframeOffset(editor: Editor): Promise<Pt> {
  const b = await editor.page().locator('iframe[src*="5174"]').first().boundingBox();
  return { x: b?.x ?? 0, y: b?.y ?? 0 };
}

/** boundingBox of the first match, or null at once when nothing matches. */
export async function quickBox(loc: Locator): Promise<Box | null> {
  if ((await loc.count()) === 0) return null;
  return loc.first().boundingBox({ timeout: 2_000 }).catch(() => null);
}

/** Box of the copy of `id` that is NOT inside any viewport tile (a canvas node). */
export async function canvasBox(editor: Editor, id: string): Promise<Box | null> {
  return quickBox(editor.sandbox().locator(`[data-id="${id}"]:not([data-viewport] [data-id])`));
}

/** Text painted by the free-canvas copy of `id` ('' when absent). */
export async function canvasText(editor: Editor, id: string): Promise<string> {
  const loc = editor.sandbox().locator(`[data-id="${id}"]:not([data-viewport] [data-id])`).first();
  if ((await loc.count()) === 0) return '';
  return ((await loc.textContent()) ?? '').trim();
}

/** Computed style of one tile copy ('' when missing). */
export async function computedIn(editor: Editor, id: string, prop: string, vpId = 'desktop'): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

/** Inline style of one tile copy (the live DOM, not the source). */
export async function inlineIn(editor: Editor, id: string, prop: string, vpId = 'desktop'): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => (el as HTMLElement).style.getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

// ─── Source reads ─────────────────────────────────────────────────────

/** How many elements carry `data-id="id"` in a file (AST, duplicates included). */
export function idCount(code: string, id: string): number {
  return parseSource(code).allIds.filter(i => i === id).length;
}

/** data-ids that occur more than once in a file. */
export function dupIds(code: string): string[] {
  const seen = new Map<string, number>();
  for (const id of parseSource(code).allIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** The source text of the element with `data-id={id}` (first match), or null. */
export function elementSource(code: string, id: string): string | null {
  const n = parseSource(code).byId.get(id);
  return n ? code.slice(n.start, n.end) : null;
}

/** Ancestor chain of `id` in the source (nearest first). */
export function ancestorsOf(code: string, id: string): string[] {
  const src = parseSource(code);
  const out: string[] = [];
  let cur = src.byId.get(id)?.parentId ?? null;
  while (cur && out.length < 100) { out.push(cur); cur = src.byId.get(cur)?.parentId ?? null; }
  return out;
}

/** The file once it stops changing (three equal reads 250ms apart, after settle). */
export async function stableCode(editor: Editor, path?: string, timeout = 8_000): Promise<string> {
  await editor.settled();
  const deadline = Date.now() + timeout;
  let prev = await editor.code(path);
  let same = 0;
  while (Date.now() < deadline && same < 2) {
    await editor.page().waitForTimeout(250);
    const cur = await editor.code(path);
    same = cur === prev ? same + 1 : 0;
    prev = cur;
  }
  return prev;
}

/** Poll a file until `pred` holds (returns the code; throws with it on timeout). */
export async function pollCode(editor: Editor, pred: (code: string) => boolean, opts: { path?: string; timeout?: number; what?: string } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeout ?? 6_000);
  let code = await editor.code(opts.path);
  while (!pred(code) && Date.now() < deadline) {
    await editor.page().waitForTimeout(100);
    code = await editor.code(opts.path);
  }
  if (!pred(code)) throw new Error(`pollCode timed out${opts.what ? ` waiting for ${opts.what}` : ''}:\n${code}`);
  return code;
}

// ─── Traces ───────────────────────────────────────────────────────────

export interface TraceEntry { ts: number; c: string; data: any }

export async function traces(page: Page, pattern?: string): Promise<TraceEntry[]> {
  return page.evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}
export async function mark(page: Page): Promise<number> {
  const all = await traces(page);
  return all.length ? all[all.length - 1].ts : 0;
}
export async function since(page: Page, ts: number, pattern?: string): Promise<TraceEntry[]> {
  return (await traces(page, pattern)).filter(e => e.ts > ts);
}
/** The strategy of the last `drag:start` since `ts`. */
export async function strategySince(page: Page, ts: number): Promise<string | undefined> {
  const s = await since(page, ts, '^drag:start$');
  return s.length ? s[s.length - 1].data?.strategy : undefined;
}

// ─── Pointer ──────────────────────────────────────────────────────────

/** A live drag (button down until `release`). One rAF per move. */
export class Gesture {
  cur: Pt;
  private constructor(readonly page: Page, from: Pt) { this.cur = from; }
  static async press(page: Page, from: Pt): Promise<Gesture> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    return new Gesture(page, from);
  }
  async moveTo(to: Pt, steps = 10, onFrame?: (p: Pt, i: number) => Promise<void>): Promise<void> {
    const from = this.cur;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await this.page.mouse.move(p.x, p.y);
      await frame(this.page);
      if (onFrame) await onFrame(p, i);
    }
    this.cur = to;
  }
  async moveBy(dx: number, dy: number, steps = 10, onFrame?: (p: Pt, i: number) => Promise<void>): Promise<void> {
    await this.moveTo({ x: this.cur.x + dx, y: this.cur.y + dy }, steps, onFrame);
  }
  /** ±1px wiggle on one axis so per-frame grace counters tick. */
  async pump(n = 8, axis: 'x' | 'y' = 'x'): Promise<void> {
    for (let i = 0; i < n; i++) {
      const d = i % 2 ? 1 : 0;
      await this.page.mouse.move(this.cur.x + (axis === 'x' ? d : 0), this.cur.y + (axis === 'y' ? d : 0));
      await frame(this.page);
    }
    await this.page.mouse.move(this.cur.x, this.cur.y);
    await frame(this.page);
  }
  async hold(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) { await this.page.mouse.move(this.cur.x, this.cur.y); await frame(this.page); }
  }
  released = false;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.page.mouse.up();
  }
}

/** Press on `from`, run `body`, always release, then settle. */
export async function gesture(editor: Editor, from: Pt, body: (g: Gesture) => Promise<void>): Promise<void> {
  const g = await Gesture.press(editor.page(), from);
  try {
    await body(g);
  } finally {
    await g.release();
    await editor.page().waitForTimeout(80);
    await editor.settled();
  }
}

/** Real click that waits out the 400ms double-click window afterwards. */
export async function clickAt(editor: Editor, p: Pt): Promise<void> {
  await editor.page().mouse.click(p.x, p.y);
  await editor.page().waitForTimeout(450);
  await editor.settled();
}

// ─── Camera ───────────────────────────────────────────────────────────

/** The canvas content transform (scale + translate), read from the DOM. */
export async function cameraTransform(editor: Editor): Promise<{ scale: number; x: number; y: number }> {
  return editor.sandbox().locator('[data-content-root]').first().evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el as HTMLElement).transform);
    return { scale: m.a, x: m.e, y: m.f };
  });
}

// ─── Module-state toggles (app's own module instance) ─────────────────

/** Viewer role on/off — the same module-level flag ProjectLoader sets from the fetched role. */
export async function setViewerRole(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (v) => {
    const url = '/src/code/stores/viewer-mode-store.ts';
    const m = await import(/* @vite-ignore */ url);
    m.setViewerMode(v);
  }, on);
}

/** Activate a locale through the real locale menu in the top bar. */
export async function pickLocale(page: Page, label: string): Promise<void> {
  await page.locator('[data-tutorial="locale-button"]').click();
  await page.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(400);
}

// ─── Collaboration (no second client: the app's own collab modules) ───

const COLLAB_LOCKS = '/src/canvas/collab/collab-locks.ts';

/** A collaborator's gesture lock, as the socket's `interacting` handler
 *  stores it (collab-locks.setRemoteLock). `ageMs` back-dates its last
 *  heartbeat (a lock whose heartbeats stopped `ageMs` ago). */
export async function remoteLock(page: Page, lock: { socketId?: string; userId?: string; name?: string; nodeIds: string[]; page?: string; ageMs?: number }): Promise<void> {
  await page.evaluate(async ([url, l]) => {
    const m = await import(/* @vite-ignore */ url as string);
    const lk = l as { socketId?: string; userId?: string; name?: string; nodeIds: string[]; page?: string; ageMs?: number };
    m.setRemoteLock({
      socketId: lk.socketId ?? 'e2e-remote', userId: lk.userId ?? 'e2e-remote-user', name: lk.name ?? 'Remote Rita',
      color: '#22aa66', nodeIds: lk.nodeIds, page: lk.page,
    }, Date.now() - (lk.ageMs ?? 0));
  }, [COLLAB_LOCKS, lock] as const);
}

export async function clearRemoteLocks(page: Page): Promise<void> {
  await page.evaluate(async (url) => { const m = await import(/* @vite-ignore */ url); m.clearAllRemoteLocks(); }, COLLAB_LOCKS);
}

/** What this tab currently holds as its own gesture lock. */
export async function localLock(page: Page): Promise<string[]> {
  return page.evaluate(async (url) => { const m = await import(/* @vite-ignore */ url); return [...m.getLocalInteraction()]; }, COLLAB_LOCKS);
}

/** Record every change of this tab's gesture lock (the feed CloudProvider
 *  turns into `interacting` packets) with a performance.now() stamp. */
export async function recordLocalLock(page: Page): Promise<void> {
  await page.evaluate(async (url) => {
    const m = await import(/* @vite-ignore */ url);
    const w = window as any;
    w.__d8LockLog = [];
    w.__d8LockUnsub?.();
    w.__d8LockUnsub = m.subscribeLocalInteraction(() => w.__d8LockLog.push({ t: performance.now(), ids: [...m.getLocalInteraction()] }));
  }, COLLAB_LOCKS);
}

export async function localLockLog(page: Page): Promise<Array<{ t: number; ids: string[] }>> {
  return page.evaluate(() => (window as any).__d8LockLog ?? []);
}

/** A collaborator's file write, applied the way CloudProvider's
 *  `applyRemoteContent` does for the active page: ProjectFS write tagged
 *  remote → queue base sync → mid-gesture stash refresh → the provider's
 *  `repaint()` (a forced canvas render, deferred while a gesture is live and
 *  run on the frame after the drag flag drops). LOCAL mode never mounts the
 *  provider, so its repaint shim is replayed here verbatim; it records
 *  `window.__d8RemoteRepaints` (how many renders, and whether any ran while
 *  the drag was still live). */
export async function remoteWrite(page: Page, path: string, edit: { from: string; to: string }): Promise<string> {
  return page.evaluate(async ([p, e]) => {
    const fsMod = await import(/* @vite-ignore */ '/src/code/project/project-fs.ts' as string);
    const q = await import(/* @vite-ignore */ '/src/code/mutation/mutation-queue.ts' as string);
    const ops = await import(/* @vite-ignore */ '/src/canvas/node-ops.ts' as string);
    const ds = await import(/* @vite-ignore */ '/src/canvas/drag/drag-state-store.ts' as string);
    const w = window as any;
    w.__d8RemoteRepaints = w.__d8RemoteRepaints ?? { count: 0, midGesture: 0 };
    const cur: string = fsMod.projectFS.readFile(p as string) ?? '';
    const ed = e as { from: string; to: string };
    if (!cur.includes(ed.from)) throw new Error(`remoteWrite: "${ed.from}" not in ${p}`);
    const next = cur.replace(ed.from, ed.to);
    fsMod.projectFS.applyRemoteWrite(p as string, next);
    q.syncQueueCode(next);
    q.refreshDeferredFlushWithExternalWrite(next);
    const render = () => { w.__d8RemoteRepaints.count++; if (ds.dragStateOps.get()) w.__d8RemoteRepaints.midGesture++; ops.forceCanvasRender(); };
    if (!ds.dragStateOps.get()) render();
    else {
      const unsub = ds.dragStateOps.subscribe(() => {
        if (ds.dragStateOps.get()) return;
        unsub();
        requestAnimationFrame(render);
      });
    }
    return next;
  }, [path, edit] as const);
}

/** The app's own drag flag (dragStateOps). */
export async function dragFlag(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const m = await import(/* @vite-ignore */ '/src/canvas/drag/drag-state-store.ts' as string);
    return !!m.dragStateOps.get();
  });
}
