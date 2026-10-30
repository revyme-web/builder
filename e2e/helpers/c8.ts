// C8 lane helpers — design components: nesting, slots and the cycle guard;
// components in collection lists; code safety and the oracle for masters
// (E2E_TEST_PLAN.md §8, CMP-228…CMP-245).
//
// Seeds are written in the builder's own dialect (`variantConfig`,
// `withResponsiveProps`, motion.* children, `@name`/`@propMeta` above the
// imports) through c6's `master()` / `c6Seed()` builders, so the Library's
// first-mount `app/globals.css` write is already in the seed.

import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { Editor } from './editor';
import type { ProjectData } from '../fixtures/project';
import { master, c6Seed, homePage, libraryRow, GLOBALS_CSS } from './c6';
import { C1_TILES, marqueeSource, SERVER_WRAPPER, type C1Tile } from './c1';

export const PAGE = 'app/page.client.tsx';
export const CARD = 'components/Card.tsx';
export const BUTTON = 'components/Button.tsx';
export const HEADER = 'components/Header.tsx';

// ─── Small readers ──────────────────────────────────────────────────

/** Trace entries whose channel matches `pattern`. */
export async function traces(editor: Editor, pattern: string): Promise<Array<{ c: string; data: any }>> {
  return editor.page().evaluate((p) => (window as any).__e2e.traceEntries(p), pattern);
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

/** A file's contents once two reads ~500ms apart agree. */
export async function stableCode(editor: Editor, path: string, timeout = 10_000): Promise<string> {
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

/** Every project file except the editor's own bookkeeping. */
export async function sourceFiles(editor: Editor): Promise<Record<string, string>> {
  const all = await editor.snapshotFiles();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === '_meta/page-camera.json' || k === 'app/globals.css') continue;
    out[k] = v;
  }
  return out;
}

/** A sonner toast carrying exactly this text. */
export function toast(page: Page, text: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

/** Box of the first match, or null right away (a bare boundingBox() on a
 *  missing node waits out the whole test timeout). */
export async function quickBox(loc: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if ((await loc.count()) === 0) return null;
  return loc.first().boundingBox({ timeout: 2_000 }).catch(() => null);
}

/** A canvas node by its exact `data-node-id` (tile-prefixed ids included). */
export function canvasNode(editor: Editor, nodeId: string): Locator {
  return editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first();
}

/** Text a canvas node paints ('' when missing). */
export async function textOf(editor: Editor, nodeId: string): Promise<string> {
  const loc = canvasNode(editor, nodeId);
  if ((await loc.count()) === 0) return '';
  return ((await loc.textContent()) ?? '').trim();
}

/** Computed style of a canvas node ('' when missing). */
export async function computed(editor: Editor, nodeId: string, prop: string): Promise<string> {
  const loc = canvasNode(editor, nodeId);
  if ((await loc.count()) === 0) return '';
  return loc.evaluate((el, p) => getComputedStyle(el as HTMLElement).getPropertyValue(p), prop);
}

/** Open a file (setup only) and wait until `readyId` painted. */
export async function enterFile(editor: Editor, path: string, readyId: string, opts: { fit?: boolean } = {}): Promise<void> {
  await editor.openFile(path);
  await editor.page().waitForFunction((p) => (window as any).__e2e.activeFile() === p, path);
  await editor.sandbox().locator(`[data-node-id="${readyId}"]`).first().waitFor({ state: 'attached', timeout: 20_000 });
  await editor.settled();
  if (opts.fit !== false) {
    await editor.fitCamera();
    await editor.settled();
  }
}

/** Wait until a node's box stops moving (camera fit animation), then return it. */
export async function stableBoxOf(editor: Editor, nodeId: string, timeout = 5_000) {
  const loc = canvasNode(editor, nodeId);
  await loc.waitFor({ state: 'attached', timeout });
  let prev = await quickBox(loc);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await editor.page().waitForTimeout(120);
    const cur = await quickBox(loc);
    if (cur && prev && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.width - prev.width) < 0.5) return cur;
    prev = cur;
  }
  if (!prev) throw new Error(`no box for ${nodeId}`);
  return prev;
}

/** Real click at a node's centre once it stopped moving (canvas node id). */
export async function clickNodeId(editor: Editor, nodeId: string, at: [number, number] = [0.5, 0.5]): Promise<void> {
  const b = await stableBoxOf(editor, nodeId);
  const page = editor.page();
  // Two presses inside 400ms read as a drill-in double-click.
  await page.waitForTimeout(450);
  await page.mouse.click(b.x + b.width * at[0], b.y + b.height * at[1]);
  await editor.settled();
}

// ─── Library drag ───────────────────────────────────────────────────

/** Drag a Library row to a screen point with real pointer events. Returns
 *  whether the toolbar drag engaged (a refused drag never starts one). */
export async function dragLibraryRow(editor: Editor, name: string, to: { x: number; y: number }): Promise<{ engaged: boolean }> {
  const page = editor.page();
  const row = await libraryRow(page, name);
  await row.scrollIntoViewIfNeeded();
  const rb = (await row.boundingBox())!;
  const from = { x: rb.x + Math.min(60, rb.width / 2), y: rb.y + rb.height / 2 };
  const raf = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  const startCount = (await traces(editor, 'toolbar-drag:move')).length;
  const startedBefore = (await traces(editor, 'library-panel:drag-start')).length;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let engaged = false;
  try {
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * i / 20, from.y + (to.y - from.y) * i / 20);
      await raf();
    }
    for (let i = 0; i < 8; i++) { await page.mouse.move(to.x + (i % 2), to.y + ((i + 1) % 2)); await raf(); }
    await page.mouse.move(to.x, to.y);
    await raf();
    engaged = (await traces(editor, 'toolbar-drag:move')).length > startCount
      || (await traces(editor, 'library-panel:drag-start')).length > startedBefore;
  } finally {
    await page.mouse.up();
  }
  await editor.settled();
  return { engaged };
}

// ─── Seeds: nested masters (Header → Card → Button) ─────────────────

/** Button: Primary (`default`) and Dark (`dark`) — the dark variant paints a
 *  black pill with a white label. */
export const BUTTON_MASTER = master('Button', `
      <motion.div layout={true} data-id="btn-root" variants={btnRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Button" style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '48px', backgroundColor: '#ff2d75', borderRadius: '24px', ...style }}>
        <motion.p layout={true} data-id="btn-text" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>{title}</motion.p>
      </motion.div>`, {
  propMeta: `{"title":{"type":"plainText","label":"Title"}}`,
  sig: `{ style, initialVariant = 'default', title = 'Click', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; [key: string]: any }`,
  config: `const variantConfig = [
  { name: 'default', label: 'Primary', x: 0, y: 0, isPrimary: true },
  { name: 'dark', label: 'Dark', x: 300, y: 0 },
];`,
  pre: `const btnRootVariants = {
  default: { backgroundColor: '#ff2d75' },
  dark: { backgroundColor: '#000000' },
};`,
});

/** Card: Default and Featured (`variant-1`). `withButton` nests a Button. */
export function cardMaster(opts: { withButton?: boolean } = {}): string {
  return master('Card', `
      <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '320px', padding: '24px', backgroundColor: '#1a1a3a', borderRadius: '16px', ...style }}>
        <motion.h2 layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', color: '#ffffff', margin: '0px' }}>Pro plan</motion.h2>${opts.withButton ? `
        <Button data-id="card-btn" data-name="Button" title="Buy" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />` : ''}
      </motion.div>`, {
    imports: opts.withButton ? [`import Button from '@/components/Button';`] : [],
    config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Featured', x: 500, y: 0 },
];`,
    pre: `const cardRootVariants = {
  default: { backgroundColor: '#1a1a3a' },
  'variant-1': { backgroundColor: '#3a1a1a' },
};`,
  });
}

/** Header: a logo and a nested Card. */
export const HEADER_MASTER = master('Header', `
      <motion.div layout={true} data-id="header-root" {...rest} data-name="Header" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '640px', padding: '16px', backgroundColor: '#223344', ...style }}>
        <motion.p layout={true} data-id="header-logo" data-name="Logo" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '20px', color: '#ffffff', margin: '0px' }}>Logo</motion.p>
        <Card data-id="header-card" data-name="Header Card" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />
      </motion.div>`, { imports: [`import Card from '@/components/Card';`] });

/** NESTED_MASTERS: Header imports Card, Card imports Button (unless
 *  `cardWithButton: false`); the page holds a Header and two Cards, the
 *  second one on the Featured variant. */
export function nestedMasters(opts: { cardWithButton?: boolean; tiles?: C1Tile[] } = {}): ProjectData {
  return c6Seed(
    { '/': homePage(`      <Header data-id="header-a" data-name="Site Header" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
      <Card data-id="card-a" data-name="Card A" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />
      <Card data-id="card-b" data-name="Card B" initialVariant="variant-1" style={{ position: 'relative', flex: '0 0 auto', order: '2' }} />`, {
      tiles: opts.tiles,
      imports: [`import Header from '@/components/Header';`, `import Card from '@/components/Card';`],
    }) },
    { [BUTTON]: BUTTON_MASTER, [CARD]: cardMaster({ withButton: opts.cardWithButton !== false }), [HEADER]: HEADER_MASTER },
  );
}

export { C1_TILES, GLOBALS_CSS, SERVER_WRAPPER, marqueeSource };

// ─── Seeds: slots (MASTER_SLOT) ─────────────────────────────────────

export const LOGOS = 'components/Logos.tsx';
export const SECTION = 'components/Section.tsx';
export const MARQUEE = 'components/Marquee.tsx';

/** A connected slot item: a module-scope `cn_` const parked off-canvas. */
export function slotItem(id: string, text: string, color: string, top: number): string {
  const name = `cn_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
  return `const ${name} = <div data-id="${id}" data-name="${text}" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '${top}px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '80px', backgroundColor: '${color}' }}><p data-id="${id}-text" data-name="${text} Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px', color: '#ffffff', margin: '0px' }}>${text}</p></div>;`;
}

/** MASTER_SLOT — the Logos master holds a Marquee wired to two `cn_` consts. */
export const LOGOS_MASTER = master('Logos', `
      <motion.div layout={true} data-id="logos-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Logos" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '600px', padding: '16px', backgroundColor: '#202030', ...style }}>
        <Marquee data-id="logos-marquee" data-name="Marquee" speed={60} gap={24} style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', height: '120px' }}>{cn_logo_a}{cn_logo_b}</Marquee>
      </motion.div>`, {
  imports: [`import Marquee from '@/components/Marquee';`],
  post: `${slotItem('logo-a', 'Logo A', '#ff3366', 100)}
${slotItem('logo-b', 'Logo B', '#3366ff', 220)}
`,
});

/** An outer master that starts empty (Logos is dropped into it), or holds Logos. */
export function sectionMaster(withLogos = false): string {
  return master('Section', `
      <motion.div layout={true} data-id="section-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Section" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '16px', width: '700px', minHeight: '200px', padding: '24px', backgroundColor: '#112233', ...style }}>
        <motion.h2 layout={true} data-id="section-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '24px', color: '#ffffff', margin: '0px' }}>Partners</motion.h2>${withLogos ? `
        <Logos data-id="section-logos" data-name="Logos" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />` : ''}
      </motion.div>`, { imports: withLogos ? [`import Logos from '@/components/Logos';`] : [] });
}

export function slotSeed(opts: { sectionWithLogos?: boolean; pageLogos?: boolean } = {}): ProjectData {
  const inner = [
    `      <Section data-id="section-a" data-name="Partners" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`,
    opts.pageLogos ? `      <Logos data-id="logos-a" data-name="Logos" style={{ position: 'relative', flex: '0 0 auto', order: '1' }} />` : '',
  ].filter(Boolean).join('\n');
  return c6Seed(
    { '/': homePage(inner, { imports: [`import Section from '@/components/Section';`, ...(opts.pageLogos ? [`import Logos from '@/components/Logos';`] : [])] }) },
    { [MARQUEE]: marqueeSource(), [LOGOS]: LOGOS_MASTER, [SECTION]: sectionMaster(!!opts.sectionWithLogos) },
  );
}

// ─── Seeds: a prop-bound text in a master (CMP-234) ─────────────────

export const PROFILE = 'components/Profile.tsx';

export const PROFILE_MASTER = master('Profile', `
      <motion.div layout={true} data-id="pf-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Profile" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '360px', padding: '24px', backgroundColor: '#1a1a3a', ...style }}>
        <motion.h3 layout={true} data-id="pf-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '24px', color: '#ffffff', margin: '0px' }}>Ada Lovelace</motion.h3>
        <motion.p layout={true} data-id="pf-bio" data-name="Bio" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: '#cccccc', margin: '0px' }}>{bio}</motion.p>
      </motion.div>`, {
  propMeta: `{"bio":{"type":"plainText","label":"Bio"}}`,
  sig: `{ style, initialVariant = 'default', bio = 'Loves maths', ...rest }: { style?: React.CSSProperties; initialVariant?: string; bio?: string; [key: string]: any }`,
});

export function profileSeed(): ProjectData {
  return c6Seed(
    { '/': homePage(`      <Profile data-id="profile-a" data-name="Profile" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Profile from '@/components/Profile';`] }) },
    { [PROFILE]: PROFILE_MASTER },
  );
}

/** A page section holding a wired `<Marquee>{cn_a}{cn_b}</Marquee>` (CMP-233). */
export function wiredMarqueePage(): ProjectData {
  const seed = c6Seed(
    { '/': homePage(`      <div data-id="partners" data-name="Partners" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '12px', width: '640px', padding: '16px', backgroundColor: '#202030' }}>
        <Marquee data-id="strip" data-name="Marquee" speed={60} gap={24} style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '100%', height: '120px' }}>{cn_a}{cn_b}</Marquee>
      </div>`, { imports: [`import Marquee from '@/components/Marquee';`] }) },
    { [MARQUEE]: marqueeSource() },
  );
  seed.files[PAGE] += `${slotItem('a', 'Alpha', '#ff3366', 100)}
${slotItem('b', 'Beta', '#3366ff', 220)}
`;
  return seed;
}

// ─── Seeds: components in collection lists (MASTER_CMS_ROW) ─────────

export const FAQ_ITEM = 'components/FaqItem.tsx';

const svg = (c: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${c}"/></svg>`).toString('base64')}`;
export const COVER = { grey: svg('#888888'), red: svg('#e06666'), blue: svg('#6fa8dc'), green: svg('#93c47d'), gold: svg('#ffd966') };

/** A FAQ collection: the `title` field is NAMED "Question" (id ≠ name), plus a
 *  second text field, a textarea, an image, a number and a boolean. */
export function faqFiles(slug = 'faq'): Record<string, string> {
  return {
    [`cms/${slug}.schema.json`]: JSON.stringify({ name: 'FAQ', slug, fields: [
      { id: 'title', name: 'Question', type: 'text', required: true },
      { id: 'shortTitle', name: 'Short title', type: 'text' },
      { id: 'answer', name: 'Answer', type: 'textarea' },
      { id: 'coverImage', name: 'Cover', type: 'image' },
      { id: 'rank', name: 'Rank', type: 'number' },
      { id: 'live', name: 'Live', type: 'boolean' },
    ] }),
    [`cms/${slug}.json`]: JSON.stringify([
      { _id: 'q1', _slug: 'what', _status: 'published', title: 'What is Revyme?', shortTitle: 'About', answer: 'A builder.', coverImage: COVER.red, rank: 1, live: true },
      { _id: 'q2', _slug: 'publish', _status: 'published', title: 'How do I publish?', shortTitle: 'Publish', answer: 'Click Publish.', coverImage: COVER.blue, rank: 2, live: true },
      { _id: 'q3', _slug: 'export', _status: 'published', title: 'Can I export?', shortTitle: 'Export', answer: 'Yes.', coverImage: COVER.green, rank: 3, live: false },
      { _id: 'q4', _slug: 'free', _status: 'published', title: 'Is there a free plan?', shortTitle: 'Pricing', answer: 'Yes.', coverImage: COVER.gold, rank: 4, live: true },
    ]),
  };
}

/** FaqItem: `title` / `content` texts and a `coverImage` fill, all props. */
export const FAQ_ITEM_MASTER = master('FaqItem', `
      <motion.div layout={true} data-id="faq-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="FAQ Item" style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', width: '420px', padding: '12px', backgroundColor: '#eeeeee', ...style }}>
        <motion.div layout={true} data-id="faq-cover" data-name="Cover" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '48px', height: '48px', backgroundImage: coverImage, backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <motion.h3 layout={true} data-id="faq-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: '#111111', margin: '0px' }}>{title}</motion.h3>
        <motion.p layout={true} data-id="faq-content" data-name="Content" style={{ position: 'relative', flex: '0 0 auto', order: '2', fontSize: '14px', color: '#555555', margin: '0px' }}>{content}</motion.p>
      </motion.div>`, {
  label: 'FAQ Item',
  propMeta: `{"title":{"type":"plainText","label":"Title"},"content":{"type":"plainText","label":"Content"},"coverImage":{"type":"image","label":"Cover Image"}}`,
  sig: `{ style, initialVariant = 'default', title = 'Question', content = 'a', coverImage = 'url(${COVER.grey})', ...rest }: { style?: React.CSSProperties; initialVariant?: string; title?: string; content?: string; coverImage?: string; [key: string]: any }`,
});

export const TWO_TILES: C1Tile[] = [C1_TILES.three[0], C1_TILES.three[1]];

/** A collection list on the page. `row` is the `.map()` body (default: an
 *  empty template row frame to drop a component into). */
export function cmsListPage(opts: { row?: string; tiles?: C1Tile[]; slug?: string; importVar?: string; preRoot?: string; imports?: string[] } = {}): ProjectData {
  const slug = opts.slug ?? 'faq';
  const v = opts.importVar ?? slug;
  const row = opts.row ?? `<div data-id="faq-row" key={idx} data-name="Row" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', width: '100%', minHeight: '72px', padding: '8px', backgroundColor: '#ffffff' }}></div>`;
  return c6Seed(
    { '/': homePage(`${opts.preRoot ?? ''}      <div data-id="faq-list" data-name="FAQ" data-collection-list="${slug}" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '8px', width: '480px', padding: '12px', backgroundColor: '#dddddd' }}>
        {${v}.map((item, idx) => (
          ${row}
        ))}
      </div>`, { tiles: opts.tiles ?? TWO_TILES, imports: [`import ${v} from '@/cms/${slug}.json';`, `import FaqItem from '@/components/FaqItem';`, ...(opts.imports ?? [])] }) },
    { [FAQ_ITEM]: FAQ_ITEM_MASTER, ...faqFiles(slug) },
  );
}

/** The FaqItem instance as the template row (attrs land before `style`). */
export function faqRow(attrs = '', id = 'faq-card'): string {
  return `<FaqItem data-id="${id}" key={idx} data-name="FAQ Card"${attrs ? ' ' + attrs : ''} style={{ position: 'relative', flex: '0 0 auto', width: '100%' }} />`;
}

/** Text of every rendered row of a collection list (template + ghosts), in order. */
export async function rowTexts(editor: Editor, listNodeId: string, childSel = ''): Promise<string[]> {
  const list = editor.sandbox().locator(`[data-node-id="${listNodeId}"]`).first();
  if ((await list.count()) === 0) return [];
  return list.evaluate((el, sel) => (Array.from(el.children) as HTMLElement[])
    .filter(k => k.offsetParent !== null || getComputedStyle(k).display !== 'none')
    .map(k => ((sel ? k.querySelector(sel) : k)?.textContent ?? '').trim()), childSel);
}

// ─── Seeds: code safety (CMP-242 …) ─────────────────────────────────

export const WISP = 'components/Wisp.tsx';

/** A master whose variants object carries a `};` INSIDE a string value — the
 *  shape the lazy `const xVariants = {[\s\S]*?};` matcher mis-cuts. */
export const WISP_MASTER = master('Wisp', `
      <motion.div layout={true} data-id="wisp-root" variants={wispRootVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Wisp" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', width: '280px', padding: '16px', backgroundColor: '#223344', ...style }}>
        <motion.p layout={true} data-id="wisp-label" data-name="Label" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '18px', color: '#ffffff', margin: '0px' }}>Wisp</motion.p>
      </motion.div>`, {
  config: `const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Mobile', x: 500, y: 0 },
];`,
  pre: `const wispRootVariants = {
  'variant-1': { backgroundColor: '#663399' },
  default: { backgroundColor: '#223344', fontFamily: 'a};b' },
};`,
});

export function wispSeed(): ProjectData {
  return c6Seed(
    { '/': homePage(`      <Wisp data-id="wisp-a" data-name="Wisp" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Wisp from '@/components/Wisp';`] }) },
    { [WISP]: WISP_MASTER },
  );
}

/** A master hand-written WITHOUT the `initialVariant` param (CMP-245). */
export const NO_IV_MASTER = master('Card', `
      <motion.div layout={true} data-id="card-root" variants={cardRootVariants} initial="default" animate="default" {...rest} data-name="Card" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '160px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
        <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '20px', color: '#000000', margin: '0px' }}>Title</motion.p>
      </motion.div>`, {
  sig: `{ style, ...rest }: { style?: React.CSSProperties; [key: string]: any }`,
  pre: `const cardRootVariants = {
  default: { backgroundColor: '#97cffc' },
};`,
});

export function noIvSeed(): ProjectData {
  return c6Seed(
    { '/': homePage(`      <Card data-id="card-a" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Card from '@/components/Card';`] }) },
    { [CARD]: NO_IV_MASTER },
  );
}
