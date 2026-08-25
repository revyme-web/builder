// Dragging a layout child out of a NON-PRIMARY viewport.
//
// Reported 2026-08-24: with a GRID parent, dragging a child out of a variant
// removed it from every variant including the primary. Flex was fine —
// LayoutLiftedStrategy has always split this in two (move the source only when
// this viewport is the last one showing it, else clone + hide here), and
// GridDragStrategy, a separate strategy for grid parents, never learned any of
// it. The predicate now lives in one place so they cannot drift again.

import { describe, it, expect } from 'vitest';
import { isReplicaOnlyOnViewport } from './replica-exit';

const never = () => '';

describe('isReplicaOnlyOnViewport — component master (variant tiles)', () => {
  const base = {
    otherVpIds: ['desktop', 'variant-1', 'variant-2'],
    isComponentMaster: true,
    readDisplay: never,
  };

  it('THE BUG: a node visible on every variant is NOT solo', () => {
    // Nothing hidden anywhere → the other tiles still render it, so moving the
    // source would empty them. This is the case that was deleting from all.
    expect(isReplicaOnlyOnViewport({ ...base, dropVpId: 'variant-1', hiddenOnVariants: new Set() })).toBe(false);
    expect(isReplicaOnlyOnViewport({ ...base, dropVpId: 'variant-1', hiddenOnVariants: null })).toBe(false);
  });

  it('solo when every OTHER variant already hides it', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'variant-1', hiddenOnVariants: new Set(['default', 'variant-2']),
    })).toBe(true);
  });

  it('not solo while ONE other variant still shows it', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'variant-1', hiddenOnVariants: new Set(['default']),
    })).toBe(false);
  });

  it('the primary tile maps to the variant name `default`', () => {
    // `desktop` is the viewport id; `default` is what the variants object calls
    // it. Comparing the raw id would never match and every check would fail.
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'desktop', hiddenOnVariants: new Set(['variant-1', 'variant-2']),
    })).toBe(true);
  });

  it('ignores inline display — a master keeps visibility in hiddenOnVariants', () => {
    // Reading the page channel here returns "solo" for everything, which is how
    // a shared element gets moved out from under its siblings.
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'variant-1', hiddenOnVariants: new Set(), inlineDisplay: 'none',
    })).toBe(false);
  });
});

describe('isReplicaOnlyOnViewport — page replicas (breakpoints)', () => {
  const base = { otherVpIds: ['desktop', 'tablet', 'mobile'], isComponentMaster: false };

  it('a node without the hide-by-default baseline is never solo', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'tablet', inlineDisplay: 'flex', readDisplay: () => 'none',
    })).toBe(false);
  });

  it('solo when hidden by default and `none` on every other viewport', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'tablet', inlineDisplay: 'none', readDisplay: () => 'none',
    })).toBe(true);
  });

  it('not solo when another viewport un-hides it via @media', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'tablet', inlineDisplay: 'none',
      readDisplay: (vp) => (vp === 'mobile' ? 'block' : 'none'),
    })).toBe(false);
  });

  it('does not test the DROP viewport against itself', () => {
    // It is visible here — that is why the user is dragging it. Including it
    // would make every page replica non-solo.
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'tablet', inlineDisplay: 'none',
      readDisplay: (vp) => (vp === 'tablet' ? 'block' : 'none'),
    })).toBe(true);
  });

  it('ignores hiddenOnVariants — that is the master channel', () => {
    expect(isReplicaOnlyOnViewport({
      ...base, dropVpId: 'tablet', inlineDisplay: 'flex',
      hiddenOnVariants: new Set(['desktop', 'mobile']), readDisplay: () => 'none',
    })).toBe(false);
  });
});
