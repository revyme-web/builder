// CMP · Make Component: the flow itself (E2E_TEST_PLAN.md §8, CMP-001..003,
// 007..010, 033, 037, 038). Right-click → "Make Component" → name modal →
// Create, the Ctrl+Alt+K shortcut, undo/redo, and where the action is offered.

import { test, expect } from '../../fixtures/test';
import {
  MAKE_COMPONENT_PAGE, makeComponentPage, MAKE_COMPONENT_BODY, cardJsx, BADGE_MASTER, CHIPS_PAGE,
  makeComponentViaMenu, makeComponentViaShortcut, pressMakeComponentShortcut,
  rightClickNode, menuItem, menuStructure, closeMenu, contextMenu,
  nameModal, submitName, breadcrumb, allowMasterEntryNoise, elementFacts,
  hasDefaultImport, parses, annotatedName, waitForActiveFile, newComponentFiles, exitToPage,
} from '../../helpers/c1';

const PAGE = 'app/page.client.tsx';
const CARD_CORNER: [number, number] = [0.04, 0.03];

test.beforeEach(async ({ editor }) => {
  // A loaded machine: every row boots the editor and enters a master at least once.
  test.slow();
  allowMasterEntryNoise(editor);
});

/** The master/page shape every successful Make Component of the card writes. */
async function expectCardComponent(
  editor: import('../../helpers/editor').Editor,
  made: { file: string; tag: string },
  name: string,
) {
  expect(made.file).toMatch(/^components\/[A-Z][a-z]+(?:[A-Z][a-z]+)+\.tsx$/);
  const master = await editor.code(made.file);
  expect(await parses(master)).toBe(true);
  expect(annotatedName(master)).toBe(name);
  expect(master).toMatch(new RegExp(`const variantConfig = \\[\\s*\\{ name: 'default', label: '${name}', x: 0, y: 0, isPrimary: true \\}`));
  expect(master).toContain(`function ${made.tag}({ style, initialVariant = 'default', ...rest }`);
  expect(master).toMatch(new RegExp(`export default withResponsiveProps\\(${made.tag}\\);`));
  // The master root is the card; its style spreads the instance `style` LAST.
  const root = await elementFacts(master, 'card');
  expect(root?.tag).toBe('motion.div');
  expect(root?.styleLastIsSpread).toBe('style');
  expect(root?.attrs).toContain('...rest');
  for (const child of ['card-title', 'card-body', 'card-img']) expect(await editor.exists(child, made.file)).toBe(true);

  // Page: the node became `<Tag data-id="card" data-name="<name>" style={{ position: 'relative', … }} />`.
  const page = await editor.code(PAGE);
  expect(await parses(page)).toBe(true);
  expect(hasDefaultImport(page, made.tag)).toBe(true);
  const inst = await elementFacts(page, 'card');
  expect(inst?.tag).toBe(made.tag);
  expect(inst?.source).toMatch(/\/>$/);
  expect(await editor.attr('card', 'data-name', PAGE)).toBe(name);
  expect(await editor.style('card', PAGE)).toMatchObject({ position: 'relative', flex: '0 0 auto', order: '0', width: '320px' });
  // The subtree left the page.
  for (const child of ['card-title', 'card-body', 'card-img']) expect(await editor.exists(child, PAGE)).toBe(false);
}

test('CMP-001 right-click → Make Component writes the master and swaps the node for an instance', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);

  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });

  await expectCardComponent(editor, made, 'Pricing Card');
  // The master's default tile paints the card's content.
  await expect(editor.node('card-title')).toHaveText('Pro plan');
  await expect(editor.node('card-body')).toBeVisible();
  expect(await breadcrumb(page)).toEqual(['Home', 'Pricing Card']);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-002 Ctrl+Alt+K (and macOS Cmd+Option+K) opens the same name modal, Enter creates', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);
  const cursor = () => page.locator('[data-canvas-root]').evaluate(el => getComputedStyle(el).cursor);

  // Real click selects the card.
  const corner = await editor.at('card', ...CARD_CORNER);
  await page.mouse.click(corner.x, corner.y);
  await editor.settled();
  expect(await editor.selection()).toEqual(['card']);

  // macOS: Option composes K into "˚" — the shortcut must still match the physical key.
  await pressMakeComponentShortcut(page, 'mac');
  const modal = nameModal(page);
  await expect(modal.heading).toBeVisible();
  await expect(modal.input).toHaveValue('Card');
  await expect(modal.submit).toHaveText('Create Component');
  // Not: the chord fell through to plain K (the Sketch tool).
  expect(await cursor()).not.toBe('crosshair');
  await page.keyboard.press('Escape');
  await expect(modal.heading).toBeHidden();
  expect(await editor.code(PAGE)).toBe(before);

  // Ctrl+Alt+K → the same modal, pre-filled with the node's data-name → Enter.
  const made = await makeComponentViaShortcut(editor, 'card', null, { at: CARD_CORNER });
  expect(await cursor()).not.toBe('crosshair');
  await expectCardComponent(editor, made, 'Card');
  await expect(editor.node('card-title')).toHaveText('Pro plan');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-003 one undo removes the component and returns to the page; redo re-enters it', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: redo of Make Component restores both files and the in-master breadcrumb trail but leaves the editor on the PAGE (the history entry\'s activeFile is the pre-op page)');
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });
  const pageAfter = await editor.code(PAGE);
  const masterAfter = await editor.code(made.file);
  expect(await breadcrumb(page)).toEqual(['Home', 'Pricing Card']);

  // Ctrl+Z: byte-identical page, master deleted, editor back on the page.
  await editor.undo();
  await expect.poll(() => editor.code(PAGE)).toBe(before);
  await expect.poll(async () => (await editor.listFiles()).includes(made.file)).toBe(false);
  await waitForActiveFile(editor, PAGE);
  await expect.poll(() => breadcrumb(page)).toEqual([]);
  await expect(editor.node('card-title')).toHaveText('Pro plan');

  // Ctrl+Shift+Z: the file and the instance are back, the editor is in the master again.
  await editor.redo();
  await expect.poll(() => editor.code(made.file)).toBe(masterAfter);
  await expect.poll(() => editor.code(PAGE)).toBe(pageAfter);
  await waitForActiveFile(editor, made.file);
  // Not: the trail duplicated (Home › Pricing Card › Pricing Card).
  await expect.poll(() => breadcrumb(page)).toEqual(['Home', 'Pricing Card']);
});

test('CMP-007 the typed name wins over the pre-filled "Frame" and survives a reload', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  const seed = makeComponentPage({ body: MAKE_COMPONENT_BODY.replace(cardJsx(), cardJsx('', 'card', 'Frame')) });
  await editor.load(seed);
  const filesBefore = await editor.listFiles();

  await rightClickNode(editor, 'card', { at: CARD_CORNER });
  await menuItem(page, 'Make Component').click();
  const modal = nameModal(page);
  await expect(modal.input).toHaveValue('Frame');
  // Clear the pre-fill and type, like a user (no fill()).
  await modal.input.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Hero Card');
  await modal.submit.click();

  await expect.poll(async () => (await newComponentFiles(editor, filesBefore)).length).toBe(1);
  const [file] = await newComponentFiles(editor, filesBefore);
  await waitForActiveFile(editor, file);
  const master = await editor.code(file);
  expect(annotatedName(master)).toBe('Hero Card');
  // Not: created under the fallback node name (stale closure).
  expect(master).not.toContain('@name "Frame"');
  expect(await editor.attr('card', 'data-name', PAGE)).toBe('Hero Card');

  const libraryRow = async () => {
    const lib = page.locator('[data-tutorial="library-button"]');
    const panel = page.locator('[data-tutorial="left-panel"]');
    if (!(await panel.getByText('Components', { exact: true }).isVisible().catch(() => false))) await lib.click();
    return panel.getByText('Hero Card', { exact: true });
  };
  await expect(await libraryRow()).toBeVisible();

  // Wait for the LOCAL save, then reload: the name comes back from storage.
  await expect.poll(() => page.evaluate((f) => {
    const raw = localStorage.getItem('revyme-project-local');
    return !!raw && (JSON.parse(raw).files?.[f] ?? '').includes('@name "Hero Card"');
  }, file), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  expect(annotatedName(await editor.code(file))).toBe('Hero Card');
  await expect(await libraryRow()).toBeVisible();
  await expect(page.locator('[data-tutorial="left-panel"]').getByText('Frame', { exact: true })).toHaveCount(0);
});

const GATES_PAGE = makeComponentPage({
  imports: ["import Badge from '@/components/Badge';"],
  body: MAKE_COMPONENT_BODY.replace(
    `<p data-id="label"`,
    `<Badge data-id="badge" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto', order: '5' }} />
      <svg data-id="icon" data-name="Icon" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" style={{ position: 'relative', flex: '0 0 auto', order: '6', width: '80px', height: '80px', display: 'block' }}>
        <path data-id="icon-path" d="M11 0 L13 9 L22 11 L13 13 L11 22 L9 13 L0 11 L9 9 Z" fill="#A9FF55" />
      </svg>
      <p data-id="label"`,
  ),
  extraFiles: { 'components/Badge.tsx': BADGE_MASTER },
});

test('CMP-008 a multi-selection offers no Make Component (menu or shortcut); its wrapper frame does', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(CHIPS_PAGE);
  const before = await editor.code(PAGE);
  const filesBefore = await editor.listFiles();

  // Click one chip, Shift+click the other. The press points sit inside the
  // pair's bounding box, clear of its resize edges (a right-press on an edge
  // starts a group resize).
  const a = await editor.at('chip-a', 0.88, 0.5);
  const b = await editor.at('chip-b', 0.12, 0.5);
  await page.mouse.click(a.x, a.y);
  await editor.settled();
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await editor.settled();
  expect((await editor.selection()).sort()).toEqual(['chip-a', 'chip-b']);

  await page.mouse.click(a.x, a.y, { button: 'right' });
  await expect(contextMenu(page)).toBeVisible();
  expect((await editor.selection()).sort()).toEqual(['chip-a', 'chip-b']);
  const rows = await menuStructure(page);
  expect(rows).toContain('Create Frame');
  expect(rows).not.toContain('Make Component');
  expect(rows[0]).not.toBe('—');
  await closeMenu(page);

  await pressMakeComponentShortcut(page);
  await editor.settled();
  await expect(nameModal(page).heading).toBeHidden();
  expect(await newComponentFiles(editor, filesBefore)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(before);

  // Wrap them in a frame first: Make Component then works on the wrapper.
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await menuItem(page, 'Create Frame').click();
  await expect.poll(async () => {
    const sel = await editor.selection();
    return sel.length === 1 && (await editor.childIds(sel[0], PAGE)).sort().join(',');
  }).toBe('chip-a,chip-b');
  const [wrapper] = await editor.selection();
  const made = await makeComponentViaShortcut(editor, wrapper, 'Pair');
  expect(annotatedName(await editor.code(made.file))).toBe('Pair');
  expect((await editor.childIds(wrapper, made.file)).sort()).toEqual(['chip-a', 'chip-b']);
  expect((await elementFacts(await editor.code(PAGE), wrapper))?.tag).toBe(made.tag);
  await expect(editor.node('chip-a-text')).toHaveText('Alpha');
});

test('CMP-009 an instance offers Detach / Replace with and an svg only Make Vector Set; the shortcut skips both', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(GATES_PAGE);
  const before = await editor.code(PAGE);
  const filesBefore = await editor.listFiles();

  // Design-component instance.
  await rightClickNode(editor, 'badge', { at: [0.9, 0.5] });
  expect(await editor.selection()).toEqual(['badge']);
  let rows = await menuStructure(page);
  expect(rows).toContain('Detach Instance');
  expect(rows).toContain('Replace with');
  expect(rows).not.toContain('Make Component');
  expect(rows).not.toContain('Unfold Children');
  expect(rows[0]).not.toBe('—');
  await closeMenu(page);
  await pressMakeComponentShortcut(page);
  await editor.settled();
  await expect(nameModal(page).heading).toBeHidden();

  // An svg icon.
  await rightClickNode(editor, 'icon', { at: [0.5, 0.5] });
  expect(await editor.selection()).toEqual(['icon']);
  rows = await menuStructure(page);
  expect(rows).toContain('Make Vector Set');
  expect(rows).not.toContain('Make Component');
  expect(rows).not.toContain('Detach Instance');
  await closeMenu(page);
  await pressMakeComponentShortcut(page);
  await editor.settled();
  await expect(nameModal(page).heading).toBeHidden();
  await expect(nameModal(page, 'Name Vector Set').heading).toBeHidden();

  expect(await newComponentFiles(editor, filesBefore)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(before);
});

test('CMP-033 after Make Component the editor is inside the master: Layers, default tile selected and fitted, breadcrumb', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  // Start from another left panel so the switch to Layers is observable.
  await page.locator('[data-tutorial="library-button"]').click();
  await expect(page.locator('[data-tutorial="library-button"]')).toHaveClass(/btn-secondary-bg/);

  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });

  expect(await editor.activeFile()).toBe(made.file);
  await expect(page.locator('[data-tutorial="layers-button"]')).toHaveClass(/btn-secondary-bg/);
  // The Layers tree lists the master: its default variant (labelled with the name) and the card's children.
  const panel = page.locator('[data-tutorial="left-panel"]');
  for (const row of ['Pricing Card', 'Title', 'Body', 'Image']) await expect(panel.getByText(row, { exact: true }).first()).toBeVisible();
  // The default variant's root is selected.
  await expect.poll(() => editor.selection()).toEqual(['card']);
  expect(await breadcrumb(page)).toEqual(['Home', 'Pricing Card']);
  // …and the camera fits that tile: centred in the canvas, at a working size.
  const canvas = (await page.locator('[data-canvas-root]').boundingBox())!;
  await expect.poll(async () => {
    const b = await editor.nodeBox('card');
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return Math.abs(cx - (canvas.x + canvas.width / 2)) < canvas.width * 0.15
      && Math.abs(cy - (canvas.y + canvas.height / 2)) < canvas.height * 0.2
      && b.width > canvas.width * 0.2;
  }, { timeout: 5_000 }).toBe(true);
});

test('CMP-037 the name modal: empty name writes nothing, Escape writes nothing, quotes are escaped', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: a name with double quotes is written raw — data-name="My "Quoted" Card" breaks the page (SYNTAX_ERROR) and @name is not escaped');
  await editor.load(MAKE_COMPONENT_PAGE);
  const before = await editor.code(PAGE);
  const filesBefore = await editor.listFiles();
  const modal = nameModal(page);

  // Empty: Create is disabled and Enter does nothing.
  await rightClickNode(editor, 'card', { at: CARD_CORNER });
  await menuItem(page, 'Make Component').click();
  await modal.input.fill('   ');
  await expect(modal.submit).toBeDisabled();
  await modal.input.press('Enter');
  await editor.settled();
  expect(await newComponentFiles(editor, filesBefore)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(before);

  // Escape: the modal closes, nothing written.
  await modal.input.fill('Never Made');
  await page.keyboard.press('Escape');
  await expect(modal.heading).toBeHidden();
  await editor.settled();
  expect(await newComponentFiles(editor, filesBefore)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(before);
  expect(await editor.activeFile()).toBe(PAGE);

  // Quotes: `@name` keeps them escaped and both files still parse.
  await rightClickNode(editor, 'card', { at: CARD_CORNER });
  await menuItem(page, 'Make Component').click();
  await submitName(page, 'My "Quoted" Card');
  await expect.poll(async () => (await newComponentFiles(editor, filesBefore)).length).toBe(1);
  const [file] = await newComponentFiles(editor, filesBefore);
  const master = await editor.code(file);
  expect(annotatedName(master)).toBe('My \\"Quoted\\" Card');
  expect(await parses(master)).toBe(true);
  expect(await parses(await editor.code(PAGE))).toBe(true);
  expect(await editor.attr('card', 'data-name', PAGE)).toBe('My "Quoted" Card');
});

test('CMP-038 two Make Components write two independent random PascalCase masters', { tag: ['@p2', '@cmp'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_PAGE);
  const first = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER });
  await exitToPage(editor);
  const second = await makeComponentViaMenu(editor, 'cell-a', 'Pricing Card');

  expect(first.file).not.toBe(second.file);
  for (const m of [first, second]) {
    expect(m.tag).toMatch(/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/);
    // The display name is the @name, never the file name.
    expect(annotatedName(await editor.code(m.file))).toBe('Pricing Card');
    expect(m.tag).not.toMatch(/Pricing|Card/);
  }
  const pageCode = await editor.code(PAGE);
  expect(hasDefaultImport(pageCode, first.tag)).toBe(true);
  expect(hasDefaultImport(pageCode, second.tag)).toBe(true);
  expect((await elementFacts(pageCode, 'card'))?.tag).toBe(first.tag);
  expect((await elementFacts(pageCode, 'cell-a'))?.tag).toBe(second.tag);
  expect(await parses(pageCode)).toBe(true);
});
