// LayoutLiftedStrategy.test.ts — Unit tests for the layout-lifted (flex/grid) drag strategy.
// Bridge-based: all DOM reads use findNodeRect/findNodeComputedStyle/findChildRects,
// all DOM writes use patchNodeStyles/bridge commands. No getNodeEl() calls.

import { describe, test, expect, vi, beforeEach, it } from 'vitest';
import { atom } from 'jotai';
import { LayoutLiftedStrategy, computeMergedTemplatedOrder } from './LayoutLiftedStrategy';
import type { DragContext } from '../types';
import type { DraggedNode, Transform } from '@/shared/types';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { isInsideRect } from '@/canvas/canvas-math';
import { getDefaultStore } from 'jotai';
import { getReplicaContext } from '../replica-context';
import { containerOverridesAtom } from '@/code/stores/container-query-store';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('@/canvas/canvas-math', () => ({
  getCanvasDelta: (dx: number, dy: number, scale: number) => ({ x: dx / scale, y: dy / scale }),
  isInsideRect: vi.fn(() => true), // default: mouse is over parent
}));

vi.mock('@/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants')>();
  return {
    ...actual,
    canAcceptChildren: vi.fn(() => true),
  };
});

vi.mock('@/canvas/selection/drop-line-store', () => ({
  dropLineOps: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock('@/canvas/selection/parent-highlight-store', () => ({
  parentHighlightOps: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock('../reparent-utils', () => ({
  calculateLayoutInsertIndexById: vi.fn(() => 0),
  computeReorderAssignments: vi.fn((ids: string[]) => ids.map((id, i) => ({ nodeId: id, order: i }))),
}));

// Mock patchNodeStyles to track all bridge style writes
const mockPatchNodeStyles = vi.fn();
const mockFindNodeRect = vi.fn<(nodeId: string, vpId: string) => DOMRect | null>();
const mockFindNodeComputedStyle = vi.fn<(nodeId: string, vpId: string, prop: string) => string>();
const mockFindNodeComputedStyles = vi.fn<(nodeId: string, vpId: string, props: string[]) => Record<string, string>>();
const mockFindChildRects = vi.fn<(parentId: string, vpId: string) => Array<{ id: string; rect: DOMRect }>>();
const mockInjectCanvasCSS = vi.fn();
const mockRepositionOverlays = vi.fn();
const mockBridgePatchStyles = vi.fn();

const mockFlushAndForceStructuralRender = vi.fn();
vi.mock('@/canvas/node-ops', () => ({
  patchNodeStyles: (...args: any[]) => mockPatchNodeStyles(...args),
  isPrimaryViewport: (vpId: string) => vpId === 'desktop' || vpId === 'default' || vpId === '',
  vpIdFromPrefix: (prefix: string) => !prefix ? 'desktop' : prefix.endsWith('-') ? prefix.slice(0, -1) : prefix,
  getViewportPrefix: (vpId: string) => vpId === 'desktop' ? '' : vpId + '-',
  getActiveFilePath: () => 'app/page.tsx',
  findNodeRect: (...args: any[]) => mockFindNodeRect(args[0], args[1]),
  findNodeComputedStyle: (...args: any[]) => mockFindNodeComputedStyle(args[0], args[1], args[2]),
  findNodeComputedStyles: (...args: any[]) => mockFindNodeComputedStyles(args[0], args[1], args[2]),
  findChildRects: (...args: any[]) => mockFindChildRects(args[0], args[1]),
  findVisibleChildRects: (...args: any[]) => mockFindChildRects(args[0], args[1]),
  getNodeHitsAtPoint: () => [],
  forceCanvasRenderDeferredDuringDrag: vi.fn(), forceCanvasRender: vi.fn(),
  // Ghost rebuild after a drag inside a collection-list row (see the
  // draggedInsideCollectionRow test below). Must be in the mock — an
  // undefined import would crash cleanup() the moment that path runs.
  flushAndForceStructuralRender: (...args: any[]) => mockFlushAndForceStructuralRender(...args),
  parseRectCacheKey: (key: string) => {
    const i = key.indexOf(':');
    return i < 0 ? { vpPrefix: '', nodeId: key } : { vpPrefix: key.slice(0, i), nodeId: key.slice(i + 1) };
  },
  injectCanvasCSS: (...args: any[]) => mockInjectCanvasCSS(...args),
  removeCanvasCSS: vi.fn(),
}));

// Mock bridge with placeholder/lift methods
const mockCreatePlaceholder = vi.fn();
const mockMovePlaceholder = vi.fn();
const mockRemovePlaceholders = vi.fn();
const mockLiftNode = vi.fn();
const mockGetIframeOffset = vi.fn(() => ({ x: 0, y: 0 }));

// SINGLETON bridge object — tests mutate it (e.g. install getRectAsync for
// the live-size correction), so the factory must hand back the same instance.
const mockBridge: any = {
  createPlaceholder: (...a: any[]) => mockCreatePlaceholder(...a),
  movePlaceholder: (...a: any[]) => mockMovePlaceholder(...a),
  removePlaceholders: (...a: any[]) => mockRemovePlaceholders(...a),
  liftNode: (...a: any[]) => mockLiftNode(...a),
  getIframeOffset: () => mockGetIframeOffset(),
  getRect: () => null,
  patchStyles: (...args: any[]) => mockBridgePatchStyles(...args),
  repositionOverlays: (...a: any[]) => mockRepositionOverlays(...a),
};
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => mockBridge,
}));

// Mock getNodeFromCache to return node data
const nodeCache = new Map<string, any>();
vi.mock('@/code/stores/store', () => ({
  getNodeFromCache: (id: string) => nodeCache.get(id),
  moveNodeInCache: vi.fn(),
  updateNodeInCache: vi.fn(),
}));

vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (path: string) => path.startsWith('components/'),
  isLayoutFile: (path: string) => /(?:^|\/)LayoutClient\.tsx$|(?:^|\/)layout\.tsx$/.test(path),
  activeFilePathAtom: atom<string>('app/page.tsx'),
}));

vi.mock('@/code/stores/viewport-store', () => ({
  getViewportWidths: () => ({ desktop: 1440, tablet: 768 }),
}));

// Capture mutation-queue ops so the detach path's queued `move` is assertable.
// (The strategy queues the canvas-exit move via queueMutation, not via the
// returned `updates` array.) flushNow is a no-op in tests (code: '').
const { mockQueueMutation } = vi.hoisted(() => ({ mockQueueMutation: vi.fn() }));
// `hasPendingDeferredFanOut` is read from inside a requestAnimationFrame
// callback in the exit-commit path, so it can fire AFTER the test that scheduled
// it finished — without it on the mock, vitest raises an unhandled
// "No export is defined on the mock" and the whole run exits non-zero even though
// every test passes. Timing-dependent, hence intermittent.
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (...args: any[]) => mockQueueMutation(...args),
  flushNowDeferredDuringDrag: vi.fn(), flushNow: vi.fn(),
  hasPendingDeferredFanOut: vi.fn(() => false),
}));

// Controllable per-viewport @media override map. The real `containerOverridesAtom`
// reads `codeAtom` from the mocked store (undefined) → swap it for a SETTABLE
// primitive atom (a no-dep derived atom would cache stale); keep the REAL
// `resolveEffectiveStylesForViewport` so the replica detach's effective-style
// baking is exercised end-to-end. Set per test via `getDefaultStore().set(...)`.
vi.mock('@/code/stores/container-query-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/stores/container-query-store')>();
  const { atom } = await import('jotai');
  return { ...actual, containerOverridesAtom: atom(new Map()) };
});

vi.mock('../replica-context', () => ({
  getReplicaContext: vi.fn(() => ({
    isPrimary: true,
    styleUpdate: vi.fn(() => []),
  })),
}));

const mockLayoutResult: string = 'flex';

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    detectParentLayoutById: vi.fn(() => mockLayoutResult),
    getFlexDirectionById: vi.fn(() => 'column'),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDraggedNode(overrides: Partial<DraggedNode> = {}): DraggedNode {
  return {
    id: 'node-1',
    startLeft: 50,
    startTop: 60,
    mouseOffsetX: 10,
    mouseOffsetY: 10,
    width: 80,
    height: 40,
    startParentId: 'parent-1',
    ...overrides,
  };
}

function makeContext(overrides: Partial<DragContext> = {}): DragContext {
  const contentEl = document.createElement('div');
  return {
    draggedNodes: [makeDraggedNode()],
    startMouse: { x: 500, y: 300 },
    transform: { x: 0, y: 0, scale: 1 } as Transform,
    containerRect: new DOMRect(0, 0, 1920, 1080),
    contentEl,
    code: '',
    nodes: new Map(),
    selectedIds: ['node-1'],
    modifiers: { alt: false, shift: false, ctrl: false },
    viewportPrefix: '',
    ...overrides,
  };
}

/** Set up NodeMap cache for parent + children */
function setupNodeCache(parentId: string, childIds: string[], parentStyles: Record<string, string> = { display: 'flex', flexDirection: 'column' }) {
  nodeCache.clear();
  nodeCache.set(parentId, {
    id: parentId,
    tag: 'div',
    type: 'div',
    styles: parentStyles,
    children: childIds,
    parentId: null,
    isCanvasNode: false,
  });
  for (let i = 0; i < childIds.length; i++) {
    nodeCache.set(childIds[i], {
      id: childIds[i],
      tag: 'div',
      type: 'div',
      styles: { position: 'relative', width: '100px', height: '40px' },
      children: [],
      parentId: parentId,
      isCanvasNode: false,
    });
  }
}

/** Set up findNodeRect to return rects for given node IDs */
function setupNodeRects(rects: Record<string, { x: number; y: number; width: number; height: number }>) {
  mockFindNodeRect.mockImplementation((nodeId: string, _vpId: string) => {
    const r = rects[nodeId];
    if (!r) return null;
    return new DOMRect(r.x, r.y, r.width, r.height);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LayoutLiftedStrategy', () => {
  let strategy: LayoutLiftedStrategy;

  beforeEach(() => {
    strategy = new LayoutLiftedStrategy();
    vi.clearAllMocks();
    getDefaultStore().set(containerOverridesAtom as any, new Map());
    nodeCache.clear();
    mockFindNodeRect.mockReturnValue(null);
    mockFindNodeComputedStyle.mockReturnValue('');
    mockFindNodeComputedStyles.mockReturnValue({});
    mockFindChildRects.mockReturnValue([]);
  });

  // ─── canHandle ────────────────────────────────────────────────────────

  describe('canHandle', () => {
    test('returns true when parent is flex AND element is NOT absolute/fixed', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent is inline-flex', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'inline-flex' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    // Grid parents are now hard-bailed here — `GridDragStrategy` (registered
    // BEFORE this one in `DragCoordinator.strategies`) handles them with
    // cell-aware swap logic. Returning `true` for grid here would steal
    // the drag and reorder via the flex/block `order` model, which is
    // wrong for grid (especially for explicit-placement grids).
    test('returns false when parent is grid (GridDragStrategy handles it)', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'grid' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent is inline-grid (GridDragStrategy handles it)', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'inline-grid' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent is flex but element is position:absolute', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'absolute' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent is flex but element is position:fixed', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'fixed' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    // The bridge computed-style cache goes stale for a beat right after a node
    // ENTERS a flex parent (it was a canvas node / absolute a moment ago). The
    // node's OWN cache already says `relative`; trusting the stale computed
    // `absolute` would route this genuine flow child to the absolute strategy,
    // which pins canvas left/top → the flex child renders thousands of px off its
    // slot and VANISHES ("flex child disappears when I drag it again"). Must be
    // reconciled: cache says flow + parent is flex → keep it here.
    test('returns TRUE for a flex flow child when the computed cache is STALE absolute', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' }, parentId: 'parent-1', isCanvasNode: false }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
      ]);
      mockFindNodeComputedStyle.mockImplementation((id: string, _vp: string, prop: string) => {
        if (id === 'node-1' && prop === 'position') return 'absolute'; // STALE
        if (id === 'parent-1' && prop === 'display') return 'flex';
        return '';
      });
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    // The genuine reason computed is preferred over the base cache: a replica
    // where the parent's flex was REMOVED (@container display:block) and the
    // child is absolute there. Parent is NOT flex → must still bail so
    // AbsoluteInFrameStrategy handles it. The stale-computed reconciliation above
    // is gated on `parent is flex`, so it doesn't swallow this case.
    test('returns FALSE for a @container-absolute child whose parent is NOT flex on this vp', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' }, parentId: 'parent-1', isCanvasNode: false }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }], // base flex…
      ]);
      mockFindNodeComputedStyle.mockImplementation((id: string, _vp: string, prop: string) => {
        if (id === 'node-1' && prop === 'position') return 'absolute';
        if (id === 'parent-1' && prop === 'display') return 'block'; // …but @container removed it here
        return '';
      });
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent has only absolute children', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'absolute' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'block' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns true when parent is block-flow with flow children (no position)', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: {} }], // no position = flow child
        ['parent-1', { id: 'parent-1', styles: { display: 'block' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns false when parent is block but child has position:relative', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
        ['parent-1', { id: 'parent-1', styles: { display: 'block' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when no startParentId', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: null })],
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent node not found in NodeMap', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: { position: 'relative' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when no dragged nodes', () => {
      const ctx = makeContext({ draggedNodes: [] });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns true when element has no explicit position (defaults to static in flex)', () => {
      const nodes = new Map<string, any>([
        ['node-1', { id: 'node-1', styles: {} }],
        ['parent-1', { id: 'parent-1', styles: { display: 'flex' } }],
      ]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });
  });

  // ─── onStart ──────────────────────────────────────────────────────────

  describe('templated page — footer bracket regression', () => {
    test('drag start brackets layout:: chrome AFTER content with a high order', () => {
      // Merged templated root: fixed header, three page sections, and the
      // template FOOTER carrying its own source `order: '2'`. During drag
      // the sections get spaced ranks (0/10/20) — without the bracket the
      // footer (order 2) slots between rank 0 and 10 and visually jumps to
      // the top of the page.
      nodeCache.clear();
      nodeCache.set('root', {
        id: 'root', tag: 'div', type: 'div',
        styles: { display: 'flex', flexDirection: 'column' },
        children: ['layout::hdr', 'sec-a', 'sec-b', 'sec-c', 'layout::site-footer'],
        parentId: null, isCanvasNode: false,
      });
      nodeCache.set('layout::hdr', {
        id: 'layout::hdr', tag: 'div', type: 'div',
        styles: { position: 'fixed' }, children: [], parentId: 'root', isCanvasNode: false,
      });
      for (const id of ['sec-a', 'sec-b', 'sec-c']) {
        nodeCache.set(id, {
          id, tag: 'div', type: 'div',
          styles: { position: 'relative', width: '1000px', height: '600px' },
          children: [], parentId: 'root', isCanvasNode: false,
        });
      }
      nodeCache.set('layout::site-footer', {
        id: 'layout::site-footer', tag: 'div', type: 'div',
        styles: { position: 'relative', order: '2' }, children: [], parentId: 'root', isCanvasNode: false,
      });
      setupNodeRects({
        'root': { x: 0, y: 0, width: 1000, height: 3000 },
        'sec-a': { x: 0, y: 0, width: 1000, height: 600 },
        'sec-b': { x: 0, y: 600, width: 1000, height: 600 },
        'sec-c': { x: 0, y: 1200, width: 1000, height: 600 },
        'layout::site-footer': { x: 0, y: 1800, width: 1000, height: 800 },
      });
      mockFindChildRects.mockReturnValue([
        { id: 'sec-a', rect: new DOMRect(0, 0, 1000, 600) },
        { id: 'sec-b', rect: new DOMRect(0, 600, 1000, 600) },
        { id: 'sec-c', rect: new DOMRect(0, 1200, 1000, 600) },
        { id: 'layout::site-footer', rect: new DOMRect(0, 1800, 1000, 800) },
      ]);
      mockFindNodeComputedStyles.mockReturnValue({ width: '1000', height: '600' });
      mockFindNodeComputedStyle.mockReturnValue('');

      const strategy = new LayoutLiftedStrategy();
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'sec-b', startParentId: 'root', width: 1000, height: 600 })],
        selectedIds: ['sec-b'],
      });
      strategy.onStart(ctx);

      // Every style write went through the patchNodeStyles fallback (the
      // mocked bridge has no patchMultipleStyles) — collect order writes.
      const orderWrites = mockPatchNodeStyles.mock.calls
        .filter((c) => c[3] && typeof c[3].order === 'string')
        .map((c) => ({ nodeId: c[1], order: c[3].order, important: c[4] }));

      // Page sections got spaced ranks…
      expect(orderWrites.find(w => w.nodeId === 'sec-a')?.order).toBe('0');
      expect(orderWrites.find(w => w.nodeId === 'sec-c')?.order).toBe('20');
      // …and the template footer got BRACKETED above every rank so it can
      // never slot between page sections during the drag.
      const footer = orderWrites.find(w => w.nodeId === 'layout::site-footer');
      expect(footer).toBeDefined();
      expect(parseInt(footer!.order, 10)).toBeGreaterThan(100000);
      expect(footer!.important).toBe(true);
    });
  });

  describe('reorder hit test (live rects — canvas-dnd parity)', () => {
    // Placeholder mutations re-emit the parent scope, so sibling spans track
    // the REAL screen every frame. Old-library semantics: inside a sibling →
    // direction-biased from its first pixel; in a gap (the placeholder's
    // real hole) → that slot, stable while hovering.
    const mk = () => {
      const strategy = new LayoutLiftedStrategy() as any;
      strategy.flexDirection = 'column';
      strategy.isGridParent = false;
      strategy.isWrapParent = false;
      strategy.getParentLocalSpace = () => ({
        mode: 'aabb-px',
        toLocal: (x: number, y: number) => ({ x, y }),
        sibAabb: (_id: string, r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height }),
      });
      const sib = (id: string, top: number, bot: number): { id: string; rect: DOMRect } =>
        ({ id, rect: { left: 0, top, width: 100, height: bot - top, right: 100, bottom: bot } as DOMRect });
      return { strategy, sib };
    };

    it('placeholder hole hover is stable; sibling first pixel fires in the drag direction', () => {
      const { strategy, sib } = mk();
      // Live layout with the placeholder hole at slot 1: A 0–100, HOLE
      // 100–240, B 240–340.
      const siblings = [sib('A', 0, 100), sib('B', 240, 340)];
      strategy.currentInsertIndex = 1;
      // Hovering the hole — stable both directions (gap → slot 1 = current).
      expect(strategy.calculateReorderIndex({ x: 50, y: 150 }, siblings, true)).toBe(1);
      expect(strategy.calculateReorderIndex({ x: 50, y: 220 }, siblings, false)).toBe(1);
      // First pixel of B going down → after B.
      expect(strategy.calculateReorderIndex({ x: 50, y: 241 }, siblings, true)).toBe(2);
      // First pixel of A going up (from 100 downwards edge) → before A.
      expect(strategy.calculateReorderIndex({ x: 50, y: 99 }, siblings, false)).toBe(0);
      // Inside A going down → after A (slot 1).
      expect(strategy.calculateReorderIndex({ x: 50, y: 60 }, siblings, true)).toBe(1);
    });

    it('before-first and after-last resolve to the ends', () => {
      const { strategy, sib } = mk();
      const siblings = [sib('A', 100, 200), sib('B', 200, 300)];
      strategy.currentInsertIndex = 2;
      expect(strategy.calculateReorderIndex({ x: 50, y: 50 }, siblings, false)).toBe(0);
      expect(strategy.calculateReorderIndex({ x: 50, y: 350 }, siblings, true)).toBe(2);
    });
  });

  describe('onStart', () => {
    test('creates a placeholder via bridge.createPlaceholder', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // Placeholder should be created via bridge
      expect(mockCreatePlaceholder).toHaveBeenCalledTimes(1);
      expect(mockCreatePlaceholder.mock.calls[0][0]).toBe('ph-child-0'); // phId
      expect(mockCreatePlaceholder.mock.calls[0][1]).toBe('parent-1'); // parentNodeId
    });

    test('lifts element via bridge.liftNode with absolute positioning', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // Node should be lifted via bridge
      expect(mockLiftNode).toHaveBeenCalledTimes(1);
      const liftStyles = mockLiftNode.mock.calls[0][2];
      expect(liftStyles.position).toBe('absolute');
      expect(liftStyles.zIndex).toBe('9999');
      expect(liftStyles.pointerEvents).toBe('none');
    });

    test('neutralizes percentage box constraints so the lifted overlay cannot collapse', () => {
      // A maxWidth: '100%' node reparented to contentRoot resolves the
      // percentage against a zero-size containing block — computed width 0,
      // invisible drag overlay. The lift must pin px size and clear min/max.
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      const childNode = nodeCache.get('child-0')!;
      childNode.styles = { position: 'relative', width: '86px', height: '86px', maxWidth: '100%' };

      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 86, height: 86 },
        'child-1': { x: 100, y: 200, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      const liftStyles = mockLiftNode.mock.calls[0][2];
      expect(liftStyles.maxWidth).toBe('none');
      expect(liftStyles.maxHeight).toBe('none');
      expect(liftStyles.minWidth).toBe('0px');
      expect(liftStyles.minHeight).toBe('0px');
      expect(liftStyles.width).toMatch(/px$/);
    });

    test('snapshots original styles from NodeMap for later restoration', () => {
      setupNodeCache('parent-1', ['child-0']);
      const childNode = nodeCache.get('child-0')!;
      childNode.styles = { flex: '1', margin: '10px', alignSelf: 'center', width: '100px', height: '40px' };

      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // Lift should have been called (styles are snapshotted internally for onCancel)
      expect(mockLiftNode).toHaveBeenCalledTimes(1);
    });
  });

  // ─── onCancel ─────────────────────────────────────────────────────────

  describe('onCancel', () => {
    test('removes placeholders via bridge and restores original styles via patchNodeStyles', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      const childNode = nodeCache.get('child-0')!;
      childNode.styles = { position: 'relative', flexGrow: '1', margin: '10px', width: '100px', height: '40px' };

      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      vi.clearAllMocks();

      strategy.onCancel(ctx);

      // Placeholders should be removed via bridge
      expect(mockRemovePlaceholders).toHaveBeenCalled();

      // Original styles should be restored via patchNodeStyles
      const restoreCalls = mockPatchNodeStyles.mock.calls.filter(
        c => c[1] === 'child-0' && c[3]?.position === 'relative'
      );
      expect(restoreCalls.length).toBeGreaterThanOrEqual(1);
      const restoredStyles = restoreCalls[0][3];
      expect(restoredStyles.position).toBe('relative');
      expect(restoredStyles.flexGrow).toBe('1');
      expect(restoredStyles.margin).toBe('10px');
    });

    test('restores the original box constraints on cancel', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      const childNode = nodeCache.get('child-0')!;
      childNode.styles = { position: 'relative', width: '86px', height: '86px', maxWidth: '100%' };

      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 86, height: 86 },
        'child-1': { x: 100, y: 200, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      vi.clearAllMocks();
      strategy.onCancel(ctx);

      const restoreCalls = mockPatchNodeStyles.mock.calls.filter(
        c => c[1] === 'child-0' && c[3]?.position === 'relative'
      );
      expect(restoreCalls.length).toBeGreaterThanOrEqual(1);
      expect(restoreCalls[0][3].maxWidth).toBe('100%');
      expect(restoreCalls[0][3].minWidth).toBe('');
    });

    test('clears visual stores on cancel', () => {
      setupNodeCache('parent-1', ['child-0']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      strategy.onCancel(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
    });

    test('handles missing rects gracefully', () => {
      setupNodeCache('parent-1', ['child-0']);
      // No rects set — findNodeRect returns null for all

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      // Should not throw when node has no rect during cancel
      expect(() => strategy.onCancel(ctx)).not.toThrow();
    });
  });

  // ─── onEnd ────────────────────────────────────────────────────────────

  describe('onEnd', () => {
    test('returns style order updates when dropped inside parent', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // Simulate a move that stays over the parent (isInsideRect returns true by default)
      strategy.onMove(ctx, { x: 510, y: 310 });

      const updates = strategy.onEnd(ctx);

      // Should emit type:'style' with order values for all siblings
      expect(updates.length).toBeGreaterThanOrEqual(1);
      const styleUpdates = updates.filter(u => u.type === 'style');
      expect(styleUpdates.length).toBeGreaterThanOrEqual(1);
      expect(styleUpdates.every(u => u.styles && 'order' in u.styles)).toBe(true);
    });

    test('clears visual stores and removes placeholders on end', () => {
      setupNodeCache('parent-1', ['child-0']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      strategy.onEnd(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
      // Placeholders should be removed via bridge
      expect(mockRemovePlaceholders).toHaveBeenCalled();
    });

    test('assigns spaced rank order to every child during onStart', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1', 'child-2']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
        'child-2': { x: 100, y: 180, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-1', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // After neutralization, every layout child got an `order` patch with
      // !important. The assigned values are spaced ranks (0, 10, 20) — see
      // order-positioning.ts. Old behavior was all '0'; preserving that
      // visual layout's stability requires the spaced scheme instead.
      const orderCalls = mockPatchNodeStyles.mock.calls.filter(
        c => typeof c[3]?.order === 'string' && c[4] === true,
      );
      expect(orderCalls.length).toBe(3); // all 3 children
      const orderValues = orderCalls.map(c => c[3].order).sort((a, b) => Number(a) - Number(b));
      expect(orderValues).toEqual(['0', '10', '20']);
    });

    test('emits updateContainerStyle for order when dropping inside parent in replica viewport', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      // Replica viewport: viewportPrefix = 'tablet-'
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
        viewportPrefix: 'tablet-',
      });

      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 510, y: 310 });

      const updates = strategy.onEnd(ctx);

      // Replica drops should emit updateContainerStyle (not style) for order
      const containerUpdates = updates.filter(u => u.type === 'updateContainerStyle');
      expect(containerUpdates.length).toBeGreaterThanOrEqual(1);
      expect(containerUpdates.every(u => u.styles && 'order' in u.styles)).toBe(true);
      expect(containerUpdates.every(u => u.maxWidth !== undefined)).toBe(true);

      // Should NOT emit type:'style' with order for replicas
      const styleOrderUpdates = updates.filter(
        u => u.type === 'style' && u.styles && 'order' in u.styles
      );
      expect(styleOrderUpdates.length).toBe(0);
    });

    test('primary viewport drop still emits type:style for order', () => {
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      // Primary viewport: viewportPrefix = ''
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
        viewportPrefix: '',
      });

      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 510, y: 310 });

      const updates = strategy.onEnd(ctx);

      // Primary drops should emit type:'style' with order
      const styleUpdates = updates.filter(u => u.type === 'style');
      expect(styleUpdates.length).toBeGreaterThanOrEqual(1);
      expect(styleUpdates.every(u => u.styles && 'order' in u.styles)).toBe(true);
    });

    test('returns move update with absolute positioning when dropped outside parent', () => {
      setupNodeCache('parent-1', ['child-0']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);

      // First move: inside parent
      vi.mocked(isInsideRect).mockReturnValue(true);
      strategy.onMove(ctx, { x: 510, y: 310 });

      // Second move: outside parent
      vi.mocked(isInsideRect).mockReturnValue(false);
      strategy.onMove(ctx, { x: 900, y: 900 });

      strategy.onEnd(ctx);

      // The primary drag-out no longer returns a 'move' update — it queues the
      // mutation DIRECTLY so onEnd can flushNow + force-render synchronously
      // before SelectionOverlay un-hides (stale-overlay fix). Assert the
      // queued mutation instead.
      const moveCall = mockQueueMutation.mock.calls
        .map((c: any[]) => c[0])
        .find((m: any) => m.type === 'move' && m.nodeId === 'child-0');
      expect(moveCall).toBeTruthy();
      expect(moveCall.newParentId).toBeNull();
      expect(moveCall.canvasNode).toBe(true);
      expect(moveCall.styles).toHaveProperty('position', 'absolute');
    });

    // Ghost rows are DOM-only clones of the template row, and the Renderer's
    // patch fast-path can only re-sync them when the row's DOM STRUCTURE or its
    // CMS BINDINGS changed. Reordering INSIDE the row changes neither (it
    // rewrites `order` styles) and an `updateStyles`-only flush may skip its
    // render — so the node just dropped into the row went missing from every
    // ghost until a page switch (user report 2026-07-26).
    test('drag INSIDE a collection row forces a ghost rebuild on drop', () => {
      mockFlushAndForceStructuralRender.mockClear();
      // list → row (template) → two children; the drag reorders inside the row.
      nodeCache.clear();
      nodeCache.set('frame-list', {
        id: 'frame-list', tag: 'div', type: 'div', parentId: null, isCanvasNode: false,
        styles: { display: 'flex', flexDirection: 'row' }, children: ['row-tpl'],
        collectionList: { source: 'blog', itemVar: 'item', templateIds: { default: 'row-tpl' } },
      });
      nodeCache.set('row-tpl', {
        id: 'row-tpl', tag: 'div', type: 'div', parentId: 'frame-list', isCanvasNode: false,
        styles: { display: 'flex', flexDirection: 'column' }, children: ['child-0', 'child-1'],
      });
      for (const id of ['child-0', 'child-1']) {
        nodeCache.set(id, {
          id, tag: 'div', type: 'div', parentId: 'row-tpl', isCanvasNode: false,
          styles: { position: 'relative' }, children: [],
        });
      }
      setupNodeRects({
        'frame-list': { x: 100, y: 100, width: 600, height: 300 },
        'row-tpl': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'row-tpl' })],
      });
      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 510, y: 310 });
      strategy.onEnd(ctx);

      expect(mockFlushAndForceStructuralRender).toHaveBeenCalled();
    });

    test('an ordinary layout drag does NOT force a ghost rebuild', () => {
      mockFlushAndForceStructuralRender.mockClear();
      setupNodeCache('parent-1', ['child-0', 'child-1']);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'child-0': { x: 100, y: 100, width: 200, height: 40 },
        'child-1': { x: 100, y: 140, width: 200, height: 40 },
      });
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'child-0', startParentId: 'parent-1' })],
      });
      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 510, y: 310 });
      strategy.onEnd(ctx);

      expect(mockFlushAndForceStructuralRender).not.toHaveBeenCalled();
    });

    test('COLLECTION LIST replica drop-out → map-preserving CLONE to canvas + hideInThis (NOT move, NOT static clone)', () => {
      // Regression guard for the replica collection-list detach bug. Dropping a
      // `.map()` repeater out of a REPLICA must behave like a NORMAL node's replica
      // drag-out: CLONE to the canvas + hide on THIS replica only (original stays on
      // primary + other replicas) — but map-preserving. So it emits a
      // `duplicateCollectionToCanvas` update (verbatim `.map()` COPY) + a hideInThis,
      // NOT a `move` (which would remove the list from ALL viewports) and NOT a
      // static `add` clone (buildCanvasCloneDescriptor → one unbound ghost).
      setupNodeCache('parent-1', ['frame-list']);
      // Mark the dragged child as a CMS Collection List in the parsed NodeMap.
      const listNode = {
        id: 'frame-list', tag: 'div', type: 'div',
        styles: { position: 'relative', display: 'grid', width: '100px', height: '40px' },
        children: ['adv-tpl'], parentId: 'parent-1', isCanvasNode: false,
        collectionList: { source: 'advisors', itemVar: 'item', templateIds: { default: 'adv-tpl' } },
      };
      const nodes = new Map<string, any>([
        ['parent-1', { id: 'parent-1', tag: 'div', type: 'div', styles: { display: 'flex', flexDirection: 'column' }, children: ['frame-list'], parentId: null, isCanvasNode: false }],
        ['frame-list', listNode],
      ]);
      setupNodeRects({
        'parent-1': { x: 100, y: 100, width: 200, height: 300 },
        'frame-list': { x: 100, y: 100, width: 200, height: 40 },
      });

      // Tablet (768) @media overrides for the list: 2-col grid + gap overrides over
      // the desktop base (display:grid). The canvas node must BAKE these (it lives
      // outside the viewport tree, so the @media rules no longer apply to it).
      getDefaultStore().set(containerOverridesAtom as any, new Map([
        ['frame-list', new Map([
          [768, new Map([
            ['gridTemplateColumns', 'repeat(2, minmax(0, 1fr))'],
            ['rowGap', '89px'],
            ['columnGap', '28px'],
          ])],
        ])],
      ]));

      // Replica context: dropping into a non-primary viewport. hideInThis MUST be
      // called (the source is hidden on THIS replica, kept everywhere else).
      const hideUpdate = { nodeId: 'frame-list', type: 'updateContainerStyle' as const, maxWidth: 768, styles: { display: 'none' } };
      const hideInThis = vi.fn(() => hideUpdate);
      vi.mocked(getReplicaContext).mockReturnValueOnce({
        isPrimary: false, hideInThis, styleUpdate: vi.fn(() => []),
      } as any);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'frame-list', startParentId: 'parent-1' })],
        nodes,
        viewportPrefix: 'tablet-',
      });

      strategy.onStart(ctx);
      vi.mocked(isInsideRect).mockReturnValue(true);
      strategy.onMove(ctx, { x: 510, y: 310 });
      vi.mocked(isInsideRect).mockReturnValue(false);
      strategy.onMove(ctx, { x: 900, y: 900 });

      const updates = strategy.onEnd(ctx);

      // CLONE: a map-preserving duplicate-to-canvas update for the list.
      const dup = updates.find(u => u.type === 'duplicateCollectionToCanvas') as any;
      expect(dup).toBeDefined();
      expect(dup.nodeId).toBe('frame-list');
      expect(dup.cmsSource).toBe('advisors');
      expect(dup.cloneSuffix).toMatch(/^-c[a-z0-9]+$/);
      // Container layout styles (display:grid) ride along + canvas position.
      expect(dup.styles).toHaveProperty('display', 'grid');
      expect(dup.styles).toHaveProperty('position', 'absolute');
      // EFFECTIVE replica styles baked: the tablet @media overrides win over the
      // desktop base (2-col grid + gap overrides), NOT the base 3-col.
      expect(dup.styles.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
      expect(dup.styles.rowGap).toBe('89px');
      expect(dup.styles.columnGap).toBe('28px');

      // HIDE on this replica only (source preserved on primary + other replicas).
      expect(hideInThis).toHaveBeenCalledWith('frame-list');
      expect(updates).toContainEqual(hideUpdate);

      // NOT a move (would remove from ALL viewports) and NOT a static `add` clone.
      expect(mockQueueMutation.mock.calls.map(c => c[0])
        .some((m: any) => m && m.type === 'move' && m.nodeId === 'frame-list')).toBe(false);
      expect(updates.find(u => u.type === 'add')).toBeUndefined();
    });
  });
});

// ─── Synced-replica hide covers the trigger's OPEN OVERLAY ──────────────────
// A layout drag hides the dragged node's replicas in the other viewport tiles so
// they don't reflow on every mouse move. A relative overlay is portaled OUT of
// the viewport root, so hiding the replica trigger never touched it — the other
// tiles kept showing a dropdown pointing at a now-invisible source.
// Live find 2026-07-25.
describe('LayoutLiftedStrategy — synced-replica hide includes overlays', () => {
  it('hides the replica OVERLAY alongside the replica trigger', () => {
    const injected: Array<{ selector: string; body: string }> = [];
    mockInjectCanvasCSS.mockImplementation((selector: string, body: string) => {
      injected.push({ selector, body });
    });

    const ctx = makeContext();
    // An overlay hanging off the dragged node, plus one on an unrelated node.
    ctx.nodes.set('ov-1', {
      id: 'ov-1', tag: 'div', parentId: 'root', children: [], styles: {},
      attrs: { 'data-overlay': JSON.stringify({ type: 'relative', triggerId: 'node-1', side: 'bottom', align: 'center' }) },
    } as never);
    ctx.nodes.set('ov-other', {
      id: 'ov-other', tag: 'div', parentId: 'root', children: [], styles: {},
      attrs: { 'data-overlay': JSON.stringify({ type: 'relative', triggerId: 'somebody-else', side: 'bottom', align: 'center' }) },
    } as never);

    const s = new LayoutLiftedStrategy();
    s.onStart(ctx);

    // The TRIGGER's replica hides via the stylesheet rule…
    const hide = injected.find(i => i.body.includes('display: none'));
    expect(hide).toBeDefined();
    expect(hide!.selector).toContain('[data-node-id="tablet-node-1"]');
    // …but the OVERLAY must be stamped INLINE with !important: overlay edit mode's
    // `[data-id][data-overlay-node]{display:block!important}` out-specifies any
    // single-attribute stylesheet hide, so a CSS rule would silently lose.
    expect(hide!.selector).not.toContain('ov-1');
    const overlayHides = mockBridgePatchStyles.mock.calls.filter(
      (c) => c[0] === 'ov-1' && c[2]?.display === 'none',
    );
    expect(overlayHides.length).toBeGreaterThan(0);
    expect(overlayHides[0][1]).toBe('tablet-'); // the replica prefix, not the source
    expect(overlayHides[0][3]).toBe(true);      // important
    // Unrelated overlay untouched.
    expect(mockBridgePatchStyles.mock.calls.some((c) => c[0] === 'ov-other')).toBe(false);
  });

  it('clears the inline overlay hide on cleanup', () => {
    const ctx = makeContext();
    ctx.nodes.set('ov-1', {
      id: 'ov-1', tag: 'div', parentId: 'root', children: [], styles: {},
      attrs: { 'data-overlay': JSON.stringify({ type: 'relative', triggerId: 'node-1', side: 'bottom', align: 'center' }) },
    } as never);
    const s = new LayoutLiftedStrategy();
    s.onStart(ctx);
    mockBridgePatchStyles.mockClear();
    s.onCancel(ctx);
    const restored = mockBridgePatchStyles.mock.calls.filter(
      (c) => c[0] === 'ov-1' && c[2]?.display === '',
    );
    expect(restored.length).toBeGreaterThan(0);
  });

  it('repositions overlays the moment the drop restores the replicas', () => {
    const ctx = makeContext();
    const s = new LayoutLiftedStrategy();
    s.onStart(ctx);
    mockRepositionOverlays.mockClear();
    s.onCancel(ctx);
    // Fired at cleanup — same frame as the node landing, not 150ms later.
    expect(mockRepositionOverlays).toHaveBeenCalled();
  });
});

// ─── LIVE-SIZE CORRECTION — stale-cache lift heights ────────────────────────
// The lift sizes come from the rect/computed CACHES, which can be stale for a
// section deep down the page (offscreen-section replay). A component instance
// measuring 657px live was lifted + placeholdered at a cached 418px and stayed
// visibly collapsed for the whole session — live site fine, page-switch heals
// (user report 2026-07-27). onStart now fires a PRE-lift getRectAsync (FIFO ⇒
// pre-lift geometry) and corrects the lifted element + placeholder + reorder
// model when it resolves.
describe('live-size correction', () => {
  const setupStaleGrid = () => {
    nodeCache.clear();
    nodeCache.set('root', {
      id: 'root', tag: 'div', type: 'div',
      styles: { display: 'flex', flexDirection: 'row' },
      children: ['inst-1', 'sib-2'], parentId: null, isCanvasNode: false,
    });
    nodeCache.set('inst-1', {
      id: 'inst-1', tag: 'div', type: 'div',
      styles: { position: 'relative', flex: '1 0 0px' },   // no transform → correctable
      children: [], parentId: 'root', isCanvasNode: false,
    });
    nodeCache.set('sib-2', {
      id: 'sib-2', tag: 'div', type: 'div',
      styles: { position: 'relative' }, children: [], parentId: 'root', isCanvasNode: false,
    });
    setupNodeRects({
      root: { x: 0, y: 0, width: 1000, height: 600 },
      'inst-1': { x: 0, y: 0, width: 900, height: 418 },   // STALE cache
      'sib-2': { x: 900, y: 0, width: 100, height: 418 },
    });
    mockFindChildRects.mockReturnValue([
      { id: 'inst-1', rect: new DOMRect(0, 0, 900, 418) },
      { id: 'sib-2', rect: new DOMRect(900, 0, 100, 418) },
    ]);
    mockFindNodeComputedStyles.mockReturnValue({ width: '900', height: '418' }); // STALE computed
    mockFindNodeComputedStyle.mockReturnValue('');
  };

  it('corrects lifted element + placeholder when the live rect disagrees with the cache', async () => {
    setupStaleGrid();
    // Live pre-lift measurement: the REAL size is 657 tall.
    const getRectAsync = vi.fn(async () => new DOMRect(0, 0, 900, 657));
    mockBridge.getRectAsync = getRectAsync;
    mockBridge.patchPlaceholderStyles = vi.fn();

    const strategy = new LayoutLiftedStrategy();
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'inst-1', startParentId: 'root', width: 900, height: 418 })],
      selectedIds: ['inst-1'],
    });
    strategy.onStart(ctx);
    expect(getRectAsync).toHaveBeenCalledWith('inst-1', '');

    await Promise.resolve(); await Promise.resolve();   // let the read settle

    // The lifted element got the corrected height…
    const corrected = mockPatchNodeStyles.mock.calls
      .filter((c) => c[1] === 'inst-1' && c[3]?.height === '657px');
    expect(corrected.length).toBeGreaterThan(0);
    // …and so did the placeholder.
    const ph = mockBridge.patchPlaceholderStyles as ReturnType<typeof vi.fn>;
    expect(ph.mock.calls.some((c: any[]) => c[2]?.height === '657px')).toBe(true);
  });

  it('a resolve landing AFTER the drag ended touches nothing', async () => {
    setupStaleGrid();
    let resolveRead: (r: DOMRect) => void;
    mockBridge.getRectAsync = vi.fn(() => new Promise<DOMRect>((res) => { resolveRead = res; }));
    mockBridge.patchPlaceholderStyles = vi.fn();

    const strategy = new LayoutLiftedStrategy();
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'inst-1', startParentId: 'root', width: 900, height: 418 })],
      selectedIds: ['inst-1'],
    });
    strategy.onStart(ctx);
    strategy.onCancel(ctx);                               // drag over
    mockPatchNodeStyles.mockClear();
    resolveRead!(new DOMRect(0, 0, 900, 657));
    await Promise.resolve(); await Promise.resolve();
    expect(mockPatchNodeStyles.mock.calls.filter((c) => c[3]?.height === '657px').length).toBe(0);
  });

  it('rotated elements are NOT corrected (AABB ≠ CSS box)', () => {
    setupStaleGrid();
    nodeCache.get('inst-1')!.styles.rotate = '45';
    const getRectAsync = vi.fn(async () => new DOMRect(0, 0, 900, 657));
    mockBridge.getRectAsync = getRectAsync;
    const strategy = new LayoutLiftedStrategy();
    strategy.onStart(makeContext({
      draggedNodes: [makeDraggedNode({ id: 'inst-1', startParentId: 'root', width: 900, height: 418 })],
      selectedIds: ['inst-1'],
    }));
    expect(getRectAsync).not.toHaveBeenCalled();
  });
});

// ─── computeMergedTemplatedOrder — templated-root merged order (2026-07-28) ──
// The trace-verified bug: the merged root held an out-of-flow OVERLAY child;
// the old fill let it consume the first section slot, shifting every section
// one early (drop-in-place jumped one slot UP until the async render healed
// it) and duplicating the last section via the run-off fallback.
describe('computeMergedTemplatedOrder', () => {
  const HEADER = 'layout::KaFiBi-1';
  const FOOTER = 'layout::KaPoJo-2';
  const OVERLAY = 'div-overlay-u';
  const SECTIONS = ['sec-a', 'sec-b', 'sec-c', 'sec-d'];

  it('out-of-flow children keep their DOM slots — no consumption, no duplicate', () => {
    const mergedChildren = [HEADER, OVERLAY, ...SECTIONS, FOOTER];
    // No-move drop: same section order.
    const out = computeMergedTemplatedOrder(mergedChildren, SECTIONS);
    expect(out).toEqual([HEADER, OVERLAY, ...SECTIONS, FOOTER]);
    // No id appears twice (the trace showed the last section duplicated).
    expect(new Set(out).size).toBe(out.length);
  });

  it('reordered sections land in sequence around the kept slots', () => {
    const mergedChildren = [HEADER, OVERLAY, ...SECTIONS, FOOTER];
    const out = computeMergedTemplatedOrder(mergedChildren, ['sec-c', 'sec-a', 'sec-b', 'sec-d']);
    expect(out).toEqual([HEADER, OVERLAY, 'sec-c', 'sec-a', 'sec-b', 'sec-d', FOOTER]);
    // indexOf drives restoreNode — the moved section's slot must match its
    // position among ALL children, overlay included.
    expect(out.indexOf('sec-c')).toBe(2);
  });

  it('no overlay → behaves exactly like the old fill', () => {
    const mergedChildren = [HEADER, ...SECTIONS, FOOTER];
    const out = computeMergedTemplatedOrder(mergedChildren, ['sec-b', 'sec-a', 'sec-c', 'sec-d']);
    expect(out).toEqual([HEADER, 'sec-b', 'sec-a', 'sec-c', 'sec-d', FOOTER]);
  });

  it('a section missing from the merged children never corrupts the rest', () => {
    const mergedChildren = [HEADER, 'sec-a', 'sec-b', FOOTER];
    const out = computeMergedTemplatedOrder(mergedChildren, ['sec-b', 'sec-a', 'sec-ghost']);
    expect(out).toEqual([HEADER, 'sec-b', 'sec-a', FOOTER]);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('getViewportScreenRect — content-bounds union', () => {
  // Imported pages carry the viewport's FIXED height on root (e.g. 900px from
  // the vp config) while sections overflow below it. Exit-detection against
  // the root box alone said "outside the viewport" for any cursor below that
  // line — `exit-parent` fired on the FIRST move and the gesture
  // exit-committed + switched to canvas before the reorder placeholder ever
  // showed (user trace 2026-08-05). The bounds must be the CONTENT bounds:
  // root ∪ its top-level sections ∪ the drag's source parent.
  function primeStrategy(s: LayoutLiftedStrategy) {
    (s as any).viewportNodeId = 'root';
    (s as any).parentNodeId = 'parent-1';
    (s as any).currentVpId = 'desktop';
  }

  it('unions the root box with overflowing sections and the source parent', () => {
    const s = new LayoutLiftedStrategy();
    nodeCache.set('root', {
      id: 'root', tag: 'div', type: 'div', styles: {},
      children: ['section-1', 'section-2'], parentId: null, isCanvasNode: false,
    });
    setupNodeRects({
      root: { x: 0, y: 0, width: 1440, height: 900 },
      'section-1': { x: 0, y: 0, width: 1440, height: 900 },
      'section-2': { x: 0, y: 900, width: 1440, height: 700 }, // below the fold
      'parent-1': { x: 100, y: 1200, width: 600, height: 500 },
    });
    primeStrategy(s);
    const rect = (s as any).getViewportScreenRect();
    // A cursor at y=1250 (inside the below-fold layout) must be INSIDE.
    expect(rect).toEqual({ left: 0, top: 0, width: 1440, height: 1700 });
  });

  it('equals the root box when nothing overflows', () => {
    const s = new LayoutLiftedStrategy();
    nodeCache.set('root', {
      id: 'root', tag: 'div', type: 'div', styles: {},
      children: ['section-1'], parentId: null, isCanvasNode: false,
    });
    setupNodeRects({
      root: { x: 0, y: 0, width: 1440, height: 900 },
      'section-1': { x: 0, y: 0, width: 1440, height: 880 },
      'parent-1': { x: 100, y: 100, width: 600, height: 300 },
    });
    primeStrategy(s);
    expect((s as any).getViewportScreenRect()).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it('EXCLUDES the dragged section from the union — its lifted rect follows the cursor', () => {
    // Dragging a ROOT SECTION: the section is one of root's children, and its
    // live rect tracks the pointer. Unioning it made the bounds chase the
    // cursor — exit-detection could never fire and the section was
    // undetachable from the page (regression report 2026-08-05).
    const s = new LayoutLiftedStrategy();
    nodeCache.set('root', {
      id: 'root', tag: 'div', type: 'div', styles: {},
      children: ['section-1', 'dragged-section'], parentId: null, isCanvasNode: false,
    });
    setupNodeRects({
      root: { x: 0, y: 0, width: 1440, height: 900 },
      'section-1': { x: 0, y: 0, width: 1440, height: 900 },
      // The dragged section mid-gesture, hanging off the page's right edge:
      'dragged-section': { x: 1600, y: 200, width: 600, height: 400 },
    });
    (s as any).viewportNodeId = 'root';
    (s as any).parentNodeId = 'root';
    (s as any).currentVpId = 'desktop';
    const rect = (s as any).getViewportScreenRect(new Set(['dragged-section']));
    // Bounds stay the page's — a cursor at x=1700 (over the dragged clone,
    // off the page) must test OUTSIDE so the exit can fire.
    expect(rect).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });

  it('sections with missing rects are skipped, not fatal', () => {
    const s = new LayoutLiftedStrategy();
    nodeCache.set('root', {
      id: 'root', tag: 'div', type: 'div', styles: {},
      children: ['cold-section'], parentId: null, isCanvasNode: false,
    });
    setupNodeRects({ root: { x: 0, y: 0, width: 1440, height: 900 } });
    primeStrategy(s);
    expect((s as any).getViewportScreenRect()).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  });
});
