// order-positioning.test.ts — pure unit tests for spaced-rank order helpers.

import { describe, it, expect } from 'vitest';
import { ORDER_GAP, rankToOrder, pickPlaceholderOrder, normalizeFlowSpans } from './order-positioning';

describe('rankToOrder', () => {
  it('multiplies rank by the spaced gap', () => {
    expect(rankToOrder(0)).toBe(0);
    expect(rankToOrder(1)).toBe(ORDER_GAP);
    expect(rankToOrder(5)).toBe(ORDER_GAP * 5);
  });
});

describe('pickPlaceholderOrder', () => {
  it('returns 0 when there are no siblings', () => {
    expect(pickPlaceholderOrder([], 0)).toBe(0);
    expect(pickPlaceholderOrder([], 5)).toBe(0);
  });

  describe('insert before all siblings', () => {
    it('produces a value smaller than the first sibling', () => {
      const orders = [0, 10, 20];
      const result = pickPlaceholderOrder(orders, 0);
      expect(result).toBeLessThan(orders[0]);
    });

    it('handles negative insert indices the same as 0', () => {
      const orders = [0, 10, 20];
      expect(pickPlaceholderOrder(orders, -1)).toBe(pickPlaceholderOrder(orders, 0));
    });
  });

  describe('insert after all siblings', () => {
    it('produces a value larger than the last sibling', () => {
      const orders = [0, 10, 20];
      const result = pickPlaceholderOrder(orders, 3);
      expect(result).toBeGreaterThan(orders[orders.length - 1]);
    });

    it('handles oversized insert indices the same as siblings.length', () => {
      const orders = [0, 10, 20];
      expect(pickPlaceholderOrder(orders, 10)).toBe(pickPlaceholderOrder(orders, orders.length));
    });
  });

  describe('insert between two siblings', () => {
    it('produces a value strictly between neighbors', () => {
      const orders = [0, 10, 20];
      const result = pickPlaceholderOrder(orders, 1);
      expect(result).toBeGreaterThan(orders[0]);
      expect(result).toBeLessThan(orders[1]);
    });

    it('produces the midpoint when neighbors are evenly spaced', () => {
      expect(pickPlaceholderOrder([0, 10, 20], 1)).toBe(5);
      expect(pickPlaceholderOrder([0, 10, 20], 2)).toBe(15);
    });

    it('rounds correctly when midpoint is fractional', () => {
      // (5 + 6) / 2 = 5.5 → rounds to 6 (Math.round, half-away-from-zero)
      expect(pickPlaceholderOrder([5, 6], 1)).toBe(6);
    });

    it('produces integers (CSS order accepts integers only)', () => {
      const cases = [
        { orders: [0, 10], idx: 1 },
        { orders: [0, 10, 20, 30], idx: 2 },
        { orders: [-5, 5], idx: 1 },
      ];
      for (const { orders, idx } of cases) {
        const result = pickPlaceholderOrder(orders, idx);
        expect(Number.isInteger(result)).toBe(true);
      }
    });
  });

  it('round-trips through rankToOrder for a typical drag', () => {
    // Three siblings at ranks 0, 1, 2 → orders 0, 10, 20
    const siblingOrders = [0, 1, 2].map(rankToOrder);
    expect(siblingOrders).toEqual([0, 10, 20]);
    // Placeholder at slot 0 = before first
    expect(pickPlaceholderOrder(siblingOrders, 0)).toBeLessThan(0);
    // Placeholder at slot 1 = between [0] and [10]
    const slot1 = pickPlaceholderOrder(siblingOrders, 1);
    expect(slot1).toBeGreaterThan(0);
    expect(slot1).toBeLessThan(10);
    // Placeholder at slot 2 = between [10] and [20]
    const slot2 = pickPlaceholderOrder(siblingOrders, 2);
    expect(slot2).toBeGreaterThan(10);
    expect(slot2).toBeLessThan(20);
    // Placeholder at slot 3 = after last
    expect(pickPlaceholderOrder(siblingOrders, 3)).toBeGreaterThan(20);
  });
});

describe('normalizeFlowSpans', () => {
  it('passes disjoint spans through unchanged', () => {
    const spans = [{ start: 0, end: 100 }, { start: 120, end: 300 }];
    expect(normalizeFlowSpans(spans)).toEqual(spans);
  });

  it('clips a negative-margin overlap to the earlier sibling', () => {
    // second span starts INSIDE the first (marginTop:-614-style overlap)
    expect(normalizeFlowSpans([
      { start: 800, end: 1300 },
      { start: 686, end: 1386 },
    ])).toEqual([
      { start: 800, end: 1300 },
      { start: 1300, end: 1386 }, // starts where the previous ends
    ]);
  });

  it('collapses a fully-contained span to zero length at the cursor', () => {
    expect(normalizeFlowSpans([
      { start: 0, end: 500 },
      { start: 100, end: 200 },
      { start: 600, end: 700 },
    ])).toEqual([
      { start: 0, end: 500 },
      { start: 500, end: 500 },
      { start: 600, end: 700 },
    ]);
  });
});
