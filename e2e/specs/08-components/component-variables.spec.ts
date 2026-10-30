// CMP · Component variables in the master (E2E_TEST_PLAN.md §8, CMP-167…CMP-175).
//
// Inside a design-component master a style / text value becomes a VARIABLE:
// a prop in the component signature (default = the value), described in
// `@propMeta`, bound where the value was. Instances then list it as a row.
// The Variables modal (toolbar "Variables") is the manage surface: "+" typed
// create, rename label, description, default, option choices, number meta,
// duplicate and remove (guarded while bound).

import { test, expect, TILES } from '../../fixtures/test';
import type { Locator, Page } from '@playwright/test';
import { allowMasterEntryNoise, breadcrumbSegment, waitForActiveFile } from '../../helpers/c1';
import { label, menuTexts, row } from '../../helpers/c5';
import { propRow } from '../../helpers/c3';
import {
  PAGE, TILE, tileSeed, tileMaster, enterMaster, parsesStrict, pollCode, panel, paint, elementOf,
  META_TILE, REMOVE_TILE, JOI_TILE, CASCADE_TILE, DUP_TILE, MQ_TILE, POINTER_MASTER, homePage,
  historyPushes, waitHistoryPush,
} from '../../helpers/c6';

test.describe.configure({ timeout: 150_000 });

// ─── Local helpers ───────────────────────────────────────────────────

/** The @propMeta JSON of a master (null when absent). */
function propMeta(code: string): Record<string, any> | null {
  const m = /\/\*\*\s*@propMeta\s+(\{[\s\S]*?\})\s*\*\//.exec(code);
  return m ? JSON.parse(m[1]) : null;
}

/** The component function's destructured params, as written (`a = 1, b, ...rest`). */
function signature(code: string, fn = 'Tile'): string {
  const m = new RegExp(`function ${fn}\\(\\{([^}]*)\\}`).exec(code);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** The ControlLabel menu (portal) item by its label. */
function labelMenuItem(page: Page, text: string | RegExp): Locator {
  return page.locator('div[class*="z-[1000"] button', { hasText: typeof text === 'string' ? new RegExp(`^${text}$`) : text }).last();
}

/** Real click on a row label, then a menu path (each step hovered/clicked). */
async function labelMenuPath(page: Page, rowLabel: string, ...path: string[]): Promise<void> {
  await label(page, rowLabel).click();
  for (const step of path) {
    const it = labelMenuItem(page, step);
    await it.waitFor({ state: 'visible', timeout: 5_000 });
    await it.click();
    await page.waitForTimeout(150);
  }
}

function variablesModal(page: Page): Locator {
  return page.locator('[data-modal-root]', { has: page.getByRole('heading', { name: 'Variables', exact: true }) });
}

async function openVariablesModal(page: Page): Promise<Locator> {
  await page.locator('[data-dynamic-toolbar="true"] button', { hasText: 'Variables' }).click();
  const m = variablesModal(page);
  await m.waitFor({ state: 'visible' });
  return m;
}

/** A variable row in the modal list (by its label). */
function varRow(modal: Locator, text: string): Locator {
  return modal.locator('div.group.cursor-pointer', { has: modal.page().locator('span.truncate', { hasText: new RegExp(`^${text}$`) }) });
}

/** The right-panel field row of the modal (label column → control). */
function field(modal: Locator, name: string): Locator {
  return modal.locator('div.flex.gap-4', { has: modal.page().locator(`label:text-is("${name}")`) });
}

async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await variablesModal(page).waitFor({ state: 'hidden' });
}

/** Leave the master for the Home page via the breadcrumb (real click). */
async function toHome(editor: import('../../helpers/editor').Editor): Promise<void> {
  await breadcrumbSegment(editor.page(), 'Home').click();
  await waitForActiveFile(editor, PAGE);
  await editor.page().waitForTimeout(300);
  await editor.settled();
}

/** Click a master node; the first press on a nested node can select its root. */
async function selectInMaster(editor: import('../../helpers/editor').Editor, id: string): Promise<void> {
  await editor.click(id);
  if ((await editor.selection())[0] !== id) {
    await editor.page().waitForTimeout(450);
    await editor.click(id);
  }
  await expect.poll(() => editor.selection()).toEqual([id]);
}

// ─── Tests ───────────────────────────────────────────────────────────

test('CMP-167 Fill label → Create Variable binds a colour prop before ...rest; rename modal opens; instances list it; one undo', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed());
  await enterMaster(editor, TILE, 'tile-root');
  await selectInMaster(editor, 'tile-swatch');
  const before = await editor.code(TILE);
  const pushes = await historyPushes(editor);

  await label(page, 'Fill').click();
  expect(await menuTexts(page)).toContain('Create Variable');
  await labelMenuItem(page, 'Create Variable').click();
  await labelMenuItem(page, 'Color').click();

  const code = await pollCode(editor, TILE, c => /backgroundColor: color\b/.test(c));
  // The prop: before ...rest, the current value as its default.
  expect(signature(code)).toMatch(/initialVariant = 'default', color = ["']#1E3C1B["'], \.\.\.rest$/);
  expect(propMeta(code)?.color).toEqual({ type: 'color', label: 'Color' });
  expect(await editor.style('tile-swatch', TILE)).toMatchObject({ backgroundColor: 'color' });
  expect(parsesStrict(code)).toBe(true);
  // The manage modal opens on the new variable, Name ready to rename.
  const modal = variablesModal(page);
  await expect(modal).toBeVisible();
  await expect(varRow(modal, 'Color')).toBeVisible();
  await expect(field(modal, 'Name').locator('input')).toHaveValue('Color');
  await closeModal(page);
  // The canvas still paints the colour, now through the variable.
  await expect.poll(async () => (await paint(editor, 'tile-swatch'))?.bg).toBe('rgb(30, 60, 27)');

  // One undo removes it all (prop, meta, binding).
  await waitHistoryPush(editor, pushes);
  await expect(editor).toUndoInOneStep(before, { path: TILE });

  // Instances on the page list the new row (a colour row is labelled by the
  // identifier today — see the CMP-170 colour-label test).
  await toHome(editor);
  await editor.click('tile-a');
  await expect(panel(page).locator('span[title]', { hasText: /^color$/i }).first()).toBeVisible();
});

test('CMP-168 Content row: plain text variable → {content}; formatted text variable → __html with sanitised inline HTML; both show as pills', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(tileMaster({ bodyText: 'Rich <strong>words</strong>' })));
  await enterMaster(editor, TILE, 'tile-root');

  await selectInMaster(editor, 'tile-title');
  await label(page, 'Content').click();
  expect(await menuTexts(page)).toEqual(expect.arrayContaining(['Create plain text variable', 'Create formatted text variable']));
  await labelMenuItem(page, 'Create plain text variable').click();
  let code = await pollCode(editor, TILE, c => /\{content\}/.test(c));
  expect(elementOf(code, 'tile-title')!.children.trim()).toBe('{content}');
  expect(signature(code)).toMatch(/content = ["']Plain words["']/);
  expect(propMeta(code)?.content).toMatchObject({ type: 'plainText', label: 'Content' });
  await expect(variablesModal(page)).toBeVisible();
  await closeModal(page);
  // The bound Content row shows the variable pill.
  await expect(panel(page).locator('[title^="Variable: Content —"]')).toBeVisible();

  await page.waitForTimeout(450);
  await selectInMaster(editor, 'tile-body');
  await labelMenuPath(page, 'Content', 'Create formatted text variable');
  code = await pollCode(editor, TILE, c => /__html: content1\b/.test(c));
  const body = elementOf(code, 'tile-body')!;
  expect(body.open).toContain('dangerouslySetInnerHTML={{ __html: content1 }}');
  expect(body.children.trim()).toBe('');
  expect(signature(code)).toMatch(/content1 = ["']Rich <strong>words<\/strong>["']/);
  expect(propMeta(code)?.content1).toMatchObject({ type: 'formattedText' });
  expect(parsesStrict(code)).toBe(true);
  await expect(variablesModal(page)).toBeVisible();
  await closeModal(page);
  await expect(panel(page).locator(`[title^="Variable: ${propMeta(code)!.content1.label} —"]`)).toBeVisible();
  // The master still paints both texts (the formatted one keeps its bold run).
  await expect.poll(async () => (await paint(editor, 'tile-title'))?.text).toBe('Plain words');
  await expect(editor.sandbox().locator('[data-node-id="tile-body"] strong')).toHaveText('words');
});

const TYPES: Array<[string, string]> = [
  ['Plain Text', 'plainText'], ['Formatted Text', 'formattedText'], ['Date', 'date'], ['Link', 'link'],
  ['Image', 'image'], ['Color', 'color'], ['Toggle', 'toggle'], ['Number', 'number'], ['Option', 'option'],
  ['Event', 'event'], ['File', 'file'], ['Transition', 'transition'], ['Border', 'border'], ['Shadow', 'shadow'],
];

test('CMP-169 Variables "+" creates one of every type with unique camelCase names; raw number/boolean defaults; bare Event; Link has no Default', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed());
  await enterMaster(editor, TILE, 'tile-root');
  const modal = await openVariablesModal(page);
  for (const [typeLabel] of TYPES) {
    await modal.locator('button[title="Add a variable"]').click();
    await page.locator('div[style*="100020"] button', { hasText: new RegExp(`^${typeLabel}$`) }).click();
    await expect(varRow(modal, typeLabel)).toBeVisible();
    // Link and Event have no editable default.
    if (typeLabel === 'Link') await expect(field(modal, 'Default')).toHaveCount(0);
    else if (typeLabel !== 'Event') await expect(field(modal, 'Default')).toBeVisible();
  }
  // A second Plain Text gets the next unique name and label.
  await modal.locator('button[title="Add a variable"]').click();
  await page.locator('div[style*="100020"] button', { hasText: /^Plain Text$/ }).click();
  await expect(varRow(modal, 'Plain Text 2')).toBeVisible();

  const code = await editor.code(TILE);
  const meta = propMeta(code)!;
  for (const [typeLabel, id] of TYPES) expect(meta[id], id).toMatchObject({ type: id, label: typeLabel });
  expect(meta.plainText1).toMatchObject({ type: 'plainText', label: 'Plain Text 2' });
  const sig = signature(code);
  expect(sig).toContain('toggle = false');
  expect(sig).toContain('number = 0');
  expect(sig).toMatch(/(^|, )event(, |$)/);
  expect(sig).not.toMatch(/event =/);
  expect(sig).toMatch(/link = ["']{2}/);
  expect(sig.endsWith('...rest')).toBe(true);
  expect(parsesStrict(code)).toBe(true);
  await closeModal(page);

  // Instances list a variable once the master APPLIES it (unused ones are
  // hidden on purpose — ComponentPropsTool isVariableAppliedInCode): bind the
  // new Color to the swatch through Fill → Set Variable.
  await selectInMaster(editor, 'tile-swatch');
  await label(page, 'Fill').click();
  await labelMenuItem(page, 'Set Variable').hover();
  await labelMenuItem(page, /^Color$/).click();
  await expect(editor).toHaveStyle('tile-swatch', 'backgroundColor', 'color', { path: TILE });
  await toHome(editor);
  await editor.click('tile-a');
  await expect(panel(page).locator('span[title]', { hasText: /^color$/i }).first()).toBeVisible();
  for (const unused of ['Plain Text', 'Date', 'Toggle', 'Number', 'Shadow']) {
    await expect(panel(page).getByText(unused, { exact: true }), unused).toHaveCount(0);
  }
});

test('CMP-170 modal edits write @propMeta label/description/options and the default; identifier and binding unchanged; instances follow', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(META_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  const modal = await openVariablesModal(page);

  // Rename the Option variable's LABEL, describe it, add a choice.
  await varRow(modal, 'Size').click();
  const name = field(modal, 'Name').locator('input');
  await name.fill('Title Size');
  await name.press('Enter');
  await expect(varRow(modal, 'Title Size')).toBeVisible();
  await field(modal, 'Description').locator('textarea').fill('Heading scale');
  await field(modal, 'Description').locator('textarea').blur();
  await field(modal, 'Default').getByText('Add option…').click();
  const optInputs = field(modal, 'Default').locator('input');
  await expect(optInputs).toHaveCount(3);
  await optInputs.nth(2).fill('24px');
  await optInputs.nth(2).press('Enter');
  await pollCode(editor, TILE, c => (propMeta(c)?.size?.options ?? []).includes('24px'));
  // The Number variable's default.
  await varRow(modal, 'Count').click();
  const def = field(modal, 'Default').locator('input').first();
  await def.click();
  await def.fill('5');
  await def.press('Enter');

  const code = await pollCode(editor, TILE, c => /count = 5\b/.test(signature(c)) && propMeta(c)?.size?.description === 'Heading scale');
  const meta = propMeta(code)!;
  expect(meta.size).toMatchObject({ type: 'option', label: 'Title Size', description: 'Heading scale', options: ['14px', '18px', '24px'] });
  // Identifiers and bindings are untouched.
  const sig = signature(code);
  expect(sig).toMatch(/size = ['"]14px['"]/);
  expect(sig).toMatch(/count = 5\b/);
  expect(await editor.style('tile-title', TILE)).toMatchObject({ fontSize: 'size' });
  expect(elementOf(code, 'tile-body')!.children.trim()).toBe('{count}');
  expect(parsesStrict(code)).toBe(true);
  await closeModal(page);

  // Instances use the new label and choices.
  await toHome(editor);
  await editor.click('tile-a');
  const sizeRow = propRow(page, 'Title Size');
  await expect(sizeRow).toBeVisible();
  await expect(panel(page).getByText('Size', { exact: true })).toHaveCount(0);
  await expect(sizeRow.locator('select option', { hasText: '24px' })).toHaveCount(1);
  await expect(propRow(page, 'Count')).toBeVisible();
});

test('CMP-170 Number knobs (Min / Max / Step / Unit / Control) all persist and drive the instance row', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, "BUG: in the Variables modal a Number knob is wiped when focus moves to the next control — the ToolInput re-commits its stale empty value on blur (trace: tool-input:commit {from:'1',to:''} → number-meta {min:null}); Min/Step are lost even at a human pace (each landed first)");
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(META_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  const modal = await openVariablesModal(page);
  await varRow(modal, 'Count').click();
  const setNum = async (f: string, v: string, landed: (c: string) => boolean) => {
    const i = field(modal, f).locator('input').first();
    await i.click();
    await i.fill(v);
    await i.press('Enter');
    await pollCode(editor, TILE, landed);
    await page.waitForTimeout(500);
  };
  await setNum('Min', '1', c => propMeta(c)?.count?.min === 1);
  await setNum('Max', '9', c => propMeta(c)?.count?.max === 9);
  await setNum('Step', '2', c => propMeta(c)?.count?.step === 2);
  await field(modal, 'Unit').locator('select').selectOption('px');
  await pollCode(editor, TILE, c => propMeta(c)?.count?.unit === 'px');
  await field(modal, 'Control').getByText('Stepper', { exact: true }).click();
  const code = await pollCode(editor, TILE, c => propMeta(c)?.count?.control === 'stepper');
  await page.waitForTimeout(500);
  expect(propMeta(await editor.code(TILE))!.count).toMatchObject({ type: 'number', min: 1, max: 9, step: 2, unit: 'px', control: 'stepper' });
  expect(parsesStrict(code)).toBe(true);
  await closeModal(page);
  await toHome(editor);
  await editor.click('tile-a');
  const count = propRow(page, 'Count');
  await expect(count).toBeVisible();
  await expect(count.locator('[role="slider"]')).toHaveCount(0);
});

test('CMP-170 a renamed COLOUR variable label reaches the instance row', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: rich-atom instance rows (colour / border / shadow / image) are labelled with the prop IDENTIFIER, not the @propMeta label — ComponentPropsTool.tsx:2811 LabelOverrideProvider label={varType === transition ? label : prop.name}; text/number/option rows use the label');
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(META_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  const modal = await openVariablesModal(page);
  await varRow(modal, 'Accent').click();
  await field(modal, 'Name').locator('input').fill('Brand Accent');
  await field(modal, 'Name').locator('input').press('Enter');
  await pollCode(editor, TILE, c => propMeta(c)?.accent?.label === 'Brand Accent');
  expect(await editor.style('tile-swatch', TILE)).toMatchObject({ backgroundColor: 'accent' });
  await closeModal(page);
  await toHome(editor);
  await editor.click('tile-a');
  await expect(panel(page).locator('span[title="Brand Accent"]')).toBeVisible({ timeout: 5_000 });
});

test('CMP-171 Remove: a bound variable is guarded; an unbound one leaves with its @propMeta and instance attrs; Remove 2 deletes both in one step', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(REMOVE_TILE, ['note="A note"', 'badge="B" tag="T"']));
  await enterMaster(editor, TILE, 'tile-root');
  const masterBefore = await editor.code(TILE);
  const pageBefore = await editor.code(PAGE);
  const modal = await openVariablesModal(page);

  // Bound → in-use warning, nothing deleted.
  await varRow(modal, 'Accent').hover();
  await varRow(modal, 'Accent').locator('button[title="More"]').click();
  await page.locator('div[style*="100021"] button', { hasText: /^Remove$/ }).click();
  await expect(modal.getByText('Accent is in use', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: /Swatch/ })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await editor.code(TILE)).toBe(masterBefore);

  // Unbound → the prop, its @propMeta entry and its hoist trail (instance attrs) go.
  const pushes0 = await historyPushes(editor);
  await varRow(modal, 'Note').hover();
  await varRow(modal, 'Note').locator('button[title="More"]').click();
  await page.locator('div[style*="100021"] button', { hasText: /^Remove$/ }).click();
  let code = await pollCode(editor, TILE, c => !/\bnote = /.test(c));
  expect(signature(code)).not.toMatch(/\bnote\b/);
  expect(propMeta(code)?.note).toBeUndefined();
  await expect.poll(async () => elementOf(await editor.code(PAGE), 'tile-a')!.open).not.toContain('note=');
  await expect(varRow(modal, 'Note')).toHaveCount(0);

  // Multi-select two → right-click → "Remove 2 variables": both in ONE step.
  // (Let the single delete's history entry close first — edits inside one
  // 300 ms window share an entry.)
  await waitHistoryPush(editor, pushes0);
  await page.waitForTimeout(500);
  const pushes = await historyPushes(editor);
  const beforeBulk = await editor.code(TILE);
  await varRow(modal, 'Badge').click();
  await varRow(modal, 'Tag').click({ modifiers: ['Shift'] });
  await varRow(modal, 'Tag').click({ button: 'right' });
  await page.locator('div[style*="100021"] button', { hasText: 'Remove 2 variables' }).click();
  code = await pollCode(editor, TILE, c => !/\bbadge = /.test(c) && !/\btag = /.test(c));
  expect(signature(code)).not.toMatch(/\b(badge|tag)\b/);
  expect(propMeta(code)).toMatchObject({ accent: { type: 'color' } });
  expect(Object.keys(propMeta(code) ?? {})).toEqual(['accent']);
  await expect.poll(async () => elementOf(await editor.code(PAGE), 'tile-b')!.open).not.toMatch(/badge=|tag=/);
  expect(parsesStrict(code)).toBe(true);
  expect(await editor.style('tile-swatch', TILE)).toMatchObject({ backgroundColor: 'accent' });
  await closeModal(page);
  await waitHistoryPush(editor, pushes);
  await expect(editor).toUndoInOneStep(beforeBulk, { path: TILE });
  expect(pageBefore).toContain('badge="B" tag="T"');
});

test('CMP-172 × on a bound Fill pill injects the variable default; the prop stays', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(JOI_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  await selectInMaster(editor, 'tile-swatch');
  const before = await editor.code(TILE);
  const pushes = await historyPushes(editor);
  const pill = row(page, 'Fill').locator('[title^="Variable: joijoijoi"]');
  await expect(pill).toBeVisible();
  await pill.locator('[title="Remove variable binding"]').click();

  await expect(editor).toHaveStyle('tile-swatch', 'backgroundColor', '#1E3C1B', { path: TILE });
  const code = await editor.code(TILE);
  // The prop stays (the title still uses it); the fill was NOT cleared.
  expect(signature(code)).toMatch(/joijoijoi = ['"]#1E3C1B['"]/);
  expect(await editor.style('tile-title', TILE)).toMatchObject({ color: 'joijoijoi' });
  expect(propMeta(code)?.joijoijoi).toMatchObject({ type: 'color' });
  await expect.poll(async () => (await paint(editor, 'tile-swatch'))?.bg).toBe('rgb(30, 60, 27)');
  await expect(row(page, 'Fill').getByText('#1E3C1B')).toBeVisible();
  await waitHistoryPush(editor, pushes);
  await expect(editor).toUndoInOneStep(before, { path: TILE });
});

test('CMP-173 × at a prop\'s LAST use drops it from the master and every instance (data-responsive + cursor opts too); a still-used prop only unbinds', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  const ABOUT = 'app/about/page.client.tsx';
  await editor.load(tileSeed(CASCADE_TILE, [
    'accent="#ff0000" ink="#00ff00" cursor={Pointer} cursorOpts={{"mode":"follow"}}',
    `accent="#0000ff" ink="#111111" data-responsive='{"768":{"accent":"#00ffff","ink":"#222222"},"_bp":[1440,768]}'`,
  ], {
    tiles: [TILES.three[0], TILES.three[1]],
    imports: [`import Pointer from '@/components/Pointer';`],
    pages: { '/about': homePage(`      <Tile data-id="tile-c" data-name="Tile C" accent="#abcdef" ink="#fedcba" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />`, { imports: [`import Tile from '@/components/Tile';`] }) },
    files: { 'components/Pointer.tsx': POINTER_MASTER },
  }));
  await enterMaster(editor, TILE, 'tile-root');

  // 1) `accent` — its only use is the swatch fill: × removes it everywhere.
  await selectInMaster(editor, 'tile-swatch');
  await row(page, 'Fill').locator('[title="Remove variable binding"]').click();
  let code = await pollCode(editor, TILE, c => !/\baccent = /.test(c));
  expect(signature(code)).not.toMatch(/\baccent\b/);
  expect(await editor.style('tile-swatch', TILE)).toMatchObject({ backgroundColor: '#1E3C1B' });
  await expect.poll(async () => elementOf(await editor.code(PAGE), 'tile-a')!.open).not.toContain('accent=');
  const tileB = elementOf(await editor.code(PAGE), 'tile-b')!.open;
  expect(tileB).not.toContain('accent=');
  expect(tileB).not.toContain('"accent"');
  expect(tileB).toContain('"ink":"#222222"');
  expect(elementOf(await editor.code(ABOUT), 'tile-c')!.open).not.toContain('accent=');

  // 2) `ink` — still used by the body: × on the title only unbinds there.
  await page.waitForTimeout(450);
  await selectInMaster(editor, 'tile-title');
  const pageMid = await editor.code(PAGE);
  await row(page, 'Color').locator('[title="Remove variable binding"]').click();
  await expect(editor).toHaveStyle('tile-title', 'color', '#ffffff', { path: TILE });
  code = await editor.code(TILE);
  expect(signature(code)).toMatch(/\bink = /);
  expect(await editor.style('tile-body', TILE)).toMatchObject({ color: 'ink' });
  expect(await editor.code(PAGE)).toBe(pageMid);
  expect(elementOf(await editor.code(ABOUT), 'tile-c')!.open).toContain('ink="#fedcba"');

  // 3) The component-cursor variable: × strips cursor + cursorOpts and the withCursor call.
  await page.waitForTimeout(450);
  await editor.click('tile-root');
  await expect.poll(() => editor.selection()).toEqual(['tile-root']);
  await panel(page).locator('[title="Remove cursor variable"]').click();
  code = await pollCode(editor, TILE, c => !/withCursor\(/.test(c.slice(c.indexOf('function Tile'))));
  expect(signature(code)).not.toMatch(/\bcursor\b|\bcursorOpts\b/);
  expect(code.slice(code.indexOf('function Tile'))).not.toContain('withCursor(');
  await expect.poll(async () => elementOf(await editor.code(PAGE), 'tile-a')!.open).not.toMatch(/cursor=|cursorOpts=/);
  expect(parsesStrict(code)).toBe(true);
  expect(parsesStrict(await editor.code(PAGE))).toBe(true);
});

test('CMP-174 Duplicate copies type, default, description, options and number meta as "<label> Copy", bound nowhere', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(DUP_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  const modal = await openVariablesModal(page);
  for (const v of ['Size', 'Count']) {
    await varRow(modal, v).hover();
    await varRow(modal, v).locator('button[title="More"]').click();
    await page.locator('div[style*="100021"] button', { hasText: /^Duplicate$/ }).click();
    await expect(varRow(modal, `${v} Copy`)).toBeVisible();
  }
  const code = await pollCode(editor, TILE, c => !!propMeta(c)?.countCopy?.control);
  const meta = propMeta(code)!;
  expect(meta.sizeCopy).toEqual({ ...meta.size, label: 'Size Copy' });
  expect(meta.countCopy).toEqual({ ...meta.count, label: 'Count Copy' });
  expect(meta.sizeCopy).toMatchObject({ type: 'option', description: 'Pick one', options: ['S', 'M', 'L'] });
  expect(meta.countCopy).toMatchObject({ type: 'number', min: 0, max: 10, step: 2, unit: 'px', control: 'stepper' });
  const sig = signature(code);
  expect(sig).toMatch(/sizeCopy = ['"]M['"]/);
  expect(sig).toMatch(/countCopy = 4\b/);
  // Bound nowhere: the copies appear only in the signature.
  const body = code.slice(code.indexOf('return ('));
  expect(body).not.toMatch(/sizeCopy|countCopy/);
  expect(parsesStrict(code)).toBe(true);
});

test('CMP-175 create + delete a variable next to a useMediaQuery helper: the prop lands on the component, useState(() => …) stays intact', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(tileSeed(MQ_TILE));
  await enterMaster(editor, TILE, 'tile-root');
  const helper = (c: string) => c.slice(c.indexOf('function useMediaQuery'), c.indexOf('function Tile'));
  const helperBefore = helper(await editor.code(TILE));
  expect(helperBefore).toContain('React.useState(() =>');

  // Create (Fill → Create Variable → Color).
  await selectInMaster(editor, 'tile-swatch');
  await labelMenuPath(page, 'Fill', 'Create Variable', 'Color');
  let code = await pollCode(editor, TILE, c => /backgroundColor: color\b/.test(c));
  expect(signature(code)).toMatch(/color = ["']#1E3C1B["'], \.\.\.rest$/);
  expect(helper(code)).toBe(helperBefore);
  expect(code).toContain('function useMediaQuery(query: string)');
  expect(code).not.toMatch(/useState\(\(\{/);
  await closeModal(page);

  // Create an unbound one from "+" and delete it.
  const modal = await openVariablesModal(page);
  await modal.locator('button[title="Add a variable"]').click();
  await page.locator('div[style*="100020"] button', { hasText: /^Plain Text$/ }).click();
  code = await pollCode(editor, TILE, c => /plainText = /.test(c));
  expect(signature(code)).toMatch(/plainText = ["']{2}, \.\.\.rest$/);
  expect(helper(code)).toBe(helperBefore);
  await varRow(modal, 'Plain Text').hover();
  await varRow(modal, 'Plain Text').locator('button[title="More"]').click();
  await page.locator('div[style*="100021"] button', { hasText: /^Remove$/ }).click();
  code = await pollCode(editor, TILE, c => !/plainText = /.test(c));
  expect(helper(code)).toBe(helperBefore);
  expect(code).not.toMatch(/useState\(\(\{/);
  expect(parsesStrict(code)).toBe(true);
  await closeModal(page);
  // The master still renders.
  await expect.poll(async () => (await paint(editor, 'tile-swatch'))?.bg).toBe('rgb(30, 60, 27)');
});
