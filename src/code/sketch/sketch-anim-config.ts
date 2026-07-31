// sketch-anim-config.ts — Per-wrapper sketch draw-animation config.
//
// Stored in source as a `data-sketch-anim="..."` attribute on the
// `<svg data-sketch="true">` wrapper. Value is a JSON-encoded
// `SketchAnimConfig`. Why a JSON-in-data-attr instead of a JSDoc
// annotation comment:
//
//   1. The HTML/JSX parser already round-trips arbitrary `data-*`
//      attributes (we rely on this for `data-points`), so no parser
//      changes are needed.
//   2. The runtime orchestrator queries the wrapper element by
//      `[data-sketch-anim]` and reads the config straight off the
//      DOM — same source for both build-time (codegen reads it back
//      from source) and runtime (the injected useEffect reads it
//      from the DOM).
//
// Persisting the full transition shape (spring vs tween + tuning)
// keeps the editor popup composable with the existing
// `parseTransitionShorthand` / `formatTransitionShorthand` system.

export type SketchAnimTrigger = 'mount' | 'inView' | 'hover' | 'tap';
export type SketchAnimMode = 'sequential' | 'staggered' | 'simultaneous';

/** Reuses the same shape `animation-utils.ts` produces, so the
 *  TransitionPanel can edit it directly. */
export interface SketchAnimTransition {
  type: 'tween' | 'spring';
  /** Duration in seconds (tween mode). */
  duration?: number;
  /** Tween easing name — 'linear' | 'easeIn' | 'easeOut' | etc. */
  ease?: string;
  /** Spring stiffness. */
  stiffness?: number;
  /** Spring damping. */
  damping?: number;
  /** Spring mass. */
  mass?: number;
  /** Initial velocity (spring). */
  velocity?: number;
}

export interface SketchAnimConfig {
  trigger: SketchAnimTrigger;
  mode: SketchAnimMode;
  /** Global multiplier on per-stroke duration. Per-stroke duration
   *  scales with point count so a long stroke takes longer than a
   *  flick — this just adjusts the overall pace. */
  durationScale: number;
  /** 0–1, only meaningful in staggered mode. 0 = sequential, 1 =
   *  simultaneous, in between = overlap factor. */
  stagger: number;
  /** Transition curve applied to each stroke's draw progress. */
  transition: SketchAnimTransition;
}

export const DEFAULT_SKETCH_ANIM: SketchAnimConfig = {
  trigger: 'inView',
  mode: 'sequential',
  durationScale: 1,
  stagger: 0.5,
  transition: { type: 'tween', duration: 1, ease: 'easeOut' },
};

export function parseSketchAnimConfig(raw: string | undefined | null): SketchAnimConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SketchAnimConfig>;
    return {
      trigger: parsed.trigger ?? DEFAULT_SKETCH_ANIM.trigger,
      mode: parsed.mode ?? DEFAULT_SKETCH_ANIM.mode,
      durationScale: parsed.durationScale ?? DEFAULT_SKETCH_ANIM.durationScale,
      stagger: parsed.stagger ?? DEFAULT_SKETCH_ANIM.stagger,
      transition: parsed.transition ?? DEFAULT_SKETCH_ANIM.transition,
    };
  } catch {
    return null;
  }
}

export function summarizeSketchAnim(config: SketchAnimConfig): string {
  const trig = config.trigger === 'inView' ? 'In view' : config.trigger.charAt(0).toUpperCase() + config.trigger.slice(1);
  const mode = config.mode === 'sequential' ? 'seq' : config.mode === 'staggered' ? 'stag' : 'all';
  const dur = config.transition.type === 'spring' ? 'spring' : `${(config.transition.duration ?? 1).toFixed(1)}s`;
  return `${trig} · ${mode} · ${dur}`;
}
