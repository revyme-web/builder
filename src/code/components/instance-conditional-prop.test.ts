import { describe, it, expect } from 'vitest';
import {
  parseConditionalPropExpression,
  formatConditionalPropExpression,
  resolveConditionalPropValue,
  setConditionalPropEntry,
  hasVariantOverrides,
} from './instance-conditional-prop';

describe('instance-conditional-prop', () => {
  describe('parseConditionalPropExpression', () => {
    it('returns null for plain string', () => {
      expect(parseConditionalPropExpression("'variant-1'")).toBeNull();
    });

    it('returns null for non-variant ternary', () => {
      expect(parseConditionalPropExpression("foo === 'a' ? 'b' : 'c'")).toBeNull();
    });

    it('parses single-branch initialVariant ternary', () => {
      const result = parseConditionalPropExpression(
        "initialVariant === 'variant-1' ? 'variant-2' : 'default'",
      );
      expect(result).toEqual({ 'variant-1': 'variant-2', default: 'default' });
    });

    it('parses chained ternary', () => {
      const result = parseConditionalPropExpression(
        "initialVariant === 'v1' ? 'a' : initialVariant === 'v2' ? 'b' : 'c'",
      );
      expect(result).toEqual({ v1: 'a', v2: 'b', default: 'c' });
    });

    it('parses ternary using `variant` (connection useState)', () => {
      const result = parseConditionalPropExpression(
        "variant === 'v1' ? 'a' : 'b'",
      );
      expect(result).toEqual({ v1: 'a', default: 'b' });
    });
  });

  describe('formatConditionalPropExpression', () => {
    it('returns plain default when no overrides', () => {
      expect(formatConditionalPropExpression({ default: 'foo' })).toBe('foo');
    });

    it('formats single-branch ternary', () => {
      const result = formatConditionalPropExpression({
        'variant-1': 'variant-2',
        default: 'default',
      });
      expect(result).toBe(
        "initialVariant === 'variant-1' ? 'variant-2' : 'default'",
      );
    });

    it('formats chained ternary', () => {
      const result = formatConditionalPropExpression({
        v1: 'a',
        v2: 'b',
        default: 'c',
      });
      expect(result).toBe(
        "initialVariant === 'v1' ? 'a' : initialVariant === 'v2' ? 'b' : 'c'",
      );
    });

    it('uses `variant` when requested', () => {
      const result = formatConditionalPropExpression(
        { v1: 'a', default: 'b' },
        'variant',
      );
      expect(result).toBe("variant === 'v1' ? 'a' : 'b'");
    });

    it('falls back to the child default variant when the default branch is empty', () => {
      // An empty default would emit `: ''` → framer-motion resolves variant ''
      // (nonexistent) → the child instance renders invisible in the parent's
      // default variant. Must emit `: 'default'`.
      const result = formatConditionalPropExpression({ 'variant-2': 'variant-1', default: '' });
      expect(result).toBe("initialVariant === 'variant-2' ? 'variant-1' : 'default'");
    });
  });

  describe('setConditionalPropEntry', () => {
    it('seeds the fallback with the child default variant, never empty', () => {
      // Setting a child variant on a NON-default parent variant for a fresh
      // instance must not leave `default: ''` (the source of the bug).
      const map = setConditionalPropEntry(null, 'variant-2', 'variant-1');
      expect(map['default']).toBe('default');
      expect(map['variant-2']).toBe('variant-1');
      expect(formatConditionalPropExpression(map)).toBe("initialVariant === 'variant-2' ? 'variant-1' : 'default'");
    });
  });

  describe('round-trip', () => {
    it('parse(format(map)) === map', () => {
      const original = { 'variant-1': 'variant-2', 'variant-3': 'foo', default: 'bar' };
      const formatted = formatConditionalPropExpression(original);
      const parsed = parseConditionalPropExpression(formatted);
      expect(parsed).toEqual(original);
    });
  });

  describe('resolveConditionalPropValue', () => {
    it('returns variant-specific value', () => {
      const map = { v1: 'a', default: 'b' };
      expect(resolveConditionalPropValue(map, 'v1')).toBe('a');
    });

    it('falls back to default for unknown variant', () => {
      const map = { v1: 'a', default: 'b' };
      expect(resolveConditionalPropValue(map, 'v2')).toBe('b');
    });
  });

  describe('setConditionalPropEntry', () => {
    it('writes to default branch', () => {
      const next = setConditionalPropEntry({ default: 'a' }, 'default', 'b');
      expect(next).toEqual({ default: 'b' });
    });

    it('writes a per-variant override', () => {
      const next = setConditionalPropEntry({ default: 'a' }, 'v1', 'b');
      expect(next).toEqual({ v1: 'b', default: 'a' });
    });

    it('removes redundant override that equals default', () => {
      const next = setConditionalPropEntry(
        { v1: 'a', default: 'a' },
        'v1',
        'a',
      );
      expect(next).toEqual({ default: 'a' });
    });

    it('initializes from null with a valid default fallback (never empty)', () => {
      const next = setConditionalPropEntry(null, 'v1', 'b');
      expect(next).toEqual({ v1: 'b', default: 'default' });
    });
  });

  describe('hasVariantOverrides', () => {
    it('false for default-only map', () => {
      expect(hasVariantOverrides({ default: 'a' })).toBe(false);
    });

    it('true when any non-default branch present', () => {
      expect(hasVariantOverrides({ v1: 'b', default: 'a' })).toBe(true);
    });
  });
});
