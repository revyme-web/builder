// collection-row-drop-keeps-ghosts.spec.ts — drag a collection list's template
// row and release it in place: the ghost rows must be back, in place, with no
// lift geometry on them (2026-09-09: the rows "disappeared" — the per-frame
// lift left/top fanned out to the ghost copies and the drop's forced rebuild
// was skipped by the render-integrity guard because a healed
// `<RevymeSplitText data-id>` looked like a node missing from the map).
// The seed carries a STAMPED wrapper id; the boot heal (healMissingInstanceDataIds,
// now transparent-tag aware) strips it before the first render — asserted below —
// and the render-integrity unit tests cover the guard itself.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('template row dragged and released in place → ghost rows visible, undisplaced', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('CMS_LIST_ROWS');
  await page.waitForTimeout(800);
  const rows = () => editor.sandbox().locator('[data-id="list"]').first().evaluate((el) => {
    return (Array.from(el.children) as HTMLElement[]).map(k => {
      const r = k.getBoundingClientRect();
      return { id: k.getAttribute('data-node-id'), ghost: k.hasAttribute('data-collection-ghost'), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: k.style.left, itop: k.style.top };
    });
  });
  const before = await rows();
  expect(before.filter(r => r.ghost).length).toBe(2);
  // Boot heal stripped the id the seed stamped on the text-effect wrapper.
  const pageSrc: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(pageSrc).toContain('<RevymeSplitText spec=');
  expect(pageSrc).not.toContain('RevymeSplitText data-id=');

  await editor.primeNode('row');
  await editor.select(['row']);
  await page.waitForTimeout(200);
  const box = await editor.nodeBox('row');
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 8; i++) { await mouse.move(from.x + i, from.y + i, { steps: 1 }); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))); }
  // lifted: ghosts hidden, and NO lift geometry on them
  const during = await rows();
  for (const g of during.filter(r => r.ghost)) { expect(g.left).toBe(''); expect(g.itop).toBe(''); }
  for (let i = 7; i >= 0; i--) { await mouse.move(from.x + i, from.y + i, { steps: 1 }); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))); }
  await mouse.up();
  await page.waitForTimeout(400);

  const after = await rows();
  const ghosts = after.filter(r => r.ghost);
  expect(ghosts.length).toBe(2);
  for (const g of ghosts) {
    expect(g.w).toBeGreaterThan(0);
    expect(g.h).toBeGreaterThan(0);
    expect(g.left).toBe('');
    expect(g.itop).toBe('');
  }
  // same vertical positions as before the gesture (±2px)
  const beforeTops = before.filter(r => r.ghost).map(r => r.top);
  ghosts.forEach((g, i) => expect(Math.abs(g.top - beforeTops[i])).toBeLessThan(3));
  // the forced rebuild was NOT skipped by the guard
  const skipped = await page.evaluate(() => (window as any).__e2e.traceEntries('force-render-skip').length);
  expect(skipped).toBe(0);
});
