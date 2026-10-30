// CMP · Make Component on a 3-tile page (E2E_TEST_PLAN.md §8, CMP-006, 010,
// 016, 017): one variant per tile, the per-tile overrides routed into the
// master (layout → ternary, paint/transform → variants object) or kept on the
// page (the instance's placement), and the action offered on primaries only.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  MAKE_COMPONENT_3VP, MAKE_COMPONENT_3VP_PLACEMENT, makeComponentViaMenu, rightClickNode,
  menuStructure, closeMenu, nameModal, pressMakeComponentShortcut, traces, allowMasterEntryNoise,
  elementFacts, exitToPage, parses, newComponentFiles,
} from '../../helpers/c1';

test.use({ viewport: TILES_VIEWPORT });

const PAGE = 'app/page.client.tsx';
const CARD_CORNER: [number, number] = [0.03, 0.03];
const TILES = ['desktop', 'tablet', 'mobile'] as const;

test.beforeEach(async ({ editor }) => {
  // A loaded machine: every row boots the editor and enters a master at least once.
  test.slow();
  allowMasterEntryNoise(editor);
});

/** On the page, whichever way history left the editor (a breadcrumb click when still in the master). */
async function ensureOnPage(editor: import('../../helpers/editor').Editor) {
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
  await editor.settled();
}

async function cardBoxes(editor: import('../../helpers/editor').Editor) {
  const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const vp of TILES) out[vp] = await editor.nodeBoxIn(vp, 'card');
  return out;
}

function expectSameBoxes(a: Record<string, { x: number; y: number; width: number; height: number }>, b: typeof a) {
  for (const vp of TILES) {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(a[vp][k] - b[vp][k]), `${vp}.${k}: ${a[vp][k]} vs ${b[vp][k]}`).toBeLessThanOrEqual(1);
    }
  }
}

/** Values of a `const <name> = { … }` variants object, as source per key. */
function variantsEntry(code: string, constName: string, variant: string): string | null {
  const block = new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\};`).exec(code)?.[1];
  if (!block) return null;
  const key = variant === 'default' ? 'default' : `'${variant}'`;
  return new RegExp(`(?:^|\\n)\\s*${key.replace(/[-']/g, m => `\\${m}`)}:\\s*\\{([^}]*)\\}`).exec(block)?.[1]?.trim() ?? null;
}

test('CMP-006 a direct child of a 3-tile page becomes a 3-variant master wired by data-responsive', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the root height ternary gets an EMPTY default branch (`height: … ? \'min-content\' : \'\'`) when the source had no height key — the oracle rejects it (COMPONENT_ROOT_PERCENT_SIZE); the mobile-only rotate also lands with no variant-1 entry (VARIANT_OBJECT_MISSING_ENTRY)');
  await editor.load(MAKE_COMPONENT_3VP, { fit: true });
  const before = await editor.code(PAGE);
  const boxesBefore = await cardBoxes(editor);

  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER, vpId: 'desktop' });
  const master = await editor.code(made.file);
  expect(await parses(master)).toBe(true);

  // Three variants, one per tile, and three master tiles.
  expect(master).toMatch(/\{ name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true \}/);
  expect(master).toMatch(/\{ name: 'variant-1', label: 'Tablet',/);
  expect(master).toMatch(/\{ name: 'variant-2', label: 'Mobile',/);
  await expect.poll(() => editor.sandbox().locator('[data-viewport]').evaluateAll(els => els.map(e => e.getAttribute('data-viewport'))))
    .toEqual(['desktop', 'variant-1', 'variant-2']);

  // The instance maps each breakpoint to its variant.
  const responsive = JSON.parse((await editor.attr('card', 'data-responsive', PAGE)) ?? '{}');
  expect(responsive).toEqual({ 768: { initialVariant: 'variant-1' }, 375: { initialVariant: 'variant-2' }, _bp: [1440, 768, 375] });

  // Layout override (tablet gap) → inline ternary; paint (tablet padding) and
  // transform (mobile title rotate) → the variants objects.
  const root = await editor.style('card', made.file);
  expect(root.gap).toBe("initialVariant === 'variant-1' ? '4px' : '12px'");
  expect(variantsEntry(master, 'cardVariants', 'variant-1')).toMatch(/padding: '12px'/);
  expect(variantsEntry(master, 'cardTitleVariants', 'variant-2')).toMatch(/rotate: 6/);
  expect((await elementFacts(master, 'card-title'))?.source).toContain('variants={cardTitleVariants}');
  // The migrated rules left the page.
  await expect(editor).toHaveBandStyle(768, 'card', 'padding', null, { path: PAGE });
  await expect(editor).toHaveBandStyle(375, 'card-title', 'transform', null, { path: PAGE });

  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Each page tile looks exactly as before (same fit, same boxes).
  await ensureOnPage(editor);
  await editor.fitCamera();
  await expect.poll(async () => { try { expectSameBoxes(boxesBefore, await cardBoxes(editor)); return true; } catch { return false; } }).toBe(true);
  await expect(await editor.nodeIn('mobile', 'card:card-title')).toHaveText('Pro plan');

  // Root sizes are px or auto on every tile: width px, height content-driven.
  expect(root.width).toBe('320px');
  const heights = (root.height ?? '').split(/\s*[?:]\s*/).filter(v => /^'.*'$/.test(v)).map(v => v.slice(1, -1));
  for (const h of heights.length ? heights : [root.height ?? '']) expect(h).toMatch(/^(?:\d+(?:\.\d+)?px|auto|min-content)$/);
});

test('CMP-010 Make Component is hidden on a replica tile and a non-default variant tile; the shortcut skips them', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor, page }) => {
  // The 3-tile page whose card has an authored height (CMP-006's empty-height bug stays out of this row).
  await editor.load(MAKE_COMPONENT_3VP_PLACEMENT, { fit: true });
  const before = await editor.code(PAGE);
  const filesBefore = await editor.listFiles();
  const skipped = async () => (await traces(page, 'make-component-skipped-non-primary')).length;

  // Tablet tile: the item is gone (not greyed) and no separator leads the menu.
  await rightClickNode(editor, 'card', { vpId: 'tablet', at: CARD_CORNER });
  let rows = await menuStructure(page);
  expect(rows).not.toContain('Make Component');
  expect(rows[0]).toBe('Cut');
  await closeMenu(page);
  const n0 = await skipped();
  await pressMakeComponentShortcut(page);
  await expect.poll(skipped).toBe(n0 + 1);
  await expect(nameModal(page).heading).toBeHidden();
  expect(await newComponentFiles(editor, filesBefore)).toEqual([]);
  expect(await editor.code(PAGE)).toBe(before);

  // The same node on Desktop still offers it.
  await rightClickNode(editor, 'card', { vpId: 'desktop', at: CARD_CORNER });
  rows = await menuStructure(page);
  expect(rows[0]).toBe('Make Component');
  expect(rows[1]).toBe('—');
  await closeMenu(page);

  // Inside a master: a child on the variant-1 tile — hidden; on default — offered.
  await page.waitForTimeout(450);
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER, vpId: 'desktop' });
  await editor.fitCamera();
  await rightClickNode(editor, 'card-img', { vpId: 'variant-1' });
  expect(await editor.selection()).toEqual(['card-img']);
  rows = await menuStructure(page);
  expect(rows).not.toContain('Make Component');
  expect(rows[0]).not.toBe('—');
  await closeMenu(page);
  const n1 = await skipped();
  const masterFiles = await editor.listFiles();
  await pressMakeComponentShortcut(page);
  await expect.poll(skipped).toBe(n1 + 1);
  await expect(nameModal(page).heading).toBeHidden();
  expect(await newComponentFiles(editor, masterFiles)).toEqual([]);

  await page.waitForTimeout(450);
  await rightClickNode(editor, 'card-img', { vpId: 'desktop' });
  expect(await menuStructure(page)).toContain('Make Component');
  await closeMenu(page);
  void made;
});

test('CMP-016 a mobile-only order stays on the page for the instance; tablet padding moves into the master', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_3VP_PLACEMENT, { fit: true });
  const before = await editor.code(PAGE);
  await expect(editor).toHaveBandStyle(375, 'card', 'order', '10', { path: PAGE });

  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER, vpId: 'desktop' });
  const master = await editor.code(made.file);

  // Placement stays with the instance on the page…
  await expect(editor).toHaveBandStyle(375, 'card', 'order', '10', { path: PAGE, important: true });
  // …paint moves into the master's tablet variant and leaves the page.
  expect(variantsEntry(master, 'cardVariants', 'variant-1')).toMatch(/padding: '12px'/);
  await expect(editor).toHaveBandStyle(768, 'card', 'padding', null, { path: PAGE });
  // Not: the order migrated into the master (layout-inert on the inner root).
  expect(variantsEntry(master, 'cardVariants', 'variant-2') ?? '').not.toMatch(/order/);
  expect(master).not.toMatch(/order: initialVariant/);

  await expect(editor).toUndoInOneStep(before, { path: PAGE });

  // Mobile: the instance still paints below every other section; Desktop: first.
  await ensureOnPage(editor);
  await editor.fitCamera();
  const mob = await editor.nodeBoxIn('mobile', 'card');
  for (const id of ['cta-row', 'grid', 'row', 'label']) expect(mob.y).toBeGreaterThan((await editor.nodeBoxIn('mobile', id)).y);
  const desk = await editor.nodeBoxIn('desktop', 'card');
  expect(desk.y).toBeLessThan((await editor.nodeBoxIn('desktop', 'cta-row')).y);
});

test('CMP-017 the subtree\'s migrated @media rules leave the page, root placement stays, no ring on the replicas', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(MAKE_COMPONENT_3VP_PLACEMENT, { fit: true });
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: CARD_CORNER, vpId: 'desktop' });
  const pageCode = await editor.code(PAGE);
  const master = await editor.code(made.file);

  // Subtree rules migrated into the master's variants and gone from the page.
  await expect(editor).toHaveBandStyle(768, 'card', 'padding', null, { path: PAGE });
  await expect(editor).toHaveBandStyle(768, 'card-body', 'fontSize', null, { path: PAGE });
  expect(pageCode).not.toContain('[data-id="card-body"]');
  expect(variantsEntry(master, 'cardBodyVariants', 'variant-1')).toMatch(/fontSize: '13px'/);
  // Root placement and nodes that stayed keep their rules.
  await expect(editor).toHaveBandStyle(375, 'card', 'order', '10', { path: PAGE });
  await expect(editor).toHaveBandStyle(768, 'cta-row', 'height', '60px', { path: PAGE });

  // No page-coloured ring: on Tablet/Mobile the instance wrapper is exactly
  // its master root (the padding is the root's, not the wrapper's).
  await exitToPage(editor);
  for (const vp of ['tablet', 'mobile']) {
    const wrapper = await editor.nodeIn(vp, 'card');
    const inner = await editor.nodeIn(vp, 'card:card');
    const [w, i] = [(await wrapper.boundingBox())!, (await inner.boundingBox())!];
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(w[k] - i[k]), `${vp} ${k}`).toBeLessThanOrEqual(0.5);
    expect(await wrapper.evaluate(el => getComputedStyle(el).paddingTop)).toBe('0px');
  }
  expect(await (await editor.nodeIn('tablet', 'card:card')).evaluate(el => getComputedStyle(el).paddingTop)).toBe('12px');
});
