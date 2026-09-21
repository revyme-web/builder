// A live patch from the DEFAULT tile must skip any tile that owns the value.
// The check used to compare KEY NAMES, so it missed the transform family: the
// Transform popup writes the CSS string `transform`, a variant stores its
// rotation as the motion prop `rotate`. Dragging the default Rotate slider
// therefore spun every tile, which snapped back on release.

import { describe, it, expect } from 'vitest';
import { MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { variantOwnsKey } from './ControlProvider';

describe('variantOwnsKey', () => {
  it('matches the plain same-key case', () => {
    expect(variantOwnsKey({ backgroundColor: '#fff' }, 'backgroundColor')).toBe(true);
    expect(variantOwnsKey({ backgroundColor: '#fff' }, 'color')).toBe(false);
  });

  // The reported bug, in one assertion.
  it('treats a motion `rotate` as owning `transform`', () => {
    expect(variantOwnsKey({ rotate: 141.9 }, 'transform')).toBe(true);
  });

  it('treats the other motion channels the same way', () => {
    for (const k of ['scale', 'scaleX', 'skewX', 'x', 'y'].filter(p => MOTION_TRANSFORM_PROPS.has(p))) {
      expect(variantOwnsKey({ [k]: 2 }, 'transform'), k).toBe(true);
    }
  });

  it('matches in the other direction too', () => {
    expect(variantOwnsKey({ transform: 'rotate(45deg)' }, 'rotate')).toBe(true);
  });

  it('does not claim ownership from an unrelated key', () => {
    expect(variantOwnsKey({ left: '10px' }, 'transform')).toBe(false);
    expect(variantOwnsKey({}, 'transform')).toBe(false);
    expect(variantOwnsKey(undefined, 'transform')).toBe(false);
  });

  it('treats an empty value as NOT owned, so the tile still follows', () => {
    expect(variantOwnsKey({ rotate: '' }, 'transform')).toBe(false);
    expect(variantOwnsKey({ transform: '' }, 'transform')).toBe(false);
  });
});
