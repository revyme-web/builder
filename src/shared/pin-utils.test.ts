import { describe, test, expect } from 'vitest';
import {
  isFixedPx, parsePx, getPinState, getInsetMode,
  togglePin, calculateAlignment, calculatePreservedPosition,
  getInsetState, computeResizeInsetStyles, computeDragInsetStyles, computeDimensionInsetStyles,
  gatePositionTypeOptions, mergeVariantPinStyles,
} from '@/shared/pin-utils';

const POSITION_OPTIONS = [
  { value: 'relative', label: 'Relative' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'sticky', label: 'Sticky' },
];
const disabledOf = (opts: { value: string; disabled?: boolean }[]) =>
  Object.fromEntries(opts.map((o) => [o.value, !!o.disabled]));

describe('gatePositionTypeOptions', () => {
  test('no-layout parent, not a viewport child → only Absolute enabled', () => {
    const d = disabledOf(gatePositionTypeOptions(POSITION_OPTIONS, {
      position: 'absolute', parentHasLayout: false, isViewportChild: false,
    }));
    expect(d).toEqual({ relative: true, absolute: false, fixed: true, sticky: true });
  });

  test('layout parent → Relative + Sticky enabled (Fixed still needs viewport child)', () => {
    const d = disabledOf(gatePositionTypeOptions(POSITION_OPTIONS, {
      position: 'absolute', parentHasLayout: true, isViewportChild: false,
    }));
    expect(d).toEqual({ relative: false, absolute: false, fixed: true, sticky: false });
  });

  test('direct viewport child → Fixed enabled', () => {
    const d = disabledOf(gatePositionTypeOptions(POSITION_OPTIONS, {
      position: 'absolute', parentHasLayout: false, isViewportChild: true,
    }));
    expect(d.fixed).toBe(false);
    expect(d.relative).toBe(true);   // still no layout → relative/sticky disabled
    expect(d.sticky).toBe(true);
  });

  test('the active position is never disabled (stays selectable/visible)', () => {
    // sticky applied but parent has no layout → rule would disable it, but it's the current value.
    const d = disabledOf(gatePositionTypeOptions(POSITION_OPTIONS, {
      position: 'sticky', parentHasLayout: false, isViewportChild: false,
    }));
    expect(d.sticky).toBe(false);    // exempt because it's the active value
    expect(d.relative).toBe(true);   // others still gated
  });

  test('Absolute is always enabled', () => {
    for (const [pl, vc] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const d = disabledOf(gatePositionTypeOptions(POSITION_OPTIONS, {
        position: 'relative', parentHasLayout: pl, isViewportChild: vc,
      }));
      expect(d.absolute).toBe(false);
    }
  });
});

describe('isFixedPx', () => {
  test('valid px values', () => {
    expect(isFixedPx('120px')).toBe(true);
    expect(isFixedPx('0px')).toBe(true);
    expect(isFixedPx('-50px')).toBe(true);
    expect(isFixedPx('3.5px')).toBe(true);
  });

  test('invalid values', () => {
    expect(isFixedPx(undefined)).toBe(false);
    expect(isFixedPx('')).toBe(false);
    expect(isFixedPx('auto')).toBe(false);
    expect(isFixedPx('50%')).toBe(false);
    expect(isFixedPx('calc(50% - 60px)')).toBe(false);
  });
});

describe('parsePx', () => {
  test('parses numeric values', () => {
    expect(parsePx('120px')).toBe(120);
    expect(parsePx('0px')).toBe(0);
    expect(parsePx('-50px')).toBe(-50);
    expect(parsePx('3.5px')).toBe(3.5);
  });

  test('returns 0 for unparseable', () => {
    expect(parsePx(undefined)).toBe(0);
    expect(parsePx('auto')).toBe(0);
    expect(parsePx('')).toBe(0);
  });
});

describe('getPinState', () => {
  test('detects active pins', () => {
    const state = getPinState({ left: '10px', top: '20px', right: '', bottom: '' });
    expect(state).toEqual({ left: true, top: true, right: false, bottom: false });
  });

  test('calc values are not active', () => {
    const state = getPinState({ left: 'calc(50% - 60px)', top: '10px' });
    expect(state.left).toBe(false);
    expect(state.top).toBe(true);
  });

  test('empty styles → all inactive', () => {
    expect(getPinState({})).toEqual({ left: false, top: false, right: false, bottom: false });
  });
});

describe('getInsetMode', () => {
  test('no pins → none', () => {
    expect(getInsetMode({ left: false, top: false, right: false, bottom: false })).toBe('none');
  });

  test('L+R → horizontal', () => {
    expect(getInsetMode({ left: true, top: false, right: true, bottom: false })).toBe('horizontal');
  });

  test('T+B → vertical', () => {
    expect(getInsetMode({ left: false, top: true, right: false, bottom: true })).toBe('vertical');
  });

  test('all 4 → full', () => {
    expect(getInsetMode({ left: true, top: true, right: true, bottom: true })).toBe('full');
  });

  test('single pin → none', () => {
    expect(getInsetMode({ left: true, top: false, right: false, bottom: false })).toBe('none');
  });
});

describe('togglePin', () => {
  const elemRect = { width: 200, height: 100, left: 50, top: 30 };
  const parentRect = { width: 600, height: 400 };

  test('pin left (single pin)', () => {
    const result = togglePin('left', {}, elemRect, parentRect);
    expect(result.left).toBe('50px');
  });

  test('pin right (single pin)', () => {
    const result = togglePin('right', {}, elemRect, parentRect);
    // right = 600 - 50 - 200 = 350
    expect(result.right).toBe('350px');
  });

  test('pin right when left already pinned → inset mode, width removed', () => {
    const result = togglePin('right', { left: '50px' }, elemRect, parentRect);
    expect(result.right).toBe('350px');
    expect(result.width).toBe(''); // removed for inset
  });

  test('unpin right from L+R inset → restores width', () => {
    const styles = { left: '50px', right: '350px' };
    const result = togglePin('right', styles, elemRect, parentRect);
    expect(result.right).toBe(''); // removed
    expect(result.width).toBe('200px'); // restored from element rect
  });

  test('unpin left (single pin)', () => {
    const result = togglePin('left', { left: '50px' }, elemRect, parentRect);
    expect(result.left).toBe('');
  });

  test('pin bottom when top already pinned → vertical inset, height removed', () => {
    const result = togglePin('bottom', { top: '30px' }, elemRect, parentRect);
    // bottom = 400 - 30 - 100 = 270
    expect(result.bottom).toBe('270px');
    expect(result.height).toBe(''); // removed for inset
  });

  test('single pin (right) does NOT affect width when no opposite pin', () => {
    const result = togglePin('right', { top: '30px' }, elemRect, parentRect);
    // right = 600 - 50 - 200 = 350
    expect(result.right).toBe('350px');
    expect(result.width).toBeUndefined(); // no width key in output
  });

  test('single pin (bottom) does NOT affect height when no opposite pin', () => {
    const result = togglePin('bottom', { left: '50px' }, elemRect, parentRect);
    // bottom = 400 - 30 - 100 = 270
    expect(result.bottom).toBe('270px');
    expect(result.height).toBeUndefined(); // no height key in output
  });

  test('unpin left from L+R inset → restores width', () => {
    const styles = { left: '50px', right: '350px' };
    const result = togglePin('left', styles, elemRect, parentRect);
    expect(result.left).toBe(''); // removed
    expect(result.width).toBe('200px'); // restored from element rect
  });

  test('toggling bottom pin while horizontal inset active does not touch width', () => {
    // Horizontal inset: L+R pinned. Now toggle bottom (vertical axis).
    const styles = { left: '50px', right: '350px' };
    const result = togglePin('bottom', styles, elemRect, parentRect);
    // bottom = 400 - 30 - 100 = 270
    expect(result.bottom).toBe('270px');
    // Should not contain width — horizontal inset is independent of vertical pin toggle
    expect(result.width).toBeUndefined();
  });
});

describe('calculateAlignment', () => {
  const elem = { width: 200, height: 100 };
  const parent = { width: 600, height: 400 };

  // Unpinned / %-positioned → centre-point system: a `%` left/top plus a
  // `translateX/Y(-50%)` so the alignment survives a parent/element resize.
  describe('unpinned (centre-point %)', () => {
    test('left', () => expect(calculateAlignment('left', {}, elem, parent))
      .toEqual({ left: '16.6667%', right: '', transform: 'translateX(-50%)' }));
    test('center-h', () => expect(calculateAlignment('center-h', {}, elem, parent))
      .toEqual({ left: '50%', right: '', transform: 'translateX(-50%)' }));
    test('right', () => expect(calculateAlignment('right', {}, elem, parent))
      .toEqual({ left: '83.3333%', right: '', transform: 'translateX(-50%)' }));
    test('top', () => expect(calculateAlignment('top', {}, elem, parent))
      .toEqual({ top: '12.5000%', bottom: '', transform: 'translateY(-50%)' }));
    test('center-v', () => expect(calculateAlignment('center-v', {}, elem, parent))
      .toEqual({ top: '50%', bottom: '', transform: 'translateY(-50%)' }));
    test('bottom', () => expect(calculateAlignment('bottom', {}, elem, parent))
      .toEqual({ top: '87.5000%', bottom: '', transform: 'translateY(-50%)' }));
  });

  // Single px pin → snap that side, stay pinned on it.
  describe('left-pinned (px)', () => {
    const s = { left: '50px' };
    test('left → 0', () => expect(calculateAlignment('left', s, elem, parent)).toEqual({ left: '0px' }));
    test('center-h', () => expect(calculateAlignment('center-h', s, elem, parent)).toEqual({ left: '200px' }));
    test('right', () => expect(calculateAlignment('right', s, elem, parent)).toEqual({ left: '400px' }));
  });

  describe('right-pinned (px) — stays pinned to the right edge', () => {
    const s = { right: '50px' };
    test('right → 0', () => expect(calculateAlignment('right', s, elem, parent)).toEqual({ right: '0px' }));
    test('left', () => expect(calculateAlignment('left', s, elem, parent)).toEqual({ right: '400px' }));
    test('center-h', () => expect(calculateAlignment('center-h', s, elem, parent)).toEqual({ right: '200px' }));
  });

  // Both sides pinned (inset) → adjust both inset values + restore width.
  describe('horizontal inset (left + right pinned)', () => {
    const s = { left: '50px', right: '50px' }; // visualWidth = 500
    test('left', () => expect(calculateAlignment('left', s, elem, parent))
      .toEqual({ width: '500px', left: '0px', right: '100px' }));
    test('right', () => expect(calculateAlignment('right', s, elem, parent))
      .toEqual({ width: '500px', right: '0px', left: '100px' }));
    test('center-h', () => expect(calculateAlignment('center-h', s, elem, parent))
      .toEqual({ width: '500px', left: '50px', right: '50px' }));
  });

  test('top-pinned → top: 0', () => expect(calculateAlignment('top', { top: '50px' }, elem, parent))
    .toEqual({ top: '0px' }));

  test('preserves a visual transform when re-centring', () =>
    expect(calculateAlignment('center-h', { transform: 'rotate(45deg)' }, elem, parent))
      .toEqual({ left: '50%', right: '', transform: 'translateX(-50%) rotate(45deg)' }));
});

describe('calculatePreservedPosition', () => {
  const elemScreen = { left: 150, top: 80 };
  const parentScreen = { left: 100, top: 50 };

  test('switch to absolute', () => {
    const result = calculatePreservedPosition('relative', 'absolute', elemScreen, parentScreen);
    expect(result.position).toBe('absolute');
    expect(result.left).toBe('50px');
    expect(result.top).toBe('30px');
  });

  test('switch to relative clears position', () => {
    const result = calculatePreservedPosition('absolute', 'relative', elemScreen, parentScreen);
    expect(result.position).toBe('relative');
    expect(result.left).toBe('');
    expect(result.top).toBe('');
  });

  test('switch to sticky sets top 0', () => {
    const result = calculatePreservedPosition('absolute', 'sticky', elemScreen, parentScreen);
    expect(result.position).toBe('sticky');
    expect(result.top).toBe('0px');
  });
});

// ─── Inset Engine ────────────────────────────────────────────────────────

describe('getInsetState', () => {
  test('no pins → no inset', () => {
    const s = getInsetState({ width: '200px', height: '100px' });
    expect(s.horizontalInset).toBe(false);
    expect(s.verticalInset).toBe(false);
    expect(s.fullInset).toBe(false);
  });

  test('L+R pinned with width → NOT horizontal inset (width overrides)', () => {
    const s = getInsetState({ left: '10px', right: '10px', width: '200px' });
    expect(s.horizontalInset).toBe(false);
  });

  test('L+R pinned without width → horizontal inset', () => {
    const s = getInsetState({ left: '10px', right: '10px', top: '5px' });
    expect(s.horizontalInset).toBe(true);
    expect(s.verticalInset).toBe(false);
  });

  test('all 4 pinned, no width/height → full inset', () => {
    const s = getInsetState({ left: '10px', right: '10px', top: '5px', bottom: '5px' });
    expect(s.fullInset).toBe(true);
  });
});

describe('computeResizeInsetStyles', () => {
  const parent = { width: 600, height: 400 };

  test('no inset → returns width/height/left/top', () => {
    const inset = getInsetState({ left: '50px' });
    const result = computeResizeInsetStyles(inset, { left: 50, top: 30, width: 200, height: 100 }, parent, false);
    expect(result.width).toBe('200px');
    expect(result.height).toBe('100px');
    expect(result.left).toBe('50px');
  });

  test('horizontal inset → returns left/right, NO width', () => {
    const inset = getInsetState({ left: '50px', right: '350px' });
    const result = computeResizeInsetStyles(inset, { left: 50, top: 30, width: 200, height: 100 }, parent, false);
    expect(result.left).toBe('50px');
    expect(result.right).toBe('350px'); // 600 - 50 - 200
    expect(result.width).toBeUndefined();
    expect(result.height).toBe('100px');
  });

  test('full inset → returns all 4, NO width/height', () => {
    const inset = getInsetState({ left: '50px', right: '350px', top: '30px', bottom: '270px' });
    const result = computeResizeInsetStyles(inset, { left: 50, top: 30, width: 200, height: 100 }, parent, false);
    expect(result.left).toBe('50px');
    expect(result.right).toBe('350px');
    expect(result.top).toBe('30px');
    expect(result.bottom).toBe('270px');
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
  });
});

describe('computeDragInsetStyles', () => {
  test('full inset drag → shifts all 4', () => {
    const inset = getInsetState({ left: '50px', right: '350px', top: '30px', bottom: '270px' });
    const result = computeDragInsetStyles(inset, { left: '50px', right: '350px', top: '30px', bottom: '270px' }, 10, 5);
    expect(result.left).toBe('60px');
    expect(result.right).toBe('340px');
    expect(result.top).toBe('35px');
    expect(result.bottom).toBe('265px');
  });

  test('right-only pin drag → right decreases', () => {
    const inset = getInsetState({ right: '100px', top: '30px' });
    const result = computeDragInsetStyles(inset, { right: '100px', top: '30px' }, 10, 5);
    expect(result.right).toBe('90px'); // right -= dx
    expect(result.top).toBe('35px');
    expect(result.left).toBeUndefined();
  });

  test('no pins → normal left/top', () => {
    const inset = getInsetState({});
    const result = computeDragInsetStyles(inset, { left: '50px', top: '30px' }, 10, 5);
    expect(result.left).toBe('60px');
    expect(result.top).toBe('35px');
  });
});

describe('computeDimensionInsetStyles', () => {
  test('horizontal inset + width change → updates right', () => {
    const inset = getInsetState({ left: '50px', right: '350px' });
    const result = computeDimensionInsetStyles(inset, { left: '50px', right: '350px' }, 'width', 250, 600);
    expect(result.left).toBe('50px');
    expect(result.right).toBe('300px'); // 600 - 50 - 250
    expect(result.width).toBeUndefined();
  });

  test('no inset + width change → normal', () => {
    const inset = getInsetState({ left: '50px' });
    const result = computeDimensionInsetStyles(inset, { left: '50px' }, 'width', 250, 600);
    expect(result.width).toBe('250px');
  });

  test('vertical inset + height change → updates bottom', () => {
    const inset = getInsetState({ top: '20px', bottom: '180px' });
    const result = computeDimensionInsetStyles(inset, { top: '20px', bottom: '180px' }, 'height', 150, 400);
    expect(result.top).toBe('20px');
    expect(result.bottom).toBe('230px'); // 400 - 20 - 150
  });
});

describe('mergeVariantPinStyles', () => {
  // The user's repro (2026-08-26): master pinned on all four sides; the
  // hover variant unpinned via { left: %, top: %, right: 'auto',
  // bottom: 'auto' }. Every pin consumer reading only base saw the
  // MASTER's pins.
  const base = {
    position: 'absolute', left: '1176px', top: '456px',
    right: '40px', bottom: '-69px', width: '64px', height: '64px',
  };
  const motionVariants = {
    default: { left: '1176px', top: '456px', right: '40px', bottom: '-69px' },
    'default-hover': {
      left: '94.375%', top: '84.0441%', right: 'auto', bottom: 'auto',
      transform: 'translate(-50%, -50%)',
    },
  };

  test('variant tile: entry auto masks base pins, % and transform ride through', () => {
    const out = mergeVariantPinStyles(base, motionVariants, 'default-hover');
    expect(out.right).toBeUndefined();
    expect(out.bottom).toBeUndefined();
    expect(out.left).toBe('94.375%');
    expect(out.top).toBe('84.0441%');
    expect(out.transform).toBe('translate(-50%, -50%)');
    expect(getPinState(out)).toEqual({ left: false, top: false, right: false, bottom: false });
  });

  test('primary tile: only the always-on default entry applies', () => {
    const out = mergeVariantPinStyles(base, motionVariants, 'default');
    expect(getPinState(out)).toEqual({ left: true, top: true, right: true, bottom: true });
  });

  test('numeric entry values are stringified', () => {
    const out = mergeVariantPinStyles({}, { default: {}, v2: { rotate: -90 } }, 'v2');
    expect(out.rotate).toBe('-90');
  });

  test('no motionVariants → same reference back', () => {
    expect(mergeVariantPinStyles(base, undefined, 'v2')).toBe(base);
    expect(mergeVariantPinStyles(base, null, 'v2')).toBe(base);
  });

  test('empty entries → same reference back', () => {
    expect(mergeVariantPinStyles(base, { other: { left: '1px' } }, 'v2')).toBe(base);
  });

  test('does not mutate base', () => {
    mergeVariantPinStyles(base, motionVariants, 'default-hover');
    expect(base.right).toBe('40px');
  });
});
