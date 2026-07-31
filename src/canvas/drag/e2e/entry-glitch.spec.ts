// entry-glitch.spec.ts — mid-drag smoothness of the canvas-node → canvas-frame
// ENTRY (the reparent moment). Regression guard for the "glitches out and
// offsets on reparent" bug: the element must track the cursor continuously
// through the entry commit + canvas → absolute-in-frame strategy switch, with
// no per-frame position discontinuity and no transient duplicate elements.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

test.describe('canvas → frame entry (mid-drag)', () => {
  test('chip enters big-frame without jumps, lands under cursor, single element', async ({ page }) => {
    const editor = new EditorPage(page);
    await editor.gotoWithSeed('CANVAS_ENTRY');

    const chip = await editor.nodeBox('chip');
    const frame = await editor.nodeBox('big-frame');
    const from = { x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 };
    const to = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };

    const sandboxFrame = page.frames().find(f => f.url().includes('5174'));
    if (!sandboxFrame) throw new Error('sandbox frame not found');
    await sandboxFrame.evaluate(() => {
      (window as any).__samples = [];
      const tick = () => {
        const els = document.querySelectorAll('[data-id="chip"]');
        const el = els[els.length - 1] as HTMLElement | undefined;
        if (el) {
          const r = el.getBoundingClientRect();
          (window as any).__samples.push({ x: Math.round(r.x), y: Math.round(r.y), n: els.length });
        }
        if ((window as any).__samples.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await editor.dragFromTo(from, to, { steps: 24 });

    const samples: Array<{ x: number; y: number; n: number }> =
      await sandboxFrame.evaluate(() => (window as any).__samples);
    expect(samples.length).toBeGreaterThan(10);

    // The cursor advances ~dist/24 px per step; anything several times that
    // within a single frame is the reparent glitch, not drag motion.
    const stepPx = Math.hypot(to.x - from.x, to.y - from.y) / 24;
    const limit = Math.max(60, stepPx * 3);
    const jumps: Array<{ i: number; d: number; from: any; to: any }> = [];
    for (let i = 1; i < samples.length; i++) {
      const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      if (d > limit) jumps.push({ i, d: Math.round(d), from: samples[i - 1], to: samples[i] });
    }
    if (jumps.length) console.log('MID-DRAG JUMPS:', JSON.stringify(jumps.slice(0, 10)));
    const dupFrames = samples.filter(s => s.n > 1).length;
    expect(jumps, `mid-drag position jumps > ${Math.round(limit)}px/frame`).toEqual([]);
    expect(dupFrames, 'frames with duplicate chip elements').toBe(0);

    // Landed under the cursor, inside the frame — DOM and code agree.
    const finalBox = await editor.nodeBox('chip');
    expect(Math.abs(finalBox.x + finalBox.width / 2 - to.x)).toBeLessThan(30);
    expect(Math.abs(finalBox.y + finalBox.height / 2 - to.y)).toBeLessThan(30);
    const domParent = await sandboxFrame.evaluate(
      () => document.querySelector('[data-id="chip"]')?.parentElement?.getAttribute('data-id'),
    );
    expect(domParent).toBe('big-frame');
    const code = await editor.getPageCode();
    const frameBlock = code.slice(code.indexOf('data-id="big-frame"'));
    expect(frameBlock).toContain('data-id="chip"');
  });
});
