import { describe, test, expect } from 'vitest';
import {
  parseShadowEntries,
  formatShadowEntries,
  extractNonShadowFilter,
  mergeFilterWithDropShadows,
  shadowSummary,
  createDefaultShadow,
} from './shadow-utils';

describe('parseShadowEntries', () => {
  test('returns empty array for no shadow', () => {
    expect(parseShadowEntries()).toEqual([]);
    expect(parseShadowEntries('none')).toEqual([]);
    expect(parseShadowEntries('', '')).toEqual([]);
  });

  test('parses single box-shadow', () => {
    const entries = parseShadowEntries('0px 4px 8px 0px rgba(0, 0, 0, 0.25)');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'box', inset: false, x: 0, y: 4, blur: 8, spread: 0,
      color: 'rgba(0, 0, 0, 0.25)',
    });
  });

  test('parses inset box-shadow (inset at start)', () => {
    const entries = parseShadowEntries('inset 0px 2px 4px 1px #000');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'box', inset: true, x: 0, y: 2, blur: 4, spread: 1, color: '#000' });
  });

  test('parses multiple box-shadows', () => {
    const entries = parseShadowEntries('0px 4px 8px rgba(0,0,0,0.3), inset 2px 2px 4px 0px #fff');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'box', inset: false, x: 0, y: 4, blur: 8 });
    expect(entries[1]).toMatchObject({ type: 'box', inset: true, x: 2, y: 2, blur: 4 });
  });

  test('parses drop-shadow from filter', () => {
    const entries = parseShadowEntries('', 'drop-shadow(4px 4px 8px rgba(0,0,0,0.5))');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'drop', inset: false, x: 4, y: 4, blur: 8, spread: 0,
      color: 'rgba(0,0,0,0.5)',
    });
  });

  test('parses multiple drop-shadows from filter', () => {
    const entries = parseShadowEntries('', 'drop-shadow(2px 2px 4px red) drop-shadow(4px 4px 8px blue)');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'drop', x: 2, y: 2, blur: 4 });
    expect(entries[1]).toMatchObject({ type: 'drop', x: 4, y: 4, blur: 8 });
  });

  test('parses mixed box-shadow + drop-shadow', () => {
    const entries = parseShadowEntries(
      '0px 4px 8px rgba(0,0,0,0.25)',
      'blur(5px) drop-shadow(2px 2px 4px red)'
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'box', x: 0, y: 4 });
    expect(entries[1]).toMatchObject({ type: 'drop', x: 2, y: 2 });
  });

  test('assigns deterministic IDs', () => {
    const entries = parseShadowEntries('0px 4px 8px #000, 2px 2px 4px #fff');
    expect(entries[0].id).toBe('shadow-0');
    expect(entries[1].id).toBe('shadow-1');
  });

  test('handles hex color at end', () => {
    const entries = parseShadowEntries('0px 4px 8px #ff0000');
    expect(entries[0].color).toBe('#ff0000');
  });

  test('handles color at start', () => {
    const entries = parseShadowEntries('rgba(255,0,0,0.5) 0px 4px 8px 0px');
    expect(entries[0].color).toBe('rgba(255,0,0,0.5)');
    expect(entries[0].x).toBe(0);
    expect(entries[0].y).toBe(4);
  });

  test('handles negative offsets', () => {
    const entries = parseShadowEntries('-5px -10px 8px 2px #000');
    expect(entries[0]).toMatchObject({ x: -5, y: -10, blur: 8, spread: 2 });
  });

  test('preserves var(--color-...) preset reference at end', () => {
    // Without this, a shadow whose color is bound to a color preset would
    // round-trip through the editor as the rgba fallback, silently breaking
    // the preset reference and the blue-pill UI in the color row.
    const entries = parseShadowEntries('0px 4px 8px var(--color-brand)');
    expect(entries[0].color).toBe('var(--color-brand)');
    expect(entries[0]).toMatchObject({ x: 0, y: 4, blur: 8 });
  });

  test('preserves var(--color-...) preset reference at start', () => {
    const entries = parseShadowEntries('var(--color-brand) 0px 4px 8px');
    expect(entries[0].color).toBe('var(--color-brand)');
    expect(entries[0]).toMatchObject({ x: 0, y: 4, blur: 8 });
  });
});

describe('formatShadowEntries', () => {
  test('formats empty array', () => {
    const result = formatShadowEntries([]);
    expect(result.boxShadow).toBe('');
    expect(result.dropShadowFilter).toBe('');
  });

  test('formats single box shadow', () => {
    const result = formatShadowEntries([{
      id: 'shadow-0', type: 'box', inset: false,
      x: 0, y: 4, blur: 8, spread: 0, color: 'rgba(0, 0, 0, 0.25)',
    }]);
    expect(result.boxShadow).toBe('0px 4px 8px 0px rgba(0, 0, 0, 0.25)');
    expect(result.dropShadowFilter).toBe('');
  });

  test('formats inset box shadow', () => {
    const result = formatShadowEntries([{
      id: 'shadow-0', type: 'box', inset: true,
      x: 2, y: 2, blur: 4, spread: 1, color: '#000',
    }]);
    expect(result.boxShadow).toBe('inset 2px 2px 4px 1px #000');
  });

  test('formats multiple box shadows', () => {
    const result = formatShadowEntries([
      { id: 'shadow-0', type: 'box', inset: false, x: 0, y: 4, blur: 8, spread: 0, color: '#000' },
      { id: 'shadow-1', type: 'box', inset: true, x: 2, y: 2, blur: 4, spread: 0, color: '#fff' },
    ]);
    expect(result.boxShadow).toBe('0px 4px 8px 0px #000, inset 2px 2px 4px 0px #fff');
  });

  test('formats drop shadow', () => {
    const result = formatShadowEntries([{
      id: 'shadow-0', type: 'drop', inset: false,
      x: 4, y: 4, blur: 8, spread: 0, color: 'rgba(0,0,0,0.5)',
    }]);
    expect(result.boxShadow).toBe('');
    expect(result.dropShadowFilter).toBe('drop-shadow(4px 4px 8px rgba(0,0,0,0.5))');
  });

  test('formats mixed entries', () => {
    const result = formatShadowEntries([
      { id: 'shadow-0', type: 'box', inset: false, x: 0, y: 4, blur: 8, spread: 0, color: '#000' },
      { id: 'shadow-1', type: 'drop', inset: false, x: 2, y: 2, blur: 4, spread: 0, color: 'red' },
    ]);
    expect(result.boxShadow).toBe('0px 4px 8px 0px #000');
    expect(result.dropShadowFilter).toBe('drop-shadow(2px 2px 4px red)');
  });
});

describe('extractNonShadowFilter', () => {
  test('returns empty for no filter', () => {
    expect(extractNonShadowFilter('')).toBe('');
    expect(extractNonShadowFilter('none')).toBe('');
  });

  test('preserves non-shadow filters', () => {
    expect(extractNonShadowFilter('blur(5px) brightness(1.2)')).toBe('blur(5px) brightness(1.2)');
  });

  test('removes drop-shadow and preserves others', () => {
    expect(extractNonShadowFilter('blur(5px) drop-shadow(2px 2px 4px red) brightness(1.2)'))
      .toBe('blur(5px) brightness(1.2)');
  });
});

describe('mergeFilterWithDropShadows', () => {
  test('merges drop shadows with existing filter', () => {
    const result = mergeFilterWithDropShadows(
      'blur(5px)',
      'drop-shadow(2px 2px 4px red)'
    );
    expect(result).toBe('blur(5px) drop-shadow(2px 2px 4px red)');
  });

  test('returns only drop shadows when no existing filter', () => {
    const result = mergeFilterWithDropShadows('', 'drop-shadow(2px 2px 4px red)');
    expect(result).toBe('drop-shadow(2px 2px 4px red)');
  });

  test('replaces old drop-shadows with new ones', () => {
    const result = mergeFilterWithDropShadows(
      'blur(5px) drop-shadow(0px 0px 0px black)',
      'drop-shadow(4px 4px 8px red)'
    );
    expect(result).toBe('blur(5px) drop-shadow(4px 4px 8px red)');
  });
});

describe('shadowSummary', () => {
  test('returns x, y, blur summary', () => {
    expect(shadowSummary({ id: 's', type: 'box', inset: false, x: 0, y: 4, blur: 8, spread: 0, color: '#000' }))
      .toBe('0, 4, 8');
  });
});

describe('createDefaultShadow', () => {
  test('returns reasonable defaults', () => {
    const d = createDefaultShadow();
    expect(d.type).toBe('box');
    expect(d.blur).toBeGreaterThan(0);
    expect(d.color).toContain('0, 0, 0');
  });
});

describe('roundtrip', () => {
  test('parse → format → parse preserves box shadow', () => {
    const css = '0px 4px 8px 2px rgba(0, 0, 0, 0.25)';
    const entries = parseShadowEntries(css);
    const formatted = formatShadowEntries(entries);
    const reparsed = parseShadowEntries(formatted.boxShadow);
    expect(reparsed[0]).toMatchObject({ x: 0, y: 4, blur: 8, spread: 2 });
  });

  test('parse → format → parse preserves drop shadow', () => {
    const filter = 'drop-shadow(4px 4px 8px rgba(0,0,0,0.5))';
    const entries = parseShadowEntries('', filter);
    const formatted = formatShadowEntries(entries);
    const reparsed = parseShadowEntries('', formatted.dropShadowFilter);
    expect(reparsed[0]).toMatchObject({ type: 'drop', x: 4, y: 4, blur: 8 });
  });
});
