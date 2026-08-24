import { describe, it, expect } from 'vitest';
import { displayEstablishesLayout } from './handle-gates';

describe('displayEstablishesLayout — padding handles', () => {
  it('THE REPORT: a no-layout frame does not get them', () => {
    // The chart bar: `order` / `flex` / `width` / `height` / `borderRadius`,
    // absolutely positioned children, no display of its own.
    expect(displayEstablishesLayout('block')).toBe(false);
    expect(displayEstablishesLayout('')).toBe(false);
  });

  it('flex and grid containers do', () => {
    expect(displayEstablishesLayout('flex')).toBe(true);
    expect(displayEstablishesLayout('grid')).toBe(true);
  });

  it('their INLINE forms count too — same layout, different outer role', () => {
    expect(displayEstablishesLayout('inline-flex')).toBe(true);
    expect(displayEstablishesLayout('inline-grid')).toBe(true);
  });

  it('other display values do not', () => {
    for (const d of ['inline', 'inline-block', 'contents', 'none', 'table', 'flow-root']) {
      expect(displayEstablishesLayout(d), d).toBe(false);
    }
  });

  it('a FLEX ITEM is not a flex container — `flex` in the style object is a different property', () => {
    // The bar carries `flex: '1 0 0px'`. Only the resolved `display` decides,
    // and this reads display, so the item's own flex shorthand never leaks in.
    expect(displayEstablishesLayout('block')).toBe(false);
  });
});
