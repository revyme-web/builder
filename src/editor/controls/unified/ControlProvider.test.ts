import { describe, it, expect } from 'vitest';
import { resolveValue, resolveBinding, surfaceHiddenVariantDisplay } from './ControlProvider';
import type { ScrollAnimData } from '@/code/parsing/scroll-parser';

describe('resolveValue', () => {
  it('returns node style value in direct mode', () => {
    const styles = { opacity: '0.5', color: 'red' };
    expect(resolveValue('direct', 'opacity', styles, {}, undefined, '1')).toBe('0.5');
  });

  it('returns default when style is missing in direct mode', () => {
    expect(resolveValue('direct', 'opacity', {}, {}, undefined, '1')).toBe('1');
  });

  it('strips var: prefix in direct mode and returns default', () => {
    const styles = { opacity: 'var:heroOpacity' };
    expect(resolveValue('direct', 'opacity', styles, {}, undefined, '1')).toBe('1');
  });

  it('returns stop prop value in scrollStop mode', () => {
    const stopProps = { opacity: '0', scale: '0.85' };
    expect(resolveValue('scrollStop', 'opacity', {}, stopProps, undefined, '1')).toBe('0');
  });

  it('returns default when stop prop is missing', () => {
    expect(resolveValue('scrollStop', 'opacity', {}, {}, undefined, '1')).toBe('1');
  });

  it('returns external value in variableDefault mode', () => {
    expect(resolveValue('variableDefault', 'opacity', {}, {}, '0.7', '1')).toBe('0.7');
  });

  it('returns default when external value is undefined', () => {
    expect(resolveValue('variableDefault', 'opacity', {}, {}, undefined, '1')).toBe('1');
  });

  it('works for cssKeyframe mode (same as scrollStop)', () => {
    const stopProps = { x: '100' };
    expect(resolveValue('cssKeyframe', 'x', {}, stopProps, undefined, '0')).toBe('100');
  });
});

describe('resolveBinding', () => {
  const emptyScroll: ScrollAnimData = { refs: [], sources: [], transforms: [], bindings: [] };

  it('returns unbound when no scroll bindings', () => {
    const result = resolveBinding('opacity', 'hero', emptyScroll);
    expect(result.bound).toBe(false);
    expect(result.boundBy).toBeNull();
  });

  it('detects scroll binding', () => {
    const scrollData: ScrollAnimData = {
      refs: [], sources: [],
      transforms: [{ varName: 'heroOpacity', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[1,0]', isSpring: false }],
      bindings: [{ nodeId: 'hero', property: 'opacity', transformVar: 'heroOpacity' }],
    };
    const result = resolveBinding('opacity', 'hero', scrollData);
    expect(result.bound).toBe(true);
    expect(result.boundBy).toBe('Scroll Transform');
    expect(result.onNavigate).toBeTypeOf('function');
  });

  it('does not detect scroll binding for other nodes', () => {
    const scrollData: ScrollAnimData = {
      refs: [], sources: [],
      transforms: [{ varName: 'heroOpacity', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[1,0]', isSpring: false }],
      bindings: [{ nodeId: 'hero', property: 'opacity', transformVar: 'heroOpacity' }],
    };
    const result = resolveBinding('opacity', 'other-node', scrollData);
    expect(result.bound).toBe(false);
  });

  it('does NOT mark var: prefix as bound (variables are editable through the atom)', () => {
    // Treating variables as `bound: true` routes the row to UsedByRow (gray
    // navigate-style pill) and short-circuits atoms before the purple
    // VariableBoundPill renders. Variables ARE editable through the same
    // atom (the user can change the variable's default value); animations
    // are read-only. They warrant different UI, so keep `bound` reserved
    // for animation/scroll. The `hasVariable` flag in the unified context
    // (computed from detectValueSource) drives the variable pill separately.
    const result = resolveBinding('opacity', 'hero', emptyScroll, 'var:heroOpacity');
    expect(result.bound).toBe(false);
    expect(result.boundBy).toBeNull();
  });

  it('returns unbound for null nodeId', () => {
    const result = resolveBinding('opacity', null, emptyScroll);
    expect(result.bound).toBe(false);
  });
});

describe('surfaceHiddenVariantDisplay', () => {
  // Regression: hiding a node in a design-component MASTER on the primary/default
  // viewport writes `hiddenOnVariants` for EVERY variant (incl. 'default'). The
  // Hide toggle reads `display`, so it must surface 'none' for the active variant
  // to show "Yes" reactively — on the DEFAULT view too, not only non-default ones.

  it('surfaces display:none when the DEFAULT variant is hidden (primary viewport)', () => {
    const out = surfaceHiddenVariantDisplay({}, 'display', 'default', new Set(['default', 'variant-1']));
    expect(out.display).toBe('none');
  });

  it('surfaces display:none when a NON-default variant is hidden', () => {
    const out = surfaceHiddenVariantDisplay({}, 'display', 'variant-1', new Set(['variant-1']));
    expect(out.display).toBe('none');
  });

  it('leaves styles untouched when the active variant is NOT hidden', () => {
    const styles = { display: 'flex' };
    const out = surfaceHiddenVariantDisplay(styles, 'display', 'variant-2', new Set(['variant-1']));
    expect(out).toBe(styles); // same ref — no surfacing
    expect(out.display).toBe('flex');
  });

  it('is a no-op on a page file (activeVariant null)', () => {
    const styles = { display: 'block' };
    const out = surfaceHiddenVariantDisplay(styles, 'display', null, new Set(['default']));
    expect(out).toBe(styles);
  });

  it('is a no-op when there are no hidden variants', () => {
    const styles = {};
    expect(surfaceHiddenVariantDisplay(styles, 'display', 'default', undefined)).toBe(styles);
    expect(surfaceHiddenVariantDisplay(styles, 'display', 'default', new Set())).toBe(styles);
  });

  it('only touches the `display` property', () => {
    const styles = { opacity: '1' };
    const out = surfaceHiddenVariantDisplay(styles, 'opacity', 'default', new Set(['default']));
    expect(out).toBe(styles);
    expect(out.display).toBeUndefined();
  });

  it('does not mutate the input styles object', () => {
    const styles = { color: 'red' };
    const out = surfaceHiddenVariantDisplay(styles, 'display', 'default', new Set(['default']));
    expect(styles).toEqual({ color: 'red' }); // original untouched
    expect(out).toEqual({ color: 'red', display: 'none' });
  });
});
