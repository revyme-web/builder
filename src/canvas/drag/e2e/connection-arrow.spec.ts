// connection-arrow.spec.ts — Adding a variant connection must draw the
// ArrowConnectors overlay arrow IMMEDIATELY (no page reload). Regression: the
// arrow's recompute effect keyed only on `nodes`, and adding a connection via
// modifyProjectFile didn't hand this component a fresh `nodes` reference, so the
// arrow never redrew until a reparse (page reload). Fixed by also keying the
// effect on `projectVersion` (bumped by every modifyProjectFile write).
// Live find 2026-07-24.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('variant connection draws the ArrowConnectors arrow immediately', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('COMPONENT_MASTER_2V');
  await page.evaluate(() => (window as any).__e2e.openFile('components/Card.tsx'));
  await editor.node('card-root').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => (window as any).__e2e.select(['card-root']));
  await page.waitForTimeout(300);

  const arrowState = async () => page.evaluate(() => {
    const svg = document.querySelector('[data-arrow-connectors]') as HTMLElement | null;
    if (!svg) return { exists: false, count: 0, visible: false };
    const cs = getComputedStyle(svg);
    return {
      exists: true,
      count: Number(svg.getAttribute('data-arrow-count') ?? '0'),
      visible: cs.opacity !== '0' && cs.visibility !== 'hidden',
    };
  });

  // Before: no connection → no arrow overlay.
  expect((await arrowState()).exists).toBe(false);

  // Add a connection default → variant-1 on click (mirrors InteractionsTool.handleAdd).
  await page.evaluate(() => (window as any).__e2e.addConnection('default', 'variant-1', 'click'));

  // The arrow overlay must appear WITHOUT a reload — poll (rebuild lands a frame
  // or two after the write).
  await expect.poll(arrowState, { timeout: 8_000 }).toMatchObject({ exists: true, visible: true });
  expect((await arrowState()).count).toBeGreaterThan(0);

  // Sanity: the connection actually committed to the source.
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('components/Card.tsx'));
  expect(code).toMatch(/const connections\s*=/);
});
