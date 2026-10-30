// Batch D5 helpers: multi-selection drags, Alt-drag duplicate, animated nodes
// (effects travel with the node) and the other node kinds (text, FIT, SVG,
// instances, code components, slots, bound content). E2E_TEST_PLAN.md §2.
//
// Seeds first (page modules built on d3's `pageSeed` / d4's `pageSrc`), then
// page helpers:
//   - a modifier-aware canvas drag (`press` → CanvasDrag from d4, + `altDown`);
//   - source reads for duplicates (`dupIds`), effect hooks and identifiers;
//   - trace slicing (`mark`/`since`) and poll helpers that never sleep blindly.

import type { Page } from '@playwright/test';
import type { Editor } from './editor';
import { TILES, type ProjectData } from '../fixtures/project';
import { pageSeed } from './d3';
import { pageSrc, seed as seedOf, CanvasDrag, frame } from './d4';
import { parseSource } from './code';
import { parse as babelParse } from '@babel/parser';
import { masterSeed as c5MasterSeed, masterModule as c5MasterModule, CONFIG_3V } from './c5';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export { pageSeed, pageSrc, seedOf, CanvasDrag, frame };

// ─── Generic helpers ──────────────────────────────────────────────────

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;

/** Poll `read` until `ok(value)` or timeout; returns the last value read. */
export async function pollFor<T>(page: Page, read: () => Promise<T>, ok: (v: T) => boolean, timeout = 6_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let v = await read();
  while (!ok(v) && Date.now() < deadline) {
    await page.waitForTimeout(60);
    v = await read();
  }
  return v;
}

/** Ids of Alt-drag duplicates (`dup-…`) in source order. */
export function dupIds(code: string): string[] {
  return parseSource(code).allIds.filter(id => id.startsWith('dup-'));
}

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

/** Does the file parse (Babel, no error recovery)? */
export function parses(code: string): boolean {
  try {
    babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    return true;
  } catch {
    return false;
  }
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

// ─── Sandbox reads ────────────────────────────────────────────────────

/** Bounding box of the first `[data-id]` match in the sandbox, or null right away. */
export async function boxOf(editor: Editor, id: string, vpId?: string): Promise<Box | null> {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.sandbox().locator(`[data-id="${id}"]`).first();
  if ((await loc.count()) === 0) return null;
  const b = await loc.boundingBox({ timeout: 2_000 }).catch(() => null);
  return b && b.width > 0 && b.height > 0 ? b : null;
}

/** Computed style of a node on a tile ('' when missing). */
export async function computed(editor: Editor, id: string, prop: string, vpId?: string): Promise<string> {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.sandbox().locator(`[data-id="${id}"]`).first();
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
}

// ─── Gestures ─────────────────────────────────────────────────────────

/** Press at a node's point (fraction of its box) and return the live drag. */
export async function pressNode(editor: Editor, id: string, opts: { vpId?: string; fx?: number; fy?: number } = {}): Promise<{ d: CanvasDrag; box: Box; from: Pt }> {
  const box = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  const from = { x: box.x + box.width * (opts.fx ?? 0.5), y: box.y + box.height * (opts.fy ?? 0.5) };
  const d = await CanvasDrag.press(editor.page(), from);
  return { d, box, from };
}

/** Release a drag and let the drop land (two flushes + render). */
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

/** Real click on a point, then wait out the double-click window. */
export async function clickAt(editor: Editor, p: Pt, modifiers: Array<'Shift' | 'Alt' | 'Meta'> = []): Promise<void> {
  const page = editor.page();
  await page.mouse.move(p.x, p.y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await editor.settled();
  await page.waitForTimeout(450);
}

/** Click a node's centre (optionally Shift) and wait out the dblclick window. */
export async function clickNode(editor: Editor, id: string, opts: { vpId?: string; shift?: boolean; fx?: number; fy?: number } = {}): Promise<void> {
  const b = opts.vpId ? await editor.nodeBoxIn(opts.vpId, id) : await editor.nodeBox(id);
  await clickAt(editor, { x: b.x + b.width * (opts.fx ?? 0.5), y: b.y + b.height * (opts.fy ?? 0.5) }, opts.shift ? ['Shift'] : []);
}

// ─── Seeds: Alt-drag duplicate ────────────────────────────────────────

/** FLEX_COLUMN: three 200px sections in a flex column root (no orders). */
export const FLEX_COLUMN = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', backgroundColor: '#f5f5f7', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '200px', backgroundColor: '#2a2a4a', position: 'relative', flex: '0 0 auto' }}></div>
</div>`);

const GRID_COLORS = ['#ff5577', '#ff9977', '#ffcc55', '#99dd55', '#55ddaa', '#55aadd', '#7766ee', '#cc66dd'];

/** A 2×4 order-stamped grid (cells g0..g7, order 0..7). */
export const GRID_8 = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="grid" data-name="Grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: '160px', gap: '20px', width: '900px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
${GRID_COLORS.map((c, i) => `    <div data-id="g${i}" data-name="G${i}" style={{ position: 'relative', backgroundColor: '${c}', order: '${i}' }}></div>`).join('\n')}
  </div>
</div>`);

/** Three tiles: a no-layout stage holding an absolute flex chip (with a dot). */
export const TABLET_ABS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '700px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="stage" data-name="Stage" style={{ width: '600px', height: '400px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="chip" data-name="Chip" style={{ position: 'absolute', left: '30px', top: '30px', width: '240px', height: '160px', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#ff66cc' }}>
      <div data-id="chip-dot" data-name="Dot" style={{ width: '20px', height: '20px', backgroundColor: '#ffffff', position: 'relative', flex: '0 0 auto' }}></div>
    </div>
  </div>
</div>`, undefined, { tiles: TILES.three });

/** A frame and its child, both with `::after` border overlays (red / green). */
export const BORDERED = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <style>{\`
    [data-id="card"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border-width: 6px;
  border-style: solid;
  border-color: #ff0000;
    }
    [data-id="card-kid"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border-width: 4px;
  border-style: solid;
  border-color: #00ff00;
    }
  \`}</style>
  <div data-id="card" data-name="Card" style={{ position: 'absolute', left: '500px', top: '200px', width: '240px', height: '200px', backgroundColor: '#1a1a3a' }}>
    <div data-id="card-kid" data-name="Kid" style={{ position: 'absolute', left: '40px', top: '40px', width: '100px', height: '80px', backgroundColor: '#3355ff' }}></div>
  </div>
</div>`);

/** A design master whose ROOT is flex (for an instance on a page). */
export const PILL_MASTER = `'use client';

/** @name "Pill" */

import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

function Pill({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.div layout={true} data-id="pill-root" data-name="Pill" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', width: '160px', height: '60px', padding: '10px', backgroundColor: '#33cc88', ...style }}>
      <motion.div layout={true} data-id="pill-dot" data-name="Dot" style={{ position: 'relative', width: '30px', height: '30px', backgroundColor: '#ffffff', flex: '0 0 auto' }} />
      <motion.div layout={true} data-id="pill-bar" data-name="Bar" style={{ position: 'relative', width: '60px', height: '12px', backgroundColor: '#114422', flex: '0 0 auto' }} />
    </motion.div>
  );
}

export default withResponsiveProps(Pill);
`;

/** Three tiles: a no-layout stage holding an absolute Pill instance. */
export const TABLET_INSTANCE = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', minHeight: '700px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="stage" data-name="Stage" style={{ width: '600px', height: '400px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <Pill data-id="pill" data-name="Pill" style={{ position: 'absolute', left: '30px', top: '30px' }} />
  </div>
</div>`, undefined, { tiles: TILES.three, imports: ["import Pill from '@/components/Pill';"], extra: { 'components/Pill.tsx': PILL_MASTER } });

/** A 3-variant master whose button is 100% wide on variant-2 only (a style
 *  ternary) and 20px on variant-2 (its variants object). */
export const CLONE_MASTER = c5MasterSeed('Card', c5MasterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', variant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px', padding: '12px', width: '320px', height: 'auto', overflow: 'hidden', backgroundColor: '#111827', ...style }}>
      <motion.p layout={true} data-id="btn" data-name="Button" variants={btnVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{ position: 'relative', width: variant === 'variant-2' ? '100%' : '', padding: '8px', backgroundColor: '#ff2d75', color: '#ffffff', fontSize: '14px', margin: '0px', flex: '0 0 auto', order: '0' }}>Buy</motion.p>
      <motion.div layout={true} data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '40px', height: '20px', backgroundColor: '#33cc88', flex: '0 0 auto', order: '1' }} />
    </motion.div>`, {
  config: CONFIG_3V,
  head: `'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`,
  hooks: `  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
`,
  pre: `const btnVariants = {
  default: { fontSize: '14px' },
  'variant-2': { fontSize: '20px' },
};`,
}));


// ─── Seeds: multi-selection drags ─────────────────────────────────────

const CN = (id: string, left: number, top: number, color: string, w = 100, h = 80) =>
  `  <div data-id="${id}" data-name="${id}" data-canvas-node="true" style={{ position: 'absolute', left: '${left}px', top: '${top}px', width: '${w}px', height: '${h}px', backgroundColor: '${color}' }}></div>`;

/** A flex column page (hero / features / how, 80px gaps — the gaps are the
 *  only spots where the cursor is over the flex root itself) + two canvas
 *  nodes above it. */
export const MULTI_FLEX = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '80px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ height: '200px', backgroundColor: '#1a1a3a', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="features" data-name="Features" style={{ height: '200px', backgroundColor: '#f5f5f7', position: 'relative', flex: '0 0 auto' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ height: '200px', backgroundColor: '#2a2a4a', position: 'relative', flex: '0 0 auto' }}></div>
</div>`, [CN('cn-a', 300, -340, '#ff66cc'), CN('cn-b', 520, -300, '#66ccff')].join('\n'));

/** Two NO-layout frames side by side in a flex row band at the very top of
 *  the page (no padding, so a pointer coming down from above crosses straight
 *  into a frame), and two canvas nodes above them spaced so one drag delta
 *  drops each node's centre into its own frame. */
export const MULTI_FRAMES = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="band" data-name="Band" style={{ display: 'flex', flexDirection: 'row', gap: '200px', width: '100%', height: '300px', position: 'relative', backgroundColor: '#14142a', flex: '0 0 auto' }}>
    <div data-id="fa" data-name="FrameA" style={{ width: '400px', height: '300px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>
    <div data-id="fb" data-name="FrameB" style={{ width: '400px', height: '300px', position: 'relative', backgroundColor: '#3a1a1a', flex: '0 0 auto' }}></div>
  </div>
</div>`, [CN('cn-a', 150, -300, '#ff66cc'), CN('cn-b', 750, -300, '#66ccff')].join('\n'));

/** A no-layout page: frame `pf` holding `pk`, and lone absolute nodes A, B, C. */
export const NESTED_ABS = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="pf" data-name="ParentFrame" style={{ position: 'absolute', left: '200px', top: '200px', width: '400px', height: '300px', backgroundColor: '#1a1a3a' }}>
    <div data-id="pk" data-name="Kid" style={{ position: 'absolute', left: '40px', top: '40px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>
  </div>
  <div data-id="gf" data-name="OtherFrame" style={{ position: 'absolute', left: '800px', top: '200px', width: '300px', height: '300px', backgroundColor: '#3a1a1a' }}></div>
  <div data-id="na" data-name="A" style={{ position: 'absolute', left: '200px', top: '600px', width: '120px', height: '100px', backgroundColor: '#66ccff' }}></div>
  <div data-id="nb" data-name="B" style={{ position: 'absolute', left: '400px', top: '600px', width: '120px', height: '100px', backgroundColor: '#ffcc33' }}></div>
  <div data-id="nc" data-name="C" style={{ position: 'absolute', left: '600px', top: '600px', width: '120px', height: '100px', backgroundColor: '#33cc88' }}></div>
</div>`);

/** Two frames side by side, the right one rotated 90°, each with one child. */
export const ROTATED_PARENTS = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="p1" data-name="Plain" style={{ position: 'absolute', left: '200px', top: '250px', width: '300px', height: '300px', backgroundColor: '#1a1a3a' }}>
    <div data-id="ka" data-name="KidA" style={{ position: 'absolute', left: '110px', top: '110px', width: '80px', height: '80px', backgroundColor: '#ff66cc' }}></div>
  </div>
  <div data-id="p2" data-name="Turned" style={{ position: 'absolute', left: '700px', top: '250px', width: '300px', height: '300px', backgroundColor: '#3a1a1a', transform: 'rotate(90deg)' }}>
    <div data-id="kb" data-name="KidB" style={{ position: 'absolute', left: '110px', top: '110px', width: '80px', height: '80px', backgroundColor: '#66ccff' }}></div>
  </div>
</div>`);

/** A fixed (modal) overlay, open on the canvas, beside a plain frame. */
export const FIXED_OVERLAY = seedOf(pageSrc({
  imports: ["import { useState } from 'react';", "import { motion, AnimatePresence } from 'framer-motion';"],
  hooks: ['const [ovOpen, setOvOpen] = useState(false);'],
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="trig" data-name="Trigger" data-overlay-trigger='{"targetId":"ov","trigger":"click","dismiss":"outside"}' onClick={() => setOvOpen(!ovOpen)} style={{ position: 'relative', width: '160px', height: '60px', backgroundColor: '#663399', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '200px', height: '320px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="box" data-name="Box" style={{ position: 'relative', width: '240px', height: '160px', backgroundColor: '#33cc88', flex: '0 0 auto', order: '2' }}></div>
  <AnimatePresence>{ovOpen && (
    <motion.div key="ov" data-id="ov" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"trig","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed', left: '600px', top: '100px', width: '400px', height: '300px', zIndex: '100', backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
    </motion.div>
  )}</AnimatePresence>
</div>`,
  canvas: `
  <div data-id="cframe" data-name="CanvasFrame" data-canvas-node="true" style={{ position: 'absolute', left: '-520px', top: '120px', width: '300px', height: '200px', backgroundColor: '#ffaa22' }}></div>`,
}));

/** Three tiles: a flex column of three order-stamped chips. */
export const TILES_CHIPS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '20px', width: '100%', minHeight: '800px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="c1" data-name="C1" style={{ width: '300px', height: '140px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  <div data-id="c2" data-name="C2" style={{ width: '300px', height: '140px', backgroundColor: '#ffcc55', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  <div data-id="c3" data-name="C3" style={{ width: '300px', height: '140px', backgroundColor: '#55aadd', position: 'relative', flex: '0 0 auto', order: '2' }}></div>
</div>`, undefined, { tiles: TILES.three });

// ─── Seeds: other node kinds ──────────────────────────────────────────

/** A flex column page whose title renders `{t('title')}` (en + fr messages). */
export const I18N_PAGE = seedOf(pageSrc({
  imports: ["import { useTranslations } from 'next-intl';"],
  hooks: ["const t = useTranslations('home');"],
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '80px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ width: '600px', height: '200px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
  <p data-id="title" data-name="Title" style={{ position: 'relative', fontSize: '48px', color: '#ffffff', margin: '0px', flex: '0 0 auto', order: '1' }}>{t('title')}</p>
  <div data-id="foot" data-name="Foot" style={{ width: '600px', height: '200px', position: 'relative', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }}></div>
</div>`,
}), {
  'i18n/config.json': JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }, null, 2),
  'messages/en.json': JSON.stringify({ home: { title: 'Hello world' } }, null, 2),
  'messages/fr.json': JSON.stringify({ home: { title: 'Bonjour le monde' } }, null, 2),
});

/** A one-variant master whose bio line is bound to the `bio` prop. */
export const BIO_MASTER = `'use client';

/** @name "Card" */
/** @propMeta {"bio":{"type":"plainText","label":"Bio"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', bio = 'Default bio', ...rest }: { style?: React.CSSProperties; initialVariant?: string; bio?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '20px', width: '400px', height: 'auto', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-band" data-name="Band" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }} />
      <motion.p layout={true} data-id="bio-text" data-name="Bio" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>{bio}</motion.p>
      <motion.div layout={true} data-id="card-foot" data-name="Foot" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#2a2a4a', flex: '0 0 auto', order: '2' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export const BIO_SEED = seedOf(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }} />` }), { 'components/Card.tsx': BIO_MASTER });

/** A no-layout page: an absolute Pill instance, and an SVG letter group on the canvas. */
export const INSTANCE_AND_GROUP = pageSeed(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <Pill data-id="pill" data-name="Pill" style={{ position: 'absolute', left: '200px', top: '200px' }} />
</div>`, `  <svg data-id="grp" data-name="Group" data-canvas-node="true" viewBox="0 0 250 64" preserveAspectRatio="none" style={{ position: "absolute", left: "-400px", top: "150px", width: "250px", height: "64px", overflow: "visible" }}><svg data-id="grp-s0" data-name="LetterA" x="0" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s0-g0" d="M0 0 H70 V64 H0 Z" fill="#3b82f6" /></svg><svg data-id="grp-s1" data-name="LetterB" x="90" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s1-g0" d="M0 0 H70 V64 H0 Z" fill="#ef4444" /></svg><svg data-id="grp-s2" data-name="LetterC" x="180" y="0" width="70" height="64" viewBox="0 0 70 64" preserveAspectRatio="none" overflow="visible"><path data-id="grp-s2-g0" d="M0 0 H70 V64 H0 Z" fill="#22c55e" /></svg></svg>`,
{ imports: ["import Pill from '@/components/Pill';"], extra: { 'components/Pill.tsx': PILL_MASTER } });

/** A canvas frame holding an absolute FIT text (svg wrapper > foreignObject > p). */
export const FIT_CANVAS = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a' }}></div>`, `
  <div data-id="tframe" data-name="TextFrame" data-canvas-node="true" style={{ position: 'absolute', left: '-900px', top: '100px', width: '600px', height: '400px', backgroundColor: '#1a1a3a' }}>
    <svg data-id="ft-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{width: '300px', height: 'auto', overflow: 'visible', display: 'block', whiteSpace: 'pre', position: 'absolute', left: '60px', top: '60px'}} viewBox="0 0 300 60">
      <foreignObject width="100%" height="100%" style={{overflow: 'visible'}}>
        <p data-id="ft" data-name="Fit Text" style={{position: 'relative', fontSize: '48px', color: '#ffffff', whiteSpace: 'nowrap', margin: '0'}}>Fit me now</p>
      </foreignObject>
    </svg>
  </div>`);

/** A code component with fixed default size annotations. */
export const SIZED_CODE = `'use client';

/** @label "Gauge" */
/** @comment "A fixed-size gauge" */
/** @defaultWidth 300 */
/** @defaultHeight 200 */
/** @controls {
  "label": { "type": "text", "label": "Label", "default": "Gauge" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function Gauge({ label = 'Gauge', ...props }: { label?: string; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '300px', height: '200px', backgroundColor: '#ffcc33', color: '#000000', ...(props.style || {}) }}>{label}</div>;
}

export default withResponsiveProps(Gauge);
`;

/** A flex row holding a fixed-size code component between two frames. */
export const CODE_ROW = pageSeed(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', padding: '80px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="row" data-name="Row" style={{ display: 'flex', flexDirection: 'row', gap: '40px', width: '100%', height: '300px', padding: '20px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}>
    <div data-id="r1" data-name="R1" style={{ width: '200px', height: '200px', position: 'relative', backgroundColor: '#ff5577', flex: '0 0 auto', order: '0' }}></div>
    <Gauge data-id="gauge" data-name="Gauge" style={{ position: 'relative', width: '300px', height: '200px', flex: '0 0 auto', order: '1' }} />
    <div data-id="r2" data-name="R2" style={{ width: '200px', height: '200px', position: 'relative', backgroundColor: '#55aadd', flex: '0 0 auto', order: '2' }}></div>
  </div>
</div>`, undefined, { imports: ["import Gauge from '@/components/Gauge';"], extra: { 'components/Gauge.tsx': SIZED_CODE } });

/** A 2-variant design master: Tablet paints a different fill. */
export const TWO_V_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 400, y: 0 },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ffb3ba' },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '260px', height: '240px', padding: '20px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-top" data-name="Top" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#1d4ed8', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="card-bottom" data-name="Bottom" style={{ position: 'relative', width: '100%', height: '80px', backgroundColor: '#0f766e', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** Three tiles: a Card instance (Tablet variant via data-responsive) and a
 *  Marquee code component holding two REAL slot children (inline connected
 *  canvas nodes) — `refs` uses hoisted `{cn_*}` consts instead. */
export function tabletKindsSeed(marquee: string, opts: { refs?: boolean } = {}): ProjectData {
  const slotA = `<div data-id="slot-a" data-name="Slot A" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '100px', width: '160px', height: '80px', backgroundColor: '#ff3366' }}></div>`;
  const slotB = `<div data-id="slot-b" data-name="Slot B" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '260px', width: '220px', height: '80px', backgroundColor: '#33ccff' }}></div>`;
  const kids = opts.refs ? '{cn_slot_a}{cn_slot_b}' : `\n    ${slotA}\n    ${slotB}\n  `;
  const page = pageSrc({
    tiles: TILES.three,
    imports: ["import Card from '@/components/Card';", "import Marquee from '@/components/Marquee';"],
    root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '60px', width: '100%', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <Card data-id="card-i" data-name="Card" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768]}' style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
  <Marquee data-id="strip" data-name="Marquee" speed={60} gap={24} style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '600px', height: '160px' }}>${kids}</Marquee>
</div>`,
  }) + (opts.refs ? `const cn_slot_a = ${slotA};\nconst cn_slot_b = ${slotB};\n` : '');
  return seedOf(page, { 'components/Card.tsx': TWO_V_CARD, 'components/Marquee.tsx': marquee });
}

// ─── Seeds: animated nodes ────────────────────────────────────────────

/** `fx` carries an Appear, a Scroll Transform and a Hover — the page module
 *  exactly as the builder writes it (generated through the product's own
 *  mutation queue: updateMotionProp initial/whileInView/viewport, then
 *  updateScrollAnim, then updateMotionProp whileHover, which composes them
 *  into one data-scroll-fx spec + page hooks). sec-a / sec-b are flex columns. */
export const FX_PAGE_SRC = `'use client';

/** @canvas {
  "viewports": [
    {
      "id": "desktop",
      "label": "Desktop",
      "width": 1440,
      "isPrimary": true,
      "order": 0
    }
  ],
  "positions": {
    "desktop": {
      "x": 0,
      "y": 0
    }
  }
} */

import React, { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring, useInView, useMotionValue, animate } from 'framer-motion';

export default function Page() {
  const { scrollYProgress: fxProgress } = useScroll();
  const fxSmooth = useSpring(fxProgress, { duration: 0.5, bounce: 0.25 });
  const fxOpacity = useTransform(fxSmooth, [0, 1], [0.5, 1]);
  const fxScale = useTransform(fxSmooth, [0, 1], [0.5, 1]);
  const fxRef = useRef(null);
  const fxInView = useInView(fxRef, { once: true });
  const fxAppear = useMotionValue(0);
  useEffect(() => { if (fxInView) { const _c = animate(fxAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [fxInView]);
  const fxOpacityC = useTransform([fxAppear, fxOpacity], ([a, t]) => a * t);
  const fxYA = useTransform(fxAppear, [0, 1], [30, 0]);
  const fxHovScale = useMotionValue(1);
  const fxScaleHovC = useTransform([fxScale, fxHovScale], ([s, h]) => s * h);
          return (
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="sec-a" data-name="SecA" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '600px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    <motion.div data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"30"},"once":true,"transition":{"type":"spring","duration":"0.5","bounce":"0.25"}},"transform":{"trigger":"onScroll","from":{"scale":"0.5","opacity":"0.5"},"to":{"scale":"1","opacity":"1"}},"hover":{"props":{"scale":"1.05"}}}'
          onHoverStart={() => { animate(fxHovScale, 1.05, { type: 'spring', stiffness: 400, damping: 30 }); }}
          onHoverEnd={() => { animate(fxHovScale, 1, { type: 'spring', stiffness: 400, damping: 30 }); }} ref={fxRef} data-id="fx" data-name="Fx" style={{width: '200px', height: '100px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto', order: '0', opacity: fxOpacityC, y: fxYA, scale: fxScaleHovC}}
          ></motion.div>
    <div data-id="a2" data-name="A2" style={{ width: '200px', height: '100px', backgroundColor: '#ff9977', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
  <div data-id="sec-b" data-name="SecB" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '600px', position: 'relative', backgroundColor: '#3a1a1a', flex: '0 0 auto', order: '1' }}>
    <div data-id="b1" data-name="B1" style={{ width: '200px', height: '100px', backgroundColor: '#77ff55', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  </div>
</div>
  );
}
`;

/** A tall copy (2400px) so the preview can scroll the Scroll Transform. */
export const FX_PAGE = seedOf(FX_PAGE_SRC.replace("minHeight: '900px'", "minHeight: '2400px'"));

/** `fx` with an Appear + a Scroll Transform (no Hover), generated the same way. */
export const FX2_PAGE_SRC = `'use client';

/** @canvas {
  "viewports": [
    {
      "id": "desktop",
      "label": "Desktop",
      "width": 1440,
      "isPrimary": true,
      "order": 0
    }
  ],
  "positions": {
    "desktop": {
      "x": 0,
      "y": 0
    }
  }
} */

import React, { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring, useInView, useMotionValue, animate } from 'framer-motion';

export default function Page() {
  const { scrollYProgress: fxProgress } = useScroll();
  const fxSmooth = useSpring(fxProgress, { duration: 0.5, bounce: 0.25 });
  const fxOpacity = useTransform(fxSmooth, [0, 1], [0.5, 1]);
  const fxScale = useTransform(fxSmooth, [0, 1], [0.5, 1]);
  const fxRef = useRef(null);
  const fxInView = useInView(fxRef, { once: true });
  const fxAppear = useMotionValue(0);
  useEffect(() => { if (fxInView) { const _c = animate(fxAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [fxInView]);
  const fxOpacityC = useTransform([fxAppear, fxOpacity], ([a, t]) => a * t);
  const fxYA = useTransform(fxAppear, [0, 1], [30, 0]);
      return (
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="sec-a" data-name="SecA" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '600px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}>
    <motion.div data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"30"},"once":true},"transform":{"trigger":"onScroll","from":{"opacity":"0.5","scale":"0.5"},"to":{"opacity":"1","scale":"1"}}}' ref={fxRef} data-id="fx" data-name="Fx" style={{width: '200px', height: '100px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto', order: '0', scale: fxScale, opacity: fxOpacityC, y: fxYA}}
          ></motion.div>
    <div data-id="a2" data-name="A2" style={{ width: '200px', height: '100px', backgroundColor: '#ff9977', position: 'relative', flex: '0 0 auto', order: '1' }}></div>
  </div>
  <div data-id="sec-b" data-name="SecB" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '600px', position: 'relative', backgroundColor: '#3a1a1a', flex: '0 0 auto', order: '1' }}>
    <div data-id="b1" data-name="B1" style={{ width: '200px', height: '100px', backgroundColor: '#77ff55', position: 'relative', flex: '0 0 auto', order: '0' }}></div>
  </div>
</div>
  );
}
`;
export const FX2_PAGE = seedOf(FX2_PAGE_SRC.replace("minHeight: '900px'", "minHeight: '2400px'"));

/** A flex column `list` with Glide on (updateGlide): every item wrapped in a
 *  data-glide-item motion.div inside one LayoutGroup. */
export const GLIDE_PAGE_SRC = `'use client';

/** @canvas {
  "viewports": [
    {
      "id": "desktop",
      "label": "Desktop",
      "width": 1440,
      "isPrimary": true,
      "order": 0
    }
  ],
  "positions": {
    "desktop": {
      "x": 0,
      "y": 0
    }
  }
} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <motion.div layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} data-glide='{"transition":{"type":"spring","duration":"0.5","bounce":"0.25","delay":"0"}}' data-id="list" data-name="List" style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px', width: '600px', position: 'relative', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '0' }}><LayoutGroup>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0', flex: '0 0 auto', width: '300px' }}><div data-id="it1" data-name="It1" style={{ width: '300px', height: '90px', backgroundColor: '#ff5577', position: 'relative', flex: '0 0 auto', order: '0' }}></div></motion.div>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '1', flex: '0 0 auto', width: '300px' }}><div data-id="it2" data-name="It2" style={{ width: '300px', height: '90px', backgroundColor: '#ffcc55', position: 'relative', flex: '0 0 auto', order: '1' }}></div></motion.div>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '2', flex: '0 0 auto', width: '300px' }}><div data-id="it3" data-name="It3" style={{ width: '300px', height: '90px', backgroundColor: '#55aadd', position: 'relative', flex: '0 0 auto', order: '2' }}></div></motion.div>
  </LayoutGroup></motion.div>
</div>
  );
}
`;
export const GLIDE_PAGE = seedOf(GLIDE_PAGE_SRC);

/** Three tiles: `fx` (absolute in no-layout frame `fa`, beside sibling frame
 *  `fb`) has an Appear hidden on Mobile (hiddenOn) and a Hover that exists on
 *  Tablet only (scoped whileHover) — written by the product (scoped
 *  updateMotionProp + the "remove here" hidePresenceOn → updateScrollFx). */
export const FX3_PAGE_SRC = `'use client';

/** @canvas {
  "viewports": [
    {
      "id": "desktop",
      "label": "Desktop",
      "width": 1440,
      "isPrimary": true,
      "order": 0
    },
    {
      "id": "tablet",
      "label": "Tablet",
      "width": 768,
      "isPrimary": false,
      "order": 1
    },
    {
      "id": "mobile",
      "label": "Mobile",
      "width": 375,
      "isPrimary": false,
      "order": 2
    }
  ],
  "positions": {
    "desktop": {
      "x": 0,
      "y": 0
    },
    "tablet": {
      "x": 1560,
      "y": 0
    },
    "mobile": {
      "x": 2448,
      "y": 0
    }
  }
} */

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

function useMediaQuery(query: string): boolean {
  // Lazy initializer reads the REAL match on the first client render (not just
  // after a post-mount effect). Critical for framer-motion's \`initial\` (Appear),
  // which is captured ONCE at mount — a useState(false) start would make the
  // responsive branch lose to the base on every page load. (On the server there's
  // no window → false; the client corrects on mount.)
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}


export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px) and (min-width: 375.02px)');
  const __mq1 = useMediaQuery('(max-width: 375px)');
      return (
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '100%', minHeight: '900px', padding: '40px', position: 'relative', backgroundColor: '#0d0d1a' }}>
  <div data-id="stage" data-name="Stage" style={{ width: '700px', height: '320px', position: 'relative', backgroundColor: '#14142a', flex: '0 0 auto', order: '0' }}>
    <div data-id="fa" data-name="FrameA" style={{ position: 'absolute', left: '20px', top: '20px', width: '300px', height: '280px', backgroundColor: '#1a1a3a' }}>
      <motion.div data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"30"},"once":true,"hiddenOn":[{"query":"(max-width: 375px)"}]},"hover":{"props":{},"responsive":[{"scope":{"query":"(max-width: 768px) and (min-width: 375.02px)"},"props":{"scale":"1.1"}}]}}' data-id="fx" data-name="Fx" style={{ position: 'absolute', left: '40px', top: '40px', width: '120px', height: '80px', backgroundColor: '#ff5577' }}
          
          whileHover={__mq0 ? { scale: 1.1 } : undefined}
          
          initial={__mq1 ? false : { opacity: 0, y: 30 }}
          
          whileInView={{ opacity: 1, y: 0 }}
          
          viewport={{ once: true }}
          ></motion.div>
    </div>
    <div data-id="fb" data-name="FrameB" style={{ position: 'absolute', left: '380px', top: '20px', width: '300px', height: '280px', backgroundColor: '#3a1a1a' }}></div>
  </div>
</div>
  );
}
`;
export const FX3_PAGE = seedOf(FX3_PAGE_SRC);

// ─── Effect-code readers ──────────────────────────────────────────────

type AstN = { type: string; start?: number | null; end?: number | null; [k: string]: any };

function walkAst(n: unknown, visit: (n: AstN, parent: AstN | null) => void, parent: AstN | null = null): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walkAst(c, visit, parent); return; }
  const node = n as AstN;
  if (typeof node.type === 'string') visit(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue;
    walkAst(node[k], visit, typeof node.type === 'string' ? node : parent);
  }
}

function patternNames(p: AstN | null | undefined, out: string[]): void {
  if (!p) return;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements) patternNames(q, out);
}

export interface EffectFacts {
  /** Every name a top-level `const` in the page function body declares (duplicates kept). */
  decls: string[];
  /** Names declared more than once. */
  dupDecls: string[];
  /** Identifiers the element's attributes reference that the page body never declares. */
  undeclared: string[];
  /** The element's `ref={…}` expression source, or null. */
  ref: string | null;
  /** The element's tag name (motion.div, div…), or null when missing. */
  tag: string | null;
  /** Identifiers referenced in the element's attributes (style values, handlers, ref). */
  attrIdents: string[];
}

/** What the file's page function declares, and what the element with `id` references. */
export function effectFacts(code: string, id: string, fnName = 'Page'): EffectFacts {
  const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as AstN;
  let fnBody: AstN | null = null;
  walkAst(ast, (n) => {
    if (fnBody) return;
    if (n.type === 'FunctionDeclaration' && n.id?.name === fnName) fnBody = n.body;
  });
  const decls: string[] = [];
  for (const st of (fnBody as AstN | null)?.body ?? []) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) patternNames(d.id, decls);
  }
  // Module-level declarations (imports, consts, functions) are in scope too.
  const moduleNames = new Set<string>();
  for (const st of (ast as AstN).program.body) {
    if (st.type === 'ImportDeclaration') for (const sp of st.specifiers) moduleNames.add(sp.local.name);
    else if (st.type === 'VariableDeclaration') for (const d of st.declarations) { const o: string[] = []; patternNames(d.id, o); o.forEach(x => moduleNames.add(x)); }
    else if (st.type === 'FunctionDeclaration' && st.id) moduleNames.add(st.id.name);
    else if (st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration') {
      const dcl = st.declaration;
      if (dcl?.type === 'FunctionDeclaration' && dcl.id) moduleNames.add(dcl.id.name);
    }
  }
  let opening: AstN | null = null;
  walkAst(ast, (n) => {
    if (opening || n.type !== 'JSXOpeningElement') return;
    if ((n.attributes ?? []).some((a: AstN) => a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.value === id)) opening = n;
  });
  const attrIdents: string[] = [];
  let ref: string | null = null;
  let tag: string | null = null;
  if (opening) {
    const o = opening as AstN;
    const nm = o.name;
    tag = nm.type === 'JSXMemberExpression' ? `${nm.object.name}.${nm.property.name}` : nm.name;
    for (const a of o.attributes ?? []) {
      if (a.type !== 'JSXAttribute' || a.value?.type !== 'JSXExpressionContainer') continue;
      if (a.name?.name === 'ref') ref = code.slice(a.value.expression.start, a.value.expression.end);
      const params: string[] = [];
      const seen: string[] = [];
      walkAst(a.value.expression, (n, parent) => {
        if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') for (const prm of n.params) patternNames(prm, params);
        if (n.type !== 'Identifier') return;
        if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
        if (parent && (parent.type === 'ObjectProperty') && parent.key === n && !parent.computed) return;
        seen.push(n.name);
      });
      attrIdents.push(...seen.filter(x => !params.includes(x)));
    }
  }
  const counts = new Map<string, number>();
  for (const d of decls) counts.set(d, (counts.get(d) ?? 0) + 1);
  const known = new Set([...decls, ...moduleNames, 'undefined', 'Math', 'window', 'document', 'true', 'false']);
  const undeclared = [...new Set(attrIdents)].filter(x => !known.has(x) && !/^[_a-z]$/.test(x));
  return { decls, dupDecls: [...counts].filter(([, n]) => n > 1).map(([k]) => k), undeclared, ref, tag, attrIdents: [...new Set(attrIdents)] };
}

/** `data-scroll-fx` spec of an element (parsed), or null. */
export function scrollFxOf(code: string, id: string): Record<string, any> | null {
  const raw = parseSource(code).byId.get(id)?.attrs['data-scroll-fx'];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export type { ProjectData };

/** Inline `order` of each id as {id: value} (null when absent). */
export async function inlineOrdersOf(editor: Editor, ids: string[], path?: string): Promise<Record<string, string | null>> {
  const src = await editor.source(path);
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = src.byId.get(id)?.style.order ?? null;
  return out;
}
