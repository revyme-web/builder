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
