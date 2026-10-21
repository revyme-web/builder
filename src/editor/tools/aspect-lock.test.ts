import { describe, it, expect } from 'vitest';
import {
  parseAspectRatio, canLockAspect, aspectLockOnPatch, aspectUnlockPatch,
  lockedDimensionWrite, lockedFitWrite, vectorDisplayValue, vectorSizePatch, vectorLockPatch,
} from './aspect-lock';

describe('parseAspectRatio', () => {
  it('reads slash, bare and rejects auto/garbage', () => {
    expect(parseAspectRatio('3.75000 / 1')).toBeCloseTo(3.75);
    expect(parseAspectRatio('16/9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('1.5')).toBe(1.5);
    expect(parseAspectRatio('auto')).toBeNull();
    expect(parseAspectRatio('')).toBeNull();
    expect(parseAspectRatio('0 / 1')).toBeNull();
  });
});

describe('canLockAspect', () => {
  it('needs one definite side, the other definite or Fit', () => {
    expect(canLockAspect({ width: '240px', height: '64px' })).toBe(true);
    expect(canLockAspect({ width: '240px', height: 'min-content' })).toBe(true);
    expect(canLockAspect({ width: 'auto', height: '64px' })).toBe(true);
    expect(canLockAspect({ width: 'min-content', height: 'min-content' })).toBe(false);
    // An unset side is left alone.
    expect(canLockAspect({ width: '240px' })).toBe(false);
  });
});

describe('aspectLockOnPatch', () => {
  const size = { width: 240, height: 64 };
  it('writes the Fit spelling, never a literal auto', () => {
    expect(aspectLockOnPatch({ width: '240px', height: '64px' }, size))
      .toEqual({ aspectRatio: '3.75000 / 1', height: 'min-content' });
  });
  it('keeps an existing Fit side as the free one', () => {
    expect(aspectLockOnPatch({ width: 'min-content', height: '64px' }, size))
      .toEqual({ aspectRatio: '3.75000 / 1', width: 'min-content' });
    expect(aspectLockOnPatch({ width: '240px', height: 'auto' }, size))
      .toEqual({ aspectRatio: '3.75000 / 1', height: 'min-content' });
  });
  it('lets a % side keep control', () => {
    expect(aspectLockOnPatch({ width: '240px', height: '50%' }, size))
      .toEqual({ aspectRatio: '3.75000 / 1', width: 'min-content' });
    expect(aspectLockOnPatch({ width: '50%', height: '64px' }, size))
      .toEqual({ aspectRatio: '3.75000 / 1', height: 'min-content' });
  });
  it('is null without a measured size', () => {
    expect(aspectLockOnPatch({ width: '240px', height: '64px' }, { width: 0, height: 64 })).toBeNull();
  });
});

describe('aspectUnlockPatch', () => {
  const size = { width: 375, height: 100 };
  it('freezes the Fit side to the px it renders at', () => {
    expect(aspectUnlockPatch({ width: 'min-content', height: '100px' }, size))
      .toEqual({ aspectRatio: '', width: '375px' });
    expect(aspectUnlockPatch({ width: '375px', height: 'auto' }, size))
      .toEqual({ aspectRatio: '', height: '100px' });
  });
  it('only drops the ratio when both sides are definite', () => {
    expect(aspectUnlockPatch({ width: '375px', height: '100px' }, size)).toEqual({ aspectRatio: '' });
  });
});

describe('vector size (W×H px + lock)', () => {
  const size = { width: 240, height: 64 };
  it('shows px, measuring a legacy Fit / % side', () => {
    expect(vectorDisplayValue('width', { width: '240px' }, size)).toBe('240px');
    expect(vectorDisplayValue('height', { height: 'min-content' }, size)).toBe('64px');
    expect(vectorDisplayValue('height', { height: '50%' }, size)).toBe('64px');
  });
  it('locked: the other side follows through the ratio, in px', () => {
    expect(vectorSizePatch('width', '480', { width: '240px', height: '64px' }, size, 3.75))
      .toEqual({ width: '480px', height: '128px' });
    expect(vectorSizePatch('height', '100', { width: '480px', height: '128px' }, size, 3.75))
      .toEqual({ height: '100px', width: '375px' });
  });
  it('unlocked: only the typed side, plus a legacy non-px side frozen', () => {
    expect(vectorSizePatch('width', '480', { width: '240px', height: '64px' }, size, null))
      .toEqual({ width: '480px' });
    expect(vectorSizePatch('width', '480', { width: '240px', height: 'min-content' }, size, null))
      .toEqual({ width: '480px', height: '64px' });
  });
  it('clamps negatives and ignores non-numbers', () => {
    expect(vectorSizePatch('width', '-5', { width: '240px', height: '64px' }, size, null)).toEqual({ width: '0px' });
    expect(vectorSizePatch('width', 'abc', {}, size, null)).toBeNull();
  });
  it('lock on stores the ratio and pins both sides to px; off only drops it', () => {
    expect(vectorLockPatch({ width: '240px', height: 'min-content' }, size, false))
      .toEqual({ aspectRatio: '3.75000 / 1', height: '64px' });
    expect(vectorLockPatch({ width: '240px', height: '64px' }, size, true)).toEqual({ aspectRatio: '' });
    expect(vectorLockPatch({}, { width: 0, height: 0 }, false)).toBeNull();
  });
});

describe('lockedDimensionWrite', () => {
  it('the written side drives, the other goes Fit', () => {
    expect(lockedDimensionWrite('height', '100px', { width: '480px', height: 'min-content' }))
      .toEqual({ height: '100px', width: 'min-content' });
  });
  it('skips the other side when it already is the Fit spelling', () => {
    expect(lockedDimensionWrite('width', '480px', { width: '240px', height: 'min-content' }))
      .toEqual({ width: '480px' });
  });
  it('respells a legacy literal auto on the other side', () => {
    expect(lockedDimensionWrite('width', '480px', { width: '240px', height: 'auto' }))
      .toEqual({ width: '480px', height: 'min-content' });
  });
});

describe('lockedFitWrite', () => {
  const size = { width: 480, height: 128 };
  it('only the picked side when the other still drives', () => {
    expect(lockedFitWrite('width', { width: '480px', height: '128px' }, size)).toEqual({ width: 'min-content' });
  });
  it('the other side takes over at its rendered px when it was Fit', () => {
    expect(lockedFitWrite('width', { width: '480px', height: 'min-content' }, size))
      .toEqual({ width: 'min-content', height: '128px' });
  });
});
