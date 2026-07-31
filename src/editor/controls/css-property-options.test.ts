import { describe, test, expect } from 'vitest';
import { getCSSPropertyOptions, getAlignOptions, getJustifyOptions } from './css-property-options';

describe('getCSSPropertyOptions', () => {
  test('returns options for flexDirection', () => {
    const opts = getCSSPropertyOptions('flexDirection');
    expect(opts).not.toBeNull();
    expect(opts!.map(o => o.value)).toContain('row');
    expect(opts!.map(o => o.value)).toContain('column');
  });

  test('returns null for unknown property', () => {
    expect(getCSSPropertyOptions('foo')).toBeNull();
  });

  test('textOverflow offers none (removes the property), clip, and ellipsis', () => {
    const opts = getCSSPropertyOptions('textOverflow');
    expect(opts).not.toBeNull();
    // '' = the builder's remove-property convention — shows as the resting state
    expect(opts!.map(o => o.value)).toEqual(['', 'clip', 'ellipsis']);
    expect(opts![0].label).toBe('none');
  });
});

describe('getAlignOptions', () => {
  test('fixed axis-neutral labels regardless of direction (2026-07-22)', () => {
    for (const dir of ['row', 'column', undefined]) {
      const opts = getAlignOptions(dir);
      expect(opts.find(o => o.value === 'flex-start')?.label).toBe('Start');
      expect(opts.find(o => o.value === 'flex-end')?.label).toBe('End');
    }
  });

  test('never offers baseline or stretch (removed 2026-06-10 — oracle FORBIDDEN_ALIGN_VALUE)', () => {
    for (const dir of ['row', 'column', undefined]) {
      const values = getAlignOptions(dir).map(o => o.value);
      expect(values).not.toContain('baseline');
      expect(values).not.toContain('stretch');
    }
    const enumValues = getCSSPropertyOptions('alignItems')!.map(o => o.value);
    expect(enumValues).not.toContain('baseline');
    expect(enumValues).not.toContain('stretch');
  });
});

describe('getJustifyOptions', () => {
  test('fixed axis-neutral labels regardless of direction (2026-07-22)', () => {
    for (const dir of ['row', 'column', undefined]) {
      const opts = getJustifyOptions(dir);
      expect(opts.find(o => o.value === 'flex-start')?.label).toBe('Start');
      expect(opts.find(o => o.value === 'flex-end')?.label).toBe('End');
      expect(opts.find(o => o.value === 'space-between')?.label).toBe('Space Between');
    }
  });

  test('includes spacing options', () => {
    const opts = getJustifyOptions('row');
    expect(opts.map(o => o.value)).toContain('space-between');
    expect(opts.map(o => o.value)).toContain('space-around');
    expect(opts.map(o => o.value)).toContain('space-evenly');
  });
});
