// DND · Commit pipeline, undo and code integrity (E2E_TEST_PLAN.md §2).
//
// What happens after the gesture: one undo step per drag (byte-for-byte, on
// every tile), never a duplicate data-id, never a cycle or a deleted node,
// coalesced moves that keep their cleanup, two-flush inserts that never leave
// the node invisible, persistence across a reload, the big-page fast paths,
// the live layers tree, a viewport width written inside a gesture, and the
// heal of a stray module-level JSX copy.

import { test, expect, TILES, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  page8, seed8, pageModule8, center, near, gesture, Gesture, stableCode, mark, since, frames, quickBox,
  idCount, dupIds, ancestorsOf, canvasBox, pollCode, type Box, type Pt,
} from '../../helpers/d8';
import { centerOn, setZoom } from '../../helpers/d3';
import { placeholders, visualOrder } from '../../helpers/d1';
import { openLayers, revealRow, expandRow, dragLayerRow, lid, layerRow, holdKey, pressMidDrag, CanvasDrag } from '../../helpers/d4';
import { resizeBy } from '../../helpers/c5';
import { parseSource } from '../../helpers/code';

test.describe.configure({ timeout: 180_000 });

const PAGE = 'app/page.client.tsx';

// ─── Seeds ────────────────────────────────────────────────────────────

/** 3 tiles: flex sections, a flex row and column, a no-layout frame with an
 *  absolute kid; canvas nodes `cv` (to enter) beside the page. */
const KINDS = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', minHeight: '900px', padding: '40px', backgroundColor: '#0d0d1a' }}>
  <div data-id="s1" data-name="S1" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '100px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="s2" data-name="S2" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '100px', backgroundColor: '#3a1a1a' }}></div>
  <div data-id="row" data-name="Row" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '10px', width: '100%', height: '140px', padding: '10px', backgroundColor: '#203020' }}>
    <div data-id="r1" data-name="R1" style={{ position: 'relative', flex: '0 0 auto', width: '120px', height: '100px', backgroundColor: '#ffcc33' }}></div>
    <div data-id="r2" data-name="R2" style={{ position: 'relative', flex: '0 0 auto', width: '120px', height: '100px', backgroundColor: '#33ffcc' }}></div>
  </div>
  <div data-id="col" data-name="Col" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '10px', width: '300px', height: '220px', padding: '10px', backgroundColor: '#202040' }}>
    <div data-id="c1" data-name="C1" style={{ position: 'relative', flex: '0 0 auto', width: '120px', height: '40px', backgroundColor: '#cc66ff' }}></div>
  </div>
  <div data-id="duo" data-name="Duo" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '40px', width: '100%', height: '220px', backgroundColor: '#101020' }}>
    <div data-id="frame" data-name="Frame" style={{ position: 'relative', flex: '0 0 auto', width: '300px', height: '200px', backgroundColor: '#302030' }}>
      <div data-id="fk" data-name="Fk" style={{ position: 'absolute', left: '20px', top: '20px', width: '80px', height: '60px', backgroundColor: '#ff6688' }}></div>
    </div>
    <div data-id="frame2" data-name="Frame2" style={{ position: 'relative', flex: '0 0 auto', width: '300px', height: '200px', backgroundColor: '#203030' }}></div>
  </div>
</div>`, {
  tiles: TILES.three,
  canvas: `<div data-id="cv" data-name="Cv" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '90px', height: '90px', backgroundColor: '#ff66cc' }}></div>`,
});

const FLEX3 = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#2a2a4a' }}></div>
</div>`, {
  canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '120px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
});

/** FLEX3 + a second page that ALREADY carries a duplicate data-id (an old splice bug). */
const CORRUPT_PAGE = 'app/corrupt/page.client.tsx';
const FLEX3_AND_CORRUPT = (() => {
  const s = { format: FLEX3.format, files: { ...FLEX3.files } } as typeof FLEX3;
  s.files['app/corrupt/page.tsx'] = FLEX3.files['app/page.tsx'];
  s.files[CORRUPT_PAGE] = pageModule8({ root: `
<div data-id="c-root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="ca" data-name="A" style={{ position: 'relative', flex: '0 0 auto', height: '200px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="cb" data-name="B" style={{ position: 'relative', flex: '0 0 auto', height: '200px', backgroundColor: '#3a1a1a' }}></div>
  <div data-id="cc" data-name="C" style={{ position: 'relative', flex: '0 0 auto', height: '200px', backgroundColor: '#1a3a1a' }}></div>
  <div data-id="twin" data-name="Twin" style={{ position: 'relative', flex: '0 0 auto', height: '60px', backgroundColor: '#444466' }}></div>
  <div data-id="twin" data-name="Twin" style={{ position: 'relative', flex: '0 0 auto', height: '60px', backgroundColor: '#444466' }}></div>
</div>` });
  return s;
})();

/** A frame with a nested child frame (descendant-as-parent bait). */
const NESTED = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '40px', width: '1440px', minHeight: '900px', padding: '60px', backgroundColor: '#0d0d1a' }}>
  <div data-id="outer" data-name="Outer" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '20px', width: '600px', height: '400px', padding: '20px', backgroundColor: '#202040' }}>
    <div data-id="inner" data-name="Inner" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', width: '400px', height: '200px', padding: '20px', backgroundColor: '#404080' }}>
      <div data-id="leaf" data-name="Leaf" style={{ position: 'relative', flex: '0 0 auto', width: '100px', height: '60px', backgroundColor: '#ffcc33' }}></div>
    </div>
  </div>
  <div data-id="other" data-name="Other" style={{ position: 'relative', flex: '0 0 auto', width: '600px', height: '120px', backgroundColor: '#204020' }}></div>
</div>`);

/** Flow sections in a page plus a no-layout canvas frame (exit → entry in one gesture). */
const EXIT_ENTRY = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="s1" data-name="S1" style={{ position: 'relative', flex: '0 0 auto', order: '0', height: '300px', backgroundColor: '#1a1a3a' }}></div>
  <div data-id="s2" data-name="S2" style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '200px', height: '120px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="s3" data-name="S3" style={{ position: 'relative', flex: '0 0 auto', order: '2', height: '300px', backgroundColor: '#2a2a4a' }}></div>
</div>`, {
  canvas: `<div data-id="cf" data-name="CanvasFrame" data-canvas-node="true" style={{ position: 'absolute', left: '-700px', top: '400px', width: '500px', height: '360px', backgroundColor: '#203040' }}></div>`,
});

/** An ORDERED flex column + a canvas chip to drop into it. */
const ORDERED = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="stack" data-name="Stack" style={{ position: 'absolute', left: '200px', top: '100px', display: 'flex', flexDirection: 'column', gap: '12px', width: '400px', padding: '12px', backgroundColor: '#202040' }}>
    <div data-id="k0" data-name="K0" style={{ position: 'relative', flex: '0 0 auto', order: '0', height: '80px', backgroundColor: '#3a1a1a' }}></div>
    <div data-id="k1" data-name="K1" style={{ position: 'relative', flex: '0 0 auto', order: '1', height: '80px', backgroundColor: '#1a1a3a' }}></div>
    <div data-id="k2" data-name="K2" style={{ position: 'relative', flex: '0 0 auto', order: '2', height: '80px', backgroundColor: '#1a3a1a' }}></div>
  </div>
</div>`, {
  canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '160px', width: '160px', height: '50px', backgroundColor: '#ff66cc' }}></div>`,
});

/** A big page: `n` root sections of `kids` children each. */
function bigPage(n: number, kids: number, opts: { canvas?: string } = {}) {
  const sections = Array.from({ length: n }, (_, i) => `  <div data-id="sec${i}" data-name="Section ${i}" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '8px', width: '100%', height: '160px', padding: '12px', backgroundColor: '${i % 2 ? '#1a1a3a' : '#2a2a4a'}' }}>
${Array.from({ length: kids }, (_, k) => `    <div data-id="sec${i}-k${k}" data-name="K${k}" style={{ position: 'relative', flex: '0 0 auto', width: '40px', height: '40px', backgroundColor: '#556677' }}></div>`).join('\n')}
  </div>`).join('\n');
  return page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
${sections}
</div>`, { canvas: opts.canvas });
}

/** Two canvas-frame targets + a canvas chip, with the layers panel in play. */
const LIVE_LAYERS = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="box" data-name="Box" style={{ position: 'absolute', left: '200px', top: '100px', width: '500px', height: '400px', backgroundColor: '#202040' }}>
    <div data-id="peer" data-name="Peer" style={{ position: 'absolute', left: '20px', top: '20px', width: '60px', height: '60px', backgroundColor: '#33ccff' }}></div>
  </div>
</div>`, {
  canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '160px', width: '100px', height: '80px', backgroundColor: '#ff66cc' }}></div>`,
});

/** 3 tiles with a mobile band rule (the width write must re-key it). */
const VP_BANDS = seed8(pageModule8({
  tiles: TILES.three,
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '0px', width: '100%', minHeight: '900px', padding: '40px', backgroundColor: '#ffffff' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="hero"] { background-color: rgb(0, 128, 0) !important; }
    }
    @media (max-width: 375px) {
      [data-id="hero"] { background-color: rgb(255, 0, 0) !important; }
    }
  \`}</style>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: 'rgb(0, 0, 255)' }}></div>
</div>`,
}), { 'app/about/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`, 'app/about/page.client.tsx': pageModule8({ root: `<div data-id="about-root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '600px', backgroundColor: '#ffffff' }}></div>` }) });

/** A page file with stray module-level JSX: a corpse copy of `hero-title`
 *  (still in the tree) and a unique `lost` element nobody renders. */
const STRAY_JSX = seed8(`${pageModule8({ root: `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#1a1a3a' }}>
    <p data-id="hero-title" data-name="Title" style={{ position: 'relative', color: '#ffffff', fontSize: '32px', margin: '0px' }}>Hello</p>
  </div>
  <div data-id="features" data-name="Features" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#f5f5f7' }}></div>
  <div data-id="how" data-name="HowItWorks" style={{ position: 'relative', flex: '0 0 auto', height: '300px', backgroundColor: '#2a2a4a' }}></div>
</div>`, canvas: `<div data-id="floater" data-name="Floater" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '100px', width: '120px', height: '120px', backgroundColor: '#ff66cc' }}></div>` })}
<p data-id="hero-title" data-name="Title" style={{ position: 'relative', color: '#ffffff', fontSize: '32px', margin: '0px' }}>Hello</p>;
<div data-id="lost" data-name="Lost" style={{ position: 'absolute', left: '-300px', top: '400px', width: '120px', height: '80px', backgroundColor: '#33ccff' }}></div>;
`);

// ─── Helpers ──────────────────────────────────────────────────────────

const IDS = ['s1', 's2', 'row', 'r1', 'r2', 'col', 'c1', 'duo', 'frame', 'frame2', 'fk'];

/** Painted boxes of `ids` on every tile (null where a node paints nothing). */
async function tileBoxes(editor: Editor, ids: string[], tiles = ['desktop', 'tablet', 'mobile']): Promise<Record<string, Box | null>> {
  const out: Record<string, Box | null> = {};
  for (const vp of tiles) {
    for (const id of ids) {
      const loc = await editor.nodeIn(vp, id);
      const b = (await loc.count()) ? await loc.boundingBox({ timeout: 1_000 }).catch(() => null) : null;
      out[`${vp}:${id}`] = b && b.width > 0 && b.height > 0 ? b : null;
    }
  }
  return out;
}

function boxesMatch(a: Record<string, Box | null>, b: Record<string, Box | null>, tol = 1.5): string[] {
  const bad: string[] = [];
  for (const k of Object.keys(a)) {
    const x = a[k], y = b[k];
    if (!x && !y) continue;
    if (!x || !y || !near(x.x, y.x, tol) || !near(x.y, y.y, tol) || !near(x.width, y.width, tol) || !near(x.height, y.height, tol)) bad.push(k);
  }
  return bad;
}

/** One Cmd+Z restores the file byte-for-byte AND every tile's paint; one
 *  Cmd+Shift+Z re-applies the exact result. */
async function undoRestoresEverything(editor: Editor, kind: string, before: string, paintBefore: Record<string, Box | null>): Promise<void> {
  const after = await stableCode(editor);
  expect(after, `${kind}: the drag changed the file`).not.toBe(before);
  expect(dupIds(after), `${kind}: no duplicate data-id`).toEqual([]);
  const paintAfter = await tileBoxes(editor, IDS);
  await editor.undo();
  await expect.poll(() => editor.code(), { message: `${kind}: one undo restores the source byte-for-byte` }).toBe(before);
  await expect.poll(async () => boxesMatch(paintBefore, await tileBoxes(editor, IDS)), { message: `${kind}: every tile repaints the pre-drag state`, timeout: 6_000 }).toEqual([]);
  await editor.redo();
  await expect.poll(() => editor.code(), { message: `${kind}: one redo re-applies it` }).toBe(after);
  await expect.poll(async () => boxesMatch(paintAfter, await tileBoxes(editor, IDS)), { message: `${kind}: every tile repaints the drop`, timeout: 6_000 }).toEqual([]);
  await editor.page().waitForTimeout(450);
}

async function dragTo(editor: Editor, from: Pt, to: Pt, steps = 20, pumpAxis: 'x' | 'y' = 'x'): Promise<void> {
  await gesture(editor, from, async (g) => {
    await g.moveTo(to, steps);
    await g.pump(8, pumpAxis);
  });
}

// ─── DND-254 ──────────────────────────────────────────────────────────

test.describe('3 tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-254 every drag kind undoes in one step on every tile and redoes exactly', { tag: ['@p0', '@dnd', '@tiles'] }, async ({ editor }) => {
    test.setTimeout(300_000);
    await editor.load(KINDS, { fit: true });
    const page = editor.page();
    let before = '';
    let paint: Record<string, Box | null> = {};
    const snap = async () => { await page.waitForTimeout(300); before = await stableCode(editor); paint = await tileBoxes(editor, IDS); };

    // 1 · flex reorder (primary): s2 above s1.
    await snap();
    await dragTo(editor, await editor.at('s2', 0.5, 0.5, 'desktop'), await editor.at('s1', 0.5, 0.1, 'desktop'));
    await expect(editor).toHaveStyle('s2', 'order', '0');
    await undoRestoresEverything(editor, 'flex reorder', before, paint);

    // 2 · cross-parent move: fk out of `frame` into its sibling `frame2`.
    await snap();
    await dragTo(editor, await editor.at('fk', 0.5, 0.5, 'desktop'), await editor.at('frame2', 0.4, 0.5, 'desktop'), 30, 'y');
    await expect.poll(() => editor.parentOf('fk')).toBe('frame2');
    await undoRestoresEverything(editor, 'cross-parent move', before, paint);

    // 3 · exit to the canvas: fk out of its frame (frame2 since step 2), off the page.
    await snap();
    const rootD = await editor.nodeBoxIn('desktop', 'root');
    await dragTo(editor, await editor.at('fk', 0.5, 0.5, 'desktop'), { x: rootD.x - 60, y: rootD.y + rootD.height * 0.8 }, 30, 'y');
    await expect.poll(async () => (await editor.source()).byId.get('fk')?.attrs['data-canvas-node']).toBe('true');
    await undoRestoresEverything(editor, 'exit to canvas', before, paint);

    // 4 · entry into a frame: the canvas node cv into `frame`.
    await snap();
    const cvB = (await canvasBox(editor, 'cv'))!;
    await dragTo(editor, center(cvB), await editor.at('frame', 0.7, 0.6, 'desktop'), 30, 'y');
    await expect.poll(() => editor.parentOf('cv')).toBe('frame');
    await undoRestoresEverything(editor, 'entry into a frame', before, paint);

    // 5 · replica band write: s1 below s2 on the Tablet tile only.
    await snap();
    const s1T = await editor.nodeBoxIn('tablet', 's1');
    await page.mouse.click(center(s1T).x, center(s1T).y);
    await page.waitForTimeout(650);
    await dragTo(editor, center(s1T), await editor.at('s2', 0.5, 0.9, 'tablet'), 20, 'x');
    await expect.poll(() => editor.bandStyle(768, 's1', 'order').then(d => d?.value ?? null)).not.toBeNull();
    await undoRestoresEverything(editor, 'replica band write', before, paint);

    // 6 · replica split: r2 dragged out of the Tablet tile onto the canvas.
    await snap();
    const r2T = await editor.nodeBoxIn('tablet', 'r2');
    await page.mouse.click(center(r2T).x, center(r2T).y);
    await page.waitForTimeout(650);
    const tabRoot = await editor.nodeBoxIn('tablet', 'root');
    await dragTo(editor, center(r2T), { x: center(tabRoot).x, y: tabRoot.y + tabRoot.height + 80 }, 30, 'x');
    const canvasIds = (c: string) => parseSource(c).nodes.filter(n => n.parentId === null && n.attrs['data-canvas-node'] === 'true').map(n => n.id);
    const canvasBefore = canvasIds(before);
    await expect.poll(async () => canvasIds(await editor.code()).filter(id => !canvasBefore.includes(id)).length, { message: 'a fresh-id canvas clone holds the drop' }).toBe(1);
    await expect(editor).toHaveBandStyle(768, 'r2', 'display', 'none');
    await undoRestoresEverything(editor, 'replica split', before, paint);

    // 7 · layers drop: s1 dropped above `duo` in the tree.
    await snap();
    await openLayers(page);
    await revealRow(editor, 's1');
    await dragLayerRow(editor, lid('s1'), lid('duo'), 'top');
    await expect.poll(async () => (await visualOrder(editor, 'root')).indexOf('s1')).toBe(3);
    await undoRestoresEverything(editor, 'layers drop', before, paint);
    await page.keyboard.press('Escape');

    // 8 · Alt-duplicate: Alt held through a drag of fk.
    await snap();
    const fkB = await editor.nodeBoxIn('desktop', 'fk');
    const d = await CanvasDrag.press(page, center(fkB));
    try {
      await d.moveBy(40, 10, 10);
      await pressMidDrag(d, 'Alt', true);
      await expect.poll(async () => parseSource(await editor.code()).allIds.filter(i => i.startsWith('dup-')).length).toBe(1);
      await d.moveBy(30, 0, 6);
    } finally {
      await d.release();
      await page.keyboard.up('Alt');
    }
    await editor.settled();
    await undoRestoresEverything(editor, 'Alt-duplicate', before, paint);
  });
});

// ─── DND-255 ──────────────────────────────────────────────────────────

test('DND-255 drags never leave a duplicate data-id; a duplicating write is refused; a corrupt page stays editable', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  // validateGeneratedCode's duplicate-data-id net runs on the async drain
  // (processQueue) and refuses there. flushNow — the drain every drag drop,
  // creator and layers drop commits through — skips validation for move /
  // addNode / removeNode ("they keep the async processQueue validation",
  // mutation-queue.ts ~1280), so the same duplicating write is ACCEPTED.
  test.fail(true, 'BUG: the duplicate data-id net never runs on flushNow (the drag-commit drain): an addNode/move that duplicates an id is written to the file');
  await editor.load(FLEX3_AND_CORRUPT);
  await centerOn(editor, ['hero', 'chip']);
  const page = editor.page();

  // Drags of several kinds: reorder, Alt-duplicate, entry.
  const f = await editor.nodeBox('features');
  await dragTo(editor, center(f), await editor.at('hero', 0.5, 0.1));
  await expect(editor).toHaveStyle('features', 'order', '0');
  await expect(editor).toHaveNoDuplicateIds();
  await page.waitForTimeout(450);
  const chip = (await canvasBox(editor, 'chip'))!;
  const d = await CanvasDrag.press(page, center(chip));
  try {
    await d.moveBy(-40, 20, 8);
    await pressMidDrag(d, 'Alt', true);
    await expect.poll(async () => parseSource(await editor.code()).allIds.filter(i => i.startsWith('dup-')).length).toBe(1);
    await d.moveBy(-30, 0, 6);
  } finally {
    await d.release();
    await page.keyboard.up('Alt');
  }
  await stableCode(editor);
  await expect(editor).toHaveNoDuplicateIds();
  await page.waitForTimeout(450);
  const chip2 = (await canvasBox(editor, 'chip'))!;
  await dragTo(editor, center(chip2), await editor.at('how', 0.5, 0.5), 30, 'y');
  await expect.poll(() => editor.parentOf('chip')).toBe('how');
  await expect(editor).toHaveNoDuplicateIds();

  // A page that ALREADY carries a duplicate stays editable by drag (the gate
  // only blocks damage the flush itself causes).
  editor.allowErrors(/preexisting/);
  await editor.openFile(CORRUPT_PAGE);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, CORRUPT_PAGE);
  await editor.node('ca').waitFor({ state: 'attached', timeout: 15_000 });
  await editor.settled();
  await centerOn(editor, ['ca', 'cc']);
  expect(idCount(await editor.code(CORRUPT_PAGE), 'twin'), 'the page is corrupt').toBe(2);
  const beforeCorrupt = await editor.code(CORRUPT_PAGE);
  const cc = await editor.nodeBox('cc');
  await dragTo(editor, center(cc), await editor.at('ca', 0.5, 0.1));
  await expect(editor).toHaveStyle('cc', 'order', '0', { path: CORRUPT_PAGE });
  await expect(editor).toHaveStyle('ca', 'order', '1', { path: CORRUPT_PAGE });
  expect(idCount(await editor.code(CORRUPT_PAGE), 'twin'), 'not made worse').toBe(2);
  await expect(editor).toUndoInOneStep(beforeCorrupt, { path: CORRUPT_PAGE });

  // A write that WOULD duplicate an id is refused — on the queue's async
  // drain AND on the synchronous drain every drag drop commits through.
  await editor.openFile(PAGE);
  await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, PAGE);
  await editor.node('hero').waitFor({ state: 'attached', timeout: 15_000 });
  await editor.settled();
  editor.allowErrors(/Duplicate data-id|validation-failed/);
  for (const drain of ['async', 'flushNow'] as const) {
    const before = await stableCode(editor);
    const m = await mark(page);
    await page.evaluate(async (dr) => {
      const q = await import(/* @vite-ignore */ '/src/code/mutation/mutation-queue.ts' as string);
      q.queueMutation({ type: 'addNode', parentId: 'root', node: { id: 'hero', type: 'div', styles: { position: 'relative', flex: '0 0 auto', height: '40px', backgroundColor: '#ffffff' } } });
      if (dr === 'flushNow') q.flushNow();
    }, drain);
    const after = await stableCode(editor);
    expect(idCount(after, 'hero'), `${drain}: never two "hero"s in the file`).toBe(1);
    expect(after, `${drain}: the duplicating write was refused`).toBe(before);
    const refused = await since(page, m, 'validation-failed');
    expect(refused.length, `${drain}: refused by the validation gate`).toBeGreaterThan(0);
  }
});

// ─── DND-256 ──────────────────────────────────────────────────────────

test('DND-256 a node\'s own descendant offered as its drop parent is refused in tree, cache and generator', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(NESTED);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'leaf');
  const before = await editor.code();

  // 1 · the layers tree offers it: drag Outer onto its own grandchild.
  const m = await mark(page);
  const ind = await dragLayerRow(editor, lid('outer'), lid('inner'), 'middle');
  expect(ind?.position === 'inside' && ind.layerId === lid('inner'), 'no drop-inside indicator on a descendant').toBe(false);
  await stableCode(editor);
  expect(await editor.code(), 'snap-back: the tree drop changed nothing').toBe(before);
  await page.waitForTimeout(450);

  // 2 · the cache refuses a cyclic move (what a bad drop candidate commits first).
  // Both refusals are traced as errors (trace.error → console) on purpose.
  editor.allowErrors(/cycle-refused|parent-not-found|moveNodeInCode/);
  const cache = await page.evaluate(async () => {
    const st = await import(/* @vite-ignore */ '/src/code/stores/store.ts' as string);
    st.moveNodeInCache?.('outer', 'leaf', 0);
    const snap = (window as any).__e2e.nodesSnapshot();
    // Walk up from leaf: must terminate at the root without meeting a cycle.
    const seen = new Set<string>();
    let cur: string | null = 'leaf';
    while (cur && !seen.has(cur)) { seen.add(cur); cur = snap[cur]?.parentId ?? null; }
    return { cycle: !!cur, outerParent: snap.outer?.parentId ?? null, has: typeof st.moveNodeInCache === 'function' };
  });
  expect(cache.has, 'store exposes moveNodeInCache').toBe(true);
  expect(cache.cycle, 'no parent cycle in the node cache').toBe(false);
  expect(cache.outerParent).toBe('root');
  expect((await since(page, m, 'moveNodeInCache-cycle-refused')).length).toBeGreaterThan(0);

  // 3 · the generator refuses the same move: the node is never deleted.
  await page.evaluate(async () => {
    const q = await import(/* @vite-ignore */ '/src/code/mutation/mutation-queue.ts' as string);
    q.queueMutation({ type: 'move', nodeId: 'outer', newParentId: 'leaf', index: 0 });
    q.flushNow();
  });
  await editor.settled();
  await page.waitForTimeout(300);
  const after = await editor.code();
  expect(idCount(after, 'outer'), 'never deleted from the file').toBe(1);
  expect(idCount(after, 'leaf')).toBe(1);
  expect(ancestorsOf(after, 'leaf')).toEqual(['inner', 'outer', 'root']);
  // The refused move hands back the pre-surgery source (the generator's
  // import housekeeping adds `import React` — nothing structural).
  const lines = (c: string) => c.split('\n').filter(l => l.trim() !== '' && l !== "import React from 'react';");
  expect(lines(after)).toEqual(lines(before));
  // Still editable afterwards: a real reorder lands.
  const other = await editor.nodeBox('other');
  await dragTo(editor, center(other), await editor.at('outer', 0.5, 0.05));
  await expect(editor).toHaveStyle('other', 'order', '0');
});

// ─── DND-257 ──────────────────────────────────────────────────────────

test('DND-257 exit then entry in one gesture: the final move keeps the exit\'s cleanup and lands in the last target', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // A plain exit to the canvas strips `order` (the flow slot) — verified with
  // the same seed. Coalescing carries the exit move's styles as a BASE under
  // the entry move's (mutation-queue coalesceMoves), but the entry move's own
  // styles still hold the node's pre-exit `order: '1'`, which wins: the node
  // lands in the no-layout canvas frame still carrying its old flow order.
  test.fail(true, "BUG: exit→entry coalesced in one gesture loses the exit's `order` cleanup — s2 lands in the canvas frame still carrying order: '1'");
  await editor.load(EXIT_ENTRY);
  await centerOn(editor, ['s2', 'cf']);
  const page = editor.page();
  const before = await editor.code();
  const s2 = await editor.nodeBox('s2');
  const root = await editor.nodeBox('root');
  const cf = (await canvasBox(editor, 'cf'))!;
  const m = await mark(page);
  await gesture(editor, center(s2), async (g) => {
    // Out of the page onto open canvas…
    await g.moveTo({ x: root.x - 60, y: center(s2).y }, 24);
    await g.pump(6, 'y');
    // …then on into the canvas frame, same gesture.
    await g.moveTo({ x: cf.x + cf.width * 0.5, y: cf.y + cf.height * 0.5 }, 24);
    await g.pump(10, 'y');
  });
  await stableCode(editor);
  expect(await editor.parentOf('s2'), 'the destination is the last move\'s').toBe('cf');
  const st = await editor.style('s2');
  // The exit's cleanup rides on the final move: the flow `order` is gone, as
  // after a plain exit (which keeps `flex: '0 0 auto'`, inert on an absolute node).
  expect(st.position).toBe('absolute');
  expect(st.left).toBeTruthy();
  expect(st.top).toBeTruthy();
  const moves = (await since(page, m, '^queueMutation$')).filter(e => e.data?.type === 'move' && e.data?.nodeId === 's2');
  expect(moves.length, 'an exit move and an entry move').toBeGreaterThanOrEqual(2);
  expect((await since(page, m, '^mutation-queue:coalesced-moves$')).map(e => e.data?.carriedStyles), 'coalesced into one move').toContainEqual(['s2']);
  expect(st.flex ?? null).toBe('0 0 auto');
  expect(st.order ?? null, 'order removed').toBeNull();
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-258 ──────────────────────────────────────────────────────────

test('DND-258 a drop into an ordered flex parent (two flushes) never leaves the node invisible', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // The node stays visible, but the second flush (the order renumber) never
  // lands: the move is the only write — the chip gets no `order` and k1/k2
  // keep 1/2 in source while the canvas paints live orders 0/1/1/2 — and the
  // builder's own oracle rejects the result (FLEX_CHILD_MISSING_ORDER).
  test.fail(true, 'BUG: a canvas node dropped into an ORDERED flex parent gets no `order` and its siblings are not renumbered (FLEX_CHILD_MISSING_ORDER); canvas and source disagree');
  await editor.load(ORDERED);
  await centerOn(editor, ['stack', 'chip']);
  const page = editor.page();
  const before = await editor.code();
  const chip = (await canvasBox(editor, 'chip'))!;
  const k0 = await editor.nodeBox('k0');
  const k1 = await editor.nodeBox('k1');
  // Between k0 and k1 (painted order k0, k1, k2).
  const to = { x: center(k0).x, y: (k0.y + k0.height + k1.y) / 2 };
  await gesture(editor, center(chip), async (g) => {
    await g.moveTo(to, 30);
    await g.pump(10, 'x');
  });
  // Sample every frame for ~1s after the drop: never a frame without the chip.
  const invisible: number[] = [];
  for (let i = 0; i < 50; i++) {
    const vis = await editor.sandbox().locator('[data-viewport] [data-id="chip"]').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }).catch(() => false);
    if (!vis) invisible.push(i);
    await frames(page, 1);
  }
  expect(invisible, 'frames where the dropped chip was invisible').toEqual([]);
  expect(await editor.parentOf('chip')).toBe('stack');
  const st = await editor.style('chip');
  expect(st.order).toBe('1');
  await expect(editor).toHaveStyle('k1', 'order', '2');
  await expect(editor).toHaveStyle('k2', 'order', '3');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-259 ──────────────────────────────────────────────────────────

test('DND-259 a drag commit survives a reload and renders identically', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(FLEX3);
  await centerOn(editor, ['features']);
  const page = editor.page();
  const f = await editor.nodeBox('features');
  await dragTo(editor, center(f), await editor.at('hero', 0.5, 0.1));
  await expect(editor).toHaveStyle('features', 'order', '0');
  const committed = await stableCode(editor);
  // The local project persists it (autosave to the local backend).
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('revyme-project-local');
    try { return JSON.parse(raw ?? '{}').files?.['app/page.client.tsx'] ?? ''; } catch { return ''; }
  }), { timeout: 15_000 }).toBe(committed);
  const order = async () => {
    const ys: Array<[string, number]> = [];
    for (const id of ['hero', 'features', 'how']) ys.push([id, (await editor.nodeBox(id)).y]);
    return ys.sort((a, b) => a[1] - b[1]).map(e => e[0]);
  };
  const painted = await order();
  expect(painted).toEqual(['features', 'hero', 'how']);
  await page.reload();
  await editor.waitForCanvas();
  await editor.settled();
  expect(await editor.code(PAGE)).toBe(committed);
  await expect.poll(order).toEqual(painted);
});

// ─── DND-260 ──────────────────────────────────────────────────────────

test('DND-260 big page: dropping a canvas node into a flex section stays on the fast path and lands quickly', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(bigPage(44, 6, { canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-300px', top: '120px', width: '60px', height: '40px', backgroundColor: '#ff66cc' }}></div>` }));
  const page = editor.page();
  await centerOn(editor, ['chip', 'sec0']);
  await setZoom(editor, 0.5, { id: 'sec0', cssWidth: 1440 }, ['chip', 'sec0']);
  const before = await editor.code();
  expect(before.length).toBeGreaterThan(50_000);
  const chip = (await canvasBox(editor, 'chip'))!;
  const sec = await editor.nodeBox('sec0');
  const m = await mark(page);
  let upAt = 0;
  const g = await Gesture.press(page, center(chip));
  try {
    await g.moveTo({ x: sec.x + sec.width * 0.7, y: center(sec).y }, 30);
    await g.pump(10, 'y');
  } finally {
    await g.release();
    upAt = Date.now();
  }
  await pollCode(editor, (c) => parseSource(c).byId.get('chip')?.parentId === 'sec0', { timeout: 5_000, what: 'chip in sec0' });
  const landedMs = Date.now() - upAt;
  await stableCode(editor);
  expect((await editor.style('chip')).flex).toBe('0 0 auto');
  const gen = (await since(page, m, '^generator:')).map(e => e.c);
  expect(gen.filter(c => c === 'generator:fast-path-fallback-to-ast'), 'no full-file regenerate').toEqual([]);
  expect(gen.filter(c => /fast-path/.test(c)).length, 'the fast path ran').toBeGreaterThan(0);
  expect(landedMs, `commit landed in ${landedMs}ms`).toBeLessThan(2_500);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-261 ──────────────────────────────────────────────────────────

test('DND-261 big page: a reorder renumbering 8 root sections refreshes the page once per commit window', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(bigPage(8, 40));
  const page = editor.page();
  await centerOn(editor, ['sec0', 'sec1']);
  const before = await editor.code();
  const s1 = await editor.nodeBox('sec1');
  const s0 = await editor.nodeBox('sec0');
  const m = await mark(page);
  await dragTo(editor, center(s1), { x: center(s0).x, y: s0.y + 4 }, 20, 'x');
  await expect(editor).toHaveStyle('sec1', 'order', '0');
  for (let i = 2; i < 8; i++) await expect(editor).toHaveStyle(`sec${i}`, 'order', String(i));
  await page.waitForTimeout(600);
  const batches = await since(page, m, '^sandbox:subtree-refresh-batch$');
  const walks = await since(page, m, '^sandbox:subtree-refresh$');
  // Coalesced: the page-sized scope is swept by the batched funnel, never
  // walked once per patched section.
  const pageBatches = batches.filter(b => (b.data?.descendants ?? 0) > 300);
  expect(walks.filter(w => (w.data?.descendants ?? 0) > 300), 'no per-section page walk').toEqual([]);
  expect(pageBatches.length, `page sweeps: ${JSON.stringify(batches.map(b => b.data))}`).toBeLessThanOrEqual(2);
  for (const b of batches) expect(b.data?.scopes ?? 0).toBeLessThanOrEqual(1);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-262 ──────────────────────────────────────────────────────────

test('DND-262 the layers tree re-nests live during a canvas reparent drag', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(LIVE_LAYERS);
  await centerOn(editor, ['box', 'chip']);
  const page = editor.page();
  await openLayers(page);
  await revealRow(editor, 'peer');
  await expandRow(page, lid('box'));
  const depth = (id: string) => layerRow(page, lid(id)).getAttribute('data-layer-depth').then(v => Number(v));
  const boxDepth = await depth('box');
  const chipDepth0 = await depth('chip');
  expect(chipDepth0).not.toBe(boxDepth + 1);
  const before = await editor.code();
  const chip = (await canvasBox(editor, 'chip'))!;
  const box = await editor.nodeBox('box');
  const m = await mark(page);
  let midDepth = NaN;
  await gesture(editor, center(chip), async (g) => {
    await g.moveTo({ x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 }, 30);
    await g.pump(10, 'y');
    // Still holding the button: the structural move already reached the tree.
    await expect.poll(() => depth('chip'), { timeout: 3_000 }).toBe(boxDepth + 1);
    midDepth = await depth('chip');
    // The tree reads the structural flush; the file itself is still held by
    // the deferred drag flush until the gesture ends.
    const moves = (await since(page, m, '^queueMutation$')).filter(e => e.data?.type === 'move' && e.data?.nodeId === 'chip');
    expect(moves.length, 'the entry was committed as a move mid-drag').toBeGreaterThan(0);
  });
  expect(midDepth).toBe(boxDepth + 1);
  await stableCode(editor);
  expect(await depth('chip')).toBe(boxDepth + 1);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-263 ──────────────────────────────────────────────────────────

test.describe('3 tiles (viewport width)', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-263 a viewport width written inside a gesture keeps @canvas config and band rules in agreement', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(VP_BANDS, { fit: true });
    const page = editor.page();
    const widths = (c: string) => {
      const m = /\/\*\* @canvas ([\s\S]*?) \*\//.exec(c);
      return m ? Object.fromEntries(JSON.parse(m[1]).viewports.map((v: any) => [v.id, v.width])) : {};
    };
    const heads = (c: string) => [...c.matchAll(/@media[^{]*(?=\{)/g)].map(x => x[0].trim());
    // Select the Mobile tile (its header label) and drag its right edge wider.
    const mRoot = await editor.nodeBoxIn('mobile', 'root');
    await page.getByText('Mobile', { exact: true }).first().click();
    await editor.settled();
    expect(await editor.selection()).toEqual(['root']);
    const scale = mRoot.width / 375;
    await resizeBy(editor, { edge: 'right', along: 0.3 }, Math.round((636 - 375) * scale), 0, 16);
    const code = await stableCode(editor);
    const w = widths(code).mobile;
    expect(w, `@canvas mobile width ${w}`).toBeGreaterThan(560);
    // Config and band rules agree: the mobile band is keyed by the config width,
    // the tablet band's floor sits just above it.
    expect(heads(code)).toContain(`@media (max-width: ${w}px)`);
    expect(heads(code).some(h => h.includes(`min-width: ${w}.02px`))).toBe(true);
    expect(code).not.toContain('@media (max-width: 375px)');
    // And they stay in agreement across a file round trip (where the old
    // revert showed: config back to 375 while the bands kept the new width).
    await editor.openFile('app/about/page.client.tsx');
    await page.waitForFunction(() => (window as any).__e2e.activeFile() === 'app/about/page.client.tsx');
    await editor.settled();
    await editor.openFile(PAGE);
    await page.waitForFunction((p) => (window as any).__e2e.activeFile() === p, PAGE);
    await editor.settled();
    const after = await stableCode(editor, PAGE);
    expect(widths(after).mobile).toBe(w);
    expect(heads(after)).toContain(`@media (max-width: ${w}px)`);
  });
});

// ─── DND-264 ──────────────────────────────────────────────────────────

test('DND-264 a stray module-level JSX copy is healed on the next edit: corpse dropped, unique content folded into canvasNodes', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(STRAY_JSX);
  await centerOn(editor, ['features']);
  const page = editor.page();
  const code0 = await editor.code();
  expect(idCount(code0, 'hero-title'), 'the seed carries the corpse copy').toBe(2);
  // Any edit — here a reorder drag.
  const m = await mark(page);
  const f = await editor.nodeBox('features');
  await dragTo(editor, center(f), await editor.at('hero', 0.5, 0.1));
  await expect(editor).toHaveStyle('features', 'order', '0');
  const code = await stableCode(editor);
  expect(idCount(code, 'hero-title'), 'the corpse copy is dropped').toBe(1);
  expect(await editor.parentOf('hero-title')).toBe('hero');
  const lost = parseSource(code).byId.get('lost');
  expect(lost, 'the unique stray element survives').toBeTruthy();
  expect(lost!.attrs['data-canvas-node']).toBe('true');
  expect(code.indexOf('data-id="lost"')).toBeGreaterThan(code.indexOf('const canvasNodes'));
  expect(code).not.toMatch(/\n<p data-id="hero-title"/);
  expect(dupIds(code)).toEqual([]);
  const snap = await page.evaluate(() => Object.keys((window as any).__e2e.nodesSnapshot()));
  expect(snap.filter(id => id === 'hero-title')).toHaveLength(1);
  const healed = (await since(page, m, '^generator:heal-dangling-jsx')).map(e => e.c);
  expect(healed).toContain('generator:heal-dangling-jsx-dropped-duplicate');
  expect(healed).toContain('generator:heal-dangling-jsx-folded-into-canvas');
  await expect.poll(() => canvasBox(editor, 'lost')).not.toBeNull();
});
