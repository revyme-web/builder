// Batch C4 helpers: design components — variants add/duplicate/delete/rename,
// interaction states, scroll variants, transitions and per-variant visibility
// (E2E_TEST_PLAN.md §8, CMP-101…CMP-127, CMP-162…CMP-166).
//
// Tiles of an open master: `desktop` is the primary (default variant), every
// other tile is its variant name (`variant-1`, `default-hover`, …). Seeds are
// in the builder's own dialect (variantConfig, withResponsiveProps, motion.*,
// `<name>Variants` consts, `connections` + guarded `_n` handlers).

import type { Locator, Page } from '@playwright/test';
import type { Editor } from './editor';
import { canvasHeader, TILES, type ProjectData } from '../fixtures/project';
import { astOf, walk, openingOf } from './c5';
import { revealRow } from './d4';

export const CARD = 'components/Card.tsx';
export const PAGE = 'app/page.client.tsx';
export const ABOUT = 'app/about/page.client.tsx';

// ─── Seeds ────────────────────────────────────────────────────────────

export const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A page module (full one-tile @canvas header) holding `jsx` in a flex column. */
export function pageWith(jsx: string, imports = `import Card from '@/components/Card';`, tiles = TILES.one): string {
  return `${canvasHeader(tiles)}
'use client';
${imports}
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
      ${jsx}
    </div>
  );
}
`;
}

export const BLANK_PAGE = pageWith('', '');

/** A project: home page + extra files. */
export function seed(files: Record<string, string>, page = BLANK_PAGE): ProjectData {
  return { format: 'revyme-v1', files: { 'app/page.tsx': PAGE_SERVER_WRAPPER, 'app/page.client.tsx': page, ...files } };
}

/** A master at components/<name>.tsx; the home page holds one instance of it. */
export function masterSeed(name: string, source: string, opts: { page?: string; extra?: Record<string, string> } = {}): ProjectData {
  const page = opts.page ?? pageWith(`<${name} data-id="inst-a" data-name="${name} A" style={{ position: 'relative', flex: '0 0 auto' }} />`, `import ${name} from '@/components/${name}';`);
  return seed({ [`components/${name}.tsx`]: source, ...(opts.extra ?? {}) }, page);
}

/** An extra route `app/<route>/` (server wrapper + client page). */
export function extraPage(route: string, page: string): Record<string, string> {
  return { [`app/${route}/page.tsx`]: PAGE_SERVER_WRAPPER, [`app/${route}/page.client.tsx`]: page };
}

// ─── Opening a master ─────────────────────────────────────────────────

/** Open a component master and fit its variant tiles on screen (setup only). */
export async function openMaster(editor: Editor, path = CARD, waitTile = 'variant-1'): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  if (waitTile) {
    await editor.sandbox().locator(`[data-viewport="${waitTile}"], [data-node-id^="${waitTile}-"]`).first()
      .waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
  }
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}

// ─── Affordances ──────────────────────────────────────────────────────

/** The "+ Variant" card to the right of a selected variant root. */
export function addVariantCard(page: Page): Locator {
  return page.locator('[title="Add Variant"]');
}

/** The "Hover / Pressed" strip below a selected variant root. */
export function hpStrip(page: Page): Locator {
  return page.locator('[title="Add interaction state"]');
}

/** The canvas area minus the bottom toolbar band (what a click can reach). */
export async function reachableCanvas(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  // [data-canvas-root] spans the whole window, under both side panels.
  const vp = page.viewportSize() ?? { width: 1720, height: 1000 };
  const left = await page.locator('[data-tutorial="left-panel"]').first().boundingBox().catch(() => null);
  const right = await page.locator('[data-properties-panel]').first().boundingBox().catch(() => null);
  const x0 = (left ? left.x + left.width : 310) + 8;
  const x1 = (right ? right.x : vp.width - 260) - 8;
  const y0 = 64, y1 = vp.height - 120;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Ctrl+wheel zoom-out over the top-left of the canvas (away from the cards). */
export async function zoomOut(editor: Editor, steps = 3): Promise<void> {
  const page = editor.page();
  const a = await reachableCanvas(page);
  const at = { x: a.x + a.width * 0.5, y: a.y + 40 };
  await page.mouse.move(at.x, at.y);
  // A ctrl-flagged wheel (pinch) through CDP: Playwright's wheel drops the modifier.
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let i = 0; i < steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 100, modifiers: 2 });
      await page.waitForTimeout(60);
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  await page.waitForTimeout(400);
  await editor.settled();
}

async function stableBoxOf(page: Page, card: Locator) {
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  let prev = await card.boundingBox();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(150);
    const cur = await card.boundingBox();
    if (prev && cur && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.width - prev.width) < 0.5) { prev = cur; break; }
    prev = cur;
  }
  if (!prev) throw new Error('affordance card has no box');
  return prev;
}

/** Wait for an affordance card to stop moving (placement polls), then click
 *  the centre of its reachable part (zooming out when it runs off-canvas or
 *  under the bottom toolbar). */
export async function clickCard(editor: Editor, card: Locator): Promise<void> {
  const page = editor.page();
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = await stableBoxOf(page, card);
    const a = await reachableCanvas(page);
    const x0 = Math.max(b.x, a.x), x1 = Math.min(b.x + b.width, a.x + a.width);
    const y0 = Math.max(b.y, a.y), y1 = Math.min(b.y + b.height, a.y + a.height);
    if (x1 - x0 >= 24 && y1 - y0 >= 24) {
      const p = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y);
      return;
    }
    // Pan (plain wheel) so the card's near edge comes to the canvas middle.
    const tx = b.x > a.x + a.width ? b.x + 60 : b.x + b.width < a.x ? b.x + b.width - 60 : a.x + a.width / 2;
    const ty = b.y > a.y + a.height - 24 ? b.y + 60 : b.y + b.height < a.y + 24 ? b.y + b.height - 60 : a.y + a.height / 2;
    await page.mouse.move(a.x + a.width / 2, a.y + 40);
    await page.mouse.wheel(tx - (a.x + a.width / 2), ty - (a.y + a.height / 2));
    await page.waitForTimeout(400);
  }
  throw new Error('affordance card never came into reach');
}

/** Open the Hover/Pressed strip and pick one state. */
export async function addState(editor: Editor, which: 'Hover' | 'Pressed'): Promise<void> {
  const page = editor.page();
  await clickCard(editor, hpStrip(page));
  const item = page.locator('div').filter({ hasText: new RegExp(`^${which}$`) }).last();
  await item.waitFor({ state: 'visible', timeout: 5_000 });
  await item.click();
  await editor.settled();
}

// ─── Source readers ───────────────────────────────────────────────────

export type VariantCfg = { name: string; label?: string; x?: number; y?: number; isPrimary?: boolean; interactionType?: string; parentVariant?: string };

/** `const variantConfig = [...]` as plain objects (literal values only). */
export function variantConfigOf(code: string): VariantCfg[] {
  const ast = astOf(code);
  let arr: any = null;
  walk(ast, (n) => {
    if (!arr && n.type === 'VariableDeclarator' && n.id?.name === 'variantConfig' && n.init?.type === 'ArrayExpression') arr = n.init;
  });
  if (!arr) return [];
  return arr.elements.filter((e: any) => e?.type === 'ObjectExpression').map((o: any) => {
    const out: any = {};
    for (const p of o.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const k = p.key.type === 'Identifier' ? p.key.name : p.key.value;
      const v = p.value;
      out[k] = v.type === 'StringLiteral' || v.type === 'NumericLiteral' || v.type === 'BooleanLiteral' ? v.value
        : v.type === 'UnaryExpression' && v.argument?.type === 'NumericLiteral' ? -v.argument.value : code.slice(v.start, v.end);
    }
    return out as VariantCfg;
  });
}

export type Conn = { from: string; to: string; trigger: string; sourceNode?: string };

/** `const connections = [...]` entries ([] when there is none). */
export function connectionsOf(code: string): Conn[] {
  const ast = astOf(code);
  let arr: any = null;
  walk(ast, (n) => {
    if (!arr && n.type === 'VariableDeclarator' && n.id?.name === 'connections' && n.init?.type === 'ArrayExpression') arr = n.init;
  });
  if (!arr) return [];
  return arr.elements.filter((e: any) => e?.type === 'ObjectExpression').map((o: any) => {
    const out: any = {};
    for (const p of o.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const k = p.key.type === 'Identifier' ? p.key.name : p.key.value;
      if (p.value.type === 'StringLiteral') out[k] = p.value.value;
    }
    return out as Conn;
  });
}

export const connKey = (c: Conn) => `${c.from}>${c.to}:${c.trigger}`;

/** Raw source of a JSX attribute's value on the element carrying `data-id` (null when absent). */
export function attrSource(code: string, id: string, name: string): string | null {
  const open = openingOf(astOf(code), id);
  if (!open) return null;
  const a = (open.attributes ?? []).find((x: any) => x.type === 'JSXAttribute' && x.name?.name === name);
  if (!a) return null;
  if (!a.value) return 'true';
  return a.value.type === 'StringLiteral' ? a.value.value : code.slice(a.value.expression?.start ?? a.value.start, a.value.expression?.end ?? a.value.end);
}

/** How many attributes named `name` the element carries. */
export function attrCount(code: string, id: string, name: string): number {
  const open = openingOf(astOf(code), id);
  return (open?.attributes ?? []).filter((x: any) => x.type === 'JSXAttribute' && x.name?.name === name).length;
}

/** Names of every `const <x> = {` object declaration in the file. */
export function objectConsts(code: string): string[] {
  const out: string[] = [];
  walk(astOf(code), (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init?.type === 'ObjectExpression') out.push(n.id.name);
  });
  return out;
}

/** True when the editor's own parser accepts the file (the canvas would render it). */
export async function editorParses(editor: Editor, path: string): Promise<boolean> {
  const v = await editor.oracle(path);
  return !v.some(x => x.tier === 3 && /PARSE|SYNTAX/i.test(x.code));
}

/** Poll a file until `predicate` holds (returns the last read either way). */
export async function pollCode(editor: Editor, path: string, predicate: (code: string) => boolean, timeout = 8_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let code = await editor.code(path);
  while (!predicate(code) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    code = await editor.code(path);
  }
  return code;
}

/** The file once it stops changing (three equal reads 300ms apart, after settle). */
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

/** Trace entries whose channel matches `pattern`. */
export async function traces(editor: Editor, pattern: string): Promise<Array<{ ts: number; c: string; data: any }>> {
  return editor.page().evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}

/** Tile ids (data-viewport) currently mounted in the sandbox. */
export async function tileIds(editor: Editor): Promise<string[]> {
  return editor.sandbox().locator('[data-viewport]').evaluateAll(els => els.map(e => e.getAttribute('data-viewport') ?? ''));
}

// ─── MASTER_STATES (C4 flavour) ──────────────────────────────────────
//
// A Card master in the shape the builder itself writes after adding a Hover,
// a Pressed and a click toggle (generated once through the UI, then frozen):
// default / variant-1 ("Open") / default-hover / default-pressed, a
// `connections` const with guarded `_n` handlers, per-variant ternaries
// (multi-branch size, order, double-quoted text, a `content`-bound text), a
// child hidden on variant-1 behind an AnimatePresence gate, and a nested
// `transition` inside the variant-1 entry. Instances on two pages.

export const STATES_HEAD = `'use client';

/** @name "Card" */
/** @propMeta {"content":{"type":"plainText","label":"Content"}} */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

export const STATES_CONFIG = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 420, interactionType: 'hover', parentVariant: 'default' },
  { name: 'default-pressed', label: 'Default - Pressed', x: 600, y: 420, interactionType: 'pressed', parentVariant: 'default' },
];`;

export const STATES_CONNECTIONS = `const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
  { from: 'default-hover', to: 'default-pressed', trigger: 'clickStart' },
  { from: 'default-pressed', to: 'default-hover', trigger: 'click' },
  { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'card-toggle' },
  { from: 'variant-1', to: 'default', trigger: 'click', sourceNode: 'card-toggle' },
];`;

export const STATES_CARD = `${STATES_HEAD}
${STATES_CONFIG}

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75', transition: { ease: 'easeIn' } },
  'default-hover': { backgroundColor: '#5aa9f0' },
  'default-pressed': { backgroundColor: '#3b82f6' }
};

const cardBadgeVariants = {
  default: { backgroundColor: '#000000' },
  'default-hover': { backgroundColor: '#000000' },
  'default-pressed': { backgroundColor: '#000000' }
};

${STATES_CONNECTIONS}

function Card({ style, initialVariant = 'default', content = 'Bound copy', ...rest }: { style?: React.CSSProperties; initialVariant?: string; content?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onTap={() => { const _n = variant === 'default-pressed' ? 'default-hover' : null; if (_n) setVariant(_n); }}
      onTapStart={() => { const _n = variant === 'default-hover' ? 'default-pressed' : null; if (_n) setVariant(_n); }}
      onHoverEnd={() => { const _n = variant === 'default-hover' ? 'default' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '260px', padding: '24px', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{variant === "variant-1" ? "Open copy" : "Resting copy"}</motion.p>
      <motion.p layout={true} data-id="card-desc" data-name="Desc" style={{ position: 'relative', fontSize: '14px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>{variant === 'variant-1' ? content : "Description"}</motion.p>
      <motion.div layout={true} data-id="card-bar" data-name="Bar" style={{ position: 'relative', width: variant === 'variant-1' ? '200px' : variant === 'default-pressed' ? '150px' : '120px', height: '12px', backgroundColor: '#000000', flex: '0 0 auto', order: variant === 'variant-1' ? 4 : 2 }} />
      <motion.div
      onTap={() => { const _n = variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-toggle" data-name="Toggle" style={{ position: 'relative', width: '60px', height: '24px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '3' }} />
      <AnimatePresence mode="popLayout">
        {variant !== "variant-1" &&
          <motion.div layout={true} key="card-badge" data-id="card-badge" data-name="Badge" variants={cardBadgeVariants} style={{ position: 'relative', width: '40px', height: '16px', backgroundColor: '#000000', flex: '0 0 auto', order: '4' }} exit={{ opacity: 0 }} animate={['default', variant]} />
          }
      </AnimatePresence>
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(Card);
`;

export const CARD_IMPORT = `import Card from '@/components/Card';`;

export const STATES_HOME = pageWith(`<Card data-id="card-a" data-name="Card A" style={{ position: 'relative', flex: '0 0 auto' }} />
      <Card data-id="card-v1" data-name="Card V1" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto' }} />`, CARD_IMPORT);

export const STATES_ABOUT = pageWith(`<Card data-id="card-c" data-name="Card C" style={{ position: 'relative', flex: '0 0 auto' }} />`, CARD_IMPORT);

/** A Card master + the home page (2 instances) + /about (1 instance). */
export function cardProject(source: string, opts: { home?: string; extra?: Record<string, string> } = {}): ProjectData {
  return seed({ [CARD]: source, ...extraPage('about', STATES_ABOUT), ...(opts.extra ?? {}) }, opts.home ?? STATES_HOME);
}

export const MASTER_STATES = cardProject(STATES_CARD);

// ─── Canvas reads ─────────────────────────────────────────────────────

/** A computed style of a node on a tile ('' when the element is missing). */
export async function computedIn(editor: Editor, vpId: string, id: string, prop: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.first().evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

/** Text a node paints on a tile ('' when missing). */
export async function textIn(editor: Editor, vpId: string, id: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return ((await loc.first().textContent()) ?? '').trim();
}

/** Number of painted copies of `id` on a tile (0 = not rendered). */
export async function countIn(editor: Editor, vpId: string, id: string): Promise<number> {
  return (await editor.nodeIn(vpId, id)).count();
}

/** Does the tile's root show the selected-label Play button (= selected on that tile)? */
export function selectedOnTile(page: Page, vpId: string, rootId: string): Locator {
  return page.locator(`[data-canvas-node-label="${vpId}:${rootId}"] [title="Preview this component"]`);
}

/** Occurrences of a quoted variant name ('x' or "x") anywhere in the file. */
export function mentions(code: string, name: string): number {
  return (code.match(new RegExp(`['"]${name.replace(/[-]/g, '\\-')}['"]`, 'g')) ?? []).length;
}

/** Is the node painted on a tile? (Variant-hidden nodes stay in the DOM with display:none.) */
export async function shownIn(editor: Editor, vpId: string, id: string): Promise<boolean> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return false;
  return loc.first().evaluate(el => getComputedStyle(el as HTMLElement).display !== 'none');
}

// ─── Simple masters ──────────────────────────────────────────────────

const SIMPLE_HEAD = (name: string, hooks = false) => `'use client';

/** @name "${name}" */

import React${hooks ? ', { useState, useEffect }' : ''} from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

/** default + variant-1 ("Open"), no connections: a root with a title and a small box. */
export function plainCard(name = 'Card'): string {
  return `${SIMPLE_HEAD(name)}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' }
};

function ${name}({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <motion.div layout={true} data-id="card-box" data-name="Box" style={{ position: 'relative', width: '60px', height: '24px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '1' }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(${name});
`;
}

/** default + variant-1 + default-hover, as the builder leaves it after "+ Hover" on default. */
export function hoverOnlyCard(name = 'Card'): string {
  return `${SIMPLE_HEAD(name, true)}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 360, interactionType: 'hover', parentVariant: 'default' },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' },
  'default-hover': { backgroundColor: '#5aa9f0' }
};

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function ${name}({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onHoverEnd={() => { const _n = variant === 'default-hover' ? 'default' : null; if (_n) setVariant(_n); }}
      onHoverStart={() => { const _n = variant === 'default' ? 'default-hover' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <motion.div layout={true} data-id="card-box" data-name="Box" style={{ position: 'relative', width: '60px', height: '24px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '1' }} />
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(${name});
`;
}

/** The guarded handler the builder emits for one transition chain. */
export function guarded(chain: Array<[string, string]>): string {
  return `() => { const _n = ${chain.map(([f, t]) => `variant === '${f}' ? '${t}'`).join(' : ')} : null; if (_n) setVariant(_n); }`;
}

// ─── Preview (:5175) ─────────────────────────────────────────────────

export const PREVIEW_NOISE = /Each child in a list should have a unique "key" prop/;

/** Switch to a page (setup), open the header Preview and return its frame once `ready` is attached. */
export async function previewPage(editor: Editor, path: string, ready: string): Promise<import('@playwright/test').FrameLocator> {
  const page = editor.page();
  if ((await editor.activeFile()) !== path) {
    await editor.openFile(path);
    await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
    await editor.settled();
  }
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 45_000 });
  return frame;
}

/** A computed style of the first element matching `sel` in the preview frame. */
export async function previewStyle(frame: import('@playwright/test').FrameLocator, sel: string, prop: string): Promise<string> {
  return frame.locator(sel).first().evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop).catch(() => '');
}

/** Move the real mouse onto (fx, fy) of a preview element. */
export async function hoverPreview(editor: Editor, frame: import('@playwright/test').FrameLocator, sel: string, fx = 0.5, fy = 0.5): Promise<void> {
  const b = await frame.locator(sel).first().boundingBox();
  if (!b) throw new Error(`preview element ${sel} has no box`);
  await editor.page().mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 4 });
}

/** Real click on (fx, fy) of a preview element. */
export async function clickPreview(editor: Editor, frame: import('@playwright/test').FrameLocator, sel: string, fx = 0.5, fy = 0.5): Promise<void> {
  const b = await frame.locator(sel).first().boundingBox();
  if (!b) throw new Error(`preview element ${sel} has no box`);
  await editor.page().mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 3 });
  await editor.page().mouse.click(b.x + b.width * fx, b.y + b.height * fy);
}

// ─── Panel helpers ────────────────────────────────────────────────────

/** Click the × of an Animation-tool entry whose label (span[title]) is `label`. */
export async function removeEffect(page: Page, label: string): Promise<void> {
  const lab = page.locator(`[data-properties-panel] span[title="${label}"]`).first();
  await lab.waitFor({ state: 'visible', timeout: 10_000 });
  const card = lab.locator('xpath=ancestor::div[.//button//span[normalize-space(text())="×"] or .//span[normalize-space(text())="×"]][1]');
  await card.locator('span').filter({ hasText: /^×$/ }).last().click();
}

/** Open an Animation-tool entry's editor (its chip next to the `label`). */
export async function openEffect(page: Page, label: string): Promise<void> {
  const lab = page.locator(`[data-properties-panel] span[title="${label}"]`).first();
  await lab.waitFor({ state: 'visible', timeout: 10_000 });
  await lab.locator('xpath=ancestor::div[1]/following-sibling::*[1]').click();
}

/** The Styles → Transition row's value button opens its popup; returns the popup. */
export async function openTransition(page: Page): Promise<Locator> {
  const lab = page.locator('[data-properties-panel] span[title="Transition"]').first();
  await lab.waitFor({ state: 'visible', timeout: 10_000 });
  const rowEl = lab.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " justify-between ")][1]');
  await rowEl.locator('button').last().click();
  const pop = page.locator('[data-tool-popup]').last();
  await pop.getByText('Instant', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  return pop;
}

// ─── Hide control / Layers eye ────────────────────────────────────────

/** The Styles → Hide row. */
export function hideRow(page: Page): Locator {
  return page.locator('[data-properties-panel] [data-tool-row]').filter({ has: page.getByText('Hide', { exact: true }) }).first();
}

/** Click Hide → Yes / No. */
export async function setHide(editor: Editor, v: 'Yes' | 'No'): Promise<void> {
  const r = hideRow(editor.page());
  await r.waitFor({ state: 'visible', timeout: 10_000 });
  await r.locator('[data-tool-row-value] button').filter({ hasText: new RegExp(`^${v}$`) }).click();
  await editor.settled();
}

/** Which Hide segment is active ('Yes' | 'No'). */
export async function hideValue(page: Page): Promise<string> {
  const r = hideRow(page);
  await r.waitFor({ state: 'visible', timeout: 10_000 });
  return r.locator('[data-tool-row-value] button').evaluateAll(bs => {
    const on = bs.find(b => b.className.includes('text-[var(--text-primary)]') && !b.className.includes('text-[var(--text-secondary)]'));
    return on?.textContent?.trim() ?? '';
  });
}

/** Is the Hide label lit as a per-variant override (purple)? */
export async function hideOverridden(page: Page): Promise<boolean> {
  return page.locator('[data-properties-panel] span[title="Hide"]').first()
    .evaluate(el => el.classList.contains('text-[var(--accent-secondary)]') || el.classList.contains('text-[var(--accent-text)]'));
}

/** Select a node through its Layers row on a tile (works for hidden nodes). */
export async function selectViaLayers(editor: Editor, nodeId: string, vpId: string): Promise<void> {
  const row = await revealRow(editor, nodeId, vpId);
  await editor.page().waitForTimeout(450);
  await row.scrollIntoViewIfNeeded();
  const b = (await row.boundingBox())!;
  await editor.page().mouse.click(b.x + Math.min(120, b.width / 2), b.y + b.height / 2);
  await editor.settled();
}

/** Click the eye of a node's Layers row on a tile. */
export async function toggleEye(editor: Editor, nodeId: string, vpId: string): Promise<void> {
  const row = await revealRow(editor, nodeId, vpId);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.locator('button[title="Hide layer"], button[title="Show layer"]').first().click();
  await editor.settled();
}
