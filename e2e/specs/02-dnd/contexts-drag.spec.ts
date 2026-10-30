// DND · Transformed, clipped, scrolled, hidden and RTL contexts (E2E_TEST_PLAN.md §2).
//
// Drags whose parent chain is rotated, scaled, skewed or under perspective;
// a scrolled overflow frame; a frame hidden on one tile; and a locale whose
// text runs right to left. The cursor must keep its grip on what it grabbed,
// the commit must land in the parent's own units, and exits must follow the
// VISUAL quad, not an axis-aligned box.

import { test, expect, TILES, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  page8, pageModule8, seed8, center, near, Gesture, gesture, stableCode, mark, since, frames,
  iframeOffset, pickLocale, quickBox, type Box, type Pt,
} from '../../helpers/d8';
import { centerOn } from '../../helpers/d3';
import { dropLine, placeholders } from '../../helpers/d1';
import { snapGuideLines } from '../../helpers/d4';
import { prime } from '../../helpers/d6';
import { parseSource } from '../../helpers/code';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ────────────────────────────────────────────────────────────

const W700 = [{ id: 'desktop', label: 'Desktop', width: 700 }];

/** ROTATED_FLEX_FRAME: a flex column rotated 90°, holding chip then card. */
const ROTATED_FLEX_FRAME = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '700px', minHeight: '640px', backgroundColor: '#0d0d1a' }}>
  <div data-id="spinframe" data-name="Frame" style={{ position: 'absolute', width: '260px', height: '400px', backgroundColor: '#7d7d7d', left: '220px', top: '120px', transform: 'rotate(90deg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
    <div data-id="chip" data-name="Chip" style={{ position: 'relative', width: '120px', height: '40px', backgroundColor: '#ff6b6b', flex: '0 0 auto' }}></div>
    <div data-id="card" data-name="Card" style={{ position: 'relative', width: '120px', height: '160px', backgroundColor: '#baffc9', flex: '0 0 auto' }}></div>
  </div>
</div>`, { tiles: W700 });

/** A pinned child under a REAL translate + scale ancestor (the old seed's
 *  `translateX(0px) scale(1)` is the identity and can't show an offset). */
const ABSOLUTE_IN_TRANSFORMED_FRAME = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '0px', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="hero" data-name="Hero" style={{ position: 'relative', height: '400px', backgroundColor: '#1a1a3a', transform: 'translateX(60px) scale(1.25)' }}>
    <div data-id="pinned-child" data-name="PinnedChild" style={{ position: 'absolute', left: '80px', top: '60px', width: '120px', height: '120px', backgroundColor: '#66ccff' }}></div>
  </div>
</div>`);

const SKEW = 20;
/** A skewed frame and a perspective frame, each holding an absolute child. */
const SKEW_AND_PERSPECTIVE = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="skewed" data-name="Skewed" style={{ position: 'absolute', left: '200px', top: '120px', width: '400px', height: '300px', backgroundColor: '#2a2a5a', transform: 'skewX(${SKEW}deg)' }}>
    <div data-id="skew-kid" data-name="SkewKid" style={{ position: 'absolute', left: '40px', top: '200px', width: '80px', height: '60px', backgroundColor: '#ffcc66' }}></div>
    <div data-id="skew-peer" data-name="SkewPeer" style={{ position: 'absolute', left: '240px', top: '40px', width: '80px', height: '60px', backgroundColor: '#66ffcc' }}></div>
  </div>
  <div data-id="persp" data-name="Persp" style={{ position: 'absolute', left: '760px', top: '120px', width: '400px', height: '300px', backgroundColor: '#3a2a4a', transform: 'perspective(600px) rotateY(35deg)' }}>
    <div data-id="persp-kid" data-name="PerspKid" style={{ position: 'absolute', left: '40px', top: '120px', width: '80px', height: '60px', backgroundColor: '#ff66aa' }}></div>
    <div data-id="persp-peer" data-name="PerspPeer" style={{ position: 'absolute', left: '240px', top: '40px', width: '80px', height: '60px', backgroundColor: '#66aaff' }}></div>
  </div>
</div>`);

/** A frame inside a rotated (45°) ancestor; the frame holds an absolute kid. */
const ROTATED_ANCESTOR = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="spin" data-name="Spin" style={{ position: 'absolute', left: '420px', top: '150px', width: '600px', height: '600px', backgroundColor: '#202040', transform: 'rotate(45deg)' }}>
    <div data-id="inner" data-name="Inner" style={{ position: 'absolute', left: '150px', top: '150px', width: '300px', height: '300px', backgroundColor: '#404080' }}>
      <div data-id="kid" data-name="Kid" style={{ position: 'absolute', left: '120px', top: '120px', width: '60px', height: '60px', backgroundColor: '#ffcc33' }}></div>
    </div>
  </div>
</div>`);

/** An overflow:auto frame with tall content and an absolute child at top 300. */
const SCROLLED = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '1440px', minHeight: '900px', backgroundColor: '#0d0d1a' }}>
  <div data-id="scroller" data-name="Scroller" style={{ position: 'absolute', left: '300px', top: '100px', width: '500px', height: '400px', overflow: 'auto', backgroundColor: '#202030' }}>
    <div data-id="spacer" data-name="Spacer" style={{ position: 'absolute', left: '0px', top: '990px', width: '10px', height: '10px', backgroundColor: '#2a2a40' }}></div>
    <div data-id="sc-kid" data-name="ScKid" style={{ position: 'absolute', left: '100px', top: '300px', width: '100px', height: '80px', backgroundColor: '#ff9933' }}></div>
  </div>
</div>`);

/** 3 tiles: `trap` (a frame) is hidden on Tablet; `mover` sits beside it. */
const HIDDEN_ON_TABLET = seed8(pageModule8({
  tiles: TILES.three,
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '700px', backgroundColor: '#0d0d1a' }}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="trap"] { display: none !important; }
    }
  \`}</style>
  <div data-id="trap" data-name="Trap" style={{ position: 'absolute', left: '40px', top: '40px', width: '300px', height: '240px', backgroundColor: '#3355ff' }}></div>
  <div data-id="mover" data-name="Mover" style={{ position: 'absolute', left: '420px', top: '120px', width: '80px', height: '80px', backgroundColor: '#ff66cc' }}></div>
</div>`,
}));

/** RTL_TEXT: a nav ROW + Arabic/English lines, Arabic configured. */
function rtlSeed() {
  const s = page8(`
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', minHeight: '500px', position: 'relative', backgroundColor: '#ffffff', padding: '40px' }}>
  <div data-id="nav" data-name="Nav" style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: '24px', width: '800px', height: '40px' }}>
    <p data-id="logo" data-name="Logo" style={{ position: 'relative', fontSize: '20px' }}>bachuki</p>
    <p data-id="link" data-name="Link" style={{ position: 'relative', fontSize: '16px' }}>Atelier</p>
    <p data-id="contact" data-name="Contact" style={{ position: 'relative', fontSize: '16px' }}>Contact</p>
  </div>
  <p data-id="arabic" data-name="Arabic" style={{ position: 'relative', width: '600px', fontSize: '20px', backgroundColor: '#eeeeee' }}>مرحبا يا صديقي؟</p>
  <p data-id="english" data-name="English" style={{ position: 'relative', width: '600px', fontSize: '20px', backgroundColor: '#eeeeee' }}>hello my friend?</p>
</div>`);
  s.files['i18n/config.json'] = JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'Arabic', direction: 'rtl' }] }, null, 2);
  s.files['messages/en.json'] = '{}';
  s.files['messages/ar.json'] = '{}';
  s.files['i18n/ar.json'] = JSON.stringify({ pages: {}, collections: {} });
  return s;
}
const RTL_TEXT = rtlSeed();

// ─── Geometry ─────────────────────────────────────────────────────────

/** Camera scale from the page root's painted width. */
async function camScale(editor: Editor, cssWidth: number, id = 'root'): Promise<number> {
  return (await editor.nodeBox(id)).width / cssWidth;
}

/** Topmost data-id under a page point, inside the sandbox. */
async function hitAt(editor: Editor, p: Pt): Promise<string | null> {
  const off = await iframeOffset(editor);
  return editor.sandbox().locator('body').evaluate((_, q) => {
    const el = document.elementFromPoint(q.x, q.y);
    return el?.closest('[data-id]')?.getAttribute('data-id') ?? null;
  }, { x: p.x - off.x, y: p.y - off.y });
}

/** The painted parallelogram of a skewX(θ) element from its AABB (origin
 *  centre: the bottom edge sits `h·tanθ` right of the top edge). */
function skewQuad(aabb: Box, deg: number): Pt[] {
  const t = Math.tan(deg * Math.PI / 180);
  const h = aabb.height;
  const w = aabb.width - h * t;
  return [
    { x: aabb.x, y: aabb.y }, { x: aabb.x + w, y: aabb.y },
    { x: aabb.x + aabb.width, y: aabb.y + h }, { x: aabb.x + h * t, y: aabb.y + h },
  ];
}

/** The painted diamond of a square rotated 45° from its AABB. */
function diamond(aabb: Box): Pt[] {
  const cx = aabb.x + aabb.width / 2, cy = aabb.y + aabb.height / 2;
  return [{ x: cx, y: aabb.y }, { x: aabb.x + aabb.width, y: cy }, { x: cx, y: aabb.y + aabb.height }, { x: aabb.x, y: cy }];
}

function inQuad(p: Pt, q: Pt[], pad = 0): boolean {
  // Convex quad, corners in order: p is inside when it sits on the same side of every edge.
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const cross = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
    if (Math.abs(cross) <= pad) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/** Signed distance (px) of a point outside a convex quad (negative = inside). */
function outsideBy(p: Pt, q: Pt[]): number {
  let worst = -Infinity;
  // Orientation of the quad (clockwise on screen = positive cross inside).
  const o = Math.sign((q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[1].y - q[0].y) * (q[2].x - q[0].x));
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const cross = o * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
    worst = Math.max(worst, -cross);
  }
  return worst;
}

/** Nearest data-id ancestor of the PAINTED copy of `id` (null when missing). */
async function domParentOf(editor: Editor, id: string): Promise<string | null> {
  return editor.sandbox().locator('body').evaluate((_, i) => {
    const els = [...document.querySelectorAll(`[data-id="${i}"]`)] as HTMLElement[];
    const el = els.find(e => e.getBoundingClientRect().width > 0) ?? els[0];
    return el?.parentElement?.closest('[data-id]')?.getAttribute('data-id') ?? null;
  }, id);
}

/** Ids sorted by their painted left edge. */
async function xOrder(editor: Editor, ids: string[]): Promise<string[]> {
  const xs: Array<[string, number]> = [];
  for (const id of ids) xs.push([id, (await editor.nodeBox(id)).x]);
  return xs.sort((a, b) => a[1] - b[1]).map(e => e[0]);
}

async function paintedBox(editor: Editor, id: string): Promise<Box | null> {
  return quickBox(editor.sandbox().locator(`[data-id="${id}"]`));
}

// ─── DND-229 ──────────────────────────────────────────────────────────

test('DND-229 a flow child of a rotate(90deg) frame lifts at its CSS size and stays centred on the cursor', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROTATED_FLEX_FRAME);
  await centerOn(editor, ['spinframe']);
  const page = editor.page();
  const chip = await editor.nodeBox('chip');
  // The painted AABB is the rotated 40×120 box.
  expect(chip.height).toBeGreaterThan(chip.width);
  const from = center(chip);
  const m = await mark(page);
  await gesture(editor, from, async (g) => {
    const steps: Pt[] = [{ x: from.x + 30, y: from.y + 20 }, { x: from.x + 60, y: from.y + 40 }];
    for (const to of steps) {
      await g.moveTo(to, 12);
      await g.pump(6, 'x');
      const info = await editor.sandbox().locator('[data-id="chip"]').first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: (el as HTMLElement).style.width, h: (el as HTMLElement).style.height };
      });
      const off = await iframeOffset(editor);
      // CSS size 120×40, never the painted 40×120 AABB.
      expect(info.w).toBe('120px');
      expect(info.h).toBe('40px');
      // Grabbed at the centre → the lifted chip's centre tracks the pointer.
      expect(Math.abs(info.cx + off.x - to.x), `x drift at ${JSON.stringify(to)}`).toBeLessThan(3);
      expect(Math.abs(info.cy + off.y - to.y), `y drift at ${JSON.stringify(to)}`).toBeLessThan(3);
    }
    await g.moveTo(from, 12);
    await g.hold(4);
  });
  expect((await since(page, m, '^drag:start$')).map(t => t.data?.strategy)).toEqual(['layout-lifted']);
  expect(await since(page, m, '^layout-lifted:live-size-skip-rotated-ancestor$')).not.toHaveLength(0);
});

// ─── DND-230 ──────────────────────────────────────────────────────────

test('DND-230 reorder inside a rotate(90deg) column follows the frame\'s own axis', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROTATED_FLEX_FRAME);
  await centerOn(editor, ['spinframe']);
  const page = editor.page();
  const before = await editor.code();
  const chip = await editor.nodeBox('chip');
  const card = await editor.nodeBox('card');
  // Column flow (chip → card) runs right-to-left on screen after the 90° turn.
  expect(chip.x).toBeGreaterThan(card.x + card.width - 2);

  const to = { x: chip.x + chip.width + 25, y: center(chip).y };
  let hole: Box | null = null;
  let line: Awaited<ReturnType<typeof dropLine>> = null;
  await gesture(editor, center(card), async (g) => {
    await g.moveTo(to, 24);
    await g.pump(8, 'y');
    const holes = await placeholders(editor);
    expect(holes).toHaveLength(1);
    hole = holes[0];
    line = await dropLine(page);
    // The placeholder is the card's slot drawn in the frame's local frame:
    // the rotated 120×160 hole paints 160 wide × 120 tall, at the column's
    // START (screen right), with the chip pushed after it (screen left).
    expect(near(hole.width / hole.height, 160 / 120, 0.08), `hole ${hole.width}×${hole.height}`).toBe(true);
    const chipNow = await editor.nodeBox('chip');
    expect(hole.x, 'slot 0 sits at the column start (screen right)').toBeGreaterThan(chipNow.x + chipNow.width - 2);
  });
  // Same-parent reorder: the hole is the indicator, no drop line is drawn.
  expect(line).toBeNull();
  await expect(editor).toHaveStyle('card', 'order', '0');
  await expect(editor).toHaveStyle('chip', 'order', '1');
  await expect(editor).toHaveJsxOrder('spinframe', ['chip', 'card']);
  // Painted: the card now holds the column start (screen right).
  await expect.poll(async () => (await editor.nodeBox('card')).x > (await editor.nodeBox('chip')).x).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-231 ──────────────────────────────────────────────────────────

/** A committed inset in px against the parent's own size (`40%` of 400 = 160). */
const insetPx = (v: string | undefined, parentSize: number): number =>
  !v ? NaN : v.trim().endsWith('%') ? parseFloat(v) / 100 * parentSize : parseFloat(v);

test('DND-231 a pinned child under a translate+scale ancestor stays under the cursor and commits in local units', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ABSOLUTE_IN_TRANSFORMED_FRAME);
  await centerOn(editor, ['pinned-child']);
  const page = editor.page();
  const before = await editor.code();
  const cam = await camScale(editor, 1440);
  const total = cam * 1.25;
  const kid = await editor.nodeBox('pinned-child');
  const hero = await editor.nodeBox('hero');
  expect(near(kid.width, 120 * total, 1.5), 'the ancestor scale paints the child 1.25×').toBe(true);
  // Grab off-centre so a scale/offset error shows up as drift.
  const from = { x: kid.x + kid.width * 0.25, y: kid.y + kid.height * 0.25 };
  const grip = { x: from.x - kid.x, y: from.y - kid.y };
  const delta = { x: 100, y: 60 };
  const m = await mark(page);
  let worst = 0;
  await gesture(editor, from, async (g) => {
    await g.moveBy(delta.x, delta.y, 20, async (p) => {
      const b = await paintedBox(editor, 'pinned-child');
      if (!b) return;
      worst = Math.max(worst, Math.hypot(b.x + grip.x - p.x, b.y + grip.y - p.y));
    });
    await g.pump(4, 'x');
  });
  expect((await since(page, m, '^drag:start$')).map(t => t.data?.strategy)).toEqual(['absolute-in-frame']);
  // Snapping is always on: allow its sticky zone (a few CSS px), nothing like
  // the 25% / 60px offset an ancestor-transform error produces.
  // (an ignored ancestor scale would drift 25px over this move).
  expect(worst, 'no drift from the ancestor transform during the drag').toBeLessThan(10 * total);
  await stableCode(editor);
  expect(await editor.parentOf('pinned-child')).toBe('hero');
  // Parent-local units: screen delta ÷ (camera × 1.25), within the snap zone.
  const st = await editor.style('pinned-child');
  const left = insetPx(st.left, 1440), top = insetPx(st.top, 400);
  expect(Math.abs(left - (80 + delta.x / total)), `left ${st.left}`).toBeLessThan(10);
  expect(Math.abs(top - (60 + delta.y / total)), `top ${st.top}`).toBeLessThan(10);
  // …and the committed value paints exactly there (hero origin + value × 1.25 × camera).
  await expect.poll(async () => {
    const b = (await paintedBox(editor, 'pinned-child'))!;
    return near(b.x, hero.x + left * total, 1.5) && near(b.y, hero.y + top * total, 1.5);
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-232 ──────────────────────────────────────────────────────────

test('DND-232 skewed and perspective frames: 1:1 tracking, no snap guides, exit only outside the painted quad', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  // AbsoluteInFrameStrategy disables snapping under a transformed ancestor
  // via nodeOrAncestorHasRotationOrSkewById → matrixHasRotationSkewOrFlip,
  // which reads only the 2D a/b/c/d terms: `perspective() rotateY()` leaves
  // b = c = 0, so the sibling-AABB guides still show under a 3D ancestor.
  test.fail(true, 'BUG: snap guides still show under a perspective/rotateY ancestor — the transformed-ancestor gate only detects 2D rotation/skew');
  await editor.load(SKEW_AND_PERSPECTIVE);
  await centerOn(editor, ['skewed', 'persp']);
  const page = editor.page();
  const before = await editor.code();

  // ── Skew: track inside, then sweep right until it leaves the painted quad.
  const frameAabb = await editor.nodeBox('skewed');
  const quad = skewQuad(frameAabb, SKEW);
  const sk = await editor.nodeBox('skew-kid');
  const from = center(sk);
  const grip = { x: from.x - sk.x, y: from.y - sk.y };
  const m = await mark(page);
  let guides = 0;
  let drift = 0;
  let firstOutside = -1;
  let exitedAt = -1;
  await gesture(editor, from, async (g) => {
    // Inside: 1:1.
    await g.moveBy(60, -20, 16, async (p) => {
      guides += (await snapGuideLines(page)).length;
      const b = await paintedBox(editor, 'skew-kid');
      if (b) drift = Math.max(drift, Math.hypot(b.x + grip.x - p.x, b.y + grip.y - p.y));
    });
    expect(await domParentOf(editor, 'skew-kid'), 'still in the frame').toBe('skewed');
    // Sweep right 4px per frame along the frame's lower half.
    for (let i = 0; i < 120 && exitedAt < 0; i++) {
      await g.moveBy(4, 0, 1);
      const b = await paintedBox(editor, 'skew-kid');
      // The page root is a plain frame, so the exit goes to it (grandparent):
      // it fires once the kid is COMPLETELY outside the painted quad.
      if (b && firstOutside < 0 && skewQuad(b, SKEW).every(c => !inQuad(c, quad, 0.5))) firstOutside = i;
      if ((await since(page, m, '^abs-in-frame:(grandparent-reparent-begin|exit-begin)$')).length) exitedAt = i;
    }
    await g.pump(4, 'y');
  });
  expect(drift, 'skew: the grabbed point stays under the cursor').toBeLessThan(4);
  expect(guides, 'skew: no snap guides under the transformed ancestor').toBe(0);
  expect(firstOutside, 'the sweep left the painted quad').toBeGreaterThanOrEqual(0);
  expect(exitedAt, 'the exit fired').toBeGreaterThanOrEqual(0);
  // Exit only once a corner is visually outside — and promptly (1-frame exit threshold).
  expect(exitedAt).toBeGreaterThanOrEqual(firstOutside);
  expect(exitedAt - firstOutside).toBeLessThanOrEqual(3);
  await stableCode(editor);
  expect(await editor.parentOf('skew-kid')).toBe('root');
  await expect(editor).toUndoInOneStep(before);
  await page.waitForTimeout(450);

  // ── Perspective: the grabbed point stays under the cursor, no guides.
  const pk = await editor.nodeBox('persp-kid');
  const pFrom = center(pk);
  let pGuides = 0;
  const pMisses: string[] = [];
  await gesture(editor, pFrom, async (g) => {
    await g.moveBy(90, 30, 24, async (p) => {
      pGuides += (await snapGuideLines(page)).length;
      const hit = await hitAt(editor, p);
      if (hit !== 'persp-kid') pMisses.push(`${Math.round(p.x)},${Math.round(p.y)}→${hit}`);
    });
    await g.moveTo(pFrom, 12);
    await g.hold(4);
  });
  expect(pMisses, 'the child never slides from under the cursor (no drift toward the vanishing point)').toEqual([]);
  expect(await editor.parentOf('persp-kid')).toBe('persp');
  expect(pGuides, 'no snap guides under a perspective ancestor').toBe(0);
});

// ─── DND-233 ──────────────────────────────────────────────────────────

test('DND-233 a frame child under a rotated ancestor detaches at the VISUAL edge, once per crossing', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(ROTATED_ANCESTOR);
  await centerOn(editor, ['spin']);
  const page = editor.page();
  const before = await editor.code();
  const cam = await camScale(editor, 1440);
  const innerAabb = await editor.nodeBox('inner');
  const innerQuad = diamond(innerAabb);
  const kid = await editor.nodeBox('kid');
  const from = center(kid);
  const m = await mark(page);
  // Up-right = straight through the inner diamond's upper-right EDGE, where
  // its AABB reaches twice as far (to the AABB corner) as the painted edge.
  const step = 3;
  let detachAt = -1;
  let detachDist = NaN;
  let kidAabbAtDetach: Box | null = null;
  await gesture(editor, from, async (g) => {
    for (let i = 0; i < 200 && detachAt < 0; i++) {
      await g.moveBy(step, -step, 1);
      if ((await since(page, m, '^abs-in-frame:(grandparent-reparent-begin|exit-begin)$')).length) {
        detachAt = i;
        const b = await paintedBox(editor, 'kid');
        kidAabbAtDetach = b;
        // How far past the inner frame's VISUAL edge the kid's nearest corner is.
        if (b) detachDist = Math.min(...diamond(b).map(c => outsideBy(c, innerQuad)));
      }
    }
    // Keep going a little (still inside Spin): one crossing detaches once,
    // with no bounce back into Inner.
    await g.moveBy(12, -12, 6);
    await g.pump(6, 'y');
  });
  const detaches = (await since(page, m, '^abs-in-frame:(grandparent-reparent-begin|exit-begin)$')).filter(t => (t.data?.fromParentId ?? 'inner') === 'inner');
  expect(detaches, 'exactly one detach for one crossing').toHaveLength(1);
  expect((await since(page, m, '^abs-in-frame:sibling-entry-confirmed$')), 'no bounce back in').toEqual([]);
  expect(detachAt).toBeGreaterThanOrEqual(0);
  // Within a few px of the painted edge (a step or two of travel)…
  expect(detachDist, `detach ${detachDist}px past the visual edge`).toBeGreaterThanOrEqual(-1);
  expect(detachDist, `detach ${detachDist}px past the visual edge`).toBeLessThan(4 * step * Math.SQRT2 + 2);
  // …while the kid's box still overlaps the inner frame's AABB: an AABB test
  // would not have detached for another ~180 CSS px of travel.
  const k = kidAabbAtDetach!;
  const overlaps = k.x < innerAabb.x + innerAabb.width && k.x + k.width > innerAabb.x && k.y < innerAabb.y + innerAabb.height && k.y + k.height > innerAabb.y;
  expect(overlaps, 'detached long before leaving the AABB').toBe(true);
  const travelled = Math.hypot(step * (detachAt + 1), step * (detachAt + 1)) / cam;
  expect(travelled, `travel ${travelled} CSS px`).toBeLessThan(250);
  await stableCode(editor);
  expect(await editor.parentOf('kid')).toBe('spin');
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-234 ──────────────────────────────────────────────────────────

test('DND-234 an absolute child of an overflow:auto frame scrolled 200px stays under the cursor and paints where released', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(SCROLLED);
  await centerOn(editor, ['scroller']);
  const page = editor.page();
  const before = await editor.code();
  // Setup: scroll the frame's own content 200px down. The canvas never
  // scrolls an inner frame itself (wheels pan the camera), and the rect cache
  // only re-measures on a render or a camera move — so nudge the camera.
  await editor.sandbox().locator('[data-id="scroller"]').first().evaluate((el) => { (el as HTMLElement).scrollTop = 200; });
  const r0 = await editor.nodeBox('root');
  await page.mouse.move(r0.x + 40, r0.y + 40);
  await page.mouse.wheel(0, 30);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, -30);
  await page.waitForTimeout(300);
  await editor.settled();
  const cam = await camScale(editor, 1440);
  const kid = await editor.nodeBox('sc-kid');
  const scroller = await editor.nodeBox('scroller');
  expect(near(kid.y - scroller.y, 100 * cam, 2), 'scrolled: the child paints 100px below the frame top').toBe(true);
  const from = center(kid);
  const grip = { x: from.x - kid.x, y: from.y - kid.y };
  let drift = 0;
  const m = await mark(page);
  await gesture(editor, from, async (g) => {
    await g.moveBy(40, 40, 16, async (p) => {
      const b = await paintedBox(editor, 'sc-kid');
      if (b) drift = Math.max(drift, Math.hypot(b.x + grip.x - p.x, b.y + grip.y - p.y));
    });
    await g.pump(4, 'x');
  });
  expect((await since(page, m, '^drag:start$')).map(t => t.data?.nodes?.[0]?.id), 'the press grabbed the child').toEqual(['sc-kid']);
  expect(drift, 'the child stays under the cursor in the scrolled frame').toBeLessThan(10 * cam);
  await stableCode(editor);
  expect(await editor.parentOf('sc-kid')).toBe('scroller');
  // Pinned today: the commit is in the frame's own (unscrolled) coordinates
  // — top = 300 + Δ/scale — and paints where released while the frame is
  // still scrolled 200px (the drag code has no scroll-specific branch).
  const st = await editor.style('sc-kid');
  const left = insetPx(st.left, 500), top = insetPx(st.top, 400);
  expect(Math.abs(left - (100 + 40 / cam)), `left ${st.left}`).toBeLessThan(10);
  expect(Math.abs(top - (300 + 40 / cam)), `top ${st.top}`).toBeLessThan(10);
  const scrollTop = await editor.sandbox().locator('[data-id="scroller"]').first().evaluate(el => (el as HTMLElement).scrollTop);
  expect(scrollTop).toBe(200);
  await expect.poll(async () => {
    const b = await editor.nodeBox('sc-kid');
    return near(b.x, scroller.x + left * cam, 2) && near(b.y, scroller.y + (top - scrollTop) * cam, 2);
  }).toBe(true);
  const after = await editor.nodeBox('sc-kid');
  expect(near(after.x, kid.x + 40, 10 * cam) && near(after.y, kid.y + 40, 10 * cam), 'it paints where it was released').toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-235 ──────────────────────────────────────────────────────────

test.describe('3 tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-235 a frame hidden on Tablet is never a drop candidate there', { tag: ['@p2', '@dnd', '@tiles'] }, async ({ editor }) => {
    await editor.load(HIDDEN_ON_TABLET, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    // On Desktop the trap is a real frame; on Tablet it paints nothing.
    expect(await quickBox(await editor.nodeIn('desktop', 'trap'))).not.toBeNull();
    const trapTablet = await quickBox(await editor.nodeIn('tablet', 'trap'));
    expect(!trapTablet || trapTablet.width === 0, 'hidden on tablet').toBe(true);
    const trapDesk = await editor.nodeBoxIn('desktop', 'trap');
    const rootDesk = await editor.nodeBoxIn('desktop', 'root');
    const rootTab = await editor.nodeBoxIn('tablet', 'root');
    const s = rootTab.width / 768;
    // The trap's area on Tablet (same CSS position as on Desktop).
    const area = { x: rootTab.x + (trapDesk.x - rootDesk.x + trapDesk.width / 2) / (rootDesk.width / 1440) * s, y: rootTab.y + 160 * s };
    await prime(editor, 'mover', 'tablet');
    const mover = await editor.nodeBoxIn('tablet', 'mover');
    const m = await mark(page);
    await gesture(editor, center(mover), async (g) => {
      await g.moveTo(area, 24);
      await g.pump(10, 'y');
    });
    await stableCode(editor);
    expect((await since(page, m, '^drag:start$')).length, 'the drag engaged').toBe(1);
    expect(await since(page, m, '^abs-in-frame:sibling-entry-confirmed$'), 'the hidden trap was never entered').toEqual([]);
    // The drop stays in the visible ancestor; the hidden frame is untouched.
    expect(await editor.parentOf('mover')).toBe('root');
    expect((await editor.source()).byId.get('trap')?.childIds ?? []).toEqual([]);
    const code = await editor.code();
    expect(code).toContain('[data-id="trap"] { display: none !important; }');
    expect(await editor.style('trap')).toEqual(parseSource(before).byId.get('trap')!.style);
    await expect(editor).toUndoInOneStep(before);
  });
});

// ─── DND-236 ──────────────────────────────────────────────────────────

test('DND-236 RTL language: English reorders left-to-right; with Arabic active the drag is blocked', { tag: ['@p2', '@dnd'] }, async ({ editor }) => {
  await editor.load(RTL_TEXT);
  await centerOn(editor, ['nav']);
  const page = editor.page();
  const before = await editor.code();
  const logo = await editor.nodeBox('logo');
  const contact = await editor.nodeBox('contact');
  await gesture(editor, center(contact), async (g) => {
    await g.moveTo({ x: logo.x + logo.width * 0.2, y: center(logo).y }, 24);
    await g.pump(8, 'y');
  });
  await expect(editor).toHaveStyle('contact', 'order', '0');
  await expect(editor).toHaveStyle('logo', 'order', '1');
  await expect(editor).toHaveStyle('link', 'order', '2');
  // Plain left-to-right: the row never mirrors (no `dir`, contact paints leftmost).
  expect(await xOrder(editor, ['logo', 'link', 'contact'])).toEqual(['contact', 'logo', 'link']);
  expect(await editor.sandbox().locator('[dir]').count()).toBe(0);
  await expect(editor).toUndoInOneStep(before);   // ends re-applied (redo)
  const ltr = await xOrder(editor, ['logo', 'link', 'contact']);
  await page.waitForTimeout(450);

  // Arabic active = translation mode: the drag dies at the threshold.
  await pickLocale(page, 'Arabic');
  await expect(editor.sandbox().locator('[data-content-root]').first()).toHaveAttribute('lang', 'ar');
  const code = await editor.code();
  const link = await editor.nodeBox('link');
  const logo2 = await editor.nodeBox('logo');
  const m = await mark(page);
  await gesture(editor, center(link), async (g) => {
    await g.moveTo({ x: logo2.x + 2, y: center(logo2).y }, 16);
    await g.pump(6, 'y');
  });
  expect(await since(page, m, '^drag:threshold-blocked-translation-mode$')).not.toHaveLength(0);
  expect(await since(page, m, '^drag:start$')).toEqual([]);
  expect(await editor.code()).toBe(code);
  // Layout still unmirrored in Arabic.
  expect(await xOrder(editor, ['logo', 'link', 'contact'])).toEqual(ltr);
  expect(await editor.sandbox().locator('[dir]').count()).toBe(0);
});
