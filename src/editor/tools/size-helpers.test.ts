// size-helpers.test.ts — Coverage for SizeTool's px → unit conversion math.

import { describe, it, expect } from 'vitest';
import { convertPxToDimUnit, estimatedVpHeight, isRelativeUnit, dimUnitOf, pickLiveDim, fitSizeRedirectTarget, exitFillFlexPatch, isAutoDim, resolveUnitChangePx } from './size-helpers';

describe('estimatedVpHeight', () => {
  it('uses 16:10 ratio for desktop (>= 1024)', () => {
    expect(estimatedVpHeight(1440)).toBe(1440 * 0.625);
    expect(estimatedVpHeight(1024)).toBe(1024 * 0.625);
  });

  it('uses 3:4 ratio for tablet (500..1023)', () => {
    expect(estimatedVpHeight(768)).toBe(768 * 1.33);
    expect(estimatedVpHeight(500)).toBe(500 * 1.33);
  });

  it('uses 9:19.5 ratio for phone (< 500)', () => {
    expect(estimatedVpHeight(375)).toBe(375 * 2.16);
    expect(estimatedVpHeight(320)).toBe(320 * 2.16);
  });
});

describe('convertPxToDimUnit', () => {
  // 1440 desktop, parent 1440, vpHeight 900
  const PARENT_W = 1440;
  const VP_W = 1440;
  const VP_H = 900;

  it('returns sentinel values for auto and fill', () => {
    expect(convertPxToDimUnit(123, 'auto', PARENT_W, VP_W, VP_H)).toBe('auto');
    expect(convertPxToDimUnit(123, 'fill', PARENT_W, VP_W, VP_H)).toBe('');
  });

  it('px → integer px', () => {
    expect(convertPxToDimUnit(123.7, 'px', PARENT_W, VP_W, VP_H)).toBe('124px');
    expect(convertPxToDimUnit(0, 'px', PARENT_W, VP_W, VP_H)).toBe('0px');
  });

  it('px → % is parent-size-relative as a whole integer', () => {
    expect(convertPxToDimUnit(720, '%', 1440, VP_W, VP_H)).toBe('50%');
    expect(convertPxToDimUnit(1440, '%', 1440, VP_W, VP_H)).toBe('100%');
    // 123/1000*100 = 12.3 → rounds to 12
    expect(convertPxToDimUnit(123, '%', 1000, VP_W, VP_H)).toBe('12%');
  });

  it('px → vw is viewport-width-relative as a whole integer', () => {
    expect(convertPxToDimUnit(720, 'vw', PARENT_W, 1440, VP_H)).toBe('50vw');
    // 720/768*100 = 93.75 → rounds to 94
    expect(convertPxToDimUnit(720, 'vw', PARENT_W, 768, VP_H)).toBe('94vw');
    expect(convertPxToDimUnit(720, 'vw', PARENT_W, 375, VP_H)).toBe('192vw');
  });

  it('px → vh is viewport-height-relative as a whole integer', () => {
    expect(convertPxToDimUnit(450, 'vh', PARENT_W, VP_W, 900)).toBe('50vh');
    expect(convertPxToDimUnit(900, 'vh', PARENT_W, VP_W, 900)).toBe('100vh');
  });

  it('THE BUG: 100% to px now uses parent width, not raw number', () => {
    // Before the fix: handleWidthUnitChange computed
    //   currentPx = (parseFloat('100%') / 100) * parentWidth = 1440
    // which happened to be correct for plain 100% — but the same path also
    // ran for 50vw, where parseFloat('50vw') = 50 was treated as 50px.
    // After the fix: SizeTool reads `computed.width` (the rendered px) and
    // passes it directly here. This test pins the conversion semantics.
    expect(convertPxToDimUnit(1440, 'px', PARENT_W, VP_W, VP_H)).toBe('1440px');
  });

  it('THE BUG: 50vw to px no longer drops the unit', () => {
    // The old code did `parseFloat(styles.width)` which stripped 'vw'
    // and treated '50vw' as 50px. After the fix, SizeTool passes the
    // real rendered px (e.g. 720 at vp=1440) and we convert from there.
    expect(convertPxToDimUnit(720, 'px', PARENT_W, VP_W, VP_H)).toBe('720px');
  });

  it('THE BUG: vw conversion uses simulated viewport, not window.innerWidth', () => {
    // Inside Tablet (768): a 384px wide element should be 50vw, not
    // 384/window.innerWidth × 100 (which would depend on the browser
    // window size).
    expect(convertPxToDimUnit(384, 'vw', PARENT_W, 768, VP_H)).toBe('50vw');
    expect(convertPxToDimUnit(187.5, 'vw', PARENT_W, 375, VP_H)).toBe('50vw');
  });

  it('zero-denominator returns 0<unit> rather than NaN', () => {
    expect(convertPxToDimUnit(100, '%', 0, VP_W, VP_H)).toBe('0%');
    expect(convertPxToDimUnit(100, 'vw', PARENT_W, 0, VP_H)).toBe('0vw');
    expect(convertPxToDimUnit(100, 'vh', PARENT_W, VP_W, 0)).toBe('0vh');
    expect(convertPxToDimUnit(100, '%', -10, VP_W, VP_H)).toBe('0%');
  });

  it('rounds % / vw / vh to whole integers (no decimals)', () => {
    // 333 / 768 * 100 = 43.359 → 43
    expect(convertPxToDimUnit(333, '%', 768, VP_W, VP_H)).toBe('43%');
    // 123 / 768 * 100 = 16.015 → 16
    expect(convertPxToDimUnit(123, 'vw', PARENT_W, 768, VP_H)).toBe('16vw');
  });
});

describe('isRelativeUnit', () => {
  // TRUE — relative units the Renderer resolves to px on canvas; the
  // Dimensions field must keep showing the authored value, NOT liveSize px.
  it('is true for %, vw, vh authored values', () => {
    expect(isRelativeUnit('100%')).toBe(true);
    expect(isRelativeUnit('50vw')).toBe(true);
    expect(isRelativeUnit('99vh')).toBe(true);
    expect(isRelativeUnit(' 100% ')).toBe(true); // tolerant of whitespace
  });

  // FALSE — these keep the liveSize px override (live canvas-resize feedback,
  // incl. component instances with no explicit width/height).
  it('is false for px / auto / empty / nullish', () => {
    expect(isRelativeUnit('868px')).toBe(false);
    expect(isRelativeUnit('auto')).toBe(false);
    expect(isRelativeUnit('')).toBe(false);
    expect(isRelativeUnit(undefined)).toBe(false);
    expect(isRelativeUnit(null)).toBe(false);
  });

  // Guard against a substring false-positive: a bare number must not match.
  it('is false for a unitless number', () => {
    expect(isRelativeUnit('100')).toBe(false);
  });
});

describe('dimUnitOf', () => {
  it('extracts the unit suffix', () => {
    expect(dimUnitOf('108vh')).toBe('vh');
    expect(dimUnitOf('50vw')).toBe('vw');
    expect(dimUnitOf('52%')).toBe('%');
    expect(dimUnitOf('880px')).toBe('px');
    expect(dimUnitOf('3rem')).toBe('rem');
  });
  it('reports px for bare numbers / empty / nullish', () => {
    expect(dimUnitOf('100')).toBe('px');
    expect(dimUnitOf('')).toBe('px');
    expect(dimUnitOf(undefined)).toBe('px');
    expect(dimUnitOf(null)).toBe('px');
  });
  it('is case / whitespace tolerant', () => {
    expect(dimUnitOf(' 108 VH ')).toBe('vh');
  });
});

describe('pickLiveDim', () => {
  // THE FIX: a vh resize now broadcasts '108vh' — same unit as the authored
  // '100vh' — so the field updates live during the drag (was stuck on source).
  it('shows the live value for a relative unit when units match', () => {
    expect(pickLiveDim('100vh', '108vh')).toBe('108vh');
    expect(pickLiveDim('50%', '64%')).toBe('64%');
    expect(pickLiveDim('20vw', '25vw')).toBe('25vw');
  });

  // The guard the old `isRelativeUnit` gate existed for: a px-resolved live
  // value (bridge resolves vh→px on canvas) must NOT override a vh authored
  // value, or the chevron would flip px↔vh.
  it('rejects a px live value for a relative authored unit', () => {
    expect(pickLiveDim('100vh', '891px')).toBeUndefined();
    expect(pickLiveDim('50%', '720px')).toBeUndefined();
  });

  // Non-relative authored values always take the live value (existing behaviour:
  // px / auto / Fit live-resize feedback, incl. component instances).
  it('shows the live value as-is for px / auto authored', () => {
    expect(pickLiveDim('800px', '880px')).toBe('880px');
    expect(pickLiveDim('auto', '880px')).toBe('880px');
    expect(pickLiveDim(undefined, '880px')).toBe('880px');
  });

  it('returns undefined when there is no live value (falls back to source)', () => {
    expect(pickLiveDim('100vh', undefined)).toBeUndefined();
    expect(pickLiveDim('100vh', null)).toBeUndefined();
    expect(pickLiveDim('800px', '')).toBeUndefined();
  });
});

// FIT-text redirect (live find 2026-07-13): selecting the fit pair's INNER <p>
// showed its internal width 'auto' in the Size tool — uneditable, and wrong
// (the user-facing size is the svg wrapper's box). The tool now redirects.
describe('fitSizeRedirectTarget', () => {
  const nodes = new Map<string, { type?: string }>([
    ['p-hero-b-svg', { type: 'svg' }],
    ['p-hero-b', { type: 'p' }],
    ['card', { type: 'div' }],
    ['card-svg', { type: 'div' }],   // -svg id but NOT an svg element
  ]);

  it('redirects the fit inner text to its svg wrapper', () => {
    expect(fitSizeRedirectTarget(nodes, 'p-hero-b')).toBe('p-hero-b-svg');
  });

  it('no redirect for ordinary nodes', () => {
    expect(fitSizeRedirectTarget(nodes, 'card')).toBeNull();
  });

  it('no redirect when the -svg sibling is not an svg element', () => {
    // 'card' has a 'card-svg' sibling of type div — must not redirect.
    expect(fitSizeRedirectTarget(new Map([['x-svg', { type: 'div' }]]), 'x')).toBeNull();
  });

  it('no redirect for the wrapper itself', () => {
    expect(fitSizeRedirectTarget(nodes, 'p-hero-b-svg')).toBeNull();
  });
});

// EMPIRICAL PIN — live find 2026-07-13: switching Width from Fill → Fit on a
// text node wrote `width: min-content` but LEFT `flex: '1 0 0px'` behind.
// Fill mode is derived (grow flex + fit-size width), so the node still
// detected as fill: the unit dropdown snapped back to Fill and the element
// kept growing. The auto branch must clear the grow flex in the same write.
describe('exitFillFlexPatch', () => {
  it('main axis + grow flex → pins flex to 0 0 auto', () => {
    expect(exitFillFlexPatch(true, '1 0 0px')).toEqual({ flex: '0 0 auto' });
  });

  it('multiplier fills (2fr, fractional) are still grow flexes', () => {
    expect(exitFillFlexPatch(true, '2 0 0px')).toEqual({ flex: '0 0 auto' });
    expect(exitFillFlexPatch(true, '1.5 1 0%')).toEqual({ flex: '0 0 auto' });
  });

  it('cross axis never touches the flex (it belongs to the other axis)', () => {
    expect(exitFillFlexPatch(false, '1 0 0px')).toBeNull();
  });

  it('non-growing flex needs no patch', () => {
    expect(exitFillFlexPatch(true, '0 0 auto')).toBeNull();
    expect(exitFillFlexPatch(true, '0 1 auto')).toBeNull();
  });

  it('missing flex needs no patch', () => {
    expect(exitFillFlexPatch(true, '')).toBeNull();
    expect(exitFillFlexPatch(true, undefined)).toBeNull();
  });
});

// ─── An AUTO axis must stay AUTO through a resize ───────────────────────────
//
// User report 2026-08-08: a component instance with width px + height auto.
// Dragging the RIGHT handle (width only) flipped the Height row's unit to `px`
// for the whole gesture, snapping back to `auto` on mouseup. The live poll
// backfills any axis the ResizeManager didn't broadcast from the COMPUTED
// cache — and computed height is always a px number, so an axis that was never
// being resized adopted one.

describe('isAutoDim', () => {
  it('treats absent / auto / Fit as content-decided', () => {
    expect(isAutoDim(undefined)).toBe(true);
    expect(isAutoDim('')).toBe(true);
    expect(isAutoDim('   ')).toBe(true);
    expect(isAutoDim('auto')).toBe(true);
    expect(isAutoDim('min-content')).toBe(true);
  });

  it('treats every authored length as NOT auto', () => {
    for (const v of ['717px', '100%', '50vh', '12vw', '0px']) {
      expect(isAutoDim(v)).toBe(false);
    }
  });

  it('is what gates the computed backfill', () => {
    // The guard the poll applies: backfill only when the axis carries a real
    // authored length. An instance whose JSX has width but no height…
    const styles = { width: '717px', height: undefined as string | undefined };
    expect(isAutoDim(styles.width)).toBe(false); // width may backfill
    expect(isAutoDim(styles.height)).toBe(true); // height must not
  });
});

describe('resolveUnitChangePx', () => {
  it('uses the TYPED number when the user typed into an auto field', () => {
    expect(resolveUnitChangePx('px', 300, 174)).toBe(300);
  });

  it('uses the computed size when the unit dropdown drove the change', () => {
    // No typed number → the user picked "px" from the dropdown, meaning
    // "freeze what is rendered right now".
    expect(resolveUnitChangePx('px', undefined, 174)).toBe(174);
  });

  it('typing 0 is a real value, not a missing one', () => {
    expect(resolveUnitChangePx('px', 0, 174)).toBe(0);
  });

  it('ignores a typed number for non-px targets — % / vh convert from rendered px', () => {
    expect(resolveUnitChangePx('%', 300, 174)).toBe(174);
    expect(resolveUnitChangePx('vh', 300, 174)).toBe(174);
  });

  it('falls back to computed on NaN', () => {
    expect(resolveUnitChangePx('px', NaN, 174)).toBe(174);
  });
});
