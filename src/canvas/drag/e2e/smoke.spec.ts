// smoke.spec.ts — Minimal sanity test. Verifies that:
//   1. The seed mechanism works (FLEX_COLUMN actually loads)
//   2. The iframe is reachable via FrameLocator
//   3. Canvas elements render with the expected data-ids
//   4. The __e2e helper hook is exposed
//
// This MUST pass before we build out per-strategy coverage. If it
// breaks, every other test is suspect.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test('FLEX_COLUMN seed loads, root has 3 sections, __e2e is exposed', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('FLEX_COLUMN');

  // Sandbox iframe + content root present
  await expect(editor.sandbox().locator('[data-content-root]').first()).toBeAttached();

  // The three seeded sections are rendered.
  await expect(editor.node('hero')).toBeAttached();
  await expect(editor.node('features')).toBeAttached();
  await expect(editor.node('how')).toBeAttached();

  // Helper hook is present and reads the seed back unchanged.
  const code = await editor.getPageCode();
  expect(code).toContain('data-id="hero"');
  expect(code).toContain('data-id="features"');
  expect(code).toContain('data-id="how"');

  // Visual order should match JSX order in this seed (no `order` styles).
  const visual = await editor.getRootChildrenVisualOrder();
  expect(visual).toEqual(['hero', 'features', 'how']);
});
