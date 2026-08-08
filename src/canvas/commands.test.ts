// commands.test.ts — Tests for commands.ts high-level user commands.
// Pure selection-navigation functions are fully testable without DOM.
// DOM-dependent functions (deleteNode, toggleLock, toggleVisibility, wrapInFrame, unfoldChildren)
// are tested with minimal jsdom mocking where feasible.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';
import {
  selectParent,
  selectChildren,
  selectNextSibling,
  selectPrevSibling,
  deleteNode,
  toggleLock,
  toggleVisibility,
  wrapInFrame,
  wrapInLayout,
} from './commands';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal CanvasNode for testing */
function makeNode(id: string, parentId: string | null, children: string[] = [], styles: Record<string, string> = {}): CanvasNode {
  return {
    id,
    type: 'div',
    name: id,
    parentId,
    children,
    styles,
    textContent: null,
  } as unknown as CanvasNode;
}

/** Build a nodesMap from an array of CanvasNodes */
function buildMap(nodes: CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map(n => [n.id, n]));
}

// ─── selectParent ────────────────────────────────────────────────────────────

describe('selectParent', () => {
  const nodesMap = buildMap([
    makeNode('root', null, ['child1', 'child2']),
    makeNode('child1', 'root', ['grandchild']),
    makeNode('child2', 'root'),
    makeNode('grandchild', 'child1'),
  ]);

  it('returns parent ID', () => {
    expect(selectParent('child1', nodesMap)).toBe('root');
  });

  it('returns parent for deeply nested node', () => {
    expect(selectParent('grandchild', nodesMap)).toBe('child1');
  });

  it('returns null for root node (no parent)', () => {
    expect(selectParent('root', nodesMap)).toBeNull();
  });

  it('returns null for unknown node ID', () => {
    expect(selectParent('nonexistent', nodesMap)).toBeNull();
  });

  it('redirects a `layout::` parent to the viewport `root` (templated page)', () => {
    // A templated page nests {children} inside a locked layout container:
    // section's parent is `layout::main`. Escape must land on the viewport
    // (`root`), not select template chrome.
    const templated = buildMap([
      makeNode('root', null, ['layout::navbar', 'layout::main', 'layout::footer']),
      makeNode('layout::navbar', 'root'),
      makeNode('layout::main', 'root', ['section']),
      makeNode('layout::footer', 'root'),
      makeNode('section', 'layout::main'),
    ]);
    expect(selectParent('section', templated)).toBe('root');
  });

  it('a section whose parent IS the merged root escapes straight to root', () => {
    // The common case: {children} sits at the template root, so the section's
    // parent is already `root` (one level to the viewport).
    const merged = buildMap([
      makeNode('root', null, ['layout::navbar', 'section', 'layout::footer']),
      makeNode('layout::navbar', 'root'),
      makeNode('section', 'root'),
      makeNode('layout::footer', 'root'),
    ]);
    expect(selectParent('section', merged)).toBe('root');
  });
});

// ─── selectChildren ──────────────────────────────────────────────────────────

describe('selectChildren', () => {
  const nodesMap = buildMap([
    makeNode('root', null, ['child1', 'child2']),
    makeNode('child1', 'root', ['grandchild']),
    makeNode('child2', 'root'),
    makeNode('grandchild', 'child1'),
  ]);

  it('returns children IDs', () => {
    expect(selectChildren('root', nodesMap)).toEqual(['child1', 'child2']);
  });

  it('returns single child', () => {
    expect(selectChildren('child1', nodesMap)).toEqual(['grandchild']);
  });

  it('returns empty array for leaf node', () => {
    expect(selectChildren('child2', nodesMap)).toEqual([]);
  });

  it('returns empty array for unknown node', () => {
    expect(selectChildren('nonexistent', nodesMap)).toEqual([]);
  });
});

// ─── selectNextSibling ──────────────────────────────────────────────────────

describe('selectNextSibling', () => {
  const nodesMap = buildMap([
    makeNode('root', null, ['a', 'b', 'c']),
    makeNode('a', 'root'),
    makeNode('b', 'root'),
    makeNode('c', 'root'),
  ]);

  it('returns next sibling', () => {
    expect(selectNextSibling('a', nodesMap)).toBe('b');
    expect(selectNextSibling('b', nodesMap)).toBe('c');
  });

  it('wraps around to first sibling', () => {
    expect(selectNextSibling('c', nodesMap)).toBe('a');
  });

  it('returns null for root (no parent)', () => {
    expect(selectNextSibling('root', nodesMap)).toBeNull();
  });

  it('returns null for unknown node', () => {
    expect(selectNextSibling('nonexistent', nodesMap)).toBeNull();
  });
});

// ─── selectPrevSibling ──────────────────────────────────────────────────────

describe('selectPrevSibling', () => {
  const nodesMap = buildMap([
    makeNode('root', null, ['a', 'b', 'c']),
    makeNode('a', 'root'),
    makeNode('b', 'root'),
    makeNode('c', 'root'),
  ]);

  it('returns previous sibling', () => {
    expect(selectPrevSibling('b', nodesMap)).toBe('a');
    expect(selectPrevSibling('c', nodesMap)).toBe('b');
  });

  it('wraps around to last sibling', () => {
    expect(selectPrevSibling('a', nodesMap)).toBe('c');
  });

  it('returns null for root (no parent)', () => {
    expect(selectPrevSibling('root', nodesMap)).toBeNull();
  });

  it('returns null for unknown node', () => {
    expect(selectPrevSibling('nonexistent', nodesMap)).toBeNull();
  });
});

// ─── deleteNode (DOM-dependent, mocked) ─────────────────────────────────────

// Mock node-ops to control removeNode, getInteractingViewport, isPrimaryViewport, updateNodeStyles
vi.mock('./node-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-ops')>();
  return {
    ...actual,
    removeNode: vi.fn(),
    updateNodeStyles: vi.fn(),
    isPrimaryViewport: vi.fn((vpId: string) => vpId === 'desktop' || vpId === 'default'),
    getInteractingViewport: vi.fn(() => ({ vpId: 'desktop', vpWidth: 1440 })),
    // Border widths for the absolute-child origin. Unbordered by default.
    findNodeComputedStyles: vi.fn(() => ({})),
  };
});

// Mock viewport-store for getViewportWidths
vi.mock('@/code/stores/viewport-store', () => ({
  getViewportWidths: vi.fn(() => ({ desktop: 1440, tablet: 768, mobile: 375 })),
}));

// Mock mutation queue for queueMutation
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
}));

// Live canvas rects for the flow→absolute bake. Empty by default, so every
// pre-existing test keeps exercising the UNMEASURABLE fallback (a real path:
// bridge not ready, node culled); the flow-to-absolute tests below populate it.
const mockCanvasRects = new Map<string, { left: number; top: number; width: number; height: number }>();
vi.mock('@/canvas/canvas-math', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/canvas/canvas-math')>()),
  getAbsoluteCanvasRectById: (id: string) => mockCanvasRects.get(id) ?? null,
}));

describe('deleteNode', () => {
  let mockRemoveNode: ReturnType<typeof vi.fn>;
  let mockGetInteractingViewport: ReturnType<typeof vi.fn>;
  let mockQueueMutation: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const nodeOps = await import('./node-ops');
    mockRemoveNode = nodeOps.removeNode as ReturnType<typeof vi.fn>;
    mockGetInteractingViewport = nodeOps.getInteractingViewport as ReturnType<typeof vi.fn>;
    mockRemoveNode.mockClear();
    mockGetInteractingViewport.mockClear();

    const mutQueue = await import('@/code/mutation/mutation-queue');
    mockQueueMutation = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    mockQueueMutation.mockClear();
  });

  it('calls removeNode for a single ID on primary viewport', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode('node-1', contentEl);
    expect(mockRemoveNode).toHaveBeenCalledTimes(1);
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-1', contentEl });
  });

  it('calls removeNode for each ID in an array on primary viewport', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode(['node-1', 'node-2', 'node-3'], contentEl);
    expect(mockRemoveNode).toHaveBeenCalledTimes(3);
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-1', contentEl });
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-2', contentEl });
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-3', contentEl });
  });

  it('handles empty array gracefully', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode([], contentEl);
    expect(mockRemoveNode).toHaveBeenCalledTimes(0);
  });

  // ─── Layout node protection ────────────────────────────────────────────

  it('filters out layout:: prefixed IDs (not deletable from page context)', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode(['layout::navbar', 'layout::footer'], contentEl);
    expect(mockRemoveNode).not.toHaveBeenCalled();
  });

  it('filters out children-slot placeholder', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode('children-slot', contentEl);
    expect(mockRemoveNode).not.toHaveBeenCalled();
  });

  it('deletes non-layout nodes while filtering layout IDs from array', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode(['layout::navbar', 'real-node', 'children-slot'], contentEl);
    expect(mockRemoveNode).toHaveBeenCalledTimes(1);
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'real-node', contentEl });
  });

  // ─── Viewport-aware deleteNode ─────────────────────────────────────────

  it('on primary viewport always calls removeNode (full delete)', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'desktop', vpWidth: 1440 });
    const contentEl = document.createElement('div');
    deleteNode('node-1', contentEl);
    expect(mockRemoveNode).toHaveBeenCalledTimes(1);
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-1', contentEl });
    // No queueMutation for container styles
    expect(mockQueueMutation).not.toHaveBeenCalled();
  });

  it('on replica viewport, queues updateContainerStyle with display:none when node visible elsewhere', () => {
    mockGetInteractingViewport.mockReturnValue({ vpId: 'tablet', vpWidth: 768 });
    const contentEl = document.createElement('div');

    // Create replica element in tablet viewport (the one being deleted from)
    const tabletEl = document.createElement('div');
    tabletEl.setAttribute('data-node-id', 'tablet-node-1');
    contentEl.appendChild(tabletEl);

    // Create element in desktop viewport (visible elsewhere)
    const desktopEl = document.createElement('div');
    desktopEl.setAttribute('data-node-id', 'node-1');
    desktopEl.style.display = 'block';
    contentEl.appendChild(desktopEl);

    // Mock getComputedStyle to return non-none for the desktop element
    const originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = vi.fn((el: Element) => {
      if (el === desktopEl) return { display: 'block' } as CSSStyleDeclaration;
      return { display: 'none' } as CSSStyleDeclaration;
    });

    deleteNode('node-1', contentEl);

    // Should NOT call removeNode (node is visible elsewhere)
    expect(mockRemoveNode).not.toHaveBeenCalled();
    // Should queue a container style mutation to hide at tablet width
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateContainerStyle',
      nodeId: 'node-1',
      maxWidth: 768,
      styles: { display: 'none' },
    });

    window.getComputedStyle = originalGetComputedStyle;
  });

  it('on replica viewport, calls removeNode when base is hidden on primary and no other replica shows it', async () => {
    // deleteUpdate routes on METADATA now (base styles from the node cache),
    // not a parent-frame DOM probe of the primary — the DOM probe only runs
    // as the last-resort check across OTHER replicas when the base is hidden.
    const { injectNodeIntoCache, removeNodeFromCache } = await import('@/code/stores/store');
    injectNodeIntoCache({
      id: 'node-1', type: 'div', name: 'Node', parentId: 'root',
      children: [], styles: { display: 'none' }, attrs: {}, textContent: '',
      hasMixedContent: false, order: 0, isCanvasNode: false,
      componentFile: null, componentInstanceId: null, isComponentRoot: false,
      motionVariants: null, motionVariantsRef: null, motionProps: null,
      responsiveVariantMap: null, conditionalStyles: null,
    });
    mockGetInteractingViewport.mockReturnValue({ vpId: 'tablet', vpWidth: 768 });
    const contentEl = document.createElement('div');

    // Create tablet replica
    const tabletEl = document.createElement('div');
    tabletEl.setAttribute('data-node-id', 'tablet-node-1');
    contentEl.appendChild(tabletEl);

    // Desktop element exists but is hidden (display:none)
    const desktopEl = document.createElement('div');
    desktopEl.setAttribute('data-node-id', 'node-1');
    contentEl.appendChild(desktopEl);

    // Mobile element exists but is hidden
    const mobileEl = document.createElement('div');
    mobileEl.setAttribute('data-node-id', 'mobile-node-1');
    contentEl.appendChild(mobileEl);

    // All other viewport elements report display:none
    const originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = vi.fn(() => {
      return { display: 'none' } as CSSStyleDeclaration;
    });

    deleteNode('node-1', contentEl);

    // Base hidden on primary + no other replica visible -> full remove
    expect(mockRemoveNode).toHaveBeenCalledTimes(1);
    expect(mockRemoveNode).toHaveBeenCalledWith({ id: 'node-1', contentEl });
    // Should NOT queue container style mutation
    expect(mockQueueMutation).not.toHaveBeenCalled();

    window.getComputedStyle = originalGetComputedStyle;
    removeNodeFromCache('node-1');
  });
});

// ─── toggleLock (DOM-dependent, mocked) ─────────────────────────────────────
// Note: node-ops mock already declared above with all needed mocks

describe('toggleLock', () => {
  let mockUpdateNodeStyles: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const nodeOps = await import('./node-ops');
    mockUpdateNodeStyles = nodeOps.updateNodeStyles as ReturnType<typeof vi.fn>;
    mockUpdateNodeStyles.mockClear();
  });

  it('locks an unlocked node (sets pointerEvents to none)', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([makeNode('n1', null, [], { pointerEvents: '' })]);
    toggleLock('n1', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).toHaveBeenCalledWith({
      id: 'n1',
      styles: { pointerEvents: 'none' },
      contentEl,
    });
  });

  it('unlocks a locked node (clears pointerEvents)', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([makeNode('n1', null, [], { pointerEvents: 'none' })]);
    toggleLock('n1', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).toHaveBeenCalledWith({
      id: 'n1',
      styles: { pointerEvents: '' },
      contentEl,
    });
  });

  it('does nothing for unknown node', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([]);
    toggleLock('nonexistent', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).not.toHaveBeenCalled();
  });
});

// ─── toggleVisibility (DOM-dependent, mocked) ──────────────────────────────

describe('toggleVisibility', () => {
  let mockUpdateNodeStyles: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const nodeOps = await import('./node-ops');
    mockUpdateNodeStyles = nodeOps.updateNodeStyles as ReturnType<typeof vi.fn>;
    mockUpdateNodeStyles.mockClear();
  });

  it('hides a visible node (sets display to none)', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([makeNode('n1', null, [], { display: '' })]);
    toggleVisibility('n1', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).toHaveBeenCalledWith({
      id: 'n1',
      styles: { display: 'none' },
      contentEl,
    });
  });

  it('shows a hidden node (clears display)', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([makeNode('n1', null, [], { display: 'none' })]);
    toggleVisibility('n1', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).toHaveBeenCalledWith({
      id: 'n1',
      styles: { display: '' },
      contentEl,
    });
  });

  it('does nothing for unknown node', () => {
    const contentEl = document.createElement('div');
    const nodesMap = buildMap([]);
    toggleVisibility('nonexistent', contentEl, nodesMap);
    expect(mockUpdateNodeStyles).not.toHaveBeenCalled();
  });
});

// ─── Notes on integration tests ─────────────────────────────────────────────
// wrapInFrame, wrapInLayout, and unfoldChildren require:
// - Full DOM tree with data-node-id attributes
// - Working createNode/moveNode that manipulate real DOM elements
// - transformManager.getTransform() for scale (unfoldChildren)
// - convertChildToAbsolute() for position preservation (unfoldChildren)
// These would need integration tests with a real (or deeply mocked) canvas environment.

// wrapInternal is pure (no DOM) — it queues the frame via queueMutation, which is
// mocked above. So we CAN assert the frame's style. A frame wrapping TEXT must
// clip: text with line-height < 1 has an invisible, hit-testable font-box that
// overflows its line box and steals hover/click from stacked siblings.
describe('wrap frame — clips overflow only when wrapping text', () => {
  const dummyEl = {} as unknown as HTMLElement;
  const absText = (id: string) => ({
    id, type: 'h1', name: id, parentId: 'page', children: [],
    textContent: 'HOME',
    styles: { position: 'absolute', left: '0px', top: '0px', width: '100px', height: '40px' },
  } as unknown as CanvasNode);
  const absDiv = (id: string) => makeNode(id, 'page', [],
    { position: 'absolute', left: '0px', top: '0px', width: '100px', height: '40px' });

  let q: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
  });

  const framedStyles = () => {
    const add = q.mock.calls.map(c => c[0]).find(m => m.type === 'addNode' || m.type === 'addCanvasNode');
    return add?.node?.styles as Record<string, string> | undefined;
  };

  it('wrapInLayout on a TEXT node → frame overflow: hidden', () => {
    const map = buildMap([makeNode('page', null, ['t1']), absText('t1')]);
    wrapInLayout(['t1'], map, dummyEl);
    expect(framedStyles()?.overflow).toBe('hidden');
  });

  it('wrapInFrame (plain) on a TEXT node → frame overflow: hidden', () => {
    const map = buildMap([makeNode('page', null, ['t1']), absText('t1')]);
    wrapInFrame(['t1'], map, dummyEl);
    expect(framedStyles()?.overflow).toBe('hidden');
  });

  it('wrapping a NON-text node keeps overflow: visible (unchanged)', () => {
    const map = buildMap([makeNode('page', null, ['d1']), absDiv('d1')]);
    wrapInLayout(['d1'], map, dummyEl);
    expect(framedStyles()?.overflow).toBe('visible');
  });

  it('a MIXED text+div selection does not clip (only pure-text wraps clip)', () => {
    const map = buildMap([makeNode('page', null, ['t1', 'd1']), absText('t1'), absDiv('d1')]);
    wrapInLayout(['t1', 'd1'], map, dummyEl);
    expect(framedStyles()?.overflow).toBe('visible');
  });
});

// A flow child (relative, in a flex parent) must hand its PLACEMENT to the
// wrapper — position/order/flex/margin. Without it, Make-Component (which wraps
// a bare text node in a frame first) has nothing to lift onto the instance tag,
// so the master root's absolute leaks and the element collapses in preview.
describe('wrap frame — flow child hands placement to the wrapper', () => {
  const dummyEl = {} as unknown as HTMLElement;
  let q: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
  });
  const calls = () => q.mock.calls.map(c => c[0]);
  const framed = () => calls().find(m => m.type === 'addNode')?.node?.styles as Record<string, string> | undefined;
  const moveStyles = (id: string) => calls().find(m => m.type === 'move' && m.nodeId === id)?.styles as Record<string, string> | undefined;

  const flowArrow = () => ({
    id: 'arrow', type: 'p', name: 'Arrow', parentId: 'meta', children: [],
    textContent: '→',
    styles: { position: 'relative', order: '1', flex: '0 0 auto', margin: '0', width: 'auto', height: 'auto' },
  } as unknown as CanvasNode);

  it('wrapper inherits position:relative + order + flex from the single flow child', () => {
    const map = buildMap([
      makeNode('meta', null, ['titles', 'arrow'], { display: 'flex', flexDirection: 'row' }),
      makeNode('titles', 'meta', [], { order: '0' }),
      flowArrow(),
    ]);
    wrapInFrame(['arrow'], map, dummyEl);
    const f = framed();
    expect(f?.position).toBe('relative');
    expect(f?.order).toBe('1');
    expect(f?.flex).toBe('0 0 auto');
  });

  it('the moved child gets order reset to 0 + margin cleared (placement now on wrapper)', () => {
    const map = buildMap([
      makeNode('meta', null, ['arrow'], { display: 'flex' }),
      flowArrow(),
    ]);
    wrapInFrame(['arrow'], map, dummyEl);
    const ms = moveStyles('arrow');
    expect(ms?.order).toBe('0');
    expect(ms?.margin).toBe(''); // '' = remove property
  });

  it('a non-text flow div also hands its order to the wrapper (relative stays)', () => {
    const map = buildMap([
      makeNode('meta', null, ['box'], { display: 'flex' }),
      makeNode('box', 'meta', [], { position: 'relative', order: '2', flex: '0 0 auto', width: '80px', height: '40px' }),
    ]);
    wrapInFrame(['box'], map, dummyEl);
    const f = framed();
    expect(f?.position).toBe('relative');
    expect(f?.order).toBe('2');
  });
});

// A SINGLE absolute child wrapped in a frame/layout must have the WRAPPER
// inherit its exact positioning (left/top/right/bottom/transform) verbatim, so
// nothing moves visually — regardless of %, translate() centering, or SVG box.
// Regression: a centered SVG's `left: 68.54%` was parseFloat'd to 68px and the
// wrapper flew ~900px off (live find 2026-07-24).
describe('wrap frame — single absolute child inherits exact position', () => {
  const dummyEl = {} as unknown as HTMLElement;
  let q: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
  });
  const calls = () => q.mock.calls.map(c => c[0]);
  const framed = () => calls().find(m => m.type === 'addNode')?.node?.styles as Record<string, string> | undefined;
  const moveStyles = (id: string) => calls().find(m => m.type === 'move' && m.nodeId === id)?.styles as Record<string, string> | undefined;

  // A centered SVG: percentage left, px top, translate(-50%,-50%) — the exact
  // shape from the reported bug.
  const centeredSvg = (): CanvasNode => ({
    id: 'star', type: 'svg', name: 'svg', parentId: 'hero', children: [],
    styles: {
      position: 'absolute', left: '68.5417%', top: '464px',
      transform: 'translateX(-50%) translateY(-50%)', width: '22px', height: '22px',
    },
  } as unknown as CanvasNode);
  const heroMap = () => buildMap([makeNode('hero', null, ['star'], { position: 'relative' }), centeredSvg()]);

  it('Create Layout: wrapper keeps the % left verbatim (NOT parseFloat px)', () => {
    wrapInLayout(['star'], heroMap(), dummyEl);
    const f = framed();
    expect(f?.left).toBe('68.5417%');           // the ~900px-off bug: would have been "68px"
    expect(f?.top).toBe('464px');
    expect(f?.transform).toBe('translateX(-50%) translateY(-50%)');
    expect(f?.position).toBe('absolute');
  });

  it('Create Layout: the wrapped child is reset to flow (cleared position + transform)', () => {
    wrapInLayout(['star'], heroMap(), dummyEl);
    const ms = moveStyles('star');
    expect(ms?.position).toBe('');
    expect(ms?.left).toBe('');
    expect(ms?.top).toBe('');
    expect(ms?.transform).toBe('');
  });

  it('Create Frame: wrapper inherits position + takes the child box; child sits at 0,0', () => {
    wrapInFrame(['star'], heroMap(), dummyEl);
    const f = framed();
    expect(f?.left).toBe('68.5417%');
    expect(f?.top).toBe('464px');
    expect(f?.transform).toBe('translateX(-50%) translateY(-50%)');
    expect(f?.width).toBe('22px');
    expect(f?.height).toBe('22px');
    const ms = moveStyles('star');
    expect(ms?.position).toBe('absolute');
    expect(ms?.left).toBe('0px');
    expect(ms?.top).toBe('0px');
    expect(ms?.transform).toBe('');
  });

  it('inherits right/bottom insets when the child is inset-pinned', () => {
    const map = buildMap([
      makeNode('hero', null, ['box'], { position: 'relative' }),
      makeNode('box', 'hero', [], { position: 'absolute', right: '40px', bottom: '20px', width: '100px', height: '50px' }),
    ]);
    wrapInFrame(['box'], map, dummyEl);
    const f = framed();
    expect(f?.right).toBe('40px');
    expect(f?.bottom).toBe('20px');
    expect(f?.left).toBeUndefined();  // no left → the wrapper is inset-anchored, same as the child
  });
});

// ─── sibling navigation follows FLOW order (CSS order), not source order ─────
// The reorder engine moves nodes via CSS `order`, so Tab/Shift+Tab must step
// in the order the user SEES (live find 2026-07-21: Shift+Tab appeared to
// select the NEXT sibling on order-shuffled sections).
import { selectNextSibling as flowNext, selectPrevSibling as flowPrev } from './commands';

function flowMap(): Map<string, CanvasNode> {
  const mk = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
    id, type: 'div', styles: {}, attrs: {}, children: [], parentId: 'parent', ...extra,
  } as CanvasNode);
  const m = new Map<string, CanvasNode>();
  m.set('parent', mk('parent', { parentId: null as unknown as string, children: ['a', 'b', 'c'] }));
  // SOURCE order a,b,c but CSS order renders as b(0), c(1), a(2)
  m.set('a', mk('a', { styles: { order: '2' } }));
  m.set('b', mk('b', { styles: { order: '0' } }));
  m.set('c', mk('c', { styles: { order: '1' } }));
  return m;
}

describe('sibling navigation flow order', () => {
  it('next steps in visual order (b → c → a → wraps to b)', () => {
    const m = flowMap();
    expect(flowNext('b', m)).toBe('c');
    expect(flowNext('c', m)).toBe('a');
    expect(flowNext('a', m)).toBe('b');
  });
  it('prev steps in visual order (c → b; b wraps to a)', () => {
    const m = flowMap();
    expect(flowPrev('c', m)).toBe('b');
    expect(flowPrev('b', m)).toBe('a');
    expect(flowPrev('a', m)).toBe('c');
  });
  it('no order props falls back to source order', () => {
    const m = flowMap();
    for (const id of ['a', 'b', 'c']) (m.get(id) as CanvasNode).styles = {};
    expect(flowNext('a', m)).toBe('b');
    expect(flowPrev('a', m)).toBe('c');
  });
});

// ─── Tab navigation skips template chrome + overlays ─────────────────────────
// On a merged templated page the root's children include LOCKED `layout::`
// chrome (Header/Footer) and floating overlay nodes (`data-overlay`) — Tab /
// Shift+Tab used to cycle onto them (unselectable chrome, invisible fixed
// overlay; user report 2026-07-28). Both are excluded from the flow cycle.
describe('selectNext/PrevSibling — template chrome + overlays are not Tab stops', () => {
  const build = () => {
    const overlay = makeNode('overlay-u', 'root', [], { position: 'absolute' });
    (overlay as unknown as { attrs: Record<string, string> }).attrs = {
      'data-overlay': '{"type":"fixed","triggerId":"t"}',
    };
    return buildMap([
      makeNode('root', null, ['layout::header', 'overlay-u', 'sec-a', 'sec-b', 'layout::footer']),
      makeNode('layout::header', 'root'),
      overlay,
      makeNode('sec-a', 'root'),
      makeNode('sec-b', 'root'),
      makeNode('layout::footer', 'root'),
    ]);
  };

  it('Tab after the LAST section wraps to the FIRST section — never the footer or overlay', () => {
    expect(selectNextSibling('sec-b', build())).toBe('sec-a');
  });

  it('Shift+Tab from the FIRST section wraps to the LAST section — never the header', () => {
    expect(selectPrevSibling('sec-a', build())).toBe('sec-b');
  });

  it('mid-list stepping still works', () => {
    expect(selectNextSibling('sec-a', build())).toBe('sec-b');
    expect(selectPrevSibling('sec-b', build())).toBe('sec-a');
  });

  it('a selection ON an excluded node is a safe no-op', () => {
    expect(selectNextSibling('layout::footer', build())).toBeNull();
    expect(selectNextSibling('overlay-u', build())).toBeNull();
  });
});

// ─── Create Frame on flow children → absolute, with baked geometry ───────────
//
// User report 2026-08-08: running Create Frame on flex/grid children produced a
// no-layout frame whose children were still `position: relative`, so they
// stacked in document flow and ignored the frame. A frame has no layout — the
// only way to place anything inside one is absolutely — and both the child's
// position AND its size were the parent layout's output, so both have to be
// measured and baked or the swap moves things.

describe('wrapInFrame — flow children become absolute against the frame box', () => {
  const dummyEl = {} as unknown as HTMLElement;
  let q: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
    mockCanvasRects.clear();
  });

  const calls = () => q.mock.calls.map(c => c[0]);
  const framed = () => calls().find(m => m.type === 'addNode')?.node?.styles as Record<string, string> | undefined;
  const moveStyles = (id: string) => calls().find(m => m.type === 'move' && m.nodeId === id)?.styles as Record<string, string> | undefined;

  /** A flex column: two stretched children 24px apart. Both are `width: auto`
   *  (the parent decides), which is exactly what makes the naive move collapse. */
  const flexColumn = () => {
    mockCanvasRects.set('a', { left: 100, top: 200, width: 320, height: 40 });
    mockCanvasRects.set('b', { left: 100, top: 264, width: 320, height: 60 });
    return buildMap([
      makeNode('sec', null, ['a', 'b'], { display: 'flex', flexDirection: 'column', gap: '24px' }),
      makeNode('a', 'sec', [], { position: 'relative', width: 'auto', height: 'auto', order: '0' }),
      makeNode('b', 'sec', [], { position: 'relative', width: 'auto', height: 'auto', order: '1' }),
    ]);
  };

  it('the frame takes the selection union — including the gap between the children', () => {
    wrapInFrame(['a', 'b'], flexColumn(), dummyEl);
    const f = framed()!;
    expect(f.width).toBe('320px');
    expect(f.height).toBe('124px');   // 40 + 24 gap + 60
    // Seated in the parent's flow, and a positioning context for its children.
    expect(f.position).toBe('relative');
    // The parent must not grow or shrink it off the measured size.
    expect(f.flex).toBe('0 0 auto');
  });

  it('each child goes absolute at its measured offset from the frame origin', () => {
    wrapInFrame(['a', 'b'], flexColumn(), dummyEl);
    expect(moveStyles('a')).toMatchObject({ position: 'absolute', left: '0px', top: '0px' });
    expect(moveStyles('b')).toMatchObject({ position: 'absolute', left: '0px', top: '64px' });
  });

  it('bakes the size the parent layout was deciding — `auto` would shrink-wrap out of flow', () => {
    wrapInFrame(['a', 'b'], flexColumn(), dummyEl);
    expect(moveStyles('a')).toMatchObject({ width: '320px', height: '40px' });
    expect(moveStyles('b')).toMatchObject({ width: '320px', height: '60px' });
  });

  it('clears the flow props — margin would offset the box, flex/order are inert', () => {
    wrapInFrame(['a', 'b'], flexColumn(), dummyEl);
    const ms = moveStyles('a')!;
    for (const k of ['margin', 'marginTop', 'flex', 'alignSelf', 'order']) expect(ms[k]).toBe('');
  });

  it('a TEXT child keeps height auto — the baked width already pins the wrap', () => {
    mockCanvasRects.set('t', { left: 0, top: 0, width: 200, height: 48 });
    const map = buildMap([
      makeNode('sec', null, ['t'], { display: 'flex' }),
      { id: 't', type: 'h1', name: 't', parentId: 'sec', children: [], textContent: 'Join our newsletter',
        styles: { position: 'relative', width: 'auto', height: 'auto' } } as unknown as CanvasNode,
    ]);
    wrapInFrame(['t'], map, dummyEl);
    const ms = moveStyles('t')!;
    expect(ms.width).toBe('200px');
    expect(ms.height).toBe('auto');
  });

  it('a shrink-wrap (Fit) size is left alone — identical in both layout models', () => {
    mockCanvasRects.set('fit', { left: 0, top: 0, width: 90, height: 20 });
    const map = buildMap([
      makeNode('sec', null, ['fit'], { display: 'flex' }),
      { id: 'fit', type: 'p', name: 'fit', parentId: 'sec', children: [], textContent: 'x',
        styles: { position: 'relative', width: 'min-content', height: 'min-content' } } as unknown as CanvasNode,
    ]);
    wrapInFrame(['fit'], map, dummyEl);
    const ms = moveStyles('fit')!;
    expect(ms.width).toBeUndefined();
    expect(ms.height).toBeUndefined();
  });

  it('Create LAYOUT is untouched — it keeps the flow model on purpose', () => {
    wrapInLayout(['a', 'b'], flexColumn(), dummyEl);
    const f = framed()!;
    expect(f.display).toBe('flex');
    // Children stay in flow; no absolute rebasing.
    expect(moveStyles('a')?.position).toBeUndefined();
  });

  it('unmeasurable selection falls back to the flow wrapper rather than collapsing', () => {
    // No rects registered → the frame would otherwise get 0×0 and the parent
    // would reflow around a hole.
    const map = buildMap([
      makeNode('sec', null, ['a'], { display: 'flex' }),
      makeNode('a', 'sec', [], { position: 'relative', width: 'auto', height: 'auto' }),
    ]);
    wrapInFrame(['a'], map, dummyEl);
    const f = framed()!;
    expect(f.width).toBe('auto');
    expect(moveStyles('a')?.position).toBeUndefined();
  });
});

// Make Component wraps a bare text node in a frame BEFORE componentizing. That
// wrap only exists to give the text a box, so it opts out of the bake — a
// px-frozen frame around an absolute text would stop the master growing with
// its own content.
describe('wrapInFrame — keepFlowChildren opt-out', () => {
  const dummyEl = {} as unknown as HTMLElement;
  let q: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
    mockCanvasRects.clear();
  });
  const calls = () => q.mock.calls.map(c => c[0]);

  it('keeps the hugging flow wrapper even when the selection IS measurable', () => {
    mockCanvasRects.set('t', { left: 0, top: 0, width: 200, height: 48 });
    const map = buildMap([
      makeNode('sec', null, ['t'], { display: 'flex' }),
      { id: 't', type: 'h1', name: 't', parentId: 'sec', children: [], textContent: 'Prima',
        styles: { position: 'relative', width: 'auto', height: 'auto', order: '2' } } as unknown as CanvasNode,
    ]);
    wrapInFrame(['t'], map, dummyEl, undefined, { keepFlowChildren: true });
    const f = calls().find(m => m.type === 'addNode')?.node?.styles as Record<string, string>;
    expect(f.width).toBe('auto');
    expect(f.height).toBe('auto');
    // Placement still hands off to the wrapper — that part is unconditional.
    expect(f.position).toBe('relative');
    expect(f.order).toBe('2');
    const ms = calls().find(m => m.type === 'move' && m.nodeId === 't')?.styles as Record<string, string>;
    expect(ms.position).toBeUndefined();
  });
});

// ─── Multi-node absolute wrap: inline geometry is not enough ────────────────
//
// User report 2026-08-08: selecting a childless frame AND a frame that has
// children, Create Layout / Create Frame did nothing. Alone, the childless one
// worked. The pair didn't, because the bbox came from `parseFloat(styles.*)`
// and a container with children hugs at `height: auto` → NaN → the whole
// command bailed with `missing-box`. A single absolute child never hit it (it
// takes the inherit-position path, which skips the bbox entirely), which is
// exactly why it looked like "only childless frames work".
describe('wrapInFrame / wrapInLayout — bbox falls back to live rects', () => {
  const dummyEl = {} as unknown as HTMLElement;
  let q: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mutQueue = await import('@/code/mutation/mutation-queue');
    q = mutQueue.queueMutation as ReturnType<typeof vi.fn>;
    q.mockClear();
    mockCanvasRects.clear();
  });

  const calls = () => q.mock.calls.map(c => c[0]);
  const framed = () => calls().find(m => m.type === 'addNode' || m.type === 'addCanvasNode')?.node?.styles as Record<string, string> | undefined;
  const moveStyles = (id: string) => calls().find(m => m.type === 'move' && m.nodeId === id)?.styles as Record<string, string> | undefined;

  /** The reported selection: `plain` is a fully-specified childless frame,
   *  `hasKids` is a frame whose height is decided by its children. The section
   *  sits at canvas (40, 60), so parent-local == canvas minus that. */
  const pair = () => {
    mockCanvasRects.set('sec', { left: 40, top: 60, width: 600, height: 400 });
    mockCanvasRects.set('plain', { left: 60, top: 100, width: 100, height: 40 });
    mockCanvasRects.set('hasKids', { left: 60, top: 180, width: 300, height: 120 });
    return buildMap([
      makeNode('sec', null, ['plain', 'hasKids'], { position: 'relative' }),
      makeNode('plain', 'sec', [], { position: 'absolute', left: '20px', top: '40px', width: '100px', height: '40px' }),
      makeNode('hasKids', 'sec', ['kid'], { position: 'absolute', left: '20px', top: '120px', width: '300px', height: 'auto' }),
      makeNode('kid', 'hasKids', []),
    ]);
  };

  it('wraps a childless frame TOGETHER with a frame that has children', () => {
    const id = wrapInFrame(['plain', 'hasKids'], pair(), dummyEl);
    expect(id).not.toBeNull();
    const f = framed()!;
    // Union in parent-local space: x 20..320, y 40..240.
    expect(f.left).toBe('20px');
    expect(f.top).toBe('40px');
    expect(f.width).toBe('300px');
    expect(f.height).toBe('200px');
  });

  it('both children move into the frame, positioned against its origin', () => {
    wrapInFrame(['plain', 'hasKids'], pair(), dummyEl);
    expect(moveStyles('plain')).toMatchObject({ position: 'absolute', left: '0px', top: '0px' });
    expect(moveStyles('hasKids')).toMatchObject({ position: 'absolute', left: '0px', top: '80px' });
  });

  it('the hugging child keeps `height: auto` — it hugs the same inside the frame', () => {
    wrapInFrame(['plain', 'hasKids'], pair(), dummyEl);
    expect(moveStyles('hasKids')!.height).toBeUndefined();
  });

  it('Create Layout on the same pair also lands at the union origin', () => {
    const id = wrapInLayout(['plain', 'hasKids'], pair(), dummyEl);
    expect(id).not.toBeNull();
    expect(framed()).toMatchObject({ left: '20px', top: '40px', display: 'flex' });
  });

  it('a bordered parent shifts the origin by its border (padding box, not border box)', async () => {
    const nodeOps = await import('./node-ops');
    (nodeOps.findNodeComputedStyles as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ borderLeftWidth: '10px', borderTopWidth: '5px' });
    wrapInFrame(['plain', 'hasKids'], pair(), dummyEl);
    // Canvas union starts at (60, 100); parent padding box starts at (50, 65).
    expect(framed()).toMatchObject({ left: '10px', top: '35px' });
  });

  it('still bails when the bridge cannot measure — never a half-applied wrap', () => {
    mockCanvasRects.clear();     // bridge cold / nodes culled
    const map = pair();
    mockCanvasRects.clear();
    expect(wrapInFrame(['plain', 'hasKids'], map, dummyEl)).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it('all-inline-readable selections never touch the bridge', () => {
    // No rects registered at all: if the inline path were skipped this bails.
    const map = buildMap([
      makeNode('sec', null, ['a', 'b'], { position: 'relative' }),
      makeNode('a', 'sec', [], { position: 'absolute', left: '0px', top: '0px', width: '50px', height: '50px' }),
      makeNode('b', 'sec', [], { position: 'absolute', left: '100px', top: '100px', width: '50px', height: '50px' }),
    ]);
    wrapInFrame(['a', 'b'], map, dummyEl);
    expect(framed()).toMatchObject({ left: '0px', top: '0px', width: '150px', height: '150px' });
  });

  it('a `%` left is measured, not parsed as px', () => {
    // parseFloat('50%') === 50 — finite, so the old reader accepted it and put
    // the frame at 50px. The element actually renders at 50% of a 600px parent.
    mockCanvasRects.set('sec', { left: 0, top: 0, width: 600, height: 400 });
    mockCanvasRects.set('p1', { left: 300, top: 0, width: 100, height: 40 });
    mockCanvasRects.set('p2', { left: 300, top: 100, width: 100, height: 40 });
    const map = buildMap([
      makeNode('sec', null, ['p1', 'p2'], { position: 'relative' }),
      makeNode('p1', 'sec', [], { position: 'absolute', left: '50%', top: '0px', width: '100px', height: '40px' }),
      makeNode('p2', 'sec', [], { position: 'absolute', left: '50%', top: '100px', width: '100px', height: '40px' }),
    ]);
    wrapInFrame(['p1', 'p2'], map, dummyEl);
    expect(framed()).toMatchObject({ left: '300px', top: '0px' });
  });

  it('a `%` SIZE is baked to px — it resolved against the old parent', () => {
    mockCanvasRects.set('sec', { left: 0, top: 0, width: 600, height: 400 });
    mockCanvasRects.set('w1', { left: 0, top: 0, width: 300, height: 40 });
    mockCanvasRects.set('w2', { left: 0, top: 100, width: 100, height: 40 });
    const map = buildMap([
      makeNode('sec', null, ['w1', 'w2'], { position: 'relative' }),
      makeNode('w1', 'sec', [], { position: 'absolute', left: '0px', top: '0px', width: '50%', height: '40px' }),
      makeNode('w2', 'sec', [], { position: 'absolute', left: '0px', top: '100px', width: '100px', height: '40px' }),
    ]);
    wrapInFrame(['w1', 'w2'], map, dummyEl);
    // The wrapper is 300 wide, so a surviving `50%` would render at 150.
    expect(moveStyles('w1')!.width).toBe('300px');
    expect(moveStyles('w2')!.width).toBeUndefined();
  });

  it('a transformed child is measured — left/top no longer describe its box', () => {
    mockCanvasRects.set('sec', { left: 0, top: 0, width: 600, height: 400 });
    mockCanvasRects.set('c1', { left: 250, top: 180, width: 100, height: 40 });
    mockCanvasRects.set('c2', { left: 0, top: 300, width: 100, height: 40 });
    const map = buildMap([
      makeNode('sec', null, ['c1', 'c2'], { position: 'relative' }),
      makeNode('c1', 'sec', [], { position: 'absolute', left: '300px', top: '200px', width: '100px', height: '40px', transform: 'translate(-50%, -50%)' }),
      makeNode('c2', 'sec', [], { position: 'absolute', left: '0px', top: '300px', width: '100px', height: '40px' }),
    ]);
    wrapInFrame(['c1', 'c2'], map, dummyEl);
    expect(framed()).toMatchObject({ left: '0px', top: '180px', width: '350px', height: '160px' });
  });

  it('canvas-level frames with a hugging one still wrap (origin is canvas itself)', () => {
    mockCanvasRects.set('f1', { left: 100, top: 100, width: 200, height: 80 });
    mockCanvasRects.set('f2', { left: 400, top: 300, width: 200, height: 150 });
    const map = buildMap([
      { ...makeNode('f1', null, [], { position: 'absolute', left: '100px', top: '100px', width: '200px', height: '80px' }), isCanvasNode: true } as unknown as CanvasNode,
      { ...makeNode('f2', null, ['k'], { position: 'absolute', left: '400px', top: '300px', width: '200px', height: 'auto' }), isCanvasNode: true } as unknown as CanvasNode,
      makeNode('k', 'f2', []),
    ]);
    const id = wrapInFrame(['f1', 'f2'], map, dummyEl);
    expect(id).not.toBeNull();
    expect(framed()).toMatchObject({ left: '100px', top: '100px', width: '500px', height: '350px' });
  });
});
