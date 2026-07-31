// culling-controller.test.ts — standard viewport culling. jsdom has no
// layout, so canvas-space boxes (offset*) are mocked per element; the math,
// swap/restore mechanics, hysteresis, and render-cycle contract are what
// these tests pin.

import { describe, it, expect, beforeEach } from 'vitest';
import { CullingController } from './culling-controller';

function makeRoot(container: HTMLElement, id: string, box: { left: number; top: number; width: number; height: number }, viewport = false): HTMLElement {
  const el = document.createElement('div');
  if (viewport) el.setAttribute('data-viewport', id);
  else el.setAttribute('data-node-id', id);
  Object.defineProperty(el, 'offsetLeft', { get: () => box.left });
  Object.defineProperty(el, 'offsetTop', { get: () => box.top });
  Object.defineProperty(el, 'offsetWidth', { get: () => box.width });
  Object.defineProperty(el, 'offsetHeight', { get: () => box.height });
  container.appendChild(el);
  return el;
}

// jsdom window is 1024×768 by default — the visible rect at identity
// transform is [0,0 .. 1024,768].

describe('CullingController', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('culls a fully-offscreen root into a grey placeholder and restores it when it returns', () => {
    const c = new CullingController(container);
    const near = makeRoot(container, 'desktop', { left: 0, top: 0, width: 800, height: 600 }, true);
    const far = makeRoot(container, 'float-1', { left: 5000, top: 0, width: 400, height: 300 });

    c.onTransform(0, 0, 1);
    c.evaluate();

    expect(near.style.display).not.toBe('none');
    expect(far.style.display).toBe('none');
    expect(far.getAttribute('data-culled')).toBe('true');
    const ph = container.querySelector('[data-culling-placeholder="float-1"]') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.style.left).toBe('5000px');
    expect(ph.style.width).toBe('400px');
    expect(ph.style.pointerEvents).toBe('none');

    // pan the camera so the far root is on screen (x = -4600 puts 5000 at 400)
    c.onTransform(-4600, 0, 1);
    c.evaluate();
    expect(far.style.display).not.toBe('none');
    expect(container.querySelector('[data-culling-placeholder="float-1"]')).toBeNull();
  });

  it('accounts for zoom — a root outside the shrunken visible rect at high scale is culled', () => {
    const c = new CullingController(container);
    const root = makeRoot(container, 'tablet', { left: 1600, top: 0, width: 768, height: 900 }, true);
    // scale 4 → visible canvas rect is only 256×192 at origin; 1600 is far out
    c.onTransform(0, 0, 4);
    c.evaluate();
    expect(root.style.display).toBe('none');
  });

  it('hysteresis: a root hovering just past the cull margin does not thrash', () => {
    const c = new CullingController(container);
    // right edge of viewport is 1024; margin 200 → culls when left > 1224.
    const root = makeRoot(container, 'edge', { left: 1250, top: 0, width: 300, height: 300 });
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(root.style.display).toBe('none');
    // nudge camera so its left edge sits at screen x=1150 — inside the cull
    // margin (200) but OUTSIDE the tighter restore margin (100) → the
    // hysteresis dead zone: stays culled, no thrash.
    c.onTransform(-100, 0, 1);
    c.evaluate();
    expect(root.style.display).toBe('none');
    // bring it clearly on screen → restores
    c.onTransform(-400, 0, 1);
    c.evaluate();
    expect(root.style.display).not.toBe('none');
  });

  it('restoreAll puts every culled root back with its previous display value', () => {
    const c = new CullingController(container);
    const a = makeRoot(container, 'a', { left: 9000, top: 0, width: 100, height: 100 });
    a.style.display = 'flex';
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(a.style.display).toBe('none');
    c.restoreAll();
    expect(a.style.display).toBe('flex');
    expect(a.hasAttribute('data-culled')).toBe(false);
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(0);
  });

  it('pruneStale keeps connected root-level nodes culled and drops removed ones', () => {
    const c = new CullingController(container);
    const a = makeRoot(container, 'a', { left: 9000, top: 0, width: 100, height: 100 });
    const b = makeRoot(container, 'b', { left: 9000, top: 300, width: 100, height: 100 });
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(a.style.display).toBe('none');
    expect(b.style.display).toBe('none');
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(2);

    // `b` leaves the DOM (file switch / stale-viewport cleanup) — prune must
    // drop its entry + placeholder while `a` STAYS culled (renders no longer
    // restore everything; patching hidden DOM is free).
    b.remove();
    c.pruneStale();
    expect(a.style.display).toBe('none');
    expect(a.hasAttribute('data-culled')).toBe(true);
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(1);
  });

  it('restores a culled root that is REPARENTED out of the container (canvas node dragged INTO a frame)', () => {
    // The bug: a canvas node culled while offscreen, then re-nested into a
    // frame (canvas drag or layers-panel re-nest), leaves root level. It is
    // still connected, so pruneStale's old `!isConnected`-only check missed
    // it; and evaluate()/restore() iterate roots() ONLY, so they can never
    // reach a now-nested element again. Result: it stayed display:none +
    // data-culled FOREVER — visible-as-nothing, unhittable, "like it doesn't
    // exist," until a page switch tore down the controller. The prune pass
    // (runs every render cycle) must notice it left root level and restore it.
    const c = new CullingController(container);
    const frame = makeRoot(container, 'frame', { left: 0, top: 0, width: 400, height: 300 });
    const chip = makeRoot(container, 'chip', { left: 9000, top: 0, width: 100, height: 100 });
    chip.style.display = 'block';
    c.onTransform(0, 0, 1);
    c.evaluate();
    // chip is far offscreen → culled
    expect(chip.style.display).toBe('none');
    expect(chip.getAttribute('data-culled')).toBe('true');
    expect(container.querySelector('[data-culling-placeholder="chip"]')).not.toBeNull();

    // Re-nest the chip INTO the frame — it is no longer a direct child of the
    // content root (no longer a cullable root), but it is still connected.
    frame.appendChild(chip);
    c.pruneStale();

    // Must be fully restored: visible display, no data-culled (so the measure
    // pass emits its REAL new in-frame rect instead of a stale projection),
    // placeholder gone, entry dropped.
    expect(chip.style.display).toBe('block');
    expect(chip.hasAttribute('data-culled')).toBe(false);
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(0);
    expect((c as unknown as { culled: Map<HTMLElement, unknown> }).culled.size).toBe(0);
  });

  it('evaluate() also restores a reparented-away culled entry (layers-panel re-nest, DOM moved inside the render)', () => {
    // The canvas-drag path re-homes the DOM (reparentLive) BEFORE the commit
    // render, so pruneStale catches it. The layers-panel path reparents via a
    // `move` mutation INSIDE renderNodes — after pruneStale already ran — so the
    // post-render evaluate() is the one that must catch it. Same orphan, later
    // moment in the cycle.
    const c = new CullingController(container);
    const frame = makeRoot(container, 'frame', { left: 0, top: 0, width: 400, height: 300 });
    const chip = makeRoot(container, 'chip', { left: 9000, top: 0, width: 100, height: 100 });
    chip.style.display = 'block';
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(chip.style.display).toBe('none');
    // The render reparents the chip into the frame (what renderNodes does), then
    // the render cycle's post-render evaluate() runs.
    frame.appendChild(chip);
    c.evaluate();
    expect(chip.style.display).toBe('block');
    expect(chip.hasAttribute('data-culled')).toBe(false);
    expect((c as unknown as { culled: Map<HTMLElement, unknown> }).culled.size).toBe(0);
  });

  it('post-render evaluate() drops DISCONNECTED entries + placeholders (file switch)', () => {
    // A file switch renders BETWEEN the pre-render prune and the post-render
    // evaluate: the removal sweep deletes the old page's elements during the
    // render, so their culled entries turn disconnected AFTER the prune already
    // ran. evaluate() must clean them (entry + grey placeholder) in the SAME
    // cycle — a blank destination page never renders again, so "next render
    // cleans it up" never comes and the placeholders would linger forever.
    const c = new CullingController(container);
    const a = makeRoot(container, 'old-page-node', { left: 9000, top: 0, width: 100, height: 100 });
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(a.style.display).toBe('none');
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(1);

    // The render's removal sweep deletes the old page's element…
    a.remove();
    // …and the post-render evaluate must drop the entry + placeholder NOW.
    c.evaluate();
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(0);
    expect((c as unknown as { culled: Map<HTMLElement, unknown> }).culled.size).toBe(0);
  });

  it('restoreDirty re-materialises culled roots whose content was patched', () => {
    const c = new CullingController(container);
    const a = makeRoot(container, 'a', { left: 9000, top: 0, width: 100, height: 100 });
    a.style.display = 'flex';
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(a.style.display).toBe('none');

    // Renderer patched content inside the hidden root → marked dirty.
    a.setAttribute('data-culled-dirty', 'true');
    c.restoreDirty();
    expect(a.style.display).toBe('flex');
    expect(a.hasAttribute('data-culled')).toBe(false);
    expect(a.hasAttribute('data-culled-dirty')).toBe(false);
    expect(container.querySelectorAll('[data-culling-placeholder]').length).toBe(0);
  });

  it('canvas-node cull box unions overflowing children (visually-in-view child prevents culling)', () => {
    const c = new CullingController(container);
    const a = makeRoot(container, 'a', { left: 9000, top: 0, width: 100, height: 100 });
    // Own client rect offscreen at identity transform…
    (a as any).getBoundingClientRect = () => ({ left: 9000, top: 0, right: 9100, bottom: 100, width: 100, height: 100 });
    // …but an absolutely-positioned child sits INSIDE the viewport.
    const child = document.createElement('div');
    child.setAttribute('data-node-id', 'a-child');
    (child as any).getBoundingClientRect = () => ({ left: 200, top: 200, right: 400, bottom: 400, width: 200, height: 200 });
    a.appendChild(child);

    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(a.style.display).not.toBe('none');
    expect(a.hasAttribute('data-culled')).toBe(false);
  });

  it('defer predicate postpones evaluation (drag in flight)', async () => {
    let dragging = true;
    const c = new CullingController(container, () => dragging);
    const far = makeRoot(container, 'far', { left: 9000, top: 0, width: 100, height: 100 });
    c.onTransform(0, 0, 1);
    await new Promise((r) => setTimeout(r, 200)); // idle fires but defers
    expect(far.style.display).not.toBe('none');
    dragging = false;
    await new Promise((r) => setTimeout(r, 350)); // rescheduled evaluate lands
    expect(far.style.display).toBe('none');
  });

  it('never touches unmeasurable (zero-box) roots', () => {
    const c = new CullingController(container);
    const ghost = makeRoot(container, 'zero', { left: 0, top: 0, width: 0, height: 0 });
    c.onTransform(0, 0, 1);
    c.evaluate();
    expect(ghost.style.display).not.toBe('none');
  });
});

// ─── Overlay portal is never culled ─────────────────────────────────────────
// The Renderer creates one portal per viewport as a direct child of the content
// root: `position:absolute` at the viewport's top-left, full viewport WIDTH but
// **height: 0**, carrying `data-viewport` for click-viewport detection. Its
// children are absolutely placed at arbitrary offsets — an overlay hanging off a
// trigger 5000px down a tall page lives in a portal whose own box is a sliver at
// y=0. `roots()` used to accept it (it has `data-viewport`) and `boxOf()` took
// the viewport branch, returning that sliver instead of unioning the children —
// so scrolling down a tall page pushed the sliver offscreen, the portal got
// display:none'd, and EVERY overlay in that viewport vanished. Short pages never
// reproduced it. Live find 2026-07-25.
describe('CullingController — overlay portal', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  function makePortal(vpId: string, box: { left: number; top: number; width: number; height: number }): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('data-overlay-portal', vpId);
    el.setAttribute('data-viewport', vpId); // for click-viewport detection
    Object.defineProperty(el, 'offsetLeft', { get: () => box.left });
    Object.defineProperty(el, 'offsetTop', { get: () => box.top });
    Object.defineProperty(el, 'offsetWidth', { get: () => box.width });
    Object.defineProperty(el, 'offsetHeight', { get: () => box.height });
    container.appendChild(el);
    return el;
  }

  it('survives when its zero-height box is scrolled far offscreen', () => {
    const c = new CullingController(container);
    // Camera panned ~5000px down a tall page: the portal's sliver at y=0 is
    // now way above the visible rect — exactly the cull condition.
    const portal = makePortal('desktop', { left: 0, top: 0, width: 1440, height: 0 });
    c.onTransform(0, -5000, 1);
    c.evaluate();

    expect(portal.style.display).not.toBe('none');
    expect(portal.hasAttribute('data-culled')).toBe(false);
    expect(container.querySelector('[data-culling-placeholder]')).toBeNull();
  });

  it('still culls the real viewport artboard beside it', () => {
    const c = new CullingController(container);
    const portal = makePortal('desktop', { left: 0, top: 0, width: 1440, height: 0 });
    const artboard = makeRoot(container, 'desktop', { left: 6000, top: 0, width: 1440, height: 900 }, true);

    c.onTransform(0, 0, 1);
    c.evaluate();

    expect(portal.style.display).not.toBe('none'); // exempt
    expect(artboard.style.display).toBe('none');   // ordinary root, still culled
  });
});
