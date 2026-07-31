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
