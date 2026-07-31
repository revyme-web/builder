// Rotated nodes must keep their transform through drag commits — regression
// for 2026-07-29: CanvasDragStrategy.onEnd cleared `originalTransforms` right
// after its atomic DOM patch, but the commit loops BELOW still read the map —
// every later `transform: orig` became `transform: ''`, so the code commit
// ERASED the rotation on mouse-up (the DOM looked right for a frame, then the
// render applied the code). Hit both the exit-from-frame drop and the plain
// canvas-node drag.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const PAGE = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff' }}>
      <div data-id="host-1" data-name="Host" style={{ position: 'relative', width: '561px', height: '500px', backgroundColor: '#ffdfba', margin: '40px auto' }}>
        <div data-id="spin-1" data-name="Spin" style={{ position: 'absolute', left: '140px', top: '120px', width: '209px', height: '172px', backgroundColor: '#97cffc', transform: 'rotate(-15deg)' }}></div>
      </div>
    </div>
  );
}
const canvasNodes = <>
  <div data-id="cn-spin" data-name="CanvasSpin" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '80px', width: '180px', height: '140px', backgroundColor: '#baffc9', transform: 'rotate(20deg)' }}></div>
</>;`;

async function seed(page: import('@playwright/test').Page): Promise<EditorPage> {
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
  await editor.node('spin-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);
  return editor;
}

async function dragBy(page: import('@playwright/test').Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + (dx * i) / 12, from.y + (dy * i) / 12);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

test('dragging a rotated node OUT of a frame onto the canvas keeps its rotation on commit', async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await seed(page);
  const b = (await editor.node('spin-1').boundingBox())!;
  // Drag from the node's center far left — well past the frame's edge onto
  // empty canvas.
  await dragBy(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -(b.x + b.width / 2) + 60, 40);

  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const seg = code.slice(code.indexOf('spin-1'), code.indexOf('spin-1') + 500);
  console.log('committed spin-1:', JSON.stringify(seg.slice(0, 300)));
  expect(seg).toContain('rotate(-15deg)');
  // And it actually left the host (canvas node or reparented out).
  expect(/data-canvas-node="true"/.test(seg) || !code.slice(code.indexOf('host-1'), code.indexOf('host-1') + 900).includes('spin-1')).toBe(true);
});

test('dragging a rotated CANVAS node keeps its rotation on commit', async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await seed(page);
  await editor.node('cn-spin').waitFor({ state: 'visible', timeout: 30_000 });
  const b = (await editor.node('cn-spin').boundingBox())!;
  await dragBy(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, 80, 60);

  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const seg = code.slice(code.indexOf('cn-spin'), code.indexOf('cn-spin') + 500);
  console.log('committed cn-spin:', JSON.stringify(seg.slice(0, 300)));
  expect(seg).toContain('rotate(20deg)');
});
