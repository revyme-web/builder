// CMP · Nesting, slots and the cycle guard (E2E_TEST_PLAN.md §8, CMP-228…CMP-235).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  nestedMasters, HEADER, CARD, BUTTON, PAGE,
  enterFile, dragLibraryRow, toast, traces, sourceFiles, stableBoxOf, pollCode, stableCode,
  canvasNode, computed, clickNodeId, textOf, quickBox,
  slotSeed, LOGOS, SECTION, wiredMarqueePage, profileSeed, PROFILE,
} from '../../helpers/c8';
import { emptyCanvasPoint } from '../../helpers/d3';
import { parsesStrict, panel, acceptKnownViolation } from '../../helpers/c6';
import { propRow, openingTag, clickStable } from '../../helpers/c3';
import { exitToPage, allowPreviewNoise } from '../../helpers/c1';
import { PREVIEW_NOISE } from '../../helpers/c4';

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: TILES_VIEWPORT });

const OWN_MASTER = 'A component can’t be placed inside its own master.';
const LOOP = 'That component already contains this one — placing it here would create a loop.';

test('CMP-228 the Library refuses a drag that would nest a master in itself or in its own chain', { tag: ['@p0', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(nestedMasters());

  // Header → Header master.
  await enterFile(editor, HEADER, 'header-root');
  const before = await sourceFiles(editor);
  let root = await stableBoxOf(editor, 'header-root');
  const own = await dragLibraryRow(editor, 'Header', { x: root.x + root.width * 0.3, y: root.y + root.height / 2 });
  await expect(toast(page, OWN_MASTER)).toBeVisible();
  // Refused at drag START: no toolbar drag ever engaged.
  expect(own.engaged, 'the drag never started').toBe(false);
  expect((await traces(editor, 'library-panel:drag-refused-cycle')).length).toBe(1);
  await editor.settled();
  expect(await sourceFiles(editor), 'nothing written').toEqual(before);

  // Card (which renders Button) → Button master: Card → … → Button would loop.
  await enterFile(editor, BUTTON, 'btn-root');
  root = await stableBoxOf(editor, 'btn-root');
  const loop = await dragLibraryRow(editor, 'Card', { x: root.x + root.width / 2, y: root.y + root.height / 2 });
  await expect(toast(page, LOOP)).toBeVisible();
  expect(loop.engaged).toBe(false);
  // Header → Card → Button: the transitive chain is refused too.
  const chain = await dragLibraryRow(editor, 'Header', { x: root.x + root.width / 2, y: root.y + root.height / 2 });
  expect(chain.engaged).toBe(false);
  expect((await traces(editor, 'library-panel:drag-refused-cycle')).length).toBe(3);
  await editor.settled();
  expect(await sourceFiles(editor), 'nothing written').toEqual(before);
  expect(await editor.exists('btn-root', BUTTON)).toBe(true);
  expect(await editor.code(BUTTON)).not.toMatch(/<(Card|Header)\b/);
  expect(await editor.code(HEADER)).not.toMatch(/<Header\b/);
});

test('CMP-229 pasting a Header instance inside the Header master is refused with a toast', { tag: ['@p1', '@cmp'] }, async ({ editor, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.load(nestedMasters());
  await editor.click('header-a');
  await expect.poll(() => editor.selection()).toEqual(['header-a']);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+c');
  await editor.settled();

  await enterFile(editor, HEADER, 'header-root');
  await clickNodeId(editor, 'header-root', [0.95, 0.5]);
  await expect.poll(() => editor.selection()).toEqual(['header-root']);
  const before = await sourceFiles(editor);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(toast(page, 'A component can’t be pasted inside its own master.')).toBeVisible();
  await editor.settled();
  expect(await sourceFiles(editor), 'nothing pasted').toEqual(before);
  const header = await editor.code(HEADER);
  expect(header).not.toMatch(/<Header\b/);
  expect(header).not.toMatch(/import Header from/);
  expect(parsesStrict(header), 'the master still parses').toBe(true);
  // The master keeps painting.
  await expect(canvasNode(editor, 'header-card:card-root')).toBeAttached();
});

test('CMP-230 dragging Button into the Card master adds the instance and its import; every tile and page instance paints it', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  await editor.load(nestedMasters({ cardWithButton: false }));
  await enterFile(editor, CARD, 'card-root');
  const before = await stableCode(editor, CARD);
  const root = await stableBoxOf(editor, 'card-root');
  const drop = await dragLibraryRow(editor, 'Button', { x: root.x + root.width / 2, y: root.y + root.height * 0.85 });
  expect(drop.engaged, 'the library drag engaged').toBe(true);

  const code = await pollCode(editor, CARD, c => /<Button\b/.test(c) && /import Button from '@\/components\/Button'/.test(c));
  expect(code).toMatch(/^import Button from '@\/components\/Button';?$/m);
  const btnId = code.match(/<Button\b[^>]*?data-id="([^"]+)"/)![1];
  expect(await editor.parentOf(btnId, CARD)).toBe('card-root');
  expect(parsesStrict(code)).toBe(true);
  // No cycle toast for a legal drop.
  expect((await traces(editor, 'library-panel:drag-refused-cycle')).length).toBe(0);

  // Both variant tiles render the nested Button.
  await expect(canvasNode(editor, `${btnId}:btn-text`)).toHaveText('Click');
  await editor.fitCamera();
  await expect(await editor.nodeIn('variant-1', `${btnId}:btn-text`)).toHaveText('Click');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Page Card instances (and the Card nested in Header) show it.
  await exitToPage(editor);
  for (const inst of ['card-a', 'card-b', 'header-a:header-card']) {
    await expect(canvasNode(editor, `${inst}:${btnId}:btn-text`), `${inst} shows the nested Button`).toHaveText('Click');
  }
});

test('CMP-231 the nested Button set to Dark on the Featured tile writes a per-variant ternary; the Featured page instance paints it', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor, page }) => {
  editor.allowErrors(PREVIEW_NOISE);
  allowPreviewNoise(editor);
  await editor.load(nestedMasters());
  await enterFile(editor, CARD, 'card-root');
  const before = await stableCode(editor, CARD);
  await clickStable(editor, 'card-btn', 'variant-1');
  await expect.poll(() => editor.selection()).toEqual(['card-btn']);
  await propRow(page, 'Variant').locator('select').selectOption({ label: 'Dark' });

  const tag = () => editor.code(CARD).then(c => openingTag(c, 'card-btn'));
  await expect.poll(tag).toMatch(/initialVariant=\{\s*initialVariant === ['"]variant-1['"] \? ['"]dark['"] : ['"]default['"]\s*\}/);
  expect(parsesStrict(await editor.code(CARD))).toBe(true);
  // The Featured tile paints the dark Button; the Default tile keeps Primary.
  await expect.poll(async () => (await editor.nodeIn('variant-1', 'card-btn:btn-root')).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
  await expect.poll(() => computed(editor, 'card-btn:btn-root', 'background-color')).toBe('rgb(255, 45, 117)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // The live preview renders the Featured page instance with the Dark Button…
  await exitToPage(editor);
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator('[data-id="card-b"]').first().waitFor({ state: 'attached', timeout: 45_000 });
  // The nested master root carries the instance's data-id on the live site.
  const bg = (inst: string) => frame.locator(`[data-id="${inst}"] [data-id="card-btn"]`).first().evaluate(el => getComputedStyle(el).backgroundColor);
  await expect.poll(() => bg('card-b'), { timeout: 15_000 }).toBe('rgb(0, 0, 0)');
  await expect.poll(() => bg('card-a')).toBe('rgb(255, 45, 117)');
  await page.keyboard.press('Escape');
  await expect(page.locator('iframe[src*="5175"]')).toHaveCount(0);

  // …and so must the canvas.
  test.fail(!process.env.C8_NOFAIL, 'BUG: on the page canvas a Featured (initialVariant="variant-1") Card instance paints its nested Button as Primary while the preview shows Dark — project-parser.ts:1015 remaps the nested motionVariants by PARENT variant name, but a page instance\'s plain initialVariant is only baked into the outer Card\'s own nodes, so the remapped child entry never activates');
  await expect.poll(() => computed(editor, 'card-a:card-btn:btn-root', 'background-color')).toBe('rgb(255, 45, 117)');
  await expect.poll(() => computed(editor, 'card-b:card-btn:btn-root', 'background-color')).toBe('rgb(0, 0, 0)');
});

// ─── Slots ───────────────────────────────────────────────────────────

/** Text a marquee paints, and whether it shows the empty-slot placeholder. */
async function marqueeText(editor: import('../../helpers/editor').Editor, nodeId: string): Promise<string> {
  return textOf(editor, nodeId);
}

test('CMP-232 a master with a wired Marquee shows its slot items on its tile, inside another master and on a page', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(slotSeed());
  // The master tile itself.
  await enterFile(editor, LOGOS, 'logos-root');
  await expect.poll(() => marqueeText(editor, 'logos-marquee')).toBe('Logo ALogo B');

  // Place Logos inside the Section master.
  await enterFile(editor, SECTION, 'section-root');
  let root = await stableBoxOf(editor, 'section-root');
  expect((await dragLibraryRow(editor, 'Logos', { x: root.x + root.width / 2, y: root.y + root.height * 0.85 })).engaged).toBe(true);
  const section = await pollCode(editor, SECTION, c => /<Logos\b/.test(c));
  const innerId = section.match(/<Logos\b[^>]*?data-id="([^"]+)"/)![1];
  expect(section).toMatch(/^import Logos from '@\/components\/Logos';?$/m);
  await expect.poll(() => marqueeText(editor, `${innerId}:logos-marquee`), { message: 'slot items resolve inside the outer master' }).toBe('Logo ALogo B');
  expect(await marqueeText(editor, `${innerId}:logos-marquee`)).not.toContain('Connect Content');

  // …and on a page, both directly and through the outer master.
  await exitToPage(editor);
  await expect.poll(() => marqueeText(editor, `section-a:${innerId}:logos-marquee`), { message: 'nested twice' }).toBe('Logo ALogo B');
  root = await stableBoxOf(editor, 'root');
  expect((await dragLibraryRow(editor, 'Logos', { x: root.x + root.width * 0.3, y: root.y + root.height * 0.8 })).engaged).toBe(true);
  const pageCode = await pollCode(editor, PAGE, c => /<Logos\b/.test(c));
  const pageId = pageCode.match(/<Logos\b[^>]*?data-id="([^"]+)"/)![1];
  await expect.poll(() => marqueeText(editor, `${pageId}:logos-marquee`), { message: 'page instance' }).toBe('Logo ALogo B');
  // The slot consts never leak into the files that only USE the master.
  expect(pageCode).not.toMatch(/const cn_logo_/);
  expect(await editor.code(SECTION)).not.toMatch(/const cn_logo_/);
});

test('CMP-233 duplicating a section with a wired Marquee shares the same cn_ references in order', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(wiredMarqueePage());
  await expect.poll(() => marqueeText(editor, 'strip')).toBe('AlphaBeta');
  await clickNodeId(editor, 'partners', [0.5, 0.06]);
  await expect.poll(() => editor.selection()).toEqual(['partners']);
  const before = await stableCode(editor, PAGE);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+d');
  const code = await pollCode(editor, PAGE, c => (c.match(/<Marquee\b/g) ?? []).length === 2);
  const marquees = [...code.matchAll(/<Marquee\b[^>]*?data-id="([^"]+)"[^>]*>([\s\S]*?)<\/Marquee>/g)];
  expect(marquees.map(m => m[2].trim()), 'both carry the same refs, same order').toEqual(['{cn_a}{cn_b}', '{cn_a}{cn_b}']);
  const copyId = marquees.map(m => m[1]).find(id => id !== 'strip')!;
  // No cloned consts: still exactly the two originals.
  expect((code.match(/^const cn_\w+\s*=/gm) ?? []).sort()).toEqual(['const cn_a =', 'const cn_b =']);
  expect(code).toContain('data-id="a"');
  // The copy paints the items. Not: the empty "Connect Content" placeholder.
  await expect.poll(() => marqueeText(editor, copyId)).toBe('AlphaBeta');
  expect(await marqueeText(editor, copyId)).not.toContain('Connect Content');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-234 a prop-bound text dragged out of a master stashes its variable; dragged back it re-binds', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(profileSeed());
  // Known, pinned elsewhere (02-dnd/node-kinds-drag.spec.ts): a child dragged
  // back into a master returns as a plain <p> carrying layout={true}.
  acceptKnownViolation(editor, PROFILE, 'MOTION_PROPS_ON_PLAIN_TAG', 'pf-bio');
  await enterFile(editor, PROFILE, 'pf-root');
  const before = await stableCode(editor, PROFILE);
  const rootBox = await stableBoxOf(editor, 'pf-root');
  const out = await emptyCanvasPoint(editor, { x: rootBox.x + rootBox.width + 220, y: rootBox.y + rootBox.height / 2 });
  await editor.dragNodeAsserted('pf-bio', out, { steps: 24 });
  await editor.settled();

  // Out: a canvas node, the literal default shown, the variable stashed.
  let code = await pollCode(editor, PROFILE, c => /data-var-orphan="content:bio"/.test(c));
  expect(code).toMatch(/data-var-orphan="content:bio"/);
  const canvasStart = code.indexOf('const canvasNodes');
  expect(canvasStart, 'landed in canvasNodes').toBeGreaterThan(-1);
  expect(code.indexOf('data-id="pf-bio"')).toBeGreaterThan(canvasStart);
  expect(code.slice(canvasStart)).not.toMatch(/\{bio\}/);
  expect(code.slice(canvasStart)).toContain('Loves maths');
  await expect.poll(() => textOf(editor, 'pf-bio')).toBe('Loves maths');
  // The purple variable pill stays on the node.
  await clickNodeId(editor, 'pf-bio');
  await expect(panel(page).locator('[title^="Variable: Bio"]').first()).toBeVisible();
  await expect(editor).toUndoInOneStep(before, { path: PROFILE });

  // Back into the render: {bio} restored, the stash dropped.
  const afterOut = await stableCode(editor, PROFILE);
  const into = await editor.at('pf-root', 0.5, 0.85);
  await editor.dragNodeAsserted('pf-bio', into, { steps: 24 });
  code = await pollCode(editor, PROFILE, c => !/data-var-orphan/.test(c) && /\{bio\}/.test(c));
  expect(code).not.toMatch(/data-var-orphan/);
  expect(await editor.parentOf('pf-bio', PROFILE)).toBe('pf-root');
  expect(code).toMatch(/data-id="pf-bio"[^>]*>\{bio\}</);
  await expect.poll(() => textOf(editor, 'pf-bio')).toBe('Loves maths');
  await expect(editor).toUndoInOneStep(afterOut, { path: PROFILE });
});

test('CMP-235 a Loop on a slot-connected canvas node in a master is a self-contained declarative loop', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(slotSeed());
  await enterFile(editor, LOGOS, 'logos-root');
  const before = await stableCode(editor, LOGOS);
  await clickNodeId(editor, 'logo-a', [0.08, 0.12]);
  await expect.poll(() => editor.selection()).toEqual(['logo-a']);
  await panel(page).locator('button[title="Add animation effect"]').first().click();
  await page.locator('button[title="Repeats forever. Yoyo + repeat delay supported."]').click();

  const code = await pollCode(editor, LOGOS, c => /data-loop/.test(c));
  const decl = code.slice(code.indexOf('const cn_logo_a'), code.indexOf('const cn_logo_b'));
  expect(decl).toMatch(/data-loop/);
  expect(decl).toMatch(/<motion\.div\b/);
  expect(decl).toMatch(/animate=\{\{/);
  expect(decl).toMatch(/repeat:\s*Infinity/);
  // No body hooks for a module-scope node.
  expect(code).not.toMatch(/useMotionValue|useInView/);
  expect(code).not.toMatch(/\b\w*[Ll]ogo\w*Ref\b/);
  expect(parsesStrict(code)).toBe(true);
  await expect(page.getByText(/References undefined identifiers/)).toHaveCount(0);
  // The item still renders in the marquee.
  await expect.poll(() => marqueeText(editor, 'logos-marquee')).toBe('Logo ALogo B');
  await expect(editor).toUndoInOneStep(before, { path: LOGOS });
});
