// The rule: bake the axes the PARENT was sizing, keep the axes the CONTENT was
// sizing. Every case below is one arrangement a node can be in when Make
// Component takes its parent away.

import { describe, it, expect } from 'vitest';
import { detectHugAxes } from './master-root-sizing';

const FLEX_ROW = { display: 'flex', flexDirection: 'row', alignItems: 'center' };
const FLEX_COL = { display: 'flex', flexDirection: 'column' };
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)' };
const BLOCK = { display: 'block' };

describe('detectHugAxes — flex parent', () => {
  it('THE REPORT: a hug button in a centred row hugs on BOTH axes', () => {
    // `<MotionLink flex: '0 0 auto'>Find an advisor</MotionLink>` in a row with
    // alignItems: center. Neither axis came from the header — the label sized
    // one and the padding the other — so neither may be frozen.
    const self = { position: 'relative', order: '0', flex: '0 0 auto', padding: '10px 18px' };
    expect(detectHugAxes(self, FLEX_ROW)).toEqual({ width: true, height: true });
  });

  it('a FILL row child is parent-sized on the main axis', () => {
    // The 2026-07-08 find: `flex: '1 0 0px'` → master Width 0 without a bake.
    expect(detectHugAxes({ flex: '1 0 0px' }, FLEX_ROW).width).toBe(false);
  });

  it('the CROSS axis stretches by default, so it is parent-sized', () => {
    // No alignItems on the parent → stretch → the row's height sized the child.
    expect(detectHugAxes({ flex: '0 0 auto' }, { display: 'flex' }))
      .toEqual({ width: true, height: false });
  });

  it('alignSelf on the child beats the parent alignItems, both ways', () => {
    expect(detectHugAxes({ alignSelf: 'center' }, { display: 'flex' }).height).toBe(true);
    expect(detectHugAxes({ alignSelf: 'stretch' }, FLEX_ROW).height).toBe(false);
  });

  it('COLUMN swaps which axis is main', () => {
    // Growing in a column takes the leftover HEIGHT; the width is the cross
    // axis and stretches.
    expect(detectHugAxes({ flex: '1 0 0px' }, FLEX_COL)).toEqual({ width: false, height: false });
    expect(detectHugAxes({ flex: '0 0 auto' }, FLEX_COL)).toEqual({ width: false, height: true });
    expect(detectHugAxes({ flex: '0 0 auto', alignSelf: 'flex-start' }, FLEX_COL))
      .toEqual({ width: true, height: true });
  });

  it('a flex item with NO flex key at all is `0 1 auto` — shrink to fit', () => {
    expect(detectHugAxes({ position: 'relative' }, FLEX_ROW).width).toBe(true);
  });

  it('reads the flex longhands when they are used instead of the shorthand', () => {
    expect(detectHugAxes({ flexGrow: '1', flexBasis: '0px' }, FLEX_ROW).width).toBe(false);
    expect(detectHugAxes({ flexGrow: '0', flexBasis: 'auto' }, FLEX_ROW).width).toBe(true);
    // A longhand present alongside the shorthand wins.
    expect(detectHugAxes({ flex: '0 0 auto', flexGrow: '1' }, FLEX_ROW).width).toBe(false);
  });

  it('a fixed flex-BASIS is a size the line supplied, not the content', () => {
    expect(detectHugAxes({ flex: '0 0 240px' }, FLEX_ROW).width).toBe(false);
    expect(detectHugAxes({ flex: '0 0 50%' }, FLEX_ROW).width).toBe(false);
  });

  it('`flex: none` hugs and `flex: auto` fills', () => {
    expect(detectHugAxes({ flex: 'none' }, FLEX_ROW).width).toBe(true);
    expect(detectHugAxes({ flex: 'auto' }, FLEX_ROW).width).toBe(false);
    expect(detectHugAxes({ flex: '1' }, FLEX_ROW).width).toBe(false);
  });

  it('numeric style values parse the same as strings', () => {
    expect(detectHugAxes({ flexGrow: '0' }, FLEX_ROW).width).toBe(true);
  });
});

describe('detectHugAxes — grid parent', () => {
  it('THE 2026-08-09 REPORT: a grid cell sizes both axes', () => {
    expect(detectHugAxes({ position: 'relative' }, GRID)).toEqual({ width: false, height: false });
  });

  it('an item that opts out of stretching hugs that axis', () => {
    expect(detectHugAxes({ justifySelf: 'start' }, GRID)).toEqual({ width: true, height: false });
    expect(detectHugAxes({ alignSelf: 'center' }, GRID)).toEqual({ width: false, height: true });
  });

  it('parent-level justifyItems / alignItems apply to every cell', () => {
    const parent = { ...GRID, justifyItems: 'start', alignItems: 'center' };
    expect(detectHugAxes({}, parent)).toEqual({ width: true, height: true });
  });
});

describe('detectHugAxes — out of flow', () => {
  it('one edge pinned leaves the box shrink-to-fit', () => {
    expect(detectHugAxes({ position: 'absolute', left: '10px', top: '20px' }, BLOCK))
      .toEqual({ width: true, height: true });
  });

  it('BOTH edges pinned means the containing block sizes that axis', () => {
    const self = { position: 'absolute', left: '0px', right: '0px', top: '0px', bottom: '0px' };
    expect(detectHugAxes(self, BLOCK)).toEqual({ width: false, height: false });
  });

  it('an `auto` inset is not a pin', () => {
    const self = { position: 'absolute', left: '0px', right: 'auto' };
    expect(detectHugAxes(self, BLOCK).width).toBe(true);
  });

  it('fixed behaves like absolute; sticky and relative stay in flow', () => {
    expect(detectHugAxes({ position: 'fixed', left: '0px', right: '0px' }, GRID).width).toBe(false);
    // sticky is in flow, so the GRID cell still sizes it
    expect(detectHugAxes({ position: 'sticky', top: '0px' }, GRID).width).toBe(false);
  });
});

describe('detectHugAxes — block flow', () => {
  it('a block box fills its container width but hugs its content height', () => {
    expect(detectHugAxes({ position: 'relative' }, BLOCK)).toEqual({ width: false, height: true });
  });

  it('an inline-level box shrink-wraps on both axes', () => {
    expect(detectHugAxes({ display: 'inline-block' }, BLOCK)).toEqual({ width: true, height: true });
    expect(detectHugAxes({ display: 'inline-flex' }, BLOCK).width).toBe(true);
  });

  it('no parent element at all is treated as block flow', () => {
    expect(detectHugAxes({ position: 'relative' }, null)).toEqual({ width: false, height: true });
  });

  it('an unknown parent display falls through to block flow', () => {
    expect(detectHugAxes({}, { display: 'contents' })).toEqual({ width: false, height: true });
  });
});
