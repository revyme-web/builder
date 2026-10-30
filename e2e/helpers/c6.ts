// C6 lane helpers: design components — component variables in the master,
// the Library (create / rename / delete / usage / replace) and Detach
// Instance (E2E_TEST_PLAN.md §8, CMP-167…CMP-196).
//
// Seeds are written in the builder's own dialect (`variantConfig`,
// `withResponsiveProps`, motion.* children, `@name`, `@propMeta`), with the
// FULL `@canvas` shape even for one tile (see fullCanvasHeader in c1.ts).

import type { Locator, Page } from '@playwright/test';
import { parse } from '@babel/parser';
import type { Editor } from './editor';
import type { ProjectData } from '../fixtures/project';
import { c1Page, SERVER_WRAPPER, C1_TILES, C1_CMS_FILES, loadMoreSource, rightClickNode, menuItem, type C1Tile } from './c1';

export const PAGE = 'app/page.client.tsx';
export const CARD = 'components/Card.tsx';

// ─── Source helpers ─────────────────────────────────────────────────

type AnyNode = { type: string; start?: number | null; end?: number | null; [k: string]: any };

/** Does `code` parse as TSX with error recovery OFF? */
export function parsesStrict(code: string): boolean {
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    return true;
  } catch {
    return false;
  }
}

function walk(n: unknown, fn: (node: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walk(c, fn, parent); return; }
  const node = n as AnyNode;
  if (typeof node.type === 'string') fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walk(node[k], fn, typeof node.type === 'string' ? node : parent);
  }
}

function astOf(code: string): AnyNode | null {
  try {
    return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as AnyNode;
  } catch {
    return null;
  }
}

function jsxName(n: AnyNode): string {
  if (n.type === 'JSXIdentifier') return String(n.name);
  if (n.type === 'JSXMemberExpression') return `${jsxName(n.object)}.${jsxName(n.property)}`;
  return '?';
}

/** Every JSX opening-tag name in the file (`motion.div`, `Card`, `p`, …). */
export function tagNames(code: string): string[] {
  const out: string[] = [];
  const ast = astOf(code);
  if (!ast) return out;
  walk(ast, (n) => { if (n.type === 'JSXOpeningElement') out.push(jsxName(n.name)); });
  return out;
}

/** Every `data-id` string value in the file, in source order (duplicates kept). */
export function dataIds(code: string): string[] {
  const out: string[] = [];
  const ast = astOf(code);
  if (!ast) return out;
  walk(ast, (n) => {
    if (n.type !== 'JSXAttribute' || n.name?.name !== 'data-id') return;
    if (n.value?.type === 'StringLiteral') out.push(n.value.value);
  });
  return out;
}

/** Facts about the JSX element carrying `data-id=<id>` (first occurrence):
 *  the tag, the raw opening-tag source, the attribute names and the whole
 *  element source. */
export function elementOf(code: string, id: string): null | { tag: string; open: string; attrs: string[]; source: string; children: string } {
  const ast = astOf(code);
  if (!ast) return null;
  let found: AnyNode | null = null;
  walk(ast, (n) => {
    if (found || n.type !== 'JSXElement') return;
    for (const a of n.openingElement.attributes ?? []) {
      if (a.type === 'JSXAttribute' && a.name?.name === 'data-id' && a.value?.type === 'StringLiteral' && a.value.value === id) { found = n; return; }
    }
  });
  if (!found) return null;
  const el = found as AnyNode;
  const op = el.openingElement;
  const attrs: string[] = [];
  for (const a of op.attributes ?? []) {
    if (a.type === 'JSXSpreadAttribute') attrs.push(`...${code.slice(a.argument.start, a.argument.end)}`);
    else attrs.push(a.name.type === 'JSXNamespacedName' ? `${a.name.namespace.name}:${a.name.name.name}` : String(a.name.name));
  }
  const children = el.closingElement ? code.slice(op.end, el.closingElement.start) : '';
  return { tag: jsxName(op.name), open: code.slice(op.start, op.end), attrs, source: code.slice(el.start ?? 0, el.end ?? 0), children };
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

/** The file list once it stops changing. */
export async function filesNow(editor: Editor): Promise<string[]> {
  return (await editor.listFiles()).slice().sort();
}

// ─── Page / master builders ─────────────────────────────────────────

export const IMG_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjNGE3Ii8+PC9zdmc+';

export const ROOT_OPEN = `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '40px', padding: '40px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>`;

/** The home page module around `inner` (children of the page root). */
export function homePage(inner: string, opts: { tiles?: C1Tile[]; imports?: string[]; preamble?: string; hooks?: string[]; canvasNodes?: string; rootOpen?: string } = {}): string {
  return c1Page(`${opts.rootOpen ?? ROOT_OPEN}\n${inner.trim()}\n    </div>`, opts);
}

/** A project from page sources + extra files. `pages` maps route → page.client source. */
export function c6Seed(pages: Record<string, string>, files: Record<string, string> = {}): ProjectData {
  const out: Record<string, string> = {};
  for (const [route, src] of Object.entries(pages)) {
    const dir = route === '/' ? 'app/' : `app/${route.replace(/^\/+|\/+$/g, '')}/`;
    out[`${dir}page.tsx`] = SERVER_WRAPPER;
    out[`${dir}page.client.tsx`] = src;
  }
  // The Library panel writes a default `app/globals.css` (through the mutation
  // queue, so as an UNDO STEP) the first time it mounts on a project without
  // one. Seeding it keeps that write out of every test's history.
  return { format: 'revyme-v1', files: { 'app/globals.css': GLOBALS_CSS, ...out, ...files } };
}

export const GLOBALS_CSS = `/* Design Tokens — Presets */
:root {
  /* Colors */
  --color-brand: #6366f1;
}
`;

export const MASTER_HEAD = `'use client';

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';`;

/** A design master module. `body` is the root element; `sig` the props. */
export function master(name: string, body: string, opts: {
  label?: string; head?: string; imports?: string[]; pre?: string; config?: string; sig?: string; hooks?: string; propMeta?: string; post?: string;
} = {}): string {
  const sig = opts.sig ?? `{ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }`;
  const config = opts.config ?? `const variantConfig = [\n  { name: 'default', label: '${opts.label ?? name}', x: 0, y: 0, isPrimary: true },\n];`;
  // Canonical header (what the builder's first write normalises to): the
  // annotations right after 'use client', then the imports.
  const head = (opts.head ?? MASTER_HEAD).replace(/^'use client';\s*/, '');
  return `'use client';

/** @name "${opts.label ?? name}" */${opts.propMeta ? `\n/** @propMeta ${opts.propMeta} */` : ''}

${head}${(opts.imports ?? []).map(i => `\n${i}`).join('')}

${config}
${opts.pre ?? ''}
function ${name}(${sig}) {
${opts.hooks ?? ''}  return (
    <LayoutGroup>
${body.trim()}
    </LayoutGroup>
  );
}

export default withResponsiveProps(${name});
${opts.post ?? ''}`;
}

// ─── Seeds: Detach (CMP-187 …) ──────────────────────────────────────

/** A single-variant Badge master (nested inside Card). */
export const BADGE_MASTER = master('Badge', `
      <motion.div layout={true} data-id="badge-root" {...rest} data-name="Badge" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', padding: '6px 12px', backgroundColor: '#22aa66', borderRadius: '12px', ...style }}>
        <motion.p layout={true} data-id="badge-text" data-name="Badge Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '14px', color: '#ffffff', margin: '0px' }}>New</motion.p>
      </motion.div>`);

/** A two-variant Card master: per-variant root fill, a heading, a text, a
 *  nested Badge instance. Root has variants/initial/animate/layout/...rest/...style. */
export const CARD_MASTER = master('Card', `
      <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', padding: '24px', backgroundColor: '#1a1a3a', borderRadius: '16px', ...style }}>
        <motion.h2 layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', color: '#ffffff', margin: '0px' }}>Pro plan</motion.h2>
        <motion.p layout={true} data-id="card-body" data-name="Body" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: '#cccccc', margin: '0px' }}>Everything in Basic.</motion.p>
        <Badge data-id="card-badge" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto', order: '2' }} />
      </motion.div>`, {
  imports: [`import Badge from '@/components/Badge';`],
  config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Dark', x: 500, y: 0 },
];`,
  pre: `const cardRootVariants = {
  default: { backgroundColor: '#1a1a3a' },
  'variant-1': { backgroundColor: '#3a1a1a' },
};`,
});

/** A code component (no variantConfig, no @name). */
export const COUNTER_CODE = `'use client';

/** @label "Counter" */
/** @controls {
  "label": { "type": "text", "label": "Label", "default": "Count" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function Counter({ label = 'Count', ...props }: { label?: string; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '60px', backgroundColor: '#ffcc33', color: '#000000', ...(props.style || {}) }}>{label}</div>;
}

export default withResponsiveProps(Counter);
`;

const CARD_IMPORT = `import Card from '@/components/Card';`;

/** A page with one Card instance (and, optionally, a code-component instance). */
export function detachPage(opts: { tiles?: C1Tile[]; counter?: boolean; cardAttrs?: string } = {}): ProjectData {
  const inner = `      <Card data-id="card-a" data-name="Pricing Card"${opts.cardAttrs ? ` ${opts.cardAttrs}` : ''} style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />${opts.counter ? `
      <Counter data-id="counter-a" data-name="Counter" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />` : ''}`;
  return c6Seed(
    { '/': homePage(inner, { tiles: opts.tiles, imports: [CARD_IMPORT, ...(opts.counter ? [`import Counter from '@/components/Counter';`] : [])] }) },
    { [CARD]: CARD_MASTER, 'components/Badge.tsx': BADGE_MASTER, ...(opts.counter ? { 'components/Counter.tsx': COUNTER_CODE } : {}) },
  );
}

export { C1_TILES };

// ─── Panel / canvas helpers ─────────────────────────────────────────

export function panel(page: Page): Locator {
  return page.locator('[data-properties-panel]');
}

/** The data-id of the first element whose `data-name` is `name`. */
export function idByName(code: string, name: string): string | null {
  const ast = astOf(code);
  if (!ast) return null;
  let found: string | null = null;
  walk(ast, (n) => {
    if (found || n.type !== 'JSXOpeningElement') return;
    let id: string | null = null, nm: string | null = null;
    for (const a of n.attributes ?? []) {
      if (a.type !== 'JSXAttribute' || a.value?.type !== 'StringLiteral') continue;
      if (a.name?.name === 'data-id') id = a.value.value;
      if (a.name?.name === 'data-name') nm = a.value.value;
    }
    if (nm === name && id) found = id;
  });
  return found;
}

/** What a canvas node paints: its box, a few computed styles and its text.
 *  `nodeId` is the data-node-id on the primary (`card-a:card-title` for an
 *  expanded instance child); with `vpId` the replica copy is read. Null when
 *  the node is not rendered. */
export async function paint(editor: Editor, nodeId: string, vpId?: string): Promise<null | {
  x: number; y: number; width: number; height: number; bg: string; display: string; color: string; text: string; padding: string;
}> {
  const loc = vpId ? await editor.nodeIn(vpId, nodeId) : editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
  if (!(await loc.count())) return null;
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return { x: r.x, y: r.y, width: r.width, height: r.height, bg: cs.backgroundColor, display: cs.display, color: cs.color, text: (el.textContent ?? '').trim(), padding: cs.padding };
  });
}

/** Two paint reads agree (sizes within `tol` px; colours, display, text equal). */
export function samePaint(a: Awaited<ReturnType<typeof paint>>, b: Awaited<ReturnType<typeof paint>>, tol = 1.5): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol
    && a.bg === b.bg && a.display === b.display && a.color === b.color && a.text === b.text && a.padding === b.padding;
}

// ─── Detach ──────────────────────────────────────────────────────────

/** Right-click the instance → "Detach Instance". Waits for the page to change
 *  and returns the source before/after plus the id the editor selected. */
export async function detachViaMenu(editor: Editor, id: string, opts: { at?: [number, number]; vpId?: string } = {}): Promise<{ before: string; after: string; rootId: string; path: string }> {
  const page = editor.page();
  const path = await editor.activeFile();
  const before = await editor.code(path);
  await rightClickNode(editor, id, opts);
  const sel = await editor.selection();
  if (sel.length !== 1 || sel[0] !== id) throw new Error(`right-click selected ${JSON.stringify(sel)}, not "${id}"`);
  await menuItem(page, 'Detach Instance').click();
  await pollCode(editor, path, c => c !== before);
  await editor.settled();
  const after = await editor.code(path);
  const rootId = (await editor.selection())[0] ?? '';
  return { before, after, rootId, path };
}

/** The data-ids inside the element `rootId` (itself included), in order. */
export function subtreeIds(code: string, rootId: string): string[] {
  const el = elementOf(code, rootId);
  return el ? dataIds(el.source) : [];
}

// ─── Seeds: Detach, CMP-189 (chained gate + text chain + prop) ──────

export const BTN = 'components/Btn.tsx';

/** A master whose svg is gated by a CHAINED comparison, whose label text is a
 *  ternary CHAIN over `variant`, with per-variant root fills and a colour prop. */
export const BTN_MASTER = master('Btn', `
      <motion.div layout={true} data-id="btn-root" variants={btnRootVariants} initial={['default', initialVariant]} animate={['default', variant]} {...rest} data-name="Btn" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', width: '240px', height: '56px', padding: '0px 16px', backgroundColor: '#1a1a3a', borderRadius: '12px', ...style }}>
        {variant !== "default-hover" && variant !== "default-pressed" && <motion.svg layout={true} data-id="btn-shape" data-name="Shape" variants={shapeVariants} initial={['default', initialVariant]} animate={['default', variant]} viewBox="0 0 26 22" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '26px', height: '22px' }}><path data-id="btn-shape-g0" d="M13 0 L26 22 L0 22 Z" fill="#ffffff" /></motion.svg>}
        <motion.p layout={true} data-id="btn-label" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: labelColor, margin: '0px' }}>{variant === "variant-4" ? "Get Started" : variant === "variant-7" ? "Start now" : "Book a Call"}</motion.p>
      </motion.div>`, {
  propMeta: `{"labelColor":{"type":"color","label":"Label Color"}}`,
  sig: `{ style, initialVariant = 'default', labelColor = '#ffffff', ...rest }: { style?: React.CSSProperties; initialVariant?: string; labelColor?: string; [key: string]: any }`,
  config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-4', label: 'Four', x: 400, y: 0 },
  { name: 'variant-7', label: 'Seven', x: 800, y: 0 },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 200, interactionType: 'hover', parentVariant: 'default' },
  { name: 'default-pressed', label: 'Default - Pressed', x: 0, y: 400, interactionType: 'pressed', parentVariant: 'default' },
];`,
  pre: `const btnRootVariants = {
  default: { backgroundColor: '#1a1a3a' },
  'variant-4': { backgroundColor: '#ff2d75' },
  'variant-7': { backgroundColor: '#22aa66' },
  'default-hover': { backgroundColor: '#2a2a5a' },
  'default-pressed': { backgroundColor: '#0a0a2a' },
};
const shapeVariants = { default: { opacity: 1 }, 'variant-4': { opacity: 1 } };`,
  hooks: `  const [variant, setVariant] = React.useState(initialVariant);
  React.useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
`,
});

export const BTN_SEED = c6Seed(
  { '/': homePage(`      <Btn data-id="btn-a" data-name="CTA" initialVariant="variant-4" labelColor="#ffcc00" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Btn from '@/components/Btn';`] }) },
  { [BTN]: BTN_MASTER },
);

// ─── Seeds: Detach, CMP-190 (data-responsive per-viewport variants) ─

export const NAV = 'components/Nav.tsx';

/** Three variants: per-variant root padding/fill, a Burger only variant-2
 *  renders (a flex node), a CTA every variant but variant-2 renders. */
export const NAV_MASTER = master('Nav', `
      <motion.div layout={true} data-id="nav-root" variants={navRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Nav" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '100%', height: '80px', padding: '16px', backgroundColor: '#223344', ...style }}>
        <motion.p layout={true} data-id="nav-logo" data-name="Logo" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '20px', color: '#ffffff', margin: '0px' }}>Logo</motion.p>
        <AnimatePresence>{initialVariant === 'variant-2' && <motion.div layout={true} key="nav-burger" data-id="nav-burger" data-name="Burger" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto', order: '1', width: '32px', height: '24px', backgroundColor: '#ffffff' }} />}</AnimatePresence>
        <AnimatePresence>{initialVariant !== 'variant-2' && <motion.div layout={true} key="nav-cta" data-id="nav-cta" data-name="CTA" style={{ position: 'relative', flex: '0 0 auto', order: '2', width: '120px', height: '40px', backgroundColor: '#ff2d75' }} />}</AnimatePresence>
      </motion.div>`, {
  head: `'use client';

import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';`,
  config: `const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 0, y: 200 },
  { name: 'variant-2', label: 'Phone', x: 0, y: 400 },
];`,
  pre: `const navRootVariants = {
  default: { backgroundColor: '#223344', padding: '16px' },
  'variant-1': { backgroundColor: '#335577', padding: '10px' },
  'variant-2': { backgroundColor: '#553322', padding: '4px' },
};`,
});

export const NAV_RESPONSIVE_SEED = c6Seed(
  { '/': homePage(`      <Nav data-id="nav-a" data-name="Navbar" data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%' }} />`, { tiles: C1_TILES.three, imports: [`import Nav from '@/components/Nav';`] }) },
  { [NAV]: NAV_MASTER },
);

// ─── Seeds: Detach, CMP-191 (master <style> rules) ──────────────────

export const FORM_CARD = 'components/FormCard.tsx';

export const FORM_CARD_MASTER = master('FormCard', `
      <motion.div layout={true} data-id="fc-root" {...rest} data-name="Form Card" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', padding: '24px', backgroundColor: '#ffffff', borderRadius: '12px', ...style }}>
        <style>{\`
    [data-id="fc-email"]::placeholder {
      color: #94a3b8 !important;
    }
    [data-id="fc-title"]:hover {
      opacity: 0.5 !important;
    }
    [data-id="fc-media"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-width: 4px;
  border-style: solid;
  border-color: #384bf6;
  pointer-events: none;
    }
    @media (max-width: 768px) {
      [data-id="fc-title"] { font-size: 18px !important; }
    }
  \`}</style>
        <motion.h3 layout={true} data-id="fc-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '22px', color: '#111111', margin: '0px' }}>Subscribe</motion.h3>
        <motion.input layout={true} data-id="fc-email" data-name="Email" type="email" name="email" placeholder="you@example.com" style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '100%', height: '40px', padding: '8px 12px', fontSize: '14px', color: '#111111', border: '1px solid #d1d5db', borderRadius: '6px' }} />
        <motion.div layout={true} data-id="fc-media" data-name="Media" style={{ position: 'relative', flex: '0 0 auto', order: '2', width: '100%', height: '80px', backgroundColor: '#eef2ff' }} />
      </motion.div>`);

export const FORM_CARD_SEED = c6Seed(
  { '/': homePage(`      <style>{\`
    [data-id="note"]:hover {
      opacity: 0.8 !important;
    }
  \`}</style>
      <p data-id="note" data-name="Note" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '14px', color: '#ffffff', margin: '0px' }}>Page note</p>
      <form onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const _hp = fd.get("_hp"); fd.delete("_hp"); const fields = Object.fromEntries(fd.entries()); try { const res = await fetch("/api/form", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formId: "page-form", fields, _hp }) }); const data = await res.json().catch(() => ({})); if (data && data.redirect) { window.location.href = data.redirect; return; } e.currentTarget.reset(); } catch (err) {} }} data-id="page-form" data-name="Signup Form" data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"you@example.com","subject":"New submission"}]}' style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', padding: '16px', backgroundColor: '#202040' }}>
        <FormCard data-id="fc-a" data-name="Signup Card" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      </form>`, { tiles: C1_TILES.three, imports: [`import FormCard from '@/components/FormCard';`] }) },
  { [FORM_CARD]: FORM_CARD_MASTER },
);

// ─── Seeds: Detach, CMP-192 (event-triggered overlay) ───────────────

export const MENU = 'components/Menu.tsx';

export const MENU_MASTER = master('Menu', `
      <motion.div layout={true} data-id="menu-root" {...rest} data-name="Menu" onClick={event1} style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '160px', height: '48px', backgroundColor: '#ff2d75', borderRadius: '24px', ...style }}>
        <motion.p layout={true} data-id="menu-label" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>Open menu</motion.p>
      </motion.div>`, {
  propMeta: `{"event1":{"type":"event","label":"Event 1"}}`,
  sig: `{ style, initialVariant = 'default', event1, ...rest }: { style?: React.CSSProperties; initialVariant?: string; event1?: () => void; [key: string]: any }`,
});

export const OVERLAY_ID = 'overlay-menu-1';
const OV_VAR = 'overlayMenu_1Open';
const OV_SET = 'setOverlayMenu_1Open';

/** The relative-overlay runtime effect, verbatim as the overlay generator
 *  writes it (the oracle's OVERLAY_MISSING_WIRING asks for exactly this). */
const OVERLAY_EFFECT = `useLayoutEffect(() => {
    if (!overlayMenu_1Open) return;
    let seen = false;
    const position = () => {
      const overlay = document.querySelector('[data-id="overlay-menu-1"]');
      if (!overlay) return;
      const raw = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
      let cfg = raw;
      if (raw.responsive) {
        const ww = window.innerWidth;
        const bps = raw.responsiveBp;
        const owning = (bps && bps.length)
          ? bps.filter(b => ww <= b).sort((a, b) => a - b)[0]
          : Object.keys(raw.responsive).map(Number).filter(n => ww <= n).sort((a, b) => a - b)[0];
        if (owning !== undefined && raw.responsive[owning]) cfg = { ...raw, ...raw.responsive[owning] };
      }
      const trigger = document.querySelector('[data-id="' + cfg.triggerId + '"]');
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const onScreen = trigger.getClientRects().length > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      if (onScreen) seen = true;
      else if (seen) { setOverlayMenu_1Open(false); return; }
      const w = overlay.offsetWidth, h = overlay.offsetHeight;
      const g = 8, ox = cfg.offsetX || 0, oy = cfg.offsetY || 0;
      let top, left;
      switch (cfg.side || 'bottom') {
        case 'top': top = r.top - h - g + oy; break;
        case 'left': top = r.top + oy; left = r.left - w - g + ox; break;
        case 'right': top = r.top + oy; left = r.right + g + ox; break;
        default: top = r.bottom + g + oy;
      }
      if (left === undefined) {
        if (cfg.align === 'center') left = r.left + r.width / 2 - w / 2 + ox;
        else if (cfg.align === 'end') left = r.right - w + ox;
        else left = r.left + ox;
      } else if (cfg.align === 'center') top = r.top + r.height / 2 - h / 2 + oy;
      else if (cfg.align === 'end') top = r.bottom - h + oy;
      if (cfg.collision !== 'none') {
        const pad = cfg.collisionPadding ?? 20;
        left = Math.min(Math.max(left, pad), window.innerWidth - w - pad);
        top = Math.min(Math.max(top, pad), window.innerHeight - h - pad);
      }
      const t = top + 'px', l = left + 'px';
      if (overlay.style.top !== t) overlay.style.top = t;
      if (overlay.style.left !== l) overlay.style.left = l;
    };
    const onOutside = (e) => {
      const ov = document.querySelector('[data-id="overlay-menu-1"]');
      if (ov && ov.contains(e.target)) return;
      const tid = ov ? (JSON.parse(ov.getAttribute('data-overlay') || '{}').triggerId) : null;
      const tr = tid ? document.querySelector('[data-id="' + tid + '"]') : null;
      if (tr && tr.contains(e.target)) return;
      setOverlayMenu_1Open(false);
    };
    const lift = document.querySelector('[data-id="overlay-menu-1"]');
    if (lift && lift.showPopover) {
      try {
        if (!document.getElementById('rv-overlay-top-layer')) { const s = document.createElement('style'); s.id = 'rv-overlay-top-layer'; s.textContent = ':where([data-overlay][popover]){inset:auto;margin:0;padding:0;border:0;color:inherit;background:none;overflow:visible;width:auto;height:auto}'; document.head.appendChild(s); }
        if (!lift.matches(':popover-open')) { lift.setAttribute('popover', 'manual'); lift.showPopover(); }
      } catch {}
    }
    position();
    let raf = requestAnimationFrame(function follow() { position(); raf = requestAnimationFrame(follow); });
    document.addEventListener('mousedown', onOutside);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('mousedown', onOutside); };
  }, [overlayMenu_1Open]);`;

export const MENU_OVERLAY_SEED = c6Seed(
  { '/': c1Page(`${ROOT_OPEN}
      <Menu data-id="menu-a" data-name="Menu Button" data-overlay-trigger='{"targetId":"${OVERLAY_ID}","trigger":"event","dismiss":"outside","eventName":"event1"}' event1={() => ${OV_SET}(!${OV_VAR})} style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      <AnimatePresence>{${OV_VAR} && (
        <motion.div key="${OVERLAY_ID}" data-id="${OVERLAY_ID}" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"menu-a","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '220px', height: '100px', backgroundColor: '#ffcc33' }}>
          <p data-id="overlay-text" data-name="Overlay Text" style={{ position: 'relative', color: '#000000', margin: '0px' }}>Menu overlay</p>
        </motion.div>
      )}</AnimatePresence>
    </div>`, {
    imports: [`import { useState, useLayoutEffect } from 'react';`, `import { motion, AnimatePresence } from 'framer-motion';`, `import Menu from '@/components/Menu';`],
    hooks: [`const [${OV_VAR}, ${OV_SET}] = useState(false);`, OVERLAY_EFFECT],
  }) },
  { [MENU]: MENU_MASTER },
);

// ─── Seeds: Detach, CMP-193 (CMS row instance) ──────────────────────

const svgUri = (c: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${c}"/></svg>`).toString('base64')}`;

export const POSTS_FILES: Record<string, string> = {
  'cms/posts.schema.json': JSON.stringify({ name: 'Posts', slug: 'posts', fields: [
    { id: 'title', name: 'Title', type: 'text', required: true },
    { id: 'image', name: 'Image', type: 'image' },
  ] }),
  'cms/posts.json': JSON.stringify([
    { _id: 'p1', _slug: 'first', _status: 'published', title: 'First post', image: svgUri('#e06666') },
    { _id: 'p2', _slug: 'second', _status: 'published', title: 'Second post', image: svgUri('#6fa8dc') },
    { _id: 'p3', _slug: 'third', _status: 'published', title: 'Third post', image: svgUri('#93c47d') },
  ]),
};

export const POST_ROW = 'components/PostRow.tsx';

export const POST_ROW_MASTER = master('PostRow', `
      <MotionLink layout={true} data-cms-nav="row" href={linkHref} data-id="pr-root" {...rest} data-name="Post Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', width: '320px', height: '56px', padding: '8px', backgroundColor: '#eeeeee', ...style }}>
        <motion.div layout={true} data-id="pr-img" data-name="Image" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '40px', height: '40px', backgroundImage: \`url(\${image})\`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <motion.h3 layout={true} data-id="pr-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '14px', color: '#111111', margin: '0px' }}>{title}</motion.h3>
      </MotionLink>`, {
  imports: [`import Link from 'next/link';`],
  pre: `const MotionLink = motion.create(Link);`,
  propMeta: `{"image":{"type":"image","label":"Image"},"title":{"type":"plainText","label":"Title"},"linkHref":{"type":"link","label":"Link"}}`,
  sig: `{ style, initialVariant = 'default', image = '', title = 'Title', linkHref = '/', ...rest }: { style?: React.CSSProperties; initialVariant?: string; image?: string; title?: string; linkHref?: string; [key: string]: any }`,
});

export const CMS_ROW_SEED = c6Seed(
  { '/': homePage(`      <div data-id="post-list" data-name="Posts" data-collection-list="posts" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff' }}>
        {posts.map((item, idx) => (
          <PostRow data-id="post-row" key={idx} data-name="Post" image={item.image} title={item.title} linkHref={\`/posts/\${item?._slug ?? ''}\`} style={{ position: 'relative', flex: '0 0 auto', width: '100%' }} />
        ))}
      </div>`, { imports: [`import posts from '@/cms/posts.json';`, `import PostRow from '@/components/PostRow';`] }) },
  { [POST_ROW]: POST_ROW_MASTER, ...POSTS_FILES },
);

// ─── Seeds: Detach, CMP-194 (paginated collection list master) ──────

export const BLOGS = 'components/Blogs.tsx';

export const BLOGS_MASTER = master('Blogs', `
      <motion.div layout={true} data-id="blogs" {...rest} data-name="Blogs" data-collection-list="blog" data-pagination="loadMore:2" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff', ...style }}>
        {blog.slice(0, visBlogs).map((item, idx) => (
          <motion.div layout={true} data-id="blog-row" key={idx} data-name="Blog" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', width: '100%', height: '40px', backgroundColor: '#eeeeee' }}>
            <motion.h3 layout={true} data-id="blog-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.title}</motion.h3>
          </motion.div>
        ))}
        {visBlogs < blog.length && <LoadMore data-id="loadmore-blogs" data-name="Load More" data-pagination-ui="true" onLoadMore={() => setVisBlogs((c) => c + 2)} style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />}
      </motion.div>`, {
  head: `'use client';

import React, { useState } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';`,
  imports: [`import blog from '@/cms/blog.json';`, `import LoadMore from '@/components/LoadMore';`],
  hooks: `  const [visBlogs, setVisBlogs] = useState(2);
`,
});

// ─── Seeds: Detach, CMP-195 (Footer with nested Link instances) ─────

export const FOOTER = 'components/Footer.tsx';
export const LNK = 'components/Lnk.tsx';

export const LNK_MASTER = master('Lnk', `
      <motion.div layout={true} data-id="lnk-root" {...rest} data-name="Footer Link" style={{ position: 'relative', display: 'flex', alignItems: 'center', padding: '6px', backgroundColor: '#334455', ...style }}>
        <motion.p layout={true} data-id="lnk-text" data-name="Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '14px', color: '#ffffff', margin: '0px' }}>{content}</motion.p>
      </motion.div>`, {
  label: 'Footer Link',
  propMeta: `{"content":{"type":"plainText","label":"Content"}}`,
  sig: `{ style, initialVariant = 'default', content = 'Link', ...rest }: { style?: React.CSSProperties; initialVariant?: string; content?: string; [key: string]: any }`,
});

export const FOOTER_MASTER = master('Footer', `
      <motion.div layout={true} data-id="f-root" {...rest} data-name="Footer" style={{ position: 'relative', display: 'block', width: '600px', height: '80px', padding: '12px', backgroundColor: '#112233', ...style }}>
        <Lnk data-id="f-a" data-name="Privacy" content="Privacy" style={{ width: '82px', height: '33px' }} />
        <Lnk data-id="f-b" data-name="Terms" content="Terms" />
        <Lnk data-id="f-c" data-name="Pinned" content="Pinned" style={{ position: 'absolute', left: '400px', top: '8px' }} />
      </motion.div>`, { imports: [`import Lnk from '@/components/Lnk';`] });

// ─── Seeds: Detach, CMP-196 (formatted-text literal + motion.create shim) ─

export const PROMO = 'components/Promo.tsx';

export const PROMO_MASTER = master('Promo', `
      <motion.div layout={true} data-id="promo-root" {...rest} data-name="Promo" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', width: '320px', padding: '16px', backgroundColor: '#1a1a3a', ...style }}>
        <motion.p layout={true} data-id="promo-rich" data-name="Rich" dangerouslySetInnerHTML={{ __html: 'Save <strong>20%</strong> today' }} style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }} />
        <MotionLink layout={true} data-id="promo-link" data-name="Logo Link" href="/" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '14px', color: '#99ccff' }}>Home</MotionLink>
      </motion.div>`, {
  imports: [`import Link from 'next/link';`],
  pre: `const MotionLink = motion.create(React.forwardRef(function MotionLinkBase({ href, ...props }: any, ref: any) {
  return href ? <Link ref={ref} href={href} {...props} /> : <div ref={ref} {...props} />;
}));`,
});

export const BLOGS_SEED = c6Seed(
  { '/': homePage(`      <Blogs data-id="blogs-a" data-name="Blog List" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Blogs from '@/components/Blogs';`] }) },
  { [BLOGS]: BLOGS_MASTER, 'components/LoadMore.tsx': loadMoreSource(), ...C1_CMS_FILES },
);

export const FOOTER_SEED = c6Seed(
  { '/': homePage(`      <Footer data-id="footer-a" data-name="Site Footer" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Footer from '@/components/Footer';`] }) },
  { [FOOTER]: FOOTER_MASTER, [LNK]: LNK_MASTER },
);

export const PROMO_SEED = c6Seed(
  { '/': homePage(`      <Promo data-id="promo-a" data-name="Promo Banner" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Promo from '@/components/Promo';`] }) },
  { [PROMO]: PROMO_MASTER },
);

// ─── Seeds: Library (CMP-176 …) ─────────────────────────────────────

/** A plain one-variant Card master (no nested instances). */
export const LIB_CARD_MASTER = master('Card', `
      <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '240px', padding: '16px', backgroundColor: '#97cffc', borderRadius: '12px', ...style }}>
        <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '18px', color: '#000000', margin: '0px' }}>Card title</motion.p>
      </motion.div>`, {
  config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Alt', x: 400, y: 0 },
];`,
});

export const LIB_BUTTON_MASTER = master('Button', `
      <motion.div layout={true} data-id="btn-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '48px', backgroundColor: '#ff2d75', borderRadius: '24px', ...style }}>
        <motion.p layout={true} data-id="btn-text" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>{title}</motion.p>
      </motion.div>`, {
  propMeta: `{"title":{"type":"plainText","label":"Title"}}`,
  sig: `{ style, initialVariant = 'default', title = 'Click', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; [key: string]: any }`,
  config: `const variantConfig = [
  { name: 'default', label: 'Primary', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Ghost', x: 300, y: 0 },
];`,
});

/** A Header master holding a Card instance. */
export const LIB_HEADER_MASTER = master('Header', `
      <motion.div layout={true} data-id="header-root" {...rest} data-name="Header" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '640px', padding: '16px', backgroundColor: '#223344', ...style }}>
        <motion.p layout={true} data-id="header-logo" data-name="Logo" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '20px', color: '#ffffff', margin: '0px' }}>Logo</motion.p>
        <Card data-id="header-card" data-name="Header Card" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />
      </motion.div>`, { imports: [`import Card from '@/components/Card';`] });

const LAYOUT_SERVER = `import LayoutClient from './LayoutClient';

export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;

/** A template (route group `marketing`) whose chrome holds a Card instance. */
export const MARKETING_LAYOUT_CLIENT = `'use client';

/** @canvas {"viewports":[{"id":"desktop","label":"Desktop","width":1440,"isPrimary":true,"order":0}],"positions":{"desktop":{"x":0,"y":0}}} */

import React from 'react';
import Card from '@/components/Card';

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Card data-id="tpl-card" data-name="Template Card" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      {children}
    </div>
  );
}
`;

/** Card used on Home (self-closing), on /about inside the `marketing`
 *  template (open/close form), in that template's chrome and inside the
 *  Header master; a Button used on Home. */
export const LIBRARY_SEED = c6Seed(
  {
    '/': homePage(`      <Card data-id="home-card" data-name="Home Card" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      <Button data-id="home-btn" data-name="Home Button" title="Go" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />
      <Header data-id="home-header" data-name="Home Header" style={{ position: 'relative', flex: '0 0 auto', order: '2' }} />
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '3', display: 'flex', flexDirection: 'row', width: '320px', height: '120px', padding: '16px', backgroundColor: '#1a1a3a' }}>
        <p data-id="hero-text" data-name="Hero Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>Hero</p>
      </div>`, {
      imports: [`import Card from '@/components/Card';`, `import Button from '@/components/Button';`, `import Header from '@/components/Header';`],
    }),
    '(marketing)/about': homePage(`      <p data-id="about-title" data-name="About Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '24px', color: '#ffffff', margin: '0px' }}>About</p>
      <Card data-id="about-card" data-name="About Card" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}></Card>`, { imports: [`import Card from '@/components/Card';`] }),
  },
  {
    [CARD]: LIB_CARD_MASTER,
    'components/Button.tsx': LIB_BUTTON_MASTER,
    'components/Header.tsx': LIB_HEADER_MASTER,
    'app/(marketing)/layout.tsx': LAYOUT_SERVER,
    'app/(marketing)/LayoutClient.tsx': MARKETING_LAYOUT_CLIENT,
    'components/Counter.tsx': COUNTER_CODE,
  },
);

/** CMP-182: a CMS row that is a Card instance carrying Card-specific props
 *  (variant, a responsive variant map, a prop) plus key / data-pinned / size. */
export const REPLACE_SEED = c6Seed(
  { '/': homePage(`      <div data-id="post-list" data-name="Posts" data-collection-list="posts" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff' }}>
        {posts.map((item, idx) => (
          <Card key={idx} data-id="swap-card" data-name="Swap Card" initialVariant="variant-1" data-responsive='{"768":{"initialVariant":"default"},"_bp":[1440,768]}' heading={item.title} data-pinned="true" style={{ position: 'relative', flex: '0 0 auto', width: '300px', height: '90px' }} />
        ))}
      </div>`, { tiles: [C1_TILES.three[0], C1_TILES.three[1]], imports: [`import posts from '@/cms/posts.json';`, `import Card from '@/components/Card';`] }) },
  { [CARD]: LIB_CARD_MASTER, 'components/Button.tsx': LIB_BUTTON_MASTER, ...POSTS_FILES },
);

export const ABOUT = 'app/(marketing)/about/page.client.tsx';
export const TEMPLATE = 'app/(marketing)/LayoutClient.tsx';
export const HEADER = 'components/Header.tsx';
export const BUTTON = 'components/Button.tsx';

// ─── Library panel helpers ──────────────────────────────────────────

export function libraryPanel(page: Page): Locator {
  return page.locator('[data-library-panel]');
}

/** Open the Library panel (left toolbar button) if it is not showing. */
export async function openLibrary(page: Page): Promise<Locator> {
  const lib = libraryPanel(page);
  if (!(await lib.isVisible().catch(() => false))) await page.locator('[data-tutorial="library-button"]').click();
  await lib.waitFor({ state: 'visible' });
  return lib;
}

/** A Library row (the SidebarRow `group` div) by its exact label. */
export async function libraryRow(page: Page, name: string): Promise<Locator> {
  const lib = await openLibrary(page);
  return lib.locator('div.group', { has: page.getByText(name, { exact: true }) }).filter({ has: page.locator('span.truncate', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).last();
}

/** Open a Library row's ⋯ menu (hover reveals the button). */
export async function openRowMenu(page: Page, name: string): Promise<void> {
  const row = await libraryRow(page, name);
  await row.hover();
  const dots = row.locator('button:has(svg circle[cx="19"])').last();
  await dots.click();
  await dropdownItem(page, /.+/).first().waitFor({ state: 'visible' });
}

/** The open dropdown menu (portal, `fixed` panel). */
export function dropdown(page: Page): Locator {
  return page.locator('body > div.fixed, body div.fixed').filter({ has: page.locator('button span.flex-1') }).last();
}

/** A dropdown entry by label. */
export function dropdownItem(page: Page, label: string | RegExp): Locator {
  const name = typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : label;
  return page.locator('button', { has: page.locator('span.flex-1', { hasText: name }) });
}

/** The Library usage badge of a row. */
export async function usageBadge(page: Page, name: string): Promise<Locator> {
  return (await libraryRow(page, name)).locator('button[title^="Used by"]');
}

/** The inline rename field of a Library row (not the panel's search box). */
export function libraryInlineInput(page: Page): Locator {
  return libraryPanel(page).locator('input:not([placeholder])');
}

/** Every project source file (`.tsx` / `.ts` / `.json` under app, components,
 *  cms and _meta/component-folders) — the editor's own bookkeeping files
 *  (`_meta/page-camera.json`, the generated `app/globals.css`) excluded. */
export async function sourceSnapshot(editor: Editor): Promise<Record<string, string>> {
  const all = await editor.snapshotFiles();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === '_meta/page-camera.json' || k === 'app/globals.css') continue;
    out[k] = v;
  }
  return out;
}

/** HARNESS workaround: a violation a DIFFERENT row already pins as a product
 *  bug (e.g. CMP-176's COMPONENT_ROOT_POSITION on every Library-created
 *  master) is added to the post-load baseline for that file, so the row
 *  under test is judged on its own behaviour. Never used for the row that
 *  owns the bug. */
export function acceptKnownViolation(editor: Editor, path: string, code: string, elementId?: string): void {
  const ed = editor as any;
  const set: Set<string> = ed.baselineViolations.get(path) ?? new Set<string>();
  set.add(`${code}|${elementId ?? ''}`);
  ed.baselineViolations.set(path, set);
}

/** How many `history:push` entries the trace has so far. */
export async function historyPushes(editor: Editor): Promise<number> {
  return editor.page().evaluate(() => ((window as any).__e2e.traceEntries('history:push') as unknown[]).length);
}

/** Wait until the history recorded a new entry since `since` (a Library /
 *  panel write reaches the history a beat after the file changes; a Cmd+Z
 *  pressed inside that beat has nothing to undo). */
export async function waitHistoryPush(editor: Editor, since: number, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await historyPushes(editor)) > since) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

// ─── Seeds: component variables (CMP-167 …) ─────────────────────────

export const TILE = 'components/Tile.tsx';

/** A Tile master with no props yet: a swatch frame, a plain text, a second text. */
export function tileMaster(opts: { sig?: string; propMeta?: string; swatchBg?: string; titleText?: string; titleColor?: string; titleFontSize?: string; bodyText?: string; bodyColor?: string; rootAttrs?: string; head?: string; pre?: string; hooks?: string; extraChild?: string } = {}): string {
  return master('Tile', `
      <motion.div layout={true} data-id="tile-root"${opts.rootAttrs ? ' ' + opts.rootAttrs : ''} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Tile" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', padding: '16px', backgroundColor: '#1a1a3a', ...style }}>
        <motion.div layout={true} data-id="tile-swatch" data-name="Swatch" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', height: '60px', backgroundColor: ${opts.swatchBg ?? "'#1E3C1B'"} }} />
        <motion.p layout={true} data-id="tile-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: ${opts.titleFontSize ?? "'18px'"}, color: ${opts.titleColor ?? "'#ffffff'"}, margin: '0px' }}>${opts.titleText ?? 'Plain words'}</motion.p>
        <motion.p layout={true} data-id="tile-body" data-name="Body" style={{ position: 'relative', flex: '0 0 auto', order: '2', fontSize: '14px', color: ${opts.bodyColor ?? "'#cccccc'"}, margin: '0px' }}>${opts.bodyText ?? 'Rich words'}</motion.p>${opts.extraChild ?? ''}
      </motion.div>`, {
    sig: opts.sig,
    propMeta: opts.propMeta,
    head: opts.head,
    pre: opts.pre,
    hooks: opts.hooks,
  });
}

/** A Tile signature with extra props before `...rest`. */
export function tileSig(props: string): string {
  return `{ style, initialVariant = 'default', ${props}, ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }`;
}

export function tileSeed(masterSrc: string = tileMaster(), instAttrs: [string, string] = ['', ''], opts: { tiles?: C1Tile[]; imports?: string[]; pages?: Record<string, string>; files?: Record<string, string> } = {}): ProjectData {
  return c6Seed(
    { '/': homePage(`      <Tile data-id="tile-a" data-name="Tile A"${instAttrs[0] ? ' ' + instAttrs[0] : ''} style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      <Tile data-id="tile-b" data-name="Tile B"${instAttrs[1] ? ' ' + instAttrs[1] : ''} style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />`, { tiles: opts.tiles, imports: [`import Tile from '@/components/Tile';`, ...(opts.imports ?? [])] }), ...(opts.pages ?? {}) },
    { [TILE]: masterSrc, ...(opts.files ?? {}) },
  );
}

/** The Pointer master a component-cursor variable points at. */
export const POINTER_MASTER = master('Pointer', `
      <motion.div layout={true} data-id="pointer-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Pointer" style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: '#ffffff', ...style }} />`);

/** CMP-170: three typed props with metadata, each applied in the master (an
 *  instance only lists variables the master applies). */
export const META_TILE = tileMaster({
  sig: tileSig(`accent = '#1E3C1B', size = '14px', count = 3`),
  propMeta: `{"accent":{"type":"color","label":"Accent"},"size":{"type":"option","label":"Size","options":["14px","18px"]},"count":{"type":"number","label":"Count"}}`,
  swatchBg: 'accent',
  titleFontSize: 'size',
  bodyText: '{count}',
});

/** CMP-171: one bound colour and three unbound text variables (instances pass two of them). */
export const REMOVE_TILE = tileMaster({
  sig: tileSig(`accent = '#1E3C1B', note = 'Hi', badge = 'New', tag = 'Tag'`),
  propMeta: `{"accent":{"type":"color","label":"Accent"},"note":{"type":"plainText","label":"Note"},"badge":{"type":"plainText","label":"Badge"},"tag":{"type":"plainText","label":"Tag"}}`,
  swatchBg: 'accent',
});

/** CMP-172: the joijoijoi colour bound to the swatch fill AND the title colour. */
export const JOI_TILE = tileMaster({
  sig: tileSig(`joijoijoi = '#1E3C1B'`),
  propMeta: `{"joijoijoi":{"type":"color","label":"joijoijoi"}}`,
  swatchBg: 'joijoijoi',
  titleColor: 'joijoijoi',
});

/** CMP-173: \`accent\` used only by the swatch, \`ink\` by the title AND the body,
 *  and a component-cursor variable on the root. */
export const CASCADE_TILE = tileMaster({
  head: `'use client';

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps, withCursor } from '@revyme/runtime';`,
  sig: tileSig(`accent = '#1E3C1B', ink = '#ffffff', cursor = () => null, cursorOpts = {}`),
  propMeta: `{"accent":{"type":"color","label":"Accent"},"ink":{"type":"color","label":"Ink"},"cursor":{"type":"componentCursor","label":"cursor"}}`,
  swatchBg: 'accent',
  titleColor: 'ink',
  bodyColor: 'ink',
  rootAttrs: `{...withCursor(cursor, { mode: 'follow', ...cursorOpts })}`,
});

/** CMP-174: an Option variable with description + choices, a Number with full meta. */
export const DUP_TILE = tileMaster({
  sig: tileSig(`size = 'M', count = 4`),
  propMeta: `{"size":{"type":"option","label":"Size","description":"Pick one","options":["S","M","L"]},"count":{"type":"number","label":"Count","description":"How many","min":0,"max":10,"step":2,"unit":"px","control":"stepper"}}`,
});

/** CMP-175: a module-scope \`useMediaQuery\` helper whose useState takes a lazy initialiser. */
export const MQ_TILE = tileMaster({
  pre: `function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}`,
  hooks: `  const isNarrow = useMediaQuery('(max-width: 768px)');
`,
});

/** Open a master (setup) and wait until its root painted. */
export async function enterMaster(editor: Editor, path: string, rootId: string): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator(`[data-node-id="${rootId}"]`).first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
  await editor.fitCamera();
  await editor.settled();
}
