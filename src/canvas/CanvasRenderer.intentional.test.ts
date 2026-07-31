// CanvasRenderer render-guard invariants — the centralized "Cmd+Z always
// re-renders the DOM" guarantee (live find 2026-07-21, stale lineHeight):
//  1. a canvasUpdating skip INVALIDATES the dedup baseline (the DOM has
//     imperatively diverged from lastForwarded, so nothing may dedup
//     against it), and
//  2. an INTENTIONAL render (undo/redo restore) is immune to both the
//     canvasUpdating skip and the duplicate-forward dedup.
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
vi.mock('@/canvas/transform', () => ({ transformManager: { getTransform: () => ({ x: 0, y: 0, scale: 1 }) } }));

import { CanvasRenderer, type RenderInput } from './CanvasRenderer';

function makeRenderer() {
  const r = new CanvasRenderer() as any;
  const renders: unknown[] = [];
  r.bridge = { render: (...args: unknown[]) => { renders.push(args); } };
  r.sandboxReady = true;
  return { r: r as CanvasRenderer, renders };
}
const input = (code: string): RenderInput => ({
  nodes: new Map(), viewports: [], code, css: '', globalsCss: '',
} as unknown as RenderInput);

describe('CanvasRenderer intentional-render invariants', () => {
  it('undo right after a skipped commit render still forwards (baseline invalidated)', () => {
    const { r, renders } = makeRenderer();
    const stateA = input('A');
    r.render(stateA);                        // forwarded — baseline = A
    expect(renders.length).toBe(1);
    r.markCanvasUpdate();
    r.render(input('B'));                    // commit render — skipped by design
    expect(renders.length).toBe(1);
    r.render(stateA);                        // undo back to A — MUST forward
    expect(renders.length).toBe(2);          // (old bug: dedup ate it)
  });

  it('intentional render consumes a leftover canvasUpdating mark instead of dying to it', () => {
    const { r, renders } = makeRenderer();
    r.markCanvasUpdate();                    // unbalanced mark from any path
    r.render(input('A'), { intentional: true });
    expect(renders.length).toBe(1);
    r.render(input('C'));                    // and the mark is consumed — next normal render runs
    expect(renders.length).toBe(2);
  });

  it('intentional render bypasses duplicate-forward dedup', () => {
    const { r, renders } = makeRenderer();
    const stateA = input('A');
    r.render(stateA);
    r.render(stateA, { intentional: true }); // same input — still forwards
    expect(renders.length).toBe(2);
  });

  it('normal renders still dedup identical input', () => {
    const { r, renders } = makeRenderer();
    const stateA = input('A');
    r.render(stateA);
    r.render(stateA);
    expect(renders.length).toBe(1);
  });
});

// The two-flush drop race (live find 2026-07-24): a toolbar drop into a parent
// with explicit `order:N` siblings runs the addNode flush (structuralPending
// true → no mark), then the order-renumber STYLE flush marks canvasUpdating —
// and the ONE React render carrying BOTH changes got eaten. The dropped node
// existed in code/layers but not in the canvas DOM until a page switch.
describe('CanvasRenderer structural-render-owed latch', () => {
  it('a mark set AFTER a structural commit cannot eat the structural render', () => {
    const { r, renders } = makeRenderer();
    r.render(input('A'));                    // baseline
    expect(renders.length).toBe(1);
    // Drop commit: add branch sets structuralPending true → flush → clears it.
    r.setStructuralPending(true);
    r.setStructuralPending(false);
    r.markCanvasUpdate();                    // order-renumber style flush marks
    r.render(input('B'));                    // the render with the new node
    expect(renders.length).toBe(2);          // MUST forward (old bug: skipped)
  });

  it('a mark set BEFORE the structural commit cannot eat it either', () => {
    const { r, renders } = makeRenderer();
    r.render(input('A'));
    r.markCanvasUpdate();                    // stale mark from an earlier style write
    r.setStructuralPending(true);
    r.setStructuralPending(false);
    r.render(input('B'));
    expect(renders.length).toBe(2);
  });

  it('latch clears once the owed render forwards — later marks skip normally', () => {
    const { r, renders } = makeRenderer();
    r.setStructuralPending(true);
    r.setStructuralPending(false);
    r.render(input('A'));                    // owed render forwards, latch clears
    expect(renders.length).toBe(1);
    r.markCanvasUpdate();
    r.render(input('B'));                    // plain style commit — skipped by design
    expect(renders.length).toBe(1);
  });

  it('forceRender also satisfies the owed latch', () => {
    const { r, renders } = makeRenderer();
    r.setStructuralPending(true);
    r.setStructuralPending(false);
    r.forceRender(input('A'));
    expect(renders.length).toBe(1);
    r.markCanvasUpdate();
    r.render(input('B'));                    // latch cleared — mark works again
    expect(renders.length).toBe(1);
  });

  it('without a structural commit, mark/skip behavior is unchanged', () => {
    const { r, renders } = makeRenderer();
    r.render(input('A'));
    r.markCanvasUpdate();
    r.render(input('B'));
    expect(renders.length).toBe(1);          // skipped, as designed
  });
});

describe('forceRender — a DROP is observable, a SHIP is confirmed', () => {
  // The file-switch path keys "did this file reach the iframe" off the return
  // value. Before it existed, a forceRender dropped mid-sandbox-rebuild was
  // treated as delivered — prevRenderedFilePathRef advanced, every later
  // effect run took the skippable path, and the iframe stayed on the PREVIOUS
  // file's DOM indefinitely. Live repro: create a template right after an
  // undo → the template editor rendered the full landing page (2026-07-27).
  it('returns false when the sandbox is not ready (nothing forwarded)', () => {
    const { r, renders } = makeRenderer();
    (r as any).sandboxReady = false;
    expect(r.forceRender(input('T'))).toBe(false);
    expect(renders.length).toBe(0);
  });

  it('returns false when there is no bridge', () => {
    const { r, renders } = makeRenderer();
    (r as any).bridge = null;
    expect(r.forceRender(input('T'))).toBe(false);
    expect(renders.length).toBe(0);
  });

  it('returns true when it ships — and the retry-after-ready flow delivers the file', () => {
    const { r, renders } = makeRenderer();
    (r as any).sandboxReady = false;
    expect(r.forceRender(input('template'))).toBe(false);   // dropped: ref must stay stale
    (r as any).sandboxReady = true;                          // ready flip re-runs the effect…
    expect(r.forceRender(input('template'))).toBe(true);     // …and the retry ships
    expect(renders.length).toBe(1);
  });
});
