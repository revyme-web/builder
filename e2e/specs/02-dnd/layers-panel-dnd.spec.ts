// DND · Layers panel drag and drop (E2E_TEST_PLAN.md §2, batch D4, DND-096..120).
//
// Every gesture here is a real mouse drag on a Layers row: press on the row,
// cross the 3px threshold, aim at the target row's top 30% / middle / bottom
// 30% (src/editor/LayersPanel/drag.ts), release. `dragLayerRow` returns the
// drop indicator the tree showed right before the release.

import { test, expect, TILES, TILES_VIEWPORT, canvasHeader } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import { visualOrder } from '../../helpers/d1';
import { BADGE_MASTER, PAGINATED_PAGE, OVERLAY_PAGE, C1_CMS_FILES } from '../../helpers/c1';
import {
  seed, pageSrc, lid, vpRow, revealRow, dragLayerRow, pressLayerRow, rowIndicator, layerRow, openLayers,
  canvasDropHighlight, traceMark, tracesSince, stableCode, idCount, frames, expandRow,
  masterModule, openMaster, variantsConst, conditionalAround, injectRemoteLock, releaseRemoteLock,
} from '../../helpers/d4';

test.describe.configure({ timeout: 180_000 });

const BADGE_IMPORT = "import Badge from '@/components/Badge';";
const box = (id: string, name: string, extra = '', kids = '') =>
  `<div data-id="${id}" data-name="${name}" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '120px', backgroundColor: '#2a2a4a'${extra ? `, ${extra}` : ''} }}>${kids}</div>`;

/** Root flex column with three sections, no explicit order yet. */
const ABC = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  ${box('a', 'A', "backgroundColor: '#1a1a3a'")}
  ${box('b', 'B', "backgroundColor: '#f5f5f7'")}
  ${box('c', 'C', "backgroundColor: '#3a2a4a'")}
</div>` }));

/** The zone rules: a mover, a non-last frame with a child, a text, an
 *  instance, and a frame that is the last child. */
const ZONES = seed(pageSrc({
  imports: [BADGE_IMPORT],
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="m" data-name="Mover" style={{ position: 'relative', flex: '0 0 auto', width: '200px', height: '60px', backgroundColor: '#ff2d75' }}></div>
  <div data-id="f1" data-name="Frame One" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', width: '600px', height: '160px', backgroundColor: '#222244' }}>
    <div data-id="k1" data-name="Kid One" style={{ position: 'relative', flex: '0 0 auto', width: '100px', height: '40px', backgroundColor: '#44aa88' }}></div>
  </div>
  <p data-id="t" data-name="Text" style={{ position: 'relative', flex: '0 0 auto', fontSize: '20px', color: '#ffffff', margin: '0px' }}>Plain text</p>
  <Badge data-id="inst" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto' }} />
  <div data-id="f2" data-name="Frame Last" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '120px', backgroundColor: '#333366' }}></div>
</div>` }), { 'components/Badge.tsx': BADGE_MASTER });

/** A no-layout stage, a flex row and a second flex frame; two canvas nodes. */
const CANVAS_INTO = seed(pageSrc({
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="stage" data-name="Stage" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '300px', backgroundColor: '#222244' }}></div>
  <div data-id="flexbox" data-name="Flexbox" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '10px', width: '600px', height: '200px', backgroundColor: '#333366' }}>
    <div data-id="fb-kid" data-name="FB Kid" style={{ position: 'relative', flex: '0 0 auto', width: '80px', height: '80px', backgroundColor: '#44aa88' }}></div>
  </div>
</div>`,
  canvas: `
  <div data-id="cn1" data-name="Canvas One" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '100px', width: '160px', height: '120px', backgroundColor: '#ff66cc' }}></div>
  <div data-id="cn2" data-name="Canvas Two" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '300px', width: '100px', height: '80px', backgroundColor: '#66ccff' }}></div>`,
}));

/** Out-of-flow nodes (absolute in a stage, a fixed one) and flex targets,
 *  one of them hidden. */
const OUT_OF_FLOW = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="stage" data-name="Stage" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '300px', backgroundColor: '#222244' }}>
    <div data-id="abs1" data-name="Abs One" style={{ position: 'absolute', left: '27.69%', top: '20px', width: '80px', height: '60px', backgroundColor: '#ff2d75' }}></div>
    <div data-id="abs2" data-name="Abs Two" style={{ position: 'absolute', left: '50px', top: '120px', right: '400px', width: '80px', height: '60px', backgroundColor: '#ffcc33' }}></div>
  </div>
  <div data-id="flex-a" data-name="Flex A" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '10px', width: '600px', height: '150px', backgroundColor: '#333366' }}>
    <div data-id="fa-kid" data-name="FA Kid" style={{ position: 'relative', flex: '0 0 auto', width: '60px', height: '60px', backgroundColor: '#44aa88' }}></div>
  </div>
  <div data-id="flex-h" data-name="Flex Hidden" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '10px', width: '600px', height: '150px', backgroundColor: '#336633' }}>
    <div data-id="fh-kid" data-name="FH Kid" style={{ position: 'relative', flex: '0 0 auto', width: '60px', height: '40px', backgroundColor: '#88aa44' }}></div>
  </div>
  <div data-id="fx" data-name="Fixed" style={{ position: 'fixed', left: '40px', top: '600px', width: '120px', height: '60px', backgroundColor: '#cc66ff' }}></div>
</div>` }));

/** A CMS team list: heading, the `.map()` row template (a `<Link>` with two
 *  children), footer; plus a Badge instance and an ordinary link. */
const TEAM = seed(pageSrc({
  imports: ["import Link from 'next/link';", "import team from '@/cms/team.json';", BADGE_IMPORT],
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="team-list" data-name="Team" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '12px', backgroundColor: '#ffffff' }}>
    <h3 data-id="team-head" data-name="Team Head" style={{ position: 'relative', flex: '0 0 auto', fontSize: '18px', color: '#111111', margin: '0px' }}>Our team</h3>
    {team.map((item, idx) => (
      <Link data-cms-nav="row" href={\`/team/\${item?._slug ?? ''}\`} data-id="team-row" key={idx} data-name="Member" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', width: '100%', height: '56px', padding: '8px', backgroundColor: '#eeeeee' }}>
        <div data-id="member-photo" data-name="Photo" style={{ position: 'relative', flex: '0 0 auto', width: '40px', height: '40px', backgroundColor: '#999999' }} />
        <p data-id="member-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.name}</p>
      </Link>
    ))}
    <p data-id="team-foot" data-name="Team Foot" style={{ position: 'relative', flex: '0 0 auto', fontSize: '12px', color: '#555555', margin: '0px' }}>See all</p>
  </div>
  <Link data-id="plain-link" data-name="Plain Link" href="/about" style={{ position: 'relative', flex: '0 0 auto', fontSize: '16px', color: '#ffffff' }}>About us</Link>
  <Badge data-id="badge-x" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>` }), { ...C1_CMS_FILES, 'components/Badge.tsx': BADGE_MASTER });

// ─── Templated page: app/(Main)/ with a LayoutClient (header, {children}, footer)

const LAYOUT_SERVER = `import LayoutClient from './LayoutClient';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LayoutClient>{children}</LayoutClient>;
}
`;
const LAYOUT_CLIENT = `'use client';

${canvasHeader(TILES.one)}

import React from 'react';

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return <div data-id="root" data-name="Layout" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', minHeight: '100vh', backgroundColor: '#101020' }}>
    <nav data-id="hdr" data-name="Header" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '60px', backgroundColor: '#eeeeee' }}></nav>
    {children}
    <footer data-id="ftr" data-name="Footer" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '60px', backgroundColor: '#cccccc' }}></footer>
  </div>;
}
`;
const TPL_PAGE = 'app/(Main)/page.client.tsx';
const TPL_LAYOUT = 'app/(Main)/LayoutClient.tsx';
const TEMPLATED = {
  format: 'revyme-v1' as const,
  files: {
    'app/(Main)/layout.tsx': LAYOUT_SERVER,
    [TPL_LAYOUT]: LAYOUT_CLIENT,
    'app/(Main)/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    [TPL_PAGE]: pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '900px', backgroundColor: '#ffffff' }}>
  ${box('hero', 'Hero', "backgroundColor: '#3355ff'")}
  ${box('s2', 'Section Two', "display: 'flex', flexDirection: 'row', backgroundColor: '#33aa55'", `<div data-id="s2-item" data-name="S2 Item" style={{ position: 'relative', flex: '0 0 auto', width: '200px', height: '60px', backgroundColor: '#ffcc33' }}></div>`)}
  ${box('s3', 'Section Three', "backgroundColor: '#aa3355'")}
</div>` }),
  },
};

async function openTemplatedPage(editor: Editor): Promise<void> {
  await editor.openFile(TPL_PAGE);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, TPL_PAGE);
  await editor.sandbox().locator('[data-node-id="hero"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
}

// ─── Component masters (variants: desktop = default, variant-1, variant-2) ──

const CARD = 'components/Card.tsx';
const chip = (n: number | string, color: string, extra = '', attrs = '') =>
  `<motion.div layout={true} data-id="chip-${n}" data-name="Chip ${n}"${attrs} style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '${color}', flex: '0 0 auto'${extra ? `, ${extra}` : ''} }} />`;
const cardRoot = (kids: string) => `
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={initialVariant} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '360px', height: 'auto', padding: '20px', backgroundColor: '#000000', ...style }}>
${kids}
    </motion.div>`;

/** A flex row whose `chip-h` renders only on variant-2 (hidden on desktop). */
const MASTER_HIDDEN_SIBLING = cardRoot(`
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '60px', flex: '0 0 auto' }}>
        ${chip(1, '#ff2d75', "order: '0'")}
        <AnimatePresence mode="popLayout">{initialVariant === 'variant-2' && (
          <motion.div layout={true} key="chip-h" data-id="chip-h" data-name="Chip H" exit={{ opacity: 0 }} style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '1' }} />
        )}</AnimatePresence>
        ${chip(2, '#33cc88', "order: '2'")}
        ${chip(3, '#3355ff', "order: '3'")}
      </motion.div>`);

/** chip-1 / chip-3 keep their order in `chipNVariants.default`, chip-2 in its base style. */
const MASTER_VARIANT_ORDER = cardRoot(`
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '60px', flex: '0 0 auto' }}>
        ${chip(1, '#ff2d75', '', " variants={chip1Variants} initial={['default', initialVariant]} animate={['default', initialVariant]}")}
        ${chip(2, '#33cc88', "order: '1'")}
        ${chip(3, '#3355ff', '', " variants={chip3Variants} initial={['default', initialVariant]} animate={['default', initialVariant]}")}
      </motion.div>`);
const VARIANT_ORDER_PRE = `const chip1Variants = {
  default: { order: 0 },
  'variant-1': { backgroundColor: '#aa22ff' },
};
const chip3Variants = {
  default: { order: 2 },
  'variant-1': { backgroundColor: '#22aaff' },
};`;

/** `v2-only` renders only on variant-2; a row frame to drop it into. */
const MASTER_V2_ONLY = cardRoot(`
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '80px', padding: '10px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        ${chip(1, '#ff2d75')}
      </motion.div>
      <AnimatePresence mode="popLayout">{initialVariant === 'variant-2' && (
        <motion.div layout={true} key="v2-only" data-id="v2-only" data-name="V2 Only" exit={{ opacity: 0 }} style={{ position: 'relative', width: '120px', height: '30px', backgroundColor: '#ff8800', flex: '0 0 auto' }} />
      )}</AnimatePresence>`);

/** 3-tile page (sections + a canvas node) and a master with a canvas node. */
const HEADERS = seed(pageSrc({
  tiles: TILES.three,
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  ${box('s1', 'Section One', "display: 'flex', flexDirection: 'row'", `<div data-id="inner" data-name="Inner" style={{ position: 'relative', flex: '0 0 auto', width: '160px', height: '60px', backgroundColor: '#ffcc33' }}></div>`)}
  ${box('s2', 'Section Two', "backgroundColor: '#33aa55'")}
</div>`,
  canvas: `<div data-id="cn" data-name="Loose Box" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '100px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
}), {
  [CARD]: masterModule(cardRoot(`
      <motion.div layout={true} data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '80px', flex: '0 0 auto' }}>
        ${chip(1, '#ff2d75')}
        <motion.div layout={true} data-id="deep" data-name="Deep" style={{ position: 'relative', width: '40px', height: '40px', backgroundColor: '#ffffff', flex: '0 0 auto' }} />
      </motion.div>`)) + `
const canvasNodes = (<>
  <div data-id="loose" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '480px', top: '-260px', width: '90px', height: '50px', backgroundColor: '#7c5cff' }}></div>
</>);
`,
});

/** Painted left-to-right order of chips in a tile (missing / 0-size ones left out). */
async function chipOrder(editor: Editor, vpId: string, ids: string[]): Promise<string[]> {
  const out: Array<{ id: string; x: number }> = [];
  for (const id of ids) {
    const loc = await editor.nodeIn(vpId, id);
    if (!(await loc.count())) continue;
    const b = await loc.first().boundingBox().catch(() => null);
    if (b && b.width > 0) out.push({ id, x: b.x });
  }
  return out.sort((a, b) => a.x - b.x).map(o => o.id);
}

// ─── Banded pages ─────────────────────────────────────────────────────

const styleBlock = (css: string) => `<style>{\`
${css}
  \`}</style>`;
const kid = (id: string, color: string, order: number) =>
  `<div data-id="${id}" data-name="${id.toUpperCase()}" style={{ position: 'relative', flex: '0 0 auto', order: '${order}', width: '80px', height: '40px', backgroundColor: '${color}' }}></div>`;

/** `box` is a block at base and a flex ROW only in the mobile band; its children carry explicit order. */
const FLEX_ONLY_MOBILE = seed(pageSrc({
  tiles: TILES.two,
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  ${styleBlock(`    @media (max-width: 375px) {
      [data-id="box"] { display: flex !important; flex-direction: row !important; }
    }`)}
  <div data-id="box" data-name="Box" style={{ position: 'relative', flex: '0 0 auto', display: 'block', width: '100%', height: '200px', backgroundColor: '#222244' }}>
    ${kid('k1', '#ff2d75', 0)}
    ${kid('k2', '#33cc88', 1)}
    ${kid('k3', '#3355ff', 2)}
  </div>
</div>` }));

const section = (id: string, color: string, order: number, kids = '') =>
  `<div data-id="${id}" data-name="${id.toUpperCase()}" style={{ position: 'relative', flex: '0 0 auto', order: '${order}', display: 'flex', flexDirection: 'column', width: '100%', height: '120px', backgroundColor: '${color}' }}>${kids}</div>`;

/** Three sections; the tablet band has its own (reversed) order map. */
const TABLET_ORDER = seed(pageSrc({
  tiles: TILES.three,
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  ${styleBlock(`    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="s1"] { order: 2 !important; }
      [data-id="s2"] { order: 1 !important; }
      [data-id="s3"] { order: 0 !important; }
    }`)}
  ${section('s1', '#aa3355', 0)}
  ${section('s2', '#33aa55', 1)}
  ${section('s3', '#3355aa', 2)}
</div>` }));

/** Three sections whose MOBILE band reorders them CSS-only (f3, f1, f2); `k` sits in f1. */
const MOBILE_CSS_ORDER = seed(pageSrc({
  tiles: TILES.two,
  root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  ${styleBlock(`    @media (max-width: 375px) {
      [data-id="f1"] { order: 1 !important; }
      [data-id="f2"] { order: 2 !important; }
      [data-id="f3"] { order: 0 !important; }
    }`)}
  ${section('f1', '#aa3355', 0, `<div data-id="k" data-name="K" style={{ position: 'relative', flex: '0 0 auto', width: '80px', height: '40px', backgroundColor: '#ffcc33' }}></div>`)}
  ${section('f2', '#33aa55', 1)}
  ${section('f3', '#3355aa', 2)}
</div>` }));

/** Painted top-to-bottom order of root sections in a tile. */
async function sectionOrder(editor: Editor, vpId: string, ids: string[]): Promise<string[]> {
  const out: Array<{ id: string; y: number }> = [];
  for (const id of ids) {
    const b = await (await editor.nodeIn(vpId, id)).boundingBox().catch(() => null);
    if (b && b.height > 0) out.push({ id, y: b.y });
  }
  return out.sort((a, b) => a.y - b.y).map(o => o.id);
}

/** A FIT text (svg > foreignObject > p) in `holder`, a destination frame, a mover. */
const FIT = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="m" data-name="Mover" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '200px', height: '50px', backgroundColor: '#ff2d75' }}></div>
  <div data-id="holder" data-name="Holder" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '10px', width: '600px', padding: '10px', backgroundColor: '#222244' }}>
    <div data-id="h-kid" data-name="H Kid" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100px', height: '30px', backgroundColor: '#44aa88' }}></div>
    <svg data-id="t-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{ width: '300px', height: 'auto', overflow: 'visible', display: 'block', whiteSpace: 'pre', position: 'relative', flex: '0 0 auto', order: '1' }} viewBox="0 0 300 40">
      <foreignObject width="100%" height="100%" style={{ overflow: 'visible' }}>
        <p data-id="t" data-name="Fit Title" style={{ fontSize: '32px', color: '#ffffff', margin: '0', lineHeight: '1' }}>Hello FIT</p>
      </foreignObject>
    </svg>
  </div>
  <div data-id="dest" data-name="Dest" style={{ position: 'relative', flex: '0 0 auto', order: '2', display: 'flex', flexDirection: 'column', width: '600px', height: '160px', backgroundColor: '#333366' }}>
    <div data-id="d-kid" data-name="D Kid" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100px', height: '30px', backgroundColor: '#aa8844' }}></div>
  </div>
</div>` }));

/** Sixty rows: a Layers list taller than the panel. */
const LONG = seed(pageSrc({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
${Array.from({ length: 60 }, (_, i) => `  <div data-id="r${i}" data-name="Row ${i}" style={{ position: 'relative', flex: '0 0 auto', order: '${i}', width: '400px', height: '14px', backgroundColor: '#${(i % 2 ? '333366' : '444488')}' }}></div>`).join('\n')}
</div>` }));

async function undoTo(editor: Editor, before: string): Promise<void> {
  await editor.undo();
  await expect.poll(() => editor.code(), { timeout: 5_000 }).toBe(before);
}

// ─── DND-096 ──────────────────────────────────────────────────────────

test('DND-096 layers drop on the top of a row reorders JSX + order and repaints at once', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABC);
  const page = editor.page();
  await openLayers(page);
  const before = await editor.code();
  const mark = await traceMark(page);

  const ind = await dragLayerRow(editor, lid('c'), lid('a'), 'top');
  // Indicator before `a`.
  expect(ind).toEqual({ layerId: lid('a'), position: 'before' });

  // Source: structural JSX reorder AND the order renumber, in tree order.
  await expect(editor).toHaveJsxOrder('root', ['c', 'a', 'b']);
  await expect(editor).toHaveStyle('c', 'order', '0');
  await expect(editor).toHaveStyle('a', 'order', '1');
  await expect(editor).toHaveStyle('b', 'order', '2');

  // Tree agrees.
  await expect.poll(async () => page.evaluate(() =>
    [...document.querySelectorAll('[data-layer-id^="desktop:"]')].map(r => r.getAttribute('data-layer-node-id'))))
    .toEqual(['c', 'a', 'b']);

  // Canvas repaints at once — no further edit, the render is forced by the drop.
  await expect.poll(() => visualOrder(editor, 'root'), { timeout: 3_000 }).toEqual(['c', 'a', 'b']);
  const forced = await tracesSince(page, mark, 'forceRenderAfterExternalEdit');
  expect(forced.some(t => t.data?.reason === 'layers-panel:drop'), 'drop forced a canvas render').toBe(true);
  const commit = (await tracesSince(page, mark, 'layers:drop-order-commit')).pop();
  expect(commit?.data?.desired).toEqual(['c', 'a', 'b']);

  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-097 ──────────────────────────────────────────────────────────

test('DND-097 layers drop zones: frame middle inside, last-frame bottom after, text/instance split at half', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(ZONES);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'k1');
  const before = await editor.code();

  // Frame middle → inside (appended after its existing child).
  expect(await dragLayerRow(editor, lid('m'), lid('f1'), 'middle')).toEqual({ layerId: lid('f1'), position: 'inside' });
  await expect(editor).toHaveJsxOrder('f1', ['k1', 'm']);
  await undoTo(editor, before);

  // Bottom 30% of the frame that is the LAST child → after it.
  expect(await dragLayerRow(editor, lid('m'), lid('f2'), 'bottom')).toEqual({ layerId: lid('f2'), position: 'after' });
  await expect(editor).toHaveJsxOrder('root', ['f1', 't', 'inst', 'f2', 'm']);
  expect(await editor.childIds('f2')).toEqual([]);
  await undoTo(editor, before);

  // Bottom 30% of a frame that is NOT the last child → inside.
  expect(await dragLayerRow(editor, lid('m'), lid('f1'), 'bottom')).toEqual({ layerId: lid('f1'), position: 'inside' });
  await expect(editor).toHaveJsxOrder('f1', ['k1', 'm']);
  await undoTo(editor, before);

  // Text row: split at half — top half before, bottom half after (never inside).
  const overText: Array<string | null> = [];
  await dragLayerRow(editor, lid('m'), lid('t'), 0.3, {
    during: async (s) => {
      overText.push(JSON.stringify(await rowIndicator(page)));
      await s.hoverRow(lid('t'), 0.5);
      overText.push(JSON.stringify(await rowIndicator(page)));
      await s.hoverRow(lid('t'), 0.7);
      overText.push(JSON.stringify(await rowIndicator(page)));
    },
  });
  expect(overText.map(j => JSON.parse(j!)?.position)).toEqual(['before', 'after', 'after']);
  await expect(editor).toHaveJsxOrder('root', ['f1', 't', 'm', 'inst', 'f2']);
  await undoTo(editor, before);

  // Instance row: same split, and its middle is NOT inside.
  const overInst: string[] = [];
  await dragLayerRow(editor, lid('m'), lid('inst'), 0.3, {
    during: async (s) => {
      overInst.push(JSON.stringify(await rowIndicator(page)));
      await s.hoverRow(lid('inst'), 0.55);
      overInst.push(JSON.stringify(await rowIndicator(page)));
      await s.hoverRow(lid('inst'), 0.7);
      overInst.push(JSON.stringify(await rowIndicator(page)));
    },
  });
  expect(overInst.map(j => JSON.parse(j)?.position)).toEqual(['before', 'after', 'after']);
  await expect(editor).toHaveJsxOrder('root', ['f1', 't', 'inst', 'm', 'f2']);
  expect(await editor.parentOf('m')).toBe('root');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-098 ──────────────────────────────────────────────────────────

test('DND-098 canvas-node row into a no-layout frame goes absolute + centred; into flex becomes a flow child', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(CANVAS_INTO);
  const page = editor.page();
  await openLayers(page);
  const before = await editor.code();

  // No-layout page frame → absolute, centred in the frame, canvas-node flag gone.
  expect(await dragLayerRow(editor, lid('cn1'), lid('stage'), 'middle')).toEqual({ layerId: lid('stage'), position: 'inside' });
  await expect.poll(() => editor.parentOf('cn1')).toBe('stage');
  await expect(editor).toHaveStyle('cn1', 'position', 'absolute');
  await expect(editor).toHaveStyle('cn1', 'left', `${(600 - 160) / 2}px`);
  await expect(editor).toHaveStyle('cn1', 'top', `${(300 - 120) / 2}px`);
  expect(await editor.attr('cn1', 'data-canvas-node')).toBeNull();
  // Painted centred inside the stage.
  await expect.poll(async () => {
    const s = await editor.nodeBox('stage'); const n = await editor.nodeBox('cn1');
    return Math.round(((n.x + n.width / 2) - (s.x + s.width / 2)) + ((n.y + n.height / 2) - (s.y + s.height / 2)));
  }).toBe(0);
  await undoTo(editor, before);

  // Flex frame → flow child: relative, insets cleared, flex 0 0 auto.
  expect(await dragLayerRow(editor, lid('cn2'), lid('flexbox'), 'middle')).toEqual({ layerId: lid('flexbox'), position: 'inside' });
  await expect.poll(() => editor.parentOf('cn2')).toBe('flexbox');
  await expect(editor).toHaveStyle('cn2', 'position', 'relative');
  for (const p of ['left', 'top', 'right', 'bottom']) await expect(editor).toHaveStyle('cn2', p, null);
  await expect(editor).toHaveStyle('cn2', 'flex', '0 0 auto');
  expect(await editor.attr('cn2', 'data-canvas-node')).toBeNull();
  await expect(editor).toHaveJsxOrder('flexbox', ['fb-kid', 'cn2']);
  // Painted in the row's flow, right of its sibling.
  await expect.poll(async () => {
    const k = await editor.nodeBox('fb-kid'); const n = await editor.nodeBox('cn2');
    return n.x > k.x + k.width - 1 && Math.abs(n.y - k.y) < 2;
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-102 ──────────────────────────────────────────────────────────

test('DND-102 absolute node into a flex frame (visible or hidden) becomes a flow child and stays one after unhide', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(OUT_OF_FLOW);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'abs1');

  // Hide flex-h with its eye (real UI) — it is now hidden on this tile.
  const hRow = layerRow(page, lid('flex-h'));
  await hRow.hover();
  await hRow.locator('[title="Hide layer"]').click();
  await expect(editor).toHaveStyle('flex-h', 'display', 'none');
  await expect(editor).toHaveStyle('flex-h', 'flexDirection', 'column');
  const before = await editor.code();
  const mark = await traceMark(page);

  // Visible flex frame.
  expect(await dragLayerRow(editor, lid('abs1'), lid('flex-a'), 'middle')).toEqual({ layerId: lid('flex-a'), position: 'inside' });
  await expect.poll(() => editor.parentOf('abs1')).toBe('flex-a');
  await expect(editor).toHaveStyle('abs1', 'position', 'relative');
  for (const p of ['left', 'top', 'right', 'bottom']) await expect(editor).toHaveStyle('abs1', p, null);
  // Not: kept `left: 27.69%` and stayed absolute.
  expect((await editor.style('abs1')).left).not.toBe('27.69%');

  // Hidden flex frame — its authored flexDirection says flex, so the same flow entry.
  const beforeHidden = await editor.code();
  expect(await dragLayerRow(editor, lid('abs2'), lid('flex-h'), 'middle')).toEqual({ layerId: lid('flex-h'), position: 'inside' });
  await expect.poll(() => editor.parentOf('abs2')).toBe('flex-h');
  await expect(editor).toHaveStyle('abs2', 'position', 'relative');
  for (const p of ['left', 'top', 'right', 'bottom']) await expect(editor).toHaveStyle('abs2', p, null);
  const fallback = (await tracesSince(page, mark, 'layers-drag:authored-layout-fallback')).pop();
  expect(fallback?.data).toMatchObject({ parentId: 'flex-h', parentLayout: 'flex' });
  await expect(editor).toUndoInOneStep(beforeHidden);

  // Unhide: abs2 is still a flow child, painted at the frame's content start.
  await hRow.hover();
  await hRow.locator('[title="Show layer"]').click();
  await expect(editor).not.toHaveStyle('flex-h', 'display', 'none');
  await expect(editor).toHaveStyle('abs2', 'position', 'relative');
  for (const p of ['left', 'top']) await expect(editor).toHaveStyle('abs2', p, null);
  await expect.poll(async () => {
    const f = await editor.nodeBox('flex-h'); const k = await editor.nodeBox('fh-kid'); const n = await editor.nodeBox('abs2');
    return Math.abs(n.x - f.x) < 2 && n.y >= k.y + k.height - 1;
  }).toBe(true);
  expect(before).not.toBe(await editor.code());
});

// ─── DND-103 ──────────────────────────────────────────────────────────

test('DND-103 a fixed node reparented by layers is never left fixed: flow child in flex, absolute in a no-layout frame', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(OUT_OF_FLOW);
  const page = editor.page();
  await openLayers(page);
  const before = await editor.code();

  // Into a flex frame → flow child.
  expect(await dragLayerRow(editor, lid('fx'), lid('flex-a'), 'middle')).toEqual({ layerId: lid('flex-a'), position: 'inside' });
  await expect.poll(() => editor.parentOf('fx')).toBe('flex-a');
  await expect(editor).toHaveStyle('fx', 'position', 'relative');
  for (const p of ['left', 'top', 'right', 'bottom']) await expect(editor).toHaveStyle('fx', p, null);
  await undoTo(editor, before);

  // Into a no-layout frame → absolute (pinned inside the frame), never fixed.
  expect(await dragLayerRow(editor, lid('fx'), lid('stage'), 'middle')).toEqual({ layerId: lid('stage'), position: 'inside' });
  await expect.poll(() => editor.parentOf('fx')).toBe('stage');
  await expect(editor).toHaveStyle('fx', 'position', 'absolute');
  const st = await editor.style('fx');
  // Re-pinned centred in the frame (the no-layout drop rule), not the old
  // viewport-anchored fixed pins (left 40px / top 600px lies outside a 300px frame).
  expect(st.left).toBe(`${(600 - 120) / 2}px`);
  expect(st.top).toBe(`${(300 - 60) / 2}px`);
  // Never fixed with flex/order bolted on.
  expect(st.position).not.toBe('fixed');
  expect(st.flex).toBeUndefined();
  expect(st.order).toBeUndefined();
  // Painted inside the stage.
  await expect.poll(async () => {
    const s = await editor.nodeBox('stage'); const n = await editor.nodeBox('fx');
    return n.x >= s.x - 1 && n.y >= s.y - 1 && n.x + n.width <= s.x + s.width + 1 && n.y + n.height <= s.y + s.height + 1;
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-107 ──────────────────────────────────────────────────────────

test('DND-107 a frame row dragged onto its own descendant shows no indicator and changes nothing', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ZONES);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'k1');
  const before = await editor.code();
  const rowsBefore = await page.evaluate(() => [...document.querySelectorAll('[data-layer-id]')].map(r => r.getAttribute('data-layer-id')));
  const mark = await traceMark(page);

  const seen: Array<unknown> = [];
  const ind = await dragLayerRow(editor, lid('f1'), lid('k1'), 'top', {
    during: async (s) => {
      for (const z of ['top', 'middle', 'bottom'] as const) {
        await s.hoverRow(lid('k1'), z);
        seen.push(await rowIndicator(page));
      }
    },
  });
  expect(seen).toEqual([null, null, null]);
  expect(ind).toBeNull();
  await editor.settled();
  expect(await editor.code()).toBe(before);
  expect(await tracesSince(page, mark, 'layers:drop')).toEqual([]);
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-layer-id]')].map(r => r.getAttribute('data-layer-id')))).toEqual(rowsBefore);
});

// ─── DND-108 ──────────────────────────────────────────────────────────

test('DND-108 hovering a frame row in the inside zone outlines that container on the canvas', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ZONES);
  const page = editor.page();
  await openLayers(page);
  const f1 = await editor.nodeBox('f1');
  let during: Awaited<ReturnType<typeof canvasDropHighlight>> = null;
  let overText: Awaited<ReturnType<typeof canvasDropHighlight>> = null;
  const s = await pressLayerRow(page, lid('m'));
  try {
    await s.hoverRow(lid('t'), 0.3);
    expect(await rowIndicator(page)).toEqual({ layerId: lid('t'), position: 'before' });
    overText = await canvasDropHighlight(page);
    await s.hoverRow(lid('f1'), 'middle');
    expect(await rowIndicator(page)).toEqual({ layerId: lid('f1'), position: 'inside' });
    await expect.poll(() => canvasDropHighlight(page).then(h => !!h)).toBe(true);
    during = await canvasDropHighlight(page);
  } finally {
    await s.release();
    await editor.settled();
  }
  // No container highlight for a before/after reorder.
  expect(overText).toBeNull();
  // Solid outline + faint fill, on the target container's box.
  expect(during).not.toBeNull();
  expect(during!.fillOpacity).toBe('0.1');
  expect(Math.abs(during!.rect.x - f1.x)).toBeLessThan(3);
  expect(Math.abs(during!.rect.y - f1.y)).toBeLessThan(3);
  expect(Math.abs(during!.rect.width - f1.width)).toBeLessThan(4);
  expect(Math.abs(during!.rect.height - f1.height)).toBeLessThan(4);
  const dashed = await page.evaluate(() => !!document.querySelector('svg > path[fill-opacity="0.1"][stroke-dasharray]'));
  expect(dashed).toBe(false);
  // Cleared on drop.
  await expect.poll(() => canvasDropHighlight(page)).toBeNull();
  await expect(editor).toHaveJsxOrder('f1', ['k1', 'm']);
});

// ─── DND-118 ──────────────────────────────────────────────────────────

test('DND-118 releasing a layers drag over empty panel space changes nothing', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(ZONES);
  const page = editor.page();
  await openLayers(page);
  const before = await editor.code();
  const mark = await traceMark(page);
  const s = await pressLayerRow(page, lid('m'));
  let ind: unknown = 'unset';
  try {
    // Over a row first (an indicator shows), then out to the empty list area below the rows.
    await s.hoverRow(lid('t'), 0.3);
    expect(await rowIndicator(page)).not.toBeNull();
    const list = (await page.locator('[data-layers-scroll]').boundingBox())!;
    const lastRow = await page.locator('[data-layer-id]').last().boundingBox();
    expect(lastRow!.y + lastRow!.height).toBeLessThan(list.y + list.height - 120);
    await s.moveTo({ x: list.x + list.width / 2, y: list.y + list.height - 90 }, 8);
    await frames(page, 3);
    ind = await rowIndicator(page);
  } finally {
    await s.release();
    await editor.settled();
  }
  expect(ind).toBeNull();
  await page.waitForTimeout(300);
  expect(await editor.code()).toBe(before);
  expect(await tracesSince(page, mark, 'layers:drop')).toEqual([]);
  expect((await tracesSince(page, mark, 'forceRenderAfterExternalEdit')).filter(t => String(t.data?.reason).startsWith('layers'))).toEqual([]);
});

// ─── DND-120 ──────────────────────────────────────────────────────────

test('DND-120 a collaborator lock blocks the canvas drag but not the layers drop (today\'s behaviour)', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABC);
  const page = editor.page();
  await openLayers(page);
  await injectRemoteLock(page, { nodeIds: ['c'], name: 'Remote Rita', page: 'app/page.client.tsx' });
  const before = await editor.code();
  const mark = await traceMark(page);

  // Canvas gesture on the locked node: refused (toast names the holder), nothing written.
  const from = await editor.at('c', 0.5, 0.5);
  const to = await editor.at('a', 0.5, 0.1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + 1, from.y + (to.y - from.y) * i / 12);
  await page.mouse.up();
  await editor.settled();
  const blocked = await tracesSince(page, mark, 'collab:blocked-by-lock');
  expect(blocked.length, 'canvas drag consulted the lock').toBeGreaterThan(0);
  expect(blocked[0].data).toMatchObject({ action: 'drag', nodeIds: ['c'] });
  await expect(page.getByText('Remote Rita is editing this element right now')).toBeVisible();
  expect(await editor.code()).toBe(before);

  // DECISION PINNED (2026-10-28): the Layers drop has NO lock check — the same
  // node moves from the tree while the collaborator holds it. When a lock
  // check is added to LayersPanel/drag.ts this test must flip.
  const mark2 = await traceMark(page);
  const ind = await dragLayerRow(editor, lid('c'), lid('a'), 'top');
  expect(ind).toEqual({ layerId: lid('a'), position: 'before' });
  await expect(editor).toHaveJsxOrder('root', ['c', 'a', 'b']);
  expect(await tracesSince(page, mark2, 'collab:blocked-by-lock')).toEqual([]);
  await expect(editor).toUndoInOneStep(before);
  await releaseRemoteLock(page);
});

// ─── DND-099 ──────────────────────────────────────────────────────────

test('DND-099 the Load More row of a paginated list moves once into another container', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(PAGINATED_PAGE);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'loadmore-blogs');
  expect(await editor.parentOf('loadmore-blogs')).toBe('blogs');
  const before = await editor.code();

  expect(await dragLayerRow(editor, lid('loadmore-blogs'), lid('row'), 'middle')).toEqual({ layerId: lid('row'), position: 'inside' });
  await expect.poll(() => editor.parentOf('loadmore-blogs')).toBe('row');
  const after = await stableCode(editor);
  // Moved once: one copy in the source, none left in the list.
  expect(idCount(after, 'loadmore-blogs')).toBe(1);
  expect(await editor.childIds('blogs')).not.toContain('loadmore-blogs');
  await expect(editor).toHaveNoDuplicateIds();
  // One painted copy, inside the row.
  await expect.poll(() => editor.sandbox().locator('[data-node-id="loadmore-blogs"]').count()).toBe(1);
  await expect.poll(async () => {
    const r = await editor.nodeBox('row'); const n = await editor.nodeBox('loadmore-blogs');
    return n.x >= r.x - 1 && n.y >= r.y - 1 && n.y + n.height <= r.y + r.height + 1;
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-100 ──────────────────────────────────────────────────────────

test('DND-100 an overlay row dragged into another container moves once, wrapper intact, and stays valid overlay code', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  // BUG (verified 3×): the Layers drop moves the overlay INTO cta-row — one
  // copy, wrapper intact (the 125703b0 regression stays fixed) — but the result
  // violates the builder's own overlay contract: OVERLAY_NOT_ROOT_CHILD (tier 2,
  // oracle/checks/overlay-dialect.ts) — an overlay must stay the LAST CHILD of
  // root. LayersPanel/drag.ts has no overlay guard. The assertions below hold
  // for any correct fix (refuse the drop, or keep the overlay at root's end).
  test.fail(true, 'BUG: a Layers drop nests an overlay inside a container; the builder\'s oracle rejects it (OVERLAY_NOT_ROOT_CHILD)');
  await editor.load(OVERLAY_PAGE);
  const page = editor.page();
  await openLayers(page);
  // Overlays are listed under their trigger.
  await expandRow(page, lid('trig'));
  await layerRow(page, lid('ov-one')).waitFor();
  const before = await editor.code();
  // `{ovOneOpen && …}` — the conditional that mounts the overlay.
  const wrappers = (c: string) => (c.match(/\{ovOneOpen &&/g) ?? []).length;
  expect(wrappers(before)).toBe(1);

  const ind = await dragLayerRow(editor, lid('ov-one'), lid('cta-row'), 'middle');
  expect(ind).toEqual({ layerId: lid('cta-row'), position: 'inside' });
  const after = await stableCode(editor);
  // Moved once: exactly one JSX copy of the overlay (the generated positioning
  // effect only names it in querySelector strings) and of its wrapper.
  expect(idCount(after, 'ov-one')).toBe(1);
  expect(wrappers(after)).toBe(1);
  await expect(editor).toHaveNoDuplicateIds();
  // The wrapper still wraps it directly.
  const wrapAt = after.indexOf('{ovOneOpen &&');
  const ovAt = after.indexOf('data-id="ov-one"', wrapAt);
  expect(ovAt).toBeGreaterThan(wrapAt);
  expect(after.slice(wrapAt, ovAt)).not.toMatch(/data-id="/);
  // …and the file is still valid overlay code: the builder's oracle accepts it
  // (today: OVERLAY_NOT_ROOT_CHILD on ov-one, nested inside cta-row).
  await expect(editor).toPassOracle();
  if (after !== before) await expect(editor).toUndoInOneStep(before);
});

// ─── DND-101 ──────────────────────────────────────────────────────────

test('DND-101 a CMS row template moves as one .map() inside its list; a template child reorders inside the template', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(TEAM);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'member-name');
  const maps = (c: string) => c.split('team.map(').length - 1;

  // Down: below the footer.
  expect(await dragLayerRow(editor, lid('team-row'), lid('team-foot'), 0.8)).toEqual({ layerId: lid('team-foot'), position: 'after' });
  await expect(editor).toHaveJsxOrder('team-list', ['team-head', 'team-foot', 'team-row']);
  let code = await stableCode(editor);
  expect(maps(code)).toBe(1);
  expect(idCount(code, 'team-row')).toBe(1);
  expect(code.indexOf('team.map(')).toBeGreaterThan(code.indexOf('data-id="team-foot"'));
  // Painted: the three member rows now sit below the footer.
  await expect.poll(async () => {
    const foot = await editor.nodeBox('team-foot');
    const rows = editor.sandbox().locator('[data-id="team-row"]');
    const n = await rows.count();
    if (n !== 3) return `rows=${n}`;
    const first = await rows.first().boundingBox();
    return first && first.y > foot.y ? 'below' : 'above';
  }).toBe('below');

  // Up: above the heading.
  const beforeUp = await editor.code();
  expect(await dragLayerRow(editor, lid('team-row'), lid('team-head'), 0.2)).toEqual({ layerId: lid('team-head'), position: 'before' });
  await expect(editor).toHaveJsxOrder('team-list', ['team-row', 'team-head', 'team-foot']);
  code = await stableCode(editor);
  expect(maps(code)).toBe(1);
  expect(idCount(code, 'team-row')).toBe(1);
  await expect(editor).toUndoInOneStep(beforeUp);

  // A child of the template reorders inside the template.
  const beforeKid = await editor.code();
  expect(await dragLayerRow(editor, lid('member-name'), lid('member-photo'), 0.2)).toEqual({ layerId: lid('member-photo'), position: 'before' });
  await expect(editor).toHaveJsxOrder('team-row', ['member-name', 'member-photo']);
  code = await stableCode(editor);
  expect(maps(code)).toBe(1);
  expect(idCount(code, 'member-name')).toBe(1);
  await expect(editor).toHaveNoDuplicateIds();
  // Every rendered row shows the name left of the photo.
  await expect.poll(async () => {
    const names = editor.sandbox().locator('[data-id="member-name"]');
    const photos = editor.sandbox().locator('[data-id="member-photo"]');
    if ((await names.count()) !== 3) return false;
    const n0 = await names.first().boundingBox(); const p0 = await photos.first().boundingBox();
    return !!n0 && !!p0 && n0.x < p0.x;
  }).toBe(true);
  await expect(editor).toUndoInOneStep(beforeKid);
});

// ─── DND-116 ──────────────────────────────────────────────────────────

test('DND-116 a component drops inside a CMS <Link> row; an ordinary link row stays before/after only', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TEAM);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'team-row');
  const before = await editor.code();

  // The CMS row template accepts an inside drop (as the canvas does).
  expect(await dragLayerRow(editor, lid('badge-x'), lid('team-row'), 'middle')).toEqual({ layerId: lid('team-row'), position: 'inside' });
  await expect.poll(() => editor.parentOf('badge-x')).toBe('team-row');
  await expect(editor).toHaveJsxOrder('team-row', ['member-photo', 'member-name', 'badge-x']);
  await expect.poll(() => editor.sandbox().locator('[data-id="badge-x"]').count()).toBe(3);
  await undoTo(editor, before);

  // An ordinary link: before / after only, never inside.
  const seen: string[] = [];
  await dragLayerRow(editor, lid('badge-x'), lid('plain-link'), 0.25, {
    during: async (s) => {
      seen.push(String((await rowIndicator(page))?.position));
      await s.hoverRow(lid('plain-link'), 'middle');
      seen.push(String((await rowIndicator(page))?.position));
      await s.hoverRow(lid('plain-link'), 0.75);
      seen.push(String((await rowIndicator(page))?.position));
    },
  });
  expect(seen).toEqual(['before', 'after', 'after']);
  await expect.poll(() => editor.parentOf('badge-x')).toBe('root');
  expect(await editor.childIds('plain-link')).toEqual([]);
  await expect(editor).toHaveJsxOrder('root', ['team-list', 'plain-link', 'badge-x']);
  void before;
});

// ─── DND-104 ──────────────────────────────────────────────────────────

test('DND-104 templated page: before hero, after the last section and inside root resolve in FILE index space', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TEMPLATED);
  await openTemplatedPage(editor);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 's2-item');
  // The merged tree leads with the template's header row.
  await layerRow(page, lid('layout::hdr')).waitFor();
  const before = await editor.code(TPL_PAGE);
  const tplBefore = await editor.code(TPL_LAYOUT);

  // Before hero → file index 0, lands BEFORE hero (not after it).
  expect(await dragLayerRow(editor, lid('s2-item'), lid('hero'), 'top')).toEqual({ layerId: lid('hero'), position: 'before' });
  await expect(editor).toHaveJsxOrder('root', ['s2-item', 'hero', 's2', 's3'], { path: TPL_PAGE });
  await expect.poll(async () => {
    const i = await editor.nodeBox('s2-item'); const h = await editor.nodeBox('hero');
    return i.y + i.height <= h.y + 1;
  }).toBe(true);
  await undoTo(editor, before);

  // After the last section → appended.
  expect(await dragLayerRow(editor, lid('s2-item'), lid('s3'), 'bottom')).toEqual({ layerId: lid('s3'), position: 'after' });
  await expect(editor).toHaveJsxOrder('root', ['hero', 's2', 's3', 's2-item'], { path: TPL_PAGE });
  await undoTo(editor, before);

  // Inside root (the viewport header) → appended at the FILE child count.
  expect(await dragLayerRow(editor, lid('s2-item'), vpRow('desktop'), 'middle')).toEqual({ layerId: vpRow('desktop'), position: 'inside' });
  await expect(editor).toHaveJsxOrder('root', ['hero', 's2', 's3', 's2-item'], { path: TPL_PAGE });
  // `layout::` chrome never counted: the template file is untouched and no
  // chrome id was written into the page.
  expect(await editor.code(TPL_LAYOUT)).toBe(tplBefore);
  const code = await editor.code(TPL_PAGE);
  expect(code).not.toContain('layout::');
  expect(await editor.childIds('root', TPL_PAGE)).not.toContain('hdr');
  await expect(editor).toUndoInOneStep(before, { path: TPL_PAGE });
});

// ─── DND-105 ──────────────────────────────────────────────────────────

test('DND-105 template chrome rows and the {children} slot row are never drop targets', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(TEMPLATED);
  await openTemplatedPage(editor);
  const page = editor.page();
  await openLayers(page);
  await layerRow(page, lid('layout::hdr')).waitFor();
  const before = await editor.code(TPL_PAGE);
  const tplBefore = await editor.code(TPL_LAYOUT);
  const mark = await traceMark(page);

  // On the page: the header and footer chrome rows.
  const seen: unknown[] = [];
  let control: unknown = null;
  const ind = await dragLayerRow(editor, lid('hero'), lid('s2'), 'top', {
    during: async (s) => {
      // Positive control: a page row takes the drop, so the drag is live.
      control = await rowIndicator(page);
      for (const z of ['top', 'middle', 'bottom'] as const) {
        await s.hoverRow(lid('layout::hdr'), z);
        seen.push(await rowIndicator(page));
      }
      for (const z of ['top', 'middle', 'bottom'] as const) {
        await s.hoverRow(lid('layout::ftr'), z);
        seen.push(await rowIndicator(page));
      }
    },
  });
  expect(control).toEqual({ layerId: lid('s2'), position: 'before' });
  expect(seen).toEqual([null, null, null, null, null, null]);
  expect(ind).toBeNull();
  expect(await editor.code(TPL_PAGE)).toBe(before);
  expect(await editor.code(TPL_LAYOUT)).toBe(tplBefore);
  expect(await tracesSince(page, mark, 'layers:drop')).toEqual([]);

  // On the template itself: the `{children}` slot row.
  await editor.openFile(TPL_LAYOUT);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, TPL_LAYOUT);
  await editor.settled();
  const slot = page.locator('[data-layer-node-id="children-slot"]').first();
  await slot.waitFor({ timeout: 10_000 });
  const slotId = (await slot.getAttribute('data-layer-id'))!;
  const hdrId = (await page.locator('[data-layer-node-id="hdr"]').first().getAttribute('data-layer-id'))!;
  const ftrId = (await page.locator('[data-layer-node-id="ftr"]').first().getAttribute('data-layer-id'))!;
  const seenSlot: unknown[] = [];
  let control2: unknown = null;
  const ind2 = await dragLayerRow(editor, hdrId, ftrId, 'top', {
    during: async (s) => {
      // Positive control: the template's own footer row takes the drop.
      control2 = await rowIndicator(page);
      for (const z of ['top', 'middle', 'bottom'] as const) {
        await s.hoverRow(slotId, z);
        seenSlot.push(await rowIndicator(page));
      }
    },
  });
  expect(control2).toEqual({ layerId: ftrId, position: 'before' });
  expect(seenSlot).toEqual([null, null, null]);
  expect(ind2).toBeNull();
  expect(await editor.code(TPL_LAYOUT)).toBe(tplBefore);
  expect(await tracesSince(page, mark, 'layers:drop')).toEqual([]);
});

// ─── DND-115 ──────────────────────────────────────────────────────────

test('DND-115 a FIT text row moves with its svg wrapper; drops beside it resolve to the wrapper\'s parent', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FIT);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'd-kid');
  await revealRow(editor, 'h-kid');
  // The tree lists the inner text, not the svg wrapper.
  await layerRow(page, lid('t')).waitFor();
  expect(await layerRow(page, lid('t-svg')).count()).toBe(0);
  const before = await editor.code();
  const svgHolds = (c: string) => {
    const at = c.indexOf('data-id="t-svg"');
    const end = c.indexOf('</svg>', at);
    return at !== -1 && c.indexOf('<foreignObject', at) < end && c.indexOf('data-id="t"', at) < end;
  };

  // Drag the FIT text to another parent: the <svg> travels with its foreignObject.
  expect(await dragLayerRow(editor, lid('t'), lid('dest'), 'middle')).toEqual({ layerId: lid('dest'), position: 'inside' });
  await expect.poll(() => editor.parentOf('t-svg')).toBe('dest');
  let code = await stableCode(editor);
  expect(await editor.parentOf('t')).toBe('t-svg');
  expect(svgHolds(code)).toBe(true);
  // Not: bare <p> pulled out, empty wrapper left behind.
  expect(await editor.childIds('holder')).toEqual(['h-kid']);
  expect(idCount(code, 't')).toBe(1);
  expect(idCount(code, 't-svg')).toBe(1);
  expect((code.match(/<foreignObject/g) ?? []).length).toBe(1);
  await expect(editor).toHaveJsxOrder('dest', ['d-kid', 't-svg']);
  await undoTo(editor, before);

  // Drops beside the FIT row resolve to holder in row index space — never into the foreignObject.
  expect(await dragLayerRow(editor, lid('m'), lid('t'), 0.25)).toEqual({ layerId: lid('t'), position: 'before' });
  await expect(editor).toHaveJsxOrder('holder', ['h-kid', 'm', 't-svg']);
  expect(await editor.childIds('t-svg')).toEqual(['t']);
  await undoTo(editor, before);

  expect(await dragLayerRow(editor, lid('m'), lid('t'), 0.75)).toEqual({ layerId: lid('t'), position: 'after' });
  await expect(editor).toHaveJsxOrder('holder', ['h-kid', 't-svg', 'm']);
  expect(await editor.childIds('t-svg')).toEqual(['t']);
  code = await stableCode(editor);
  expect(svgHolds(code)).toBe(true);
  // Painted below the FIT text, in the holder's flow.
  await expect.poll(async () => {
    const t = await editor.nodeBox('t-svg'); const n = await editor.nodeBox('m');
    return n.y >= t.y + t.height - 1;
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-117 ──────────────────────────────────────────────────────────

test('DND-117 a long Layers list auto-scrolls while the drag holds still at its edge, faster nearer the edge', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(LONG);
  const page = editor.page();
  await openLayers(page);
  const list = page.locator('[data-layers-scroll]');
  const metrics = () => list.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect((await metrics()).max, 'list is taller than the panel').toBeGreaterThan(600);
  const lb = (await list.boundingBox())!;
  const before = await editor.code();
  const x = lb.x + Math.min(120, lb.width / 2);
  const bottom = lb.y + lb.height;
  /** scrollTop change while the mouse sits still at `y` for `ms`. */
  const still = async (px: number, y: number, ms: number) => {
    await page.mouse.move(px, y);
    await frames(page, 2);
    const a = (await metrics()).top;
    await page.waitForTimeout(ms);
    return (await metrics()).top - a;
  };

  const s = await pressLayerRow(page, lid('r1'));
  let inner = 0, edge = 0, up = 0, sideways = 0;
  try {
    // Inner edge of the 52px band, then the very edge — same hold time.
    inner = await still(x, bottom - 46, 400);
    edge = await still(x, bottom - 3, 400);
    // Near the top edge: scrolls back up.
    up = await still(x, lb.y + 4, 400);
    // Out of the column sideways (beyond the 24px slack), at the bottom edge: no scroll.
    sideways = await still(lb.x + lb.width + 80, bottom - 3, 400);
    // End the drag off the column so nothing drops.
    expect(await rowIndicator(page)).toBeNull();
  } finally {
    await s.release();
    await editor.settled();
  }
  expect(inner, 'scrolls with the mouse held still').toBeGreaterThan(0);
  expect(edge, 'faster nearer the edge').toBeGreaterThan(inner * 2);
  expect(up, 'scrolls up near the top edge').toBeLessThan(0);
  expect(sideways, 'no scroll once the cursor leaves the column').toBe(0);
  expect(await editor.code()).toBe(before);
});

// ─── DND-106 ──────────────────────────────────────────────────────────

test.describe('tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-106 drops on a viewport header append to the real root; on a variant header to that variant\'s root', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    // BUG (verified 3×): every routing rule of the row holds, but both
    // canvas-node entries leave code the builder's own oracle rejects:
    //   page:   the replica-solo storage `display: 'none'` on `cn` → DISPLAY_TOGGLE_VISIBILITY (tier 2);
    //   master: `loose` enters the tree as a plain <div> carrying `layout` → MOTION_PROPS_ON_PLAIN_TAG (tier 2).
    test.fail(true, 'BUG: a canvas node dropped on a non-primary page/variant header leaves oracle violations (DISPLAY_TOGGLE_VISIBILITY on the page, MOTION_PROPS_ON_PLAIN_TAG in the master)');
    await editor.load(HEADERS, { fit: true });
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'inner');
    const before = await editor.code();

    // Page header → appended to the real `root`.
    expect(await dragLayerRow(editor, lid('inner'), vpRow('desktop'), 'middle')).toEqual({ layerId: vpRow('desktop'), position: 'inside' });
    await expect(editor).toHaveJsxOrder('root', ['s1', 's2', 'inner']);
    expect(await editor.code()).not.toContain('layout::');
    await undoTo(editor, before);

    // A canvas node dropped on a NON-primary header is isolated to that tile.
    expect(await dragLayerRow(editor, lid('cn'), vpRow('mobile'), 'middle')).toEqual({ layerId: vpRow('mobile'), position: 'inside' });
    await expect.poll(() => editor.parentOf('cn')).toBe('root');
    await expect(editor).toHaveJsxOrder('root', ['s1', 's2', 'cn']);
    await expect(editor).toHaveStyle('cn', 'display', 'none');
    await expect.poll(async () => (await editor.bandStyle(375, 'cn', 'display'))?.value ?? null).not.toBeNull();
    expect((await editor.bandStyle(375, 'cn', 'display'))?.value).not.toBe('none');
    expect(await editor.attr('cn', 'data-replica-solo')).toBe('mobile');
    expect(await editor.attr('cn', 'data-canvas-node')).toBeNull();
    // Soft: record the page-side violation and still exercise the master half.
    await expect.soft(editor).toPassOracle();
    // Painted on mobile only.
    await expect.poll(async () => (await (await editor.nodeIn('mobile', 'cn')).boundingBox())?.width ?? 0).toBeGreaterThan(0);
    for (const vp of ['desktop', 'tablet']) {
      await expect.poll(async () => (await (await editor.nodeIn(vp, 'cn')).boundingBox().catch(() => null))?.width ?? 0).toBe(0);
    }
    await expect(editor).toUndoInOneStep(before);

    // Component master: the variant header → appended to the variant root id (card-root, not `root`).
    await openMaster(editor, CARD);
    await openLayers(page);
    await revealRow(editor, 'deep');
    const mBefore = await editor.code(CARD);
    expect(await dragLayerRow(editor, lid('deep'), vpRow('desktop'), 'middle')).toEqual({ layerId: vpRow('desktop'), position: 'inside' });
    await expect.poll(() => editor.parentOf('deep', CARD)).toBe('card-root');
    await expect(editor).toHaveJsxOrder('card-root', ['row', 'deep'], { path: CARD });
    await undoTo(editor, mBefore);

    // A canvas node dropped on a non-primary VARIANT header is isolated to that variant.
    expect(await dragLayerRow(editor, lid('loose'), vpRow('variant-1'), 'middle')).toEqual({ layerId: vpRow('variant-1'), position: 'inside' });
    await expect.poll(() => editor.parentOf('loose', CARD)).toBe('card-root');
    const mAfter = await stableCode(editor, CARD);
    expect(conditionalAround(mAfter, 'loose'), 'variant visibility conditional').toMatch(/variant-1/);
    await expect.soft(editor).toPassOracle();
    await expect.poll(async () => (await (await editor.nodeIn('variant-1', 'loose')).boundingBox().catch(() => null))?.width ?? 0).toBeGreaterThan(0);
    for (const vp of ['desktop', 'variant-2']) {
      await expect.poll(async () => (await (await editor.nodeIn(vp, 'loose')).boundingBox().catch(() => null))?.width ?? 0).toBe(0);
    }
    await expect(editor).toUndoInOneStep(mBefore, { path: CARD });
  });

  // ─── DND-109 ────────────────────────────────────────────────────────

  test('DND-109 master: reorder past a variant-hidden sibling keeps its authored slot and one copy', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(seed(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px' }} />` }), { [CARD]: masterModule(MASTER_HIDDEN_SIBLING) }), { fit: true });
    await openMaster(editor, CARD);
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'chip-1');
    // The tree shows the hidden sibling in its authored slot.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-layer-id^="desktop:chip-"]')].map(r => r.getAttribute('data-layer-node-id'))))
      .toEqual(['chip-1', 'chip-h', 'chip-2', 'chip-3']);
    const before = await editor.code(CARD);

    expect(await dragLayerRow(editor, lid('chip-3'), lid('chip-1'), 'top')).toEqual({ layerId: lid('chip-1'), position: 'before' });
    await expect.poll(async () => Number((await editor.style('chip-3', CARD)).order)).toBe(0);
    const o = async (id: string) => Number((await editor.style(id, CARD)).order);
    const orders = { c3: await o('chip-3'), c1: await o('chip-1'), h: await o('chip-h'), c2: await o('chip-2') };
    // Visible order lands as shown: chip-3, chip-1, chip-2.
    expect(orders.c3).toBeLessThan(orders.c1);
    expect(orders.c1).toBeLessThan(orders.c2);
    // The hidden child keeps its slot between chip-1 and chip-2 (not sorted to slot 0).
    expect(orders.h).toBeGreaterThan(orders.c1);
    expect(orders.h).toBeLessThan(orders.c2);
    expect(orders.h).not.toBe(0);
    // Still exactly one copy of the hidden node, still conditional.
    const after = await stableCode(editor, CARD);
    expect(idCount(after, 'chip-h')).toBe(1);
    expect(conditionalAround(after, 'chip-h')).toContain("'variant-2'");
    // Canvas: desktop paints 3,1,2; variant-2 shows the hidden one in its slot.
    await expect.poll(() => chipOrder(editor, 'desktop', ['chip-1', 'chip-h', 'chip-2', 'chip-3'])).toEqual(['chip-3', 'chip-1', 'chip-2']);
    await expect.poll(() => chipOrder(editor, 'variant-2', ['chip-1', 'chip-h', 'chip-2', 'chip-3'])).toEqual(['chip-3', 'chip-1', 'chip-h', 'chip-2']);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });

  // ─── DND-110 ────────────────────────────────────────────────────────

  test('DND-110 master: a reorder whose order lived in variants.default lands in one coherent place and the canvas moves', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    // ROW-ADJUSTED: the row expects each order written back into
    // `chipNVariants.default`. order-commit.ts now routes a primary reorder on a
    // master through `setConditionalOrder`, which deliberately STRIPS `order`
    // from every variants entry and writes one base value (a quoted literal when
    // no variant is pinned) — a single source of truth that also heals old
    // seeded entries. The user-visible half of fix e0038e38 still holds: the
    // canvas moves.
    await editor.load(seed(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px' }} />` }), { [CARD]: masterModule(MASTER_VARIANT_ORDER, { pre: VARIANT_ORDER_PRE }) }), { fit: true });
    await openMaster(editor, CARD);
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'chip-1');
    await expect.poll(() => chipOrder(editor, 'desktop', ['chip-1', 'chip-2', 'chip-3'])).toEqual(['chip-1', 'chip-2', 'chip-3']);
    const before = await editor.code(CARD);

    expect(await dragLayerRow(editor, lid('chip-3'), lid('chip-1'), 'top')).toEqual({ layerId: lid('chip-1'), position: 'before' });
    await expect(editor).toHaveStyle('chip-3', 'order', '0', { path: CARD });
    await expect(editor).toHaveStyle('chip-1', 'order', '1', { path: CARD });
    await expect(editor).toHaveStyle('chip-2', 'order', '2', { path: CARD });
    const code = await stableCode(editor, CARD);
    // No stale order left in a variants entry to override the new base value.
    for (const name of ['chip1Variants', 'chip3Variants']) {
      const v = variantsConst(code, name);
      expect(v, `${name} still exists`).not.toBeNull();
      for (const [variant, entry] of Object.entries(v!)) expect(entry.order, `${name}.${variant}.order`).toBeUndefined();
    }
    await expect(editor).toHaveJsxOrder('row', ['chip-3', 'chip-1', 'chip-2'], { path: CARD });
    // The canvas moved (not: correct file, canvas never moved) — on every variant.
    await expect.poll(() => chipOrder(editor, 'desktop', ['chip-1', 'chip-2', 'chip-3']), { timeout: 5_000 }).toEqual(['chip-3', 'chip-1', 'chip-2']);
    await expect.poll(() => chipOrder(editor, 'variant-1', ['chip-1', 'chip-2', 'chip-3']), { timeout: 5_000 }).toEqual(['chip-3', 'chip-1', 'chip-2']);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });

  // ─── DND-111 ────────────────────────────────────────────────────────

  test('DND-111 master: a variant-hidden node dragged into another parent keeps its visibility wrapper', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(seed(pageSrc({ root: `<div data-id="root" data-name="Page" style={{ width: '1440px', minHeight: '900px' }} />` }), { [CARD]: masterModule(MASTER_V2_ONLY) }), { fit: true });
    await openMaster(editor, CARD);
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'chip-1');
    await layerRow(page, lid('v2-only')).waitFor();
    const before = await editor.code(CARD);
    expect(conditionalAround(before, 'v2-only')).toBe("initialVariant === 'variant-2'");

    expect(await dragLayerRow(editor, lid('v2-only'), lid('row'), 'middle')).toEqual({ layerId: lid('row'), position: 'inside' });
    await expect.poll(() => editor.parentOf('v2-only', CARD)).toBe('row');
    const after = await stableCode(editor, CARD);
    // The wrapper travelled: still hidden on every variant but variant-2.
    expect(conditionalAround(after, 'v2-only')).toBe("initialVariant === 'variant-2'");
    expect(idCount(after, 'v2-only')).toBe(1);
    // Canvas: absent on desktop / variant-1, painted inside the row on variant-2.
    for (const vp of ['desktop', 'variant-1']) {
      await expect.poll(async () => (await (await editor.nodeIn(vp, 'v2-only')).boundingBox().catch(() => null))?.width ?? 0).toBe(0);
    }
    await expect.poll(async () => {
      const r = await (await editor.nodeIn('variant-2', 'row')).boundingBox();
      const n = await (await editor.nodeIn('variant-2', 'v2-only')).boundingBox().catch(() => null);
      return !!r && !!n && n.y >= r.y - 1 && n.y + n.height <= r.y + r.height + 1;
    }).toBe(true);
    // Eye-slash agrees: hidden on desktop's row, visible on variant-2's.
    await revealRow(editor, 'v2-only');
    const dRow = layerRow(page, lid('v2-only'));
    await dRow.hover();
    await expect(dRow.locator('[title="Show layer"]')).toHaveCount(1);
    await revealRow(editor, 'v2-only', 'variant-2');
    const vRow = layerRow(page, lid('v2-only', 'variant-2'));
    await vRow.hover();
    await expect(vRow.locator('[title="Hide layer"]')).toHaveCount(1);
    await expect(editor).toUndoInOneStep(before, { path: CARD });
  });

  // ─── DND-112 ────────────────────────────────────────────────────────

  test('DND-112 a frame that is flex only in the mobile band: a Desktop reorder writes order and Mobile follows', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(FLEX_ONLY_MOBILE, { fit: true });
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'k1');
    await expect.poll(() => chipOrder(editor, 'mobile', ['k1', 'k2', 'k3'])).toEqual(['k1', 'k2', 'k3']);
    const before = await editor.code();
    const mark = await traceMark(page);

    expect(await dragLayerRow(editor, lid('k3'), lid('k1'), 'top')).toEqual({ layerId: lid('k1'), position: 'before' });
    // `order` renumbered because the siblings carry explicit order …
    await expect(editor).toHaveStyle('k3', 'order', '0');
    await expect(editor).toHaveStyle('k1', 'order', '1');
    await expect(editor).toHaveStyle('k2', 'order', '2');
    await expect(editor).toHaveJsxOrder('box', ['k3', 'k1', 'k2']);
    expect((await tracesSince(page, mark, 'layers-drag:ordered-by-explicit-order')).length).toBeGreaterThan(0);
    // … so the Mobile (flex) tile follows — not a bare JSX reorder it ignored.
    await expect.poll(() => chipOrder(editor, 'mobile', ['k1', 'k2', 'k3'])).toEqual(['k3', 'k1', 'k2']);
    // The Desktop block stacks in the new JSX order.
    await expect.poll(() => sectionOrder(editor, 'desktop', ['k1', 'k2', 'k3'])).toEqual(['k3', 'k1', 'k2']);
    await expect(editor).toUndoInOneStep(before);
  });

  // ─── DND-113 ────────────────────────────────────────────────────────

  test('DND-113 Tablet tile with its own order band: reorder writes the tablet band + JSX; Desktop and Mobile unchanged', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_ORDER, { fit: true });
    const page = editor.page();
    await openLayers(page);
    const ids = ['s1', 's2', 's3'];
    // The tablet section of the tree follows the tablet band.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-layer-id^="tablet:"]')].map(r => r.getAttribute('data-layer-node-id'))))
      .toEqual(['s3', 's2', 's1']);
    await expect.poll(() => sectionOrder(editor, 'tablet', ids)).toEqual(['s3', 's2', 's1']);
    const before = await editor.code();

    expect(await dragLayerRow(editor, lid('s1', 'tablet'), lid('s3', 'tablet'), 'top')).toEqual({ layerId: lid('s3', 'tablet'), position: 'before' });
    // Tablet band order written …
    await expect(editor).toHaveBandStyle(768, 's1', 'order', '0');
    await expect(editor).toHaveBandStyle(768, 's3', 'order', '1');
    await expect(editor).toHaveBandStyle(768, 's2', 'order', '2');
    // … together with the structural JSX reorder (s1 now right before s3).
    await expect.poll(async () => { const c = await editor.childIds('root'); return c.indexOf('s3') - c.indexOf('s1'); }).toBe(1);
    // Desktop's inline order untouched; Desktop and Mobile paint unchanged.
    for (const [id, o] of [['s1', '0'], ['s2', '1'], ['s3', '2']] as const) await expect(editor).toHaveStyle(id, 'order', o);
    await expect.poll(() => sectionOrder(editor, 'tablet', ids)).toEqual(['s1', 's3', 's2']);
    await expect.poll(() => sectionOrder(editor, 'desktop', ids)).toEqual(['s1', 's2', 's3']);
    await expect.poll(() => sectionOrder(editor, 'mobile', ids)).toEqual(['s1', 's2', 's3']);
    await expect(editor).toUndoInOneStep(before);
  });

  // ─── DND-114 ────────────────────────────────────────────────────────

  test('DND-114 reparenting a section strips its banded order; a same-parent move keeps its bands', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(TABLET_ORDER, { fit: true });
    const page = editor.page();
    await openLayers(page);
    const before = await editor.code();
    expect(await editor.bandStyle(768, 's1', 'order')).not.toBeNull();

    // Reparent s1 into s3.
    expect(await dragLayerRow(editor, lid('s1'), lid('s3'), 'middle')).toEqual({ layerId: lid('s3'), position: 'inside' });
    await expect.poll(() => editor.parentOf('s1')).toBe('s3');
    await expect(editor).toHaveBandStyle(768, 's1', 'order', null);
    // Not: sank below every sibling on tablet — it paints inside s3 there.
    await expect.poll(async () => {
      const p = await (await editor.nodeIn('tablet', 's3')).boundingBox();
      const n = await (await editor.nodeIn('tablet', 's1')).boundingBox();
      return !!p && !!n && n.y >= p.y - 1 && n.y < p.y + p.height;
    }).toBe(true);
    await expect(editor).toUndoInOneStep(before);
    await undoTo(editor, before);

    // A same-parent move keeps the moved node's bands.
    expect(await dragLayerRow(editor, lid('s2'), lid('s3'), 'bottom')).toEqual({ layerId: lid('s3'), position: 'after' });
    await expect.poll(async () => { const c = await editor.childIds('root'); return c.indexOf('s2') > c.indexOf('s3'); }).toBe(true);
    expect(await editor.bandStyle(768, 's2', 'order')).not.toBeNull();
    expect(await editor.parentOf('s2')).toBe('root');
    await expect(editor).toUndoInOneStep(before);
  });

  // ─── DND-119 ────────────────────────────────────────────────────────

  test('DND-119 after a CSS-only reorder on a replica, the bottom edge of the visually last frame row means after', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    // BUG (verified 3×): the row's rule holds (after, not inside), but the drop
    // on the Mobile tile renumbers `order` only in the mobile band — the node
    // entering the ordered root gets NO base `order`, so on Desktop it snaps to
    // the front of the order-0 group, and the builder's oracle rejects the file
    // (FLEX_CHILD_MISSING_ORDER on root: "k → order: '2'").
    test.fail(true, 'BUG: a layers drop on a replica tile into an ordered flex parent writes no base order for the entering node (FLEX_CHILD_MISSING_ORDER)');
    await editor.load(MOBILE_CSS_ORDER, { fit: true });
    const page = editor.page();
    await openLayers(page);
    await revealRow(editor, 'k', 'mobile');
    // Mobile tree follows its band: f3, f1, f2 — f2 is visually last, f3 is last in JSX.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-layer-id^="mobile:f"]')].map(r => r.getAttribute('data-layer-node-id'))))
      .toEqual(['f3', 'f1', 'f2']);
    const before = await editor.code();

    const seen: unknown[] = [];
    const ind = await dragLayerRow(editor, lid('k', 'mobile'), lid('f2', 'desktop'), 'bottom', {
      during: async (s) => {
        // Control: on Desktop f2 is NOT last, so its bottom edge is inside.
        seen.push(await rowIndicator(page));
        await s.hoverRow(lid('f2', 'mobile'), 'bottom');
      },
    });
    expect(seen[0]).toEqual({ layerId: lid('f2', 'desktop'), position: 'inside' });
    expect(ind).toEqual({ layerId: lid('f2', 'mobile'), position: 'after' });
    await expect.poll(() => editor.parentOf('k')).toBe('root');
    expect(await editor.childIds('f2')).toEqual([]);
    await expect(editor).toUndoInOneStep(before);
    // Every flow child of the ordered root still carries a base order.
    await expect(editor).toPassOracle();
  });
});
