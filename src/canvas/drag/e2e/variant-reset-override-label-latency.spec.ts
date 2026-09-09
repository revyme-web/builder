// variant-reset-override-label-latency.spec.ts — Reset Override on the
// Component Props "Variant" row must drop the label's override accent WITH the
// click, not a second later.
//
// Reported 2026-09-09: on a tablet replica the DOM reverted instantly but the
// purple/blue "Variant" label took ~1s to lose its override state. The panel
// derives that state from the STABLE code mirror, which by design waits out a
// 450ms canvas-paint budget (+ the parser cascade) before catching up. Panel
// writes are meant to call `expediteStableAtomSync()` so their own result
// lands on the next tick — the Component Props tool's reset never did.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.use({ viewport: { width: 1720, height: 1000 } });

test('Reset Override on the Variant row: label accent clears within a frame budget, not the 450ms mirror delay', async ({ page }) => {
  test.setTimeout(90_000);
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('INSTANCE_VARIANT_OVERRIDE_3VP');
  await editor.fitCamera();
  await editor.primeNode('root', 'tablet');
  await editor.select(['card-inst'], 'tablet');
  await page.waitForTimeout(800);

  const panel = page.locator('[data-properties-panel]');
  const label = panel.getByText('Variant', { exact: true }).first();
  await expect(label).toBeVisible({ timeout: 10_000 });
  // Page file + per-viewport override → the blue override accent.
  await expect(label).toHaveClass(/accent-text/, { timeout: 10_000 });

  // Open the label's menu (left click), then click "Reset Override" from
  // INSIDE the page and time how long the accent survives, frame by frame.
  await label.click();
  await expect(page.getByText('Reset Override', { exact: true })).toBeVisible({ timeout: 5_000 });
  const elapsedMs = await page.evaluate(() => new Promise<number>((resolve) => {
    const leafByText = (root: ParentNode, text: string): HTMLElement | null => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        if (el.childElementCount === 0 && el.textContent?.trim() === text) return el;
      }
      return null;
    };
    const item = leafByText(document, 'Reset Override');
    if (!item) { resolve(-1); return; }
    const panelEl = document.querySelector('[data-properties-panel]')!;
    const accented = () => leafByText(panelEl, 'Variant')?.className.includes('accent-text') ?? false;
    const t0 = performance.now();
    item.click();
    const tick = () => {
      const dt = performance.now() - t0;
      if (!accented() || dt > 4000) { resolve(dt); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  expect(elapsedMs, 'the Reset Override item was found').toBeGreaterThanOrEqual(0);
  // The stable mirror's canvas budget alone is 450ms; an expedited panel
  // write lands the next tick + a small parse/render — well under this.
  expect(elapsedMs, 'label accent cleared with the click').toBeLessThan(250);

  // The override really went away in the source.
  await page.waitForTimeout(300);
  const code = await editor.readFile('app/page.client.tsx');
  expect(code).not.toMatch(/"768":\{[^}]*initialVariant/);
  await expect(label).not.toHaveClass(/accent-text/);
});
