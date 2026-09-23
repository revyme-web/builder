import { describe, it, expect } from 'vitest';
import { seedFlowChild, planReorder, visualFlowChildren, inheritedFlowStyles, isLayoutParent } from './flow-placement';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (id: string, styles: Record<string, string> = {}, children: string[] = []) =>
  ({ id, type: 'div', styles, children, attrs: {} } as unknown as CanvasNode);
const row = (kids: CanvasNode[], display = 'flex') => {
  const parent = node('row', { display }, kids.map((k) => k.id));
  return { parent, nodes: new Map<string, CanvasNode>([[parent.id, parent], ...kids.map((k) => [k.id, k] as [string, CanvasNode])]) };
};
const abc = () => row([node('a', { order: '0' }), node('b', { order: '1' }), node('c', { order: '2' })]);

describe('seedFlowChild', () => {
  it('a new child of a flex row gets position, no-shrink flex and the NEXT order', () => {
    const { parent, nodes } = abc();
    expect(seedFlowChild({ width: '10px' }, parent, nodes)).toEqual({
      styles: { width: '10px', position: 'relative', flex: '0 0 auto', order: '3' }, siblings: [],
    });
  });

  it('inserting at an index makes room: the siblings after it move down', () => {
    const { parent, nodes } = abc();
    const out = seedFlowChild({}, parent, nodes, 1);
    expect(out.styles.order).toBe('1');
    expect(out.siblings).toEqual([{ id: 'b', order: '2' }, { id: 'c', order: '3' }]);
  });

  it('never overrides what the caller set', () => {
    const { parent, nodes } = abc();
    const out = seedFlowChild({ position: 'relative', flex: '1 0 0px', order: '9' }, parent, nodes);
    expect(out.styles).toMatchObject({ flex: '1 0 0px', order: '9' });
  });

  it('an absolute child is out of the flow: it takes no order and moves nobody', () => {
    const { parent, nodes } = abc();
    expect(seedFlowChild({ position: 'absolute' }, parent, nodes, 0)).toEqual({ styles: { position: 'absolute' }, siblings: [] });
  });

  it('outside a layout only the position is guaranteed', () => {
    const { parent, nodes } = row([node('a')], 'block');
    expect(seedFlowChild({}, parent, nodes)).toEqual({ styles: { position: 'relative' }, siblings: [] });
    expect(seedFlowChild({}, undefined, new Map())).toEqual({ styles: { position: 'relative' }, siblings: [] });
  });

  it('grid counts as a layout too', () => {
    expect(isLayoutParent(node('g', { display: 'grid' }))).toBe(true);
    expect(isLayoutParent(node('g', { display: 'block' }))).toBe(false);
  });

  it('heals siblings that had no order yet while it is there', () => {
    const { parent, nodes } = row([node('a'), node('b')]);
    const out = seedFlowChild({}, parent, nodes);
    expect(out.styles.order).toBe('2');
    expect(out.siblings).toEqual([{ id: 'a', order: '0' }, { id: 'b', order: '1' }]);
  });
});

describe('planReorder — the order the user SEES', () => {
  it('moves the third card to the front', () => {
    const { parent, nodes } = abc();
    expect(planReorder(parent, nodes, 'c', 0)).toEqual([{ id: 'c', order: '0' }, { id: 'a', order: '1' }, { id: 'b', order: '2' }]);
  });
  it('writes nothing when the node is already there', () => {
    const { parent, nodes } = abc();
    expect(planReorder(parent, nodes, 'a', 0)).toEqual([]);
  });
  it('reads the CURRENT visible order from `order`, not from the JSX', () => {
    const { parent, nodes } = row([node('a', { order: '2' }), node('b', { order: '0' }), node('c', { order: '1' })]);
    expect(visualFlowChildren(parent, nodes)).toEqual(['b', 'c', 'a']);
    expect(planReorder(parent, nodes, 'a', 0)).toEqual([{ id: 'a', order: '0' }, { id: 'b', order: '1' }, { id: 'c', order: '2' }]);
  });
  it('clamps a wild index, and ignores a parent that is not a layout', () => {
    const { parent, nodes } = abc();
    expect(planReorder(parent, nodes, 'a', 99)).toEqual([{ id: 'b', order: '0' }, { id: 'c', order: '1' }, { id: 'a', order: '2' }]);
    const block = row([node('a'), node('b')], 'block');
    expect(planReorder(block.parent, block.nodes, 'b', 0)).toEqual([]);
  });
  it('absolute siblings are not part of the sequence', () => {
    const { parent, nodes } = row([node('a', { order: '0' }), node('badge', { position: 'absolute' }), node('b', { order: '1' })]);
    expect(planReorder(parent, nodes, 'b', 0)).toEqual([{ id: 'b', order: '0' }, { id: 'a', order: '1' }]);
  });
});

describe('inheritedFlowStyles', () => {
  it('an element taking another\'s place keeps its slot', () => {
    expect(inheritedFlowStyles(node('x', { position: 'relative', order: '2', flex: '0 0 auto', width: '300px', color: 'red' })))
      .toEqual({ position: 'relative', order: '2', flex: '0 0 auto' });
  });
  it('always has a position', () => {
    expect(inheritedFlowStyles(node('x', {}))).toEqual({ position: 'relative' });
  });
});
