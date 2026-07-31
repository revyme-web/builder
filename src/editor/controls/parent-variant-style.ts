// parent-variant-style.ts — resolve a PARENT node's effective style value on a
// component-master VARIANT tile.
//
// Leaf module (zero imports) so ControlProvider and its test can both take it
// without dragging the provider's atom graph into a unit test.
//
// Why it exists: child controls whose meaning depends on the parent's layout —
// Fill/fr sizing, align-self, order — have to know the parent's EFFECTIVE
// `display` / `flex-direction` on the tile being edited. ControlProvider already
// resolved a replica's `@media` override for that; the component-master twin was
// missing, so a master whose parent flips direction per variant resolved as the
// base `row`. On a `column` variant the panel then presented the child's
// `flex: 3 0 0px` grow under WIDTH while CSS applies it to the main axis — the
// HEIGHT — and lowering "Width 3 fr" visibly shrank the card's height
// (user report 2026-07-26).

/** The parent shape this reads — the two places a per-variant value can live. */
export interface VariantStyleSource {
  /** Inline ternary, folded by the parser: prop → { variantName: value }.
   *  `flexDirection: variant === 'variant-4' ? 'column' : 'row'` becomes
   *  `{ flexDirection: { 'variant-4': 'column', default: 'row' } }`. */
  conditionalStyles?: Record<string, Record<string, string>> | null;
  /** The variant OBJECT the element animates through: variantName → styles. */
  motionVariants?: Record<string, Record<string, string>> | null;
}

/**
 * The parent's value for `prop` on `variant`, or undefined when the variant
 * doesn't set one (caller then falls back to replica overrides / base styles).
 *
 * Precedence matches the Renderer's `resolveVariantStyles`: the conditional
 * ternary wins over the variant object. A conditional with no entry for this
 * variant falls back to its `default` key — that IS the ternary's else branch,
 * which is what every other variant renders.
 *
 * Empty strings are treated as "not set" so a cleared value can't mask the base.
 */
export function resolveParentVariantStyle(
  parent: VariantStyleSource | null | undefined,
  variant: string | null | undefined,
  prop: string,
): string | undefined {
  if (!parent || !variant) return undefined;
  const cond = parent.conditionalStyles?.[prop];
  const condVal = cond?.[variant] ?? cond?.['default'];
  if (condVal !== undefined && condVal !== '') return String(condVal);
  const objVal = parent.motionVariants?.[variant]?.[prop];
  return objVal !== undefined && objVal !== '' ? String(objVal) : undefined;
}
