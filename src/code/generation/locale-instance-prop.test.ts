// Per-LOCALE instance-prop values — the locale scope riding the shared
// scoped-expr chain (foundation for variable localization).
import { describe, it, expect } from 'vitest';
import { setLocaleInstancePropInCode } from './responsive-instance-prop-vars-gen';
import { parseScopedScalarExpr } from './scoped-expr';

const PAGE = `'use client';
import React from 'react';
import Frame from '@/components/Frame';
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <Frame data-id="inst-1" data-name="Frame" zefzef="hello" style={{ position: 'relative' }} />
  </div>);
}
`;

describe('setLocaleInstancePropInCode', () => {
  it('writes a locale ternary + the useLocale hook, keeps the base', () => {
    const out = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'ergerg');
    expect(out).toContain(`zefzef={(__activeLocale === 'fr' ? "ergerg" : "hello")}`);
    expect(out).toContain("import { useLocale } from 'next-intl';");
    expect(out).toContain('const __activeLocale = useLocale();');
  });

  it('banded locale value (per-replica) compounds with a media gate', () => {
    const out = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'fr-tablet',
      '(max-width: 768px) and (min-width: 375.02px)');
    expect(out).toMatch(/__activeLocale === 'fr' && __mq\d+ \? "fr-tablet" : "hello"/);
    expect(out).toContain("useMediaQuery('(max-width: 768px) and (min-width: 375.02px)')");
    // round-trips through the shared parser
    const expr = out.match(/zefzef=\{([\s\S]*?)\}\s/)![1];
    const parsed = parseScopedScalarExpr(out, expr);
    expect(parsed.base).toBe('"hello"');
    expect(parsed.responsive[0].scope).toEqual({ locale: 'fr', query: '(max-width: 768px) and (min-width: 375.02px)' });
  });

  it('removing the locale scope restores the plain literal + sweeps orphan gates', () => {
    const withFr = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'fr-only',
      '(max-width: 768px)');
    const out = setLocaleInstancePropInCode(withFr, 'inst-1', 'Frame', 'zefzef', 'fr', null, '(max-width: 768px)');
    // `={"hello"}` (expr form) and `="hello"` are semantically identical
    expect(out).toMatch(/zefzef=\{?"hello"\}?/);
    expect(out).not.toContain('__mq');
  });

  it('two locales chain without clobbering each other', () => {
    const fr = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'bonjour');
    const both = setLocaleInstancePropInCode(fr, 'inst-1', 'Frame', 'zefzef', 'it', 'ciao');
    expect(both).toContain(`__activeLocale === 'it' ? "ciao"`);
    expect(both).toContain(`__activeLocale === 'fr' ? "bonjour"`);
    expect(both).toMatch(/: "hello"\)/);
  });
});
