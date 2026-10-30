// Batch D4 helpers: layers-panel drag and drop, and the canvas modifiers
// (Shift axis lock, Cmd promote/bypass, Alt distance, ruler-guide snapping).
// E2E_TEST_PLAN.md §2.
//
// What the shared Editor lacks for these rows:
//   - a layers-panel drag (`dragLayerRow`) that presses a row, crosses the 3px
//     threshold, holds still near the list edge until the auto-scroll brings
//     the target row on screen, and aims at the row's top / middle / bottom
//     zone (the drop-position logic in src/editor/LayersPanel/drag.ts);
//   - reads of the tree's drop indicator, the canvas drop-inside highlight
//     (LayerDropHighlight) and the Alt measuring overlay (DistanceIndicators);
//   - modifier choreography around a canvas drag (`holdKey`, `pressMidDrag`);
//   - remote collaborator locks (collab-locks.ts) without a second client.

import type { Locator, Page } from '@playwright/test';
import type { Editor } from './editor';
import { canvasHeader, TILES, type Tile, type ProjectData } from '../fixtures/project';
import { parseSource } from './code';
import { parse as babelParse } from '@babel/parser';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type DropPos = 'before' | 'after' | 'inside';
/** Row zone: top 15%, middle, bottom 85% — or an explicit vertical fraction. */
export type Zone = 'top' | 'middle' | 'bottom' | number;

export const frame = (page: Page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
export async function frames(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame(page);
}

// ─── Seed builders ────────────────────────────────────────────────────

export const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A full page.client.tsx: header (+ optional extra annotation such as
 *  `@rulerGuides`), imports, module consts, hooks, root JSX, canvasNodes. */
export function pageSrc(opts: {
  root: string;
  tiles?: Tile[];
  canvas?: string;
  imports?: string[];
  pre?: string;
  hooks?: string[];
  header?: string;
  positions?: Record<string, { x: number; y: number }>;
}): string {
  let head = canvasHeader(opts.tiles ?? TILES.one);
  if (opts.positions) {
    const m = /\/\*\* @canvas ([\s\S]*) \*\//.exec(head)!;
    const cfg = JSON.parse(m[1]);
    cfg.positions = { ...cfg.positions, ...opts.positions };
    head = `/** @canvas ${JSON.stringify(cfg, null, 2)} */`;
  }
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const hooks = (opts.hooks ?? []).map(h => `  ${h}\n`).join('');
  const canvas = opts.canvas ? `const canvasNodes = (<>\n${opts.canvas.trim()}\n</>);\n` : '';
  return `${head}
${opts.header ? `\n${opts.header}\n` : ''}
'use client';
${imports}${opts.pre ? `\n${opts.pre.trim()}\n` : ''}
export default function Page() {
${hooks}  return (
${opts.root.trim()}
  );
}
${canvas}`;
}

export function seed(page: string, extra: Record<string, string> = {}): ProjectData {
  return { format: 'revyme-v1', files: { 'app/page.tsx': PAGE_SERVER_WRAPPER, 'app/page.client.tsx': page, ...extra } };
}

export const MASTER_HEAD = `'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

export const MASTER_3V_CONFIG = `const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 450, y: 0 },
  { name: 'variant-2', label: 'Mobile', x: 900, y: 0 },
];`;

/** A design-component master module around `body` (the root element JSX). */
export function masterModule(body: string, opts: { config?: string; pre?: string; name?: string } = {}): string {
  const name = opts.name ?? 'Card';
  return `${MASTER_HEAD}
${opts.config ?? MASTER_3V_CONFIG}
${opts.pre ?? ''}
function ${name}({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
${body.trim()}
  );
}

export default withResponsiveProps(${name});
`;
}

const BLANK_PAGE = pageSrc({ root: `<div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }} />` });

export function masterSeed(name: string, source: string, extra: Record<string, string> = {}): ProjectData {
  return seed(BLANK_PAGE, { [`components/${name}.tsx`]: source, ...extra });
}

/** Open a component master (setup only) and fit its variant tiles. */
export async function openMaster(editor: Editor, path = 'components/Card.tsx'): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator('[data-node-id^="variant-1-"]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}

// ─── Source polling ───────────────────────────────────────────────────

/** Poll a file until `pred` holds; returns the code (throws with the last code on timeout). */
export async function pollCode(editor: Editor, pred: (code: string) => boolean, opts: { path?: string; timeout?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeout ?? 6_000);
  let code = await editor.code(opts.path);
  while (!pred(code) && Date.now() < deadline) {
    await editor.page().waitForTimeout(100);
    code = await editor.code(opts.path);
  }
  return code;
}

/** Code that stopped changing for ~400ms (a drop can land in two flushes). */
export async function stableCode(editor: Editor, path?: string, timeout = 8_000): Promise<string> {
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

/** JSX elements carrying `data-id={id}` (AST count — generated effects name
 *  ids inside querySelector strings, which a text count would include). */
export function idCount(code: string, id: string): number {
  return parseSource(code).allIds.filter(x => x === id).length;
}

// ─── Traces ───────────────────────────────────────────────────────────

export interface TraceEntry { ts: number; c: string; data: any }

export async function traces(page: Page, pattern?: string): Promise<TraceEntry[]> {
  return page.evaluate((p) => (window as any).__e2e.traceEntries(p), pattern);
}
export async function traceMark(page: Page): Promise<number> {
  const all = await traces(page);
  return all.length ? all[all.length - 1].ts : 0;
}
export async function tracesSince(page: Page, since: number, pattern?: string): Promise<TraceEntry[]> {
  return (await traces(page, pattern)).filter(e => e.ts > since);
}

// ─── Layers panel ─────────────────────────────────────────────────────

/** Row id of a node in a tile's section of the tree (`desktop:hero`). */
export const lid = (nodeId: string, vpId = 'desktop') => `${vpId}:${nodeId}`;
/** Viewport / variant header row id. */
export const vpRow = (vpId: string) => `__vp_${vpId}`;

export function layersList(page: Page): Locator {
  return page.locator('[data-layers-scroll]');
}

export function layerRow(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-id="${layerId}"]`);
}

/** The Layers panel is the home panel; open it through the left menu when another panel is up. */
export async function openLayers(page: Page): Promise<void> {
  if (await layersList(page).isVisible().catch(() => false)) return;
  await page.locator('[data-tutorial="layers-button"]').click();
  await layersList(page).waitFor({ state: 'visible', timeout: 10_000 });
}

async function rowExpanded(row: Locator): Promise<boolean | null> {
  // The chevron is the row's first button; its svg points down when expanded.
  const chevron = row.locator('button').first();
  if (!(await chevron.count())) return null;
  return (await chevron.locator('polyline[points="6 9 12 15 18 9"]').count()) > 0;
}

/** Expand a row by its chevron (no-op when already open or childless). */
export async function expandRow(page: Page, layerId: string): Promise<void> {
  const row = layerRow(page, layerId);
  await row.waitFor({ state: 'attached', timeout: 10_000 });
  const open = await rowExpanded(row);
  if (open !== false) return;
  await row.scrollIntoViewIfNeeded();
  await row.locator('button').first().click();
  await page.waitForFunction((id) => {
    const r = document.querySelector(`[data-layer-id="${id}"]`);
    return !!r?.querySelector('button polyline[points="6 9 12 15 18 9"]');
  }, layerId, { timeout: 5_000 });
}

/** Expand the tile header and every ancestor row of `nodeId` so its row exists. */
export async function revealRow(editor: Editor, nodeId: string, vpId = 'desktop'): Promise<Locator> {
  const page = editor.page();
  await openLayers(page);
  const snap: Record<string, { parentId: string | null }> = await page.evaluate(() => (window as any).__e2e.nodesSnapshot());
  const chain: string[] = [];
  let p = snap[nodeId]?.parentId ?? null;
  while (p) { chain.unshift(p); p = snap[p]?.parentId ?? null; }
  if (await layerRow(page, vpRow(vpId)).count()) await expandRow(page, vpRow(vpId));
  for (const a of chain) {
    if (await layerRow(page, lid(a, vpId)).count()) await expandRow(page, lid(a, vpId));
  }
  const row = layerRow(page, lid(nodeId, vpId));
  await row.waitFor({ state: 'attached', timeout: 10_000 });
  return row;
}

export interface RowIndicator { layerId: string; position: DropPos }

/** The tree's drop indicator: which row draws it and where (null = none). */
export async function rowIndicator(page: Page): Promise<RowIndicator | null> {
  return page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-layer-id]')) {
      for (const c of row.children) {
        const cls = (c as HTMLElement).className;
        if (typeof cls !== 'string') continue;
        if (cls.includes('cut-border')) return { layerId: row.getAttribute('data-layer-id')!, position: 'inside' as const };
        if (cls.includes('h-0.5') && cls.includes('top-0')) return { layerId: row.getAttribute('data-layer-id')!, position: 'before' as const };
        if (cls.includes('h-0.5') && cls.includes('bottom-0')) return { layerId: row.getAttribute('data-layer-id')!, position: 'after' as const };
      }
    }
    return null;
  });
}

/** The canvas outline LayerDropHighlight draws while the tree shows a drop-inside. */
export async function canvasDropHighlight(page: Page): Promise<{ rect: Box; fillOpacity: string | null; stroke: string | null } | null> {
  return page.evaluate(() => {
    const path = [...document.querySelectorAll('svg > path[fill-opacity="0.1"][stroke-width="2"]')]
      .find(p => (p.parentElement as unknown as SVGElement).style.position === 'fixed') as SVGPathElement | undefined;
    if (!path) return null;
    const r = path.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, fillOpacity: path.getAttribute('fill-opacity'), stroke: path.getAttribute('stroke') };
  });
}

/** Screen point on a row: on its name (left part, clear of the chevron and the
 *  right-hand lock/eye buttons) at the given vertical fraction. */
async function rowPoint(page: Page, layerId: string, fy: number): Promise<Pt> {
  const row = layerRow(page, layerId);
  const b = await row.boundingBox();
  if (!b) throw new Error(`layer row ${layerId} has no box`);
  const depth = Number(await row.getAttribute('data-layer-depth') ?? '0');
  const list = await layersList(page).boundingBox();
  const right = list ? Math.min(list.x + list.width - 70, b.x + b.width - 70) : b.x + b.width - 70;
  const x = Math.min(b.x + 12 + depth * 20 + 52, right);
  return { x, y: b.y + b.height * fy };
}

const ZONE_FY: Record<'top' | 'middle' | 'bottom', number> = { top: 0.15, middle: 0.5, bottom: 0.85 };

/** Where the row sits relative to the list's usable area. A row inside the
 *  52px auto-scroll band counts as off screen while the list can still scroll
 *  that way (hovering it would scroll it out from under the cursor). */
async function rowOnScreen(page: Page, layerId: string, margin = 56): Promise<'above' | 'below' | 'on'> {
  const b = await layerRow(page, layerId).boundingBox();
  const l = await layersList(page).boundingBox();
  if (!b || !l) return 'below';
  const sc = await layersList(page).evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  const topMargin = sc.top > 0 ? margin : 0;
  const botMargin = sc.top < sc.max - 1 ? margin : 0;
  if (b.y < l.y + topMargin) return 'above';
  if (b.y + b.height > l.y + l.height - botMargin) return 'below';
  return 'on';
}

export interface LayerDragSession {
  page: Page;
  cur: Pt;
  moveTo(p: Pt, steps?: number): Promise<void>;
  /** Hover a row's zone (auto-scrolling the list there first when needed). */
  hoverRow(layerId: string, zone: Zone): Promise<void>;
  release(): Promise<void>;
}

/** Press a layers row and cross the 3px drag threshold; the caller moves and releases. */
export async function pressLayerRow(page: Page, fromLayerId: string): Promise<LayerDragSession> {
  const row = layerRow(page, fromLayerId);
  await row.scrollIntoViewIfNeeded();
  const start = await rowPoint(page, fromLayerId, 0.5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const s: LayerDragSession = {
    page,
    cur: start,
    async moveTo(p, steps = 8) {
      const from = this.cur;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(from.x + (p.x - from.x) * t, from.y + (p.y - from.y) * t);
        await frame(page);
      }
      this.cur = p;
    },
    async hoverRow(layerId, zone) {
      // Hold still in the edge band until the list auto-scrolls the row on screen.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const where = await rowOnScreen(page, layerId);
        if (where === 'on') break;
        if (Date.now() > deadline) throw new Error(`auto-scroll never brought ${layerId} on screen`);
        const l = (await layersList(page).boundingBox())!;
        const edge = { x: l.x + Math.min(120, l.width / 2), y: where === 'below' ? l.y + l.height - 6 : l.y + 6 };
        if (Math.abs(this.cur.y - edge.y) > 1 || Math.abs(this.cur.x - edge.x) > 1) await this.moveTo(edge, 6);
        await frames(page, 4);
      }
      const fy = typeof zone === 'number' ? zone : ZONE_FY[zone];
      const p = await rowPoint(page, layerId, fy);
      await this.moveTo(p, 8);
      // Re-aim after the move (the list can still be settling a scroll).
      const again = await rowPoint(page, layerId, fy);
      await page.mouse.move(again.x, again.y);
      this.cur = again;
      await frames(page, 2);
    },
    async release() {
      await page.mouse.up();
    },
  };
  // Cross the 3px threshold so the drag is live before anything else.
  await s.moveTo({ x: start.x + 6, y: start.y + 6 }, 3);
  return s;
}

/**
 * Drag a layers row onto another row's top / middle / bottom zone and drop.
 * Asserts the drag engaged (the source row dims) and returns the drop
 * indicator that was showing right before release (null = none).
 */
export async function dragLayerRow(
  editor: Editor, fromLayerId: string, toLayerId: string, zone: Zone,
  opts: { during?: (s: LayerDragSession) => Promise<void> } = {},
): Promise<RowIndicator | null> {
  const page = editor.page();
  await openLayers(page);
  const s = await pressLayerRow(page, fromLayerId);
  let ind: RowIndicator | null = null;
  try {
    const dimmed = await page.evaluate((id) => {
      const r = document.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null;
      return !!r && r.className.includes('opacity-40');
    }, fromLayerId);
    if (!dimmed) throw new Error(`layers drag never engaged for ${fromLayerId}`);
    await s.hoverRow(toLayerId, zone);
    if (opts.during) await opts.during(s);
    ind = await rowIndicator(page);
  } finally {
    await s.release();
    await page.waitForTimeout(80);
    await editor.settled();
  }
  return ind;
}

// ─── Keyboard modifiers ───────────────────────────────────────────────

/** Hold a modifier around `body` (always released). */
export async function holdKey<T>(page: Page, key: 'Alt' | 'Shift' | 'Meta' | 'Control', body: () => Promise<T>): Promise<T> {
  await page.keyboard.down(key);
  try {
    return await body();
  } finally {
    await page.keyboard.up(key);
  }
}

// ─── Canvas drag session ──────────────────────────────────────────────

export class CanvasDrag {
  cur: Pt;
  constructor(readonly page: Page, from: Pt) { this.cur = from; }
  static async press(page: Page, from: Pt): Promise<CanvasDrag> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    return new CanvasDrag(page, from);
  }
  async moveTo(to: Pt, steps = 10, onFrame?: () => Promise<void>): Promise<void> {
    const from = this.cur;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await frame(this.page);
      if (onFrame) await onFrame();
    }
    this.cur = to;
  }
  async moveBy(dx: number, dy: number, steps = 10, onFrame?: () => Promise<void>): Promise<void> {
    await this.moveTo({ x: this.cur.x + dx, y: this.cur.y + dy }, steps, onFrame);
  }
  /** Sit still for a few frames (snap/velocity settle at low speed). */
  async hold(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.page.mouse.move(this.cur.x, this.cur.y);
      await frame(this.page);
    }
  }
  async release(): Promise<void> { await this.page.mouse.up(); }
}

/** Press a modifier mid-drag and nudge so the strategy sees it on a move. */
export async function pressMidDrag(d: CanvasDrag, key: 'Alt' | 'Shift' | 'Meta', down: boolean): Promise<void> {
  if (down) await d.page.keyboard.down(key); else await d.page.keyboard.up(key);
  await frame(d.page);
}

// ─── Alt measuring overlay ────────────────────────────────────────────

export interface MeasureRead { lines: number; dashed: number; labels: string[]; lineColor: string | null; labelColor: string | null }

/** The Alt distance overlay: pink lines (+ dashed elbow reaches) and their px labels. */
export async function measureOverlay(page: Page): Promise<MeasureRead> {
  return page.evaluate(() => {
    const svgs = [...document.querySelectorAll('body svg')].filter(s => (s as SVGElement).style.zIndex === '4998');
    let lines = 0; let dashed = 0; let lineColor: string | null = null;
    for (const s of svgs) {
      for (const l of s.querySelectorAll('line')) {
        const stroke = l.getAttribute('stroke') ?? '';
        if (!stroke.includes('255, 124, 221')) continue;
        lineColor = stroke;
        if (l.getAttribute('stroke-dasharray')) dashed++;
        else lines++;
      }
    }
    const labels: string[] = []; let labelColor: string | null = null;
    for (const d of document.querySelectorAll('body > div')) {
      const el = d as HTMLElement;
      if (el.style.position !== 'fixed' || el.style.zIndex !== '4999') continue;
      const bg = el.style.backgroundColor;
      if (!bg.includes('255, 124, 221')) continue;
      labelColor = bg;
      labels.push((el.textContent ?? '').trim());
    }
    return { lines, dashed, labels, lineColor, labelColor };
  });
}

/** Pink snap alignment guides currently drawn (the drag snap overlay). */
export async function snapGuideCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('line[stroke="#f472b6"]').length);
}

// ─── Collaboration locks ──────────────────────────────────────────────

/** Inject a collaborator's gesture lock straight into the app's collab-locks
 *  module (same instance the app imported: Vite serves one module per URL). */
export async function injectRemoteLock(page: Page, lock: { nodeIds: string[]; name?: string; page?: string }): Promise<void> {
  await page.evaluate(async (l) => {
    const url = '/src/canvas/collab/collab-locks.ts';
    const m = await import(/* @vite-ignore */ url);
    m.setRemoteLock({ socketId: 'e2e-remote', userId: 'e2e-remote-user', name: l.name ?? 'Remote Rita', color: '#22aa66', nodeIds: l.nodeIds, page: l.page });
  }, lock);
}

export async function releaseRemoteLock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/src/canvas/collab/collab-locks.ts';
    const m = await import(/* @vite-ignore */ url);
    m.clearRemoteLock('e2e-remote');
  });
}

// ─── Master variant objects ───────────────────────────────────────────

/** `const <name> = { default: {...}, 'variant-1': {...} }` → entries as
 *  string maps (literals unquoted, expressions as source). Null when absent. */
export function variantsConst(code: string, name: string): Record<string, Record<string, string>> | null {
  const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as any;
  let found: any = null;
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object' || found) return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === 'VariableDeclarator' && n.id?.name === name && n.init?.type === 'ObjectExpression') { found = n.init; return; }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') visit(n[k]);
  };
  visit(ast.program);
  if (!found) return null;
  const keyOf = (k: any) => k.type === 'Identifier' ? k.name : String(k.value);
  const out: Record<string, Record<string, string>> = {};
  for (const p of found.properties) {
    if (p.type !== 'ObjectProperty' || p.value.type !== 'ObjectExpression') continue;
    const entry: Record<string, string> = {};
    for (const q of p.value.properties) {
      if (q.type !== 'ObjectProperty') continue;
      const v = q.value;
      entry[keyOf(q.key)] = v.type === 'StringLiteral' || v.type === 'NumericLiteral' ? String(v.value) : code.slice(v.start, v.end);
    }
    out[keyOf(p.key)] = entry;
  }
  return out;
}

/** The source text of the smallest `{ … && … }` JSX expression that wraps the
 *  element with `data-id={id}` (its visibility conditional), or null. */
export function conditionalAround(code: string, id: string): string | null {
  const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as any;
  let best: string | null = null;
  const hasId = (el: any) => el?.type === 'JSXElement' && el.openingElement.attributes.some((a: any) =>
    a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === id);
  const unwrap = (e: any): any => (e?.type === 'ParenthesizedExpression' ? unwrap(e.expression) : e);
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === 'JSXExpressionContainer' && n.expression?.type === 'LogicalExpression' && n.expression.operator === '&&') {
      const right = unwrap(n.expression.right);
      if (hasId(right)) best = code.slice(n.expression.left.start, n.expression.left.end);
    }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') visit(n[k]);
  };
  visit(ast.program);
  return best;
}

// ─── Canvas geometry / camera ─────────────────────────────────────────

/** Canvas scale read off a node's painted width vs its CSS width. */
export async function scaleOf(editor: Editor, id: string, cssWidth: number): Promise<number> {
  return (await editor.nodeBox(id)).width / cssWidth;
}

/** Wait until a node's screen box stops moving (camera animations settle). */
export async function boxSettled(editor: Editor, id: string, timeout = 5_000): Promise<Box> {
  const deadline = Date.now() + timeout;
  let last = await editor.nodeBox(id);
  let still = 0;
  while (Date.now() < deadline && still < 3) {
    await editor.page().waitForTimeout(80);
    const now = await editor.nodeBox(id);
    still = Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5 && Math.abs(now.width - last.width) < 0.5 ? still + 1 : 0;
    last = now;
  }
  return last;
}

/** A trackpad pinch: wheel events with ctrlKey set but NO Control keydown
 *  (what browsers synthesise for a pinch), sent through CDP. */
export async function pinch(page: Page, at: Pt, deltaY: number, ticks = 1): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let i = 0; i < ticks; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY, modifiers: 2 });
      await frame(page);
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Seed the Direct-selection preference before the editor boots (setup only). */
export async function presetDirectSelection(page: Page, enabled: boolean): Promise<void> {
  await page.addInitScript((v) => {
    try { localStorage.setItem('revyme:prefs:directSelectionEnabled', JSON.stringify(v)); } catch { /* private mode */ }
  }, enabled);
}


/** Pink snap alignment lines (drag snap overlay), with orientation. */
export async function snapGuideLines(page: Page): Promise<Array<{ vertical: boolean; at: number }>> {
  return page.evaluate(() => [...document.querySelectorAll('line[stroke="#f472b6"]')].map((l) => {
    const x1 = Number(l.getAttribute('x1')), x2 = Number(l.getAttribute('x2'));
    const y1 = Number(l.getAttribute('y1'));
    const vertical = Math.abs(x1 - x2) < 0.5;
    return { vertical, at: vertical ? x1 : y1 };
  }));
}

/** Two-finger scroll (plain wheel) over the canvas until `id`'s centre sits at `target`. */
export async function panNodeTo(editor: Editor, id: string, target: Pt): Promise<void> {
  const page = editor.page();
  for (let i = 0; i < 6; i++) {
    const b = await editor.nodeBox(id);
    const dx = b.x + b.width / 2 - target.x;
    const dy = b.y + b.height / 2 - target.y;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel(dx, dy);
    await frames(page, 3);
  }
}
