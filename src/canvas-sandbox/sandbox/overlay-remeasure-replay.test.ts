// overlay-remeasure-replay.test.ts — a portaled relative overlay must be
// RE-PLACED by the full-measure funnel, not only by a render.
//
// A layout drag (reorder / reparent) commits imperatively and deliberately SKIPS
// the resulting re-render, so the Renderer's portal pass never runs on mouseup.
// Repositioning at the raw gesture-end instant wasn't enough either: the reorder
// animates via framer-motion's `layout` FLIP, so at mouseup the trigger is still
// at its OLD rect. `runRemeasureOnNextFrame` is the single funnel every full
// measure goes through — gesture-end force, the settle observer once the FLIP's
// mutations stop, and the camera-idle heal — so the replay lives there and the
// overlay converges wherever the geometry does. Live find 2026-07-25.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { forceRemeasureAllRects } from './rect-emit';
import { setContentRoot } from './sandbox-state';
import { rememberOverlayPlacements } from '@/canvas/renderer/overlay-portals';

// The measure pass itself is out of scope here (and needs the host bridge) —
// stub it so the test asserts only the replay that runs just before it.
vi.mock('./measure', () => ({ emitAllMeasures: vi.fn() }));

function el(attrs: Record<string, string>): HTMLElement {
  const e = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** jsdom has no layout — stub the rects the placement math reads. */
function withRect(e: HTMLElement, r: { left: number; top: number; width: number; height: number }): HTMLElement {
  e.getBoundingClientRect = () => ({
    left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height,
    width: r.width, height: r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(e, 'offsetWidth', { get: () => r.width, configurable: true });
  Object.defineProperty(e, 'offsetHeight', { get: () => r.height, configurable: true });
  return e;
}

const nextFrames = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

describe('full-measure funnel re-places portaled overlays', () => {
  let container: HTMLElement, trigger: HTMLElement, overlay: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    const root = withRect(el({ 'data-node-id': 'root', 'data-viewport': 'desktop' }), { left: 0, top: 0, width: 1440, height: 6000 });
    const portal = el({ 'data-overlay-portal': 'desktop' });
    trigger = withRect(el({ 'data-node-id': 'btn' }), { left: 100, top: 500, width: 200, height: 100 });
    overlay = withRect(el({ 'data-node-id': 'ov1', 'data-overlay-node': 'true' }), { left: 0, top: 0, width: 200, height: 100 });
    root.appendChild(trigger);
    portal.appendChild(overlay); // already portaled by an earlier render
    container.append(root, portal);
    document.body.appendChild(container);
    setContentRoot(container);
    rememberOverlayPlacements([{
      overlayNodeId: 'ov1', triggerNodeId: 'btn', rootNodeId: 'root',
      config: { side: 'bottom', align: 'start', offsetX: 0, offsetY: 10 }, clamp: true,
    }]);
  });

  it('forceRemeasureAllRects re-derives the overlay from the trigger', async () => {
    forceRemeasureAllRects();
    await nextFrames();
    // trigger bottom (600) + gap (8) + offsetY (10)
    expect(overlay.style.top).toBe('618px');
    expect(overlay.style.left).toBe('100px');
  });

  it('a measure AFTER the FLIP settles picks up the trigger\'s final rect', async () => {
    forceRemeasureAllRects();
    await nextFrames();
    const atMouseUp = overlay.style.top;

    // framer-motion's layout animation finishes — the trigger lands lower. The
    // settle observer re-arms on its style mutations and lands another measure.
    withRect(trigger, { left: 100, top: 2400, width: 200, height: 100 });
    forceRemeasureAllRects();
    await nextFrames();

    expect(overlay.style.top).not.toBe(atMouseUp);
    expect(overlay.style.top).toBe('2518px');
  });

  it('no overlays recorded — measure still runs without throwing', async () => {
    rememberOverlayPlacements([]);
    forceRemeasureAllRects();
    await expect(nextFrames()).resolves.toBeUndefined();
  });
});
