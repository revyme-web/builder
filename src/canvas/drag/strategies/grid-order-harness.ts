// grid-order-harness.ts — shared mock rig for GridDragStrategy order-mode
// tests. A 4×2 grid of 100×100 cells (20px gaps) at scale 1, children c-0..c-7
// (the dragged one is 'dragged' at visual slot 2). Cell (col,row) screen rect:
// left = 10 + col*120, top = 10 + row*120.
import { vi } from 'vitest';
import type { DragContext } from '../types';
import type { Transform } from '@/shared/types';

export interface GridHarness {
  context: DragContext;
  createdPlaceholders: Array<{ id: string; styles: Record<string, string> }>;
  placeholderPatches: Array<{ id: string; styles: Record<string, string> }>;
  swapTwoElementsCalls: unknown[][];
  patchedStyles: Array<{ nodeId: string; styles: Record<string, string> }>;
}

export async function onePassMocks(opts: { withOrders?: boolean; childSize?: { width: string; height: string } } = {}): Promise<GridHarness> {
  const withOrders = opts.withOrders !== false;
  const nodeOps = await import('@/canvas/node-ops');
  const bridgeMod = await import('@/canvas/canvas-bridge');
  const resolver = await import('./grid-cell-resolver');

  const ids = ['c-0', 'c-1', 'dragged', 'c-3', 'c-4', 'c-5', 'c-6', 'c-7'];
  const rectOf = (i: number) =>
    new DOMRect(10 + (i % 4) * 120, 10 + Math.floor(i / 4) * 120, 100, 100);

  const createdPlaceholders: GridHarness['createdPlaceholders'] = [];
  const placeholderPatches: GridHarness['placeholderPatches'] = [];
  const swapTwoElementsCalls: unknown[][] = [];
  const patchedStyles: GridHarness['patchedStyles'] = [];

  vi.mocked(nodeOps.findChildRects).mockReturnValue(ids.map((id, i) => ({ id, rect: rectOf(i) })));
  vi.mocked(nodeOps.findNodeRect).mockImplementation(((id: string) => {
    if (id === 'grid-parent') return new DOMRect(0, 0, 500, 260);
    if (id === 'viewport-root') return new DOMRect(0, 0, 1000, 800);
    const i = ids.indexOf(id);
    return i >= 0 ? rectOf(i) : null;
  }) as any);
  vi.mocked(nodeOps.findNodeComputedStyles).mockImplementation(((_id: string, _vp: string, props: string[]) => {
    const out: Record<string, string> = {};
    for (const p of props) {
      if (p === 'width' || p === 'height') out[p] = '100';
      if (p === 'columnGap' || p === 'rowGap') out[p] = '20';
    }
    return out;
  }) as any);
  vi.mocked(nodeOps.patchNodeStyles).mockImplementation(((_el: any, nodeId: string, _pfx: string, styles: Record<string, string>) => {
    patchedStyles.push({ nodeId, styles });
  }) as any);
  void bridgeMod; // the test file's vi.mock delegates to this global holder:
  (globalThis as any).__gridTestBridge = ({
    liftNode: vi.fn(),
    restoreNode: vi.fn(),
    createPlaceholder: (id: string, _p: string, _pfx: string, _d: string, styles: Record<string, string>) =>
      createdPlaceholders.push({ id, styles }),
    patchPlaceholderStyles: (id: string, _pfx: string, styles: Record<string, string>) =>
      placeholderPatches.push({ id, styles }),
    removePlaceholders: vi.fn(),
    swapTwoElements: (...a: unknown[]) => swapTwoElementsCalls.push(a),
    setDragLockedNodeIds: vi.fn(),
    prefetchChildRects: vi.fn(),
  });
  vi.mocked(resolver.parseGridInfo).mockReturnValue({
    hasExplicitPlacement: false,
    itemPlacements: new Map(),
  } as any);

  const nodes = new Map<string, any>([
    ['grid-parent', { id: 'grid-parent', parentId: 'viewport-root', styles: { display: 'grid' }, children: ids }],
    ['viewport-root', { id: 'viewport-root', parentId: null, styles: {}, children: ['grid-parent'] }],
    ...ids.map((id, i): [string, any] => [id, {
      id, parentId: 'grid-parent',
      styles: {
        ...(withOrders ? { order: String(i) } : {}),
        ...(opts.childSize ?? {}),
        flex: '0 0 auto',
      },
      children: [],
    }]),
  ]);

  const transform: Transform = { x: 0, y: 0, scale: 1 };
  const context: DragContext = {
    draggedNodes: [{
      id: 'dragged', startParentId: 'grid-parent',
      startLeft: 0, startTop: 0, width: 100, height: 100,
      mouseOffsetX: 0, mouseOffsetY: 0,
    } as any],
    startMouse: { x: 300, y: 55 },
    transform,
    containerRect: { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    contentEl: document.createElement('div'),
    code: '', nodes, selectedIds: ['dragged'],
    modifiers: { alt: false, shift: false, ctrl: false },
    viewportPrefix: '',
  };

  return { context, createdPlaceholders, placeholderPatches, swapTwoElementsCalls, patchedStyles };
}
