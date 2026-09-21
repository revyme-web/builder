// The four channels a rotation can arrive through, and the one that broke:
// `variants.default.rotate`, with `styles.transform` empty. The drag's replica
// fan-out read only `styles.transform`, so every replica painted itself
// axis-aligned for the whole gesture and snapped back on mouse-up.

import { describe, it, expect } from 'vitest';
import { foldEffectiveTransform } from './motion-transform';

const ROTATED_VARIANTS = {
  default: { top: '154px', bottom: '72px', rotate: 141.9, right: '112px', left: '429px' },
};

describe('foldEffectiveTransform', () => {
  it('folds a rotation held in the motion CHANNEL, not in transform', () => {
    const out = foldEffectiveTransform({
      styles: { position: 'absolute', left: '429px' },   // no `transform` at all
      motionVariants: ROTATED_VARIANTS,
      variantKey: 'default',
    });
    expect(out).toContain('rotate(141.9deg)');
  });

  // The replica case: a variant tile still gets the always-on `default` entry.
  it('applies the default entry on a NON-default tile', () => {
    const out = foldEffectiveTransform({
      styles: {},
      motionVariants: ROTATED_VARIANTS,
      variantKey: 'variant-1',
    });
    expect(out).toContain('rotate(141.9deg)');
  });

  it("lets a tile's own entry win over the default", () => {
    const out = foldEffectiveTransform({
      styles: {},
      motionVariants: { default: { rotate: 141.9 }, 'variant-1': { rotate: 10 } },
      variantKey: 'variant-1',
    });
    expect(out).toContain('rotate(10deg)');
    expect(out).not.toContain('141.9');
  });

  it('keeps a CSS transform string alongside the motion props', () => {
    const out = foldEffectiveTransform({
      styles: { transform: 'translateX(-50%)' },
      motionVariants: { default: { rotate: 45 } },
      variantKey: 'default',
    });
    expect(out).toContain('translateX(-50%)');
    expect(out).toContain('rotate(45deg)');
  });

  it('treats transform:none as empty', () => {
    expect(foldEffectiveTransform({ styles: { transform: 'none' }, variantKey: 'default' })).toBe('');
    expect(foldEffectiveTransform({ styles: {}, variantKey: 'default' })).toBe('');
  });

  it('applies a viewport @container override, and its deletes', () => {
    const base = { transform: 'rotate(10deg)' };
    expect(foldEffectiveTransform({
      styles: base, overrides: new Map([['transform', 'rotate(90deg)']]), variantKey: 'default',
    })).toContain('rotate(90deg)');
    expect(foldEffectiveTransform({
      styles: base, overrides: new Map([['transform', '']]), variantKey: 'default',
    })).toBe('');
    expect(foldEffectiveTransform({
      styles: base, overrides: new Map([['transform', 'auto']]), variantKey: 'default',
    })).toBe('');
  });

  // A component INSTANCE keeps per-variant motion props as inline ternaries.
  it('resolves a conditionalStyles rotation for the tile', () => {
    const conditionalStyles = { rotate: { default: '5', 'variant-1': '80' } };
    expect(foldEffectiveTransform({ styles: {}, conditionalStyles, variantKey: 'variant-1' }))
      .toContain('rotate(80deg)');
    expect(foldEffectiveTransform({ styles: {}, conditionalStyles, variantKey: 'variant-2' }))
      .toContain('rotate(5deg)');   // falls back to the default branch
  });

  it('survives an empty node', () => {
    expect(foldEffectiveTransform({ variantKey: 'default' })).toBe('');
  });
});
