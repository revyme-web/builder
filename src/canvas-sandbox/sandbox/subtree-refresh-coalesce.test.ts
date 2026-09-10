// subtree-refresh-coalesce.test.ts — one refresh per frame per scope.
//
// A committed style batch patches each node separately, and the refresh scope
// is the patched element's PARENT. Reordering a page's root sections writes
// `order` to every sibling, so 8 patches asked for 8 refreshes of the SAME
// parent — and for root sections that parent is the whole page. Measured on a
// real 633-element page (2026-09-09): 8 × 590 descendants ≈ 9,400 rect/corner
// messages, ~250ms, which is why the layers panel, the selection outline and
// the replica tiles settled about a second after the DOM had already moved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleSubtreeRefresh, clearPendingSubtreeRefresh } from './rect-emit';
import * as dndHost from '../sandbox-dnd-host';

/** Wait past the scheduler's coalescing window and let its work run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 80));

function tree(sections: number, perSection: number) {
  const root = document.createElement('div');
  root.setAttribute('data-node-id', 'root');
  root.setAttribute('data-id', 'root');
  const scopes: HTMLElement[] = [];
  for (let s = 0; s < sections; s++) {
    const sec = document.createElement('div');
    sec.setAttribute('data-node-id', `sec-${s}`);
    sec.setAttribute('data-id', `sec-${s}`);
    for (let i = 0; i < perSection; i++) {
      const kid = document.createElement('div');
      kid.setAttribute('data-node-id', `sec-${s}-kid-${i}`);
      kid.setAttribute('data-id', `sec-${s}-kid-${i}`);
      sec.appendChild(kid);
    }
    root.appendChild(sec);
    scopes.push(sec);
  }
  document.body.appendChild(root);
  return { root, scopes };
}

describe('scheduleSubtreeRefresh', () => {
  beforeEach(() => { clearPendingSubtreeRefresh(); document.body.innerHTML = ''; });
  afterEach(() => { clearPendingSubtreeRefresh(); vi.restoreAllMocks(); });

  it('runs ONE walk when every patch in a batch shares the same scope', async () => {
    const { root } = tree(8, 4);            // 8 sections, small enough to stay per-element
    const emit = vi.fn();
    for (let i = 0; i < 8; i++) scheduleSubtreeRefresh(root, emit);   // the reorder shape
    await settle();
    // 41 elements: the scope itself + its 40 descendants, each emitted once.
    // Eight queued requests, one walk — before coalescing this was 8 × 41.
    const rectEvents = emit.mock.calls.filter((c) => c[0]?.type === 'rectUpdate').length;
    expect(rectEvents).toBe(41);
  });

  it('drops a scope nested inside another queued scope', async () => {
    const { root, scopes } = tree(2, 3);
    const emit = vi.fn();
    scheduleSubtreeRefresh(scopes[0], emit);   // inner
    scheduleSubtreeRefresh(root, emit);        // outer covers it
    await settle();
    const ids = emit.mock.calls.filter((c) => c[0]?.type === 'rectUpdate').map((c) => c[0].nodeId);
    // Each element appears at most twice (the scope's own double-emit), never
    // once per queued scope.
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it('hands a PAGE-sized scope to the batched sweep instead of per-element messages', async () => {
    // Not just cheaper — the per-element walk has no culled-tile gate, so
    // walking an offscreen (`display:none`) viewport tile emits all-ZERO rects
    // that the host stores verbatim and whose zero-centre corners pass its 8px
    // stale check. The batched pass replays the whole tile instead.
    const { root } = tree(8, 40);           // 329 elements — over the budget
    const emit = vi.fn();
    for (let i = 0; i < 8; i++) scheduleSubtreeRefresh(root, emit);
    await settle();
    // Nothing goes out one element at a time; the all-rects funnel ships it.
    expect(emit).not.toHaveBeenCalled();
  });

  it('DEFERS past a gesture that started after the patch, then lands', async () => {
    // The caller's drag gate is tested at patch time; a gesture can start
    // inside the coalescing window (DragCoordinator.startDrag patches `order`
    // via onStart BEFORE it sets the interacting flag). Running then would race
    // the drag's own imperative cache writes.
    const { root } = tree(4, 3);            // 17 elements — under the batch budget
    const emit = vi.fn();
    const spy = vi.spyOn(dndHost, 'isSandboxDndInteracting').mockReturnValue(true);
    scheduleSubtreeRefresh(root, emit);
    await settle();
    expect(emit).not.toHaveBeenCalled();    // held, not dropped
    spy.mockReturnValue(false);             // gesture ends
    await settle();
    const rectEvents = emit.mock.calls.filter((c) => c[0]?.type === 'rectUpdate').length;
    expect(rectEvents).toBe(17);            // the owed walk lands
  });

  it('coalesces requests that arrive in different frames (one reorder = two patch batches)', async () => {
    const { root } = tree(8, 4);
    const emit = vi.fn();
    scheduleSubtreeRefresh(root, emit);                       // inline `order` writes
    await new Promise((r) => setTimeout(r, 20));              // next frame
    scheduleSubtreeRefresh(root, emit);                       // replica band writes
    await settle();
    const rectEvents = emit.mock.calls.filter((c) => c[0]?.type === 'rectUpdate').length;
    expect(rectEvents).toBe(41);                              // still ONE walk, not two
  });

  it('a disconnected scope is skipped', async () => {
    const { root, scopes } = tree(2, 2);
    const emit = vi.fn();
    scopes[0].remove();
    scheduleSubtreeRefresh(scopes[0], emit);
    await settle();
    expect(emit).not.toHaveBeenCalled();
    root.remove();
  });
});
