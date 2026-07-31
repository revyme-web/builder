// Fallback row of the locale prop popup — the expression's bare base branch
// stringifies to 'undefined' ("defer to master default") and must NEVER be
// displayed as the fallback (the "Fallback: undefined" find). Options-backed
// props display the option LABEL (Top/Bottom…), matching the Set row.
import { describe, it, expect } from 'vitest';
import { resolveEffectiveFallback, resolveScopedPropDisplayValue } from './LocalePropPill';

const JUSTIFY_OPTS = [
  { value: 'flex-start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'flex-end', label: 'End' },
];

describe('resolveEffectiveFallback', () => {
  it('uses a real literal base value and maps it to its option label', () => {
    const r = resolveEffectiveFallback('flex-end', undefined, JUSTIFY_OPTS);
    expect(r.value).toBe('flex-end');
    expect(r.label).toBe('End');
  });

  it("stringified 'undefined' base defers to the row fallback (master default)", () => {
    const r = resolveEffectiveFallback('undefined', 'flex-start', JUSTIFY_OPTS);
    expect(r.value).toBe('flex-start');
    expect(r.label).toBe('Start');
  });

  it("stringified 'undefined' in BOTH slots yields empty (popup renders —)", () => {
    const r = resolveEffectiveFallback('undefined', 'undefined', JUSTIFY_OPTS);
    expect(r.value).toBe('');
    expect(r.label).toBe('');
  });

  it("stringified 'null' is equally unusable", () => {
    expect(resolveEffectiveFallback('null', 'center', JUSTIFY_OPTS).label).toBe('Center');
  });

  it('a raw scoped expression never leaks into the fallback', () => {
    const expr = `(__activeLocale === 'fr' ? "flex-end" : undefined)`;
    const r = resolveEffectiveFallback(expr, expr, JUSTIFY_OPTS);
    expect(r.value).toBe('');
  });

  it('a value without an option match displays verbatim (free-text props)', () => {
    const r = resolveEffectiveFallback('hello world', undefined, undefined);
    expect(r.value).toBe('hello world');
    expect(r.label).toBe('hello world');
  });
});

// Display resolution of a locale-scoped attr — the raw expression must never
// reach a select (unmatched value renders the FIRST option: the "every choice
// reverts to Start after 2s" bug once the optimistic hold expired).
describe('resolveScopedPropDisplayValue', () => {
  const VPW = { desktop: 1200, tablet: 768 };
  const CODE = `function P(){ const __activeLocale = 'en'; return <div><Hero justify={(__activeLocale === 'fr' ? "center" : "flex-end")} data-id="h" data-name="Hero" /></div>; }`;
  const RAW = `(__activeLocale === 'fr' ? "center" : "flex-end")`;

  it('default locale (en): shows the BASE branch, not the raw expression', () => {
    const v = resolveScopedPropDisplayValue(CODE, 'h', 'justify', 'desktop', VPW, 'en', 'en', RAW, 'flex-start');
    expect(v).toBe('flex-end');
  });

  it('active locale fr: shows the fr entry', () => {
    const v = resolveScopedPropDisplayValue(CODE, 'h', 'justify', 'desktop', VPW, 'fr', 'en', RAW, 'flex-start');
    expect(v).toBe('center');
  });

  it('bare undefined base falls to the component default', () => {
    const code = `function P(){ const __activeLocale = 'en'; return <div><Hero justify={(__activeLocale === 'fr' ? "center" : undefined)} data-id="h" data-name="Hero" /></div>; }`;
    const raw = `(__activeLocale === 'fr' ? "center" : undefined)`;
    const v = resolveScopedPropDisplayValue(code, 'h', 'justify', 'desktop', VPW, 'en', 'en', raw, 'flex-start');
    expect(v).toBe('flex-start');
  });

  it('plain literals pass through untouched', () => {
    expect(resolveScopedPropDisplayValue(CODE, 'h', 'justify', 'desktop', VPW, 'en', 'en', 'flex-end', 'x')).toBe('flex-end');
  });
});
