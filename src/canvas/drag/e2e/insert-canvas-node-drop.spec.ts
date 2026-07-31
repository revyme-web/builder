// Insert-panel drag onto a CANVAS-NODE layout — regression for 2026-07-29:
// dragging from the Insert panel over floating canvas frames showed no drop
// indicators and dropped free. Root cause: `getViewportPrefix('')` returned
// the bogus prefix '-' (instead of '' — the prefix canvas nodes are cached
// under), so every rect/layout lookup in ToolbarDragStrategy's canvas-node
// branch silently missed; the drop-position branch also required a truthy
// currentVpId, which canvas-node drops never have.
import { test } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const PAGE = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '600px', backgroundColor: '#ffffff' }}></div>
  );
}
const canvasNodes = <>
  <div data-id="cn-layout" data-name="Floating Column" data-canvas-node="true" style={{ position: 'absolute', left: '-500px', top: '80px', width: '320px', height: '400px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: '16px', padding: '20px', backgroundColor: '#f5f5f7', borderRadius: '12px' }}>
    <div data-id="cn-a" data-name="A" style={{ order: '0', flex: '0 0 auto', position: 'relative', width: '100%', height: '80px', backgroundColor: '#3b82f6', borderRadius: '8px' }}></div>
    <div data-id="cn-b" data-name="B" style={{ order: '1', flex: '0 0 auto', position: 'relative', width: '100%', height: '80px', backgroundColor: '#ef4444', borderRadius: '8px' }}></div>
  </div>
</>;`;

test('insert drag over a canvas-node layout resolves the drop target and inserts inside', async ({ page }) => {
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
  await page.waitForTimeout(2500);

  // Open the Insert panel (the + button in the left rail).
  await page.locator('[data-tutorial="insert-button"]').click();
  await page.waitForTimeout(800);
  const panelDump = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('[data-editor-panel]')];
    return panels.map((p) => (p.textContent ?? '').slice(0, 200));
  });
  console.log('panels', JSON.stringify(panelDump));
  await page.getByText('Elements', { exact: true }).first().hover();
  await page.waitForTimeout(200);
  await page.getByText('Elements', { exact: true }).first().click();
  await page.waitForTimeout(600);
  const frameTile = page.getByText('Frame', { exact: true }).first();
  await frameTile.waitFor({ state: 'visible', timeout: 10_000 });
  const ft = await frameTile.boundingBox();
  console.log('frame tile', JSON.stringify(ft));
  if (!ft) return;

  const target = await editor.node('cn-layout').boundingBox();
  console.log('canvas node rect', JSON.stringify(target));

  // Drag from the tile onto the canvas node (between A and B).
  await page.mouse.move(ft.x + ft.width / 2, ft.y + ft.height / 2);
  await page.mouse.down();
  const tx = target!.x + target!.width / 2;
  const ty = target!.y + target!.height * 0.55;
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(ft.x + ((tx - ft.x) * i) / 10, ft.y + ((ty - ft.y) * i) / 10);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  const moveTraces: string[] = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('toolbar-drag:move') ?? []).slice(-3).map((e: any) => JSON.stringify(e.data ?? e).slice(0, 160)));
  for (const t of moveTraces) console.log('move', t);
  // Drop-line visible?
  const dropLine = await page.evaluate(() => !!document.querySelector('[data-drop-line], [data-dropline]') || null);
  console.log('dropline el?', dropLine);
  await page.mouse.up();
  await page.waitForTimeout(1000);

  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const m = code.match(/data-id="(frame-[a-z0-9]+-\d+)"/);
  console.log('new frame id', m?.[1] ?? null);
  // Is it INSIDE cn-layout?
  const inside = m ? code.indexOf(m[1]) > code.indexOf('cn-layout') && code.indexOf(m[1]) < code.indexOf('</div>', code.indexOf('cn-b')) + 200 : false;
  const cnBlock = code.slice(code.indexOf('cn-layout'), code.indexOf('</div>\n</>') + 10);
  console.log('inserted inside canvas node?', cnBlock.includes(m?.[1] ?? '@@'));
  const dropT: Array<{ parentId?: string }> = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('toolbar-drag:drop') ?? []).slice(-1).map((e: any) => e.data ?? {}));
  const { expect } = await import('@playwright/test');
  expect(m?.[1], 'a new frame was inserted').toBeTruthy();
  expect(cnBlock.includes(m![1]), 'inserted INSIDE the canvas-node layout').toBe(true);
  expect(dropT[0]?.parentId, 'drop routed to the canvas-node parent').toBe('cn-layout');
});
