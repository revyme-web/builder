// absolute-sibling-keeps-paint-order.spec.ts — dropping a canvas node ABOVE
// the flow child of a flex parent renumbers the flow siblings; the parent's
// absolute/fixed children must ride along (Flexbox paints them by `order`
// too) or they drop behind the first sibling with order ≥ 1 (a pinned hero
// vanished under the next section, 2026-09-09).
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('hero + bar stay painted above the renumbered section after a drop', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('FLEX_WITH_ABSOLUTE_HERO');
  await page.waitForTimeout(600);
  const probe = () => editor.sandbox().locator('[data-id="wrap"]').first().evaluate((wrap) => {
    const doc = wrap.ownerDocument;
    const q = (id: string) => wrap.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
    const hero = q('hero')!, bar = q('bar')!, body = q('body')!;
    // Probe a point where the hero overlaps the flow SECTION (below the header).
    const br = body.getBoundingClientRect(); const hr = hero.getBoundingClientRect();
    const top = doc.elementFromPoint(hr.left + hr.width / 2, Math.min(hr.bottom - 4, br.top + 30)) as HTMLElement | null;
    return {
      orders: { body: getComputedStyle(body).order, hdr: q('hdr') ? getComputedStyle(q('hdr')!).order : null },
      z: { hero: hero.style.zIndex, bar: bar.style.zIndex },
      topAtHeroCenter: top?.closest('[data-id="hero"]') ? 'hero' : (top?.getAttribute('data-id') ?? top?.tagName ?? null),
    };
  });
  const before = await probe();
  expect(before.topAtHeroCenter).toBe('hero');

  await editor.primeNode('hdr');
  await editor.select(['hdr']);
  await page.waitForTimeout(150);
  const bodyBox = await editor.nodeBox('body');
  // Drop at the flow section's TOP EDGE (edge magnet → the flex parent wins,
  // insert index 0 = above the section), in the strip the overlays don't cover.
  await editor.duringDrag('hdr', { x: bodyBox.x + bodyBox.width * 0.9, y: bodyBox.y + 3 }, async () => {}, { prime: false, steps: 20 });
  await page.waitForTimeout(700);

  const after = await probe();
  expect(after.orders.hdr).toBe('0');
  expect(after.orders.body).toBe('1');
  // The overlays got z-index 1 → still painted above the renumbered section.
  expect(after.z.hero).toBe('1');
  expect(after.z.bar).toBe('1');
  expect(after.topAtHeroCenter).toBe('hero');
  // …and it is in the SOURCE, not only the DOM.
  const src: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const heroTag = src.slice(src.indexOf('data-id="hero"'), src.indexOf('}}', src.indexOf('data-id="hero"')));
  expect(heroTag).toMatch(/zIndex: '1'/);
});


test('USER PAGE: the already-renumbered page is healed on load — hero paints above the section', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('USER_HERO_AFTER');
  await editor.openFile('app/collection-1/[slug]/page.client.tsx');
  await page.waitForTimeout(1500);
  const r = await editor.sandbox().locator('[data-id="div-mt9uiobg-1"]').first().evaluate((wrap) => {
    const doc = wrap.ownerDocument;
    const hero = doc.querySelector('[data-node-id="div-mt9uiobo-2v"]') as HTMLElement;
    const b = hero.getBoundingClientRect();
    const el = doc.elementFromPoint(b.x + b.width / 2, b.y + b.height * 0.8) as HTMLElement | null;
    return { top: el?.closest('[data-node-id="div-mt9uiobo-2v"]') ? 'HERO' : (el?.getAttribute('data-node-id') ?? null), z: hero.style.zIndex };
  });
  expect(r.top).toBe('HERO');
  expect(r.z).toBe('1');
  const src: string = await page.evaluate(() => (window as any).__e2e.readFile('app/collection-1/[slug]/page.client.tsx'));
  const heroTag = src.slice(src.indexOf('data-id="div-mt9uiobo-2v"'), src.indexOf('}}', src.indexOf('data-id="div-mt9uiobo-2v"')));
  expect(heroTag).toMatch(/zIndex: '1'/);
});
