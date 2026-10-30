// DND · CMS collection lists, ghost rows and slug pages (E2E_TEST_PLAN.md §2).
//
// A `.map()` list paints its template row (item 0) plus DOM-only ghost copies
// (`data-collection-ghost`, ids suffixed `__N`). These rows pin what a drag
// does to them: ghosts collapse or hide for the gesture, never pick up lift
// geometry, rebuild once on drop, and their `__N` ids never become a drop
// parent the node model can't hold.

import { test, expect, TILES, TILES_VIEWPORT } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  page8, pageModule8, seed8, TEAM_FILES, TEAM_IMPORT, BADGE_MASTER, BADGE_IMPORT,
  listRows, copiesOf, mark, since, center, near, Gesture, gesture, stableCode, idCount, dupIds,
  ancestorsOf, canvasText, canvasBox, quickBox, type Box, type Pt,
} from '../../helpers/d8';
import { centerOn } from '../../helpers/d3';
import { dropLine, parentOutline } from '../../helpers/d1';
import { prime } from '../../helpers/d6';

test.describe.configure({ timeout: 180_000 });

// ─── Seeds ────────────────────────────────────────────────────────────

const row = (inner: string, extra = '') => `{team.map((item, idx) => (
      <div data-id="row" data-name="Row" key={idx} style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', width: '100%', height: '56px', padding: '8px', backgroundColor: '#eeeeee'${extra} }}>
        ${inner}
      </div>
    ))}`;

const NAME_ROLE = `<p data-id="name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.name}</p>
        <p data-id="role" data-name="Role" style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px', color: '#555555', margin: '0px' }}>{item.role}</p>`;

const ROOT_OPEN = `<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '24px', width: '1440px', minHeight: '900px', padding: '60px', backgroundColor: '#0d0d1a' }}>`;

/** A flex-column list holding manual siblings around the `.map()` rows. */
const LIST_WITH_SIBLINGS = page8(`
${ROOT_OPEN}
  <div data-id="list" data-name="List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '12px', width: '424px', padding: '12px', backgroundColor: '#ffffff' }}>
    <div data-id="m-top" data-name="Top" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '40px', backgroundColor: '#ffcc33' }} />
    ${row(NAME_ROLE)}
    <div data-id="m-bottom" data-name="Bottom" style={{ position: 'relative', flex: '0 0 auto', width: '100%', height: '40px', backgroundColor: '#33ccff' }} />
  </div>
</div>`, { imports: [TEAM_IMPORT], extra: TEAM_FILES });

/** A plain list of name/role rows + a canvas chip. */
const LIST = page8(`
${ROOT_OPEN}
  <div data-id="list" data-name="List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '12px', width: '424px', padding: '12px', backgroundColor: '#ffffff' }}>
    ${row(NAME_ROLE)}
  </div>
</div>`, { imports: [TEAM_IMPORT], extra: TEAM_FILES });

/** CMS_LIST_ROWS in the builder's shape: a split-text title whose effect
 *  wrapper carries a stamped data-id (stripped by the boot heal). */
const CMS_LIST_ROWS = seed8(pageModule8({
  imports: ["import React from 'react';", TEAM_IMPORT, "import { RevymeSplitText } from '@revyme/runtime';"],
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '700px', backgroundColor: '#0d0d1a', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px' }}>
  <p data-id="title" data-name="Text" data-text-anim='{"animationType":"word","opacity":0,"blur":10,"delay":0.05}' style={{ fontSize: '32px', color: '#ffffff', position: 'relative', flex: '0 0 auto' }}><RevymeSplitText data-id="RevymeSplitText-e2e-1" spec={{ animationType: "word", opacity: 0, blur: 10, delay: 0.05 }}>Our team.</RevymeSplitText></p>
  <div data-id="list" data-name="List" data-collection-list="team" style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', padding: '12px', backgroundColor: '#ffffff', borderRadius: '8px', position: 'relative' }}>
    {team.map((item, idx) => (
      <div data-id="row" data-name="Row" key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', height: '56px', padding: '8px', backgroundColor: '#eeeeee', borderRadius: '6px', position: 'relative', flex: '0 0 auto' }}>
        <div data-id="avatar" style={{ width: '40px', height: '40px', backgroundColor: '#cccccc', borderRadius: '6px', flex: '0 0 auto' }}></div>
        <p data-id="name" style={{ fontSize: '14px', color: '#111111', flex: '0 0 auto' }}>{item.name}</p>
      </div>
    ))}
  </div>
</div>`,
}), TEAM_FILES);

/** Three cards sharing a 1328px flex row (each `flex: 1 1 0` = 424px). */
const CARD_ROW_LIST = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '24px', width: '1440px', minHeight: '900px', padding: '56px', backgroundColor: '#0d0d1a' }}>
  <div data-id="list" data-name="List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', gap: '28px', width: '1328px', backgroundColor: '#ffffff' }}>
    {team.map((item, idx) => (
      <div data-id="card" data-name="Card" key={idx} style={{ position: 'relative', flex: '1 1 0px', display: 'flex', flexDirection: 'column', gap: '8px', height: '200px', padding: '16px', backgroundColor: '#e8eefc' }}>
        <p data-id="card-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', fontSize: '18px', color: '#111111', margin: '0px' }}>{item.name}</p>
      </div>
    ))}
  </div>
</div>`, { imports: [TEAM_IMPORT], extra: TEAM_FILES });

/** Rows whose root is a `<Link data-cms-nav="row">` + a canvas chip. */
const LINK_ROWS = page8(`
${ROOT_OPEN}
  <div data-id="team-list" data-name="Team" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '12px', width: '600px', padding: '12px', backgroundColor: '#ffffff' }}>
    {team.map((item, idx) => (
      <Link data-cms-nav="row" href={\`/team/\${item?._slug ?? ''}\`} data-id="team-row" key={idx} data-name="Member" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', width: '100%', height: '80px', padding: '8px', backgroundColor: '#eeeeee' }}>
        <p data-id="member-name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.name}</p>
      </Link>
    ))}
  </div>
</div>`, {
  imports: ["import Link from 'next/link';", TEAM_IMPORT],
  canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-260px', top: '120px', width: '60px', height: '40px', backgroundColor: '#ff66cc' }}></div>`,
  extra: TEAM_FILES,
});

/** Rows holding a Badge component instance + a name; a canvas chip. */
const INSTANCE_ROWS = page8(`
${ROOT_OPEN}
  <div data-id="list" data-name="List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '16px', width: '600px', padding: '12px', backgroundColor: '#ffffff' }}>
    {team.map((item, idx) => (
      <div data-id="row" data-name="Row" key={idx} style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px', width: '100%', height: '96px', padding: '8px', backgroundColor: '#eeeeee' }}>
        <Badge data-id="badge" data-name="Badge" style={{ position: 'relative', flex: '0 0 auto' }} />
        <p data-id="name" data-name="Name" style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px', color: '#111111', margin: '0px' }}>{item.name}</p>
      </div>
    ))}
  </div>
</div>`, {
  imports: [TEAM_IMPORT, BADGE_IMPORT],
  canvas: `<div data-id="chip" data-name="Chip" data-canvas-node="true" style={{ position: 'absolute', left: '-260px', top: '120px', width: '40px', height: '30px', backgroundColor: '#ff66cc' }}></div>`,
  extra: { ...TEAM_FILES, 'components/Badge.tsx': BADGE_MASTER },
});

/** A 3-tile page whose list paints on every tile. */
const LIST_3VP = page8(`
<div data-id="root" data-name="Page" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', padding: '40px', backgroundColor: '#0d0d1a' }}>
  <div data-id="list" data-name="List" data-collection-list="team" style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', padding: '24px', backgroundColor: '#ffffff' }}>
    ${row(NAME_ROLE)}
  </div>
</div>`, { tiles: TILES.three, imports: [TEAM_IMPORT], extra: TEAM_FILES });

/** CMS_SLUG_PAGE (a [slug] detail page: `item` from @cmsPage, no `.map()`). */
const CASE_SCHEMA = JSON.stringify({ slug: 'case-study', name: 'Case study', fields: [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'overview', name: 'Overview', type: 'text' },
] });
const CASE_DATA = JSON.stringify([
  { _id: 'i1', _slug: 'meridian', _status: 'published', title: 'MERIDIAN ARCHITECTS', overview: 'A forty-person practice known for civic buildings.' },
  { _id: 'i2', _slug: 'other', _status: 'published', title: 'OTHER STUDIO', overview: 'Second item.' },
]);
const CMS_SLUG_PAGE = seed8(pageModule8({
  header: '/** @cmsPage { "collection": "case-study", "kind": "detail" } */',
  imports: ["import caseStudy from '@/cms/case-study.json';"],
  signature: '{ params }: { params: { slug: string } }',
  hooks: ['const item = caseStudy.find((i) => i._slug === params.slug) ?? caseStudy[0];'],
  root: `
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '900px', minHeight: '700px', backgroundColor: '#0d0d1a', display: 'flex', flexDirection: 'column', gap: '16px', padding: '60px' }}>
  <p data-id="title" data-name="Title" style={{ fontSize: '32px', color: '#ffffff', position: 'relative', flex: '0 0 auto' }}>{item.title}</p>
  <p data-id="overview" data-name="Overview" style={{ fontSize: '16px', color: '#c8c4bc', position: 'relative', flex: '0 0 auto' }}>{item.overview}</p>
</div>`,
}), { 'cms/case-study.schema.json': CASE_SCHEMA, 'cms/case-study.json': CASE_DATA });

// ─── Helpers ──────────────────────────────────────────────────────────

/** Ids the drag guards must never adopt as a drop parent: the instance and
 *  its expansion (`inst:masterId`), ghost suffix included. */
const instanceOwned = (id: string | null | undefined, inst: string) =>
  !!id && (id === inst || id.startsWith(`${inst}:`) || id.startsWith(`${inst}__`));

async function boxOf(editor: Editor, id: string): Promise<Box> {
  return editor.nodeBox(id);
}

/** A point of free canvas `dx` px left of the page root's left edge. */
async function leftOfPage(editor: Editor, dx = 160, fy = 0.15): Promise<Pt> {
  const r = await editor.nodeBox('root');
  return { x: r.x - dx, y: r.y + r.height * fy };
}

// ─── DND-212 ──────────────────────────────────────────────────────────

test('DND-212 an instance dragged out over its own ghost rows never lands inside itself', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(INSTANCE_ROWS);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const before = await editor.code();
  const rows = await listRows(editor, 'list');
  const ghost2 = rows.find(r => r.nodeId === 'row__2')!;
  expect(ghost2, 'the list paints two ghost rows').toBeTruthy();
  const badge = await boxOf(editor, 'badge');
  const m = await mark(page);

  // Press the template row's Badge and drag it straight down over its own
  // ghost copies (badge__1, badge__2), holding still over the last one.
  await gesture(editor, center(badge), async (g) => {
    await g.moveTo({ x: center(badge).x, y: ghost2.y + ghost2.h / 2 }, 24);
    await g.pump(10, 'x');
    const line = await dropLine(page);
    const outline = await parentOutline(page);
    // The drop target is never the dragged instance or anything inside it.
    expect(instanceOwned(line?.parentId, 'badge'), `drop line parent ${line?.parentId}`).toBe(false);
    expect(instanceOwned(outline?.parentId, 'badge'), `highlight ${outline?.parentId}`).toBe(false);
  });
  const after = await stableCode(editor);
  expect(await since(page, m, '^drag:start$'), 'the gesture engaged').not.toHaveLength(0);

  // Never deleted, never duplicated, never parented under itself.
  expect(idCount(after, 'badge')).toBe(1);
  expect(dupIds(after)).toEqual([]);
  expect(ancestorsOf(after, 'badge')).not.toContain('badge');
  expect(await editor.exists('badge')).toBe(true);
  // A refused cycle is a traced no-op, never a crash.
  const refused = await since(page, m, 'cycle-refused|parent-not-found');
  for (const r of refused) expect(String(r.c)).toMatch(/refused|not-found/);
  // The canvas still paints the badge and every row.
  await expect.poll(async () => (await copiesOf(editor, 'badge')).filter(c => c.box.width > 0).length).toBeGreaterThanOrEqual(1);
  if (after !== before) await expect(editor).toUndoInOneStep(before);
});

// ─── DND-213 ──────────────────────────────────────────────────────────

test('DND-213 template row released in place: ghosts hidden without lift geometry, back in place after', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CMS_LIST_ROWS, { fit: true });
  const page = editor.page();
  const start = await listRows(editor, 'list');
  const ghosts0 = start.filter(r => r.ghost);
  expect(ghosts0).toHaveLength(2);
  // The boot heal stripped the id stamped on the effect wrapper.
  const code0 = await editor.code();
  expect(code0).toContain('<RevymeSplitText spec=');
  expect(code0).not.toContain('RevymeSplitText data-id=');
  const m = await mark(page);

  // Press the row's empty right end (its centre is the name text).
  const box = await editor.nodeBox('row');
  const from = { x: box.x + box.width * 0.92, y: box.y + box.height / 2 };
  await gesture(editor, from, async (g) => {
    await g.moveBy(8, 8, 8);
    const started = await since(page, m, '^drag:start$');
    expect(started.map(t => t.data?.nodes?.[0]?.id), 'the ROW lifted').toEqual(['row']);
    // Lifted: the ghosts collapse and carry NO lift geometry.
    await g.hold(4);
    await expect.poll(async () => (await listRows(editor, 'list')).filter(r => r.ghost).map(r => r.display)).toEqual(['none', 'none']);
    for (let i = 0; i < 4; i++) {
      await g.moveBy(i % 2 ? -2 : 2, 0, 1);
      for (const gr of (await listRows(editor, 'list')).filter(r => r.ghost)) {
        expect(gr.display).toBe('none');
        expect(gr.left).toBe('');
        expect(gr.top).toBe('');
      }
    }
    await g.moveTo(from, 8);
    await g.hold(4);
  });
  await editor.settled();

  await expect.poll(async () => (await listRows(editor, 'list')).filter(r => r.ghost && r.display !== 'none' && r.h > 0).length).toBe(2);
  const after = (await listRows(editor, 'list')).filter(r => r.ghost);
  after.forEach((gr, i) => {
    expect(gr.left).toBe('');
    expect(gr.top).toBe('');
    expect(Math.abs(gr.y - ghosts0[i].y), `ghost ${i} back in place`).toBeLessThanOrEqual(2);
    expect(Math.abs(gr.h - ghosts0[i].h)).toBeLessThanOrEqual(2);
  });
  // The drop's forced rebuild ran and the render-integrity guard did not skip it.
  expect(await since(page, m, '^layout-lifted:force-collection-ghost-rebuild$')).not.toHaveLength(0);
  expect(await since(page, m, 'force-render-skip')).toEqual([]);
  // Released where it started: the template row stays in its map.
  const code = await stableCode(editor);
  expect(code).toContain('{team.map((item, idx) => (');
  expect(await editor.parentOf('row')).toBe('list');
});

// ─── DND-214 ──────────────────────────────────────────────────────────

test('DND-214 template row reordered among manual siblings: ghosts collapse, rows rebuild at the new slot', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LIST_WITH_SIBLINGS);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const before = await editor.code();
  const rowBox = await editor.nodeBox('row');
  const bottom = await editor.nodeBox('m-bottom');
  const m = await mark(page);

  await gesture(editor, center(rowBox), async (g) => {
    const to = { x: center(rowBox).x, y: bottom.y + bottom.height * 0.8 };
    await g.moveTo(to, 20);
    await g.pump(8, 'x');
    expect(await since(page, m, '^drag:start$'), 'the row lifted').not.toHaveLength(0);
    // Ghost rows collapse: ONE row element paints, and it is under the cursor.
    const rows = await listRows(editor, 'list');
    for (const r of rows.filter(r => r.ghost)) expect(r.display).toBe('none');
    const painted = (await copiesOf(editor, 'row', '*')).filter(c => c.display !== 'none' && c.box.width > 0);
    expect(painted).toHaveLength(1);
    const p = painted[0].box;
    expect(to.x >= p.x - 2 && to.x <= p.x + p.width + 2 && to.y >= p.y - 2 && to.y <= p.y + p.height + 2, 'the lifted row is under the cursor').toBe(true);
  });

  // Source: an order map, the JSX untouched (the map stays where it was).
  await expect(editor).toHaveStyle('m-top', 'order', '0');
  await expect(editor).toHaveStyle('m-bottom', 'order', '1');
  await expect(editor).toHaveStyle('row', 'order', '2');
  await expect(editor).toHaveJsxOrder('list', ['m-top', 'row', 'm-bottom']);
  // Canvas: every row rebuilt below m-bottom, the template (item 0) first.
  await expect.poll(async () => {
    const rows = await listRows(editor, 'list');
    return rows.filter(r => r.display !== 'none' && r.h > 0).sort((a, b) => a.y - b.y).map(r => r.nodeId);
  }).toEqual(['m-top', 'm-bottom', 'row', 'row__1', 'row__2']);
  const names = (await copiesOf(editor, 'name')).sort((a, b) => a.box.y - b.box.y).map(c => c.text);
  expect(names).toEqual(['Alice Johnson', 'Bob Smith', 'Carol Davis']);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-215 ──────────────────────────────────────────────────────────

test('DND-215 a title dragged inside the template row hides only its own ghost copies; every row shows the new order', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LIST);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const before = await editor.code();
  const rows0 = await listRows(editor, 'list');
  const name = await editor.nodeBox('name');
  const role = await editor.nodeBox('role');
  const m = await mark(page);

  await gesture(editor, center(name), async (g) => {
    const to = { x: role.x + role.width * 0.85, y: center(role).y };
    await g.moveTo(to, 20);
    await g.pump(8, 'y');
    expect(await since(page, m, '^drag:start$'), 'the title lifted').not.toHaveLength(0);
    // Rows keep their layout: no ghost row collapses or moves.
    const rows = await listRows(editor, 'list');
    for (const r of rows.filter(r => r.ghost)) {
      const r0 = rows0.find(x => x.nodeId === r.nodeId)!;
      expect(r.display).not.toBe('none');
      expect(Math.abs(r.y - r0.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(r.h - r0.h)).toBeLessThanOrEqual(2);
    }
    // Only the title's ghost COPIES hide (visibility), and none floats
    // outside its own row (no lift geometry fanned out to them).
    const copies = await copiesOf(editor, 'name');
    const ghosts = copies.filter(c => c.ghost);
    expect(ghosts).toHaveLength(2);
    for (const c of ghosts) expect(c.visibility).toBe('hidden');
    for (const c of ghosts) {
      const host = rows.find(r => r.nodeId === c.nodeId.replace(/^name/, 'row'))!;
      expect(c.box.y >= host.y - 2 && c.box.y + c.box.height <= host.y + host.h + 2, `${c.nodeId} sits in its row`).toBe(true);
    }
    // The other fields' ghost copies stay visible.
    for (const c of (await copiesOf(editor, 'role')).filter(c => c.ghost)) expect(c.visibility).toBe('visible');
  });

  await expect(editor).toHaveStyle('role', 'order', '0');
  await expect(editor).toHaveStyle('name', 'order', '1');
  await expect(editor).toHaveJsxOrder('row', ['name', 'role']);
  // One forced ghost rebuild, and every row (ghosts included) shows the new order.
  expect(await since(page, m, '^layout-lifted:force-collection-ghost-rebuild$')).toHaveLength(1);
  await expect.poll(async () => {
    const names = await copiesOf(editor, 'name');
    const roles = await copiesOf(editor, 'role');
    if (names.length !== 3 || roles.length !== 3) return false;
    return names.every((n, i) => n.visibility === 'visible' && roles[i].box.x < n.box.x);
  }).toBe(true);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-216 ──────────────────────────────────────────────────────────

test('DND-216 a 424px template card keeps its width when the lift starts', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CARD_ROW_LIST);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const list = await editor.nodeBox('list');
  const scale = list.width / 1328;
  const card = await editor.nodeBox('card');
  expect(near(card.width / scale, 424, 2), `card paints ${card.width / scale}px`).toBe(true);
  const m = await mark(page);

  const widths: number[] = [];
  await gesture(editor, center(card), async (g) => {
    await g.moveBy(0, 30, 10, async () => {
      const b = (await copiesOf(editor, 'card', '*')).find(c => !c.ghost);
      if (b) widths.push(b.box.width / scale);
    });
    await g.hold(8);
    const b = (await copiesOf(editor, 'card', '*')).find(c => !c.ghost);
    if (b) widths.push(b.box.width / scale);
    await g.moveBy(0, -30, 10);
  });
  expect(await since(page, m, '^drag:start$'), 'the card lifted').not.toHaveLength(0);
  expect(widths.length).toBeGreaterThan(5);
  // Never exploded to the list's 1328px when its ghosts collapsed.
  for (const w of widths) expect(near(w, 424, 3), `lifted card width ${w}`).toBe(true);
  expect(await since(page, m, '^layout-lifted:live-size-skip-collection-row$')).not.toHaveLength(0);
  expect(await since(page, m, '^layout-lifted:live-size-correct')).toEqual([]);
});

// ─── DND-217 ──────────────────────────────────────────────────────────

test('DND-217 a bound title dragged out bakes the row value, and rebinds when dragged back into the row', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LIST);
  const page = editor.page();
  await centerOn(editor, ['list']);
  const before = await editor.code();
  expect(before).toContain('{item.name}');

  // 1 · out of the row onto the free canvas, left of the page.
  const name = await editor.nodeBox('name');
  const out = await leftOfPage(editor, 180, 0.3);
  await gesture(editor, center(name), async (g) => {
    await g.moveTo(out, 30);
    await g.pump(6, 'y');
  });
  const exited = await stableCode(editor);
  const n = (await editor.source()).byId.get('name');
  expect(n?.parentId ?? null, 'it left the page for the canvas').toBeNull();
  expect(n?.attrs['data-canvas-node']).toBe('true');
  // The ROW's value (item 0), never the field name; binding dormant.
  expect(n?.attrs['data-cms-orphan']).toBe('__text:name');
  expect(exited).not.toContain('{item.name}');
  expect(exited).toMatch(/>\s*Alice Johnson\s*</);
  await expect.poll(() => canvasText(editor, 'name')).toBe('Alice Johnson');
  await expect(editor).toUndoInOneStep(before);
  await page.waitForTimeout(450);

  // 2 · back into the template row (its empty right half).
  const beforeEntry = await editor.code();
  const nb = (await canvasBox(editor, 'name'))!;
  const rowBox = await editor.nodeBox('row');
  const into = { x: rowBox.x + rowBox.width * 0.75, y: center(rowBox).y };
  await gesture(editor, center(nb), async (g) => {
    await g.moveTo(into, 30);
    await g.pump(10, 'y');
  });
  await stableCode(editor);
  expect(await editor.parentOf('name')).toBe('row');
  const back = await editor.code();
  expect(back).toContain('{item.name}');
  expect((await editor.source()).byId.get('name')?.attrs['data-cms-orphan']).toBeUndefined();
  // Every row paints its own value again.
  await expect.poll(async () => (await copiesOf(editor, 'name')).map(c => c.text).sort()).toEqual(['Alice Johnson', 'Bob Smith', 'Carol Davis']);
  await expect(editor).toUndoInOneStep(beforeEntry);
});

// ─── DND-218 ──────────────────────────────────────────────────────────

test.describe('3 tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('DND-218 a whole list dragged out of the Tablet tile keeps its .map() and is hidden on Tablet only', { tag: ['@p1', '@dnd', '@tiles'] }, async ({ editor }) => {
    // The clone renames ids with a bare global substring replace
    // (cms-paste-gen.ts rebuildPastedCollectionInCode → applyRenames), so an
    // id that also occurs as a WORD elsewhere in the subtree corrupts it:
    // `flexDirection: 'row'` → 'row-cXXXX', `data-name=` → `data-name-cXXXX=`,
    // `{item.name}` → `{item.name-cXXXX}` (NaN on the canvas). With ids that
    // never collide (tl-k2 / tr-k3 …) the same gesture works.
    test.fail(true, 'BUG: list drag-out clone renames data-ids by bare substring, corrupting `row`/`name`/`role` words in styles, attrs and `{item.name}`');
    await editor.load(LIST_3VP, { fit: true });
    const page = editor.page();
    const before = await editor.code();
    const list = await editor.nodeBoxIn('tablet', 'list');
    // Prime on the list's own padding (a press on a row would pick the row).
    const grab = { x: list.x + list.width * 0.5, y: list.y + 3 };
    await page.mouse.click(grab.x, grab.y);
    await page.waitForTimeout(650);
    expect(await editor.selection()).toEqual(['list']);
    const tabletRoot = await editor.nodeBoxIn('tablet', 'root');
    // Below the tiles: free canvas.
    const to = { x: center(list).x, y: tabletRoot.y + tabletRoot.height + 120 };
    const m = await mark(page);
    await gesture(editor, grab, async (g) => {
      await g.moveTo(to, 30);
      await g.pump(8, 'x');
    });
    const code = await stableCode(editor);
    expect(await since(page, m, '^layout-lifted:drop-canvas-collection-list-clone$')).toHaveLength(1);

    // A new canvas list that still maps the collection (not one static ghost).
    const src = await editor.source();
    const clone = src.nodes.find(nd => nd.id.startsWith('list-c') && nd.parentId === null);
    expect(clone, 'a canvas clone of the list').toBeTruthy();
    expect(clone!.attrs['data-canvas-node']).toBe('true');
    const cloneSrc = code.slice(clone!.start, clone!.end);
    expect(cloneSrc).toContain('team.map((item, idx) => (');
    // Bindings and styles ride along verbatim; only data-ids get the suffix.
    expect(cloneSrc).toContain('{item.name}');
    expect(cloneSrc).toContain('{item.role}');
    expect(cloneSrc).toContain("flexDirection: 'row'");
    expect(cloneSrc).not.toMatch(/data-name-c\w+=/);
    // The source stays in the page, hidden on Tablet only.
    expect(await editor.parentOf('list')).toBe('root');
    await expect(editor).toHaveBandStyle(768, 'list', 'display', 'none');
    expect(await editor.style('list')).not.toHaveProperty('display', 'none');
    // Canvas: the clone paints every item; desktop and mobile still show the list.
    await expect.poll(async () => {
      const el = editor.sandbox().locator(`[data-id="${clone!.id}"]:not([data-viewport] [data-id])`).first();
      if ((await el.count()) === 0) return [];
      return ((await el.innerText()) ?? '').split('\n').filter(s => /Johnson|Smith|Davis/.test(s));
    }).toEqual(['Alice Johnson', 'Bob Smith', 'Carol Davis']);
    expect(await quickBox(await editor.nodeIn('desktop', 'list'))).not.toBeNull();
    expect(await quickBox(await editor.nodeIn('mobile', 'list'))).not.toBeNull();
    const tabletCopy = await quickBox(await editor.nodeIn('tablet', 'list'));
    expect(!tabletCopy || tabletCopy.width === 0 || tabletCopy.height === 0, 'hidden on tablet').toBe(true);
    await expect(editor).toUndoInOneStep(before);
  });
});

// ─── DND-219 ──────────────────────────────────────────────────────────

test('DND-219 a <Link> row is a drop target: the chip lands inside the template card', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(LINK_ROWS);
  const page = editor.page();
  await centerOn(editor, ['team-list', 'chip']);
  const before = await editor.code();
  const chip = await editor.nodeBox('chip');
  const card = await editor.nodeBox('team-row');
  const into = { x: card.x + card.width * 0.7, y: center(card).y };
  const parents = new Set<string>();

  await gesture(editor, center(chip), async (g) => {
    await g.moveTo(into, 30, async () => {
      const o = await parentOutline(page);
      if (o?.parentId) parents.add(o.parentId);
    });
    await g.pump(10, 'y');
    const o = await parentOutline(page);
    if (o?.parentId) parents.add(o.parentId);
    expect(o?.parentId, 'the card itself is offered, not only the list beside it').toBe('team-row');
  });
  await stableCode(editor);
  expect(await editor.parentOf('chip')).toBe('team-row');
  expect(ancestorsOf(await editor.code(), 'chip')).toContain('team-list');
  // The ghost cards rebuild with the new child.
  await expect.poll(async () => (await copiesOf(editor, 'chip')).filter(c => c.box.width > 0).length).toBe(3);
  await expect(editor).toUndoInOneStep(before);
});

// ─── DND-220 ──────────────────────────────────────────────────────────

test('DND-220 a node dragged over a ghost row\'s instance never drops into the instance', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(INSTANCE_ROWS);
  const page = editor.page();
  await centerOn(editor, ['list', 'chip']);
  const before = await editor.code();
  const master = await editor.code('components/Badge.tsx');
  const ghostBadge = (await copiesOf(editor, 'badge')).find(c => c.nodeId === 'badge__1');
  expect(ghostBadge, 'ghost row 1 paints its badge').toBeTruthy();
  const chip = await editor.nodeBox('chip');
  const target = { x: ghostBadge!.box.x + ghostBadge!.box.width * 0.5, y: ghostBadge!.box.y + ghostBadge!.box.height * 0.6 };
  const seen: string[] = [];
  const watch = async () => {
    const l = await dropLine(page);
    const o = await parentOutline(page);
    if (l?.parentId) seen.push(`line:${l.parentId}`);
    if (o?.parentId) seen.push(`outline:${o.parentId}`);
  };

  await gesture(editor, center(chip), async (g) => {
    await g.moveTo(target, 30, watch);
    await g.pump(10, 'y');
    await watch();
  });
  await stableCode(editor);
  // No drop line or highlight inside the card, ghost suffix or not.
  for (const s of seen) expect(instanceOwned(s.split(':').slice(1).join(':'), 'badge'), s).toBe(false);
  // Wherever the chip went, it is not in the instance (and the master is untouched).
  const parent = await editor.parentOf('chip');
  expect(instanceOwned(parent, 'badge'), `chip parent ${parent}`).toBe(false);
  expect(await editor.code('components/Badge.tsx')).toBe(master);
  expect(dupIds(await editor.code())).toEqual([]);
  if ((await editor.code()) !== before) await expect(editor).toUndoInOneStep(before);
});

// ─── DND-221 ──────────────────────────────────────────────────────────

test('DND-221 a bound node dragged out of a slug page keeps the item\'s words and reads as bound', { tag: ['@p1', '@dnd'] }, async ({ editor }) => {
  await editor.load(CMS_SLUG_PAGE);
  const page = editor.page();
  await centerOn(editor, ['root']);
  const before = await editor.code();
  const box = await editor.nodeBox('overview');
  const out = await leftOfPage(editor, 220, 0.3);
  await gesture(editor, center(box), async (g) => {
    await g.moveTo(out, 30);
    await g.pump(6, 'y');
  });
  const code = await stableCode(editor);
  const n = (await editor.source()).byId.get('overview');
  expect(n?.attrs['data-canvas-node'], 'it really left the page body for the canvas').toBe('true');
  // The words it was SHOWING, never the humanized field name.
  expect(code).toContain('A forty-person practice known for civic buildings.');
  expect(code).not.toMatch(/>\s*Overview\s*</);
  expect(n?.attrs['data-cms-orphan']).toBe('__text:overview');
  await expect.poll(() => canvasText(editor, 'overview')).toBe('A forty-person practice known for civic buildings.');
  // The panel names the field instead of claiming it is missing.
  const panel = page.locator('[data-properties-panel]');
  await expect(panel.getByText('Overview', { exact: true }).first()).toBeVisible({ timeout: 8_000 });
  await expect(panel.getByText('Missing', { exact: true })).toHaveCount(0);
  await expect(editor).toUndoInOneStep(before);
});
