// enclosing-section.test.ts — the "Section in View" default target: the
// node's nearest ANCHORED ancestor (html id attribute), skipping unanchored
// wrappers; the node's own anchor never self-targets.

import { describe, it, expect, vi } from 'vitest';

let mockNodes = new Map<string, any>();
vi.mock('@/code/stores/store', () => ({ getNodesSnapshot: () => mockNodes }));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

import { findEnclosingAnchorId } from './enclosing-section';

const n = (id: string, parentId: string | null, anchor?: string) => [
  id, { id, parentId, attrs: anchor ? { id: anchor } : {} },
] as const;

describe('findEnclosingAnchorId', () => {
  it('returns the direct parent section anchor', () => {
    mockNodes = new Map([n('root', null), n('sec-1', 'root', 'features'), n('p-1', 'sec-1')]);
    expect(findEnclosingAnchorId('p-1')).toBe('features');
  });

  it('skips unanchored wrappers up to the anchored section', () => {
    mockNodes = new Map([
      n('root', null), n('sec-1', 'root', 'hero'), n('wrap', 'sec-1'), n('p-1', 'wrap'),
    ]);
    expect(findEnclosingAnchorId('p-1')).toBe('hero');
  });

  it('ignores the node OWN anchor (no self-target)', () => {
    mockNodes = new Map([n('root', null), n('sec-1', 'root'), n('p-1', 'sec-1', 'my-own-anchor')]);
    expect(findEnclosingAnchorId('p-1')).toBe('');
  });

  it('returns "" when no ancestor is anchored', () => {
    mockNodes = new Map([n('root', null), n('sec-1', 'root'), n('p-1', 'sec-1')]);
    expect(findEnclosingAnchorId('p-1')).toBe('');
  });

  it('returns "" for an unknown node', () => {
    mockNodes = new Map();
    expect(findEnclosingAnchorId('nope')).toBe('');
  });
});
