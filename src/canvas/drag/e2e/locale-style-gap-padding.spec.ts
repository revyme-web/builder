// Gap Localize must not crash (StyleField hook order) and Padding gets the
// pill + a full-width spacing cluster in the popup (ControlRow hideLabel).
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';
test('Gap localize does not crash; Padding gets pill + wide control', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('LOCALE_3VP');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__e2e.select(['card'], 'desktop'));
  await page.waitForTimeout(400);
  // GAP — used to crash StyleField with "Rendered fewer hooks".
  await page.locator('[data-properties-panel]').getByText('Gap', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  expect(errs.filter(e => e.includes('fewer hooks'))).toHaveLength(0);
  // The seeded gap value is a real length (CSS initial 0px), never the
  // browser's computed 'normal'.
  const gapCode = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(gapCode).not.toMatch(/gap:\s*normal/i);
  expect(gapCode).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*gap:\s*0px/i);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-locale-pill="gap"]')).toBeVisible({ timeout: 5000 });
  // PADDING — pill on the row + rule written.
  await page.locator('[data-properties-panel]').getByText('Padding', { exact: true }).first().click();
  await page.getByText('Localize', { exact: true }).click();
  await page.waitForTimeout(700);
  const dbg = await page.evaluate(() => {
    const cond = document.querySelector('[data-locale-condition]');
    const walk = (el: Element, d: number): string[] => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const out = [`${'  '.repeat(d)}${el.tagName}.${(el as HTMLElement).className?.toString().slice(0, 60)} w=${Math.round(r.width)}`];
      if (d < 4) for (const c of el.children) out.push(...walk(c, d + 1));
      return out;
    };
    return cond ? walk(cond, 0).slice(0, 25) : ['NO-COND'];
  });
  console.log('TREE\n' + dbg.join('\n'));
  const setInput = page.locator('[data-locale-condition] input').first();
  const w = (await setInput.boundingBox())?.width ?? 0;
  expect(w).toBeGreaterThan(40); // not the collapsed sliver
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-locale-pill="padding"]')).toBeVisible({ timeout: 5000 });
  const code = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toMatch(/:lang\(fr\)[^{]*\[data-id="card"\][^{]*\{[^}]*padding/i);
});
