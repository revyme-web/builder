import { describe, it, expect } from 'vitest';
import { resolveSketchTargets, isSketchNode } from './sketch-targets';
import type { CanvasNode } from '@/code/parsing/parser';

// EMPIRICAL PIN, live find 2026-07-29: selecting several sketches and setting
// the Brush Fill recolored only the LAST-selected one — the brush writers
// targeted the single primary nodeId. Same class as the SvgShapeTool fan-out
// (svg-shape-targets, 2026-07-24): every custom writer in a tool that renders
// for multi-select must iterate ALL selected ids.

const sketch = (id: string): CanvasNode => ({
  id, type: 'svg', name: 'Sketch', parentId: null, children: [],
  styles: {}, attrs: { 'data-sketch': 'true' }, textContent: '',
} as unknown as CanvasNode);
const frame = (id: string): CanvasNode => ({
  id, type: 'div', name: 'Frame', parentId: null, children: [],
  styles: {}, attrs: {}, textContent: '',
} as unknown as CanvasNode);

const mapOf = (...nodes: CanvasNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe('resolveSketchTargets', () => {
  it('multi-select → every selected sketch (the fill fan-out)', () => {
    const nodes = mapOf(sketch('s1'), sketch('s2'), sketch('s3'));
    expect(resolveSketchTargets(null, ['s1', 's2', 's3'], 's3', nodes)).toEqual(['s1', 's2', 's3']);
  });

  it('non-sketch nodes in the selection are filtered out', () => {
    const nodes = mapOf(sketch('s1'), frame('f1'), sketch('s2'));
    expect(resolveSketchTargets(null, ['s1', 'f1', 's2'], 's1', nodes)).toEqual(['s1', 's2']);
  });

  it('sketch-edit mode pins to the edited sketch regardless of selection', () => {
    const nodes = mapOf(sketch('s1'), sketch('s2'));
    expect(resolveSketchTargets('s2', ['s1', 's2'], 's1', nodes)).toEqual(['s2']);
  });

  it('falls back to the primary when nothing in the selection resolves (never regresses single-select)', () => {
    expect(resolveSketchTargets(null, [], 's1', mapOf())).toEqual(['s1']);
  });

  it('grouped sketches (data-sketch stripped, name kept) still count', () => {
    const grouped = { ...sketch('g1'), attrs: {} } as CanvasNode;
    expect(isSketchNode(grouped)).toBe(true);
    expect(resolveSketchTargets(null, ['g1'], 'g1', mapOf(grouped))).toEqual(['g1']);
  });
});
