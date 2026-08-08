// deferred-drag-flush.structural.test.ts — a mid-drag flush that carries a
// STRUCTURAL change must reach the canvas immediately instead of being stashed.
//
// Style-only drag flushes are stashed by design (the DOM is already patched
// imperatively, so applying is a visual no-op that costs a parse). But an
// ALT-DUPLICATE adds a NEW node mid-drag and asks to paint now via
// setForceRender() + flushNow() + forceCanvasRender(). Stashing that flush meant
// the new code never reached the nodes atom, so the forced render re-painted the
// PRE-duplicate tree — the duplicate lived in source but stayed invisible until
// an unrelated later edit drained the stash ("no duplicate… then I create
// another node and suddenly it appears", 2026-08-08).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
const forcePending = { value: false };
vi.mock('@/code/mutation/mutation-queue', () => ({
  isForceRenderPending: () => forcePending.value,
}));

import { createDeferredDragFlush } from './deferred-drag-flush';

const setup = (dragging: boolean) => {
  const applied: string[] = [];
  const d = createDeferredDragFlush({
    isDragging: () => dragging,
    apply: (code: string) => { applied.push(code); },
  });
  return { d, applied };
};

beforeEach(() => { forcePending.value = false; });

describe('deferred drag flush — structural bypass', () => {
  it('stashes a style-only flush during a drag (unchanged behaviour)', () => {
    const { d, applied } = setup(true);
    d.onFlush('code-A');
    expect(applied).toEqual([]);
  });

  it('APPLIES a mid-drag flush when a force-render is pending (alt-duplicate)', () => {
    forcePending.value = true;
    const { d, applied } = setup(true);
    d.onFlush('code-with-duplicate');
    expect(applied).toEqual(['code-with-duplicate']);
  });

  it('applies normally when not dragging', () => {
    const { d, applied } = setup(false);
    d.onFlush('code-B');
    expect(applied).toEqual(['code-B']);
  });

  it('bypasses when the flag was already CONSUMED by this flush (latch window)', () => {
    // The flush consumes the flag while deciding render-skip, before onFlush
    // subscribers run — isForceRenderPending() must still report true here or
    // the structural flush gets stashed anyway (2026-08-08 regression).
    forcePending.value = true;   // mock stands in for "pending OR this-flush latch"
    const { d, applied } = setup(true);
    d.onFlush('post-consume');
    expect(applied).toEqual(['post-consume']);
  });

  it('a bypassed structural flush leaves no stale stash behind', () => {
    forcePending.value = true;
    const { d, applied } = setup(true);
    d.onFlush('structural');
    d.onDragEnd();                       // nothing pending → no re-apply
    expect(applied).toEqual(['structural']);
  });
});
