// GroupFillControl.test.ts — unit tests for the pure shape collector that
// drives the SVG-group Fill control (fan-out + Mixed detection).

import { describe, it, expect } from 'vitest';
import { collectGroupShapeSvgs } from './GroupFillControl';
import type { CanvasNode } from '@/code/parsing/parser';

// Minimal CanvasNode factory — only the fields the collector reads matter.
const mk = (partial: Partial<CanvasNode> & { id: string; type: string }): CanvasNode => ({
  name: '',
  parentId: null,
  children: [],
  styles: {},
  attrs: {},
  textContent: '',
  hasMixedContent: false,
  order: 0,
  isCanvasNode: false,
  componentFile: null,
  componentInstanceId: null,
  isComponentRoot: false,
  motionVariants: null,
  motionVariantsRef: null,
  responsiveVariantMap: null,
  conditionalStyles: null,
  motionProps: null,
  ...partial,
} as CanvasNode);

/** Build a leaf shape <svg> (wrapper id `svgId`) holding one polygon with the
 *  given fill, registering both into `nodes`. Returns the wrapper id. */
function addLeafShape(nodes: Map<string, CanvasNode>, svgId: string, fill?: string): string {
  const shapeId = `${svgId}-poly`;
  nodes.set(shapeId, mk({ id: shapeId, type: 'polygon', parentId: svgId, attrs: fill ? { fill } : {} }));
  nodes.set(svgId, mk({ id: svgId, type: 'svg', children: [shapeId] }));
  return svgId;
}

describe('collectGroupShapeSvgs', () => {
  it('collects every direct leaf shape <svg> under the group', () => {
    const nodes = new Map<string, CanvasNode>();
    addLeafShape(nodes, 'a', '#f00');
    addLeafShape(nodes, 'b', '#0f0');
    const group = mk({ id: 'group', type: 'svg', children: ['a', 'b'] });

    const refs = collectGroupShapeSvgs(group, nodes);
    expect(refs.map(r => r.svgId)).toEqual(['a', 'b']);
    expect(refs.map(r => r.shape.attrs?.fill)).toEqual(['#f00', '#0f0']);
  });

  it('recurses into nested groups (svg-of-svgs)', () => {
    const nodes = new Map<string, CanvasNode>();
    addLeafShape(nodes, 'leaf1', '#111');
    addLeafShape(nodes, 'leaf2', '#222');
    // nested group <svg> whose children are themselves shape <svg>s
    nodes.set('inner', mk({ id: 'inner', type: 'svg', children: ['leaf1', 'leaf2'] }));
    addLeafShape(nodes, 'leaf3', '#333');
    const group = mk({ id: 'group', type: 'svg', children: ['inner', 'leaf3'] });

    const refs = collectGroupShapeSvgs(group, nodes);
    expect(refs.map(r => r.svgId).sort()).toEqual(['leaf1', 'leaf2', 'leaf3']);
  });

  it('ignores non-svg children', () => {
    const nodes = new Map<string, CanvasNode>();
    addLeafShape(nodes, 'a', '#f00');
    nodes.set('txt', mk({ id: 'txt', type: 'div', parentId: 'group' }));
    const group = mk({ id: 'group', type: 'svg', children: ['a', 'txt'] });

    const refs = collectGroupShapeSvgs(group, nodes);
    expect(refs.map(r => r.svgId)).toEqual(['a']);
  });

  it('returns empty for a null group or a group with no shape children', () => {
    expect(collectGroupShapeSvgs(null, new Map())).toEqual([]);
    const nodes = new Map<string, CanvasNode>();
    const empty = mk({ id: 'g', type: 'svg', children: [] });
    expect(collectGroupShapeSvgs(empty, nodes)).toEqual([]);
  });
});
