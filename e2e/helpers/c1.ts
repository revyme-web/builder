// C1 lane helpers: Make Component (E2E_TEST_PLAN.md §8, CMP-001..038).
//
// The Make Component UI flow as real input, reusable by other component batches:
//
//   import { makeComponentViaMenu, makeComponentViaShortcut } from '../../helpers/c1';
//   const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card');
//   made.file      // 'components/<Pascal>.tsx'
//   made.tag       // '<Pascal>' (the JSX tag on the page)
//
// Plus what the flow needs around it: the context menu (items + separators),
// the "Name Component" modal, the master breadcrumb, trace lookups, a CDP key
// dispatch for macOS-style Option shortcuts (Option turns K into "˚"), the
// preview frame, Babel source facts, and the seeds (MAKE_COMPONENT_PAGE,
// MAKE_COMPONENT_3VP, masters with connections / variables / events, CMS,
// forms, overlays, slots). `fullCanvasHeader` gives single-tile pages the
// isPrimary flag the shared `canvasHeader` leaves out.

import type { FrameLocator, Locator, Page } from '@playwright/test';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import type { Editor } from './editor';

// ─── Context menu ────────────────────────────────────────────────────

/** Real right-click on a node: left-click selects it first (the menu acts on
 *  the selection), then a right-click at the same point opens the menu.
 *  `at` = fraction of the node box to click (default centre). */
export async function rightClickNode(
  editor: Editor,
  id: string,
  opts: { vpId?: string; at?: [number, number] } = {},
): Promise<void> {
  const page = editor.page();
  // A right-press selects the top-level hit itself (the menu then acts on the
  // selection). No left click first: two presses inside 400ms read as a
  // double-click and drill into a child.
  const [fx, fy] = opts.at ?? [0.5, 0.5];
  const p = await editor.at(id, fx, fy, opts.vpId);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await contextMenu(page).waitFor({ state: 'visible' });
  await editor.settled();
}

/** The open canvas context menu (portal to body, the only z-[1000001] layer). */
export function contextMenu(page: Page): Locator {
  // The menu has no role; it is the fixed z-[1000001] panel that always lists "Duplicate".
  return page.locator('div[class*="z-[1000001]"]', { has: page.getByRole('button', { name: /^Duplicate/ }) });
}

/** A context-menu item by its label (the shortcut hint is part of the button text). */
export function menuItem(page: Page, label: string): Locator {
  return contextMenu(page).getByRole('button', { name: new RegExp(`^${escapeRe(label)}(?:\\s|$|[A-Z][a-z]*\\+)`) });
}

/** Labels of every top-level menu item currently shown, in order. */
export async function menuLabels(page: Page): Promise<string[]> {
  return (await menuStructure(page)).filter(x => x !== '—');
}

/** The menu's direct rows in order: an item's label, or '—' for a separator
 *  (submenus count as their label). Reveals an orphaned leading separator. */
export async function menuStructure(page: Page): Promise<string[]> {
  return contextMenu(page).evaluate((menu) => {
    const out: string[] = [];
    for (const el of Array.from(menu.children) as HTMLElement[]) {
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.tagName === 'BUTTON') { out.push(el.querySelector('span.flex-1')?.textContent?.trim() ?? ''); continue; }
      if (el.classList.contains('h-px')) { out.push('—'); continue; }
      const b = el.querySelector(':scope > button span.flex-1');
      if (b) out.push(b.textContent?.trim() ?? '');
    }
    return out;
  });
}

/** Close the context menu with Escape. */
export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await contextMenu(page).waitFor({ state: 'hidden' });
}

// ─── Name Component modal ────────────────────────────────────────────

export function nameModal(page: Page, title = 'Name Component'): {
  root: Locator; heading: Locator; input: Locator; submit: Locator;
} {
  const heading = page.getByRole('heading', { name: title, exact: true });
  const root = page.locator('div.relative.w-64', { has: heading });
  return {
    root,
    heading,
    input: root.getByRole('textbox'),
    submit: root.getByRole('button', { name: title === 'Name Component' ? 'Create Component' : /^Create/ }),
  };
}

/** Type a name into the open modal (replacing the pre-fill) and submit. */
export async function submitName(page: Page, name: string, via: 'click' | 'enter' = 'click'): Promise<void> {
  const m = nameModal(page);
  await m.input.waitFor({ state: 'visible' });
  await m.input.fill(name);
  if (via === 'enter') await m.input.press('Enter');
  else await m.submit.click();
}

// ─── The whole flow ──────────────────────────────────────────────────

export interface MadeComponent {
  /** `components/<Pascal>.tsx` */
  file: string;
  /** The PascalCase identifier (also the JSX tag on the page). */
  tag: string;
  /** The page file the node was on. */
  pageFile: string;
  /** Page source right before the gesture. */
  pageBefore: string;
}

/** Right-click → "Make Component" → type the name → Create Component.
 *  Waits until the new master file exists AND the editor entered it. */
export async function makeComponentViaMenu(
  editor: Editor,
  id: string,
  name: string,
  opts: { vpId?: string; at?: [number, number]; submit?: 'click' | 'enter' } = {},
): Promise<MadeComponent> {
  const page = editor.page();
  const pageFile = await editor.activeFile();
  const pageBefore = await editor.code(pageFile);
  const filesBefore = new Set(await editor.listFiles());
  await rightClickNode(editor, id, { vpId: opts.vpId, at: opts.at });
  // The right-press selects the deepest hit: aim at a point only `id` covers.
  const sel = await editor.selection();
  if (sel.length !== 1 || sel[0] !== id) throw new Error(`right-click selected ${JSON.stringify(sel)}, not "${id}" — aim with opts.at at a spot no child covers`);
  await menuItem(page, 'Make Component').click();
  await submitName(page, name, opts.submit ?? 'click');
  return waitForNewComponent(editor, filesBefore, pageFile, pageBefore);
}

/** Select by real click → Ctrl+Alt+K (or the macOS Option dispatch) →
 *  modal → type the name (or keep the pre-fill when `name` is null) → Enter. */
export async function makeComponentViaShortcut(
  editor: Editor,
  id: string,
  name: string | null,
  opts: { vpId?: string; mac?: boolean; at?: [number, number] } = {},
): Promise<MadeComponent> {
  const page = editor.page();
  const pageFile = await editor.activeFile();
  const pageBefore = await editor.code(pageFile);
  const filesBefore = new Set(await editor.listFiles());
  const sel = await editor.selection();
  if (sel.length !== 1 || sel[0] !== id) {
    // A second click on a selected frame drills into its child — only click when needed.
    const p = await editor.at(id, ...(opts.at ?? [0.5, 0.5]), opts.vpId);
    await page.mouse.click(p.x, p.y);
    await editor.settled();
    const now = await editor.selection();
    if (now.length !== 1 || now[0] !== id) throw new Error(`click selected ${JSON.stringify(now)}, not "${id}"`);
  }
  await pressMakeComponentShortcut(page, opts.mac ? 'mac' : 'ctrl');
  const m = nameModal(page);
  await m.input.waitFor({ state: 'visible' });
  if (name !== null) await m.input.fill(name);
  await m.input.press('Enter');
  return waitForNewComponent(editor, filesBefore, pageFile, pageBefore);
}

/** Ctrl+Alt+K. `mac`: a trusted CDP keydown the way macOS sends Cmd+Option+K —
 *  `code: 'KeyK'` with the Option-composed `key: '˚'`. */
export async function pressMakeComponentShortcut(page: Page, style: 'ctrl' | 'mac' = 'ctrl'): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  if (style === 'ctrl') {
    await page.keyboard.press('Control+Alt+k');
    return;
  }
  await pressComposed(page, { key: '˚', code: 'KeyK', keyCode: 75, meta: true, alt: true });
}

/** A trusted keydown/keyup with a key that differs from its physical code
 *  (macOS Option composition, non-Latin layouts). */
export async function pressComposed(
  page: Page,
  k: { key: string; code: string; keyCode: number; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const modifiers = (k.alt ? 1 : 0) | (k.ctrl ? 2 : 0) | (k.meta ? 4 : 0) | (k.shift ? 8 : 0);
  const base = { modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await cdp.detach();
}

/** The one new `components/*.tsx` file since `filesBefore`, once the editor
 *  is inside it. */
export async function waitForNewComponent(
  editor: Editor,
  filesBefore: Set<string>,
  pageFile: string,
  pageBefore: string,
  timeout = 15_000,
): Promise<MadeComponent> {
  const page = editor.page();
  const deadline = Date.now() + timeout;
  let file: string | undefined;
  while (Date.now() < deadline) {
    const added = (await editor.listFiles()).filter(f => !filesBefore.has(f) && /^components\/[^/]+\.tsx$/.test(f));
    if (added.length === 1 && (await editor.activeFile()) === added[0]) { file = added[0]; break; }
    await page.waitForTimeout(100);
  }
  if (!file) throw new Error(`Make Component wrote no new components/*.tsx (or the editor did not enter it); active=${await editor.activeFile()}`);
  await editor.settled();
  const tag = file.replace(/^components\//, '').replace(/\.tsx$/, '');
  return { file, tag, pageFile, pageBefore };
}

/** New components/*.tsx files since a listFiles() snapshot. */
export async function newComponentFiles(editor: Editor, before: string[]): Promise<string[]> {
  const set = new Set(before);
  return (await editor.listFiles()).filter(f => !set.has(f) && /^components\/[^/]+\.tsx$/.test(f));
}

// ─── Master reads ────────────────────────────────────────────────────

/** Breadcrumb segment labels in the top bar (empty when not in a master). */
export async function breadcrumb(page: Page): Promise<string[]> {
  const bar = page.locator('[data-dynamic-toolbar="true"]');
  if (!(await bar.count())) return [];
  return bar.locator('button span.truncate').allInnerTexts();
}

/** A breadcrumb segment button by label. */
export function breadcrumbSegment(page: Page, label: string): Locator {
  return page.locator('[data-dynamic-toolbar="true"] button', { has: page.locator('span.truncate', { hasText: label }) }).first();
}

/** Trace entries (category matched by regex). */
export async function traces(page: Page, pattern: string): Promise<Array<{ c: string; data: any }>> {
  return page.evaluate(p => (window as any).__e2e.traceEntries(p), pattern);
}

/** Does `code` parse as TSX? (Babel, error recovery OFF). */
export async function parses(code: string): Promise<boolean> {
  const { parse } = await import('@babel/parser');
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    return true;
  } catch {
    return false;
  }
}

/** The `@name "<…>"` annotation (raw, escapes kept). */
export function annotatedName(code: string): string | null {
  return /\/\*\*?\s*@name\s+"((?:[^"\\]|\\.)*)"\s*\*\//.exec(code)?.[1] ?? null;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Seeds ───────────────────────────────────────────────────────────

export interface C1Tile { id: string; label: string; width: number }
export const C1_TILES: Record<'one' | 'three', C1Tile[]> = {
  one: [{ id: 'desktop', label: 'Desktop', width: 1440 }],
  three: [
    { id: 'desktop', label: 'Desktop', width: 1440 },
    { id: 'tablet', label: 'Tablet', width: 768 },
    { id: 'mobile', label: 'Mobile', width: 375 },
  ],
};

/** The FULL `@canvas` shape, single tile included. The shared `canvasHeader`
 *  writes a bare `{id,width}` for one tile, which has no `isPrimary` — the
 *  editor then reads the desktop tile as a REPLICA and hides every
 *  primary-only action (Make Component among them). */
export function fullCanvasHeader(tiles: C1Tile[] = C1_TILES.one): string {
  const GAP = 120;
  let x = 0;
  const positions: Record<string, { x: number; y: number }> = {};
  const viewports = tiles.map((t, i) => {
    positions[t.id] = { x, y: 0 };
    x += t.width + GAP;
    return { id: t.id, label: t.label, width: t.width, isPrimary: i === 0, order: i };
  });
  return `/** @canvas ${JSON.stringify({ viewports, positions })} */`;
}

export const SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A complete `page.client.tsx`: 'use client' first, the full @canvas block,
 *  imports, module-level consts, hook lines inside Page, the root JSX and an
 *  optional `const canvasNodes = (<>…</>)` block. */
export function c1Page(rootJsx: string, opts: {
  tiles?: C1Tile[]; imports?: string[]; preamble?: string; hooks?: string[]; canvasNodes?: string;
} = {}): string {
  const imports = ['import React from \'react\';', ...(opts.imports ?? [])].join('\n');
  const hooks = (opts.hooks ?? []).map(h => `  ${h}\n`).join('');
  const canvasNodes = opts.canvasNodes ? `const canvasNodes = (<>\n${opts.canvasNodes.trim()}\n</>);\n` : '';
  return `'use client';

${fullCanvasHeader(opts.tiles)}

${imports}
${opts.preamble ? `\n${opts.preamble.trim()}\n` : ''}
export default function Page() {
${hooks}  return (
${rootJsx.trim()}
  );
}
${canvasNodes}`;
}

const IMG_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjNGE3Ii8+PC9zdmc+';

/** The card frame (heading, text, image in a flex column). `extra` lands in
 *  the card's own style object. */
export function cardJsx(extra = '', id = 'card', name = 'Card'): string {
  return `<div data-id="${id}" data-name="${name}" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', padding: '24px', backgroundColor: '#1a1a3a', borderRadius: '16px'${extra ? `, ${extra}` : ''} }}>
        <h2 data-id="${id}-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', color: '#ffffff', margin: '0px' }}>Pro plan</h2>
        <p data-id="${id}-body" data-name="Body" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: '#cccccc', margin: '0px' }}>Everything in Basic, plus more.</p>
        <div data-id="${id}-img" data-name="Image" style={{ position: 'relative', flex: '0 0 auto', order: '2', width: '100%', height: '120px', backgroundImage: 'url(${IMG_URI})', backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />
      </div>`;
}

const ROOT_OPEN = `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '40px', padding: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>`;

/** The MAKE_COMPONENT_PAGE body: card, hug pill in a centred row, a 2-column
 *  grid (no-width cell + 100%×100% cell), a fill child in a row, a bare text. */
export const MAKE_COMPONENT_BODY = `${ROOT_OPEN}
      ${cardJsx()}
      <div data-id="cta-row" data-name="CTA Row" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '100%', height: '80px', backgroundColor: '#14142a' }}>
        <div data-id="pill" data-name="Pill" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'row', alignItems: 'center', padding: '12px 24px', borderRadius: '999px', backgroundColor: '#ff2d75' }}>
          <p data-id="pill-label" data-name="Pill Label" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>Find an advisor</p>
        </div>
      </div>
      <div data-id="grid" data-name="Grid" style={{ position: 'relative', flex: '0 0 auto', order: '2', display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '120px', gap: '20px', width: '800px' }}>
        <div data-id="cell-a" data-name="Cell A" style={{ position: 'relative', order: '0', height: '100px', backgroundColor: '#2a2a4a' }} />
        <div data-id="cell-b" data-name="Cell B" style={{ position: 'relative', order: '1', width: '100%', height: '100%', backgroundColor: '#3a3a5a' }} />
      </div>
      <div data-id="row" data-name="Row" style={{ position: 'relative', flex: '0 0 auto', order: '3', display: 'flex', flexDirection: 'row', gap: '20px', width: '800px', height: '80px' }}>
        <div data-id="fixed" data-name="Fixed" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '200px', height: '80px', backgroundColor: '#444466' }} />
        <div data-id="fill" data-name="Fill" style={{ position: 'relative', flex: '1 0 0px', order: '1', height: '80px', backgroundColor: '#5555aa' }} />
      </div>
      <p data-id="label" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '4', marginTop: '8px', fontSize: '20px', color: '#ffffff' }}>Bare label</p>
    </div>`;

export const MAKE_COMPONENT_CANVAS_NODES = `
  <div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '100px', width: '160px', height: '120px', backgroundColor: '#ff66cc' }} />`;

export function makeComponentPage(opts: { body?: string; tiles?: C1Tile[]; canvasNodes?: string | null; preamble?: string; imports?: string[]; hooks?: string[]; extraFiles?: Record<string, string> } = {}) {
  const files: Record<string, string> = {
    'app/page.tsx': SERVER_WRAPPER,
    'app/page.client.tsx': c1Page(opts.body ?? MAKE_COMPONENT_BODY, {
      tiles: opts.tiles,
      canvasNodes: opts.canvasNodes === null ? undefined : (opts.canvasNodes ?? MAKE_COMPONENT_CANVAS_NODES),
      preamble: opts.preamble, imports: opts.imports, hooks: opts.hooks,
    }),
    ...(opts.extraFiles ?? {}),
  };
  return { format: 'revyme-v1' as const, files };
}

/** MAKE_COMPONENT_PAGE: the one-tile page every Make Component row starts from. */
export const MAKE_COMPONENT_PAGE = makeComponentPage();

// ─── Known product noise ─────────────────────────────────────────────

/** Entering a master logs two React console.errors from the properties panel:
 *  `ControlLabel` returns early (`if (unifiedCtx?.hideLabel …) return null`,
 *  `if (plain) …`) BEFORE its `useControl()`/`useAtomValue` hooks, so the hook
 *  order changes when the selection lands on a row that flips `plain`
 *  (src/editor/controls/ControlLabel.tsx). Not a Make Component behavior, but
 *  every test that enters a master hits it — allow exactly those two. */
export function allowMasterEntryNoise(editor: Editor): void {
  editor.allowErrors(/change in the order of Hooks[\s\S]*ControlLabel/);
  editor.allowErrors(/Expected static flag was missing/);
}

// ─── Source helpers (Babel) ──────────────────────────────────────────

type AnyNode = { type: string; start?: number | null; end?: number | null; [k: string]: unknown };

function walk(n: unknown, fn: (node: AnyNode) => void): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walk(c, fn); return; }
  const node = n as AnyNode;
  if (typeof node.type === 'string') fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walk(node[k], fn);
  }
}

/** Facts about the element carrying `data-id="<id>"` (first occurrence). */
export async function elementFacts(code: string, id: string): Promise<null | {
  tag: string; attrs: string[]; styleKeys: string[]; styleLastIsSpread: string | null; source: string;
}> {
  const { parse } = await import('@babel/parser');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });
  let found: AnyNode | null = null;
  walk(ast, (node) => {
    if (found || node.type !== 'JSXOpeningElement') return;
    for (const a of (node.attributes as AnyNode[]) ?? []) {
      if (a.type === 'JSXAttribute' && (a.name as AnyNode)?.name === 'data-id' && (a.value as AnyNode)?.type === 'StringLiteral' && (a.value as any).value === id) found = node;
    }
  });
  if (!found) return null;
  const op = found as AnyNode;
  const nameOf = (n: AnyNode): string => n.type === 'JSXIdentifier' ? String(n.name) : n.type === 'JSXMemberExpression' ? `${nameOf(n.object as AnyNode)}.${nameOf(n.property as AnyNode)}` : '?';
  const attrs: string[] = [];
  let styleKeys: string[] = [];
  let styleLastIsSpread: string | null = null;
  for (const a of (op.attributes as AnyNode[]) ?? []) {
    if (a.type === 'JSXSpreadAttribute') { attrs.push(`...${code.slice((a.argument as AnyNode).start!, (a.argument as AnyNode).end!)}`); continue; }
    const name = String((a.name as AnyNode).name);
    attrs.push(name);
    if (name === 'style') {
      const expr = ((a.value as AnyNode)?.expression ?? null) as AnyNode | null;
      if (expr?.type === 'ObjectExpression') {
        const props = expr.properties as AnyNode[];
        styleKeys = props.map(p => p.type === 'SpreadElement' ? `...${code.slice((p.argument as AnyNode).start!, (p.argument as AnyNode).end!)}` : String(((p.key as AnyNode).name ?? (p.key as any).value)));
        const last = props[props.length - 1];
        styleLastIsSpread = last?.type === 'SpreadElement' ? code.slice((last.argument as AnyNode).start!, (last.argument as AnyNode).end!) : null;
      }
    }
  }
  return { tag: nameOf(op.name as AnyNode), attrs, styleKeys, styleLastIsSpread, source: code.slice(op.start!, op.end!) };
}

/** The import a page carries for a master (`import X from '@/components/X'`). */
export function hasDefaultImport(code: string, tag: string): boolean {
  return new RegExp(`^import\\s+${tag}\\s+from\\s+['"]@/components/${tag}['"];?\\s*$`, 'm').test(code);
}

/** How many times `re` matches in `code`. */
export function count(code: string, re: RegExp): number {
  return (code.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
}

/** Wait until the editor is on `path` and settled. */
export async function waitForActiveFile(editor: Editor, path: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await editor.activeFile()) === path) { await editor.settled(); return; }
    await editor.page().waitForTimeout(100);
  }
  throw new Error(`active file never became ${path} (is ${await editor.activeFile()})`);
}

/** Back to the page through the breadcrumb's first segment (real click). */
export async function exitToPage(editor: Editor, pageFile = 'app/page.client.tsx', label = 'Home'): Promise<void> {
  await breadcrumbSegment(editor.page(), label).click();
  await waitForActiveFile(editor, pageFile);
  // The camera restore + re-render land a frame or two after the switch.
  await editor.page().waitForTimeout(300);
  await editor.settled();
}

/** Box of a node with a bounded wait (null when it never renders). */
export async function boxOrNull(editor: Editor, id: string, vpId?: string, timeout = 3_000) {
  const loc = vpId ? await editor.nodeIn(vpId, id) : editor.node(id);
  return loc.boundingBox({ timeout }).catch(() => null);
}

/** Per-tile overrides for the 3-tile page: tablet padding + gap on the card,
 *  a mobile-only order on the card and a mobile-only rotate on its title. */
export const MAKE_COMPONENT_3VP_STYLE = `<style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="card"] { padding: 12px !important; gap: 4px !important; }
    }
    @media (max-width: 375px) {
      [data-id="card"] { order: 10 !important; }
      [data-id="card-title"] { transform: rotate(6deg) !important; }
    }
  \`}</style>`;

/** MAKE_COMPONENT_3VP: the same page on Desktop / Tablet / Mobile tiles. */
export const MAKE_COMPONENT_3VP = makeComponentPage({
  tiles: C1_TILES.three,
  body: MAKE_COMPONENT_BODY.replace(ROOT_OPEN, `${ROOT_OPEN}\n      ${MAKE_COMPONENT_3VP_STYLE}`),
});

/** 3-tile page for the placement rows: the card has an authored auto height
 *  (`min-content`), tablet padding + a child font-size, a mobile-only order,
 *  and an unrelated rule on the CTA row that must survive. */
export const MAKE_COMPONENT_3VP_PLACEMENT_STYLE = `<style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="card"] { padding: 12px !important; }
      [data-id="card-body"] { font-size: 13px !important; }
      [data-id="cta-row"] { height: 60px !important; }
    }
    @media (max-width: 375px) {
      [data-id="card"] { order: 10 !important; }
    }
  \`}</style>`;

export const MAKE_COMPONENT_3VP_PLACEMENT = makeComponentPage({
  tiles: C1_TILES.three,
  body: MAKE_COMPONENT_BODY
    .replace(ROOT_OPEN, `${ROOT_OPEN}\n      ${MAKE_COMPONENT_3VP_PLACEMENT_STYLE}`)
    .replace(cardJsx(), cardJsx("height: 'min-content'")),
});

/** A design master `components/Badge.tsx` (single variant, forwards ...rest). */
export const BADGE_MASTER = `'use client';

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Badge" */

const variantConfig = [
  { name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true },
];

function Badge({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="badge-root" {...rest} data-name="Badge" style={{ position: 'absolute', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', width: '200px', height: '60px', padding: '12px', backgroundColor: '#22aa66', borderRadius: '12px', ...style }}>
        <motion.p layout={true} data-id="badge-text" data-name="Badge Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>New</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Badge);
`;

/** Two fixed-size chips side by side in a row (multi-selection rows). */
export function chipJsx(id: string, text: string, order: number, color: string): string {
  return `<div data-id="${id}" data-name="${text}" style={{ position: 'relative', flex: '0 0 auto', order: '${order}', display: 'flex', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '160px', height: '80px', borderRadius: '12px', backgroundColor: '${color}' }}>
        <p data-id="${id}-text" data-name="${text} Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>${text}</p>
      </div>`;
}

export const CHIPS_PAGE = makeComponentPage({
  canvasNodes: null,
  body: `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '24px', padding: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
      ${chipJsx('chip-a', 'Alpha', 0, '#3355cc')}
      ${chipJsx('chip-b', 'Beta', 1, '#cc3355')}
    </div>`,
});

// ─── Preview (:5175) ─────────────────────────────────────────────────

/** Open the header Preview and return its frame once `waitText` painted. */
export async function openPreview(page: Page, waitText: string): Promise<FrameLocator> {
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.getByText(waitText, { exact: true }).first().waitFor({ timeout: 45_000 });
  return frame;
}

/** Bounding rect + a few computed styles of `[data-id=<id>]` in the preview. */
export async function previewFacts(frame: FrameLocator, id: string, nth = 0) {
  return frame.locator(`[data-id="${id}"]`).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, width: r.width, height: r.height, position: cs.position, lineHeight: cs.lineHeight, fontSize: cs.fontSize };
  });
}

/** The preview (:5175) logs React's "unique key" warning for `Page` on every
 *  page this suite opened (no list in the page source at all) — allow exactly that. */
export function allowPreviewNoise(editor: Editor): void {
  editor.allowErrors(/Each child in a list should have a unique "key" prop[\s\S]*render method of `Page`/);
}

// ─── Code-carry seeds (CMP-018 … 036) ────────────────────────────────

/** The page body with `extra` JSX inserted before the bare label. */
export function bodyWith(extra: string, body = MAKE_COMPONENT_BODY): string {
  return body.replace(`<p data-id="label"`, `${extra.trim()}\n      <p data-id="label"`);
}

/** CMP-018: an Overlay border (`::after`) on a card child, a `:hover` on
 *  another, and an unrelated rule for a node that stays on the page. */
export const STYLE_RULES_PAGE = makeComponentPage({
  canvasNodes: null,
  body: MAKE_COMPONENT_BODY.replace(ROOT_OPEN, `${ROOT_OPEN}
      <style>{\`
    [data-id="card-img"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-width: 4px;
  border-style: solid;
  border-color: #384bf6;
  pointer-events: none;
    }
    [data-id="card-title"]:hover {
  opacity: 0.5;
    }
    [data-id="cta-row"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-width: 2px;
  border-style: solid;
  border-color: #ff0000;
  pointer-events: none;
    }
  \`}</style>`),
});

/** CMP-022: a variants const only the card uses, and one shared with a node that stays. */
export const VARIANT_CONSTS_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import { motion } from 'framer-motion';"],
  preamble: `const titleVariants = { default: { opacity: 1 }, 'variant-1': { opacity: 0.4 } };
const sharedVariants = { default: { scale: 1 }, 'variant-1': { scale: 1.1 } };`,
  body: MAKE_COMPONENT_BODY
    .replace(`<h2 data-id="card-title" data-name="Title" style={{ position: 'relative',`, `<motion.h2 data-id="card-title" data-name="Title" variants={titleVariants} initial="default" animate="default" style={{ position: 'relative', opacity: 1,`)
    .replace(`>Pro plan</h2>`, `>Pro plan</motion.h2>`)
    .replace(`<p data-id="card-body" data-name="Body" style=`, `<motion.p data-id="card-body" data-name="Body" variants={sharedVariants} initial="default" animate="default" style=`)
    .replace(`>Everything in Basic, plus more.</p>`, `>Everything in Basic, plus more.</motion.p>`)
    .replace(`<p data-id="pill-label" data-name="Pill Label" style=`, `<motion.p data-id="pill-label" data-name="Pill Label" variants={sharedVariants} initial="default" animate="default" style=`)
    .replace(`>Find an advisor</p>`, `>Find an advisor</motion.p>`),
});

/** CMP-034: a frame holding a next/link `<Link>` child, and the page it targets. */
export const LINK_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import Link from 'next/link';"],
  body: bodyWith(`<div data-id="nav" data-name="Nav" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'row', gap: '16px', padding: '16px', backgroundColor: '#223344' }}>
        <Link href="/about" data-id="nav-about" data-name="About Link" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', padding: '8px 12px', color: '#ffffff', backgroundColor: '#445566' }}>About us</Link>
      </div>`),
  extraFiles: {
    'app/about/page.tsx': SERVER_WRAPPER,
    'app/about/page.client.tsx': c1Page(`<div data-id="about-root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', minHeight: '600px', padding: '40px', backgroundColor: '#ffffff' }}>
      <h1 data-id="about-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#111111', margin: '0px' }}>About Us</h1>
    </div>`),
  },
});

/** CMP-035: a glided frame holding a glided container. */
export const GLIDE_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import { motion, LayoutGroup } from 'framer-motion';"],
  body: bodyWith(`<motion.div layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} data-glide='{"transition":{"type":"spring","duration":"0.5","bounce":"0.25","delay":"0"}}' data-id="glide-box" data-name="Glide Box" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'row', gap: '12px', width: '420px', height: '160px', padding: '12px', backgroundColor: '#ffffba' }}><LayoutGroup>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0', flex: '0 0 auto' }}><motion.div layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} data-glide='{"transition":{"type":"spring","duration":"0.5","bounce":"0.25","delay":"0"}}' data-id="glide-inner" data-name="Glide Inner" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '8px', width: '180px', height: '120px', backgroundColor: '#baffc9' }}><LayoutGroup>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0', flex: '0 0 auto' }}><div data-id="glide-leaf" data-name="Leaf" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '60px', height: '40px', backgroundColor: '#bae1ff' }} /></motion.div>
  </LayoutGroup></motion.div></motion.div>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '1', flex: '0 0 auto' }}><div data-id="glide-side" data-name="Side" style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '120px', height: '120px', backgroundColor: '#ffb3ba' }} /></motion.div>
  </LayoutGroup></motion.div>`),
});

/** CMS data with inline images (no network). */
const CMS_IMG = (c: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${c}"/></svg>`).toString('base64')}`;
export const C1_TEAM_SCHEMA = JSON.stringify({ name: 'Team Members', slug: 'team', fields: [
  { id: 'name', name: 'Name', type: 'text', required: true },
  { id: 'role', name: 'Role', type: 'text' },
  { id: 'photo', name: 'Photo', type: 'image' },
] });
export const C1_TEAM_DATA = JSON.stringify([
  { _id: 'alice', _slug: 'alice', _status: 'published', name: 'Alice Johnson', role: 'CEO', photo: CMS_IMG('#e06666') },
  { _id: 'bob', _slug: 'bob', _status: 'published', name: 'Bob Smith', role: 'CTO', photo: CMS_IMG('#6fa8dc') },
  { _id: 'carol', _slug: 'carol', _status: 'published', name: 'Carol Davis', role: 'Design Lead', photo: CMS_IMG('#93c47d') },
]);
export const C1_BLOG_SCHEMA = JSON.stringify({ name: 'Blog Posts', slug: 'blog', fields: [
  { id: 'title', name: 'Title', type: 'text', required: true },
  { id: 'excerpt', name: 'Excerpt', type: 'text' },
] });
export const C1_BLOG_DATA = JSON.stringify([
  { _id: 'p1', _slug: 'launching-v2', _status: 'published', title: 'Launching v2.0', excerpt: 'Our biggest release yet.' },
  { _id: 'p2', _slug: 'design-system', _status: 'published', title: 'Building a Design System', excerpt: 'From scratch.' },
  { _id: 'p3', _slug: 'hiring', _status: 'published', title: 'We are hiring', excerpt: 'Join us.' },
]);
export const C1_CMS_FILES: Record<string, string> = {
  'cms/team.schema.json': C1_TEAM_SCHEMA, 'cms/team.json': C1_TEAM_DATA,
  'cms/blog.schema.json': C1_BLOG_SCHEMA, 'cms/blog.json': C1_BLOG_DATA,
};

/** CMP-025: a frame holding a component instance, a CMS list and a MotionLink. */
export const IMPORTS_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: [
    "import Link from 'next/link';",
    "import { motion } from 'framer-motion';",
    "import Badge from '@/components/Badge';",
    "import team from '@/cms/team.json';",
  ],
  preamble: 'const MotionLink = motion.create(Link);',
  body: bodyWith(`<div data-id="bundle" data-name="Bundle" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'column', gap: '12px', width: '360px', padding: '16px', backgroundColor: '#202040' }}>
        <Badge data-id="bundle-badge" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
        <div data-id="team-list" data-name="Team List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
          {team.map((item, idx) => (
            <div data-id="team-row" data-name="Team Row" key={idx} style={{ position: 'relative', flex: '0 0 auto', display: 'flex', width: '100%', height: '32px', backgroundColor: '#333366' }}>
              <p data-id="team-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#ffffff', margin: '0px' }}>{item.name}</p>
            </div>
          ))}
        </div>
        <MotionLink layout={true} href="/about" data-id="bundle-link" data-name="About Link" style={{ position: 'relative', flex: '0 0 auto', order: '2', display: 'flex', padding: '8px 12px', color: '#ffffff', backgroundColor: '#445566' }}>About us</MotionLink>
      </div>`),
  extraFiles: { 'components/Badge.tsx': BADGE_MASTER, ...C1_CMS_FILES },
});

// ─── Masters for the "inside a master" rows (CMP-020 / 021 / 023 / 024) ──

const MASTER_HEAD = (name: string, extraImports = '') => `'use client';

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
${extraImports}
/** @name "${name}" */
`;

/** A 2-variant Header (Closed / Open): a logo group whose dot rides the
 *  variants, and a hamburger. Connections are added at test time through the
 *  product's own writer (`__e2e.addConnection`), so the toggle code is real. */
export const HEADER_MASTER = `${MASTER_HEAD('Header')}
const variantConfig = [
  { name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 640, y: 0 },
];

const hdrRootVariants = {
  default: { backgroundColor: '#111133' },
  'variant-1': { backgroundColor: '#aa2244' },
};

const logoDotVariants = {
  default: { rotate: 0 },
  'variant-1': { rotate: 45 },
};

function Header({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="hdr-root" {...rest} variants={hdrRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} data-name="Header" style={{ position: 'absolute', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: '16px', width: '480px', height: '80px', padding: '16px', backgroundColor: '#111133', ...style }}>
        <motion.div layout={true} data-id="logo" data-name="Logo" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '6px', width: initialVariant === 'variant-1' ? '120px' : '80px', height: '40px', backgroundColor: '#222255' }}>
          <motion.div layout={true} data-id="logo-dot" data-name="Dot" variants={logoDotVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '20px', height: '20px', backgroundColor: '#ffcc00' }} />
        </motion.div>
        <motion.div layout={true} data-id="hamburger" data-name="Hamburger" key="hamburger" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '48px', height: '48px', padding: '12px', backgroundColor: '#ffffff' }}>
          <motion.div layout={true} data-id="ham-line" data-name="Line" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', height: '4px', backgroundColor: '#111133' }} />
        </motion.div>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Header);
`;

export const HEADER_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import Header from '@/components/Header';"],
  body: bodyWith(`<Header data-id="hdr" data-name="Header" style={{ position: 'relative', flex: '0 0 auto', order: '5' }} />`),
  extraFiles: { 'components/Header.tsx': HEADER_MASTER },
});

/** A master with an EVENT prop fired by a child (CMP-024). The page instance
 *  wires the event to a visible effect so the preview can prove it fires. */
export const CTA_MASTER = `${MASTER_HEAD('Cta')}
/** @propMeta {"event1":{"type":"event","label":"Modal"},"content":{"type":"plainText","label":"Copy"}} */

const variantConfig = [
  { name: 'default', label: 'Cta', x: 0, y: 0, isPrimary: true },
];

function Cta({ style, initialVariant = 'default', event1, content = "AI Intelligence", ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="cta-root" {...rest} data-name="Cta" style={{ position: 'absolute', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '420px', height: '80px', padding: '16px', backgroundColor: '#113322', ...style }}>
        <motion.div layout={true} data-id="find-btn" data-name="Find Advisor" onClick={event1} style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', alignItems: 'center', padding: '10px 18px', backgroundColor: '#33aa66' }}>
          <motion.p layout={true} data-id="find-text" data-name="Find Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#ffffff', margin: '0px' }}>Find an advisor</motion.p>
        </motion.div>
        <motion.p layout={true} data-id="cta-copy" data-name="Copy" style={{ position: 'relative', flex: '0 0 auto', order: '1', color: '#ffffff', margin: '0px' }}>{content}</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Cta);
`;

export const CTA_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import Cta from '@/components/Cta';"],
  hooks: ['const [fired, setFired] = React.useState(0);'],
  body: bodyWith(`<Cta data-id="cta" data-name="Cta" event1={() => setFired((n) => n + 1)} style={{ position: 'relative', flex: '0 0 auto', order: '5' }} />
      <p data-id="fired" data-name="Fired" style={{ position: 'relative', flex: '0 0 auto', order: '6', color: '#ffffff', margin: '0px' }}>{'Fired ' + fired}</p>`),
  extraFiles: { 'components/Cta.tsx': CTA_MASTER },
});

const USE_MEDIA_QUERY_FN = `function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}`;

/** A master whose child is bound to its variables (CMP-023): a Shadow var on
 *  a card and a per-viewport `__mq` transform pair on a chip inside it. */
export const PANEL_MASTER = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Panel" */
/** @propMeta {"shadow5":{"type":"shadow","label":"Card Shadow"},"tilt":{"type":"number","label":"Tilt"},"tilt1":{"type":"number","label":"Tilt Mobile"},"heading":{"type":"plainText","label":"Heading"}} */

const variantConfig = [
  { name: 'default', label: 'Panel', x: 0, y: 0, isPrimary: true },
];

${USE_MEDIA_QUERY_FN}

function Panel({ style, initialVariant = 'default', shadow5 = "0px 8px 24px rgba(0,0,0,0.5)", tilt = 0, tilt1 = 8, heading = "Panel", ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const __mq2 = useMediaQuery('(max-width: 375px)');
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="panel-root" {...rest} data-name="Panel" style={{ position: 'absolute', display: 'flex', flexDirection: 'column', gap: '12px', width: '360px', height: '220px', padding: '20px', backgroundColor: '#1d1d2d', ...style }}>
        <motion.div layout={true} data-id="panel-card" data-name="Panel Card" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'row', gap: '8px', width: '100%', height: '120px', padding: '12px', backgroundColor: '#2d2d4d', boxShadow: shadow5 }}>
          <motion.div layout={true} data-id="panel-chip" data-name="Chip" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '60px', height: '60px', backgroundColor: '#ff8844', rotate: tilt }} />
          <motion.input layout={true} data-id="panel-input" data-name="Search" data-search-field="true" type="text" placeholder={__mq2 ? "Short" : "Type here"} style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '160px', height: '36px' }} />
        </motion.div>
        <motion.p layout={true} data-id="panel-text" data-name="Heading" style={{ position: 'relative', flex: '0 0 auto', order: '1', color: '#ffffff', margin: '0px' }}>{heading}</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Panel);
`;

export const PANEL_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import Panel from '@/components/Panel';"],
  body: bodyWith(`<Panel data-id="panel" data-name="Panel" style={{ position: 'relative', flex: '0 0 auto', order: '5' }} />`),
  extraFiles: { 'components/Panel.tsx': PANEL_MASTER },
});

/** The page's file-local `useResponsiveText` hook, as the text writer emits it
 *  (read from the generator so the seed can't drift from the product). */
export function responsiveTextHookBlock(): string {
  const src = nodeFs.readFileSync(nodePath.join(__dirname, '../../src/code/generation/text-override-gen.ts'), 'utf8');
  const start = src.indexOf('const HOOK_DEFINITION = `') + 'const HOOK_DEFINITION = `'.length;
  const end = src.indexOf('`.trim();', start);
  const body = src.slice(start, end).replace(/\$\{HOOK_NAME\}/g, 'useResponsiveText').replace(/\\`/g, '`').trim();
  return `// @useResponsiveText-begin\n${body}\n// @useResponsiveText-end`;
}

/** CMP-026: the card's title translated through `t()` (en + fr) and its body
 *  routed through `useResponsiveText`. */
export function i18nPage() {
  return makeComponentPage({
    canvasNodes: null,
    imports: ["import { useRef, useState, useLayoutEffect } from 'react';", "import { useTranslations } from 'next-intl';"],
    preamble: responsiveTextHookBlock(),
    hooks: ["const t = useTranslations('home');"],
    body: MAKE_COMPONENT_BODY
      .replace(`>Pro plan</h2>`, `>{t('card-title')}</h2>`)
      .replace(`>Everything in Basic, plus more.</p>`, `>{useResponsiveText("Everything in Basic, plus more.", { 375: "Basic, plus more." }, [375, 768, 1440])}</p>`),
    extraFiles: {
      'i18n/config.json': JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }, null, 2),
      'messages/en.json': JSON.stringify({ home: { 'card-title': 'Pro plan' } }, null, 2),
      'messages/fr.json': JSON.stringify({ home: { 'card-title': 'Forfait Pro' } }, null, 2),
    },
  });
}

/** A 2-variant design master (default / variant-1) for scroll-variant and fx rows. */
export const BADGE2_MASTER = `${MASTER_HEAD('Badge Two')}
const variantConfig = [
  { name: 'default', label: 'Badge Two', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Scrolled', x: 300, y: 0 },
];

const badgeTwoRootVariants = {
  default: { backgroundColor: '#2266aa' },
  'variant-1': { backgroundColor: '#aa6622' },
};

function BadgeTwo({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="badge2-root" {...rest} variants={badgeTwoRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} data-name="Badge Two" style={{ position: 'absolute', display: 'flex', flexDirection: 'row', alignItems: 'center', width: '160px', height: '60px', padding: '12px', backgroundColor: '#2266aa', ...style }}>
        <motion.p layout={true} data-id="badge2-text" data-name="Badge Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#ffffff', margin: '0px' }}>Hover me</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(BadgeTwo);
`;

/** CMP-027: a frame holding an instance with a hover fx and a scroll variant,
 *  whose hooks live in the page body (the shape the generators write). */
export const FX_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: [
    "import { useState, useRef } from 'react';",
    "import { useScroll, useMotionValueEvent, useTransform } from 'framer-motion';",
    "import BadgeTwo from '@/components/BadgeTwo';",
  ],
  // The page-level hooks exactly as scroll-variant-gen + instance-fx-gen write them
  // (a Scroll Transform: rotate 0 → 45 over the element's pass through the viewport).
  hooks: [`const [kidSv, setKidSv] = useState('default');
  const { scrollY: kidSvScroll } = useScroll();
  useMotionValueEvent(kidSvScroll, "change", (y) => {
    const prev = kidSvScroll.getPrevious() ?? 0;
    if (y > prev) setKidSv('variant-1');
    else if (y < prev) setKidSv('default');
  });
  const kidRef = useRef(null);
  const { scrollYProgress: kidFxTfP } = useScroll({ target: kidRef, offset: ['start end', 'end start'] });
  const kidFxTfRotate = useTransform(kidFxTfP, [0, 1], [0, 45]);`],
  body: bodyWith(`<div data-id="fx-frame" data-name="Fx Frame" style={{ position: 'relative', flex: '0 0 auto', order: '5', width: '400px', height: '160px', backgroundColor: '#1a2a1a' }}>
        <BadgeTwo data-instance-fx='{"transform":{"from":{"rotate":0},"to":{"rotate":45},"trigger":"onScroll"}}' ref={kidRef} data-scroll-variant='{"trigger":"onScroll","from":"default","to":"variant-1","direction":"down","replay":true}' initialVariant={kidSv} data-id="kid" data-name="Badge Two" style={{ rotate: kidFxTfRotate, position: 'absolute', left: '20px', top: '20px', width: '160px', height: '60px' }} />
      </div>`),
  extraFiles: { 'components/BadgeTwo.tsx': BADGE2_MASTER },
});

/** CMP-029: one overlay triggered by a frame that will itself become the
 *  component (root trigger), one triggered by a child of another frame
 *  (descendant trigger). Both overlays sit at the root's end, as written. */
export const OVERLAY_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import { useState } from 'react';", "import { motion, AnimatePresence } from 'framer-motion';"],
  hooks: ['const [ovOneOpen, setOvOneOpen] = useState(false);', 'const [ovTwoOpen, setOvTwoOpen] = useState(false);'],
  body: bodyWith(`<div data-id="trig" data-name="Trigger" data-overlay-trigger='{"targetId":"ov-one","trigger":"click","dismiss":"outside"}' onClick={() => setOvOneOpen(!ovOneOpen)} style={{ position: 'relative', flex: '0 0 auto', order: '5', width: '200px', height: '60px', backgroundColor: '#663399' }} />
      <div data-id="ov-host" data-name="Overlay Host" style={{ position: 'relative', flex: '0 0 auto', order: '6', display: 'flex', flexDirection: 'row', width: '300px', height: '80px', padding: '10px', backgroundColor: '#336699' }}>
        <div data-id="ov-btn" data-name="Open Button" data-overlay-trigger='{"targetId":"ov-two","trigger":"click","dismiss":"outside"}' onClick={() => setOvTwoOpen(!ovTwoOpen)} style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '120px', height: '60px', backgroundColor: '#99ccff' }} />
      </div>`)
    .replace(/\n    <\/div>$/, `
      <AnimatePresence>{ovOneOpen && (
        <motion.div key="ov-one" data-id="ov-one" data-name="Overlay One" data-overlay='{"type":"relative","triggerId":"trig","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '220px', height: '100px', backgroundColor: '#ffcc33' }}>
          <p data-id="ov-one-text" data-name="Overlay One Text" style={{ position: 'relative', color: '#000000', margin: '0px' }}>Overlay one</p>
        </motion.div>
      )}</AnimatePresence>
      <AnimatePresence>{ovTwoOpen && (
        <motion.div key="ov-two" data-id="ov-two" data-name="Overlay Two" data-overlay='{"type":"relative","triggerId":"ov-btn","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '220px', height: '100px', backgroundColor: '#33ffcc' }}>
          <p data-id="ov-two-text" data-name="Overlay Two Text" style={{ position: 'relative', color: '#000000', margin: '0px' }}>Overlay two</p>
        </motion.div>
      )}</AnimatePresence>
    </div>`),
});

/** The built-in Marquee code component, read from its template. */
export function marqueeSource(): string {
  const src = nodeFs.readFileSync(nodePath.join(__dirname, '../../src/code/project/default-code-components/Marquee.ts'), 'utf8');
  const start = src.indexOf('export const MARQUEE_COMPONENT = `') + 'export const MARQUEE_COMPONENT = `'.length;
  return src.slice(start, src.indexOf('`;', start));
}

/** CMP-030: a frame holding a Marquee whose items are connected `cn_` canvas
 *  nodes; one item holds a component instance. */
export function slotPage() {
  const files = makeComponentPage({
    canvasNodes: null,
    imports: ["import Marquee from '@/components/Marquee';", "import Badge from '@/components/Badge';"],
    body: bodyWith(`<div data-id="strip-host" data-name="Strip Host" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'column', width: '600px', padding: '16px', backgroundColor: '#202030' }}>
        <Marquee data-id="strip" data-name="Marquee" speed={60} gap={24} style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', height: '120px' }}>{cn_slot_a}{cn_slot_b}</Marquee>
      </div>`),
    extraFiles: { 'components/Marquee.tsx': marqueeSource(), 'components/Badge.tsx': BADGE_MASTER },
  });
  files.files['app/page.client.tsx'] += `const cn_slot_a = <div data-id="slot-a" data-name="Slot A" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '100px', width: '160px', height: '80px', backgroundColor: '#ff3366' }}></div>;
const cn_slot_b = <div data-id="slot-b" data-name="Slot B" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '260px', width: '220px', height: '80px', backgroundColor: '#33ccff' }}><Badge data-id="slot-badge" data-name="Badge" style={{ position: 'relative' }} /></div>;
`;
  return files;
}

/** CMP-031: a collection list whose template row is a nav Link with fields. */
export const CMS_ROW_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import Link from 'next/link';", "import team from '@/cms/team.json';"],
  body: bodyWith(`<div data-id="team-list" data-name="Team" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff' }}>
        {team.map((item, idx) => (
          <Link data-cms-nav="row" href={\`/team/\${item?._slug ?? ''}\`} data-id="team-row" key={idx} data-name="Member" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', width: '100%', height: '56px', padding: '8px', backgroundColor: '#eeeeee' }}>
            <div data-id="member-photo" data-name="Photo" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '40px', height: '40px', backgroundImage: \`url(\${item.photo})\`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />
            <p data-id="member-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.name}</p>
          </Link>
        ))}
      </div>`),
  extraFiles: { ...C1_CMS_FILES },
});

/** The Load More master exactly as the pagination generator writes it. */
export function loadMoreSource(): string {
  const src = nodeFs.readFileSync(nodePath.join(__dirname, '../../src/code/generation/cms-pagination-gen.ts'), 'utf8');
  const fn = src.indexOf('export function buildLoadMoreComponentCode');
  const start = src.indexOf('return `', fn) + 'return `'.length;
  return src.slice(start, src.indexOf('`;\n}', start)).replace(/\$\{LOADMORE_COMPONENT_NAME\}/g, 'LoadMore');
}

/** CMP-032: a whole paginated collection list (Load More, 2 per page, 3 posts). */
export const PAGINATED_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import { useState } from 'react';", "import blog from '@/cms/blog.json';", "import LoadMore from '@/components/LoadMore';"],
  hooks: ['const [visBlogs, setVisBlogs] = useState(2);'],
  body: bodyWith(`<div data-id="blogs" data-name="Blogs" data-collection-list="blog" data-pagination="loadMore:2" style={{ position: 'relative', flex: '0 0 auto', order: '5', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff' }}>
        {blog.slice(0, visBlogs).map((item, idx) => (
          <div data-id="blog-row" data-name="Blog" key={idx} style={{ position: 'relative', flex: '0 0 auto', display: 'flex', width: '100%', height: '40px', backgroundColor: '#eeeeee' }}>
            <h3 data-id="blog-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.title}</h3>
          </div>
        ))}
        {visBlogs < blog.length && <LoadMore data-id="loadmore-blogs" data-name="Load More" data-pagination-ui="true" onLoadMore={() => setVisBlogs((c) => c + 2)} style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />}
      </div>`),
  extraFiles: { ...C1_CMS_FILES, 'components/LoadMore.tsx': loadMoreSource() },
});

/** The `name={…}` attribute (balanced braces) inside a tag's source, or null. */
export function attrExpr(tagSource: string, name: string): string | null {
  const at = tagSource.search(new RegExp(`\\s${name}=\\{`));
  if (at === -1) return null;
  const open = tagSource.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < tagSource.length; i++) {
    if (tagSource[i] === '{') depth++;
    else if (tagSource[i] === '}') { depth--; if (depth === 0) return tagSource.slice(at + 1, i + 1); }
  }
  return null;
}

/** The template literal a generator function returns, read from its source
 *  file (so a seed can't drift from what the product writes). `vars` fills
 *  the `${NAME}` interpolations. */
export function generatorTemplate(file: string, fnName: string, vars: Record<string, string> = {}): string {
  const src = nodeFs.readFileSync(nodePath.join(__dirname, '../../src', file), 'utf8');
  const fn = src.indexOf(`export function ${fnName}`);
  let i = src.indexOf('return `', fn) + 'return `'.length;
  let out = '';
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { out += src[i + 1]; i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') {
      const close = src.indexOf('}', i);
      const name = src.slice(i + 2, close).trim();
      if (!(name in vars)) throw new Error(`generatorTemplate(${fnName}): no value for \${${name}}`);
      out += vars[name];
      i = close + 1;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const FORM_STATE = 'formStateContactform';
const SET_FORM_STATE = 'setFormStateContactform';

/** A contact form exactly as the Insert panel's Custom Form drop writes it
 *  (onSubmit lifecycle + FormSubmit instance mapped loading/success), plus the
 *  destination and child placement the oracle asks for. */
export const FORM_PAGE = makeComponentPage({
  canvasNodes: null,
  imports: ["import { useState } from 'react';", "import FormSubmit from '@/components/FormSubmit';"],
  hooks: [`const [${FORM_STATE}, ${SET_FORM_STATE}] = useState('idle');`],
  body: bodyWith(`<form onSubmit={async (e) => {
        e.preventDefault();
        ${SET_FORM_STATE}("loading");
        const formEl = e.currentTarget;
        const fd = new FormData(formEl);
        const _hp = fd.get("_hp");
        fd.delete("_hp");
        const fields = Object.fromEntries(fd.entries());
        try {
          const res = await fetch("/api/form", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formId: "contact-form", fields, _hp }) });
          const data = await res.json().catch(() => ({}));
          if (data && data.redirect) { window.location.href = data.redirect; return; }
          if (res.ok && (!data || data.ok !== false)) { formEl.reset(); ${SET_FORM_STATE}("success"); setTimeout(() => ${SET_FORM_STATE}("idle"), 4000); } else { ${SET_FORM_STATE}("error"); setTimeout(() => ${SET_FORM_STATE}("idle"), 4000); }
        } catch (err) { ${SET_FORM_STATE}("error"); setTimeout(() => ${SET_FORM_STATE}("idle"), 4000);}
      }} data-id="contact-form" data-name="Custom Form" data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"you@example.com","subject":"New submission"}]}' style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '400px', padding: '24px', backgroundColor: '#ffffff', borderRadius: '12px', flex: '0 0 auto', position: 'relative', order: '5' }}>
        <h3 data-id="form-heading" data-name="Heading" style={{ fontSize: '18px', fontWeight: '600', color: '#111827', margin: '0px', order: '0', flex: '0 0 auto', position: 'relative' }}>Get in touch</h3>
        <input data-id="form-name" type="text" name="name" placeholder="Name" style={{ width: '100%', height: '40px', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none', order: '1', flex: '0 0 auto', position: 'relative' }}></input>
        <input data-id="form-email" type="email" name="email" placeholder="Email" style={{ width: '100%', height: '40px', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none', order: '2', flex: '0 0 auto', position: 'relative' }}></input>
        <FormSubmit data-form-state='{"loading":"loading","success":"success"}' initialVariant={${FORM_STATE} === 'loading' ? 'loading' : ${FORM_STATE} === 'success' ? 'success' : 'default'} data-id="form-submit" data-name="Submit" label={"Send"} style={{ width: "100%", order: '3', flex: '0 0 auto', position: 'relative' }} />
      </form>`),
  extraFiles: {
    'components/FormSubmit.tsx': generatorTemplate('code/generation/form-submit-gen.ts', 'buildFormSubmitComponentCode', { FORMSUBMIT_GEN_TOKEN: '@formsubmit-gen v3', FORMSUBMIT_COMPONENT_NAME: 'FormSubmit', SPINNER_COMPONENT_NAME: 'Spinner' }),
    'components/Spinner.tsx': generatorTemplate('code/generation/cms-pagination-gen.ts', 'buildSpinnerComponentCode', { SPINNER_COMPONENT_NAME: 'Spinner' }),
  },
});

/** A file's contents once they stop changing (two reads ~600ms apart agree):
 *  post-Make-Component heals (e.g. the form-state declaration healer) land in
 *  the master a moment after the editor enters it. */
export async function stableCode(editor: Editor, path: string, timeout = 10_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let prev = await editor.code(path);
  while (Date.now() < deadline) {
    await editor.page().waitForTimeout(600);
    await editor.settled();
    const now = await editor.code(path);
    if (now === prev) return now;
    prev = now;
  }
  return prev;
}
