// CMP · Instance props and overrides (E2E_TEST_PLAN.md §8, CMP-067…CMP-100).
//
// A page instance of a design component carries its prop values as JSX
// attributes on the tag (`<Card title="Hello" />`); the canvas expands the
// master per instance (`card-a:card-title`), so one instance's prop must
// paint only on that instance.

import { test, expect, TILES, TILES_VIEWPORT, project } from '../../fixtures/test';
import {
  INSTANCE_PROPS_ALL_TYPES, ALL_TYPES_CARD, MASTER_STATES, PAGE, CARD, propRow, typeInRow, canvasText, canvasStyle,
  openingTag, pollCode, openPreview, panel, withFiles, extraPage, GLOBALS_WITH_BRAND, PNG_1PX, canvasBgHex,
  closePopup, dblclickWord, loadC3, seedWithCard, twoInstancePage,
  DIRECTION_CARD, DIRECTION_LIST_PAGE, TEAM_CMS, resetOverrideLatency, TITLE_VARIANT_CARD, setPreviewWidth,
  ZAPOKA_SEED, SECTION_CARD, OVERLAY_BORDER_CARD, PRICING_SEED, pageModuleC3,
  NESTED_MASTERS, NAV_SEED, HEADER, clickStable, cursorSeed, cursorOptsSeed, CDN_SEED, CDN_URL, CDN_HASH, CDN_INTERFACE, stableCode,
  EVENT_CARD, LINK_IN_OVERLAY,
  APOSTROPHE_CARD, FORWARD_REF_CARD, NUMBER_CARD, ANIMATED_NUMBER, SVG_ICON_CARD,
} from '../../helpers/c3';

/** The editor's preview logs React's list-key warning for the page module (not this lane's subject). */
const PREVIEW_NOISE = /Each child in a list should have a unique "key" prop/;

test.describe.configure({ timeout: 120_000 });

test.describe('typed instance props', () => {
  test('CMP-067 plain-text prop on one instance writes its tag only', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    const master = await editor.code(CARD);
    await editor.click('card-a');
    await typeInRow(page, 'Title', 'Hello');

    await expect(editor).toHaveStyle('card-a', 'position', 'relative'); // tag still parses
    await expect.poll(() => editor.attr('card-a', 'title', PAGE)).toBe('Hello');
    expect(await editor.attr('card-b', 'title', PAGE)).toBeNull();
    expect(await editor.code(CARD)).toBe(master);

    await expect.poll(() => canvasText(editor, 'card-a:card-title')).toBe('Hello');
    expect(await canvasText(editor, 'card-b:card-title')).toBe('Card title');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    // After the undo/redo round trip the attribute is back exactly once.
    expect((await editor.code(PAGE)).match(/title="Hello"/g)).toHaveLength(1);
  });

  test('CMP-069 toggle prop set to No hides the icon on that instance only', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    await propRow(page, 'Icon Visible').getByText('No', { exact: true }).click();

    // A boolean expression, never the (truthy) string "false".
    await expect.poll(() => editor.attr('card-a', 'iconVisible', PAGE)).toBe('false');
    const tag = openingTag(await editor.code(PAGE), 'card-a');
    expect(tag).toContain('iconVisible={false}');
    expect(tag).not.toContain('iconVisible="false"');
    expect(await editor.attr('card-b', 'iconVisible', PAGE)).toBeNull();

    await expect.poll(() => canvasStyle(editor, 'card-a:card-icon', 'display')).toBe('none');
    expect(await canvasStyle(editor, 'card-b:card-icon', 'display')).toBe('block');
    // The builder's own oracle accepts the master's display ternary.
    const hides = (await editor.oracle(CARD)).filter(v => v.code === 'DISPLAY_TOGGLE_VISIBILITY');
    expect(hides).toEqual([]);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // Same in preview: A's icon is gone, B's still renders.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="card-b"]');
    await expect(frame.locator('[data-id="card-b"] [data-id="card-icon"]')).toBeVisible();
    await expect(frame.locator('[data-id="card-a"] [data-id="card-icon"]')).toBeHidden();
  });

  test('CMP-070 number prop slider previews live and commits once on release; typed value clamps to max', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: (1) a text-bound prop never previews live — previewProp patches `getContentRoot()` (the hidden parent-frame anchor, Canvas.tsx:1321) instead of the canvas iframe (ComponentPropsTool.tsx:944-950); (2) the typed value is not limited to @propMeta max (NumberVariableEditor passes no min/max to its ToolInput) → `count={99}`');
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    const row = propRow(page, 'Count');
    const thumb = row.locator('[role="slider"]').first();
    await expect(thumb).toBeVisible();
    const track = await row.locator('[data-orientation="horizontal"]').first().boundingBox();
    const tb = (await thumb.boundingBox())!;
    expect(track).not.toBeNull();

    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    // Drag toward 70% of the track (step 1 over 0..10 → 7), in several ticks.
    const targetX = track!.x + track!.width * 0.7;
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(tb.x + (targetX - tb.x) * (i / 6), tb.y + tb.height / 2);
      await page.waitForTimeout(30);
    }
    // Live: the canvas follows, the source does not (no per-tick write).
    await expect.poll(() => canvasText(editor, 'card-a:card-count')).toBe('7');
    expect(await editor.code(PAGE)).toBe(before);
    await page.mouse.up();

    await expect.poll(() => editor.attr('card-a', 'count', PAGE)).toBe('7');
    expect(openingTag(await editor.code(PAGE), 'card-a')).toContain('count={7}');
    expect(await canvasText(editor, 'card-b:card-count')).toBe('3');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // Typing past the max is limited to it.
    const input = row.locator('input').first();
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.fill('99');
    await input.press('Enter');
    await expect.poll(() => editor.attr('card-a', 'count', PAGE)).not.toBe('7');
    expect(await editor.attr('card-a', 'count', PAGE)).toBe('10');
  });

  test('CMP-071 option prop lists exactly its options and drives the bound padding on that instance', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    const select = propRow(page, 'Size').locator('select');
    const options = await select.locator('option').allTextContents();
    expect(options).toEqual(['8px', '16px', '32px']);
    await select.selectOption('32px');

    await expect.poll(() => editor.attr('card-a', 'size', PAGE)).toBe('32px');
    expect(openingTag(await editor.code(PAGE), 'card-a')).toContain('size="32px"');
    expect(await editor.attr('card-b', 'size', PAGE)).toBeNull();
    await expect.poll(() => canvasStyle(editor, 'card-a:card-root', 'padding-top')).toBe('32px');
    expect(await canvasStyle(editor, 'card-b:card-root', 'padding-top')).toBe('8px');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });
});

test.describe('variant + rich instance props', () => {
  test('CMP-068 Variant row picks a real variant: styles AND text follow, interaction states are not offered', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, MASTER_STATES);
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    const select = propRow(page, 'Variant').locator('select');
    // Only the component's own variants — hover/pressed are interaction states.
    expect(await select.locator('option').allTextContents()).toEqual(['Default', 'Hover']);
    await select.selectOption({ label: 'Hover' });

    await expect.poll(() => editor.attr('card-a', 'initialVariant', PAGE)).toBe('variant-1');
    expect(await editor.attr('card-b', 'initialVariant', PAGE)).toBeNull();
    // variant-1 styles AND variant-1 text — not variant-1 styles with the default text.
    await expect.poll(() => canvasBgHex(editor, 'card-a:card-root')).toBe('#ff2d75');
    await expect.poll(() => canvasText(editor, 'card-a:card-text')).toBe('Hover copy');
    expect(await canvasBgHex(editor, 'card-b:card-root')).toBe('#97cffc');
    expect(await canvasText(editor, 'card-b:card-text')).toBe('Resting copy');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test('CMP-072 colour prop: picker drag previews live and commits once; a preset shows the pill and × restores a plain value', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: the rich-atom prop row drops externalOnChangeLive (ComponentPropsTool.tsx:2831 passes only externalValue/externalOnChange to <VariableAtom>), so a colour drag commits through the 140ms debounce mid-drag instead of once on release');
    await loadC3(editor, withFiles(INSTANCE_PROPS_ALL_TYPES, { 'app/globals.css': GLOBALS_WITH_BRAND }));
    await editor.click('card-a');

    // A colour preset: the blue preset pill, and its × restores a plain value.
    await propRow(page, 'bg').getByText('#97CFFC').click();
    await page.locator('[data-tool-popup]').getByText('Brand', { exact: true }).click();
    await expect.poll(() => editor.attr('card-a', 'bg', PAGE)).toBe('var(--color-brand)');
    await closePopup(page);
    const pill = panel(page).locator('button[title^="Preset: "]');
    await expect(pill).toBeVisible();
    await expect.poll(() => canvasBgHex(editor, 'card-a:card-root')).toBe('#ff2d75');
    await pill.locator('[role="button"]').click();
    await expect.poll(() => editor.attr('card-a', 'bg', PAGE)).toBeNull();
    await expect(pill).toHaveCount(0);
    await expect(propRow(page, 'bg')).toContainText('#97CFFC');
    await expect.poll(() => canvasBgHex(editor, 'card-a:card-root')).toBe('#97cffc');

    // A picker drag: the canvas previews live, the source waits for the release.
    const before = await editor.code(PAGE);
    await propRow(page, 'bg').getByText('#97CFFC').click();
    const sv = page.locator('[data-tool-popup] .cursor-crosshair').first();
    await expect(sv).toBeVisible();
    const b = (await sv.boundingBox())!;
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width * (0.5 + 0.49 * i / 8), b.y + b.height * (0.5 - 0.49 * i / 8));
    await expect.poll(() => canvasBgHex(editor, 'card-a:card-root')).not.toBe('#97cffc');
    // Holding still mid-drag must not write (one commit per gesture).
    await page.waitForTimeout(400);
    expect(await editor.code(PAGE)).toBe(before);
    await page.mouse.up();
    await expect.poll(() => editor.attr('card-a', 'bg', PAGE)).toMatch(/^#[0-9a-f]{6}$/i);
    const bg = (await editor.attr('card-a', 'bg', PAGE))!.toLowerCase();
    expect(await canvasBgHex(editor, 'card-a:card-root')).toBe(bg);
    expect(await canvasBgHex(editor, 'card-b:card-root')).toBe('#97cffc');
    await closePopup(page);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test('CMP-073 image prop: the row is an image picker; picking writes a url() value on the instance only', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    const master = await editor.code(CARD);
    await editor.click('card-a');
    const row = propRow(page, 'image');
    // An image picker (thumbnail + "Image"), not a text field.
    await expect(row.locator('input')).toHaveCount(0);
    await row.getByText('Image', { exact: true }).click();
    await page.locator('[data-tool-popup]').getByText('Change', { exact: true }).click();
    await page.getByText('Upload', { exact: true }).first().click();
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'pick.png', mimeType: 'image/png', buffer: PNG_1PX });

    // LOCAL mode's asset backend returns a data: URL; the prop is the whole url() value.
    await expect.poll(() => editor.attr('card-a', 'image', PAGE)).toMatch(/^url\('?data:image\/png;base64,/);
    const value = (await editor.attr('card-a', 'image', PAGE))!;
    expect(openingTag(await editor.code(PAGE), 'card-a')).toContain(`image="${value}"`);
    expect(await editor.attr('card-b', 'image', PAGE)).toBeNull();
    expect(await editor.code(CARD)).toBe(master);
    await expect.poll(() => canvasStyle(editor, 'card-a:card-media', 'background-image')).toContain('data:image/png');
    expect(await canvasStyle(editor, 'card-b:card-media', 'background-image')).toContain('unsplash');
    await closePopup(page);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test('CMP-074 link prop: page + New Tab on A; B stays unset ("Add link", no anchor, no navigation)', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    const seed = withFiles(INSTANCE_PROPS_ALL_TYPES, extraPage('about', `<div data-id="about-root" data-name="About" style={{ width: '100%', minHeight: '400px', position: 'relative' }}><p data-id="about-title" style={{ position: 'relative' }}>About us</p></div>`));
    await loadC3(editor, seed);
    await editor.click('card-a');
    await propRow(page, 'linkHref').getByText('Add link').click();
    await page.locator('[data-tool-popup] input[placeholder^="/page"]').first().click();
    await page.getByText('about', { exact: true }).first().click();
    await expect.poll(() => editor.attr('card-a', 'linkHref', PAGE)).toBe('/about');
    await closePopup(page);
    await propRow(page, 'New Tab').getByText('Yes', { exact: true }).click();
    await expect.poll(() => editor.attr('card-a', 'newTab', PAGE)).toBe('true');
    // The boolean is an expression, never the (truthy) string "false"/"true".
    expect(openingTag(await editor.code(PAGE), 'card-a')).toContain('newTab={true}');

    // B never set the link: the row offers "Add link", the tag has no linkHref.
    await editor.click('card-b');
    await expect(propRow(page, 'linkHref')).toContainText('Add link');
    expect(await editor.attr('card-b', 'linkHref', PAGE)).toBeNull();

    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="card-b"]');
    const aLink = frame.locator('[data-id="card-a"] a[data-id="card-link"]');
    await expect(aLink).toHaveAttribute('href', '/about');
    await expect(aLink).toHaveAttribute('target', '_blank');
    // Not: an unset link going to Home — B renders no anchor at all, and clicking it stays put.
    await expect(frame.locator('[data-id="card-b"] a')).toHaveCount(0);
    const bLink = frame.locator('[data-id="card-b"] [data-id="card-link"]');
    await expect(bLink).toBeVisible();
    const previewUrl = await page.locator('iframe[src*="5175"]').evaluate(f => (f as HTMLIFrameElement).src);
    await bLink.click();
    await expect(frame.locator('[data-id="card-b"]')).toBeVisible();
    expect(await page.locator('iframe[src*="5175"]').evaluate(f => (f as HTMLIFrameElement).src)).toBe(previewUrl);
  });

  test('CMP-075 formatted-text prop: bold + link are written as one JS string literal and paint as HTML', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    await editor.click('card-a');
    await panel(page).locator('[data-formatted-text-edit="content"]').click();
    const field = page.locator('[data-formatted-text-field="content"]');
    await expect(field).toBeVisible();
    await dblclickWord(page, field, 'Plain');
    await page.getByTitle('Bold (⌘B)').click();
    await dblclickWord(page, field, 'here');
    await page.locator('[data-rich-link-toggle]').click();
    const linkInput = page.locator('[data-rich-link-panel] input').first();
    await linkInput.click();
    await linkInput.fill('https://example.com');
    await linkInput.press('Enter');
    await closePopup(page); // the Link popup
    await closePopup(page); // the Content popup

    await expect.poll(async () => openingTag(await editor.code(PAGE), 'card-a')).toMatch(/content=\{".*<a /);
    const tag = openingTag(await editor.code(PAGE), 'card-a');
    const m = tag.match(/content=\{("(?:[^"\\]|\\.)*")\}/);
    expect(m, tag).not.toBeNull();
    const html = JSON.parse(m![1]) as string;
    expect(html).toContain('<strong>Plain</strong>');
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"[^>]*>here<\/a>/);
    // A JS string literal on the tag — no `__html` style binding.
    expect(tag).not.toContain('__html');
    // The instance paints the HTML; B keeps the master default.
    const rich = editor.sandbox().locator('[data-node-id="card-a:card-rich"]');
    await expect(rich.locator('strong')).toHaveText('Plain');
    await expect(rich.locator('a')).toHaveText('here');
    await expect(editor.sandbox().locator('[data-node-id="card-b:card-rich"] strong')).toHaveCount(0);
    // A later prop edit still finds the tag and leaves the content intact.
    await typeInRow(page, 'Title', 'After');
    await expect.poll(() => editor.attr('card-a', 'title', PAGE)).toBe('After');
    expect(openingTag(await editor.code(PAGE), 'card-a')).toContain(`content={${m![1]}}`);
    expect((await editor.code(PAGE)).match(/data-id="card-a"/g)).toHaveLength(1);
  });

  test('CMP-076 transition prop: a spring is written as an object literal and reopens as the spring', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    await propRow(page, 'Transition').getByText('Default', { exact: true }).click();
    await page.locator('[data-tool-popup]').getByText('Spring', { exact: true }).click();
    await closePopup(page);
    await expect.poll(async () => openingTag(await editor.code(PAGE), 'card-a')).toMatch(/transition=\{\{/);
    const tag = openingTag(await editor.code(PAGE), 'card-a');
    expect(tag).toMatch(/transition=\{\{\s*type: 'spring'/);
    expect(tag).not.toMatch(/transition="/);
    // Reopen: the saved spring, not "Default".
    await editor.click('card-b');
    await expect(propRow(page, 'Transition')).toContainText('Default');
    await editor.click('card-a');
    await expect(propRow(page, 'Transition')).not.toContainText('Default');
    await propRow(page, 'Transition').locator('button').last().click();
    const springTab = page.locator('[data-tool-popup]').getByText('Spring', { exact: true });
    await expect(springTab).toBeVisible();
    await expect(page.locator('[data-tool-popup]').getByText('Stiffness').or(page.locator('[data-tool-popup]').getByText('Bounce')).first()).toBeVisible();
    await closePopup(page);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test('CMP-077 border and shadow props get their rich controls and write CSS values', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, INSTANCE_PROPS_ALL_TYPES);
    await editor.click('card-a');
    // Border control: Color / Width / Style.
    await propRow(page, 'border').getByText('1 · SOLID').click();
    const widthRow = page.locator('div').filter({ has: page.getByText('Width', { exact: true }) }).filter({ has: page.locator('input') }).last();
    const widthInput = widthRow.locator('input').last();
    await widthInput.click();
    await widthInput.press('ControlOrMeta+a');
    await widthInput.fill('2');
    await widthInput.press('Enter');
    await expect.poll(() => editor.attr('card-a', 'border', PAGE)).toBe('2px solid #000000');
    await page.keyboard.press('Escape');
    // Shadow row: the Shadow control (entries + Add…), not a colour picker.
    const shadowRow = panel(page).locator('div').filter({ has: page.getByText('shadow', { exact: true }) }).filter({ hasText: 'Add...' }).last();
    await expect(shadowRow.getByText('0, 4, 8')).toBeVisible();
    await expect(shadowRow.getByText('Add...')).toBeVisible();
    await shadowRow.getByText('0, 4, 8').click();
    await expect(page.locator('.cursor-crosshair')).toHaveCount(0);
    await expect(page.getByText('Blur', { exact: true }).first()).toBeVisible();
  });
});

test.describe('registry and tag-writer regressions', () => {
  test('CMP-086 an escaped apostrophe in a default does not hide the props after it', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, seedWithCard(APOSTROPHE_CARD));
    await editor.click('card-a');
    // Every prop after the apostrophe is listed on the instance.
    for (const label of ['Button Text', 'Font Size', 'Icon Visible', 'iconColor', 'iconColor2']) {
      await expect(panel(page).getByText(label, { exact: true }).first()).toBeVisible();
    }
    // The default keeps its apostrophe (row + canvas).
    await expect(propRow(page, 'Button Text').locator('input')).toHaveValue("Let's get your cargo");
    expect(await canvasText(editor, 'card-a:card-text')).toBe("Let's get your cargo");

    // Inside the master: the Variables modal and the Set Variable menu list them too.
    await panel(page).getByText('Edit Component').click();
    await expect.poll(() => editor.activeFile()).toBe(CARD);
    await editor.settled();
    await editor.click('card-root');
    await panel(page).getByText('Fill', { exact: true }).first().click();
    await page.getByText('Set Variable', { exact: true }).first().hover();
    await expect(page.getByText('Icon Color', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Icon Color 2', { exact: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await editor.click('card-icon');
    await panel(page).locator('[title^="Variable: Icon Color"]').first().click();
    const modal = page.locator('[data-modal-root]').filter({ hasText: 'Variables' }).last();
    for (const label of ['Button Text', 'Font Size', 'Icon Visible', 'Icon Color', 'Icon Color 2']) {
      await expect(modal.getByText(label, { exact: true }).first()).toBeVisible();
    }
    // The master's own source still carries the escaped default untouched.
    expect(await editor.code(CARD)).toContain("bTText = 'Let\\'s get your cargo'");
  });

  test('CMP-087 a forwardRef master paints its bound default and the row shows it', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, seedWithCard(FORWARD_REF_CARD));
    expect(await canvasBgHex(editor, 'card-a:card-root')).toBe('#ff2d75');
    await editor.click('card-a');
    await expect(propRow(page, 'tone')).toContainText('#FF2D75');
    // Not: the raw `var:<prop>` marker, in the panel or on the canvas.
    await expect(panel(page)).not.toContainText('var:tone');
    const style = await editor.sandbox().locator('[data-node-id="card-a:card-root"]').getAttribute('style');
    expect(style).not.toContain('var:');
  });

  test('CMP-090 a prop on its own line of a multi-line tag is edited in place, never duplicated', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    const pageJsx = `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <Card
    data-id="card-a"
    data-name="Card A"
    title="First"
    style={{ position: 'relative', flex: '0 0 auto' }}
  />
  <Card data-id="card-b" data-name="Card B" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`;
    await loadC3(editor, seedWithCard(ALL_TYPES_CARD, pageJsx));
    await editor.click('card-a');
    await expect(propRow(page, 'Title').locator('input')).toHaveValue('First');
    await typeInRow(page, 'Title', 'Second');
    await expect.poll(() => editor.attr('card-a', 'title', PAGE)).toBe('Second');
    const mid = await stableCode(editor, PAGE);
    await typeInRow(page, 'Title', 'Third');
    await expect.poll(() => editor.attr('card-a', 'title', PAGE)).toBe('Third');
    const tag = openingTag(await editor.code(PAGE), 'card-a');
    expect(tag.match(/\btitle=/g)).toHaveLength(1);
    expect(tag).not.toContain('First');
    expect(tag).not.toContain('Second');
    await expect.poll(() => canvasText(editor, 'card-a:card-title')).toBe('Third');
    await expect(editor).toUndoInOneStep(mid, { path: PAGE });
  });

  test('CMP-097 a number prop named `end` is a number control, not an Align select', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, withFiles(seedWithCard(NUMBER_CARD), { 'components/AnimatedNumber.tsx': ANIMATED_NUMBER }));
    await editor.click('card-a');
    const row = propRow(page, 'end');
    await expect(row).toBeVisible();
    await expect(row.locator('select')).toHaveCount(0);
    const input = row.locator('input').first();
    await expect(input).toHaveValue('12');
    // It edits as a number (expression), not an alignment keyword.
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.fill('20');
    await input.press('Enter');
    await expect.poll(() => editor.attr('card-a', 'end', PAGE)).toBe('20');
    expect(openingTag(await editor.code(PAGE), 'card-a')).not.toMatch(/end=["{]'?flex/);
  });

  test('CMP-098 a prop consumed only as an SVG fill="var(--x)" gets a colour editor', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, seedWithCard(SVG_ICON_CARD));
    await editor.click('card-a');
    const row = propRow(page, 'iconColor');
    await expect(row).toContainText('#FF2D75');
    // Not a raw text input showing the value.
    await expect(row.locator('input')).toHaveCount(0);
    await row.getByText('#FF2D75').click();
    await expect(page.locator('[data-tool-popup] .cursor-crosshair')).toBeVisible();
    await closePopup(page);
  });

  test('CMP-099 Styles → Margin on an instance writes the page tag, not the master', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
    const pageJsx = twoInstancePage().replace(`data-name="Card A" style={{ position: 'relative', flex: '0 0 auto' }}`, `data-name="Card A" style={{ position: 'relative', flex: '0 0 auto', marginTop: '24px' }}`);
    await loadC3(editor, seedWithCard(SVG_ICON_CARD, pageJsx));
    const before = await editor.code(PAGE);
    const master = await editor.code(CARD);
    await editor.click('card-a');
    const margin = panel(page).getByText('Margin', { exact: true }).first();
    await expect(margin).toBeVisible();
    // Only marginTop is set → the row splits into T / R / B / L; T reads 24.
    const tInput = panel(page).locator('div').filter({ has: page.getByText('T', { exact: true }) }).filter({ has: page.locator('input') }).last().locator('input').first();
    await expect(tInput).toHaveValue('24');
    await tInput.click();
    await tInput.press('ControlOrMeta+a');
    await tInput.fill('40');
    await tInput.press('Enter');
    await expect(editor).toHaveStyle('card-a', 'marginTop', '40px', { path: PAGE });
    expect(await editor.code(CARD)).toBe(master);
    await expect.poll(() => canvasStyle(editor, 'card-a', 'margin-top')).toBe('40px');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    await expect(editor).toHaveStyle('card-a', 'marginTop', '40px', { path: PAGE });
  });
});

test.describe('per-tile instance props', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-091 a prop set on the Tablet tile becomes a data-responsive override, base untouched', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: the canvas Mobile tile (375) inherits the Tablet (768) instance-prop override ("Tab"), but the runtime buckets are (prev, bp] and do not cascade — the preview/published page at 375 shows the base "Card title"');
    await loadC3(editor, seedWithCard(ALL_TYPES_CARD, twoInstancePage(), { tiles: TILES.three }), { fit: true });
    const before = await editor.code(PAGE);
    await clickStable(editor, 'card-a', 'tablet');
    await typeInRow(page, 'Title', 'Tab');

    await expect.poll(() => editor.attr('card-a', 'data-responsive', PAGE)).not.toBeNull();
    const resp = JSON.parse((await editor.attr('card-a', 'data-responsive', PAGE))!);
    expect(resp['768']).toEqual({ title: 'Tab' });
    expect([...resp._bp].sort((a: number, b: number) => a - b)).toEqual([375, 768, 1440]);
    // Not: the base attribute changed for every tile.
    expect(await editor.attr('card-a', 'title', PAGE)).toBeNull();

    await expect.poll(async () => (await (await editor.nodeIn('tablet', 'card-a:card-title')).textContent())).toBe('Tab');
    expect(await (await editor.nodeIn('desktop', 'card-a:card-title')).textContent()).toBe('Card title');
    // The label is accented and offers Reset Override.
    await expect(panel(page).getByText('Title', { exact: true }).first()).toHaveClass(/accent-text/);
    await panel(page).getByText('Title', { exact: true }).first().click();
    await expect(page.getByText('Reset Override', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // Preview: 768 shows the override; 375 and 1440 the base.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="card-a"]');
    const title = frame.locator('[data-id="card-a"] [data-id="card-title"]');
    await setPreviewWidth(page, frame, 768);
    await expect(title).toHaveText('Tab');
    await setPreviewWidth(page, frame, 375);
    await expect(title).toHaveText('Card title');
    await setPreviewWidth(page, frame, 1440);
    await expect(title).toHaveText('Card title');
    await page.keyboard.press('Escape');

    // The Mobile tile keeps the base, like the page it previews.
    expect(await (await editor.nodeIn('mobile', 'card-a:card-title')).textContent()).toBe('Card title');
  });

  test('CMP-092 Reset Override drops the entry (Title, then Variant) and clears the accent within a frame budget', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    const pageJsx = twoInstancePage(`data-responsive='{"768":{"title":"Tab","initialVariant":"variant-1"},"_bp":[1440,768,375]}'`);
    await loadC3(editor, seedWithCard(TITLE_VARIANT_CARD, pageJsx, { tiles: TILES.three }), { fit: true });
    await clickStable(editor, 'card-a', 'tablet');
    await expect(panel(page).getByText('Title', { exact: true }).first()).toHaveClass(/accent-text/);
    await expect(panel(page).getByText('Variant', { exact: true }).first()).toHaveClass(/accent-text/);

    // Title row: its entry goes, the Variant entry stays.
    const titleMs = await resetOverrideLatency(page, 'Title');
    expect(titleMs, 'the Reset Override item was found').toBeGreaterThanOrEqual(0);
    expect(titleMs, 'Title accent cleared with the click (not the 450ms mirror delay)').toBeLessThan(250);
    await expect.poll(async () => JSON.parse((await editor.attr('card-a', 'data-responsive', PAGE)) ?? '{}')['768']).toEqual({ initialVariant: 'variant-1' });
    await expect.poll(async () => (await (await editor.nodeIn('tablet', 'card-a:card-title')).textContent())).toBe('Card title');

    // Variant row: the last entry goes, and the now-empty attribute with it.
    const variantMs = await resetOverrideLatency(page, 'Variant');
    expect(variantMs).toBeGreaterThanOrEqual(0);
    expect(variantMs, 'Variant accent cleared with the click').toBeLessThan(250);
    await expect.poll(() => editor.attr('card-a', 'data-responsive', PAGE)).toBeNull();
    await expect.poll(() => canvasBgHex(editor, 'tablet-card-a:card-root')).toBe('#97cffc');
  });

  test('CMP-093 a style-driving prop set on Mobile paints per tile, ghost rows included', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    const seed = withFiles(seedWithCard(DIRECTION_CARD, DIRECTION_LIST_PAGE, { tiles: TILES.three, extraImports: [`import team from '@/cms/team.json';`] }), TEAM_CMS);
    await loadC3(editor, seed, { fit: true });
    const before = await editor.code(PAGE);
    await clickStable(editor, 'row-card', 'mobile');
    await propRow(page, 'Direction').locator('select').selectOption('column');

    await expect.poll(() => editor.attr('row-card', 'data-responsive', PAGE)).not.toBeNull();
    const resp = JSON.parse((await editor.attr('row-card', 'data-responsive', PAGE))!);
    expect(resp['375']).toEqual({ direction: 'column' });
    expect(await editor.attr('row-card', 'direction', PAGE)).toBeNull();

    const dir = async (nodeId: string) => (await editor.sandbox().locator(`[data-node-id="${nodeId}"]`).first().evaluate(el => getComputedStyle(el).flexDirection));
    // Mobile: the template row and every ghost row are columns.
    for (const id of ['mobile-row-card:card-root', 'mobile-row-card:card-root__1', 'mobile-row-card:card-root__2']) {
      await expect.poll(() => dir(id), id).toBe('column');
    }
    // Desktop and tablet keep the row.
    for (const id of ['row-card:card-root', 'row-card:card-root__1', 'row-card:card-root__2', 'tablet-row-card:card-root__2']) {
      expect(await dir(id), id).toBe('row');
    }
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });
});

test.describe('tag identity, sections, overlays, nested variables', () => {
  test('CMP-089 a prop on an instance whose tag name differs from the registry name lands after the real tag', { tag: ['@p1', '@cmp', '@dnd'] }, async ({ editor, page }) => {
    await loadC3(editor, ZAPOKA_SEED);
    await editor.click('corner-a');
    await typeInRow(page, 'Corner', 'bottom-right');
    await expect.poll(() => editor.attr('corner-a', 'corner', PAGE)).toBe('bottom-right');
    const code = await editor.code(PAGE);
    const tag = openingTag(code, 'corner-a');
    // The prop sits right after the real tag name; the tag's identity is intact.
    expect(tag).toMatch(/^<ZaPoKa\s+corner="bottom-right"/);
    expect(tag).toContain('data-id="corner-a"');
    // Not: `<ZaPoKa data- corner=… id=…>`, nor a minted auto id.
    expect(code).not.toMatch(/data-\s+corner=/);
    expect(code).not.toMatch(/auto_\d+/);
    await expect(editor).toHaveNoDuplicateIds({ path: PAGE });
    await expect.poll(() => canvasText(editor, 'corner-a')).toBe('bottom-right');

    // The drag still commits on that tag.
    const before = await editor.code(PAGE);
    await editor.dragNodeAsserted('corner-a', await editor.at('top', 0.5, 0.1));
    await expect(editor).toHaveStyle('corner-a', 'order', '0', { path: PAGE });
    await expect(editor).toHaveStyle('top', 'order', '1', { path: PAGE });
    const after = await editor.code(PAGE);
    expect(openingTag(after, 'corner-a')).toMatch(/^<ZaPoKa\s+corner="bottom-right"/);
    expect(after).not.toMatch(/auto_\d+/);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test('CMP-094 an overlay-border prop maps onto that instance root only', { tag: ['@p2', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await loadC3(editor, seedWithCard(OVERLAY_BORDER_CARD));
    const before = await editor.code(PAGE);
    await editor.click('card-a');
    await propRow(page, 'ring').getByText('2 · SOLID').click();
    const widthInput = page.locator('[data-tool-popup] div').filter({ has: page.getByText('Width', { exact: true }) }).filter({ has: page.locator('input') }).last().locator('input').last();
    await widthInput.click();
    await widthInput.press('ControlOrMeta+a');
    await widthInput.fill('6');
    await widthInput.press('Enter');
    await expect.poll(() => editor.attr('card-a', 'ring', PAGE)).toBe('6px solid #000000');
    await closePopup(page);
    expect(await editor.attr('card-b', 'ring', PAGE)).toBeNull();

    const after = async (id: string) => editor.sandbox().locator(`[data-node-id="${id}"]`).first()
      .evaluate(el => ({ v: getComputedStyle(el).getPropertyValue('--b1').trim(), w: getComputedStyle(el, '::after').borderTopWidth }));
    // A's expanded root carries A's value; the overlay rule paints it on A only.
    await expect.poll(async () => (await after('card-a:card-root')).v).toBe('6px solid #000000');
    await expect.poll(async () => (await after('card-a:card-root')).w).toBe('6px');
    expect(await after('card-b:card-root')).toEqual({ v: '2px solid #000000', w: '2px' });
    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // Preview matches.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="card-b"]');
    const pw = (id: string) => frame.locator(`[data-id="${id}"]`).first().evaluate(el => getComputedStyle(el, '::after').borderTopWidth);
    await expect.poll(() => pw('card-a')).toBe('6px');
    expect(await pw('card-b')).toBe('2px');
  });

  test('CMP-095 a Section prop lists the page anchors, or says there are none', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
    const homeJsx = `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', background: '#0d0d1a', padding: '40px' }}>
  <div data-id="hero" data-name="Hero" id="hero" style={{ position: 'relative', width: '100%', height: '120px', background: '#1a1a3a', flex: '0 0 auto' }}></div>
  <div data-id="plans" data-name="Plans" id="plans" style={{ position: 'relative', width: '100%', height: '120px', background: '#2a2a4a', flex: '0 0 auto' }}></div>
  <Card data-id="card-a" data-name="Card A" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`;
    const aboutFiles = project().pageSource(pageModuleC3(`
<div data-id="about-root" data-name="About" style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: '600px', position: 'relative', padding: '40px' }}>
  <Card data-id="card-x" data-name="Card X" style={{ position: 'relative', flex: '0 0 auto' }} />
</div>`, { imports: [`import Card from '@/components/Card';`] }), { route: 'about' }).build().files;
    await loadC3(editor, withFiles(seedWithCard(SECTION_CARD, homeJsx), aboutFiles));
    await editor.click('card-a');
    const select = propRow(page, 'Section').locator('select');
    const opts = await select.locator('option').allTextContents();
    expect(opts).toEqual(expect.arrayContaining(['#hero', '#plans']));
    expect(opts).not.toContain('No sections on the page');
    await select.selectOption({ label: '#plans' });
    await expect.poll(() => editor.attr('card-a', 'section', PAGE)).toBe('plans');

    // A page with no anchors.
    await editor.openFile('app/about/page.client.tsx');
    await editor.settled();
    await editor.click('card-x');
    await expect(propRow(page, 'Section').locator('select option').first()).toHaveText('No sections on the page');
    // card-x never set a section: only the empty-state entry (polled — the row's
    // optimistic hold of card-a's pick, keyed by prop name, lingers up to 1.2s).
    await expect.poll(() => propRow(page, 'Section').locator('select option').count()).toBe(1);
    expect(await editor.attr('card-x', 'section', 'app/about/page.client.tsx')).toBeNull();
  });

  test('CMP-096 a nested instance bound per variant to master variables paints and shows each tile\'s branch', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: on the Pricing master the variant-1 tile paints the default branch ($10) of `value={variant === \'variant-1\' ? priceYearly : priceMonthly}` on a nested DESIGN-component instance; the panel resolves the right variable per tile, the canvas does not');
    await loadC3(editor, PRICING_SEED);
    await editor.openFile('components/Pricing.tsx');
    await editor.settled();
    await editor.fitCamera();
    // The row shows the variable bound for the active tile, not a literal.
    await editor.click('pricing-price');
    await expect(propRow(page, 'Value')).toContainText('Price Monthly');
    await expect(propRow(page, 'Value').locator('input')).toHaveCount(0);
    await clickStable(editor, 'pricing-price', 'variant-1');
    await expect(propRow(page, 'Value')).toContainText('Price Yearly');
    await expect(propRow(page, 'Value').locator('input')).toHaveCount(0);
    // Each tile paints its own branch's variable default.
    expect(await (await editor.nodeIn('default', 'pricing-price:price-text')).textContent()).toBe('$10');
    await expect.poll(async () => (await (await editor.nodeIn('variant-1', 'pricing-price:price-text')).textContent())).toBe('$100');
  });
});

/** Open the Header master from its page instance (real "Edit Component"), fit its variant tiles. */
async function enterHeader(editor: import('../../helpers/editor').Editor, page: import('@playwright/test').Page): Promise<void> {
  await editor.click('header-a');
  await panel(page).getByText('Edit Component').click();
  await expect.poll(() => editor.activeFile()).toBe(HEADER);
  await editor.settled();
  await editor.fitCamera();
  await clickStable(editor, 'header-heading');
}

/** The nested Button tag inside the Header master. */
const btnTag = async (editor: import('../../helpers/editor').Editor) => openingTag(await editor.code(HEADER), 'header-btn');

test.describe('nested instances inside a master', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-079 a variantOf prop is a select of the child component\'s real variants', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await loadC3(editor, NAV_SEED);
    const before = await editor.code(PAGE);
    await editor.click('nav-a');
    const row = propRow(page, 'Button Variant');
    // A select (not a text input) of Button's own variants.
    await expect(row.locator('input')).toHaveCount(0);
    const select = row.locator('select');
    expect(await select.locator('option').allTextContents()).toEqual(['Primary', 'Ghost']);
    await select.selectOption({ label: 'Ghost' });
    await expect.poll(() => editor.attr('nav-a', 'btnVariant', PAGE)).toBe('variant-1');
    // The nested Button switches variant on the canvas…
    await expect.poll(() => canvasBgHex(editor, 'nav-a:nav-btn:btn-root')).toBe('#ffffff');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    // …and in preview.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="nav-a"]');
    await expect.poll(() => frame.locator('[data-id="nav-a"] [data-id="nav-btn"]').first()
      .evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  });

  test('CMP-082 Hoist Variable on a nested instance prop adds a master variable and a row on the page instance', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, NESTED_MASTERS);
    await enterHeader(editor, page);
    await editor.click('header-btn');
    await panel(page).getByText('Title', { exact: true }).first().click();
    await page.getByText('Hoist Variable', { exact: true }).click();

    // The nested tag now forwards a new Header variable…
    await expect.poll(async () => (await btnTag(editor))).toMatch(/title=\{\w+\}/);
    const v = (await btnTag(editor)).match(/title=\{(\w+)\}/)![1];
    const header = await editor.code(HEADER);
    // …declared in the signature with the resolved default and in @pageVariables.
    expect(header).toMatch(new RegExp(`\\b${v} = ['"]A['"]`));
    const pv = header.match(/@pageVariables\s*(\{[\s\S]*?\})\s*\*\//);
    expect(pv, 'an @pageVariables block').not.toBeNull();
    expect(JSON.parse(pv![1]).variables.map((x: { name: string }) => x.name)).toContain(v);
    // The rename modal opens on it.
    await expect(page.locator('[data-modal-root]').last()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => canvasText(editor, 'header-btn:btn-text')).toBe('A');

    // Back on the page, the Header instance lists the new row.
    await page.locator('button, a').filter({ hasText: /^Home$/ }).first().click();
    await expect.poll(() => editor.activeFile()).toBe(PAGE);
    await editor.settled();
    await editor.click('header-a');
    const label = (await editor.code(HEADER)).match(new RegExp(`"${v}":\\{[^}]*"label":"([^"]+)"`))?.[1] ?? v;
    await expect(propRow(page, label).locator('input')).toHaveValue('A');
  });

  test('CMP-083 hoisting the nested Variant on the variant-6 tile writes a per-variant branch; × leaves a literal; Reset Override drops it', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await loadC3(editor, NESTED_MASTERS);
    await enterHeader(editor, page);
    await clickStable(editor, 'header-btn', 'variant-6');
    // The variant-6 tile shows the Ghost button (a per-variant literal) before the hoist.
    await propRow(page, 'Variant').locator('select').selectOption({ label: 'Ghost' });
    await expect.poll(async () => (await btnTag(editor))).toMatch(/['"]variant-6['"] \? ['"]variant-1['"] : ['"]default['"]/);
    await panel(page).getByText('Variant', { exact: true }).first().click();
    await page.getByText('Hoist Variable', { exact: true }).click();
    await page.keyboard.press('Escape');

    // Only variant-6 is bound to the new variable (default = the tile's value); the other variants keep the literal base.
    await expect.poll(async () => (await btnTag(editor))).toMatch(/initialVariant=\{\s*(initialVariant|variant) === ['"]variant-6['"] \? [A-Za-z_]\w* : ['"]default['"]\s*\}/);
    const v = (await btnTag(editor)).match(/\? ([A-Za-z_]\w*) :/)![1];
    expect(await editor.code(HEADER)).toMatch(new RegExp(`\\b${v} = ['"]variant-1['"]`));

    // × on the pill: variant-6 keeps a LITERAL branch (not the variable).
    await panel(page).locator('[title="Remove variable binding"]').first().click();
    await expect.poll(async () => (await btnTag(editor))).not.toContain(`? ${v} :`);
    expect(await btnTag(editor)).toMatch(/initialVariant=\{[^}]*['"]variant-6['"] \? ['"]variant-1['"] : ['"]default['"]/);

    // Reset Override drops the variant-6 branch altogether.
    await panel(page).getByText('Variant', { exact: true }).first().click();
    await page.getByText('Reset Override', { exact: true }).click();
    await expect.poll(async () => (await btnTag(editor))).not.toContain('variant-6');
  });

  test('CMP-084 Set Variable binds a nested prop to an existing master variable; × writes its default back', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: a nested instance\'s TEXT prop row offers no "Set Variable" (the menu item is gated on a CSS mapping, ComponentPropsTool.tsx `componentInfo && selectedId && cssProp`), so `title` cannot be bound to the existing `heading` variable');
    await loadC3(editor, NESTED_MASTERS);
    await enterHeader(editor, page);
    await editor.click('header-btn');

    // A colour prop: Set Variable → Accent, then × injects Accent's default (not an empty value).
    await panel(page).getByRole('button', { name: /^fill\b/ }).first().click();
    await page.getByText('Set Variable', { exact: true }).first().hover();
    await page.getByText('Accent', { exact: true }).last().click();
    await expect.poll(async () => (await btnTag(editor))).toContain('fill={accent}');
    await expect(panel(page).locator('[title^="Variable: Accent"]')).toBeVisible();
    await panel(page).locator('[title="Remove variable binding"]').first().click();
    await expect.poll(async () => (await btnTag(editor))).toMatch(/fill="#00ff88"/i);

    // The text prop: Set Variable → Heading → `title={heading}`; × writes "Welcome" back.
    await panel(page).getByText('Title', { exact: true }).first().click();
    await page.getByText('Set Variable', { exact: true }).first().hover({ timeout: 5_000 });
    await page.getByText('Heading', { exact: true }).last().click();
    await expect.poll(async () => (await btnTag(editor))).toContain('title={heading}');
    await expect(panel(page).locator('[title^="Variable: Heading"]')).toBeVisible();
    await panel(page).locator('[title="Remove variable binding"]').first().click();
    await expect.poll(async () => (await btnTag(editor))).toContain('title="Welcome"');
  });

  test('CMP-085 a nested prop set on the variant-1 tile writes a per-variant ternary; Reset Override collapses it', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: the variant-1 tile keeps painting the base "A" for the builder-written `title={initialVariant === \'variant-1\' ? "B" : "A"}` on a nested design-component instance (same canvas gap as CMP-096)');
    await loadC3(editor, NESTED_MASTERS);
    await enterHeader(editor, page);
    const before = await editor.code(HEADER);
    await clickStable(editor, 'header-btn', 'variant-1');
    await typeInRow(page, 'Title', 'B');
    await expect.poll(async () => (await btnTag(editor))).toMatch(/title=\{\s*initialVariant === ['"]variant-1['"] \? ['"]B['"] : ['"]A['"]\s*\}/);
    expect(await (await editor.nodeIn('default', 'header-btn:btn-text')).textContent()).toBe('A');
    // The label shows the per-variant override accent.
    await expect(panel(page).getByText('Title', { exact: true }).first()).toHaveClass(/accent/);
    await expect(editor).toUndoInOneStep(before, { path: HEADER });

    await panel(page).getByText('Title', { exact: true }).first().click();
    await page.getByText('Reset Override', { exact: true }).click();
    await expect.poll(async () => (await btnTag(editor))).toMatch(/title="A"/);
    expect(await btnTag(editor)).not.toContain('variant-1');

    // Undo restores the branch, and the variant-1 tile paints it.
    await editor.undo();
    await expect.poll(async () => (await btnTag(editor))).toMatch(/\? ['"]B['"]/);
    await expect.poll(async () => (await (await editor.nodeIn('variant-1', 'header-btn:btn-text')).textContent())).toBe('B');
  });
});

test.describe('cursor variable, closed-source CDN instance', () => {
  test('CMP-078 cursor opts are per instance: Brand on 1, Motion on 2, the popup reseeds on selection switch', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, cursorSeed());
    await editor.click('card-a');
    await propRow(page, 'cursor').getByText('Pointer', { exact: true }).click();
    const popup = page.locator('[data-tool-popup]').filter({ hasText: 'Component Cursor' }).last();
    const variantSelect = popup.locator('select').filter({ has: page.locator('option', { hasText: 'Brand' }) });
    await variantSelect.selectOption({ label: 'Brand' });

    const opts = async (id: string) => {
      const v = await editor.attr(id, 'cursorOpts', PAGE);
      return v ? JSON.parse(v) : null;
    };
    await expect.poll(async () => (await opts('card-a'))?.variant).toBe('brand');
    // The master's call spreads the per-instance opts last.
    await expect.poll(() => editor.code(CARD)).toMatch(/withCursor\(cursor, \{[^}]*\.\.\.cursorOpts\s*\}\)/);

    // Switch selection with the popup open: it reseeds with instance 2's values.
    await editor.click('card-b');
    await expect(variantSelect).toHaveValue(/^(default|)$/);
    await variantSelect.selectOption({ label: 'Motion' });
    await expect.poll(async () => (await opts('card-b'))?.variant).toBe('motion');
    // Instance 1 keeps Brand.
    expect((await opts('card-a'))?.variant).toBe('brand');
    // Back on instance 1 the popup shows Brand again.
    await editor.click('card-a');
    await expect(variantSelect).toHaveValue('brand');
  });

  test('CMP-088 deleting the cursor variable strips `cursor` from every instance and never touches cursorOpts', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
    await loadC3(editor, cursorOptsSeed());
    const optsBefore = (await editor.attr('card-a', 'cursorOpts', PAGE))!;
    await editor.click('card-a');
    await panel(page).getByText('Edit Component').click();
    await expect.poll(() => editor.activeFile()).toBe(CARD);
    await editor.settled();
    await page.getByRole('button', { name: 'Variables' }).click();
    const modal = page.locator('[data-modal-root]').last();
    await modal.getByText('cursor', { exact: true }).click({ button: 'right' });
    await page.getByText(/^Remove/).first().click();
    await expect(modal.getByText('cursor', { exact: true })).toHaveCount(0);

    // Both instances lose `cursor`…
    await expect.poll(() => editor.attr('card-a', 'cursor', PAGE)).toBeNull();
    expect(await editor.attr('card-b', 'cursor', PAGE)).toBeNull();
    const code = await editor.code(PAGE);
    // …the page still parses (no stray `}}`), cursorOpts is untouched, and the
    // arrow function's `>` did not end the tag early.
    const { parse } = await import('@babel/parser');
    expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
    expect(await editor.attr('card-a', 'cursorOpts', PAGE)).toBe(optsBefore);
    expect(await editor.attr('card-a', 'onPick', PAGE)).toBe('() => 2 > 1');
    expect(code).not.toMatch(/\}\}\s*(data-id|key|style)=/);
    expect(code).not.toMatch(/<Card\}\}/);
    await expect(editor).toHaveNoDuplicateIds({ path: PAGE });
    expect(await editor.code(CARD)).not.toMatch(/withCursor\(cursor\b/);
  });

  test('CMP-100 a closed-source CDN instance is configured from the metadata interface', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
    test.fail(true, 'BUG: a CDN-linked instance lists no prop rows — visibleProps filters on isVariableAppliedInCode(name, masterCode), and masterCode reads projectFS (empty for a CDN URL; the interface has no bodies anyway), so every prop reads as unused (ComponentPropsTool.tsx:209 + the visibleProps filter)');
    // The CDN bundle itself is not served here; only the panel is under test.
    editor.allowErrors(/assets\.revyme\.app|Promo@|Failed to fetch|import|module|net::/i);
    let sourceRequests = 0;
    await page.route(/\/api\/components\/source\?/, async (route) => { sourceRequests++; await route.fulfill({ status: 403, body: 'closed source' }); });
    await page.route(/\/api\/components\/metadata\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ hash: CDN_HASH, name: 'Promo', creator: null, createdAt: '2026-09-01T00:00:00.000Z', closedSource: true, defaultWidth: 300, defaultHeight: 120, interfaceSource: CDN_INTERFACE }),
    }));
    await page.route(/assets\.revyme\.app\/components\//, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: 'export default function Promo() { return null; }' }));

    await loadC3(editor, CDN_SEED);
    const t0 = Date.now();
    await editor.click('promo-a');
    // Name and the variant picker come from the interface; picking writes the tag.
    await expect(panel(page).getByText('Promo', { exact: true }).first()).toBeVisible();
    const variant = propRow(page, 'Variant').locator('select');
    expect(await variant.locator('option').allTextContents()).toEqual(['Default', 'Bold']);
    await variant.selectOption({ label: 'Bold' });
    await expect.poll(() => editor.attr('promo-a', 'initialVariant', PAGE)).toBe('variant-1');
    // The 403 is terminal: at most one source request in 5s.
    await page.waitForTimeout(Math.max(0, 5_000 - (Date.now() - t0)));
    expect(sourceRequests).toBeLessThanOrEqual(1);
    // The prop rows come from the interface too, and edits write the tag.
    await expect(propRow(page, 'Headline').locator('input')).toHaveValue('Hello', { timeout: 5_000 });
    await typeInRow(page, 'Headline', 'Sale');
    await expect.poll(() => editor.attr('promo-a', 'headline', PAGE)).toBe('Sale');
  });
});

test.describe('component events and overlays', () => {
  test('CMP-080 an overlay opened by a component event: the instance forwards the event, the child opens it in preview', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await loadC3(editor, seedWithCard(EVENT_CARD));
    await editor.click('card-a');
    await panel(page).getByRole('button', { name: 'Add overlay' }).click();
    await page.getByText('Modal', { exact: true }).click();
    await expect.poll(async () => (await editor.selection())[0] ?? '').toMatch(/^overlay-/);
    const overlayId = (await editor.selection())[0];
    const showOn = panel(page).locator('div').filter({ has: page.getByText('Interaction', { exact: true }) }).locator('select').first();
    await expect(showOn.locator('option', { hasText: 'Child Trigger 1' })).toHaveCount(1);
    await showOn.selectOption({ label: 'Child Trigger 1' });

    // The instance passes a handler for its event that drives the overlay's open state.
    await expect.poll(() => editor.attr('card-a', 'childtrigger1', PAGE)).toMatch(/^\(\) => set\w+Open\(/);
    const handler = (await editor.attr('card-a', 'childtrigger1', PAGE))!;
    expect(handler).toMatch(/^\(\) => set(\w+)Open\((true|!\w+Open)\)$/);
    expect(await editor.attr('card-b', 'childtrigger1', PAGE)).toBeNull();

    // Preview: the child fires the event and the overlay opens; the other child does not.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="card-a"]');
    const overlay = frame.locator(`[data-id="${overlayId}"]`);
    await expect(overlay).toHaveCount(0);
    await frame.locator('[data-id="card-a"] [data-id="card-text"]').click();
    await expect(overlay).toHaveCount(0);
    await frame.locator('[data-id="card-a"] [data-id="card-cta"]').click();
    await expect(overlay).toBeVisible();
  });

  test('CMP-081 a LINK component inside a fixed overlay forwards the instance onClick before its managed link handler', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await loadC3(editor, LINK_IN_OVERLAY);
    // The builder writes the master's managed link handler (Smooth Scroll on a variable href).
    await editor.openFile('components/NavLink.tsx');
    await editor.settled();
    await clickStable(editor, 'navlink-root');
    const smooth = panel(page).locator('div.justify-between').filter({ has: page.getByText('Smooth Scroll', { exact: true }) }).first();
    await smooth.getByText('Yes', { exact: true }).click();
    await expect.poll(() => editor.code('components/NavLink.tsx')).toMatch(/onClick=\{\(e\) => \{/);
    const root = openingTag(await editor.code('components/NavLink.tsx'), 'navlink-root');
    // The forwarded click runs FIRST inside the managed handler.
    expect(root).toMatch(/onClick=\{\(e\) => \{\s*\(rest\.onClick\)\?\.\(e\);/);

    // Preview: open the overlay, click the link text — the overlay closes.
    await editor.openFile(PAGE);
    await editor.settled();
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreview(page, '[data-id="menu-btn"]');
    await frame.locator('[data-id="menu-btn"]').click();
    const overlay = frame.locator('[data-id="overlay-menu-btn-1"]');
    await expect(overlay).toBeVisible();
    await frame.locator('[data-id="nav-link"] [data-id="navlink-text"]').click();
    await expect(overlay).toHaveCount(0);
  });
});
