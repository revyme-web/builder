// CMP · Code safety and the oracle for masters (E2E_TEST_PLAN.md §8, CMP-242…CMP-245).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  PAGE, CARD, WISP, wispSeed, noIvSeed, enterFile, clickNodeId, stableCode, pollCode, traces, canvasNode, sourceFiles, quickBox, computed,
} from '../../helpers/c8';
import { parsesStrict, panel, c6Seed, homePage } from '../../helpers/c6';
import { cardJsx, makeComponentViaMenu, exitToPage } from '../../helpers/c1';
import { addVariantCard, hpStrip, clickCard, variantConfigOf, connectionsOf, cardProject, plainCard, openMaster } from '../../helpers/c4';
import { clickStable, variantEntry, row, label, parsesClean, attrSource } from '../../helpers/c5';
import { propRow } from '../../helpers/c3';
import { openTransition, addState } from '../../helpers/c4';

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: TILES_VIEWPORT });

/** Select a variant tile's root with a real click in its bottom padding. */
async function selectRoot(editor: Editor, vpId: string, rootId: string): Promise<void> {
  await editor.page().waitForTimeout(450);
  await clickStable(editor, rootId, vpId, 0.5, 0.95);
  await expect.poll(() => editor.selection()).toEqual([rootId]);
}

test('CMP-242 a variant write that would leave the master unparseable is refused; the last good code and every render survive', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  // The refusal is logged through trace.error (console.error) by design.
  editor.allowErrors(/addVariant-parse-revert|Failed to parse JSX/);
  await editor.load(wispSeed());
  await enterFile(editor, WISP, 'wisp-root');
  const before = await stableCode(editor, WISP);
  expect(parsesStrict(before), 'the seed itself parses').toBe(true);
  const files = await sourceFiles(editor);

  // + Variant on the Mobile (variant-1) root clones its entry; the lazy
  // variants-object matcher ends at the `};` inside `'a};b'`, so the insert
  // would land inside that string.
  await selectRoot(editor, 'variant-1', 'wisp-root');
  await clickCard(editor, addVariantCard(editor.page()));
  await expect.poll(async () => (await traces(editor, 'parse-revert')).length, { message: 'the parse net fired' }).toBeGreaterThan(0);
  await editor.settled();

  // The write was refused: the master is byte-identical and parses.
  expect(await editor.code(WISP)).toBe(before);
  expect(variantConfigOf(await editor.code(WISP)).map(v => v.name)).toEqual(['default', 'variant-1']);
  expect(await sourceFiles(editor)).toEqual(files);
  // The canvas never blanks: both tiles still paint the root.
  await expect(canvasNode(editor, 'wisp-root')).toBeVisible();
  await expect(await editor.nodeIn('variant-1', 'wisp-root')).toBeAttached();
  expect(await editor.sandbox().locator('[data-node-id^="variant-2"]').count()).toBe(0);

  // Pages importing the master still render it.
  await exitToPage(editor);
  await expect(canvasNode(editor, 'wisp-a:wisp-label')).toHaveText('Wisp');
  expect((await quickBox(canvasNode(editor, 'wisp-a')))?.height ?? 0).toBeGreaterThan(10);
});

test('CMP-243 Make Component + variants + an instance prop survive a reload byte for byte', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(c6Seed({ '/': homePage(`      ${cardJsx()}`) }));
  const made = await makeComponentViaMenu(editor, 'card', 'Plan', { at: [0.5, 0.03] });
  await expect.poll(() => editor.activeFile()).toBe(made.file);
  await editor.settled();
  await editor.fitCamera();
  // Add a Hover state and a variant on the new master.
  const rootId = (await editor.code(made.file)).match(/data-id="([^"]+)"[^>]*\{\.\.\.rest\}/)?.[1] ?? 'card';
  await selectRoot(editor, 'desktop', rootId);
  await addState(editor, 'Hover');
  await pollCode(editor, made.file, c => connectionsOf(c).length > 0);
  await editor.settled();
  await selectRoot(editor, 'desktop', rootId);
  await clickCard(editor, addVariantCard(page));
  const master = await pollCode(editor, made.file, c => variantConfigOf(c).some(v => /^variant-\d+$/.test(v.name)));
  const newV = variantConfigOf(master).find(v => /^variant-\d+$/.test(v.name))!.name;
  expect(variantConfigOf(master).map(v => v.name).sort()).toEqual(['default', 'default-hover', newV].sort());
  expect(parsesClean(master)).toBe(true);

  // An instance prop on the page: the Variant pick.
  await exitToPage(editor);
  await editor.fitCamera();
  await clickNodeId(editor, 'card', [0.5, 0.03]);
  await expect.poll(() => editor.selection()).toEqual(['card']);
  await propRow(page, 'Variant').locator('select').selectOption({ value: newV });
  await pollCode(editor, PAGE, c => c.includes(`initialVariant="${newV}"`));
  await editor.settled();

  const files = await sourceFiles(editor);
  const paint = {
    root: await computed(editor, `card:${rootId}`, 'background-color'),
    title: await computed(editor, 'card:card-title', 'font-size'),
  };
  // Wait for the LOCAL save to hold exactly these files, then reload.
  await expect.poll(() => page.evaluate((want) => {
    const raw = localStorage.getItem('revyme-project-local');
    if (!raw) return false;
    const saved = JSON.parse(raw).files ?? {};
    return Object.entries(want).every(([k, v]) => saved[k] === v);
  }, files), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();

  expect(await sourceFiles(editor)).toEqual(files);
  await expect.poll(() => computed(editor, `card:${rootId}`, 'background-color')).toBe(paint.root);
  expect(await computed(editor, 'card:card-title', 'font-size')).toBe(paint.title);
  // The master's tiles come back too.
  await enterFile(editor, made.file, rootId);
  await expect(await editor.nodeIn(newV, rootId)).toBeAttached();
  await expect(await editor.nodeIn('default-hover', rootId)).toBeAttached();
  expect(variantConfigOf(await editor.code(made.file))).toEqual(variantConfigOf(files[made.file]));
  expect(connectionsOf(await editor.code(made.file))).toEqual(connectionsOf(files[made.file]));
});

test('CMP-244 the builder\'s own master edits pass its oracle (variant transition, variant border overlay, display toggle prop, perf pair)', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  await editor.load(cardProject(plainCard()));
  await openMaster(editor);

  // 1. Perf pair: a heavy prop (padding) on the variant-1 root.
  await selectRoot(editor, 'variant-1', 'card-root');
  const pad = row(page, 'Padding').locator('input').first();
  await pad.click();
  await pad.fill('40');
  await pad.press('Enter');
  let code = await pollCode(editor, CARD, c => /contain:\s*'layout/.test(c));
  expect(code).toMatch(/contain:\s*'layout(?: paint)?',\s*willChange:\s*'transform'/);

  // 2. Per-variant transition on a child (variant-1).
  await editor.page().waitForTimeout(450);
  await clickStable(editor, 'card-box', 'variant-1');
  await expect.poll(() => editor.selection()).toEqual(['card-box']);
  const pop = await openTransition(page);
  await pop.locator('select').first().selectOption('anticipate');
  await editor.settled();
  await page.keyboard.press('Escape');
  code = await pollCode(editor, CARD, c => /anticipate/.test(c));
  expect(variantEntry(code, 'card-box', 'variant-1')?.transition).toMatch(/anticipate/);

  // 3. Per-variant border overlay on the same child.
  await row(page, 'Border').getByText('Add', { exact: true }).click();
  await editor.settled();
  await page.keyboard.press('Escape');
  code = await pollCode(editor, CARD, c => /::after/.test(c) && /card-box/.test(c.slice(c.indexOf('::after') - 200)));
  expect(code).toMatch(/\[data-id="card-box"\][^{]*::after|\[data-variant="variant-1"\] \[data-id="card-box"\]::after/);

  // 4. A display toggle prop: Hide → Create Variable on the title (primary).
  await editor.page().waitForTimeout(450);
  await clickStable(editor, 'card-title', 'desktop');
  await expect.poll(() => editor.selection()).toEqual(['card-title']);
  await label(page, 'Hide').click();
  await page.getByText('Create Variable', { exact: true }).first().click();
  await editor.settled();
  await page.keyboard.press('Escape');
  code = await pollCode(editor, CARD, c => /display:\s*\w+\s*\?/.test(c));
  // Hide → Create Variable binds a toggle prop: `display: hide ? "none" : ""`.
  expect(code).toMatch(/"hide":\{"type":"toggle"/);
  expect(code).toMatch(/display:\s*hide\s*\?\s*["']none["']\s*:\s*["'][\w-]*["']/);
  expect(parsesClean(code)).toBe(true);
  expect(code).toMatch(/\[data-id="card-box"\]::after/);

  // The three shapes the oracle was taught to accept: a variant-entry
  // transition, the per-variant overlay rule, a boolean-prop display ternary.
  const violations = (await editor.oracle(CARD)).filter(v => v.tier >= 2);
  for (const c of ['DEFAULT_VALUE_NOT_IN_BASE', 'RAW_STYLE_TAG', 'DISPLAY_TOGGLE_VISIBILITY', 'UNRESOLVABLE_TERNARY']) {
    expect(violations.filter(v => v.code === c).map(v => v.elementId), c).toEqual([]);
  }

  // The oracle accepts every one of those writes.
  test.fail(!process.env.C8_NOFAIL, "BUG: the builder's own per-variant border overlay on a master child fails its oracle — the var-backed overlay writes inline '--rvb-bw/bs/bc' and STYLE_PROP_NO_CONTROL (tier 2) flags every `--` key (same cause C5 pinned for the root in CMP-144); and with a variant transition present the Border write splices the vars INSIDE the entry's nested `transition: { ease, '--rvb-bw': … }` object, so live never applies them");
  expect(violations.map(v => `${v.code}@${v.elementId ?? ''}`)).toEqual([]);
  // The variant-1 border vars live in the entry itself, not in its transition.
  const v1 = variantEntry(code, 'card-box', 'variant-1')!;
  expect(v1['--rvb-bw']).toBe('1px');
  expect(v1.transition).not.toMatch(/--rvb/);
});

test('CMP-245 adding a Hover to a master without the initialVariant param declares it and writes valid wiring', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
  // The parse gate logs its refusal through trace.error (console.error).
  editor.allowErrors(/parse-gate-revert|Failed to parse JSX/);
  await editor.load(noIvSeed());
  await enterFile(editor, CARD, 'card-root');
  const before = await stableCode(editor, CARD);
  expect(before).not.toMatch(/initialVariant/);
  await selectRoot(editor, 'desktop', 'card-root');
  await addState(editor, 'Hover');

  const code = await pollCode(editor, CARD, c => connectionsOf(c).length > 0 && /default-hover/.test(c));
  expect(variantConfigOf(code).map(v => v.name)).toEqual(['default', 'default-hover']);
  test.fail(!process.env.C8_NOFAIL, 'BUG: on a master without the `initialVariant` param, Hover adds the tile and its variants entry but no wiring — the connection codegen output does not parse, the modify-file parse gate reverts both addConnection writes (trace modify-file:parse-gate-revert ×2), and ensureInitialVariantParam never runs; the same master WITH the param gets connections + handlers');
  expect(connectionsOf(code).length, 'connections written').toBeGreaterThan(0);
  // The wiring references initialVariant → it is declared in the signature.
  expect(code).toMatch(/\binitialVariant\b/);
  expect(code).toMatch(/function Card\(\{[^)]*\binitialVariant = ['"]default['"]/);
  // Connections + handlers on the root.
  expect(connectionsOf(code).length).toBeGreaterThan(0);
  expect(attrSource(code, 'card-root', 'onHoverStart') ?? attrSource(code, 'card-root', 'onMouseEnter')).not.toBeNull();
  expect(parsesClean(code)).toBe(true);
  expect((await editor.oracle(CARD)).filter(v => v.tier >= 2).map(v => v.code)).toEqual([]);
  // The hover tile renders.
  await expect(await editor.nodeIn('default-hover', 'card-root')).toBeAttached();
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});
