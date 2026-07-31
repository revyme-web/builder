// CanvasDragOrchestrator.test.ts — Unit tests for the 4-branch commit ladder.
// We mock DragCoordinator entirely and call orchestrator.commitUpdates() directly.
// See DragCoordinator.test.ts lines 1–60 for the mocking template.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CanvasDragOrchestrator, descriptorChildrenToDefs, resolveCanvasNodeRootDims, type CanvasDragOrchestratorOpts } from './CanvasDragOrchestrator';
import type { PendingUpdate } from '@/shared/types';

// A free canvas node can't resolve % dims (no flow container) — they must
// become px/auto or the section collapses to a narrow strip on drop.
describe('resolveCanvasNodeRootDims', () => {
  test('resolves width % → px against the reference width', () => {
    expect(resolveCanvasNodeRootDims({ width: '100%' }, 1440).width).toBe('1440px');
    expect(resolveCanvasNodeRootDims({ width: '50%' }, 1200).width).toBe('600px');
  });
  test('a % height becomes auto (no reference height on a free node)', () => {
    expect(resolveCanvasNodeRootDims({ height: '100%' }, 1440).height).toBe('auto');
  });
  test('leaves px / auto / unset dims untouched', () => {
    const s = resolveCanvasNodeRootDims({ width: '1120px', height: 'auto', maxWidth: '90%' }, 1440);
    expect(s.width).toBe('1120px');
    expect(s.height).toBe('auto');
    expect(s.maxWidth).toBe('90%'); // only width/height are resolved
  });
  test('does not mutate the input object', () => {
    const input = { width: '100%' };
    resolveCanvasNodeRootDims(input, 1440);
    expect(input.width).toBe('100%');
  });
});

// ─── descriptorChildrenToDefs — plugin-layout `add` child mapping ───────────────
// A plugin layout tree (canvas.startLayoutDrag) omits child ids; the mapper must
// mint unique ones or every node emits `data-id="undefined"` and the canvas
// crashes (regression: dropping a Layouts-plugin section collapsed + crashed).
describe('descriptorChildrenToDefs', () => {
  test('mints unique ids for id-less children and maps tag→type recursively', () => {
    const defs = descriptorChildrenToDefs([
      {
        tag: 'div', name: 'Row', styles: { display: 'flex' }, children: [
          { tag: 'h2', name: 'Heading', textContent: 'Hi', styles: { margin: '0' } },
          { tag: 'button', name: 'Button', textContent: 'Go', styles: {} },
        ],
      },
    ])!;
    const row = defs[0];
    expect(row.type).toBe('div');            // tag → type
    expect(row.id).toBeTruthy();             // minted
    const [h, b] = row.children;
    expect(h.type).toBe('h2');
    expect(b.type).toBe('button');
    expect(h.textContent).toBe('Hi');
    // every id present + all unique (no `data-id="undefined"` collisions)
    const ids = [row.id, h.id, b.id];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  test('preserves an id the descriptor already supplied', () => {
    const defs = descriptorChildrenToDefs([{ tag: 'p', id: 'keep-me', styles: {} }])!;
    expect(defs[0].id).toBe('keep-me');
    expect(defs[0].type).toBe('p');
  });

  test('returns undefined for no children', () => {
    expect(descriptorChildrenToDefs(undefined)).toBeUndefined();
  });
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./DragCoordinator', () => ({
  DragCoordinator: vi.fn().mockImplementation(function(this: any, containerEl: any, contentEl: any, opts: any) {
    this._opts = opts;
    this.handleMouseMove = vi.fn();
    this.handleMouseUp = vi.fn();
    this.startPending = vi.fn();
    this.startToolbarDrag = vi.fn();
    this.dispose = vi.fn();
    this.updateRefs = vi.fn();
    this.compensateAutoPan = vi.fn();
    this.isDragging = false;
    this.isPending = false;
    this.hasWindowListeners = false;
    this.lastDragViewportPrefix = '';
  }),
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('../transform', () => ({
  attachAutoPan: vi.fn(() => ({
    setActive: vi.fn(),
    onTick: vi.fn(() => vi.fn()),
    onIdle: vi.fn(() => vi.fn()),
    trackMouse: vi.fn(),
    destroy: vi.fn(),
  })),
  setActiveAutoPan: vi.fn(),
  transformManager: {
    getTransform: vi.fn(() => ({ x: 0, y: 0, scale: 1 })),
  },
}));

vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: vi.fn((p: string) => p.includes('components/')),
  isIconSetFilePath: vi.fn((p: string) => p.includes('icons/')),
}));

const mockUpdateVariantPosition = vi.fn();
vi.mock('@/code/variants/variant-ops', () => ({
  updateVariantPosition: (...args: any[]) => mockUpdateVariantPosition(...args),
}));

const mockUpdateIconPosition = vi.fn();
const mockUpdateIconSize = vi.fn();
vi.mock('@/code/icons/icon-set-ops', () => ({
  updateIconPosition: (...args: any[]) => mockUpdateIconPosition(...args),
  updateIconSize: (...args: any[]) => mockUpdateIconSize(...args),
}));

const mockParseIconSetConfig = vi.fn((..._args: any[]) => [{ name: 'icon-node' }] as any[]);
vi.mock('@/code/icons/icon-set-config', () => ({
  parseIconSetConfig: (...args: any[]) => mockParseIconSetConfig(...args),
  // Real px-guard semantics (px/unitless pass, % and junk fall back) so the
  // commit-branch tests exercise the same values production would write.
  iconConfigPx: (value: string | undefined, fallback: number) => {
    if (!value) return fallback;
    const n = parseFloat(value.trim());
    return !Number.isFinite(n) || value.trim().endsWith('%') ? fallback : n;
  },
}));

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: vi.fn(() => null),
  },
}));

const mockQueueMutation = vi.fn();
const mockSyncQueueCode = vi.fn();
const mockFlushNow = vi.fn();
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (...args: any[]) => mockQueueMutation(...args),
  syncQueueCode: (...args: any[]) => mockSyncQueueCode(...args),
  flushNow: (...args: any[]) => mockFlushNow(...args),
  setDeferNextFanOut: vi.fn(),
}));

vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: vi.fn(() => ({
    patchAttrsAndStyles: vi.fn(),
  })),
}));

vi.mock('@/code/stores/shape-edit-store', () => ({
  shapeEditCommitPendingAtom: { init: false },
}));

vi.mock('@/code/stores/cms-store', () => ({
  collectionSchemasAtom: { init: new Map() },
}));

const mockUpdateNodeStyles = vi.fn();
const mockCommitDragPosition = vi.fn();
const mockGetActiveFilePath = vi.fn(() => 'app/page.tsx');
const mockForceCanvasRender = vi.fn();
vi.mock('../node-ops', () => ({
  updateNodeStyles: (opts: any) => mockUpdateNodeStyles(opts),
  commitDragPosition: (id: any, styles: any, contentEl: any) => mockCommitDragPosition(id, styles, contentEl),
  getActiveFilePath: () => mockGetActiveFilePath(),
  forceCanvasRender: () => mockForceCanvasRender(),
  getSvgGroupAncestorChain: vi.fn(() => []),
  getViewportPrefix: vi.fn(() => ''),
}));

vi.mock('@/code/svg/refit-group', () => ({
  moveChildAndRefitGroup: vi.fn(() => null),
  refitGroupChain: vi.fn(),
}));

vi.mock('../selection/parent-highlight-store', () => ({
  parentHighlightOps: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock('../ViewportHeaderManager', () => ({
  setViewportHeadersVisible: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNodes(entries: Record<string, { type?: string; parentId?: string | null; isCanvasNode?: boolean }> = {}) {
  return new Map(Object.entries(entries).map(([id, data]) => [id, {
    id,
    type: data.type ?? 'div',
    parentId: data.parentId !== undefined ? data.parentId : null,
    isCanvasNode: data.isCanvasNode ?? false,
    styles: {},
    attrs: {},
    children: [],
    name: '',
    textContent: '',
  } as any]));
}

function makeOpts(overrides: Partial<CanvasDragOrchestratorOpts> = {}): CanvasDragOrchestratorOpts {
  const containerEl = document.createElement('div');
  const contentEl = document.createElement('div');
  return {
    jotaiStore: {
      get: vi.fn((atom: any) => atom.init ?? new Map()),
      set: vi.fn(),
      sub: vi.fn(() => vi.fn()),
    } as any,
    containerEl,
    contentEl,
    getVpOverlay: () => null,
    onSnapGuidesChange: vi.fn(),
    onSpacingGuidesChange: vi.fn(),
    onDraggingChange: vi.fn(),
    onCanvasInteractingChange: vi.fn(),
    getCode: vi.fn(() => ''),
    getNodes: vi.fn(() => new Map()),
    getSelectedIds: vi.fn(() => []),
    getActiveFilePath: vi.fn(() => 'app/page.tsx'),
    isComponentFile: false,
    setSelectedIds: vi.fn(),
    renderer: { setStructuralPending: vi.fn(), markCanvasUpdate: vi.fn() } as any,
    getInteractingVpId: vi.fn(() => 'desktop'),
    setCode: vi.fn(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CanvasDragOrchestrator — commitUpdates branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Move updates sync the IMPERATIVE node cache ────────────────────────────
  // The drop-time flex/grid slot entry is the one reparent path whose cache
  // sync doesn't happen mid-drag in the strategy. With the drop fan-out
  // deferred, live cache readers un-hide right after mouseup — a stale
  // `isCanvasNode: true` made CanvasNodeNameDisplay re-show the floating
  // name label for ~0.3s after dropping a canvas node into a layout.
  test('a move update flips the imperative cache (parentId + isCanvasNode) at commit time', async () => {
    const { injectNodeIntoCache, getNodeFromCache } = await import('@/code/stores/store');
    injectNodeIntoCache({
      id: 'flex-parent', type: 'div', parentId: null, isCanvasNode: false,
      styles: {}, attrs: {}, children: [],
    } as any);
    injectNodeIntoCache({
      id: 'dragged-canvas-node', type: 'div', parentId: null, isCanvasNode: true,
      styles: { left: '100px', top: '50px' }, attrs: {}, children: [],
    } as any);

    const nodes = makeNodes({
      'flex-parent': { type: 'div', parentId: null },
      'dragged-canvas-node': { type: 'div', parentId: null, isCanvasNode: true },
    });
    const opts = makeOpts({ getNodes: vi.fn(() => nodes) });
    const orchestrator = new CanvasDragOrchestrator(opts);
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    orchestrator.commitUpdates([{
      type: 'move',
      nodeId: 'dragged-canvas-node',
      newParentId: 'flex-parent',
      newIndex: 0,
      styles: { position: 'relative', left: '', top: '', flex: '0 0 auto' },
    }]);

    const cached = getNodeFromCache('dragged-canvas-node');
    expect(cached?.parentId).toBe('flex-parent');
    expect(cached?.isCanvasNode).toBe(false);
    // Style sync: empty values removed, new values merged.
    expect(cached?.styles?.left).toBeUndefined();
    expect(cached?.styles?.flex).toBe('0 0 auto');
  });

  // ── Branch 1: Component variant root ──────────────────────────────────────
  test('component variant root drag calls updateVariantPosition and strips left/top from inline styles', () => {
    const nodes = makeNodes({
      'root-node': { type: 'div', parentId: null, isCanvasNode: false },
    });
    const opts = makeOpts({
      isComponentFile: true,
      getActiveFilePath: vi.fn(() => 'components/Card.tsx'),
      getNodes: vi.fn(() => nodes),
    });
    const orchestrator = new CanvasDragOrchestrator(opts);
    // Manually set the lastDragViewportPrefix on the inner coordinator mock
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    const updates: PendingUpdate[] = [{
      type: 'style',
      nodeId: 'root-node',
      styles: { left: '40px', top: '20px' },
    }];

    orchestrator.commitUpdates(updates);

    expect(mockUpdateVariantPosition).toHaveBeenCalledWith(
      'components/Card.tsx',
      'default',
      40,
      20,
    );
    // left/top should NOT be passed to updateNodeStyles (stripped)
    expect(mockUpdateNodeStyles).not.toHaveBeenCalledWith(
      expect.objectContaining({ styles: expect.objectContaining({ left: expect.anything() }) }),
    );
  });

  // ── Branch 2: Icon-set vector position + size ──────────────────────────────
  test('icon-set vector drag calls updateIconPosition for left/top and updateIconSize for width/height', () => {
    const nodes = makeNodes({ 'icon-node': { type: 'div' } });
    const opts = makeOpts({
      isComponentFile: false,
      getActiveFilePath: vi.fn(() => 'icons/MyIcons.tsx'),
      getNodes: vi.fn(() => nodes),
    });
    const orchestrator = new CanvasDragOrchestrator(opts);
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    const updates: PendingUpdate[] = [{
      type: 'style',
      nodeId: 'icon-node',
      styles: { left: '10px', top: '20px', width: '64px', height: '64px' },
    }];

    orchestrator.commitUpdates(updates);

    expect(mockUpdateIconPosition).toHaveBeenCalledWith('icons/MyIcons.tsx', 'icon-node', 10, 20);
    expect(mockUpdateIconSize).toHaveBeenCalledWith('icons/MyIcons.tsx', 'icon-node', 64, 64);
  });

  test('icon-set drag rejects a percent-anchored commit — keeps the current config value', () => {
    // Regression: a mid-band dynamic pin once committed `left: "48.6026%"`;
    // parseFloat wrote x:49 into iconConfig and the card jumped ~790px left
    // on mouse-up. A non-px axis must keep the entry's CURRENT value.
    mockParseIconSetConfig.mockReturnValueOnce([
      { name: 'icon-node', x: 840, y: 840, width: 240, height: 240 } as any,
    ]);
    mockUpdateIconPosition.mockClear();
    const nodes = makeNodes({ 'icon-node': { type: 'div' } });
    const opts = makeOpts({
      isComponentFile: false,
      getActiveFilePath: vi.fn(() => 'icons/MyIcons.tsx'),
      getNodes: vi.fn(() => nodes),
    });
    const orchestrator = new CanvasDragOrchestrator(opts);
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    orchestrator.commitUpdates([{
      type: 'style',
      nodeId: 'icon-node',
      styles: { left: '48.6026%', top: '900px' },
    }]);

    expect(mockUpdateIconPosition).toHaveBeenCalledWith('icons/MyIcons.tsx', 'icon-node', 840, 900);
  });

  // ── Branch 3: SVG group child drag ────────────────────────────────────────
  test('SVG group child drag routes position to updateHtmlAttrs + moveChildAndRefitGroup', () => {
    const nodes = makeNodes({
      'svg-child': { type: 'svg', parentId: 'svg-group' },
      'svg-group': { type: 'svg' },
    });
    const opts = makeOpts({
      isComponentFile: false,
      getActiveFilePath: vi.fn(() => 'app/page.tsx'),
      getNodes: vi.fn(() => nodes),
    });
    const orchestrator = new CanvasDragOrchestrator(opts);
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    const updates: PendingUpdate[] = [{
      type: 'style',
      nodeId: 'svg-child',
      styles: { left: '15px', top: '25px' },
    }];

    orchestrator.commitUpdates(updates);

    // Should queue updateHtmlAttrs (writes x/y onto the <svg> WRAPPER) — NOT
    // updateSvgAttrs, which redirects to the inner shape and double-offsets.
    expect(mockQueueMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'updateHtmlAttrs',
        nodeId: 'svg-child',
        attrs: expect.objectContaining({ x: '15', y: '25' }),
      }),
    );
    expect(mockQueueMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'updateSvgAttrs' }),
    );
    // commitDragPosition should NOT be called for SVG group child
    expect(mockCommitDragPosition).not.toHaveBeenCalled();
  });

  // ── Branch 4: Regular page node ───────────────────────────────────────────
  test('regular page node drag calls commitDragPosition', () => {
    const nodes = makeNodes({ 'plain-node': { type: 'div', parentId: 'root' } });
    const opts = makeOpts({
      isComponentFile: false,
      getActiveFilePath: vi.fn(() => 'app/page.tsx'),
      getNodes: vi.fn(() => nodes),
    });
    const orchestrator = new CanvasDragOrchestrator(opts);
    (orchestrator.coordinator as any).lastDragViewportPrefix = '';

    const updates: PendingUpdate[] = [{
      type: 'style',
      nodeId: 'plain-node',
      styles: { left: '100px', top: '200px' },
    }];

    orchestrator.commitUpdates(updates);

    expect(mockCommitDragPosition).toHaveBeenCalledWith(
      'plain-node',
      { left: '100px', top: '200px' },
      opts.contentEl,
    );
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  test('dispose cleans up auto-pan and wires setActiveAutoPan(null)', async () => {
    const { setActiveAutoPan } = await import('../transform');
    const opts = makeOpts();
    const orchestrator = new CanvasDragOrchestrator(opts);
    orchestrator.dispose();
    expect(setActiveAutoPan).toHaveBeenCalledWith(null);
  });
});
