// renderer-culled-dirty.test.ts — a DISTRUSTED render (undo/redo) must not
// mark UNCHANGED culled roots dirty.
//
// Distrusted renders disable the patch-key skip by design (undo residue has to
// be reconciled), so every element walks the patch path. Marking the enclosing
// culled root dirty from that walk restored EVERY offscreen subtree on each
// keystroke — and re-attaching a subtree makes the browser re-decode and
// re-raster its images, so undo took ~½s on image-heavy pages while deleting
// the images made it instant ("those images create the bottleneck",
// 2026-08-07). The dirty-mark is now gated on a REAL value change: the freshly
// computed patch key differing from the stored one.

import { describe, it, expect } from 'vitest';

/** The gate, mirrored exactly from patchElement (Renderer.ts). */
function marksDirty(patchKey: string | null, storedKey: string | undefined): boolean {
  const unchanged = patchKey !== null && storedKey === patchKey;
  return !unchanged;
}

describe('culled-root dirty gate on distrusted renders', () => {
  it('does NOT mark dirty when the recomputed key matches the stored one', () => {
    expect(marksDirty('sig|pfx||1440|fp|en', 'sig|pfx||1440|fp|en')).toBe(false);
  });

  it('marks dirty when the value genuinely changed', () => {
    expect(marksDirty('sigB|pfx||1440|fp|en', 'sigA|pfx||1440|fp|en')).toBe(true);
  });

  it('marks dirty for a never-patched element (no stored key)', () => {
    expect(marksDirty('sig|pfx||1440|fp|en', undefined)).toBe(true);
  });

  it('stays conservative for keyless nodes (dynamic / CMS-bound): always dirty', () => {
    expect(marksDirty(null, undefined)).toBe(true);
    expect(marksDirty(null, 'anything')).toBe(true);
  });
});
