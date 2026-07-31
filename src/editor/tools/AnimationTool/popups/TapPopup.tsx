// AnimationTool/popups/TapPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';
import { TransitionRow } from './TransitionRow';

// Tap is Motion-only (same rationale as Hover).
export function TapPopup({ nodeId, node, payload }: {
  nodeId: string;
  node: any;
  payload: any;
}) {
  const { pushPanel } = useToolPopup();
  return (
    <div className="flex flex-col gap-2">
      <MotionPropsEditor nodeId={nodeId} preview
        props={payload?.props || node.motionProps?.whileTap || {}}
        // Pass the ACTIVE scope so editing a base tap on a replica creates a
        // per-viewport override branch (responsive value) instead of mutating
        // the base — same as Hover.
        onChange={(newProps) => queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileTap', props: newProps, scope: getActiveAnimationScope() })}
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
