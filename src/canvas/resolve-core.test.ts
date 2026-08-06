import { describe, it, expect } from 'vitest';
import { resolveActiveVariant, bandForTile, responsiveVariantForWidth } from './resolve-core';

describe('resolve-core: responsiveVariantForWidth (media-query interval lookup)', () => {
  // The template-chrome shape: map keyed by TEMPLATE breakpoints, tile at a PAGE width.
  const map = { 768: 'variant-2', 375: 'variant-4' };
  it('exact key hit stays an exact hit', () => {
    expect(responsiveVariantForWidth(map, 768)).toBe('variant-2');
    expect(responsiveVariantForWidth(map, 375)).toBe('variant-4');
  });
  it('a width BETWEEN keys picks the band live gates would: smallest key ≥ width (585 → tablet burger, the chrome-on-resized-page report)', () => {
    expect(responsiveVariantForWidth(map, 585)).toBe('variant-2');
    expect(responsiveVariantForWidth(map, 400)).toBe('variant-2');
  });
  it('below the lowest key → the lowest band, matching (max-width: 375px)', () => {
    expect(responsiveVariantForWidth(map, 300)).toBe('variant-4');
  });
  it('above every key → undefined (the primary band shows)', () => {
    expect(responsiveVariantForWidth(map, 900)).toBeUndefined();
    expect(responsiveVariantForWidth(map, 1440)).toBeUndefined();
  });
  it('no map → undefined', () => {
    expect(responsiveVariantForWidth(undefined, 585)).toBeUndefined();
  });

  describe('with the instance _bp list (live parity — no cascade)', () => {
    // The inverted-widths report (2026-08-06): replica WIDER than primary.
    // Config desktop=1277 (primary), tablet=796, mobile=1409; overrides only
    // on tablet + mobile. The PRIMARY tile must show the BASE variant — the
    // map-key walk was cascading 1277 → 1409 and painting mobile's variant.
    const invMap = { 796: 'variant-1', 1409: 'variant-2' };
    const invBp = [1409, 1277, 796];
    it("the primary's own bucket has no override → base shows (no cascade)", () => {
      expect(responsiveVariantForWidth(invMap, 1277, invBp)).toBeUndefined();
      // Anything bucketing to the primary behaves the same.
      expect(responsiveVariantForWidth(invMap, 1000, invBp)).toBeUndefined();
    });
    it('replica buckets still resolve their own overrides', () => {
      expect(responsiveVariantForWidth(invMap, 796, invBp)).toBe('variant-1');
      expect(responsiveVariantForWidth(invMap, 600, invBp)).toBe('variant-1');
      expect(responsiveVariantForWidth(invMap, 1409, invBp)).toBe('variant-2');
      expect(responsiveVariantForWidth(invMap, 1300, invBp)).toBe('variant-2');
    });
    it('wider than every breakpoint → base', () => {
      expect(responsiveVariantForWidth(invMap, 1500, invBp)).toBeUndefined();
    });
    it('template-chrome case keeps the same answer under bp bucketing', () => {
      // Chrome map keyed by template breakpoints; page tile at 585 → tablet.
      expect(responsiveVariantForWidth({ 768: 'variant-2', 375: 'variant-4' }, 585, [1440, 768, 375])).toBe('variant-2');
      expect(responsiveVariantForWidth({ 768: 'variant-2', 375: 'variant-4' }, 300, [1440, 768, 375])).toBe('variant-4');
      expect(responsiveVariantForWidth({ 768: 'variant-2', 375: 'variant-4' }, 1440, [1440, 768, 375])).toBeUndefined();
    });
  });
});

describe('resolve-core: resolveActiveVariant', () => {
  it('per-tile responsiveVariantMap override WINS over the base variant', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 768, variant: 'base' })).toBe('v2');
  });
  it('map MISS (wider than every key) → base variant', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 1024, variant: 'base' })).toBe('base');
  });
  it('a width INSIDE a band resolves that band (interval semantics, not exact keys)', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 585, variant: 'base' })).toBe('v2');
  });
  it('no base variant → componentVariant → fallback', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 1024, variant: null })).toBe('cv');
    const bare: any = { responsiveVariantMap: { 768: 'v2' } };
    expect(resolveActiveVariant(bare, { vpWidth: 1024, variant: null })).toBe(null);           // default fallback = null
    expect(resolveActiveVariant(bare, { vpWidth: 1024, variant: null }, 'default')).toBe('default');
  });
  it('no map / no vpWidth → base ?? componentVariant ?? fallback', () => {
    const node: any = { componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { variant: 'base' })).toBe('base');
    expect(resolveActiveVariant(node, { variant: null })).toBe('cv');
  });
});

describe('resolve-core: bandForTile (first-match-wins, NOT cascade)', () => {
  it('exclusive bands: each tile resolves its own breakpoint', () => {
    const byW = { 768: 'a', 1440: 'b' };
    const bands = { 768: 376, 1440: 769 };
    expect(bandForTile(byW, bands, 768)).toBe(768);   // 376..768
    expect(bandForTile(byW, bands, 1000)).toBe(1440); // 769..1440
    expect(bandForTile(byW, bands, 375)).toBe(null);  // below both floors → base shows
    expect(bandForTile(byW, bands, 2000)).toBe(null); // above all → base shows
  });
  it('OVERLAPPING bands: the SMALLEST covering breakpoint wins (the Bug-1 invariant)', () => {
    const byW = { 768: 'a', 1440: 'b' };
    const bands = { 768: 0, 1440: 0 };               // both ranges cover 768
    expect(bandForTile(byW, bands, 768)).toBe(768);  // smaller wins, NOT 1440
    expect(bandForTile(byW, bands, 1200)).toBe(1440);// only 1440 covers it
  });
  it('missing bands default min to 0; empty/undefined byW → null', () => {
    expect(bandForTile({ 768: 'a' }, undefined, 500)).toBe(768);   // min defaults 0, 500<=768
    expect(bandForTile(undefined, undefined, 500)).toBe(null);
    expect(bandForTile({}, undefined, 500)).toBe(null);
  });
});
