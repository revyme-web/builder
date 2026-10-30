// DND · Animated nodes: effects travel with the node (E2E_TEST_PLAN.md §2,
// batch D5, DND-270..273). Seeds are the builder's own output: the effects were
// written through the product's mutation queue (see FX_PAGE in helpers/d5.ts).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import { centerOn, emptyCanvasPoint } from '../../helpers/d3';
import { dragLayerRow, lid, pressMidDrag } from '../../helpers/d4';
import { visualOrderIn } from '../../helpers/d6';
import { openPreview, PREVIEW_NOISE } from '../../helpers/c5';
import {
  FX_PAGE, FX2_PAGE, GLIDE_PAGE, FX3_PAGE,
  pressNode, drop, engaged, clickNode, stableCode, parses, effectFacts, scrollFxOf, dupIds, pollFor, near,
} from '../../helpers/d5';
import { parse as babelParse } from '@babel/parser';

test.describe.configure({ timeout: 240_000 });

/** In-page invariants for an effect-carrying node: motion tag, its own ref,
 *  one declaration per hook, nothing referenced that isn't declared, oracle clean. */
async function expectEffectsInPage(editor: Editor, id: string, label: string): Promise<void> {
  const code = await stableCode(editor);
  expect(parses(code), `${label}: the file parses`).toBe(true);
  const f = effectFacts(code, id);
  expect(f.tag, `${label}: still a motion element`).toBe('motion.div');
  expect(f.ref, `${label}: the ref stays on its tag`).toBe(`${id}Ref`);
  expect(f.dupDecls, `${label}: one declaration per effect hook`).toEqual([]);
  expect(f.undeclared, `${label}: no dangling identifiers on the tag`).toEqual([]);
  // Every effect value the tag uses is declared exactly once in the body.
  for (const name of f.attrIdents.filter(n => n.startsWith(id))) {
    expect(f.decls.filter(d => d === name), `${label}: ${name} declared once`).toHaveLength(1);
  }
  const fx = scrollFxOf(code, id);
  expect(Object.keys(fx ?? {}).sort(), `${label}: the spec keeps all three effects`).toEqual(['appear', 'hover', 'transform']);
  expect(await editor.newOracleViolations(), `${label}: __e2e.checkFile clean`).toEqual([]);
}

// ─── DND-270 ──────────────────────────────────────────────────────────

test('DND-270 a node with Appear, Scroll Transform and Hover: reorder, into another section, out to the canvas and back — the effect code follows it and still runs', { tag: ['@p0', '@dnd', '@preview'] }, async ({ editor }) => {
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(FX_PAGE);
  const page = editor.page();
  await centerOn(editor, ['sec-a', 'sec-b']);
  await expectEffectsInPage(editor, 'fx', 'seed');

  // 1. Reorder below a2 in its own flex column.
  const a2 = await editor.nodeBox('a2');
  let r = await pressNode(editor, 'fx');
  try {
    await r.d.moveTo({ x: a2.x + a2.width / 2 + 2, y: a2.y + a2.height * 0.85 }, 20);
    await engaged(editor, 'fx', r.box);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  expect(await editor.parentOf('fx')).toBe('sec-a');
  expect(await visualOrderIn(editor, 'desktop', ['fx', 'a2'])).toEqual(['a2', 'fx']);
  await expectEffectsInPage(editor, 'fx', 'after the reorder');

  // 2. Into the other section (a flow child changes parents through the tree).
  await page.waitForTimeout(450);
  await dragLayerRow(editor, lid('fx'), lid('sec-b'), 'middle');
  await expect.poll(() => editor.parentOf('fx')).toBe('sec-b');
  await expectEffectsInPage(editor, 'fx', 'in sec-b');

  // 3. Out to the canvas: the spec goes dormant, every hook leaves the page body.
  await page.waitForTimeout(450);
  const root = await editor.nodeBox('root');
  const out = await emptyCanvasPoint(editor, { x: root.x + root.width / 2, y: root.y + root.height + 60 }, 30);
  r = await pressNode(editor, 'fx');
  try {
    await r.d.moveTo(out, 30);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(async () => (await editor.source()).byId.get('fx')?.attrs['data-canvas-node']).toBe('true');
  let code = await stableCode(editor);
  expect(parses(code)).toBe(true);
  const onCanvas = effectFacts(code, 'fx');
  expect(onCanvas.ref, 'no ref at module scope').toBeNull();
  expect(onCanvas.decls.filter(d => d.startsWith('fx')), 'no fx hooks left in the page body').toEqual([]);
  expect(onCanvas.undeclared).toEqual([]);
  expect(Object.keys(scrollFxOf(code, 'fx') ?? {}).sort(), 'the dormant spec keeps all three').toEqual(['appear', 'hover', 'transform']);
  expect(await editor.newOracleViolations(), 'canvas: __e2e.checkFile clean').toEqual([]);

  // 4. Back into the page (sec-a): the hooks regenerate for it.
  await page.waitForTimeout(450);
  const before4 = await editor.code();
  await centerOn(editor, ['fx', 'sec-a']);
  const secA = await editor.nodeBox('sec-a');
  const a2b = await editor.nodeBox('a2');
  r = await pressNode(editor, 'fx');
  try {
    await r.d.moveTo({ x: secA.x + secA.width * 0.75, y: a2b.y + a2b.height * 0.75 }, 30);
    await r.d.hold(10);
  } finally { await drop(editor, r.d); }
  await expect.poll(() => editor.parentOf('fx')).toBe('sec-a');
  await expectEffectsInPage(editor, 'fx', 'back in the page');
  await expect(editor).toUndoInOneStep(before4);

  // All three still run in the preview: the Appear settles (opacity 0→1 times
  // the transform's 0.5 at scroll 0), Hover scales ×1.05, scrolling scrubs.
  const f = await openPreview(page, '[data-id="fx"]');
  const read = () => f.locator('[data-id="fx"]').evaluate(el => {
    const cs = getComputedStyle(el);
    const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
    return { opacity: Number(cs.opacity), scale: m.a, ty: m.f };
  });
  const settled = await pollFor(page, read, v => near(v.opacity, 0.5, 0.02) && near(v.ty, 0, 0.5), 8_000);
  expect(near(settled.opacity, 0.5, 0.02) && near(settled.scale, 0.5, 0.02) && near(settled.ty, 0, 0.5), `appear settled at the scroll-0 transform: ${JSON.stringify(settled)}`).toBe(true);
  const fb = (await f.locator('[data-id="fx"]').boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  const hovered = await pollFor(page, read, v => near(v.scale, 0.525, 0.004), 5_000);
  expect(near(hovered.scale, 0.525, 0.01), `hover scales ×1.05: ${hovered.scale}`).toBe(true);
  const frame = (await page.locator('iframe[src*="5175"]').boundingBox())!;
  await page.mouse.move(frame.x + 20, frame.y + frame.height / 2);
  await page.mouse.wheel(0, 800);
  const scrolled = await pollFor(page, read, v => v.opacity > 0.6, 6_000);
  expect(scrolled.opacity, 'scrolling scrubs the transform').toBeGreaterThan(0.6);
  expect(scrolled.scale).toBeGreaterThan(0.6);
});

// ─── DND-271 ──────────────────────────────────────────────────────────

test('DND-271 Alt-drag a node with Appear and a Scroll Transform: the copy gets its own effect identifiers and ref, both animate', { tag: ['@p1', '@dnd', '@preview'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: the Alt-drag duplicate of an animated node is a PLAIN <div> that copies ref={fxRef} and the source\'s motion values (scale: fxScale, opacity: fxOpacityC, y: fxYA) — a shared ref, no hooks of its own (oracle STYLE_PROP_NO_CONTROL)');
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(FX2_PAGE);
  const page = editor.page();
  await centerOn(editor, ['sec-a', 'sec-b']);
  const a2 = await editor.nodeBox('a2');
  const r = await pressNode(editor, 'fx');
  let dup = '';
  try {
    await r.d.moveBy(0, 20, 5);
    await engaged(editor, 'fx', r.box);
    await pressMidDrag(r.d, 'Alt', true);
    dup = (await pollFor(page, async () => dupIds(await editor.code()), ids => ids.length === 1, 3_000))[0];
    await r.d.moveTo({ x: a2.x + a2.width / 2 + 2, y: a2.y + a2.height * 0.85 }, 15);
    await r.d.hold(8);
  } finally {
    await drop(editor, r.d);
    await page.keyboard.up('Alt');
  }
  expect(dup, 'a duplicate was made').toBeTruthy();
  const code = await stableCode(editor);
  expect(parses(code), 'the file parses').toBe(true);
  const src = effectFacts(code, 'fx');
  const copy = effectFacts(code, dup);
  expect(src.ref).toBe('fxRef');
  expect(copy.tag, 'the copy is a motion element').toBe('motion.div');
  expect(copy.ref, 'the copy has a ref').not.toBeNull();
  expect(copy.ref, 'not the shared source ref').not.toBe(src.ref);
  const srcOwn = src.attrIdents.filter(n => n.startsWith('fx'));
  expect(copy.attrIdents.filter(n => srcOwn.includes(n)), 'no shared effect identifiers').toEqual([]);
  expect(src.dupDecls.concat(copy.dupDecls), 'no duplicate const').toEqual([]);
  expect(copy.undeclared).toEqual([]);
  expect(await editor.newOracleViolations()).toEqual([]);
  // Both animate in the preview.
  const f = await openPreview(page, '[data-id="fx"]');
  for (const id of ['fx', dup]) {
    const v = await pollFor(page, () => f.locator(`[data-id="${id}"]`).evaluate(el => Number(getComputedStyle(el).opacity)), o => near(o, 0.5, 0.02), 8_000);
    expect(near(v, 0.5, 0.02), `${id} appeared to the transform's 0.5 (${v})`).toBe(true);
  }
});

// ─── DND-272 ──────────────────────────────────────────────────────────

interface GlideShape { wrappers: number; childrenPerWrapper: number[]; layoutGroups: number; wrappedIds: string[] }

function glideShape(code: string, listId = 'list'): GlideShape {
  const ast = babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as any;
  const out: GlideShape = { wrappers: 0, childrenPerWrapper: [], layoutGroups: 0, wrappedIds: [] };
  const idOf = (el: any) => el.openingElement.attributes.find((a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-id')?.value?.value;
  const visit = (n: any, inList: boolean): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(c => visit(c, inList)); return; }
    let here = inList;
    if (n.type === 'JSXElement') {
      if (idOf(n) === listId) here = true;
      const name = n.openingElement.name;
      if (here && name.type === 'JSXIdentifier' && name.name === 'LayoutGroup') out.layoutGroups++;
      if (here && n.openingElement.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-glide-item')) {
        out.wrappers++;
        const kids = n.children.filter((c: any) => c.type === 'JSXElement');
        out.childrenPerWrapper.push(kids.length);
        for (const k of kids) { const id = idOf(k); if (id) out.wrappedIds.push(id); }
      }
    }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') visit(n[k], here);
  };
  visit(ast.program, false);
  return out;
}

test('DND-272 a glided list: reorder an item, then drag one out — one wrapper per child, one LayoutGroup, no husks', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  test.fail(!process.env.D5_NOFAIL, 'BUG: dragging an item out of a glided list leaves its empty <motion.div data-glide-item> wrapper behind in the list (a husk)');
  await editor.load(GLIDE_PAGE);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const before = await editor.code();

  // Reorder it1 below it3.
  const it3 = await editor.nodeBox('it3');
  let r = await pressNode(editor, 'it1');
  try {
    await r.d.moveTo({ x: it3.x + it3.width / 2 + 2, y: it3.y + it3.height * 0.85 }, 20);
    await engaged(editor, 'it1', r.box);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  let code = await stableCode(editor);
  expect(parses(code), 'parses after the reorder').toBe(true);
  expect(await visualOrderIn(editor, 'desktop', ['it1', 'it2', 'it3'])).toEqual(['it2', 'it3', 'it1']);
  let shape = glideShape(code);
  expect(shape, 'after the reorder').toEqual({ wrappers: 3, childrenPerWrapper: [1, 1, 1], layoutGroups: 1, wrappedIds: expect.arrayContaining(['it1', 'it2', 'it3']) });
  expect(await editor.newOracleViolations()).toEqual([]);
  expect(code).not.toBe(before);

  // Drag it2 out to the canvas.
  await page.waitForTimeout(450);
  const root = await editor.nodeBox('root');
  const p = await emptyCanvasPoint(editor, { x: root.x + root.width / 2, y: root.y + root.height + 60 }, 30);
  r = await pressNode(editor, 'it2');
  try {
    await r.d.moveTo(p, 30);
    await r.d.hold(8);
  } finally { await drop(editor, r.d); }
  await expect.poll(async () => (await editor.source()).byId.get('it2')?.attrs['data-canvas-node']).toBe('true');
  code = await stableCode(editor);
  expect(parses(code), 'parses after the drag-out').toBe(true);
  shape = glideShape(code);
  expect(shape.wrappedIds.sort(), 'the dragged-out item left its wrapper').toEqual(['it1', 'it3']);
  expect(shape.layoutGroups, 'one LayoutGroup').toBe(1);
  expect(shape.childrenPerWrapper, 'exactly one wrapper per remaining child (no husk)').toEqual([1, 1]);
  expect(await editor.newOracleViolations()).toEqual([]);
});

// ─── DND-273 ──────────────────────────────────────────────────────────

/** The Animation section's entries for the current selection (text between
 *  the section title and the next section). */
async function animationEntries(editor: Editor): Promise<string> {
  const txt = await editor.page().locator('[data-properties-panel]').innerText();
  const m = /Animation\n([\s\S]*?)\nLayout\n/.exec(txt);
  return m ? m[1] : '';
}

test.describe('on tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-273 a Tablet-only Hover and an Appear hidden on Mobile travel with the node into another parent', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(FX3_PAGE, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const fx0 = scrollFxOf(before, 'fx');
    const fb = await editor.nodeBox('fb');
    const r = await pressNode(editor, 'fx');
    try {
      await r.d.moveTo({ x: fb.x + fb.width * 0.4, y: fb.y + fb.height * 0.4 }, 30);
      await engaged(editor, 'fx', r.box);
      await r.d.hold(10);
    } finally { await drop(editor, r.d); }
    await expect.poll(() => editor.parentOf('fx')).toBe('fb');
    const code = await stableCode(editor);
    expect(parses(code)).toBe(true);
    // The per-tile branches are still on its tag, and their gates still declared once.
    const tag = (await editor.source()).byId.get('fx')!.attrs;
    expect(tag.whileHover.replace(/\s+/g, ' ')).toBe('__mq0 ? { scale: 1.1 } : undefined');
    expect(tag.initial.replace(/\s+/g, ' ')).toBe('__mq1 ? false : { opacity: 0, y: 30 }');
    expect(scrollFxOf(code, 'fx'), 'spec unchanged (hiddenOn + responsive hover)').toEqual(fx0);
    const facts = effectFacts(code, 'fx');
    expect(facts.decls.filter(d => d === '__mq0' || d === '__mq1').sort()).toEqual(['__mq0', '__mq1']);
    expect(facts.undeclared).toEqual([]);
    expect(code).toContain("useMediaQuery('(max-width: 768px) and (min-width: 375.02px)')");
    expect(code).toContain("useMediaQuery('(max-width: 375px)')");
    // After the move: Tablet still overrides (Hover listed there only), Mobile still hides the Appear.
    await page.waitForTimeout(450);
    const seen: Record<string, string> = {};
    for (const vp of ['tablet', 'mobile', 'desktop']) {
      await clickNode(editor, 'fx', { vpId: vp });
      expect(await editor.selection()).toEqual(['fx']);
      seen[vp] = await pollFor(page, () => animationEntries(editor), t => vp !== 'tablet' || t.includes('Hover'), 3_000);
    }
    expect(seen.tablet, 'Tablet: Appear + its Hover').toMatch(/Appear[\s\S]*Hover/);
    expect(seen.mobile.includes('Appear') || seen.mobile.includes('Hover'), `Mobile: nothing (${JSON.stringify(seen.mobile)})`).toBe(false);
    expect(seen.desktop.includes('Appear') && !seen.desktop.includes('Hover'), `Desktop: Appear only (${JSON.stringify(seen.desktop)})`).toBe(true);
    await expect(editor).toUndoInOneStep(before);
  });
});
