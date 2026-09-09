import { describe, test, expect } from 'vitest';
import { outOfFlowLayeringForOrders } from './out-of-flow-order';

describe('outOfFlowLayeringForOrders', () => {
  const oof = new Set(['hero', 'bar', 'bg']);
  const isOof = (id: string) => oof.has(id);
  const noZ = () => undefined;
  test('overlays AFTER a flow sibling that now has order ≥ 1 get z-index 1', () => {
    expect(outOfFlowLayeringForOrders([{ nodeId: 'header', order: 0 }, { nodeId: 'section', order: 1 }], ['header', 'section', 'hero', 'bar'], isOof, noZ))
      .toEqual([{ nodeId: 'hero', zIndex: 1 }, { nodeId: 'bar', zIndex: 1 }]);
  });
  test('a background layer BEFORE every flow sibling is left alone (stays below)', () => {
    expect(outOfFlowLayeringForOrders([{ nodeId: 'title', order: 0 }, { nodeId: 'text', order: 1 }], ['bg', 'title', 'text'], isOof, noZ)).toEqual([]);
  });
  test('nothing needed while every flow order is 0; an authored z-index is respected', () => {
    expect(outOfFlowLayeringForOrders([{ nodeId: 'a', order: 0 }], ['a', 'hero'], isOof, noZ)).toEqual([]);
    expect(outOfFlowLayeringForOrders([{ nodeId: 'a', order: 0 }, { nodeId: 'b', order: 1 }], ['a', 'b', 'hero'], isOof, () => '3')).toEqual([]);
    expect(outOfFlowLayeringForOrders([{ nodeId: 'a', order: 0 }, { nodeId: 'b', order: 1 }], ['a', 'b', 'hero'], isOof, () => 'auto')).toEqual([{ nodeId: 'hero', zIndex: 1 }]);
  });
  test('empty assignments → nothing', () => {
    expect(outOfFlowLayeringForOrders([], ['a', 'hero'], isOof, noZ)).toEqual([]);
  });
});
