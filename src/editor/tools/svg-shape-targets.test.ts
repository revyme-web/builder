// Fan-out enumeration for SvgShapeTool Fill/Stroke — multi-select must hit
// EVERY selected SVG shape, not just the primary (live find 2026-07-24).
import { describe, it, expect } from 'vitest';
import { resolveShapeAttrTargets } from './svg-shape-targets';
import type { CanvasNode } from '@/code/parsing/parser';

const svg = (id: string, childId: string): CanvasNode => ({
  id, type: 'svg', name: 'svg', parentId: 'p', children: [childId], styles: {}, attrs: {},
} as unknown as CanvasNode);
const path = (id: string): CanvasNode => ({
  id, type: 'path', name: 'path', parentId: '', children: [], styles: {}, attrs: {},
} as unknown as CanvasNode);

// Injected shape-child resolver: the svg's first child.
const resolveChild = (s: CanvasNode, nodes: Map<string, CanvasNode>) =>
  nodes.get(s.children[0]) ?? null;

function makeNodes(): Map<string, CanvasNode> {
  return new Map<string, CanvasNode>([
    ['s1', svg('s1', 'p1')], ['p1', path('p1')],
    ['s2', svg('s2', 'p2')], ['p2', path('p2')],
    ['s3', svg('s3', 'p3')], ['p3', path('p3')],
    ['box', { id: 'box', type: 'div', children: [], styles: {}, attrs: {}, parentId: 'p' } as unknown as CanvasNode],
  ]);
}

describe('resolveShapeAttrTargets', () => {
  const primary = (id: string, shape: CanvasNode | null) => ({ nodeId: id, shapeNode: shape, childIndex: 0 });

  it('single-select → just the primary (keeps its childIndex)', () => {
    const nodes = makeNodes();
    const out = resolveShapeAttrTargets(['s1'], { nodeId: 's1', shapeNode: nodes.get('p1')!, childIndex: 2 }, nodes, resolveChild);
    expect(out).toEqual([{ nodeId: 's1', shapeNode: nodes.get('p1'), childIndex: 2 }]);
  });

  it('multi-select → EVERY selected svg, each its own shape child at index 0', () => {
    const nodes = makeNodes();
    const out = resolveShapeAttrTargets(['s1', 's2', 's3'], primary('s1', nodes.get('p1')!), nodes, resolveChild);
    expect(out.map(t => t.nodeId)).toEqual(['s1', 's2', 's3']);
    expect(out.map(t => t.shapeNode?.id)).toEqual(['p1', 'p2', 'p3']);
    expect(out.every(t => t.childIndex === 0)).toBe(true);
  });

  it('multi-select ignores non-svg nodes in the selection', () => {
    const nodes = makeNodes();
    const out = resolveShapeAttrTargets(['s1', 'box', 's2'], primary('s1', nodes.get('p1')!), nodes, resolveChild);
    expect(out.map(t => t.nodeId)).toEqual(['s1', 's2']);   // 'box' dropped
  });

  it('single-select with no primary nodeId → empty (nothing to write)', () => {
    const nodes = makeNodes();
    expect(resolveShapeAttrTargets([], { nodeId: null, shapeNode: null, childIndex: 0 }, nodes, resolveChild)).toEqual([]);
  });

  it('multi-select where a shape has no inner child → shapeNode null but still targeted', () => {
    const nodes = makeNodes();
    nodes.set('s2', { id: 's2', type: 'svg', children: [], styles: {}, attrs: {}, parentId: 'p' } as unknown as CanvasNode);
    const out = resolveShapeAttrTargets(['s1', 's2'], primary('s1', nodes.get('p1')!), nodes, resolveChild);
    expect(out.map(t => t.nodeId)).toEqual(['s1', 's2']);
    expect(out[1].shapeNode).toBeNull();
  });
});
