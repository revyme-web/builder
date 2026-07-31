// SVG group-child drag stability — regression for the 2026-07-28 report:
// "the first drag after reload is stable, but all subsequent drags offset".
//
// Root cause chain being guarded here:
//   1. The group-child drag COMMIT calls `moveChildAndRefitGroup` (re-bases
//      children + rewrites the group viewBox/box) and bridge-patches the
//      finals into the sandbox DOM.
//   2. It then fires `forceCanvasRender()` — which used to ship the STALE
//      pre-drag `nodesAtom` parse (the deferred-drag-flush stashes the
//      fan-out for the whole gesture, and the fan-out is only ARMED after
//      the commit), repainting the PRE-refit wrapper over the patches.
//   3. The later fresh parse was identity-preserved (`sameMap: true` — the
//      commit seeds the imperative cache), so NO reconciling render ever
//      shipped. The DOM wrapper stayed one refit behind the model. A refit
//      is a pure re-base, so the stale frame PAINTS correctly — until the
//      next drag writes model-frame coords into it and offsets from the
//      cursor for the whole gesture.
//
// The fix ships `getCachedNodesMap()` + `getCurrentCode()` for any forced
// render inside the gesture window (Canvas.tsx force-render wiring) and
// seeds the refit result into the imperative cache (refit-group.ts). This
// spec drags a group child TWICE and asserts:
//   a. after each commit the sandbox wrapper DOM (viewBox + left/top)
//      EQUALS the committed source — no one-refit-behind Frankenstein;
//   b. during the SECOND drag the child's painted box tracks the mouse.

import { test, expect, type Page } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const GROUP = 'grp';
const CHILD = 'grp-s1';

interface WrapperState {
  viewBox: string;
  left: number;
  top: number;
  childX: number;
  childY: number;
}

/** Committed source truth: group viewBox + left/top and the child's x/y. */
async function sourceWrapperState(page: Page): Promise<WrapperState> {
  const code: string = await page.evaluate(() =>
    (window as any).__e2e.readFile('app/page.client.tsx'),
  );
  const groupOpen = code.match(/<svg[^>]*data-id="grp"[^>]*>/)?.[0] ?? '';
  const childOpen = code.match(/<svg[^>]*data-id="grp-s1"[^>]*>/)?.[0] ?? '';
  const num = (src: string, re: RegExp) => parseFloat(src.match(re)?.[1] ?? 'NaN');
  return {
    viewBox: groupOpen.match(/viewBox="([^"]+)"/)?.[1] ?? '',
    left: num(groupOpen, /left:\s*['"](-?[\d.]+)px['"]/),
    top: num(groupOpen, /top:\s*['"](-?[\d.]+)px['"]/),
    childX: num(childOpen, /\bx="(-?[\d.]+)"/),
    childY: num(childOpen, /\by="(-?[\d.]+)"/),
  };
}

/** Live sandbox DOM state for the same values. */
async function domWrapperState(editor: EditorPage): Promise<WrapperState> {
  return await editor.node(GROUP).evaluate((el) => {
    const child = el.querySelector('[data-id="grp-s1"]') as SVGElement | null;
    return {
      viewBox: el.getAttribute('viewBox') ?? '',
      left: parseFloat((el as unknown as HTMLElement).style.left || 'NaN'),
      top: parseFloat((el as unknown as HTMLElement).style.top || 'NaN'),
      childX: parseFloat(child?.getAttribute('x') ?? 'NaN'),
      childY: parseFloat(child?.getAttribute('y') ?? 'NaN'),
    };
  });
}

function expectDomMatchesSource(dom: WrapperState, src: WrapperState, label: string) {
  expect(dom.viewBox, `${label}: wrapper viewBox DOM vs source`).toBe(src.viewBox);
  expect(Math.abs(dom.left - src.left), `${label}: wrapper left DOM=${dom.left} src=${src.left}`).toBeLessThanOrEqual(1);
  expect(Math.abs(dom.top - src.top), `${label}: wrapper top DOM=${dom.top} src=${src.top}`).toBeLessThanOrEqual(1);
  expect(Math.abs(dom.childX - src.childX), `${label}: child x DOM=${dom.childX} src=${src.childX}`).toBeLessThanOrEqual(1);
  expect(Math.abs(dom.childY - src.childY), `${label}: child y DOM=${dom.childY} src=${src.childY}`).toBeLessThanOrEqual(1);
}

/** Real-mouse drag of the group child by (dx, dy) SCREEN px. Returns the
 *  child's painted bbox sampled mid-drag (after ~60% of the movement). */
async function dragChild(
  editor: EditorPage,
  dxScreen: number,
  dyScreen: number,
): Promise<{ startBox: { x: number; y: number }; midBox: { x: number; y: number }; midProgress: number }> {
  const page = editor.page();
  // Enter group isolation so the pointer hit-test descends to the child.
  await page.evaluate(
    ([g, c]) => (window as any).__e2e.isolateGroupChild(g, c),
    [GROUP, CHILD] as const,
  );
  await page.waitForTimeout(120);
  const box = await editor.node(CHILD).boundingBox();
  expect(box, 'child bbox before drag').toBeTruthy();
  const sx = box!.x + box!.width / 2;
  const sy = box!.y + box!.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Cross the drag-start threshold, then move in steps.
  const STEPS = 10;
  let midBox = { x: 0, y: 0 };
  let midProgress = 0;
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(sx + (dxScreen * i) / STEPS, sy + (dyScreen * i) / STEPS);
    await page.waitForTimeout(30);
    if (i === Math.ceil(STEPS * 0.6)) {
      const mb = await editor.node(CHILD).boundingBox();
      expect(mb, 'child bbox mid-drag').toBeTruthy();
      midBox = { x: mb!.x + mb!.width / 2, y: mb!.y + mb!.height / 2 };
      midProgress = i / STEPS;
    }
  }
  await page.mouse.up();
  return { startBox: { x: sx, y: sy }, midBox, midProgress };
}

test('group-child drag commits leave DOM == source; second drag tracks the mouse', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('SVG_GROUP_LETTERS');
  // Canvas nodes boot off-camera — fit first, then settle.
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(700);

  const group = editor.node(GROUP);
  await expect(group).toBeVisible();

  // Sanity: fresh-load DOM matches the seed source.
  expectDomMatchesSource(await domWrapperState(editor), await sourceWrapperState(page), 'fresh load');

  // ── Drag 1 ── move the middle letter up-right so the refit rewrites the
  // group box AND re-bases siblings (dy motion guarantees a origin shift).
  await dragChild(editor, 90, -55);
  await page.waitForTimeout(900); // commit + forced render + fan-out settle

  const src1 = await sourceWrapperState(page);
  const dom1 = await domWrapperState(editor);
  // The refit must have actually happened (box grew upward → top moved).
  expect(src1.viewBox, 'drag 1 must rewrite the group viewBox').not.toBe('0 0 250 64');
  expectDomMatchesSource(dom1, src1, 'after drag 1 commit');

  // ── Drag 2 ── THE regression: must track the mouse from the first ticks.
  const preBox = await editor.node(CHILD).boundingBox();
  const { startBox, midBox, midProgress } = await dragChild(editor, -120, 70);
  // Mid-drag the painted child centre must sit at start + progress·delta.
  // Before the fix the wrapper was one refit behind (27px off in y here),
  // so the child painted offset from the cursor for the whole gesture.
  const expectedMidX = startBox.x + -120 * midProgress;
  const expectedMidY = startBox.y + 70 * midProgress;
  expect(Math.abs(midBox.x - expectedMidX), `drag 2 mid-drag x: painted=${midBox.x} expected=${expectedMidX}`).toBeLessThanOrEqual(6);
  expect(Math.abs(midBox.y - expectedMidY), `drag 2 mid-drag y: painted=${midBox.y} expected=${expectedMidY}`).toBeLessThanOrEqual(6);
  await page.waitForTimeout(900);

  // And drag 2's commit also leaves DOM == source.
  const src2 = await sourceWrapperState(page);
  const dom2 = await domWrapperState(editor);
  expectDomMatchesSource(dom2, src2, 'after drag 2 commit');

  // The child's final painted position must reflect the second drag's mouse
  // delta (no snap-back): compare painted centre before vs after.
  const postBox = await editor.node(CHILD).boundingBox();
  expect(preBox && postBox, 'child bboxes around drag 2').toBeTruthy();
  expect(Math.abs((postBox!.x - preBox!.x) - -120), 'drag 2 committed x delta').toBeLessThanOrEqual(6);
  expect(Math.abs((postBox!.y - preBox!.y) - 70), 'drag 2 committed y delta').toBeLessThanOrEqual(6);
});
