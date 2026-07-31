import { describe, it, expect, vi, beforeEach } from 'vitest';

// Call-order log shared by all mocks — the whole point of exit-commit.ts is
// that the statement ORDER is preserved (SelectionOverlay un-hide race).
const calls: Array<{ fn: string; args: any[] }> = [];

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn((m: any) => calls.push({ fn: 'queueMutation', args: [m] })),
  flushNowDeferredDuringDrag: vi.fn(() => calls.push({ fn: 'flushNowDeferredDuringDrag', args: [] })),
  flushNow: vi.fn(() => calls.push({ fn: 'flushNow', args: [] })),
}));
vi.mock('@/code/stores/store', () => ({
  moveNodeInCache: vi.fn((...args: any[]) => calls.push({ fn: 'moveNodeInCache', args })),
  updateNodeInCache: vi.fn((...args: any[]) => calls.push({ fn: 'updateNodeInCache', args })),
}));
vi.mock('@/canvas/node-ops', () => ({
  patchNodeStyles: vi.fn((...args: any[]) => calls.push({ fn: 'patchNodeStyles', args })),
  forceCanvasRender: vi.fn(() => calls.push({ fn: 'forceCanvasRender', args: [] })),
  // Mid-drag transition sites render via the DEFERRED variant (redundant
  // mid-drag; reconciled by the drop render).
  forceCanvasRenderDeferredDuringDrag: vi.fn(() => calls.push({ fn: 'forceCanvasRenderDeferredDuringDrag', args: [] })),
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => ({
    reparentLive: (...args: any[]) => calls.push({ fn: 'reparentLive', args }),
  }),
}));

import { commitExitToCanvas, flushExitToCanvas } from './exit-commit';

const contentEl = {} as HTMLElement;

beforeEach(() => { calls.length = 0; });

describe('commitExitToCanvas — statement order', () => {
  it('queues clearContainerStyles before the canvas-root move', () => {
    commitExitToCanvas({ nodeId: 'n1', styles: { left: '10px' } });
    expect(calls.map(c => c.fn)).toEqual([
      'queueMutation', 'queueMutation', 'moveNodeInCache', 'updateNodeInCache',
    ]);
    expect(calls[0].args[0]).toEqual({ type: 'clearContainerStyles', nodeId: 'n1' });
    expect(calls[1].args[0]).toMatchObject({
      type: 'move', nodeId: 'n1', newParentId: null, canvasNode: true, styles: { left: '10px' },
    });
    // Cache sync: reparent to canvas root + committed styles.
    expect(calls[2].args).toEqual(['n1', null]);
    expect(calls[3].args).toEqual(['n1', { left: '10px' }]);
  });

  it('passes sourceVariant + sourceVpWidth through to the move mutation', () => {
    commitExitToCanvas({ nodeId: 'n1', styles: {}, sourceVariant: 'variant-1', sourceVpWidth: 768 });
    expect(calls[1].args[0]).toMatchObject({ type: 'move', sourceVariant: 'variant-1', sourceVpWidth: 768 });
  });

  it("re-homes imperatively + patches BEFORE the cache sync in 'before-cache' mode (Canvas/AbsInFrame ordering)", () => {
    commitExitToCanvas({
      nodeId: 'n1', styles: { left: '1px' },
      patch: { contentEl, vpPrefix: 'tablet-', styles: { transform: '' }, when: 'before-cache' },
    });
    expect(calls.map(c => c.fn)).toEqual([
      'queueMutation', 'queueMutation', 'reparentLive', 'patchNodeStyles', 'moveNodeInCache', 'updateNodeInCache',
    ]);
    // Imperative re-home to canvas root (drag-locked renders skip the node,
    // so the flush-render can't do the DOM move anymore): exit styles merged
    // with the patch styles, null parent = lift to content root.
    expect(calls[2].args).toEqual(['n1', 'tablet-', null, 0, { left: '1px', transform: '' }]);
    expect(calls[3].args).toEqual([contentEl, 'n1', 'tablet-', { transform: '' }]);
  });

  it("re-homes imperatively AND patches AFTER the cache sync in 'after-cache' mode (LayoutLifted drop ordering)", () => {
    commitExitToCanvas({
      nodeId: 'n1', styles: { left: '1px' },
      patch: { contentEl, vpPrefix: '', styles: { left: '1px' }, when: 'after-cache' },
    });
    // The drop-time exit used to rely on the drag-end drain's SYNCHRONOUS
    // setCode -> render to move the element out of its old parent. With the
    // drag-end fan-out deferred, the mouseup frame paints immediately — so
    // the after-cache path must reparentLive too, or the node visibly snaps
    // back into its old flex slot until the deferred render lands.
    expect(calls.map(c => c.fn)).toEqual([
      'queueMutation', 'queueMutation', 'moveNodeInCache', 'updateNodeInCache', 'reparentLive', 'patchNodeStyles',
    ]);
    const rep = calls.find(c => c.fn === 'reparentLive')!;
    expect(rep.args).toEqual(['n1', '', null, 0, { left: '1px' }]);
  });

  it('queues extraMutations right after the move (AbsInFrame data-pinned clear)', () => {
    commitExitToCanvas({
      nodeId: 'n1', styles: {},
      extraMutations: [{ type: 'updateHtmlAttrs', nodeId: 'n1', attrs: { 'data-pinned': '' } } as any],
      patch: { contentEl, vpPrefix: '', styles: { transform: '' }, when: 'before-cache' },
    });
    expect(calls.map(c => c.fn)).toEqual([
      'queueMutation', 'queueMutation', 'queueMutation', 'reparentLive', 'patchNodeStyles', 'moveNodeInCache', 'updateNodeInCache',
    ]);
    expect(calls[2].args[0]).toMatchObject({ type: 'updateHtmlAttrs', nodeId: 'n1' });
  });
});

describe('flushExitToCanvas', () => {
  it('requests the drag-deferred flush + re-render (drop drains in one chain)', () => {
    flushExitToCanvas();
    expect(calls.map(c => c.fn)).toEqual(['flushNowDeferredDuringDrag', 'forceCanvasRenderDeferredDuringDrag']);
  });
});
