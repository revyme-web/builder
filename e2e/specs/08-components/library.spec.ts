// CMP · Library: create, rename, delete, usage, replace (E2E_TEST_PLAN.md §8,
// CMP-176…CMP-186).
//
// The Library panel's Components section lists every master. Its rows carry
// a ⋯ menu (Edit / Rename / Duplicate / Move to folder / Delete), a usage
// badge that lists every instance project-wide, and shift-click multi-select.

import { test, expect } from '../../fixtures/test';
import type { Page } from '@playwright/test';
import {
  nameModal, rightClickNode, menuItem, contextMenu, breadcrumb, waitForNewComponent, annotatedName, allowMasterEntryNoise,
} from '../../helpers/c1';
import {
  PAGE, CARD, ABOUT, TEMPLATE, HEADER, BUTTON, LIBRARY_SEED, REPLACE_SEED, parsesStrict, pollCode, panel, elementOf,
  openLibrary, libraryPanel, libraryRow, openRowMenu, dropdownItem, usageBadge, paint, libraryInlineInput, sourceSnapshot, acceptKnownViolation,
  historyPushes, waitHistoryPush,
} from '../../helpers/c6';

test.describe.configure({ timeout: 150_000 });

const COUNTER = 'components/Counter.tsx';

/** The project as the editor would SAVE it (LOCAL mode: localStorage). */
async function savedFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate((f) => {
    const raw = localStorage.getItem('revyme-project-local');
    return raw ? (JSON.parse(raw).files?.[f] ?? null) : null;
  }, path);
}

function confirmDialog(page: Page, title: string) {
  return page.locator('[data-modal-root]', { has: page.getByRole('heading', { name: title, exact: true }) });
}

test('CMP-176 Library "+" → Design Component → "Badge" creates and enters a new master', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, "BUG: the Library's Design Component template (LibraryPanel/index.tsx createDesignComponent) writes a `position: 'relative'` master root, which the builder's own oracle rejects (COMPONENT_ROOT_POSITION, tier 2: a master root is absolute or has no position)");
  allowMasterEntryNoise(editor);
  await editor.load(LIBRARY_SEED);
  const pageBefore = await editor.code(PAGE);
  const filesBefore = new Set(await editor.listFiles());
  const lib = await openLibrary(page);
  await lib.locator('button[title="Create component"]').click();
  await dropdownItem(page, 'Design Component').click();
  const m = nameModal(page);
  await expect(m.input).toBeVisible();
  await expect(m.input).toHaveValue('');
  await m.input.fill('Badge');
  await m.submit.click();

  const made = await waitForNewComponent(editor, filesBefore, PAGE, pageBefore);
  // A random internal file name, never the display name.
  expect(made.file).toMatch(/^components\/[A-Z][A-Za-z]+\.tsx$/);
  expect(made.file).not.toBe('components/Badge.tsx');
  const code = await editor.code(made.file);
  expect(annotatedName(code)).toBe('Badge');
  expect(code).toMatch(new RegExp(`export default withResponsiveProps\\(${made.tag}\\);`));
  expect(code).toMatch(/const variantConfig = \[\{ name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true \}\];/);
  expect(parsesStrict(code)).toBe(true);
  const rootId = `${made.tag.toLowerCase()}-root`;
  const root = elementOf(code, rootId)!;
  expect(root.tag).toBe('motion.div');
  expect(root.open).toContain('data-name="Badge"');
  expect(await editor.style(rootId, made.file)).toMatchObject({ width: '300px', height: '300px', backgroundColor: '#ffffff' });
  expect(root.open).toMatch(/\.\.\.style,?\s*\}\}/);
  // The page is untouched.
  expect(await editor.code(PAGE)).toBe(pageBefore);

  // The editor is inside it: breadcrumb, and its 300×300 white root paints.
  await expect.poll(() => breadcrumb(page)).toContain('Badge');
  await expect.poll(async () => {
    const p = await paint(editor, rootId);
    return p && p.bg === 'rgb(255, 255, 255)' && p.width > 0 && Math.abs(p.width - p.height) < 1;
  }).toBe(true);
  // The Library lists it.
  await expect(await libraryRow(page, 'Badge')).toBeVisible();
});

test('CMP-177 Library ⋯ → Rename writes @name in place (after @controls when missing) and survives reload', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(LIBRARY_SEED);
  const cardBefore = await editor.code(CARD);
  const counterBefore = await editor.code(COUNTER);
  const pageBefore = await editor.code(PAGE);
  const filesBefore = Object.keys(await sourceSnapshot(editor)).sort();

  // Design component: ⋯ → Rename → "Pill" → Enter.
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Rename').click();
  const input = libraryInlineInput(page);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Card');
  await input.fill('Pill');
  await input.press('Enter');
  const card = await pollCode(editor, CARD, c => c !== cardBefore);
  // Replaced IN PLACE: the same file with only the annotation's text changed.
  expect(card).toBe(cardBefore.replace('/** @name "Card" */', '/** @name "Pill" */'));
  expect(card.match(/@name/g)).toHaveLength(1);
  // (Undo of a rename: see the separate CMP-177 undo test.)

  // Code component without @name: inserted AFTER the leading @controls block.
  await openRowMenu(page, 'Counter');
  await dropdownItem(page, 'Rename').click();
  await expect(libraryInlineInput(page)).toHaveValue('Counter');
  await libraryInlineInput(page).fill('Ticker');
  await libraryInlineInput(page).press('Enter');
  const counter = await pollCode(editor, COUNTER, c => c !== counterBefore);
  const at = counter.indexOf('/** @name "Ticker" */');
  expect(at).toBeGreaterThan(counter.indexOf('} */'));
  expect(at).toBeLessThan(counter.indexOf('import '));
  expect(parsesStrict(counter)).toBe(true);
  // The @controls block is untouched (an insert INSIDE it would corrupt the JSON).
  const controls = counterBefore.slice(counterBefore.indexOf('/** @controls'), counterBefore.indexOf('} */') + 4);
  expect(counter).toContain(controls);
  expect(counter.match(/@name/g)).toHaveLength(1);

  // File paths and the page's tags are unchanged.
  expect(Object.keys(await sourceSnapshot(editor)).sort()).toEqual(filesBefore);
  expect(await editor.code(PAGE)).toBe(pageBefore);

  // Library, instance panel and breadcrumb read the new names.
  await expect(await libraryRow(page, 'Pill')).toBeVisible();
  await expect(await libraryRow(page, 'Ticker')).toBeVisible();
  await expect(libraryPanel(page).getByText('Card', { exact: true })).toHaveCount(0);
  await editor.click('home-card');
  expect(await editor.selection()).toEqual(['home-card']);
  await expect(panel(page).getByText('Pill', { exact: true })).toBeVisible();
  await (await libraryRow(page, 'Pill')).click();
  await expect.poll(() => editor.activeFile()).toBe(CARD);
  await expect.poll(() => breadcrumb(page)).toEqual(['Home', 'Pill']);

  // Survives a reload (LOCAL save → reload reads what was saved).
  await expect.poll(async () => (await savedFile(page, CARD))?.includes('@name "Pill"') && (await savedFile(page, COUNTER))?.includes('@name "Ticker"'), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  expect(annotatedName(await editor.code(CARD))).toBe('Pill');
  await expect(await libraryRow(page, 'Pill')).toBeVisible();
  await expect(await libraryRow(page, 'Ticker')).toBeVisible();
});

test('CMP-177 Rename with double quotes escapes them and still reads back', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: setComponentName writes `@name "Pill \\"XL\\""` but NAME_REGEX (`"([^"]*)"`, component-ops.ts:198) cannot read an escaped quote, so the Library falls back to the file name "Card" and a later rename inserts a second @name');
  await editor.load(LIBRARY_SEED);
  const before = await editor.code(CARD);
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Rename').click();
  await libraryInlineInput(page).fill('Pill "XL"');
  await libraryInlineInput(page).press('Enter');
  const card = await pollCode(editor, CARD, c => c !== before);
  expect(card).toContain('/** @name "Pill \\"XL\\"" */');
  expect(parsesStrict(card)).toBe(true);
  await expect(await libraryRow(page, 'Pill "XL"')).toBeVisible({ timeout: 5_000 });
});

test('CMP-177 a Library rename is one undo step', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the Components section rename (ComponentsSection handleRenameCommit → modifyProjectFile) pushes no history entry — Cmd+Z does nothing (or reverts it only when it happens to merge into another pending edit); the Templates section pushes pushHistoryFileOp for the same action');
  await editor.load(LIBRARY_SEED);
  const before = await editor.code(CARD);
  const pushes = await historyPushes(editor);
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Rename').click();
  await libraryInlineInput(page).fill('Pill');
  await libraryInlineInput(page).press('Enter');
  await pollCode(editor, CARD, c => c !== before);
  await waitHistoryPush(editor, pushes);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect(await libraryRow(page, 'Card')).toBeVisible();
});

test('CMP-178 Library ⋯ → Delete: confirm copy; Delete removes every instance + import + file; Cancel changes nothing', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(LIBRARY_SEED);
  const snapshot = await sourceSnapshot(editor);

  // Cancel first: nothing changes.
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Delete').click();
  const dlg = confirmDialog(page, 'Delete Component');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('Are you sure you want to delete "Card"? All instances of this component will be removed from your project. This cannot be undone.', { exact: true })).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await editor.settled();
  expect(await sourceSnapshot(editor)).toEqual(snapshot);

  // Then Delete.
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Delete').click();
  await confirmDialog(page, 'Delete Component').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => editor.listFiles()).not.toContain(CARD);
  await editor.settled();
  for (const f of [PAGE, ABOUT, TEMPLATE, HEADER]) {
    const code = await editor.code(f);
    expect(code, f).not.toMatch(/<Card\b|<\/Card>/);
    expect(code, f).not.toMatch(/import Card from/);
    expect(parsesStrict(code), f).toBe(true);
  }
  // Everything else on those files survives.
  const home = await editor.code(PAGE);
  expect(home).toContain('data-id="home-btn"');
  expect(home).toContain('data-id="home-header"');
  expect(home).toMatch(/import Button from '@\/components\/Button'/);
  expect(await editor.code(ABOUT)).toContain('data-id="about-title"');
  expect(await editor.code(TEMPLATE)).toContain('{children}');
  expect(await editor.code(HEADER)).toContain('data-id="header-logo"');
  // The canvas and the Library follow.
  await expect(editor.sandbox().locator('[data-node-id="home-card"]')).toHaveCount(0);
  await expect(libraryPanel(page).getByText('Card', { exact: true })).toHaveCount(0);
});

test('CMP-179 deleting the component whose master is open goes Home first, clears selection and breadcrumb', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(LIBRARY_SEED);
  await (await libraryRow(page, 'Card')).click();
  await expect.poll(() => editor.activeFile()).toBe(CARD);
  await editor.settled();
  await page.waitForTimeout(500);
  await editor.click('card-title');
  await expect.poll(() => editor.selection()).toEqual(['card-title']);
  expect(await breadcrumb(page)).toContain('Card');

  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Delete').click();
  await confirmDialog(page, 'Delete Component').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => editor.listFiles()).not.toContain(CARD);
  await expect.poll(() => editor.activeFile()).toBe(PAGE);
  await editor.settled();
  expect(await editor.selection()).toEqual([]);
  expect(await breadcrumb(page)).not.toContain('Card');
  // The page renders (no error banner) without the instance.
  await expect(editor.sandbox().locator('[data-node-id="home-btn"]')).toBeVisible();
  await expect(editor.sandbox().locator('[data-node-id="home-card"]')).toHaveCount(0);
  await expect(page.getByText('AI changes blocked — validation failed')).toHaveCount(0);
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
});

test('CMP-180 shift-click two rows → one "Delete 2 components" confirm removes both files and their instances', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(LIBRARY_SEED);
  await (await libraryRow(page, 'Card')).click({ modifiers: ['Shift'] });
  await (await libraryRow(page, 'Button')).click({ modifiers: ['Shift'] });
  // Shift-click picks rows; it never navigates.
  expect(await editor.activeFile()).toBe(PAGE);
  await openRowMenu(page, 'Button');
  // The per-row menu collapses to the single bulk entry.
  await expect(dropdownItem(page, 'Rename')).toHaveCount(0);
  await dropdownItem(page, 'Delete 2 components').click();
  const dlg = confirmDialog(page, 'Delete 2 components?');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(/^(Card, Button|Button, Card)\. This cannot be undone\.$/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(async () => (await editor.listFiles()).filter(f => f === CARD || f === BUTTON)).toEqual([]);
  // No per-item confirm stacked after the bulk one.
  await expect(confirmDialog(page, 'Delete Component')).toHaveCount(0);
  await editor.settled();
  const home = await editor.code(PAGE);
  expect(home).not.toMatch(/<Card\b|<Button\b|import (Card|Button) from/);
  expect(home).toContain('data-id="home-header"');
  for (const f of [ABOUT, TEMPLATE, HEADER]) expect(await editor.code(f), f).not.toMatch(/<Card\b|import Card from/);
  expect(parsesStrict(home)).toBe(true);
  await expect(editor.sandbox().locator('[data-node-id="home-btn"]')).toHaveCount(0);
});

test('CMP-181 usage badge lists all 4 Card uses with route-group-free labels and navigates to one; one popup at a time', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(LIBRARY_SEED);
  const badge = await usageBadge(page, 'Card');
  await expect(badge).toHaveText('4');
  await expect(badge).toHaveAttribute('title', 'Used by 4 nodes — click to view');
  await badge.click();
  const popup = page.locator('div[class*="z-[9999]"]').filter({ hasText: 'Home Card' });
  await expect(popup).toBeVisible();
  const entries = popup.locator('div.group');
  await expect(entries).toHaveCount(4);
  const texts = (await entries.allInnerTexts()).map(t => t.replace(/\s*View\s*$/, '').replace(/\s+/g, ' ').trim());
  expect(texts.sort()).toEqual([
    'About Card /about',
    'Header Card Header',
    'Home Card Home',
    'Template Card marketing Template',
  ]);
  expect(texts.join(' ')).not.toContain('(marketing)');

  // Click an entry: navigates to that file, selects and zooms to the instance.
  await entries.filter({ hasText: 'About Card' }).click();
  await expect.poll(() => editor.activeFile()).toBe(ABOUT);
  await expect.poll(() => editor.selection()).toEqual(['about-card']);
  const canvas = (await page.locator('[data-canvas-root]').boundingBox())!;
  await expect.poll(async () => {
    const b = await editor.nodeBox('about-card').catch(() => null);
    if (!b) return false;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    return Math.abs(cx - (canvas.x + canvas.width / 2)) < canvas.width * 0.1 && Math.abs(cy - (canvas.y + canvas.height / 2)) < canvas.height * 0.1;
  }, { timeout: 10_000 }).toBe(true);

  // Opening a second badge closes the first.
  await (await usageBadge(page, 'Card')).click();
  await expect(page.locator('div[class*="z-[9999]"]').filter({ hasText: 'Home Card' })).toBeVisible();
  await (await usageBadge(page, 'Button')).click();
  await expect(page.locator('div[class*="z-[9999]"]').filter({ hasText: 'Home Button' })).toBeVisible();
  await expect(page.locator('div[class*="z-[9999]"]').filter({ hasText: 'Home Card' })).toHaveCount(0);
});

test('CMP-182 right-click → Replace with → "But" → Button swaps the tag, keeps identity and size, drops Card props', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(REPLACE_SEED);
  const before = await editor.code(PAGE);
  await rightClickNode(editor, 'swap-card', { at: [0.9, 0.5] });
  expect(await editor.selection()).toEqual(['swap-card']);
  await contextMenu(page).getByRole('button', { name: /^Replace with/ }).hover();
  const search = page.getByPlaceholder('Search components…');
  await expect(search).toBeVisible();
  await search.click();
  await search.pressSequentially('But');
  const results = contextMenu(page).locator('button', { has: page.locator('span.flex-1.truncate') });
  await expect(results).toHaveText(['Button']);
  await results.first().click();

  const after = await pollCode(editor, PAGE, c => c !== before);
  const el = elementOf(after, 'swap-card')!;
  expect(el.tag).toBe('Button');
  expect(el.open).toContain('key={idx}');
  expect(el.open).toContain('data-pinned="true"');
  expect(el.open).toContain('data-name="Button"');
  expect(await editor.style('swap-card', PAGE)).toMatchObject({ position: 'relative', flex: '0 0 auto', width: '300px', height: '90px' });
  // Card-specific props are gone.
  expect(el.open).not.toMatch(/initialVariant|data-responsive|heading=/);
  // Imports swapped; the list survives.
  expect(after).toMatch(/import Button from '@\/components\/Button'/);
  expect(after).not.toMatch(/import Card from/);
  expect(after).toContain('posts.map((item, idx) =>');
  expect(parsesStrict(after)).toBe(true);
  // Selection stays on the node; the canvas paints Button rows.
  expect(await editor.selection()).toEqual(['swap-card']);
  await expect.poll(() => editor.sandbox().locator('[data-node-id="swap-card:btn-text"]').first().textContent()).toBe('Click');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-183 Components folders: New Folder, rename, drag a row in, ⋯ Move to, delete keeps the files', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(LIBRARY_SEED);
  const lib = await openLibrary(page);
  const folders = async () => JSON.parse((await editor.code('_meta/component-folders.json')) || '{"folders":[]}');

  // New Folder: created at once, straight into an empty inline name field.
  await lib.locator('button[title="Create component"]').click();
  await dropdownItem(page, 'New Folder').click();
  const input = libraryInlineInput(page);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await input.fill('UI');
  await input.press('Enter');
  await expect(await libraryRow(page, 'UI')).toBeVisible();

  // Rename through its ⋯ menu.
  await openRowMenu(page, 'UI');
  await dropdownItem(page, 'Rename').click();
  await libraryInlineInput(page).fill('Kit');
  await libraryInlineInput(page).press('Enter');
  await expect(await libraryRow(page, 'Kit')).toBeVisible();

  // Drag the Card row onto the folder.
  const from = (await (await libraryRow(page, 'Card')).boundingBox())!;
  const to = (await (await libraryRow(page, 'Kit')).boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + 30 + ((to.x + 40 - from.x - 30) * i) / 12, from.y + from.height / 2 + ((to.y + to.height / 2 - from.y - from.height / 2) * i) / 12);
  await page.waitForTimeout(150);
  await page.mouse.move(to.x + 41, to.y + to.height / 2);
  await page.mouse.up();
  await editor.settled();

  // ⋯ → Move to folder → Kit on the Button row.
  await openRowMenu(page, 'Button');
  await dropdownItem(page, 'Move to folder').hover();
  await dropdownItem(page, 'Kit').click();
  await editor.settled();

  await expect.poll(async () => {
    const f = (await folders()).folders?.find((x: any) => x.name === 'Kit');
    return f ? [...f.children].sort() : null;
  }).toEqual([BUTTON, CARD].sort());
  expect((await folders()).folders.map((f: any) => f.name)).toEqual(['Kit']);

  // The tree persists: it is in the saved project and comes back after reload.
  await expect.poll(async () => (await savedFile(page, '_meta/component-folders.json'))?.includes('"Kit"'), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  await expect(await libraryRow(page, 'Kit')).toBeVisible();
  expect((await folders()).folders.find((x: any) => x.name === 'Kit').children.sort()).toEqual([BUTTON, CARD].sort());

  // Deleting the folder keeps the component files (rows return to the root).
  await openRowMenu(page, 'Kit');
  await dropdownItem(page, 'Delete').click();
  await expect.poll(async () => (await folders()).folders?.length ?? 0).toBe(0);
  const files = await editor.listFiles();
  expect(files).toContain(CARD);
  expect(files).toContain(BUTTON);
  await expect(await libraryRow(page, 'Card')).toBeVisible();
  await expect(await libraryRow(page, 'Button')).toBeVisible();
});

test('CMP-184 Library ⋯ → Duplicate is a no-op today (no file, no error)', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(LIBRARY_SEED);
  const snapshot = await sourceSnapshot(editor);
  await openRowMenu(page, 'Card');
  await dropdownItem(page, 'Duplicate').click();
  await editor.settled();
  await page.waitForTimeout(500);
  // Flip this when Duplicate ships: it should then write a copy of the master.
  expect(await sourceSnapshot(editor)).toEqual(snapshot);
  expect(await editor.activeFile()).toBe(PAGE);
});

test('CMP-185 Name Component modal (context menu + Library): purple Create with a white label; a press that starts on it creates', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  allowMasterEntryNoise(editor);
  await editor.load(LIBRARY_SEED);
  const purple = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--accent-secondary, #9a66ff)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const isPurple = (rgb: string) => {
    const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
    return b > g + 40 && r > g; // violet: blue-dominant, red above green
  };
  expect(isPurple(purple)).toBe(true);
  const look = async (btn: import('@playwright/test').Locator) => btn.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));

  // 1) From the canvas context menu.
  await rightClickNode(editor, 'hero', { at: [0.9, 0.9] });
  await menuItem(page, 'Make Component').click();
  let m = nameModal(page);
  await expect(m.submit).toBeVisible();
  expect(await look(m.submit)).toEqual({ bg: purple, fg: 'rgb(255, 255, 255)' });
  // A press that starts ON the button and is released over the backdrop never dismisses.
  let b = (await m.submit.boundingBox())!;
  const vp = page.viewportSize()!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.width - 20, vp.height - 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(m.submit).toBeVisible();
  // A real mouse click on Create creates the component.
  let filesBefore = new Set(await editor.listFiles());
  b = (await m.submit.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  const made1 = await waitForNewComponent(editor, filesBefore, PAGE, '');
  expect(annotatedName(await editor.code(made1.file))).toBe('Hero');
  await expect(m.root).toHaveCount(0);

  // 2) From the Library "+" → Design Component.
  const lib = await openLibrary(page);
  await lib.locator('button[title="Create component"]').click();
  await dropdownItem(page, 'Design Component').click();
  m = nameModal(page);
  await m.input.fill('Chip');
  expect(await look(m.submit)).toEqual({ bg: purple, fg: 'rgb(255, 255, 255)' });
  filesBefore = new Set(await editor.listFiles());
  const from = await editor.activeFile();
  b = (await m.submit.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  const made2 = await waitForNewComponent(editor, filesBefore, from, '');
  expect(annotatedName(await editor.code(made2.file))).toBe('Chip');
  // The Library template's own root-position violation is CMP-176's bug.
  acceptKnownViolation(editor, made2.file, 'COMPONENT_ROOT_POSITION', `${made2.tag.toLowerCase()}-root`);
});

test('CMP-186 pasting an instance whose master path exists with different content materialises <Name>Linked.tsx', { tag: ['@p2', '@cmp'] }, async ({ editor, page, context }) => {
  test.fail(true, 'BUG: the materialised components/CardLinked.tsx keeps `function Card` / `withResponsiveProps(Card)` (materializeBundle, cross-project-paste.ts:92, renames the file only), so the registry keyed by export name renders <CardLinked> as an empty wrapper (oracle COMPONENT_NAME_MATCHES_FILE)');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.load(LIBRARY_SEED);
  const localCard = await editor.code(CARD);
  // A real copy of the instance captures its master bundle…
  await editor.click('home-card');
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('revyme_clipboard'))).toBe(true);
  // …then the clipboard is made to look like it came from ANOTHER project
  // whose components/Card.tsx differs (two standalone projects both report 'local').
  const otherCard = localCard.replace("backgroundColor: '#97cffc'", "backgroundColor: '#ff8800'");
  expect(otherCard).not.toBe(localCard);
  await page.evaluate((src) => {
    const data = JSON.parse(localStorage.getItem('revyme_clipboard')!);
    const master = data.components.find((c: any) => c.masterPath === 'components/Card.tsx');
    master.files[0].content = src;
    localStorage.setItem('revyme_clipboard', JSON.stringify(data));
  }, otherCard);
  const before = await editor.code(PAGE);

  await editor.click('hero');
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => editor.listFiles()).toContain('components/CardLinked.tsx');
  await editor.settled();
  // The incoming master is written under the aliased name and used by the paste…
  const linked = await editor.code('components/CardLinked.tsx');
  expect(linked).toContain("backgroundColor: '#ff8800'");
  expect(linked.replace(/\bCardLinked\b/g, 'Card')).toBe(otherCard);
  const after = await pollCode(editor, PAGE, c => /<CardLinked\b/.test(c));
  expect(after).toMatch(/<CardLinked\b/);
  expect(after).toMatch(/import CardLinked from '@\/components\/CardLinked'/);
  // …the local master is NOT silently reused or overwritten.
  expect(await editor.code(CARD)).toBe(localCard);
  expect((after.match(/<Card\b/g) ?? []).length).toBe((before.match(/<Card\b/g) ?? []).length);
  expect(parsesStrict(after)).toBe(true);
  // The pasted instance renders the INCOMING master (orange), the original stays blue.
  const pastedId = /<CardLinked\b[^>]*?data-id="([^"]+)"/.exec(after)![1];
  await expect.poll(async () => (await paint(editor, `${pastedId}:card-root`))?.bg).toBe('rgb(255, 136, 0)');
  expect((await paint(editor, 'home-card:card-root'))?.bg).toBe('rgb(151, 207, 252)');
  // A file named CardLinked exports CardLinked (the registry keys by export name).
  expect(await editor.code('components/CardLinked.tsx')).toMatch(/export default withResponsiveProps\(CardLinked\);/);
});
