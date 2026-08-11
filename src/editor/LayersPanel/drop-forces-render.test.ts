// drop-forces-render.test.ts — a Layers-panel drop must FORCE a canvas render.
//
// Unlike a canvas drag, the layers panel never patches the DOM imperatively: it
// only queues mutations. The render-skip the canvas path depends on (it patched
// already, so skipping is correct) therefore left a layers reorder invisible —
// the code was right but the canvas stayed stale until a page switch or reload
// rebuilt it. `move`/`reorder` are structural, so they aren't in the
// render-resolved set `onBeforeFlush` consults either. Live find 2026-07-25.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import { startLayerDrag, type LayerDragContext, type DropIndicator } from './drag';
import type { CanvasNode } from '@/code/parsing/parser';

const mockQueueMutation = vi.fn();
const mockForceRender = vi.fn();

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (...a: unknown[]) => mockQueueMutation(...a),
  flushNow: vi.fn(),
}));
vi.mock('@/canvas/node-ops', () => ({
  getContentRoot: () => document.createElement('div'),
  isPrimaryViewport: (vp: string) => vp === 'desktop',
  findChildRects: () => [],
  findNodeComputedStyle: () => '',
  // Destination frame 400x300, dragged node 160x32 → centred at 120,134.
  findNodeComputedStyles: (id: string) => id === 'b'
    ? { width: '160px', height: '32px' }
    : { width: '400px', height: '300px' },
  forceRenderAfterExternalEdit: (...a: unknown[]) => mockForceRender(...a),
}));
vi.mock('@/canvas/drag/reparent-utils', () => ({
  computeReorderAssignments: () => [],
  computeReplicaOrderMirrorUpdates: () => [],
  flexForFlowChildEnteringFlex: () => ({}),
}));
vi.mock('@/canvas/drag/strategies/order-commit', () => ({ commitOrderAssignments: () => [] }));
vi.mock('@/canvas/drag/replica-context', () => ({ getReplicaContext: () => ({ hideInAllOthers: () => [] }) }));
vi.mock('@/canvas/creators/creator-utils', () => ({ queueReplicaCreationUnhide: vi.fn() }));
// 'none' layout → the CSS-`order` pipeline is skipped, leaving the pure
// structural path this test is about.
vi.mock('@/canvas/drag/types', () => ({
  detectParentLayoutById: () => 'none',
  getFlexDirectionById: () => 'column',
}));
vi.mock('@/canvas/arrow-nudge', () => ({ queuePendingUpdates: vi.fn() }));

function node(id: string, children: string[] = [], parentId: string | null = null): CanvasNode {
  return {
    id, type: 'div', name: id, parentId, children, styles: {}, attrs: {},
    textContent: '', hasMixedContent: false, order: 0, isCanvasNode: false,
  } as unknown as CanvasNode;
}
const ref = <T,>(v: T): MutableRefObject<T> => ({ current: v });

function makeCtx(indicator: DropIndicator, draggedId: string): LayerDragContext {
  return {
    nodes: new Map([
      ['parent', node('parent', ['a', 'b'])],
      ['a', node('a', [], 'parent')],
      ['b', node('b', [], 'parent')],
    ]),
    isCompMode: false,
    vpWidths: { desktop: 1440 },
    vpConfigs: [{ id: 'desktop', width: 1440, isPrimary: true }],
    activeFilePath: 'app/page.tsx',
    dragStartPos: ref<{ x: number; y: number } | null>({ x: 0, y: 0 }),
    dragThresholdMet: ref(true),
    activeIdRef: ref<string | null>(draggedId),
    activeLayerIdRef: ref<string | null>(`desktop:${draggedId}`),
    dropIndicatorRef: ref<DropIndicator | null>(indicator),
    setActiveId: vi.fn(), setActiveLayerId: vi.fn(), setDropIndicator: vi.fn(),
  };
}

/** Begin a drag then release — the mouseup handler reads the refs directly, so
 *  the pointer-move phase doesn't need simulating. */
function dragAndDrop(ctx: LayerDragContext, draggedId: string): void {
  const down = { button: 0, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} } as unknown as ReactMouseEvent;
  startLayerDrag(ctx, down, `desktop:${draggedId}`, draggedId);
  // startLayerDrag may reset the refs on mousedown — restore the drop state.
  ctx.activeIdRef.current = draggedId;
  ctx.dragThresholdMet.current = true;
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('Layers-panel drop', () => {
  beforeEach(() => {
    mockQueueMutation.mockClear();
    mockForceRender.mockClear();
  });

  it('forces a canvas render after a same-parent reorder', () => {
    const ctx = makeCtx({ layerId: 'desktop:a', nodeId: 'a', position: 'before', depth: 1 }, 'b');
    dragAndDrop(ctx, 'b');

    expect(mockQueueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reorder', nodeId: 'b', parentId: 'parent' }),
    );
    // …and the render is forced, or the canvas stays stale until a reload.
    expect(mockForceRender).toHaveBeenCalled();
    expect(mockForceRender.mock.calls[0][0]).toBe('layers-panel:drop');
  });

  it('forces a canvas render after a re-parent (drop inside)', () => {
    const ctx = makeCtx({ layerId: 'desktop:a', nodeId: 'a', position: 'inside', depth: 1 }, 'b');
    dragAndDrop(ctx, 'b');

    expect(mockQueueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'move', nodeId: 'b', newParentId: 'a' }),
    );
    expect(mockForceRender).toHaveBeenCalled();
  });

  it('drops into a NO-LAYOUT frame as absolute, centred', () => {
    // `detectParentLayoutById` is mocked to 'none' — a frame with neither flex
    // nor grid positions its children by PINS, so a `relative` child there has no
    // anchors and stacks at the parent's top-left instead of where it was
    // dropped. This ran only for canvas-sourced drags before, so a TREE→TREE drop
    // kept `position: relative` (live find 2026-07-25).
    const ctx = makeCtx({ layerId: 'desktop:a', nodeId: 'a', position: 'inside', depth: 1 }, 'b');
    dragAndDrop(ctx, 'b');

    const move = mockQueueMutation.mock.calls
      .map((c) => c[0])
      .find((m: { type: string }) => m.type === 'move');
    expect(move.styles).toMatchObject({
      position: 'absolute',
      left: '120px',  // (400 - 160) / 2
      top: '134px',   // (300 - 32)  / 2
      right: '',      // stale opposite anchors cleared, or the node stretches
      bottom: '',
    });
  });

  it('leaves a FLEX destination as a flow child (no absolute pinning)', async () => {
    vi.resetModules();
    vi.doMock('@/canvas/drag/types', () => ({
      detectParentLayoutById: () => 'flex',
      getFlexDirectionById: () => 'column',
    }));
    const { startLayerDrag: startFlex } = await import('./drag');
    const ctx = makeCtx({ layerId: 'desktop:a', nodeId: 'a', position: 'inside', depth: 1 }, 'b');
    const down = { button: 0, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} } as unknown as ReactMouseEvent;
    startFlex(ctx, down, 'desktop:b', 'b');
    ctx.activeIdRef.current = 'b';
    ctx.dragThresholdMet.current = true;
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const move = mockQueueMutation.mock.calls
      .map((c) => c[0])
      .find((m: { type: string }) => m.type === 'move');
    expect(move?.styles?.position).not.toBe('absolute');
    vi.doUnmock('@/canvas/drag/types');
  });

  it('does NOT force a render when the drop was a no-op (no indicator)', () => {
    const ctx = makeCtx({ layerId: 'desktop:a', nodeId: 'a', position: 'before', depth: 1 }, 'b');
    ctx.dropIndicatorRef.current = null;
    dragAndDrop(ctx, 'b');

    expect(mockQueueMutation).not.toHaveBeenCalled();
    expect(mockForceRender).not.toHaveBeenCalled();
  });
});
