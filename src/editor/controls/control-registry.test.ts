// control-registry.test.ts — Tests for the centralized control registry.

import { describe, test, expect } from 'vitest';
import { resolveControl } from './control-registry';

describe('resolveControl', () => {
  test('returns numeric config for gap', () => {
    const def = resolveControl('gap');
    expect(def).toEqual({ type: 'numeric', min: 0, max: 200, step: 1 });
  });

  test('returns numeric config for opacity', () => {
    const def = resolveControl('opacity');
    expect(def).toEqual({ type: 'numeric', min: 0, max: 1, step: 0.01 });
  });

  test('returns select for flexDirection (from css-property-options)', () => {
    const def = resolveControl('flexDirection');
    expect(def?.type).toBe('select');
  });

  test('returns select for overflow (from css-property-options)', () => {
    const def = resolveControl('overflow');
    expect(def?.type).toBe('select');
  });

  test('returns null for unknown property', () => {
    expect(resolveControl('someRandomProp')).toBeNull();
  });

  test('numeric takes priority over css-property-options', () => {
    const def = resolveControl('gap');
    expect(def?.type).toBe('numeric');
  });
});

// The Italic control is the panel twin of the Cmd+I shortcut (ItalicToggle).
// A two-value property reads as a button group, not a dropdown — the CSS values
// stay real so both paths write the identical textStyle mark; only the labels
// are Yes/No.
describe('fontStyle — the Italic control', () => {
  test('resolves to a segmented control, not a select', () => {
    expect(resolveControl('fontStyle')?.type).toBe('segmented');
  });

  test('labels the segments Yes/No', () => {
    const def = resolveControl('fontStyle');
    expect(def?.type === 'segmented' && def.options).toEqual([
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ]);
  });

  test('maps CSS values to segments, treating oblique as italic', () => {
    const def = resolveControl('fontStyle');
    if (def?.type !== 'segmented') throw new Error('expected segmented');
    expect(def.map('italic')).toBe('yes');
    expect(def.map('oblique 14deg')).toBe('yes');
    expect(def.map('normal')).toBe('no');
    expect(def.map('')).toBe('no');
  });

  test('unmaps segments back to real CSS values', () => {
    const def = resolveControl('fontStyle');
    if (def?.type !== 'segmented') throw new Error('expected segmented');
    // `normal`, not '' — an explicit upright is the only thing that beats an
    // italic inherited from the element, which is the case this exists for.
    expect(def.unmap('yes')).toBe('italic');
    expect(def.unmap('no')).toBe('normal');
  });

  test('round-trips both directions', () => {
    const def = resolveControl('fontStyle');
    if (def?.type !== 'segmented') throw new Error('expected segmented');
    for (const seg of ['yes', 'no']) expect(def.map(def.unmap(seg))).toBe(seg);
  });
});
