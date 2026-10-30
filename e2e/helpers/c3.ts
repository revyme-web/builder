// C3 lane helpers — design components: instance props and overrides
// (E2E_TEST_PLAN.md §8, CMP-067…CMP-100).
//
// Seeds are written in the builder's own dialect: `variantConfig`,
// `withResponsiveProps`, motion.* children, typed props declared in the
// function signature + `@propMeta`, instances on the page with their import.
// Expanded instance children render on the canvas as `<instanceId>:<childId>`
// (`card-a:card-title`), prefixed per replica tile (`tablet-card-a:card-title`).

import type { Locator, Page } from '@playwright/test';
import { parse } from '@babel/parser';
import type { Editor } from './editor';
import { project, canvasHeader, type ProjectData, type Tile } from '../fixtures/project';

// ─── Panel helpers ───────────────────────────────────────────────────

export function panel(page: Page): Locator {
  return page.locator('[data-properties-panel]');
}

/** A Component Props row (label + control) by its visible label. */
export function propRow(page: Page, label: string): Locator {
  return panel(page)
    .getByText(label, { exact: true })
    .first()
    // Plain rows are `flex justify-between`; rich-atom rows (colour, image,
    // border, shadow, transition) are a two-column `grid`.
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " justify-between ") or contains(@class, "grid-cols-")][1]');
}

/** The label element of a Component Props row (its className carries the accent). */
export function propLabel(page: Page, label: string): Locator {
  return panel(page).getByText(label, { exact: true }).first();
}

/** Type into a text row's input and commit with Enter. */
export async function typeInRow(page: Page, label: string, value: string): Promise<void> {
  const input = propRow(page, label).locator('input').first();
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.fill(value);
  await input.press('Enter');
}

/** Text a canvas node paints (expanded instance children are `<inst>:<child>`). */
export async function canvasText(editor: Editor, nodeId: string, vpId?: string): Promise<string> {
  const loc = vpId ? await editor.nodeIn(vpId, nodeId) : editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  return (await loc.textContent()) ?? '';
}

/** A computed style of a canvas node (read inside the sandbox frame). */
export async function canvasStyle(editor: Editor, nodeId: string, prop: string, vpId?: string): Promise<string> {
  const loc = vpId ? await editor.nodeIn(vpId, nodeId) : editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

/** The JSX opening tag of an element by data-id (raw source text, via Babel —
 *  a formatted-text prop's markup can hold `<`/`>` before the data-id). */
export function openingTag(code: string, dataId: string): string {
  let ast: any;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });
  } catch { return ''; }
  let found = '';
  const visit = (n: any): void => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === 'JSXOpeningElement') {
      for (const a of n.attributes ?? []) {
        if (a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === dataId) {
          found = code.slice(n.start, n.end);
          return;
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
      visit(n[k]);
    }
  };
  visit(ast);
  return found;
}

export async function pollCode(editor: Editor, path: string, predicate: (code: string) => boolean, timeout = 5_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let code = await editor.code(path);
  while (!predicate(code) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    code = await editor.code(path);
  }
  return code;
}

// ─── Seeds ───────────────────────────────────────────────────────────

export const PAGE = 'app/page.client.tsx';
export const CARD = 'components/Card.tsx';
const CARD_IMPORT = `import Card from '@/components/Card';`;

export const IMG_DEFAULT = 'https://images.unsplash.com/photo-1545897398-2aba891843b6?w=800';

/** INSTANCE_PROPS_ALL_TYPES — one prop of every typed-variable kind, each bound
 *  to a child of the Card master, with `@propMeta`; two instances on the page. */
export const ALL_TYPES_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"title":{"type":"plainText","label":"Title"},"iconVisible":{"type":"toggle","label":"Icon Visible"},"count":{"type":"number","label":"Count","min":0,"max":10,"step":1,"control":"slider"},"size":{"type":"option","label":"Size","options":["8px","16px","32px"]},"bg":{"type":"color","label":"Bg"},"image":{"type":"image","label":"Image"},"border":{"type":"border","label":"Border"},"shadow":{"type":"shadow","label":"Shadow"},"linkHref":{"type":"link","label":"Link"},"newTab":{"type":"toggle","label":"New Tab"},"content":{"type":"formattedText","label":"Content"},"transition":{"type":"transition","label":"Transition"}} */

import React from 'react';
import Link from 'next/link';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(React.forwardRef(function MotionLinkBase({ href, ...props }: any, ref: any) { return href ? <Link ref={ref} href={href} {...props} /> : <div ref={ref} {...props} />; }));

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', title = 'Card title', iconVisible = true, count = 3, size = '8px', bg = '#97cffc', image = 'url(${IMG_DEFAULT})', border = '1px solid #000000', shadow = '0px 4px 8px rgba(0, 0, 0, 0.25)', linkHref = '', newTab = false, content = 'Plain words here', transition = {}, ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; iconVisible?: boolean; count?: number; size?: string; bg?: string; image?: string; border?: string; shadow?: string; linkHref?: string; newTab?: boolean; content?: string; transition?: any; [key: string]: any }) {
  return <LayoutGroup><MotionConfig transition={transition}>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: 'auto', padding: size, backgroundColor: bg, borderRadius: '12px', border: border, boxShadow: shadow, ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{title}</motion.p>
      <motion.div layout={true} data-id="card-icon" data-name="Icon" style={{ position: 'relative', width: '24px', height: '24px', backgroundColor: '#000000', flex: '0 0 auto', order: '1', display: iconVisible ? 'block' : 'none' }} />
      <motion.p layout={true} data-id="card-count" data-name="Count" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '2' }}>{count}</motion.p>
      <motion.div layout={true} data-id="card-media" data-name="Media" style={{ position: 'relative', width: '100%', height: '80px', backgroundImage: image, backgroundSize: 'cover', backgroundPosition: 'center', flex: '0 0 auto', order: '3' }} />
      <motion.p layout={true} data-id="card-rich" data-name="Rich" dangerouslySetInnerHTML={{ __html: content }} style={{ position: 'relative', fontSize: '14px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '4' }} />
      <MotionLink layout={true} data-id="card-link" data-name="Link" href={linkHref} target={newTab ? '_blank' : undefined} style={{ position: 'relative', fontSize: '14px', color: '#000000', flex: '0 0 auto', order: '5' }}>Read more</MotionLink>
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export function twoInstancePage(attrsA = '', attrsB = ''): string {
  return `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Card data-id="card-a" data-name="Card A"${attrsA ? ' ' + attrsA : ''} style={{ position: 'relative', flex: '0 0 auto' }} />
  <Card data-id="card-b" data-name="Card B"${attrsB ? ' ' + attrsB : ''} style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`;
}

/** The builder's own one-tile `@canvas` shape. The shared `canvasHeader()`
 *  writes a bare `{id, width}` for one tile, which the editor reads as a
 *  NON-primary tile (isReplicaViewportAtom = !vp.isPrimary), so every
 *  instance-prop write on it was routed into `data-responsive` (HARNESS). */
export const ONE_TILE_HEADER = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;

/** A whole `page.client.tsx` around one root element (full @canvas header). */
export function pageModuleC3(rootJsx: string, opts: { tiles?: Tile[]; imports?: string[]; preamble?: string } = {}): string {
  const header = !opts.tiles || opts.tiles.length === 1 ? ONE_TILE_HEADER : canvasHeader(opts.tiles);
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  const body = rootJsx.trim().split('\n').map(l => (l ? '    ' + l : l)).join('\n');
  return `'use client';

${header}

import React from 'react';
${imports}${opts.preamble ?? ''}
export default function Page() {
  return (
${body}
  );
}
`;
}

export function seedWithCard(cardSource: string, pageJsx: string = twoInstancePage(), opts: { tiles?: Tile[]; extraImports?: string[] } = {}): ProjectData {
  return project()
    .pageSource(pageModuleC3(pageJsx, { imports: [CARD_IMPORT, ...(opts.extraImports ?? [])], tiles: opts.tiles }))
    .component('Card', cardSource)
    .build();
}

export const INSTANCE_PROPS_ALL_TYPES = seedWithCard(ALL_TYPES_CARD);

// ─── Preview (:5175) ─────────────────────────────────────────────────

/** Open the editor's preview overlay and return its frame once `ready` finds content. */
export async function openPreview(page: Page, ready: string): Promise<import('@playwright/test').FrameLocator> {
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 30_000 });
  return frame;
}

/** A two-variant master with hover/pressed interaction states (`connections`),
 *  per-variant root styles AND per-variant text. */
export const VARIANT_CARD = `'use client';

/** @name "Card" */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 300, interactionType: 'hover', parentVariant: 'default' },
  { name: 'default-pressed', label: 'Default - Pressed', x: 0, y: 600, interactionType: 'pressed', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter', sourceNode: 'card-root' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave', sourceNode: 'card-root' },
  { from: 'default-hover', to: 'default-pressed', trigger: 'clickStart', sourceNode: 'card-root' },
  { from: 'default-pressed', to: 'default-hover', trigger: 'click', sourceNode: 'card-root' },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' },
  'default-hover': { backgroundColor: '#5aa9f0' },
  'default-pressed': { backgroundColor: '#3b82f6' },
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-name="Card"
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)}
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onTapStart={() => setVariant(variant === 'default-hover' ? 'default-pressed' : variant)}
      onTap={() => setVariant(variant === 'default-pressed' ? 'default-hover' : variant)}
      style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', borderRadius: '12px', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{variant === 'variant-1' ? 'Hover copy' : 'Resting copy'}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export const MASTER_STATES = seedWithCard(VARIANT_CARD);

/** `app/globals.css` with one colour preset (`--color-brand`). */
export const GLOBALS_WITH_BRAND = `/* Design Tokens — Presets */
:root {
  /* Colors */
  --color-brand: #ff2d75;
}
`;

/** A 1×1 PNG for the Media modal's Upload input. */
export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The canvas background colour of a node as `#rrggbb`. */
export async function canvasBgHex(editor: Editor, nodeId: string): Promise<string> {
  const rgb = await canvasStyle(editor, nodeId, 'background-color');
  const m = rgb.match(/\d+/g) ?? [];
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

/** A copy of a seed with extra files (another route, globals.css, messages…). */
export function withFiles(seed: ProjectData, files: Record<string, string>): ProjectData {
  return { format: 'revyme-v1', files: { ...seed.files, ...files } };
}

/** A plain extra page at `app/<route>/` (server wrapper + client module). */
export function extraPage(route: string, rootJsx: string): Record<string, string> {
  const p = project().pageSource(pageModuleC3(rootJsx), { route }).build();
  return p.files;
}

/** Close the topmost ToolPopup with its header × (Escape would also deselect the node). */
export async function closePopup(page: Page): Promise<void> {
  const popups = page.locator('[data-tool-popup]');
  const n = await popups.count();
  if (n === 0) return;
  await popups.nth(n - 1).locator('div.cursor-grab > button').last().click();
  await expect_(async () => (await popups.count()) < n);
}

async function expect_(cond: () => Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await cond()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
}

/** Double-click one word inside an element (real mouse, at the word's own rect). */
export async function dblclickWord(page: Page, within: Locator, word: string): Promise<void> {
  const pt = await within.evaluate((root, w) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, word);
  if (!pt) throw new Error(`word "${word}" not found`);
  await page.mouse.dblclick(pt.x, pt.y);
}

/** `editor.load` with a longer first-paint budget. On this loaded machine the
 *  sandbox sometimes needs more than the harness's 30s to stamp
 *  `[data-content-root]`; when that wait times out we keep waiting (up to 90s
 *  total) and finish the load bookkeeping the same way `Editor.load` does
 *  (HARNESS workaround — `waitForCanvas` is not configurable). */
export async function loadC3(editor: Editor, seed: ProjectData, opts: { fit?: boolean } = {}): Promise<void> {
  try {
    await editor.load(seed, opts);
    return;
  } catch (e) {
    if (!/waitFor|Timeout/i.test(String(e))) throw e;
  }
  const sandbox = editor.sandbox();
  await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached', timeout: 30_000 });
  await editor.settled();
  if (opts.fit) await editor.fitCamera();
  const ed = editor as any;
  ed.baseline = await editor.snapshotFiles();
  for (const path of Object.keys(ed.baseline)) {
    if (!path.endsWith('.tsx')) continue;
    ed.baselineViolations.set(path, new Set((await editor.oracle(path)).map((v: any) => `${v.code}|${v.elementId ?? ''}`)));
  }
}

// ─── Seeds: parser/registry regressions ──────────────────────────────

/** CMP-086 — a default with an escaped apostrophe followed by more props. */
export const APOSTROPHE_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"bTText":{"type":"plainText","label":"Button Text"},"fontSize":{"type":"number","label":"Font Size"},"iconVisible":{"type":"toggle","label":"Icon Visible"},"iconColor":{"type":"color","label":"Icon Color"},"iconColor2":{"type":"color","label":"Icon Color 2"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', bTText = 'Let\\'s get your cargo', fontSize = 16, iconVisible = true, iconColor = '#ffffff', iconColor2 = '#000000', ...rest }: { style?: React.CSSProperties; initialVariant?: string; bTText?: string; fontSize?: number; iconVisible?: boolean; iconColor?: string; iconColor2?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'row', gap: '12px', width: '320px', height: 'auto', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: fontSize, color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{bTText}</motion.p>
      <motion.div layout={true} data-id="card-icon" data-name="Icon" style={{ position: 'relative', width: '24px', height: '24px', backgroundColor: iconColor, flex: '0 0 auto', order: '1', display: iconVisible ? 'block' : 'none' }} />
      <motion.div layout={true} data-id="card-icon2" data-name="Icon 2" style={{ position: 'relative', width: '24px', height: '24px', backgroundColor: iconColor2, flex: '0 0 auto', order: '2' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-087 — a master exported through React.forwardRef, a style bound to a defaulted prop. */
export const FORWARD_REF_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

const Card = React.forwardRef(function Card({ style, initialVariant = 'default', tone = '#ff2d75', ...rest }: { style?: React.CSSProperties; initialVariant?: string; tone?: string; [key: string]: any }, ref: any) {
  return <LayoutGroup>
    <motion.div ref={ref} layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '120px', padding: '16px', backgroundColor: tone, ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Wrapped</motion.p>
    </motion.div>
  </LayoutGroup>;
});
export default withResponsiveProps(Card);
`;

/** CMP-097 — a number prop `end` forwarded into a code component, beside an
 *  alignItems variant ternary whose strings contain "end" ('flex-end'). */
export const NUMBER_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import AnimatedNumber from '@/components/AnimatedNumber';

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'v1', label: 'Right', x: 500, y: 0 },
];

function Card({ style, initialVariant = 'default', end = 12, ...rest }: { style?: React.CSSProperties; initialVariant?: string; end?: number; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', alignItems: initialVariant === 'v1' ? 'flex-end' : 'flex-start', width: '300px', height: '120px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <AnimatedNumber data-id="card-number" data-name="Number" end={end} style={{ position: 'relative', width: '120px', height: '40px', flex: '0 0 auto', order: '0' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export const ANIMATED_NUMBER = `'use client';
/** @label "Animated Number" */
/** @comment "Counts up to a number" */
/** @defaultWidth 120 */
/** @defaultHeight 40 */
/** @controls {
  "end": { "type": "number", "label": "End", "default": 12, "min": 0, "max": 1000, "step": 1 }
} */
import { withResponsiveProps } from '@revyme/runtime';
function AnimatedNumber({ end = 12, ...props }: { end?: number; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', fontSize: '24px', color: '#000000', ...props.style }}>{end}</div>;
}
export default withResponsiveProps(AnimatedNumber);
`;

/** CMP-098 — a prop consumed only through an SVG presentation attribute. */
export const SVG_ICON_CARD = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', iconColor = '#ff2d75', ...rest }: { style?: React.CSSProperties; initialVariant?: string; iconColor?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'row', width: '300px', height: '80px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <svg data-id="card-svg" data-name="Icon" viewBox="0 0 24 24" style={{ '--c1': iconColor, position: 'relative', width: '24px', height: '24px', flex: '0 0 auto', order: '0' }}>
        <path data-id="card-svg-path" d="M2 2 L22 2 L22 22 L2 22 Z" fill="var(--c1)" />
      </svg>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

// ─── Seeds: per-tile instance props ──────────────────────────────────

/** CMP-093 — a style-driving `direction` prop (flexDirection). */
export const DIRECTION_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"direction":{"type":"option","label":"Direction","options":["row","column"],"optionsLocked":true}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', direction = 'row', ...rest }: { style?: React.CSSProperties; initialVariant?: string; direction?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: direction, gap: '8px', width: '300px', height: 'auto', padding: '12px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-a1" data-name="A" style={{ position: 'relative', width: '40px', height: '40px', backgroundColor: '#000000', flex: '0 0 auto', order: '0' }} />
      <motion.div layout={true} data-id="card-a2" data-name="B" style={{ position: 'relative', width: '40px', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export const TEAM_CMS = {
  'cms/team.schema.json': JSON.stringify({ slug: 'team', name: 'Team', fields: [{ id: 'name', name: 'Name', type: 'text' }] }),
  'cms/team.json': JSON.stringify([
    { _id: 'i1', _slug: 'john', _status: 'published', name: 'John Doe' },
    { _id: 'i2', _slug: 'jane', _status: 'published', name: 'Jane Roe' },
    { _id: 'i3', _slug: 'max', _status: 'published', name: 'Max Mustermann' },
  ]),
};

export const DIRECTION_LIST_PAGE = `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <div data-id="list" data-name="List" data-collection-list="team" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', position: 'relative', flex: '0 0 auto' }}>
    {team.map((item, idx) => (
      <Card data-id="row-card" data-name="Row" key={idx} style={{ position: 'relative', flex: '0 0 auto' }} />
    ))}
  </div>
</div>`;

/** Click a row label (opens its menu), click "Reset Override" from inside the
 *  page and time how long the label keeps its accent, frame by frame. */
export async function resetOverrideLatency(page: Page, label: string): Promise<number> {
  await panel(page).getByText(label, { exact: true }).first().click();
  await page.getByText('Reset Override', { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
  return page.evaluate((lbl) => new Promise<number>((resolve) => {
    const leafByText = (root: ParentNode, text: string): HTMLElement | null => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        if (el.childElementCount === 0 && el.textContent?.trim() === text) return el;
      }
      return null;
    };
    const item = leafByText(document, 'Reset Override');
    if (!item) { resolve(-1); return; }
    const panelEl = document.querySelector('[data-properties-panel]')!;
    const accented = () => leafByText(panelEl, lbl)?.className.includes('accent-text') ?? false;
    const t0 = performance.now();
    item.click();
    const tick = () => {
      const dt = performance.now() - t0;
      if (!accented() || dt > 4000) { resolve(dt); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), label);
}

/** CMP-092 — two variants + a plain-text prop (per-tile overrides of both). */
export const TITLE_VARIANT_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"title":{"type":"plainText","label":"Title"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];

const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#ff2d75' },
};

function Card({ style, initialVariant = 'default', title = 'Card title', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '120px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{title}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** Type a width into the preview overlay's W field (Enter commits) and wait
 *  until the preview document reports that viewport width. */
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

// ─── Seeds: tag writer, sections, overlay border, nested variables ────

/** CMP-089 — a CODE component whose file/import/tag name (ZaPoKa) differs
 *  from its registry name (the internal function, CurvedCorner). */
export const CURVED_CORNER = `'use client';
/** @label "Curved Corner" */
/** @comment "A box with one rounded corner" */
/** @defaultWidth 200 */
/** @defaultHeight 80 */
/** @controls {
  "corner": { "type": "text", "label": "Corner", "default": "top-left" }
} */
import { withResponsiveProps } from '@revyme/runtime';
function CurvedCorner({ corner = 'top-left', ...props }: { corner?: string; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', width: '200px', height: '80px', background: '#97cffc', borderRadius: corner === 'bottom-right' ? '0 0 24px 0' : '24px 0 0 0', ...props.style }}>{corner}</div>;
}
export default withResponsiveProps(CurvedCorner);
`;

export const ZAPOKA_SEED: ProjectData = project()
  .pageSource(pageModuleC3(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <div data-id="top" data-name="Top" style={{ position: 'relative', width: '300px', height: '120px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
  <ZaPoKa data-id="corner-a" data-name="Corner" style={{ position: 'relative', width: '200px', height: '80px', flex: '0 0 auto' }} />
</div>`, { imports: [`import ZaPoKa from '@/components/ZaPoKa';`] }))
  .component('ZaPoKa', CURVED_CORNER)
  .build();

/** CMP-095 — a Section variable (the instance picks an anchor of its page). */
export const SECTION_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"section":{"type":"section","label":"Section"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', section = '', ...rest }: { style?: React.CSSProperties; initialVariant?: string; section?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" data-scroll-section={section} style={{ display: 'flex', width: '300px', height: '80px', padding: '12px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Jump</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-094 — the root's border is an ::after overlay reading a custom property bound to a prop. */
export const OVERLAY_BORDER_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"ring":{"type":"border","label":"Ring"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', ring = '2px solid #000000', ...rest }: { style?: React.CSSProperties; initialVariant?: string; ring?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ '--b1': ring, display: 'flex', width: '300px', height: '100px', padding: '12px', backgroundColor: '#97cffc', ...style }}>
      <style>{\`[data-id="card-root"]::after { content: ''; position: absolute; inset: 0; border: var(--b1); border-radius: inherit; pointer-events: none; }\`}</style>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Ringed</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** CMP-096 — Pricing master: a nested Price instance bound per variant to master variables. */
export const PRICE_MASTER = `'use client';

/** @name "Price" */
/** @propMeta {"value":{"type":"plainText","label":"Value"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Price', x: 0, y: 0, isPrimary: true }];

function Price({ style, initialVariant = 'default', value = '$0', ...rest }: { style?: React.CSSProperties; initialVariant?: string; value?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="price-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Price" style={{ display: 'flex', width: '160px', height: '48px', padding: '8px', backgroundColor: '#ffffff', ...style }}>
      <motion.p layout={true} data-id="price-text" data-name="Value" style={{ position: 'relative', fontSize: '24px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>{value}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Price);
`;

export const PRICING_MASTER = `'use client';

/** @name "Pricing" */
/** @propMeta {"priceMonthly":{"type":"plainText","label":"Price Monthly"},"priceYearly":{"type":"plainText","label":"Price Yearly"}} */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Price from '@/components/Price';

const variantConfig = [
  { name: 'default', label: 'Monthly', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Yearly', x: 500, y: 0 },
];

function Pricing({ style, initialVariant = 'default', priceMonthly = '$10', priceYearly = '$100', ...rest }: { style?: React.CSSProperties; initialVariant?: string; priceMonthly?: string; priceYearly?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="pricing-root" initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-name="Pricing" style={{ display: 'flex', flexDirection: 'column', width: '300px', height: '160px', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <Price data-id="pricing-price" data-name="Price" value={variant === 'variant-1' ? priceYearly : priceMonthly} style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Pricing);
`;

export const PRICING_SEED: ProjectData = project()
  .pageSource(pageModuleC3(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Pricing data-id="pricing-a" data-name="Pricing" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`, { imports: [`import Pricing from '@/components/Pricing';`] }))
  .component('Price', PRICE_MASTER)
  .component('Pricing', PRICING_MASTER)
  .build();

// ─── Seeds: nested masters (Header imports Button) ───────────────────

export const BUTTON_MASTER = `'use client';

/** @name "Button" */
/** @propMeta {"title":{"type":"plainText","label":"Title"},"fill":{"type":"color","label":"Fill"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Primary', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Ghost', x: 300, y: 0 },
];

const btnRootVariants = {
  default: { backgroundColor: '#ff2d75' },
  'variant-1': { backgroundColor: '#ffffff' },
};

function Button({ style, initialVariant = 'default', title = 'Click', fill = '#000000', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; fill?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="btn-root" variants={btnRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '48px', backgroundColor: '#ff2d75', borderRadius: '24px', ...style }}>
      <motion.p layout={true} data-id="btn-text" data-name="Label" style={{ position: 'relative', fontSize: '16px', color: fill, margin: '0px', flex: '0 0 auto', order: '0' }}>{title}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Button);
`;

export const HEADER_MASTER = `'use client';

/** @name "Header" */
/** @propMeta {"heading":{"type":"plainText","label":"Heading"},"accent":{"type":"color","label":"Accent"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Button from '@/components/Button';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Dark', x: 560, y: 0 },
  { name: 'variant-6', label: 'Six', x: 1120, y: 0 },
];

const headerRootVariants = {
  default: { backgroundColor: '#97cffc' },
  'variant-1': { backgroundColor: '#1a1a3a' },
  'variant-6': { backgroundColor: '#ffd166' },
};

function Header({ style, initialVariant = 'default', heading = 'Welcome', accent = '#00ff88', ...rest }: { style?: React.CSSProperties; initialVariant?: string; heading?: string; accent?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="header-root" variants={headerRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Header" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '480px', height: '96px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="header-heading" data-name="Heading" style={{ position: 'relative', fontSize: '20px', color: accent, margin: '0px', flex: '0 0 auto', order: '0' }}>{heading}</motion.p>
      <Button data-id="header-btn" data-name="Button" title="A" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Header);
`;

export const NESTED_MASTERS: ProjectData = project()
  .pageSource(pageModuleC3(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Header data-id="header-a" data-name="Header" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`, { imports: [`import Header from '@/components/Header';`] }))
  .component('Button', BUTTON_MASTER)
  .component('Header', HEADER_MASTER)
  .build();

export const HEADER = 'components/Header.tsx';

/** CMP-079 — a master prop typed as the VARIANT of its nested Button. */
export const NAV_MASTER = `'use client';

/** @name "Nav" */
/** @propMeta {"btnVariant":{"label":"Button Variant","variantOf":"Button"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Button from '@/components/Button';

const variantConfig = [{ name: 'default', label: 'Nav', x: 0, y: 0, isPrimary: true }];

function Nav({ style, initialVariant = 'default', btnVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; btnVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="nav-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Nav" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', width: '400px', height: '80px', padding: '16px', backgroundColor: '#1a1a3a', ...style }}>
      <Button data-id="nav-btn" data-name="Button" initialVariant={btnVariant} title="Go" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Nav);
`;

export const NAV_SEED: ProjectData = project()
  .pageSource(pageModuleC3(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Nav data-id="nav-a" data-name="Nav" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`, { imports: [`import Nav from '@/components/Nav';`] }))
  .component('Button', BUTTON_MASTER)
  .component('Nav', NAV_MASTER)
  .build();

/** Click a node once its box has stopped moving (the fit-camera animation can
 *  still be running on a loaded machine, and a click on a stale box lands on
 *  another tile — or another node). */
export async function clickStable(editor: Editor, id: string, vpId?: string): Promise<void> {
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
  await editor.click(id, { vpId });
}

// ─── Seeds: component cursor variable (CMP-078 / CMP-088) ────────────

export const POINTER_MASTER = `'use client';

/** @name "Pointer" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'brand', label: 'Brand', x: 200, y: 0 },
  { name: 'motion', label: 'Motion', x: 400, y: 0 },
];

const pointerRootVariants = {
  default: { backgroundColor: '#ffffff' },
  brand: { backgroundColor: '#ff2d75' },
  motion: { backgroundColor: '#00ff88' },
};

function Pointer({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="pointer-root" variants={pointerRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Pointer" style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: '#ffffff', ...style }} />
  </LayoutGroup>;
}
export default withResponsiveProps(Pointer);
`;

export const CURSOR_CARD = `'use client';

/** @name "Card" */
/** @pageVariables {"variables":[{"name":"cursor","type":"componentCursor","default":""}]} */
/** @propMeta {"cursor":{"type":"componentCursor","label":"cursor"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps, withCursor } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', cursor = () => null, ...rest }: { style?: React.CSSProperties; initialVariant?: string; cursor?: any; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" {...withCursor(cursor, { mode: 'follow' })} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', width: '300px', height: '100px', padding: '12px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Hover me</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

export function cursorSeed(attrsA = 'cursor={Pointer}', attrsB = 'cursor={Pointer}'): ProjectData {
  return project()
    .pageSource(pageModuleC3(twoInstancePage(attrsA, attrsB), { imports: [`import Card from '@/components/Card';`, `import Pointer from '@/components/Pointer';`] }))
    .component('Card', CURSOR_CARD)
    .component('Pointer', POINTER_MASTER)
    .build();
}

/** CMP-088 — the cursor master forwards per-instance opts; instance A carries
 *  nested-object opts and an arrow-function prop with a `>` in it. */
export function cursorOptsSeed(): ProjectData {
  const master = CURSOR_CARD
    .replace('cursor = () => null, ...rest', 'cursor = () => null, cursorOpts = {}, ...rest')
    .replace("withCursor(cursor, { mode: 'follow' })", "withCursor(cursor, { mode: 'follow', ...cursorOpts })");
  return project()
    .pageSource(pageModuleC3(twoInstancePage(`cursor={Pointer} cursorOpts={{"mode":"follow","transition":{"type":"spring"}}} onPick={() => 2 > 1}`, 'cursor={Pointer}'), { imports: [`import Card from '@/components/Card';`, `import Pointer from '@/components/Pointer';`] }))
    .component('Card', master)
    .component('Pointer', POINTER_MASTER)
    .build();
}

/** CMP-100 — a CDN-linked, closed-source instance (source 403, interface in the metadata). */
export const CDN_HASH = 'abc123def456';
export const CDN_URL = `https://assets.revyme.app/components/Promo@${CDN_HASH}.js`;
export const CDN_INTERFACE = `'use client';
/** @name "Promo" */
/** @propMeta {"headline":{"type":"plainText","label":"Headline"}} */
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Bold', x: 400, y: 0 },
];
function Promo({ style, initialVariant = 'default', headline = 'Hello', ...rest }: { style?: any; initialVariant?: string; headline?: string; [key: string]: any }) {}
export default withResponsiveProps(Promo);
`;
export const CDN_SEED: ProjectData = project()
  .pageSource(pageModuleC3(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Promo data-id="promo-a" data-name="Promo" style={{ position: 'relative', width: '300px', height: '120px', flex: '0 0 auto' }} />
</div>`, { imports: [`import Promo from '${CDN_URL}';`] }))
  .build();

// ─── Seeds: component events (CMP-080) ───────────────────────────────

export const EVENT_CARD = `'use client';

/** @name "Card" */
/** @propMeta {"childtrigger1":{"type":"event","label":"Child Trigger 1"}} */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', childtrigger1, ...rest }: { style?: React.CSSProperties; initialVariant?: string; childtrigger1?: () => void; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: 'auto', padding: '16px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Not a trigger</motion.p>
      <motion.div layout={true} data-id="card-cta" data-name="CTA" onClick={childtrigger1} style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#ff2d75', flex: '0 0 auto', order: '1' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

// ─── Seeds: LINK component inside a fixed overlay (CMP-081) ──────────

export const NAVLINK_MASTER = `'use client';

/** @name "Nav Link" */
/** @propMeta {"linkHref":{"type":"link","label":"Link"}} */

import React from 'react';
import Link from 'next/link';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(React.forwardRef(function MotionLinkBase({ href, ...props }: any, ref: any) { return href ? <Link ref={ref} href={href} {...props} /> : <div ref={ref} {...props} />; }));

const variantConfig = [{ name: 'default', label: 'Nav Link', x: 0, y: 0, isPrimary: true }];

function NavLink({ style, initialVariant = 'default', linkHref = '', ...rest }: { style?: React.CSSProperties; initialVariant?: string; linkHref?: string; [key: string]: any }) {
  return <LayoutGroup>
    <MotionLink layout={true} data-id="navlink-root" href={linkHref} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Nav Link" style={{ display: 'flex', alignItems: 'center', width: '200px', height: '48px', padding: '12px', backgroundColor: '#ffffff', textDecoration: 'none', ...style }}>
      <motion.p layout={true} data-id="navlink-text" data-name="Label" style={{ position: 'relative', fontSize: '18px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>HOME</motion.p>
    </MotionLink>
  </LayoutGroup>;
}
export default withResponsiveProps(NavLink);
`;

const OVERLAY_PAGE = `'use client';

${ONE_TILE_HEADER}

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import NavLink from '@/components/NavLink';

export default function Page() {
  const [overlayMenuBtn_1Open, setOverlayMenuBtn_1Open] = useState(false);
  useEffect(() => {
    if (!overlayMenuBtn_1Open) return;
    const overlay = document.querySelector('[data-id="overlay-menu-btn-1"]');
    if (!overlay) return;
    if (overlay && overlay.showPopover) {
      try {
        if (!document.getElementById('rv-overlay-top-layer')) { const s = document.createElement('style'); s.id = 'rv-overlay-top-layer'; s.textContent = ':where([data-overlay][popover]){inset:auto;margin:0;padding:0;border:0;color:inherit;background:none;overflow:visible;width:auto;height:auto}'; document.head.appendChild(s); }
        if (!overlay.matches(':popover-open')) { overlay.setAttribute('popover', 'manual'); overlay.showPopover(); }
      } catch {}
    }
    const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
    if (cfg.fill) overlay.style.backgroundColor = cfg.fill;
    if (cfg.zIndex != null) overlay.style.zIndex = String(cfg.zIndex);
    const onBackdrop = (e) => { if (e.target === overlay && cfg.dismissible !== false) setOverlayMenuBtn_1Open(false); };
    overlay.addEventListener('mousedown', onBackdrop);
    const prevOverflow = document.body.style.overflow;
    if (cfg.pageScroll !== 'auto') document.body.style.overflow = 'hidden';
    return () => {
      overlay.removeEventListener('mousedown', onBackdrop);
      document.body.style.overflow = prevOverflow;
    };
  }, [overlayMenuBtn_1Open]);
  return (
    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
      <div data-id="hero" data-name="Hero" id="hero" style={{ position: 'relative', width: '100%', height: '200px', background: '#1a1a3a', flex: '0 0 auto', order: '0' }}></div>
      <div data-id="menu-btn" data-name="Menu" style={{ position: 'relative', width: '120px', height: '48px', background: '#ff2d75', flex: '0 0 auto', order: '1' }} data-overlay-trigger='{"targetId":"overlay-menu-btn-1","trigger":"click","dismiss":"outside"}' onClick={() => setOverlayMenuBtn_1Open(!overlayMenuBtn_1Open)}></div>
      <AnimatePresence>{overlayMenuBtn_1Open && (
        <motion.div key="overlay-menu-btn-1" data-id="overlay-menu-btn-1" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"menu-btn","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { type: 'tween', duration: 0.3, ease: 'easeOut' } }} transition={{ type: 'tween', duration: 0.3, ease: 'easeIn' }} style={{
        position: 'fixed',
        left: '0',
        top: '0',
        width: '100%',
        height: '100vh',
        zIndex: '100',
        backgroundColor: 'rgba(0, 0, 0, 0.5)'
      }}>
          <NavLink data-id="nav-link" data-name="Nav Link" linkHref="#hero" onClick={() => setOverlayMenuBtn_1Open(false)} style={{ position: 'absolute', left: '40px', top: '40px' }} />
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
`;

export const LINK_IN_OVERLAY: ProjectData = project()
  .pageSource(OVERLAY_PAGE)
  .component('NavLink', NAVLINK_MASTER)
  .build();

/** A file's contents once two reads 300ms apart agree (a commit can land in
 *  several flushes — e.g. the first write also normalises the module header). */
export async function stableCode(editor: Editor, path: string, timeout = 5_000): Promise<string> {
  await editor.settled();
  let prev = await editor.code(path);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const cur = await editor.code(path);
    if (cur === prev) return cur;
    prev = cur;
  }
  return prev;
}
