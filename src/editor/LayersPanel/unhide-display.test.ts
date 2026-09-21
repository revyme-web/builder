// Unhiding a node on TABLET whose hide lives in the BASE style: the write was
// `display: ''`, which deletes the override for that viewport — and there was
// none. The base `display: none` still won, so the node flashed visible and the
// next render hid it again (user report 2026-09-21).

import { describe, it, expect } from 'vitest';
import { visibleDisplayForUnhide } from './rows';

describe('visibleDisplayForUnhide', () => {
  it('defaults to block for a plain frame', () => {
    expect(visibleDisplayForUnhide({ position: 'relative', display: 'none' })).toBe('block');
    expect(visibleDisplayForUnhide({})).toBe('block');
    expect(visibleDisplayForUnhide(undefined)).toBe('block');
  });

  // Hiding overwrote `display`, but the layout properties survive it and say
  // what the node was — the same signal `authoredLayoutOfParent` relies on.
  it('recovers flex from the surviving layout properties', () => {
    expect(visibleDisplayForUnhide({ display: 'none', flexDirection: 'column' })).toBe('flex');
    expect(visibleDisplayForUnhide({ display: 'none', flexWrap: 'wrap' })).toBe('flex');
  });

  it('recovers grid', () => {
    expect(visibleDisplayForUnhide({ display: 'none', gridTemplateColumns: '1fr 1fr' })).toBe('grid');
    expect(visibleDisplayForUnhide({ display: 'none', gridAutoFlow: 'row' })).toBe('grid');
  });

  it('never returns a value that would keep the node hidden', () => {
    const cases: Record<string, string>[] = [{}, { display: 'none' }, { display: 'none', flexDirection: 'row' }];
    for (const styles of cases) {
      expect(visibleDisplayForUnhide(styles)).not.toBe('none');
      expect(visibleDisplayForUnhide(styles)).not.toBe('');
    }
  });

  it('ignores empty layout props', () => {
    expect(visibleDisplayForUnhide({ display: 'none', flexDirection: '  ' })).toBe('block');
  });
});
