// Batch C5 helpers: design components — per-variant styles, borders, text and
// layout (E2E_TEST_PLAN.md §8, CMP-128…CMP-161).
//
// Seeds are component masters in the builder's own dialect (`variantConfig`,
// `withResponsiveProps`, motion.* children, `<name>Variants` consts). Open a
// master with `openMaster(editor, 'components/X.tsx')`: its variants become
// the tiles. The primary (default) variant tile is vpId `desktop`, every
// other variant tile is its variant name (`variant-1`, `default-hover`, …).

import type { Locator, Page } from '@playwright/test';
import { parse as babelParse } from '@babel/parser';
import type { Editor } from './editor';
import { canvasHeader, TILES, type ProjectData } from '../fixtures/project';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

// ─── Seed builders ────────────────────────────────────────────────────

export const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** The full one-tile `@canvas` header (a bare {id,width} entry reads as a replica). */
export const PAGE_HEADER = canvasHeader(TILES.one);

export const BLANK_PAGE = `${PAGE_HEADER}
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px', background: '#0d0d1a' }} />
  );
}
`;

/** A project: home page (blank unless given) + extra files. */
export function seed(files: Record<string, string>, page = BLANK_PAGE): ProjectData {
  return { format: 'revyme-v1', files: { 'app/page.tsx': PAGE_SERVER_WRAPPER, 'app/page.client.tsx': page, ...files } };
}

/** A component master project: `components/<name>.tsx` + a blank home page. */
export function masterSeed(name: string, source: string, extra: Record<string, string> = {}, page = BLANK_PAGE): ProjectData {
  return seed({ [`components/${name}.tsx`]: source, ...extra }, page);
}

export const MASTER_HEAD = `'use client';

import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

export const CONFIG_2V = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 500, y: 0 },
];`;

export const CONFIG_3V = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 500, y: 0 },
  { name: 'variant-2', label: 'Variant 2', x: 1000, y: 0 },
];`;

/** A design-component master module around `body` (the root element JSX). */
export function masterModule(body: string, opts: { config?: string; pre?: string; name?: string; head?: string; post?: string; sig?: string; hooks?: string } = {}): string {
  const name = opts.name ?? 'Card';
  const sig = opts.sig ?? `{ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }`;
  return `${opts.head ?? MASTER_HEAD}
${opts.config ?? CONFIG_2V}
${opts.pre ?? ''}
function ${name}(${sig}) {
${opts.hooks ?? ''}  return (
${body.trim()}
  );
}

export default withResponsiveProps(${name});
${opts.post ?? ''}`;
}

// ─── Opening a master ─────────────────────────────────────────────────

/** Open a component master and fit its variant tiles on screen (setup only). */
export async function openMaster(editor: Editor, path = 'components/Card.tsx', secondTile = 'variant-1'): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator(`[data-viewport="${secondTile}"], [data-node-id^="${secondTile}-"]`).first()
    .waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}

/** Click a node once its box has stopped moving (the fit animation can still run). */
export async function clickStable(editor: Editor, id: string, vpId?: string, fx = 0.5, fy = 0.5): Promise<void> {
  const box = () => (vpId ? editor.nodeBoxIn(vpId, id) : editor.nodeBox(id));
  let prev = await box();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    const cur = await box();
    const same = Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.width - prev.width) < 0.5;
    prev = cur;
    if (same) break;
  }
  await editor.page().mouse.click(prev.x + prev.width * fx, prev.y + prev.height * fy);
  await editor.settled();
}

// ─── Panel ────────────────────────────────────────────────────────────

export function panel(page: Page): Locator {
  return page.locator('[data-properties-panel]');
}

// ─── Source readers (variants objects, style ternaries) ───────────────

type AstNode = { type: string; start?: number | null; end?: number | null; [k: string]: any };

export function astOf(code: string): AstNode {
  try {
    return babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as AstNode;
  } catch {
    // Unrecoverable syntax: an empty program (readers then find nothing).
    return { type: 'File', program: { type: 'Program', body: [] } } as unknown as AstNode;
  }
}

/** True when the file parses with no recovered errors. */
export function parsesClean(code: string): boolean {
  try {
    const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }) as any;
    return !(ast.errors?.length);
  } catch { return false; }
}

export function walk(n: unknown, visit: (n: AstNode) => void): void {
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
export function openingOf(ast: AstNode, id: string): AstNode | null {
  let found: AstNode | null = null;
  walk(ast, (n) => {
    if (found || n.type !== 'JSXOpeningElement') return;
    for (const a of n.attributes ?? []) {
      if (a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === id) { found = n; return; }
    }
  });
  return found;
}

/** Raw source of the opening tag of `id` ('' when missing). */
export function openingTag(code: string, id: string): string {
  const open = openingOf(astOf(code), id);
  return open ? code.slice(open.start ?? 0, open.end ?? 0) : '';
}

/** Raw source of the whole JSX element of `id` ('' when missing). */
export function elementSource(code: string, id: string): string {
  const ast = astOf(code);
  let found = '';
  walk(ast, (n) => {
    if (found || n.type !== 'JSXElement') return;
    const open = n.openingElement;
    for (const a of open.attributes ?? []) {
      if (a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === id) {
        found = code.slice(n.start ?? 0, n.end ?? 0);
        return;
      }
    }
  });
  return found;
}

/** The JSX tag name of `id` (`motion.div`, `MotionLink`, …). */
export function tagOf(code: string, id: string): string | null {
  const open = openingOf(astOf(code), id);
  if (!open) return null;
  const nm = (n: AstNode): string => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${nm(n.object)}.${nm(n.property)}` : '?';
  return nm(open.name);
}

/** The variants object (identifier resolved) for `id`: { variantName: {prop: value} }. */
export function variantsOf(code: string, id: string): Record<string, Record<string, string>> | null {
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
  const out: Record<string, Record<string, string>> = {};
  for (const p of (obj as AstNode).properties ?? []) {
    if (p.type !== 'ObjectProperty') continue;
    const k = keyName(p.key);
    if (k && p.value.type === 'ObjectExpression') out[k] = objectToRecord(code, p.value);
  }
  return out;
}

/** One variants entry for a node: { prop: value } (null when absent). */
export function variantEntry(code: string, id: string, variant: string): Record<string, string> | null {
  return variantsOf(code, id)?.[variant] ?? null;
}

/** Name of the identifier passed as `variants={…}` (null for inline/none). */
export function variantsIdent(code: string, id: string): string | null {
  const open = openingOf(astOf(code), id);
  const attr = (open?.attributes ?? []).find((a: AstNode) => a.type === 'JSXAttribute' && a.name?.name === 'variants');
  const expr = attr?.value?.expression;
  return expr?.type === 'Identifier' ? expr.name : null;
}

/** Style ternary `prop: drv === 'v1' ? a : c` → { branches: { v1: a, default: c }, driver }.
 *  A plain literal comes back as { default: value }; a missing prop as null. */
export function styleTernary(code: string, id: string, prop: string): { branches: Record<string, string>; driver: string | null; raw: string } | null {
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
  const raw = code.slice(v.start ?? 0, v.end ?? 0);
  while (v.type === 'ConditionalExpression' && v.test.type === 'BinaryExpression' && v.test.operator === '===') {
    const l = v.test.left, r = v.test.right;
    const name = l.type === 'Identifier' ? l.name : r.type === 'Identifier' ? r.name : null;
    const lit = l.type === 'StringLiteral' ? l.value : r.type === 'StringLiteral' ? r.value : null;
    if (name) driver = name;
    if (lit != null) branches[lit] = literal(code, v.consequent);
    v = v.alternate;
  }
  branches.default = literal(code, v);
  return { branches, driver, raw };
}

/** Poll a file until `predicate` holds (returns the last read either way). */
export async function pollCode(editor: Editor, path: string, predicate: (code: string) => boolean, timeout = 6_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let code = await editor.code(path);
  while (!predicate(code) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    code = await editor.code(path);
  }
  return code;
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

// ─── Canvas reads ─────────────────────────────────────────────────────

/** A computed style of a node on a tile ('' when missing). */
export async function computedIn(editor: Editor, vpId: string, id: string, prop: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.first().evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

/** Box of the copy of `id` on a tile (null when it has no box). */
export async function boxIn(editor: Editor, vpId: string, id: string): Promise<Box | null> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return null;
  return loc.first().boundingBox({ timeout: 2_000 }).catch(() => null);
}

export async function traces(editor: Editor, pattern: string): Promise<Array<{ c: string; data: any }>> {
  return editor.page().evaluate((p) => (window as any).__e2e.traceEntries(p) ?? [], pattern);
}

export const rafs = (page: Page, n = 1) =>
  page.evaluate((k) => new Promise<void>(r => {
    let i = 0;
    const tick = () => (++i >= k ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/** A properties-panel row by its label (the label span carries `title`). */
export function row(page: Page, label: string, nth = 0): Locator {
  return panel(page).locator(`span[title="${label}"]`).nth(nth)
    .locator('xpath=ancestor::div[@data-tool-row or contains(concat(" ", normalize-space(@class), " "), " justify-between ") or contains(@class, "grid-cols-")][1]');
}

/** The label span of a row (its class carries the override accent). */
export function label(page: Page, text: string, nth = 0): Locator {
  return panel(page).locator(`span[title="${text}"]`).nth(nth);
}

/** True when the row's label shows the component override accent (purple). */
export async function isOverridden(page: Page, text: string, nth = 0): Promise<boolean> {
  return label(page, text, nth).evaluate(el => el.classList.contains('text-[var(--accent-secondary)]') || el.classList.contains('text-[var(--accent-text)]'));
}

/** The preview logs React's "unique key" warning for `Page` — allow exactly that. */
export const PREVIEW_NOISE = /Each child in a list should have a unique "key" prop[\s\S]*render method of `Page`/;

/** The preview also logs that warning for a master's root children ("passed a
 *  child from <Master>") on some renders — dev-only React noise. */
export const PREVIEW_MASTER_KEY_NOISE = /unique "key" prop[\s\S]*passed a child from \w+/;

/** The topmost open ToolPopup. */
export function topPopup(page: Page): Locator {
  return page.locator('[data-tool-popup]').last();
}

/** Close the topmost ToolPopup with its header × (Escape would also deselect). */
export async function closePopup(page: Page): Promise<void> {
  const popups = page.locator('[data-tool-popup]');
  const n = await popups.count();
  if (n === 0) return;
  await popups.nth(n - 1).locator('div.cursor-grab > button').last().click().catch(async () => {
    await popups.nth(n - 1).locator('button').first().click();
  });
  const deadline = Date.now() + 3_000;
  while ((await popups.count()) >= n && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
}

/** Open the Fill popup (clicks the value button of the Fill row). */
export async function openFill(page: Page): Promise<Locator> {
  // The value button (not the label button that holds span[title]).
  await row(page, 'Fill').locator('button:not(:has(span[title]))').first().click();
  const pop = topPopup(page);
  await pop.locator('input[spellcheck="false"]').first().waitFor({ timeout: 5_000 });
  return pop;
}

/** Fill → type a hex into the colour picker (Enter commits), optionally an alpha %, then close. */
export async function setFillHex(page: Page, hex: string, opts: { alpha?: number; keepOpen?: boolean } = {}): Promise<void> {
  const pop = await openFill(page);
  const input = pop.locator('input[spellcheck="false"]').first();
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(hex.replace(/^#/, ''));
  await input.press('Enter');
  if (opts.alpha !== undefined) {
    const a = pop.locator('div:has(> span:text-is("A")) > input').first();
    await a.click();
    await a.press('ControlOrMeta+a');
    await a.fill(String(opts.alpha));
    await a.press('Enter');
  }
  if (!opts.keepOpen) await closePopup(page);
}

// ─── Gestures ─────────────────────────────────────────────────────────

/** Drag a selection resize handle (`edge` strip or corner `dir` circle) by a
 *  screen delta. An edge is grabbed at `along` (fraction of its length): the
 *  midpoint of a master root's right edge carries the connection-arrow handle. */
export async function resizeBy(editor: Editor, handle: { edge?: string; dir?: string; along?: number }, dx: number, dy: number, steps = 12): Promise<void> {
  const page = editor.page();
  const sel = handle.edge ? `[data-resize-edge="${handle.edge}"]` : `[data-resize-dir="${handle.dir}"]`;
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: 'attached', timeout: 5_000 });
  // Out of the double-click window of the selecting click.
  await page.waitForTimeout(650);
  const b = (await loc.boundingBox())!;
  const along = handle.along ?? 0.3;
  const vertical = b.height > b.width;
  const from = handle.edge
    ? (vertical ? { x: b.x + b.width / 2, y: b.y + b.height * along } : { x: b.x + b.width * along, y: b.y + b.height / 2 })
    : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await editor.settled();
}

/** Type a value into a numeric panel row's first input (Enter commits). */
export async function typeInRow(page: Page, labelText: string, value: string, opts: { nth?: number; input?: number } = {}): Promise<void> {
  const input = row(page, labelText, opts.nth ?? 0).locator('input').nth(opts.input ?? 0);
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(value);
  await input.press('Enter');
}

/** Select a node on a tile with a real click (default: its centre). */
export async function clickIn(editor: Editor, vpId: string, id: string, fx = 0.5, fy = 0.5): Promise<void> {
  await clickStable(editor, id, vpId, fx, fy);
}

/** DEBUG: a compact text dump of the properties panel (labels, inputs, buttons). */
export async function dumpPanel(page: Page): Promise<string> {
  return panel(page).evaluate(el => {
    const out: string[] = [];
    const walk = (n: Element, d: number) => {
      const tag = n.tagName.toLowerCase();
      const attrs = ['aria-label', 'title', 'placeholder', 'data-testid', 'role', 'value', 'type'].map(a => n.getAttribute(a) ? `${a}="${n.getAttribute(a)}"` : '').filter(Boolean).join(' ');
      const own = Array.from(n.childNodes).filter(c => c.nodeType === 3).map(c => c.textContent?.trim()).filter(Boolean).join('|');
      if (attrs || own || ['input', 'button', 'select'].includes(tag)) out.push(`${'  '.repeat(Math.min(d, 30))}${tag} ${attrs} ${own ? `«${own}»` : ''}`);
      for (const c of Array.from(n.children)) walk(c, d + 1);
    };
    walk(el, 0);
    return out.join('\n');
  });
}

/** A computed style of a node's `::after` on a tile ('' when missing). */
export async function afterIn(editor: Editor, vpId: string, id: string, prop: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  if ((await loc.count()) === 0) return '';
  return loc.first().evaluate((el, p) => getComputedStyle(el as HTMLElement, '::after').getPropertyValue(p), prop);
}

/** Rotation (deg) of a tile node's computed transform (0 when none). */
export async function angleIn(editor: Editor, vpId: string, id: string): Promise<number> {
  const t = await computedIn(editor, vpId, id, 'transform');
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  return Math.round(Math.atan2(b, a) * 180 / Math.PI);
}

/** Rotate the selected node with the corner rotate zone (outside the
 *  `topRight` resize circle) by `deg` around its centre, Shift held (15° snap). */
export async function rotateByHandle(editor: Editor, deg: number, opts: { shift?: boolean; corner?: string } = {}): Promise<void> {
  const page = editor.page();
  await page.waitForTimeout(650);
  const circles = page.locator('[data-resize-dir]');
  await circles.first().waitFor({ state: 'attached', timeout: 5_000 });
  const pts = await circles.evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { dir: e.getAttribute('data-resize-dir'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const corner = pts.find(p => p.dir === (opts.corner ?? 'topRight')) ?? pts[0];
  const vx = corner.x - cx, vy = corner.y - cy;
  const len = Math.hypot(vx, vy) || 1;
  const start = { x: corner.x + (vx / len) * 11, y: corner.y + (vy / len) * 11 };
  const r0 = Math.hypot(start.x - cx, start.y - cy);
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  if (opts.shift !== false) await page.keyboard.down('Shift');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (deg * Math.PI / 180) * (i / steps);
    await page.mouse.move(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  if (opts.shift !== false) await page.keyboard.up('Shift');
  await editor.settled();
}

/** Open the Border row popup and set the uniform Width (Enter commits). */
export async function setBorderWidth(page: Page, width: number, opts: { keepOpen?: boolean } = {}): Promise<void> {
  await row(page, 'Border').locator('button[type="button"]').first().click();
  const w = topPopup(page).locator('div:has(> span[title="Width"]) input').first();
  await w.waitFor({ timeout: 5_000 });
  await w.click();
  await w.press('ControlOrMeta+a');
  await w.fill(String(width));
  await w.press('Enter');
  if (!opts.keepOpen) await closePopup(page);
}

/** Click a row label and pick a menu item (e.g. "Reset Override"). */
export async function labelMenu(page: Page, labelText: string, item: string): Promise<void> {
  await label(page, labelText).click();
  const it = page.getByText(item, { exact: true }).last();
  await it.waitFor({ timeout: 5_000 });
  await it.click();
}

// ─── Preview (:5175) ─────────────────────────────────────────────────

/** Open the header Preview and return its frame once `ready` (a CSS selector) is attached. */
export async function openPreview(page: Page, ready: string): Promise<import('@playwright/test').FrameLocator> {
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 45_000 });
  return frame;
}

/** Type a width into the preview overlay's W field and wait until the preview reports it. */
export async function setPreviewWidth(page: Page, frame: import('@playwright/test').FrameLocator, width: number): Promise<void> {
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
}

/** Switch the active file back to a page (setup only). */
export async function showFile(editor: Editor, path: string): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.settled();
}

/** Text of the open label-menu items (the ControlLabel dropdown). */
export async function menuTexts(page: Page): Promise<string[]> {
  return page.locator('body').evaluate(() => Array.from(document.querySelectorAll('[class*="dropdown-bg"] *'))
    .filter(e => e.childElementCount === 0).map(e => e.textContent?.trim() ?? '').filter(Boolean));
}

/** Open the colour picker of a row (`Fill`, `Color`, …), type a hex, Enter, close. */
export async function setColorHex(page: Page, rowLabel: string, hex: string): Promise<void> {
  await row(page, rowLabel).locator('button:not(:has(span[title]))').first().click();
  const pop = topPopup(page);
  const input = pop.locator('input[spellcheck="false"]').first();
  await input.waitFor({ timeout: 5_000 });
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(hex.replace(/^#/, ''));
  await input.press('Enter');
  await closePopup(page);
}

// ─── Text editing ─────────────────────────────────────────────────────

/** Is a text editor (contenteditable) mounted in the sandbox? */
export async function isTextEditing(editor: Editor): Promise<boolean> {
  return (await editor.sandbox().locator('[contenteditable="true"]').count()) > 0;
}

/** Double-click a text node on a tile and wait for the inline editor (throws when it never mounts). */
export async function startTextEdit(editor: Editor, vpId: string, id: string): Promise<void> {
  const b = await editor.nodeBoxIn(vpId, id);
  const page = editor.page();
  // Two SPACED clicks, not mouse.dblclick: Playwright fires the pair <50ms
  // apart and the controller's duplicate-event guard drops the second.
  await page.waitForTimeout(450);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(120);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect_(() => isTextEditing(editor), 8_000);
  if (!(await isTextEditing(editor))) throw new Error(`text editor never mounted on ${vpId}:${id}`);
  // Visible ≠ focused: TipTap takes a frame to place the caret.
  await page.waitForTimeout(250);
}

/** Click empty canvas (commits an open text edit). */
export async function clickAway(editor: Editor, at: Pt = { x: 900, y: 860 }): Promise<void> {
  await editor.page().mouse.click(at.x, at.y);
  await editor.settled();
  await expect_(async () => !(await isTextEditing(editor)), 5_000);
  await editor.settled();
}

async function expect_(cond: () => Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await cond()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 60));
}

// ─── Drag gestures (the D6 technique, copied: that lane is still in flight) ──

export const center = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Linear glide between two points, one rAF per move. */
export async function glide(page: Page, a: Pt, b: Pt, steps = 10): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { steps: 1 });
    await rafs(page);
  }
}

/** ±1px wiggle so entry/exit hysteresis counters tick. */
export async function pump(page: Page, at: Pt, frames = 8): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.mouse.move(at.x + (i % 2 ? 1 : 0), at.y + (i % 2 ? 0 : 1), { steps: 1 });
    await rafs(page);
  }
}

/** Press at `from`, glide through every waypoint (pumping at each), run
 *  `atWaypoint(i)` with the button down, release (unless `release: false`). */
export async function gesture(
  editor: Editor, from: Pt, waypoints: Pt[],
  opts: { steps?: number; pumpFrames?: number; atWaypoint?: (i: number, p: Pt) => Promise<void>; release?: boolean; modifiers?: string[] } = {},
): Promise<void> {
  const page = editor.page();
  await page.mouse.move(from.x, from.y);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
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
      for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
      await editor.settled();
    }
  }
}

/** Real click on a node (on a tile) that starts the tile's rect stream and
 *  selects it, then waits out the double-click window. */
export async function prime(editor: Editor, id: string, vpId?: string, fx = 0.5, fy = 0.5): Promise<void> {
  const b = vpId ? await editor.nodeBoxIn(vpId, id) : await editor.nodeBox(id);
  await editor.page().mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  await editor.page().waitForTimeout(650);
}

/** Ids in reading order by their painted boxes on one tile (missing/hidden dropped). */
export async function visualOrderIn(editor: Editor, vpId: string, ids: string[]): Promise<string[]> {
  const m: Array<{ id: string; x: number; y: number }> = [];
  for (const id of ids) {
    const b = await boxIn(editor, vpId, id);
    if (b && b.width > 0 && b.height > 0) m.push({ id, x: b.x, y: b.y });
  }
  m.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x));
  return m.map(e => e.id);
}

/** Computed display of a node on a tile ('' when the element is missing). */
export async function displayIn(editor: Editor, vpId: string, id: string): Promise<string> {
  return computedIn(editor, vpId, id, 'display');
}

/** How many times `data-id="id"` appears in a file. */
export function idCount(code: string, id: string): number {
  return (code.match(new RegExp(`data-id="${id.replace(/[-]/g, '\\-')}"`, 'g')) ?? []).length;
}

// ─── Position panel ───────────────────────────────────────────────────

/** A pin toggle (T/L/R/B) in the Position tool. */
export function pinButton(page: Page, side: 'T' | 'L' | 'R' | 'B'): Locator {
  return panel(page).locator('div.grid-rows-3 > button').filter({ hasText: new RegExp(`^${side}$`) }).first();
}

export async function pinActive(page: Page, side: 'T' | 'L' | 'R' | 'B'): Promise<boolean> {
  return pinButton(page, side).evaluate(el => el.className.includes('bg-[var(--accent)] text-[var(--accent-fg)]'));
}

/** The pin fields in DOM order: top, left, right, bottom. */
export function pinField(page: Page, side: 'top' | 'left' | 'right' | 'bottom'): Locator {
  const idx = { top: 1, left: 2, right: 3, bottom: 4 }[side];
  return panel(page).locator('select:has(option[value="sticky"])').first().locator(`xpath=following::input[${idx}]`);
}

// ─── Layers panel ─────────────────────────────────────────────────────

export function layerRow(page: Page, layerId: string): Locator {
  return page.locator(`[data-layer-id="${layerId}"]`).first();
}

/** Expand a collapsed variant header (`__vp_<vpId>`) in Layers. */
export async function expandLayerVariant(page: Page, vpId: string, firstChild: string): Promise<void> {
  if (await page.locator(`[data-layer-id="${vpId}:${firstChild}"]`).count()) return;
  await layerRow(page, `__vp_${vpId}`).locator('button, svg').first().click();
  await page.locator(`[data-layer-id="${vpId}:${firstChild}"]`).first().waitFor({ timeout: 5_000 });
}

/** Mouse-drag a layer row onto another row: `before`/`after` = its top/bottom
 *  quarter, `inside` = its middle. */
export async function layersDrag(editor: Editor, from: string, to: string, where: 'before' | 'after' | 'inside'): Promise<void> {
  const page = editor.page();
  const a = (await layerRow(page, from).boundingBox())!;
  const b = (await layerRow(page, to).boundingBox())!;
  const fy = where === 'before' ? 0.15 : where === 'after' ? 0.85 : 0.5;
  const start = { x: a.x + a.width * 0.5, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width * 0.5, y: b.y + b.height * fy };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await glide(page, start, { x: start.x, y: start.y + (end.y > start.y ? 8 : -8) }, 4);
  await glide(page, { x: start.x, y: start.y + (end.y > start.y ? 8 : -8) }, end, 12);
  await pump(page, end, 6);
  await page.mouse.up();
  await editor.settled();
}
