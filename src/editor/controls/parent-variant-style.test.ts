// parent-variant-style.test.ts — the parent's EFFECTIVE layout on a variant tile.
//
// Child controls whose meaning depends on the parent's layout (Fill/fr sizing,
// align-self, order) need the parent's `display` / `flex-direction` as rendered
// on the tile being edited. ControlProvider resolved a REPLICA's `@media`
// override for that; the component-master twin was missing, so a master whose
// parent flips direction per variant resolved as its base `row`.
//
// Consequence on the reported file: the root renders
//   flexDirection: variant === 'variant-4' ? 'column' : 'row'
// so on variant-4 the parent is a COLUMN, where `flex: 3 0 0px` grows along the
// main axis = the HEIGHT. The panel called it "Width 3 fr", and lowering it
// shrank the card's height (user report 2026-07-26).

import { describe, it, expect } from 'vitest';
import { resolveParentVariantStyle } from './parent-variant-style';

// The exact shape the reported component produces.
const ROOT = {
  conditionalStyles: { flexDirection: { 'variant-4': 'column', default: 'row' } },
  motionVariants: { default: { display: 'flex' } },
};

describe('resolveParentVariantStyle', () => {
  it('reads the conditional ternary branch for THIS variant', () => {
    expect(resolveParentVariantStyle(ROOT, 'variant-4', 'flexDirection')).toBe('column');
  });

  it('falls back to the ternary DEFAULT branch on other variants', () => {
    // `variant === 'variant-4' ? 'column' : 'row'` — every other variant is the
    // else branch, which the parser stores under `default`.
    expect(resolveParentVariantStyle(ROOT, 'variant-1', 'flexDirection')).toBe('row');
    expect(resolveParentVariantStyle(ROOT, 'default', 'flexDirection')).toBe('row');
  });

  it('reads the variant OBJECT when there is no conditional', () => {
    const parent = { motionVariants: { 'variant-2': { flexDirection: 'column' } } };
    expect(resolveParentVariantStyle(parent, 'variant-2', 'flexDirection')).toBe('column');
    expect(resolveParentVariantStyle(parent, 'variant-1', 'flexDirection')).toBeUndefined();
  });

  it('lets the CONDITIONAL win over the variant object (Renderer precedence)', () => {
    const parent = {
      conditionalStyles: { flexDirection: { 'variant-1': 'column' } },
      motionVariants: { 'variant-1': { flexDirection: 'row' } },
    };
    expect(resolveParentVariantStyle(parent, 'variant-1', 'flexDirection')).toBe('column');
  });

  it('returns undefined when the variant sets nothing (caller falls back to base)', () => {
    expect(resolveParentVariantStyle({ motionVariants: {} }, 'variant-4', 'flexDirection')).toBeUndefined();
    expect(resolveParentVariantStyle({}, 'variant-4', 'display')).toBeUndefined();
  });

  it('treats an EMPTY value as not-set so it cannot mask the base', () => {
    const parent = {
      conditionalStyles: { flexDirection: { 'variant-1': '' } },
      motionVariants: { 'variant-1': { flexDirection: '' } },
    };
    expect(resolveParentVariantStyle(parent, 'variant-1', 'flexDirection')).toBeUndefined();
  });

  it('resolves display too (a parent can stop being flex on a variant)', () => {
    const parent = { motionVariants: { 'variant-3': { display: 'grid' } } };
    expect(resolveParentVariantStyle(parent, 'variant-3', 'display')).toBe('grid');
  });

  it('is a no-op without a parent or a variant', () => {
    expect(resolveParentVariantStyle(null, 'variant-4', 'flexDirection')).toBeUndefined();
    expect(resolveParentVariantStyle(ROOT, null, 'flexDirection')).toBeUndefined();
    expect(resolveParentVariantStyle(ROOT, undefined, 'flexDirection')).toBeUndefined();
  });
});
