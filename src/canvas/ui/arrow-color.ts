// arrow-color.ts — Pure decision: given the selection state, what
// color does each variant-connection arrow render at?
//
// Extracted from `ArrowConnectors.tsx` so the rules are unit-testable
// without spinning up jotai + the active-file store. The component
// imports `pickArrowColor()` and feeds it `(arrow, selectedId,
// isChildSelection, selectedVpId)` per render.
//
// Rules (in priority order):
//   1. No selection at all              → all arrows greyed.
//   2. Per-child arrow                   → highlighted iff
//                                          `selectedId === sourceNode`
//                                          AND the user is interacting
//                                          in the SAME variant as the
//                                          connection's source.
//   3. Root arrow + child selected       → greyed (selection is "below"
//                                          the variant).
//   4. Root arrow + variant root selected → highlighted iff the
//                                           selected variant matches
//                                           either end of the arrow
//                                           (`fromVp` or `toVp`).
//
// Rule 1 was the May-2026 regression fix; rule 4's variant-id check is
// the follow-up: with multiple variants on a master page, ALL root
// arrows used to light up whenever any top-level node was selected,
// because the rule couldn't tell which variant the click landed in.
//
// Variant identification: a connection's `from` / `to` strings are
// variant names that double as viewport ids — except `'default'` which
// maps to the primary viewport `'desktop'`. The component reads the
// active viewport from `interactingViewportIdAtom` and passes it as
// `selectedVpId`.

import { COMPONENT_COLOR } from '@/shared/constants';

// Live re-export (NOT `const ARROW_COLOR = COMPONENT_COLOR` — that snapshots the
// value at module-load, before the theme tokens resolve, so the arrows kept the
// old fallback purple forever). Re-exporting the `let` binding keeps ARROW_COLOR
// tracking the live `--accent-secondary` token. Internal code below reads
// COMPONENT_COLOR directly for the same reason.
export { COMPONENT_COLOR as ARROW_COLOR } from '@/shared/constants';
export const ARROW_COLOR_GREYED = 'rgba(255,255,255,0.08)';

/**
 * Just the bits of an arrow we need to color it. `from` / `to` are
 * variant names from the parsed connection (e.g. `'default'`,
 * `'variant-1'`); `sourceNode` is the data-id of a per-child trigger
 * when the connection isn't rooted on the variant root.
 */
export interface ArrowColorInput {
  from: string;
  to: string;
  sourceNode?: string;
}

/** Map a connection variant name to its viewport id. */
function toVpId(variantName: string): string {
  return variantName === 'default' ? 'desktop' : variantName;
}

/**
 * @param arrow            the arrow record
 * @param selectedId       the currently selected node id, or null
 * @param isChildSelection true iff `selectedId` is a descendant of a
 *                         variant root (NOT the variant root itself).
 *                         Computed in ArrowConnectors via the parentId
 *                         walk.
 * @param selectedVpId     the viewport id the user is interacting in.
 *                         When `selectedId` is null this is irrelevant
 *                         (rule 1 short-circuits anyway).
 */
export function pickArrowColor(
  arrow: ArrowColorInput,
  selectedId: string | null,
  isChildSelection: boolean,
  selectedVpId: string,
  // A dragged-out CANVAS NODE isn't a variant artboard, but it carries a variant association
  // (`data-replica-solo`/`initialVariant`) so its `selectedVpId` resolves to a variant — without this every arrow
  // touching that variant lit up just from selecting the free canvas node. Canvas-node selection → all greyed.
  isCanvasNodeSelected = false,
): string {
  if (!selectedId) return ARROW_COLOR_GREYED;
  // A selected canvas node: highlight ITS OWN connection arrow (the canvas node IS the arrow's sourceNode) — it's
  // the source of that connection — and grey every other arrow. (It's not a variant artboard, so the variant
  // rules below don't apply.)
  if (isCanvasNodeSelected) return arrow.sourceNode === selectedId ? COMPONENT_COLOR : ARROW_COLOR_GREYED;

  const fromVp = toVpId(arrow.from);
  const toVp = toVpId(arrow.to);

  if (arrow.sourceNode) {
    // Per-child arrow lights up only when (a) the selection IS that
    // child trigger, AND (b) the user is in the same variant the
    // connection fires from. Without the variant check, the same
    // child id rendered in a different replica would also light up.
    const matchesChild = arrow.sourceNode === selectedId;
    const inSourceVariant = selectedVpId === fromVp;
    return matchesChild && inSourceVariant ? COMPONENT_COLOR : ARROW_COLOR_GREYED;
  }

  if (isChildSelection) return ARROW_COLOR_GREYED;

  // Variant root selected: highlight only arrows whose source OR
  // target is the variant the user clicked into.
  return selectedVpId === fromVp || selectedVpId === toVp
    ? COMPONENT_COLOR
    : ARROW_COLOR_GREYED;
}
