/**
 * The shape of a `useScroll` target, shared by every reader that parses one.
 *
 * Plain:          useScroll({ target: heroRef, … })
 * Variant-gated:  useScroll({ target: variant !== 'mobile' ? heroRef : undefined, … })
 *
 * The gated form exists because framer-motion's useScroll THROWS ("Target ref
 * is defined but not hydrated") when the target ref is defined but its element
 * never mounted — which is exactly what happens when the tracked element (or
 * an ancestor) is hidden in a variant via conditional rendering. The hook can't
 * be conditional, so the target is: `undefined` in the variants that don't
 * render it. With the runtime rendering EVERY breakpoint's copy (SSR variant
 * copies), an ungated target crashes the page on every breakpoint.
 *
 * Every reader must resolve the gated form to the REF (`heroRef`), not to the
 * first identifier of the condition (`variant`).
 */

/** Regex source matching a target expression; group 1 is the ref name. */
export const SCROLL_TARGET_EXPR = String.raw`(?:[^?,{}()]*?\?\s*)?([A-Za-z_$][\w$]*)(?:\s*:\s*undefined)?`;

/** The ref a `useScroll({...})` argument string targets, or null. */
export function scrollTargetRef(args: string, key: 'target' | 'container' = 'target'): string | null {
  const m = args.match(new RegExp(String.raw`\b${key}\s*:\s*${SCROLL_TARGET_EXPR}`));
  return m ? m[1] : null;
}
