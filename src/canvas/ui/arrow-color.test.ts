// arrow-color.test.ts — Coverage for the variant-connection arrow
// color rules. Selection × arrow-kind × variant-scope produces a small
// matrix; we enumerate the meaningful cells.

import { describe, it, expect } from 'vitest';
import { pickArrowColor, ARROW_COLOR, ARROW_COLOR_GREYED } from './arrow-color';

// Convenience: most tests don't care about every corner of the input —
// these helpers fix the irrelevant fields to defensible defaults.
const arrow = (
  from: string,
  to: string,
  sourceNode?: string,
) => ({ from, to, sourceNode });

describe('pickArrowColor', () => {
  // ─── Rule 1: no selection → everything greyed ──────────────────────────
  describe('no selection', () => {
    it('greys a per-child arrow', () => {
      expect(
        pickArrowColor(arrow('default', 'v-1', 'btn-1'), null, false, 'desktop'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it('greys a root arrow (regression: was previously purple)', () => {
      // BEFORE the May-2026 fix this returned ARROW_COLOR because
      // isChildSelection was false. The whole reason this helper
      // exists is to make this test impossible to forget.
      expect(
        pickArrowColor(arrow('default', 'v-1'), null, false, 'desktop'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it('greys regardless of viewport / isChildSelection', () => {
      expect(pickArrowColor(arrow('a', 'b'), null, true, 'a')).toBe(ARROW_COLOR_GREYED);
      expect(pickArrowColor(arrow('a', 'b', 'x'), null, true, 'a')).toBe(ARROW_COLOR_GREYED);
    });
  });

  // ─── Rule 2: per-child arrows match BOTH the trigger AND the variant ──
  describe('per-child arrow (sourceNode set)', () => {
    it('highlights when sourceNode AND fromVp match', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2', 'btn-1'), 'btn-1', true, 'v-1'),
      ).toBe(ARROW_COLOR);
    });

    it("greys when sourceNode matches but the user is in a DIFFERENT variant", () => {
      // Same child data-id rendered in a replica of another variant —
      // selection lands on that replica, but the connection fires from
      // v-1's instance, not this one.
      expect(
        pickArrowColor(arrow('v-1', 'v-2', 'btn-1'), 'btn-1', true, 'v-3'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it('greys when a sibling child is selected in the same variant', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2', 'btn-1'), 'btn-2', true, 'v-1'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it('greys when the variant root is selected (not the child trigger)', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2', 'btn-1'), 'card-root', false, 'v-1'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it("normalizes 'default' to 'desktop' in fromVp matching", () => {
      expect(
        pickArrowColor(arrow('default', 'v-2', 'btn-1'), 'btn-1', true, 'desktop'),
      ).toBe(ARROW_COLOR);
    });
  });

  // ─── Rule 3 + 4: root arrows depend on variant scoping ────────────────
  describe('root arrow (no sourceNode)', () => {
    it('greys when a child is selected, regardless of viewport', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'btn-1', true, 'v-1'),
      ).toBe(ARROW_COLOR_GREYED);
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'btn-1', true, 'v-3'),
      ).toBe(ARROW_COLOR_GREYED);
    });

    it('highlights when selectedVpId matches the source variant', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'card-root', false, 'v-1'),
      ).toBe(ARROW_COLOR);
    });

    it('highlights when selectedVpId matches the target variant', () => {
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'card-root', false, 'v-2'),
      ).toBe(ARROW_COLOR);
    });

    it("normalizes 'default' → 'desktop' on either end", () => {
      expect(
        pickArrowColor(arrow('default', 'v-2'), 'card-root', false, 'desktop'),
      ).toBe(ARROW_COLOR);
      expect(
        pickArrowColor(arrow('v-1', 'default'), 'card-root', false, 'desktop'),
      ).toBe(ARROW_COLOR);
    });

    it('GREYS arrows that involve neither end (regression: previously purple)', () => {
      // The bug: with multiple variants on the master page, ALL root
      // arrows lit up whenever any variant root was selected. This
      // test asserts that an arrow connecting v-1 ↔ v-2 stays grey
      // when the user is interacting in v-3.
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'card-root', false, 'v-3'),
      ).toBe(ARROW_COLOR_GREYED);
      expect(
        pickArrowColor(arrow('v-1', 'v-2'), 'card-root', false, 'desktop'),
      ).toBe(ARROW_COLOR_GREYED);
    });
  });

  // ─── Canvas-node selection: grey all EXCEPT the node's own connection ──
  it('greys variant arrows for a CANVAS NODE selection, but HIGHLIGHTS the node’s own connection arrow', () => {
    // A variant arrow (sourceNode is a different node / variant-level) stays greyed under canvas-node selection…
    expect(pickArrowColor(arrow('v-1', 'v-2'), 'detach-x', false, 'v-1', true)).toBe(ARROW_COLOR_GREYED);
    // …but the canvas node's OWN connection arrow (its sourceNode === the selected canvas node) highlights.
    expect(pickArrowColor(arrow('detach-x', 'v-1', 'detach-x'), 'detach-x', false, 'desktop', true)).toBe(ARROW_COLOR);
    // a DIFFERENT canvas node's arrow stays greyed.
    expect(pickArrowColor(arrow('detach-y', 'v-1', 'detach-y'), 'detach-x', false, 'desktop', true)).toBe(ARROW_COLOR_GREYED);
  });

  // ─── Sanity: the two color constants are actually distinct ────────────
  it('returns one of the two known colors and they are not equal', () => {
    expect(ARROW_COLOR).not.toBe(ARROW_COLOR_GREYED);
    expect(
      pickArrowColor(arrow('v-1', 'v-2', 'a'), 'a', true, 'v-1'),
    ).toBe(ARROW_COLOR);
    expect(
      pickArrowColor(arrow('v-1', 'v-2', 'a'), null, false, 'v-1'),
    ).toBe(ARROW_COLOR_GREYED);
  });
});
