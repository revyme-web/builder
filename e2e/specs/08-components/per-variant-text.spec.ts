// CMP · Per-variant text: colour hoisting, per-variant content ternaries,
// rich variant runs and text effects on a connection-less master
// (E2E_TEST_PLAN.md §8, batch C5). Tiles: `desktop` = primary/default variant.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  masterSeed, masterModule, openMaster, clickIn, panel, row, topPopup, closePopup, setColorHex,
  stableCode, pollCode, variantEntry, styleTernary, openingTag, elementSource, parsesClean, computedIn,
  startTextEdit, clickAway, isTextEditing, astOf, walk,
} from '../../helpers/c5';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const CARD = 'components/Card.tsx';

const STATE_HEAD = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;
const STATE_HOOKS = `  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
`;

/** The colour a text node paints (its first inline run, else itself). */
async function textColorIn(editor: Parameters<typeof clickIn>[0], vpId: string, id: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  return loc.evaluate((el) => {
    let t: Element = el;
    while (t.firstElementChild) t = t.firstElementChild;
    return getComputedStyle(t).color;
  });
}

// ─── CMP-137 · span colour hoisted on a variant colour edit ──────────

const DARK_LIGHT_CONFIG = `const variantConfig = [
  { name: 'default', label: 'White', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Accent', x: 420, y: 0 },
  { name: 'variant-3', label: 'Dark', x: 840, y: 0 },
];`;

const SPAN_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '320px', height: '120px', backgroundColor: '#dddddd', ...style }}>
      <motion.p layout={true} data-id="label" data-name="Label" variants={labelVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', fontSize: '24px', margin: '0px' }}><motion.span style={{ color: 'rgb(21, 21, 21)' }}>CONTACT US</motion.span></motion.p>
    </motion.div>`, {
  config: DARK_LIGHT_CONFIG,
  pre: `const labelVariants = {
  default: { opacity: 1 },
  'variant-1': { color: '#ff0000' },
};`,
}));

test('CMP-137 a variant-3 text colour hoists the span colour to the <p> base; other tiles keep the colour they paint', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(SPAN_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const paintedBefore = {
    desktop: await textColorIn(editor, 'desktop', 'label'),
    'variant-1': await textColorIn(editor, 'variant-1', 'label'),
  };
  expect(paintedBefore.desktop).toBe('rgb(21, 21, 21)');

  await clickIn(editor, 'variant-3', 'label');
  expect(await editor.selection()).toEqual(['label']);
  await setColorHex(page, 'Color', '#ffffff');

  const code = await pollCode(editor, CARD, c => variantEntry(c, 'label', 'variant-3')?.color != null);
  expect(variantEntry(code, 'label', 'variant-3')?.color?.toLowerCase()).toBe('#ffffff');
  // The span colour moved to the <motion.p> base and left the span.
  expect((await editor.style('label', CARD)).color).toBe('rgb(21, 21, 21)');
  expect(elementSource(code, 'label')).not.toMatch(/<motion\.span style=\{\{\s*color/);
  expect(parsesClean(code)).toBe(true);
  // Tiles: variant-3 white; default and variant-1 paint what they painted before.
  await expect.poll(() => textColorIn(editor, 'variant-3', 'label')).toBe('rgb(255, 255, 255)');
  expect(await textColorIn(editor, 'desktop', 'label')).toBe(paintedBefore.desktop);
  expect(await textColorIn(editor, 'variant-1', 'label'), 'variant-1 keeps its painted colour').toBe(paintedBefore['variant-1']);
  // The default stays dark.
  const def = variantEntry(code, 'label', 'default');
  if (def?.color) expect(def.color).toBe('rgb(21, 21, 21)');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-138 · per-variant text ternary ──────────────────────────────

const STATE_CONFIG = `const variantConfig = [
  { name: 'default', label: 'White', x: 0, y: 0, isPrimary: true },
  { name: 'variant-3', label: 'Dark', x: 420, y: 0 },
];`;

const TEXT_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" variants={cardRootVariants} initial={['default', initialVariant]} animate={['default', variant]} {...rest} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '320px', height: '120px', backgroundColor: '#ffffff', ...style }}>
      <motion.p layout={true} data-id="label" data-name="Label" style={{ position: 'relative', fontSize: '24px', color: '#888888', margin: '0px' }}>CONTACT US</motion.p>
    </motion.div>`, {
  config: STATE_CONFIG, head: STATE_HEAD, hooks: STATE_HOOKS,
  pre: `const cardRootVariants = {
  default: { backgroundColor: '#ffffff' },
  'variant-3': { backgroundColor: '#111111' },
};`,
}));

test('CMP-138 a no-op edit on the Dark tile leaves the file byte-identical; typing writes a variant ternary', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(TEXT_MASTER);
  await openMaster(editor, CARD, 'variant-3');
  const before = await stableCode(editor, CARD);

  // No-op: double-click and click away without typing.
  await clickIn(editor, 'variant-3', 'label');
  await startTextEdit(editor, 'variant-3', 'label');
  await clickAway(editor);
  expect(await stableCode(editor, CARD), 'a no-op edit is byte-identical').toBe(before);

  // Real edit.
  await clickIn(editor, 'variant-3', 'label');
  await startTextEdit(editor, 'variant-3', 'label');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('REACH OUT');
  await clickAway(editor);
  const code = await pollCode(editor, CARD, c => c.includes('REACH OUT'));
  // `{variant === 'variant-3' ? 'REACH OUT' : 'CONTACT US'}` (quote style is the printer's).
  const br = textBranches(code, 'label')!;
  expect(br, 'a per-variant text ternary').not.toBeNull();
  expect(br.test).toMatch(/^variant === ["']variant-3["']$/);
  expect(br.cons).toBe('StringLiteral');
  expect(br.consSrc.slice(1, -1)).toBe('REACH OUT');
  expect(br.alt).toBe('StringLiteral');
  expect(br.altSrc.slice(1, -1)).toBe('CONTACT US');
  // Not: a `: ''` fallback blanking the other tiles.
  expect(code).not.toMatch(/'REACH OUT'\s*:\s*''/);
  expect(parsesClean(code)).toBe(true);
  await expect.poll(async () => (await (await editor.nodeIn('variant-3', 'label')).textContent())?.trim()).toBe('REACH OUT');
  expect((await (await editor.nodeIn('desktop', 'label')).textContent())?.trim(), 'the White tile is unchanged').toBe('CONTACT US');
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-139 · rich text on one variant ──────────────────────────────

const PLAIN_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '360px', height: '120px', backgroundColor: '#ffffff', ...style }}>
      <motion.p layout={true} data-id="label" data-name="Label" style={{ position: 'relative', fontSize: '24px', color: '#111111', margin: '0px' }}>Plain label here</motion.p>
    </motion.div>`));

/** The `cond ? a : b` text child of `id`: each branch's AST type and source. */
function textBranches(code: string, id: string): { test: string; cons: string; consSrc: string; alt: string; altSrc: string } | null {
  const ast = astOf(code);
  let out: { test: string; cons: string; consSrc: string; alt: string; altSrc: string } | null = null;
  walk(ast, (n) => {
    if (out || n.type !== 'JSXElement') return;
    const idAttr = (n.openingElement.attributes ?? []).find((a: any) => a.name?.name === 'data-id');
    if (idAttr?.value?.value !== id) return;
    for (const c of n.children ?? []) {
      if (c.type === 'JSXExpressionContainer' && c.expression.type === 'ConditionalExpression') {
        const e = c.expression;
        out = { test: code.slice(e.test.start, e.test.end), cons: e.consequent.type, consSrc: code.slice(e.consequent.start, e.consequent.end), alt: e.alternate.type, altSrc: code.slice(e.alternate.start, e.alternate.end) };
      }
    }
  });
  return out;
}

/** Font weight of the inline run holding `word` on a tile (the element's own weight when no run). */
async function wordWeightIn(editor: Parameters<typeof clickIn>[0], vpId: string, id: string, word: string): Promise<string> {
  const loc = await editor.nodeIn(vpId, id);
  return loc.evaluate((el, w) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.textContent ?? '').includes(w)) return getComputedStyle(n.parentElement!).fontWeight;
    }
    return '';
  }, word);
}

test('CMP-139 bolding one word on variant-1 writes a fragment branch; the default stays a string, survives reload', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: the builder's own rich per-variant text (`initialVariant === 'variant-1' ? <>Plain <strong>label</strong> here</> : '…'`) is rejected by its oracle — CONDITIONAL_RENDER_UNSUPPORTED treats an inline text run in a ternary branch as a conditional mount");
  const page = editor.page();
  await editor.load(PLAIN_MASTER);
  await openMaster(editor);
  const before = await stableCode(editor, CARD);

  await clickIn(editor, 'variant-1', 'label');
  await startTextEdit(editor, 'variant-1', 'label');
  // Select the word "label" inside the editor and bold it.
  const ed = editor.sandbox().locator('[contenteditable="true"]').first();
  const pt = await ed.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf('label');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 5);
      const sel = window.getSelection()!;
      sel.removeAllRanges(); sel.addRange(r);
      return true;
    }
    return false;
  });
  expect(pt).toBe(true);
  await page.keyboard.press('ControlOrMeta+b');
  await clickAway(editor);

  const code = await pollCode(editor, CARD, c => textBranches(c, 'label') != null);
  const br = textBranches(code, 'label')!;
  expect(br.cons, 'variant-1 branch is a fragment of runs').toBe('JSXFragment');
  // The bold run is a mark element (`<strong>`) or an object-styled span — never a string style.
  expect(br.consSrc).toMatch(/<strong>label<\/strong>|<span style=\{\{[^}]*fontWeight[^}]*\}\}>label<\/span>/);
  expect(br.consSrc).not.toMatch(/style="/);
  expect(br.alt, 'the default branch stays a string').toBe('StringLiteral');
  expect(br.altSrc.slice(1, -1)).toBe('Plain label here');
  expect(parsesClean(code)).toBe(true);
  await expect.poll(() => wordWeightIn(editor, 'variant-1', 'label', 'label')).toMatch(/^(700|bold)$/);
  expect(await wordWeightIn(editor, 'desktop', 'label', 'label')).not.toMatch(/^(700|bold)$/);
  // No phantom span nodes: the label still has no element children in the node map.
  const kids = await page.evaluate(() => {
    const snap = (window as any).__e2e.nodesSnapshot?.();
    const n = snap?.get ? snap.get('label') : snap?.label;
    return n?.children ?? [];
  });
  expect(kids, 'no phantom run nodes').toEqual([]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // Reload: bold only on variant-1.
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  await openMaster(editor);
  await expect.poll(() => wordWeightIn(editor, 'variant-1', 'label', 'label'), { timeout: 15_000 }).toMatch(/^(700|bold)$/);
  expect(await wordWeightIn(editor, 'desktop', 'label', 'label')).not.toMatch(/^(700|bold)$/);
  expect(textBranches(await editor.code(CARD), 'label')?.alt).toBe('StringLiteral');
  // The builder must pass its own oracle.
  await expect(editor).toPassOracle();
});

// ─── CMP-140 · text effect on a connection-less master ───────────────

const FX_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', width: '320px', height: '160px', backgroundColor: '#111827', ...style }}>
      <motion.p layout={true} data-id="title" data-name="Title" style={{ position: 'relative', fontSize: '28px', color: '#ffffff', margin: '0px' }}>Hello world</motion.p>
    </motion.div>`));

/** The `spec={{…}}` source of the split-text wrapper inside `id` and its `variant` attr. */
function splitText(code: string, id: string): { tag: string; spec: string; variant: string | null } | null {
  const src = elementSource(code, id);
  const m = /<(RevymeSplitText)\b([^>]*?)>/s.exec(src);
  if (!m) return null;
  const attrs = m[2];
  const v = /\bvariant=\{([^}]+)\}/.exec(attrs);
  const specStart = attrs.indexOf('spec={');
  return { tag: m[1], spec: specStart >= 0 ? attrs.slice(specStart) : '', variant: v ? v[1].trim() : null };
}

const SCOPE_V1 = /scope:\s*\{\s*variant:\s*"variant-1"\s*\}/;

/** The `config: {…}` text of the responsive scope for `variant` ('' when absent). */
function scopeConfig(spec: string, variant: string): string {
  const i = spec.search(new RegExp(`scope:\\s*\\{\\s*variant:\\s*"${variant}"\\s*\\}`));
  if (i < 0) return '';
  const j = spec.indexOf('config:', i);
  return braced(spec, spec.indexOf('{', j));
}

/** The base spec text, with the `responsive: [...]` scopes cut out. */
function baseConfig(spec: string): string {
  const i = spec.indexOf('responsive:');
  return i < 0 ? spec : spec.slice(0, i);
}

function braced(s: string, open: number): string {
  let d = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return s.slice(open, k + 1); }
  }
  return '';
}

test('CMP-140 a text effect on a connection-less master: variant-1 gets its own scope and × disables it there only', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(FX_MASTER);
  await openMaster(editor);

  // Add the Text effect on the default tile.
  await clickIn(editor, 'desktop', 'title');
  expect(await editor.selection()).toEqual(['title']);
  await panel(page).locator('button[title="Add animation effect"]').click();
  await page.locator('button[title="Character/word/line stagger via Motion."]').click();
  let code = await pollCode(editor, CARD, c => splitText(c, 'title') != null);
  await closePopup(page);
  expect(splitText(code, 'title')).not.toBeNull();

  // On variant-1: change a popup VALUE (Opacity; Split/Play are structural and fold into the base).
  await clickIn(editor, 'variant-1', 'title');
  expect(await editor.selection()).toEqual(['title']);
  const fxRow = row(page, 'Text');
  await expect(fxRow).toContainText('character');
  await fxRow.locator('button[type="button"]').first().click();
  const op = topPopup(page).locator('[data-tool-row]:has(span[title="Opacity"]) input').first();
  await op.click();
  await op.press('ControlOrMeta+a');
  await op.fill('0.5');
  await op.press('Enter');
  await closePopup(page);
  code = await pollCode(editor, CARD, c => SCOPE_V1.test(splitText(c, 'title')?.spec ?? '') && /opacity:\s*0\.5/.test(splitText(c, 'title')?.spec ?? ''));
  let st = splitText(code, 'title')!;
  // The wrapper reads the connection-less `initialVariant` (no undefined `variant`).
  expect(st.variant).toBe('initialVariant');
  expect(code).not.toMatch(/variant=\{variant\}/);
  expect(scopeConfig(st.spec, 'variant-1'), 'variant-1 owns a scoped entry').toMatch(/opacity:\s*0\.5/);
  expect(baseConfig(st.spec), 'the base keeps its own value').toMatch(/opacity:\s*0[,\s]/);
  expect(parsesClean(code)).toBe(true);

  // × on variant-1 disables the effect there only.
  const before = await stableCode(editor, CARD);
  await row(page, 'Text').getByText('×', { exact: true }).click();
  code = await pollCode(editor, CARD, c => /disabled:\s*true/.test(scopeConfig(splitText(c, 'title')?.spec ?? '', 'variant-1')));
  st = splitText(code, 'title')!;
  expect(scopeConfig(st.spec, 'variant-1')).toMatch(/disabled:\s*true/);
  expect(baseConfig(st.spec), 'the default keeps its effect').not.toMatch(/disabled:\s*true/);
  expect(st.variant).toBe('initialVariant');
  expect(parsesClean(code)).toBe(true);
  // The default tile still shows the effect row.
  await clickIn(editor, 'desktop', 'title');
  await expect(row(page, 'Text')).toContainText('character');
  // No blocked-write message.
  const blocked = await page.evaluate(() => ((window as any).__e2e.traceEntries('blocked|validate:fail|write-rejected') ?? []).length);
  expect(blocked).toBe(0);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});
