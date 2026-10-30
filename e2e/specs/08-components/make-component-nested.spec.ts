// CMP · Make Component INSIDE a master (E2E_TEST_PLAN.md §8, CMP-020, 021,
// 023, 024): connections, variant refs, parent variables and event props the
// subtree used are re-homed so both masters compile and keep working.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  HEADER_PAGE, CTA_PAGE, PANEL_PAGE, makeComponentViaMenu, exitToPage, breadcrumb, breadcrumbSegment,
  allowMasterEntryNoise, allowPreviewNoise, parses, elementFacts, openPreview, waitForActiveFile, attrExpr, stableCode,
} from '../../helpers/c1';

const HEADER = 'components/Header.tsx';

test.beforeEach(async ({ editor }) => {
  test.slow();
  allowMasterEntryNoise(editor);
  allowPreviewNoise(editor);
});

/** Setup: open a master (its tiles become the variants) and fit the camera. */
async function enterMaster(editor: Editor, path: string) {
  await editor.openFile(path);
  await waitForActiveFile(editor, path);
  await editor.fitCamera();
  await editor.settled();
}

/** Setup: wire the hamburger to toggle Closed ⇄ Open through the product's own
 *  connection writer (the Interactions panel's path). */
async function wireHamburger(editor: Editor, both = true) {
  const page = editor.page();
  await editor.select(['hamburger'], 'desktop');
  await page.evaluate(() => (window as any).__e2e.addConnection('default', 'variant-1', 'click'));
  await editor.settled();
  if (both) {
    await page.evaluate(() => (window as any).__e2e.addConnection('variant-1', 'default', 'click'));
    await editor.settled();
  }
  await editor.select([]);
  await expect.poll(async () => /\bsetVariant\(/.test(await editor.code(HEADER))).toBe(true);
}

/** Identifiers named exactly `variant` / `setVariant` in code (strings excluded). */
function variantStateRefs(code: string): string[] {
  const stripped = code.replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
  return stripped.match(/(?<![\w$.])(?:variant|setVariant)(?![\w$])/g) ?? [];
}

test('CMP-020 a connection-wired hamburger: the handler and key move to the new instance in the Header', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the connection writer emits a BLOCK-bodied toggle (`onTap={() => { const _n = …; if (_n) setVariant(_n); }}`) that Make Component\'s brace-free handler regex never matches — the handler stays in the new master (undefined setVariant, WOULD_CRASH) and the instance never fires');
  await editor.load(HEADER_PAGE);
  await enterMaster(editor, HEADER);
  await wireHamburger(editor);
  const headerBefore = await stableCode(editor, HEADER);
  // The handler exactly as the connection writer wrote it on the hamburger.
  const handler = attrExpr((await elementFacts(headerBefore, 'hamburger'))!.source, 'onTap');
  expect(handler).toContain('setVariant(');

  const made = await makeComponentViaMenu(editor, 'hamburger', 'Menu Button', { at: [0.1, 0.1] });
  const header = await editor.code(HEADER);
  const master = await editor.code(made.file);

  // The connection and the key now ride the instance tag in the Header…
  const inst = await elementFacts(header, 'hamburger');
  expect(inst?.tag).toBe(made.tag);
  expect(inst?.source).toContain(handler!);
  expect(inst?.source).toContain('key="hamburger"');
  // …and the new master is clean: no parent variant state, no leftover key.
  expect(variantStateRefs(master)).toEqual([]);
  expect(master).not.toContain('key="hamburger"');
  expect(await parses(header)).toBe(true);
  expect(await parses(master)).toBe(true);
  expect(await breadcrumb(page)).toEqual(['Home', 'Header', 'Menu Button']);
  await expect(editor).toUndoInOneStep(headerBefore, { path: HEADER });

  // Not: connection kept visually but never fires — the hamburger still opens the Header live.
  await exitToPage(editor);
  const frame = await openPreview(page, 'Bare label');
  const root = frame.locator('[data-mroot="hdr-root"]').first();
  await expect.poll(() => root.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(17, 17, 51)');
  await frame.locator('[data-id="hamburger"]').first().click();
  await expect.poll(() => root.evaluate(el => getComputedStyle(el).backgroundColor), { timeout: 10_000 }).toBe('rgb(170, 34, 68)');
});

test('CMP-021 children of a variant-driven master are rebound to initialVariant in the new master', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(HEADER_PAGE);
  await enterMaster(editor, HEADER);
  await wireHamburger(editor, false);
  const headerBefore = await stableCode(editor, HEADER);
  // The Header now drives its children from its `variant` state.
  expect((await elementFacts(headerBefore, 'logo-dot'))?.source).toContain("animate={['default', variant]}");
  expect((await editor.style('logo', HEADER)).width).toMatch(/^variant === 'variant-1'/);

  const made = await makeComponentViaMenu(editor, 'logo', 'Logo', { at: [0.9, 0.5] });
  const master = await editor.code(made.file);
  expect((await elementFacts(master, 'logo-dot'))?.source).toContain("animate={['default', initialVariant]}");
  expect((await editor.style('logo', made.file)).width).toMatch(/^initialVariant === 'variant-1'/);
  // No undefined `variant` left behind.
  expect(variantStateRefs(master)).toEqual([]);
  expect(await parses(master)).toBe(true);
  expect(await parses(await editor.code(HEADER))).toBe(true);
  await expect(editor).toUndoInOneStep(headerBefore, { path: HEADER });

  // Both files keep editing: delete a node in each with the real key.
  if ((await editor.activeFile()) !== made.file) {
    await editor.openFile(made.file);
    await waitForActiveFile(editor, made.file);
  }
  await editor.select(['logo-dot'], 'desktop');
  const masterNow = await editor.code(made.file);
  await editor.blur();
  await page.keyboard.press('Delete');
  await expect.poll(() => editor.code(made.file)).not.toBe(masterNow);
  expect(await parses(await editor.code(made.file))).toBe(true);
  await breadcrumbSegment(page, 'Header').click();
  await waitForActiveFile(editor, HEADER);
  await editor.select(['ham-line'], 'desktop');
  const headerNow = await editor.code(HEADER);
  await editor.blur();
  await page.keyboard.press('Delete');
  await expect.poll(() => editor.code(HEADER)).not.toBe(headerNow);
  expect(await parses(await editor.code(HEADER))).toBe(true);
});

test('CMP-023 parent variables used by the subtree become props of the new master and pass through', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(PANEL_PAGE);
  await enterMaster(editor, 'components/Panel.tsx');
  const panelBefore = await stableCode(editor, 'components/Panel.tsx');

  const made = await makeComponentViaMenu(editor, 'panel-card', 'Panel Card', { at: [0.9, 0.5] });
  const master = await editor.code(made.file);
  // Params with the parent's defaults, before ...rest…
  expect(master).toMatch(/initialVariant = 'default', shadow5 = "0px 8px 24px rgba\(0,0,0,0\.5\)", tilt = 0, \.\.\.rest/);
  // …@propMeta labels/types carried…
  expect(master).toMatch(/"shadow5":\{"type":"shadow","label":"Card Shadow"\}/);
  expect(master).toMatch(/"tilt":\{"type":"number","label":"Tilt"\}/);
  // …the __mq gate and its hook.
  expect(master).toContain("const __mq2 = useMediaQuery('(max-width: 375px)');");
  expect(master).toMatch(/function useMediaQuery\(query: string\)/);
  // Vars the subtree never used are not transferred.
  expect(master).not.toMatch(/\bheading\b/);
  expect(master).not.toMatch(/\btilt1\b/);
  expect(await parses(master)).toBe(true);

  // The instance passes the parent's variables through.
  const inst = (await elementFacts(await editor.code('components/Panel.tsx'), 'panel-card'))!;
  expect(inst.tag).toBe(made.tag);
  for (const v of ['shadow5', 'tilt']) expect(inst.source).toContain(`${v}={${v}}`);
  await expect(editor).toUndoInOneStep(panelBefore, { path: 'components/Panel.tsx' });

  // The instance row shows the hoisted variable.
  await breadcrumbSegment(page, 'Panel').click().catch(() => {});
  if ((await editor.activeFile()) !== 'components/Panel.tsx') await editor.openFile('components/Panel.tsx');
  await waitForActiveFile(editor, 'components/Panel.tsx');
  await editor.click('panel-card', {});
  expect(await editor.selection()).toEqual(['panel-card']);
  await expect(page.locator('[data-tutorial="right-toolbar"]').first().getByText('Card Shadow').first()).toBeVisible();
});

test('CMP-024 a child firing the master\'s event becomes a trigger-named event prop, wired to the parent event', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(CTA_PAGE);
  await enterMaster(editor, 'components/Cta.tsx');
  const ctaBefore = await stableCode(editor, 'components/Cta.tsx');

  const made = await makeComponentViaMenu(editor, 'find-btn', 'Find Button', { at: [0.05, 0.5] });
  const master = await editor.code(made.file);
  expect(master).toMatch(/function \w+\(\{ style, initialVariant = 'default', click, \.\.\.rest \}/);
  expect(master).toMatch(/"click":\{"type":"event","label":"Click"\}/);
  expect((await elementFacts(master, 'find-btn'))?.source).toContain('onClick={click}');
  expect(master).not.toContain('event1');
  // Props the subtree never referenced stay behind.
  expect(master).not.toMatch(/\bcontent\b/);
  expect(await parses(master)).toBe(true);
  const inst = (await elementFacts(await editor.code('components/Cta.tsx'), 'find-btn'))!;
  expect(inst.tag).toBe(made.tag);
  expect(inst.source).toContain('click={event1}');
  await expect(editor).toUndoInOneStep(ctaBefore, { path: 'components/Cta.tsx' });

  // The interaction still fires on the live page.
  if ((await editor.activeFile()) !== 'app/page.client.tsx') await exitToPage(editor);
  const frame = await openPreview(page, 'Fired 0');
  await frame.locator('[data-id="find-text"]').first().click();
  await expect(frame.getByText('Fired 1', { exact: true })).toBeVisible();
});
