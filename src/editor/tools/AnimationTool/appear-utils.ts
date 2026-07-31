// appear-utils.ts — derive the reveal (`whileInView`) for an Enter-only Appear.
//
// the reference's Appear has only an ENTER (From) state; the element animates TO its
// resting state. We model that as `initial` (the scoped, responsive enter) +
// a DERIVED `whileInView` = the neutral resting value of every enter key, so each
// viewport's enter animates back to rest. whileInView is non-responsive (resting
// is the same everywhere) but must cover the UNION of keys across all viewports.

/** Transform + opacity keys whose RESTING value is neutral (0, or 1 for scale/
 *  opacity) — the element is un-transformed at rest, so the reveal animates back
 *  to neutral. Every OTHER animated key is a real CSS box value (height, width,
 *  top, borderRadius, …) that rests at its AUTHORED style value, NOT 0. */
const NEUTRAL_KEYS = new Set([
  'opacity', 'x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ',
  'scale', 'scaleX', 'scaleY', 'scaleZ', 'skew', 'skewX', 'skewY',
]);

/** Resting value a prop animates TO: opacity/scale → 1, other transforms → 0. */
export function appearNeutralValue(k: string): string {
  return (k === 'opacity' || k.startsWith('scale')) ? '1' : '0';
}

/** The value a key REVEALS to (the `whileInView`/resting state): the element's
 *  AUTHORED style value whenever one exists, else neutral. The appear animates
 *  the element back to how it was designed — the canvas paints the authored
 *  style, so any other rest value makes live drift from canvas. Concrete bug:
 *  a decorative aura authored at `opacity: '0.2'` revealed to the old
 *  hardcoded 1 and rendered saturated on the published page while the canvas
 *  showed it faint (user report 2026-07-27). Same rule for the motion
 *  shorthands: an authored `rotate: '90'` must reveal back to 90, not 0.
 *  Neutral (1 for opacity/scale, 0 otherwise) is only the fallback for keys
 *  the style doesn't author — for transforms that IS the resting state, and
 *  for layout keys 0 is the legacy fallback (better than collapsing, see the
 *  "Add height → bar reveals to 0px" bug). */
export function appearRestingValue(k: string, styles?: Record<string, string>): string {
  const v = styles?.[k];
  if (v != null && v !== '') return String(v);
  return (NEUTRAL_KEYS.has(k) || k.startsWith('scale')) ? appearNeutralValue(k) : '0';
}

/** Every enter-prop key the node uses across base + all viewport/variant overrides
 *  (parsed `_base`/`_chain` markers) + the current edit. Markers/empties dropped. */
export function appearUnionKeys(parsedInitial: any, extra: Record<string, string> = {}): string[] {
  const keys = new Set<string>();
  const add = (o: any) => { for (const k of Object.keys(o || {})) if (!k.startsWith('_') && o[k] !== '') keys.add(k); };
  add(parsedInitial); add(extra);
  try { if (parsedInitial?._base) add(JSON.parse(parsedInitial._base)); } catch { /* ignore */ }
  try { if (parsedInitial?._chain) for (const e of JSON.parse(parsedInitial._chain)) add(e.props); } catch { /* ignore */ }
  return [...keys];
}

/** The full derived `whileInView` reveal for a set of enter keys. Pass the node's
 *  `styles` so layout keys (height/width/…) reveal to their authored value instead
 *  of collapsing to 0. */
export function appearReveal(keys: string[], styles?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(keys.map(k => [k, appearRestingValue(k, styles)]));
}
