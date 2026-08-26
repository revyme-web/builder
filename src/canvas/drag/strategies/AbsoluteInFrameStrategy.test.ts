// AbsoluteInFrameStrategy.test.ts — Unit tests for absolute-in-frame drag strategy.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AbsoluteInFrameStrategy } from './AbsoluteInFrameStrategy';
import { dropDynamicStyleBindings, buildCanvasCloneDescriptor } from '../clone-descriptor';
import type { DragContext } from '../types';
import type { DraggedNode, Transform } from '@/shared/types';
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
  isInsideRect: vi.fn(() => false),
}));

vi.mock('../handlers/snap-handler', () => ({
  calculateSnap: vi.fn(() => ({
    x: 0, y: 0, snappedX: false, snappedY: false, guides: [], spacingGuides: [],
  })),
  getMouseVelocity: vi.fn(() => 0),
}));

// Ruler guides feed extra snap lines into calculateSnap each onMove; the
// real store derives from activeFilePathAtom which isn't part of this
// test's active-file-store mock.
vi.mock('@/code/stores/ruler-guides-store', () => ({
  getActiveRulerGuideSnapLines: vi.fn(() => []),
}));

vi.mock('@/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/constants')>();
  return {
    ...actual,
    SNAP_THRESHOLD: 5,
    DEFAULT_VIEWPORT_WIDTH: 1440,
    canAcceptChildren: vi.fn(() => true),
    // The strategies call the NODE-aware predicate now. `nodeAcceptsChildren`
    // calls the real `canAcceptChildren` internally (module-local call — the
    // mock above can't intercept it), so it has to be overridden too or this
    // harness's "every frame accepts children" intent silently lapses.
    nodeAcceptsChildren: vi.fn(() => true),
  };
});

vi.mock('@/code/project/active-file-store', () => {
  const { atom } = require('jotai');
  return {
    isComponentFilePath: vi.fn(() => false),
    // Container-set master detection — consulted by onMove's snap-sibling
    // collection and the exit-destination rule. Plain pages → false.
    isIconSetFilePath: vi.fn(() => false),
    activeCodeAtom: atom(''),
    // The exit commit re-reads nodesAtom (for overlay-follow re-arm), whose
    // derivation walks these active-file helpers.
    activeFilePathAtom: atom('app/page.tsx'),
    isLayoutFile: vi.fn(() => false),
    getLayoutForPage: vi.fn(() => null),
    getLayoutClientPath: vi.fn(() => ''),
    isComponentLikeFilePath: vi.fn(() => false),
    filePathToSlug: vi.fn(() => '/'),
  };
});

vi.mock('@/code/stores/viewport-store', () => {
  const { atom } = require('jotai');
  return {
    getViewportWidths: vi.fn(() => ({ desktop: 1440, tablet: 768, mobile: 375 })),
    getSortedBreakpointWidths: vi.fn(() => [1440, 768, 375]),
    // onStart now reads the dynamic viewport config list to merge replica
    // @media overrides into the inset snapshot (viewportsConfigAtom), and
    // overlay-follow reads visibleViewportsAtom during the exit commit.
    viewportsConfigAtom: atom([
      { id: 'desktop', width: 1440 },
      { id: 'tablet', width: 768 },
      { id: 'mobile', width: 375 },
    ]),
    visibleViewportsAtom: atom([]),
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
}));

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNowDeferredDuringDrag: vi.fn(), flushNow: vi.fn(),
  // The variant-exit clone copies the subtree's ::after border-overlay rules
  // (`queueBorderOverlayDuplicates`), which reads the live code for its <style>
  // block. Empty string = "no border rules to copy" → early return.
  getCurrentCode: vi.fn(() => ''),
}));

// Observable bridge — the clone exit hands the drag lock to the clone through
// it, and the ORDER of that call relative to the forced render is the contract
// under test (see the ghost-copy case at the bottom of this file).
const bridgeCalls: string[] = [];
const mockSetDragLockedNodeIds = vi.fn((ids: string[]) => { bridgeCalls.push(`lock:${ids.join(',')}`); });
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => ({
    setDragLockedNodeIds: (ids: string[]) => mockSetDragLockedNodeIds(ids),
    reparentLive: vi.fn(),
    patchStyles: vi.fn(),
    liveRefitGroup: vi.fn(),
    patchAttrsAndStyles: vi.fn(),
  }),
}));

vi.mock('@/shared/dom-utils', () => ({
  getStyleNum: vi.fn((el: HTMLElement, prop: string) => parseFloat((el.style as any)[prop]) || 0),
}));

// DELEGATING spy over the real seed. The clone exits re-seed the imperative
// node cache from the post-flush code, and that is the half of the fix that
// makes the forced render actually ship (see the mount-gating test at the
// bottom of this file) — so the call site has to be observable, and its
// ORDER relative to flushNow/forceCanvasRender has to be pinned.
const seedNodesForCodeSpy = vi.fn();
vi.mock('@/code/stores/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/stores/store')>();
  return {
    ...actual,
    seedNodesForCode: (...args: Parameters<typeof actual.seedNodesForCode>) => {
      seedNodesForCodeSpy(...args);
      return actual.seedNodesForCode(...args);
    },
  };
});

vi.mock('@/shared/pin-utils', () => ({
  getInsetState: vi.fn(() => ({
    pins: { left: false, right: false, top: false, bottom: false },
    mode: 'default',
    horizontalInset: false,
    verticalInset: false,
    fullInset: false,
  })),
  // Real behavior is pinned in pin-utils.test.ts; a passthrough keeps this
  // suite's fixture styles (which have no motionVariants) unchanged.
  mergeVariantPinStyles: vi.fn((styles: Record<string, string>) => styles),
}));

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    detectParentLayoutById: vi.fn(() => 'absolute'),
    getFlexDirectionById: vi.fn(() => 'column'),
  };
});

// Mock node-ops with controllable return values
const mockPatchNodeStyles = vi.fn();
const mockFindNodeRect = vi.fn<(nodeId: string, vpId: string) => DOMRect | null>(() => null);
const mockFindNodeComputedStyle = vi.fn<(nodeId: string, vpId: string, prop: string) => string>(() => '');

vi.mock('@/canvas/node-ops', () => ({
  updateNodeStyles: vi.fn(),
  patchNodeStyles: (...args: any[]) => mockPatchNodeStyles(args[0], args[1], args[2], args[3], args[4]),
  patchElementStyles: (el: HTMLElement, styles: Record<string, string>, important?: boolean) => {
    for (const [k, v] of Object.entries(styles)) {
      try {
        if (v === '') { (el.style as any)[k] = ''; }
        else if (important) { el.style.setProperty(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v, 'important'); }
        else { (el.style as any)[k] = v; }
      } catch {}
    }
  },
  getActiveFilePath: vi.fn(() => 'app/page.tsx'),
  vpIdFromPrefix: vi.fn((prefix: string) => !prefix ? 'desktop' : prefix.endsWith('-') ? prefix.slice(0, -1) : prefix),
  isPrimaryViewport: vi.fn((vpId: string) => vpId === 'desktop' || vpId === 'default' || !vpId),
  // Bridge helpers
  findNodeRect: (...args: any[]) => mockFindNodeRect(args[0], args[1]),
  findNodeComputedStyle: (...args: any[]) => mockFindNodeComputedStyle(args[0], args[1], args[2]),
  // Plural variant — used by the dynamic-pin snapshot to read un-rotated
  // CSS box width/height. Returns an object keyed by the requested
  // properties. Tests don't exercise rotated dynamic-pin scenarios, so
  // returning sentinel '0px' values is fine — the strategy's `Number.isFinite`
  // guard falls back to `node.width / scale` when parseFloat yields 0.
  findNodeComputedStyles: (..._args: any[]) => ({ width: '0px', height: '0px' }),
  findChildRects: vi.fn(() => []),
  // Newer node-ops APIs the strategy (and its bridge helpers) now call:
  // sibling-entry hit-testing, post-exit re-render, viewport prefix lookup
  // (geometry-utils), overlay-follow, and canvas CSS injection.
  getNodeHitsAtPoint: vi.fn(() => []),
  findRootHitAtPoint: vi.fn(() => null),
  forceCanvasRenderDeferredDuringDrag: vi.fn(), forceCanvasRender: vi.fn(),
  getViewportPrefix: vi.fn((vpId: string) =>
    !vpId || vpId === 'desktop' || vpId === 'default' ? '' : `${vpId}-`,
  ),
  getContentRootRect: vi.fn(() => null),
  injectCanvasCSS: vi.fn(),
  removeCanvasCSS: vi.fn(),
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

/** Create a minimal CanvasNode for the nodes map (only fields needed by canHandle) */
function makeNode(id: string, parentId: string | null): any {
  return { id, parentId };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AbsoluteInFrameStrategy', () => {
  let strategy: AbsoluteInFrameStrategy;

  beforeEach(() => {
    strategy = new AbsoluteInFrameStrategy();
    vi.clearAllMocks();
    // Reset bridge mock defaults
    mockFindNodeRect.mockReturnValue(null);
    mockFindNodeComputedStyle.mockReturnValue('');
  });

  // ─── canHandle ────────────────────────────────────────────────────────

  describe('canHandle', () => {
    test('returns true when parent node exists in NodeMap with a parentId (nested frame)', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent is viewport root (canHandle no longer rejects viewport-root parents)', () => {
      // canHandle now accepts ANY parent that exists in the NodeMap — where
      // the drag exits to (canvas vs grandparent) is decided at onStart via
      // `exitDestination`, not by strategy selection.
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', null)],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent has parentId and display is flex', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent has parentId and display is inline-flex', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent has parentId and display is grid', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns true when parent has parentId and display is inline-grid', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(true);
    });

    test('returns false when no startParentId', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: null })],
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when parent node not found in NodeMap', () => {
      // nodes map is empty — parent-1 not present
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when no dragged nodes', () => {
      const ctx = makeContext({ draggedNodes: [] });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    // (Deleted: "returns true when parent is viewport root but file is a
    // component" — canHandle no longer consults isComponentFilePath at all;
    // the viewport-root case above covers the same accept path.)

    test('returns false when the dragged node is a canvas node', () => {
      // Canvas nodes are free-floating — CanvasDragStrategy owns them.
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
        ['node-1', { id: 'node-1', parentId: 'parent-1', isCanvasNode: true }],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });

    test('returns false when the parent is template chrome (layout:: prefix)', () => {
      // Template-merged nodes belong to the layout file — never draggable
      // through this strategy on a page.
      const nodes = new Map([
        ['layout::header', makeNode('layout::header', 'layout::root')],
      ]) as any;
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'layout::header' })],
        nodes,
      });
      expect(strategy.canHandle(ctx)).toBe(false);
    });
  });

  // ─── onStart ──────────────────────────────────────────────────────────

  describe('onStart', () => {
    test('initializes state without DOM access', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
      });

      // Should not throw — initializes internal state via bridge helpers
      expect(() => strategy.onStart(ctx)).not.toThrow();
    });

    test('resets exit/entry state between drags', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });

      // First drag
      strategy.onStart(ctx);

      // Second drag — should reset state cleanly
      strategy.onStart(ctx);

      // Verify by checking that onEnd returns normal in-frame updates (not exit updates)
      const updates = strategy.onEnd(ctx);
      // Should be style updates, not 'move' (exit reparent)
      for (const u of updates) {
        expect(u.type).toBe('style');
      }
    });
  });

  // ─── Exit detection ───────────────────────────────────────────────────

  describe('exit detection', () => {
    // EXIT_FRAME_THRESHOLD is now 1 (was 5): touching the canvas with any
    // element corner unparents instantly once the entry grace has elapsed.
    test('exit fires on the first post-grace frame the element is outside (EXIT_FRAME_THRESHOLD = 1)', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Element INSIDE the parent while the 10-frame entry grace elapses.
      // The first post-grace frame samples `startedNotFullyInside = false`,
      // keeping the element-rect exit predicate in charge.
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return new DOMRect(50, 50, 100, 100);
      });
      for (let i = 0; i < 10; i++) {
        const result = strategy.onMove(ctx, { x: 500, y: 300 });
        expect(result.switchRequest).toBeUndefined();
      }

      // Element moves fully outside → exit commits (code-first, live) and
      // the strategy switch fires on this very frame.
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(600, 50, 100, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });
      const result = strategy.onMove(ctx, { x: 600, y: 300 });
      expect(result.switchRequest).toBeDefined();
      expect(result.switchRequest!.toStrategy).toBe('canvas');
      expect(result.switchRequest!.reason).toBe('parent-exit');
    });

    // (Replaced: "framesOutsideParent resets when element moves back inside" —
    // with EXIT_FRAME_THRESHOLD = 1 there is no multi-frame counter to reset.
    // The surviving hysteresis is the pre-existing-overflow rule below.)
    test('pre-existing overflow: exit waits for the CURSOR to leave the parent', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 200, y: 200 },
      });
      strategy.onStart(ctx);

      // Element rect is outside the parent from the very first exit-check
      // frame → `startedNotFullyInside` samples true. The permanently-true
      // "not fully inside" test can't express intent for a pre-overflowing
      // element, so exit is gated on the cursor leaving the parent instead.
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(600, 50, 100, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });

      // Grace (10 frames) + 4 post-grace frames with the cursor still INSIDE
      // the parent (200, 200) → no exit despite the element rect being outside.
      for (let i = 0; i < 14; i++) {
        const result = strategy.onMove(ctx, { x: 200, y: 200 });
        expect(result.switchRequest).toBeUndefined();
      }

      // Cursor leaves the parent → exit fires on that frame.
      const result = strategy.onMove(ctx, { x: 600, y: 300 });
      expect(result.switchRequest).toBeDefined();
      expect(result.switchRequest!.toStrategy).toBe('canvas');
      expect(result.switchRequest!.reason).toBe('parent-exit');
    });
  });

  // ─── Entry grace counter ──────────────────────────────────────────────

  describe('entry grace counter', () => {
    test('blocks exit detection for N frames after onStart', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Element is fully outside from the very start (via bridge rects)
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(600, 50, 100, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });

      // During the first 9 frames, grace counter is still > 0, so exit detection is blocked.
      for (let i = 0; i < 9; i++) {
        const result = strategy.onMove(ctx, { x: 600, y: 300 });
        expect(result.switchRequest).toBeUndefined();
      }

      // Frame 10: grace expires. Element outside on its first check frame →
      // the pre-existing-overflow rule gates on the CURSOR, which is also
      // outside → exit commits on this frame (EXIT_FRAME_THRESHOLD = 1, so
      // there is no multi-frame exit counter after the grace anymore).
      const result = strategy.onMove(ctx, { x: 600, y: 300 });
      expect(result.switchRequest).toBeDefined();
      expect(result.switchRequest!.toStrategy).toBe('canvas');
    });
  });

  // ─── onEnd ────────────────────────────────────────────────────────────

  describe('onEnd', () => {
    test('returns style updates for normal in-frame drop', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Move to populate lastStyles
      strategy.onMove(ctx, { x: 520, y: 330 });

      const updates = strategy.onEnd(ctx);

      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0].nodeId).toBe('node-1');
      expect(updates[0].type).toBe('style');
      expect(updates[0].styles).toHaveProperty('left');
      expect(updates[0].styles).toHaveProperty('top');
    });

    test('clears visual stores on end', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
      });
      strategy.onStart(ctx);
      strategy.onEnd(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
    });
  });

  // ─── Viewport detection from DOM ─────────────────────────────────────

  describe('getDropViewportId — uses cached vpId', () => {
    test('returns tablet when viewportPrefix is tablet-', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        viewportPrefix: 'tablet-',
      });
      strategy.onStart(ctx);
      expect(strategy.getDropViewportId(ctx)).toBe('tablet');
    });

    test('returns desktop when viewportPrefix is empty', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        viewportPrefix: '',
      });
      strategy.onStart(ctx);
      expect(strategy.getDropViewportId(ctx)).toBe('desktop');
    });

    test('returns mobile when viewportPrefix is mobile-', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        viewportPrefix: 'mobile-',
      });
      strategy.onStart(ctx);
      expect(strategy.getDropViewportId(ctx)).toBe('mobile');
    });
  });

  // ─── onCancel ─────────────────────────────────────────────────────────

  describe('onCancel', () => {
    test('restores start positions via patchNodeStyles', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ id: 'node-1', startLeft: 50, startTop: 60, startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      strategy.onCancel(ctx);

      // onCancel now also restores the lift-time transform ('' here — no
      // pre-drag transform) atomically with the start left/top, clearing
      // any per-frame translate the drag had written.
      expect(mockPatchNodeStyles).toHaveBeenCalledWith(
        ctx.contentEl, 'node-1', '', { left: '50px', top: '60px', transform: '' }, undefined,
      );
    });

    test('clears visual stores on cancel', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
      });
      strategy.onStart(ctx);
      strategy.onCancel(ctx);

      expect(dropLineOps.hide).toHaveBeenCalled();
      expect(parentHighlightOps.hide).toHaveBeenCalled();
    });

    test('always succeeds (no DOM dependency)', () => {
      const ctx = makeContext({
        draggedNodes: [makeDraggedNode({ startParentId: 'parent-1' })],
      });

      strategy.onStart(ctx);
      expect(() => strategy.onCancel(ctx)).not.toThrow();
    });
  });

  // ─── Parent exit with inset resolution ────────────────────────────────

  describe('parent exit resolves inset dimensions', () => {
    test('element with right+bottom insets gets width/height on exit, insets cleared', () => {
      // Set up node with right+bottom insets in NodeMap
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
        ['node-1', { id: 'node-1', parentId: 'parent-1', tag: 'div', styles: {
          position: 'absolute', left: '10px', right: '20px', top: '5px', bottom: '15px',
        }}],
      ]) as any;

      const ctx = makeContext({
        nodes,
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);

      // Mock bridge rects for exit detection: element far outside parent
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(2000, 50, 200, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });

      // Exhaust grace period (10 frames) + 1 outside frame (EXIT_FRAME_THRESHOLD
      // is now 1 — instant unparent) = 11 moves. Cursor is outside the parent
      // too, satisfying the pre-existing-overflow cursor gate.
      for (let i = 0; i < 11; i++) {
        strategy.onMove(ctx, { x: 2000 + i, y: 300 });
      }

      // Code-first exit: move mutation committed via flushNow during onMove
      expect(queueMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'move',
          nodeId: 'node-1',
          newParentId: null,
          canvasNode: true,
          styles: expect.objectContaining({
            position: 'absolute',
            width: '200px',
            height: '100px',
            right: '',
            bottom: '',
          }),
        }),
      );
      // Plain unparent exits DEFER the flush now (drop drains in one chain).
      expect(flushNowDeferredDuringDrag).toHaveBeenCalled();

      // onEnd returns position-only style updates (move already committed)
      const updates = strategy.onEnd(ctx);
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0].type).toBe('style');
    });
  });

  // ─── Component-VARIANT exit must mount the clone MID-DRAG ─────────────
  //
  // The variant exit doesn't move the source — it queues `addCanvasNode` for a
  // brand-new CLONE and swaps the drag identity onto it. Nothing imperative can
  // create that element's DOM, so the exit has to run the FULL synchronous
  // pipeline right there. The deferred helpers only log and latch
  // (`flushNowDeferredDuringDrag` returns without flushing;
  // `forceCanvasRenderDeferredDuringDrag` just sets `_forceRenderOnNextFlush`)
  // and the queue gate then HOLDS the mutations until the drop — so taking the
  // deferred branch here left the clone with NO element for the entire drag:
  // 391 null `getScreenCornersById` lookups in one traced 2.4s drag, the
  // element frozen at its exit position until mouseup (user report 2026-08-03).
  describe('component-variant exit flushes synchronously', () => {
    test('queues the clone AND runs flushNow + forceCanvasRender, not the deferred pair', async () => {
      const { isComponentFilePath } = await import('@/code/project/active-file-store');
      const { forceCanvasRender, forceCanvasRenderDeferredDuringDrag } = await import('@/canvas/node-ops');
      vi.mocked(isComponentFilePath).mockReturnValue(true);

      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
        ['node-1', {
          id: 'node-1', parentId: 'parent-1', type: 'div', name: 'Card', tag: 'div',
          children: [], attrs: {},
          styles: { position: 'absolute', left: '10px', top: '5px' },
        }],
      ]) as any;

      // `viewportPrefix: 'variant-1-'` on a component file IS the variant-exit
      // condition (isComponentFile && viewportPrefix !== '').
      const ctx = makeContext({
        nodes,
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
        viewportPrefix: 'variant-1-',
      });
      strategy.onStart(ctx);

      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(2000, 50, 200, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });
      for (let i = 0; i < 11; i++) {
        strategy.onMove(ctx, { x: 2000 + i, y: 300 });
      }

      // The clone is queued (fresh id — never the source's).
      const addCanvasNodeCalls = vi.mocked(queueMutation).mock.calls
        .filter(([m]) => (m as { type: string }).type === 'addCanvasNode');
      expect(addCanvasNodeCalls).toHaveLength(1);
      const cloneId = (addCanvasNodeCalls[0][0] as { node: { id: string } }).node.id;
      expect(cloneId).not.toBe('node-1');

      // …and the drag identity is now the clone, so the element the rest of the
      // drag patches is the one `addCanvasNode` creates.
      expect(ctx.draggedNodes[0].id).toBe(cloneId);

      // THE REGRESSION: the clone's element only exists if BOTH of these run
      // now. The deferred pair would leave it unmounted until mouseup.
      expect(flushNow).toHaveBeenCalled();
      expect(forceCanvasRender).toHaveBeenCalled();
      expect(flushNowDeferredDuringDrag).not.toHaveBeenCalled();
      expect(forceCanvasRenderDeferredDuringDrag).not.toHaveBeenCalled();

      // THE GHOST-COPY CONTRACT. The renderer SKIPS removing a drag-locked
      // element (a lifted node lives at the content root mid-gesture and must
      // not be wiped). The lock set is sandbox state updated by its own bridge
      // message, and DragCoordinator only moves the lock onto the swapped id
      // AFTER this strategy returns — i.e. BEHIND the render. The sandbox then
      // rendered still believing the SOURCE was locked, kept the source's
      // element in the variant tile although the map no longer had it, and the
      // user saw a duplicate sitting on the variant root for the rest of the
      // drag (gone on mouseup, when the unlocked render finally swept it —
      // design-component masters, 2026-08-04). Locking the CLONE before the
      // render is not the answer either — `patchCanvasNodes`' build branch
      // skips locked nodes too, and a brand-new clone has no element anywhere,
      // so it would never be created (the follow-up report: "the node
      // completely disappears until I mouse up"). The set in force across the
      // render must contain NEITHER id; the clone is locked after.
      const renderOrder = vi.mocked(forceCanvasRender).mock.invocationCallOrder[0];
      const lockCalls = mockSetDragLockedNodeIds.mock.calls;
      const lockOrders = mockSetDragLockedNodeIds.mock.invocationCallOrder;

      // THE set in force at render time is the LAST one posted before it.
      let effective: string[] | null = null;
      for (let i = 0; i < lockCalls.length; i++) {
        if (lockOrders[i] < renderOrder) effective = lockCalls[i][0];
      }
      expect(effective).not.toBeNull();
      // Neither id may be locked across the render:
      //   source locked  → its stale element survives the remove sweep (ghost);
      //   clone locked   → the build branch skips it and it is never created.
      expect(effective).not.toContain('node-1');
      expect(effective).not.toContain(cloneId);

      // …and the clone IS locked again once the render has been posted, so no
      // later render wipes or resurrects it.
      const relockIdx = lockCalls.findIndex((c, i) => lockOrders[i] > renderOrder && c[0].includes(cloneId));
      expect(relockIdx).toBeGreaterThanOrEqual(0);
      // The SOURCE is never locked again after the swap.
      expect(mockSetDragLockedNodeIds).not.toHaveBeenCalledWith(['node-1']);

      // …and the cache seed runs BETWEEN them. Order is the whole point: the
      // forced render reads the imperative cache mid-gesture, so a seed after
      // it (or no seed at all) leaves the render skipped by the integrity
      // guard and the clone unmounted.
      expect(seedNodesForCodeSpy).toHaveBeenCalled();
      const flushOrder = vi.mocked(flushNow).mock.invocationCallOrder[0];
      const seedOrder = seedNodesForCodeSpy.mock.invocationCallOrder[0];
      expect(flushOrder).toBeLessThan(seedOrder);
      expect(seedOrder).toBeLessThan(renderOrder);
    });

    test('a plain (non-clone) unparent exit still defers — no mid-drag pipeline', () => {
      const nodes = new Map([
        ['parent-1', makeNode('parent-1', 'grandparent-1')],
        ['node-1', { id: 'node-1', parentId: 'parent-1', type: 'div', tag: 'div', children: [], attrs: {},
          styles: { position: 'absolute', left: '10px', top: '5px' } }],
      ]) as any;
      const ctx = makeContext({
        nodes,
        draggedNodes: [makeDraggedNode({ id: 'node-1', startParentId: 'parent-1' })],
        startMouse: { x: 500, y: 300 },
      });
      strategy.onStart(ctx);
      mockFindNodeRect.mockImplementation((nodeId: string) => {
        if (nodeId === 'node-1') return new DOMRect(2000, 50, 200, 100);
        if (nodeId === 'parent-1') return new DOMRect(0, 0, 400, 400);
        return null;
      });
      for (let i = 0; i < 11; i++) strategy.onMove(ctx, { x: 2000 + i, y: 300 });

      // The expensive synchronous pipeline stays off the common path.
      expect(flushNowDeferredDuringDrag).toHaveBeenCalled();
      expect(flushNow).not.toHaveBeenCalled();
      expect(seedNodesForCodeSpy).not.toHaveBeenCalled();
    });
  });
});

// The gate the clone has to clear to become a real element mid-drag. During a
// gesture Canvas.tsx's forced render reads the IMPERATIVE node cache (codeAtom
// is stale — the setCode fan-out is stashed) and refuses to render a map that
// lags the committed code, because doing so rebuilds the canvas WITHOUT a
// just-committed node (live find 2026-07-29: a freshly drawn frame vanished).
// A brand-new clone is exactly such a node, so the exit's flush alone leaves
// the render skipped forever — the element only appears at mouseup. Re-seeding
// the cache from the flushed code satisfies the guard on the merits.
describe('render-integrity guard — why the clone exit re-seeds the node cache', () => {
  const page = (extra: string) => `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="src-1" data-name="Card" style={{ position: 'absolute' }}></div>${extra}
    </div>
  );
}`;
  const WITHOUT_CLONE = page('');
  const WITH_CLONE = page('\n      <div data-id="detach-clone-1" data-name="Card" style={{ position: \'absolute\' }}></div>');

  test('a cache that lags the committed code SKIPS the render; seeding un-skips it', async () => {
    const { seedNodesForCode, getCachedNodesMap } = await import('@/code/stores/store');
    const { shouldSkipLaggingForcedRender } = await import('@/canvas/render-integrity');

    // Pre-flush state: the clone exists in code but not in the cache.
    seedNodesForCode(WITHOUT_CLONE);
    expect(getCachedNodesMap().has('detach-clone-1')).toBe(false);
    expect(shouldSkipLaggingForcedRender(WITH_CLONE, getCachedNodesMap())).toBe(true);

    // What the exit now does after flushNow: re-derive from the committed code.
    seedNodesForCode(WITH_CLONE);
    expect(getCachedNodesMap().has('detach-clone-1')).toBe(true);
    expect(shouldSkipLaggingForcedRender(WITH_CLONE, getCachedNodesMap())).toBe(false);
  });
});

describe('dropDynamicStyleBindings — canvas clone dormancy', () => {
  test('drops `var:` motion-value/ref bindings, keeps static styles', () => {
    const out = dropDynamicStyleBindings({
      scale: 'var:frameXFxCScale',
      opacity: 'var:frameXFxCOpacity',
      y: 'var:frameXFxCY',
      position: 'absolute',
      left: '100px',
      width: '200px',
      transform: '',
    });
    expect(out).toEqual({ position: 'absolute', left: '100px', width: '200px', transform: '' });
    expect('scale' in out).toBe(false);   // dead motion-value binding gone (would crash module scope)
    expect('opacity' in out).toBe(false);
  });
  test('no-op when there are no dynamic bindings', () => {
    const styles = { left: '0px', top: '0px', backgroundColor: 'red' };
    expect(dropDynamicStyleBindings(styles)).toEqual(styles);
  });
});

describe('buildCanvasCloneDescriptor — bakes the source viewport/variant', () => {
  const RESP = '{"375":{"initialVariant":"variant-2"},"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}';
  const makeInstanceNode = () => new Map<string, any>([
    ['inst', { id: 'inst', type: 'GoSeKu', name: 'Frame', styles: { width: '300px' }, children: [],
      attrs: { 'data-responsive': RESP, ref: 'var:instRef' } }],
  ]);

  test('page replica: bakes data-responsive[sourceVpWidth] as explicit initialVariant', () => {
    const desc = buildCanvasCloneDescriptor('inst', makeInstanceNode(), new Map(), 768)!;
    expect(desc.attrs!.initialVariant).toBe('variant-1');  // tablet (768) variant baked, not the base
    expect(desc.attrs!.ref).toBeUndefined();               // dead ref dropped
  });

  test('page replica: a different source vp width bakes its own variant', () => {
    const desc = buildCanvasCloneDescriptor('inst', makeInstanceNode(), new Map(), 375)!;
    expect(desc.attrs!.initialVariant).toBe('variant-2');  // mobile (375)
  });

  test('component-variant exit: bakes sourceVariant directly when no data-responsive', () => {
    const nodes = new Map<string, any>([
      ['inst', { id: 'inst', type: 'GoSeKu', name: 'Frame', styles: {}, children: [], attrs: {} }],
    ]);
    const desc = buildCanvasCloneDescriptor('inst', nodes, new Map(), undefined, 'variant-1')!;
    expect(desc.attrs!.initialVariant).toBe('variant-1');
  });

  test('no baking when the source is the primary/default (no data-responsive entry, sourceVariant=desktop)', () => {
    const nodes = new Map<string, any>([
      ['inst', { id: 'inst', type: 'GoSeKu', name: 'Frame', styles: {}, children: [], attrs: {} }],
    ]);
    const desc = buildCanvasCloneDescriptor('inst', nodes, new Map(), 1440, 'desktop')!;
    expect(desc.attrs!.initialVariant).toBeUndefined();
  });
});
