// PinConstraintLines.test.ts — Unit tests for the transform-detection
// helper. The component now hides itself entirely whenever the selected
// node or any ancestor has a CSS `transform`, so the test surface is just
// the walk-up-the-tree predicate.

import { describe, test, expect, vi } from 'vitest';
import { nodeOrAncestorHasTransform } from './pin-constraint-utils';

vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(() => null),
}));

type Stub = { parentId?: string | null; styles?: Record<string, string> };

function makeNodes(entries: Array<{ id: string } & Stub>) {
  return new Map(entries.map((e) => [e.id, { parentId: e.parentId ?? null, styles: e.styles ?? {} }]));
}

describe('nodeOrAncestorHasTransform', () => {
  test('returns false for a flat tree with no transforms', () => {
    const nodes = makeNodes([
      { id: 'root' },
      { id: 'child', parentId: 'root' },
    ]);
    expect(nodeOrAncestorHasTransform('child', nodes)).toBe(false);
  });

  test('returns true when the node itself has a transform', () => {
    const nodes = makeNodes([
      { id: 'root' },
      { id: 'child', parentId: 'root', styles: { transform: 'rotate(15deg)' } },
    ]);
    expect(nodeOrAncestorHasTransform('child', nodes)).toBe(true);
  });

  test('returns true when an ancestor has a transform', () => {
    const nodes = makeNodes([
      { id: 'root', styles: { transform: 'rotate(30deg)' } },
      { id: 'mid', parentId: 'root' },
      { id: 'leaf', parentId: 'mid' },
    ]);
    expect(nodeOrAncestorHasTransform('leaf', nodes)).toBe(true);
  });

  test('treats `none` and empty as no transform', () => {
    const nodes = makeNodes([
      { id: 'root', styles: { transform: 'none' } },
      { id: 'a', parentId: 'root', styles: { transform: '' } },
      { id: 'b', parentId: 'a', styles: { transform: '   ' } }, // whitespace
    ]);
    expect(nodeOrAncestorHasTransform('b', nodes)).toBe(false);
  });

  test('returns false when the node is missing from the map', () => {
    expect(nodeOrAncestorHasTransform('ghost', makeNodes([]))).toBe(false);
  });

  test('returns false when an ancestor link points to a missing node', () => {
    const nodes = makeNodes([{ id: 'orphan', parentId: 'gone' }]);
    expect(nodeOrAncestorHasTransform('orphan', nodes)).toBe(false);
  });

  test('handles cycles defensively (depth cap, no infinite loop)', () => {
    // Construct a manual cycle — should not throw or hang.
    const a = { parentId: 'b', styles: {} as Record<string, string> };
    const b = { parentId: 'a', styles: {} as Record<string, string> };
    const nodes = new Map<string, typeof a>([['a', a], ['b', b]]);
    expect(nodeOrAncestorHasTransform('a', nodes)).toBe(false);
  });

  test('detects a variety of transform functions', () => {
    for (const t of [
      'rotate(45deg)',
      'translateX(10px)',
      'scale(1.5)',
      'skew(5deg)',
      'matrix(1, 0, 0, 1, 0, 0)',
      'rotate(0deg) translate(0, 0)', // composite
    ]) {
      const nodes = makeNodes([
        { id: 'root' },
        { id: 'child', parentId: 'root', styles: { transform: t } },
      ]);
      expect(nodeOrAncestorHasTransform('child', nodes)).toBe(true);
    }
  });
});

// ─── pinDataEqual — the guard that stopped the app crashing ────────────────
//
// PinConstraintLines' RAF loop built a FRESH PinData object every frame and set
// it unconditionally, so every frame re-rendered even when nothing moved. On its
// own that's just waste — but the poll effect's deps include the live `node`
// (identity churns per frame while a drag writes the node cache) and the effect
// kicks its first `update()` off SYNCHRONOUSLY. set → render → effect re-runs →
// set → … with no frame boundary to break the chain: React threw "Maximum
// update depth exceeded" from PinConstraintLines.tsx and took the whole app down
// while dragging an absolute frame (user report 2026-07-26).
//
// Returning the PREVIOUS object when nothing changed lets React bail out
// (Object.is), capping the chain at a single set. Same equality-preserving
// contract `usePolledValue` documents for this skeleton.
import { pinDataEqual, type PinDataLike } from './pin-constraint-utils';

const rect = (left: number, top: number, width = 100, height = 50) => ({ left, top, width, height });

const base: PinDataLike = {
  lp: true, rp: false, tp: true, bp: false,
  er: rect(10, 20), pr: rect(0, 0, 500, 400),
};

describe('pinDataEqual', () => {
  test('a re-poll with identical geometry compares EQUAL (the bail-out)', () => {
    // Fresh objects every frame — `findNodeRect` returns a new DOMRect per call,
    // so reference equality can never help here.
    const next: PinDataLike = { ...base, er: rect(10, 20), pr: rect(0, 0, 500, 400) };
    expect(next).not.toBe(base);
    expect(pinDataEqual(base, next)).toBe(true);
  });

  test('a moved element compares UNEQUAL so the lines still track', () => {
    expect(pinDataEqual(base, { ...base, er: rect(11, 20) })).toBe(false);
    expect(pinDataEqual(base, { ...base, er: rect(10, 21) })).toBe(false);
  });

  test('a resized element or parent compares UNEQUAL', () => {
    expect(pinDataEqual(base, { ...base, er: rect(10, 20, 101, 50) })).toBe(false);
    expect(pinDataEqual(base, { ...base, er: rect(10, 20, 100, 51) })).toBe(false);
    expect(pinDataEqual(base, { ...base, pr: rect(0, 0, 501, 400) })).toBe(false);
  });

  test('every pin flag is compared — a flipped edge must repaint', () => {
    // Dynamic-pin drag flips these live as the auto-pin shifts.
    expect(pinDataEqual(base, { ...base, lp: false })).toBe(false);
    expect(pinDataEqual(base, { ...base, rp: true })).toBe(false);
    expect(pinDataEqual(base, { ...base, tp: false })).toBe(false);
    expect(pinDataEqual(base, { ...base, bp: true })).toBe(false);
  });

  test('handles the null (suppressed) state on either side', () => {
    expect(pinDataEqual(null, null)).toBe(true);   // setPin(null) already bails in React
    expect(pinDataEqual(base, null)).toBe(false);
    expect(pinDataEqual(null, base)).toBe(false);
  });

  test('is reference-equal fast-pathed', () => {
    expect(pinDataEqual(base, base)).toBe(true);
  });
});
