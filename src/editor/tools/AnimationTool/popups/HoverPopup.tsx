// AnimationTool/popups/HoverPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';
import { TransitionRow } from './TransitionRow';

// Hover is Motion-only. For "hover one element → several elements react", make
// the group a COMPONENT and drive it with a `mouseEnter`/`mouseLeave` variant
// connection — that's the conflict-free, FLIP-aware path. (CSS hover was
// removed: CSS transform can't override motion's inline projection.)
export function HoverPopup({ nodeId, node, payload }: {
  nodeId: string;
  node: any;
  payload: any;
}) {
  const { pushPanel } = useToolPopup();
  return (
    <div className="flex flex-col gap-2">
      <MotionPropsEditor nodeId={nodeId} preview
        props={payload?.props || node.motionProps?.whileHover || {}}
        // Pass the ACTIVE scope so editing a base hover on a replica creates a
        // per-viewport override branch (responsive value) instead of mutating
        // the base. scope=null on primary → writes the base.
        onChange={(newProps) => queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileHover', props: newProps, scope: getActiveAnimationScope() })}
        transitionRow={
          <TransitionRow transition={node.motionProps?.transition || {}}
            onClick={() => pushPanel('Transition', (
              <TransitionPanel initialTransition={node.motionProps?.transition || {}} onWrite={(t) => {
                queueMutation({ type: 'updateMotionProp', nodeId, propName: 'transition', props: t });
              }} />
            ))} />
        } />
    </div>
  );
}
