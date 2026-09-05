import { describe, test, expect } from 'vitest';
import {
  stripTranslateTransforms,
  buildTransformWithTranslate,
  extractAxisTranslate,
  buildAxisCenterTransform,
  toPercentageCenter,
  toFixedPin,
  toInsetMode,
  fromInsetMode,
  toRelative,
  toAbsolute,
  neutralizeReplicaClears,
  type VisualRect,
} from './position-utils';

const rect: VisualRect = {
  left: 50, top: 30, width: 200, height: 100,
  parentWidth: 600, parentHeight: 400,
  centerXPercent: 25, centerYPercent: 20,
};

describe('stripTranslateTransforms', () => {
  test('strips translate()', () => {
    expect(stripTranslateTransforms('translate(-50%, -50%) rotate(45deg)')).toBe('rotate(45deg)');
  });
  test('strips translateX/Y/Z', () => {
    expect(stripTranslateTransforms('translateX(100px) translateY(50px) scale(1.5)')).toBe('scale(1.5)');
  });
  test('strips translate3d', () => {
    expect(stripTranslateTransforms('translate3d(10px, 20px, 0) rotate(10deg)')).toBe('rotate(10deg)');
  });
  test('returns empty for translate-only', () => {
    expect(stripTranslateTransforms('translate(-50%, -50%)')).toBe('');
  });
  test('returns empty for none', () => {
    expect(stripTranslateTransforms('none')).toBe('');
  });
  test('returns empty for undefined', () => {
    expect(stripTranslateTransforms(undefined)).toBe('');
  });
  test('preserves rotate + scale', () => {
    expect(stripTranslateTransforms('rotate(45deg) scale(2)')).toBe('rotate(45deg) scale(2)');
  });
});

describe('buildTransformWithTranslate', () => {
  test('prepends translate to existing', () => {
    expect(buildTransformWithTranslate('translate(-50%, -50%)', 'rotate(45deg)')).toBe('translate(-50%, -50%) rotate(45deg)');
  });
  test('translate only when no existing', () => {
    expect(buildTransformWithTranslate('translate(-50%, -50%)', undefined)).toBe('translate(-50%, -50%)');
  });
  test('strips old translate before prepending', () => {
    expect(buildTransformWithTranslate('translate(-50%, -50%)', 'translate(100px, 50px) rotate(10deg)')).toBe('translate(-50%, -50%) rotate(10deg)');
  });
});

describe('toPercentageCenter', () => {
  test('converts to percentage + translate(-50%,-50%)', () => {
    const result = toPercentageCenter(rect);
    expect(result.left).toBe('25.0000%');
    expect(result.top).toBe('20.0000%');
    expect(result.transform).toBe('translate(-50%, -50%)');
    expect(result.width).toBe('200px');
    expect(result.height).toBe('100px');
    expect(result.right).toBe('');
    expect(result.bottom).toBe('');
  });

  test('preserves existing rotate', () => {
    const result = toPercentageCenter(rect, 'rotate(45deg)');
    expect(result.transform).toBe('translate(-50%, -50%) rotate(45deg)');
  });
});

describe('toFixedPin', () => {
  test('left pin', () => expect(toFixedPin('left', rect)).toEqual({ left: '50px' }));
  test('right pin', () => expect(toFixedPin('right', rect)).toEqual({ right: '350px' }));
  test('top pin', () => expect(toFixedPin('top', rect)).toEqual({ top: '30px' }));
  test('bottom pin', () => expect(toFixedPin('bottom', rect)).toEqual({ bottom: '270px' }));
});

describe('toInsetMode', () => {
  test('horizontal → L+R, no width', () => {
    const result = toInsetMode('horizontal', rect);
    expect(result.left).toBe('50px');
    expect(result.right).toBe('350px');
    expect(result.width).toBe('');
  });

  test('vertical → T+B, no height', () => {
    const result = toInsetMode('vertical', rect);
    expect(result.top).toBe('30px');
    expect(result.bottom).toBe('270px');
    expect(result.height).toBe('');
  });
});

describe('fromInsetMode', () => {
  test('remove right → restores width', () => {
    const result = fromInsetMode('right', rect);
    expect(result.right).toBe('');
    expect(result.width).toBe('200px');
  });

  test('remove bottom → restores height', () => {
    const result = fromInsetMode('bottom', rect);
    expect(result.bottom).toBe('');
    expect(result.height).toBe('100px');
  });
});

describe('toRelative', () => {
  test('clears all position props', () => {
    const result = toRelative();
    expect(result.position).toBe('relative');
    expect(result.left).toBe('');
    expect(result.top).toBe('');
    expect(result.right).toBe('');
    expect(result.bottom).toBe('');
  });

  test('strips translate from transform', () => {
    const result = toRelative('translate(-50%, -50%) rotate(45deg)');
    expect(result.transform).toBe('rotate(45deg)');
  });
});

describe('toAbsolute', () => {
  test('sets absolute with visual position', () => {
    const result = toAbsolute(rect);
    expect(result.position).toBe('absolute');
    expect(result.left).toBe('50px');
    expect(result.top).toBe('30px');
  });
});

// The unpin-one-axis bug (live find 2026-07-24): an icon centered on BOTH axes
// via `translate(-50%, -50%)` lost its `translateY(-50%)` when the LEFT pin was
// removed, so it jumped down half its height. extractAxisTranslate +
// buildAxisCenterTransform preserve the untouched axis.
describe('extractAxisTranslate', () => {
  test('pulls each axis out of the 2-arg shorthand', () => {
    expect(extractAxisTranslate('translate(-50%, -50%)', 'x')).toBe('translateX(-50%)');
    expect(extractAxisTranslate('translate(-50%, -50%)', 'y')).toBe('translateY(-50%)');
  });

  test('2-arg with y omitted → y is empty (defaults to 0)', () => {
    expect(extractAxisTranslate('translate(-50%)', 'x')).toBe('translateX(-50%)');
    expect(extractAxisTranslate('translate(-50%)', 'y')).toBe('');
  });

  test('single-axis forms', () => {
    expect(extractAxisTranslate('translateX(-50%)', 'x')).toBe('translateX(-50%)');
    expect(extractAxisTranslate('translateX(-50%)', 'y')).toBe('');
    expect(extractAxisTranslate('translateY(-50%)', 'y')).toBe('translateY(-50%)');
    expect(extractAxisTranslate('translateY(-50%)', 'x')).toBe('');
  });

  test('both single-axis forms present', () => {
    const t = 'translateX(-50%) translateY(-50%)';
    expect(extractAxisTranslate(t, 'x')).toBe('translateX(-50%)');
    expect(extractAxisTranslate(t, 'y')).toBe('translateY(-50%)');
  });

  test('ignores rotate/scale and zero translates', () => {
    expect(extractAxisTranslate('rotate(45deg) scale(1.5)', 'x')).toBe('');
    expect(extractAxisTranslate('translate(0, -50%)', 'x')).toBe('');
    expect(extractAxisTranslate('translate(0, -50%)', 'y')).toBe('translateY(-50%)');
  });

  test('non-percent px translate is preserved verbatim', () => {
    expect(extractAxisTranslate('translate(10px, 20px)', 'x')).toBe('translateX(10px)');
    expect(extractAxisTranslate('translate(10px, 20px)', 'y')).toBe('translateY(20px)');
  });

  test('none / empty → empty', () => {
    expect(extractAxisTranslate('none', 'x')).toBe('');
    expect(extractAxisTranslate('', 'y')).toBe('');
    expect(extractAxisTranslate(undefined, 'x')).toBe('');
  });
});

describe('buildAxisCenterTransform', () => {
  test('unpin left (x-center) PRESERVES the y-axis translate — the reported bug', () => {
    // Element was centered both axes; removing left keeps translateY(-50%).
    expect(buildAxisCenterTransform('x', 'translate(-50%, -50%)')).toBe('translateX(-50%) translateY(-50%)');
  });

  test('unpin top (y-center) preserves the x-axis translate', () => {
    expect(buildAxisCenterTransform('y', 'translate(-50%, -50%)')).toBe('translateY(-50%) translateX(-50%)');
  });

  test('no other-axis translate → just this axis', () => {
    expect(buildAxisCenterTransform('x', 'translateX(-50%)')).toBe('translateX(-50%)');
    expect(buildAxisCenterTransform('x', undefined)).toBe('translateX(-50%)');
  });

  test('preserves rotate/scale visuals alongside the preserved axis', () => {
    expect(buildAxisCenterTransform('x', 'translate(-50%, -50%) rotate(30deg)'))
      .toBe('translateX(-50%) translateY(-50%) rotate(30deg)');
  });

  test('other axis has a non-center translate → preserved verbatim', () => {
    expect(buildAxisCenterTransform('x', 'translateY(12px)')).toBe('translateX(-50%) translateY(12px)');
  });
});

describe('neutralizeReplicaClears', () => {
  // The user's exact repro (2026-08-26): master button pinned on all four
  // sides; unpin-all on a variant wrote right/bottom as '' — which only
  // DELETES the variant-entry keys, so the base right/bottom cascaded back
  // and the variant stayed pinned R/B.
  const base = {
    position: 'absolute', left: '1176px', top: '456px',
    right: '40px', bottom: '-69px', width: '64px', height: '64px',
  };

  test('unpin-all payload: base-carried right/bottom clears become auto', () => {
    const payload = toPercentageCenter(rect, undefined);
    const out = neutralizeReplicaClears(payload, base);
    expect(out.right).toBe('auto');
    expect(out.bottom).toBe('auto');
    // Set values ride through untouched
    expect(out.left).toBe(payload.left);
    expect(out.top).toBe(payload.top);
    expect(out.transform).toBe(payload.transform);
  });

  test('clears of props the base does not carry stay as deletes (no band noise)', () => {
    const out = neutralizeReplicaClears(
      { right: '', bottom: '' },
      { position: 'absolute', left: '10px', top: '10px' },
    );
    expect(out.right).toBe('');
    expect(out.bottom).toBe('');
  });

  test('re-pin single side: opposite-side clear masks the base value', () => {
    // Pin right on a variant → PinControl clears left; base left must be
    // masked or left+width would win over right (over-constrained).
    const out = neutralizeReplicaClears({ right: '40px', left: '' }, base);
    expect(out.left).toBe('auto');
    expect(out.right).toBe('40px');
  });

  test('pin-all inset mode: width/height clears become auto so insets can stretch', () => {
    const out = neutralizeReplicaClears({ width: '', height: '' }, base);
    expect(out.width).toBe('auto');
    expect(out.height).toBe('auto');
  });

  test('position clear becomes static when base carries position', () => {
    const out = neutralizeReplicaClears({ position: '' }, base);
    expect(out.position).toBe('static');
  });

  test('transform clear becomes identity translate, not none', () => {
    // 'none' is collapsed to a key-delete by the variants-object generator —
    // the identity translate survives both the band and the variant channel.
    const out = neutralizeReplicaClears(
      { transform: '' },
      { ...base, transform: 'translate(-50%, -50%)' },
    );
    expect(out.transform).toBe('translate(0px, 0px)');
  });

  test('transform clear stays a delete when base has no transform', () => {
    const out = neutralizeReplicaClears({ transform: '' }, base);
    expect(out.transform).toBe('');
  });

  test('does not mutate the input payload', () => {
    const payload = { right: '', bottom: '' };
    neutralizeReplicaClears(payload, base);
    expect(payload).toEqual({ right: '', bottom: '' });
  });
});

describe('removeAxisTranslate / centeringChannel', () => {
  test('removes one axis, keeps the other + visuals; splits translate(x,y)', async () => {
    const { removeAxisTranslate } = await import('./position-utils');
    expect(removeAxisTranslate('translateX(-50%) translateY(-50%) rotate(9deg)', 'x')).toBe('translateY(-50%) rotate(9deg)');
    expect(removeAxisTranslate('translate(-50%, -50%)', 'x')).toBe('translateY(-50%)');
    expect(removeAxisTranslate('translateX(-50%)', 'x')).toBe('');
    expect(removeAxisTranslate('rotate(9deg)', 'y')).toBe('rotate(9deg)');
    expect(removeAxisTranslate(undefined, 'x')).toBe('');
  });
  test('centeringChannel detects motion shorthands', async () => {
    const { centeringChannel } = await import('./position-utils');
    expect(centeringChannel({ x: '-50%' })).toBe('shorthand');
    expect(centeringChannel({ y: '-50%', transform: 'translateX(-50%)' })).toBe('shorthand');
    expect(centeringChannel({ transform: 'translateX(-50%)' })).toBe('string');
    expect(centeringChannel({ x: '' })).toBe('string');
  });
});
