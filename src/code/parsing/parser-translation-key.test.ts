// `{t('key')}` text children → node.translationKey (localization overhaul
// Phase 1). The parsed marker replaces the string-includes orphan gate in
// the canvas locale resolution.
import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

describe('parser translationKey detection', () => {
  test('sole t() call child sets translationKey', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">{t('title')}</p>`);
    expect(nodes.get('title')!.translationKey).toBe('title');
  });

  test('renamed hook variable still detected', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">{tr('hero-copy')}</p>`);
    expect(nodes.get('title')!.translationKey).toBe('hero-copy');
  });

  test('plain text has no translationKey', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">Painter</p>`);
    expect(nodes.get('title')!.translationKey).toBeUndefined();
    expect(nodes.get('title')!.textContent).toBe('Painter');
  });

  test('useResponsiveText is NOT a translation key', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">{useResponsiveText('a', { 768: 'b' })}</p>`);
    expect(nodes.get('title')!.translationKey).toBeUndefined();
  });

  test('bare {prop} variable text gets no translationKey', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">{title}</p>`);
    expect(nodes.get('title')!.translationKey).toBeUndefined();
  });

  test('multi-arg calls are ignored (not a t() shape)', () => {
    const nodes = parseJSXToNodes(`<p data-id="title">{fmt('a', 'b')}</p>`);
    expect(nodes.get('title')!.translationKey).toBeUndefined();
  });

  test('translation-call ATTRS parse into attrTranslationKeys', () => {
    const nodes = parseJSXToNodes(`<input data-id="email" placeholder={t('email__attr_placeholder')} type="email" />`);
    const n = nodes.get('email')!;
    expect(n.attrTranslationKeys).toEqual({ placeholder: 'email__attr_placeholder' });
    expect(n.attrs.placeholder).toBeUndefined();
    expect(n.attrs.type).toBe('email');
  });
});
