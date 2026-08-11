// GridDragStrategy.test.ts — `canHandle` smoke + selection-precedence regression.
//
// The class-level algorithm (cell detection, swap math) is tested in
// `grid-cell-resolver.test.ts` where it lives as pure functions. These
// tests pin the `canHandle` contract so a refactor of
// `LayoutLiftedStrategy.canHandle` (which now bails on grid) can't
// accidentally re-route grid drags through the wrong strategy.

import { describe, test, expect, vi } from 'vitest';
import { GridDragStrategy } from './GridDragStrategy';
import type { DragContext } from '../types';
import type { DraggedNode, Transform } from '@/shared/types';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));
vi.mock('@/canvas/selection/drop-line-store', () => ({ dropLineOps: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('../reposition-signal', () => ({ repositionSignalOps: { signal: vi.fn() } }));
vi.mock('@/canvas/selection/parent-highlight-store', () => ({ parentHighlightOps: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(),
  findNodeComputedStyle: vi.fn(),
  findNodeComputedStyles: vi.fn(),
  findChildRects: vi.fn(() => []),
  patchNodeStyles: vi.fn(),
  getViewportPrefix: (vpId: string) => vpId === 'desktop' ? '' : vpId + '-',
  vpIdFromPrefix: (p: string) => !p ? 'desktop' : p.endsWith('-') ? p.slice(0, -1) : p,
  // commitOrderAssignments (the onEnd order re-stamp) reads these:
  isPrimaryViewport: (vpId: string) => vpId === 'desktop' || vpId === 'default',
  getActiveFilePath: () => (globalThis as any).__gridTestActiveFile ?? 'app/page.client.tsx',
}));
vi.mock('@/code/stores/viewport-store', () => ({ getViewportWidths: () => ({ desktop: 1440, tablet: 768 }) }));
vi.mock('@/code/stores/store', () => ({ getNodeFromCache: vi.fn(() => undefined) }));
// Delegates through a global holder so the order-mode harness can install a
// full fake bridge (vi.mock factories are hoisted — they can't be reassigned).
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => (globalThis as any).__gridTestBridge ?? {},
}));
vi.mock('./grid-cell-resolver', () => ({
  parseGridInfo: vi.fn(),
}));

function makeDraggedNode(o: Partial<DraggedNode> = {}): DraggedNode {
  return {
    id: 'node-1', startParentId: 'parent-1',
    startLeft: 0, startTop: 0, width: 100, height: 100,
    mouseOffsetX: 0, mouseOffsetY: 0, ...o,
  };
}

function makeContext(o: Partial<DragContext> = {}): DragContext {
  const transform: Transform = { x: 0, y: 0, scale: 1 };
  return {
    draggedNodes: [makeDraggedNode()],
    startMouse: { x: 0, y: 0 },
    transform,
    containerRect: { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    contentEl: document.createElement('div'),
    code: '',
    nodes: new Map(),
    selectedIds: ['node-1'],
    modifiers: { alt: false, shift: false, ctrl: false },
    viewportPrefix: '',
    ...o,
  };
}

describe('GridDragStrategy.canHandle', () => {
  const strategy = new GridDragStrategy();

  test('true when parent is display:grid', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'grid' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(true);
  });

  test('true when parent is display:inline-grid', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'inline-grid' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(true);
  });

  test('false when parent is flex', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(false);
  });

  test('false when parent is block', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'block' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(false);
  });

  test('false when own position is absolute (AbsoluteInFrameStrategy handles)', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'absolute' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'grid' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(false);
  });

  test('false when own position is fixed', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', styles: { position: 'fixed' } }],
      ['parent-1', { id: 'parent-1', styles: { display: 'grid' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(false);
  });

  test('false when node is a canvas node (CanvasDragStrategy handles)', () => {
    const nodes = new Map<string, any>([
      ['node-1', { id: 'node-1', isCanvasNode: true, styles: {} }],
      ['parent-1', { id: 'parent-1', styles: { display: 'grid' } }],
    ]);
    expect(strategy.canHandle(makeContext({ nodes }))).toBe(false);
  });

  test('false when no startParentId', () => {
    expect(strategy.canHandle(makeContext({
      draggedNodes: [makeDraggedNode({ startParentId: null })],
    }))).toBe(false);
  });
});

// ─── ORDER-STYLE grids — the 2026-07-27 reorder-does-nothing bug ────────────
//
// The builder stamps every grid child with an inline `order` (oracle rule),
// and CSS `order` BEATS DOM position in grid auto-flow. The strategy's
// DOM-swap + JSX-reorder model painted NOTHING mid-drag, the placeholder
// (order-less → slot 0) displaced the whole grid at lift, and the committed
// JSX reorder was visually reverted by the untouched order styles.
import { onePassMocks } from './grid-order-harness';

describe('GridDragStrategy — order-style grids', () => {
  test('full drag: placeholder pins the dragged cell, swap exchanges ORDERS, commit re-stamps sequentially', async () => {
    const h = await onePassMocks();
    const strategy = new GridDragStrategy();

    strategy.onStart(h.context);
    // 1. Placeholder carries the dragged item's order — the lift must not
    //    reflow the grid (order-less placeholder auto-flowed to slot 0).
    expect(h.createdPlaceholders[0]?.styles.order).toBe('2');

    // 2. Move over the sibling at order 5 → ORDER swap, not a DOM swap.
    strategy.onMove(h.context, { x: 180, y: 180 });
    expect(h.swapTwoElementsCalls.length).toBe(0);
    expect(h.patchedStyles.find(p => p.nodeId === 'c-5')?.styles.order).toBe('2');       // target takes dragged's order
    expect(h.placeholderPatches[h.placeholderPatches.length - 1]?.styles.order).toBe('5');                          // placeholder takes target's

    // 3. Commit: JSX reorders AND a sequential order re-stamp through the
    //    shared router (primary → inline styles).
    const updates = strategy.onEnd(h.context);
    const orderWrites = updates.filter(u => u.type === 'style' && u.styles?.order !== undefined);
    expect(orderWrites.length).toBeGreaterThan(0);
    // The final VISUAL order has c-5 in the dragged slot (idx 2) and the
    // dragged node at c-5's slot (idx 5) — sequential 0..N over that.
    const byId = Object.fromEntries(orderWrites.map(u => [u.nodeId, u.styles!.order]));
    expect(byId['c-5']).toBe('2');
    expect(byId['dragged']).toBe('5');
  });

  test('cancel restores every swapped order to its drag-start value', async () => {
    const h = await onePassMocks();
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });     // swap with c-5
    h.patchedStyles.length = 0;
    strategy.onCancel(h.context);
    expect(h.patchedStyles.find(p => p.nodeId === 'c-5')?.styles.order).toBe('5');
  });

  test('commit pulses the reposition signal (SelectionFade parity with layout drag)', async () => {
    const { repositionSignalOps } = await import('../reposition-signal');
    vi.mocked(repositionSignalOps.signal).mockClear();
    const h = await onePassMocks();
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });
    strategy.onEnd(h.context);
    // Drop-inside commit → overlay hides + fades in at the settled slot.
    expect(repositionSignalOps.signal).toHaveBeenCalledTimes(1);

    // Cancel does NOT pulse (mirrors LayoutLiftedStrategy — no commit, no fade).
    vi.mocked(repositionSignalOps.signal).mockClear();
    const h2 = await onePassMocks();
    const s2 = new GridDragStrategy();
    s2.onStart(h2.context);
    s2.onCancel(h2.context);
    expect(repositionSignalOps.signal).not.toHaveBeenCalled();
  });

  test('placeholder mirrors the SIZING MODE: % children stretch, px children keep the footprint', async () => {
    // A `height: 100%` child contributes ~nothing to an auto row's track
    // sizing — a fixed-px placeholder injected a real contribution and the
    // dragged row GREW while the other shrank, snapping back on mouseup
    // (user report 2026-07-27).
    const hPct = await onePassMocks({ childSize: { width: '100%', height: '100%' } });
    new GridDragStrategy().onStart(hPct.context);
    const phPct = hPct.createdPlaceholders[0]!.styles;
    expect(phPct.width).toBe('100%');
    expect(phPct.height).toBe('100%');
    expect(phPct.alignSelf).toBe('stretch');
    expect(phPct.justifySelf).toBe('stretch');

    const hPx = await onePassMocks({ childSize: { width: '100px', height: '100px' } });
    new GridDragStrategy().onStart(hPx.context);
    const phPx = hPx.createdPlaceholders[0]!.styles;
    expect(phPx.width).toBe('100px');
    expect(phPx.height).toBe('100px');
    expect(phPx.alignSelf).toBe('start');
    expect(phPx.justifySelf).toBe('start');
  });

  test('grids WITHOUT order styles keep the DOM-swap path', async () => {
    const h = await onePassMocks({ withOrders: false });
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });
    expect(h.swapTwoElementsCalls.length).toBe(1);      // DOM swap used
    expect(h.placeholderPatches.length).toBe(0);        // no order juggling
  });

  test('primary commit stays STRUCTURAL (JSX reorders emitted)', async () => {
    const h = await onePassMocks({ withOrders: false });
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });
    const updates = strategy.onEnd(h.context);
    expect(updates.some(u => u.type === 'reorder')).toBe(true);
    expect(updates.some(u => u.type === 'setConditionalOrder')).toBe(false);
  });
});

// ─── Tile-scoped commits — the 2026-08-11 "reorders ALL variants" bug ───────
//
// JSX is shared by every variant/replica. The grid commit always JSX-reordered,
// so a reorder performed ON a master's variant tile moved the cards on every
// variant (the flex path was already correct: LayoutLiftedStrategy never
// JSX-reorders — it routes CSS `order` through commitOrderAssignments). On a
// non-primary tile the grid must do the same: order TERNARY on a master
// variant, @container band on a page replica, and NO structural mutation.
describe('GridDragStrategy — non-primary tiles commit CSS order, not JSX', () => {
  test('master variant tile: order ternary scoped to the variant, primary pinned in default branch', async () => {
    const h = await onePassMocks({
      withOrders: false,                       // the reported case: cards carry NO order
      viewportPrefix: 'variant-2-',
      activeFile: 'components/TaMaNe.tsx',
    });
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });   // swap dragged (slot 2) ↔ c-5
    const updates = strategy.onEnd(h.context);

    // NO structural JSX change — other variants keep their sequence.
    expect(updates.some(u => u.type === 'reorder')).toBe(false);
    expect(updates.some(u => u.type === 'move')).toBe(false);

    // Every child gets a variant ternary; the moved pair carries the swap on
    // the variant branch while the default branch pins the PRIMARY sequence.
    const cond = updates.filter(u => u.type === 'setConditionalOrder') as Array<{ nodeId: string; orderMap: Record<string, number> }>;
    const byId = Object.fromEntries(cond.map(u => [u.nodeId, u.orderMap]));
    expect(byId['dragged']).toEqual({ default: 2, 'variant-2': 5 });
    expect(byId['c-5']).toEqual({ default: 5, 'variant-2': 2 });
    expect(byId['c-0']).toEqual({ default: 0, 'variant-2': 0 });
  });

  test('page replica tile: @container order for that band only, no JSX change', async () => {
    const h = await onePassMocks({ withOrders: false, viewportPrefix: 'tablet-' });
    const strategy = new GridDragStrategy();
    strategy.onStart(h.context);
    strategy.onMove(h.context, { x: 180, y: 180 });
    const updates = strategy.onEnd(h.context);

    expect(updates.some(u => u.type === 'reorder')).toBe(false);
    const band = updates.filter(u => u.type === 'updateContainerStyle') as Array<{ nodeId: string; maxWidth: number; styles: Record<string, string> }>;
    expect(band.length).toBeGreaterThan(0);
    expect(band.every(u => u.maxWidth === 768)).toBe(true);
    const byId = Object.fromEntries(band.map(u => [u.nodeId, u.styles.order]));
    expect(byId['dragged']).toBe('5');
    expect(byId['c-5']).toBe('2');
  });
});
