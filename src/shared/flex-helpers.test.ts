import { describe, test, it, expect } from 'vitest';
import { parseFlex, formatFlex, isFillMode, getFillMultiplier, makeFillFlex, canUseFill, isMainAxis } from '@/shared/flex-helpers';

describe('parseFlex', () => {
  test('parses "1 0 0px"', () => expect(parseFlex('1 0 0px')).toEqual({ grow: 1, shrink: 0, basis: '0px' }));
  test('parses "2 0 300px"', () => expect(parseFlex('2 0 300px')).toEqual({ grow: 2, shrink: 0, basis: '300px' }));
  test('parses "0 0 auto"', () => expect(parseFlex('0 0 auto')).toEqual({ grow: 0, shrink: 0, basis: 'auto' }));
  test('parses empty', () => expect(parseFlex('')).toEqual({ grow: 0, shrink: 1, basis: 'auto' }));
  test('parses single "1"', () => expect(parseFlex('1')).toEqual({ grow: 1, shrink: 1, basis: 'auto' }));
  test('parses "0 1 auto"', () => expect(parseFlex('0 1 auto')).toEqual({ grow: 0, shrink: 1, basis: 'auto' }));
  test('parses "3 2 100px"', () => expect(parseFlex('3 2 100px')).toEqual({ grow: 3, shrink: 2, basis: '100px' }));
});

describe('formatFlex', () => {
  test('formats shorthand', () => expect(formatFlex({ grow: 1, shrink: 0, basis: '0px' })).toBe('1 0 0px'));
  test('formats with basis', () => expect(formatFlex({ grow: 2, shrink: 1, basis: '300px' })).toBe('2 1 300px'));
  test('formats zero grow', () => expect(formatFlex({ grow: 0, shrink: 0, basis: 'auto' })).toBe('0 0 auto'));
});

describe('isFillMode', () => {
  test('"1 0 0px" is fill', () => expect(isFillMode('1 0 0px')).toBe(true));
  test('"2 0 0px" is fill', () => expect(isFillMode('2 0 0px')).toBe(true));
  test('"1 0 0%" is fill', () => expect(isFillMode('1 0 0%')).toBe(true));
  test('"1 0 0" is fill', () => expect(isFillMode('1 0 0')).toBe(true));
  test('"0 0 auto" is not fill', () => expect(isFillMode('0 0 auto')).toBe(false));
  test('"1 0 300px" is fill (grow > 0, basis is starting size)', () => expect(isFillMode('1 0 300px')).toBe(true));
  test('empty is not fill', () => expect(isFillMode('')).toBe(false));
});

describe('getFillMultiplier', () => {
  test('"1 0 0px" → 1', () => expect(getFillMultiplier('1 0 0px')).toBe(1));
  test('"3 0 0px" → 3', () => expect(getFillMultiplier('3 0 0px')).toBe(3));
  test('"0 0 auto" → 1 (defaults)', () => expect(getFillMultiplier('0 0 auto')).toBe(1));
});

describe('makeFillFlex', () => {
  test('1 → "1 0 0px"', () => expect(makeFillFlex(1)).toBe('1 0 0px'));
  test('2 → "2 0 0px"', () => expect(makeFillFlex(2)).toBe('2 0 0px'));
  test('0 clamps to 1', () => expect(makeFillFlex(0)).toBe('1 0 0px'));
});

describe('canUseFill', () => {
  test('flex row + width = yes', () => expect(canUseFill('flex', 'row', 'width')).toBe(true));
  test('flex row + height = yes (cross-axis fill)', () => expect(canUseFill('flex', 'row', 'height')).toBe(true));
  test('flex column + height = yes', () => expect(canUseFill('flex', 'column', 'height')).toBe(true));
  test('flex column + width = yes (cross-axis fill)', () => expect(canUseFill('flex', 'column', 'width')).toBe(true));
  test('grid = no', () => expect(canUseFill('grid', '', 'width')).toBe(false));
  test('none = no', () => expect(canUseFill('none', '', 'width')).toBe(false));
});

describe('isMainAxis', () => {
  test('row + width = main', () => expect(isMainAxis('row', 'width')).toBe(true));
  test('row + height = cross', () => expect(isMainAxis('row', 'height')).toBe(false));
  test('column + height = main', () => expect(isMainAxis('column', 'height')).toBe(true));
  test('column + width = cross', () => expect(isMainAxis('column', 'width')).toBe(false));
  test('empty (row default) + width = main', () => expect(isMainAxis('', 'width')).toBe(true));
  test('row-reverse + width = main', () => expect(isMainAxis('row-reverse', 'width')).toBe(true));
  test('column-reverse + height = main', () => expect(isMainAxis('column-reverse', 'height')).toBe(true));
});

// ─── wrapHidesGapHandles — replica @media override awareness ────────────────
// A REPLICA's wrap often exists ONLY as a per-viewport @media override; the
// gap-handle gate must consult that map first (live find 2026-07-20: handles
// painted over wrapped pricing cards on the tablet tile).

import { wrapHidesGapHandles } from './flex-helpers';

describe('wrapHidesGapHandles', () => {
  const ov = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('base wrap hides (primary — no override map)', () => {
    expect(wrapHidesGapHandles(null, { flexWrap: 'wrap' }, {})).toBe(true);
  });

  it('replica @media wrap hides even when base says nothing', () => {
    expect(wrapHidesGapHandles(ov({ flexWrap: 'wrap' }), {}, {})).toBe(true);
  });

  it('kebab-case override key also hides', () => {
    expect(wrapHidesGapHandles(ov({ 'flex-wrap': 'wrap-reverse' }), {}, {})).toBe(true);
  });

  it('replica override back to nowrap WINS over a wrapping base', () => {
    expect(wrapHidesGapHandles(ov({ flexWrap: 'nowrap' }), { flexWrap: 'wrap' }, {})).toBe(false);
  });

  it('computed fallback hides (code-component stylesheet wrap)', () => {
    expect(wrapHidesGapHandles(null, {}, { flexWrap: 'wrap' })).toBe(true);
  });

  it('no wrap anywhere shows handles', () => {
    expect(wrapHidesGapHandles(ov({}), { flexDirection: 'row' }, { display: 'flex' })).toBe(false);
  });
});

// ─── crossAxisFillPatch — replica flipped-parent re-base pairing ────────────
import { crossAxisFillPatch } from './flex-helpers';

describe('crossAxisFillPatch', () => {
  it('replica + grow flex pairs the re-base', () => {
    expect(crossAxisFillPatch('width', true, '1 0 0px')).toEqual({ width: '100%', flex: '0 0 auto' });
  });
  it('replica + non-grow flex writes plain 100%', () => {
    expect(crossAxisFillPatch('width', true, '0 0 auto')).toEqual({ width: '100%' });
  });
  it('primary never pairs (grow flex is the other-axis Fill)', () => {
    expect(crossAxisFillPatch('height', false, '1 0 0px')).toEqual({ height: '100%' });
  });
});

// ─── planDirectionFlipRebase — axis flip re-expresses each child's Fill ──────
//
// The reported bug: a card authored `flex: '1 0 0px'` in a ROW, stacked to
// `column` by the tablet band. flex-basis follows the MAIN axis, so basis 0 +
// grow took over the HEIGHT and outranked the band's own
// `height: 213px !important` — the Height input moved nothing, at any value
// (user report 2026-07-26). Same failure the oracle's
// MEDIA_COLUMN_FLIP_MISSING_REBASE rule flags in authored files.
import { planDirectionFlipRebase } from './flex-helpers';

describe('planDirectionFlipRebase', () => {
  describe('row → column', () => {
    it('re-bases a row-fill child so its height applies again', () => {
      // The exact reported node: flex fill, explicit height, NO width — so the
      // freed cross axis takes the fill.
      expect(planDirectionFlipRebase(
        [{ id: 'card', flex: '1 0 0px', height: '326px' }], 'row', 'column',
      )).toEqual([{ id: 'card', styles: { width: '100%', flex: '0 0 auto' } }]);
    });

    it('keeps an existing old-main size instead of claiming it for the fill', () => {
      // `width: 250px` was INERT under basis 0. The flip frees it rather than
      // overwriting the authored number with 100%.
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '1 0 0px', width: '250px' }], 'row', 'column',
      )).toEqual([{ id: 'a', styles: { flex: '0 0 auto' } }]);
      // `auto` is not an authored size — the fill takes it.
      expect(planDirectionFlipRebase(
        [{ id: 'b', flex: '1 0 0px', width: 'auto' }], 'row', 'column',
      )).toEqual([{ id: 'b', styles: { width: '100%', flex: '0 0 auto' } }]);
    });

    it('RECOVERY PATH: a double-toggle heals the reported node, keeping its height', () => {
      // The user's live tablet state: base `flex: 1 0 0px`, band `height: 213px`,
      // parent already flipped to column — height inert. Toggling to row...
      const [toRow] = planDirectionFlipRebase(
        [{ id: 'card', flex: '1 0 0px', height: '213px' }], 'column', 'row',
      );
      expect(toRow.styles).toEqual({ flex: '0 0 auto' });   // 213px untouched
      // ...then back to column: the band now reads `0 0 auto`, so nothing more is
      // needed — and `height: 213px` finally applies.
      expect(planDirectionFlipRebase(
        [{ id: 'card', flex: toRow.styles.flex, height: '213px' }], 'row', 'column',
      )).toEqual([]);
    });

    it('turns a cross-axis (height) fill into the new main-axis grow', () => {
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '0 0 auto', height: '100%' }], 'row', 'column',
      )).toEqual([{ id: 'a', styles: { flex: '1 0 0px', height: '' } }]);
    });

    it('handles a child that fills BOTH axes (grow wins the new main axis)', () => {
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '1 0 0px', height: '100%' }], 'row', 'column',
      )).toEqual([{ id: 'a', styles: { width: '100%', flex: '1 0 0px', height: '' } }]);
    });

    it('leaves a fixed-size child completely alone', () => {
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '0 0 auto', width: '104px', height: '104px' }], 'row', 'column',
      )).toEqual([]);
    });

    it('skips out-of-flow children — flex does not apply to them', () => {
      expect(planDirectionFlipRebase([
        { id: 'abs', flex: '1 0 0px', position: 'absolute' },
        { id: 'fix', flex: '1 0 0px', position: 'fixed' },
        { id: 'rel', flex: '1 0 0px', position: 'relative' },
      ], 'row', 'column')).toEqual([
        { id: 'rel', styles: { width: '100%', flex: '0 0 auto' } },
      ]);
    });
  });

  describe('column → row (the mirror)', () => {
    it('re-bases a column-fill child so its width applies again', () => {
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '1 0 0px', width: '200px' }], 'column', 'row',
      )).toEqual([{ id: 'a', styles: { height: '100%', flex: '0 0 auto' } }]);
    });

    it('turns a cross-axis (width) fill into grow', () => {
      expect(planDirectionFlipRebase(
        [{ id: 'a', flex: '0 0 auto', width: '100%' }], 'column', 'row',
      )).toEqual([{ id: 'a', styles: { flex: '1 0 0px', width: '' } }]);
    });
  });

  it('ROUND-TRIPS: flip and flip back restores the original spelling', () => {
    const [there] = planDirectionFlipRebase([{ id: 'a', flex: '1 0 0px' }], 'row', 'column');
    expect(there.styles).toEqual({ width: '100%', flex: '0 0 auto' });
    // Feed the result back through the reverse flip.
    const [back] = planDirectionFlipRebase(
      [{ id: 'a', flex: there.styles.flex, width: there.styles.width }], 'column', 'row',
    );
    expect(back.styles).toEqual({ flex: '1 0 0px', width: '' });
  });

  it('is a no-op when the AXIS does not change', () => {
    const kids = [{ id: 'a', flex: '1 0 0px' }];
    expect(planDirectionFlipRebase(kids, 'row', 'row')).toEqual([]);
    expect(planDirectionFlipRebase(kids, 'column', 'column')).toEqual([]);
    // row → row-reverse keeps the axis; only the order changes.
    expect(planDirectionFlipRebase(kids, 'row', 'row-reverse')).toEqual([]);
    // An ABSENT direction is `row` (the CSS initial value).
    expect(planDirectionFlipRebase(kids, undefined, 'row')).toEqual([]);
    expect(planDirectionFlipRebase(kids, '', 'column')).toHaveLength(1);
  });

  it('treats column-reverse as the column axis', () => {
    expect(planDirectionFlipRebase(
      [{ id: 'a', flex: '1 0 0px' }], 'row', 'column-reverse',
    )).toEqual([{ id: 'a', styles: { width: '100%', flex: '0 0 auto' } }]);
  });

  it('collapses a fill MULTIPLIER to 1 (proportions are main-axis only)', () => {
    // 3fr can't survive on the cross axis — documented lossy edge.
    expect(planDirectionFlipRebase(
      [{ id: 'a', flex: '3 0 0px' }], 'row', 'column',
    )).toEqual([{ id: 'a', styles: { width: '100%', flex: '0 0 auto' } }]);
  });

  it('does not mistake an authored px/auto cross size for a fill', () => {
    expect(planDirectionFlipRebase([
      { id: 'px', flex: '0 0 auto', height: '326px' },
      { id: 'auto', flex: '0 0 auto', height: 'auto' },
      { id: 'minc', flex: '0 0 auto', height: 'min-content' },
    ], 'row', 'column')).toEqual([]);
  });

  it('handles an empty child list and a missing flex', () => {
    expect(planDirectionFlipRebase([], 'row', 'column')).toEqual([]);
    expect(planDirectionFlipRebase([{ id: 'a' }], 'row', 'column')).toEqual([]);
  });
});

// ─── canvasRootFlowReset — parent-flow props die with the parent ────────────
//
// Reported: drag a node out of a flex row onto the canvas and it kept
// `flex: '1 0 0px'` at module scope — a grow factor with nothing to grow inside
// (2026-07-26). Every exit path builds its commit styles from position/size
// only; the strategies clear flex on the mid-drag LIFT styles (the zIndex 9999
// overlay) and never on the commit.
import { canvasRootFlowReset, PARENT_FLOW_PROPS } from './flex-helpers';

describe('canvasRootFlowReset', () => {
  it('normalises the reported grow flex to 0 0 auto', () => {
    expect(canvasRootFlowReset({ flex: '1 0 0px', width: '360px' }))
      .toEqual({ flex: '0 0 auto' });
  });

  it('normalises ANY flex, not just a grow one', () => {
    expect(canvasRootFlowReset({ flex: '0 1 auto' })).toEqual({ flex: '0 0 auto' });
    expect(canvasRootFlowReset({ flex: '2 0 0px' })).toEqual({ flex: '0 0 auto' });
  });

  it('folds flex LONGHANDS into the shorthand and clears them', () => {
    expect(canvasRootFlowReset({ flexGrow: '1', flexBasis: '0px' }))
      .toEqual({ flex: '0 0 auto', flexGrow: '', flexBasis: '' });
    expect(canvasRootFlowReset({ flex: '1 0 0px', flexShrink: '0' }))
      .toEqual({ flex: '0 0 auto', flexShrink: '' });
  });

  it('removes the other parent-relative props when present', () => {
    expect(canvasRootFlowReset({
      order: '1', alignSelf: 'center', justifySelf: 'end',
      gridColumn: 'span 2', gridRow: '1 / 3', gridArea: 'a',
    })).toEqual({
      order: '', alignSelf: '', justifySelf: '',
      gridColumn: '', gridRow: '', gridArea: '',
    });
  });

  it('writes NOTHING for a node that carries no flow props', () => {
    // Keeps exit-to-canvas from littering `flex: 0 0 auto` onto every node.
    expect(canvasRootFlowReset({ position: 'absolute', left: '10px', width: '360px' })).toEqual({});
    expect(canvasRootFlowReset({})).toEqual({});
    expect(canvasRootFlowReset(undefined)).toEqual({});
    expect(canvasRootFlowReset(null)).toEqual({});
  });

  it('is a no-op when flex is ALREADY neutral (no pointless rewrite)', () => {
    expect(canvasRootFlowReset({ flex: '0 0 auto' })).toEqual({});
    // …but a stray longhand alongside it still gets cleaned up.
    expect(canvasRootFlowReset({ flex: '0 0 auto', flexGrow: '1' }))
      .toEqual({ flex: '0 0 auto', flexGrow: '' });
  });

  it('leaves every non-flow property alone', () => {
    const styles = {
      flex: '1 0 0px', position: 'absolute', left: '-556px', top: '4697px',
      width: '360px', height: '503px', display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'center', maxWidth: '600px',
      overflow: 'hidden', backgroundSize: 'cover',
    };
    const out = canvasRootFlowReset(styles);
    // `flexDirection` / `justifyContent` / `alignItems` describe how this node
    // lays out its OWN children — they survive the move.
    expect(Object.keys(out)).toEqual(['flex']);
  });

  it('only ever emits keys from PARENT_FLOW_PROPS', () => {
    const everything = Object.fromEntries(PARENT_FLOW_PROPS.map(p => [p, '1']));
    for (const key of Object.keys(canvasRootFlowReset(everything))) {
      expect(PARENT_FLOW_PROPS).toContain(key);
    }
  });
});
