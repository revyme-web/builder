// DND · Other node kinds: translated text, prop-bound master children,
// instances and SVG groups, FIT text, design instances and code components
// on a replica, fixed-size code components, slot canvas nodes
// (E2E_TEST_PLAN.md §2, batch D5, DND-222..228).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { centerOn, emptyCanvasPoint, isCanvasNode } from '../../helpers/d3';
import { slotPage, marqueeSource } from '../../helpers/c1';
import { openMaster, prime } from '../../helpers/c5';
import {
  I18N_PAGE, BIO_SEED, INSTANCE_AND_GROUP, FIT_CANVAS, CODE_ROW, tabletKindsSeed,
  pressNode, drop, engaged, stableCode, mark, since, near, parses, center, pollFor,
} from '../../helpers/d5';

test.describe.configure({ timeout: 180_000 });

const CARD = 'components/Card.tsx';
const px = (v: string | undefined) => parseFloat(v ?? 'NaN');

/** Source text of the element carrying `id` (null when missing). */
async function elementSource(editor: import('../../helpers/editor').Editor, id: string, path?: string): Promise<string | null> {
  const src = await editor.source(path);
  const n = src.byId.get(id);
  return n ? src.code.slice(n.start, n.end) : null;
}

// ─── DND-222 ──────────────────────────────────────────────────────────

test('DND-222 a {t(\'key\')} text dragged out to the canvas bakes the default-locale literal + data-i18n-orphan, and gets its t() call back in the page', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(I18N_PAGE);
  const page = editor.page();
  const before = await editor.code();
  const tile = await editor.nodeBox('root');
  const out = await emptyCanvasPoint(editor, { x: tile.x + tile.width / 2, y: tile.y + tile.height + 60 }, 30);
  const m = await mark(page);
  let r = await pressNode(editor, 'title', { fx: 0.05 });
  try {
    await r.d.moveTo(out, 30);
    await engaged(editor, 'title', r.box);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => isCanvasNode(editor, 'title')).toBe(true);
  let code = await stableCode(editor);
  // On the canvas: the default-locale copy, the key stashed, no t() at module scope.
  expect(await editor.attr('title', 'data-i18n-orphan')).toBe('title');
  const el = (await elementSource(editor, 'title'))!;
  expect(el).toContain('>Hello world<');
  expect(el).not.toMatch(/\bt\(/);
  await expect(editor.node('title')).toHaveText('Hello world');
  // No "References undefined identifier: t" rejection: the move landed, and the oracle is clean.
  expect((await since(page, m)).filter(e => /undefined identifier/i.test(JSON.stringify(e.data ?? ''))), 'no undefined-identifier rejection').toEqual([]);
  expect(await editor.newOracleViolations()).toEqual([]);
  expect(code).not.toBe(before);

  // Back into the page root: the t() call is restored, the stash dropped.
  await page.waitForTimeout(450);
  const back = await editor.code();
  const root = await editor.nodeBox('root');
  const hero = await editor.nodeBox('hero');
  const foot = await editor.nodeBox('foot');
  r = await pressNode(editor, 'title');
  try {
    await r.d.moveTo({ x: root.x + root.width * 0.7, y: (hero.y + hero.height + foot.y) / 2 }, 30);
    await r.d.hold(10);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => editor.parentOf('title')).toBe('root');
  code = await stableCode(editor);
  const el2 = (await elementSource(editor, 'title'))!;
  expect(el2).toMatch(/\{t\((["'])title\1\)\}/);
  expect(el2).not.toContain('Hello world');
  expect(await editor.attr('title', 'data-i18n-orphan')).toBeNull();
  expect(code).toContain("useTranslations('home')");
  expect(await isCanvasNode(editor, 'title')).toBe(false);
  expect(await editor.newOracleViolations()).toEqual([]);
  await expect(editor).toUndoInOneStep(back);
});

// ─── DND-223 ──────────────────────────────────────────────────────────

test('DND-223 a prop-bound master child dragged onto the canvas keeps a dormant binding (data-var-orphan, purple pill) and rebinds when dragged back', { tag: ['@p1', '@dnd', '@cmp'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: dragged back into the master, the child returns as a PLAIN <p> carrying layout={true} (it was <motion.p>), which the builder\'s oracle rejects (MOTION_PROPS_ON_PLAIN_TAG)');
  await editor.load(BIO_SEED);
  await openMaster(editor, CARD, 'desktop');
  const page = editor.page();
  const root0 = await editor.nodeBox('card-root');
  const out = await emptyCanvasPoint(editor, { x: root0.x + root0.width + 150, y: root0.y + 100 }, 30);
  let r = await pressNode(editor, 'bio-text', { fx: 0.1 });
  try {
    await r.d.moveTo(out, 30);
    await engaged(editor, 'bio-text', r.box);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => isCanvasNode(editor, 'bio-text', CARD)).toBe(true);
  await stableCode(editor, CARD);
  // Dormant: the default painted in, the binding stashed, no `{bio}` at module scope.
  expect(await editor.attr('bio-text', 'data-var-orphan', CARD)).toBe('content:bio');
  const el = (await elementSource(editor, 'bio-text', CARD))!;
  expect(el).toContain('{"Default bio"}');
  expect(el).not.toContain('{bio}');
  expect(await editor.newOracleViolations(), 'no undefined-identifier crash').toEqual([]);
  // The panel still shows the variable: a purple "Bio" pill (the bound-variable chip).
  const pills = page.locator('[data-properties-panel] button', { has: page.locator('span', { hasText: /^Bio$/ }) });
  await expect(pills.first()).toBeVisible({ timeout: 10_000 });
  const purple = await pollFor(page, () => pills.evaluateAll(bs => bs.map(b => getComputedStyle(b).backgroundColor)), bgs => bgs.some(bg => {
    const [rr, gg, bb] = (bg.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return !/rgba\(0, 0, 0, 0\)/.test(bg) && bb > gg && rr > gg;
  }), 5_000);
  expect(purple.some(bg => !/rgba\(0, 0, 0, 0\)/.test(bg)), `a purple Bio pill (${purple.join(' | ')})`).toBe(true);

  // Back into the card root: rebinds.
  await page.waitForTimeout(450);
  const back = await editor.code(CARD);
  const band = await editor.nodeBox('card-band');
  const foot = await editor.nodeBox('card-foot');
  r = await pressNode(editor, 'bio-text');
  try {
    await r.d.moveTo({ x: band.x + band.width / 2, y: (band.y + band.height + foot.y) / 2 }, 30);
    await r.d.hold(10);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => editor.parentOf('bio-text', CARD)).toBe('card-root');
  await stableCode(editor, CARD);
  const el2 = (await elementSource(editor, 'bio-text', CARD))!;
  expect(el2).toContain('{bio}');
  expect(await editor.attr('bio-text', 'data-var-orphan', CARD)).toBeNull();
  expect(await editor.newOracleViolations(), "the builder's oracle accepts the re-entered child").toEqual([]);
  await expect(editor).toUndoInOneStep(back, { path: CARD });
});

// ─── DND-224 ──────────────────────────────────────────────────────────

test('DND-224 a press inside an instance drags the whole instance; inside an SVG group in group-edit the pressed child drags', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(INSTANCE_AND_GROUP);
  const page = editor.page();
  await centerOn(editor, ['pill', 'grp']);
  const before = await editor.code();
  const master0 = await editor.code('components/Pill.tsx');
  const pill0 = await editor.style('pill');
  const dot0 = await editor.nodeBox('pill:pill-dot');
  const pb0 = await editor.nodeBox('pill');
  let m = await mark(page);
  const r = await pressNode(editor, 'pill:pill-dot');
  try {
    await r.d.moveBy(60, 30, 12);
    await engaged(editor, 'pill', pb0);
    await r.d.hold(4);
  } finally { await drop(editor, r.d); }
  await stableCode(editor);
  expect((await since(page, m, '^drag:start$'))[0]?.data?.nodes?.map((n: any) => n.id), 'redirected to the instance root').toEqual(['pill']);
  expect(await editor.style('pill')).not.toEqual(pill0);
  expect(await editor.code('components/Pill.tsx'), 'the master is untouched').toBe(master0);
  const pb1 = await editor.nodeBox('pill'), dot1 = await editor.nodeBox('pill:pill-dot');
  expect(near(dot1.x - pb1.x, dot0.x - pb0.x, 1) && near(dot1.y - pb1.y, dot0.y - pb0.y, 1), 'the inner element rode along').toBe(true);
  await expect(editor).toUndoInOneStep(before);

  // Group-edit: double-click (two spaced clicks) into the group, then drag the letter.
  await page.waitForTimeout(450);
  const s1 = center(await editor.nodeBox('grp-s1'));
  await page.mouse.click(s1.x, s1.y);
  await page.waitForTimeout(120);
  await page.mouse.click(s1.x, s1.y);
  await editor.settled();
  await expect.poll(() => editor.selection()).toEqual(['grp-s1']);
  await page.waitForTimeout(450);
  const s0Box = await editor.nodeBox('grp-s0');
  const x0 = await editor.attr('grp-s1', 'x');
  const before2 = await editor.code();
  m = await mark(page);
  const r2 = await pressNode(editor, 'grp-s1');
  try {
    await r2.d.moveBy(40, 30, 12);
    await engaged(editor, 'grp-s1', r2.box);
    await r2.d.hold(4);
  } finally { await drop(editor, r2.d); }
  await stableCode(editor);
  expect((await since(page, m, '^drag:start$'))[0]?.data?.nodes?.map((n: any) => n.id), 'the pressed child drags itself').toEqual(['grp-s1']);
  expect(await editor.attr('grp-s1', 'x')).not.toBe(x0);
  expect(await editor.parentOf('grp-s1')).toBe('grp');
  const s0After = await editor.nodeBox('grp-s0');
  expect(near(s0After.x, s0Box.x, 1.5) && near(s0After.y, s0Box.y, 1.5), 'its sibling stayed put').toBe(true);
  await expect(editor).toUndoInOneStep(before2);
});

// ─── DND-225 ──────────────────────────────────────────────────────────

test('DND-225 FIT text: a press on its text moves the -svg wrapper inside the frame, and out to the canvas the <id>-svg pairing holds', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FIT_CANVAS);
  const page = editor.page();
  await centerOn(editor, ['tframe']);
  const before = await editor.code();
  const inner0 = await editor.style('ft');
  const w0 = await editor.style('ft-svg');
  let m = await mark(page);
  let r = await pressNode(editor, 'ft');
  try {
    await r.d.moveBy(40, 30, 12);
    await engaged(editor, 'ft', r.box);
    await r.d.hold(4);
  } finally { await drop(editor, r.d); }
  await stableCode(editor);
  expect((await since(page, m, '^drag:start$'))[0]?.data?.nodes?.map((n: any) => n.id), 'press redirected to the wrapper').toEqual(['ft-svg']);
  const w1 = await editor.style('ft-svg');
  expect([w1.left, w1.top], 'the wrapper moved').not.toEqual([w0.left, w0.top]);
  expect(await editor.style('ft'), 'the inner text kept its own style').toEqual(inner0);
  expect(await editor.parentOf('ft-svg')).toBe('tframe');
  await expect(editor).toUndoInOneStep(before);
  await editor.undo(); // back to the seed: the out-to-canvas leg starts from it
  await expect.poll(() => editor.code()).toBe(before);

  // Out to the canvas.
  await page.waitForTimeout(450);
  const tf = await editor.nodeBox('tframe');
  m = await mark(page);
  r = await pressNode(editor, 'ft');
  try {
    await r.d.moveTo({ x: tf.x + tf.width + 60, y: tf.y + 60 }, 30);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => isCanvasNode(editor, 'ft-svg')).toBe(true);
  const code = await stableCode(editor);
  expect(parses(code)).toBe(true);
  // The pairing: wrapper `<inner>-svg` > foreignObject > inner text.
  const src = await editor.source();
  expect(src.byId.get('ft')?.parentId).toBe('ft-svg');
  expect(src.byId.get('ft-svg')?.attrs['data-name']).toBe('FIT');
  const wrap = (await elementSource(editor, 'ft-svg'))!;
  expect(wrap).toMatch(/<foreignObject[\s\S]*data-id="ft"[\s\S]*<\/foreignObject>/);
  expect(await editor.childIds('tframe')).toEqual([]);
  await expect(editor.node('ft')).toHaveText('Fit me now');
  expect(await editor.newOracleViolations()).toEqual([]);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-226 ──────────────────────────────────────────────────────────

test.describe('on tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-226 Tablet drag-outs: a design instance detaches as a leaf, a code component keeps its real slot children', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    test.fail(!process.env.D5_NOFAIL, 'BUG: the replica drag-out clone of a code component keeps its slot children but strips their data-canvas-node marker, so they become inline children the canvas never renders (oracle SLOT_COMPONENT_INLINE_CHILDREN)');
    await editor.load(tabletKindsSeed(marqueeSource()), { fit: true });
    const page = editor.page();
    const tab = await editor.nodeBoxIn('tablet', 'root');
    const known = new Set((await editor.source()).allIds);
    const clones: Record<string, string> = {};
    for (const id of ['card-i', 'strip']) {
      await prime(editor, id, 'tablet', 0.5, 0.15);
      const r = await pressNode(editor, id, { vpId: 'tablet', fx: 0.5, fy: 0.15 });
      try {
        await r.d.moveTo({ x: r.box.x + r.box.width / 2, y: tab.y + tab.height + 80 }, 30);
        await r.d.hold(8);
      } finally { await drop(editor, r.d); }
      const fresh = await pollFor(page, async () => (await editor.source()).nodes.filter(n => !known.has(n.id) && n.parentId === null).map(n => n.id), ids => ids.length === 1, 6_000);
      expect(fresh, `one canvas clone for ${id}`).toHaveLength(1);
      clones[id] = fresh[0];
      for (const n of (await editor.source()).allIds) known.add(n);
      await page.waitForTimeout(500);
    }
    await stableCode(editor);
    const src = await editor.source();
    // Design instance: a leaf, data-responsive stripped, the Tablet variant baked.
    const card = src.byId.get(clones['card-i'])!;
    expect(card.tag).toBe('Card');
    expect(card.attrs['data-canvas-node']).toBe('true');
    expect(card.childIds, 'no expanded children').toEqual([]);
    expect(card.attrs['data-responsive'], 'data-responsive stripped').toBeUndefined();
    expect(card.attrs.initialVariant).toBe('variant-1');
    // Code component: its two slot items come along, still connected canvas nodes.
    const strip = src.byId.get(clones.strip)!;
    expect(strip.tag).toBe('Marquee');
    expect(strip.childIds, 'both slot children kept').toHaveLength(2);
    for (const kid of strip.childIds) {
      expect(src.byId.get(kid)?.attrs['data-canvas-node'], `slot child ${kid} still a connected canvas node`).toBe('true');
    }
    expect(await editor.newOracleViolations()).toEqual([]);
  });
});

// ─── DND-227 ──────────────────────────────────────────────────────────

test('DND-227 a fixed-size code component dragged out of a flex row keeps its px width and height and renders at that size', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(CODE_ROW);
  const before = await editor.code();
  const g0 = await editor.nodeBox('gauge');
  const scale = (await editor.nodeBox('r1')).width / 200;
  const tile = await editor.nodeBox('root');
  const out = await emptyCanvasPoint(editor, { x: tile.x + tile.width / 2, y: tile.y + tile.height + 80 }, 40);
  const r = await pressNode(editor, 'gauge');
  try {
    await r.d.moveTo(out, 30);
    await engaged(editor, 'gauge', g0);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => isCanvasNode(editor, 'gauge')).toBe(true);
  await stableCode(editor);
  const st = await editor.style('gauge');
  expect([st.width, st.height], 'px size kept').toEqual(['300px', '200px']);
  expect(st.position).toBe('absolute');
  const g1 = await editor.nodeBox('gauge');
  expect(near(g1.width, 300 * scale, 2) && near(g1.height, 200 * scale, 2), `renders 300×200 (${g1.width}×${g1.height} at ${scale})`).toBe(true);
  expect(await editor.childIds('row')).toEqual(['r1', 'r2']);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-228 ──────────────────────────────────────────────────────────

test('DND-228 a slot item canvas node (cn_* const) dragged on the canvas moves as a canvas node and stays connected — no clone', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(slotPage());
  await centerOn(editor, ['slot-a', 'slot-b']);
  const before = await editor.code();
  const ids0 = (await editor.source()).allIds.slice().sort();
  const s0 = await editor.style('slot-a');
  const b0 = await editor.nodeBox('slot-a');
  const r = await pressNode(editor, 'slot-a');
  try {
    await r.d.moveBy(60, 30, 12);
    await engaged(editor, 'slot-a', b0);
    await r.d.hold(4);
  } finally { await drop(editor, r.d); }
  const code = await stableCode(editor);
  const s1 = await editor.style('slot-a');
  expect(px(s1.left) - px(s0.left)).toBeGreaterThan(20);
  expect(px(s1.top) - px(s0.top)).toBeGreaterThan(10);
  // Still the hoisted const, still referenced inside the Marquee, still one node.
  expect((code.match(/const cn_slot_a = <div data-id="slot-a"/g) ?? []).length).toBe(1);
  expect(code).toMatch(/<Marquee[^>]*>\{cn_slot_a\}\{cn_slot_b\}<\/Marquee>/);
  expect(await editor.attr('slot-a', 'data-canvas-node')).toBe('true');
  expect((await editor.source()).allIds.slice().sort(), 'no clone, no new ids').toEqual(ids0);
  expect(await editor.newOracleViolations()).toEqual([]);
  await expect(editor).toUndoInOneStep(before);
});

