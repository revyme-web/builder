// AnimationTool/popups/InstanceFxPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { TransitionRow } from './TransitionRow';
import { getActiveAnimationScope } from '../animation-scope-source';
import type { SerScope } from '@/code/generation/generator-motion';
import { resolveFxValue, setFxValueScoped, type InstanceFxSpec, type FxProps } from '@/code/generation/instance-fx-gen';
import { fxToStr, strToFx, fxTransitionToStr, strToFxTransition, FX_DEFAULT_TRANSITION, FX_LOOP_DEFAULT_TRANSITION } from './fx-utils';

/** Edit popup for a component-instance effect (Hover/Press/Appear/Loop). Reuses
 *  MotionPropsEditor; writes merge into the single data-instance-fx spec via `write`. */
export function InstanceFxPopup({ nodeId, fxKind, spec, write }: {
  nodeId: string;
  fxKind: 'hover' | 'tap' | 'appear' | 'loop';
  spec: InstanceFxSpec;
  write: (mutate: (s: InstanceFxSpec) => InstanceFxSpec) => void;
}) {
  const cur = spec[fxKind] as any;
  // hover/tap are VALUE-responsive: on a replica the editor shows + writes that tile's
  // override (base ⊕ scope), so editing on Tablet changes ONLY Tablet — exactly like
  // normal-node hover and instance Transform. Loop stays base-only (keyframe-responsive
  // is a follow-up; its PRESENCE works). appear is handled by InstanceAppearPopup.
  const activeScope = getActiveAnimationScope() as SerScope | null;
  const isGesture = fxKind === 'hover' || fxKind === 'tap';
  const props: FxProps = fxKind === 'loop'
    ? Object.fromEntries(Object.entries(cur?.keyframes || {}).map(([k, v]) => [k, (v as number[])[(v as number[]).length - 1]]))
    : isGesture ? resolveFxValue(spec, fxKind, activeScope)
    : (cur?.to || {});
  const onChange = (newStr: Record<string, string>) => {
    const fx = strToFx(newStr);
    write((s) => {
      if (fxKind === 'loop') return { ...s, loop: { ...s.loop, keyframes: Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, [0, v]])) } };
      if (isGesture) return setFxValueScoped(s, fxKind, fx, activeScope);
      return { ...s, [fxKind]: { ...(s as any)[fxKind], to: fx } };
    });
  };
  // Transition row — SAME as the element Hover/Tap/Loop popups (the instance
  // variant previously exposed no transition even though the spec + codegen
  // support one per effect; edits silently kept the default spring/tween).
  // Structural like trigger: edits the BASE, never per-viewport.
  const { pushPanel } = useToolPopup();
  const transitionFallback = fxKind === 'loop' ? FX_LOOP_DEFAULT_TRANSITION : FX_DEFAULT_TRANSITION;
  const transitionStr = fxTransitionToStr(cur?.transition, transitionFallback);
  const writeTransition = (t: Record<string, string>) =>
    write((s) => ({ ...s, [fxKind]: { ...(s as any)[fxKind], transition: strToFxTransition(t) } }));
  return (
    <div className="flex flex-col gap-2">
      <MotionPropsEditor nodeId={nodeId} preview props={fxToStr(props)} onChange={onChange}
        transitionRow={
          <TransitionRow transition={transitionStr}
            onClick={() => pushPanel('Transition', (
              <TransitionPanel initialTransition={transitionStr} onWrite={writeTransition} />
            ))} />
        } />
    </div>
  );
}
