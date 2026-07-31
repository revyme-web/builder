// AnimationTool/popups/fx-utils.ts — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import type { FxProps, InstanceFxSpec } from '@/code/generation/instance-fx-gen';

// instance-fx props are numbers; MotionPropsEditor works in strings.
export const fxToStr = (p: FxProps): Record<string, string> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
export const strToFx = (p: Record<string, string>): FxProps => {
  const o: FxProps = {};
  for (const [k, v] of Object.entries(p)) { const n = parseFloat(v); if (!isNaN(n)) o[k] = n; }
  return o;
};

/** The spec's transition shape (typed numbers) — not exported by the generator,
 *  extracted from the spec type so the two can't drift. */
export type FxTransition = NonNullable<NonNullable<InstanceFxSpec['appear']>['transition']>;

/** The generator's defaults when a spec carries no transition (mirrors
 *  fmtTransition's fallbacks) — shown in the Transition row so it reads
 *  "Spring …"/"Tween …" instead of empty, exactly like the element popups. */
export const FX_DEFAULT_TRANSITION: Record<string, string> = { type: 'spring', stiffness: '300', damping: '30' };
export const FX_LOOP_DEFAULT_TRANSITION: Record<string, string> = { type: 'tween', duration: '4', ease: 'linear', repeat: 'Infinity' };

/** FxTransition (typed numbers) → the Record<string,string> shape
 *  TransitionRow/TransitionPanel speak. */
export const fxTransitionToStr = (
  t: FxTransition | undefined,
  fallback: Record<string, string> = FX_DEFAULT_TRANSITION,
): Record<string, string> => {
  if (!t || Object.keys(t).length === 0) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (v != null) out[k] = String(v);
  return out;
};

/** TransitionPanel output → FxTransition. String fields stay strings; numeric
 *  fields parse; `repeat: 'Infinity'` is preserved as the sentinel. */
export const strToFxTransition = (t: Record<string, string>): FxTransition => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (v === '' || v == null) continue;
    if (k === 'type' || k === 'ease' || k === 'repeatType') out[k] = v;
    else if (k === 'repeat' && v === 'Infinity') out[k] = 'Infinity';
    else { const n = parseFloat(v); if (!isNaN(n)) out[k] = n; }
  }
  return out as FxTransition;
};
