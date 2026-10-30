// CMP · Components in collection lists (E2E_TEST_PLAN.md §8, CMP-236…CMP-241).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Page } from '@playwright/test';
import type { Editor } from '../../helpers/editor';
import {
  PAGE, FAQ_ITEM, COVER, cmsListPage, faqRow, faqFiles, TWO_TILES, C1_TILES,
  dragLibraryRow, stableBoxOf, pollCode, stableCode, clickNodeId, canvasNode, textOf, computed,
} from '../../helpers/c8';
import { panel, parsesStrict } from '../../helpers/c6';
import { propRow, openingTag, typeInRow } from '../../helpers/c3';
import { makeComponentViaMenu, exitToPage } from '../../helpers/c1';
import { emptyCanvasPoint, panBy } from '../../helpers/d3';

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: TILES_VIEWPORT });

const TITLES = ['What is Revyme?', 'How do I publish?', 'Can I export?', 'Is there a free plan?'];
const SHORT = ['About', 'Publish', 'Export', 'Pricing'];

/** The text every rendered copy of `<inst>:<child>` paints (template + ghosts __1…__3). */
async function rows(editor: Editor, inst: string, child: string, vp = ''): Promise<string[]> {
  const out: string[] = [];
  for (const suffix of ['', '__1', '__2', '__3']) out.push(await textOf(editor, `${vp}${inst}:${child}${suffix}`));
  return out;
}

/** Open a prop row's label menu and hover "Set Variable"; returns the visible field labels. */
async function openSetVariable(page: Page, label: string): Promise<void> {
  await panel(page).getByText(label, { exact: true }).first().click();
  await page.getByText('Set Variable', { exact: true }).first().hover();
}

/** The visible menu entries among `names`. */
async function visibleEntries(page: Page, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of names) {
    if (await page.locator('button').filter({ hasText: new RegExp(`^${n}$`) }).first().isVisible().catch(() => false)) out.push(n);
  }
  return out;
}

const tagOf = async (editor: Editor, id: string) => openingTag(await editor.code(PAGE), id);

test('CMP-236 a component dropped in a template row binds Title to the "Question" field; every row shows its own item', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(cmsListPage(), { fit: true });
  const row = await stableBoxOf(editor, 'faq-row');
  expect((await dragLibraryRow(editor, 'FAQ Item', { x: row.x + row.width / 2, y: row.y + row.height / 2 })).engaged).toBe(true);
  let code = await pollCode(editor, PAGE, c => /<FaqItem\b/.test(c));
  const id = code.match(/<FaqItem\b[^>]*?data-id="([^"]+)"/)![1];
  expect(await editor.parentOf(id, PAGE)).toBe('faq-row');
  await expect.poll(() => rows(editor, id, 'faq-title')).toEqual(['Question', 'Question', 'Question', 'Question']);

  await clickNodeId(editor, id, [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual([id]);
  const before = await stableCode(editor, PAGE);
  await openSetVariable(page, 'Title');
  // Only the text-compatible fields are offered.
  await expect(page.locator('button').filter({ hasText: /^Question$/ }).first()).toBeVisible();
  expect(await visibleEntries(page, ['Question', 'Short title', 'Answer', 'Cover', 'Rank', 'Live'])).toEqual(['Question', 'Short title', 'Answer']);
  await page.locator('button').filter({ hasText: /^Question$/ }).first().click();

  code = await pollCode(editor, PAGE, c => /title=\{item\.title\}/.test(c));
  const tag = openingTag(code, id);
  expect(tag).toContain('title={item.title}');
  // Inside the .map() body.
  const mapAt = code.indexOf('faq.map(');
  expect(mapAt).toBeGreaterThan(-1);
  expect(code.indexOf(tag)).toBeGreaterThan(mapAt);
  expect(parsesStrict(code)).toBe(true);
  // Every row (template + ghosts) shows its own item.
  await expect.poll(() => rows(editor, id, 'faq-title')).toEqual(TITLES);
  // The pill reads the field NAME, not its id — on Desktop…
  await expect(propRow(page, 'Title').getByText('Question', { exact: true })).toBeVisible();
  await expect(propRow(page, 'Title').getByText('title', { exact: true })).toHaveCount(0);
  // …and on Tablet.
  await expect.poll(() => rows(editor, id, 'faq-title', 'tablet-')).toEqual(TITLES);
  await clickNodeId(editor, `tablet-${id}`, [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual([id]);
  await expect(propRow(page, 'Title').getByText('Question', { exact: true })).toBeVisible();
  await expect(propRow(page, 'Title').getByText('title', { exact: true })).toHaveCount(0);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-237 on Tablet: rebind Title to "Short title", unbind there, Reset Override — Desktop untouched throughout', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(cmsListPage({ row: faqRow('title={item.title}') }), { fit: true });
  const desktop = async () => {
    expect(await tagOf(editor, 'faq-card')).toContain('title={item.title}');
    expect(await rows(editor, 'faq-card', 'faq-title')).toEqual(TITLES);
  };
  await expect.poll(() => rows(editor, 'faq-card', 'faq-title', 'tablet-')).toEqual(TITLES);
  await clickNodeId(editor, 'tablet-faq-card', [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['faq-card']);
  const base = await stableCode(editor, PAGE);

  // Rebind on Tablet → a computed data-responsive override for 768.
  await openSetVariable(page, 'Title');
  await page.locator('button').filter({ hasText: /^Short title$/ }).first().click();
  let tag = '';
  await expect.poll(async () => (tag = await tagOf(editor, 'faq-card'))).toMatch(/data-responsive=\{JSON\.stringify\(\{\s*["']?768["']?:\s*\{\s*["']?title["']?:\s*item\.shortTitle\s*\},\s*["']?_bp["']?:\s*\[[^\]]*\]\s*\}\)\}/);
  expect(parsesStrict(await editor.code(PAGE))).toBe(true);
  await expect.poll(() => rows(editor, 'faq-card', 'faq-title', 'tablet-')).toEqual(SHORT);
  await desktop();
  await expect(propRow(page, 'Title').getByText('Short title', { exact: true })).toBeVisible();
  await expect(editor).toUndoInOneStep(base, { path: PAGE });

  // Unbind on Tablet → the master default as a literal for 768.
  const rebound = await stableCode(editor, PAGE);
  await panel(page).getByText('Title', { exact: true }).first().click();
  await page.getByText('Unbind Field', { exact: true }).click();
  await expect.poll(async () => (tag = await tagOf(editor, 'faq-card'))).toMatch(/["']?768["']?:\s*\{\s*["']?title["']?:\s*["']Question["']\s*\}/);
  expect(tag).not.toContain('item.shortTitle');
  await expect.poll(() => rows(editor, 'faq-card', 'faq-title', 'tablet-')).toEqual(['Question', 'Question', 'Question', 'Question']);
  await desktop();
  await expect(editor).toUndoInOneStep(rebound, { path: PAGE });

  // Reset Override → back to the base binding.
  await panel(page).getByText('Title', { exact: true }).first().click();
  await page.getByText('Reset Override', { exact: true }).click();
  await expect.poll(async () => (tag = await tagOf(editor, 'faq-card'))).not.toMatch(/768/);
  expect(tag).toContain('title={item.title}');
  await expect.poll(() => rows(editor, 'faq-card', 'faq-title', 'tablet-')).toEqual(TITLES);
  await desktop();
  expect(await editor.code(PAGE)).toBe(base);
});

test('CMP-238 editing a non-bound prop on the template-row instance updates all 4 rows', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(cmsListPage({ row: faqRow('title={item.title}'), tiles: C1_TILES.one }), { fit: true });
  await expect.poll(() => rows(editor, 'faq-card', 'faq-content')).toEqual(['a', 'a', 'a', 'a']);
  await clickNodeId(editor, 'faq-card', [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['faq-card']);
  const before = await stableCode(editor, PAGE);
  await typeInRow(page, 'Content', 'b');
  await expect.poll(() => tagOf(editor, 'faq-card')).toMatch(/content="b"/);
  // Every row repaints. Not: only the first (template) row.
  await expect.poll(() => rows(editor, 'faq-card', 'faq-content')).toEqual(['b', 'b', 'b', 'b']);
  expect(await rows(editor, 'faq-card', 'faq-title')).toEqual(TITLES);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-239 binding a prop with a hyphenated slug lands in the JSX tag, not in the ::after selector', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  const style = `      <style>{\`
    [data-id="RoJiKu-1"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-width: 2px;
  border-style: solid;
  border-color: #384bf6;
  pointer-events: none;
    }
  \`}</style>
`;
  await editor.load(cmsListPage({ slug: 'collection-1', importVar: 'collection1', row: faqRow('', 'RoJiKu-1'), tiles: C1_TILES.one, preRoot: style }), { fit: true });
  await clickNodeId(editor, 'RoJiKu-1', [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['RoJiKu-1']);
  const before = await stableCode(editor, PAGE);
  await openSetVariable(page, 'Content');
  await page.locator('button').filter({ hasText: /^Answer$/ }).first().click();

  const code = await pollCode(editor, PAGE, c => /content=\{item\.answer\}/.test(c));
  expect(openingTag(code, 'RoJiKu-1')).toContain('content={item.answer}');
  // The selector is untouched. Not: attributes spliced into the CSS selector.
  expect(code).toContain('[data-id="RoJiKu-1"]::after {');
  expect(code).not.toMatch(/\[data-id="RoJiKu-1"[^\]]*content=/);
  expect(parsesStrict(code)).toBe(true);
  await expect.poll(() => rows(editor, 'RoJiKu-1', 'faq-content')).toEqual(['A builder.', 'Click Publish.', 'Yes.', 'Yes.']);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-240 Make Component on a row whose image is bound: the instance binds coverImage wrapped; the master default is the first item\'s image', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  // The template row's thumbnail Fill image is bound to the Cover field.
  await editor.load(cmsListPage({ tiles: C1_TILES.one, row: `<div data-id="faq-row" key={idx} data-name="Row" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', width: '100%', padding: '8px', backgroundColor: '#ffffff' }}>
            <div data-id="row-thumb" data-name="Thumb" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '48px', height: '48px', backgroundImage: \`url(\${item.coverImage})\`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            <p data-id="row-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '16px', color: '#111111', margin: '0px' }}>{item.title}</p>
          </div>` }), { fit: true });
  const made = await makeComponentViaMenu(editor, 'faq-row', 'Faq Row', { at: [0.97, 0.5] });
  const pageCode = await editor.code(PAGE);
  const inst = openingTag(pageCode, 'faq-row');
  expect(inst).toContain('coverImage={`url(${item.coverImage})`}');
  expect(inst).toContain('title={item.title}');
  const master = await editor.code(made.file);
  // The master binds the image bare; its default is the first item's image.
  expect(master).toMatch(/backgroundImage: coverImage\b/);
  expect(master.match(/\bcoverImage = (["'])(.*?)\1/)?.[2]).toBe(`url(${COVER.red})`);
  expect(master).not.toMatch(/\bitem\./);
  expect(parsesStrict(master)).toBe(true);
  // The editor is in the new master: its tile paints that image (not empty).
  await expect.poll(() => editor.activeFile()).toBe(made.file);
  await expect.poll(() => computed(editor, 'row-thumb', 'background-image')).toContain(COVER.red.slice(-24));
  await expect.poll(() => textOf(editor, 'row-title')).toBe(TITLES[0]);

  // On the page every row paints its own image, and the prop shows the field pill.
  await exitToPage(editor);
  for (const [i, c] of [COVER.red, COVER.blue, COVER.green, COVER.gold].entries()) {
    await expect.poll(() => computed(editor, `faq-row:row-thumb${i ? `__${i}` : ''}`, 'background-image')).toContain(c.slice(-24));
  }
  await clickNodeId(editor, 'faq-row', [0.97, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['faq-row']);
  await expect(panel(page).locator('[title^="Bound to CMS field: Cover"]').first()).toBeVisible();
});

test('CMP-241 a bound row instance dragged out of the list shows a "Missing" pill; × clears it to the master default', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(cmsListPage({ row: faqRow('title={item.title}'), tiles: C1_TILES.one }), { fit: true });
  // Bring empty canvas into view left of the page tile.
  await panBy(editor, { x: 800, y: 500 }, { x: 1250, y: 500 });
  const card = await stableBoxOf(editor, 'faq-card');
  const out = await emptyCanvasPoint(editor, { x: card.x - 200, y: card.y + 40 }, 50);
  const before = await stableCode(editor, PAGE);
  await editor.dragNodeAsserted('faq-card', out, { steps: 24 });
  let code = await pollCode(editor, PAGE, c => /data-cms-orphan="title:title"/.test(c));
  expect(openingTag(code, 'faq-card')).toContain('data-cms-orphan="title:title"');
  expect(openingTag(code, 'faq-card')).not.toContain('item.');
  expect(code.indexOf('data-id="faq-card"')).toBeGreaterThan(code.indexOf('const canvasNodes'));
  expect(parsesStrict(code)).toBe(true);
  // Renders the row's value it was showing (baked), no crash.
  expect(openingTag(code, 'faq-card')).toContain('title="What is Revyme?"');
  await expect.poll(() => textOf(editor, 'faq-card:faq-title')).toBe('What is Revyme?');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  await clickNodeId(editor, 'faq-card', [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['faq-card']);
  const missing = propRow(page, 'Title').getByText('Missing', { exact: true });
  await expect(missing).toBeVisible();
  const detached = await stableCode(editor, PAGE);
  await propRow(page, 'Title').locator('[title="Clear — revert to the component default"]').click();
  code = await pollCode(editor, PAGE, c => !/data-cms-orphan/.test(c));
  expect(code).not.toContain('data-cms-orphan');
  await expect(missing).toHaveCount(0);
  // "Revert to the component default": the baked row value goes too.
  test.fail(!process.env.C8_NOFAIL, 'BUG: × on the "Missing" pill (titled "Clear — revert to the component default") only drops the data-cms-orphan stash — clearCmsOrphanInCode (cms-detach-gen.ts:750) leaves the row value the drag-out baked (title="What is Revyme?"), so the instance keeps showing the old row instead of the master default');
  expect(openingTag(code, 'faq-card')).not.toMatch(/\btitle=/);
  await expect.poll(() => textOf(editor, 'faq-card:faq-title')).toBe('Question');
  await expect(editor).toUndoInOneStep(detached, { path: PAGE });
});
