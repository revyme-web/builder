// rtl-text — RTL languages flip the TEXT, never the layout by themselves.
import { describe, it, expect } from 'vitest';
import { isRtlLocale, RTL_TEXT_CSS } from './rtl-text';

describe('isRtlLocale', () => {
  it('matches right-to-left scripts by primary subtag', () => {
    for (const c of ['ar', 'ar-EG', 'he', 'fa', 'ur', 'ug', 'ckb', 'yi', 'AR']) expect(isRtlLocale(c)).toBe(true);
  });
  it('everything else is left to right', () => {
    for (const c of ['en', 'fr', 'pt-BR', 'zh', 'hi', '', null, undefined]) expect(isRtlLocale(c)).toBe(false);
  });
});

describe('RTL_TEXT_CSS', () => {
  it('sets the bidi paragraph direction on text, scoped to RTL lang, at zero specificity', () => {
    expect(RTL_TEXT_CSS.startsWith(':where(p,h1,')).toBe(true);
    expect(RTL_TEXT_CSS).toContain('):where(:lang(ar),');
    expect(RTL_TEXT_CSS).toContain(':lang(he)');
    expect(RTL_TEXT_CSS.endsWith('{unicode-bidi:plaintext}')).toBe(true);
  });
  it('never touches `direction` — the property flex/grid layout reads', () => {
    expect(RTL_TEXT_CSS).not.toMatch(/direction/);
  });
  it('holds nothing an HTML <style> would mis-parse', () => {
    expect(RTL_TEXT_CSS).not.toMatch(/[<>&"']/);
  });
});
