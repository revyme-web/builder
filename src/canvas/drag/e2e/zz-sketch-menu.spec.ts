// zz — TEMP: verify the actual context-menu items for 2-sketch selection.
import { test } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
import { readFileSync } from 'node:fs';
const PAGE = readFileSync('/private/tmp/claude-501/-Users-nk-Documents-Solo-revyme-revyme-open/627c8635-9935-42d2-a6d2-82337e78f7a4/scratchpad/jenny-now2.tsx', 'utf8');

test('menu items for 2-sketch selection', async ({ page }) => {
  test.setTimeout(90_000);
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

  await page.evaluate(() => (window as any).__e2e.select(['sketch-ms5vtkyk-6', 'sketch-ms5vtuj7-7']));
  await page.waitForTimeout(400);
  const r = await editor.node('sketch-ms5vtkyk-6').boundingBox();
  await page.mouse.click(r!.x + r!.width / 2, r!.y + r!.height / 2, { button: 'right' });
  await page.waitForTimeout(600);

  console.log('selection at menu', JSON.stringify(await page.evaluate(() => (window as any).__e2e.selection?.() ?? [])));
  const items = await page.evaluate(() => {
    const menus = [...document.querySelectorAll('div.fixed')].filter((d) => (d as HTMLElement).className.includes('min-w-[240px]'));
    const menu = menus[menus.length - 1];
    if (!menu) return null;
    return [...menu.querySelectorAll('button, [role="menuitem"], div')].map((el) => el.firstChild?.textContent?.trim()).filter((t, i, a) => t && t.length > 1 && t.length < 30 && a.indexOf(t) === i);
  });
  console.log('MENU ITEMS', JSON.stringify(items));
});
