import { describe, it, expect } from 'vitest';
import { appearNeutralValue, appearUnionKeys, appearReveal, appearRestingValue } from './appear-utils';

describe('appearNeutralValue', () => {
  it('opacity + scale → 1, transforms → 0', () => {
    expect(appearNeutralValue('opacity')).toBe('1');
    expect(appearNeutralValue('scale')).toBe('1');
    expect(appearNeutralValue('scaleX')).toBe('1');
    expect(appearNeutralValue('y')).toBe('0');
    expect(appearNeutralValue('rotate')).toBe('0');
    expect(appearNeutralValue('skewX')).toBe('0');
  });
});

describe('appearUnionKeys', () => {
  it('plain enter + edit', () => {
    expect(appearUnionKeys({ opacity: '0', y: '30' }, { scale: '0.8' }).sort())
      .toEqual(['opacity', 'scale', 'y']);
  });
  it('unions across _base + _chain overrides, drops markers/empties', () => {
    const parsed = {
      opacity: '0', _scope: 'gate:__mq0',
      _base: JSON.stringify({ opacity: '0', y: '30' }),
      _chain: JSON.stringify([{ marker: 'gate:__mq0', props: { opacity: '0', rotate: '45' } }]),
    };
    expect(appearUnionKeys(parsed, {}).sort()).toEqual(['opacity', 'rotate', 'y']);
  });
  it('reveal covers every enter key at its resting value', () => {
    const keys = appearUnionKeys({ opacity: '0', y: '30', rotate: '45', scale: '0.8' });
    expect(appearReveal(keys)).toEqual({ opacity: '1', y: '0', rotate: '0', scale: '1' });
  });
});

describe('appearRestingValue — every prop reveals to the AUTHORED style value first', () => {
  const styles = { height: '58px', width: '38%', borderRadius: '12px' };

  it('transforms/opacity rest at neutral when the style does not author them', () => {
    expect(appearRestingValue('opacity', styles)).toBe('1');
    expect(appearRestingValue('scale', styles)).toBe('1');
    expect(appearRestingValue('y', styles)).toBe('0');
    expect(appearRestingValue('rotate', styles)).toBe('0');
  });

  it('an AUTHORED opacity wins over the neutral 1 (the saturated-aura bug)', () => {
    // A decorative aura authored at opacity 0.2 revealed to the hardcoded 1:
    // saturated on the live page, faint on the canvas (user report 2026-07-27).
    expect(appearRestingValue('opacity', { opacity: '0.2' })).toBe('0.2');
    expect(appearReveal(['opacity', 'y'], { opacity: '0.54' }))
      .toEqual({ opacity: '0.54', y: '0' });
  });

  it('an AUTHORED motion shorthand (rotate/scale in style) wins over neutral', () => {
    expect(appearRestingValue('rotate', { rotate: '90' })).toBe('90');
    expect(appearRestingValue('scale', { scale: '1.2' })).toBe('1.2');
  });

  it('height/width/box props reveal to the style value (NOT 0 — the collapse bug)', () => {
    expect(appearRestingValue('height', styles)).toBe('58px');
    expect(appearRestingValue('width', styles)).toBe('38%');
    expect(appearRestingValue('borderRadius', styles)).toBe('12px');
  });

  it('falls back to 0 when the style has no authored value', () => {
    expect(appearRestingValue('height', {})).toBe('0');
    expect(appearRestingValue('height')).toBe('0');
  });

  it('appearReveal threads styles so a height enter reveals to the real height', () => {
    // Adding `height` to the enter must NOT collapse whileInView to 0.
    expect(appearReveal(['opacity', 'height'], styles)).toEqual({ opacity: '1', height: '58px' });
  });
});
