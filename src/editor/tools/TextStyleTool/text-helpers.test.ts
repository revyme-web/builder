import { describe, it, expect } from 'vitest';
import {
  parseTextShadowEntries,
  formatTextShadowEntries,
  createDefaultTextShadow,
  textShadowSummary,
  rowSwatchBackground,
} from './text-helpers';

describe('text-shadow multi-entry utils', () => {
  it('parses a single shadow (offsets then color)', () => {
    const e = parseTextShadowEntries('1px 2px 3px red');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ x: 1, y: 2, blur: 3, color: 'red' });
  });

  it('parses multiple comma-separated shadows', () => {
    const e = parseTextShadowEntries('1px 1px 2px red, 0px 0px 5px blue');
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ x: 1, y: 1, blur: 2, color: 'red' });
    expect(e[1]).toMatchObject({ x: 0, y: 0, blur: 5, color: 'blue' });
  });

  it('does not split inside rgba() commas', () => {
    const e = parseTextShadowEntries('2px 4px 6px rgba(0, 0, 0, 0.5)');
    expect(e).toHaveLength(1);
    expect(e[0].color).toBe('rgba(0, 0, 0, 0.5)');
    expect(e[0]).toMatchObject({ x: 2, y: 4, blur: 6 });
  });

  it('parses two rgba shadows without mis-splitting', () => {
    const e = parseTextShadowEntries('1px 1px 0px rgba(255,0,0,1), 0px 0px 3px rgba(0,0,255,0.8)');
    expect(e).toHaveLength(2);
    expect(e[0].color).toBe('rgba(255,0,0,1)');
    expect(e[1].color).toBe('rgba(0,0,255,0.8)');
  });

  it('handles color-first ordering', () => {
    const e = parseTextShadowEntries('red 1px 2px 3px');
    expect(e[0]).toMatchObject({ x: 1, y: 2, blur: 3, color: 'red' });
  });

  it('treats none / empty as no entries', () => {
    expect(parseTextShadowEntries('none')).toEqual([]);
    expect(parseTextShadowEntries('')).toEqual([]);
    expect(parseTextShadowEntries(undefined)).toEqual([]);
  });

  it('formats entries back to CSS and round-trips', () => {
    const css = '1px 1px 2px red, 0px 0px 5px blue';
    const out = formatTextShadowEntries(parseTextShadowEntries(css));
    expect(out).toBe('1px 1px 2px red, 0px 0px 5px blue');
  });

  it('empty entries serialize to none', () => {
    expect(formatTextShadowEntries([])).toBe('none');
  });

  it('createDefaultTextShadow uses a unique id per index', () => {
    expect(createDefaultTextShadow(0).id).toBe('text-shadow-0');
    expect(createDefaultTextShadow(2).id).toBe('text-shadow-2');
  });

  it('summary shows x · y', () => {
    expect(textShadowSummary({ id: 'a', x: 4, y: 8, blur: 0, color: '#000' })).toBe('4px · 8px');
  });
});


describe('rowSwatchBackground (Text → Color row swatch)', () => {
  const base = { nodeMixed: false, mixedSwatchCSS: '', isGradient: false, gradientCSS: '', solidSwatch: '#000000' };
  it('a mixed selection paints the blend of its colors, never the black default', () => {
    expect(rowSwatchBackground({ ...base, isMixed: true, mixedValues: ['#ffffff', '#e2ff31'] }))
      .toBe('linear-gradient(90deg, #ffffff, #e2ff31)');
  });
  it('mixed without listed values → base color + span colors', () => {
    expect(rowSwatchBackground({ ...base, isMixed: true, fallbackColors: ['#ffffff', '#e2ff31'] }))
      .toBe('linear-gradient(90deg, #ffffff, #e2ff31)');
  });
  it('a live picker drag overrides the mixed blend with the dragged solid', () => {
    expect(rowSwatchBackground({ ...base, isMixed: true, mixedValues: ['#fff', '#ff0'], livePreviewColor: '#123456', solidSwatch: '#123456' })).toBe('#123456');
  });
  it('gradient + spans "Mixed" preview wins; plain gradient / solid otherwise', () => {
    expect(rowSwatchBackground({ ...base, nodeMixed: true, mixedSwatchCSS: 'linear-gradient(90deg, red 0% 50%, blue 50% 100%)', isMixed: false })).toContain('red 0% 50%');
    expect(rowSwatchBackground({ ...base, isMixed: false, isGradient: true, gradientCSS: 'linear-gradient(red, blue)' })).toBe('linear-gradient(red, blue)');
    expect(rowSwatchBackground({ ...base, isMixed: false, solidSwatch: '#abcdef' })).toBe('#abcdef');
  });
});
