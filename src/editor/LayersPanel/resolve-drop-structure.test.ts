// resolve-drop-structure.test.ts — the layers-drop indicator → structural
// insert mapping.
//
// The panel's `nodes` map is the MERGED tree: a templated page's root children
// lead with `layout::` chrome that doesn't exist in the page FILE. The old
// code fed `parent.children.indexOf(target)` straight to the generators, whose
// index space is file-only — every root drop landed one slot late per leading
// chrome node ("dropped before the hero, landed after it", 2026-08-11). Both
// generators also splice in a child space WITHOUT the dragged node, so the
// dragged id must come out of the count as well.

import { describe, it, expect } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';
import { resolveLayerDropStructure } from './drag';

function nodeMap(entries: Record<string, { parentId?: string | null; children?: string[] }>): Map<string, CanvasNode> {
  const map = new Map<string, CanvasNode>();
  for (const [id, n] of Object.entries(entries)) {
    map.set(id, { id, parentId: n.parentId ?? null, children: n.children ?? [] } as unknown as CanvasNode);
  }
  return map;
}

// The real bug's shape: merged root = [nav chrome, hero, how, faq, footer chrome].
const TEMPLATED = nodeMap({
  root: { children: ['layout::KuFeJo-nav', 'hero', 'how', 'faq', 'layout::JiTaJo-footer'] },
  hero: { parentId: 'root', children: ['arc', 'stats'] },
  how: { parentId: 'root' },
  faq: { parentId: 'root' },
  stats: { parentId: 'hero' },
  arc: { parentId: 'hero' },
});

describe('resolveLayerDropStructure — templated page (leading chrome)', () => {
  it("'before hero' is FILE index 0 with hero as the anchor (was 1 → landed after)", () => {
    const r = resolveLayerDropStructure(TEMPLATED, { nodeId: 'hero', position: 'before' }, 'stats');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 0, insertBeforeId: 'hero' });
  });

  it("'after hero' anchors on the next real section", () => {
    const r = resolveLayerDropStructure(TEMPLATED, { nodeId: 'hero', position: 'after' }, 'stats');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 1, insertBeforeId: 'how' });
  });

  it("'after' the last section appends — no anchor (trailing chrome is not one)", () => {
    const r = resolveLayerDropStructure(TEMPLATED, { nodeId: 'faq', position: 'after' }, 'stats');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 3, insertBeforeId: undefined });
  });

  it("'inside' the root appends at the FILE child count, not the merged one", () => {
    const r = resolveLayerDropStructure(TEMPLATED, { nodeId: 'root', position: 'inside' }, 'stats');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 3 });
  });
});

describe('resolveLayerDropStructure — dragged node excluded from the index space', () => {
  // Generators splice with the dragged node already removed: an index counted
  // with it present lands one late whenever it precedes the target.
  const PLAIN = nodeMap({
    root: { children: ['a', 'b', 'c'] },
    a: { parentId: 'root' },
    b: { parentId: 'root' },
    c: { parentId: 'root' },
  });

  it("dragging 'a' after 'b' is index 1 in the sans-dragged space (not 2)", () => {
    const r = resolveLayerDropStructure(PLAIN, { nodeId: 'b', position: 'after' }, 'a');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 1, insertBeforeId: 'c' });
  });

  it("dragging 'c' before 'b' is index 1 with 'b' as anchor", () => {
    const r = resolveLayerDropStructure(PLAIN, { nodeId: 'b', position: 'before' }, 'c');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 1, insertBeforeId: 'b' });
  });
});

describe('resolveLayerDropStructure — {children} slot on a template master', () => {
  // The slot occupies a generator slot (JSXExpressionContainer) so it stays in
  // the COUNT, but it can never be the anchor — it has no data-id to match.
  const TEMPLATE_FILE = nodeMap({
    root: { children: ['nav-sec', 'children-slot', 'footer-sec'] },
    'nav-sec': { parentId: 'root' },
    'footer-sec': { parentId: 'root' },
  });

  it('a drop before the slot keeps the slot in the index and drops the anchor', () => {
    const r = resolveLayerDropStructure(TEMPLATE_FILE, { nodeId: 'nav-sec', position: 'after' }, 'footer-sec');
    expect(r).toEqual({ finalParentId: 'root', structuralInsertIndex: 1, insertBeforeId: undefined });
  });
});

describe('resolveLayerDropStructure — null cases', () => {
  it('unknown inside-target returns null', () => {
    expect(resolveLayerDropStructure(TEMPLATED, { nodeId: 'ghost', position: 'inside' }, 'stats')).toBeNull();
  });

  it('target without a parent returns null', () => {
    expect(resolveLayerDropStructure(TEMPLATED, { nodeId: 'root', position: 'before' }, 'stats')).toBeNull();
  });
});
