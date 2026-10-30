// Batch D7 helpers: drag & drop on grid layouts, templated pages (page +
// LayoutClient) and template files, and overlays (E2E_TEST_PLAN.md §2).
//
// Seeds first (page modules built on d4's `pageSrc`), then page helpers:
//   - grid reads: per-cell boxes, the swap / hover-target traces;
//   - drop-line read with the rotated-line angle;
//   - overlay reads: the portaled copy of an overlay on a tile, its config.

import type { Page, Locator } from '@playwright/test';
import type { Editor } from './editor';
import { TILE, TILES, canvasHeader, type Tile, type ProjectData } from '../fixtures/project';
import { pageSrc, seed, CanvasDrag, frame, PAGE_SERVER_WRAPPER } from './d4';
import { parseSource } from './code';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export { pageSrc, seed, CanvasDrag, frame, TILE, TILES, PAGE_SERVER_WRAPPER };

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;
export const sameBox = (a: Box | null, b: Box | null, tol = 2) =>
  !!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.width, b.width, tol) && near(a.height, b.height, tol);

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

// ─── Source reads ─────────────────────────────────────────────────────

/** The code once it has stopped changing for ~400ms. */
export async function stableCode(editor: Editor, path?: string, timeout = 8_000): Promise<string> {
  await editor.settled();
  const deadline = Date.now() + timeout;
  let last = await editor.code(path);
  let since = Date.now();
  while (Date.now() < deadline) {
    await editor.page().waitForTimeout(100);
    const now = await editor.code(path);
    if (now !== last) { last = now; since = Date.now(); continue; }
    if (Date.now() - since >= 400) break;
  }
  return last;
}

/** Inline `order` of each id ({id: value|null}). */
export async function inlineOrders(editor: Editor, ids: string[], path?: string): Promise<Record<string, string | null>> {
  const src = await editor.source(path);
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = src.byId.get(id)?.style.order ?? null;
  return out;
}

/** The `@media (max-width: W…)` band `order` of each id ({id: value|null}). */
export async function bandOrders(editor: Editor, width: number, ids: string[], path?: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = (await editor.bandStyle(width, id, 'order', path))?.value ?? null;
  return out;
}

export function idCount(code: string, id: string): number {
  return parseSource(code).allIds.filter(x => x === id).length;
}

// ─── Sandbox reads ────────────────────────────────────────────────────

/** Bounding box of a locator right away (null when missing / boxless). */
export async function quickBox(loc: Locator): Promise<Box | null> {
  if ((await loc.count()) === 0) return null;
  const b = await loc.first().boundingBox({ timeout: 1_500 }).catch(() => null);
  return b && b.width > 0 && b.height > 0 ? b : null;
}

/** Box of a node on a tile (primary when vpId is omitted), or null. */
export async function boxOf(editor: Editor, id: string, vpId?: string): Promise<Box | null> {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.sandbox().locator(`[data-node-id="${id}"]`).first();
  return quickBox(loc);
}

/** Boxes of several nodes on a tile. */
export async function boxesOf(editor: Editor, ids: string[], vpId?: string): Promise<Record<string, Box | null>> {
  const out: Record<string, Box | null> = {};
  for (const id of ids) out[id] = await boxOf(editor, id, vpId);
  return out;
}

/** Placeholder boxes on a tile (all tiles when vpId is omitted). */
export async function placeholderBoxes(editor: Editor, vpId?: string): Promise<Box[]> {
  const scope = vpId ? `[data-viewport="${vpId}"] ` : '';
  const loc = editor.sandbox().locator(`${scope}[data-placeholder-id]`);
  const n = await loc.count();
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const b = await loc.nth(i).boundingBox().catch(() => null);
    if (b) out.push(b);
  }
  return out;
}

/** Ids sorted by painted reading order (top, then left within 4px). Boxless ids are left out. */
export async function paintedOrder(editor: Editor, ids: string[], vpId?: string): Promise<string[]> {
  const m: Array<{ id: string; b: Box }> = [];
  for (const id of ids) {
    const b = await boxOf(editor, id, vpId);
    if (b) m.push({ id, b });
  }
  m.sort((a, b) => (Math.abs(a.b.y - b.b.y) > 4 ? a.b.y - b.b.y : a.b.x - b.b.x));
  return m.map(e => e.id);
}

/** How many elements in the sandbox carry this data-id (all tiles). */
export async function domCount(editor: Editor, id: string): Promise<number> {
  return editor.sandbox().locator(`[data-id="${id}"]`).count();
}

/** Computed style of a node on a tile ('' when missing). */
export async function computedOf(editor: Editor, id: string, prop: string, vpId?: string): Promise<string> {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.sandbox().locator(`[data-node-id="${id}"]`).first();
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

// ─── Editor-frame overlays ────────────────────────────────────────────

export interface DropLineRead {
  parentId: string | null;
  insertIndex: number | null;
  rect: Box;
  orientation: 'horizontal' | 'vertical';
  /** Rotation of a non-axis-aligned line (deg), null for the axis-aligned box. */
  angle: number | null;
}

/** The drop line (editor frame), or null when none shows. */
export async function dropLineRead(page: Page): Promise<DropLineRead | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-drop-line-indicator]') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const idx = el.getAttribute('data-insert-index');
    const ang = el.getAttribute('data-drop-line-angle');
    return {
      parentId: el.getAttribute('data-parent-id'),
      insertIndex: idx == null ? null : Number(idx),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      orientation: r.height > r.width ? 'vertical' as const : 'horizontal' as const,
      angle: ang == null ? null : Number(ang),
    };
  });
}

/** Snap guide lines on screen (pink). */
export async function snapGuides(page: Page): Promise<Array<{ vertical: boolean; at: number }>> {
  return page.evaluate(() => [...document.querySelectorAll('line[stroke="#f472b6"]')].map((l) => {
    const r = (l as SVGLineElement).getBoundingClientRect();
    const vertical = r.height > r.width;
    return { vertical, at: vertical ? r.x + r.width / 2 : r.y + r.height / 2 };
  }));
}

// ─── Gestures ─────────────────────────────────────────────────────────

/** Press at a node's point (fraction of its box) and return the live drag. */
export async function pressNode(editor: Editor, id: string, opts: { vpId?: string; fx?: number; fy?: number } = {}): Promise<{ d: CanvasDrag; box: Box; from: Pt }> {
  const box = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  const from = { x: box.x + box.width * (opts.fx ?? 0.5), y: box.y + box.height * (opts.fy ?? 0.5) };
  const d = await CanvasDrag.press(editor.page(), from);
  return { d, box, from };
}

/** Release a drag and let the drop land. */
export async function drop(editor: Editor, d: CanvasDrag): Promise<void> {
  await d.release();
  await editor.page().waitForTimeout(80);
  await editor.settled();
}

/** Throws unless `id` left its start box (the gesture engaged). */
export async function engaged(editor: Editor, id: string, start: Box, vpId?: string): Promise<void> {
  const now = await (vpId ? editor.nodeBoxIn(vpId, id) : editor.nodeBox(id)).catch(() => null);
  if (now && Math.abs(now.x - start.x) < 2 && Math.abs(now.y - start.y) < 2) {
    throw new Error(`Drag never engaged for "${id}": still at (${start.x}, ${start.y}) with the button down.`);
  }
}

/** ±1px wiggle along one axis so per-frame counters tick without changing direction. */
export async function wiggle(d: CanvasDrag, frames = 6, axis: 'x' | 'y' = 'y'): Promise<void> {
  for (let i = 0; i < frames; i++) {
    const o = i % 2 ? 1 : 0;
    await d.page.mouse.move(d.cur.x + (axis === 'x' ? o : 0), d.cur.y + (axis === 'y' ? o : 0));
    await frame(d.page);
  }
  await d.page.mouse.move(d.cur.x, d.cur.y);
  await frame(d.page);
}

/** Real click, then wait out the double-click window. */
export async function clickAt(editor: Editor, p: Pt): Promise<void> {
  const page = editor.page();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await editor.settled();
  await page.waitForTimeout(450);
}

/** Click a node (on a tile) to select it and start that tile's rect stream. */
export async function prime(editor: Editor, id: string, vpId?: string, fx = 0.5, fy = 0.5): Promise<void> {
  const b = vpId ? await editor.nodeBoxIn(vpId, id) : await editor.nodeBox(id);
  await clickAt(editor, { x: b.x + b.width * fx, y: b.y + b.height * fy });
  await editor.page().waitForTimeout(200);
}

// ─── Grid seeds ───────────────────────────────────────────────────────

export const CELL_COLORS = ['#ff5577', '#ff9977', '#ffcc55', '#99dd55', '#55ddaa', '#55aadd', '#7766ee', '#cc66dd'];
export const G8 = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];

const ROOT_OPEN = (extra = '') =>
  `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a'${extra ? `, ${extra}` : ''} }}>`;

/** A grid cell: order-stamped unless `order` is null. */
export function cell(id: string, i: number, opts: { order?: number | null; extra?: string; name?: string } = {}): string {
  const order = opts.order === undefined ? i : opts.order;
  const parts = [`position: 'relative'`, `backgroundColor: '${CELL_COLORS[i % CELL_COLORS.length]}'`];
  if (opts.extra) parts.push(opts.extra);
  if (order !== null) parts.push(`order: '${order}'`);
  return `<div data-id="${id}" data-name="${opts.name ?? id.toUpperCase()}" style={{ ${parts.join(', ')} }}></div>`;
}

/** The 2×4 order-stamped grid: 4 columns × 2 rows, cells g0..g7 with order 0..7,
 *  120px rows, 20px gaps, 760px wide. */
export function grid8(opts: { id?: string; cellExtra?: string; order?: boolean; gridExtra?: string; ids?: string[] } = {}): string {
  const id = opts.id ?? 'grid';
  const ids = opts.ids ?? G8;
  const cells = ids.map((c, i) => `    ${cell(c, i, { order: opts.order === false ? null : i, extra: opts.cellExtra })}`).join('\n');
  return `<div data-id="${id}" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: '120px', gap: '20px', width: '760px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0'${opts.gridExtra ? `, ${opts.gridExtra}` : ''} }}>
${cells}
  </div>`;
}

export function gridPage(body: string, opts: { canvas?: string; tiles?: Tile[]; rootExtra?: string; pre?: string } = {}): ProjectData {
  return seed(pageSrc({ tiles: opts.tiles, pre: opts.pre, root: `${ROOT_OPEN(opts.rootExtra)}
  ${body}
</div>`, canvas: opts.canvas }));
}

// ─── Templated-page seeds ─────────────────────────────────────────────

export const TPL_PAGE = 'app/(Main)/page.client.tsx';
export const TPL_LAYOUT = 'app/(Main)/LayoutClient.tsx';

const LAYOUT_SERVER = `import LayoutClient from './LayoutClient';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;

/** The template (`LayoutClient.tsx`): header, `{children}`, footer in a flex
 *  column, with an optional leading `<style>`. */
export function layoutClient(opts: { style?: string; tiles?: Tile[]; hdrOrder?: string; ftrOrder?: string } = {}): string {
  const hdrOrder = opts.hdrOrder ? `, order: '${opts.hdrOrder}'` : '';
  const ftrOrder = opts.ftrOrder ? `, order: '${opts.ftrOrder}'` : '';
  return `'use client';

${canvasHeader(opts.tiles ?? TILES.one)}

import React from 'react';

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return <div data-id="root" data-name="Layout" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', minHeight: '100vh', backgroundColor: '#101020' }}>
    ${opts.style ?? ''}
    <nav data-id="hdr" data-name="Header" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '60px', backgroundColor: '#eeeeee'${hdrOrder} }}></nav>
    {children}
    <footer data-id="ftr" data-name="Footer" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '60px', backgroundColor: '#cccccc'${ftrOrder} }}></footer>
  </div>;
}
`;
}

export function section(id: string, name: string, color: string, extra = '', kids = ''): string {
  return `<div data-id="${id}" data-name="${name}" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '160px', backgroundColor: '${color}'${extra ? `, ${extra}` : ''} }}>${kids}</div>`;
}

/** A templated page: `app/(Main)/` with layout.tsx + LayoutClient.tsx and a
 *  page whose root holds `rootBody`. */
export function templatedSeed(rootBody: string, opts: {
  tiles?: Tile[]; layout?: string; imports?: string[]; hooks?: string[]; canvas?: string; extra?: Record<string, string>;
} = {}): ProjectData {
  return {
    format: 'revyme-v1',
    files: {
      'app/page.tsx': PAGE_SERVER_WRAPPER,
      'app/page.client.tsx': pageSrc({ root: `<div data-id="home-root" data-name="Home" style={{ width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }} />` }),
      'app/(Main)/layout.tsx': LAYOUT_SERVER,
      [TPL_LAYOUT]: opts.layout ?? layoutClient({ tiles: opts.tiles }),
      'app/(Main)/page.tsx': PAGE_SERVER_WRAPPER,
      [TPL_PAGE]: pageSrc({
        tiles: opts.tiles, imports: opts.imports, hooks: opts.hooks, canvas: opts.canvas,
        root: `<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '900px', backgroundColor: '#ffffff' }}>
  ${rootBody.trim()}
</div>`,
      }),
      ...(opts.extra ?? {}),
    },
  };
}

/** Open the templated page (setup only) and wait for its sections to paint. */
export async function openTemplated(editor: Editor, path = TPL_PAGE, waitId = 'hero'): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator(`[data-node-id="${waitId}"]`).first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
}

// ─── Overlay reads ────────────────────────────────────────────────────

/** The overlay element on a tile (primary when vpId omitted). */
export async function overlayIn(editor: Editor, id: string, vpId = 'desktop'): Promise<Locator> {
  return editor.nodeIn(vpId, id);
}

/** The parsed `data-overlay` config of a node in the source. */
export async function overlayConfig(editor: Editor, id: string, path?: string): Promise<Record<string, any> | null> {
  const raw = await editor.attr(id, 'data-overlay', path);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Enter overlay-edit mode for an overlay (setup only) and wait for it to paint. */
export async function openOverlay(editor: Editor, id: string | null, vpId = 'desktop'): Promise<void> {
  await editor.page().evaluate((i) => (window as any).__e2e.openOverlay(i), id);
  await editor.settled();
  if (!id) return;
  const loc = await editor.nodeIn(vpId, id);
  await loc.waitFor({ state: 'visible', timeout: 10_000 });
  await editor.page().waitForTimeout(300);
}
