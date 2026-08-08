// variant-override-alias.test.ts — a SHORTHAND control is overridden by any of
// its longhands, on the variant channel as well as the @media one.
//
// User report 2026-08-08: on a component variant tile whose padding (32/16/72/16)
// plainly differs from the primary's (90/0/80/0), the Padding label stayed plain
// — no purple, no Reset Override — while Gap lit correctly. Gap is a single key;
// per-variant padding lands in the entry as the four longhands and never as
// `padding`, so the exact-key lookup missed it. `overrideAliasKeys` already
// solved this for @media blocks; this pins the variant twin.

import { describe, it, expect } from 'vitest';
import { overrideAliasKeys } from '@/code/stores/container-query-store';

/** The exact predicate ControlProvider.hasOverride now uses for a variant entry. */
const overriddenInVariant = (entry: Record<string, string>, property: string): boolean =>
  overrideAliasKeys(property).some((k) => k in entry);

/** …and for the inline-ternary (conditionalStyles) channel. */
const overriddenInConditional = (
  cond: Record<string, Record<string, string>>,
  property: string,
  variant: string,
): boolean => overrideAliasKeys(property).some((k) => cond[k] && variant in cond[k]);

describe('variant override detection — shorthand aliases', () => {
  // The Footer's tablet entry, verbatim.
  const tabletEntry = { paddingTop: '32px', paddingRight: '16px', paddingBottom: '72px', paddingLeft: '16px' };

  it('lights the Padding label from the longhands alone', () => {
    expect(overriddenInVariant(tabletEntry, 'padding')).toBe(true);
  });

  it('still lights from the shorthand itself', () => {
    expect(overriddenInVariant({ padding: '16px' }, 'padding')).toBe(true);
  });

  it('does not light a property the variant does not touch', () => {
    expect(overriddenInVariant(tabletEntry, 'margin')).toBe(false);
    expect(overriddenInVariant(tabletEntry, 'backgroundColor')).toBe(false);
  });

  it('covers margin and border-radius the same way', () => {
    expect(overriddenInVariant({ marginTop: '8px' }, 'margin')).toBe(true);
    expect(overriddenInVariant({ borderTopLeftRadius: '4px' }, 'borderRadius')).toBe(true);
  });

  it('a single-key property is unaffected (Gap kept working)', () => {
    expect(overriddenInVariant({ gap: '68px' }, 'gap')).toBe(true);
    expect(overriddenInVariant({ paddingTop: '4px' }, 'gap')).toBe(false);
  });

  it('applies to the inline-ternary channel too', () => {
    const cond = { paddingTop: { 'variant-1': '32px', default: '80px' } };
    expect(overriddenInConditional(cond, 'padding', 'variant-1')).toBe(true);
    expect(overriddenInConditional(cond, 'padding', 'variant-2')).toBe(false);
  });
});
