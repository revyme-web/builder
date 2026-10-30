// Batch D6 helpers: drag & drop on replica/breakpoint tiles and on component
// masters + variant tiles. Seeds first, then page helpers.

import type { Page } from '@playwright/test';
import { canvasHeader, TILE, TILES, type Tile, type ProjectData } from '../fixtures/project';
import type { Editor } from './editor';
import { parseSource } from './code';
import { parse as babelParse } from '@babel/parser';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

// ─── Seed builders ────────────────────────────────────────────────────

const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

const BLANK_PAGE = `${canvasHeader(TILES.one)}
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }} />
  );
}
`;

/** A full page.client.tsx: header + root JSX + an optional canvasNodes fragment. */
export function pageWithCanvas(opts: {
  tiles: Tile[];
  root: string;
  canvas?: string;
  imports?: string[];
  pre?: string;
}): string {
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const canvas = opts.canvas ? `const canvasNodes = (<>\n${opts.canvas.trim()}\n</>);\n` : '';
  return `${canvasHeader(opts.tiles)}
'use client';
${imports}${opts.pre ?? ''}
export default function Page() {
  return (
${opts.root.trim()}
  );
}
${canvas}`;
}

export function seed(page: string, extra: Record<string, string> = {}): ProjectData {
  return {
    format: 'revyme-v1',
    files: { 'app/page.tsx': PAGE_SERVER_WRAPPER, 'app/page.client.tsx': page, ...extra },
  };
}

/** A component master project: blank home page + `components/<name>.tsx`. */
export function masterSeed(name: string, source: string, extra: Record<string, string> = {}): ProjectData {
  return seed(BLANK_PAGE, { [`components/${name}.tsx`]: source, ...extra });
}

export const FOUR_TILES: Tile[] = [...TILES.three, { id: 'custom', label: 'Custom', width: 600 }];
export { TILE, TILES };

// ─── Page helpers ─────────────────────────────────────────────────────

export const rafs = (page: Page, n = 1) =>
  page.evaluate((k) => new Promise<void>(r => {
    let i = 0;
    const tick = () => (++i >= k ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/** Linear glide between two points, one rAF per move. `onStep` runs after each move. */
export async function glide(page: Page, a: Pt, b: Pt, steps = 10, onStep?: (p: Pt, i: number) => Promise<void>): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    await page.mouse.move(p.x, p.y, { steps: 1 });
    await rafs(page);
    if (onStep) await onStep(p, i);
  }
}

/** ±1px wiggle so entry/exit hysteresis counters tick. */
export async function pump(page: Page, at: Pt, frames = 8): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.mouse.move(at.x + (i % 2 ? 1 : 0), at.y + (i % 2 ? 0 : 1), { steps: 1 });
    await rafs(page);
  }
}

/** Press at `from`, glide through every waypoint (pumping at each), and
 *  call `atWaypoint(i)` after each one with the button still down. Releases
 *  in `finally`. Returns after the post-drop settle. */
export async function gesture(
  editor: Editor,
  from: Pt,
  waypoints: Pt[],
  opts: { steps?: number; pumpFrames?: number; atWaypoint?: (i: number, p: Pt) => Promise<void>; release?: boolean } = {},
): Promise<void> {
  const page = editor.page();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let cur = from;
  try {
    for (let i = 0; i < waypoints.length; i++) {
      await glide(page, cur, waypoints[i], opts.steps ?? 10);
      await pump(page, waypoints[i], opts.pumpFrames ?? 8);
      cur = waypoints[i];
      if (opts.atWaypoint) await opts.atWaypoint(i, cur);
    }
  } finally {
    if (opts.release !== false) {
      await page.mouse.up();
      await editor.settled();
    }
  }
}

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const inside = (p: Pt, b: Box | null, pad = 2) =>
  !!b && p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;

/** Box of the copy of `id` that lives on a tile (or null when it has no box). */
export async function boxIn(editor: Editor, vpId: string, id: string): Promise<Box | null> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return null;
  return loc.boundingBox({ timeout: 2_000 }).catch(() => null);
}

/** boundingBox of the first match, or null right away when nothing matches
 *  (a bare locator.boundingBox() waits for a match until the TEST timeout). */
export async function quickBox(loc: import('@playwright/test').Locator): Promise<Box | null> {
  if ((await loc.count()) === 0) return null;
  return loc.first().boundingBox({ timeout: 2_000 }).catch(() => null);
}

/** Computed display of a node on a tile ('' when the element is missing). */
export async function displayIn(editor: Editor, vpId: string, id: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate(el => getComputedStyle(el).display);
}

/** Bounding box of the copy of `id` that is NOT inside any viewport tile
 *  (a free canvas node), or null. */
export async function canvasBox(editor: Editor, id: string): Promise<Box | null> {
  const loc = editor.sandbox().locator(`[data-id="${id}"]:not([data-viewport] [data-id])`).first();
  return quickBox(loc);
}

/** Trace entries of a category pattern (data JSON-cloned). */
export async function traces(editor: Editor, pattern: string): Promise<Array<{ c: string; data: any }>> {
  return editor.page().evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}

/** How many times `data-id="id"` appears in a file. */
export function idCount(code: string, id: string): number {
  return (code.match(new RegExp(`data-id="${id.replace(/[-]/g, '\\-')}"`, 'g')) ?? []).length;
}

// ─── Tile geometry ────────────────────────────────────────────────────

/** Screen px per canvas px, measured from a tile's root (width:100% = tile width). */
export async function zoomOf(editor: Editor, vpId: string, tileWidth: number, rootId = 'root'): Promise<number> {
  const b = await editor.nodeBoxIn(vpId, rootId);
  return b.width / tileWidth;
}

/** Ids sorted in reading order by their painted boxes on one tile (missing/hidden ones dropped). */
export async function visualOrderIn(editor: Editor, vpId: string, ids: string[]): Promise<string[]> {
  const m: Array<{ id: string; x: number; y: number }> = [];
  for (const id of ids) {
    const b = await boxIn(editor, vpId, id);
    if (b && b.width > 0 && b.height > 0) m.push({ id, x: b.x, y: b.y });
  }
  m.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x));
  return m.map(e => e.id);
}

/** Computed transform of a tile copy ('none' when untransformed). */
export async function transformIn(editor: Editor, vpId: string, id: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate(el => getComputedStyle(el).transform);
}

/** All `order` declarations of one band as {id: value}. */
export async function bandOrders(editor: Editor, width: number, ids: string[], path?: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = (await editor.bandStyle(width, id, 'order', path))?.value ?? null;
  return out;
}

/** Inline `order` of each id as {id: value}. */
export async function inlineOrders(editor: Editor, ids: string[], path?: string): Promise<Record<string, string | null>> {
  const src = await editor.source(path);
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = src.byId.get(id)?.style.order ?? null;
  return out;
}

/** Real click on a node (on a tile) that starts the tile's rect stream and
 *  selects it, then waits out the double-click window so the next press
 *  reads as a fresh drag. */
export async function prime(editor: Editor, id: string, vpId?: string): Promise<void> {
  const b = vpId ? await editor.nodeBoxIn(vpId, id) : await editor.nodeBox(id);
  await editor.page().mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await editor.page().waitForTimeout(650);
}

/** Replica-origin drag setup (the old specs' technique): a real click on the
 *  PARENT starts the tile's rect stream, the hook selects the child with that
 *  tile as the interacting viewport, and the wait breaks the dblclick window. */
export async function primeReplica(editor: Editor, vpId: string, parentId: string, childId: string): Promise<void> {
  await prime(editor, parentId, vpId);
  await editor.select([childId], vpId);
  await editor.page().waitForTimeout(300);
}

/** The smallest visible element with a data-id whose box contains the point,
 *  searched under `scope` (a CSS selector in the sandbox). One round trip. */
export async function elementUnder(editor: Editor, scope: string, p: Pt, exclude: string[] = []): Promise<{ id: string; box: Box } | null> {
  const frame = await editor.page().locator('iframe[src*="5174"]').first().boundingBox();
  if (!frame) return null;
  const local = { x: p.x - frame.x, y: p.y - frame.y };
  const hits = await editor.sandbox().locator(`${scope} [data-id]`).evaluateAll((els, [pt, ex]) => {
    const out: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
    for (const el of els as HTMLElement[]) {
      const id = el.getAttribute('data-id') ?? '';
      if ((ex as string[]).includes(id)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const q = pt as { x: number; y: number };
      if (q.x < r.x - 2 || q.x > r.x + r.width + 2 || q.y < r.y - 2 || q.y > r.y + r.height + 2) continue;
      out.push({ id, x: r.x, y: r.y, width: r.width, height: r.height });
    }
    return out;
  }, [local, exclude] as const);
  if (!hits.length) return null;
  hits.sort((a, b) => a.width * a.height - b.width * b.height);
  const h = hits[0];
  return { id: h.id, box: { x: h.x + frame.x, y: h.y + frame.y, width: h.width, height: h.height } };
}

/** Canvas-root ids: top-level data-canvas-node elements, in source order. */
export function canvasNodeIds(code: string): string[] {
  return parseSource(code).nodes.filter(n => n.parentId === null && n.attrs['data-canvas-node'] === 'true').map(n => n.id);
}

/** True when a selection border (the 1.5px SVG edge lines) starts near this box's top-left. */
export async function selectionBorderAt(editor: Editor, b: Box, tol = 4): Promise<boolean> {
  return editor.page().evaluate(([x, y, t]) => {
    const lines = Array.from(document.querySelectorAll('svg line[stroke-width="1.5"]'));
    return lines.some(l => Math.abs(Number(l.getAttribute('x1')) - x) <= t && Math.abs(Number(l.getAttribute('y1')) - y) <= t);
  }, [b.x, b.y, tol] as const);
}

/** The open file once it stops changing (three equal reads 300ms apart, after settle). */
export async function stableCode(editor: Editor, path?: string, timeout = 8_000): Promise<string> {
  await editor.settled();
  const deadline = Date.now() + timeout;
  let prev = await editor.code(path);
  let same = 0;
  while (Date.now() < deadline && same < 2) {
    await editor.page().waitForTimeout(300);
    const cur = await editor.code(path);
    same = cur === prev ? same + 1 : 0;
    prev = cur;
  }
  await editor.settled();
  return prev;
}

// ─── Shared replica seeds ─────────────────────────────────────────────

/** LOCALE_3VP: a card with a flow child on three tiles; mobile narrows the card. */
export const LOCALE_3VP = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 375px) {
  [data-id="card"] { width: 300px !important; height: auto !important; }
}
\`}</style>
  <div data-id="card" data-name="Card" style={{ display: 'flex', flexDirection: 'column', padding: '48px', width: '600px', height: '300px', position: 'relative', backgroundColor: '#1a1a3a', borderRadius: '12px' }}>
    <div data-id="card-inner" data-name="Inner" style={{ width: '80%', height: '150px', position: 'relative', backgroundColor: '#3b3b6b', borderRadius: '8px' }}></div>
  </div>
</div>` }));

export const EXIT_CANVAS = `
  <div data-id="drop-frame" data-name="DropFrame" data-canvas-node="true" style={{ position: 'absolute', left: '1650px', top: '780px', width: '620px', height: '360px', backgroundColor: '#e8eefc', borderRadius: '10px', overflow: 'hidden' }}>
    <div data-id="dead-child" data-name="DeadChild" style={{ position: 'absolute', width: '440px', height: '198px', backgroundColor: '#0d263a', display: 'none', left: '-3162px', top: '-200px' }}></div>
  </div>
  <div data-id="layout-frame" data-name="LayoutFrame" data-canvas-node="true" style={{ position: 'absolute', left: '860px', top: '780px', width: '620px', height: '360px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', backgroundColor: '#fce8ee', borderRadius: '10px' }}></div>
  <div data-id="canvas-chip" data-name="CanvasChip" data-canvas-node="true" style={{ position: 'absolute', left: '1650px', top: '-200px', width: '180px', height: '80px', backgroundColor: '#7c5cff', borderRadius: '8px' }}></div>
  <div data-id="canvas-flex" data-name="CanvasFlex" data-canvas-node="true" style={{ position: 'absolute', left: '2450px', top: '-260px', width: '200px', height: '120px', display: 'flex', flexDirection: 'row', gap: '8px', padding: '10px', backgroundColor: '#44aa88' }}>
    <div data-id="canvas-flex-kid" data-name="Kid" style={{ width: '40px', height: '40px', backgroundColor: '#ffffff', position: 'relative', flex: '0 0 auto' }}></div>
  </div>`;

/** REPLICA_EXIT_TO_FRAME: a flow child, a tablet-only SOLO chip (manual hide +
 *  tablet un-hide, no data-replica-solo), a mobile-solo frame (the pattern an
 *  add on the Mobile tile writes), and canvas frames/chips below and above. */
export const REPLICA_EXIT_TO_FRAME = seed(pageWithCanvas({ tiles: TILES.three, root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '640px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <style>{\`
@media (max-width: 768px) and (min-width: 375.02px) {
  [data-id="solo-chip"] { display: unset !important; }
}
@media (max-width: 375px) {
  [data-id="m-frame"] { display: block !important; }
}
\`}</style>
  <div data-id="card" data-name="Card" style={{ display: 'flex', flexDirection: 'column', padding: '32px', width: '480px', height: '260px', position: 'relative', backgroundColor: '#1a1a3a', borderRadius: '12px' }}>
    <div data-id="card-inner" data-name="Inner" style={{ width: '240px', height: '110px', position: 'relative', backgroundColor: '#3b3b6b', borderRadius: '8px' }}></div>
    <div data-id="solo-chip" data-name="SoloChip" style={{ width: '180px', height: '70px', position: 'relative', backgroundColor: '#cc4477', borderRadius: '8px', display: 'none' }}></div>
  </div>
  <div data-id="m-frame" data-name="MobileFrame" data-replica-solo="mobile" style={{ width: '200px', height: '90px', position: 'relative', backgroundColor: '#ffaa22', flex: '0 0 auto', display: 'none' }}></div>
</div>`, canvas: EXIT_CANVAS }));


// ─── Replica exit gestures ────────────────────────────────────────────

export const visibleIn = (sel: string) => `${sel} > [data-id]:visible:not([data-id="dead-child"])`;

/** Replica-origin drag: out of the tile straight down, then into `targetId` (a
 *  canvas frame); `atEntry`/`afterTravel` run with the button down. */
export async function exitIntoFrame(
  editor: Editor, vpId: string, dragId: string, targetId: string,
  checks: { atEntry?: (to: Pt) => Promise<void>; afterTravel?: (to2: Pt) => Promise<void> } = {},
): Promise<void> {
  await primeReplica(editor, vpId, 'card', dragId);
  const inner = await editor.nodeBoxIn(vpId, dragId);
  const frame = await editor.nodeBox(targetId);
  const from = { x: inner.x + inner.width / 2 + 8, y: inner.y + inner.height / 2 + 6 };
  const to = center(frame);
  const mid = { x: from.x, y: frame.y - 40 };
  const to2 = { x: to.x + 40, y: to.y + 30 };
  await gesture(editor, from, [mid, to, to2], {
    atWaypoint: async (i) => {
      if (i === 1 && checks.atEntry) await checks.atEntry(to);
      if (i === 2 && checks.afterTravel) await checks.afterTravel(to2);
    },
  });
}


// ─── Component-master readers (variants objects + style ternaries) ────

type AstNode = { type: string; start?: number | null; end?: number | null; [k: string]: any };

function astOf(code: string): AstNode {
  return babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as AstNode;
}

function walk(n: unknown, visit: (n: AstNode) => void): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walk(c, visit); return; }
  const node = n as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walk(node[k], visit);
  }
}

const keyName = (k: AstNode): string | null => (k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : null);

function literal(code: string, v: AstNode): string {
  if (v.type === 'StringLiteral') return v.value;
  if (v.type === 'NumericLiteral') return String(v.value);
  if (v.type === 'UnaryExpression' && v.operator === '-' && v.argument.type === 'NumericLiteral') return String(-v.argument.value);
  if (v.type === 'TemplateLiteral' && v.expressions.length === 0) return v.quasis[0].value.cooked;
  return code.slice(v.start ?? 0, v.end ?? 0);
}

function objectToRecord(code: string, obj: AstNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of obj.properties ?? []) {
    if (p.type !== 'ObjectProperty') continue;
    const k = keyName(p.key);
    if (k) out[k] = literal(code, p.value);
  }
  return out;
}

/** The opening element of the JSX node carrying `data-id`. */
function openingOf(ast: AstNode, id: string): AstNode | null {
  let found: AstNode | null = null;
  walk(ast, (n) => {
    if (found || n.type !== 'JSXOpeningElement') return;
    for (const a of n.attributes ?? []) {
      if (a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === id) { found = n; return; }
    }
  });
  return found;
}

/** A framer `variants` entry for a node: { prop: value } (null when absent). */
export function variantEntry(code: string, id: string, variant: string): Record<string, string> | null {
  const ast = astOf(code);
  const open = openingOf(ast, id);
  if (!open) return null;
  const attr = (open.attributes ?? []).find((a: AstNode) => a.type === 'JSXAttribute' && a.name?.name === 'variants');
  if (!attr) return null;
  let obj: AstNode | null = null;
  const expr = attr.value?.expression as AstNode | undefined;
  if (expr?.type === 'ObjectExpression') obj = expr;
  else if (expr?.type === 'Identifier') {
    walk(ast, (n) => {
      if (!obj && n.type === 'VariableDeclarator' && n.id?.name === expr.name && n.init?.type === 'ObjectExpression') obj = n.init;
    });
  }
  if (!obj) return null;
  const entry = ((obj as AstNode).properties ?? []).find((p: AstNode) => p.type === 'ObjectProperty' && keyName(p.key) === variant);
  return entry && entry.value.type === 'ObjectExpression' ? objectToRecord(code, entry.value) : null;
}

/** A style ternary `prop: drv === 'v1' ? a : drv === 'v2' ? b : c` → { v1: a, v2: b, default: c }.
 *  A plain literal comes back as { default: value }; a missing prop as null. */
export function styleTernary(code: string, id: string, prop: string): { branches: Record<string, string>; driver: string | null } | null {
  const ast = astOf(code);
  const open = openingOf(ast, id);
  if (!open) return null;
  const style = (open.attributes ?? []).find((a: AstNode) => a.type === 'JSXAttribute' && a.name?.name === 'style');
  const obj = style?.value?.expression as AstNode | undefined;
  if (!obj || obj.type !== 'ObjectExpression') return null;
  const p = (obj.properties ?? []).find((q: AstNode) => q.type === 'ObjectProperty' && keyName(q.key) === prop);
  if (!p) return null;
  const branches: Record<string, string> = {};
  let driver: string | null = null;
  let v: AstNode = p.value;
  while (v.type === 'ConditionalExpression' && v.test.type === 'BinaryExpression' && v.test.operator === '===') {
    const l = v.test.left, r = v.test.right;
    const name = l.type === 'Identifier' ? l.name : r.type === 'Identifier' ? r.name : null;
    const lit = l.type === 'StringLiteral' ? l.value : r.type === 'StringLiteral' ? r.value : null;
    if (name) driver = name;
    if (lit != null) branches[lit] = literal(code, v.consequent);
    v = v.alternate;
  }
  branches.default = literal(code, v);
  return { branches, driver };
}

/** The `variantConfig` array as parsed records. */
export function variantConfigOf(code: string): Array<Record<string, string>> {
  const ast = astOf(code);
  let arr: AstNode | null = null;
  walk(ast, (n) => {
    if (!arr && n.type === 'VariableDeclarator' && n.id?.name === 'variantConfig' && n.init?.type === 'ArrayExpression') arr = n.init;
  });
  if (!arr) return [];
  return ((arr as AstNode).elements ?? []).filter((e: AstNode) => e?.type === 'ObjectExpression').map((e: AstNode) => objectToRecord(code, e));
}

// ─── Master seeds ─────────────────────────────────────────────────────

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

/** Open a component master and fit its variant tiles on screen (setup only). */
export async function openMaster(editor: Editor, path = 'components/Card.tsx'): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator('[data-viewport="variant-1"], [data-node-id^="variant-1-"]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}
