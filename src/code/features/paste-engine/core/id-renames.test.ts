// id-renames.test.ts — Verify the shared rename helpers used by both
// the effects-injector (source slices) and the node-creator (style
// `var:` references).

import { describe, it, expect } from 'vitest';
import {
  buildIdRenamePairs,
  applyAllRenames,
  applyPrefixRenames,
  renameVarStyleValues,
} from './id-renames';

describe('buildIdRenamePairs', () => {
  it('produces raw + prefix pairs from an id-map', () => {
    const idMap = new Map([['frame-mpoaahpp-2', 'div-mpoab3d2-4']]);
    const pairs = buildIdRenamePairs(idMap);
    expect(pairs.raw).toEqual([['frame-mpoaahpp-2', 'div-mpoab3d2-4']]);
    expect(pairs.prefixLower).toEqual([['frameMpoaahpp_2', 'divMpoab3d2_4']]);
    expect(pairs.prefixUpper).toEqual([['FrameMpoaahpp_2', 'DivMpoab3d2_4']]);
  });

  it('skips identity pairs (same src and dst)', () => {
    const idMap = new Map([['a', 'a'], ['b', 'c']]);
    const pairs = buildIdRenamePairs(idMap);
    expect(pairs.raw).toEqual([['b', 'c']]);
  });

  it('sorts longest-first to avoid partial matches', () => {
    const idMap = new Map([
      ['short', 'A'],
      ['shorter-name', 'B'],
      ['shortest-name-ever', 'C'],
    ]);
    const pairs = buildIdRenamePairs(idMap);
    expect(pairs.raw[0][0].length).toBeGreaterThanOrEqual(pairs.raw[1][0].length);
    expect(pairs.raw[1][0].length).toBeGreaterThanOrEqual(pairs.raw[2][0].length);
  });
});

describe('applyAllRenames', () => {
  it('renames quoted data-id literals and var-prefix occurrences together', () => {
    const idMap = new Map([['frame-x-1', 'div-y-2']]);
    const pairs = buildIdRenamePairs(idMap);
    const input = `gsap.to('[data-id="frame-x-1"]', { opacity: frameX_1Opacity });`;
    const out = applyAllRenames(input, pairs);
    expect(out).toContain('[data-id="div-y-2"]');
    expect(out).toContain('divY_2Opacity');
    expect(out).not.toContain('frame-x-1');
    expect(out).not.toContain('frameX_1Opacity');
  });

  it('leaves cross-references (ids not in the map) verbatim', () => {
    const idMap = new Map([['frame-a', 'frame-b']]);
    const pairs = buildIdRenamePairs(idMap);
    const input = `getElementById('other-target');`;
    const out = applyAllRenames(input, pairs);
    expect(out).toBe(input);
  });
});

describe('applyPrefixRenames', () => {
  it('does NOT touch text inside string-literal quotes', () => {
    const idMap = new Map([['frame-a', 'frame-b']]);
    const pairs = buildIdRenamePairs(idMap);
    // The prefix `frameA` appears inside `'frameA'` — must NOT rename
    // (the next char `'` isn't uppercase).
    const out = applyPrefixRenames(`const s = 'frameA';`, pairs);
    expect(out).toContain("'frameA'");
  });

  it('renames `<prefix><Suffix>` style names', () => {
    const idMap = new Map([['frame-mpo91uhh-8', 'frame-new']]);
    const pairs = buildIdRenamePairs(idMap);
    const out = applyPrefixRenames(
      `const frameMpo91uhh_8Opacity = useTransform(...);`,
      pairs,
    );
    // `frame-new` → `frameNew` lowercase. So renamed name is `frameNewOpacity`.
    expect(out).toContain('frameNewOpacity');
    expect(out).not.toContain('frameMpo91uhh_8Opacity');
  });
});

// ─── var: style value rename ────────────────────────────────────────────────

describe('renameVarStyleValues', () => {
  it('rewrites `var:<oldPrefix><Suffix>` → `var:<newPrefix><Suffix>`', () => {
    const idMap = new Map([['frame-mpoaahpp-2', 'div-mpoab3d2-4']]);
    const pairs = buildIdRenamePairs(idMap);
    const out = renameVarStyleValues(
      {
        opacity: 'var:frameMpoaahpp_2Opacity',
        scale: 'var:frameMpoaahpp_2Scale',
      },
      pairs,
    );
    expect(out.opacity).toBe('var:divMpoab3d2_4Opacity');
    expect(out.scale).toBe('var:divMpoab3d2_4Scale');
  });

  it('leaves non-`var:` style values alone', () => {
    const idMap = new Map([['frame-a', 'frame-b']]);
    const pairs = buildIdRenamePairs(idMap);
    const out = renameVarStyleValues(
      { width: '320px', backgroundColor: '#ffb3ba' },
      pairs,
    );
    expect(out.width).toBe('320px');
    expect(out.backgroundColor).toBe('#ffb3ba');
  });

  it('preserves `var:` values whose prefix is NOT in the rename map (cross-refs)', () => {
    const idMap = new Map([['frame-a', 'frame-b']]);
    const pairs = buildIdRenamePairs(idMap);
    // Reference points at a different source node (`frameC`) that the
    // user didn't copy → stays verbatim, will resolve to undefined on
    // destination, no-op.
    const out = renameVarStyleValues(
      { opacity: 'var:frameCOpacity' },
      pairs,
    );
    expect(out.opacity).toBe('var:frameCOpacity');
  });

  it('returns input ref when nothing changed (caller can identity-check)', () => {
    const idMap = new Map([['frame-a', 'frame-b']]);
    const pairs = buildIdRenamePairs(idMap);
    const input = { width: '100px' };
    const out = renameVarStyleValues(input, pairs);
    expect(out).toBe(input);
  });
});
