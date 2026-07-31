// DragCoordinator.test.ts — Unit tests for mid-drag strategy switching and drag lifecycle.
// After the code-first refactor, deferred updates and replica hiding are removed.
// Entry/exit mutations commit immediately via flushNow() in strategies.

import { describe, test, it, expect, vi, beforeEach } from 'vitest';
import { DragCoordinator, type DragCallbacks } from './DragCoordinator';
import { flushNow } from '@/code/mutation/mutation-queue';
import type { PendingUpdate, Transform } from '@/shared/types';
import { findNodeRect } from '@/canvas/node-ops';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSetDragLockedNodeIds = vi.fn();
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: vi.fn(() => ({
    getRect: vi.fn(() => null),
    setDragLockedNodeIds: (ids: string[]) => mockSetDragLockedNodeIds(ids),
  })),
}));

vi.mock('@/code/mutation/mutation-queue', () => ({
  flushNow: vi.fn(),
  queueMutation: vi.fn(),
  setForceRender: vi.fn(),
  setDeferNextFanOut: vi.fn(),
  hasQueuedMutations: vi.fn(() => false),
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SNAP_THRESHOLD: 5,
  MIN_DRAG_DISTANCE: 4,
  DEFAULT_VIEWPORT_WIDTH: 1440,
  canAcceptChildren: vi.fn(() => true),
  isSvgTag: vi.fn(() => false),
}));

// Partial mock over the real module — replica-context's scale-geometry import
// chain reaches other viewport-store exports (visibleViewportsAtom, …); a
// full replacement mock breaks on every new transitive consumer.
vi.mock('@/code/stores/viewport-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getViewportWidths: vi.fn(() => ({ desktop: 1440, tablet: 768, mobile: 375 })),
}));

vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(() => null),
  findNodeComputedStyles: vi.fn(() => ({})),
  vpIdFromPrefix: vi.fn((prefix: string) => !prefix ? 'desktop' : prefix.endsWith('-') ? prefix.slice(0, -1) : prefix),
  forceCanvasRenderDeferredDuringDrag: vi.fn(), forceCanvasRender: vi.fn(),
  isPrimaryViewport: vi.fn(() => true),
  getActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

vi.mock('@/shared/dom-utils', () => ({
  getStyleNum: vi.fn(() => 0),
}));

vi.mock('@/canvas/resize/geometry-utils', () => ({
  elementOrAncestorHasRotationOrSkew: vi.fn(() => false),
  getScreenCorners: vi.fn(() => []),
  getScreenCornersById: vi.fn(() => null),
  getElementCenter: vi.fn(() => ({ x: 0, y: 0 })),
}));

vi.mock('./handlers/snap-handler', () => ({
  resetSnapHysteresis: vi.fn(),
}));

// ─── Mock strategies (injectable via subclass for testing) ──────────────────

/** Create a mock DragStrategy with controllable onMove results and onEnd updates */
function createMockStrategy(name: string, options: {
  canHandle?: boolean;
  onEndUpdates?: PendingUpdate[];
  onMoveResult?: any;
} = {}) {
  return {
    name,
    canHandle: vi.fn(() => options.canHandle ?? false),
    onStart: vi.fn(),
    onMove: vi.fn(() => options.onMoveResult ?? {
      snap: null,
      dropTarget: null,
      highlightParentId: null,
      axisLock: null,
    }),
    onEnd: vi.fn(() => options.onEndUpdates ?? []),
    onCancel: vi.fn(),
  };
}

function makeCallbacks(overrides: Partial<DragCallbacks> = {}): DragCallbacks {
  return {
    onSnapGuidesChange: vi.fn(),
    onSpacingGuidesChange: vi.fn(),
    onCommit: vi.fn(),
    onHighlightParent: vi.fn(),
    onDragStateChange: vi.fn(),
    getCode: vi.fn(() => ''),
    getNodes: vi.fn(() => new Map()),
    getSelectedIds: vi.fn(() => ['node-1']),
    getTransform: vi.fn(() => ({ x: 0, y: 0, scale: 1 } as Transform)),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DragCoordinator — strategy switching', () => {
  let containerEl: HTMLElement;
  let contentEl: HTMLElement;

  beforeEach(() => {
    containerEl = document.createElement('div');
    contentEl = document.createElement('div');
    vi.clearAllMocks();
  });

  test('mid-drag strategy switch starts new strategy without deferring updates', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);

    // Create mock strategies
    const firstStrategy = createMockStrategy('canvas', {
      canHandle: true,
      onMoveResult: {
        snap: null,
        dropTarget: null,
        highlightParentId: null,
        axisLock: null,
        switchRequest: {
          toStrategy: 'absolute-in-frame',
          reason: 'parent-entry-absolute',
        },
      },
    });

    const secondStrategy = createMockStrategy('absolute-in-frame', {
      canHandle: true,
    });

    // Inject strategies via the private field for testing
    (coordinator as any).strategies = [firstStrategy, secondStrategy];

    // Geometry comes from the bridge rect cache (canvas DOM lives in the
    // sandbox iframe) — mock the rect the dragged node would report.
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(100, 200, 100, 50));

    // Start drag
    coordinator.startPending('node-1', new MouseEvent('mousedown', { clientX: 110, clientY: 210 }));

    // Trigger threshold + strategy switch via onMove
    coordinator.handleMouseMove(new MouseEvent('mousemove', { clientX: 130, clientY: 230 }));

    // The second strategy's onStart should have been called
    expect(secondStrategy.onStart).toHaveBeenCalled();

    // No commit during mid-drag switch — commits happen only on mouseUp
    expect(callbacks.onCommit).not.toHaveBeenCalled();
  });

  test('onEnd updates are passed through to onCommit on mouseUp', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);

    const finalUpdate: PendingUpdate = {
      nodeId: 'node-1', type: 'style',
      styles: { left: '150px', top: '160px' },
    };

    // Set up coordinator state as if mid-drag
    const mockStrategy = createMockStrategy('absolute-in-frame', {
      canHandle: true,
      onEndUpdates: [finalUpdate],
    });

    (coordinator as any).isDragStarted = true;
    (coordinator as any).activeStrategy = mockStrategy;
    (coordinator as any).context = {
      draggedNodes: [{ id: 'node-1', startLeft: 100, startTop: 200, startParentId: null }],
      selectedIds: ['node-1'],
      viewportPrefix: '',
      contentEl,
    };

    // Trigger mouseup
    coordinator.handleMouseUp();

    // onCommit should be called with final position updates only
    expect(callbacks.onCommit).toHaveBeenCalledTimes(1);
    const committedUpdates = (callbacks.onCommit as any).mock.calls[0][0];
    expect(committedUpdates).toEqual([finalUpdate]);
  });

  test('empty onEnd updates do not trigger onCommit', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);

    const mockStrategy = createMockStrategy('canvas', {
      canHandle: true,
      onEndUpdates: [],
    });

    (coordinator as any).isDragStarted = true;
    (coordinator as any).activeStrategy = mockStrategy;
    (coordinator as any).context = {
      draggedNodes: [],
      selectedIds: [],
      viewportPrefix: '',
      contentEl,
    };

    coordinator.handleMouseUp();

    // No updates → no commit
    expect(callbacks.onCommit).not.toHaveBeenCalled();
  });

  test('cancel calls onCancel on active strategy and resets state', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);

    const mockStrategy = createMockStrategy('canvas');

    (coordinator as any).isDragStarted = true;
    (coordinator as any).activeStrategy = mockStrategy;
    (coordinator as any).context = {
      draggedNodes: [],
      selectedIds: [],
      viewportPrefix: '',
    };

    coordinator.cancel();

    expect(mockStrategy.onCancel).toHaveBeenCalled();
    expect(callbacks.onDragStateChange).toHaveBeenCalledWith(false, expect.anything());
    expect(coordinator.isDragging).toBe(false);
  });
});

// ─── svgGroupChildStartPosition — variant-painted geometry beats base attrs ──

import { svgGroupChildStartPosition } from './DragCoordinator';

describe('svgGroupChildStartPosition (the variant-replica group-child jump, 2026-06-11)', () => {
  const NODE = {
    attrs: { x: '44', y: '229' },
    motionVariants: {
      default: {},
      'variant-1': { x: '67', y: '-192' },
    },
  };

  it('on a non-primary variant, painted = base attrs + variant DELTA', () => {
    expect(svgGroupChildStartPosition(NODE, 'variant-1')).toEqual({ x: 111, y: 37 });
  });

  it('on the primary (desktop → default with empty entry), painted = base attrs', () => {
    expect(svgGroupChildStartPosition(NODE, 'desktop')).toEqual({ x: 44, y: 229 });
  });

  it('an unknown viewport (page replica) has no delta', () => {
    expect(svgGroupChildStartPosition(NODE, 'tablet')).toEqual({ x: 44, y: 229 });
  });

  it('empty-string variant values (deleted override) contribute zero delta', () => {
    const node = { ...NODE, motionVariants: { 'variant-1': { x: '', y: '' } } };
    expect(svgGroupChildStartPosition(node, 'variant-1')).toEqual({ x: 44, y: 229 });
  });

  it('numeric variant values and negative deltas work', () => {
    const node = { attrs: { x: '10', y: '20' }, motionVariants: { 'variant-1': { x: 12 as unknown as string, y: -8 as unknown as string } } };
    expect(svgGroupChildStartPosition(node, 'variant-1')).toEqual({ x: 22, y: 12 });
  });

  it('attrX/attrY (current format) are ABSOLUTE and win over base attrs', () => {
    const node = { attrs: { x: '44', y: '229' }, motionVariants: { 'variant-1': { attrX: '204', attrY: '121' } } };
    expect(svgGroupChildStartPosition(node, 'variant-1')).toEqual({ x: 204, y: 121 });
  });

  it('per-variant SCALE shifts the painted top-left by base·(1−s)/2 (fill-box-center math)', () => {
    // The LeDaJo resize-offset case (2026-06-12): painted left of a scaled
    // child = attrX + dx + w·(1 − sx)/2. Baselines that ignored the scale term
    // ran the gesture in the base frame and the commit relocated the box.
    const node = {
      attrs: { x: '84', y: '74', width: '68', height: '153' },
      motionVariants: { 'variant-1': { x: '-16', y: '0', scaleX: '1.4706' } },
    };
    // 84 − 16 + 68·(1 − 1.4706)/2 = 84 − 16 − 16 = 52
    const pos = svgGroupChildStartPosition(node, 'variant-1');
    expect(pos.x).toBeCloseTo(52, 1);
    expect(pos.y).toBeCloseTo(74, 5);
  });

  it('attrX wins even when a legacy x delta coexists', () => {
    const node = { attrs: { x: '44', y: '229' }, motionVariants: { 'variant-1': { attrX: '204', x: '67', attrY: '121', y: '-192' } } };
    expect(svgGroupChildStartPosition(node, 'variant-1')).toEqual({ x: 204, y: 121 });
  });

  it('no node / no attrs → 0,0', () => {
    expect(svgGroupChildStartPosition(null, 'variant-1')).toEqual({ x: 0, y: 0 });
  });
});


describe('DragCoordinator — central renderer drag-locks', () => {
  let containerEl: HTMLElement;
  let contentEl: HTMLElement;

  beforeEach(() => {
    containerEl = document.createElement('div');
    contentEl = document.createElement('div');
    vi.clearAllMocks();
  });

  test('locks the dragged node on start and releases SYNCHRONOUSLY on mouseup (no deferred truth-up render)', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);
    const strategy = createMockStrategy('canvas', { canHandle: true });
    (coordinator as any).strategies = [strategy];
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(100, 200, 100, 50));

    coordinator.startPending('node-1', new MouseEvent('mousedown', { clientX: 110, clientY: 210 }));
    coordinator.handleMouseMove(new MouseEvent('mousemove', { clientX: 130, clientY: 230 }));

    // Start: the dragged node is renderer-locked so mid-drag renders never
    // re-apply commit-time coords to it (the off/on jump at reparent).
    expect(mockSetDragLockedNodeIds).toHaveBeenCalledWith(['node-1']);

    coordinator.handleMouseUp();
    // Unlock is SYNCHRONOUS in reset(), BEFORE the drop flush — so the single
    // drop render reconciles the dropped node (clears its drag transform,
    // applies committed left/top). No 120ms deferred full re-render + measure.
    const calls = mockSetDragLockedNodeIds.mock.calls;
    expect(calls[calls.length - 1][0]).toEqual([]);
  });

  test('unlock precedes the drop flush (drop render reconciles the dropped node)', () => {
    // Order guard: setCentralDragLocks([]) must be called BEFORE flushNow(),
    // or the drop render skips the still-locked node and its drag transform
    // survives (double-applied position). We assert relative call order via
    // a shared sequence log.
    const seq: string[] = [];
    mockSetDragLockedNodeIds.mockImplementation((ids: string[]) => {
      if (ids.length === 0) seq.push('unlock');
    });
    vi.mocked(flushNow).mockImplementation(() => { seq.push('flush'); });

    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);
    const strategy = createMockStrategy('canvas', { canHandle: true });
    (coordinator as any).strategies = [strategy];
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(100, 200, 100, 50));

    coordinator.startPending('node-1', new MouseEvent('mousedown', { clientX: 110, clientY: 210 }));
    coordinator.handleMouseMove(new MouseEvent('mousemove', { clientX: 130, clientY: 230 }));
    coordinator.handleMouseUp();

    expect(seq).toEqual(['unlock', 'flush']);
  });

  test('does not clobber layout-lifted strategy-managed locks', () => {
    const callbacks = makeCallbacks();
    const coordinator = new DragCoordinator(containerEl, contentEl, callbacks);
    const strategy = createMockStrategy('layout-lifted', { canHandle: true });
    (coordinator as any).strategies = [strategy];
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(100, 200, 100, 50));

    coordinator.startPending('node-1', new MouseEvent('mousedown', { clientX: 110, clientY: 210 }));
    coordinator.handleMouseMove(new MouseEvent('mousemove', { clientX: 130, clientY: 230 }));

    // layout-lifted sets its own richer lock set in onStart — the central
    // path must not overwrite it at start (only clear on reset).
    expect(mockSetDragLockedNodeIds).not.toHaveBeenCalledWith(['node-1']);
  });
});

// ─── Subtree cache nudge — cycle guard ───────────────────────────────────────
// A corrupt node cache with a parentId/children cycle (collection-list
// drag-out, 2026-07-29) blew the recursive descendant walk with a stack
// overflow. The walk must visit each node at most once and still nudge the
// acyclic part of the subtree.

describe('DragCoordinator — nudgeDraggedSubtreeCaches cycle guard', () => {
  test('survives a cyclic node cache and shifts each descendant once', async () => {
    const { injectNodeIntoCache } = await import('@/code/stores/store');
    const bare = (id: string, children: string[], parentId: string | null) => ({
      id, type: 'div', name: '', parentId, children, styles: {}, textContent: '',
      attrs: {}, hasMixedContent: false, order: 0, isCanvasNode: parentId === null,
      componentFile: null, componentInstanceId: null, isComponentRoot: false,
      motionVariants: null, motionVariantsRef: null, motionProps: null,
      responsiveVariantMap: null, conditionalStyles: null,
    } as any);
    // Cycle: ndg-a → ndg-b → ndg-a (never producible via moveNodeInCache —
    // its guard refuses — but injectable by a buggy write path).
    injectNodeIntoCache(bare('ndg-a', ['ndg-b'], null));
    injectNodeIntoCache(bare('ndg-b', ['ndg-a'], 'ndg-a'));

    const shift = vi.fn();
    const { getCanvasBridge } = await import('@/canvas/canvas-bridge');
    vi.mocked(getCanvasBridge).mockReturnValue({
      getRect: vi.fn(() => null),
      setDragLockedNodeIds: vi.fn(),
      shiftCachedSubtree: shift,
    } as any);
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(100, 100, 50, 50));

    const coordinator = new DragCoordinator(document.createElement('div'), document.createElement('div'), makeCallbacks());
    (coordinator as any).dragStartRootRects.set('ndg-a', { left: 0, top: 0, width: 50, height: 50 });

    // Without the `seen` guard this recursed forever (RangeError).
    (coordinator as any).nudgeDraggedSubtreeCaches(['ndg-a'], 'desktop');

    expect(shift).toHaveBeenCalledTimes(1);
    expect(shift).toHaveBeenCalledWith(['ndg-b'], 100, 100);
  });
});
