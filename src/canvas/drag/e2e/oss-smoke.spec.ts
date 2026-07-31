// oss-smoke.spec.ts — Zero-regression covenant smoke for the OSS cleanup.
//
// Drives the CORE editor flows end-to-end and archives screenshots so the
// same script can run after every cleanup phase and be compared against
// the baseline captured on the untouched anchor commit.
//
// Screenshot dir is parameterized: OSS_SCREEN_DIR env var
// (default: oss-release-plan/screens/current).
//
// Flows covered here (drag/reorder/reparent/toolbar/shape-edit are already
// covered by the sibling specs in this directory):
//   1. Editor boots with a seeded project; canvas renders all nodes.
//   2. Click-select a frame → selection overlay + properties panel render.
//   3. Draw a new frame with the Frame tool (F) inside an existing frame
//      → new node lands in ProjectFS code.
//   4. Undo (Cmd+Z) → code returns byte-identical to pre-draw.
//   5. Resize a frame via the bottom-right handle → committed size changes.
//   6. Double-click text → type → Escape → committed text updated.

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { EditorPage } from './helpers/editor-page';

const SCREEN_DIR = process.env.OSS_SCREEN_DIR ?? 'oss-release-plan/screens/current';

function shotPath(name: string): string {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  return path.join(SCREEN_DIR, name);
}

// Serial: flows share one editor boot per test but the suite is cheap;
// keep tests independent (each seeds fresh) for reliable bisection.
test.describe('OSS covenant smoke', () => {
  test('1+2: boot, render, select, panel', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('OSS_SMOKE');

    for (const id of ['hero', 'headline', 'cards', 'card-a', 'card-b']) {
      await expect(editor.node(id)).toBeAttached();
    }
    await page.screenshot({ path: shotPath('01-boot.png'), fullPage: false });

    // Click-select the hero frame (pointer events go through the parent frame).
    const c = await editor.nodeCenter('hero');
    await page.mouse.click(c.x, c.y);
    // Properties panel should now show the Styles section for the selection.
    await expect(page.getByText('Styles', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: shotPath('02-selected-panel.png'), fullPage: false });
  });

  test('3+4: draw frame with F tool, then undo restores code byte-identical', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('OSS_SMOKE');

    const before = await editor.getPageCode();

    // Frame tool + draw a ~120x90 rect inside the hero frame.
    await page.keyboard.press('f');
    const hero = await editor.nodeBox('hero');
    const from = { x: hero.x + 60, y: hero.y + 60 };
    const to = { x: hero.x + 180, y: hero.y + 150 };
    await editor.dragFromTo(from, to);
    // Creator commit is deferred a couple frames + queue flush.
    await page.waitForTimeout(600);

    const after = await editor.getPageCode();
    expect(after).not.toEqual(before);
    const countIds = (s: string) => (s.match(/data-id="/g) ?? []).length;
    expect(countIds(after)).toBeGreaterThan(countIds(before));
    await page.screenshot({ path: shotPath('03-frame-drawn.png'), fullPage: false });

    // Undo → byte-identical restore.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForTimeout(500);
    const undone = await editor.getPageCode();
    expect(undone).toEqual(before);
    await page.screenshot({ path: shotPath('04-after-undo.png'), fullPage: false });
  });

  test('5: resize via bottom-right handle commits new size', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('OSS_SMOKE');

    // Select card-a, then grab its bottom-right corner handle.
    const center = await editor.nodeCenter('card-a');
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(300);
    const box = await editor.nodeBox('card-a');
    const corner = { x: box.x + box.width, y: box.y + box.height };
    await editor.dragFromTo(corner, { x: corner.x + 60, y: corner.y + 40 });
    await page.waitForTimeout(500);

    const code = await editor.getPageCode();
    // card-a started at width 300 / height 200 — the committed style must differ.
    const cardTag = /data-id="card-a"[^>]*style=\{\{([^}]*)\}\}/.exec(code)?.[1] ?? '';
    expect(cardTag).not.toContain("width: '300px'");
    await page.screenshot({ path: shotPath('05-resized.png'), fullPage: false });
  });

  test('6: double-click text, type, Escape commits', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('OSS_SMOKE');

    const c = await editor.nodeCenter('headline');
    await page.mouse.dblclick(c.x, c.y);
    await page.waitForTimeout(600); // TipTap mounts inside the iframe
    await page.keyboard.type(' EDITED', { delay: 20 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const code = await editor.getPageCode();
    expect(code).toContain('EDITED');
    await page.screenshot({ path: shotPath('06-text-edited.png'), fullPage: false });
  });
});
