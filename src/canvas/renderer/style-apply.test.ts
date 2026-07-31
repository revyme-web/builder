import { describe, test, expect } from 'vitest';
import { resolveInstanceWrapperOverflow } from './style-apply';

// The wrapper is the real FLEX ITEM for a component instance on the canvas.
// Its overflow must mirror the master root's so the CSS automatic-minimum-size
// rule (min-height:auto → 0 only when the item clips) behaves like the
// deployed single-div instance — otherwise a flex-basis:0 collapse shows on
// the live site but not on the canvas (the AboutPoint tablet-column find).
describe('resolveInstanceWrapperOverflow', () => {
  test('mirrors a clipping root overflow onto the wrapper', () => {
    expect(resolveInstanceWrapperOverflow({ overflow: 'hidden' })).toBe('hidden');
    expect(resolveInstanceWrapperOverflow({ overflow: 'clip' })).toBe('clip');
    expect(resolveInstanceWrapperOverflow({ overflow: 'auto' })).toBe('auto');
    expect(resolveInstanceWrapperOverflow({ overflow: 'scroll' })).toBe('scroll');
  });

  test('keeps the historical visible default when the root does not clip', () => {
    expect(resolveInstanceWrapperOverflow({ overflow: 'visible' })).toBe('visible');
    expect(resolveInstanceWrapperOverflow({})).toBe('visible');
    expect(resolveInstanceWrapperOverflow(null)).toBe('visible');
    expect(resolveInstanceWrapperOverflow(undefined)).toBe('visible');
  });

  test('ignores non-string / empty overflow values (variant objects can carry numbers)', () => {
    expect(resolveInstanceWrapperOverflow({ overflow: '' })).toBe('visible');
    expect(resolveInstanceWrapperOverflow({ overflow: '   ' })).toBe('visible');
    expect(resolveInstanceWrapperOverflow({ overflow: 0 as unknown as string })).toBe('visible');
  });
});
