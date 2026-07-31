// snap-targets.test.ts — Coverage for the shared top-level snap-target
// collector used by ResizeManager (canvas-node resize) and
// CanvasDragStrategy (top-level drag).
//
// Mocks the bridge (`rectCache` + `getRect` + `getIframeOffset`) and
// the active-file-path module so we can run the helper without booting
// the iframe sandbox.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transform } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const fakeBridge: {
  rectCache: Map<string, DOMRect>;
  getRect: (dataId: string, prefix: string) => DOMRect | null;
  getIframeOffset: () => { x: number; y: number };
} = {
  rectCache: new Map(),
  getRect: vi.fn(),
  getIframeOffset: vi.fn(() => ({ x: 0, y: 0 })),
};

vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => fakeBridge,
}));

const mockGetActiveFilePath = vi.fn(() => '/pages/Home.tsx');
vi.mock('@/canvas/node-ops', () => ({
  getActiveFilePath: () => mockGetActiveFilePath(),
  // Mirror the real parseRectCacheKey (node-ops.ts) — pure string parsing.
  parseRectCacheKey: (key: string) => {
    const colonIdx = key.indexOf(':');
    if (colonIdx < 0) return null;
    return { vpPrefix: key.slice(0, colonIdx), nodeId: key.slice(colonIdx + 1) };
  },
}));

const mockIsIconSetFilePath = vi.fn((p: string) => p.startsWith('/icon-sets/'));
vi.mock('@/code/project/active-file-store', () => ({
  isIconSetFilePath: (p: string) => mockIsIconSetFilePath(p),
}));

// Import AFTER mocks.
import { collectTopLevelSnapTargets } from './snap-targets';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function makeNode(id: string, parentId: string | null = null): CanvasNode {
  return { id, type: 'div', parentId, children: [], styles: {}, attrs: {} } as unknown as CanvasNode;
}

const IDENTITY: Transform = { x: 0, y: 0, scale: 1 };

beforeEach(() => {
  fakeBridge.rectCache = new Map();
  (fakeBridge.getRect as ReturnType<typeof vi.fn>).mockReset();
  (fakeBridge.getIframeOffset as ReturnType<typeof vi.fn>).mockReset();
  (fakeBridge.getIframeOffset as ReturnType<typeof vi.fn>).mockReturnValue({ x: 0, y: 0 });
  mockGetActiveFilePath.mockReturnValue('/pages/Home.tsx');
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('collectTopLevelSnapTargets', () => {
  it('returns empty when rectCache is empty', () => {
    expect(collectTopLevelSnapTargets(new Set(), '', IDENTITY, new Map())).toEqual([]);
  });

  it('includes parentless siblings, excludes the moving element', () => {
    fakeBridge.rectCache.set(':a', rect(0, 0, 100, 50));
    fakeBridge.rectCache.set(':b', rect(200, 0, 100, 50));
    fakeBridge.rectCache.set(':moving', rect(50, 50, 80, 80));
    (fakeBridge.getRect as any).mockImplementation((id: string) => fakeBridge.rectCache.get(`:${id}`));

    const nodes = new Map<string, CanvasNode>([
      ['a', makeNode('a')],
      ['b', makeNode('b')],
      ['moving', makeNode('moving')],
    ]);

    const out = collectTopLevelSnapTargets(new Set(['moving']), '', IDENTITY, nodes);
    const ids = out.map(t => t.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('excludes nodes that have a parent (non-root, regular file)', () => {
    fakeBridge.rectCache.set(':top', rect(0, 0, 100, 50));
    fakeBridge.rectCache.set(':child', rect(0, 100, 100, 50));
    (fakeBridge.getRect as any).mockImplementation((id: string) => fakeBridge.rectCache.get(`:${id}`));

    const nodes = new Map<string, CanvasNode>([
      ['top', makeNode('top')],
      ['child', makeNode('child', 'top')],
    ]);

    const out = collectTopLevelSnapTargets(new Set(), '', IDENTITY, nodes);
    expect(out.map(t => t.id)).toEqual(['top']);
  });

  it('on icon-set master, includes direct children of root as top-level peers', () => {
    mockGetActiveFilePath.mockReturnValue('/icon-sets/MyIcons.tsx');
    fakeBridge.rectCache.set(':variant1', rect(0, 0, 100, 50));
    fakeBridge.rectCache.set(':deeper', rect(0, 100, 100, 50));
    (fakeBridge.getRect as any).mockImplementation((id: string) => fakeBridge.rectCache.get(`:${id}`));

    const nodes = new Map<string, CanvasNode>([
      ['variant1', makeNode('variant1', 'root')],   // direct child of root → counted
      ['deeper', makeNode('deeper', 'variant1')],   // grandchild → excluded
    ]);

    const out = collectTopLevelSnapTargets(new Set(), '', IDENTITY, nodes);
    expect(out.map(t => t.id)).toEqual(['variant1']);
  });

  it('on regular page (not container master), excludes parentId === "root" entries', () => {
    fakeBridge.rectCache.set(':rootChild', rect(0, 0, 100, 50));
    (fakeBridge.getRect as any).mockImplementation((id: string) => fakeBridge.rectCache.get(`:${id}`));

    const nodes = new Map<string, CanvasNode>([
      ['rootChild', makeNode('rootChild', 'root')],
    ]);

    const out = collectTopLevelSnapTargets(new Set(), '', IDENTITY, nodes);
    expect(out).toEqual([]);
  });

  it('keeps cross-prefix paintings of the same dataId (multi-viewport master)', () => {
    fakeBridge.rectCache.set(':moving', rect(50, 50, 80, 80));
    fakeBridge.rectCache.set('tablet-:moving', rect(500, 50, 80, 80));
    (fakeBridge.getRect as any).mockImplementation((id: string, prefix: string) =>
      fakeBridge.rectCache.get(`${prefix}:${id}`),
    );

    const nodes = new Map<string, CanvasNode>([
      ['moving', makeNode('moving')],
    ]);

    // Moving in the desktop painting → tablet painting of the same id
    // should still appear as a snap target.
    const out = collectTopLevelSnapTargets(new Set(['moving']), '', IDENTITY, nodes);
    expect(out.map(t => t.id)).toEqual(['tablet-moving']);
  });

  it('skips entries where the bridge has no rect lookup (race / disconnected)', () => {
    fakeBridge.rectCache.set(':a', rect(0, 0, 100, 50));
    fakeBridge.rectCache.set(':b', rect(0, 0, 100, 50));
    (fakeBridge.getRect as any).mockImplementation((id: string) =>
      id === 'a' ? rect(0, 0, 100, 50) : null,
    );

    const nodes = new Map<string, CanvasNode>([
      ['a', makeNode('a')],
      ['b', makeNode('b')],
    ]);

    const out = collectTopLevelSnapTargets(new Set(), '', IDENTITY, nodes);
    expect(out.map(t => t.id)).toEqual(['a']);
  });

  it('converts screen rects to canvas-space using the camera transform + iframe offset', () => {
    (fakeBridge.getIframeOffset as any).mockReturnValue({ x: 50, y: 30 });
    fakeBridge.rectCache.set(':a', rect(0, 0, 1, 1));
    (fakeBridge.getRect as any).mockReturnValue(rect(550, 230, 200, 100));

    const nodes = new Map<string, CanvasNode>([['a', makeNode('a')]]);

    // transform: screen = canvas * scale + (tx, ty); plus iframe offset.
    // Inverting: canvas = (screen - offset - t) / scale.
    const transform: Transform = { x: 100, y: 50, scale: 2 };
    const out = collectTopLevelSnapTargets(new Set(), '', transform, nodes);

    expect(out).toHaveLength(1);
    expect(out[0].rect).toMatchObject({
      left: (550 - 50 - 100) / 2,   // 200
      top: (230 - 30 - 50) / 2,     // 75
      width: 200 / 2,               // 100
      height: 100 / 2,              // 50
    });
  });

  it('skips cache entries with no `:` separator (malformed key)', () => {
    fakeBridge.rectCache.set('no-colon-key', rect(0, 0, 1, 1));
    (fakeBridge.getRect as any).mockReturnValue(rect(0, 0, 1, 1));

    const out = collectTopLevelSnapTargets(new Set(), '', IDENTITY, new Map());
    expect(out).toEqual([]);
  });
});
