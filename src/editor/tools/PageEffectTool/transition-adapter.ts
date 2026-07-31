// transition-adapter.ts — bridges the Page Effect TransitionConfig (typed, what
// the View-Transition CSS builder consumes) ↔ the AnimationTool TransitionPanel's
// Record<string,string> shape, so we REUSE that exact overlay (user requirement).
//
// TransitionPanel record keys: type ('tween'|'spring'|'instant'), duration, ease
// (preset name OR '[b0, b1, b2, b3]'), delay, stiffness/damping/mass (spring
// physics) OR duration/bounce (spring time).

import { EASE_BEZIERS } from '../AnimationTool/CurvePreview';
import { DEFAULT_BEZIER, type TransitionConfig } from '@/code/project/page-effects-config';

/** Convert a spring time-config (duration + bounce) → physics (stiffness/damping/
 *  mass) so our spring→linear() sampler (which needs k/c/m) can render it. */
function springTimeToPhysics(duration: number, bounce: number): { stiffness: number; damping: number; mass: number } {
  const zeta = Math.min(Math.max(1 - bounce, 0.05), 1); // bounce 0→critically damped, →1 bouncy
  const settle = Math.max(duration, 0.1);
  const w = -Math.log(0.01) / (zeta * settle); // ω so the envelope settles in ~duration
  return { stiffness: Math.round(w * w), damping: Math.round(2 * zeta * w), mass: 1 };
}

/** Page Effect TransitionConfig → TransitionPanel Record. */
export function transitionConfigToRecord(t: TransitionConfig): Record<string, string> {
  if (t.kind === 'spring') {
    return {
      type: 'spring',
      stiffness: String(t.stiffness ?? 300),
      damping: String(t.damping ?? 25),
      mass: String(t.mass ?? 1),
      delay: String(t.delay ?? 0),
    };
  }
  const ease = t.bezier ? `[${t.bezier.join(', ')}]` : (t.ease ?? 'easeInOut');
  return { type: 'tween', duration: String(t.duration ?? 0.4), ease, delay: String(t.delay ?? 0) };
}

function easeToBezier(ease: string | undefined): { ease: string; bezier: [number, number, number, number] } {
  if (!ease) return { ease: 'easeInOut', bezier: [...DEFAULT_BEZIER] };
  const m = ease.match(/^\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]$/);
  if (m) return { ease: 'custom', bezier: [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])] };
  const preset = (EASE_BEZIERS as Record<string, number[]>)[ease];
  if (preset && preset.length === 4) return { ease, bezier: [preset[0], preset[1], preset[2], preset[3]] };
  return { ease: 'easeInOut', bezier: [...DEFAULT_BEZIER] };
}

/** TransitionPanel Record → Page Effect TransitionConfig (always resolves a
 *  concrete bezier / physics so the CSS builder has everything it needs). */
export function recordToTransitionConfig(r: Record<string, string>): TransitionConfig {
  const delay = parseFloat(r.delay || '0') || 0;
  if (r.type === 'spring') {
    if (r.stiffness != null && r.stiffness !== '') {
      return {
        kind: 'spring',
        stiffness: parseFloat(r.stiffness) || 300,
        damping: parseFloat(r.damping || '25') || 25,
        mass: parseFloat(r.mass || '1') || 1,
        duration: 0,
        delay,
      };
    }
    const phys = springTimeToPhysics(parseFloat(r.duration || '0.5') || 0.5, parseFloat(r.bounce || '0.25') || 0);
    return { kind: 'spring', ...phys, duration: 0, delay };
  }
  // tween / instant → ease
  const { ease, bezier } = easeToBezier(r.ease);
  return { kind: 'ease', ease, bezier, duration: parseFloat(r.duration || '0.4') || 0.4, delay };
}

/** Short human summary for the Transition row, e.g. "Ease · 0.4s" / "Spring". */
export function pageEffectTransitionSummary(t: TransitionConfig): string {
  if (t.kind === 'spring') return 'Spring';
  return `Ease · ${t.duration}s`;
}
