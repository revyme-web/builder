// AnimationTool/popups/HoverTapPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ControlActionRow } from '../../../controls';
import { AnimationIcon } from '@/design-system/PropertyIcons';
import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { TransitionRow } from './TransitionRow';

export function HoverTapPopup({ nodeId, propName, props, initialProps, transition }: {
  nodeId: string; propName: string; props: Record<string, string>; initialProps: Record<string, string>; transition: Record<string, string>;
}) {
  const { pushPanel } = useToolPopup();
  return (
    <div className="flex flex-col gap-2">
      {/* From (initial state) */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="From" property="" plain />
        <ControlActionRow onClick={() => pushPanel('From', (
          <MotionPropsEditor nodeId={nodeId} props={initialProps} preview
            onChange={(newProps) => queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: newProps })} />
        ))}>
          <AnimationIcon width={20} height={20} className="shrink-0" />
          <span className="text-[var(--text-secondary)]">Effect</span>
        </ControlActionRow>
      </div>

      {/* To (whileHover/whileTap state) */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="To" property="" plain />
        <ControlActionRow onClick={() => pushPanel('To', (
          <MotionPropsEditor nodeId={nodeId} props={props} preview
            onChange={(newProps) => queueMutation({ type: 'updateMotionProp', nodeId, propName, props: newProps })} />
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
