import { describe, it, expect } from 'vitest';
import {
  scopeEq, presentOn, isPresenceOverride, addPresenceScope, hidePresenceOn, resetPresenceScope,
  type PresenceState,
} from './presence';
import type { SerScope } from '@/code/generation/generator-motion';

const TABLET: SerScope = { query: '(max-width: 768px) and (min-width: 376px)' };
const MOBILE: SerScope = { query: '(max-width: 375px)' };
const V2: SerScope = { variant: 'variant-2' };

describe('presence — shared per-viewport 3-state logic', () => {
  it('scopeEq matches query and variant scopes', () => {
    expect(scopeEq(TABLET, { query: TABLET.query })).toBe(true);
    expect(scopeEq(TABLET, MOBILE)).toBe(false);
    expect(scopeEq(V2, { variant: 'variant-2' })).toBe(true);
    expect(scopeEq(V2, TABLET as any)).toBe(false);
  });

  it('base (no state) runs everywhere; not an override', () => {
    expect(presentOn(undefined, null)).toBe(true);
    expect(presentOn(undefined, TABLET)).toBe(true);
    expect(presentOn({}, MOBILE)).toBe(true);
    expect(isPresenceOverride(undefined, TABLET)).toBe(false);
  });

  it('scoped-only is absent on primary, present only on its scope', () => {
    const p: PresenceState = { scope: [TABLET] };
    expect(presentOn(p, null)).toBe(false);
    expect(presentOn(p, TABLET)).toBe(true);
    expect(presentOn(p, MOBILE)).toBe(false);
    expect(isPresenceOverride(p, TABLET)).toBe(true);
    expect(isPresenceOverride(p, null)).toBe(false);
  });

  it('hiddenOn keeps base, off on the listed tile', () => {
    const p: PresenceState = { hiddenOn: [TABLET] };
    expect(presentOn(p, null)).toBe(true);
    expect(presentOn(p, TABLET)).toBe(false);
    expect(presentOn(p, MOBILE)).toBe(true);
    expect(isPresenceOverride(p, TABLET)).toBe(true);
  });

  it('addPresenceScope: replica → scoped-only; null → unchanged base', () => {
    expect(addPresenceScope(undefined, TABLET)).toEqual({ scope: [TABLET] });
    expect(addPresenceScope({ hiddenOn: [MOBILE] }, TABLET)).toEqual({ hiddenOn: [MOBILE], scope: [TABLET] });
    expect(addPresenceScope(undefined, null)).toBeUndefined();   // Desktop add = base
  });

  it('hidePresenceOn: base → hidden-here; scoped-only → remove on last tile', () => {
    expect(hidePresenceOn(undefined, TABLET)).toEqual({ remove: false, state: { hiddenOn: [TABLET] } });
    expect(hidePresenceOn({ scope: [TABLET] }, TABLET)).toEqual({ remove: true });
    expect(hidePresenceOn({ scope: [TABLET, MOBILE] }, TABLET)).toEqual({ remove: false, state: { scope: [MOBILE] } });
  });

  it('resetPresenceScope: drop the tile; scoped-only with no base → remove', () => {
    expect(resetPresenceScope({ hiddenOn: [TABLET] }, TABLET)).toEqual({ remove: false, state: undefined });
    expect(resetPresenceScope({ scope: [TABLET] }, TABLET)).toEqual({ remove: true });
    expect(resetPresenceScope({ scope: [TABLET, MOBILE] }, TABLET)).toEqual({ remove: false, state: { scope: [MOBILE] } });
  });

  it('works with variant scopes too (component context)', () => {
    const p: PresenceState = { scope: [V2] };
    expect(presentOn(p, V2)).toBe(true);
    expect(presentOn(p, null)).toBe(false);
    expect(hidePresenceOn(p, V2)).toEqual({ remove: true });
  });
});
