// Locale-scoped instance-prop parsing: the ternary walker resolves locale
// segments against the ACTIVE parse locale — matching plain segment overrides
// the base, matching banded segment lands as a width entry, other locales are
// skipped. (Phases 2+3 of variable localization.)
import { describe, it, expect, afterEach } from 'vitest';
import { parseJSXToNodes, setParseActiveLocale } from './parser';
import { setLocaleInstancePropInCode } from '@/code/generation/responsive-instance-prop-vars-gen';

const PAGE = `'use client';
import React from 'react';
import Frame from '@/components/Frame';
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <Frame data-id="inst-1" data-name="Frame" zefzef="hello" style={{ position: 'relative' }} />
  </div>);
}
`;

afterEach(() => setParseActiveLocale(''));

describe('locale-scoped instance props', () => {
  it('default locale parses the base value; french parse resolves the override', () => {
    const withFr = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'ergerg');
    setParseActiveLocale('');
    expect(parseJSXToNodes(withFr).get('inst-1')?.componentProps?.zefzef).toBe('hello');
    setParseActiveLocale('fr');
    expect(parseJSXToNodes(withFr).get('inst-1')?.componentProps?.zefzef).toBe('ergerg');
    setParseActiveLocale('it');
    expect(parseJSXToNodes(withFr).get('inst-1')?.componentProps?.zefzef).toBe('hello');
  });

  it('banded per-replica locale value lands as a width entry when active', () => {
    const banded = setLocaleInstancePropInCode(PAGE, 'inst-1', 'Frame', 'zefzef', 'fr', 'fr-tablet',
      '(max-width: 768px) and (min-width: 375.02px)');
    setParseActiveLocale('fr');
    const n = parseJSXToNodes(banded).get('inst-1');
    expect(n?.responsiveAttrPropValues?.zefzef?.[768]).toBe('fr-tablet');
    expect(n?.componentProps?.zefzef).toBe('hello');
    setParseActiveLocale('');
    const n2 = parseJSXToNodes(banded).get('inst-1');
    expect(n2?.responsiveAttrPropValues?.zefzef?.[768]).toBeUndefined();
    expect(n2?.componentProps?.zefzef).toBe('hello');
  });
});
