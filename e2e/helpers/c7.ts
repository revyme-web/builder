// Batch C7 helpers: design-component instance sizing, canvas–live parity and
// variants on breakpoints (E2E_TEST_PLAN.md §8, CMP-197…222).
//
//   import { c7Seed, CARD240, sizeSelect, cssSize } from '../../helpers/c7';
//
// Seeds are in the builder's own dialect (variantConfig, withResponsiveProps,
// motion.* roots spreading `...style`). A page instance renders on the canvas
// as its WRAPPER (`data-id` = the instance id) holding the expanded master
// root, whose node id is `<instanceId>:<rootId>`; live (:5175) the instance is
// ONE element (the master root with the instance style spread last), unless
// the runtime engages its wrapper split (data-size-hug, MotionValues, refs).

import type { FrameLocator, Locator, Page } from '@playwright/test';
import type { Editor } from './editor';
import { canvasHeader, TILE, TILES, type Tile, type ProjectData } from '../fixtures/project';

export { TILE, TILES };
export const PAGE = 'app/page.client.tsx';
export const ABOUT = 'app/about/page.client.tsx';

export type Box = { x: number; y: number; width: number; height: number };

// ─── Seed builders ────────────────────────────────────────────────────

export const SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A whole page.client.tsx: full @canvas header, imports, an optional
 *  preamble (consts), the root JSX and an optional canvasNodes fragment. */
export function c7Page(rootJsx: string, opts: { tiles?: Tile[]; imports?: string[]; preamble?: string; canvas?: string; header?: string } = {}): string {
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const body = rootJsx.trim().split('\n').map(l => (l ? '    ' + l : l)).join('\n');
  const canvas = opts.canvas ? `const canvasNodes = (<>\n${opts.canvas.trim()}\n</>);\n` : '';
  return `${opts.header ?? canvasHeader(opts.tiles ?? TILES.one)}
'use client';
import React from 'react';
${imports}${opts.preamble ?? ''}
export default function Page() {
  return (
${body}
  );
}
${canvas}`;
}

/** A project from a home page source plus masters (`components/<Name>.tsx`) and extra files. */
export function c7Seed(home: string, masters: Record<string, string> = {}, extra: Record<string, string> = {}): ProjectData {
  const files: Record<string, string> = { 'app/page.tsx': SERVER_WRAPPER, [PAGE]: home };
  for (const [name, src] of Object.entries(masters)) files[`components/${name}.tsx`] = src;
  Object.assign(files, extra);
  return { format: 'revyme-v1', files };
}

export const imp = (name: string) => `import ${name} from '@/components/${name}';`;

const ROOT_STYLE = `display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px'`;

/** The page root (flex column, padded) around `children`. */
export function root(children: string, opts: { id?: string; style?: string } = {}): string {
  return `<div data-id="${opts.id ?? 'root'}" data-name="Page" style={{ ${opts.style ?? ROOT_STYLE} }}>\n${children.trim().split('\n').map(l => '  ' + l).join('\n')}\n</div>`;
}

/** Master module boilerplate: one function component whose root spreads `...style` last. */
export function master(name: string, body: string, opts: { config?: string; pre?: string; imports?: string; params?: string; head?: string } = {}): string {
  const config = opts.config ?? `const variantConfig = [{ name: 'default', label: '${name}', x: 0, y: 0, isPrimary: true }];`;
  return `'use client';

/** @name "${name}" */
${opts.head ?? ''}
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
${opts.imports ?? ''}
${config}
${opts.pre ?? ''}
function ${name}({ style, initialVariant = 'default', ${opts.params ? opts.params + ', ' : ''}...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
${body.trim().split('\n').map(l => '    ' + l).join('\n')}
  </LayoutGroup>;
}
export default withResponsiveProps(${name});
`;
}

// ─── Masters ──────────────────────────────────────────────────────────

/** CMP-197: a 300×200 master (absolute root, the canvas tiling shape). */
export const TECARD = master('TeCard', `
<motion.div layout={true} data-id="tec-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ position: 'absolute', width: '300px', height: '200px', backgroundColor: '#97cffc', borderRadius: '12px', left: '0px', top: '0px', ...style }}>
  <motion.p layout={true} data-id="tec-text" data-name="Text" style={{ fontSize: '24px', color: '#000000', position: 'relative', margin: '0px' }}>Card</motion.p>
</motion.div>`);

/** A 240×160 card master (CMP-198/201/202). */
export const CARD240 = master('Card', `
<motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '240px', height: '160px', padding: '16px', backgroundColor: '#97cffc', borderRadius: '12px', ...style }}>
  <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Card title</motion.p>
</motion.div>`);

/** A card instance tag (page dialect). */
export function inst(tag: string, id: string, style = `position: 'relative', flex: '0 0 auto'`, attrs = ''): string {
  return `<${tag} data-id="${id}" data-name="${tag}"${attrs ? ' ' + attrs : ''} style={{ ${style} }} />`;
}

// ─── Panel ────────────────────────────────────────────────────────────

export function panel(page: Page): Locator {
  return page.locator('[data-properties-panel]');
}

/** The Dimensions section of the properties panel. */
export function dimensions(page: Page): Locator {
  return panel(page).locator('div').filter({ has: page.getByText('Dimensions', { exact: true }) }).last();
}

/** A properties-panel row by its label span (`title` attr), e.g. 'Width'. */
export function row(page: Page, label: string, nth = 0): Locator {
  return panel(page).locator(`span[title="${label}"]`).nth(nth)
    .locator('xpath=ancestor::div[@data-tool-row or contains(concat(" ", normalize-space(@class), " "), " justify-between ") or contains(@class, "grid-cols-")][1]');
}

/** The unit <select> of the Dimensions Width/Height row. */
export function sizeSelect(page: Page, dim: 'Width' | 'Height'): Locator {
  return row(page, dim).locator('select').first();
}

/** The number input of the Dimensions Width/Height row. */
export function sizeInput(page: Page, dim: 'Width' | 'Height'): Locator {
  return row(page, dim).locator('input').first();
}

/** A Component Props row (label + control) by its visible label. */
export function propRow(page: Page, label: string): Locator {
  return panel(page)
    .getByText(label, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " justify-between ") or contains(@class, "grid-cols-")][1]');
}

/** True when a row label shows the override accent. */
export async function labelAccented(page: Page, label: string): Promise<boolean> {
  const el = panel(page).locator(`span[title="${label}"]`).first();
  if (await el.count() === 0) {
    return panel(page).getByText(label, { exact: true }).first().evaluate(e => /accent/.test(e.className));
  }
  return el.evaluate(e => /accent/.test(e.className));
}

// ─── Canvas reads ─────────────────────────────────────────────────────

/** Layout size (CSS px, camera zoom excluded) of a node's copy on a tile. */
export async function cssSize(editor: Editor, vpId: string, id: string): Promise<{ w: number; h: number } | null> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return null;
  return loc.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
}

/** Layout size of a canvas node by its full node id (e.g. `card-a:card-root`). */
export async function cssSizeOfNode(editor: Editor, nodeId: string): Promise<{ w: number; h: number } | null> {
  const loc = editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  if ((await loc.count()) === 0) return null;
  return loc.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
}

/** A computed style of a node's copy on a tile ('' when missing). */
export async function computedIn(editor: Editor, vpId: string, id: string, prop: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

/** boundingBox of the first match, or null right away when nothing matches. */
export async function quickBox(loc: Locator): Promise<Box | null> {
  if ((await loc.count()) === 0) return null;
  return loc.first().boundingBox({ timeout: 2_000 }).catch(() => null);
}

/** Wait for a node's box to stop moving (camera tweens), then return it. */
export async function stableBoxIn(editor: Editor, vpId: string, id: string, timeout = 5_000): Promise<Box> {
  const read = () => editor.nodeBoxIn(vpId, id);
  let prev = await read();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    const cur = await read();
    const same = Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.width - prev.width) < 0.5 && Math.abs(cur.height - prev.height) < 0.5;
    prev = cur;
    if (same) break;
  }
  return prev;
}

/** Real click on a node's copy on a tile once the camera stopped moving,
 *  out of the double-click window of an earlier click. */
export async function clickIn(editor: Editor, vpId: string, id: string, opts: { fx?: number; fy?: number; shift?: boolean } = {}): Promise<void> {
  const page = editor.page();
  await page.waitForTimeout(450);
  const b = await stableBoxIn(editor, vpId, id);
  const p = { x: b.x + b.width * (opts.fx ?? 0.5), y: b.y + b.height * (opts.fy ?? 0.5) };
  await page.mouse.move(p.x, p.y);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  if (opts.shift) await page.keyboard.up('Shift');
  await editor.settled();
}

// ─── Source reads ─────────────────────────────────────────────────────

/** The JSX opening tag (raw text) carrying data-id="<id>" — tag-aware, so a
 *  `<style>` block repeating the id in a selector is skipped. */
export function tagOf(code: string, id: string): string {
  const needle = `data-id="${id}"`;
  let from = 0;
  while (from < code.length) {
    const at = code.indexOf(needle, from);
    if (at === -1) return '';
    from = at + needle.length;
    const start = code.lastIndexOf('<', at);
    if (start === -1 || !/[A-Za-z]/.test(code[start + 1] ?? '')) continue;
    let depth = 0, str = '';
    let inside = true;
    for (let i = start; i < at; i++) {
      const ch = code[i];
      if (str) { if (ch === str && code[i - 1] !== '\\') str = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') str = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) { inside = false; break; }
    }
    if (!inside) continue;
    depth = 0; str = '';
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if (str) { if (ch === str && code[i - 1] !== '\\') str = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) return code.slice(start, i + 1);
    }
    return '';
  }
  return '';
}

/** The `data-responsive` JSON of an instance tag (null when absent). */
export function responsiveOf(code: string, id: string): Record<string, any> | null {
  const tag = tagOf(code, id);
  const m = tag.match(/data-responsive=(?:'([^']*)'|"([^"]*)"|\{'([^']*)'\}|\{"((?:[^"\\]|\\.)*)"\})/);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? (m[4] ? JSON.parse(`"${m[4]}"`) : '');
  try { return JSON.parse(raw); } catch { return null; }
}

/** Poll a file until `predicate` holds; returns the last read. */
export async function pollCode(editor: Editor, path: string, predicate: (code: string) => boolean, timeout = 8_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let code = await editor.code(path);
  while (!predicate(code) && Date.now() < deadline) {
    await editor.page().waitForTimeout(100);
    code = await editor.code(path);
  }
  return code;
}

/** A file's contents once they stop changing (two reads ~500ms apart agree). */
export async function stableCode(editor: Editor, path: string, timeout = 8_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let prev = await editor.code(path);
  while (Date.now() < deadline) {
    await editor.page().waitForTimeout(500);
    await editor.settled();
    const now = await editor.code(path);
    if (now === prev) return now;
    prev = now;
  }
  return prev;
}

export async function traces(editor: Editor, pattern: string): Promise<Array<{ ts?: number; c: string; data: any }>> {
  return editor.page().evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}

// ─── Preview (:5175) ──────────────────────────────────────────────────

/** React's dev "unique key" warnings the preview logs on healthy pages. */
export const PREVIEW_NOISE = /Each child in a list should have a unique "key" prop/;

/** Open the header Preview and return its frame once `ready` is attached. */
export async function openPreview(editor: Editor, ready: string): Promise<FrameLocator> {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 45_000 });
  return frame;
}

/** Type a width into the preview overlay's W field (Enter commits) and wait
 *  until the preview document reports that viewport width. */
export async function setPreviewWidth(page: Page, frame: FrameLocator, width: number): Promise<void> {
  const input = page.locator('[data-preview-overlay] div.flex.items-center')
    .filter({ has: page.getByText('W', { exact: true }) }).locator('input').first();
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(String(width));
  await input.press('Enter');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const w = await frame.locator('body').evaluate(() => window.innerWidth).catch(() => 0);
    if (w === width) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`preview never reached ${width}px`);
}

/** Layout box + a few computed styles of the nth `[data-id=id]` in the preview. */
export async function previewBox(frame: FrameLocator, id: string, nth = 0): Promise<{ x: number; y: number; w: number; h: number; display: string; position: string; overflow: string; minWidth: string; boxShadow: string } | null> {
  const loc = frame.locator(`[data-id="${id}"]`);
  if ((await loc.count()) <= nth) return null;
  return loc.nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, position: cs.position, overflow: cs.overflow, minWidth: cs.minWidth, boxShadow: cs.boxShadow };
  });
}

// ─── Pixels ───────────────────────────────────────────────────────────

/** The RGB of one screen pixel (editor page coordinates, iframes composited). */
export async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const buf = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, buf.toString('base64'));
}

/** Is `rgb` close to the hex colour? */
export function near(rgb: [number, number, number], hex: string, tol = 40): boolean {
  const n = parseInt(hex.replace('#', ''), 16);
  const want = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
}

// ─── Seeds: pill / hug / shadow masters (CMP-203…205) ─────────────────

/** A MotionLink `<a>` pill root, no display of its own: 12/18 padding, a
 *  12px line → a 36px border box, hugging its label. */
export const LINK_PILL = `'use client';

/** @name "Link Pill" */

import React from 'react';
import Link from 'next/link';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(Link);

const variantConfig = [{ name: 'default', label: 'Link Pill', x: 0, y: 0, isPrimary: true }];

function LinkPill({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <MotionLink layout={true} data-id="lp-root" href="/" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Link Pill" style={{ padding: '12px 18px', backgroundColor: '#111111', borderRadius: '999px', fontSize: '12px', lineHeight: '12px', color: '#ffffff', textDecoration: 'none', whiteSpace: 'nowrap', ...style }}>
      Get started
    </MotionLink>
  </LayoutGroup>;
}
export default withResponsiveProps(LinkPill);
`;

/** A motion.button root with an AUTHORED inline-flex display. */
export const BUTTON_PILL = master('ButtonPill', `
<motion.button layout={true} data-id="bp-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button Pill" style={{ display: 'inline-flex', alignItems: 'center', padding: '12px 18px', backgroundColor: '#ff2d75', border: '0px', borderRadius: '999px', fontSize: '12px', lineHeight: '12px', color: '#ffffff', ...style }}>
  Buy now
</motion.button>`);

/** A hug master root (no width/height keys) holding a label that must not wrap. */
export const HUG_PILL = master('HugPill', `
<motion.div layout={true} data-id="hp-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Hug Pill" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', padding: '12px 18px', backgroundColor: '#ffd166', borderRadius: '999px', ...style }}>
  <motion.p layout={true} data-id="hp-label" data-name="Label" style={{ position: 'relative', fontSize: '16px', lineHeight: '20px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Find an advisor near you</motion.p>
</motion.div>`);

/** A clipping master root with a solid spread shadow (12px red ring). */
export const SHADOW_CARD = master('ShadowCard', `
<motion.div layout={true} data-id="sc-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Shadow Card" style={{ display: 'flex', flexDirection: 'column', width: '200px', height: '120px', padding: '16px', backgroundColor: '#97cffc', overflow: 'hidden', boxShadow: '0px 0px 0px 12px #ff0000', ...style }}>
  <motion.p layout={true} data-id="sc-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Shadowed</motion.p>
</motion.div>`);

// ─── Seeds: nested instances (CMP-199 / 200 / 212) ────────────────────

/** The nested master: a 200×120 box. */
export const BOX = master('Box', `
<motion.div layout={true} data-id="box-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Box" style={{ display: 'flex', flexDirection: 'column', width: '200px', height: '120px', padding: '12px', backgroundColor: '#ffd166', ...style }}>
  <motion.p layout={true} data-id="box-text" data-name="Text" style={{ position: 'relative', fontSize: '14px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Box</motion.p>
</motion.div>`);

/** A two-variant Panel master holding a nested Box instance (`boxAttrs` + `boxStyle` on its tag). */
export function panelMaster(opts: { second?: string; boxAttrs?: string; boxStyle?: string } = {}): string {
  const second = opts.second ?? 'variant-1';
  return master('Panel', `
<motion.div layout={true} data-id="panel-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '400px', padding: '24px', backgroundColor: '#1a1a3a', ...style }}>
  <Box data-id="box-inst" data-name="Box"${opts.boxAttrs ? ' ' + opts.boxAttrs : ''} style={{ ${opts.boxStyle ?? `position: 'relative', width: '200px', height: '419px', flex: '0 0 auto'`} }} />
</motion.div>`, {
    imports: imp('Box'),
    config: `const variantConfig = [
  { name: 'default', label: 'Panel', x: 0, y: 0, isPrimary: true },
  { name: '${second}', label: 'Compact', x: 600, y: 0 },
];`,
  });
}

/** A 80×48 chip (CMP-200's nested master). */
export const CHIP = master('Chip', `
<motion.div layout={true} data-id="chip-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Chip" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '80px', height: '48px', backgroundColor: '#ff2d75', borderRadius: '8px', ...style }}>
  <motion.p layout={true} data-id="chip-text" data-name="Text" style={{ position: 'relative', fontSize: '12px', lineHeight: '12px', color: '#ffffff', margin: '0px', flex: '0 0 auto' }}>Chip</motion.p>
</motion.div>`);

/** A stateful (connections) Nav whose nested Chip sizes per variant with a
 *  '' else branch: `height: variant === 'x' ? '35px' : ''`. */
export const NAV_X = `'use client';

/** @name "Nav" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Chip from '@/components/Chip';

const variantConfig = [
  { name: 'default', label: 'Nav', x: 0, y: 0, isPrimary: true },
  { name: 'x', label: 'X', x: 600, y: 0 },
  { name: 'default-hover', label: 'Nav - Hover', x: 0, y: 200, interactionType: 'hover', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function Nav({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="nav-root" onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)} initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-name="Nav" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', width: '400px', height: '80px', padding: '16px', backgroundColor: '#1a1a3a', ...style }}>
      <Chip data-id="nav-chip" data-name="Chip" style={{ position: 'relative', width: '80px', height: variant === 'x' ? '35px' : '', flex: '0 0 auto' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Nav);
`;

/** A two-variant 240×160 card (labels Default / Hover). */
export const CARD_2V = master('Card', `
<motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '240px', height: '160px', padding: '16px', backgroundColor: '#97cffc', borderRadius: '12px', ...style }}>
  <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>Card title</motion.p>
</motion.div>`, {
  config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];`,
});

/** A master whose root promotes itself (`willChange: transform`, perf isolation). */
export const PROMOTED = master('Neon', `
<motion.div layout={true} data-id="neon-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Neon" style={{ position: 'relative', contain: 'layout paint', willChange: 'transform', width: '400px', padding: '16px', backgroundColor: '#ffffff', ...style }}>
  <motion.h1 layout={true} data-id="neon-text" data-name="Text" style={{ position: 'relative', margin: '0px', fontSize: '40px', color: '#000000' }}>NEON PRIME</motion.h1>
</motion.div>`);

/** CMP-206: a master whose ROOT is 760px wide with an authored auto height. */
export const FAQ_ITEM = master('FAQItem', `
<motion.div layout={true} data-id="faq-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="FAQ Item" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '760px', height: 'auto', padding: '20px', backgroundColor: '#97cffc', ...style }}>
  <motion.p layout={true} data-id="faq-q" data-name="Question" style={{ position: 'relative', fontSize: '18px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>How does billing work?</motion.p>
</motion.div>`);

/** The Library panel's row for a component (opens the panel first). */
export async function libraryRow(page: Page, name: string): Promise<Locator> {
  const lib = page.locator('[data-library-panel]');
  if (!(await lib.isVisible().catch(() => false))) await page.locator('[data-tutorial="library-button"]').click();
  await lib.waitFor({ state: 'visible' });
  return lib.getByText(name, { exact: true }).first();
}

// ─── Seeds: runtime placement (CMP-208 / 209) ─────────────────────────

/** A master whose root bakes `position: 'absolute'` (canvas tiling shape). */
export const ABS_TILE = master('Tile', `
<motion.div layout={true} data-id="tile-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Tile" style={{ position: 'absolute', left: '0px', top: '0px', width: '120px', height: '80px', backgroundColor: '#97cffc', ...style }}>
  <motion.p layout={true} data-id="tile-text" data-name="Text" style={{ position: 'relative', fontSize: '14px', color: '#000000', margin: '0px' }}>Tile</motion.p>
</motion.div>`);

/** A Header master holding a SignUp instance inside AnimatePresence popLayout. */
export const POP_HEADER = `'use client';

/** @name "Pop Header" */

import React from 'react';
import { motion, LayoutGroup, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import SignUp from '@/components/SignUp';

const variantConfig = [{ name: 'default', label: 'Pop Header', x: 0, y: 0, isPrimary: true }];

function PopHeader({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="ph-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Pop Header" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '800px', height: '80px', padding: '0px 24px', backgroundColor: '#1a1a3a', overflow: 'hidden', ...style }}>
      <motion.p layout={true} data-id="ph-logo" data-name="Logo" style={{ position: 'relative', fontSize: '20px', color: '#ffffff', margin: '0px', flex: '0 0 auto' }}>Logo</motion.p>
      <AnimatePresence mode="popLayout">
        <SignUp key="signup" data-id="ph-signup" data-name="Sign Up" style={{ position: 'relative', flex: '0 0 auto' }} />
      </AnimatePresence>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(PopHeader);
`;

/** A relative header-bar master (motion root, layout) for the fixed/sticky row. */
export const NAV_BAR = master('NavBar', `
<motion.div layout={true} data-id="nb-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Nav Bar" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '24px', width: '100%', height: '64px', padding: '0px 24px', backgroundColor: '#111111', ...style }}>
  <motion.p layout={true} data-id="nb-logo" data-name="Logo" style={{ position: 'relative', fontSize: '18px', color: '#ffffff', margin: '0px', flex: '0 0 auto' }}>Brand</motion.p>
</motion.div>`);

// ─── Seeds: variants on breakpoints (CMP-215…222) ─────────────────────

/** A stateless master with `<name>RootVariants` background colours per variant
 *  (+ optional extra root style), so each tile's variant reads off its fill. */
export function variantMaster(name: string, rootId: string, variants: Array<{ name: string; label: string; bg: string }>, opts: { rootStyle?: string; children?: string } = {}): string {
  const constName = `${rootId.replace(/-(\w)/g, (_, c) => c.toUpperCase())}Variants`;
  const config = `const variantConfig = [
${variants.map((v, i) => `  { name: '${v.name}', label: '${v.label}', x: ${i * 600}, y: 0${i === 0 ? ', isPrimary: true' : ''} },`).join('\n')}
];`;
  const pre = `const ${constName} = {
${variants.map(v => `  '${v.name}': { backgroundColor: '${v.bg}' },`).join('\n')}
};`;
  return master(name, `
<motion.div layout={true} data-id="${rootId}" variants={${constName}} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="${name}" style={{ ${opts.rootStyle ?? `display: 'flex', flexDirection: 'column', gap: '8px', width: '240px', height: '120px', padding: '16px'`}, backgroundColor: '${variants[0].bg}', ...style }}>
${(opts.children ?? `<motion.p layout={true} data-id="${rootId}-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto' }}>${name}</motion.p>`).trim()}
</motion.div>`, { config, pre });
}

export const BLUE = '#97cffc';
export const PINK = '#ff2d75';
export const GREEN = '#00c48c';
export const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** Background colour a node paints on a tile ('' when missing). */
export async function bgIn(editor: Editor, vpId: string, nodeId: string): Promise<string> {
  return computedIn(editor, vpId, nodeId, 'background-color');
}

// ─── Viewport tiles ───────────────────────────────────────────────────

/** Select a tile's viewport root with a real click on its header label. */
export async function selectTileRoot(editor: Editor, vpId: string): Promise<void> {
  const page = editor.page();
  await page.waitForTimeout(450);
  const label = page.locator(`[data-viewport-header="${vpId}"] [data-header-label], [data-viewport-header="${vpId}"] [data-header-title]`).first();
  const b = (await label.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await editor.settled();
}

/** The viewport root's Width (breakpoint) input — a plain-label Dimensions row. */
export function vpWidthInput(page: Page): Locator {
  return panel(page).getByText('Width', { exact: true }).first()
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " justify-between ")][1]').locator('input').first();
}

/** Real click on a tile header's "+" (Add Breakpoint). */
export async function clickAddBreakpoint(editor: Editor, vpId: string): Promise<void> {
  const page = editor.page();
  const b = (await page.locator(`[data-viewport-header="${vpId}"] [data-header-add]`).first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
