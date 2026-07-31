// axisFillActive — the Size tool's per-axis FILL detection.
//
// The replica case this file locks down (2026-07-28): setting Height → Fill on
// a MOBILE replica writes `flex: 1 0 0px` into the @media override map, but the
// PRIMARY's inline `height: 581px` stays in the base styles (the base belongs
// to the primary). CSS ignores that height (flex-basis 0 governs the main
// axis), but the tool's size guard vetoed the fill display — the replica's
// Height row kept showing "581 px" with no override accent while desktop
// correctly showed "1 fr".

import { describe, it, expect } from 'vitest';
import { axisFillActive } from './SizeTool';

const FILL = '1 0 0px';

describe('axisFillActive', () => {
  it('primary main-axis fill: fill flex with no explicit size', () => {
    expect(axisFillActive(FILL, undefined, true, true, false)).toBe(true);
    expect(axisFillActive(FILL, '', true, true, false)).toBe(true);
  });

  it('primary: an explicit size vetoes the fill display (writer clears it on fill)', () => {
    expect(axisFillActive(FILL, '581px', true, true, false)).toBe(false);
  });

  it('REPLICA override fill: the primary base size no longer vetoes', () => {
    // flex override present for this viewport → base height must be ignored.
    expect(axisFillActive(FILL, '581px', true, true, true)).toBe(true);
  });

  it('no fill flex → never fill, override or not', () => {
    expect(axisFillActive('0 0 auto', '581px', true, true, true)).toBe(false);
    expect(axisFillActive('', undefined, true, true, true)).toBe(false);
  });

  it('cross axis / non-fillable parent → never fill', () => {
    expect(axisFillActive(FILL, undefined, false, true, true)).toBe(false);
    expect(axisFillActive(FILL, undefined, true, false, true)).toBe(false);
  });
});
