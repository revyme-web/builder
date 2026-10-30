// CMP · Detach Instance (E2E_TEST_PLAN.md §8, CMP-187…CMP-196).
//
// Detach turns a design-component instance into ordinary page nodes: the
// master's JSX is inlined with fresh `det-` ids, the component machinery
// (variants, initial/animate, layout, keys, `...style`) is resolved away, and
// the copy must look exactly like the instance did — on every tile.

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import { rightClickNode, menuItem, contextMenu, closeMenu, pressComposed } from '../../helpers/c1';
import {
  PAGE, CARD, detachPage, C1_TILES, detachViaMenu, elementOf, dataIds, tagNames, subtreeIds, idByName, paint, samePaint,
  parsesStrict, pollCode, panel,
  BTN_SEED, NAV_RESPONSIVE_SEED, FORM_CARD_SEED, MENU_OVERLAY_SEED, OVERLAY_ID, CMS_ROW_SEED, BLOGS_SEED, FOOTER_SEED, PROMO_SEED,
} from '../../helpers/c6';

/** The preview logs React's list-key warning for the page module. */
const PREVIEW_NOISE = /Each child in a list should have a unique "key" prop/;

test.describe.configure({ timeout: 150_000 });

async function openPreviewFrame(page: import('@playwright/test').Page, ready: string) {
  await page.locator('[data-tutorial="header-preview-button"]').click({ force: true });
  const frame = page.frameLocator('iframe[src*="5175"]');
  await frame.locator(ready).first().waitFor({ state: 'attached', timeout: 45_000 });
  return frame;
}

test('CMP-187 Detach Instance inlines the master as plain page nodes that look identical', { tag: ['@p0', '@cmp'] }, async ({ editor }) => {
  await editor.load(detachPage());
  const master = await editor.code(CARD);
  // The instance renders a wrapper (`card-a`) around the expanded master root.
  const rootBefore = await paint(editor, 'card-a:card-root');
  const boxBefore = await paint(editor, 'card-a');
  const titleBefore = await paint(editor, 'card-a:card-title');
  const bodyBefore = await paint(editor, 'card-a:card-body');
  expect(rootBefore && titleBefore && bodyBefore).toBeTruthy();

  const { before, after, rootId } = await detachViaMenu(editor, 'card-a', { at: [0.95, 0.95] });

  // Source: the instance is gone, the master content is inlined in its place.
  expect(after).not.toMatch(/<Card\b/);
  expect(rootId).toMatch(/^det-/);
  const root = elementOf(after, rootId)!;
  expect(root).not.toBeNull();
  // Root named after the INSTANCE (not the master's "Card").
  expect(root.open).toContain('data-name="Pricing Card"');
  // Fresh det- ids everywhere in the copy; no master id survives on the page.
  const ids = subtreeIds(after, rootId);
  expect(ids.length).toBe(4);
  for (const id of ids) expect(id).toMatch(/^det-/);
  for (const masterId of ['card-root', 'card-title', 'card-body', 'card-badge']) expect(dataIds(after)).not.toContain(masterId);
  // motion.* → plain tags; the nested instance stays an instance.
  expect(tagNames(root.source)).toEqual(['div', 'h2', 'p', 'Badge']);
  expect(root.source).not.toMatch(/\b(variants|initial|animate|layout|key)=/);
  expect(root.source).not.toContain('...style');
  expect(root.source).not.toContain('...rest');
  expect(after).not.toContain('cardRootVariants');
  // The instance's wrapper styles merged onto the root, the master's own kept.
  const s = (await editor.style(rootId, PAGE));
  expect(s).toMatchObject({ position: 'relative', flex: '0 0 auto', order: '0', width: '320px', backgroundColor: '#1a1a3a', display: 'flex' });
  expect(after).toMatch(/import Badge from '@\/components\/Badge'/);
  expect(parsesStrict(after)).toBe(true);
  // The master file is untouched.
  expect(await editor.code(CARD)).toBe(master);

  // The detached root is selected.
  expect(await editor.selection()).toEqual([rootId]);

  // Canvas: identical to the instance it replaced.
  const [, titleId, bodyId] = ids;
  await expect.poll(async () => samePaint(await paint(editor, rootId), rootBefore)).toBe(true);
  expect(samePaint(await paint(editor, titleId), titleBefore)).toBe(true);
  expect(samePaint(await paint(editor, bodyId), bodyBefore)).toBe(true);
  const r = (await paint(editor, rootId))!;
  expect(Math.abs(r.x - boxBefore!.x)).toBeLessThan(1.5);
  expect(Math.abs(r.y - boxBefore!.y)).toBeLessThan(1.5);
  expect(Math.abs(r.width - boxBefore!.width)).toBeLessThan(1.5);

  // One undo restores `<Card`.
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
  await editor.undo();
  expect(await editor.code(PAGE)).toContain('<Card data-id="card-a"');
});

test.describe('on three tiles', () => {
  test.use({ viewport: TILES_VIEWPORT });

  test('CMP-188 Ctrl+Alt+B detaches like the menu; greyed + no-op on Tablet; no Detach on a code component', { tag: ['@p0', '@cmp', '@tiles'] }, async ({ editor, page }) => {
    await editor.load(detachPage({ tiles: C1_TILES.three, counter: true }), { fit: true });
    const before = await editor.code(PAGE);

    // Tablet tile: the item is shown but greyed …
    await rightClickNode(editor, 'card-a', { vpId: 'tablet', at: [0.95, 0.95] });
    expect(await editor.selection()).toEqual(['card-a']);
    await expect(menuItem(page, 'Detach Instance')).toBeVisible();
    await expect(menuItem(page, 'Detach Instance')).toBeDisabled();
    await closeMenu(page);
    // … and the shortcut does nothing there.
    await editor.blur();
    await page.keyboard.press('Control+Alt+b');
    await editor.settled();
    await page.waitForTimeout(600);
    expect(await editor.code(PAGE)).toBe(before);

    // A code-component instance offers no Detach at all.
    await page.waitForTimeout(450);
    await rightClickNode(editor, 'counter-a', { at: [0.5, 0.5] });
    expect(await editor.selection()).toEqual(['counter-a']);
    const labels = await contextMenu(page).getByRole('button').allInnerTexts();
    expect(labels.some(l => /Detach Instance/.test(l))).toBe(false);
    await closeMenu(page);

    // Desktop: select the instance by a real click, then the advertised shortcut.
    await page.waitForTimeout(450);
    const p = await editor.at('card-a', 0.95, 0.95, 'desktop');
    await page.mouse.click(p.x, p.y);
    await editor.settled();
    expect(await editor.selection()).toEqual(['card-a']);
    await editor.blur();
    await page.keyboard.press('Control+Alt+b');
    const after = await pollCode(editor, PAGE, c => c !== before);
    expect(after).not.toMatch(/<Card\b/);
    const rootId = idByName(after, 'Pricing Card')!;
    expect(rootId).toMatch(/^det-/);
    expect(tagNames(elementOf(after, rootId)!.source)).toEqual(['div', 'h2', 'p', 'Badge']);
    await expect.poll(() => editor.selection()).toEqual([rootId]);
    // The code component is untouched.
    expect(after).toContain('<Counter data-id="counter-a"');
    await expect(editor).toUndoInOneStep(before, { path: PAGE });

    // macOS sends Cmd+Option+B with an Option-composed key: it still detaches.
    await editor.undo();
    expect(await editor.code(PAGE)).toBe(before);
    await page.waitForTimeout(450);
    await page.mouse.click(p.x, p.y);
    await editor.settled();
    expect(await editor.selection()).toEqual(['card-a']);
    await editor.blur();
    await pressComposed(page, { key: '∫', code: 'KeyB', keyCode: 66, meta: true, alt: true });
    const mac = await pollCode(editor, PAGE, c => c !== before);
    expect(mac).not.toMatch(/<Card\b/);
  });

  test('CMP-190 data-responsive variants become per-viewport @media overrides; each tile looks as before', { tag: ['@p1', '@cmp', '@tiles'] }, async ({ editor }) => {
    test.fail(true, "BUG: (1) detach writes unranged bands narrowest-first, so the later `@media (max-width: 768px)` wins on the 375 tile too and Mobile paints the Tablet variant's fill/padding (the builder's own serializers write descending bands with min-width floors); (2) the variant-only Burger is hidden on the base with an inline display:'none', which the builder's own oracle rejects (DISPLAY_TOGGLE_VISIBILITY)");
    await editor.load(NAV_RESPONSIVE_SEED, { fit: true });
    const tiles = ['desktop', 'tablet', 'mobile'] as const;
    const parts = { root: 'nav-a:nav-root', logo: 'nav-a:nav-logo', burger: 'nav-a:nav-burger', cta: 'nav-a:nav-cta' };
    const was: Record<string, Record<string, Awaited<ReturnType<typeof paint>>>> = {};
    for (const vp of tiles) {
      was[vp] = {};
      for (const [k, id] of Object.entries(parts)) was[vp][k] = await paint(editor, id, vp);
    }
    // The seed renders a different variant per tile (a node a variant does
    // not render paints as display:none or not at all).
    const shown = (p: Awaited<ReturnType<typeof paint>>) => !!p && p.display !== 'none';
    expect(shown(was.desktop.burger)).toBe(false);
    expect(shown(was.mobile.burger)).toBe(true);
    expect(shown(was.mobile.cta)).toBe(false);
    expect(shown(was.tablet.cta)).toBe(true);

    const { before, after, rootId } = await detachViaMenu(editor, 'nav-a', { at: [0.5, 0.95] });
    const burger = idByName(after, 'Burger')!;
    const cta = idByName(after, 'CTA')!;
    const logo = idByName(after, 'Logo')!;
    expect([rootId, burger, cta, logo].every(id => /^det-/.test(id))).toBe(true);

    // Base = the default variant (inline).
    expect(await editor.style(rootId, PAGE)).toMatchObject({ backgroundColor: '#223344', padding: '16px' });
    // Per-variant differences → @media band overrides. (The order and floors
    // of the bands are judged by what each tile paints, below: two unranged
    // max-width bands both match the 375 tile, and the later one wins.)
    await expect(editor).toHaveBandStyle(768, rootId, 'backgroundColor', '#335577');
    await expect(editor).toHaveBandStyle(768, rootId, 'padding', '10px');
    await expect(editor).toHaveBandStyle(375, rootId, 'backgroundColor', '#553322');
    await expect(editor).toHaveBandStyle(375, rootId, 'padding', '4px');
    // The Burger only the phone variant shows: hidden on the base, unhidden on
    // 375 with its REAL display (flex) — never `unset`.
    await expect(editor).toHaveBandStyle(375, burger, 'display', 'flex');
    await expect(editor).toHaveBandStyle(375, cta, 'display', 'none');
    expect(after).not.toMatch(/display:\s*unset/);
    expect(after).not.toMatch(/\binitialVariant\b|data-responsive|navRootVariants/);
    expect(parsesStrict(after)).toBe(true);

    // Every tile looks as it did.
    const now = { root: rootId, logo, burger, cta };
    for (const vp of tiles) {
      for (const k of Object.keys(parts) as Array<keyof typeof parts>) {
        const p0 = was[vp][k];
        await expect.poll(async () => {
          const p1 = await paint(editor, now[k], vp);
          // A node the tile didn't render must be display:none (or absent) now.
          if (!shown(p0)) return !shown(p1);
          return samePaint(p1, p0);
        }, { message: `${k} on ${vp}` }).toBe(true);
      }
    }
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
  });

  test("CMP-191 the master's ::placeholder / :hover / ::after / @media rules follow the det- ids into the page's one <style>", { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
    await editor.load(FORM_CARD_SEED, { fit: true });
    const { before, after, rootId } = await detachViaMenu(editor, 'fc-a', { at: [0.95, 0.95] });
    expect(rootId).toMatch(/^det-/);
    const email = idByName(after, 'Email')!;
    const title = idByName(after, 'Title')!;
    const media = idByName(after, 'Media')!;
    expect([email, title, media].every(id => /^det-/.test(id))).toBe(true);

    // Exactly ONE <style> on the page, holding the page's own rule and the carried ones.
    expect(after.match(/<style>/g)).toHaveLength(1);
    expect(after).toContain('[data-id="note"]:hover');
    expect(after).toMatch(new RegExp(`\\[data-id="${email}"\\]::placeholder\\s*\\{\\s*color: #94a3b8 !important;`));
    expect(after).toContain(`[data-id="${title}"]:hover`);
    expect(after).toMatch(new RegExp(`\\[data-id="${media}"\\]::after\\s*\\{[^}]*border-color: #384bf6;`));
    await expect(editor).toHaveBandStyle(768, title, 'fontSize', '18px', { important: true });
    // No master-id selector leaks onto the page.
    expect(after).not.toMatch(/\[data-id="fc-(email|title|media|root)"\]/);
    // No <style> left inside the detached subtree.
    expect(elementOf(after, rootId)!.source).not.toContain('<style>');
    expect(parsesStrict(after)).toBe(true);
    await expect(editor).toUndoInOneStep(before, { path: PAGE });
    await editor.redo();

    // Preview: the placeholder is still grey.
    editor.allowErrors(PREVIEW_NOISE);
    const frame = await openPreviewFrame(page, `[data-id="${email}"]`);
    await expect.poll(() => frame.locator(`[data-id="${email}"]`).evaluate(el => getComputedStyle(el, '::placeholder').color), { timeout: 15_000 })
      .toBe('rgb(148, 163, 184)');
  });
});

test('CMP-189 variant-4 instance with a chained gate, a text ternary chain and a prop override detaches to variant-4', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(BTN_SEED);
  const rootBefore = await paint(editor, 'btn-a:btn-root');
  const labelBefore = await paint(editor, 'btn-a:btn-label');
  expect(labelBefore?.text).toBe('Get Started');

  const { before, after, rootId } = await detachViaMenu(editor, 'btn-a', { at: [0.97, 0.9] });
  const root = elementOf(after, rootId)!;
  // The svg the chained gate keeps for variant-4 (with its path), and the variant-4 text.
  expect(tagNames(root.source)).toEqual(['div', 'svg', 'path', 'p']);
  expect(root.source).toContain('viewBox="0 0 26 22"');
  expect(root.source).toContain('Get Started');
  expect(after).not.toContain('Book a Call');
  expect(after).not.toContain('Start now');
  // variant-4 styles baked; the instance prop wins over the master default.
  expect(await editor.style(rootId, PAGE)).toMatchObject({ backgroundColor: '#ff2d75' });
  const label = idByName(after, 'Label')!;
  expect(await editor.style(label, PAGE)).toMatchObject({ color: '#ffcc00' });
  // No variant machinery identifier left on the page.
  expect(after).not.toMatch(/\bvariant\b|\bsetVariant\b|\binitialVariant\b|Variants\b|\blabelColor\b/);
  expect(parsesStrict(after)).toBe(true);
  // The page renders the copy exactly as the instance painted.
  await expect.poll(async () => samePaint(await paint(editor, rootId), rootBefore)).toBe(true);
  expect(samePaint(await paint(editor, label), labelBefore)).toBe(true);
  expect(await paint(editor, idByName(after, 'Shape')!)).not.toBeNull();
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-192 an event-triggered overlay survives detach as a click trigger on the detached root', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  test.fail(true, "BUG: detach rewrites the event trigger to a click trigger but drops the instance's event1={() => setOverlayMenu_1Open(…)} handler, so the detached root has no onClick and the overlay never opens (oracle OVERLAY_MISSING_WIRING)");
  await editor.load(MENU_OVERLAY_SEED);
  const { before, after, rootId } = await detachViaMenu(editor, 'menu-a', { at: [0.05, 0.5] });
  expect(rootId).toMatch(/^det-/);

  // The overlay element survives and now points at the detached root.
  const overlay = elementOf(after, OVERLAY_ID)!;
  expect(overlay).not.toBeNull();
  expect(overlay.open).toContain(`"triggerId":"${rootId}"`);
  expect(after).not.toContain('"triggerId":"menu-a"');
  // The trigger moved to the root as a CLICK trigger, single-quoted JSON.
  const open = elementOf(after, rootId)!.open;
  expect(open).toMatch(new RegExp(`data-overlay-trigger='\\{"targetId":"${OVERLAY_ID}","trigger":"click"`));
  expect(after).not.toContain('"trigger":"event"');
  expect(after).not.toContain('eventName');
  expect(parsesStrict(after)).toBe(true);
  // A click trigger needs its click handler: the overlay's toggle.
  expect(open).toMatch(/onClick=\{\(\) => setOverlayMenu_1Open\(!overlayMenu_1Open\)\}/);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
  await editor.redo();

  // Preview: clicking the detached trigger opens the overlay.
  editor.allowErrors(PREVIEW_NOISE);
  const frame = await openPreviewFrame(page, `[data-id="${rootId}"]`);
  await expect(frame.getByText('Menu overlay')).toHaveCount(0);
  await frame.locator(`[data-id="${rootId}"]`).click();
  await expect(frame.getByText('Menu overlay')).toBeVisible({ timeout: 10_000 });
});

test('CMP-193 a CMS row instance detaches to a <Link data-cms-nav="row"> with its item bindings', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(CMS_ROW_SEED);
  const { before, after, rootId } = await detachViaMenu(editor, 'post-row', { at: [0.95, 0.5] });
  const root = elementOf(after, rootId)!;
  expect(root.tag).toBe('Link');
  expect(root.open).toContain('data-cms-nav="row"');
  expect(root.open).toContain("href={`/posts/${item?._slug ?? ''}`}");
  // Props resolved back to the per-row CMS fields.
  expect(root.source).toContain('url(${item.image})');
  expect(root.source).toContain('>{item.title}<');
  expect(after).toContain('posts.map((item, idx) =>');
  expect(after).not.toMatch(/<PostRow\b|MotionLink|motion\./);
  expect(root.source).not.toMatch(/\$\{image\}|\{title\}|\.\.\.style|linkHref/);
  expect(after).toMatch(/import Link from 'next\/link'/);
  expect(parsesStrict(after)).toBe(true);
  // Every row still paints its own title.
  const title = idByName(after, 'Title')!;
  await expect.poll(() => editor.sandbox().locator(`[data-id="${title}"]`).allInnerTexts()).toEqual(['First post', 'Second post', 'Third post']);

  // The selected detached row is a frame: layout tools, not the text tool.
  expect(await editor.selection()).toEqual([rootId]);
  await expect(panel(page).getByText('Layout', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Direction', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Font Size', { exact: true })).toHaveCount(0);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-194 a paginated collection-list master detaches with its pagination re-declared in the page', { tag: ['@p1', '@cmp', '@preview'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: detach drops the LoadMore instance\'s onLoadMore={() => setVis…((c) => c + 2)} handler, so the re-declared setter is never called and Load More does nothing in preview (2 rows stay 2; the instance itself pages 2 → 3)');
  await editor.load(BLOGS_SEED);
  const { before, after, rootId } = await detachViaMenu(editor, 'blogs-a', { at: [0.97, 0.03] });
  expect(rootId).toMatch(/^det-/);
  const v = 'vis' + rootId.replace(/[^a-zA-Z0-9]/g, '').replace(/^./, c => c.toUpperCase());
  const setV = 'set' + v.charAt(0).toUpperCase() + v.slice(1);
  // State re-declared in the page under the NEW container id; the master's name is gone.
  expect(after).toContain(`const [${v}, ${setV}] = useState(2);`);
  expect(after).toMatch(/import React, \{[^}]*\buseState\b[^}]*\} from 'react'|import \{[^}]*\buseState\b[^}]*\} from 'react'/);
  expect(after).not.toContain('visBlogs');
  const root = elementOf(after, rootId)!;
  expect(root.open).toContain('data-pagination="loadMore:2"');
  expect(root.source).toContain(`blog.slice(0, ${v}).map((item, idx)`);
  expect(root.source).toContain('{item.title}');
  expect(root.source).toContain(`{${v} < blog.length && <LoadMore`);
  expect(after).toMatch(/import LoadMore from '@\/components\/LoadMore'/);
  // The Load More button still advances the page.
  expect(root.source).toContain(`onLoadMore={() => ${setV}((c) => c + 2)}`);
  expect(parsesStrict(after)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
  await editor.redo();

  editor.allowErrors(PREVIEW_NOISE);
  const frame = await openPreviewFrame(page, `[data-id="${rootId}"]`);
  const title = idByName(after, 'Title')!;
  await expect(frame.locator(`[data-id="${title}"]`)).toHaveCount(2, { timeout: 15_000 });
  await frame.getByText('Load More', { exact: true }).first().click();
  await expect(frame.locator(`[data-id="${title}"]`)).toHaveCount(3, { timeout: 10_000 });
});

test('CMP-195 nested Link instances: width-only and style-less get position relative, the absolute one keeps its offsets', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(FOOTER_SEED);
  const { before, after, rootId } = await detachViaMenu(editor, 'footer-a', { at: [0.5, 0.95] });
  expect(rootId).toMatch(/^det-/);
  const a = idByName(after, 'Privacy')!;
  const b = idByName(after, 'Terms')!;
  const c = idByName(after, 'Pinned')!;
  for (const id of [a, b, c]) expect(elementOf(after, id)!.tag).toBe('Lnk');
  expect(await editor.style(a, PAGE)).toEqual({ width: '82px', height: '33px', position: 'relative' });
  // The style-less one gains a style attribute.
  expect(elementOf(after, b)!.attrs).toContain('style');
  expect(await editor.style(b, PAGE)).toEqual({ position: 'relative' });
  expect(await editor.style(c, PAGE)).toEqual({ position: 'absolute', left: '400px', top: '8px' });
  expect(after).toMatch(/import Lnk from '@\/components\/Lnk'/);
  expect(parsesStrict(after)).toBe(true);
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});

test('CMP-196 a formatted-text literal becomes formatted children; a motion.create shim becomes its base tag', { tag: ['@p2', '@cmp'] }, async ({ editor }) => {
  await editor.load(PROMO_SEED);
  const { before, after, rootId } = await detachViaMenu(editor, 'promo-a', { at: [0.95, 0.95] });
  expect(rootId).toMatch(/^det-/);
  const rich = elementOf(after, idByName(after, 'Rich')!)!;
  expect(rich.tag).toBe('p');
  expect(rich.open).not.toContain('dangerouslySetInnerHTML');
  expect(rich.children.replace(/\s+/g, ' ').trim()).toBe('Save <strong>20%</strong> today');
  const link = elementOf(after, idByName(after, 'Logo Link')!)!;
  expect(link.tag).toBe('Link');
  expect(link.open).toContain('href="/"');
  expect(after).not.toContain('MotionLink');
  expect(after).toMatch(/import Link from 'next\/link'/);
  expect(parsesStrict(after)).toBe(true);
  // The formatted text paints, bold run included.
  const richId = idByName(after, 'Rich')!;
  await expect.poll(async () => (await paint(editor, richId))?.text).toBe('Save 20% today');
  await expect(editor.sandbox().locator(`[data-node-id="${richId}"] strong`)).toHaveText('20%');
  await expect(editor).toUndoInOneStep(before, { path: PAGE });
});
