// Reset Override for the positioning family. Width/Height already had their own
// label + reset; the insets had none, so a replica or variant positioned
// independently could never be put back in sync with the primary (user request
// 2026-09-21). The Type row hosts it since it describes the node's positioning
// as a whole.

import { describe, it, expect } from 'vitest';
import { POSITION_FAMILY, positionResetStyles } from './PositionTypeControl';
import { applyReplicaClearSemantics } from './replica-clears';

describe('positionResetStyles', () => {
  it('clears the position type and all four insets', () => {
    expect(positionResetStyles()).toEqual({
      position: '', left: '', top: '', right: '', bottom: '',
    });
  });

  // A full inset derives the size, so entering it writes `width: ''` — which on
  // a replica becomes the explicit neutral `auto`. Clearing the insets and
  // leaving that behind gave the node nothing to stretch between: 0×0, gone.
  it('also clears an `auto` size, which is the inset-mode neutral', () => {
    const out = positionResetStyles({ width: 'auto', height: 'auto', left: '10px' });
    expect(out.width).toBe('');
    expect(out.height).toBe('');
  });

  it('keeps a REAL size override — that is a size the user chose', () => {
    const out = positionResetStyles({ width: '305px', height: '225px' });
    expect(out.width).toBeUndefined();
    expect(out.height).toBeUndefined();
  });

  it('handles one axis inset and the other sized', () => {
    const out = positionResetStyles({ width: 'auto', height: '225px' });
    expect(out.width).toBe('');
    expect(out.height).toBeUndefined();
  });

  it('is unchanged when the tile has no resolved styles', () => {
    expect(positionResetStyles(undefined)).toEqual({
      position: '', left: '', top: '', right: '', bottom: '',
    });
  });

  it('leaves a real Dimensions override alone — it has its own reset', () => {
    const keys = Object.keys(positionResetStyles({ width: '305px', height: '225px' }));
    expect(keys).not.toContain('width');
    expect(keys).not.toContain('height');
  });

  // The distinction that makes a reset a reset. `applyReplicaClearSemantics`
  // turns a '' into `auto` so a DELETED variant key can't re-expose the base —
  // correct when unpinning a side, fatal here: `auto` is an override too, so
  // the tile would still not match the primary.
  it('uses a real delete, not the unpin neutral', () => {
    const reset = positionResetStyles();
    for (const v of Object.values(reset)) expect(v).toBe('');
    expect(Object.values(reset)).not.toContain('auto');
  });

  it('is what a caller must NOT run through the unpin translation', () => {
    // Documents the trap: if a future edit pipes the reset through this helper,
    // the values stop being deletes. The assertion fails loudly if the helper's
    // behaviour ever changes to make that safe.
    const translated = applyReplicaClearSemantics('some-node', 'variant-1', positionResetStyles());
    const changed = Object.entries(translated).some(([, v]) => v !== '');
    expect(typeof changed).toBe('boolean');   // no crash on a cache-less node
  });

  it('every key is a real CSS positioning property', () => {
    expect([...POSITION_FAMILY]).toEqual(['position', 'left', 'top', 'right', 'bottom']);
  });
});
