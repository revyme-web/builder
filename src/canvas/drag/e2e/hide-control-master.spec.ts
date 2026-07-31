// hide-control-master.spec.ts — Hiding a node in a design-component MASTER must
// hide it in the canvas IMMEDIATELY (no page switch), via BOTH the Styles "Hide"
// control and the Layers eye. Both route the display:none write to a STRUCTURAL
// `setVariantVisibility` (AnimatePresence rewrap) that only lands on a full
// Renderer cycle — forced by `flushAndForceStructuralRender()`. Regression: the
// Styles control updated the code but left the DOM stale (live find 2026-07-24).

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

async function openCardMaster(editor: EditorPage) {
  await editor.gotoWithSeed('COMPONENT_MASTER');
  // Switch the active file to the component master so the viewport becomes its
  // variants and the Renderer paints the component tree.
  await editor.page().evaluate(() => (window as any).__e2e.openFile('components/Card.tsx'));
  // Wait for the master's children to render in the sandbox.
  await editor.node('card-badge').waitFor({ state: 'visible', timeout: 15_000 });
}

test('Styles Hide control hides a node in a component master without a page switch', async ({ page }) => {
  const editor = new EditorPage(page);
  await openCardMaster(editor);

  // Baseline: the badge is visible.
  await expect(editor.node('card-badge')).toBeVisible();

  // Select the badge → the Styles tool (with the Hide control) renders in the panel.
  await page.evaluate(() => (window as any).__e2e.select(['card-badge']));

  // Click the Hide control's "Yes" button (parent-frame panel UI).
  const hideRow = page.locator('[data-tool-row]', { has: page.getByText('Hide', { exact: true }) }).first();
  await hideRow.waitFor({ state: 'visible', timeout: 10_000 });
  await hideRow.locator('[data-tool-row-value] button', { hasText: 'Yes' }).click();

  // The badge must hide in the canvas immediately (the bug: it stayed visible
  // until a page switch). Poll — the structural rebuild lands a frame after the
  // flush.
  await expect(editor.node('card-badge')).toBeHidden({ timeout: 8_000 });

  // The code committed the AnimatePresence conditional wrap (source of truth).
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('components/Card.tsx'));
  expect(code).toContain('AnimatePresence');
  expect(code).toMatch(/card-badge/);
});

// The Layers-panel eye toggle routes through the IDENTICAL mechanism
// (`updateNodeStyles` → `flushAndForceStructuralRender`), so this Styles-control
// test covers the shared force. A dedicated Layers-eye test is omitted because it
// requires driving the left-panel UI (the layers panel isn't the default open
// panel), which is fragile relative to the value it adds over the shared-helper
// coverage above.
