// text-anim-presets.ts — TextAnimConfig type + 13 presets matching builder exactly.

/** A per-viewport (page) or per-variant (component) scope — structurally identical to the animation
 *  system's SerScope. `query` is a banded `@media` string; `variant` is a component variant name. */
export type TextAnimScope = { query: string } | { variant: string };

/** A scoped override of the text effect's VALUE fields (opacity/scale/x/y/rotate/skew/blur/stagger/
 *  transition/scroll Start-End). Structural fields (animationType = Split, trigger = Play) are global —
 *  they change the compiled span DOM/mechanism and can't be runtime-gated on a single DOM — so they're
 *  never stored here. Mirrors instance-fx's `FxValueOverride`. */
interface TextAnimOverride {
  scope: TextAnimScope;
  config: Partial<TextAnimConfig>;
}

export interface TextAnimConfig {
  animationType: 'character' | 'word' | 'line' | 'full';
  /** Wrap each split unit in an overflow-hidden clip so the reveal slides out from BEHIND the line
   *  ("cut-off"/masked reveal) instead of floating in from open space. Structural, like animationType —
   *  it changes the emitted DOM, not just a value. Without it in the config the clip was hand-authored
   *  markup that any regeneration silently discarded, leaving two headings on one page animating
   *  differently (live find 2026-07-30). Pair with a percentage `y` (e.g. '100%') so the offset tracks
   *  the type size; a px offset masks correctly at one breakpoint only. */
  mask?: boolean;
  /** Playback trigger. 'view' (default) = each unit reveals once when scrolled into view (per-child
   *  whileInView + staggered delay). 'scroll' = the reveal is scrubbed to scroll progress
   *  (useScroll + per-unit useTransform). */
  trigger?: 'view' | 'scroll';
  /** On Scroll only — useScroll offset viewport positions (% down the viewport of the element's top).
   *  scrollStart (default 90) = where the reveal begins as the element enters from the bottom;
   *  scrollEnd (default 35) = where it's fully revealed. */
  scrollStart?: number;
  scrollEnd?: number;
  /** Per-viewport / per-variant VALUE overrides (the blue "reset override" rows). Only the base config's
   *  structural fields (animationType, trigger) apply; each entry overrides value fields for its scope. */
  responsive?: TextAnimOverride[];
  opacity?: number;
  scale?: number;
  blur?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  skewX?: number;
  skewY?: number;
  x?: number | string;
  y?: number | string;
  delay?: number;        // stagger delay between animation units
  transition?: {
    type?: 'spring' | 'tween';
    stiffness?: number;
    damping?: number;
    mass?: number;
    duration?: number;
    ease?: string;
    bounce?: number;
    delay?: number;       // initial delay before animation starts
  };
}

export interface TextAnimPreset {
  name: string;
  config: TextAnimConfig;
}

const BASE: Pick<TextAnimConfig, 'animationType' | 'delay'> = {
  animationType: 'character',
  delay: 0.05,
};

export const TEXT_ANIM_PRESETS: TextAnimPreset[] = [
  {
    name: 'None',
    config: { ...BASE, opacity: 1, scale: 1, blur: 0, rotateX: 0, rotateY: 0, rotateZ: 0, skewX: 0, skewY: 0, x: 0, y: 0, transition: { type: 'tween', duration: 0, ease: 'linear' } },
  },
  {
    name: 'Fade In',
    config: { ...BASE, opacity: 0, transition: { type: 'tween', duration: 0.8, ease: 'easeOut' } },
  },
  {
    name: 'Slide Up',
    config: { ...BASE, opacity: 0, y: 20, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Slide Down',
    config: { ...BASE, opacity: 0, y: -20, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Slide Left',
    config: { ...BASE, opacity: 0, x: 20, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Slide Right',
    config: { ...BASE, opacity: 0, x: -20, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Scale Up',
    config: { ...BASE, opacity: 0, scale: 0.5, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Bounce',
    config: { ...BASE, scale: 0.3, y: -30, transition: { type: 'spring', duration: 0.6, bounce: 0.5 } },
  },
  {
    name: 'Blur',
    config: { ...BASE, opacity: 0, blur: 10, scale: 1.2, transition: { type: 'tween', duration: 1, ease: 'easeOut' } },
  },
  {
    name: 'Rotate',
    config: { ...BASE, opacity: 0, rotateZ: 90, scale: 0.8, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Flip',
    config: { ...BASE, opacity: 0, rotateX: 90, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  },
  {
    name: 'Glitch',
    config: { ...BASE, skewX: 20, x: 10, y: -5, transition: { type: 'tween', duration: 0.3, ease: 'easeInOut' } },
  },
  {
    name: 'Elastic',
    config: { ...BASE, opacity: 0, scale: 0, transition: { type: 'spring', stiffness: 500, damping: 15 } },
  },
  {
    name: 'Wave',
    config: { ...BASE, opacity: 0, y: -15, transition: { type: 'spring', duration: 0.6, bounce: 0.4 } },
  },
];

/** Default config when adding a text effect */
export const DEFAULT_TEXT_ANIM: TextAnimConfig = TEXT_ANIM_PRESETS[2].config; // Slide Up

/** Detect which preset matches, or null for custom */
export function detectTextAnimPreset(config: TextAnimConfig): string | null {
  for (const preset of TEXT_ANIM_PRESETS) {
    if (configsMatch(config, preset.config)) return preset.name;
  }
  return null;
}

function configsMatch(a: TextAnimConfig, b: TextAnimConfig): boolean {
  const keys: (keyof TextAnimConfig)[] = ['opacity', 'scale', 'blur', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'x', 'y'];
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  // Compare transition type and key params
  const at = a.transition ?? {};
  const bt = b.transition ?? {};
  if ((at.type ?? 'spring') !== (bt.type ?? 'spring')) return false;
  if (at.type === 'spring' || bt.type === 'spring') {
    if ((at.stiffness ?? 300) !== (bt.stiffness ?? 300)) return false;
    if ((at.damping ?? 30) !== (bt.damping ?? 30)) return false;
    if ((at.bounce ?? undefined) !== (bt.bounce ?? undefined)) return false;
  } else {
    if ((at.ease ?? 'easeOut') !== (bt.ease ?? 'easeOut')) return false;
    if ((at.duration ?? 0.5) !== (bt.duration ?? 0.5)) return false;
  }
  return true;
}

/** Animation type options for dropdown */
export const ANIM_TYPE_OPTIONS = [
  { value: 'character', label: 'Character' },
  { value: 'word', label: 'Word' },
  { value: 'line', label: 'Line' },
  { value: 'full', label: 'Full' },
];

// ─── Per-viewport / per-variant scope helpers ────────────────────────────────
//
// Overrides live in `config.responsive`. The base config holds the primary/desktop values plus the two
// GLOBAL structural fields (animationType, trigger). A scope override carries ONLY value fields.

/** GLOBAL fields, never stored in a scope override. `animationType` (Split) changes the span DOM, so it
 *  stays global; `trigger` (Play: View/Scroll) IS per-viewport (the hybrid codegen gates each span between
 *  the whileInView reveal and the scroll motion-values), so it is NOT global. `responsive` is the carrier. */
// `mask` changes the emitted DOM (a clip wrapper per unit), not a value — so like animationType it
// belongs to the BASE config and can never be a per-scope override.
const STRUCTURAL_KEYS: (keyof TextAnimConfig)[] = ['animationType', 'responsive', 'mask'];

function textAnimScopesEqual(a: TextAnimScope, b: TextAnimScope): boolean {
  if ('variant' in a) return 'variant' in b && a.variant === b.variant;
  return 'query' in b && a.query === b.query;
}

/** Resolve the effective config for a scope: base ⊕ that scope's override (value fields only).
 *  scope null → the base config verbatim. */
export function resolveTextAnimForScope(config: TextAnimConfig, scope: TextAnimScope | null): TextAnimConfig {
  if (!scope) return config;
  const ov = config.responsive?.find(r => textAnimScopesEqual(r.scope, scope));
  return ov ? { ...config, ...ov.config } : config;
}

/** True when there's a value override for this scope (drives the blue "reset override" indicator). */
export function hasTextAnimScope(config: TextAnimConfig, scope: TextAnimScope | null): boolean {
  if (!scope) return false;
  return !!config.responsive?.some(r => textAnimScopesEqual(r.scope, scope));
}

/** Strip global/structural keys from a partial override (they always live on the base). */
function stripStructural(partial: Partial<TextAnimConfig>): Partial<TextAnimConfig> {
  const out: Partial<TextAnimConfig> = { ...partial };
  for (const k of STRUCTURAL_KEYS) delete out[k];
  return out;
}

/** Write `next` for a scope. scope null → merge into the base. scope set → upsert that scope's override
 *  (value fields only); structural changes in `next` always fold into the base regardless of scope. */
export function setTextAnimScoped(config: TextAnimConfig, next: TextAnimConfig, scope: TextAnimScope | null): TextAnimConfig {
  if (!scope) {
    // Editing the primary tile — `next` is the full new base; keep existing overrides.
    return { ...next, responsive: config.responsive };
  }
  // Editing a replica/variant: GLOBAL fields (animationType) fold into base; everything else — incl.
  // trigger (Play) — becomes this scope's override.
  const base: TextAnimConfig = { ...config, animationType: next.animationType };
  const ovConfig = stripStructural(next);
  const others = (config.responsive ?? []).filter(r => !textAnimScopesEqual(r.scope, scope));
  return { ...base, responsive: [...others, { scope, config: ovConfig }] };
}

/** Remove a scope's override (the "Reset Override" action). */
export function resetTextAnimScope(config: TextAnimConfig, scope: TextAnimScope): TextAnimConfig {
  const next = (config.responsive ?? []).filter(r => !textAnimScopesEqual(r.scope, scope));
  return { ...config, responsive: next.length ? next : undefined };
}
