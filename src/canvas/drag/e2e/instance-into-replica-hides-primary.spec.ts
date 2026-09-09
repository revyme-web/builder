// instance-into-replica-hides-primary.spec.ts — a COMPONENT INSTANCE dragged
// from the open canvas into the TABLET replica must show ONLY on tablet.
//
// Reported 2026-09-09: "when I drag a canvas COMPONENT into a replica it hides
// only on mobile but doesn't hide in primary… it works for normal nodes but
// for components it keeps it visible in primary". Instances skipped the
// inline `display:'none'` (the one write that can hide the primary range) on
// the theory that the bounded @media hides cover it — the generator drops a
// primary-width band, so nothing ever hid the desktop.
//
// Now the instance takes the same pair as any node: inline `display:'none'`
// on the tag + the entered band restoring the master ROOT's display (`flex`
// here — never `unset`, which collapses the canvas wrapper <div> to inline,
// and never a blind `block`, because on the live site the band rule lands on
// the root itself). See instance-replica-visibility.ts.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1720, height: 1000 } });

test('component instance dragged into the tablet replica: hidden on desktop + mobile, visible on tablet', async ({ page }) => {
  test.setTimeout(120_000);
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('INSTANCE_CANVAS_3VP');
  await editor.fitCamera();
  await editor.primeNode('card-inst');
  await editor.select(['card-inst']);
  await page.waitForTimeout(600);

  const box = await editor.nodeBox('card-inst');
  const root = await editor.nodeBoxIn('tablet', 'root');
  const hero = await editor.nodeBoxIn('tablet', 'hero');
  // Grab the instance a bit off-centre and drop it into the tablet root's
  // empty flex area below the hero (edge magnet → a flex slot after the hero).
  const from = { x: box.x + box.width / 2 + 6, y: box.y + box.height / 2 + 4 };
  const to = { x: root.x + root.width / 2, y: hero.y + hero.height + (root.y + root.height - hero.y - hero.height) * 0.5 };

  const mouse = page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    await mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { steps: 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));
  }
  await editor.pumpDrag(to, 8);
  await mouse.up();
  await page.waitForTimeout(1200);

  // ── Source: the pair landed in the right channels ──
  const code = await editor.readFile('app/page.client.tsx');
  expect(code, 'the instance joined the page tree').toMatch(/<Card[^>]*data-id="card-inst"/);
  expect(code).not.toMatch(/data-id="card-inst"[^>]*data-canvas-node/);
  // The instance tag spans several lines — match it whole (the helper's
  // single-line tag lookup stops short of a multi-line style object).
  const cardTag = /<Card[\s\S]*?\/>/.exec(code)![0];
  expect(cardTag, 'inline hide baseline on the tag').toMatch(/display:\s*'none'/);
  expect(await editor.getBandStyleProp(768, 'card-inst', 'display'), 'tablet band restores the master ROOT display').toBe('flex');
  expect(await editor.getBandStyleProp(375, 'card-inst', 'display'), 'mobile band hides').toBe('none');
  expect(code, 'no band may be keyed at the primary width').not.toContain('max-width: 1440px');

  // ── Canvas: each tile paints what the source says ──
  const displayIn = async (vpId: string) =>
    (await editor.nodeIn(vpId, 'card-inst')).evaluate(el => getComputedStyle(el).display);
  expect(await displayIn('desktop'), 'desktop copy hidden').toBe('none');
  expect(await displayIn('mobile'), 'mobile copy hidden').toBe('none');
  expect(await displayIn('tablet'), 'tablet copy visible').toBe('flex');
  // The expanded master root inside the tablet copy must paint too — the old
  // `unset` unhide left the wrapper inline (0×0) and a root-baked `none`
  // left the embed blank.
  const innerRoot = editor.sandbox().locator('[data-node-id="tablet-card-inst:card-root"]').first();
  const innerBox = await innerRoot.boundingBox();
  expect(innerBox, 'inner root has a box on tablet').not.toBeNull();
  expect(innerBox!.height).toBeGreaterThan(20);
  expect(await innerRoot.evaluate(el => getComputedStyle(el).display)).toBe('flex');
  const tabletBox = await editor.nodeBoxIn('tablet', 'card-inst');
  expect(tabletBox.width).toBeGreaterThan(20);
  expect(tabletBox.height).toBeGreaterThan(20);
});
