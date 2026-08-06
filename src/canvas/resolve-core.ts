// resolve-core.ts — pure resolution primitives shared by the Renderer (read/paint) and the live-drag
// preview. Extracted to kill the duplication the audit found: the variant-precedence block copy-pasted
// across the Renderer's variant/CMS sites, and the per-viewport BAND selection duplicated in the style +
// text resolvers (and re-implemented DIVERGENTLY in TemplatePicker's drag path — the source of Bug 1).
//
// Pure functions, no DOM / side effects → trivially testable and safe to call per frame. The canvas is
// fully imperative + DOM-only, so these decide a value/variant from the parsed node model; the caller
// writes the result to the DOM.

import type { CanvasNode } from '@/code/parsing/parser';
import { pinnedResolveWidth } from './resize/viewport-band-pin-store';

/**
 * The variant a node resolves to for a given context: a per-tile override in
 * `responsiveVariantMap[vpWidth]` WINS over the passed base `variant`, then the node's static
 * `componentVariant`, then `fallback`.
 *
 * Centralizes the precedence copy-pasted across `applyResponsiveAndVariantBindings` + the two
 * collection-list sites. `fallback` preserves each site's intentionally-different tail (the audit's
 * "PARTIAL": the binding site fell back to `null`, the CMS-list build site to `undefined`).
 *
 * NOTE — `resolveVariantStyles` and `resolveConditionalText` keep their OWN forms and are NOT routed
 * here: they legitimately diverge (a `motionVariants||conditionalStyles||hiddenOnVariants` guard; a
 * two-branch shape with a rare null-map edge). Merging them would be a behavior change, not a refactor.
 */
export function resolveActiveVariant(
  node: Pick<CanvasNode, 'responsiveVariantMap' | 'componentVariant'> & { id?: string; responsiveVariantBp?: number[] | null },
  ctx: { vpWidth?: number; variant?: string | null },
  fallback: string | null | undefined = null,
): string | null | undefined {
  const { variant } = ctx;
  let { vpWidth } = ctx;
  if (vpWidth !== undefined) {
    vpWidth = pinnedResolveWidth(node.id, vpWidth); // viewport-drag pin
    const mapped = responsiveVariantForWidth(node.responsiveVariantMap, vpWidth, node.responsiveVariantBp);
    if (mapped !== undefined) return mapped;
  }
  return variant ?? node.componentVariant ?? fallback;
}

/**
 * The variant-map entry that applies at `vpWidth` — MEDIA-QUERY interval semantics, not exact
 * lookup. The map's numeric keys are the breakpoint widths the instance's `initialVariant` gates
 * were generated for: each key is a `(max-width: key)` bound, floored where the next key down
 * begins. An exact hit stays an exact hit (page tiles render at exactly their own breakpoint
 * widths, so page instances behave as before). A tile at a width BETWEEN keys picks the band the
 * LIVE gates would — the case is template chrome on a page: the chrome's `data-responsive` is
 * keyed by the TEMPLATE's breakpoints (768/375) while the page tile renders at the PAGE's width
 * (e.g. a mobile viewport resized to 585). Exact lookup missed → primary variant → the canvas
 * showed the DESKTOP nav on a 585px tile while live (where `(max-width: 768px)` matches) showed
 * the tablet burger (user report 2026-08-06). Above every key → undefined (the primary band).
 */
export function responsiveVariantForWidth<T = string>(
  map: Record<number, T> | null | undefined,
  vpWidth: number,
  /** The instance's own `_bp` breakpoint list (data-responsive). When present,
   *  bucketing runs against THIS list — exactly what the live runtime does —
   *  and a bucket WITHOUT an override returns undefined (the base shows).
   *  Without it, a map-keys interval walk CASCADES past widths that have no
   *  entry: with a replica WIDER than the primary (map {796: v1, 1409: v2},
   *  primary at 1277), the walk skipped the primary's own bucket and painted
   *  1409's variant on the PRIMARY tile while live correctly showed the base
   *  (user report 2026-08-06). */
  bp?: number[] | null,
): T | undefined {
  if (!map) return undefined;
  if (map[vpWidth] !== undefined) return map[vpWidth];
  if (bp && bp.length > 0) {
    // LIVE PARITY: bucket = smallest breakpoint ≥ the width; look up the map
    // AT that bucket only — no cascade. Wider than every breakpoint → base.
    let bucket: number | null = null;
    for (const b of bp) {
      if (!Number.isFinite(b) || b < vpWidth) continue;
      if (bucket === null || b < bucket) bucket = b;
    }
    return bucket === null ? undefined : map[bucket];
  }
  // Legacy (no _bp captured): smallest map key ≥ the width. Correct only
  // while every configured breakpoint carries an entry or the replica set is
  // narrower than the primary.
  let best: number | null = null;
  for (const k of Object.keys(map)) {
    const kn = Number(k);
    if (!Number.isFinite(kn) || kn < vpWidth) continue;
    if (best === null || kn < best) best = kn;
  }
  return best === null ? undefined : map[best];
}

/**
 * The per-viewport BAND a tile falls into for a set of breakpoint values: the SMALLEST breakpoint `b`
 * (ascending) whose range [min, b] still covers `vpWidth` — first-match-wins, NOT cascade (a Tablet
 * override does NOT paint Mobile). Returns the winning breakpoint number, or `null` if none covers the
 * tile (→ the base value shows). `bands[b]` is breakpoint `b`'s min-width floor (default 0).
 *
 * This is the ONE definition of "which breakpoint applies to this tile", lifted verbatim from
 * `getResponsiveStyleVarValuesForNode`. The Renderer (style + text resolvers) AND TemplatePicker's
 * live-drag preview both call it, so the drag preview can never again disagree with the paint (Bug 1).
 */
export function bandForTile(
  byW: Record<number, unknown> | undefined,
  bands: Record<number, number> | null | undefined,
  vpWidth: number,
): number | null {
  if (!byW) return null;
  const widths = Object.keys(byW).map(Number).sort((a, b) => a - b);
  for (const b of widths) {
    const min = bands?.[b] ?? 0;
    if (vpWidth <= b && vpWidth >= min) return b;
  }
  return null;
}
