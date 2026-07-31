// @vitest-environment jsdom
// emitAllMeasures — the post-render measure pass. Pins the OFFSCREEN-SECTION
// replay: culling is tile-level, so zooming deep INTO a big page keeps the
// tile materialised and the pass used to re-measure its entire subtree per
// operation. Sections fully outside the expanded viewport must replay their
// cached payloads (shifted by the section's own screen delta) instead of
// re-measuring, and the idle full pass must heal them afterwards.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitAllMeasures, clearMeasureReplayCache } from './measure';
import { setContentRoot } from './sandbox-state';

type Box = { left: number; top: number; width: number; height: number };
const boxes = new Map<Element, Box>();
const gbcrCalls = new Map<Element, number>();

function el(tag: string, dni: string, dataId: string | null, box: Box): HTMLElement {
  const e = document.createElement(tag);
  e.setAttribute('data-node-id', dni);
  if (dataId) e.setAttribute('data-id', dataId);
  boxes.set(e, box);
  gbcrCalls.set(e, 0);
  (e as any).getBoundingClientRect = () => {
    gbcrCalls.set(e, (gbcrCalls.get(e) || 0) + 1);
    const b = boxes.get(e)!;
    return { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height, width: b.width, height: b.height, x: b.left, y: b.top };
  };
  return e;
}

// jsdom viewport: 1024×768. OFFSCREEN_MARGIN is 600 → offscreen at left > 1624.
const OFF_X = 3000;

let events: any[] = [];
let postSpy: ReturnType<typeof vi.spyOn>;

function rectsFromLastAllRects(): Map<string, Box> {
  const evt = [...events].reverse().find(e => e?.payload?.type === 'allRects');
  const m = new Map<string, Box>();
  for (const r of evt?.payload?.rects ?? []) m.set(`${r.vpPrefix}:${r.nodeId}`, r.rect);
  return m;
}

describe('emitAllMeasures — offscreen-section replay', () => {
  let root: HTMLElement;
  let tile: HTMLElement;
  let secA: HTMLElement; let a1: HTMLElement;
  let secB: HTMLElement; let b1: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    postSpy = vi.spyOn(window, 'postMessage').mockImplementation(((msg: any) => { events.push(msg); }) as any);
    document.body.innerHTML = '';
    boxes.clear(); gbcrCalls.clear();
    root = document.createElement('div');
    document.body.appendChild(root);
    setContentRoot(root);

    tile = el('div', 'root', 'root', { left: 0, top: 0, width: 1440, height: 4000 });
    tile.setAttribute('data-viewport', 'desktop');
    root.appendChild(tile);
    secA = el('div', 'secA', 'secA', { left: 0, top: 0, width: 500, height: 400 });
    a1 = el('div', 'a1', 'a1', { left: 20, top: 20, width: 100, height: 50 });
    secA.appendChild(a1);
    tile.appendChild(secA);
    secB = el('div', 'secB', 'secB', { left: OFF_X, top: 0, width: 500, height: 400 });
    b1 = el('div', 'b1', 'b1', { left: OFF_X + 20, top: 20, width: 100, height: 50 });
    secB.appendChild(b1);
    tile.appendChild(secB);
  });

  afterEach(() => {
    postSpy.mockRestore();
    vi.useRealTimers();
  });

  it('first pass measures everything (no cache yet), later passes replay offscreen sections', () => {
    emitAllMeasures();
    // Pass 1: no cache — offscreen secB measured live too.
    let rects = rectsFromLastAllRects();
    expect(rects.get(':b1')?.left).toBe(OFF_X + 20);
    const b1CallsAfterPass1 = gbcrCalls.get(b1)!;
    expect(b1CallsAfterPass1).toBeGreaterThan(0);

    // Pass 2: secB has cache and sits offscreen — its subtree is REPLAYED,
    // not re-measured (b1's getBoundingClientRect is not called again).
    events = [];
    emitAllMeasures();
    rects = rectsFromLastAllRects();
    expect(rects.get(':b1')?.left).toBe(OFF_X + 20); // same values, replayed
    expect(gbcrCalls.get(b1)).toBe(b1CallsAfterPass1);
    // Visible section stays live-measured.
    expect(gbcrCalls.get(a1)).toBeGreaterThan(1);
  });

  it('shifts replayed payloads by the section delta when the offscreen section moved', () => {
    emitAllMeasures(); // prime cache
    // Content above secB grew: the whole section shifted +40/+120 on screen.
    boxes.set(secB, { left: OFF_X + 40, top: 120, width: 500, height: 400 });
    events = [];
    emitAllMeasures();
    const rects = rectsFromLastAllRects();
    // b1's OWN mock rect was not consulted — the cached rect is shifted by
    // the section's delta.
    expect(rects.get(':b1')?.left).toBe(OFF_X + 20 + 40);
    expect(rects.get(':b1')?.top).toBe(20 + 120);
  });

  it('idle full pass re-measures skipped sections (staleness heal)', () => {
    emitAllMeasures(); // prime
    emitAllMeasures(); // skipping pass → schedules the idle full pass
    const calls = gbcrCalls.get(b1)!;
    events = [];
    vi.advanceTimersByTime(450);
    expect(gbcrCalls.get(b1)!).toBeGreaterThan(calls); // measured again
    const rects = rectsFromLastAllRects();
    expect(rects.get(':b1')?.left).toBe(OFF_X + 20);
  });

  it('culled tiles still replay via the culled path (unchanged contract)', () => {
    emitAllMeasures(); // prime
    // Real culling sets BOTH data-culled AND display:none together
    // (CullingController.cull) — a genuinely culled root is display:none.
    tile.setAttribute('data-culled', 'true');
    (tile as HTMLElement).style.display = 'none';
    const tileCalls = gbcrCalls.get(a1)!;
    events = [];
    emitAllMeasures();
    const rects = rectsFromLastAllRects();
    expect(rects.get(':a1')?.left).toBe(20); // replayed from cache
    expect(gbcrCalls.get(a1)).toBe(tileCalls); // not re-measured
  });

  it('a data-culled root that is VISIBLE (stale attr) is measured LIVE, not replayed', () => {
    emitAllMeasures(); // prime cache with the real box (left 20)
    // Stale attribute: data-culled left on a node that is actually on-screen
    // (display NOT none) — a node culled offscreen then re-shown/reparented
    // whose attr never got cleared. It must be measured live so the hit-test
    // gets its REAL rect (else "visible but unhittable until page switch").
    tile.setAttribute('data-culled', 'true'); // but style.display stays visible
    boxes.set(a1, { left: 999, top: 5, width: 100, height: 40 }); // node actually moved
    const tileCalls = gbcrCalls.get(a1)!;
    events = [];
    emitAllMeasures();
    const rects = rectsFromLastAllRects();
    expect(rects.get(':a1')?.left).toBe(999); // LIVE rect, not the stale 20
    expect(gbcrCalls.get(a1)!).toBeGreaterThan(tileCalls); // re-measured
  });
});

// ─── clearMeasureReplayCache — file switches drop remembered geometry ───────
// Node ids collide across files (`root`/`mobile-root` exist in every page AND
// every LayoutClient), so a file-switch render must not replay the previous
// file's measures onto the new file's nodes. Live symptom: entering a template
// from a long page selected the template's mobile viewport with the PAGE's
// ~14,000px-tall replayed rect until a pan forced a real measure (2026-07-27).
describe('clearMeasureReplayCache', () => {
  let root: HTMLElement;
  let tile: HTMLElement;
  let secB: HTMLElement; let b1: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    postSpy = vi.spyOn(window, 'postMessage').mockImplementation(((msg: any) => { events.push(msg); }) as any);
    document.body.innerHTML = '';
    boxes.clear(); gbcrCalls.clear();
    root = document.createElement('div');
    document.body.appendChild(root);
    setContentRoot(root);
    tile = el('div', 'root', 'root', { left: 0, top: 0, width: 1440, height: 4000 });
    tile.setAttribute('data-viewport', 'desktop');
    root.appendChild(tile);
    secB = el('div', 'secB', 'secB', { left: OFF_X, top: 0, width: 500, height: 400 });
    b1 = el('div', 'b1', 'b1', { left: OFF_X + 20, top: 20, width: 100, height: 50 });
    secB.appendChild(b1);
    tile.appendChild(secB);
  });

  afterEach(() => { postSpy.mockRestore(); vi.useRealTimers(); });

  it('after the clear, an offscreen section is MEASURED live, never replayed', () => {
    emitAllMeasures(); // prime the replay cache (the "previous file")
    const primed = gbcrCalls.get(b1)!;
    // Sanity: a second pass would replay (no new measure).
    emitAllMeasures();
    expect(gbcrCalls.get(b1)).toBe(primed);

    // FILE SWITCH: same ids, different file — the stale cache must go.
    clearMeasureReplayCache();
    // The "new file's" geometry differs; without the clear, the replay would
    // have served the OLD rect.
    boxes.set(b1, { left: OFF_X + 20, top: 20, width: 100, height: 9999 });
    events = [];
    emitAllMeasures();
    expect(gbcrCalls.get(b1)).toBeGreaterThan(primed);          // measured live
    expect(rectsFromLastAllRects().get(':b1')?.height).toBe(9999); // fresh value
  });
});
