// CMP · Per-variant layout, position and structure on component masters:
// variant-only layouts, layout add/remove, arrow nudges, pins, live mirroring,
// per-variant order, hidden nodes, clones, drag in/out and handle resolution
// (E2E_TEST_PLAN.md §8, batch C5). Tiles: `desktop` = primary/default variant.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  masterSeed, masterModule, openMaster, clickIn, panel, row, label, topPopup, closePopup,
  stableCode, pollCode, variantEntry, variantsOf, styleTernary, openingTag, elementSource, tagOf, parsesClean,
  computedIn, boxIn, resizeBy, traces, rafs, center, glide, pump, gesture, prime, visualOrderIn, displayIn, idCount,
  pinButton, pinActive, pinField, CONFIG_3V, layersDrag, layerRow, expandLayerVariant, astOf, walk,
} from '../../helpers/c5';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

const CARD = 'components/Card.tsx';

/** Strategy names of every drag started after the first `since` ones. */
async function strategiesSince(editor: Parameters<typeof clickIn>[0], since: number): Promise<string[]> {
  return (await traces(editor, '^drag:start$')).slice(since).map(t => t.data?.strategy ?? '');
}
async function now(editor: Parameters<typeof clickIn>[0]): Promise<number> {
  return (await traces(editor, '^drag:start$')).length;
}

// ─── CMP-131 · a layout that exists on variant-2 only ────────────────

const V2_LAYOUT_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', width: '320px', height: 'auto', backgroundColor: '#000000', ...style }}>
      <motion.div layout={true} data-id="flexy" data-name="Flexy" variants={flexyVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '100%', height: '160px', backgroundColor: '#222244', flex: '0 0 auto', flexDirection: initialVariant === 'variant-2' ? 'row' : 'row', gap: initialVariant === 'variant-2' ? '10px' : '0px' }}>
        <motion.div layout={true} data-id="k1" data-name="K1" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
        <motion.div layout={true} data-id="k2" data-name="K2" style={{ position: 'relative', width: '60px', height: '60px', backgroundColor: '#33cc88', flex: '0 0 auto' }} />
      </motion.div>
    </motion.div>`, {
  config: CONFIG_3V,
  // The shape Add Layout writes on a variant tile: display in the variants
  // object, the flex props as ternaries with CSS-initial else branches.
  pre: `const flexyVariants = {
  default: {},
  'variant-2': { display: 'flex' },
};`,
}));

test('CMP-131 a variant-2-only layout reads as a layout on variant-2 alone, and its children reorder there only', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(V2_LAYOUT_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // Default: the neutral else-branches are not read as a layout.
  await clickIn(editor, 'desktop', 'flexy', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['flexy']);
  await expect(panel(page).locator('button[title="Add Layout"]')).toBeVisible();
  await expect(panel(page).locator('button[title="Remove Layout"]')).toHaveCount(0);

  // Variant-2: the Layout tool shows the flex layout.
  await clickIn(editor, 'variant-2', 'flexy', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['flexy']);
  await expect(panel(page).locator('button[title="Remove Layout"]')).toBeVisible();
  await expect(row(page, 'Gap').locator('input').first()).toHaveValue('10');

  // Dragging k2 before k1 on variant-2 uses the layout (reorder) strategy.
  let t0 = await now(editor);
  await prime(editor, 'k2', 'variant-2');
  const k1 = await editor.nodeBoxIn('variant-2', 'k1');
  const k2 = await editor.nodeBoxIn('variant-2', 'k2');
  await gesture(editor, center(k2), [{ x: k1.x + 3, y: k1.y + k1.height / 2 }], {
    atWaypoint: async () => {
      expect(await editor.sandbox().locator('[data-viewport="variant-2"] [data-placeholder-id]').count(), 'a reorder placeholder on variant-2').toBeGreaterThan(0);
    },
  });
  const v2Strategies = await strategiesSince(editor, t0);
  const orderOn = (code: string, id: string, v: string) => { const t = styleTernary(code, id, 'order'); return t ? (t.branches[v] ?? t.branches.default) : null; };
  await expect.poll(async () => orderOn(await editor.code(CARD), 'k2', 'variant-2')).toBe('0');
  expect(orderOn(await editor.code(CARD), 'k1', 'variant-2')).toBe('1');
  await expect.poll(() => visualOrderIn(editor, 'variant-2', ['k1', 'k2'])).toEqual(['k2', 'k1']);
  expect(await visualOrderIn(editor, 'desktop', ['k1', 'k2'])).toEqual(['k1', 'k2']);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // The same gesture on the default tile is NOT a layout reorder (only the strategy matters; the drop is undone).
  t0 = await now(editor);
  await prime(editor, 'k2', 'desktop');
  const d1 = await editor.nodeBoxIn('desktop', 'k1');
  const d2 = await editor.nodeBoxIn('desktop', 'k2');
  await gesture(editor, center(d2), [{ x: d1.x + 3, y: d1.y + d1.height / 2 }], {
    release: false,
    atWaypoint: async () => {
      expect(await editor.sandbox().locator('[data-viewport="desktop"] [data-placeholder-id]').count(), 'no reorder placeholder on default').toBe(0);
    },
  });
  await page.mouse.up();
  await editor.settled();
  const defStrategies = await strategiesSince(editor, t0);
  expect(v2Strategies.length).toBeGreaterThan(0);
  expect(defStrategies.length).toBeGreaterThan(0);
  expect(defStrategies[0], `default drag strategy vs variant-2 (${v2Strategies[0]})`).not.toBe(v2Strategies[0]);
  expect(styleTernary(await stableCode(editor, CARD), 'k2', 'order'), 'no order written on the default tile').toBeNull();
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
});

// ─── CMP-132 · Add Layout on a root whose child is offset on variant-2 ──

const OFFSET_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '200px', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="chip" data-name="Chip" variants={chipVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '10px', top: '10px', width: '60px', height: '40px', backgroundColor: '#ff2d75' }} />
    </motion.div>`, {
  config: CONFIG_3V,
  pre: `const chipVariants = {
  default: { backgroundColor: '#ff2d75' },
  'variant-2': { left: '40px', top: '12px', width: '90px', rotate: 15 },
};`,
}));

test('CMP-132 Add Layout on the root strips every variant inset of its absolute child; width and rotate stay', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: Add Layout on a master root whose absolute child has insets only in its variant-2 entry strips them but splices a double comma into the child's default entry (`flex: '0 0 auto', , width: '60px'`) — the master no longer parses");
  const page = editor.page();
  await editor.load(OFFSET_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await clickIn(editor, 'desktop', 'card-root', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['card-root']);
  await panel(page).locator('button[title="Add Layout"]').click();

  const code = await pollCode(editor, CARD, c => c !== before && (!parsesClean(c) || /display:\s*'flex'/.test(c)));
  // Never unparseable source (the double comma `, ,` spliced into the default entry).
  expect(parsesClean(code), 'the file parses after Add Layout').toBe(true);
  expect(code).not.toMatch(/,\s*,/);
  expect(/display:\s*'flex'/.test(openingTag(code, 'card-root')) || variantEntry(code, 'card-root', 'default')?.display === 'flex', 'the root becomes flex').toBe(true);
  const v2 = variantEntry(code, 'chip', 'variant-2')!;
  expect(v2.left, 'insets stripped from the variant-2 entry').toBeUndefined();
  expect(v2.top).toBeUndefined();
  expect(v2.width).toBe('90px');
  expect(v2.rotate).toBe('15');
  for (const [name, entry] of Object.entries(variantsOf(code, 'chip') ?? {})) {
    expect(entry.left, `${name}.left`).toBeUndefined();
    expect(entry.top, `${name}.top`).toBeUndefined();
    expect(entry.position, `${name}.position`).toBeUndefined();
  }
  const base = await editor.style('chip', CARD);
  expect(base.position ?? 'relative').toBe('relative');
  expect(base.left).toBeUndefined();
  expect(base.top).toBeUndefined();
  expect(parsesClean(code)).toBe(true);
  // The child sits in flow on variant-2 (not still offset by 40/12).
  await expect.poll(() => computedIn(editor, 'variant-2', 'chip', 'position')).not.toBe('absolute');
  const root = (await boxIn(editor, 'variant-2', 'card-root'))!;
  const chip = (await boxIn(editor, 'variant-2', 'chip'))!;
  const zoom = root.width / 320;
  expect(Math.abs((chip.x - root.x) / zoom), 'no left offset left on variant-2').toBeLessThan(25);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-133 · Remove Layout fully, incl. a parent of order-first instances ──

const BADGE = masterModule(`
    <motion.div layout={true} data-id="badge-root" data-name="Badge" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '60px', height: '24px', backgroundColor: '#ffcc33', ...style }} />`, {
  name: 'Badge', config: `const variantConfig = [{ name: 'default', label: 'Badge', x: 0, y: 0, isPrimary: true }];`,
});
const LAYOUT_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', padding: '20px', width: '320px', height: 'auto', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="list" data-name="List" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '8px', width: '100%', height: '60px', backgroundColor: '#222244' }}>
        <Badge data-id="b1" data-name="Badge" style={{ order: '0', position: 'relative', flex: '0 0 auto' }} />
        <Badge data-id="b2" data-name="Badge" style={{ order: '1', position: 'relative', flex: '0 0 auto' }} />
      </motion.div>
      <motion.div layout={true} data-id="cell" data-name="Cell" style={{ position: 'relative', width: '100%', height: '60px', backgroundColor: '#333366' }} />
    </motion.div>`, { config: CONFIG_3V }).replace("import { withResponsiveProps } from '@revyme/runtime';", "import { withResponsiveProps } from '@revyme/runtime';\nimport Badge from '@/components/Badge';"),
{ 'components/Badge.tsx': BADGE });

const LAYOUT_KEYS = ['display', 'flexDirection', 'gridTemplateColumns', 'gridTemplateRows', 'gap', 'alignItems', 'justifyContent', 'flexWrap'];

test('CMP-133 Layout minus removes every layout prop; a parent of order-first instances keeps valid styles', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(LAYOUT_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // 1. The grid root.
  await clickIn(editor, 'desktop', 'card-root', 0.95, 0.97);
  expect(await editor.selection()).toEqual(['card-root']);
  await panel(page).locator('button[title="Remove Layout"]').click();
  let code = await pollCode(editor, CARD, c => !/display:\s*'grid'/.test(openingTag(c, 'card-root')));
  const rs = await editor.style('card-root', CARD);
  expect(rs.display ?? 'block', 'root display').not.toMatch(/grid|flex/);
  for (const k of LAYOUT_KEYS.slice(1)) expect(rs[k], `root ${k}`).toBeUndefined();
  await expect(panel(page).locator('button[title="Add Layout"]'), 'not stuck on Grid').toBeVisible();
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });

  // 2. The flex parent of instances whose style starts with `order` (from the seed state).
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);
  const mid = before;
  await clickIn(editor, 'desktop', 'list', 0.95, 0.9);
  expect(await editor.selection()).toEqual(['list']);
  await panel(page).locator('button[title="Remove Layout"]').click();
  code = await pollCode(editor, CARD, c => !/display:\s*'flex'/.test(openingTag(c, 'list')));
  const ls = await editor.style('list', CARD);
  expect(ls.display ?? 'block', 'list display').not.toMatch(/grid|flex/);
  for (const k of LAYOUT_KEYS.slice(1)) expect(ls[k], `list ${k}`).toBeUndefined();
  expect(parsesClean(code), 'the file parses').toBe(true);
  for (const id of ['b1', 'b2']) {
    const tag = openingTag(code, id);
    expect(tag, `${id} style object`).toMatch(/style=\{\{\s*[A-Za-z'"]/);
    expect(tag, `${id}: no leading comma`).not.toMatch(/style=\{\{\s*,/);
    expect(tag).not.toMatch(/,\s*,/);
  }
  await expect(editor).toUndoInOneStep(mid, { path: CARD });
});

// ─── CMP-152 · Shift+Arrow nudges from the tile's effective value ────

const NUDGE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '700px', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="tag" data-name="Tag" variants={tagVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '388px', width: '80px', height: '40px', backgroundColor: '#ffcc33' }} />
    </motion.div>`, {
  config: `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-5', label: 'Variant 5', x: 450, y: 0 },
];`,
  pre: `const tagVariants = {
  default: { top: '400px' },
  'variant-5': { top: '573px' },
};`,
}));

test('CMP-152 Shift+ArrowUp on variant-5 steps 573 → 563 → 553 in its entry; the default is untouched', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(NUDGE_MASTER);
  await openMaster(editor, CARD, 'variant-5');
  const before = await editor.code(CARD);

  await clickIn(editor, 'variant-5', 'tag');
  expect(await editor.selection()).toEqual(['tag']);
  await editor.blur();
  await page.keyboard.press('Shift+ArrowUp');
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'tag', 'variant-5')?.top !== '573px');
  // Not: the first press jumping from the base (388 → 378) or the default (400 → 390).
  expect(variantEntry(code, 'tag', 'variant-5')?.top).toBe('563px');
  await page.keyboard.press('Shift+ArrowUp');
  code = await pollCode(editor, CARD, c => variantEntry(c, 'tag', 'variant-5')?.top !== '563px');
  // Not: the repeat writing the same value again.
  expect(variantEntry(code, 'tag', 'variant-5')?.top).toBe('553px');
  expect(variantEntry(code, 'tag', 'default')?.top).toBe('400px');
  expect((await editor.style('tag', CARD)).top).toBe('388px');
  const root = (await boxIn(editor, 'variant-5', 'card-root'))!;
  await expect.poll(async () => Math.round(((await boxIn(editor, 'variant-5', 'tag'))!.y - root.y) / (root.width / 320))).toBe(553);
  // Consecutive nudges coalesce into one history step.
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-153 · unpin R/B on a variant, pan, drag ─────────────────────

const PIN_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: '320px', height: '240px', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="pinned" data-name="Pinned" variants={pinnedVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '20px', top: '20px', right: '20px', bottom: '20px', backgroundColor: '#3355ff' }} />
    </motion.div>`, {
  pre: `const pinnedVariants = {
  default: { backgroundColor: '#3355ff' },
  'variant-1': { backgroundColor: '#ff2d75' },
};`,
}));

test('CMP-153 unpinning R/B on variant-1 writes auto insets there; a pan keeps the pins; a drag moves only left/top', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(PIN_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  await clickIn(editor, 'variant-1', 'pinned', 0.3, 0.3);
  expect(await editor.selection()).toEqual(['pinned']);
  for (const s of ['T', 'L', 'R', 'B'] as const) expect(await pinActive(page, s), `${s} pinned at start`).toBe(true);
  await pinButton(page, 'R').click();
  await pinButton(page, 'B').click();
  let code = await pollCode(editor, CARD, c => variantEntry(c, 'pinned', 'variant-1')?.bottom === 'auto');
  const v1 = variantEntry(code, 'pinned', 'variant-1')!;
  expect(v1.right).toBe('auto');
  expect(v1.bottom).toBe('auto');
  expect(variantEntry(code, 'pinned', 'default')?.right ?? '20px', 'default untouched').toBe('20px');
  expect((await editor.style('pinned', CARD)).right).toBe('20px');
  await expect.poll(() => pinActive(page, 'R')).toBe(false);
  expect(await pinActive(page, 'B')).toBe(false);

  // Hold Space and pan the canvas.
  const afterPins = await stableCode(editor, CARD);
  const p0 = (await boxIn(editor, 'variant-1', 'pinned'))!;
  // Focus off the pin buttons first: Space on a focused button would press it.
  await editor.blur();
  await page.mouse.move(760, 840);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await glide(page, { x: 760, y: 840 }, { x: 720, y: 800 }, 8);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await editor.settled();
  const p1 = (await boxIn(editor, 'variant-1', 'pinned'))!;
  expect(Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y), 'the camera panned').toBeGreaterThan(20);
  expect(await stableCode(editor, CARD), 'a pan writes nothing').toBe(afterPins);
  // Not: R/B re-pinned from the master values.
  expect(await pinActive(page, 'R')).toBe(false);
  expect(await pinActive(page, 'B')).toBe(false);
  expect(await pinActive(page, 'L')).toBe(true);
  expect(await pinActive(page, 'T')).toBe(true);

  // Drag the child 30px right: only left/top change, no size jump.
  await prime(editor, 'pinned', 'variant-1', 0.3, 0.3);
  const s0 = (await boxIn(editor, 'variant-1', 'pinned'))!;
  const from = { x: s0.x + s0.width * 0.3, y: s0.y + s0.height * 0.3 };
  await gesture(editor, from, [{ x: from.x + 30, y: from.y }], {
    atWaypoint: async () => {
      const b = (await boxIn(editor, 'variant-1', 'pinned'))!;
      expect(Math.abs(b.width - s0.width), 'no half-size jump mid-drag').toBeLessThan(2);
      expect(Math.abs(b.height - s0.height)).toBeLessThan(2);
    },
  });
  code = await pollCode(editor, CARD, c => variantEntry(c, 'pinned', 'variant-1')?.left != null);
  const e = variantEntry(code, 'pinned', 'variant-1')!;
  expect(parseFloat(e.left)).toBeGreaterThan(20);
  expect(e.right).toBe('auto');
  expect(e.bottom).toBe('auto');
  const s1 = (await boxIn(editor, 'variant-1', 'pinned'))!;
  expect(Math.abs(s1.width - s0.width)).toBeLessThan(2);
  expect(variantEntry(code, 'pinned', 'default')?.left ?? '20px').toBe('20px');
  await expect(editor).toUndoInOneStep(afterPins, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(afterPins);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-161 · size handles resolve per tile ─────────────────────────

const MINCONTENT_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', width: '320px', height: '240px', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="hug" data-name="Hug" style={{ position: 'relative', display: 'flex', padding: '12px', width: initialVariant === 'variant-1' ? '200px' : 'min-content', height: initialVariant === 'variant-1' ? '120px' : 'min-content', backgroundColor: '#3355ff', flex: '0 0 auto' }}>
        <motion.p layout={true} data-id="hug-text" data-name="Text" style={{ position: 'relative', fontSize: '16px', color: '#ffffff', margin: '0px' }}>Hug</motion.p>
      </motion.div>
    </motion.div>`));

async function handleDirs(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-resize-dir]').evaluateAll(els => els.map(el => el.getAttribute('data-resize-dir') ?? '').sort());
}

test('CMP-161 on a px-overridden variant tile a min-content node shows resize circles', { tag: ['@p2', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(MINCONTENT_MASTER);
  await openMaster(editor);

  await clickIn(editor, 'variant-1', 'hug', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['hug']);
  await expect.poll(() => handleDirs(page), { message: 'four corner circles on the px tile' }).toEqual(['bottomLeft', 'bottomRight', 'topLeft', 'topRight']);
  // On the default tile the same node hugs its content.
  await clickIn(editor, 'desktop', 'hug', 0.9, 0.9);
  expect(await editor.selection()).toEqual(['hug']);
  await expect.poll(() => handleDirs(page)).not.toEqual(['bottomLeft', 'bottomRight', 'topLeft', 'topRight']);
});

// ─── CMP-154 · live mirroring of primary edits onto variant tiles ────

const MIRROR_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', width: initialVariant === 'variant-2' ? '300px' : '320px', height: '240px', backgroundColor: '#111827', ...style }}>
      <motion.div data-id="box" data-name="Box" variants={boxVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'absolute', left: '40px', top: '40px', width: '80px', height: '60px', backgroundColor: '#ffcc33' }} />
    </motion.div>`, {
  config: CONFIG_3V,
  pre: `const boxVariants = {
  default: { left: '40px', top: '40px' },
  'variant-2': { left: '180px', top: '140px' },
};`,
}));

/** Box of a node relative to its tile root, in canvas px. */
const isHidden = (d: string) => d === '' || d === 'none';

async function localBox(editor: Parameters<typeof clickIn>[0], vpId: string, id: string) {
  const r = (await boxIn(editor, vpId, 'card-root'))!;
  const b = (await boxIn(editor, vpId, id))!;
  const z = r.width / 320;
  return { x: (b.x - r.x) / z, y: (b.y - r.y) / z, w: b.width / z, h: b.height / z };
}

test('CMP-154 primary child drags/resizes mirror live onto synced tiles only; a root west-edge resize never mirrors the root position', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: a primary-root west-edge resize shifts a variant tile that owns its width — ResizeManager.computeSiblingVariantShifts only checks the variants OBJECT for `width`, but the builder writes a per-variant root width as an inline ternary (CMP-130), so variant-2 moves left (variantConfig x 1000 → 947) without growing");
  const page = editor.page();
  await editor.load(MIRROR_MASTER);
  await openMaster(editor);
  const v1Start = await localBox(editor, 'variant-1', 'box');
  const v2Start = await localBox(editor, 'variant-2', 'box');

  // 1. Drag the child on the primary: variant-1 (inherits) follows live, variant-2 (own x/y) stays.
  await prime(editor, 'box', 'desktop');
  const b = await editor.nodeBoxIn('desktop', 'box');
  const z = (await boxIn(editor, 'desktop', 'card-root'))!.width / 320;
  await gesture(editor, center(b), [{ x: center(b).x + 40 * z, y: center(b).y + 20 * z }], {
    atWaypoint: async () => {
      const v1 = await localBox(editor, 'variant-1', 'box');
      expect(v1.x - v1Start.x, 'variant-1 follows the drag live').toBeGreaterThan(25);
      const v2 = await localBox(editor, 'variant-2', 'box');
      expect(Math.abs(v2.x - v2Start.x) + Math.abs(v2.y - v2Start.y), 'variant-2 keeps its own x/y').toBeLessThan(2);
    },
  });
  // The primary committed its new position (px or the % model); variant-2 keeps its own.
  await expect.poll(async () => (await localBox(editor, 'desktop', 'box')).x).toBeGreaterThan(60);
  await expect.poll(async () => variantEntry(await editor.code(CARD), 'box', 'default')?.left).not.toBe('40px');
  expect(variantEntry(await editor.code(CARD), 'box', 'variant-2')).toMatchObject({ left: '180px', top: '140px' });
  expect((await localBox(editor, 'variant-2', 'box')).x).toBeCloseTo(v2Start.x, 0);

  // 2. Resize the child (right edge): variant-1 widens live, variant-2 keeps its x.
  const v1Before = await localBox(editor, 'variant-1', 'box');
  const v2Before = await localBox(editor, 'variant-2', 'box');
  await clickIn(editor, 'desktop', 'box', 0.5, 0.5);
  await page.waitForTimeout(650);
  // The bottom-right corner circle (an edge midpoint carries the connection arrow).
  const corner = (await page.locator('[data-resize-dir="bottomRight"]').first().boundingBox())!;
  const from = center(corner);
  await gesture(editor, from, [{ x: from.x + 30 * z, y: from.y }], {
    atWaypoint: async () => {
      const v1 = await localBox(editor, 'variant-1', 'box');
      expect(v1.w - v1Before.w, 'variant-1 widens live').toBeGreaterThan(15);
      const v2 = await localBox(editor, 'variant-2', 'box');
      expect(Math.abs(v2.x - v2Before.x), 'variant-2 keeps its x').toBeLessThan(2);
    },
  });

  // 3. Resize the primary ROOT from its west edge.
  const r0 = { d: (await boxIn(editor, 'desktop', 'card-root'))!, v1: (await boxIn(editor, 'variant-1', 'card-root'))!, v2: (await boxIn(editor, 'variant-2', 'card-root'))! };
  await clickIn(editor, 'desktop', 'card-root', 0.95, 0.95);
  expect(await editor.selection()).toEqual(['card-root']);
  await page.waitForTimeout(650);
  const west = (await page.locator('[data-resize-edge="left"]').first().boundingBox())!;
  const wFrom = { x: west.x + west.width / 2, y: west.y + west.height * 0.3 };
  const dx = -40;
  await gesture(editor, wFrom, [{ x: wFrom.x + dx, y: wFrom.y }], {
    atWaypoint: async () => {
      const d = (await boxIn(editor, 'desktop', 'card-root'))!;
      const v1 = (await boxIn(editor, 'variant-1', 'card-root'))!;
      const v2 = (await boxIn(editor, 'variant-2', 'card-root'))!;
      const grew = d.width - r0.d.width;
      expect(grew, 'the primary root grows').toBeGreaterThan(20);
      // The synced variant-1 tile grows by the same delta and shifts by the same x delta…
      expect(Math.abs((v1.width - r0.v1.width) - grew)).toBeLessThan(3);
      expect(Math.abs((v1.x - r0.v1.x) - (d.x - r0.d.x))).toBeLessThan(3);
      // …but never takes the primary's position.
      expect(Math.abs(v1.x - d.x)).toBeGreaterThan(50);
      // variant-2 owns its width: it keeps x and width.
      expect(Math.abs(v2.x - r0.v2.x)).toBeLessThan(2);
      expect(Math.abs(v2.width - r0.v2.width)).toBeLessThan(2);
    },
  });
  const code = await stableCode(editor, CARD);
  const w = styleTernary(code, 'card-root', 'width')!;
  expect(parseFloat(w.branches.default)).toBeGreaterThan(330);
  expect(w.branches['variant-2']).toBe('300px');
  expect((await editor.style('card-root', CARD)).left, 'no root position written').toBeUndefined();
  expect(parsesClean(code)).toBe(true);
});

// ─── CMP-155 · per-variant order in a grid ───────────────────────────

const CARD_COLORS = ['ff2d75', '33cc88', '3355ff', 'ffcc33', 'aa22ff', '22ccff'];
const GRID_IDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const GRID_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', padding: '10px', width: '320px', height: 'auto', backgroundColor: '#111827', ...style }}>
        ${GRID_IDS.map((id, i) => `<motion.div layout={true} data-id="${id}" data-name="${id.toUpperCase()}" style={{ position: 'relative', height: '50px', backgroundColor: '#${CARD_COLORS[i]}' }} />`).join('\n        ')}
    </motion.div>`, { config: CONFIG_3V }));

const orderOn = (code: string, id: string, v: string) => { const t = styleTernary(code, id, 'order'); return t ? (t.branches[v] ?? t.branches.default) : null; };

test('CMP-155 a grid reorder on one variant writes order ternaries for that variant only (canvas and Layers)', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(GRID_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);

  // Canvas: on variant-2, drag card 2 onto card 5.
  await prime(editor, 'c2', 'variant-2');
  const c2 = await editor.nodeBoxIn('variant-2', 'c2');
  const c5 = await editor.nodeBoxIn('variant-2', 'c5');
  await gesture(editor, center(c2), [center(c5), { x: c5.x + c5.width * 0.7, y: c5.y + c5.height * 0.5 }]);
  let code = await pollCode(editor, CARD, c => styleTernary(c, 'c2', 'order') != null);
  await expect(editor).toHaveJsxOrder('card-root', GRID_IDS, { path: CARD });
  const v2Order = await visualOrderIn(editor, 'variant-2', GRID_IDS);
  expect(v2Order.indexOf('c2'), 'card 2 moved on variant-2').toBeGreaterThan(1);
  for (const id of GRID_IDS) {
    const t = styleTernary(code, id, 'order');
    if (!t) continue;
    // A card whose variant-2 slot equals its default collapses to a literal.
    if (t.driver) {
      expect(t.driver, `${id} driver`).toBe('initialVariant');
      expect(Object.keys(t.branches).sort(), `${id}: scoped to variant-2`).toEqual(['default', 'variant-2']);
    }
    // The default branch pins the current visual order.
    expect(Number(t.branches.default), `${id} default order`).toBe(GRID_IDS.indexOf(id));
    expect(Number(orderOn(code, id, 'variant-2')), `${id} variant-2 order`).toBe(v2Order.indexOf(id));
  }
  expect(await visualOrderIn(editor, 'desktop', GRID_IDS), 'default unchanged').toEqual(GRID_IDS);
  expect(await visualOrderIn(editor, 'variant-1', GRID_IDS), 'variant-1 unchanged').toEqual(GRID_IDS);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // Layers: on variant-1, move C1 between C3 and C4 (a frame row's middle means "inside").
  // ROW-ADJUSTED: the Layers drop also moves the JSX ("structural mutation always
  // runs", LayersPanel/drag.ts) — the order ternaries keep every other tile as it was.
  await expandLayerVariant(page, 'variant-1', 'c1');
  await layersDrag(editor, 'variant-1:c1', 'variant-1:c4', 'before');
  code = await pollCode(editor, CARD, c => styleTernary(c, 'c1', 'order') != null);
  await expect.poll(() => visualOrderIn(editor, 'variant-1', GRID_IDS)).toEqual(['c2', 'c3', 'c1', 'c4', 'c5', 'c6']);
  expect(await visualOrderIn(editor, 'desktop', GRID_IDS)).toEqual(GRID_IDS);
  expect(await visualOrderIn(editor, 'variant-2', GRID_IDS)).toEqual(GRID_IDS);
  for (const id of GRID_IDS) {
    const t = styleTernary(code, id, 'order');
    if (t?.driver) expect(Object.keys(t.branches).sort(), `${id}: scoped to variant-1`).toEqual(['default', 'variant-1']);
    if (t) expect(Number(t.branches.default), `${id} default order`).toBe(GRID_IDS.indexOf(id));
  }
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-156 · Layers-drag a node hidden on variant-1 ────────────────

const HIDDEN_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', width: '320px', height: 'auto', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="a" data-name="A" style={{ position: 'relative', width: '100%', height: '30px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
      <AnimatePresence mode="popLayout">{initialVariant !== 'variant-1' && (
        <motion.div layout={true} key="hid" data-id="hid" data-name="Hid" exit={{ opacity: 0 }} style={{ position: 'relative', width: '100%', height: '30px', backgroundColor: '#ffcc33', flex: '0 0 auto' }} />
      )}</AnimatePresence>
      <motion.div layout={true} data-id="b" data-name="B" style={{ position: 'relative', width: '100%', height: '30px', backgroundColor: '#33cc88', flex: '0 0 auto' }} />
      <motion.div layout={true} data-id="box" data-name="Box" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px', width: '100%', height: 'auto', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="inner" data-name="Inner" style={{ position: 'relative', width: '100%', height: '24px', backgroundColor: '#3355ff', flex: '0 0 auto' }} />
      </motion.div>
    </motion.div>`, { config: CONFIG_3V }));

/** The `{cond && (...)}` gate wrapping `id` (condition source), or null. */
function gateOf(code: string, id: string): string | null {
  const ast = astOf(code);
  let found: string | null = null;
  walk(ast, (n) => {
    if (found || n.type !== 'LogicalExpression' || n.operator !== '&&') return;
    const src = code.slice(n.right.start, n.right.end);
    if (new RegExp(`data-id="${id}"`).test(src)) found = code.slice(n.left.start, n.left.end);
  });
  return found;
}

test('CMP-156 a node hidden on variant-1 Layers-dragged elsewhere keeps its gate and appears once', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  const page = editor.page();
  await editor.load(HIDDEN_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  expect(isHidden(await displayIn(editor, 'variant-1', 'hid'))).toBe(true);

  // 1. Another index: between B and Box (a frame row's middle means "inside").
  await layersDrag(editor, 'desktop:hid', 'desktop:box', 'before');
  let code = await pollCode(editor, CARD, c => (c.indexOf('data-id="hid"') > c.indexOf('data-id="b"')) || c !== before);
  await expect(editor).toHaveNoDuplicateIds({ path: CARD });
  expect(parsesClean(code)).toBe(true);
  expect(gateOf(code, 'hid'), 'the variant gate travels with the node').toMatch(/initialVariant !== ['"]variant-1['"]/);
  expect(await visualOrderIn(editor, 'desktop', ['a', 'hid', 'b'])).toEqual(['a', 'b', 'hid']);
  expect(isHidden(await displayIn(editor, 'variant-1', 'hid')), 'still hidden on variant-1').toBe(true);
  expect(isHidden(await displayIn(editor, 'variant-2', 'hid')), 'visible on variant-2').toBe(false);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // 2. Into another parent: inside Box.
  await layersDrag(editor, 'desktop:hid', 'desktop:box', 'inside');
  code = await pollCode(editor, CARD, c => c !== before);
  await expect(editor).toHaveNoDuplicateIds({ path: CARD });
  expect(parsesClean(code)).toBe(true);
  expect(await editor.parentOf('hid', CARD)).toBe('box');
  expect(gateOf(code, 'hid')).toMatch(/initialVariant !== ['"]variant-1['"]/);
  expect(isHidden(await displayIn(editor, 'variant-1', 'hid'))).toBe(true);
  expect(isHidden(await displayIn(editor, 'desktop', 'hid'))).toBe(false);
  expect(await editor.sandbox().locator('[data-viewport="desktop"] [data-id="hid"]').count(), 'appears once on the default tile').toBeLessThanOrEqual(1);
  expect(await (await editor.nodeIn('desktop', 'hid')).count()).toBe(1);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-157 · clones bake the tile's painted values ─────────────────

const STATE_HEAD = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;
const STATE_HOOKS = `  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
`;
const CLONE_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', variant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px', padding: '12px', width: '320px', height: 'auto', overflow: 'hidden', backgroundColor: '#111827', ...style }}>
      <motion.p layout={true} data-id="btn" data-name="Button" variants={btnVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{ position: 'relative', width: variant === 'variant-2' ? '100%' : '', padding: '8px', backgroundColor: '#ff2d75', color: '#ffffff', fontSize: '14px', margin: '0px', flex: '0 0 auto', order: '0' }}>Buy</motion.p>
      <motion.div layout={true} data-id="spacer" data-name="Spacer" style={{ position: 'relative', width: '40px', height: '20px', backgroundColor: '#33cc88', flex: '0 0 auto', order: '1' }} />
    </motion.div>`, {
  config: CONFIG_3V, head: STATE_HEAD, hooks: STATE_HOOKS,
  pre: `const btnVariants = {
  default: { fontSize: '14px' },
  'variant-2': { fontSize: '20px' },
};`,
}));

/** data-ids in the file that are not in `known`. */
function newIds(code: string, known: string[]): string[] {
  return [...code.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]).filter(id => !known.includes(id));
}

async function assertBakedClone(editor: Parameters<typeof clickIn>[0], code: string, how: string) {
  const ids = newIds(code, ['card-root', 'btn', 'spacer']);
  expect(ids, `${how}: exactly one clone`).toHaveLength(1);
  const clone = ids[0];
  const st = await editor.style(clone, CARD);
  const entry = variantEntry(code, clone, 'variant-2') ?? {};
  // Baked with the tile's painted values: full width and the variant-2 size.
  expect(st.width ?? entry.width, `${how}: width`).toBe('100%');
  expect(st.fontSize === '20px' || entry.fontSize === '20px', `${how}: variant-2 fontSize (${st.fontSize}/${entry.fontSize})`).toBe(true);
  // Visible only on variant-2.
  await expect.poll(async () => isHidden(await displayIn(editor, 'variant-2', clone)), { message: `${how}: shows on variant-2` }).toBe(false);
  for (const vp of ['desktop', 'variant-1']) {
    const d = await displayIn(editor, vp, clone);
    expect(isHidden(d), `${how}: hidden on ${vp} (${d})`).toBe(true);
  }
  // Not: an auto-width primary-looking copy on variant-2.
  const btnW = (await boxIn(editor, 'variant-2', 'btn'))!.width;
  const cloneW = (await boxIn(editor, 'variant-2', clone))!.width;
  expect(Math.abs(cloneW - btnW), `${how}: the clone paints full width`).toBeLessThan(2);
  return clone;
}

test('CMP-157 Alt-drag and copy/paste on variant-2 clone the painted variant-2 values, visible on variant-2 only', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, "BUG: the Cmd+V clone pasted on a variant tile is hidden on the other variants with an inline display:'none', which the builder's own oracle rejects (DISPLAY_TOGGLE_VISIBILITY) — the Alt-drag clone uses the AnimatePresence conditional");
  const page = editor.page();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.load(CLONE_MASTER);
  await openMaster(editor, CARD, 'variant-2');
  const before = await editor.code(CARD);

  // Alt-drag.
  await prime(editor, 'btn', 'variant-2');
  const b = await editor.nodeBoxIn('variant-2', 'btn');
  await gesture(editor, center(b), [{ x: center(b).x, y: b.y + b.height * 2.2 }], { modifiers: ['Alt'] });
  let code = await pollCode(editor, CARD, c => newIds(c, ['card-root', 'btn', 'spacer']).length > 0);
  await assertBakedClone(editor, code, 'Alt-drag');
  expect(parsesClean(code)).toBe(true);
  expect.soft(await editor.newOracleViolations(), "Alt-drag: the builder's oracle accepts the clone").toEqual([]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // Copy / paste on variant-2.
  await clickIn(editor, 'variant-2', 'btn');
  expect(await editor.selection()).toEqual(['btn']);
  await editor.blur();
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(200);
  await page.keyboard.press('ControlOrMeta+v');
  code = await pollCode(editor, CARD, c => newIds(c, ['card-root', 'btn', 'spacer']).length > 0);
  await assertBakedClone(editor, code, 'Cmd+V');
  expect(parsesClean(code)).toBe(true);
  expect.soft(await editor.newOracleViolations(), "Cmd+V: the builder's oracle accepts the clone").toEqual([]);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
});

// ─── CMP-158 · drag in / drag out on a variant tile ──────────────────

const DRAGIO_MASTER = masterSeed('Card', masterModule(`
    <motion.div layout={true} data-id="card-root" data-name="Card" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', width: '320px', height: 'auto', overflow: 'hidden', backgroundColor: '#111827', ...style }}>
      <motion.div layout={true} data-id="drop" data-name="Drop" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px', width: '100%', height: '150px', backgroundColor: '#222244', flex: '0 0 auto' }}>
        <motion.div layout={true} data-id="kid" data-name="Kid" style={{ position: 'relative', width: '80px', height: '30px', backgroundColor: '#ff2d75', flex: '0 0 auto' }} />
      </motion.div>
    </motion.div>`, {
  post: `
const canvasNodes = (<>
  <div data-id="loose" data-name="Loose" data-canvas-node="true" style={{ position: 'absolute', left: '600px', top: '380px', width: '90px', height: '40px', backgroundColor: '#7c5cff' }}></div>
</>);
`,
}));

test('CMP-158 dragging into a variant-1 frame shows no default copy, Escape restores every tile, the drop is variant-1-only, a drag-out leaves one copy', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
  test.fail(true, 'BUG: Escape does not cancel an element drag — DragCoordinator.cancel() ("e.g. Escape key") is bound only for toolbar drags; the canvas Escape shortcut selects the parent and the release still drops (same finding as DND-179)');
  const page = editor.page();
  await editor.load(DRAGIO_MASTER);
  await openMaster(editor);
  const before = await editor.code(CARD);
  const loose = editor.sandbox().locator('[data-id="loose"]:not([data-viewport] [data-id])').first();
  const tileDisplays = async () => {
    const out: Record<string, string> = {};
    for (const vp of ['desktop', 'variant-1']) for (const id of ['card-root', 'drop', 'kid']) out[`${vp}:${id}`] = await displayIn(editor, vp, id);
    return out;
  };
  const displays0 = await tileDisplays();

  // 1. Drag in and hold; then Escape.
  let lb = (await loose.boundingBox())!;
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.waitForTimeout(650);
  let drop = await editor.nodeBoxIn('variant-1', 'drop');
  await gesture(editor, center(lb), [center(drop), { x: drop.x + drop.width * 0.5, y: drop.y + drop.height * 0.7 }], {
    release: false,
    atWaypoint: async (i) => {
      if (i !== 1) return;
      expect(await editor.sandbox().locator('[data-viewport="desktop"] [data-id="drop"] [data-id="loose"]:visible').count(), 'no copy on the default tile while held').toBe(0);
    },
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Escape mid-drag leaves no tile element at display:none.
  expect(await tileDisplays(), 'no tile hidden after Escape').toEqual(displays0);
  await page.mouse.up();
  await editor.settled();
  expect(await tileDisplays(), 'no tile hidden after the release').toEqual(displays0);
  // Escape cancelled the gesture: nothing written. (Today the release drops; restore and carry on.)
  expect.soft(await stableCode(editor, CARD), 'Escape cancels the drag: nothing written').toBe(before);
  for (let i = 0; i < 3 && (await editor.code(CARD)) !== before; i++) await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // 2. Repeat and drop.
  lb = (await loose.boundingBox())!;
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.waitForTimeout(650);
  drop = await editor.nodeBoxIn('variant-1', 'drop');
  await gesture(editor, center(lb), [center(drop), { x: drop.x + drop.width * 0.5, y: drop.y + drop.height * 0.7 }]);
  let code = await pollCode(editor, CARD, c => c.indexOf('data-id="loose"') > 0 && c.indexOf('data-id="loose"') < c.indexOf('canvasNodes'));
  expect(await editor.parentOf('loose', CARD)).toBe('drop');
  expect(idCount(code, 'loose')).toBe(1);
  await expect.poll(async () => isHidden(await displayIn(editor, 'variant-1', 'loose'))).toBe(false);
  const d = await displayIn(editor, 'desktop', 'loose');
  expect(isHidden(d), `gated to variant-1: hidden on the default tile (${d})`).toBe(true);
  expect(parsesClean(code)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: CARD });
  await editor.undo();
  await expect.poll(() => editor.code(CARD)).toBe(before);

  // 3. Drag a variant-1 child out to empty canvas: one canvas copy, none left on the variant-1 root.
  await prime(editor, 'kid', 'variant-1');
  const kid = await editor.nodeBoxIn('variant-1', 'kid');
  const root = await editor.nodeBoxIn('variant-1', 'card-root');
  const out = { x: center(kid).x + 20, y: root.y + root.height + 100 };
  await gesture(editor, center(kid), [{ x: center(kid).x, y: root.y + root.height + 50 }, out]);
  await expect.poll(async () => canvasIds(await editor.code(CARD)).length).toBe(2);
  code = await stableCode(editor, CARD);
  const copy = canvasIds(code).find(id => id !== 'loose')!;
  expect(idCount(code, copy), 'exactly one copy').toBe(1);
  expect(await editor.sandbox().locator(`[data-id="${copy}"]:not([data-viewport] [data-id]):visible`).count(), 'one painted canvas copy').toBe(1);
  // None left on the variant-1 root (the source is hidden there or moved out).
  if (copy !== 'kid') expect(isHidden(await displayIn(editor, 'variant-1', 'kid')), 'none on the variant-1 root').toBe(true);
  else expect(await editor.parentOf('kid', CARD)).toBeNull();
  expect(await editor.sandbox().locator(`[data-viewport="variant-1"] [data-id="${copy}"]:visible`).count()).toBe(0);
  expect(parsesClean(code)).toBe(true);
});

/** Top-level canvas-node ids (`data-canvas-node="true"`). */
function canvasIds(code: string): string[] {
  return [...code.matchAll(/<\w[\w.]*\s[^>]*?data-id="([^"]+)"[^>]*?data-canvas-node="true"/g)].map(m => m[1])
    .concat([...code.matchAll(/<\w[\w.]*\s[^>]*?data-canvas-node="true"[^>]*?data-id="([^"]+)"/g)].map(m => m[1]))
    .filter((v, i, a) => a.indexOf(v) === i);
}
