import { describe, it, expect } from 'vitest';
import {
  viewportBand,
  viewportSetToQuery,
  queryToViewportSet,
  scopeMotionPropValue,
} from './animation-scope';

const W = [1470, 768, 375]; // desktop / tablet / mobile

describe('viewportBand', () => {
  it('largest (primary) → open-top min only', () => {
    expect(viewportBand(1470, W)).toEqual({ min: 768.02 });
  });
  it('middle → both edges', () => {
    expect(viewportBand(768, W)).toEqual({ min: 375.02, max: 768 });
  });
  it('smallest → open-bottom max only', () => {
    expect(viewportBand(375, W)).toEqual({ max: 375 });
  });
  it('unknown width → empty', () => {
    expect(viewportBand(999, W)).toEqual({});
  });
});

describe('viewportSetToQuery', () => {
  it('all widths → "" (no wrapper, runs everywhere)', () => {
    expect(viewportSetToQuery([1470, 768, 375], W)).toBe('');
  });
  it('empty set → "none" (disabled)', () => {
    expect(viewportSetToQuery([], W)).toBe('none');
  });
  it('mobile only → max-width band', () => {
    expect(viewportSetToQuery([375], W)).toBe('(max-width: 375px)');
  });
  it('desktop only → open-top min band', () => {
    expect(viewportSetToQuery([1470], W)).toBe('(min-width: 768.02px)');
  });
  it('tablet only → both edges', () => {
    expect(viewportSetToQuery([768], W)).toBe('(max-width: 768px) and (min-width: 375.02px)');
  });
  it('NOT mobile (desktop+tablet, contiguous) → single open-top range', () => {
    expect(viewportSetToQuery([1470, 768], W)).toBe('(min-width: 375.02px)');
  });
  it('NOT tablet (desktop+mobile, non-contiguous) → comma OR', () => {
    const q = viewportSetToQuery([1470, 375], W);
    expect(q).toContain('(min-width: 768.02px)');
    expect(q).toContain('(max-width: 375px)');
    expect(q).toContain(',');
  });
});

describe('queryToViewportSet — round-trips viewportSetToQuery', () => {
  const cases: number[][] = [[375], [768], [1470], [1470, 768], [1470, 768, 375], [1470, 375]];
  for (const set of cases) {
    it(`round-trip ${JSON.stringify(set)}`, () => {
      const q = viewportSetToQuery(set, W);
      expect(queryToViewportSet(q, W).sort()).toEqual([...set].sort());
    });
  }
  it('"" → every width', () => {
    expect(queryToViewportSet('', W).sort()).toEqual([...W].sort());
  });
  it('"none" → empty', () => {
    expect(queryToViewportSet('none', W)).toEqual([]);
  });
  // LEGACY integer bounds (written before the 0.02 seam migration) must keep
  // resolving — rewriteAnimationBreakpoints restamps wild files through this.
  it('legacy integer min-width bound still resolves to its band', () => {
    expect(queryToViewportSet('(max-width: 768px) and (min-width: 376px)', W)).toEqual([768]);
    expect(queryToViewportSet('(min-width: 769px)', W)).toEqual([1470]);
  });
  // The Android fractional-width hole: the emitted tablet band must have NO
  // gap above the mobile breakpoint (375.65px-class devices sit in (375,376)).
  it('emitted bands leave no 1px hole above the smaller breakpoint', () => {
    const q = viewportSetToQuery([768], W);
    const min = parseFloat(q.match(/min-width:\s*([\d.]+)px/)![1]);
    expect(min).toBeLessThan(376);
    expect(min).toBeGreaterThan(375);
  });
});

describe('scopeMotionPropValue', () => {
  it('all → unchanged', () => {
    expect(scopeMotionPropValue('{ opacity: 1 }', { kind: 'all' })).toBe('{ opacity: 1 }');
  });
  it('variant → name ternary, default off=undefined', () => {
    expect(scopeMotionPropValue('{ opacity: 1, y: 0 }', { kind: 'variant', name: 'variant-2' }))
      .toBe("variant === 'variant-2' ? { opacity: 1, y: 0 } : undefined");
  });
  it('variant with off=false (the initial/entry prop)', () => {
    expect(scopeMotionPropValue('{ opacity: 0 }', { kind: 'variant', name: 'variant-2' }, { off: 'false' }))
      .toBe("variant === 'variant-2' ? { opacity: 0 } : false");
  });
  it('viewport → gate-var ternary', () => {
    expect(scopeMotionPropValue('{ opacity: 1 }', { kind: 'viewports', widths: [768] }, { gateVar: 'isTablet' }))
      .toBe('isTablet ? { opacity: 1 } : undefined');
  });
  it('respects a custom variantVar (initialVariant pre-connection)', () => {
    expect(scopeMotionPropValue('{ x: 0 }', { kind: 'variant', name: 'v1' }, { variantVar: 'initialVariant' }))
      .toBe("initialVariant === 'v1' ? { x: 0 } : undefined");
  });
});

import { rewriteAnimationBreakpoints } from './animation-scope';
describe('rewriteAnimationBreakpoints — re-stamp gates on viewport resize', () => {
  const GATE = (q: string) => `const __mq0 = useMediaQuery('${q}');`;
  it('resizing tablet 768→900 widens its own gate max-width', () => {
    // widths: mobile 375, tablet (now 900), desktop 1470, ultra 2560
    const out = rewriteAnimationBreakpoints(GATE('(max-width: 768px) and (min-width: 376px)'),
      768, 900, [375, 900, 1470, 2560]);
    expect(out).toBe(GATE('(max-width: 900px) and (min-width: 375.02px)'));
  });
  it('resizing mobile 375→500 shifts tablet gate min-width floor', () => {
    const out = rewriteAnimationBreakpoints(GATE('(max-width: 768px) and (min-width: 376px)'),
      375, 500, [500, 768, 1470, 2560]);
    expect(out).toBe(GATE('(max-width: 768px) and (min-width: 500.02px)'));
  });
  it('mobile gate (smallest) stays max-width-only', () => {
    const out = rewriteAnimationBreakpoints(GATE('(max-width: 375px)'),
      375, 400, [400, 768, 1470, 2560]);
    expect(out).toBe(GATE('(max-width: 400px)'));
  });
  it('leaves the useMediaQuery hook definition untouched (no string literal arg)', () => {
    const code = `function useMediaQuery(query: string){ const m = window.matchMedia(query); return false; }
const __mq0 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');`;
    const out = rewriteAnimationBreakpoints(code, 768, 900, [375, 900, 1470, 2560]);
    expect(out).toContain('function useMediaQuery(query: string)');
    expect(out).toContain("matchMedia(query)");
    expect(out).toContain("useMediaQuery('(max-width: 900px) and (min-width: 375.02px)')");
  });
  it('no-op when oldWidth === newWidth', () => {
    const c = GATE('(max-width: 768px)');
    expect(rewriteAnimationBreakpoints(c, 768, 768, [375, 768])).toBe(c);
  });
  it('rewrites multiple gates in one pass', () => {
    const code = `${GATE('(max-width: 768px) and (min-width: 376px)')}\nconst __mq1 = useMediaQuery('(max-width: 375px)');`;
    const out = rewriteAnimationBreakpoints(code, 768, 900, [375, 900, 1470, 2560]);
    expect(out).toContain("useMediaQuery('(max-width: 900px) and (min-width: 375.02px)')");
    expect(out).toContain("useMediaQuery('(max-width: 375px)')");  // mobile unchanged
  });
});

describe('rewriteAnimationBreakpoints — wider-than-primary (min-width) gates', () => {
  const GATE = (q: string) => `const __mq0 = useMediaQuery('${q}');`;
  it('resizing ultra-wide keeps its min-width floor (primary unchanged)', () => {
    // widths 375/768/1470/2560 → ultra-wide gate is min-width: 1471
    const out = rewriteAnimationBreakpoints(GATE('(min-width: 1471px)'),
      2560, 3000, [375, 768, 1470, 3000]);
    expect(out).toBe(GATE('(min-width: 1470.02px)'));   // floor = primary + 0.02 seam
  });
  it('does not corrupt a gate it cannot map (returns it unchanged)', () => {
    const out = rewriteAnimationBreakpoints(GATE('(max-width: 999px)'), 768, 900, [375, 900, 1470]);
    expect(out).toContain("useMediaQuery(");        // never throws / blanks
  });
});

// ─── rewriteAnimationBreakpoints: drift heal + spec-attr queries ────────────
import { rewriteAnimationBreakpoints as rab } from './animation-scope';

describe('rewriteAnimationBreakpoints — orphan heal + JSON query strings', () => {
  it('claims an ORPHAN stale query for the resized viewport (drift heal)', () => {
    // Query says 375 but the mobile viewport is 392 (drifted) — resize 392→1329.
    const code = `const __mq1 = useMediaQuery('(max-width: 375px)');`;
    const out = rab(code, 392, 1329, [1440, 1329, 768]);
    expect(out).toContain("useMediaQuery('(max-width: 1329px) and (min-width: 768.02px)')");
  });

  it('rewrites "query" strings inside JSON spec attrs (data-scroll-variant scopes)', () => {
    const code = `<A data-scroll-variant='{"responsive":[{"scope":{"query":"(max-width: 375px)"},"from":"variant-4"}]}' />`;
    const out = rab(code, 375, 1329, [1440, 1329, 768]);
    expect(out).toContain('"query":"(max-width: 1329px) and (min-width: 768.02px)"');
  });

  it('a tablet-ONLY banded gate survives as the new narrowest band', () => {
    // Tablet-only under the old set = banded; after mobile grows past it,
    // tablet becomes the narrowest → bare max-width form.
    const code = `const __mq0 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');`;
    const out = rab(code, 375, 1329, [1440, 1329, 768]);
    expect(out).toContain("useMediaQuery('(max-width: 768px)')");
  });
});
