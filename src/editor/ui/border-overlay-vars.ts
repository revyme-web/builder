// border-overlay-vars.ts — the OVERLAY border (`::after` layer above the
// content, never in flow) driven by CSS custom properties so it ANIMATES with
// framer-motion's own physics (spring / mass / damping) on variant switches.
//
// A pseudo-element cannot be a motion target, but motion animates CSS
// variables on the element like any other value. So in a design-component
// master the rule reads `var(--rvb-*)` and the per-variant VALUES live in the
// variants object (`'--rvb-bw': '2px'`), exactly like backgroundColor: the
// component's transition eases the variables, the `::after` follows. This is
// how the reference gets an eased border while keeping it a layer (2026-09-06).
//
// Pages (no variants) keep the literal rule — nothing to animate between.

import type { BorderState } from './border-utils';

export const BORDER_OVERLAY_VAR_WIDTH = '--rvb-bw';
export const BORDER_OVERLAY_VAR_STYLE = '--rvb-bs';
export const BORDER_OVERLAY_VAR_COLOR = '--rvb-bc';
export const BORDER_OVERLAY_VARS = [BORDER_OVERLAY_VAR_WIDTH, BORDER_OVERLAY_VAR_STYLE, BORDER_OVERLAY_VAR_COLOR] as const;

/** The static `::after` body: geometry + `var()` reads. Written ONCE per node. */
export function formatBorderAfterCSSVars(): string {
  return [
    "content: '';",
    'position: absolute;',
    'inset: 0;',
    'border-radius: inherit;',
    'pointer-events: none;',
    'z-index: 1;',
    `border-width: var(${BORDER_OVERLAY_VAR_WIDTH});`,
    `border-style: var(${BORDER_OVERLAY_VAR_STYLE});`,
    `border-color: var(${BORDER_OVERLAY_VAR_COLOR});`,
  ].map((l) => '  ' + l).join('\n');
}

/** The variable values for a border state (uniform → single value; else the
 *  4-side shorthand — motion interpolates multi-number / multi-color strings). */
export function borderStateToOverlayVars(state: BorderState): Record<string, string> {
  const { top, right, bottom, left } = state;
  if (state.isUniform) {
    return {
      [BORDER_OVERLAY_VAR_WIDTH]: `${top.width}px`,
      [BORDER_OVERLAY_VAR_STYLE]: top.style,
      [BORDER_OVERLAY_VAR_COLOR]: top.color,
    };
  }
  return {
    [BORDER_OVERLAY_VAR_WIDTH]: `${top.width}px ${right.width}px ${bottom.width}px ${left.width}px`,
    [BORDER_OVERLAY_VAR_STYLE]: `${top.style} ${right.style} ${bottom.style} ${left.style}`,
    [BORDER_OVERLAY_VAR_COLOR]: `${top.color} ${right.color} ${bottom.color} ${left.color}`,
  };
}

/** '' for every variable — the delete-this-property write (removes the inline
 *  values on the primary, or a variant entry's override so it inherits). */
export function clearedOverlayVars(): Record<string, string> {
  return { [BORDER_OVERLAY_VAR_WIDTH]: '', [BORDER_OVERLAY_VAR_STYLE]: '', [BORDER_OVERLAY_VAR_COLOR]: '' };
}

/** NO border, spelled in `state`'s own style and colour: every side 0px. What
 *  the primary holds while only a variant has a border — it paints nothing, and
 *  motion still eases the WIDTH to the variant's (a missing variable can't be
 *  animated from, and wouldn't animate back). Before 2026-10-15 the first
 *  border written on a hover tile seeded the primary with the HOVER's own
 *  values, so the primary showed the border too. */
export function zeroWidthOverlayVars(state: BorderState): Record<string, string> {
  const zero = (side: BorderState['top']) => ({ ...side, width: 0 });
  return borderStateToOverlayVars({
    top: zero(state.top), right: zero(state.right), bottom: zero(state.bottom), left: zero(state.left),
    isUniform: state.isUniform,
  });
}

/** Does a `--rvb-bw` value (one width or the 4-side shorthand) paint anything? */
export function overlayWidthVisible(width: string | null | undefined): boolean {
  return !!width && width.trim().split(/\s+/).some((w) => parseFloat(w) > 0);
}

/** The design component's primary variant — its variants entry mirrors the
 *  inline base (the animate-back seed), so it never states a border of its own. */
const PRIMARY_VARIANT = 'default';

export type OverlayVarRemoval =
  /** A variant tile the primary's border would show through: override it with
   *  NO border in this entry — the purple override, Reset Override restores it.
   *  Dropping the entry's values instead let the primary's border show again,
   *  and on a variant with no values of its own the × did nothing at all
   *  (2026-10-15). */
  | { kind: 'zero-variant' }
  /** A variant tile while the primary has no visible border: drop this entry's
   *  values so it inherits the primary's none. */
  | { kind: 'inherit' }
  /** The primary while another variant still has a border: zero the primary's
   *  width, KEEP the shared `::after` rule — removing it erased every variant's. */
  | { kind: 'zero-primary' }
  /** No visible border is left anywhere: the rule goes, and with it every
   *  variable — inline and in each listed variants entry. */
  | { kind: 'remove-all'; clearVariants: string[] };

/** What removing a VAR-BACKED overlay border does, from the tile it's removed on.
 *  The × always means "no border HERE": the primary's × leaves every variant's
 *  own border alone, a variant's × leaves the primary's alone.
 *  `variants` is the node's parsed variants object, `baseWidth` its inline
 *  `--rvb-bw`, `tileVariant` the variant tile (null = the primary). */
export function planOverlayVarRemoval(opts: {
  variants: Record<string, Record<string, string>> | null | undefined;
  baseWidth: string | undefined;
  tileVariant: string | null;
}): OverlayVarRemoval {
  const entries = opts.variants ?? {};
  const otherVariantHasBorder = Object.entries(entries).some(([name, st]) =>
    name !== PRIMARY_VARIANT && name !== opts.tileVariant && overlayWidthVisible(st?.[BORDER_OVERLAY_VAR_WIDTH]));
  if (opts.tileVariant) {
    if (overlayWidthVisible(opts.baseWidth)) return { kind: 'zero-variant' };
    return otherVariantHasBorder ? { kind: 'inherit' } : removeAll(entries);
  }
  return otherVariantHasBorder ? { kind: 'zero-primary' } : removeAll(entries);
}

function removeAll(entries: Record<string, Record<string, string>>): OverlayVarRemoval {
  return {
    kind: 'remove-all',
    clearVariants: Object.keys(entries).filter((n) => BORDER_OVERLAY_VARS.some((v) => v in (entries[n] ?? {}))),
  };
}

export function isVarBackedBorderAfterBody(body: string | null | undefined): boolean {
  return !!body && body.includes(`var(${BORDER_OVERLAY_VAR_WIDTH}`);
}

/** Substitute `var(--rvb-*)` with the tile's effective values so the literal
 *  parser (`parseBorderAfterCSS`) can read the state. Unresolvable vars → ''. */
export function resolveBorderAfterBodyVars(body: string, lookup: (name: string) => string | undefined): string {
  return body.replace(/var\((--rvb-[a-z]+)\)/g, (_m, name: string) => lookup(name) ?? '');
}
