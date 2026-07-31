// Drag a canvas node INTO a section whose hit-target is an absolute child
// positioned `left/top: 50%` + `translate(-50%, -50%)` at 100%×100% (the
// centered-image pattern) — regression for 2026-07-30: the entry commit's
// screen→parent-local conversion composed the parent's FULL computed matrix
// (whose translation is already reflected in the BCR anchor), double-applying
// the -50% translate → the dragged node jumped by ~(W/2, H/2) the moment it
// entered. The fix uses only the matrix's linear part.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const PAGE = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px', backgroundColor: '#ffffff' }}>
      <div data-id="section-1" data-name="Section" style={{ position: 'relative', width: '100%', height: '761px', backgroundColor: '#dddddd', overflow: 'hidden' }}>
        <div data-id="img-1" data-name="Image" style={{ position: 'absolute', left: '50%', top: '50%', width: '100%', height: '100%', backgroundColor: '#222222', transform: 'translateX(-50%) translateY(-50%)' }}></div>
      </div>
    </div>
  );
}
const canvasNodes = <>
  <div data-id="cn-pink" data-name="Pink" data-canvas-node="true" style={{ position: 'absolute', left: '-460px', top: '200px', width: '300px', height: '170px', backgroundColor: '#ffb3ba' }}></div>
</>;`;

test('canvas node dragged into a translate(-50%,-50%) image child lands at the cursor (no entry jump)', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('cn-pink').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);

  const start = (await editor.node('cn-pink').boundingBox())!;
  const img = (await editor.node('img-1').boundingBox())!;
  const grabX = start.x + start.width / 2;
  const grabY = start.y + start.height / 2;
  // Target: center-ish of the image section.
  const targetX = img.x + img.width * 0.37;
  const targetY = img.y + img.height * 0.41;

  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  // Slow, fine-grained motion: the entry anchor reads the element's rect at
  // the crossing instant — big synthetic per-step jumps leave a rect-cache
  // lag that reads as a false offset (~half a step). 36 small steps keeps
  // the lag under a couple of px, like a real human drag.
  for (let i = 1; i <= 36; i++) {
    await page.mouse.move(grabX + ((targetX - grabX) * i) / 36, grabY + ((targetY - grabY) * i) / 36);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(1500);

  // The node's center must sit at the cursor's final position (it was grabbed
  // at its center), continuous through the entry commit — pre-fix it jumped
  // by ~half the image's size (hundreds of px).
  const after = (await editor.node('cn-pink').boundingBox())!;
  const cx = after.x + after.width / 2;
  const cy = after.y + after.height / 2;
  console.log('final center vs cursor', (cx - targetX).toFixed(1), (cy - targetY).toFixed(1));
  const entryTraces: string[] = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('transform-reparent:entry') ?? []).map((e: any) => JSON.stringify(e.data ?? e).slice(0, 300)));
  for (const t of entryTraces) console.log('entry', t);
  const snapTraces: string[] = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('drag:snap') ?? []).slice(-2).map((e: any) => JSON.stringify(e.data ?? e).slice(0, 200)));
  for (const t of snapTraces) console.log('snap', t);
  expect(Math.abs(cx - targetX)).toBeLessThan(6);
  expect(Math.abs(cy - targetY)).toBeLessThan(6);

  // And it committed INSIDE the section subtree (image child or section).
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const sectionIdx = code.indexOf('section-1');
  const pinkIdx = code.indexOf('cn-pink');
  expect(pinkIdx).toBeGreaterThan(sectionIdx);
  expect(code.slice(pinkIdx, pinkIdx + 300)).not.toContain('data-canvas-node');
});
