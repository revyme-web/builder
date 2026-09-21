// Which keys a variant tile "owns" decides whether it follows the primary LIVE
// during a drag. Owning `transform` means the mid-drag mirror (which paints
// position as a `translate(dx, dy)` patch) is dropped for that tile.

import { describe, it, expect, beforeEach } from 'vitest';
import { getVariantOverriddenKeys, injectNodeIntoCache } from './store';
import type { CanvasNode } from '@/code/parsing/parser';

const ID = 'frame-1';
const seed = (motionVariants: Record<string, Record<string, unknown>>) => {
  injectNodeIntoCache({
    id: ID, type: 'div', name: 'Frame', parentId: 'root', children: [],
    styles: {}, textContent: '', attrs: {}, motionVariants,
  } as unknown as CanvasNode);
};

beforeEach(() => seed({}));

describe('getVariantOverriddenKeys — transform ownership', () => {
  // The reported case: Tablet synced live, Mobile did not, and Mobile's only
  // overrides were a rotation and a zero skew.
  it('a ROTATION-only variant does not own transform, so it still follows a drag', () => {
    seed({ 'variant-2': { rotate: 141.9, skewX: 0 } });
    const keys = getVariantOverriddenKeys(ID, 'variant-2')!;
    expect(keys.has('rotate')).toBe(true);        // it does own its rotation
    expect(keys.has('transform'), 'rotation is not position').toBe(false);
  });

  it('a scale-only variant likewise follows', () => {
    seed({ 'variant-1': { scale: 2 } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(false);
  });

  // The case the rule exists for: an independently POSITIONED tile must not be
  // dragged along by the primary.
  it('an x/y translate variant DOES own transform', () => {
    seed({ 'variant-1': { x: 40 } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(true);
    seed({ 'variant-1': { y: 40 } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(true);
  });

  it('legacy attrX/attrY absolutes count as position', () => {
    seed({ 'variant-1': { attrX: '10' } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(true);
  });

  it('left/top in the entry own transform too', () => {
    seed({ 'variant-1': { left: '10px' } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(true);
    seed({ 'variant-1': { top: '10px' } });
    expect(getVariantOverriddenKeys(ID, 'variant-1')!.has('transform')).toBe(true);
  });

  it('an empty value is not ownership', () => {
    seed({ 'variant-1': { x: '', left: '' } });
    const keys = getVariantOverriddenKeys(ID, 'variant-1');
    expect(keys?.has('transform') ?? false).toBe(false);
  });

  it('a fully reset variant owns nothing', () => {
    seed({ 'variant-1': {} });
    expect(getVariantOverriddenKeys(ID, 'variant-1')).toBeNull();
  });
});
