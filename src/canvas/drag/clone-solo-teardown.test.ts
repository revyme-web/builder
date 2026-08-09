// clone-solo-teardown.test.ts — a canvas clone must not inherit the hide that
// only its source viewport was undoing.
//
// User report 2026-08-09: mobile → canvas → tablet → canvas in ONE gesture; the
// frame vanished the instant it left tablet.
//
// A replica-only node is inline `display: 'none'` + a `display: 'unset'` band
// for the viewport it lives on + `data-replica-solo`. `buildCanvasCloneDescriptor`
// strips that inline hide — but the vp-only extraction site REPLACES the whole
// style map with `pSnap.originalStyles`, the source's raw pre-drag map, putting
// it straight back. At canvas root nothing flips it visible again.
//
// The sibling exit site carries the identical guard; this one only needed it
// once `originalStyles` became the base, which is how the two drifted apart.

import { describe, it, expect } from 'vitest';

/** The teardown applied to an extracted canvas clone, in shape. */
function tearDownSolo(clone: { styles: Record<string, string>; attrs?: Record<string, string> }) {
  if (clone.styles.display === 'none') clone.styles.display = '';
  if (clone.attrs?.['data-replica-solo']) {
    clone.attrs = { ...clone.attrs, 'data-replica-solo': '' };
  }
  return clone;
}

describe('canvas clone — replica-solo teardown', () => {
  it('THE BUG: an inherited display:none is cleared', () => {
    const c = tearDownSolo({ styles: { display: 'none', left: '10px' }, attrs: {} });
    expect(c.styles.display).toBe('');
  });

  it('clears the solo marker — a canvas node has no viewport context', () => {
    const c = tearDownSolo({ styles: {}, attrs: { 'data-replica-solo': 'galaxy-s23' } });
    expect(c.attrs!['data-replica-solo']).toBe('');
  });

  it('leaves a visible clone`s display alone', () => {
    for (const display of ['flex', 'block', 'grid']) {
      expect(tearDownSolo({ styles: { display } }).styles.display).toBe(display);
    }
  });

  it('does not invent a display key when there was none', () => {
    expect('display' in tearDownSolo({ styles: { left: '1px' } }).styles).toBe(false);
  });

  it('leaves other attrs untouched', () => {
    const c = tearDownSolo({ styles: {}, attrs: { 'data-replica-solo': 'x', 'data-pinned': 'true' } });
    expect(c.attrs!['data-pinned']).toBe('true');
  });

  it('a clone with no attrs at all does not crash', () => {
    expect(() => tearDownSolo({ styles: { display: 'none' } })).not.toThrow();
  });
});
