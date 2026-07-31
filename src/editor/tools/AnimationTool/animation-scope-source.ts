// animation-scope-source.ts — Resolve the CURRENT animation scope from the
// editor context (which tile / variant the user is working on), so adding a
// hover/appear/etc. scopes it like a style override does.
//
//   - Component file + a non-default active variant → { variant }.
//   - Page + a non-primary interacting viewport      → { query } (banded like @media).
//   - Otherwise (primary / desktop / base)           → null = runs everywhere.
//
// Mirrors how set_variant_style picks up the active variant. The generators
// consume the returned ResolvedScope directly.

import { getDefaultStore } from 'jotai';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import {
  interactingViewportIdAtom,
  viewportWidthsAtom,
  activeComponentVariantAtom,
  getSortedBreakpointWidths,
} from '@/code/stores/viewport-store';
import { isPrimaryViewport } from '@/canvas/node-ops';
import { resolveScope, queryToViewportSet, type ResolvedScope } from '@/code/animations/animation-scope';

/**
 * Decide whether a detected animation (by its scope) should SHOW on the current
 * viewport/variant, and whether it's a scoped OVERRIDE (vs a base/all animation).
 *
 *   - A base animation (no scope) shows everywhere, isn't an override.
 *   - A page-viewport scoped animation shows ONLY on the viewport(s) its query
 *     covers; on those, it's an override (so the row gets a Reset).
 *   - A variant scoped animation shows ONLY in that variant.
 *
 * `scope` comes from a motion `_scope` marker (`gate:__mqN` / `variant:x`)
 * resolved against `code`, or an already-parsed `ResolvedScope`.
 */
function animAppliesHere(
  scope: ResolvedScope | string | undefined | null,
  code: string,
  ctx: { vpWidth: number; allWidths: number[]; variant: string | null },
): { applies: boolean; isOverride: boolean } {
  if (!scope) return { applies: true, isOverride: false };

  let query: string | null = null;
  let variant: string | null = null;
  if (typeof scope === 'string') {
    if (scope.startsWith('variant:')) variant = scope.slice(8);
    else if (scope.startsWith('query:')) query = scope.slice(6);
    else if (scope.startsWith('gate:')) {
      const v = scope.slice(5);
      const m = code.match(new RegExp(`const\\s+${v}\\s*=\\s*useMediaQuery\\('([^']+)'\\)`));
      query = m ? m[1] : null;
    }
  } else if ('variant' in scope) variant = scope.variant;
  else query = scope.query;

  // A variant-scoped animation whose home IS the primary ('default') is not an
  // override — there is no base it overrides, and the purple Reset chip belongs
  // on REPLICAS only (live find 2026-06-10: a solo-node gated appear
  // `initial={variant === 'default' ? {…} : undefined}` showed purple on the
  // primary master).
  if (variant) return { applies: ctx.variant === variant, isOverride: variant !== 'default' };
  if (query) return { applies: queryToViewportSet(query, ctx.allWidths).includes(ctx.vpWidth), isOverride: true };
  return { applies: true, isOverride: false };
}

/**
 * Resolve a parsed responsive motion prop (whileHover / whileTap / …) for the
 * current tile. The parser stores the full ternary chain as `_chain`
 * ([{marker, props}], one per viewport/variant) + the final `_base`, plus a
 * `_scope` marker for the simple single-branch form. Returns whether the row
 * should SHOW here, whether it's a scoped OVERRIDE (→ Reset), and the props to
 * SEED the editor with (the branch that gates this tile, else the base).
 */
export function resolveResponsiveMotionProp(
  motionProp: Record<string, any> | null | undefined,
  code: string,
  ctx: { vpWidth: number; allWidths: number[]; variant: string | null },
): { applies: boolean; isOverride: boolean; props: Record<string, string> } {
  if (!motionProp) return { applies: false, isOverride: false, props: {} };
  let { applies, isOverride } = animAppliesHere(motionProp._scope, code, ctx);
  let props: Record<string, string> = motionProp;
  const chainJson = motionProp._chain;
  if (chainJson) {
    try {
      const chain: Array<{ marker: string; props: Record<string, string> }> = JSON.parse(chainJson);
      const hit = chain.find(e => animAppliesHere(e.marker, code, ctx).applies);
      // isOverride comes from the marker's verdict — a default-variant-gated
      // branch on the PRIMARY tile is the effect's home, not an override.
      if (hit) { applies = true; isOverride = animAppliesHere(hit.marker, code, ctx).isOverride; props = hit.props; }
      else {
        const base = motionProp._base ? JSON.parse(motionProp._base) : {};
        if (Object.keys(base).length > 0) { applies = true; isOverride = false; props = base; }
        else applies = false;
      }
    } catch { /* malformed _chain — keep the scope-marker result */ }
  }
  return { applies, isOverride, props };
}

export function getActiveAnimationScope(): ResolvedScope {
  const store = getDefaultStore();

  // `isComponentFilePath` is path-based (`components/…`) and already FALSE for a template
  // (LayoutClient lives under `app/`), so a template correctly takes the viewport branch below —
  // no `isLayoutFile` guard needed here. (The per-viewport-vs-global routing bug for templates was
  // in ControlProvider's `removeVariable`, which keyed on the component-LIKE `isComponentFileAtom`.)
  if (isComponentFilePath(store.get(activeFilePathAtom))) {
    const variant = store.get(activeComponentVariantAtom);
    if (!variant || variant === 'default') return null;     // primary variant = base
    return { variant };
  }

  const vpId = store.get(interactingViewportIdAtom);
  if (!vpId || vpId === 'desktop' || isPrimaryViewport(vpId)) return null;  // primary = base
  const w = store.get(viewportWidthsAtom)[vpId];
  if (!w) return null;
  return resolveScope({ kind: 'viewports', widths: [w] }, getSortedBreakpointWidths());
}
