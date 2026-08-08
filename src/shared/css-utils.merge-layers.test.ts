// css-utils.merge-layers.test.ts — layered style merge must obey CSS order.
//
// User report 2026-08-08: a footer section with `padding: 80px` top/bottom on
// the primary variant rendered with NO padding on the canvas, while the live
// site showed it. Its `default` variant entry was
// `{ padding: '0px', paddingTop: '80px', … }` — correct in its own key order —
// but object spread re-seated the shorthand AFTER the longhands, so applying
// the merged map to the DOM in key order let `padding: 0` win.

import { describe, it, expect } from 'vitest';
import { mergeStyleLayers } from './css-utils';

describe('mergeStyleLayers', () => {
  it('keeps a later shorthand AHEAD of the longhands it precedes in that layer', () => {
    const base = { display: 'flex', paddingRight: '0px', paddingTop: '80px', paddingBottom: '80px' };
    const variantDefault = {
      padding: '0px', paddingTop: '80px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px',
    };
    const merged = mergeStyleLayers(base, variantDefault);
    const keys = Object.keys(merged);
    // Order is what actually decides the paint.
    expect(keys.indexOf('padding')).toBeLessThan(keys.indexOf('paddingTop'));
    expect(keys.indexOf('padding')).toBeLessThan(keys.indexOf('paddingBottom'));
    expect(merged.paddingTop).toBe('80px');
    expect(merged.paddingBottom).toBe('80px');
    // Spread — the old behaviour — puts it last, which is the bug.
    expect(Object.keys({ ...base, ...variantDefault }).indexOf('padding'))
      .toBeGreaterThan(Object.keys({ ...base, ...variantDefault }).indexOf('paddingTop'));
  });

  it('a shorthand-only layer REPLACES the earlier layer per-side values', () => {
    // The author's intent when a variant entry carries just `padding: '0px'`.
    const merged = mergeStyleLayers(
      { paddingTop: '80px', paddingBottom: '80px', color: 'red' },
      { padding: '0px' },
    );
    expect(merged.paddingTop).toBeUndefined();
    expect(merged.paddingBottom).toBeUndefined();
    expect(merged.padding).toBe('0px');
    expect(merged.color).toBe('red'); // unrelated props untouched
  });

  it('a later longhand refines an earlier shorthand without dropping it', () => {
    const merged = mergeStyleLayers({ padding: '10px' }, { paddingTop: '40px' });
    const keys = Object.keys(merged);
    expect(keys.indexOf('padding')).toBeLessThan(keys.indexOf('paddingTop'));
    expect(merged.padding).toBe('10px');
    expect(merged.paddingTop).toBe('40px');
  });

  it('handles the three-layer case: base → default entry → active variant', () => {
    const merged = mergeStyleLayers(
      { paddingTop: '80px', paddingBottom: '80px' },
      { padding: '0px', paddingTop: '80px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px' },
      { paddingTop: '32px', paddingRight: '16px', paddingBottom: '32px', paddingLeft: '16px' },
    );
    expect(merged.paddingTop).toBe('32px');
    expect(merged.paddingLeft).toBe('16px');
    const keys = Object.keys(merged);
    expect(keys.indexOf('padding')).toBeLessThan(keys.indexOf('paddingTop'));
  });

  it('covers the other shorthands, not just padding', () => {
    const radius = mergeStyleLayers(
      { borderTopLeftRadius: '8px' },
      { borderRadius: '0px', borderTopLeftRadius: '8px' },
    );
    expect(Object.keys(radius).indexOf('borderRadius')).toBeLessThan(Object.keys(radius).indexOf('borderTopLeftRadius'));
    expect(mergeStyleLayers({ marginTop: '10px' }, { margin: '0px' }).marginTop).toBeUndefined();
    expect(mergeStyleLayers({ rowGap: '4px' }, { gap: '0px' }).rowGap).toBeUndefined();
    expect(mergeStyleLayers({ top: '4px' }, { inset: '0px' }).top).toBeUndefined();
  });

  it('ignores null/undefined layers and matches spread when no shorthand is involved', () => {
    expect(mergeStyleLayers({ a: '1' }, null, { b: '2' }, undefined)).toEqual({ a: '1', b: '2' });
    expect(mergeStyleLayers({ color: 'red' }, { color: 'blue' })).toEqual({ color: 'blue' });
  });
});
