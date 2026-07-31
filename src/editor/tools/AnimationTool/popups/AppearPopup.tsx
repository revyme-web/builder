// AnimationTool/popups/AppearPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ControlActionRow } from '../../../controls';
import { AnimationIcon } from '@/design-system/PropertyIcons';
import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';
import { appearReveal, appearUnionKeys } from '../appear-utils';
import { TransitionRow } from './TransitionRow';

// Appear = ENTER (From) only, standard. The element animates from `initial`
// (the scoped, responsive enter state) TO its resting state via `whileInView`,
// which we DERIVE as the neutral of every enter key (non-scoped — resting is the
// same on every viewport). No "To" row.
export function AppearPopup({ nodeId, node, enterProps, transition, isVariantMode, initialName }: {
  nodeId: string; node: any; enterProps: Record<string, string>;
  transition: Record<string, string>; isVariantMode: boolean; initialName?: string;
}) {
  const { pushPanel } = useToolPopup();
  const writeEnter = (newProps: Record<string, string>) => {
    if (isVariantMode && initialName) {
      queueMutation({ type: 'updateVariantStyle', nodeId, variantName: initialName, styles: newProps });
      return;
    }
    // Scoped enter (responsive, like hover/tap) …
    queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: newProps, scope: getActiveAnimationScope() });
    // … plus the derived reveal over the UNION of all enter keys. Layout keys
    // (height/width/…) reveal to the node's AUTHORED style value (not 0), so the
    // element animates back to its real size instead of collapsing.
    queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileInView',
      props: appearReveal(appearUnionKeys(node?.motionProps?.initial, newProps), node?.styles) });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Enter" property="" plain />
        <ControlActionRow onClick={() => pushPanel('Enter', (
          <MotionPropsEditor nodeId={nodeId} props={enterProps} preview onChange={writeEnter} />
        ))}>
          <AnimationIcon width={20} height={20} className="shrink-0" />
          <span className="text-[var(--text-secondary)]">Effect</span>
        </ControlActionRow>
      </div>

      <TransitionRow transition={transition}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={transition} onWrite={(t) => {
            queueMutation({ type: 'updateMotionProp', nodeId, propName: 'transition', props: t });
          }} />
        ))} />
    </div>
  );
}
