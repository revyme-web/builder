// Batch D3 helpers: drag & drop ENTRY into frames / layouts / viewport roots,
// and EXIT, reparent and mid-drag handoff (E2E_TEST_PLAN.md §2).
//
// Seeds first (page modules built on d6's `pageWithCanvas`), then page helpers:
//   - a per-frame rect sampler that runs INSIDE the sandbox (`startSampler`),
//     so an entry/exit jump between two rAFs can't hide between our reads;
//   - DOM-parent and canvas-node reads;
//   - `queueMutation` trace counts (one `move` per crossing);
//   - `setZoom` (Shift+3, then Ctrl± steps) and `panBy` (wheel).

import type { Frame, Page } from '@playwright/test';
import type { Editor } from './editor';
import { TILE, type Tile, type ProjectData } from '../fixtures/project';
import { seed, pageWithCanvas } from './d6';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export const ONE: Tile[] = [TILE.desktop];

/** A one-tile page with an optional `canvasNodes` fragment (extra files allowed). */
export function pageSeed(root: string, canvas?: string, opts: { tiles?: Tile[]; imports?: string[]; pre?: string; extra?: Record<string, string> } = {}): ProjectData {
  return seed(pageWithCanvas({ tiles: opts.tiles ?? ONE, root, canvas, imports: opts.imports, pre: opts.pre }), opts.extra ?? {});
}

// ─── Seeds ────────────────────────────────────────────────────────────

/** CANVAS_NODE_WITH_GAP: flex column root with 60px gaps + a 120px canvas floater. */
export const GAP = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '60px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '200px', backgroundColor: '#ffffff' }}></div>
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '120px', height: '120px', backgroundColor: '#ff66cc' }}></div>`);

/** CANVAS_ENTRY: a no-layout canvas frame and a chip below it (+ a second
 *  frame to the left for multi-hop gestures). */
export const ENTRY = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', position: 'relative', width: '100%', minHeight: '400px', backgroundColor: '#ffffff' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '300px', backgroundColor: '#f5f5f7' }}></div>
</div>`, `
  <div data-id="big-frame" data-name="BigFrame" data-canvas-node="true" style={{ position: 'absolute', left: '-380px', top: '60px', width: '320px', height: '240px', backgroundColor: '#e8eefc' }}></div>
  <div data-id="frame-b" data-name="FrameB" data-canvas-node="true" style={{ position: 'absolute', left: '-760px', top: '60px', width: '320px', height: '240px', backgroundColor: '#fce8ee' }}></div>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-330px', top: '360px', width: '90px', height: '90px', backgroundColor: '#ff66cc' }}></div>`);

/** An EMPTY flex frame in the page, next to a no-layout tray with an absolute peer (pin/snap bait). */
export const EMPTY_FLEX = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', backgroundColor: '#0d0d1a' }}>
  <div data-id="empty" data-name="Empty" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '600px', height: '240px', backgroundColor: '#203020', flex: '0 0 auto', position: 'relative' }}></div>
  <div data-id="tray" data-name="Tray" style={{ width: '600px', height: '240px', backgroundColor: '#303040', flex: '0 0 auto', position: 'relative' }}>
    <div data-id="peer" data-name="Peer" style={{ position: 'absolute', left: '40px', top: '40px', width: '60px', height: '40px', backgroundColor: '#33ccff' }}></div>
  </div>
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '80px', height: '80px', backgroundColor: '#ff66cc' }}></div>`);

// ─── Sandbox reads ────────────────────────────────────────────────────

/** The sandbox iframe as a Frame (for in-frame evaluate). */
export function sandboxFrame(page: Page): Frame {
  const f = page.frames().find(fr => fr.url().includes('5174'));
  if (!f) throw new Error('sandbox frame not found');
  return f;
}

/** data-id of the painted element's DOM parent (the visible copy; null when missing). */
export async function domParent(editor: Editor, id: string): Promise<string | null> {
  return sandboxFrame(editor.page()).evaluate((i) => {
    const els = [...document.querySelectorAll(`[data-id="${i}"]`)] as HTMLElement[];
    const el = els.find(e => e.getBoundingClientRect().width > 0) ?? els[0];
    return el?.parentElement?.closest('[data-id]')?.getAttribute('data-id') ?? null;
  }, id);
}

/** Number of painted (non-zero, not display:none) elements carrying data-id. */
export async function paintedCount(editor: Editor, id: string): Promise<number> {
  return sandboxFrame(editor.page()).evaluate((i) => [...document.querySelectorAll(`[data-id="${i}"]`)]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; }).length, id);
}

export interface Sample { t: number; x: number; y: number; w: number; h: number; n: number; parent: string | null }

/** Start sampling `id`'s painted rect every animation frame INSIDE the sandbox
 *  (sandbox-local coords; add the iframe offset to compare with the cursor). */
export async function startSampler(editor: Editor, id: string): Promise<void> {
  await sandboxFrame(editor.page()).evaluate((i) => {
    const w = window as any;
    w.__d3Samples = [];
    w.__d3Stop = false;
    const tick = () => {
      if (w.__d3Stop) return;
      const els = [...document.querySelectorAll(`[data-id="${i}"]`)] as HTMLElement[];
      const vis = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; });
      const el = vis[vis.length - 1];
      if (el) {
        const r = el.getBoundingClientRect();
        w.__d3Samples.push({ t: performance.now(), x: r.x, y: r.y, w: r.width, h: r.height, n: vis.length, parent: el.parentElement?.closest('[data-id]')?.getAttribute('data-id') ?? null });
      }
      if (w.__d3Samples.length < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

/** Stop the sampler and return its samples, in PAGE coordinates. */
export async function stopSampler(editor: Editor): Promise<Sample[]> {
  const off = await editor.page().locator('iframe[src*="5174"]').first().boundingBox();
  const raw: Sample[] = await sandboxFrame(editor.page()).evaluate(() => { const w = window as any; w.__d3Stop = true; return w.__d3Samples ?? []; });
  return raw.map(s => ({ ...s, x: s.x + (off?.x ?? 0), y: s.y + (off?.y ?? 0) }));
}

/** Largest per-frame centre jump among samples. */
export function maxJump(samples: Sample[]): { d: number; at: number } {
  let d = 0, at = -1;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const j = Math.hypot(b.x + b.w / 2 - (a.x + a.w / 2), b.y + b.h / 2 - (a.y + a.h / 2));
    if (j > d) { d = j; at = i; }
  }
  return { d, at };
}

// ─── Source reads ─────────────────────────────────────────────────────

/** True when `id` is a top-level canvas node in the source (canvasNodes, data-canvas-node). */
export async function isCanvasNode(editor: Editor, id: string, path?: string): Promise<boolean> {
  const n = (await editor.source(path)).byId.get(id);
  return !!n && n.parentId === null && n.attrs['data-canvas-node'] === 'true';
}

/** The open file once it stops changing (three equal reads 250ms apart, after settle). */
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

// ─── Traces ───────────────────────────────────────────────────────────

export interface TraceEntry { ts: number; c: string; data: any }

export async function traces(page: Page, pattern?: string): Promise<TraceEntry[]> {
  return page.evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}

export async function traceMark(page: Page): Promise<number> {
  const all = await traces(page);
  return all.length ? all[all.length - 1].ts : 0;
}

export async function tracesSince(page: Page, since: number, pattern?: string): Promise<TraceEntry[]> {
  return (await traces(page, pattern)).filter(e => e.ts > since);
}

/** `move` mutations queued for `nodeId` since `since` (each queueMutation trace). */
export async function moveMutations(page: Page, since: number, nodeId: string): Promise<TraceEntry[]> {
  return (await tracesSince(page, since, '^queueMutation$')).filter(e => e.data?.type === 'move' && e.data?.nodeId === nodeId);
}

// ─── Camera ───────────────────────────────────────────────────────────

/** Screen px per CSS px, read from a node whose CSS width is known. */
export async function scaleOf(editor: Editor, id: string, cssWidth: number): Promise<number> {
  const b = await editor.nodeBox(id);
  return b.width / cssWidth;
}

async function waitStable(editor: Editor, id: string): Promise<void> {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    await editor.page().waitForTimeout(60);
    const b = await editor.nodeBox(id).catch(() => null);
    const w = b ? Math.round(b.width * 100) : -2;
    if (w === prev) return;
    prev = w;
  }
}

/** Zoom to `scale` exactly: Shift+3 (100%) then 10% Ctrl± steps anchored at
 *  the midpoint of the `focus` nodes, then pan that midpoint to the middle of
 *  the window. Waits out each animation on the reference node. */
export async function setZoom(editor: Editor, scale: number, ref: { id: string; cssWidth: number }, focus: string[] = []): Promise<number> {
  const page = editor.page();
  const mid = async (): Promise<Pt | null> => {
    if (!focus.length) return null;
    const boxes = await Promise.all(focus.map(id => editor.nodeBox(id)));
    const x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.width));
    const y0 = Math.min(...boxes.map(b => b.y)), y1 = Math.max(...boxes.map(b => b.y + b.height));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  };
  await editor.blur();
  await page.keyboard.press('Shift+Digit3');
  await waitStable(editor, ref.id);
  const anchor = await mid();
  if (anchor) await page.mouse.move(anchor.x, anchor.y);
  const steps = Math.round((scale - 1) / 0.1);
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.keyboard.press(steps > 0 ? 'ControlOrMeta+Equal' : 'ControlOrMeta+Minus');
    await waitStable(editor, ref.id);
  }
  const m = await mid();
  if (m) await panBy(editor, m, CANVAS_MID);
  await editor.settled();
  return scaleOf(editor, ref.id, ref.cssWidth);
}

/** Pan the camera with a plain wheel so screen point `from` moves to `to`. */
export async function panBy(editor: Editor, from: Pt, to: Pt): Promise<void> {
  const page = editor.page();
  await page.mouse.move(from.x, from.y);
  await page.mouse.wheel(from.x - to.x, from.y - to.y);
  await page.waitForTimeout(250);
  await editor.settled();
}

/** The canvas area left free by the side panels (layers ≈ 0–340, properties ≈ 1340–1600). */
export const CANVAS_MID: Pt = { x: 840, y: 520 };

/** Pan (wheel) so the bounding box of `ids` is centred in the free canvas area. */
export async function centerOn(editor: Editor, ids: string[], at: Pt = CANVAS_MID): Promise<void> {
  const boxes = await Promise.all(ids.map(id => editor.nodeBox(id)));
  const x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.width));
  const y0 = Math.min(...boxes.map(b => b.y)), y1 = Math.max(...boxes.map(b => b.y + b.height));
  await panBy(editor, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, at);
}

/** True when the editor's top element at `p` is the canvas (not a side panel). */
export async function onCanvas(page: Page, p: Pt): Promise<boolean> {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el && (el.tagName === 'IFRAME' || !el.closest('[class*="w-[260px]"], [class*="w-[52px]"], [class*="overflow-y-au"], [class*="px-2"]'));
  }, p);
}

// ─── Geometry ─────────────────────────────────────────────────────────

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const inside = (p: Pt, b: Box | null, pad = 2) =>
  !!b && p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;
export const contains = (outer: Box, inner: Box, pad = 1) =>
  inner.x >= outer.x - pad && inner.y >= outer.y - pad
  && inner.x + inner.width <= outer.x + outer.width + pad && inner.y + inner.height <= outer.y + outer.height + pad;

// ─── More entry seeds ─────────────────────────────────────────────────

const CARD_IMPORT = `import Card from '@/components/Card';`;

/** A design component: a flex column with two children (its "expansion"). */
export const CARD_MASTER = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '260px', height: '240px', padding: '20px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-top" data-name="Top" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#1d4ed8', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="card-bottom" data-name="Bottom" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#0f766e', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** A flex row filled with three Card instances + a canvas floater. */
export const INSTANCE_ROW = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="inst-row" data-name="Row" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '30px', width: '100%', position: 'relative', backgroundColor: '#202030', flex: '0 0 auto' }}>
    <Card data-id="card-1" data-name="Card 1" style={{ position: 'relative', flex: '0 0 auto' }} />
    <Card data-id="card-2" data-name="Card 2" style={{ position: 'relative', flex: '0 0 auto' }} />
    <Card data-id="card-3" data-name="Card 3" style={{ position: 'relative', flex: '0 0 auto' }} />
  </div>
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>`,
{ imports: [CARD_IMPORT], extra: { 'components/Card.tsx': CARD_MASTER } });

/** An absolute (overlay-style) Card instance sitting over a flex section. */
export const INSTANCE_OVERLAY = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="sec" data-name="Section" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '30px', width: '100%', height: '400px', position: 'relative', backgroundColor: '#202030', flex: '0 0 auto' }}>
    <div data-id="s1" data-name="S1" style={{ position: 'relative', width: '300px', height: '300px', backgroundColor: '#ff5577', flex: '0 0 auto' }}></div>
    <div data-id="s2" data-name="S2" style={{ position: 'relative', width: '300px', height: '300px', backgroundColor: '#55ffaa', flex: '0 0 auto' }}></div>
    <div data-id="s3" data-name="S3" style={{ position: 'relative', width: '300px', height: '300px', backgroundColor: '#5599ff', flex: '0 0 auto' }}></div>
  </div>
  <Card data-id="aura" data-name="Aura" style={{ position: 'absolute', left: '300px', top: '120px', width: '500px', height: '320px' }} />
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>`,
{ imports: [CARD_IMPORT], extra: { 'components/Card.tsx': CARD_MASTER } });

/** Nested no-layout canvas frames (outer > inner) and a chip, for zoom drags. */
export const NESTED_FRAMES = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '400px', position: 'relative', backgroundColor: '#ffffff' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '300px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
</div>`, `
  <div data-id="outer" data-name="Outer" data-canvas-node="true" style={{ position: 'absolute', left: '-520px', top: '0px', width: '400px', height: '300px', backgroundColor: '#e8eefc' }}>
    <div data-id="inner" data-name="Inner" style={{ position: 'absolute', left: '100px', top: '75px', width: '200px', height: '150px', backgroundColor: '#c7d2fe' }}></div>
  </div>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-350px', top: '330px', width: '40px', height: '40px', backgroundColor: '#ff66cc' }}></div>`,
{ tiles: [{ id: 'desktop', label: 'Desktop', width: 600 }] });

/** A section whose hit target is a centred translate(-50%,-50%) image child. */
export const TRANSLATED_IMAGE = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px', backgroundColor: '#ffffff' }}>
  <div data-id="section-1" data-name="Section" style={{ position: 'relative', width: '100%', height: '761px', backgroundColor: '#dddddd', overflow: 'hidden' }}>
    <div data-id="img-1" data-name="Image" style={{ position: 'absolute', left: '50%', top: '50%', width: '100%', height: '100%', backgroundColor: '#222222', transform: 'translateX(-50%) translateY(-50%)' }}></div>
  </div>
</div>`, `
  <div data-id="cn-pink" data-name="Pink" data-canvas-node="true" style={{ position: 'absolute', left: '-460px', top: '200px', width: '300px', height: '170px', backgroundColor: '#ffb3ba' }}></div>`);

/** A 25°-rotated no-layout canvas frame, a plain frame, a chip and a 2×-scaled node. */
export const TRANSFORMED_TARGETS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '400px', position: 'relative', backgroundColor: '#ffffff' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '300px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
</div>`, `
  <div data-id="tilted" data-name="Tilted" data-canvas-node="true" style={{ position: 'absolute', left: '-560px', top: '40px', width: '420px', height: '300px', backgroundColor: '#e8eefc', transform: 'rotate(25deg)' }}></div>
  <div data-id="plain" data-name="Plain" data-canvas-node="true" style={{ position: 'absolute', left: '-560px', top: '520px', width: '480px', height: '360px', backgroundColor: '#fce8ee' }}></div>
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '160px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>
  <div data-id="scaled" data-name="Scaled" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '620px', width: '50px', height: '50px', backgroundColor: '#22aa66', transform: 'scale(2)' }}></div>`,
{ tiles: [{ id: 'desktop', label: 'Desktop', width: 600 }] });

/** A STATIC no-layout card in a flex slot + a small chip and an oversized chip. */
export const CARD_IN_SLOT = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="slots" data-name="Slots" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '40px', width: '100%', height: '420px', position: 'relative', backgroundColor: '#202030', flex: '0 0 auto' }}>
    <div data-id="card" data-name="Card" style={{ width: '400px', height: '300px', backgroundColor: '#303060', flex: '0 0 auto' }}></div>
    <div data-id="other" data-name="Other" style={{ width: '300px', height: '300px', backgroundColor: '#603030', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
</div>`, `
  <div data-id="small" data-name="Small" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '80px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>
  <div data-id="huge" data-name="Huge" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '300px', width: '520px', height: '360px', backgroundColor: '#ffaa22' }}></div>`);

/** Two flex cards A and B side by side, each with two children, + a floater. */
export const TWO_CARDS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'row', gap: '60px', width: '1440px', minHeight: '700px', padding: '60px', position: 'relative', backgroundColor: '#0d0d1a', alignItems: 'flex-start' }}>
  <div data-id="card-a" data-name="CardA" style={{ display: 'flex', flexDirection: 'column', gap: '40px', padding: '30px', width: '500px', position: 'relative', backgroundColor: '#203040', flex: '0 0 auto' }}>
    <div data-id="a1" data-name="A1" style={{ width: '100%', height: '120px', backgroundColor: '#ff5577', flex: '0 0 auto', position: 'relative' }}></div>
    <div data-id="a2" data-name="A2" style={{ width: '100%', height: '120px', backgroundColor: '#ff9977', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
  <div data-id="card-b" data-name="CardB" style={{ display: 'flex', flexDirection: 'column', gap: '40px', padding: '30px', width: '500px', position: 'relative', backgroundColor: '#304020', flex: '0 0 auto' }}>
    <div data-id="b1" data-name="B1" style={{ width: '100%', height: '120px', backgroundColor: '#55ffaa', flex: '0 0 auto', position: 'relative' }}></div>
    <div data-id="b2" data-name="B2" style={{ width: '100%', height: '120px', backgroundColor: '#55aaff', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>`);

const SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A component master whose root is NO-layout, with a canvas chip in the master file. */
export const MASTER_ROOT_SRC = `'use client';

/** @name "Tile" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Tile', x: 0, y: 0, isPrimary: true }];

function Tile({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="tile-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Tile" style={{ position: 'relative', width: '400px', height: '300px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="tile-dot" data-name="Dot" style={{ position: 'absolute', left: '20px', top: '20px', width: '40px', height: '40px', backgroundColor: '#1d4ed8' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Tile);

const canvasNodes = (<>
  <div data-id="m-chip" data-name="MChip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '40px', width: '160px', height: '160px', backgroundColor: '#ff66cc' }}></div>
</>);
`;

/** Three roots in one project: the home page's FLEX root (empty space under its
 *  last child), a /starter page with the no-layout starter root, and a master
 *  whose root is no-layout — each with a canvas chip of its own. */
export const ROOTS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '1100px', padding: '60px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
</div>`, `
  <div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '200px', width: '120px', height: '120px', backgroundColor: '#ff66cc' }}></div>`, { extra: {
  'app/starter/page.tsx': SERVER_WRAPPER,
  'app/starter/page.client.tsx': pageWithCanvas({ tiles: ONE, root: `
<div data-id="root" data-name="Starter" style={{ position: 'relative', width: '100%', minHeight: '900px', backgroundColor: '#ffffff' }}>
</div>`, canvas: `
  <div data-id="s-chip" data-name="SChip" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '200px', width: '160px', height: '160px', backgroundColor: '#ff66cc' }}></div>` }),
  'components/Tile.tsx': MASTER_ROOT_SRC,
} });

/** A full-bleed backdrop (deep 100%×100% noise) under a higher-z flex section. */
export const BACKDROP = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="backdrop" data-name="Backdrop" style={{ position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', zIndex: '0' }}>
    <div data-id="noise" data-name="Noise" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: '#1a1a2a' }}></div>
  </div>
  <div data-id="logos" data-name="Logos" style={{ display: 'flex', flexDirection: 'row', gap: '60px', padding: '60px', width: '100%', height: '400px', position: 'relative', zIndex: '1', flex: '0 0 auto' }}>
    <div data-id="logo-1" data-name="Logo1" style={{ width: '240px', height: '240px', backgroundColor: '#ff5577', flex: '0 0 auto', position: 'relative' }}></div>
    <div data-id="logo-2" data-name="Logo2" style={{ width: '240px', height: '240px', backgroundColor: '#55ffaa', flex: '0 0 auto', position: 'relative' }}></div>
  </div>
</div>`, `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '60px', height: '60px', backgroundColor: '#ff66cc' }}></div>`);

// ─── Exit helpers ─────────────────────────────────────────────────────

/** True when no canvas element (data-id) paints at page point `p`. */
export async function isEmptyCanvasAt(editor: Editor, p: Pt): Promise<boolean> {
  const off = await editor.page().locator('iframe[src*="5174"]').first().boundingBox();
  const local = { x: p.x - (off?.x ?? 0), y: p.y - (off?.y ?? 0) };
  return sandboxFrame(editor.page()).evaluate(({ x, y }) => !document.elementsFromPoint(x, y).some(e => e.closest('[data-id]')), local);
}

/** A point of EMPTY canvas inside the free canvas area, at least `margin` px
 *  (all around) from any painted node; prefers points near `near`. One
 *  in-sandbox search (the iframe covers the whole window at offset 0,0). */
export async function emptyCanvasPoint(editor: Editor, near: Pt, margin = 60): Promise<Pt> {
  const off = await editor.page().locator('iframe[src*="5174"]').first().boundingBox();
  const ox = off?.x ?? 0, oy = off?.y ?? 0;
  const found = await sandboxFrame(editor.page()).evaluate(({ n, m, ox, oy }) => {
    const cands: Array<{ x: number; y: number }> = [];
    for (let y = 140; y <= 920; y += 20) for (let x = 400; x <= 1280; x += 20) cands.push({ x, y });
    cands.sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y));
    const empty = (x: number, y: number) => !document.elementsFromPoint(x - ox, y - oy).some(e => e.closest('[data-id]'));
    for (const c of cands) {
      let ok = true;
      for (const [dx, dy] of [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m], [m, m], [-m, -m], [m, -m], [-m, m]]) {
        if (!empty(c.x + dx, c.y + dy)) { ok = false; break; }
      }
      if (ok) return c;
    }
    return null;
  }, { n: near, m: margin, ox, oy });
  if (!found) throw new Error('no empty canvas point on screen');
  return found;
}

/** Rotation angle (deg, −180..180) of the painted element's transform matrix. */
export async function paintedAngle(editor: Editor, id: string): Promise<{ angle: number; rotateProp: string; transform: string }> {
  return sandboxFrame(editor.page()).evaluate((i) => {
    const els = [...document.querySelectorAll(`[data-id="${i}"]`)] as HTMLElement[];
    const el = els.find(e => e.getBoundingClientRect().width > 0) ?? els[0];
    const cs = getComputedStyle(el);
    const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
    const r = cs.rotate && cs.rotate !== 'none' ? parseFloat(cs.rotate) : 0;
    const a = (Math.atan2(m.b, m.a) * 180) / Math.PI + r;
    const norm = ((a + 540) % 360) - 180;
    return { angle: norm, rotateProp: cs.rotate, transform: cs.transform };
  }, id);
}

/** Selection-overlay handles currently mounted: the reorder grip and gap handles. */
export async function handleCounts(page: Page): Promise<{ grip: number; gap: number; opacity: number | null }> {
  return page.evaluate(() => {
    const fade = document.querySelector('[data-selection-fade]') as HTMLElement | null;
    const grip = [...document.querySelectorAll('div')].filter(d => (d as HTMLElement).style.cursor === 'grab' && (d as HTMLElement).style.borderRadius === '50%').length;
    return { grip, gap: document.querySelectorAll('[data-gap-handle]').length, opacity: fade ? Number(getComputedStyle(fade).opacity) : null };
  });
}

// ─── Exit seeds ───────────────────────────────────────────────────────

/** FLEX_COLUMN with flow props on `features` (order, alignSelf, grid placement). */
export const FLEX_COLUMN = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '300px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', width: '600px', height: '300px', backgroundColor: '#f5f5f7', flex: '1 0 0px', order: '1', alignSelf: 'center', gridColumn: '1 / 2', gridRow: '1 / 2' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', height: '300px', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }}></div>
</div>`);

/** ABSOLUTE_IN_FRAME: an absolute pinned child (translate + rotate) in a no-layout
 *  hero, a flex row of cards and a 2-column grid below. */
export const ABSOLUTE_IN_FRAME = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '400px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="abs-child" data-name="AbsChild" data-pinned="true" style={{ position: 'absolute', left: '40px', top: '40px', width: '120px', height: '120px', backgroundColor: '#66ccff', transform: 'translateX(10px) rotate(15deg)' }}></div>
  </div>
  <div data-id="features" data-name="Features" style={{ display: 'flex', flexDirection: 'row', gap: '40px', height: '300px', backgroundColor: '#f5f5f7', padding: '20px', position: 'relative', flex: '0 0 auto' }}>
    <div data-id="card-a" data-name="CardA" style={{ width: '300px', height: '260px', backgroundColor: '#ffffff', position: 'relative', flex: '0 0 auto' }}></div>
    <div data-id="card-b" data-name="CardB" style={{ width: '300px', height: '260px', backgroundColor: '#ffffff', position: 'relative', flex: '0 0 auto' }}></div>
  </div>
  <div data-id="gridsec" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px', height: '300px', backgroundColor: '#e5e5ff', padding: '20px', position: 'relative', flex: '0 0 auto' }}>
    <div data-id="g1" data-name="G1" style={{ height: '200px', backgroundColor: '#ffffff', position: 'relative' }}></div>
    <div data-id="g2" data-name="G2" style={{ height: '200px', backgroundColor: '#ffffff', position: 'relative' }}></div>
  </div>
</div>`);

/** Two no-layout sibling frames A and B in a no-layout section; A holds an absolute chip. */
export const SIBLING_FRAMES = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="frame-a" data-name="FrameA" style={{ position: 'absolute', left: '80px', top: '80px', width: '500px', height: '400px', backgroundColor: '#1a1a3a' }}>
    <div data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '300px', top: '150px', width: '80px', height: '80px', backgroundColor: '#ff66cc' }}></div>
  </div>
  <div data-id="frame-b" data-name="FrameB" style={{ position: 'absolute', left: '700px', top: '80px', width: '500px', height: '400px', backgroundColor: '#3a1a1a' }}></div>
</div>`);

/** Two flex sections A and B (children each) in a flex column root. */
export const TWO_SECTIONS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="sec-a" data-name="SecA" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '30px', height: '260px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="a1" data-name="A1" style={{ width: '200px', height: '200px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="a2" data-name="A2" style={{ width: '200px', height: '200px', backgroundColor: '#ff9977', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
    <div data-id="a3" data-name="A3" style={{ width: '200px', height: '200px', backgroundColor: '#ffbb77', position: 'relative', flex: '0 0 auto', order: '2' }}></div>
  </div>
  <div data-id="sec-b" data-name="SecB" style={{ display: 'flex', flexDirection: 'row', gap: '40px', padding: '30px', height: '260px', position: 'relative', backgroundColor: '#1a3a1a', flex: '0 0 auto' }}>
    <div data-id="b1" data-name="B1" style={{ width: '200px', height: '200px', backgroundColor: '#55ffaa', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="b2" data-name="B2" style={{ width: '200px', height: '200px', backgroundColor: '#55aaff', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
</div>`);

const TWO_VP = [TILE.desktop, { id: 'tablet', label: 'Tablet', width: 810 }];

/** HANDOFF_TWO_VP: a flow parent (two chips) and a sibling flex target, on two tiles. */
export const HANDOFF_TWO_VP = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <div data-id="source-box" data-name="Source" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', position: 'relative', padding: '16px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    <div data-id="chip-a" data-name="ChipA" style={{ width: '100%', height: '80px', backgroundColor: '#3355ff', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="chip-b" data-name="ChipB" style={{ width: '100%', height: '80px', backgroundColor: '#ffcc33', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
  <div data-id="target-box" data-name="Target" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', height: '320px', position: 'relative', padding: '16px', backgroundColor: '#2a1a1a', flex: '0 0 auto', order: '1' }}>
    <div data-id="chip-c" data-name="ChipC" style={{ width: '100%', height: '80px', backgroundColor: '#33cc88', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  </div>
</div>`, undefined, { tiles: TWO_VP });

/** The same flow parent next to a NO-layout sibling container, on two tiles. */
export const HANDOFF_NO_LAYOUT = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <div data-id="source-box" data-name="Source" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', position: 'relative', padding: '16px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    <div data-id="chip-a" data-name="ChipA" style={{ width: '100%', height: '80px', backgroundColor: '#3355ff', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="chip-b" data-name="ChipB" style={{ width: '240px', height: '80px', backgroundColor: '#ffcc33', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
  <div data-id="target-box" data-name="Target" style={{ width: '100%', height: '320px', position: 'relative', backgroundColor: '#2a1a1a', flex: '0 0 auto', order: '1' }}></div>
</div>`, undefined, { tiles: TWO_VP });

/** A flow list in the page and a no-layout canvas frame beside the viewport. */
export const FLOW_AND_CANVAS_FRAME = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '700px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <div data-id="list" data-name="List" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', position: 'relative', padding: '16px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="item-a" data-name="ItemA" style={{ width: '300px', height: '90px', backgroundColor: '#3355ff', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
    <div data-id="item-b" data-name="ItemB" style={{ width: '300px', height: '90px', backgroundColor: '#ffcc33', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
</div>`, `
  <div data-id="drop-frame" data-name="DropFrame" data-canvas-node="true" style={{ position: 'absolute', left: '-760px', top: '60px', width: '640px', height: '480px', backgroundColor: '#e8eefc' }}></div>`,
{ tiles: [{ id: 'desktop', label: 'Desktop', width: 800 }] });

/** TEXT_IN_CENTERED_COLUMN: a bare auto/auto <p> in a centred column. */
export const TEXT_IN_CENTERED_COLUMN = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', position: 'relative', width: '100%', minHeight: '400px', backgroundColor: '#ffffff' }}>
  <div data-id="col" data-name="Column" style={{ position: 'relative', width: '400px', height: '160px', backgroundColor: '#97cffc', flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
    <p data-id="label" data-name="Text" style={{ fontSize: '16px', color: '#000000', fontFamily: 'Inter, sans-serif', fontWeight: '400', lineHeight: '1.2', overflowWrap: 'break-word', position: 'relative', flex: '0 0 auto' }}>Hello brave new world</p>
  </div>
</div>`);

/** Four flow children of a stretch column: fixed-width text, 100% frame, stretched frame, Fit frame. */
export const SIZES = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '30px', width: '100%', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#ffffff' }}>
  <p data-id="t-fixed" data-name="FixedText" style={{ width: '300px', fontSize: '16px', lineHeight: '1.3', color: '#000000', margin: '0px', position: 'relative', flex: '0 0 auto' }}>A fixed-width paragraph that wraps onto a second line here.</p>
  <div data-id="f-full" data-name="Full" style={{ width: '100%', height: '80px', backgroundColor: '#97cffc', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="f-stretch" data-name="Stretch" style={{ height: '80px', backgroundColor: '#fcd297', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="f-fit" data-name="Fit" style={{ display: 'flex', flexDirection: 'row', gap: '10px', padding: '10px', width: 'min-content', height: 'min-content', backgroundColor: '#c7fc97', position: 'relative', flex: '0 0 auto' }}>
    <div data-id="fit-kid" data-name="Kid" style={{ width: '120px', height: '40px', backgroundColor: '#333333', position: 'relative', flex: '0 0 auto' }}></div>
  </div>
</div>`);

/** A host frame with a rotate(-15deg) absolute child. */
export const ROTATED_CHILD = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff' }}>
  <div data-id="host-1" data-name="Host" style={{ position: 'relative', width: '561px', height: '500px', backgroundColor: '#ffdfba', margin: '40px auto' }}>
    <div data-id="spin-1" data-name="Spin" style={{ position: 'absolute', left: '140px', top: '120px', width: '209px', height: '172px', backgroundColor: '#97cffc', transform: 'rotate(-15deg)' }}></div>
  </div>
</div>`);

/** A flex column child carrying BOTH a motion `rotate` and a `transform: rotate(...)`. */
export const DOUBLE_ROTATE = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '30px', width: '900px', minHeight: '800px', padding: '60px', position: 'relative', backgroundColor: '#ffffff', alignItems: 'flex-start' }}>
  <div data-id="first" data-name="First" style={{ width: '240px', height: '100px', backgroundColor: '#97cffc', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  <motion.div data-id="spin" data-name="Spin" style={{ width: '240px', height: '100px', backgroundColor: '#fc9797', position: 'relative', flex: '0 0 auto', order: '1', rotate: '-190.3', transform: 'rotate(-190.3deg)' }}></motion.div>
  <div data-id="last" data-name="Last" style={{ width: '240px', height: '100px', backgroundColor: '#c7fc97', position: 'relative', flex: '0 0 auto', order: '2' }}></div>
</div>`, undefined, { imports: [`import { motion } from 'framer-motion';`] });

/** Insets: an absolute child sized by right/bottom, and a rotated full-inset child. */
export const INSET_CHILDREN = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', height: '900px', backgroundColor: '#ffffff' }}>
  <div data-id="box-1" data-name="Box1" style={{ position: 'absolute', left: '80px', top: '80px', width: '600px', height: '400px', backgroundColor: '#e8eefc' }}>
    <div data-id="inset" data-name="Inset" style={{ position: 'absolute', left: '40px', top: '40px', right: '200px', bottom: '100px', backgroundColor: '#97cffc' }}></div>
  </div>
  <div data-id="box-2" data-name="Box2" style={{ position: 'absolute', left: '800px', top: '80px', width: '300px', height: '200px', backgroundColor: '#fce8ee' }}>
    <div data-id="full" data-name="Full" style={{ position: 'absolute', left: '0px', top: '0px', right: '0px', bottom: '0px', backgroundColor: '#fc9797', transform: 'rotate(45deg)' }}></div>
  </div>
</div>`);

/** Three nested no-layout canvas frames with a right/bottom-pinned chip in the deepest. */
export const NESTED_3 = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '300px', position: 'relative', backgroundColor: '#ffffff' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
</div>`, `
  <div data-id="l1" data-name="L1" data-canvas-node="true" style={{ position: 'absolute', left: '-1000px', top: '0px', width: '900px', height: '660px', backgroundColor: '#e8eefc' }}>
    <div data-id="l2" data-name="L2" style={{ position: 'absolute', left: '60px', top: '60px', width: '600px', height: '480px', backgroundColor: '#c7d2fe' }}>
      <div data-id="l3" data-name="L3" style={{ position: 'absolute', left: '60px', top: '60px', width: '300px', height: '240px', backgroundColor: '#a5b4fc' }}>
        <div data-id="nchip" data-name="NChip" style={{ position: 'absolute', right: '110px', bottom: '90px', width: '80px', height: '80px', backgroundColor: '#ff66cc' }}></div>
      </div>
    </div>
  </div>`, { tiles: [{ id: 'desktop', label: 'Desktop', width: 400 }] });

/** An absolute child of a no-layout frame that is itself a slot of a flex section. */
export const FRAME_IN_FLEX = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="sec" data-name="Section" style={{ display: 'flex', flexDirection: 'row', gap: '60px', padding: '30px', height: '360px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="holder" data-name="Holder" style={{ width: '360px', height: '300px', backgroundColor: '#303060', position: 'relative', flex: '0 0 auto' }}>
      <div data-id="abs" data-name="Abs" style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '100px', backgroundColor: '#ff66cc' }}></div>
    </div>
    <div data-id="c1" data-name="C1" style={{ width: '200px', height: '300px', backgroundColor: '#55ffaa', position: 'relative', flex: '0 0 auto' }}></div>
    <div data-id="c2" data-name="C2" style={{ width: '200px', height: '300px', backgroundColor: '#55aaff', position: 'relative', flex: '0 0 auto' }}></div>
  </div>
</div>`);

/** An overflow:hidden frame with an absolute child, and a destination frame (canvas nodes). */
export const CLIPPED = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '300px', position: 'relative', backgroundColor: '#ffffff' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '200px', backgroundColor: '#f5f5f7', flex: '0 0 auto' }}></div>
</div>`, `
  <div data-id="clip" data-name="Clip" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '0px', width: '360px', height: '260px', backgroundColor: '#e8eefc', overflow: 'hidden' }}>
    <div data-id="cchip" data-name="CChip" style={{ position: 'absolute', left: '230px', top: '150px', width: '90px', height: '70px', backgroundColor: '#ff66cc' }}></div>
  </div>
  <div data-id="dest" data-name="Dest" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '420px', width: '420px', height: '300px', backgroundColor: '#fce8ee' }}></div>`,
{ tiles: [{ id: 'desktop', label: 'Desktop', width: 400 }] });

/** A flex section with children inside a flex column (the container to drop on canvas while selected). */
export const CONTAINER_CHILD = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1000px', minHeight: '700px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="top" data-name="Top" style={{ width: '100%', height: '120px', backgroundColor: '#1a1a3a', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="box" data-name="Box" style={{ display: 'flex', flexDirection: 'row', gap: '20px', padding: '20px', width: '400px', height: '160px', backgroundColor: '#303060', position: 'relative', flex: '0 0 auto' }}>
    <div data-id="k1" data-name="K1" style={{ width: '100px', height: '100px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto' }}></div>
    <div data-id="k2" data-name="K2" style={{ width: '100px', height: '100px', backgroundColor: '#55ffaa', position: 'relative', flex: '0 0 auto' }}></div>
  </div>
</div>`);
