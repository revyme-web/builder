import { describe, it, expect } from 'vitest';
import { resolveActiveVariant, bandForTile } from './resolve-core';

describe('resolve-core: resolveActiveVariant', () => {
  it('per-tile responsiveVariantMap override WINS over the base variant', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 768, variant: 'base' })).toBe('v2');
  });
  it('map MISS → base variant', () => {
    const node: any = { responsiveVariantMap: { 768: 'v2' }, componentVariant: 'cv' };
    expect(resolveActiveVariant(node, { vpWidth: 1024, variant: 'base' })).toBe('base');
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
