// A finished render can read as "stale" when the project version moved on a
// bump that changed nothing on canvas (every tool result refreshes panels).
// settleObservation re-measures and waits for a FRESH epoch, so audit_design
// stops reporting "stale" over the agent's own, already-rendered edit.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ now: 5, atFill: 4, remeasured: 0 }));

vi.mock('@/canvas/canvas-bridge', async (orig) => {
  const real = await orig<typeof import('@/canvas/canvas-bridge')>();
  const bridge = {
    getCacheEpoch: () => ({ renderSeq: 1, projectVersion: state.atFill }),
    // The canvas answers a re-measure with a fill stamped at the version NOW.
    forceRemeasureAllRects: () => { state.remeasured++; setTimeout(() => { state.atFill = state.now; }, 150); },
  };
  return { ...real, getCanvasBridge: () => bridge, readProjectVersion: () => state.now };
});
vi.mock('@/code/stores/store', () => ({ getNodesSnapshot: vi.fn(() => new Map()) }));
vi.mock('./design-audit', () => ({ collectLayoutSnapshot: vi.fn(() => [{ id: 'hero', rect: { x: 0, y: 0, width: 10, height: 10 } }]) }));

import { waitForRender, settleObservation } from './wait-for-render';
import { collectEpochSnapshot } from './observation-epoch';

beforeEach(() => { state.now = 5; state.atFill = 4; state.remeasured = 0; });

describe('fresh measurements', () => {
  it('waitForRender without `fresh` is "ready" on stale rects at once — the old trap', async () => {
    const r = await waitForRender({ vpId: 'desktop', timeoutMs: 500, intervalMs: 50 });
    expect(r.ready).toBe(true);
    expect(r.epoch.stale).toBe(true);
  });

  it('with `fresh` it waits for a current epoch (and gives up as pending if none comes)', async () => {
    const r = await waitForRender({ vpId: 'desktop', timeoutMs: 300, intervalMs: 50, fresh: true });
    expect(r.ready).toBe(false);
    expect(r.status).toBe('pending');
  });

  it('settleObservation re-measures a stale viewport and returns once the measurement is fresh', async () => {
    expect(collectEpochSnapshot(new Map(), 'desktop').epoch.stale).toBe(true);
    await settleObservation({ vpId: 'desktop' });
    expect(state.remeasured).toBe(1);
    expect(collectEpochSnapshot(new Map(), 'desktop').epoch.stale).toBe(false);
  });

  it('a fresh viewport is not re-measured', async () => {
    state.atFill = state.now;
    await settleObservation({ vpId: 'desktop' });
    expect(state.remeasured).toBe(0);
  });
});
