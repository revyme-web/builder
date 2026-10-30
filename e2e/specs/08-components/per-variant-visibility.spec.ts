// CMP · Per-variant visibility: Hide control, Layers eye, AnimatePresence gates
// (E2E_TEST_PLAN.md §8, batch C4). Tiles of an open master: `desktop` is the
// primary (default variant), every other tile is its variant name.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  CARD, cardProject, openMaster, pollCode, stableCode, attrSource, computedIn, shownIn, mentions, objectConsts,
  setHide, hideValue, hideOverridden, selectViaLayers, toggleEye, variantConfigOf,
  previewPage, clickPreview, PREVIEW_NOISE, PAGE,
} from '../../helpers/c4';
import { clickStable, parsesClean, openingTag, elementSource, setFillHex, variantsOf } from '../../helpers/c5';
import { conditionalAround, variantsConst } from '../../helpers/d4';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

async function selectNode(editor: Editor, vpId: string, id: string, fx = 0.5, fy = 0.5): Promise<void> {
  await editor.page().waitForTimeout(450);
  await clickStable(editor, id, vpId, fx, fy);
  await expect.poll(() => editor.selection()).toEqual([id]);
}

const HEAD = (hooks = false) => `'use client';

/** @name "Card" */

import React${hooks ? ', { useState, useEffect }' : ''} from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

// ─── CMP-162 ─────────────────────────────────────────────────────────

const PANEL_CARD = `${HEAD()}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-5', label: 'Compact', x: 600, y: 0 },
];

const cardPanelVariants = {
  default: { display: 'flex' }
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: 'auto', overflow: 'hidden', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <motion.div layout={true} data-id="card-panel" data-name="Panel" variants={cardPanelVariants} style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '8px', width: '200px', height: '40px', backgroundColor: '#000000', flex: '0 0 auto', order: '1' }}>
        <motion.div layout={true} data-id="card-dot" data-name="Dot" style={{ position: 'relative', width: '20px', height: '20px', backgroundColor: '#ffffff', flex: '0 0 auto', order: '0' }} />
      </motion.div>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

test('CMP-162 Hide → Yes on the variant-5 tile gates the child in AnimatePresence and hides only that tile\'s copy', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(PANEL_CARD));
  await openMaster(editor, CARD, 'variant-5');
  const before = await editor.code(CARD);

  await selectNode(editor, 'variant-5', 'card-panel', 0.8, 0.5);
  expect(await hideValue(page)).toBe('No');
  await setHide(editor, 'Yes');

  const code = await pollCode(editor, CARD, c => conditionalAround(c, 'card-panel') !== null);
  expect(conditionalAround(code, 'card-panel')).toMatch(/^initialVariant !== ["']variant-5["']$/);
  // `<AnimatePresence mode="popLayout">{… && <el key="…" layout/>}</AnimatePresence>`
  expect(code).toMatch(/<AnimatePresence mode="popLayout">\s*\{initialVariant !== ["']variant-5["'] &&\s*\(?\s*<motion\.div[^>]*data-id="card-panel"/);
  const tag = openingTag(code, 'card-panel');
  expect(tag).toMatch(/key="card-panel"/);
  expect(tag).toMatch(/layout=\{true\}/);
  expect(variantsConst(code, 'cardPanelVariants')!.default, 'the default entry keeps its display').toEqual({ display: 'flex' });
  expect(parsesClean(code)).toBe(true);

  // Not: hidden live but visible on the canvas tile (the default entry's display:flex must not win).
  await expect.poll(() => computedIn(editor, 'variant-5', 'card-panel', 'display')).toBe('none');
  expect(await computedIn(editor, 'desktop', 'card-panel', 'display')).toBe('flex');
  // The Hide label is the purple per-variant override on variant-5.
  await expect.poll(() => hideValue(page)).toBe('Yes');
  expect(await hideOverridden(page)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-163 ─────────────────────────────────────────────────────────

/** node-x held hidden three ways: a `variant !== "default"` gate, an inline
 *  display:'none' and a default-entry display:'none'. */
const TRIPLE_HIDDEN = `${HEAD(true)}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
  { name: 'variant-2', label: 'Wide', x: 1200, y: 0 },
];

const nodeXVariants = {
  default: { display: 'none', backgroundColor: '#ff0000' },
  'variant-1': { backgroundColor: '#00aa00' }
};

const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click' },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onTap={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }} layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }} animate={['default', variant]}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <AnimatePresence mode="popLayout">
        {variant !== "default" &&
          <motion.div layout={true} key="node-x" data-id="node-x" data-name="X" variants={nodeXVariants} style={{ position: 'relative', width: '80px', height: '30px', backgroundColor: '#ff0000', display: 'none', flex: '0 0 auto', order: '1' }} exit={{ opacity: 0 }} animate={['default', variant]} />
        }
      </AnimatePresence>
    </motion.div>
    </LayoutGroup>);

}

export default withResponsiveProps(Card);
`;

/** No display:'none' left in any channel of node-x (inline style or variants entry). */
function noneChannels(code: string): string[] {
  const out: string[] = [];
  if (/display:\s*['"]none['"]/.test(openingTag(code, 'node-x'))) out.push('inline');
  for (const [k, v] of Object.entries(variantsConst(code, 'nodeXVariants') ?? {})) if (v.display === 'none') out.push(`entry:${k}`);
  return out;
}

test('CMP-163 unhiding on variant-1 clears every display:none channel; Hide → Yes again writes only the gate (Hide control, then the eye)', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(TRIPLE_HIDDEN));
  await openMaster(editor);
  const seedCode = await editor.code(CARD);
  expect(noneChannels(seedCode), 'seed sanity').toEqual(['inline', 'entry:default']);

  const checkUnhidden = async (via: string) => {
    const code = await pollCode(editor, CARD, c => noneChannels(c).length === 0);
    expect(noneChannels(code), `${via}: every display:none channel is gone`).toEqual([]);
    // Sibling props are kept.
    expect(openingTag(code, 'node-x')).toMatch(/width: '80px'/);
    expect(variantsConst(code, 'nodeXVariants')!.default, `${via}: the default entry keeps its other props`).toEqual({ backgroundColor: '#ff0000' });
    // Still gated off default.
    expect(conditionalAround(code, 'node-x')).toMatch(/^variant !== ["']default["']$/);
    expect(parsesClean(code)).toBe(true);
    // Not: the toggle changing nothing on the canvas.
    await expect.poll(() => shownIn(editor, 'variant-1', 'node-x'), { message: `${via}: visible on variant-1` }).toBe(true);
    expect(await shownIn(editor, 'variant-2', 'node-x')).toBe(true);
    expect(await shownIn(editor, 'desktop', 'node-x')).toBe(false);
    return code;
  };

  // 1. Hide → No on variant-1 (the node is hidden: select it through Layers).
  await selectViaLayers(editor, 'node-x', 'variant-1');
  await expect.poll(() => editor.selection()).toEqual(['node-x']);
  expect(await hideValue(page)).toBe('Yes');
  await setHide(editor, 'No');
  const unhidden = await checkUnhidden('Hide → No');
  await expect(editor).toUndoInOneStep(seedCode, { path: CARD });

  // Hide → Yes again on variant-1 writes only the gate.
  await setHide(editor, 'Yes');
  const rehidden = await pollCode(editor, CARD, c => /variant-1/.test(conditionalAround(c, 'node-x') ?? ''));
  const gate = conditionalAround(rehidden, 'node-x')!;
  expect(gate === `variant === "variant-2"` || gate === `variant === 'variant-2'` || /variant !== ["']default["'] && variant !== ["']variant-1["']/.test(gate), `gate: ${gate}`).toBe(true);
  expect(noneChannels(rehidden), 'no display:none written back').toEqual([]);
  await expect.poll(() => shownIn(editor, 'variant-1', 'node-x')).toBe(false);
  expect(await shownIn(editor, 'variant-2', 'node-x')).toBe(true);

  // 2. Back to the seed, then unhide on variant-1 with the Layers eye.
  await editor.undo();
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(seedCode);
  await toggleEye(editor, 'node-x', 'variant-1');
  // The eye unhides over a BASE display:none with an explicit display in the
  // variant-1 entry (LayersPanel's unhide-over-base-none path) — it does not
  // clear the base channels the way Hide → No does.
  const eyed = await pollCode(editor, CARD, c => variantsConst(c, 'nodeXVariants')?.['variant-1']?.display != null);
  expect(variantsConst(eyed, 'nodeXVariants')!['variant-1']).toEqual({ backgroundColor: '#00aa00', display: 'block' });
  expect(noneChannels(eyed), 'the base channels stay').toEqual(['inline', 'entry:default']);
  expect(conditionalAround(eyed, 'node-x'), 'still gated off default').toMatch(/^variant !== ["']default["']$/);
  expect(parsesClean(eyed)).toBe(true);
  // Not: the eye toggling with no visible change.
  await expect.poll(() => shownIn(editor, 'variant-1', 'node-x')).toBe(true);
  expect(await shownIn(editor, 'desktop', 'node-x')).toBe(false);
  await expect(page.locator('[data-layer-id="variant-1:node-x"] button[title="Hide layer"]')).toHaveCount(1);
  await expect(editor).toUndoInOneStep(seedCode, { path: CARD });
  expect(unhidden.length).toBeGreaterThan(0);
});

// ─── CMP-164 ─────────────────────────────────────────────────────────

/** A master holding an overlay behind its own open-state gate `{ovOpen && (…)}`. */
const OVERLAY_CARD = `${HEAD().replace("import React from 'react';", "import React, { useState } from 'react';")}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [ovOpen, setOvOpen] = useState(false);
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: 'auto', overflow: 'hidden', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.div layout={true} data-id="card-trig" data-name="Trigger" data-overlay-trigger='{"targetId":"ov-1","trigger":"click","dismiss":"outside"}' onClick={() => setOvOpen(!ovOpen)} style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#663399', flex: '0 0 auto', order: '0' }} />
      <AnimatePresence>{ovOpen && (
        <motion.div key="ov-1" data-id="ov-1" data-name="Menu" data-overlay='{"type":"relative","triggerId":"card-trig","side":"bottom","align":"center","offsetX":0,"offsetY":8}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ffcc33' }}>
          <p data-id="ov-1-text" data-name="Menu Text" style={{ position: 'relative', color: '#000000', margin: '0px' }}>Menu</p>
        </motion.div>
      )}</AnimatePresence>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

/** The full left side of the overlay's `{… && (` gate. */
const overlayGate = (code: string) => conditionalAround(code, 'ov-1');

test('CMP-164 hiding an overlay per variant keeps its open-state gate; hidden everywhere = ovOpen && false', { tag: ['@p1', '@cmp', '@tiles', '@preview'] }, async ({ editor }) => {
  const page = editor.page();
  editor.allowErrors(PREVIEW_NOISE);
  await editor.load(cardProject(OVERLAY_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);
  // Overlay-edit mode draws the overlay on every tile (setup).
  await page.evaluate(() => (window as any).__e2e.openOverlay('ov-1'));
  await expect.poll(() => shownIn(editor, 'variant-1', 'ov-1')).toBe(true);

  // 1. Hide on variant-1: the variant test is ANDed into the open-state gate.
  await selectNode(editor, 'variant-1', 'ov-1', 0.5, 0.8);
  await setHide(editor, 'Yes');
  const hidden = await pollCode(editor, CARD, c => /variant-1/.test(overlayGate(c) ?? ''));
  expect(overlayGate(hidden)).toMatch(/^ovOpen && initialVariant !== ["']variant-1["']$/);
  expect((hidden.match(/<AnimatePresence/g) ?? []).length, 'no second wrapper').toBe(1);
  await expect.poll(() => shownIn(editor, 'variant-1', 'ov-1')).toBe(false);
  expect(await shownIn(editor, 'desktop', 'ov-1')).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // 2. Unhide restores the bare open-state gate.
  await setHide(editor, 'No');
  const unhidden = await pollCode(editor, CARD, c => overlayGate(c) === 'ovOpen');
  expect(overlayGate(unhidden)).toBe('ovOpen');
  expect(unhidden).toContain('<AnimatePresence>');
  await expect.poll(() => shownIn(editor, 'variant-1', 'ov-1')).toBe(true);

  // 3. Hidden on every variant (Hide on the primary): `{ovOpen && false && …}`; the primary hides too.
  await selectNode(editor, 'desktop', 'ov-1', 0.5, 0.8);
  await setHide(editor, 'Yes');
  const all = await pollCode(editor, CARD, c => /false/.test(overlayGate(c) ?? ''));
  expect(overlayGate(all)).toBe('ovOpen && false');
  expect(parsesClean(all)).toBe(true);
  await expect.poll(() => shownIn(editor, 'desktop', 'ov-1')).toBe(false);
  expect(await shownIn(editor, 'variant-1', 'ov-1')).toBe(false);

  // Back to the unhidden gate: live, the overlay mounts only once its trigger opens it.
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(unhidden);
  await page.evaluate(() => (window as any).__e2e.openOverlay(null));
  const frame = await previewPage(editor, PAGE, '[data-id="card-a"]');
  await page.waitForTimeout(1_000);
  // Not: an always-mounted overlay.
  expect(await frame.locator('[data-id="ov-1"]').count(), 'closed overlay is not mounted').toBe(0);
  await clickPreview(editor, frame, '[data-id="card-a"] [data-id="card-trig"]');
  await expect.poll(() => frame.locator('[data-id="ov-1"]').count(), { timeout: 10_000 }).toBeGreaterThan(0);
});

// ─── CMP-165 ─────────────────────────────────────────────────────────

const MULTILINE_CARD = `${HEAD()}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Open', x: 600, y: 0 },
];

const divVariants = {
  default: {
    backgroundColor: '#000000'
  },
  'variant-1': {
    backgroundColor: '#ffffff'
  }
};

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <AnimatePresence mode="popLayout">
        {initialVariant !== 'variant-1' &&
          <motion.div layout={true} key="div" data-id="div" data-name="Div" variants={divVariants} style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#000000', flex: '0 0 auto', order: '1' }} exit={{ opacity: 0 }} />
        }
      </AnimatePresence>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

test('CMP-165 deleting a node with a multi-line variants const removes the whole const and its empty AnimatePresence', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(cardProject(MULTILINE_CARD));
  await openMaster(editor);
  const before = await editor.code(CARD);

  // Select it from the Layers panel, then Delete.
  await selectViaLayers(editor, 'div', 'desktop');
  await expect.poll(() => editor.selection()).toEqual(['div']);
  await page.keyboard.press('Delete');
  const code = await pollCode(editor, CARD, c => !/data-id="div"/.test(c));
  expect(code).not.toMatch(/data-id="div"/);
  expect(objectConsts(code), 'the whole const is removed').not.toContain('divVariants');
  expect(code).not.toMatch(/divVariants/);
  expect(parsesClean(code), 'no stray `};`').toBe(true);
  expect(code).not.toMatch(/\n\s*\};\s*\n\s*\};/);
  expect(code, 'no empty AnimatePresence left').not.toMatch(/<AnimatePresence[^>]*>\s*<\/AnimatePresence>/);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // The next edit is accepted (not "AI changes blocked").
  await editor.fitCamera();
  await page.waitForTimeout(450);
  await clickStable(editor, 'card-title', 'desktop');
  await expect.poll(() => editor.selection()).toEqual(['card-title']);
  await page.waitForTimeout(450);
  await clickStable(editor, 'card-root', 'desktop', 0.5, 0.95);
  await expect.poll(() => editor.selection()).toEqual(['card-root']);
  await setFillHex(page, '#00ff00');
  const edited = await pollCode(editor, CARD, c => /#00ff00/i.test(c));
  expect(edited).toMatch(/#00ff00/i);
  await expect.poll(() => computedIn(editor, 'desktop', 'card-root', 'background-color')).toBe('rgb(0, 255, 0)');
});

// ─── CMP-166 ─────────────────────────────────────────────────────────

const THREE_VARIANTS = `${HEAD()}
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'One', x: 600, y: 0 },
  { name: 'variant-2', label: 'Two', x: 1200, y: 0 },
];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', height: '200px', padding: '24px', backgroundColor: '#97cffc', ...style }}>
      <motion.p layout={true} data-id="card-title" data-name="Title" style={{ position: 'relative', fontSize: '20px', color: '#000000', margin: '0px', flex: '0 0 auto', order: '0' }}>Title</motion.p>
      <motion.div layout={true} data-id="card-badge" data-name="Badge" style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#000000', flex: '0 0 auto', order: '1' }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

test('CMP-166 hiding a node on the primary hides it on every variant and every tile\'s Hide reads Yes', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: Hide on the master primary writes the "hidden everywhere" gate `{false && <el/>}`, which the builder\'s own oracle rejects (CONDITIONAL_RENDER_UNSUPPORTED — it only accepts variant comparisons)');
  const page = editor.page();
  await editor.load(cardProject(THREE_VARIANTS));
  await openMaster(editor, CARD, 'variant-2');
  const before = await editor.code(CARD);

  await selectNode(editor, 'desktop', 'card-badge');
  await setHide(editor, 'Yes');
  const code = await pollCode(editor, CARD, c => conditionalAround(c, 'card-badge') !== null);
  expect(conditionalAround(code, 'card-badge'), 'hidden on every variant, default included').toBe('false');
  expect(openingTag(code, 'card-badge')).not.toMatch(/display:\s*'none'/);
  for (const vp of ['desktop', 'variant-1', 'variant-2']) {
    await expect.poll(() => shownIn(editor, vp, 'card-badge'), { message: `hidden on ${vp}` }).toBe(false);
  }
  // The toggle reads Yes on the primary right away…
  await expect.poll(() => hideValue(page)).toBe('Yes');
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // …and on each tile once selected there (through Layers: the copies are hidden).
  for (const vp of ['variant-1', 'variant-2', 'desktop']) {
    await selectViaLayers(editor, 'card-badge', vp);
    await expect.poll(() => editor.selection()).toEqual(['card-badge']);
    await expect.poll(() => hideValue(page), { message: `Hide reads Yes on ${vp}` }).toBe('Yes');
  }
  // The builder's own "hidden on every variant" form passes its oracle.
  await expect(editor).toPassOracle();
});
