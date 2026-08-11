// CanvasDragStrategy.test.ts — Unit tests for the default canvas absolute drag strategy.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CanvasDragStrategy } from './CanvasDragStrategy';
import type { DragContext } from '../types';
import type { DraggedNode, Transform, Point } from '@/shared/types';
import { dropLineOps } from '@/canvas/selection/drop-line-store';
import { parentHighlightOps } from '@/canvas/selection/parent-highlight-store';
import { queueMutation, flushNow, flushNowDeferredDuringDrag } from '@/code/mutation/mutation-queue';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('@/canvas/canvas-math', () => ({
  getCanvasDelta: (dx: number, dy: number, scale: number) => ({ x: dx / scale, y: dy / scale }),
  getAbsoluteCanvasRectById: vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 })),
  getParentCanvasOffsetById: vi.fn(() => ({ x: 0, y: 0 })),
  getElementScreenRect: vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 })),
  isInsideRect: vi.fn(() => false),
  screenToParent: vi.fn(() => ({ x: 0, y: 0 })),
}));

vi.mock('../handlers/snap-handler', () => ({
  calculateSnap: vi.fn(() => ({
    x: 0, y: 0, snappedX: false, snappedY: false, guides: [], spacingGuides: [],
  })),
  getMouseVelocity: vi.fn(() => 0),
}));

vi.mock('@/shared/constants', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    SNAP_THRESHOLD: 5,
    MIN_DRAG_DISTANCE: 4,
    DEFAULT_VIEWPORT_WIDTH: 1440,
    canAcceptChildren: vi.fn(() => true),
  };
});

vi.mock('@/code/stores/viewport-store', () => ({
  getViewportWidths: vi.fn(() => ({ desktop: 1440, tablet: 768, mobile: 375 })),
}));

vi.mock('@/canvas/selection/drop-line-store', () => ({
  dropLineOps: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock('@/canvas/selection/parent-highlight-store', () => ({
  parentHighlightOps: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock('../reparent-utils', () => ({
  calculateLayoutInsertIndexById: vi.fn(() => 0),
  // Edge-magnet promotion runs on every single-select containment pass —
  // pass the candidate through unchanged (no promotion in these tests).
  applyLayoutEdgeMagnet: vi.fn((bestFrame: any) => bestFrame),
  computeLayoutInsertOrderUpdates: vi.fn(() => []),
}));

// Transform-aware entry/exit coordinate helpers construct DOMMatrix, which
// jsdom doesn't implement. They're pure math with their own coverage — mock
// them so the entry path can run end-to-end in this environment.
vi.mock('../transform-reparent', () => ({
  computeEntryParentLocalPosition: vi.fn(() => ({ parentRelLeft: 100, parentRelTop: 200, cssWidth: 100, cssHeight: 50 })),
  computeExitCanvasPosition: vi.fn(() => ({ canvasLeft: 0, canvasTop: 0 })),
  traceTransformReparent: vi.fn(),
}));

vi.mock('@/shared/dom-utils', () => ({
  getStyleNum: vi.fn((el: HTMLElement, prop: string) => parseFloat((el.style as any)[prop]) || 0),
}));

// We mock node-ops at the module level and control return values per test
const mockPatchNodeStyles = vi.fn<(contentEl: HTMLElement, nodeId: string, vpPrefix: string, styles: Record<string, string>, important?: boolean) => void>();
// Controllable bridge reads — entry/viewport detection is bridge-based now
// (getNodeHitsAtPoint + findNodeRect), not DOM-based.
const mockFindNodeRect = vi.fn<(nodeId: string, vpId: string) => DOMRect | null>(() => null);
const mockGetNodeHitsAtPoint = vi.fn<(x: number, y: number) => Array<{ id: string; vpPrefix: string }>>(() => []);

vi.mock('@/canvas/node-ops', () => ({
  updateNodeStyles: vi.fn(),
  patchElementStyles: (el: HTMLElement, styles: Record<string, string>) => {
    for (const [k, v] of Object.entries(styles)) { try { (el.style as any)[k] = v; } catch {} }
  },
  patchNodeStyles: (...args: any[]) => mockPatchNodeStyles(args[0], args[1], args[2], args[3], args[4]),
  isPrimaryViewport: vi.fn((vpId: string) => vpId === 'desktop' || vpId === 'default' || !vpId),
  vpIdFromPrefix: vi.fn((prefix: string) => !prefix ? 'desktop' : prefix.endsWith('-') ? prefix.slice(0, -1) : prefix),
  getActiveFilePath: vi.fn(() => 'pages/home.tsx'),
  // Bridge helpers
  findNodeRect: (...args: any[]) => mockFindNodeRect(args[0], args[1]),
  findNodeComputedStyle: vi.fn(() => ''),
  findNodeComputedStyles: vi.fn(() => ({})),
  findChildRects: vi.fn(() => []),
  // Bridge / canvas mode helpers used by reparent + variant-exit branches
  getNodeHitsAtPoint: (...args: any[]) => mockGetNodeHitsAtPoint(args[0], args[1]),
  findRootHitAtPoint: vi.fn(() => null),
  forceCanvasRenderDeferredDuringDrag: vi.fn(), forceCanvasRender: vi.fn(),
  getViewportPrefix: vi.fn((vpId: string) =>
    !vpId || vpId === 'desktop' || vpId === 'default' ? '' : `${vpId}-`,
  ),
}));

vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: vi.fn(() => ({
    patchStyles: vi.fn(),
  })),
}));

vi.mock('@/code/project/active-file-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/project/active-file-store')>();
  return { ...actual, isComponentFilePath: vi.fn((path: string) => path.startsWith('components/')) };
});

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNowDeferredDuringDrag: vi.fn(), flushNow: vi.fn(),
  syncQueueCode: vi.fn(),
  // The entry's synchronous unhide pipeline seeds the node cache from the
  // just-flushed code; '' parses to an empty map, which is all these tests need.
  getCurrentCode: vi.fn(() => ''),
}));

vi.mock('../replica-context', () => ({
  getReplicaContext: vi.fn(() => ({
    isPrimary: false,
    isComponent: true,
    vpId: 'variant-1',
    variantName: 'variant-1',
    vpWidth: 400,
    allVpWidths: { default: 400, 'variant-1': 400 },
    hideInThis: vi.fn(() => ({ nodeId: 'node-1', type: 'updateVariantStyle', variantName: 'variant-1', styles: { display: 'none' } })),
    hideInAllOthers: vi.fn(() => []),
    styleUpdate: vi.fn(() => []),
    exitToCanvas: vi.fn(() => ({ nodeId: 'node-1', type: 'move', newParentId: null, canvasNode: true, styles: {} })),
    deleteUpdate: vi.fn(() => []),
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockEl(attrs: Record<string, string> = {}, styles: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(styles)) (el.style as any)[k] = v;
  return el;
}

function makeDraggedNode(overrides: Partial<DraggedNode> = {}): DraggedNode {
  return {
    id: 'node-1',
    startLeft: 100,
    startTop: 200,
    mouseOffsetX: 10,
    mouseOffsetY: 10,
    width: 100,
    height: 50,
    startParentId: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<DragContext> & { nodeStyles?: Record<string, Record<string, string>> } = {}): DragContext {
  const contentEl = document.createElement('div');
  const { nodeStyles, ...rest } = overrides;
  const draggedNodes = rest.draggedNodes ?? [makeDraggedNode()];

  // Build nodes Map with style data for canHandle() (reads position from NodeMap)
  const nodes: Map<string, any> = rest.nodes ?? new Map();
  if (nodeStyles) {
    for (const [id, styles] of Object.entries(nodeStyles)) {
      const existing = nodes.get(id) ?? { id, tag: 'div', styles: {} };
      nodes.set(id, { ...existing, styles: { ...existing.styles, ...styles } });
    }
  }

  return {
    draggedNodes,
    startMouse: { x: 500, y: 300 },
    transform: { x: 0, y: 0, scale: 1 } as Transform,
    containerRect: new DOMRect(0, 0, 1920, 1080),
    contentEl,
    code: '',
    nodes,
    selectedIds: ['node-1'],
    modifiers: { alt: false, shift: false, ctrl: false },
    viewportPrefix: '',
    ...rest,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CanvasDragStrategy', () => {
  let strategy: CanvasDragStrategy;

  beforeEach(() => {
    strategy = new CanvasDragStrategy();
    vi.clearAllMocks();
    // Reset bridge-read defaults (mockImplementation set in a test would
    // otherwise leak into the next one).
    mockFindNodeRect.mockReturnValue(null);
    mockGetNodeHitsAtPoint.mockReturnValue([]);
  });

  // ─── canHandle ────────────────────────────────────────────────────────

  describe('canHandle', () => {
    test('returns true for absolute-positioned node (from NodeMap)', () => {
      const ctx = makeContext({
        nodeStyles: { 'node-1': { position: 'absolute' } },
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true for fixed-positioned node (from NodeMap)', () => {
      const ctx = makeContext({
        nodeStyles: { 'node-1': { position: 'fixed' } },
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when element has no startParentId (root level)', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: null })],
        nodeStyles: { 'node-1': { position: 'relative' } },
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns false for relative node WITH a startParentId', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodeStyles: { 'node-1': { position: 'relative' } },
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false for static node WITH a startParentId', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodeStyles: { 'node-1': { position: 'static' } },
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns true when node not in NodeMap (defaults to absolute)', () => {
      // When node data is missing from NodeMap, position defaults to 'absolute'
      const ctx = makeContext();
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns false when no dragged nodes', () => {
      const ctx = makeContext({ draggedNodes: [] });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('defaults to absolute when node has no position style', () => {
      // When node exists in NodeMap but has no position style, defaults to 'absolute'
      const ctx = makeContext({
        nodeStyles: { 'node-1': {} },
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });
  });

  // ─── onStart ──────────────────────────────────────────────────────────

  describe('onStart', () => {
    test('initializes state — clears lastPositions, axis lock, entry state', () => {
      const ctx = makeContext();
      strategy.onStart(ctx);

      // After onStart, internal state should be fresh.
      // We verify this indirectly: onEnd after onStart-without-onMove should return empty updates
      // (no lastPositions stored).
      const updates = strategy.onEnd(ctx);
      expect(updates).toEqual([]);
    });

    test('can be called multiple times to reset state', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });

      // First drag cycle
      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 520, y: 330 });

      // Start a new drag — should reset lastPositions
      strategy.onStart(ctx);
      const updates = strategy.onEnd(ctx);
      expect(updates).toEqual([]); // lastPositions should be cleared
    });
  });

  // ─── onMove ───────────────────────────────────────────────────────────

  describe('onMove', () => {
    // Per-frame writes are TRANSFORM-only now (compositor translate, no
    // layout pass per tick). The element's inline left/top stay at the last
    // committed value; final left/top land via onEnd's PendingUpdates.
    // (onStart also patches `willChange: 'transform'` per node, so tests
    // read the LAST patch for a node, which is the onMove translate.)

    /** Helper: get the LAST patchNodeStyles call for a given nodeId */
    function getLastPatchedStyles(nodeId: string): Record<string, string> | undefined {
      const calls = mockPatchNodeStyles.mock.calls.filter(c => c[1] === nodeId);
      return calls[calls.length - 1]?.[3];
    }

    test('basic move writes a compositor translate of (dx, dy); left/top commit at onEnd', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Move mouse by (20, 30) screen pixels at scale=1 -> delta=(20, 30) canvas
      const mouseScreen: Point = { x: 520, y: 330 };
      strategy.onMove(ctx, mouseScreen);

      // onMove now patches `transform: translate(dx, dy)` instead of left/top
      // (position writes moved to onEnd — see the onEnd tests for 120/230).
      const styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(20px, 30px)' });
    });

    test('shift+drag axis lock — locks to X axis when horizontal movement > vertical', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
        modifiers: { alt: false, shift: true, ctrl: false },
      });
      strategy.onStart(ctx);

      // Move mouse diagonally with more X than Y (>5px threshold to trigger lock)
      const mouseScreen: Point = { x: 510, y: 303 };
      strategy.onMove(ctx, mouseScreen);

      // X axis locked: dx=10, dy forced to 0 in the per-frame translate
      const styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(10px, 0px)' });
    });

    test('shift+drag axis lock — locks to Y axis when vertical movement > horizontal', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
        modifiers: { alt: false, shift: true, ctrl: false },
      });
      strategy.onStart(ctx);

      // Move with more Y than X
      const mouseScreen: Point = { x: 502, y: 310 };
      strategy.onMove(ctx, mouseScreen);

      const styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(0px, 10px)' });
    });

    test('axis lock does not trigger for movement < 5px', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
        modifiers: { alt: false, shift: true, ctrl: false },
      });
      strategy.onStart(ctx);

      // Small movement — below 5px threshold
      const mouseScreen: Point = { x: 503, y: 302 };
      strategy.onMove(ctx, mouseScreen);

      // No axis lock determined yet, so both axes update freely
      const styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(3px, 2px)' });
    });

    test('axis lock resets when shift is released', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
        modifiers: { alt: false, shift: true, ctrl: false },
      });
      strategy.onStart(ctx);

      // Lock to X axis
      strategy.onMove(ctx, { x: 510, y: 302 });
      let styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(10px, 0px)' }); // Y locked

      // Release shift
      ctx.modifiers.shift = false;
      strategy.onMove(ctx, { x: 515, y: 310 });

      // Both axes should update now
      styles = getLastPatchedStyles('node-1');
      expect(styles).toEqual({ transform: 'translate(15px, 10px)' });
    });

    test('multi-select: moves all dragged nodes', () => {

      const ctx = makeContext({
        draggedNodes: [
          makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 }),
          makeDraggedNode({ id: 'node-2', startLeft: 300, startTop: 400 }),
        ],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      strategy.onMove(ctx, { x: 520, y: 330 });

      // Same delta applied to every dragged node as a per-node translate
      // (each node's own startLeft/startTop only matter at commit time).
      const styles1 = getLastPatchedStyles('node-1');
      expect(styles1).toEqual({ transform: 'translate(20px, 30px)' });
      const styles2 = getLastPatchedStyles('node-2');
      expect(styles2).toEqual({ transform: 'translate(20px, 30px)' });
    });

    test('returns DragMoveResult with snap and axisLock', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode()],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      const result = strategy.onMove(ctx, { x: 520, y: 330 });

      expect(result).toHaveProperty('snap');
      expect(result).toHaveProperty('dropTarget', null);
      expect(result).toHaveProperty('highlightParentId', null);
      expect(result).toHaveProperty('axisLock', null);
    });
  });

  // ─── onEnd ────────────────────────────────────────────────────────────

  describe('onEnd', () => {
    test('returns style PendingUpdates with final left/top', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Move to store lastPositions
      strategy.onMove(ctx, { x: 540, y: 360 });

      const updates = strategy.onEnd(ctx);

      expect(updates).toHaveLength(1);
      // The node here had NO pre-drag transform, so the commit carries none:
      // an empty `transform` is not a no-op downstream — the style writer
      // reads it as "reset the transform", which also clears a framer-motion
      // `rotate` prop and stripped the rotation off rotated masters on every
      // drop (2026-08-11). The per-frame drag translate is still cleared, but
      // through the imperative bridge patch, which is where it belongs.
      expect(updates[0]).toEqual({
        nodeId: 'node-1',
        type: 'style',
        styles: {
          left: '140px',
          top: '260px',
        },
      });
    });

    test('returns empty array if no lastPositions (no onMove called)', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1' })],
      });
      strategy.onStart(ctx);

      const updates = strategy.onEnd(ctx);
      expect(updates).toEqual([]);
    });

    test('returns updates for all dragged nodes', () => {

      const ctx = makeContext({
        draggedNodes: [
          makeDraggedNode({ id: 'node-1', startLeft: 10, startTop: 20 }),
          makeDraggedNode({ id: 'node-2', startLeft: 50, startTop: 60 }),
        ],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 510, y: 310 });

      const updates = strategy.onEnd(ctx);
      expect(updates).toHaveLength(2);
      expect(updates[0].nodeId).toBe('node-1');
      expect(updates[1].nodeId).toBe('node-2');
    });

    test('clears visual stores on end', () => {
      const ctx = makeContext();
      strategy.onStart(ctx);
      strategy.onEnd(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
    });
  });

  // ─── Hovered viewport detection (bridge hit-testing → lastHoverVpId) ──

  describe('hovered viewport detection via onMove', () => {
    // Single-select viewport detection is bridge-based now: the deepest
    // NON-DRAGGED hit under the cursor (getNodeHitsAtPoint) supplies the
    // hovered viewport prefix — the DOM data-viewport scan is gone from
    // this path.

    test('detects viewport from the deepest non-dragged bridge hit under the cursor', () => {
      // The dragged element must resolve a rect or containment detection
      // bails before reading hits.
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(480, 380, 100, 50);
        return null;
      });
      // Cursor is over some tablet-replica element (not a valid drop frame —
      // it's absent from the NodeMap — but it still determines the hover vp).
      mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'other-1', vpPrefix: 'tablet-' }]);

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      const result = strategy.onMove(ctx, { x: 500, y: 400 });

      // highlightVpId should be the viewport the mouse is over
      expect(result.highlightVpId).toBe('tablet');
    });

    test('returns undefined vpId when the dragged rect is unresolvable (no bridge hits)', () => {
      // findNodeRect stays null → containment detection bails early and
      // never sets lastHoverVpId.
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      const result = strategy.onMove(ctx, { x: 510, y: 310 });

      // No hover viewport resolved → highlightVpId should be undefined
      expect(result.highlightVpId).toBeUndefined();
    });
  });

  // ─── buildReplicaVisibilityUpdates (tested via onEnd after entering a parent in a viewport) ──

  describe('buildReplicaVisibilityUpdates — replica visibility via onEnd', () => {
    // These test the replica visibility update generation that happens inside onEnd
    // when the strategy detects entry into a frame in a non-primary viewport.

    test('onEnd returns empty replica updates for primary viewport (desktop)', () => {

      // Primary viewport (desktop) — no replica updates expected
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
        viewportPrefix: '', // primary
      });
      strategy.onStart(ctx);
      strategy.onMove(ctx, { x: 520, y: 330 });

      const updates = strategy.onEnd(ctx);

      // Should NOT have any updateContainerStyle updates (only style updates)
      const containerStyleUpdates = updates.filter(u => u.type === 'updateContainerStyle');
      expect(containerStyleUpdates).toHaveLength(0);
    });
  });

  // ─── Drop line + parent highlight mutual exclusivity ──────────────────

  describe('drop line and parent highlight mutual exclusivity', () => {
    test('highlightParentId is null when dropLineActive is true (layout with children)', () => {
      // When a layout parent with children is detected, a drop line shows.
      // In this case, highlightParentId should be null (mutually exclusive).
      // We test this indirectly: the onMove result should return highlightParentId as null
      // when there's an active drop line (we can't directly check dropLineActive, but the
      // result.highlightParentId being null while a parent IS detected confirms it).

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Without any frame entry, both should be null
      const result = strategy.onMove(ctx, { x: 520, y: 330 });
      expect(result.highlightParentId).toBeNull();
    });

    test('returns highlightParentId as null by default when no entry detected', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      const result = strategy.onMove(ctx, { x: 510, y: 310 });

      // No parent entry → no highlight, no drop target
      expect(result.highlightParentId).toBeNull();
      expect(result.dropTarget).toBeNull();
    });
  });

  // ─── Mid-drag switch behavior ──────────────────────────────────────────

  describe('mid-drag strategy switch — code-first entry', () => {
    /** Bridge-based entry setup: the frame is a NodeMap entry + bridge rects
     *  and hit-test results (the DOM-element based detection is gone). */
    function setupFrameEntry(vpPrefix: string) {
      mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'frame-1', vpPrefix }]);
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        // Dragged element fully inside the frame — required for non-layout entry.
        if (nodeId === 'node-1') return new DOMRect(200, 300, 100, 50);
        if (nodeId === 'frame-1') return new DOMRect(100, 100, 400, 400);
        return null;
      });
      const nodes = new Map<string, any>([
        ['frame-1', {
          id: 'frame-1', type: 'div', tag: 'div', parentId: null, children: [],
          styles: { position: 'relative' }, attrs: {},
        }],
      ]);
      return nodes;
    }

    test('entry into non-layout frame sets switchRequest with toStrategy=absolute-in-frame', () => {
      const nodes = setupFrameEntry('');

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
        startMouse: { x: 200, y: 300 },
        viewportPrefix: '',
        nodes,
      });
      strategy.onStart(ctx);

      // Run through grace period (ENTRY_GRACE_FRAMES = 3).
      // Frame 1: candidateParentId set, framesInCandidateParent=1
      // Frame 2: framesInCandidateParent=2
      // Frame 3: framesInCandidateParent=3 → entry confirmed → reparent → switchRequest!
      let switchResult;
      for (let i = 0; i < 3; i++) {
        const result = strategy.onMove(ctx, { x: 220, y: 320 });
        if (result.switchRequest) switchResult = result;
      }

      // On the 3rd frame, switchRequest should be emitted
      expect(switchResult).toBeDefined();
      expect(switchResult!.switchRequest!.toStrategy).toBe('absolute-in-frame');
      expect(switchResult!.switchRequest!.reason).toBe('parent-entry-absolute');
      // Entry is CODE-FIRST now: the move mutation is committed live during
      // onMove (flushNow), not deferred to mouseup.
      expect(queueMutation).toHaveBeenCalledWith(expect.objectContaining({
        type: 'move', nodeId: 'node-1', newParentId: 'frame-1', canvasNode: false,
      }));
      expect(flushNowDeferredDuringDrag).toHaveBeenCalled();
    });

    test('onEnd after a code-first entry commits position only (no replica visibility updates)', () => {
      // Replica visibility is committed live during onMove's entry
      // (queueMutation + flushNow) — onEnd must only emit the final
      // position, never deferred updateContainerStyle updates.
      const nodes = setupFrameEntry('tablet-');

      // Context in a non-primary viewport (where replica visibility matters)
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
        startMouse: { x: 200, y: 300 },
        viewportPrefix: 'tablet-',
        nodes,
      });

      // Create a fresh strategy and trigger entry
      const testStrategy = new CanvasDragStrategy();
      testStrategy.onStart(ctx);

      // Run through grace period — 3 frames to trigger entry + switch
      let switchFired = false;
      for (let i = 0; i < 3; i++) {
        const result = testStrategy.onMove(ctx, { x: 220, y: 320 });
        if (result.switchRequest) switchFired = true;
      }

      // Verify the switch actually triggered (entry was confirmed)
      expect(switchFired).toBe(true);

      // onEnd after the live reparent: only position ('style') updates —
      // the replica hides already went through the mutation queue mid-drag.
      const updates = testStrategy.onEnd(ctx);

      const replicaUpdates = updates.filter(u => u.type === 'updateContainerStyle');
      expect(replicaUpdates).toHaveLength(0);
    });
  });

  // ─── onCancel ─────────────────────────────────────────────────────────

  describe('onCancel', () => {
    test('restores start positions for all dragged nodes via patchNodeStyles', () => {
      const ctx = makeContext({
        draggedNodes: [
          makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 }),
          makeDraggedNode({ id: 'node-2', startLeft: 300, startTop: 400 }),
        ],
      });

      strategy.onStart(ctx);
      strategy.onCancel(ctx);

      // patchNodeStyles restores each node's start position, and now also
      // restores the lift-time transform ('' — no pre-drag transform here)
      // and clears the onStart `willChange: 'transform'` layer promotion.
      expect(mockPatchNodeStyles).toHaveBeenCalledWith(
        ctx.contentEl, 'node-1', '', { left: '100px', top: '200px', transform: '', willChange: '' }, undefined,
      );
      expect(mockPatchNodeStyles).toHaveBeenCalledWith(
        ctx.contentEl, 'node-2', '', { left: '300px', top: '400px', transform: '', willChange: '' }, undefined,
      );
    });

    test('handles missing elements gracefully', () => {

      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200 })],
      });

      strategy.onStart(ctx);
      // Should not throw — patchNodeStyles is a no-op mock
      expect(() => strategy.onCancel(ctx)).not.toThrow();
    });

    test('clears visual stores on cancel', () => {
      const ctx = makeContext();
      strategy.onStart(ctx);
      strategy.onCancel(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
    });
  });
});

// Entering a viewport that currently HIDES the node must make it visible on the
// entry frame, not at mouseup. The hide is a `@media … { [data-id=x] {
// display:none !important } }` rule in the page's <style> block: a stylesheet
// `!important` beats every imperative per-element patch the drag has, so the
// only way to drop it is to regenerate the code and re-render the block. The
// entry queues that removal — but deferring the flush meant the node stayed
// invisible for the whole entry-to-drop window ("it should not hide when I enter
// primary", user report 2026-08-04).
describe('entry into a viewport that hides the node', () => {
  // This describe sits OUTSIDE the main one, so it needs its own reset —
  // without it the first test's flushNow leaks into the second.
  beforeEach(() => { vi.clearAllMocks(); });

  const RULE_CODE = (width: number) => `<div data-id="root" style={{position:'relative'}}>
  <style>{\`
    @media (max-width: ${width}px) {
      [data-id="node-1"] { display: none !important; }
    }
  \`}</style>
</div>`;

  function runEntry(nodes: Map<string, any>, vpPrefix = '') {
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
      startMouse: { x: 200, y: 300 },
      viewportPrefix: vpPrefix,
      nodes,
    });
    const s = new CanvasDragStrategy();
    s.onStart(ctx);
    for (let i = 0; i < 3; i++) s.onMove(ctx, { x: 220, y: 320 });
  }

  function frameNodes(vpPrefix = '') {
    mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'frame-1', vpPrefix }]);
    mockFindNodeRect.mockImplementation((nodeId: string) => {
      if (nodeId === 'node-1') return new DOMRect(200, 300, 100, 50);
      if (nodeId === 'frame-1') return new DOMRect(100, 100, 400, 400);
      return null;
    });
    return new Map<string, any>([
      ['frame-1', { id: 'frame-1', type: 'div', tag: 'div', parentId: null, children: [], styles: { position: 'relative' }, attrs: {} }],
    ]);
  }

  test('runs the pipeline SYNCHRONOUSLY when a hide rule covers the entered viewport', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('@/code/stores/store');
    const { forceCanvasRender, forceCanvasRenderDeferredDuringDrag } = await import('@/canvas/node-ops');
    // desktop is the entered viewport and its width is 1440 in this harness.
    getDefaultStore().set(codeAtom, RULE_CODE(1440));

    runEntry(frameNodes());

    // The unhide is queued…
    expect(queueMutation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'updateContainerStyle', nodeId: 'node-1', maxWidth: 1440, styles: { display: '' },
    }));
    // …and committed + re-rendered NOW, because nothing imperative can beat a
    // stylesheet !important. Deferring these is what left the node invisible.
    expect(flushNow).toHaveBeenCalled();
    expect(forceCanvasRender).toHaveBeenCalled();
    expect(flushNowDeferredDuringDrag).not.toHaveBeenCalled();
    expect(forceCanvasRenderDeferredDuringDrag).not.toHaveBeenCalled();
  });

  test('keeps the cheap DEFERRED path when no rule hides the entered viewport', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('@/code/stores/store');
    const { forceCanvasRender } = await import('@/canvas/node-ops');
    // A rule at the TABLET width only — the entered (desktop) viewport is clear,
    // so this entry has nothing to unhide and must not pay for the pipeline.
    getDefaultStore().set(codeAtom, RULE_CODE(768));

    runEntry(frameNodes());

    expect(flushNowDeferredDuringDrag).toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(forceCanvasRender).not.toHaveBeenCalled();
  });
});

// The REPLICA half of the same problem. Entering a non-primary viewport does not
// CLEAR a hide — it CREATES one: base inline `display:'none'` (so the node shows
// on no other viewport) plus the entered vp's `display:'unset'` @container
// override to reveal it there. The inline half reaches the DOM instantly and the
// stylesheet half cannot, so deferring the flush left the node hidden EVERYWHERE
// for the whole drag: "the moment it enters the replica it's completely hidden
// and only appears on mouse up" (user report 2026-08-04). `unhidesLiveRule` is
// structurally blind to this — there is no pre-existing rule to find.
describe('entry into a REPLICA writes the visibility pair', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const NO_RULES = `<div data-id="root" style={{position:'relative'}}></div>`;

  function replicaNodes() {
    mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'frame-1', vpPrefix: 'tablet-' }]);
    mockFindNodeRect.mockImplementation((nodeId: string) => {
      if (nodeId === 'node-1') return new DOMRect(200, 300, 100, 50);
      if (nodeId === 'frame-1') return new DOMRect(100, 100, 400, 400);
      return null;
    });
    return new Map<string, any>([
      ['frame-1', { id: 'frame-1', type: 'div', tag: 'div', parentId: null, children: [], styles: { position: 'relative' }, attrs: {} }],
    ]);
  }

  function runReplicaEntry() {
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
      startMouse: { x: 200, y: 300 },
      viewportPrefix: '',
      nodes: replicaNodes(),
    });
    const s = new CanvasDragStrategy();
    s.onStart(ctx);
    for (let i = 0; i < 3; i++) s.onMove(ctx, { x: 220, y: 320 });
  }

  test('takes the synchronous pipeline even though no rule existed beforehand', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('@/code/stores/store');
    const { forceCanvasRender, forceCanvasRenderDeferredDuringDrag } = await import('@/canvas/node-ops');
    getDefaultStore().set(codeAtom, NO_RULES);

    runReplicaEntry();

    // The entry writes the base hide half…
    expect(queueMutation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'move', nodeId: 'node-1', styles: expect.objectContaining({ display: 'none' }),
    }));
    // …so the stylesheet half has to land NOW, not at mouseup.
    expect(flushNow).toHaveBeenCalled();
    expect(forceCanvasRender).toHaveBeenCalled();
    expect(flushNowDeferredDuringDrag).not.toHaveBeenCalled();
    expect(forceCanvasRenderDeferredDuringDrag).not.toHaveBeenCalled();
  });

  test('the PRIMARY entry with nothing to change still takes the cheap path', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('@/code/stores/store');
    const { forceCanvasRender } = await import('@/canvas/node-ops');
    getDefaultStore().set(codeAtom, NO_RULES);

    // Same drag, entering the PRIMARY: no rule to clear and no pair to write.
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
      startMouse: { x: 200, y: 300 },
      viewportPrefix: '',
      nodes: (() => {
        mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'frame-1', vpPrefix: '' }]);
        mockFindNodeRect.mockImplementation((nodeId: string) => {
          if (nodeId === 'node-1') return new DOMRect(200, 300, 100, 50);
          if (nodeId === 'frame-1') return new DOMRect(100, 100, 400, 400);
          return null;
        });
        return new Map<string, any>([
          ['frame-1', { id: 'frame-1', type: 'div', tag: 'div', parentId: null, children: [], styles: { position: 'relative' }, attrs: {} }],
        ]);
      })(),
    });
    const s = new CanvasDragStrategy();
    s.onStart(ctx);
    for (let i = 0; i < 3; i++) s.onMove(ctx, { x: 220, y: 320 });

    expect(flushNowDeferredDuringDrag).toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(forceCanvasRender).not.toHaveBeenCalled();
  });
});

describe('entry into a design-component VARIANT mirrors the hide into the DOM', () => {
  // The code write alone is invisible mid-drag: the node is drag-locked, so
  // `patch-children-skip-locked` skips the copy in every OTHER variant's tile —
  // styles included — while `reparentLive` has already inserted one there. The
  // user saw the node appear in the primary tile for the whole gesture and
  // vanish on mouseup (2026-08-04). Page replicas hide via an `@container` rule,
  // which reaches a locked element fine — hence component-only.
  beforeEach(() => { vi.clearAllMocks(); });

  async function runVariantEntry() {
    const { getReplicaContext } = await import('../replica-context');
    const { getActiveFilePath } = await import('@/canvas/node-ops');
    (getActiveFilePath as any).mockReturnValue('components/PoVuZa.tsx');
    (getReplicaContext as any).mockReturnValue({
      isPrimary: false, isComponent: true, vpId: 'variant-1', variantName: 'variant-1',
      vpWidth: 400, allVpWidths: { default: 400, 'variant-1': 400 },
      hideInThis: vi.fn(() => ({ nodeId: 'node-1', type: 'updateVariantStyle', variantName: 'variant-1', styles: { display: 'none' } })),
      // Solo on variant-1 → hidden on `default`, whose tile prefix is ''.
      hideInAllOthers: vi.fn(() => [
        { nodeId: 'node-1', type: 'setVariantVisibility', hiddenVariants: ['default'], allVariants: ['default', 'variant-1'] },
      ]),
      styleUpdate: vi.fn(() => []),
      exitToCanvas: vi.fn(() => ({ nodeId: 'node-1', type: 'move', newParentId: null, canvasNode: true, styles: {} })),
      deleteUpdate: vi.fn(() => []),
    });
    mockGetNodeHitsAtPoint.mockReturnValue([{ id: 'frame-1', vpPrefix: 'variant-1-' }]);
    mockFindNodeRect.mockImplementation((nodeId: string) => {
      if (nodeId === 'node-1') return new DOMRect(200, 300, 100, 50);
      if (nodeId === 'frame-1') return new DOMRect(100, 100, 400, 400);
      return null;
    });
    const ctx = makeContext({
      draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null })],
      startMouse: { x: 200, y: 300 },
      viewportPrefix: '',
      nodes: new Map<string, any>([
        ['frame-1', { id: 'frame-1', type: 'div', tag: 'div', parentId: null, children: [], styles: { position: 'relative' }, attrs: {} }],
      ]),
    });
    const s = new CanvasDragStrategy();
    s.onStart(ctx);
    for (let i = 0; i < 3; i++) s.onMove(ctx, { x: 220, y: 320 });
    return { s, ctx };
  }

  /** Every (prefix, display) pair painted on node-1. */
  const displayPatches = () => mockPatchNodeStyles.mock.calls
    .filter(c => c[1] === 'node-1' && c[3] && 'display' in c[3])
    .map(c => ({ prefix: c[2], display: c[3].display }));

  test('paints display:none on the hidden variant tile, not just in code', async () => {
    await runVariantEntry();

    // The code write still happens…
    expect(queueMutation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'setVariantVisibility', nodeId: 'node-1', hiddenVariants: ['default'],
    }));
    // …AND the tile it hides is darkened now, because no mid-drag render will.
    expect(displayPatches()).toContainEqual({ prefix: '', display: 'none' });
  });

  test('never darkens the variant being dragged into', async () => {
    await runVariantEntry();
    expect(displayPatches()).not.toContainEqual({ prefix: 'variant-1-', display: 'none' });
  });

  test('onCancel undoes the paint — the hide was never committed', async () => {
    const { s, ctx } = await runVariantEntry();
    expect(displayPatches()).toContainEqual({ prefix: '', display: 'none' });

    s.onCancel(ctx);

    // Restored to the node's own display (none of its own → '' DELETES the
    // inline property). Without this a cancelled drag strands an invisible copy.
    expect(displayPatches()).toContainEqual({ prefix: '', display: '' });
  });
});
