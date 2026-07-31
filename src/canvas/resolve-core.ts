// resolve-core.ts — pure resolution primitives shared by the Renderer (read/paint) and the live-drag
// preview. Extracted to kill the duplication the audit found: the variant-precedence block copy-pasted
// across the Renderer's variant/CMS sites, and the per-viewport BAND selection duplicated in the style +
// text resolvers (and re-implemented DIVERGENTLY in TemplatePicker's drag path — the source of Bug 1).
//
// Pure functions, no DOM / side effects → trivially testable and safe to call per frame. The canvas is
// fully imperative + DOM-only, so these decide a value/variant from the parsed node model; the caller
// writes the result to the DOM.

import type { CanvasNode } from '@/code/parsing/parser';

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
  node: Pick<CanvasNode, 'responsiveVariantMap' | 'componentVariant'>,
  ctx: { vpWidth?: number; variant?: string | null },
  fallback: string | null | undefined = null,
): string | null | undefined {
  const { vpWidth, variant } = ctx;
  if (vpWidth !== undefined && node.responsiveVariantMap?.[vpWidth] !== undefined) {
    return node.responsiveVariantMap[vpWidth];
  }
  return variant ?? node.componentVariant ?? fallback;
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
