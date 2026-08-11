// grid-config.test.ts — round-trip + reference CSS coverage.

import { describe, test, expect } from 'vitest';
import {
  parseGridConfig, formatGridConfig, defaultGridConfig,
  flexToGridParentStyles, gridChildFillStyles,
  withRowsCount, implicitRowCount,
  type GridConfig,
} from './grid-config';

describe('parseGridConfig — reference cases', () => {
  test('basic 3×2 grid, Min width, Fill height', () => {
    const c = parseGridConfig({
      gridTemplateColumns: 'repeat(3, minmax(53px, 1fr))',
      gridTemplateRows: 'repeat(2, minmax(0px, 1fr))',
      gridAutoRows: 'minmax(0px, 1fr)',
      gap: '34px 49px',
      justifyContent: 'center',
    });
    expect(c.columnsMode).toBe('fixed');
    expect(c.columnsCount).toBe(3);
    expect(c.widthMode).toBe('min');
    expect(c.width).toBe(53);
    expect(c.heightMode).toBe('fill');
    expect(c.rowsCount).toBe(2);
    expect(c.gapY).toBe(34);
    expect(c.gapX).toBe(49);
    expect(c.align).toBe('center');
  });

  test('columns Auto + width Min', () => {
    const c = parseGridConfig({
      gridTemplateColumns: 'repeat(auto-fill, minmax(53px, 1fr))',
      gridAutoRows: 'minmax(0px, 1fr)',
      justifyContent: 'center',
    });
    expect(c.columnsMode).toBe('auto');
    expect(c.widthMode).toBe('min');
    expect(c.width).toBe(53);
    expect(c.heightMode).toBe('fill');  // inferred from gridAutoRows
  });

  test('Fixed height 200px', () => {
    const c = parseGridConfig({
      gridTemplateColumns: 'repeat(3, minmax(53px, 1fr))',
      gridTemplateRows: 'repeat(2, 200px)',
      gridAutoRows: '200px',
      justifyContent: 'end',
    });
    expect(c.heightMode).toBe('fixed');
    expect(c.height).toBe(200);
    expect(c.rowsCount).toBe(2);
    expect(c.align).toBe('end');
  });

  test('Fit Content height (no template-rows)', () => {
    const c = parseGridConfig({
      gridTemplateColumns: 'repeat(3, 1fr)',
    });
    expect(c.heightMode).toBe('fit');
  });

  test('Masonry mode marker (grid-template-rows: masonry)', () => {
    const c = parseGridConfig({
      gridTemplateColumns: 'repeat(3, 1fr)',
      gridTemplateRows: 'masonry',
    });
    expect(c.masonry).toBe(true);
  });
});

describe('formatGridConfig → CSS', () => {
  function withDefaults(over: Partial<GridConfig>): GridConfig {
    return { ...defaultGridConfig(), ...over };
  }

  test('fixed 3×2, Width Min, Height Fill — fixed count drops the px floor (no overflow)', () => {
    const css = formatGridConfig(withDefaults({
      columnsCount: 3, rowsCount: 2,
      gapX: 49, gapY: 34,
      columnsMode: 'fixed', width: 53, widthMode: 'min',
      heightMode: 'fill',
      align: 'center',
    }));
    // A fixed count must NOT carry a px min floor — minmax(53px,1fr) overflows
    // when the container is narrower than 3×53. Equal columns via minmax(0,1fr).
    expect(css.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    expect(css.gridTemplateRows).toBe('repeat(2, minmax(0px, 1fr))');
    expect(css.gridAutoRows).toBe('minmax(0px, 1fr)');
    expect(css.rowGap).toBe('34px');
    expect(css.columnGap).toBe('49px');
  });

  test('columns Auto + width Min KEEPS the px floor (auto-fill wrap threshold)', () => {
    const css = formatGridConfig(withDefaults({
      columnsMode: 'auto', width: 53, widthMode: 'min',
      heightMode: 'fill', rowsCount: 2,
    }));
    // In AUTO mode the px floor is the wrap threshold — auto-fill drops columns
    // rather than overflow, so it's correct (and required) here.
    expect(css.gridTemplateColumns).toBe('repeat(auto-fill, minmax(53px, 1fr))');
  });

  test('fixed height 200px', () => {
    const css = formatGridConfig(withDefaults({
      columnsCount: 3, rowsCount: 2,
      columnsMode: 'fixed', width: 53, widthMode: 'min',
      heightMode: 'fixed', height: 200,
    }));
    expect(css.gridTemplateRows).toBe('repeat(2, 200px)');
    expect(css.gridAutoRows).toBe('200px');
  });

  test('fit content height clears template-rows (does NOT touch parent height)', () => {
    const css = formatGridConfig(withDefaults({ heightMode: 'fit' }));
    expect(css.gridTemplateRows).toBe('');
    expect(css.gridAutoRows).toBe('');
    expect(css.height).toBeUndefined();  // SizeTool owns parent height
  });

  test('masonry sets template + marker (does NOT touch parent height)', () => {
    const css = formatGridConfig(withDefaults({ masonry: true, columnsCount: 3 }));
    expect(css.gridTemplateColumns).toBe('repeat(3, 1fr)');
    expect(css.gridTemplateRows).toBe('masonry');
    expect(css.height).toBeUndefined();
  });

  test('width Fixed produces plain Wpx (no minmax)', () => {
    const css = formatGridConfig(withDefaults({
      columnsCount: 3, columnsMode: 'fixed', widthMode: 'fixed', width: 100,
    }));
    expect(css.gridTemplateColumns).toBe('repeat(3, 100px)');
  });

  test('gap shorthand when X === Y', () => {
    const css = formatGridConfig(withDefaults({ gapX: 16, gapY: 16 }));
    expect(css.gap).toBe('16px');
    expect(css.rowGap).toBe('');
    expect(css.columnGap).toBe('');
  });

  test('align start / end writes justifyContent; center clears', () => {
    expect(formatGridConfig(withDefaults({ align: 'start' })).justifyContent).toBe('start');
    expect(formatGridConfig(withDefaults({ align: 'end' })).justifyContent).toBe('end');
    expect(formatGridConfig(withDefaults({ align: 'center' })).justifyContent).toBe('');
  });
});

describe('round-trip — parse(format(c)) === c', () => {
  const cases: Partial<GridConfig>[] = [
    { columnsMode: 'fixed', columnsCount: 3, width: 53, widthMode: 'min', heightMode: 'fill', rowsCount: 2, gapX: 49, gapY: 34, align: 'center' },
    { columnsMode: 'auto', width: 53, widthMode: 'min', heightMode: 'fit' },
    { columnsMode: 'fixed', columnsCount: 2, widthMode: 'fixed', width: 100, heightMode: 'fixed', height: 200, rowsCount: 3, align: 'end' },
  ];
  for (const partial of cases) {
    test(JSON.stringify(partial), () => {
      const original: GridConfig = { ...defaultGridConfig(), ...partial };
      const css = formatGridConfig(original);
      const reparsed = parseGridConfig(css);
      // Field-by-field compare (only fields the round-trip can preserve).
      expect(reparsed.columnsMode).toBe(original.columnsMode);
      expect(reparsed.widthMode).toBe(original.widthMode);
      expect(reparsed.width).toBe(original.width);
      expect(reparsed.heightMode).toBe(original.heightMode);
      expect(reparsed.gapX).toBe(original.gapX);
      expect(reparsed.gapY).toBe(original.gapY);
      expect(reparsed.align).toBe(original.align);
      if (original.columnsMode === 'fixed') {
        expect(reparsed.columnsCount).toBe(original.columnsCount);
      }
      if (original.heightMode !== 'fit') {
        expect(reparsed.rowsCount).toBe(original.rowsCount);
        if (original.heightMode === 'fixed') expect(reparsed.height).toBe(original.height);
      }
    });
  }
});

// ─── Flex → Grid conversion (the "everything collapses on switch to grid" bug) ─
describe('flexToGridParentStyles', () => {
  test('defaults to 2 overflow-safe columns + FIT-CONTENT rows', () => {
    const p = flexToGridParentStyles();
    // minmax(0, 1fr): never overflows (no px floor) and never blows out the grid
    // (no `auto` min like plain 1fr). Empty rows = fit-content (hug child height).
    expect(p.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(p.gridTemplateRows).toBe('');
    const c = parseGridConfig(p);
    expect(c.heightMode).toBe('fit');
    expect(c.columnsMode).toBe('fixed');
    expect(c.columnsCount).toBe(2);
  });

  test('a fixed minmax(0,1fr) grid round-trips (parse → format → parse)', () => {
    const css = formatGridConfig({ ...parseGridConfig({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }) });
    expect(css.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    const c = parseGridConfig({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
    expect(c.columnsMode).toBe('fixed');
    expect(c.columnsCount).toBe(3);
    expect(c.widthMode).toBe('min');
  });
});

describe('gridChildFillStyles', () => {
  test('fills the column width but NEVER forces height:100%', () => {
    const s = gridChildFillStyles({ position: 'relative', flex: '1 0 0px' });
    expect(s.width).toBe('100%');
    expect('height' in s).toBe(false); // no height key → child keeps its natural/master height
  });

  test('overrides a component master fixed width (324px → 100%)', () => {
    const s = gridChildFillStyles({ width: '324px', height: '620px' });
    expect(s.width).toBe('100%');
    expect('height' in s).toBe(false); // master 620px stays → card renders full height
  });

  test('clears a STALE injected fill-height so a re-toggle stops collapsing', () => {
    const s = gridChildFillStyles({ width: '100%', height: '100%' });
    expect(s.width).toBe('100%');
    expect(s.height).toBe(''); // '' = remove property
  });

  test('tolerates a child with no styles', () => {
    const s = gridChildFillStyles(undefined);
    expect(s).toEqual({ width: '100%' });
  });
});

// ─── Rows in fit-content mode — the "Rows +/- does nothing" bug (2026-08-11) ─
//
// In `fit` height mode the serializer emits NO row template (rows are
// implicit), so a rows-count change updated state that formatGridConfig never
// wrote — verified in the trace: every press emitted `gridTemplateRows: ""`.
// `withRowsCount` is the rows twin of the columns auto→fixed flip: touching
// the count promotes fit → explicit tracks. `implicitRowCount` is what the
// Rows field DISPLAYS in fit mode (it showed the parse default "2" over a
// visibly 3-row grid).
describe('withRowsCount — a rows change must produce visible tracks', () => {
  const fitConfig = (): GridConfig => ({
    ...defaultGridConfig(),
    heightMode: 'fit',
    columnsCount: 5,
  });

  test('fit + definite container height promotes to FILL and the template appears', () => {
    const next = withRowsCount(fitConfig(), 3, '720px');
    expect(next.heightMode).toBe('fill');
    expect(next.rowsCount).toBe(3);
    expect(formatGridConfig(next).gridTemplateRows).toBe('repeat(3, minmax(0px, 1fr))');
  });

  test('fit + auto/min-content height promotes to FIXED (fill would collapse rows to 0)', () => {
    for (const h of [undefined, '', 'auto', 'min-content']) {
      const next = withRowsCount(fitConfig(), 4, h);
      expect(next.heightMode).toBe('fixed');
      expect(formatGridConfig(next).gridTemplateRows).toMatch(/^repeat\(4, \d+px\)$/);
    }
  });

  test('percent and vh container heights count as definite → fill', () => {
    expect(withRowsCount(fitConfig(), 2, '100%').heightMode).toBe('fill');
    expect(withRowsCount(fitConfig(), 2, '50vh').heightMode).toBe('fill');
  });

  test('non-fit modes just take the count', () => {
    const c = { ...defaultGridConfig(), heightMode: 'fill' as const, rowsCount: 2 };
    const next = withRowsCount(c, 5, undefined);
    expect(next.heightMode).toBe('fill');
    expect(next.rowsCount).toBe(5);
  });

  test('count clamps to [1, 20]', () => {
    expect(withRowsCount(fitConfig(), 0, '720px').rowsCount).toBe(1);
    expect(withRowsCount(fitConfig(), 99, '720px').rowsCount).toBe(20);
  });
});

describe('implicitRowCount — what the Rows field shows in fit mode', () => {
  test('15 items across 5 columns = 3 rows (the reported grid)', () => {
    expect(implicitRowCount(15, 5)).toBe(3);
  });
  test('partial last row rounds up; empty grid shows 1', () => {
    expect(implicitRowCount(11, 5)).toBe(3);
    expect(implicitRowCount(0, 5)).toBe(1);
    expect(implicitRowCount(7, 0)).toBe(7);
  });
});
