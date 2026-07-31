// CanvasMouseController.test.ts — Characterization tests for redirect chain, dblclick paths,
// and shape-edit click-outside behaviour.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createStore } from 'jotai';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants')>();
  return {
    ...actual,
    DOUBLE_CLICK_THRESHOLD: 400,
    ZERO_WIDTH_SPACE: '​',
    isFrameTag: vi.fn(() => false),
  };
});

// node-ops redirect helpers
vi.mock('@/canvas/node-ops', () => ({
  redirectToComponentInstance: vi.fn((id: string) => id),
  redirectToCollectionTemplate: vi.fn(() => null),
  redirectToFitTextWrapper: vi.fn(() => null),
  redirectLayoutNodeToViewport: vi.fn(() => null),
  getIsolatedChildOfGroup: vi.fn(() => null),
  getNodeHitsAtPoint: vi.fn(() => []),
  vpIdFromPrefix: vi.fn((prefix: string) => prefix?.replace(/-$/, '') || 'desktop'),
  getViewportPrefix: vi.fn((vpId: string) => (vpId ? vpId + '-' : '')),
  getActiveFilePath: vi.fn(() => 'app/page.tsx'),
  createNode: vi.fn(() => document.createElement('div')),
}));

vi.mock('@/canvas/commands', () => ({
  redirectToTopLevelChild: vi.fn((id: string) => id),
}));

vi.mock('@/shared/ghost-id', () => ({
  isGhostNodeId: vi.fn(() => false),
  getGhostIndex: vi.fn(() => null),
  stripGhostSuffix: vi.fn((id: string) => id),
}));

vi.mock('@/canvas/transform', () => ({
  handleHandToolDown: vi.fn(() => false),
  handleHandToolMove: vi.fn(() => false),
  handleHandToolUp: vi.fn(),
  handleSpacePanDown: vi.fn(() => false),
  handleSpacePanMove: vi.fn(() => false),
  handleSpacePanUp: vi.fn(),
  isPanning: vi.fn(() => false),
  isSpacePanning: vi.fn(() => false),
  isSpaceBarDown: vi.fn(() => false),
}));

vi.mock('@/canvas/shortcuts', () => ({
}));

vi.mock('@/canvas/selection/SelectionBox', () => ({
  suppressSelectionBox: vi.fn(),
}));

vi.mock('@/canvas/creators/FrameCreator', () => ({
  startFrameCreation: vi.fn(),
}));

vi.mock('@/canvas/creators/TextCreator', () => ({
  startTextCreation: vi.fn(),
  getDefaultTextNodeStyles: vi.fn(() => ({})),
}));

vi.mock('@/canvas/creators/ShapeCreator', () => ({
  startShapeCreation: vi.fn(),
}));

vi.mock('@/canvas/creators/SketchCreator', () => ({
  startSketchCreation: vi.fn(),
}));

vi.mock('@/canvas/creators/LayoutCreator', () => ({
  startLayoutCreation: vi.fn(),
}));

vi.mock('@/code/stores/tool-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/stores/tool-store')>();
  return {
    ...actual,
    isShapeMode: vi.fn(() => false),
    isLayoutMode: vi.fn(() => false),
  };
});

vi.mock('@/canvas/component-navigation', () => ({
  enterComponentFile: vi.fn(),
}));

vi.mock('@/code/project/template-ops', () => ({
  getPageTemplate: vi.fn(() => null),
  listTemplates: vi.fn(() => []),
}));

vi.mock('@/canvas/creators/creator-utils', () => ({
  generateNodeId: vi.fn((prefix: string) => `${prefix}-test-id`),
}));
vi.mock('@/shared/id-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/id-utils')>()),
  generateNodeId: vi.fn((prefix: string) => `${prefix}-test-id`),
}));

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
}));

// ─── Store & Atom helpers ──────────────────────────────────────────────────────

// Import the real atoms so we can wire a real jotai store in tests.
// Heavy deps (project-fs, babel, etc.) are mocked above so the atom
// *declarations* load fine without real module resolution.
import {
  nodesAtom,
  selectedIdsAtom,
  mapItemIndexAtom,
} from '@/code/stores/store';

// Lightweight atom shims for atoms we need that live in other stores.
// We build a real createStore() so store.get/set/sub all work correctly.
import {
  shapeEditingIdAtom,
  groupEditingIdAtom,
  selectedPointAtom,
} from '@/code/stores/shape-edit-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { toolModeAtom } from '@/code/stores/tool-store';
import { directSelectionEnabledAtom } from '@/code/stores/user-preferences-store';

import {
  redirectToComponentInstance,
  redirectToFitTextWrapper,
  redirectLayoutNodeToViewport,
} from '@/canvas/node-ops';
import { CanvasMouseController } from './CanvasMouseController';

// ─── Factory helper ───────────────────────────────────────────────────────────

function makeMouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    clientX: 100,
    clientY: 100,
    target: document.createElement('div'),
    ...overrides,
  } as unknown as MouseEvent;
}

function makeController(storeOverride?: ReturnType<typeof createStore>) {
  const store = storeOverride ?? createStore();

  // Ensure toolModeAtom is 'select' by default
  store.set(toolModeAtom, 'select' as any);
  store.set(directSelectionEnabledAtom, true as any); // direct selection ON = no walk-up redirect

  const setSelectedIds = vi.fn((ids: string[]) => store.set(selectedIdsAtom, ids));
  const setInteractingViewport = vi.fn((vpId: string) => store.set(interactingViewportIdAtom, vpId));

  const opts = {
    jotaiStore: store,
    bridge: {} as any,
    containerRef: { current: document.createElement('div') },
    iframeRef: { current: document.createElement('iframe') } as any,
    contentRef: { current: document.createElement('div') } as any,
    dragCoordinatorRef: { current: { isDragging: false, isPending: false, hasWindowListeners: false, startPending: vi.fn(), handleMouseMove: vi.fn(), handleMouseUp: vi.fn() } } as any,
    textEditControllerRef: { current: { setEmptyFrameScaffold: vi.fn() } } as any,
    editingNodeIdRef: { current: null as string | null },
    hoverSuppressUntilRef: { current: 0 },
    canvasInteractingValRef: { current: false },
    frameCreatorCallbacksRef: { current: () => ({}) } as any,
    setBreadcrumb: vi.fn(),
    setActiveFilePath: vi.fn(),
    setUpdatingFromCanvas: vi.fn(),
    setPanCursor: vi.fn(),
    setInteractingViewport,
    setSelectedIds,
    setHoveredId: vi.fn(),
    setHoveredNodeId: vi.fn(),
    setHoveredViewport: vi.fn(),
    setMapItemIndex: vi.fn((idx: number | null) => store.set(mapItemIndexAtom, idx)),
    setShapeEditingId: vi.fn((val: any) => {
      if (typeof val === 'function') {
        store.set(shapeEditingIdAtom, val(store.get(shapeEditingIdAtom)));
      } else {
        store.set(shapeEditingIdAtom, val);
      }
    }),
    setSelectedPoint: vi.fn((p: any) => store.set(selectedPointAtom, p)),
    setGroupEditingId: vi.fn((id: string | null) => store.set(groupEditingIdAtom, id)),
    setOverlayEditingId: vi.fn(),
    startTextEdit: vi.fn(),
    commitTextEdit: vi.fn(),
    openCmsEditor: vi.fn(),
    setLeftPanel: vi.fn(),
    setToolMode: vi.fn((m: string) => store.set(toolModeAtom, m as any)),
    getCmsData: vi.fn(() => new Map()),
  };

  const controller = new CanvasMouseController(opts);
  return { controller, store, opts, setSelectedIds, setInteractingViewport };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CanvasMouseController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: Redirect chain order ────────────────────────────────────────────
  // Mock each redirect helper to chain: original → layoutRedirected (null here,
  // since layout redirect returns null for non-layout nodes) → componentRedirected
  // → fitRedirected → topLevelRedirected.
  // With direct-selection ON the topLevel redirect is bypassed.
  // The final store write must be the deepest non-null redirect's result.
  test('redirect chain: component instance redirect then fit-text redirect applied in order', () => {
    const { controller, store, setSelectedIds } = makeController();

    // Mock redirect chain:
    //   redirectLayoutNodeToViewport('original') → null (not a layout node)
    //   redirectToComponentInstance('original') → 'component-root'
    //   redirectToFitTextWrapper('component-root') → 'fit-text-wrapper'
    vi.mocked(redirectLayoutNodeToViewport).mockReturnValue(null);
    vi.mocked(redirectToComponentInstance).mockReturnValue('component-root');
    vi.mocked(redirectToFitTextWrapper).mockReturnValue('fit-text-wrapper');

    // Put a minimal node in the map so the viewport-root guard passes
    store.set(nodesAtom, new Map([
      ['original', { id: 'original', parentId: 'some-parent', type: 'div', children: [], styles: {}, name: 'Box', isCanvasNode: false }],
    ]) as any);

    const ev = makeMouseEvent({ button: 0 });
    controller.handleNodeMouseDown('original', ev, 'desktop');

    // The final selectedIdsAtom write must be ['fit-text-wrapper']
    expect(store.get(selectedIdsAtom)).toEqual(['fit-text-wrapper']);
  });

  // ── Test 2: Double-click enters component file ───────────────────────────────
  // Simulate two rapid left-clicks on the same node. The second click must
  // trigger enterComponentFile.
  test.todo(
    'double-click on component instance triggers enterComponentFile',
    // This test requires enterComponentFile to be wired up with heavy deps
    // (component-registry, projectFS, AST parse). Mocking the function is
    // feasible but the node map setup (componentFile, isMasterFilePath) has
    // many interacting pieces. Deferred until integration test suite.
  );

  // ── Test 3: Shape-edit click-outside exits shape edit and proceeds ──────────
  test('shape-edit click-outside clears shapeEditingIdAtom and selects new node', () => {
    const { controller, store, opts } = makeController();

    // Precondition: shape edit is active on 'shape-A'
    store.set(shapeEditingIdAtom, 'shape-A');

    // Put both the editing shape and the clicked node in the node map
    store.set(nodesAtom, new Map([
      ['shape-A', { id: 'shape-A', parentId: null, type: 'svg', children: [], styles: {}, name: 'Shape', isCanvasNode: false }],
      ['other-node', { id: 'other-node', parentId: 'frame-1', type: 'div', children: [], styles: {}, name: 'Box', isCanvasNode: false }],
      ['frame-1', { id: 'frame-1', parentId: null, type: 'div', children: ['other-node'], styles: {}, name: 'Frame', isCanvasNode: false }],
    ]) as any);

    // Redirect helpers return identity (no redirect)
    vi.mocked(redirectLayoutNodeToViewport).mockReturnValue(null);
    vi.mocked(redirectToComponentInstance).mockReturnValue('other-node');
    vi.mocked(redirectToFitTextWrapper).mockReturnValue(null);

    const ev = makeMouseEvent({ button: 0 });
    // Click 'other-node' which is NOT inside 'shape-A' hierarchy
    controller.handleNodeMouseDown('other-node', ev, 'desktop');

    // Exit commits via SvgEditorOverlay unmount (bridge.commitShapeEdit);
    // here we assert the exit state itself: shapeEditingIdAtom must be null
    expect(store.get(shapeEditingIdAtom)).toBeNull();
    // The new node must be selected
    expect(store.get(selectedIdsAtom)).toEqual(['other-node']);
  });
});

// ─── Multi-select: children stay reachable ──────────────────────────────────
// Pressing a child of a multi-selected node redirects the DRAG to the ancestor so
// grabbing a child still moves the whole group. It used to redirect the SELECTION
// too, which made every descendant of a multi-selection unclickable — pressing one
// just re-selected the group, so a child could never be picked without dropping the
// selection first (user report 2026-07-25). The child is now committed on mouseup
// when no drag happened.
describe('CanvasMouseController — multi-select descendants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redirectLayoutNodeToViewport).mockReturnValue(null);
    vi.mocked(redirectToComponentInstance).mockImplementation((id: string) => id);
    vi.mocked(redirectToFitTextWrapper).mockReturnValue(null);
  });

  /** tileA + tileB multi-selected; `icon` is a child of tileA. */
  function multiSelected() {
    const { controller, store, opts } = makeController();
    store.set(nodesAtom, new Map([
      ['tileA', { id: 'tileA', parentId: 'grid', children: ['icon'], styles: {}, attrs: {} }],
      ['tileB', { id: 'tileB', parentId: 'grid', children: [], styles: {}, attrs: {} }],
      ['icon', { id: 'icon', parentId: 'tileA', children: [], styles: {}, attrs: {} }],
      ['grid', { id: 'grid', parentId: null, children: ['tileA', 'tileB'], styles: {}, attrs: {} }],
    ]) as never);
    store.set(selectedIdsAtom, ['tileA', 'tileB']);
    return { controller, store, opts };
  }

  test('press on a child drags the GROUP (ancestor), leaving the selection intact', () => {
    const { controller, store, opts } = multiSelected();
    controller.handleNodeMouseDown('icon', makeMouseEvent(), 'desktop');

    // Drag target = the multi-selected ancestor.
    expect(opts.dragCoordinatorRef.current.startPending).toHaveBeenCalledWith(
      'tileA', expect.anything(), expect.anything(),
    );
    // Selection untouched while the gesture is undecided.
    expect(store.get(selectedIdsAtom)).toEqual(['tileA', 'tileB']);
  });

  test('mouseup WITHOUT a drag selects the child', () => {
    const { controller, store, opts } = multiSelected();
    controller.handleNodeMouseDown('icon', makeMouseEvent(), 'desktop');
    opts.dragCoordinatorRef.current.isDragging = false;
    opts.dragCoordinatorRef.current.isPending = true; // armed, never moved
    controller.handleMouseUp(makeMouseEvent());

    expect(store.get(selectedIdsAtom)).toEqual(['icon']);
  });

  test('mouseup AFTER a real drag keeps the group selected', () => {
    const { controller, store, opts } = multiSelected();
    controller.handleNodeMouseDown('icon', makeMouseEvent(), 'desktop');
    opts.dragCoordinatorRef.current.isDragging = true; // moved past the threshold
    controller.handleMouseUp(makeMouseEvent());

    expect(store.get(selectedIdsAtom)).toEqual(['tileA', 'tileB']);
  });

  test('a second mouseup does not re-apply a stale child pick', () => {
    const { controller, store, opts } = multiSelected();
    controller.handleNodeMouseDown('icon', makeMouseEvent(), 'desktop');
    opts.dragCoordinatorRef.current.isPending = true;
    controller.handleMouseUp(makeMouseEvent());
    store.set(selectedIdsAtom, ['tileB']);
    controller.handleMouseUp(makeMouseEvent());

    expect(store.get(selectedIdsAtom)).toEqual(['tileB']);
  });

  test('pressing a node that IS in the selection is unaffected', () => {
    const { controller, store, opts } = multiSelected();
    controller.handleNodeMouseDown('tileB', makeMouseEvent(), 'desktop');
    opts.dragCoordinatorRef.current.isPending = true;
    controller.handleMouseUp(makeMouseEvent());

    expect(store.get(selectedIdsAtom)).toEqual(['tileA', 'tileB']);
  });
});
