// C2 lane helpers — design components: entering, leaving and editing the
// master, the default variant and canvas expansion (E2E_TEST_PLAN.md §8,
// CMP-039…066, CMP-223…227).
//
//   import { enterByDoubleClick, C2_SEED, CARD } from '../../helpers/c2';
//   await enterByDoubleClick(editor, 'card-a', CARD);
//
// Seeds are in the builder's own dialect (variantConfig, withResponsiveProps,
// motion.* children, `@propMeta`). A page instance renders on the canvas as
// its wrapper (`data-id` = the instance id) holding the expanded master tree,
// whose nodes carry `<instanceId>:<childId>` node ids.

import type { Locator, Page } from '@playwright/test';
import type { Editor } from './editor';
import { project, type ProjectData } from '../fixtures/project';
import { breadcrumb, breadcrumbSegment, waitForActiveFile } from './c1';

export const PAGE = 'app/page.client.tsx';
export const ABOUT = 'app/about/page.client.tsx';
export const CARD = 'components/Card.tsx';

export type Box = { x: number; y: number; width: number; height: number };

// ─── Seeds ───────────────────────────────────────────────────────────

/** The builder's own one-tile `@canvas` header (full shape, isPrimary). */
export const ONE_TILE = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;

export function pageClient(rootJsx: string, opts: { imports?: string[]; header?: string; preamble?: string; hooks?: string; canvasNodes?: string; head?: string } = {}): string {
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const body = rootJsx.trim().split('\n').map(l => (l ? '    ' + l : l)).join('\n');
  const canvasNodes = opts.canvasNodes ? `const canvasNodes = (<>\n${opts.canvasNodes.trim()}\n</>);\n` : '';
  return `'use client';

${opts.header ?? ONE_TILE}
${opts.head ?? ''}
import React from 'react';
${imports}${opts.preamble ?? ''}
export default function Page() {
${opts.hooks ?? ''}  return (
${body}
  );
}
${canvasNodes}`;
}

const ROOT_STYLE = `display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px'`;

export function pageRoot(children: string, rootId = 'root'): string {
  return `<div data-id="${rootId}" data-name="Page" style={{ ${ROOT_STYLE} }}>\n${children.trim().split('\n').map(l => '  ' + l).join('\n')}\n</div>`;
}

export function inst(tag: string, id: string, attrs = '', style = `position: 'relative', flex: '0 0 auto'`): string {
  return `<${tag} data-id="${id}" data-name="${tag}"${attrs ? ' ' + attrs : ''} style={{ ${style} }} />`;
}

/** The Card master every navigation row uses: two variants (default, Hover),
 *  a prop-bound Title, a badge and a body text, root fill in the inline style. */
export const CARD_MASTER = `'use client';

/** @name "Card" */
/** @propMeta {"title":{"type":"plainText","label":"Title"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];

function Card({ style, initialVariant = 'default', title = 'Old', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', borderRadius: '12px', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{title}</motion.p>
      <motion.div layout={true} data-id="card-badge" data-name="Badge" style={{ position: 'relative', width: '48px', height: '48px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '1' }} />
      <motion.p layout={true} data-id="card-body" data-name="Body" style={{ position: 'relative', fontSize: '16px', color: '#333333', margin: '0px', flex: '0 0 auto', order: '2' }}>Body copy</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

const CARD_IMPORT = `import Card from '@/components/Card';`;
const SERVER = `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`;

/** Page A (home): two Card instances (B passes `title="Custom"`) and a
 *  marker frame; page B (/about): one Card. */
export function cardSeed(opts: { master?: string; aAttrs?: string; bAttrs?: string; extra?: Record<string, string>; canvasNodes?: string } = {}): ProjectData {
  const b = project()
    .pageSource(pageClient(pageRoot(`
<div data-id="marker" data-name="Marker" style={{ position: 'relative', width: '400px', height: '120px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
${inst('Card', 'card-a', opts.aAttrs ?? '')}
${inst('Card', 'card-b', opts.bAttrs ?? 'title="Custom"')}`), { imports: [CARD_IMPORT], canvasNodes: opts.canvasNodes }))
    .file('app/about/page.tsx', SERVER)
    .file(ABOUT, pageClient(pageRoot(inst('Card', 'card-c'), 'about-root'), { imports: [CARD_IMPORT] }))
    .component('Card', opts.master ?? CARD_MASTER);
  for (const [k, v] of Object.entries(opts.extra ?? {})) b.file(k, v);
  return b.build();
}

export const C2_SEED = cardSeed();

// ─── Navigation ──────────────────────────────────────────────────────

/** Real double-click on a node (page instance, master node, …): two presses
 *  ~120ms apart. The canvas reads its own double-click from mousedowns and
 *  ignores a pair closer than 50ms (same-frame guard), which a bare
 *  `mouse.dblclick` (0ms gap) hits whenever the machine is fast enough. */
export async function dblclickNode(editor: Editor, id: string, opts: { vpId?: string; at?: [number, number] } = {}): Promise<void> {
  const page = editor.page();
  const [fx, fy] = opts.at ?? [0.5, 0.5];
  const p = await editor.at(id, fx, fy, opts.vpId);
  await dblclickAt(page, p);
}

export async function dblclickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
  await page.mouse.click(p.x, p.y);
}

/** Double-click an instance and wait until its master is active and painted. */
export async function enterByDoubleClick(editor: Editor, instanceId: string, file: string, opts: { vpId?: string; at?: [number, number] } = {}): Promise<void> {
  // Out of the double-click window of any earlier click.
  await editor.page().waitForTimeout(450);
  await dblclickNode(editor, instanceId, opts);
  await waitForActiveFile(editor, file, 15_000);
  await waitEntryPainted(editor);
}

/** The entry fade (iframe opacity dip) is over and the canvas settled. */
export async function waitEntryPainted(editor: Editor): Promise<void> {
  const page = editor.page();
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
    return !f || f.style.opacity !== '0';
  }, undefined, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  await editor.settled();
}

export { breadcrumb, breadcrumbSegment, waitForActiveFile };

/** Box of a node once two reads 120ms apart agree (camera tweens settle). */
export async function stableBox(editor: Editor, id: string, vpId?: string, timeout = 5_000): Promise<Box> {
  const read = () => (vpId ? editor.nodeBoxIn(vpId, id) : editor.nodeBox(id));
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

/** The zoom % shown in the bottom toolbar. */
export async function zoomPercent(page: Page): Promise<number> {
  const txt = await page.locator('text=/^\\d+%$/').first().innerText();
  return parseInt(txt, 10);
}

// ─── Panel ───────────────────────────────────────────────────────────

export function panel(page: Page): Locator {
  return page.locator('[data-properties-panel]');
}

export function leftPanel(page: Page): Locator {
  return page.locator('[data-tutorial="left-panel"]');
}

/** Trace entries (category matched by regex). */
export async function traces(page: Page, pattern: string): Promise<Array<{ ts: number; c: string; data: any }>> {
  return page.evaluate(p => (window as any).__e2e.traceEntries(p), pattern);
}

/** The canvas area (parent frame) the camera frames. */
export async function canvasArea(page: Page): Promise<Box> {
  return (await page.locator('[data-canvas-root]').boundingBox())!;
}

/** Is the box centred in the canvas area (within a fraction of its size)? */
export function centredIn(b: Box, area: Box, tol = 0.12): boolean {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return Math.abs(cx - (area.x + area.width / 2)) < area.width * tol
    && Math.abs(cy - (area.y + area.height / 2)) < area.height * tol;
}

/** Does `b` lie entirely inside `area`? */
export function within(b: Box, area: Box, pad = 1): boolean {
  return b.x >= area.x - pad && b.y >= area.y - pad && b.x + b.width <= area.x + area.width + pad && b.y + b.height <= area.y + area.height + pad;
}

export function sameBox(a: Box, b: Box, tol = 1): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

/** Real wheel input over the canvas centre: ctrl+wheel zooms, plain wheel pans. */
export async function zoomAndPan(page: Page, opts: { zoomSteps?: number; zoomDelta?: number; panX?: number; panY?: number } = {}): Promise<void> {
  const area = await canvasArea(page);
  await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.4);
  for (let i = 0; i < (opts.zoomSteps ?? 3); i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, opts.zoomDelta ?? -60);
    await page.keyboard.up('Control');
    await page.waitForTimeout(60);
  }
  if (opts.panX || opts.panY) {
    await page.mouse.wheel(opts.panX ?? 0, opts.panY ?? 0);
    await page.waitForTimeout(60);
  }
  // Camera persist captures a settled camera after 200ms.
  await page.waitForTimeout(500);
}

/** Is the Layers variant/viewport header row lit (the selection fill)? */
export async function layerHeaderLit(page: Page, vpId = 'desktop'): Promise<boolean> {
  const row = page.locator(`[data-layer-id="__vp_${vpId}"]`).first();
  if ((await row.count()) === 0) return false;
  return row.evaluate((el) => {
    const bg = (el.previousElementSibling as HTMLElement | null)?.style.backgroundColor ?? '';
    return /accent/.test(bg);
  });
}

/** The left panel shows Layers (its toolbar button carries the active fill). */
export async function layersTabActive(page: Page): Promise<boolean> {
  const cls = (await page.locator('[data-tutorial="layers-button"]').getAttribute('class')) ?? '';
  return cls.includes('btn-secondary-bg');
}

/** A properties-panel row by its label (the label span carries `title`). */
export function row(page: Page, label: string, nth = 0): Locator {
  return panel(page).locator(`span[title="${label}"]`).nth(nth)
    .locator('xpath=ancestor::div[@data-tool-row or contains(concat(" ", normalize-space(@class), " "), " justify-between ") or contains(@class, "grid-cols-")][1]');
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

/** Fill row → colour popup → type a hex (Enter commits) → close the popup. */
export async function setFillHex(page: Page, hex: string): Promise<void> {
  await row(page, 'Fill').locator('button:not(:has(span[title]))').first().click();
  const pop = page.locator('[data-tool-popup]').last();
  const input = pop.locator('input[spellcheck="false"]').first();
  await input.waitFor({ timeout: 5_000 });
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(hex.replace(/^#/, ''));
  await input.press('Enter');
  await closePopup(page);
}

/** Double-click a prop-bound text in a master → the Variable modal opens on
 *  that variable → type its new default. */
export async function editBoundTextDefault(editor: Editor, textId: string, value: string): Promise<void> {
  const page = editor.page();
  await page.waitForTimeout(450);
  await dblclickNode(editor, textId);
  const fieldRow = page.locator('div.flex.gap-4', { has: page.locator('label', { hasText: /^Default$/ }) }).last();
  const field = fieldRow.locator('textarea, input').first();
  await field.waitFor({ state: 'visible', timeout: 5_000 });
  await field.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(value);
  await field.press('Tab');
  await page.keyboard.press('Escape');
  await editor.settled();
}

/** rgb() of a canvas node's computed property (`nodeId` = data-node-id). */
export async function paintedById(editor: Editor, nodeId: string, prop: string): Promise<string> {
  const loc = editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

export async function textById(editor: Editor, nodeId: string): Promise<string> {
  const loc = editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  if ((await loc.count()) === 0) return '';
  return (await loc.textContent()) ?? '';
}

/** Collect console.error texts from now on (the fixture also sees them). */
export function collectConsoleErrors(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') out.push(m.text()); });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

/** React's hooks-order warning. Playwright's msg.text() keeps the `%s`
 *  placeholder ("…called by %s…") and appends the component name after the
 *  format string, so match the pieces separately. */
export const HOOKS_ORDER = /change in the order of Hooks[\s\S]*ControlLabel|ControlLabel[\s\S]*order of Hooks/;

// ─── Seeds: nested masters with a variant-driven nested instance ─────

/** Logo master: two variants with different fills. */
export const LOGO_MASTER = `'use client';

/** @name "Logo" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Light', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Dark', x: 300, y: 0 },
];

const logoRootVariants = {
  default: { backgroundColor: '#ffffff' },
  'variant-1': { backgroundColor: '#111111' },
};

function Logo({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="logo-root" variants={logoRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Logo" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '120px', height: '48px', backgroundColor: '#ffffff', ...style }}>
      <motion.p layout={true} data-id="logo-text" data-name="Mark" style={{ position: 'relative', fontSize: '16px', color: '#ff2d75', margin: '0px', flex: '0 0 auto', order: '0' }}>LOGO</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Logo);
`;

/** Header master: two variants driven by `variant` state; the nested Logo
 *  follows the parent variant through a per-variant ternary. */
export const HEADER_LOGO_MASTER = `'use client';

/** @name "Header" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Logo from '@/components/Logo';

const variantConfig = [
  { name: 'default', label: 'Light', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Dark', x: 700, y: 0 },
];

const headerRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#1a1a3a' },
};

function Header({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="header-root" variants={headerRootVariants} initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-name="Header" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '24px', width: '600px', height: '120px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <Logo data-id="header-logo" data-name="Logo" initialVariant={variant === 'variant-1' ? 'variant-1' : 'default'} style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      <motion.p layout={true} data-id="header-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>Header</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Header);
`;

export const HEADER_LOGO_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(inst('Header', 'header-a')), { imports: [`import Header from '@/components/Header';`] }))
  .component('Logo', LOGO_MASTER)
  .component('Header', HEADER_LOGO_MASTER)
  .build();

// ─── Seeds: a MotionLink-root master with a hover state (CMP-048) ────

export const SIGNUP_MASTER = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(Link);

/** @name "Sign Up Button" */

const variantConfig = [
  { name: 'default', label: 'Sign Up Button', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Sign Up Button - Hover', x: 0, y: 71, interactionType: 'hover', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function SignUp({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <MotionLink
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} layout={true} key="signup" data-id="link-signup" {...rest} data-name="Sign Up Button" href="/" style={{ display: 'flex', flexDirection: 'row', gap: '10px', position: 'absolute', backgroundColor: '#111111', width: 'max-content', height: 'min-content', padding: '12px 24px', overflow: 'hidden', ...style}} initial={['default', initialVariant]} animate={['default', variant]}>
      <motion.p layout={true} data-id="text-signup" data-name="Sign Up Label" style={{ position: 'relative', fontSize: '16px', color: '#ffffff', margin: '0px' }}>Sign Up</motion.p>
    </MotionLink>
    </LayoutGroup>
  );
}

export default withResponsiveProps(SignUp);
`;

export const SIGNUP_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(`<div data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '200px', height: '100px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>`)))
  .component('SignUp', SIGNUP_MASTER)
  .build();

// ─── Seeds: design + code + CDN instances side by side (CMP-045) ─────

export const COUNTER_CODE = `'use client';

/** @label "Counter" */
/** @comment "Counts" */
/** @controls {
  "label": { "type": "text", "label": "Label", "default": "Count" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function Counter({ label = 'Count', ...props }: { label?: string; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '60px', backgroundColor: '#ffcc33', color: '#000000', ...(props.style || {}) }}>{label}</div>;
}

export default withResponsiveProps(Counter);
`;

export const STUB_CDN_HASH = '0123456789abcdef';
export const STUB_CDN_URL = `https://assets.revyme.app/components/StubPill@${STUB_CDN_HASH}.js`;
export const STUB_CDN_INTERFACE = `'use client';
/** @name "StubPill" */
const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
function StubPill({ style, initialVariant = 'default', ...rest }: { style?: any; initialVariant?: string; [key: string]: any }) {}
export default withResponsiveProps(StubPill);
`;

export const THREE_KINDS_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(`
${inst('Card', 'card-a')}
${inst('Counter', 'counter-a')}
${inst('StubPill', 'cdn-a', '', `position: 'relative', width: '160px', height: '60px', flex: '0 0 auto'`)}`), {
    imports: [CARD_IMPORT, `import Counter from '@/components/Counter';`, `import StubPill from '${STUB_CDN_URL}';`],
  }))
  .component('Card', CARD_MASTER)
  .component('Counter', COUNTER_CODE)
  .build();

/** Stub the cloud routes a CDN-linked instance asks for (LOCAL mode has no backend). */
export async function stubCdn(page: Page): Promise<void> {
  await page.route(/\/api\/components\/source\?/, route => route.fulfill({ status: 403, body: 'closed source' }));
  await page.route(/\/api\/components\/metadata\?/, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ hash: STUB_CDN_HASH, name: 'StubPill', creator: null, createdAt: '2026-09-01T00:00:00.000Z', closedSource: true, defaultWidth: 160, defaultHeight: 60, interfaceSource: STUB_CDN_INTERFACE }),
  }));
  await page.route(/assets\.revyme\.app\/components\//, route => route.fulfill({
    status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' },
    body: 'export default function StubPill(props) { return null; }',
  }));
}

/** A second, plain master for the Library chain rows. */
export const BADGE_MASTER = `'use client';

/** @name "Badge" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true }];

function Badge({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="badge-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Badge" style={{ display: 'flex', width: '80px', height: '32px', backgroundColor: '#ffd166', borderRadius: '16px', ...style }} />
  </LayoutGroup>;
}
export default withResponsiveProps(Badge);
`;

/** The Library panel's row for a component (opens the panel first). */
export async function libraryRow(page: Page, name: string): Promise<Locator> {
  const lib = page.locator('[data-library-panel]');
  if (!(await lib.isVisible().catch(() => false))) await page.locator('[data-tutorial="library-button"]').click();
  await lib.waitFor({ state: 'visible' });
  return lib.getByText(name, { exact: true }).first();
}

// ─── Seeds: a Header whose master has a "Tools" node (CMP-065) ───────

export const TOOLS_HEADER_MASTER = HEADER_LOGO_MASTER
  .replace(`<motion.p layout={true} data-id="header-title" data-name="Title"`, `<motion.div layout={true} data-id="header-tools" data-name="Tools" style={{ position: 'relative', width: '80px', height: '32px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '2' }} />
      <motion.p layout={true} data-id="header-title" data-name="Title"`);

export const TOOLS_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(`
<div data-id="hero" data-name="Hero" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>
${inst('Header', 'header-a')}`), { imports: [`import Header from '@/components/Header';`] }))
  .component('Logo', LOGO_MASTER)
  .component('Header', TOOLS_HEADER_MASTER)
  .build();

// ─── Seeds: a CMS [slug] detail page holding an instance (CMP-062) ───

export const CASE_SCHEMA = JSON.stringify({ slug: 'case-study', name: 'Case study', fields: [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'overview', name: 'Overview', type: 'text' },
] });
export const CASE_DATA = JSON.stringify([
  { _id: 'i1', _slug: 'meridian', _status: 'published', title: 'MERIDIAN ARCHITECTS', overview: 'A forty-person practice.' },
  { _id: 'i2', _slug: 'other', _status: 'published', title: 'OTHER STUDIO', overview: 'Second item.' },
]);
export const DETAIL = 'app/case-study/[slug]/page.client.tsx';
export const CASE_LIST = 'app/case-study/page.client.tsx';

export const CMS_DETAIL_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(`<div data-id="home-hero" data-name="Hero" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#1a1a3a', flex: '0 0 auto' }}></div>`)))
  .file('app/case-study/page.tsx', SERVER)
  .file(CASE_LIST, pageClient(pageRoot(`<div data-id="list-hero" data-name="List" style={{ position: 'relative', width: '600px', height: '200px', backgroundColor: '#2a2a4a', flex: '0 0 auto' }}></div>`, 'list-root')))
  .file('app/case-study/[slug]/page.tsx', SERVER)
  .file(DETAIL, `'use client';

${ONE_TILE}
/** @cmsPage { "collection": "case-study", "kind": "detail" } */
import React from 'react';
import caseStudy from '@/cms/case-study.json';
import Card from '@/components/Card';

export default function Page({ params }: { params: { slug: string } }) {
  const item = caseStudy.find((i) => i._slug === params.slug) ?? caseStudy[0];
  return (
    <div data-id="detail-root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '700px', backgroundColor: '#0d0d1a', display: 'flex', flexDirection: 'column', gap: '16px', padding: '60px' }}>
      <p data-id="detail-title" data-name="Title" style={{ fontSize: '32px', color: '#ffffff', position: 'relative', flex: '0 0 auto' }}>{item.title}</p>
      <Card data-id="card-d" data-name="Card" style={{ position: 'relative', flex: '0 0 auto' }} />
    </div>
  );
}
`)
  .file('cms/case-study.schema.json', CASE_SCHEMA)
  .file('cms/case-study.json', CASE_DATA)
  .component('Card', CARD_MASTER)
  .build();

// ─── Command palette (Cmd+K) ─────────────────────────────────────────

export function palette(page: Page): Locator {
  return page.locator('div[class*="z-[99999]"]', { has: page.locator('input[placeholder^="Search layers"]') });
}

/** Open the palette with the real shortcut and type a query. */
export async function paletteSearch(page: Page, query: string): Promise<void> {
  if (!(await palette(page).isVisible().catch(() => false))) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).waitFor({ state: 'visible' });
  }
  const input = palette(page).locator('input[placeholder^="Search layers"]');
  await input.fill('');
  await input.pressSequentially(query, { delay: 20 });
  await page.waitForTimeout(500);
}

/** The palette's result rows, grouped: { category label, name, subcategory }. */
export async function paletteResults(page: Page): Promise<Array<{ category: string; name: string; sub: string }>> {
  return palette(page).evaluate((root) => {
    const out: Array<{ category: string; name: string; sub: string }> = [];
    for (const group of Array.from(root.querySelectorAll('div.mb-1'))) {
      const label = (group.firstElementChild?.textContent ?? '').trim();
      for (const row of Array.from(group.querySelectorAll('div.cursor-pointer'))) {
        const name = (row.querySelector('span.text-sm')?.textContent ?? '').trim();
        const sub = (row.querySelector('span[class*="text-[10px]"]')?.textContent ?? '').trim();
        out.push({ category: label, name, sub });
      }
    }
    return out;
  });
}

/** The icon search reaches api.iconify.design; serve it an empty SVG. */
export async function stubIconify(page: Page): Promise<void> {
  await page.route(/api\.iconify\.design/, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
}

// ─── Master-editing seeds (CMP-050 … 066) ────────────────────────────

const MASTER_IMPORTS = `import React from 'react';
import { motion, LayoutGroup, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';`;

/** A one-instance page around any master (`<Tag data-id="<id>"/>`). */
export function oneInstanceSeed(tag: string, id: string, master: string, opts: { files?: Record<string, string>; instAttrs?: string; instStyle?: string } = {}): ProjectData {
  const b = project()
    .pageSource(pageClient(pageRoot(inst(tag, id, opts.instAttrs ?? '', opts.instStyle)), { imports: [`import ${tag} from '@/components/${tag}';`] }))
    .component(tag, master);
  for (const [k, v] of Object.entries(opts.files ?? {})) b.file(k, v);
  return b.build();
}

/** CMP-051: a Nav whose hamburger (display flex, 3 stacked bars) is hidden on
 *  the primary through the AnimatePresence render gate, shown on Tablet/Mobile. */
export const NAV_HAMBURGER_MASTER = `'use client';

/** @name "Nav" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 700, y: 0 },
  { name: 'variant-2', label: 'Mobile', x: 1400, y: 0 },
];

const hamburgerVariants = {
  default: { display: 'flex', width: '32px' },
  'variant-1': { display: 'flex', width: '32px' },
  'variant-2': { display: 'flex', width: '28px' },
};

function Nav({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="nav-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Nav" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '600px', height: '80px', padding: '16px', backgroundColor: '#1a1a3a', ...style }}>
      <motion.p layout={true} data-id="nav-brand" data-name="Brand" style={{ position: 'relative', fontSize: '20px', color: '#ffffff', margin: '0px', flex: '0 0 auto', order: '0' }}>Brand</motion.p>
      <AnimatePresence mode="popLayout">
        {initialVariant !== 'default' && (
          <motion.div layout={true} key="hamburger" data-id="hamburger" data-name="Hamburger" variants={hamburgerVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} exit={{ opacity: 0 }} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '5px', width: '32px', flex: '0 0 auto', order: '1' }}>
            <motion.div layout={true} data-id="bar-1" data-name="Bar 1" style={{ position: 'relative', width: '100%', height: '3px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '0' }} />
            <motion.div layout={true} data-id="bar-2" data-name="Bar 2" style={{ position: 'relative', width: '100%', height: '3px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '1' }} />
            <motion.div layout={true} data-id="bar-3" data-name="Bar 3" style={{ position: 'relative', width: '100%', height: '3px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '2' }} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Nav);
`;

/** CMP-053: inline paddingTop 80 on the root AND a default entry that puts
 *  the `padding` shorthand before `paddingTop`. */
export const PADDED_MASTER = `'use client';

/** @name "Card" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tight', x: 500, y: 0 },
];

const cardRootVariants = {
  default: { padding: '0px', paddingTop: '80px', backgroundColor: '#97cffc' },
  'variant-1': { padding: '0px', paddingTop: '20px', backgroundColor: '#ff2d75' },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '200px', paddingTop: '80px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Padded</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-054: the root's border is an Overlay border (an ::after rule). */
export const OVERLAY_BORDER_MASTER = `'use client';

/** @name "Card" */

${MASTER_IMPORTS}

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ position: 'relative', display: 'flex', width: '300px', height: '100px', padding: '12px', backgroundColor: '#97cffc', ...style }}>
      <style>{\`[data-id="card-root"]::after { content: ''; position: absolute; inset: 0; border: 3px solid #ff2d75; border-radius: inherit; pointer-events: none; }\`}</style>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Ringed</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-055: a MotionLink wrapper whose base function starts with
 *  \`return href ? <Link …>\` and an overlay-style effect returning a cleanup. */
export const LINK_EFFECT_MASTER = `'use client';

/** @name "Promo" */
/** @propMeta {"linkHref":{"type":"link","label":"Link"}} */

import React, { useEffect } from 'react';
import Link from 'next/link';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(React.forwardRef(function MotionLinkBase({ href, ...props }: any, ref: any) { return href ? <Link ref={ref} href={href} {...props} /> : <div ref={ref} {...props} />; }));

const variantConfig = [{ name: 'default', label: 'Promo', x: 0, y: 0, isPrimary: true }];

function Promo({ style, initialVariant = 'default', linkHref = '', ...rest }: { style?: React.CSSProperties; initialVariant?: string; linkHref?: string; [key: string]: any }) {
  useEffect(() => {
    const el = document.querySelector('[data-id="promo-root"]');
    if (!el) return;
    const onKey = () => {};
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return <LayoutGroup>
    <MotionLink layout={true} data-id="promo-root" href={linkHref} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Promo" style={{ display: 'flex', alignItems: 'flex-end', width: '300px', height: '160px', padding: '16px', backgroundColor: '#97cffc', textDecoration: 'none', ...style }}>
      <motion.p layout={true} data-id="promo-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Promo</motion.p>
    </MotionLink>
  </LayoutGroup>;
}
export default withResponsiveProps(Promo);
`;

/** CMP-057: the root is rotated through its variants (default 14.4°, variant-1 30°). */
export const ROTATED_MASTER = `'use client';

/** @name "Card" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tilted', x: 600, y: 0 },
];

const cardRootVariants = {
  default: { rotate: 14.4 },
  'variant-1': { rotate: 30 },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '200px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-dot" data-name="Dot" style={{ position: 'relative', width: '24px', height: '24px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '0' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-060: a 1280px-wide, auto-height root holding a 70×70 avatar. */
export const WIDE_MASTER = `'use client';

/** @name "Wide" */

${MASTER_IMPORTS}

const variantConfig = [{ name: 'default', label: 'Wide', x: 0, y: 0, isPrimary: true }];

function Wide({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="wide-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Wide" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '1280px', height: 'auto', padding: '40px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="wide-avatar" data-name="Avatar" style={{ position: 'relative', width: '70px', height: '70px', borderRadius: '35px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '0' }} />
      <motion.p layout={true} data-id="wide-text" data-name="Text" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>A wide component with an avatar</motion.p>
      <motion.div layout={true} data-id="wide-block" data-name="Block" style={{ position: 'relative', width: '100%', height: '480px', backgroundColor: '#1a1a3a', flex: '0 0 auto', order: '2' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Wide);
`;

/** CMP-066: a 4000px-tall master reading a translation (the project has
 *  next-intl providers + messages). */
export const TALL_MASTER = `'use client';

/** @name "Tall" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import { useTranslations } from 'next-intl';

const variantConfig = [{ name: 'default', label: 'Tall', x: 0, y: 0, isPrimary: true }];

function Tall({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const t = useTranslations('tall');
  return <LayoutGroup>
    <motion.div layout={true} data-id="tall-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Tall" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '600px', height: '4000px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="tall-top" data-name="Top" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{t('top')}</motion.p>
      <motion.p layout={true} data-id="tall-bottom" data-name="Bottom" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '1' }}>Bottom</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Tall);
`;

export const I18N_FILES: Record<string, string> = {
  'i18n/config.json': JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] }, null, 2),
  'messages/en.json': JSON.stringify({ tall: { top: 'Top of tall' } }, null, 2),
  'messages/fr.json': JSON.stringify({ tall: { top: 'Haut' } }, null, 2),
};

/** Rotation (deg, 1 decimal) of a canvas node's computed transform (0 when none). */
export async function angleOf(editor: Editor, nodeId: string): Promise<number> {
  const loc = editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  if ((await loc.count()) === 0) return NaN;
  const t = await loc.evaluate(el => getComputedStyle(el).transform);
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  return Math.round(Math.atan2(b, a) * 1800 / Math.PI) / 10;
}

/** Select a node by a real click at a fraction of its box (no double-click window). */
export async function clickAt(editor: Editor, id: string, fx = 0.5, fy = 0.5, vpId?: string): Promise<void> {
  const page = editor.page();
  await page.waitForTimeout(450);
  const p = await editor.at(id, fx, fy, vpId);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await editor.settled();
}

// ─── Default variant + canvas expansion seeds (CMP-223 … 227) ────────

/** CMP-223: a FormSubmit-like master whose fill lives ONLY in rootVariants.default. */
export const SUBMIT_MASTER = `'use client';

/** @name "Submit" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Idle', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Sending', x: 300, y: 0 },
];

const submitRootVariants = {
  default: { backgroundColor: '#3b82f6', color: '#ffffff' },
  'variant-1': { opacity: 0.6 },
};

function Submit({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.button layout={true} data-id="submit-root" variants={submitRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Submit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '200px', height: '48px', border: 'none', ...style }}>
      <motion.span layout={true} data-id="submit-label" data-name="Label" style={{ position: 'relative', fontSize: '16px', flex: '0 0 auto', order: '0' }}>Send</motion.span>
    </motion.button>
  </LayoutGroup>;
}
export default withResponsiveProps(Submit);
`;

export const SUBMIT_SEED: ProjectData = project()
  .pageSource(`'use client';

${ONE_TILE}

import React, { useState } from 'react';
import Submit from '@/components/Submit';

export default function Page() {
  const [status, setStatus] = useState('idle');
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
      <Submit data-id="submit-a" data-name="Submit" initialVariant={status === 'sending' ? 'variant-1' : 'default'} onClick={() => setStatus('sending')} style={{ position: 'relative', flex: '0 0 auto' }} />
      <Submit data-id="submit-b" data-name="Submit" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto' }} />
    </div>
  );
}
`)
  .component('Submit', SUBMIT_MASTER)
  .build();

/** CMP-224: a Button whose variant-3 text is a conditional and whose fill is a variants entry. */
export const BUTTON4_MASTER = `'use client';

/** @name "Button" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Primary', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Ghost', x: 260, y: 0 },
  { name: 'variant-2', label: 'Dark', x: 520, y: 0 },
  { name: 'variant-3', label: 'Contact', x: 780, y: 0 },
];

const btnRootVariants = {
  default: { backgroundColor: '#ff2d75' },
  'variant-1': { backgroundColor: '#ffffff' },
  'variant-2': { backgroundColor: '#111111' },
  'variant-3': { backgroundColor: '#00aa66' },
};

function Button({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="btn-root" variants={btnRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '200px', height: '48px', backgroundColor: '#ff2d75', ...style }}>
      <motion.p layout={true} data-id="btn-text" data-name="Label" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{initialVariant === 'variant-3' ? 'REACH OUT' : 'Click'}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Button);
`;

export const BTN_HEADER_MASTER = `'use client';

/** @name "Header" */

${MASTER_IMPORTS}
import Button from '@/components/Button';

const variantConfig = [{ name: 'default', label: 'Header', x: 0, y: 0, isPrimary: true }];

function Header({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="hdr-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Header" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '520px', height: '96px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <Button data-id="hdr-btn" data-name="Button" initialVariant="variant-3" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Header);
`;

export const BUTTON4_SEED: ProjectData = project()
  .pageSource(pageClient(pageRoot(`
${inst('Button', 'btn-a', 'initialVariant="variant-3"')}
${inst('Header', 'hdr-a')}`), { imports: [`import Button from '@/components/Button';`, `import Header from '@/components/Header';`] }))
  .component('Button', BUTTON4_MASTER)
  .component('Header', BTN_HEADER_MASTER)
  .build();

/** CMP-225: width lives both inline and in the default entry. */
export const SYNCED_WIDTH_MASTER = `'use client';

/** @name "Card" */

${MASTER_IMPORTS}

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Narrow', x: 500, y: 0 },
];

const cardRootVariants = {
  default: { width: '300px', backgroundColor: '#97cffc' },
  'variant-1': { width: '200px', backgroundColor: '#ff2d75' },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Synced</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-227: twenty Card instances on one page (small, wrapping, all on screen). */
export function twentyCardsSeed(): ProjectData {
  const cards = Array.from({ length: 20 }, (_, i) => inst('Card', `card-${i + 1}`, '', `position: 'relative', width: '160px', height: '110px', flex: '0 0 auto'`)).join('\n');
  return project()
    .pageSource(pageClient(`<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start', gap: '16px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
${cards.split('\n').map(l => '  ' + l).join('\n')}
</div>`, { imports: [CARD_IMPORT] }))
    .component('Card', CARD_MASTER)
    .build();
}
